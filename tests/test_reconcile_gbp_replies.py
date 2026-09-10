"""
Regression tests for reconcile_gbp_replies.py.

Covers the required invariants: preflight never writes anything; only rows
matching MATCH_PREDICATE (gbp_reply_update_time set, owner_response empty)
are ever touched; a real reply returned by Google backfills owner_response
and gbp_reply_update_time; no reply returned leaves the row unchanged and
reports it unresolved; a fetch failure leaves the row unchanged and reports
the error; nothing outside the matching rows is ever modified; re-running
is idempotent (a backfilled row no longer matches on the next pass).

Every test uses a temporary, isolated SQLite DB -- never the real
dashboard/reviews.db. fetch_review is always an injected stand-in -- no
test in this file ever calls the real Google API.

Run directly: py tests/test_reconcile_gbp_replies.py
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import reconcile_gbp_replies as reconcile
import tenant_keys
import tenant_paths

TEST_TENANT_ID = tenant_keys.DEFAULT_TENANT_ID


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="test_reconcile_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    tenant_paths._set_review_db_path_for_tests(TEST_TENANT_ID, db.DB_PATH)
    conn = db.get_connection()
    db.init_schema(conn)
    return db.DB_PATH, conn


def _add_location(conn, name="Casa Tequila Testtown"):
    cur = conn.execute("INSERT INTO locations (name, city, brand) VALUES (?, 'Testtown', 'Casa Tequila')", (name,))
    conn.commit()
    return cur.lastrowid


def _add_anomaly_row(conn, loc_id, gbp_review_name, reply_update_time="2026-05-01T00:00:00Z", key_suffix=""):
    now = "2026-07-28T00:00:00Z"
    cur = conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, gbp_review_name, reviewer_name, review_date,
           star_rating, review_text, owner_response, gbp_reply_update_time, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, 'Jane Doe', '2026-04-01', 1, 'Not great', '', ?, ?, ?)""",
        (loc_id, gbp_review_name + key_suffix, gbp_review_name, reply_update_time, now, now),
    )
    conn.commit()
    return cur.lastrowid


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
    _add_anomaly_row(conn, loc_id, "reviews/PREFLIGHT1")

    before = conn.execute("SELECT owner_response, gbp_reply_update_time FROM reviews").fetchall()
    report1 = reconcile.preflight(conn, db_path)
    report2 = reconcile.preflight(conn, db_path)
    after = conn.execute("SELECT owner_response, gbp_reply_update_time FROM reviews").fetchall()

    assert [dict(r) for r in before] == [dict(r) for r in after], "preflight() must never modify the database"
    assert report1["matching_rows"] == report2["matching_rows"] == 1
    assert report1["integrity_check"] == "ok"


# ---------------------------------------------------------------------------
# Case: Google returns a real reply -> backfill owner_response and
# gbp_reply_update_time from the live response, never fabricated.
# ---------------------------------------------------------------------------

