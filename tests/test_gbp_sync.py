"""
Regression tests for gbp_sync.py against a temporary, isolated SQLite DB --
never the real dashboard/reviews.db. google_api.py is fully mocked, so no
real network call or credential is ever needed.

Covers: new review sync, idempotent re-sync (no duplicate rows), edit
detection, and the graceful-failure path when Google's API errors out
(e.g. the 0-quota condition hit in production on 2026-07-15) -- confirms
a failed sync never partially writes and never crashes the caller.

Run directly: py tests/test_gbp_sync.py
"""
import sys
import tempfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import gbp_sync
import google_api as ga


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="gbp_sync_test_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    conn = db.get_connection()
    db.init_schema(conn)
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Casa Tequila Testtown', 'Testtown', 'Casa Tequila')")
    conn.commit()
    conn.close()


SAMPLE_ACCOUNT = {"name": "accounts/123", "accountName": "Test Account"}
SAMPLE_LOCATION = {"name": "accounts/123/locations/456", "locationName": "Casa Tequila Testtown"}


def _review(review_id, text, stars, update_time):
    return {
        "name": f"accounts/123/locations/456/reviews/{review_id}",
        "reviewId": review_id,
        "reviewer": {"displayName": "Jane Doe"},
        "starRating": stars,
        "comment": text,
        "createTime": "2026-07-10T12:00:00Z",
        "updateTime": update_time,
    }


def _run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        return True
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        return False


def test_new_review_syncs_once():
    _fresh_db()
    with mock.patch.object(ga, "is_configured", return_value=True), \
         mock.patch.object(ga, "list_accounts", return_value=[SAMPLE_ACCOUNT]), \
         mock.patch.object(ga, "list_locations", return_value=[SAMPLE_LOCATION]), \
         mock.patch.object(ga, "list_reviews", return_value=[_review("rev1", "Great food and fast service every visit", "FOUR", "2026-07-10T12:00:00Z")]):
        result = gbp_sync.sync_all(fast=False)

    assert result["status"] == "ok", result
    assert result["new"] == 1, result

    conn = db.get_connection()
    count = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    conn.close()
    assert count == 1, f"expected 1 review row, got {count}"


def test_resync_is_idempotent_no_duplicates():
    _fresh_db()
    review = _review("rev1", "Great food and fast service every visit", "FOUR", "2026-07-10T12:00:00Z")
    with mock.patch.object(ga, "is_configured", return_value=True), \
         mock.patch.object(ga, "list_accounts", return_value=[SAMPLE_ACCOUNT]), \
         mock.patch.object(ga, "list_locations", return_value=[SAMPLE_LOCATION]), \
         mock.patch.object(ga, "list_reviews", return_value=[review]):
        gbp_sync.sync_all(fast=False)
        second = gbp_sync.sync_all(fast=False)

    assert second["new"] == 0, f"re-sync of identical data should add 0 new reviews, got {second['new']}"

    conn = db.get_connection()
    count = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    conn.close()
    assert count == 1, f"expected still exactly 1 review row after re-sync, got {count}"


def test_edited_review_is_detected():
    _fresh_db()
    original = _review("rev1", "Good food", "FOUR", "2026-07-10T12:00:00Z")
    edited = _review("rev1", "EDITED: actually the food was cold this time", "TWO", "2026-07-12T09:00:00Z")

    with mock.patch.object(ga, "is_configured", return_value=True), \
         mock.patch.object(ga, "list_accounts", return_value=[SAMPLE_ACCOUNT]), \
         mock.patch.object(ga, "list_locations", return_value=[SAMPLE_LOCATION]), \
         mock.patch.object(ga, "list_reviews", return_value=[original]):
        gbp_sync.sync_all(fast=False)

    with mock.patch.object(ga, "is_configured", return_value=True), \
         mock.patch.object(ga, "list_accounts", return_value=[SAMPLE_ACCOUNT]), \
         mock.patch.object(ga, "list_locations", return_value=[SAMPLE_LOCATION]), \
         mock.patch.object(ga, "list_reviews", return_value=[edited]):
        result = gbp_sync.sync_all(fast=False)

    assert result["edited"] == 1, result

    conn = db.get_connection()
    row = conn.execute("SELECT review_text, star_rating FROM reviews").fetchone()
    conn.close()
    assert "EDITED" in row["review_text"]
    assert row["star_rating"] == 2


def test_quota_failure_is_graceful_no_partial_writes():
    """Mirrors the exact production failure hit on 2026-07-15: Google API
    429 quota-exceeded at list_accounts(). Must not crash and must not
    write anything -- the caller (critical_alert_check.py, update-reviews.yml)
    depends on this returning a clean failed status."""
    _fresh_db()
    with mock.patch.object(ga, "is_configured", return_value=True), \
         mock.patch.object(ga, "list_accounts", side_effect=ga.GBPRateLimitError(
             "Google API 429: Quota exceeded for quota metric 'Requests' and limit "
             "'Requests per minute' of service 'mybusinessaccountmanagement.googleapis.com'", status=429)):
        result = gbp_sync.sync_all(fast=False)

    assert result["status"] == "failed", result
    assert "429" in result["reason"], result

    conn = db.get_connection()
    count = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    run_row = conn.execute("SELECT status, mode, error_summary FROM scraper_runs ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()
    assert count == 0, f"a failed sync must write zero reviews, got {count}"
    assert run_row is not None, "a failure at account discovery must still leave a visible scraper_runs record"
    assert run_row["status"] == "failed"
    assert run_row["mode"] == "api_sync"
    assert "429" in run_row["error_summary"]


def main():
    tests = [
        ("new review syncs exactly once", test_new_review_syncs_once),
        ("idempotent re-sync produces zero duplicates", test_resync_is_idempotent_no_duplicates),
        ("an edited review is detected and updated in place", test_edited_review_is_detected),
        ("quota/API failure at account discovery degrades gracefully with zero writes", test_quota_failure_is_graceful_no_partial_writes),
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
