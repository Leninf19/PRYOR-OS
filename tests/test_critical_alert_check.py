"""
Regression tests for critical_alert_check.py / digest_filters.py's critical-
review escalation logic, against a temporary, isolated SQLite DB. Covers the
30-day lookback bound (the exact flood-risk fix applied earlier in this
project), dedup against notifications_log, and the "sync failed but still
check existing critical reviews" degradation path confirmed live in
production on 2026-07-15.

Run directly: py tests/test_critical_alert_check.py
"""
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import critical_alert_check as cac
import db
import digest_filters
import gbp_sync
import tenant_keys
import tenant_paths

TEST_TENANT_ID = tenant_keys.DEFAULT_TENANT_ID


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="critical_alert_test_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    tenant_paths._set_review_db_path_for_tests(TEST_TENANT_ID, db.DB_PATH)
    conn = db.get_connection()
    db.init_schema(conn)
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Test Loc', 'Testville', 'Casa Tequila')")
    loc_id = conn.execute("SELECT id FROM locations WHERE name = ?", ("Test Loc",)).fetchone()["id"]
    conn.commit()
    conn.close()
    return loc_id


def _add_review(loc_id, text, stars, priority, review_date, owner_response=None):
    conn = db.get_connection()
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """INSERT INTO reviews (location_id, reviewer_name, review_date, star_rating, review_text,
           dedup_key, is_deleted, ai_priority, owner_response, first_seen_at, last_seen_at)
           VALUES (?, 'Tester', ?, ?, ?, ?, 0, ?, ?, ?, ?)""",
        (loc_id, review_date, stars, text, text[:20] + review_date, priority, owner_response, now, now),
    )
    conn.commit()
    review_id = conn.execute("SELECT id FROM reviews WHERE review_date = ?", (review_date,)).fetchone()["id"]
    conn.close()
    return review_id


def _run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        return True
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        return False


def test_old_backlog_excluded_by_lookback_window():
    loc_id = _fresh_db()
    today = datetime.now(timezone.utc).date()
    old_date = (today - timedelta(days=digest_filters.CRITICAL_LOOKBACK_DAYS + 5)).isoformat()
    recent_date = today.isoformat()

    _add_review(loc_id, "Found something dangerous in my food and got seriously ill", 1, "critical", old_date)
    _add_review(loc_id, "Someone was injured on the premises and no one helped", 1, "critical", recent_date)

    conn = db.get_connection()
    critical = digest_filters.find_unescalated_critical_reviews(conn)
    conn.close()

    assert len(critical) == 1, f"expected only the in-window review, got {len(critical)}"
    assert critical[0]["review_date"] == recent_date


def test_already_escalated_review_excluded():
    loc_id = _fresh_db()
    today = datetime.now(timezone.utc).date().isoformat()
    review_id = _add_review(loc_id, "Serious safety concern needing immediate attention here", 1, "critical", today)

    conn = db.get_connection()
    before = digest_filters.find_unescalated_critical_reviews(conn)
    assert len(before) == 1, "should find the critical review before it's escalated"

    digest_filters.log_notification(conn, "critical_review_immediate", "test", related_review_id=review_id)
    conn.commit()

    after = digest_filters.find_unescalated_critical_reviews(conn)
    conn.close()
    assert len(after) == 0, "an already-escalated review must not be found again (dedup)"


def test_answered_review_excluded_even_if_critical():
    loc_id = _fresh_db()
    today = datetime.now(timezone.utc).date().isoformat()
    _add_review(loc_id, "This was a serious safety incident that needs review", 1, "critical", today,
                owner_response="We take this extremely seriously and have already reached out.")

    conn = db.get_connection()
    critical = digest_filters.find_unescalated_critical_reviews(conn)
    conn.close()
    assert len(critical) == 0, "an already-answered review should not be treated as needing immediate escalation"


def test_sync_failure_still_checks_existing_critical_reviews():
    """Mirrors production on 2026-07-15: the Google API call fails (quota),
    but critical_alert_check.py must still surface any critical review
    already sitting in the local DB from a prior successful sync, rather
    than silently doing nothing just because today's sync failed."""
    loc_id = _fresh_db()
    today = datetime.now(timezone.utc).date().isoformat()
    _add_review(loc_id, "Extremely dangerous situation, someone could have been hurt badly", 1, "critical", today)

    with mock.patch.object(gbp_sync, "sync_all", return_value={"status": "failed", "reason": "Google API 429: Quota exceeded"}), \
         mock.patch.object(cac, "FROM_ADDR", "sender@example.com"), mock.patch.object(cac, "APP_PASS", "test-app-password"), \
         mock.patch("critical_alert_check._send_email") as mock_send:
        result = cac.run(TEST_TENANT_ID)

    assert result["status"] == "ok", result
    assert result["sent"] == 1, f"expected the pre-existing critical review to be found and sent, got {result}"
    assert mock_send.called, "expected the alert email path to be invoked despite the sync failure"


# --- Diagnostics-only: _describe_sync_failure() classification ---------------
# Follow-up to the fix above: the printed diagnostic used to read
# `sync failed -- {sync_result.get('errors')}`, which was always None for
# exactly this failure shape (provider_sync.py's discovery-failure path
# returns the message under 'reason', never 'errors'). These tests lock in
# the replacement classifier -- none of them touch run()'s control flow or
# assert anything about email/DB behavior beyond what the pre-existing test
# above already covers, since this change is diagnostics-only.

