"""
Regression tests for local_safety.py -- the lock/environment-guard/path-
validation primitives that make auto_update.py --local safe. Every test
uses a tempfile.TemporaryDirectory(); the real repo and the real
dashboard/reviews.db are never touched.

Run directly: py tests/test_local_safety.py
"""
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import local_safety

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def test_acquire_then_release_allows_reacquire():
    with tempfile.TemporaryDirectory() as tmp:
        lock_path = Path(tmp) / ".local_db_mutation.lock"
        local_safety.acquire(lock_path)
        assert lock_path.exists(), "lock file must exist after acquire()"
        local_safety.release(lock_path)
        assert not lock_path.exists(), "lock file must be gone after release()"
        # Must be reacquirable afterward -- release() actually freed it.
        local_safety.acquire(lock_path)
        local_safety.release(lock_path)


def test_lock_file_contains_metadata():
    with tempfile.TemporaryDirectory() as tmp:
        lock_path = Path(tmp) / ".local_db_mutation.lock"
        local_safety.acquire(lock_path)
        try:
            import json
            data = json.loads(lock_path.read_text(encoding="utf-8"))
            assert data["pid"] == os.getpid(), "lock must record the current PID"
            assert data["hostname"], "lock must record a hostname"
            assert data["started_at"], "lock must record a start timestamp"
            assert "command" in data, "lock must record the invoking command"
        finally:
            local_safety.release(lock_path)


def test_second_concurrent_acquire_is_rejected():
    with tempfile.TemporaryDirectory() as tmp:
        lock_path = Path(tmp) / ".local_db_mutation.lock"
        local_safety.acquire(lock_path)
        try:
            try:
                local_safety.acquire(lock_path)
                raise AssertionError("a second acquire() while the lock is held must raise LocalLockError")
            except local_safety.LocalLockError as e:
                assert str(os.getpid()) in str(e), "conflict message should mention the holding PID"
        finally:
            local_safety.release(lock_path)


def test_release_after_exception_still_frees_lock():
    with tempfile.TemporaryDirectory() as tmp:
        lock_path = Path(tmp) / ".local_db_mutation.lock"
        local_safety.acquire(lock_path)
        try:
            try:
                raise RuntimeError("simulated failure mid-mutation")
            finally:
                local_safety.release(lock_path)
        except RuntimeError:
            pass
        assert not lock_path.exists(), "lock must be released even when the protected code raised"
        # Someone else must now be able to acquire it.
        local_safety.acquire(lock_path)
        local_safety.release(lock_path)


def test_release_is_safe_to_call_when_never_acquired():
    with tempfile.TemporaryDirectory() as tmp:
        lock_path = Path(tmp) / ".local_db_mutation.lock"
        local_safety.release(lock_path)  # must not raise
        local_safety.release(None)       # must not raise


def test_stale_lock_from_dead_pid_is_reported_but_not_removed():
    with tempfile.TemporaryDirectory() as tmp:
        lock_path = Path(tmp) / ".local_db_mutation.lock"
        import json, socket
        # A PID astronomically unlikely to be running right now.
        fake_stale = {"pid": 999_999_999, "hostname": socket.gethostname(),
                      "started_at": "2020-01-01T00:00:00+00:00", "command": "old command"}
        lock_path.write_text(json.dumps(fake_stale), encoding="utf-8")
        try:
            local_safety.acquire(lock_path)
            raise AssertionError("a present lock file must always block acquire(), stale or not")
        except local_safety.LocalLockError as e:
            msg = str(e)
            assert "does NOT appear to be running" in msg, "must flag likely staleness for a dead PID"
            assert lock_path.exists(), "must NEVER auto-delete the lock, even when it looks stale"


def test_lock_from_different_host_is_never_assumed_stale():
    with tempfile.TemporaryDirectory() as tmp:
        lock_path = Path(tmp) / ".local_db_mutation.lock"
        import json
        fake = {"pid": 123, "hostname": "some-other-machine", "started_at": "2020-01-01T00:00:00+00:00", "command": "x"}
        lock_path.write_text(json.dumps(fake), encoding="utf-8")
        try:
            local_safety.acquire(lock_path)
            raise AssertionError("must raise")
        except local_safety.LocalLockError as e:
            assert "could not be determined" in str(e), "a different hostname must never be treated as verifiably stale"


def test_unreadable_lock_contents_still_blocks_and_never_deletes():
    with tempfile.TemporaryDirectory() as tmp:
        lock_path = Path(tmp) / ".local_db_mutation.lock"
        lock_path.write_text("not json at all", encoding="utf-8")
        try:
            local_safety.acquire(lock_path)
            raise AssertionError("must raise")
        except local_safety.LocalLockError:
            assert lock_path.exists(), "an unreadable lock must still never be auto-deleted"


