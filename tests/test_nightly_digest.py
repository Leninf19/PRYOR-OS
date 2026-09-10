"""
Regression tests for nightly_digest.py against a temporary, isolated
SQLite DB. Covers the meaningful-content filter, already-answered
exclusion, "Previously Escalated" labeling, dedup across runs, the
zero-qualifying-reviews no-email path, and the DST-safe 10pm ET hour gate.

Run directly: py tests/test_nightly_digest.py
"""
import sys
import tempfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import nightly_digest as nd
import tenant_keys
import tenant_paths

nd.FROM_ADDR = ""
nd.APP_PASS = ""

TEST_TENANT_ID = tenant_keys.DEFAULT_TENANT_ID


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="nightly_digest_test_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    tenant_paths._set_review_db_path_for_tests(TEST_TENANT_ID, db.DB_PATH)
    conn = db.get_connection()
    db.init_schema(conn)
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Test Loc', 'Testville', 'Casa Tequila')")
    loc_id = conn.execute("SELECT id FROM locations WHERE name = ?", ("Test Loc",)).fetchone()["id"]
    conn.commit()
    conn.close()
    return loc_id


def _add_review(loc_id, text, stars, priority=None, owner_response=None, review_date="2026-07-15"):
    conn = db.get_connection()
    conn.execute(
        """INSERT INTO reviews (location_id, reviewer_name, review_date, star_rating, review_text,
           dedup_key, is_deleted, ai_priority, owner_response, first_seen_at, last_seen_at)
           VALUES (?, 'Tester', ?, ?, ?, ?, 0, ?, ?, ?, ?)""",
        (loc_id, review_date, stars, text, text[:20] + str(stars) + review_date, priority, owner_response,
         review_date, review_date),
    )
    conn.commit()
    conn.close()


def _run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        return True
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        return False


def test_meaningful_content_filter_and_header_count():
    loc_id = _fresh_db()
    _add_review(loc_id, "The wait staff was rude and the food arrived cold and bland, worst visit ever", 1, "high")
    _add_review(loc_id, "Bad", 1, "low")
    _add_review(loc_id, "", 2, "low")

    conn = db.get_connection()
    reviews = nd.find_new_meaningful_low_star(conn)
    conn.close()
    assert len(reviews) == 1, f"expected only the descriptive review to qualify, got {len(reviews)}"


def test_answered_review_excluded():
    loc_id = _fresh_db()
    _add_review(loc_id, "Cold food and slow service, would not recommend to anyone", 1, "high",
                owner_response="We're very sorry, please reach out to us directly.")

    conn = db.get_connection()
    reviews = nd.find_new_meaningful_low_star(conn)
    conn.close()
    assert len(reviews) == 0, "an already-answered review must be excluded from the nightly digest entirely"


def test_escalated_review_labeled_not_excluded():
    loc_id = _fresh_db()
    _add_review(loc_id, "Found a serious health issue in my food and got sick after eating here", 1, "critical")

    conn = db.get_connection()
    review_id = conn.execute("SELECT id FROM reviews").fetchone()["id"]
    import digest_filters
    digest_filters.log_notification(conn, "critical_review_immediate", "test", related_review_id=review_id)
    conn.commit()

    reviews = nd.find_new_meaningful_low_star(conn)
    assert len(reviews) == 1, "an escalated review should still appear in the digest (labeled), not be excluded"
    escalated = nd.is_already_escalated(conn, reviews[0]["id"])
    conn.close()
    assert escalated is True

    html = nd.build_email([{**reviews[0], "location_name": "Test Loc", "_escalated": True}], "July 15, 2026")
    assert "PREVIOUSLY ESCALATED" in html


def test_dedup_across_runs():
    loc_id = _fresh_db()
    _add_review(loc_id, "Waited over an hour and the food was still wrong when it arrived", 2, "medium")

    with mock.patch.object(nd, "FROM_ADDR", ""), mock.patch.object(nd, "APP_PASS", ""):
        first = nd.run(TEST_TENANT_ID, force=True)
        second = nd.run(TEST_TENANT_ID, force=True)

    assert first["status"] == "ready_no_credentials"
    assert first["count"] == 1, first
    assert second["status"] == "no_qualifying_reviews", f"re-running should find zero new reviews, got {second}"


def test_zero_qualifying_reviews_sends_no_email():
    _fresh_db()
    with mock.patch.object(nd, "send_email") as mock_send:
        result = nd.run(TEST_TENANT_ID, force=True)
    assert result["status"] == "no_qualifying_reviews"
    assert not mock_send.called, "must never call send_email when nothing qualifies"


def test_dst_hour_gate_skips_outside_10pm_et():
    """Deterministic, not wall-clock-dependent: mocks datetime.now() to a
    fixed non-10pm ET moment and confirms the gate skips without --force."""
    _fresh_db()
    from datetime import datetime as real_datetime
    from zoneinfo import ZoneInfo
    fake_now = real_datetime(2026, 7, 15, 14, 30, tzinfo=ZoneInfo("America/New_York"))  # 2:30pm ET

    class FakeDatetime(real_datetime):
        @classmethod
        def now(cls, tz=None):
            return fake_now if tz else fake_now.replace(tzinfo=None)

    with mock.patch.object(nd, "datetime", FakeDatetime):
        result = nd.run(TEST_TENANT_ID, force=False)
    assert result["status"] == "skipped_wrong_hour", result
    assert result["hour_et"] == 14, result


def test_dst_hour_gate_proceeds_at_10pm_et():
    """Same fixture, mocked to exactly 10pm ET -- confirms the gate lets a
    real firing through instead of always skipping."""
    loc_id = _fresh_db()
    _add_review(loc_id, "The manager was dismissive when we raised a serious billing issue", 1, "high")
    from datetime import datetime as real_datetime
    from zoneinfo import ZoneInfo
    fake_now = real_datetime(2026, 7, 15, 22, 0, tzinfo=ZoneInfo("America/New_York"))

    class FakeDatetime(real_datetime):
        @classmethod
        def now(cls, tz=None):
            return fake_now if tz else fake_now.replace(tzinfo=None)

    with mock.patch.object(nd, "datetime", FakeDatetime):
        result = nd.run(TEST_TENANT_ID, force=False)
    assert result["status"] == "ready_no_credentials", result
    assert result["count"] == 1, result


def main():
    tests = [
        ("meaningful-content filter excludes empty/generic reviews", test_meaningful_content_filter_and_header_count),
        ("an already-answered review is excluded entirely", test_answered_review_excluded),
        ("a previously-escalated critical review is labeled, not excluded", test_escalated_review_labeled_not_excluded),
        ("dedup: re-running finds zero new reviews the second time", test_dedup_across_runs),
        ("zero qualifying reviews sends no email", test_zero_qualifying_reviews_sends_no_email),
        ("DST-safe hour gate skips at a non-10pm-ET moment", test_dst_hour_gate_skips_outside_10pm_et),
        ("DST-safe hour gate proceeds at exactly 10pm ET", test_dst_hour_gate_proceeds_at_10pm_et),
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
