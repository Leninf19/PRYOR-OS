"""
Regression tests for dedupe_review_revisions.py.

Covers the invariants this one-time maintenance utility is required to
hold: preflight never writes anything; a row is deleted if and only if its
own old_value/new_value are identical after whitespace normalization
(the growth bug's exact signature); reviews, locations, and every genuine
(non-duplicate) revision row are never touched; a second run is a no-op
(idempotent); and a failed post-delete verification rolls back the whole
transaction rather than leaving a partial delete committed.

Every test uses a temporary, isolated SQLite DB -- never the real
dashboard/reviews.db.

Run directly: py tests/test_dedupe_review_revisions.py
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import dedupe_review_revisions as maint


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="test_dedupe_revisions_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    conn = db.get_connection()
    db.init_schema(conn)
    return db.DB_PATH, conn


def _add_location(conn, name="Casa Tequila Testtown"):
    cur = conn.execute("INSERT INTO locations (name, city, brand) VALUES (?, 'Testtown', 'Casa Tequila')", (name,))
    conn.commit()
    return cur.lastrowid


def _add_review(conn, loc_id, key="k1"):
    now = "2026-09-01T00:00:00Z"
    cur = conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date, star_rating,
           review_text, owner_response, review_url, first_seen_at, last_seen_at)
           VALUES (?, ?, 'Jane Doe', '2026-08-01', 5, 'text', 'Thanks!', 'https://example.com/r', ?, ?)""",
        (loc_id, key, now, now),
    )
    conn.commit()
    return cur.lastrowid


def _add_revision(conn, review_id, field, old_value, new_value):
    conn.execute(
        "INSERT INTO review_revisions (review_id, field_changed, old_value, new_value) VALUES (?, ?, ?, ?)",
        (review_id, field, old_value, new_value),
    )
    conn.commit()


def _counts(conn):
    reviews = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    locations = conn.execute("SELECT COUNT(*) c FROM locations").fetchone()["c"]
    total_revisions = conn.execute("SELECT COUNT(*) c FROM review_revisions").fetchone()["c"]
    return reviews, locations, total_revisions


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
# Case: preflight() must never write anything.
# ---------------------------------------------------------------------------

def test_preflight_is_read_only():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id)
    _add_revision(conn, review_id, "owner_response", "Thanks!", "Thanks!\n")   # whitespace-only -> duplicate
    _add_revision(conn, review_id, "owner_response", "Thanks!", "Thanks so much!")  # genuine change

    before = _counts(conn)
    report1 = maint.preflight(conn)
    report2 = maint.preflight(conn)
    after = _counts(conn)

    assert before == after, "preflight() must never modify the database"
    assert report1["total_rows"] == report2["total_rows"] == 2
    assert report1["would_delete"] == 1
    assert report1["would_remain"] == 1
    assert report1["integrity_check"] == "ok"


# ---------------------------------------------------------------------------
# Case: run_dedupe() deletes a row if and only if old_value/new_value are
# identical after normalization -- never a row where they genuinely differ.
# ---------------------------------------------------------------------------

def test_dedupe_deletes_only_whitespace_only_duplicates():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id)

    _add_revision(conn, review_id, "owner_response", "Thanks!", "Thanks! ")      # trailing space -> delete
    _add_revision(conn, review_id, "owner_response", "Thanks!", "Thanks!\n")     # trailing newline -> delete
    _add_revision(conn, review_id, "owner_response", " Thanks!", "Thanks!")     # leading space (old side) -> delete
    _add_revision(conn, review_id, "owner_response", "Thanks!", "Thanks so much!")  # genuine -> keep
    _add_revision(conn, review_id, "review_text", "Good food", "Great food")    # genuine -> keep

    result = maint.run_dedupe(conn)
    assert result["rows_deleted"] == 3, f"expected exactly 3 whitespace-only duplicates deleted, got {result['rows_deleted']}"

    remaining = conn.execute("SELECT field_changed, old_value, new_value FROM review_revisions ORDER BY id").fetchall()
    assert len(remaining) == 2
    assert {(r["field_changed"], r["old_value"], r["new_value"]) for r in remaining} == {
        ("owner_response", "Thanks!", "Thanks so much!"),
        ("review_text", "Good food", "Great food"),
    }


