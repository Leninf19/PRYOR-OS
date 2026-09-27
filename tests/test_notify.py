"""
Regression tests for notify.py's platform/business notification-routing
split (Multi-Tenant notification-isolation revision):

- Platform-operational content (scraper failures, structural/data-integrity
  bugs) always goes to PLATFORM_TO_ADDR (lenin@futuremark.studio),
  regardless of tenant.
- Tenant-business content (rating-drop alerts) is resolved per tenant via
  resolve_business_recipient() -- Los Tres Amigos keeps its historical
  advertising@l3amigos.com; every other tenant has no configured recipient
  yet and is skipped with a warning, NEVER defaulted to LTA's address.
- The two categories are dispatched independently: each one's
  notifications_log rows are written ONLY after ITS OWN email send
  succeeds, so a send failure in one category never loses or duplicates
  the other category's notifications on retry.

Run directly: py tests/test_notify.py
"""
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import notify
import tenant_keys
import tenant_paths

OTHER_TENANT_ID = "t_other-tenant"

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _fresh_db(tenant_id: str):
    tmpdir = tempfile.mkdtemp(prefix="notify_test_")
    path = Path(tmpdir) / "reviews.db"
    tenant_paths._set_review_db_path_for_tests(tenant_id, path)
    db.DB_PATH = path
    conn = db.get_connection()
    db.init_schema(conn)
    conn.close()


def _seed_scraper_failure(conn, started_hours_ago=1):
    started = (datetime.now(timezone.utc) - timedelta(hours=started_hours_ago)).isoformat()
    conn.execute(
        """INSERT INTO scraper_runs (started_at, finished_at, mode, status, locations_attempted,
           locations_succeeded, locations_failed, error_summary)
           VALUES (?, ?, 'cloud', 'failed', 1, 0, 1, 'Test Loc: something broke')""",
        (started, started),
    )
    conn.commit()


def _seed_rating_drop(conn, loc_name="Test Loc"):
    conn.execute("INSERT INTO locations (name, city, brand) VALUES (?, 'Testville', 'Test Brand')", (loc_name,))
    loc_id = conn.execute("SELECT id FROM locations WHERE name = ?", (loc_name,)).fetchone()["id"]
    now = datetime.now(timezone.utc)
    for i in range(5):
        d = (now - timedelta(days=5 + i)).date().isoformat()
        conn.execute(
            """INSERT INTO reviews (location_id, reviewer_name, review_date, star_rating, review_text,
               dedup_key, is_deleted, first_seen_at, last_seen_at)
               VALUES (?, 'Tester', ?, 1, 'not good', ?, 0, ?, ?)""",
            (loc_id, d, f"cur-{loc_name}-{i}", d, d),
        )
    for i in range(5):
        d = (now - timedelta(days=35 + i)).date().isoformat()
        conn.execute(
            """INSERT INTO reviews (location_id, reviewer_name, review_date, star_rating, review_text,
               dedup_key, is_deleted, first_seen_at, last_seen_at)
               VALUES (?, 'Tester', ?, 5, 'great', ?, 0, ?, ?)""",
            (loc_id, d, f"prev-{loc_name}-{i}", d, d),
        )
    conn.commit()
    return loc_id


# --- Recipient resolution -----------------------------------------------

def test_resolve_business_recipient_lta_only():
    assert notify.resolve_business_recipient(tenant_keys.DEFAULT_TENANT_ID) == notify.LTA_BUSINESS_TO_ADDR
    assert notify.resolve_business_recipient(OTHER_TENANT_ID) is None, \
        "a tenant with no configured recipient must get None, never LTA's address"


def test_never_reuses_the_public_review_response_contact():
    """Enforces the explicit requirement: internal notification routing must
    never read the public, customer-facing review-response contact
    (ai_engine.py's resolve_review_response_contact() / the reviewContact
    tenant_config field). Only checks actual imports/field access, not the
    module docstring's own explanatory mention of ai_engine.py by name."""
    source = Path(notify.__file__).read_text(encoding="utf-8")
    assert not re.search(r"^\s*(import ai_engine\b|from ai_engine\b)", source, re.MULTILINE), \
        "notify.py must never import ai_engine (the public review-response-contact resolver)"
    assert '"reviewContact"' not in source and "'reviewContact'" not in source, \
        "notify.py must never read the reviewContact tenant_config field"


# --- Send-only-when-reportable -------------------------------------------

def test_nothing_to_report_sends_nothing():
    _fresh_db(tenant_keys.DEFAULT_TENANT_ID)
    with mock.patch.object(notify, "FROM_ADDR", "sender@example.com"), \
         mock.patch.object(notify, "APP_PASS", "test-pass"), \
         mock.patch.object(notify, "send_email") as mock_send:
        result = notify.run(tenant_keys.DEFAULT_TENANT_ID)
    assert result == {"platform": "skipped_empty", "business": "skipped_empty"}, result
    assert not mock_send.called


