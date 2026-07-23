"""
Regression tests for the full notification-pipeline audit (production
incident: neither immediate critical alerts nor the nightly digest were
being received, despite update-reviews.yml completing successfully every
time).

Root causes found and fixed:

1. nightly_digest.py's hour gate required now_et.hour == 22 (exactly 10pm
   ET). GitHub Actions' actual cron delay for this repo is consistently
   3-4 hours past both scheduled UTC firings, landing the real invocation
   around 1-2 AM ET -- never hour 22. Confirmed via live run logs: every
   single scheduled run printed {'status': 'skipped_wrong_hour', ...}, and
   zero 'nightly_digest_review' notifications exist anywhere in this
   project's history. Fixed by widening the gate to a tolerant overnight
   window (VALID_HOURS_ET).

2. Both nightly_digest.py and critical_alert_check.py used to call
   log_notification() (permanently marking a review as "already notified")
   BEFORE confirming the email actually sent. A genuine send failure (bad
   credentials, an SMTP error, anything send_email()/_send_email() raises)
   would still leave the "notified" row committed -- silently losing that
   alert forever with no way to retry. Fixed by moving notification-logging
   to strictly after a successful send (nightly_digest.py's one
   already-tested exception -- logging when credentials are simply not yet
   configured, a one-time setup gap rather than a transient failure --
   is deliberately preserved, see test_dedup_across_runs in
   test_nightly_digest.py).

This file covers the specific regression scenarios called for by that
audit, cutting across critical_alert_check.py, nightly_digest.py, and
provider_sync.py/sync_reviews.py.

Run directly: py tests/test_notification_pipeline_audit.py
"""
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import critical_alert_check as cac
import nightly_digest as nd
import gbp_sync
import provider_sync
from provider_base import Provider, ProviderLocation, ProviderReview

nd.FROM_ADDR = ""
nd.APP_PASS = ""


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="notification_audit_test_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    conn = db.get_connection()
    db.init_schema(conn)
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Test Loc', 'Testville', 'Casa Tequila')")
    loc_id = conn.execute("SELECT id FROM locations WHERE name = ?", ("Test Loc",)).fetchone()["id"]
    conn.commit()
    conn.close()
    return loc_id


def _add_review(loc_id, review_id_seed, text, stars, priority=None, owner_response=None, review_date=None):
    review_date = review_date or datetime.now(timezone.utc).date().isoformat()
    conn = db.get_connection()
    conn.execute(
        """INSERT INTO reviews (location_id, reviewer_name, review_date, star_rating, review_text,
           dedup_key, is_deleted, ai_priority, owner_response, first_seen_at, last_seen_at)
           VALUES (?, 'Tester', ?, ?, ?, ?, 0, ?, ?, ?, ?)""",
        (loc_id, review_date, stars, text, f"seed-{review_id_seed}-{review_date}", priority, owner_response,
         review_date, review_date),
    )
    conn.commit()
    row = conn.execute("SELECT id FROM reviews WHERE dedup_key = ?", (f"seed-{review_id_seed}-{review_date}",)).fetchone()
    conn.close()
    return row["id"]


def _run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        return True
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        return False


# --- Scenario 1: new bad review -> alert sent -------------------------------

def test_new_bad_review_triggers_immediate_alert():
    loc_id = _fresh_db()
    _add_review(loc_id, 1, "Someone got seriously injured on the premises and staff ignored it", 1, "critical")

    with mock.patch.object(gbp_sync, "sync_all", return_value={"status": "skipped", "reason": "not configured"}), \
         mock.patch.object(cac, "FROM_ADDR", "sender@example.com"), mock.patch.object(cac, "APP_PASS", "test-pass"), \
         mock.patch("critical_alert_check._send_email") as mock_send:
        result = cac.run()

    assert result["status"] == "ok", result
    assert result["sent"] == 1, result
    assert mock_send.called, "a genuinely new critical review must trigger an actual send attempt"


# --- Scenario 2: duplicate review -> no duplicate alert ---------------------

def test_duplicate_review_never_re_alerts():
    loc_id = _fresh_db()
    _add_review(loc_id, 2, "Extremely dangerous situation, someone could have been hurt badly", 1, "critical")

    with mock.patch.object(gbp_sync, "sync_all", return_value={"status": "skipped", "reason": "not configured"}), \
         mock.patch.object(cac, "FROM_ADDR", "sender@example.com"), mock.patch.object(cac, "APP_PASS", "test-pass"), \
         mock.patch("critical_alert_check._send_email") as mock_send:
        first = cac.run()
        second = cac.run()

    assert first["status"] == "ok" and first["sent"] == 1, first
    assert second["status"] == "ok" and second["sent"] == 0, \
        f"the same review must never trigger a second alert, got {second}"
    assert mock_send.call_count == 1, f"send must be attempted exactly once total, got {mock_send.call_count}"


# --- Scenario 3: multiple bad reviews -> all alerts sent --------------------

