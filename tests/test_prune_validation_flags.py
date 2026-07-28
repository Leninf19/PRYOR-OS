"""
Regression tests for prune_validation_flags.py.

Covers the invariants the maintenance utility is required to hold: preflight
never writes anything; only resolved rows older than the retention cutoff are
deleted; open flags, reviews, and locations are never touched regardless of
age; a second run is a no-op (idempotent); and a failed post-delete
verification rolls back the whole transaction rather than leaving a partial
delete committed.

Every test uses a temporary, isolated SQLite DB -- never the real
dashboard/reviews.db.

Run directly: py tests/test_prune_validation_flags.py
"""
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import prune_validation_flags as maint


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="test_prune_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    conn = db.get_connection()
    db.init_schema(conn)
    return db.DB_PATH, conn


def _iso(days_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


def _add_location(conn, name="Casa Tequila Testtown"):
    cur = conn.execute("INSERT INTO locations (name, city, brand) VALUES (?, 'Testtown', 'Casa Tequila')", (name,))
    conn.commit()
    return cur.lastrowid


def _add_review(conn, loc_id, key="k1"):
    now = "2026-07-28T00:00:00Z"
    cur = conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date, star_rating,
           review_text, review_url, first_seen_at, last_seen_at)
           VALUES (?, ?, 'Jane Doe', '2026-06-01', 5, 'text', 'https://example.com/r', ?, ?)""",
        (loc_id, key, now, now),
    )
    conn.commit()
    return cur.lastrowid


def _add_flag(conn, review_id, loc_id, flag_type, resolved_at=None, detected_days_ago=100):
    conn.execute(
        "INSERT INTO validation_flags (review_id, location_id, flag_type, detail, detected_at, resolved_at) "
        "VALUES (?, ?, ?, NULL, ?, ?)",
        (review_id, loc_id, flag_type, _iso(detected_days_ago), resolved_at),
    )
    conn.commit()


def _counts(conn):
    reviews = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    locations = conn.execute("SELECT COUNT(*) c FROM locations").fetchone()["c"]
    open_flags = conn.execute("SELECT COUNT(*) c FROM validation_flags WHERE resolved_at IS NULL").fetchone()["c"]
    total_flags = conn.execute("SELECT COUNT(*) c FROM validation_flags").fetchone()["c"]
    return reviews, locations, open_flags, total_flags


def _run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        return True
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        return False
    except Exception as e:
        print(f"FAIL: {name} -- unexpected {type(e).__name__}: {e}")
        return False


# ---------------------------------------------------------------------------
# Case: preflight() must never write anything, regardless of how many times
# it's called.
# ---------------------------------------------------------------------------

def test_preflight_is_read_only():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id)
    _add_flag(conn, review_id, loc_id, "missing_text", resolved_at=_iso(50), detected_days_ago=100)
    _add_flag(conn, review_id, loc_id, "missing_url")  # open

    before = _counts(conn)
    report1 = maint.preflight(conn, db_path, retention_days=7)
    report2 = maint.preflight(conn, db_path, retention_days=7)
    after = _counts(conn)

    assert before == after, "preflight() must never modify the database"
    assert report1["total_flags"] == report2["total_flags"] == 2
    assert report1["open_flags"] == 1
    assert report1["resolved_flags"] == 1
    assert report1["integrity_check"] == "ok"


# ---------------------------------------------------------------------------
# Case: run_prune() deletes only RESOLVED rows older than the cutoff -- never
# an open row, never a resolved row still inside the retention window.
# ---------------------------------------------------------------------------

def test_prune_deletes_only_resolved_rows_past_retention():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id)

    _add_flag(conn, review_id, loc_id, "missing_text", resolved_at=_iso(30))  # old resolved -> delete
    _add_flag(conn, review_id, loc_id, "missing_url", resolved_at=_iso(1))    # recent resolved -> keep
    _add_flag(conn, review_id, loc_id, "bad_star_rating")                    # open -> keep regardless of age

    result = maint.run_prune(conn, retention_days=7)
    assert result["rows_deleted"] == 1, f"expected exactly 1 row deleted, got {result['rows_deleted']}"

    remaining = conn.execute("SELECT flag_type, resolved_at FROM validation_flags ORDER BY flag_type").fetchall()
    remaining_types = {r["flag_type"] for r in remaining}
    assert remaining_types == {"missing_url", "bad_star_rating"}, (
        f"wrong rows survived pruning: {remaining_types}"
    )


# ---------------------------------------------------------------------------
# Case: reviews, locations, and open flags are never touched by run_prune(),
# no matter how old they are.
# ---------------------------------------------------------------------------

def test_prune_never_touches_reviews_locations_or_open_flags():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id)
    _add_flag(conn, review_id, loc_id, "missing_text", resolved_at=_iso(400))
    _add_flag(conn, review_id, loc_id, "stale_location", detected_days_ago=400)  # open, very old

    reviews_before, locations_before, open_before, _ = _counts(conn)
    result = maint.run_prune(conn, retention_days=7)
    reviews_after, locations_after, open_after, _ = _counts(conn)

    assert reviews_after == reviews_before, "review count changed"
    assert locations_after == locations_before, "location count changed"
    assert open_after == open_before, "open flag count changed"
    assert result["reviews_unchanged"] and result["locations_unchanged"] and result["open_flags_unchanged"]
    assert result["integrity_after_delete"] == "ok"


# ---------------------------------------------------------------------------
# Case: idempotency -- running prune again with nothing new to delete must
# delete exactly zero rows, and must be safe to call repeatedly.
# ---------------------------------------------------------------------------

def test_prune_is_idempotent():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id)
    _add_flag(conn, review_id, loc_id, "missing_text", resolved_at=_iso(30))

    first = maint.run_prune(conn, retention_days=7)
    assert first["rows_deleted"] == 1

    second = maint.run_prune(conn, retention_days=7)
    assert second["rows_deleted"] == 0, "re-running prune with nothing left to delete must delete 0 rows"

    third = maint.run_prune(conn, retention_days=7)
    assert third["rows_deleted"] == 0


# ---------------------------------------------------------------------------
# Case: a failed post-delete verification must roll back the entire
# transaction -- no partial delete left committed.
# ---------------------------------------------------------------------------

class _LyingCountConn:
    """Wraps a real connection; makes exactly one specific COUNT(*) query
    return a value different from reality, to deterministically exercise
    run_prune()'s rollback path without needing an actual race condition."""

    def __init__(self, real_conn, lie_on_sql_fragment, lie_value):
        self._real = real_conn
        self._lie_on = lie_on_sql_fragment
        self._lie_value = lie_value
        self._calls = 0

    def execute(self, sql, params=()):
        if self._lie_on in sql:
            self._calls += 1
            if self._calls == 2:  # first call establishes the real "before" count
                return _OneRowCursor(self._lie_value)
        return self._real.execute(sql, params)

    def commit(self):
        raise AssertionError("commit() must never be called when a post-delete check fails")

    def rollback(self):
        self._real.rollback()