# ---------------------------------------------------------------------------
# Case: reviews, locations, and every genuine revision row are never
# touched, regardless of how many duplicate rows surround them.
# ---------------------------------------------------------------------------

def test_dedupe_never_touches_reviews_locations_or_genuine_rows():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id)
    genuine_id = conn.execute(
        "INSERT INTO review_revisions (review_id, field_changed, old_value, new_value) VALUES (?, 'owner_response', 'A', 'B')",
        (review_id,),
    ).lastrowid
    conn.commit()
    for _ in range(5):
        _add_revision(conn, review_id, "owner_response", "B", "B ")  # duplicate, repeated

    reviews_before, locations_before, _ = _counts(conn)
    result = maint.run_dedupe(conn)
    reviews_after, locations_after, _ = _counts(conn)

    assert reviews_after == reviews_before, "review count changed"
    assert locations_after == locations_before, "location count changed"
    assert result["reviews_unchanged"] and result["locations_unchanged"] and result["genuine_rows_preserved"]
    assert result["integrity_after_delete"] == "ok"
    still_there = conn.execute("SELECT id FROM review_revisions WHERE id = ?", (genuine_id,)).fetchone()
    assert still_there is not None, "the one genuine revision row was deleted"


# ---------------------------------------------------------------------------
# Case: idempotency -- a second run with nothing left to delete must delete
# exactly zero rows.
# ---------------------------------------------------------------------------

def test_dedupe_is_idempotent():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id)
    _add_revision(conn, review_id, "owner_response", "Thanks!", "Thanks! ")

    first = maint.run_dedupe(conn)
    assert first["rows_deleted"] == 1

    second = maint.run_dedupe(conn)
    assert second["rows_deleted"] == 0, "re-running dedupe with nothing left to delete must delete 0 rows"

    third = maint.run_dedupe(conn)
    assert third["rows_deleted"] == 0


# ---------------------------------------------------------------------------
# Case: None/empty old_value or new_value never crashes the predicate and is
# handled the same way db.py's _normalize_text_field() treats it.
# ---------------------------------------------------------------------------

def test_dedupe_handles_none_and_empty_values_safely():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id)
    _add_revision(conn, review_id, "owner_response", None, "")   # None vs "" -> both empty -> duplicate
    _add_revision(conn, review_id, "owner_response", None, "Thanks!")  # genuine first-time reply -> keep

    result = maint.run_dedupe(conn)
    assert result["rows_deleted"] == 1
    remaining = conn.execute("SELECT old_value, new_value FROM review_revisions").fetchall()
    assert len(remaining) == 1
    assert remaining[0]["new_value"] == "Thanks!"


# ---------------------------------------------------------------------------
# Case: a failed post-delete verification must roll back the entire
# transaction -- no partial delete left committed.
# ---------------------------------------------------------------------------

class _LyingCountConn:
    """Wraps a real connection; makes exactly one specific COUNT(*) query
    return a value different from reality, to deterministically exercise
    run_dedupe()'s rollback path without needing an actual race condition."""

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


def test_dedupe_rolls_back_when_review_count_check_fails():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id)
    _add_revision(conn, review_id, "owner_response", "Thanks!", "Thanks! ")

    before_total = conn.execute("SELECT COUNT(*) c FROM review_revisions").fetchone()["c"]

    lying = _LyingCountConn(conn, "SELECT COUNT(*) c FROM reviews", lie_value=999)
    try:
        maint.run_dedupe(lying)
        raised = False
    except RuntimeError:
        raised = True

    assert raised, "run_dedupe() must raise when the review-count check fails post-delete"
    after_total = conn.execute("SELECT COUNT(*) c FROM review_revisions").fetchone()["c"]
    assert after_total == before_total, (
        "a failed verification must roll back the delete -- row count changed anyway"
    )


def main():
    tests = [
        ("preflight() is read-only", test_preflight_is_read_only),
        ("dedupe deletes only whitespace-only duplicates", test_dedupe_deletes_only_whitespace_only_duplicates),
        ("dedupe never touches reviews/locations/genuine rows", test_dedupe_never_touches_reviews_locations_or_genuine_rows),
        ("dedupe is idempotent", test_dedupe_is_idempotent),
        ("dedupe handles None/empty values safely", test_dedupe_handles_none_and_empty_values_safely),
        ("dedupe rolls back when a post-delete check fails", test_dedupe_rolls_back_when_review_count_check_fails),
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
