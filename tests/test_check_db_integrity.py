"""
Regression tests for check_db_integrity.py's check_integrity() -- every case
runs against a scratch SQLite file inside a tempfile.TemporaryDirectory().
The real dashboard/reviews.db is never opened by this file.

Run directly: py tests/test_check_db_integrity.py
"""
import sqlite3
import sys
import tempfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import check_db_integrity
import tenant_keys
import tenant_paths

TEST_TENANT_ID = tenant_keys.DEFAULT_TENANT_ID

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _make_valid_db(path: Path, n_locations=2, n_reviews=3):
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE locations (id INTEGER PRIMARY KEY, name TEXT)")
    conn.execute("CREATE TABLE reviews (id INTEGER PRIMARY KEY, location_id INTEGER)")
    for i in range(n_locations):
        conn.execute("INSERT INTO locations (name) VALUES (?)", (f"Loc {i}",))
    for i in range(n_reviews):
        conn.execute("INSERT INTO reviews (location_id) VALUES (?)", (1,))
    conn.commit()
    conn.close()


def test_missing_file_fails():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "does-not-exist.db"
        ok, message, counts = check_db_integrity.check_integrity(path)
        assert not ok, "a missing file must fail the check"
        assert counts is None
        assert "does not exist" in message


def test_valid_db_passes_with_correct_counts():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "scratch.db"
        _make_valid_db(path, n_locations=5, n_reviews=42)
        ok, message, counts = check_db_integrity.check_integrity(path)
        assert ok, message
        assert counts == {"locations": 5, "reviews": 42}
        assert "5 locations, 42 reviews" in message


def test_empty_tables_fail():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "scratch.db"
        _make_valid_db(path, n_locations=0, n_reviews=0)
        ok, message, counts = check_db_integrity.check_integrity(path)
        assert not ok, "zero locations and zero reviews must fail as a likely-truncated DB"
        assert "empty/truncated" in message


