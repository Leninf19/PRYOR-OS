"""
Regression tests for gbp_reply_bridge_reconcile.py (Recovery Milestone 6B,
Part 7/9/11).

Covers: a bridge record whose review now has a real Google reply gets
reconciled into reviews.db (owner_response/gbp_reply_update_time) and its
Redis key deleted; a still-pending record is left untouched; a record whose
review already has owner_response locally (self-healed by the full sync)
just gets its now-redundant bridge record cleared without a spurious
Google call; a fetch failure leaves everything untouched; a malformed
record with no gbpReviewName is skipped; nothing outside these exact rows
is ever written; --dry-run performs zero writes/deletes while still
reporting what it would have done.

Every test uses a temporary, isolated SQLite DB -- never the real
dashboard/reviews.db. Redis and Google are always injected fakes -- no
test in this file ever makes a real network call.

Run directly: py tests/test_gbp_reply_bridge_reconcile.py
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import gbp_reply_bridge_reconcile as reconcile


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="test_bridge_reconcile_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    conn = db.get_connection()
    db.init_schema(conn)
    return conn


def _add_location(conn, name="Casa Tequila Testtown"):
    cur = conn.execute("INSERT INTO locations (name, city, brand) VALUES (?, 'Testtown', 'Casa Tequila')", (name,))
    conn.commit()
    return cur.lastrowid


def _add_review(conn, loc_id, gbp_review_name, owner_response="", reviewer_name="Jane Doe"):
    now = "2026-08-22T12:00:00Z"
    cur = conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, gbp_review_name, reviewer_name, review_date,
           star_rating, review_text, owner_response, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, '2026-08-07', 5, 'Great food', ?, ?, ?)""",
        (loc_id, gbp_review_name, gbp_review_name, reviewer_name, owner_response, now, now),
    )
    conn.commit()
    return cur.lastrowid


def _bridge_record(gbp_review_name="accounts/1/locations/2/reviews/abc", response_text="Thank you!"):
    return {
        "localReviewId": "r1", "gbpReviewName": gbp_review_name, "responseText": response_text,
        "publishedAt": "2026-08-22T13:45:00Z", "source": "future_insights",
        "status": "pending_google_reconciliation", "locationName": "Casa Tequila Testtown",
        "reviewerName": "Jane Doe", "reviewDate": "2026-08-07",
    }


def _run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        return True
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        return False


