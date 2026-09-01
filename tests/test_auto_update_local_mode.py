"""
Orchestration tests for auto_update.py's main() -- the lock/environment-
guard/integrity-check/git sequencing added around --local mode. Every test
monkeypatches auto_update.BASE_DIR, db.DB_PATH, and auto_update.LOCAL_MODE
to point at a tempfile.TemporaryDirectory() scratch DB, and replaces
_scrape_and_write / _git_commit_push_deploy with fakes so no real
Playwright browser, git command, or Vercel deploy ever runs. The real repo
and the real dashboard/reviews.db are never touched by this file.

Run directly: py tests/test_auto_update_local_mode.py
"""
import asyncio
import inspect
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import auto_update
import db
import local_safety
import tenant_keys
import tenant_paths

TEST_TENANT_ID = tenant_keys.DEFAULT_TENANT_ID

results = []


def run(name, fn):
    try:
        asyncio.run(fn()) if inspect.iscoroutinefunction(fn) else fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _make_valid_db(path: Path, n_locations=2, n_reviews=3):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE locations (id INTEGER PRIMARY KEY, name TEXT)")
    conn.execute("CREATE TABLE reviews (id INTEGER PRIMARY KEY, location_id INTEGER)")
    for i in range(n_locations):
        conn.execute("INSERT INTO locations (name) VALUES (?)", (f"Loc {i}",))
    for i in range(n_reviews):
        conn.execute("INSERT INTO reviews (location_id) VALUES (?)", (1,))
    conn.commit()
    conn.close()


class _Scratch:
    """Monkeypatches auto_update.BASE_DIR / db.DB_PATH / auto_update.LOCAL_MODE
    for the duration of a `with` block, restoring the originals afterward --
    the only way to exercise main()'s new orchestration logic without
    touching the real repo/DB, since BASE_DIR and DB_PATH are plain module
    globals auto_update.main() reads directly."""

    def __init__(self, local_mode=True, seed_db=True):
        self.local_mode = local_mode
        self.seed_db = seed_db

    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.base = base
        self.db_path = base / "dashboard" / "reviews.db"
        if self.seed_db:
            _make_valid_db(self.db_path)
        else:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)

        self._orig_base_dir = auto_update.BASE_DIR
        self._orig_db_path = db.DB_PATH
        self._orig_local_mode = auto_update.LOCAL_MODE
        self._orig_reviews_csv = auto_update.REVIEWS_CSV
        self._orig_tenant_id_arg = auto_update.TENANT_ID_ARG
        self._orig_scrape = auto_update._scrape_and_write
        self._orig_git = auto_update._git_commit_push_deploy

        auto_update.BASE_DIR = base
        db.DB_PATH = self.db_path
        auto_update.LOCAL_MODE = self.local_mode
        # load_existing()/append_to_csv() read this module-level constant
        # directly -- without repointing it too, main() would read the
        # REAL dashboard/reviews.csv (read-only, but not truly sandboxed).
        auto_update.REVIEWS_CSV = base / "dashboard" / "reviews.csv"
        # Multi-Tenant Phase 4D: main() now re-resolves BOTH db.DB_PATH and
        # REVIEWS_CSV from --tenant-id before anything else runs -- the
        # tenant_paths override below must point at the exact same scratch
        # paths set above, or main() would silently overwrite them back to
        # the real registered LTA paths the moment it starts.
        auto_update.TENANT_ID_ARG = TEST_TENANT_ID
        tenant_paths._set_review_db_path_for_tests(TEST_TENANT_ID, self.db_path)
        tenant_paths._set_export_dir_for_tests(TEST_TENANT_ID, base / "dashboard" / "private-data")
        self.git_called = False
        self.scrape_called = False
        return self

    def __exit__(self, *exc):
        auto_update.BASE_DIR = self._orig_base_dir
        db.DB_PATH = self._orig_db_path
        auto_update.LOCAL_MODE = self._orig_local_mode
        auto_update.REVIEWS_CSV = self._orig_reviews_csv
        auto_update.TENANT_ID_ARG = self._orig_tenant_id_arg
        auto_update._scrape_and_write = self._orig_scrape
        auto_update._git_commit_push_deploy = self._orig_git
        tenant_paths._reset_review_db_paths_for_tests()
        tenant_paths._reset_export_dirs_for_tests()
        self.tmp.cleanup()
        return False

    @property
    def lock_path(self):
        return self.base / local_safety.LOCAL_LOCK_FILENAME

    def set_fake_scrape(self, fn):
        auto_update._scrape_and_write = fn

    def set_fake_git(self, fn=None):
        def _default(new_rows):
            self.git_called = True
        auto_update._git_commit_push_deploy = fn or _default