def test_corrupted_file_fails_integrity_check():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "scratch.db"
        _make_valid_db(path)
        # Corrupt it: truncate to a fraction of its size mid-page, which
        # PRAGMA integrity_check reliably flags without needing to
        # construct a specific corruption pattern by hand.
        raw = path.read_bytes()
        path.write_bytes(raw[: len(raw) // 3])
        ok, message, counts = check_db_integrity.check_integrity(path)
        assert not ok, "a truncated/corrupted file must fail"


def test_not_a_database_file_fails_safely():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "scratch.db"
        path.write_text("this is not a sqlite file at all", encoding="utf-8")
        ok, message, counts = check_db_integrity.check_integrity(path)
        assert not ok, "a non-database file must fail, not raise"


def test_missing_tables_fail_safely_not_crash():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "scratch.db"
        conn = sqlite3.connect(str(path))
        conn.execute("CREATE TABLE unrelated (id INTEGER)")
        conn.commit()
        conn.close()
        ok, message, counts = check_db_integrity.check_integrity(path)
        assert not ok, "a DB missing the expected tables must fail cleanly, not raise"


def _pad_to(path: Path, target_bytes: int):
    """Grows a valid scratch DB to at least target_bytes by appending inert
    trailing bytes -- SQLite tolerates (and PRAGMA integrity_check ignores)
    bytes appended after the last real page, so this changes only the file
    size on disk, not the database's actual content or validity."""
    current = path.stat().st_size
    if current < target_bytes:
        with open(path, "ab") as f:
            f.write(b"\0" * (target_bytes - current))


def test_check_size_under_warn_threshold_is_silent():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "scratch.db"
        _make_valid_db(path)
        ok, message = check_db_integrity.check_size(path)
        assert ok and message is None, "a small file must produce no warning at all"


def test_check_size_between_warn_and_fail_is_a_non_fatal_warning():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "scratch.db"
        _make_valid_db(path)
        _pad_to(path, check_db_integrity.WARN_SIZE_BYTES + 1024)
        ok, message = check_db_integrity.check_size(path)
        assert ok, "the warn tier must still be considered ok=True -- advisory, not fatal"
        assert message is not None and "advisory threshold" in message


def test_check_size_at_or_above_fail_threshold_fails():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "scratch.db"
        _make_valid_db(path)
        _pad_to(path, check_db_integrity.FAIL_SIZE_BYTES)
        ok, message = check_db_integrity.check_size(path)
        assert not ok, "at or above the fail threshold must be treated as a hard failure"
        assert "regression-guard threshold" in message
        assert "prune_validation_flags.py" in message, "the failure message must point at the actual remediation"


def test_check_integrity_fails_overall_when_size_guard_fails():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "scratch.db"
        _make_valid_db(path)
        _pad_to(path, check_db_integrity.FAIL_SIZE_BYTES)
        ok, message, counts = check_db_integrity.check_integrity(path)
        assert not ok, "check_integrity() must propagate a size-guard failure as an overall failure"
        assert counts is not None, "row counts should still be reported even though the size guard failed"
        assert "regression-guard threshold" in message


def test_check_integrity_still_passes_and_includes_warning_text_in_warn_tier():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "scratch.db"
        _make_valid_db(path)
        _pad_to(path, check_db_integrity.WARN_SIZE_BYTES + 1024)
        ok, message, counts = check_db_integrity.check_integrity(path)
        assert ok, "the warn tier alone must not fail the overall check"
        assert "WARNING" in message, "the warning must still be visible in the passing message, not silently dropped"


def test_cli_main_exit_code_matches_check_integrity():
    # Multi-Tenant Phase 4D: main() now requires --tenant-id and resolves
    # its db path via tenant_paths.resolve_review_db_path() -- simulated
    # here via sys.argv + a patched resolver, the same pattern every other
    # tenant-aware script's CLI tests already use.
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "scratch.db"
        _make_valid_db(path)
        with mock.patch.object(sys, "argv", ["check_db_integrity.py", "--tenant-id", TEST_TENANT_ID]), \
             mock.patch.object(tenant_paths, "resolve_review_db_path", return_value=path):
            assert check_db_integrity.main() == 0


def test_cli_main_requires_tenant_id():
    with mock.patch.object(sys, "argv", ["check_db_integrity.py"]):
        try:
            check_db_integrity.main()
            raise AssertionError("argparse should have exited on a missing --tenant-id")
        except SystemExit as e:
            assert e.code == 2


def test_cli_main_fails_closed_for_an_unregistered_tenant():
    with mock.patch.object(sys, "argv", ["check_db_integrity.py", "--tenant-id", "t_unregistered-tenant"]):
        assert check_db_integrity.main() == 1


def main():
    run("missing file -> fails, counts=None", test_missing_file_fails)
    run("valid DB -> passes with correct row counts", test_valid_db_passes_with_correct_counts)
    run("empty locations/reviews tables -> fails (looks truncated)", test_empty_tables_fail)
    run("corrupted/truncated file -> fails PRAGMA integrity_check", test_corrupted_file_fails_integrity_check)
    run("a non-SQLite file -> fails safely, does not raise", test_not_a_database_file_fails_safely)
    run("a DB missing the expected tables -> fails safely, does not raise", test_missing_tables_fail_safely_not_crash)
    run("check_size(): under the warn threshold is silent", test_check_size_under_warn_threshold_is_silent)
    run("check_size(): between warn and fail is a non-fatal warning", test_check_size_between_warn_and_fail_is_a_non_fatal_warning)
    run("check_size(): at/above the fail threshold fails, with remediation pointer", test_check_size_at_or_above_fail_threshold_fails)
    run("check_integrity(): overall fails when the size guard fails", test_check_integrity_fails_overall_when_size_guard_fails)
    run("check_integrity(): still passes but surfaces the warning text in the warn tier", test_check_integrity_still_passes_and_includes_warning_text_in_warn_tier)
    run("main()'s CLI exit code matches check_integrity()'s ok flag", test_cli_main_exit_code_matches_check_integrity)
    run("main() requires --tenant-id (argparse exits 2 without it)", test_cli_main_requires_tenant_id)
    run("main() fails closed for an unregistered tenant", test_cli_main_fails_closed_for_an_unregistered_tenant)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
