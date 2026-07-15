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


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="critical_alert_test_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
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
         mock.patch("critical_alert_check._send_email") as mock_send:
        result = cac.run()

    assert result["status"] == "ok", result
    assert result["sent"] == 1, f"expected the pre-existing critical review to be found and sent, got {result}"
    assert mock_send.called, "expected the alert email path to be invoked despite the sync failure"


def main():
    tests = [
        ("critical reviews older than the lookback window are excluded", test_old_backlog_excluded_by_lookback_window),
        ("an already-escalated critical review is not re-found (dedup)", test_already_escalated_review_excluded),
        ("a critical review with an owner reply is excluded from immediate escalation", test_answered_review_excluded_even_if_critical),
        ("a failed Google sync still surfaces pre-existing critical reviews", test_sync_failure_still_checks_existing_critical_reviews),
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