def test_environment_guard_rejects_github_actions():
    try:
        local_safety.ensure_safe_for_local_mode(env={"GITHUB_ACTIONS": "true"})
        raise AssertionError("must raise UnsafeEnvironmentError")
    except local_safety.UnsafeEnvironmentError as e:
        assert "GITHUB_ACTIONS" in str(e)


def test_environment_guard_rejects_vercel():
    try:
        local_safety.ensure_safe_for_local_mode(env={"VERCEL": "1"})
        raise AssertionError("must raise UnsafeEnvironmentError")
    except local_safety.UnsafeEnvironmentError:
        pass


def test_environment_guard_rejects_ci():
    try:
        local_safety.ensure_safe_for_local_mode(env={"CI": "true"})
        raise AssertionError("must raise UnsafeEnvironmentError")
    except local_safety.UnsafeEnvironmentError:
        pass


def test_environment_guard_rejects_vercel_env_production():
    try:
        local_safety.ensure_safe_for_local_mode(env={"VERCEL_ENV": "production"})
        raise AssertionError("must raise UnsafeEnvironmentError")
    except local_safety.UnsafeEnvironmentError:
        pass


def test_environment_guard_allows_clean_local_environment():
    local_safety.ensure_safe_for_local_mode(env={})  # must not raise


def test_environment_guard_generic_bypass_value_does_not_work():
    for bogus in ["1", "true", "yes", "bypass"]:
        try:
            local_safety.ensure_safe_for_local_mode(env={"GITHUB_ACTIONS": "true", "LTA_LOCAL_MODE_TESTING_OVERRIDE": bogus})
            raise AssertionError(f"a generic value ({bogus!r}) must NOT satisfy the override")
        except local_safety.UnsafeEnvironmentError:
            pass


def test_environment_guard_exact_override_value_works():
    # Only the exact, narrowly-named, documented value bypasses the guard --
    # and only for testing this guard itself, never a real deployment.
    local_safety.ensure_safe_for_local_mode(env={
        "GITHUB_ACTIONS": "true",
        "LTA_LOCAL_MODE_TESTING_OVERRIDE": "i-understand-this-is-for-testing-only",
    })


def test_db_path_validation_accepts_expected_path():
    # Multi-Tenant Phase 4D revision: ensure_expected_db_path()'s second
    # argument is now the caller's own resolved expected path directly
    # (e.g. tenant_paths.resolve_review_db_path(tenant_id)'s result), not a
    # base directory this function derives dashboard/reviews.db from.
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        expected = base / "dashboard" / "reviews.db"
        expected.parent.mkdir(parents=True)
        expected.touch()
        local_safety.ensure_expected_db_path(expected, expected)  # must not raise


def test_db_path_validation_rejects_unexpected_path():
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        wrong = base / "somewhere-else.db"
        expected = base / "dashboard" / "reviews.db"
        try:
            local_safety.ensure_expected_db_path(wrong, expected)
            raise AssertionError("must raise ValueError for an unexpected DB path")
        except ValueError:
            pass


def main():
    run("acquire() then release() allows immediate reacquisition", test_acquire_then_release_allows_reacquire)
    run("lock file contains pid/hostname/started_at/command", test_lock_file_contains_metadata)
    run("a second concurrent acquire() is rejected with LocalLockError", test_second_concurrent_acquire_is_rejected)
    run("lock is released even after the protected code raises", test_release_after_exception_still_frees_lock)
    run("release() is a safe no-op when never acquired / given None", test_release_is_safe_to_call_when_never_acquired)
    run("a lock from a dead PID is reported as likely-stale but never auto-removed", test_stale_lock_from_dead_pid_is_reported_but_not_removed)
    run("a lock from a different hostname is never assumed stale", test_lock_from_different_host_is_never_assumed_stale)
    run("unreadable lock contents still block acquisition and are never deleted", test_unreadable_lock_contents_still_blocks_and_never_deletes)
    run("environment guard rejects GITHUB_ACTIONS", test_environment_guard_rejects_github_actions)
    run("environment guard rejects VERCEL", test_environment_guard_rejects_vercel)
    run("environment guard rejects CI", test_environment_guard_rejects_ci)
    run("environment guard rejects VERCEL_ENV=production", test_environment_guard_rejects_vercel_env_production)
    run("environment guard allows a clean local environment", test_environment_guard_allows_clean_local_environment)
    run("a generic/guessed override value never satisfies the guard", test_environment_guard_generic_bypass_value_does_not_work)
    run("only the exact, narrowly-named override value satisfies the guard", test_environment_guard_exact_override_value_works)
    run("DB path validation accepts the expected dashboard/reviews.db path", test_db_path_validation_accepts_expected_path)
    run("DB path validation rejects any other path", test_db_path_validation_rejects_unexpected_path)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