def test_confirmed_reply_reconciles_db_and_clears_bridge():
    conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id, "accounts/1/locations/2/reviews/abc")
    deleted = []

    def fake_fetch(name):
        return {"reviewReply": {"comment": "Thank you so much!", "updateTime": "2026-08-22T13:50:00Z"}}

    counts = reconcile.run_reconcile(
        conn, dry_run=False,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: _bridge_record(),
        fetch_review=fake_fetch,
        delete_record=lambda k: deleted.append(k),
    )
    row = conn.execute("SELECT owner_response, gbp_reply_update_time FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert counts["confirmed"] == 1, counts
    assert row["owner_response"] == "Thank you so much!", row["owner_response"]
    assert row["gbp_reply_update_time"] == "2026-08-22T13:50:00Z"
    assert deleted == ["publish_bridge:v1:r1"], deleted


def test_still_pending_leaves_row_and_bridge_untouched():
    conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id, "accounts/1/locations/2/reviews/abc")
    deleted = []

    counts = reconcile.run_reconcile(
        conn, dry_run=False,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: _bridge_record(),
        fetch_review=lambda name: {},  # no reviewReply at all
        delete_record=lambda k: deleted.append(k),
    )
    row = conn.execute("SELECT owner_response FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert counts["still_pending"] == 1, counts
    assert row["owner_response"] == "", row["owner_response"]
    assert deleted == [], deleted


def test_already_answered_locally_clears_stale_bridge_without_google_call():
    conn = _fresh_db()
    loc_id = _add_location(conn)
    _add_review(conn, loc_id, "accounts/1/locations/2/reviews/abc", owner_response="Already replied via full sync")
    deleted = []
    fetch_calls = []

    counts = reconcile.run_reconcile(
        conn, dry_run=False,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: _bridge_record(),
        fetch_review=lambda name: fetch_calls.append(name) or {},
        delete_record=lambda k: deleted.append(k),
    )
    assert counts["confirmed"] == 1, counts
    assert deleted == ["publish_bridge:v1:r1"], deleted
    assert fetch_calls == [], "must not call Google when reviews.db is already reconciled"


def test_fetch_failure_leaves_everything_untouched():
    conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id, "accounts/1/locations/2/reviews/abc")
    deleted = []

    def fake_fetch(name):
        raise RuntimeError("network error")

    counts = reconcile.run_reconcile(
        conn, dry_run=False,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: _bridge_record(),
        fetch_review=fake_fetch,
        delete_record=lambda k: deleted.append(k),
    )
    row = conn.execute("SELECT owner_response FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert counts["fetch_failed"] == 1, counts
    assert row["owner_response"] == ""
    assert deleted == []


def test_no_gbp_review_name_is_skipped_not_crashed():
    conn = _fresh_db()
    record = _bridge_record()
    record["gbpReviewName"] = None
    counts = reconcile.run_reconcile(
        conn, dry_run=False,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: record,
        fetch_review=lambda name: (_ for _ in ()).throw(AssertionError("must not be called")),
        delete_record=lambda k: (_ for _ in ()).throw(AssertionError("must not be called")),
    )
    assert counts["skipped_no_gbp_id"] == 1, counts


def test_review_not_found_locally_is_skipped_not_crashed():
    conn = _fresh_db()
    _add_location(conn)  # no matching review row at all
    counts = reconcile.run_reconcile(
        conn, dry_run=False,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: _bridge_record(gbp_review_name="accounts/1/locations/2/reviews/does-not-exist"),
        fetch_review=lambda name: (_ for _ in ()).throw(AssertionError("must not be called")),
        delete_record=lambda k: (_ for _ in ()).throw(AssertionError("must not be called")),
    )
    assert counts["skipped_not_found_locally"] == 1, counts


def test_dry_run_performs_zero_writes_or_deletes():
    conn = _fresh_db()
    loc_id = _add_location(conn)
    review_id = _add_review(conn, loc_id, "accounts/1/locations/2/reviews/abc")
    deleted = []

    counts = reconcile.run_reconcile(
        conn, dry_run=True,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: _bridge_record(),
        fetch_review=lambda name: {"reviewReply": {"comment": "Thank you!", "updateTime": "2026-08-22T13:50:00Z"}},
        delete_record=lambda k: deleted.append(k),
    )
    row = conn.execute("SELECT owner_response FROM reviews WHERE id = ?", (review_id,)).fetchone()
    assert counts["confirmed"] == 1, "dry-run should still REPORT what it would confirm"
    assert row["owner_response"] == "", "dry-run must never actually write"
    assert deleted == [], "dry-run must never actually delete the bridge record"


def test_only_the_matching_row_is_ever_touched():
    conn = _fresh_db()
    loc_id = _add_location(conn)
    target_id = _add_review(conn, loc_id, "accounts/1/locations/2/reviews/abc")
    other_id = _add_review(conn, loc_id, "accounts/1/locations/2/reviews/xyz", reviewer_name="Other Person")

    reconcile.run_reconcile(
        conn, dry_run=False,
        list_keys=lambda: ["publish_bridge:v1:r1"],
        get_record=lambda k: _bridge_record(gbp_review_name="accounts/1/locations/2/reviews/abc"),
        fetch_review=lambda name: {"reviewReply": {"comment": "Thanks!", "updateTime": "2026-08-22T13:50:00Z"}},
        delete_record=lambda k: None,
    )
    target = conn.execute("SELECT owner_response, review_text, star_rating FROM reviews WHERE id = ?", (target_id,)).fetchone()
    other = conn.execute("SELECT owner_response FROM reviews WHERE id = ?", (other_id,)).fetchone()
    assert target["owner_response"] == "Thanks!"
    assert target["review_text"] == "Great food", "must never touch review_text"
    assert target["star_rating"] == 5, "must never touch star_rating"
    assert other["owner_response"] == "", "must never touch an unrelated row"


def main() -> int:
    tests = [
        ("confirmed reply reconciles reviews.db and clears the bridge", test_confirmed_reply_reconciles_db_and_clears_bridge),
        ("still-pending record leaves the row and bridge untouched", test_still_pending_leaves_row_and_bridge_untouched),
        ("already-answered locally clears a stale bridge without calling Google", test_already_answered_locally_clears_stale_bridge_without_google_call),
        ("a fetch failure leaves everything untouched", test_fetch_failure_leaves_everything_untouched),
        ("a record with no gbpReviewName is skipped, not crashed", test_no_gbp_review_name_is_skipped_not_crashed),
        ("a review not found locally is skipped, not crashed", test_review_not_found_locally_is_skipped_not_crashed),
        ("--dry-run performs zero writes or deletes", test_dry_run_performs_zero_writes_or_deletes),
        ("only the exact matching row is ever touched", test_only_the_matching_row_is_ever_touched),
    ]
    results = [_run(name, fn) for name, fn in tests]
    passed = sum(results)
    print(f"\n{passed}/{len(results)} tests passed" if passed == len(results) else f"\n{len(results) - passed} of {len(results)} TESTS FAILED")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
