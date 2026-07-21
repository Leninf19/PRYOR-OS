"""
Regression tests for bootstrap_mock_snapshot.py (Phase 3 Milestone 3) --
the local-only script that creates MockProvider's snapshot database.

Every test operates on scratch paths inside a tempfile.TemporaryDirectory()
-- never the real dashboard/reviews.db or the real gitignored snapshot.

Run directly: py tests/test_bootstrap_mock_snapshot.py
"""
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import local_safety
import bootstrap_mock_snapshot as bms

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _make_scratch_source_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    db.init_schema(conn)
    conn.execute("INSERT INTO locations (name, city) VALUES ('Loc A', 'City A')")
    loc_id = conn.execute("SELECT id FROM locations WHERE name = 'Loc A'").fetchone()[0]
    conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date, star_rating, last_seen_at)
           VALUES (?, 'k1', 'Alice', '2026-07-01', 5, '2026-07-01')""",
        (loc_id,),
    )
    conn.commit()
    conn.close()


# --- bootstrap() the underlying function -------------------------------------

def test_bootstrap_copies_source_to_snapshot_and_reports_counts():
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "source.db"
        snapshot = Path(tmp) / "snapshot.db"
        _make_scratch_source_db(source)

        ok, message = bms.bootstrap(source_path=source, snapshot_path=snapshot)
        assert ok is True
        assert snapshot.exists()
        assert "1 locations, 1 reviews" in message

        conn = sqlite3.connect(str(snapshot))
        try:
            assert conn.execute("SELECT COUNT(*) FROM locations").fetchone()[0] == 1
            assert conn.execute("SELECT COUNT(*) FROM reviews").fetchone()[0] == 1
        finally:
            conn.close()


def test_bootstrap_refuses_when_source_missing():
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "does-not-exist.db"
        snapshot = Path(tmp) / "snapshot.db"
        ok, message = bms.bootstrap(source_path=source, snapshot_path=snapshot)
        assert ok is False
        assert "does not exist" in message
        assert not snapshot.exists()


def test_bootstrap_refuses_to_overwrite_existing_snapshot_without_force():
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "source.db"
        snapshot = Path(tmp) / "snapshot.db"
        _make_scratch_source_db(source)
        snapshot.write_bytes(b"a pre-existing developer-customized snapshot, must not be clobbered")

        ok, message = bms.bootstrap(source_path=source, snapshot_path=snapshot)
        assert ok is False
        assert "already exists" in message
        assert snapshot.read_bytes() == b"a pre-existing developer-customized snapshot, must not be clobbered"


def test_bootstrap_force_overwrites_existing_snapshot():
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "source.db"
        snapshot = Path(tmp) / "snapshot.db"
        _make_scratch_source_db(source)
        snapshot.write_bytes(b"stale snapshot")

        ok, message = bms.bootstrap(source_path=source, snapshot_path=snapshot, force=True)
        assert ok is True
        assert snapshot.read_bytes() != b"stale snapshot"


def test_bootstrap_creates_parent_directory_if_missing():
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "source.db"
        snapshot = Path(tmp) / "nested" / "dir" / "snapshot.db"
        _make_scratch_source_db(source)
        ok, _ = bms.bootstrap(source_path=source, snapshot_path=snapshot)
        assert ok is True
        assert snapshot.exists()


# --- main()'s CI safety guard ------------------------------------------------

def test_ci_environment_rejects_bootstrap_before_any_file_is_touched():
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "source.db"
        snapshot = Path(tmp) / "snapshot.db"
        _make_scratch_source_db(source)

        with mock.patch.object(bms, "SOURCE_DB_PATH", source), \
             mock.patch.object(bms, "DEFAULT_SNAPSHOT_PATH", snapshot), \
             mock.patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), \
             mock.patch.object(sys, "argv", ["bootstrap_mock_snapshot.py"]):
            try:
                bms.main()
                raise AssertionError("main() must refuse to run under GITHUB_ACTIONS=true")
            except local_safety.UnsafeEnvironmentError:
                pass
        assert not snapshot.exists(), "the guard must fire before any file is touched"


def test_main_succeeds_end_to_end_outside_ci():
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "source.db"
        snapshot = Path(tmp) / "snapshot.db"
        _make_scratch_source_db(source)

        with mock.patch.object(bms, "SOURCE_DB_PATH", source), \
             mock.patch.object(bms, "DEFAULT_SNAPSHOT_PATH", snapshot), \
             mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(sys, "argv", ["bootstrap_mock_snapshot.py"]):
            exit_code = bms.main()
        assert exit_code == 0
        assert snapshot.exists()


def main():
    tests = [
        ("bootstrap() copies source to snapshot and reports counts", test_bootstrap_copies_source_to_snapshot_and_reports_counts),
        ("bootstrap() refuses when the source db is missing", test_bootstrap_refuses_when_source_missing),
        ("bootstrap() refuses to overwrite an existing snapshot without --force", test_bootstrap_refuses_to_overwrite_existing_snapshot_without_force),
        ("bootstrap(force=True) overwrites an existing snapshot", test_bootstrap_force_overwrites_existing_snapshot),
        ("bootstrap() creates the snapshot's parent directory if missing", test_bootstrap_creates_parent_directory_if_missing),
        ("a detected CI environment rejects the bootstrap before any file is touched", test_ci_environment_rejects_bootstrap_before_any_file_is_touched),
        ("main() succeeds end-to-end outside CI", test_main_succeeds_end_to_end_outside_ci),
    ]
    for name, fn in tests:
        run(name, fn)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