async def test_normal_local_run_acquires_and_releases_lock():
    with _Scratch(local_mode=True) as s:
        async def fake_scrape(existing):
            assert s.lock_path.exists(), "lock must be held while _scrape_and_write runs"
            return [], []
        s.set_fake_scrape(fake_scrape)
        s.set_fake_git()
        await auto_update.main()
        assert not s.lock_path.exists(), "lock must be released after a successful run"
        assert s.git_called, "git/deploy step must run after a clean local run"


async def test_second_concurrent_local_run_is_rejected():
    with _Scratch(local_mode=True) as s:
        local_safety.acquire(s.lock_path)  # simulate another run already in progress
        try:
            async def fake_scrape(existing):
                raise AssertionError("must never reach the scrape step while the lock is held")
            s.set_fake_scrape(fake_scrape)
            s.set_fake_git()
            try:
                await auto_update.main()
                raise AssertionError("main() must raise when the lock is already held")
            except local_safety.LocalLockError:
                pass
            assert not s.git_called, "git/deploy must never run when the lock could not be acquired"
        finally:
            local_safety.release(s.lock_path)


async def test_lock_released_after_scrape_exception():
    with _Scratch(local_mode=True) as s:
        async def fake_scrape(existing):
            raise RuntimeError("simulated Playwright crash mid-scrape")
        s.set_fake_scrape(fake_scrape)
        s.set_fake_git()
        try:
            await auto_update.main()
            raise AssertionError("main() must propagate the scrape failure")
        except RuntimeError:
            pass
        assert not s.lock_path.exists(), "lock must be released even though the scrape step raised"
        assert not s.git_called, "git/deploy must never run after a scrape failure"


async def test_pre_write_integrity_failure_blocks_mutation():
    with _Scratch(local_mode=True, seed_db=False) as s:
        # A corrupted DB present before the scrape even starts.
        s.db_path.write_text("not a real sqlite file", encoding="utf-8")

        async def fake_scrape(existing):
            raise AssertionError("must never reach the scrape step when the pre-check fails")
        s.set_fake_scrape(fake_scrape)
        s.set_fake_git()
        try:
            await auto_update.main()
            raise AssertionError("main() must raise on a failing pre-scrape integrity check")
        except RuntimeError as e:
            assert "Refusing to start" in str(e)
        assert not s.lock_path.exists(), "lock must still be released"
        assert not s.git_called


async def test_post_write_integrity_failure_blocks_git():
    with _Scratch(local_mode=True) as s:
        async def fake_scrape(existing):
            # Simulate the scrape corrupting the DB on the way out.
            s.db_path.write_text("corrupted after the fact", encoding="utf-8")
            return [{"location_name": "X"}], []
        s.set_fake_scrape(fake_scrape)
        s.set_fake_git()
        try:
            await auto_update.main()
            raise AssertionError("main() must raise on a failing post-scrape integrity check")
        except RuntimeError as e:
            assert "Post-scrape integrity check failed" in str(e)
        assert not s.git_called, "git commit/push/deploy must never run after a failed post-check"
        assert not s.lock_path.exists(), "lock must still be released"


async def test_no_git_operations_when_blocked():
    # Covered by both integrity-failure tests above (git_called stays
    # False in each) -- this test asserts it explicitly as its own case
    # per the requirement to test "no git commit or push occurs".
    with _Scratch(local_mode=True, seed_db=False) as s:
        s.db_path.write_text("garbage", encoding="utf-8")
        git_calls = []
        s.set_fake_git(lambda new_rows: git_calls.append(new_rows))

        async def fake_scrape(existing):
            return [], []
        s.set_fake_scrape(fake_scrape)
        try:
            await auto_update.main()
        except RuntimeError:
            pass
        assert git_calls == [], "no git/deploy call of any kind must occur when blocked"


