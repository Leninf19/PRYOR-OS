"""
check_db_integrity.py -- run before every workflow commits dashboard/reviews.db,
and (via check_integrity()) before/after every auto_update.py --local mutation.

Exits non-zero (failing the job via GitHub Actions' ::error:: annotation) if
SQLite's own integrity check fails, or if the file is missing/unreadable, or
if the reviews table is empty when it shouldn't be. This exists because a
workflow that commits a corrupt or truncated DB file would silently become
tomorrow's "why did reviews disappear" incident -- catching it here means
the commit step never runs against bad data in the first place.

File-size regression guard (recovery audit, 2026-08-20): dashboard/reviews.db
reached exactly 104,857,600 bytes (100.00 MiB) -- GitHub's hard file-size
limit -- and every commit-and-push step began failing with "File ... exceeds
GitHub's file size limit". Root cause: validate.py (before its 2026-07-28
fix) inserted a fresh validation_flags row every run for the same
persisting conditions instead of updating/reusing the existing open one,
accumulating 575,864 rows (56.6 MiB, 57% of the file) of which 570,300 were
already-resolved dead weight no reader ever queries (see
prune_validation_flags.py). Pruning + VACUUM brought this same database
down to 41.34 MiB with zero review/location/notification/scraper-run data
lost. These two thresholds exist so a future regrowth is caught here --
failing the job with a clear, actionable message -- long before a push is
ever attempted and rejected with a much more confusing git-level error:
  - WARN_SIZE_BYTES (70 MiB): ~29 MiB of headroom above the post-cleanup
    baseline -- an early, non-fatal heads-up.
  - FAIL_SIZE_BYTES (95 MiB): 5 MiB of margin below GitHub's actual 100 MiB
    limit -- close enough to be a real, timely alarm, far enough that a
    single large run can't sail past it between checks.

Run directly: python check_db_integrity.py
"""
import sqlite3
import sys
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "dashboard" / "reviews.db"

WARN_SIZE_BYTES = 70 * 1024 * 1024  # 70 MiB
FAIL_SIZE_BYTES = 95 * 1024 * 1024  # 95 MiB -- GitHub's hard limit is 100 MiB


def get_row_counts(conn: sqlite3.Connection) -> dict:
    return {
        "locations": conn.execute("SELECT COUNT(*) FROM locations").fetchone()[0],
        "reviews": conn.execute("SELECT COUNT(*) FROM reviews").fetchone()[0],
    }


def check_size(db_path: Path) -> tuple[bool, str | None]:
    """Pure, side-effect-free: returns (ok, warning_message_or_None). Never
    touches the database itself -- just the file's size on disk. Kept
    separate from check_integrity() so it's independently testable without
    needing a real/fake SQLite file, just a file of a given size."""
    size = db_path.stat().st_size
    size_mib = size / (1024 * 1024)
    if size >= FAIL_SIZE_BYTES:
        return False, (
            f"{db_path} is {size_mib:.2f} MiB, at or above the "
            f"{FAIL_SIZE_BYTES / (1024 * 1024):.0f} MiB regression-guard threshold "
            f"(GitHub's hard commit limit is 100 MiB) -- refusing to let this be committed. "
            f"Run: python prune_validation_flags.py --retention-days 7 --apply --vacuum "
            f"(against a backup first), or investigate what table is growing via "
            f"CREATE VIRTUAL TABLE stat USING dbstat(main); SELECT name, SUM(pgsize) FROM stat GROUP BY name;"
        )
    if size >= WARN_SIZE_BYTES:
        return True, (
            f"{db_path} is {size_mib:.2f} MiB, above the {WARN_SIZE_BYTES / (1024 * 1024):.0f} MiB "
            f"advisory threshold -- consider running prune_validation_flags.py soon, well before "
            f"it reaches the {FAIL_SIZE_BYTES / (1024 * 1024):.0f} MiB hard limit."
        )
    return True, None


def check_integrity(db_path: Path) -> tuple[bool, str, dict | None]:
    """Returns (ok, message, row_counts). row_counts is None only when the
    check failed before row counts could be read at all. Never raises --
    every failure mode is reported through the return value so callers
    (auto_update.py's --local pre/post checks, this file's own main())
    can react without needing to catch sqlite3 exceptions themselves.

    The connection is always closed before returning, on every path
    (including when PRAGMA integrity_check itself raises rather than
    returning a row, e.g. for a non-SQLite file) -- on Windows, an
    unclosed sqlite3.Connection keeps an OS-level file lock alive well
    past function return, which previously left scratch DBs unreadable/
    undeletable in tests using a real corrupted or non-SQLite file."""
    if not db_path.exists():
        return False, f"{db_path} does not exist -- nothing to check.", None

    conn = None
    result = None
    try:
        conn = sqlite3.connect(str(db_path))
        result = conn.execute("PRAGMA integrity_check").fetchone()[0]
    except sqlite3.Error as e:
        return False, f"Could not open {db_path} for integrity check: {e}", None
    finally:
        if result is None and conn is not None:
            conn.close()

    if result != "ok":
        conn.close()
        return False, f"PRAGMA integrity_check failed for {db_path}: {result}", None

    try:
        counts = get_row_counts(conn)
    except sqlite3.Error as e:
        conn.close()
        return False, f"Integrity check passed but a basic row-count query failed: {e}", None
    conn.close()

    if counts["locations"] == 0 or counts["reviews"] == 0:
        return False, (
            f"{db_path} has {counts['locations']} locations and {counts['reviews']} reviews -- "
            "refusing to commit what looks like an empty/truncated database."
        ), counts

    size_ok, size_message = check_size(db_path)
    if not size_ok:
        return False, size_message, counts

    base_message = f"reviews.db integrity check passed -- {counts['locations']} locations, {counts['reviews']} reviews."
    if size_message:
        base_message = f"{base_message} WARNING: {size_message}"
    return True, base_message, counts


def main() -> int:
    ok, message, _ = check_integrity(DB_PATH)
    print(message if ok else f"::error::{message}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