def test_quota_block_logs_the_expected_fallback_message():
    sync_result = {
        "status": "failed",
        "reason": "Google API 429: Quota exceeded for quota metric 'Requests' and limit "
                  "'Requests per minute' of service 'mybusinessaccountmanagement.googleapis.com' "
                  "for consumer 'project_number:786038057684'.",
        "error_type": "GBPRateLimitError",
        "error_status": 429,
    }
    message = cac._describe_sync_failure(sync_result)
    assert cac.GBP_QUOTA_BLOCK_MESSAGE in message, f"expected the exact known-quota-block message, got: {message}"
    assert "reconnect" not in message.lower(), "a quota block must never suggest reconnecting -- it does nothing for this"


def test_quota_block_detected_by_status_alone_even_without_error_type():
    # Belt-and-suspenders: detection must not depend solely on error_type
    # being populated (e.g. an older/foreign caller that only sets status).
    sync_result = {"status": "failed", "reason": "Google API 429: rate limited", "error_status": 429}
    message = cac._describe_sync_failure(sync_result)
    assert cac.GBP_QUOTA_BLOCK_MESSAGE in message, message


def test_authentication_errors_remain_distinguishable_from_quota_block():
    sync_result = {
        "status": "failed",
        "reason": "Unauthorized: Request had invalid authentication credentials.",
        "error_type": "GBPAuthError",
        "error_status": 401,
    }
    message = cac._describe_sync_failure(sync_result)
    assert cac.GBP_QUOTA_BLOCK_MESSAGE not in message, "an auth error must never be reported as the quota-block message"
    assert "authentication" in message.lower(), f"expected an auth-specific message, got: {message}"
    assert "reconnect" in message.lower(), "an auth error (unlike a quota block) should point at reconnecting"


def test_unexpected_errors_never_become_none():
    # Anything that isn't the known quota or auth shape -- the exact bug
    # being fixed is that this used to render as the literal string "None".
    sync_result = {
        "status": "failed",
        "reason": "Google API 500: internal error",
        "error_type": "GBPServerError",
        "error_status": 500,
        "error_traceback": "Traceback (most recent call last):\n  ...\nGBPServerError: Google API 500: internal error\n",
    }
    message = cac._describe_sync_failure(sync_result)
    assert message != "None", message
    assert "None" not in message.split("message=")[-1].split(".")[0], f"the actual detail must never be swallowed into None: {message}"
    assert "GBPServerError" in message and "500" in message and "internal error" in message, message
    assert "Traceback" in message, "a captured traceback should be surfaced for an unclassified failure"


def test_unexpected_error_with_no_detail_at_all_is_still_never_none():
    # The absolute worst case this bug produced: an empty dict's .get() calls
    # all returning None. Must still produce a real, non-"None" message.
    message = cac._describe_sync_failure({"status": "failed"})
    assert message != "None"
    assert "no error detail available" in message, message


def test_fallback_database_check_still_runs_for_every_failure_classification():
    """The core degradation-path guarantee (test_sync_failure_still_checks_existing_critical_reviews
    above) must hold no matter HOW the failure is classified -- quota, auth,
    or unexpected. This is a diagnostics-only change: it must never affect
    whether run() still checks the database and sends the alert."""
    for sync_result in [
        {"status": "failed", "reason": "Google API 429: Quota exceeded", "error_type": "GBPRateLimitError", "error_status": 429},
        {"status": "failed", "reason": "Unauthorized", "error_type": "GBPAuthError", "error_status": 401},
        {"status": "failed", "reason": "Google API 500: internal error", "error_type": "GBPServerError", "error_status": 500},
    ]:
        loc_id = _fresh_db()
        today = datetime.now(timezone.utc).date().isoformat()
        _add_review(loc_id, "Extremely dangerous situation, someone could have been hurt badly", 1, "critical", today)

        with mock.patch.object(gbp_sync, "sync_all", return_value=sync_result), \
             mock.patch.object(cac, "FROM_ADDR", "sender@example.com"), mock.patch.object(cac, "APP_PASS", "test-app-password"), \
             mock.patch("critical_alert_check._send_email") as mock_send:
            result = cac.run(TEST_TENANT_ID)

        assert result["status"] == "ok", f"{sync_result['error_type']}: {result}"
        assert result["sent"] == 1, f"{sync_result['error_type']}: expected the pre-existing critical review still found, got {result}"
        assert mock_send.called, f"{sync_result['error_type']}: expected the alert email path still invoked despite the sync failure"


def main():
    tests = [
        ("critical reviews older than the lookback window are excluded", test_old_backlog_excluded_by_lookback_window),
        ("an already-escalated critical review is not re-found (dedup)", test_already_escalated_review_excluded),
        ("a critical review with an owner reply is excluded from immediate escalation", test_answered_review_excluded_even_if_critical),
        ("a failed Google sync still surfaces pre-existing critical reviews", test_sync_failure_still_checks_existing_critical_reviews),
        ("a quota block (429/GBPRateLimitError) logs the expected fallback message", test_quota_block_logs_the_expected_fallback_message),
        ("a quota block is detected by status alone, even without error_type", test_quota_block_detected_by_status_alone_even_without_error_type),
        ("authentication errors remain distinguishable from a quota block", test_authentication_errors_remain_distinguishable_from_quota_block),
        ("unexpected errors are never rendered as the literal string None", test_unexpected_errors_never_become_none),
        ("an unexpected error with no detail at all is still never None", test_unexpected_error_with_no_detail_at_all_is_still_never_none),
        ("the database fallback still runs for every failure classification (quota/auth/unexpected)", test_fallback_database_check_still_runs_for_every_failure_classification),
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