class _OneRowCursor:
    def __init__(self, value):
        self._value = value

    def fetchone(self):
        return {"c": self._value}


def test_prune_rolls_back_when_open_flag_count_check_fails():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id)
    _add_flag(conn, review_id, loc_id, "missing_text", resolved_at=_iso(30))
    _add_flag(conn, review_id, loc_id, "missing_url")  # open

    before_total = conn.execute("SELECT COUNT(*) c FROM validation_flags").fetchone()["c"]

    lying = _LyingCountConn(conn, "resolved_at IS NULL", lie_value=999)
    try:
        maint.run_prune(lying, retention_days=7)
        raised = False
    except RuntimeError:
        raised = True

    assert raised, "run_prune() must raise when the open-flag count check fails post-delete"
    after_total = conn.execute("SELECT COUNT(*) c FROM validation_flags").fetchone()["c"]
    assert after_total == before_total, (
        "a failed verification must roll back the delete -- row count changed anyway"
    )


def main():
    tests = [
        ("preflight() is read-only", test_preflight_is_read_only),
        ("prune deletes only resolved rows past retention", test_prune_deletes_only_resolved_rows_past_retention),
        ("prune never touches reviews/locations/open flags", test_prune_never_touches_reviews_locations_or_open_flags),
        ("prune is idempotent", test_prune_is_idempotent),
        ("prune rolls back when a post-delete check fails", test_prune_rolls_back_when_open_flag_count_check_fails),
    ]
    results = [_run(name, fn) for name, fn in tests]
    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