# --- Independent dispatch + dedup-after-success --------------------------

def test_both_categories_send_independently_when_both_have_content():
    tenant_id = tenant_keys.DEFAULT_TENANT_ID
    _fresh_db(tenant_id)
    conn = db.get_connection()
    _seed_scraper_failure(conn)
    _seed_rating_drop(conn)
    conn.close()

    with mock.patch.object(notify, "FROM_ADDR", "sender@example.com"), \
         mock.patch.object(notify, "APP_PASS", "test-pass"), \
         mock.patch.object(notify, "send_email") as mock_send:
        result = notify.run(tenant_id)

    assert result == {"platform": "sent", "business": "sent"}, result
    assert mock_send.call_count == 2
    sent_to = {c.args[0] for c in mock_send.call_args_list}
    assert sent_to == {notify.PLATFORM_TO_ADDR, notify.LTA_BUSINESS_TO_ADDR}, sent_to

    conn = db.get_connection()
    scraper_rows = conn.execute(
        "SELECT recipient FROM notifications_log WHERE notification_type = 'scraper_failure'"
    ).fetchall()
    rating_rows = conn.execute(
        "SELECT recipient FROM notifications_log WHERE notification_type = 'rating_drop'"
    ).fetchall()
    conn.close()
    assert [r["recipient"] for r in scraper_rows] == [notify.PLATFORM_TO_ADDR]
    assert [r["recipient"] for r in rating_rows] == [notify.LTA_BUSINESS_TO_ADDR]

    # Retry: everything already notified -- no further sends, no duplicates.
    with mock.patch.object(notify, "FROM_ADDR", "sender@example.com"), \
         mock.patch.object(notify, "APP_PASS", "test-pass"), \
         mock.patch.object(notify, "send_email") as mock_send2:
        retried = notify.run(tenant_id)
    assert retried == {"platform": "skipped_empty", "business": "skipped_empty"}, retried
    assert not mock_send2.called


def test_platform_failure_does_not_block_or_duplicate_business_send():
    tenant_id = tenant_keys.DEFAULT_TENANT_ID
    _fresh_db(tenant_id)
    conn = db.get_connection()
    _seed_scraper_failure(conn)
    _seed_rating_drop(conn)
    conn.close()

    def _fail_platform(to_addr, subject, html):
        if to_addr == notify.PLATFORM_TO_ADDR:
            raise Exception("simulated SMTP failure")

    with mock.patch.object(notify, "FROM_ADDR", "sender@example.com"), \
         mock.patch.object(notify, "APP_PASS", "test-pass"), \
         mock.patch.object(notify, "send_email", side_effect=_fail_platform) as mock_send:
        result = notify.run(tenant_id)

    assert result == {"platform": "failed", "business": "sent"}, result
    assert mock_send.call_count == 2, "both categories must still be attempted independently"

    conn = db.get_connection()
    scraper_logged = conn.execute(
        "SELECT 1 FROM notifications_log WHERE notification_type = 'scraper_failure'"
    ).fetchone()
    rating_logged = conn.execute(
        "SELECT 1 FROM notifications_log WHERE notification_type = 'rating_drop'"
    ).fetchone()
    conn.close()
    assert scraper_logged is None, "a failed send must never be marked notified"
    assert rating_logged is not None, "the succeeding category must still be marked notified"

    # Retry with everything now succeeding: platform must resend (still
    # pending); business must NOT resend -- no duplicate to
    # advertising@l3amigos.com.
    with mock.patch.object(notify, "FROM_ADDR", "sender@example.com"), \
         mock.patch.object(notify, "APP_PASS", "test-pass"), \
         mock.patch.object(notify, "send_email") as mock_send2:
        retried = notify.run(tenant_id)

    assert retried == {"platform": "sent", "business": "skipped_empty"}, retried
    assert mock_send2.call_count == 1
    assert mock_send2.call_args_list[0].args[0] == notify.PLATFORM_TO_ADDR


def test_business_failure_does_not_block_or_duplicate_platform_send():
    tenant_id = tenant_keys.DEFAULT_TENANT_ID
    _fresh_db(tenant_id)
    conn = db.get_connection()
    _seed_scraper_failure(conn)
    _seed_rating_drop(conn)
    conn.close()

    def _fail_business(to_addr, subject, html):
        if to_addr == notify.LTA_BUSINESS_TO_ADDR:
            raise Exception("simulated SMTP failure")

    with mock.patch.object(notify, "FROM_ADDR", "sender@example.com"), \
         mock.patch.object(notify, "APP_PASS", "test-pass"), \
         mock.patch.object(notify, "send_email", side_effect=_fail_business) as mock_send:
        result = notify.run(tenant_id)

    assert result == {"platform": "sent", "business": "failed"}, result
    assert mock_send.call_count == 2

    conn = db.get_connection()
    scraper_logged = conn.execute(
        "SELECT 1 FROM notifications_log WHERE notification_type = 'scraper_failure'"
    ).fetchone()
    rating_logged = conn.execute(
        "SELECT 1 FROM notifications_log WHERE notification_type = 'rating_drop'"
    ).fetchone()
    conn.close()
    assert scraper_logged is not None, "the succeeding category must still be marked notified"
    assert rating_logged is None, "a failed send must never be marked notified"

    with mock.patch.object(notify, "FROM_ADDR", "sender@example.com"), \
         mock.patch.object(notify, "APP_PASS", "test-pass"), \
         mock.patch.object(notify, "send_email") as mock_send2:
        retried = notify.run(tenant_id)

    assert retried == {"platform": "skipped_empty", "business": "sent"}, retried
    assert mock_send2.call_count == 1
    assert mock_send2.call_args_list[0].args[0] == notify.LTA_BUSINESS_TO_ADDR