def test_backfills_from_a_real_reply():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_anomaly_row(conn, loc_id, "reviews/HASREPLY")

    def fake_fetch(name):
        assert name == "reviews/HASREPLY"
        return {"reviewReply": {"comment": "Sorry about that -- please call us.",
                                 "updateTime": "2026-06-01T00:00:00Z"}}

    result = reconcile.run_reconcile(conn, TEST_TENANT_ID, fetch_review=fake_fetch)
    assert len(result["backfilled"]) == 1
    assert result["unresolved"] == []
    assert result["failed"] == []

    row = conn.execute("SELECT * FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert row["owner_response"] == "Sorry about that -- please call us."
    assert row["gbp_reply_update_time"] == "2026-06-01T00:00:00Z"


# ---------------------------------------------------------------------------
# Case: Google still returns no reply -> row left unchanged, reported
# unresolved, never marked replied.
# ---------------------------------------------------------------------------

def test_no_reply_returned_leaves_row_unchanged_and_unresolved():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_anomaly_row(conn, loc_id, "reviews/STILLNONE")

    def fake_fetch(name):
        return {"reviewReply": {}}  # Google genuinely has no reply on this review

    result = reconcile.run_reconcile(conn, TEST_TENANT_ID, fetch_review=fake_fetch)
    assert result["backfilled"] == []
    assert len(result["unresolved"]) == 1
    assert result["unresolved"][0]["id"] == review_id

    row = conn.execute("SELECT * FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert not (row["owner_response"] or "").strip(), "must not fabricate a reply"
    assert row["gbp_reply_update_time"] == "2026-05-01T00:00:00Z", "must leave the row exactly as it was"


# ---------------------------------------------------------------------------
# Case: the fetch itself fails -> row left unchanged, reported as failed,
# never treated as resolved or replied.
# ---------------------------------------------------------------------------

def test_fetch_failure_leaves_row_unchanged_and_reports_error():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_anomaly_row(conn, loc_id, "reviews/GONE")

    def failing_fetch(name):
        raise RuntimeError("404: review not found")

    result = reconcile.run_reconcile(conn, TEST_TENANT_ID, fetch_review=failing_fetch)
    assert result["backfilled"] == []
    assert result["unresolved"] == []
    assert len(result["failed"]) == 1
    assert result["failed"][0]["id"] == review_id
    assert "404" in result["failed"][0]["error"]

    row = conn.execute("SELECT * FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert not (row["owner_response"] or "").strip()


# ---------------------------------------------------------------------------
# Case: nothing outside the matching predicate is ever touched -- a normal
# review (already replied, or genuinely never replied and no gbp reply
# timestamp) must be completely unaffected by a reconcile run.
# ---------------------------------------------------------------------------

def test_only_matching_rows_are_touched():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    anomaly_id = _add_anomaly_row(conn, loc_id, "reviews/ANOMALY")

    now = "2026-07-28T00:00:00Z"
    already_replied_id = conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, gbp_review_name, reviewer_name, review_date,
           star_rating, review_text, owner_response, gbp_reply_update_time, first_seen_at, last_seen_at)
           VALUES (?, 'reviews/NORMAL1', 'reviews/NORMAL1', 'Bob', '2026-04-01', 5, 'Great',
           'Thanks!', '2026-04-02T00:00:00Z', ?, ?)""",
        (loc_id, now, now),
    ).lastrowid
    never_replied_id = conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, gbp_review_name, reviewer_name, review_date,
           star_rating, review_text, owner_response, gbp_reply_update_time, first_seen_at, last_seen_at)
           VALUES (?, 'reviews/NORMAL2', 'reviews/NORMAL2', 'Carol', '2026-04-01', 5, 'Fine', '', NULL, ?, ?)""",
        (loc_id, now, now),
    ).lastrowid
    conn.commit()

    def fake_fetch(name):
        return {"reviewReply": {"comment": "Fixed now", "updateTime": "2026-06-01T00:00:00Z"}}

    result = reconcile.run_reconcile(conn, TEST_TENANT_ID, fetch_review=fake_fetch)
    assert len(result["backfilled"]) == 1
    assert result["backfilled"][0]["id"] == anomaly_id

    normal1 = conn.execute("SELECT * FROM reviews WHERE id = ?", (already_replied_id,)).fetchone()
    normal2 = conn.execute("SELECT * FROM reviews WHERE id = ?", (never_replied_id,)).fetchone()
    assert normal1["owner_response"] == "Thanks!", "an already-correct row must never be touched"
    assert normal2["owner_response"] == "" and normal2["gbp_reply_update_time"] is None, (
        "a review with no gbp reply timestamp at all is not this predicate's concern"
    )


# ---------------------------------------------------------------------------
# Case: idempotency -- a backfilled row no longer matches, so a second run
# reconciles nothing further for it.
# ---------------------------------------------------------------------------

def test_rerun_is_idempotent():
    db_path, conn = _fresh_db()
    loc_id = _add_location(conn)
    _add_anomaly_row(conn, loc_id, "reviews/RERUN1")

    def fake_fetch(name):
        return {"reviewReply": {"comment": "All set", "updateTime": "2026-06-01T00:00:00Z"}}

    first = reconcile.run_reconcile(conn, TEST_TENANT_ID, fetch_review=fake_fetch)
    assert len(first["backfilled"]) == 1

    second = reconcile.run_reconcile(conn, TEST_TENANT_ID, fetch_review=fake_fetch)
    assert second["matched"] == 0, "a backfilled row must not match the predicate again"
    assert second["backfilled"] == []


def main():
    tests = [
        ("preflight() is read-only", test_preflight_is_read_only),
        ("backfills from a real reply", test_backfills_from_a_real_reply),
        ("no reply returned leaves row unchanged and unresolved", test_no_reply_returned_leaves_row_unchanged_and_unresolved),
        ("fetch failure leaves row unchanged and reports error", test_fetch_failure_leaves_row_unchanged_and_reports_error),
        ("only matching rows are touched", test_only_matching_rows_are_touched),
        ("rerun is idempotent", test_rerun_is_idempotent),
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