async def test_ci_environment_rejects_local_mode():
    with _Scratch(local_mode=True) as s:
        import os
        os.environ["GITHUB_ACTIONS"] = "true"
        try:
            async def fake_scrape(existing):
                raise AssertionError("must never reach the scrape step in a detected CI environment")
            s.set_fake_scrape(fake_scrape)
            s.set_fake_git()
            try:
                await auto_update.main()
                raise AssertionError("main() must refuse to run --local under GITHUB_ACTIONS=true")
            except local_safety.UnsafeEnvironmentError:
                pass
            assert not s.lock_path.exists(), "the lock must never even be created when the environment guard fires first"
            assert not s.git_called
        finally:
            del os.environ["GITHUB_ACTIONS"]


async def test_main_never_trusts_a_pre_tampered_db_path():
    """Multi-Tenant Phase 4D revision: main() now resolves db.DB_PATH from
    the tenant registry (tenant_paths.resolve_review_db_path()) itself, at
    the very top of every run, before load_existing()/ensure_expected_db_path()/
    anything else -- it never trusts whatever db.DB_PATH happened to
    already be set to. This is a STRONGER guarantee than the pre-Phase-4D
    design (where ensure_expected_db_path() was the only thing standing
    between some earlier stray db.DB_PATH mutation and a wrong-file write,
    and a caller had to remember to set db.DB_PATH correctly in the first
    place). Proven here by deliberately tampering with db.DB_PATH BEFORE
    calling main(), then confirming main() corrects it back to the
    tenant's own registered path before doing anything -- ensure_expected_db_path()
    itself (still exercised, still a real safety net for any future
    refactor) is covered directly by test_local_safety.py."""
    with _Scratch(local_mode=True) as s:
        async def fake_scrape(existing):
            return [], []
        s.set_fake_scrape(fake_scrape)
        s.set_fake_git()
        db.DB_PATH = s.base / "somewhere-else.db"  # tampered, deliberately wrong
        _make_valid_db(db.DB_PATH)

        await auto_update.main()

        assert db.DB_PATH == s.db_path, (
            "main() must re-resolve db.DB_PATH from the tenant registry on every run, "
            "ignoring any value it was already set to"
        )


async def test_baseline_and_final_row_count_reporting():
    with _Scratch(local_mode=True) as s:
        async def fake_scrape(existing):
            conn = sqlite3.connect(str(s.db_path))
            conn.execute("INSERT INTO reviews (location_id) VALUES (1)")
            conn.commit()
            conn.close()
            return [], []
        s.set_fake_scrape(fake_scrape)
        s.set_fake_git()

        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            await auto_update.main()
        output = buf.getvalue()
        assert "locations: 2 -> 2" in output, output
        assert "reviews: 3 -> 4" in output, output


async def test_normal_non_local_behavior_unchanged():
    with _Scratch(local_mode=False) as s:
        calls = []

        async def fake_scrape(existing):
            calls.append("scrape")
            return [{"location_name": "X"}], []
        s.set_fake_scrape(fake_scrape)

        def fake_git(new_rows):
            calls.append("git")
        s.set_fake_git(fake_git)

        await auto_update.main()
        assert calls == ["scrape"], (
            "the non-local path must call _scrape_and_write and then return -- "
            f"it must never touch the lock, integrity checks, or git/deploy step (got {calls})"
        )
        assert not s.lock_path.exists(), "no lock file should ever be created in cloud/CI mode"


def main():
    run("a normal local run acquires the lock during scrape and releases it after", test_normal_local_run_acquires_and_releases_lock)
    run("a second concurrent local run is rejected (LocalLockError), no git call", test_second_concurrent_local_run_is_rejected)
    run("the lock is released after the scrape step raises", test_lock_released_after_scrape_exception)
    run("a failing pre-scrape integrity check blocks the scrape entirely", test_pre_write_integrity_failure_blocks_mutation)
    run("a failing post-scrape integrity check blocks git/deploy", test_post_write_integrity_failure_blocks_git)
    run("no git operation of any kind occurs when a run is blocked", test_no_git_operations_when_blocked)
    run("a detected CI environment rejects --local before the lock is even created", test_ci_environment_rejects_local_mode)
    run("main() never trusts a pre-tampered db.DB_PATH -- always re-resolves from the tenant registry", test_main_never_trusts_a_pre_tampered_db_path)
    run("baseline and final row counts are reported with correct deltas", test_baseline_and_final_row_count_reporting)
    run("normal (non-local) behavior is completely unchanged: no lock, no integrity check, no git call", test_normal_non_local_behavior_unchanged)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