# --- LTA-only business boundary -------------------------------------------

def test_non_lta_tenant_never_falls_back_to_ltas_business_address():
    _fresh_db(OTHER_TENANT_ID)
    conn = db.get_connection()
    _seed_rating_drop(conn, loc_name="Other Loc")
    conn.close()

    with mock.patch.object(notify, "FROM_ADDR", "sender@example.com"), \
         mock.patch.object(notify, "APP_PASS", "test-pass"), \
         mock.patch.object(notify, "send_email") as mock_send:
        result = notify.run(OTHER_TENANT_ID)

    assert result["business"] == "skipped_no_recipient", result
    assert not any(c.args[0] == notify.LTA_BUSINESS_TO_ADDR for c in mock_send.call_args_list), \
        "must never send a non-LTA tenant's business content to LTA's address"

    conn = db.get_connection()
    logged = conn.execute("SELECT 1 FROM notifications_log WHERE notification_type = 'rating_drop'").fetchone()
    conn.close()
    assert logged is None, "unsent content must not be marked notified (so it stays visible once configured)"


def test_non_lta_tenants_platform_content_is_unaffected_by_missing_business_recipient():
    """Platform-operational content is never tenant-scoped for recipient
    purposes -- a tenant with no business recipient configured must still
    get its platform-operational alerts sent normally."""
    _fresh_db(OTHER_TENANT_ID)
    conn = db.get_connection()
    _seed_scraper_failure(conn)
    conn.close()

    with mock.patch.object(notify, "FROM_ADDR", "sender@example.com"), \
         mock.patch.object(notify, "APP_PASS", "test-pass"), \
         mock.patch.object(notify, "send_email") as mock_send:
        result = notify.run(OTHER_TENANT_ID)

    assert result["platform"] == "sent", result
    assert mock_send.call_args_list[0].args[0] == notify.PLATFORM_TO_ADDR


# --- Missing credentials never permanently suppresses content ------------

def test_missing_credentials_skips_without_losing_content():
    tenant_id = tenant_keys.DEFAULT_TENANT_ID
    _fresh_db(tenant_id)
    conn = db.get_connection()
    _seed_scraper_failure(conn)
    conn.close()

    with mock.patch.object(notify, "FROM_ADDR", ""), mock.patch.object(notify, "APP_PASS", ""):
        result = notify.run(tenant_id)
    assert result["platform"] == "skipped_no_credentials", result

    conn = db.get_connection()
    logged = conn.execute("SELECT 1 FROM notifications_log WHERE notification_type = 'scraper_failure'").fetchone()
    conn.close()
    assert logged is None, "must not be marked notified while credentials are missing"

    with mock.patch.object(notify, "FROM_ADDR", "sender@example.com"), \
         mock.patch.object(notify, "APP_PASS", "test-pass"), \
         mock.patch.object(notify, "send_email") as mock_send:
        retried = notify.run(tenant_id)
    assert retried["platform"] == "sent", retried
    assert mock_send.called


def main():
    tests = [
        ("resolve_business_recipient resolves LTA only, never a fallback", test_resolve_business_recipient_lta_only),
        ("notify.py never reuses the public review-response contact", test_never_reuses_the_public_review_response_contact),
        ("nothing to report sends nothing", test_nothing_to_report_sends_nothing),
        ("both categories send independently when both have content", test_both_categories_send_independently_when_both_have_content),
        ("a platform send failure never blocks or duplicates the business send", test_platform_failure_does_not_block_or_duplicate_business_send),
        ("a business send failure never blocks or duplicates the platform send", test_business_failure_does_not_block_or_duplicate_platform_send),
        ("a non-LTA tenant never falls back to LTA's business address", test_non_lta_tenant_never_falls_back_to_ltas_business_address),
        ("a non-LTA tenant's platform content is unaffected by a missing business recipient", test_non_lta_tenants_platform_content_is_unaffected_by_missing_business_recipient),
        ("missing credentials skip without losing content", test_missing_credentials_skips_without_losing_content),
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