def test_multiple_bad_reviews_all_included_in_one_alert():
    loc_id = _fresh_db()
    _add_review(loc_id, 3, "Found something dangerous in my food and got seriously ill", 1, "critical")
    _add_review(loc_id, 4, "Employee was hostile and made discriminatory remarks about my accent", 1, "critical")
    _add_review(loc_id, 5, "Fire hazard -- exposed wiring near the kitchen, genuinely unsafe", 1, "critical")

    with mock.patch.object(gbp_sync, "sync_all", return_value={"status": "skipped", "reason": "not configured"}), \
         mock.patch.object(cac, "FROM_ADDR", "sender@example.com"), mock.patch.object(cac, "APP_PASS", "test-pass"), \
         mock.patch("critical_alert_check._send_email") as mock_send:
        result = cac.run()

    assert result["status"] == "ok", result
    assert result["sent"] == 3, f"all three genuinely new critical reviews must be included, got {result}"
    assert mock_send.call_count == 1, "all three must be batched into a single email, not three separate sends"


# --- Scenario 4: nightly digest with reviews --------------------------------

def test_nightly_digest_with_qualifying_reviews_sends():
    loc_id = _fresh_db()
    _add_review(loc_id, 6, "The staff was rude and our order arrived cold after a very long wait", 1, "high")

    with mock.patch.object(nd, "FROM_ADDR", "sender@example.com"), mock.patch.object(nd, "APP_PASS", "test-pass"), \
         mock.patch.object(nd, "send_email") as mock_send:
        result = nd.run(force=True)

    assert result["status"] == "sent", result
    assert result["count"] == 1, result
    assert mock_send.called, "a qualifying review must result in an actual digest send attempt"


# --- Scenario 5: nightly digest with no reviews -----------------------------

def test_nightly_digest_with_no_qualifying_reviews_sends_nothing():
    _fresh_db()  # no reviews at all
    with mock.patch.object(nd, "FROM_ADDR", "sender@example.com"), mock.patch.object(nd, "APP_PASS", "test-pass"), \
         mock.patch.object(nd, "send_email") as mock_send:
        result = nd.run(force=True)

    assert result["status"] == "no_qualifying_reviews", result
    assert not mock_send.called, "must never attempt a send when there is nothing to digest"


# --- Scenario 6: successful scraper run with no alerts ----------------------

class _FakeAllPositiveProvider(Provider):
    """A minimal, in-memory Provider (matches ScraperProvider/GBPProvider's
    contract via provider_base.Provider, no Playwright/Google credentials
    involved) whose one location has only 4-5 star reviews -- confirms a
    genuinely healthy, fully successful sync with nothing negative to
    report completes cleanly and triggers no alert path at all."""
    name = "fake_positive"
    display_name = "Fake All-Positive Provider"

    def is_configured(self):
        return True

    def discover_locations(self):
        return [ProviderLocation(external_id=None, name="Test Loc", city="Testville")]

    def fetch_reviews(self, location, *, fast=False):
        return [
            ProviderReview(reviewer_name="Happy Customer", review_date="2026-07-20",
                            star_rating=5, review_text="Wonderful, will come back again soon",
                            review_url="", gbp_review_name=None),
            ProviderReview(reviewer_name="Another Happy Customer", review_date="2026-07-21",
                            star_rating=4, review_text="Great food, quick service", review_url="", gbp_review_name=None),
        ]


def test_successful_scraper_run_with_only_positive_reviews_sends_no_alert():
    import asyncio
    import digest_filters
    _fresh_db()
    result = asyncio.run(provider_sync.sync_all(_FakeAllPositiveProvider(), fast=True))

    assert result["status"] == "ok", f"a fully healthy sync must report status ok, got {result}"
    assert result["locations_failed"] == 0, result
    new_reviews = result.get("new_reviews", [])
    assert len(new_reviews) == 2, f"both positive reviews must be stored as new, got {result}"

    negative = digest_filters.get_new_negative_reviews(new_reviews)
    assert negative == [], "an all-positive successful sync must report zero negative reviews, never a fabricated alert"


# --- Scenario 7: Google Business Profile failures must never suppress ------
# scraper-based notifications (explicit, dedicated lock-in for this exact
# guarantee, distinct from test_critical_alert_check.py's own broader
# regression coverage of the same principle).

def test_gbp_failure_never_suppresses_a_genuinely_new_critical_alert():
    loc_id = _fresh_db()
    _add_review(loc_id, 7, "Roach infestation in the dining area, genuinely unsanitary conditions", 1, "critical")

    gbp_failure = {
        "status": "failed",
        "reason": "Google API 429: Quota exceeded for quota metric 'Requests'",
        "error_type": "GBPRateLimitError",
        "error_status": 429,
    }
    with mock.patch.object(gbp_sync, "sync_all", return_value=gbp_failure), \
         mock.patch.object(cac, "FROM_ADDR", "sender@example.com"), mock.patch.object(cac, "APP_PASS", "test-pass"), \
         mock.patch("critical_alert_check._send_email") as mock_send:
        result = cac.run()

    assert result["status"] == "ok", f"a GBP quota/auth failure must never prevent the scraper-based DB check, got {result}"
    assert result["sent"] == 1, result
    assert mock_send.called, "the alert must still be sent even though the GBP sync itself failed"


