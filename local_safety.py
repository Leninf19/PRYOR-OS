"""
local_safety.py -- safety primitives for auto_update.py --local: a manual,
human-run scrape+commit+push+deploy against the SAME dashboard/reviews.db
every scheduled GitHub Actions workflow writes to. Three separate concerns:

1. A local mutation lock (LocalLockError / acquire() / release()) so two
   overlapping --local runs on one machine (or one left running and
   started again) can't race each other. This is DELIBERATELY separate
   from -- and does not replace -- GitHub Actions' own
   `concurrency: group: reviews-db-writer`, which only ever sees scheduled/
   CI workflow runs and has no visibility into a human's local machine at
   all. The two mechanisms protect different, non-overlapping classes of
   collision; both matter.

2. ensure_safe_for_local_mode() -- refuses to run if this looks like a CI/
   production environment (--local is meant for a human's own machine
   only; it should never fire inside a GitHub Actions runner, a Vercel
   build, or anywhere CI=true).

3. ensure_expected_db_path() -- a cheap assertion that the DB path about to
   be mutated is really dashboard/reviews.db, not something a future
   refactor accidentally pointed elsewhere.
"""
import json
import os
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path

LOCAL_LOCK_FILENAME = ".local_db_mutation.lock"

# Narrowly named on purpose -- this is NOT a general security bypass flag.
# Its only legitimate use is a test asserting ensure_safe_for_local_mode()
# itself behaves correctly when deliberately invoked inside a CI process;
# it must never be set in a real deployment, workflow, or human's normal
# local run (which isn't CI in the first place, so never needs it).
_TESTING_OVERRIDE_VAR = "LTA_LOCAL_MODE_TESTING_OVERRIDE"
_TESTING_OVERRIDE_VALUE = "i-understand-this-is-for-testing-only"

_CI_FLAG_VARS = ["GITHUB_ACTIONS", "VERCEL", "CI"]


class LocalLockError(Exception):
    """Raised when the local mutation lock is already held."""


class UnsafeEnvironmentError(Exception):
    """Raised when --local is invoked somewhere that looks like CI/production."""


# --------------------------------------------------------------------------
# Environment guard
# --------------------------------------------------------------------------

def ensure_safe_for_local_mode(env: dict | None = None) -> None:
    env = os.environ if env is None else env

    if env.get(_TESTING_OVERRIDE_VAR) == _TESTING_OVERRIDE_VALUE:
        return

    triggered = [name for name in _CI_FLAG_VARS if env.get(name)]
    if env.get("VERCEL_ENV") == "production":
        triggered.append("VERCEL_ENV=production")

    if triggered:
        raise UnsafeEnvironmentError(
            "auto_update.py --local refuses to run here: this looks like a CI/"
            f"production environment ({', '.join(triggered)} set). --local scrapes "
            "with a headed browser and commits/pushes/deploys on a human's own "
            "machine -- it must never run inside GitHub Actions, Vercel, or any "
            "other automated environment. If you are specifically testing this "
            f"guard function itself, set {_TESTING_OVERRIDE_VAR}="
            f"{_TESTING_OVERRIDE_VALUE} -- this is not a general bypass and has no "
            "other effect."
        )


# --------------------------------------------------------------------------
# DB path validation
# --------------------------------------------------------------------------

def ensure_expected_db_path(db_path: Path, expected_path: Path) -> None:
    """Multi-Tenant Phase 4D revision: expected_path is now passed in
    explicitly by the caller (resolved via tenant_paths.resolve_review_db_path()
    for whichever tenant that caller is running as) rather than hardcoded
    here to dashboard/reviews.db -- this guard must correctly validate
    against ANY tenant's own database, not just Los Tres Amigos's."""
    expected = Path(expected_path).resolve()
    actual = Path(db_path).resolve()
    if actual != expected:
        raise ValueError(
            f"Refusing to mutate unexpected database path: {actual} (expected {expected}). "
            "This should be impossible unless db.DB_PATH has changed -- treat this as a bug, not a config option."
        )


# --------------------------------------------------------------------------
# Local mutation lock
# --------------------------------------------------------------------------

def _lock_metadata() -> dict:
    return {
        "pid": os.getpid(),
        "hostname": socket.gethostname(),
        "started_at": datetime.now(timezone.utc).isoformat(),
        "command": " ".join(sys.argv),
    }


def _read_existing(lock_path: Path) -> dict | None:
    try:
        return json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _pid_likely_running(pid, hostname) -> bool | None:
    """True/False if determinable, None if not (different host, bad data --
    callers must treat None as "unknown", never as "safe to remove").

    os.kill(pid, 0) is the standard POSIX existence probe (signal 0 sends
    nothing, it only checks whether the process could be signaled) and is
    used the same way here on Windows -- confirmed empirically that it does
    NOT terminate a live target process on Windows either; it only fails to
    open a handle. The two platforms just report "doesn't exist" through
    different exception shapes: POSIX raises ProcessLookupError, Windows
    raises a plain OSError with winerror=87 (ERROR_INVALID_PARAMETER)."""
    if not isinstance(hostname, str) or hostname != socket.gethostname():
        return None
    if not isinstance(pid, int) or pid <= 0:
        return None
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # process exists, just owned by someone else
    except OSError as e:
        if getattr(e, "winerror", None) == 87:
            return False
        return None


def _format_conflict_message(lock_path: Path, existing: dict | None) -> str:
    header = (
        "Another auto_update.py --local run appears to be in progress "
        "(or a previous one did not exit cleanly).\n"
        f"  Lock file: {lock_path}\n"
    )
    if not existing:
        return header + (
            "Its contents could not be read. This tool will NEVER delete an existing "
            "lock automatically -- if you are certain no other --local run is active, "
            "inspect and remove the file yourself, then try again."
        )

    running = _pid_likely_running(existing.get("pid"), existing.get("hostname"))
    staleness = {
        True: "That process still appears to be running on this machine -- do not remove this lock.",
        False: (
            "That process does NOT appear to be running on this machine anymore, which "
            "suggests the lock may be stale (e.g. a previous run was killed). This tool "
            "will still never delete it automatically -- verify independently, then "
            "remove the file yourself if you're confident it's safe."
        ),
        None: (
            "Staleness could not be determined (different hostname, or insufficient "
            "permission to check). Do not assume it is safe to remove."
        ),
    }[running]

    return header + (
        f"  Held by:   PID {existing.get('pid')} on {existing.get('hostname')}\n"
        f"  Started:   {existing.get('started_at')}\n"
        f"  Command:   {existing.get('command')}\n"
        f"{staleness}"
    )


def acquire(lock_path: Path) -> Path:
    """Atomically creates the lock file, or raises LocalLockError with a
    detailed conflict message if one already exists. O_EXCL is what makes
    this atomic -- the OS guarantees at most one caller's os.open() call
    succeeds when multiple processes race to create the same path."""
    try:
        fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise LocalLockError(_format_conflict_message(lock_path, _read_existing(lock_path)))

    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(_lock_metadata(), f, indent=2)
    except Exception:
        # Don't leave a half-written / unreadable lock file behind if
        # writing the metadata itself fails for some reason.
        try:
            lock_path.unlink()
        except OSError:
            pass
        raise
    return lock_path


def release(lock_path: Path | None) -> None:
    """Always safe to call from a `finally` block, including when acquire()
    was never called (lock_path is None) or already removed."""
    if lock_path is None:
        return
    try:
        Path(lock_path).unlink()
    except FileNotFoundError:
        pass
