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

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import check_db_integrity

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


def test_cli_main_exit_code_matches_check_integrity():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "scratch.db"
        _make_valid_db(path)
        original = check_db_integrity.DB_PATH
        check_db_integrity.DB_PATH = path
        try:
            assert check_db_integrity.main() == 0
        finally:
            check_db_integrity.DB_PATH = original


def main():
    run("missing file -> fails, counts=None", test_missing_file_fails)
    run("valid DB -> passes with correct row counts", test_valid_db_passes_with_correct_counts)
    run("empty locations/reviews tables -> fails (looks truncated)", test_empty_tables_fail)
    run("corrupted/truncated file -> fails PRAGMA integrity_check", test_corrupted_file_fails_integrity_check)
    run("a non-SQLite file -> fails safely, does not raise", test_not_a_database_file_fails_safely)
    run("a DB missing the expected tables -> fails safely, does not raise", test_missing_tables_fail_safely_not_crash)
    run("main()'s CLI exit code matches check_integrity()'s ok flag", test_cli_main_exit_code_matches_check_integrity)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