# --- Regression lock-in for the actual bug fixed this audit -----------------

def test_missing_credentials_never_permanently_suppresses_a_critical_alert():
    """The core logic-bug fix: previously, log_notification() ran regardless
    of whether _send_email() actually sent anything -- so if credentials
    were ever missing (even transiently, e.g. a misconfigured secret), the
    review would be marked "notified" forever with no email ever delivered.
    Confirms the review remains eligible for a real send once credentials
    are available."""
    loc_id = _fresh_db()
    _add_review(loc_id, 8, "Extremely unsafe experience, a customer was injured and needs medical attention", 1, "critical")

    with mock.patch.object(gbp_sync, "sync_all", return_value={"status": "skipped", "reason": "not configured"}), \
         mock.patch.object(cac, "FROM_ADDR", ""), mock.patch.object(cac, "APP_PASS", ""):
        blocked = cac.run()
    assert blocked["status"] == "ready_no_credentials", blocked
    assert blocked["pending"] == 1, blocked

    conn = db.get_connection()
    still_not_logged = conn.execute(
        "SELECT 1 FROM notifications_log WHERE notification_type = 'critical_review_immediate'"
    ).fetchone()
    conn.close()
    assert still_not_logged is None, "a critical review must NOT be marked notified while credentials are missing"

    with mock.patch.object(gbp_sync, "sync_all", return_value={"status": "skipped", "reason": "not configured"}), \
         mock.patch.object(cac, "FROM_ADDR", "sender@example.com"), mock.patch.object(cac, "APP_PASS", "test-pass"), \
         mock.patch("critical_alert_check._send_email") as mock_send:
        recovered = cac.run()

    assert recovered["status"] == "ok" and recovered["sent"] == 1, \
        f"once credentials are available, the SAME review must still be found and sent, got {recovered}"
    assert mock_send.called


def test_nightly_digest_send_failure_does_not_permanently_suppress_review():
    """The nightly-digest half of the same fix: a genuine send_email()
    exception (a real SMTP failure, not just missing credentials) must
    leave the review un-logged so the next run can retry it."""
    loc_id = _fresh_db()
    _add_review(loc_id, 9, "Cold food and a two-hour wait, completely unacceptable service", 1, "high")

    with mock.patch.object(nd, "FROM_ADDR", "sender@example.com"), mock.patch.object(nd, "APP_PASS", "test-pass"), \
         mock.patch.object(nd, "send_email", side_effect=Exception("simulated SMTP failure")):
        try:
            nd.run(force=True)
            raised = False
        except Exception:
            raised = True
    assert raised, "a genuine send failure must propagate, not be silently swallowed"

    conn = db.get_connection()
    logged = conn.execute(
        "SELECT 1 FROM notifications_log WHERE notification_type = 'nightly_digest_review'"
    ).fetchone()
    conn.close()
    assert logged is None, "a review must NOT be marked notified when the send itself genuinely failed"

    # Retrying (send now succeeding) must still find and send the same review.
    with mock.patch.object(nd, "FROM_ADDR", "sender@example.com"), mock.patch.object(nd, "APP_PASS", "test-pass"), \
         mock.patch.object(nd, "send_email") as mock_send:
        retried = nd.run(force=True)
    assert retried["status"] == "sent" and retried["count"] == 1, retried
    assert mock_send.called


def main():
    tests = [
        ("a new bad review triggers an immediate alert", test_new_bad_review_triggers_immediate_alert),
        ("a duplicate review is never re-alerted", test_duplicate_review_never_re_alerts),
        ("multiple new bad reviews are all included in one alert", test_multiple_bad_reviews_all_included_in_one_alert),
        ("nightly digest sends when qualifying reviews exist", test_nightly_digest_with_qualifying_reviews_sends),
        ("nightly digest sends nothing when there is nothing to report", test_nightly_digest_with_no_qualifying_reviews_sends_nothing),
        ("a successful scraper run with only positive reviews triggers no alert", test_successful_scraper_run_with_only_positive_reviews_sends_no_alert),
        ("a GBP quota/auth failure never suppresses a genuinely new critical alert", test_gbp_failure_never_suppresses_a_genuinely_new_critical_alert),
        ("missing credentials never permanently suppress a critical alert (core bug fix)", test_missing_credentials_never_permanently_suppresses_a_critical_alert),
        ("a genuine nightly-digest send failure never permanently suppresses a review (core bug fix)", test_nightly_digest_send_failure_does_not_permanently_suppress_review),
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
