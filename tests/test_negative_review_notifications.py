"""
Regression tests for the negative-review notification fix (2026-07-17):

Bug 1 -- the "N new reviews" email included every star rating (4-star,
5-star reviews shown alongside 1-2 star ones). Root cause: this email was
never filtered by rating at all, by original design -- not a broken
existing filter. Fixed by routing it through the new
digest_filters.get_new_negative_reviews() before it ever reaches the
template, in both auto_update.py (active) and gbp_sync.py (dormant).

Bug 2 -- a global account-discovery failure (e.g. Google API 429 quota
exceeded) was misreported as "0 of 0 locations encountered an error" with
the raw API error text listed as an "affected location". Root cause:
notify.py::check_scraper_failure() assumed error_summary was always a
per-location ";"-joined list; gbp_sync.py's account-discovery failure path
writes a single global message instead. Fixed via an explicit
scraper_runs.failure_stage='account_discovery' marker (never inferred).

Covers the 8 required test scenarios from the fix spec. Run directly:
py tests/test_negative_review_notifications.py
"""
import sys
import tempfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import auto_update
import db
import digest_filters
import gbp_sync
import google_api as ga
import notify
import tenant_keys
import tenant_paths

TEST_TENANT_ID = tenant_keys.DEFAULT_TENANT_ID


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="negreview_test_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    tenant_paths._set_review_db_path_for_tests(TEST_TENANT_ID, db.DB_PATH)
    conn = db.get_connection()
    db.init_schema(conn)
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Test Loc', 'Testville', 'Casa Tequila')")
    loc_id = conn.execute("SELECT id FROM locations WHERE name = ?", ("Test Loc",)).fetchone()["id"]
    conn.commit()
    conn.close()
    return loc_id


def _run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        return True
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        return False


# ---------------------------------------------------------------------------
# Scenario 1: New reviews are [5, 4, 5, 4] -- all stored, no negative email
# ---------------------------------------------------------------------------
def test_all_positive_stored_no_email():
    loc_id = _fresh_db()
    conn = db.get_connection()
    rows = []
    for i, stars in enumerate([5, 4, 5, 4]):
        row = {
            "reviewer_name": f"Reviewer{i}", "star_rating": stars,
            "review_text": f"Great experience number {i}", "review_date": "2026-07-17",
            "review_url": f"https://maps.google.com/review{i}", "owner_response": "",
        }
        db.upsert_review(conn, loc_id, "Test Loc", row, "2026-07-17T00:00:00+00:00")
        rows.append(row)
    conn.commit()
    stored = conn.execute("SELECT COUNT(*) c FROM reviews WHERE is_deleted=0").fetchone()["c"]
    conn.close()
    assert stored == 4, f"all 4 reviews must be stored regardless of rating, got {stored}"

    negative = digest_filters.get_new_negative_reviews(rows)
    assert negative == [], f"no negative reviews expected, got {negative}"
    html = auto_update.build_email_html(negative)
    assert html == "", "no email content should be built when there are zero negative reviews"


# ---------------------------------------------------------------------------
# Scenario 2: New reviews are [5, 2, 4, 1] -- all stored, email has only 2★/1★
# ---------------------------------------------------------------------------
def test_mixed_ratings_email_contains_only_negative():
    loc_id = _fresh_db()
    conn = db.get_connection()
    rows = [
        {"location_name": "Test Loc", "reviewer_name": "Positive5", "star_rating": 5, "review_text": "Loved it", "review_date": "2026-07-17", "review_url": "https://maps.google.com/r5", "owner_response": ""},
        {"location_name": "Test Loc", "reviewer_name": "Negative2", "star_rating": 2, "review_text": "Food was cold and service was slow", "review_date": "2026-07-17", "review_url": "https://maps.google.com/r2", "owner_response": ""},
        {"location_name": "Test Loc", "reviewer_name": "Positive4", "star_rating": 4, "review_text": "Pretty good", "review_date": "2026-07-17", "review_url": "https://maps.google.com/r4", "owner_response": ""},
        {"location_name": "Test Loc", "reviewer_name": "Negative1", "star_rating": 1, "review_text": "Terrible, never again", "review_date": "2026-07-17", "review_url": "https://maps.google.com/r1", "owner_response": ""},
    ]
    for row in rows:
        db.upsert_review(conn, loc_id, "Test Loc", row, "2026-07-17T00:00:00+00:00")
    conn.commit()
    stored = conn.execute("SELECT COUNT(*) c FROM reviews WHERE is_deleted=0").fetchone()["c"]
    conn.close()
    assert stored == 4, f"all 4 must still be stored, got {stored}"

    negative = digest_filters.get_new_negative_reviews(rows)
    assert len(negative) == 2, f"expected exactly 2 negative reviews, got {len(negative)}"
    assert {r["reviewer_name"] for r in negative} == {"Negative1", "Negative2"}

    html = auto_update.build_email_html(negative)
    assert "Negative1" in html and "Negative2" in html, "both negative reviewers must appear"
    assert "Positive5" not in html and "Positive4" not in html, "positive reviewers must never appear in the email"


# ---------------------------------------------------------------------------
# Scenario 3: string rating "2" is treated as 2 stars
# ---------------------------------------------------------------------------
def test_string_rating_normalized():
    assert digest_filters.normalize_rating({"star_rating": "2"}) == 2
    assert digest_filters.normalize_rating({"star_rating": "2.0"}) == 2
    assert digest_filters.is_negative_review_for_notification({"star_rating": "2"}) is True


# ---------------------------------------------------------------------------
# Scenario 4: Google rating enum equivalent of 1 star is treated as 1 star
# ---------------------------------------------------------------------------
def test_google_enum_rating_normalized():
    assert digest_filters.normalize_rating({"star_rating": "ONE"}) == 1
    assert digest_filters.normalize_rating({"star_rating": "ONE_STAR"}) == 1
    assert digest_filters.is_negative_review_for_notification({"star_rating": "ONE"}) is True


# ---------------------------------------------------------------------------
# Scenario 5: a previously emailed 1-star review appears again -- not re-emailed
# ---------------------------------------------------------------------------
def test_previously_seen_review_not_resent():
    _fresh_db()
    review = {
        "name": "accounts/1/locations/2/reviews/rev1", "reviewer": {"displayName": "Repeat Reviewer"},
        "starRating": "ONE", "comment": "Bad experience the first time", "createTime": "2026-07-17T12:00:00Z", "updateTime": "2026-07-17T12:00:00Z",
    }
    account = {"name": "accounts/1", "accountName": "Test"}
    location = {"name": "accounts/1/locations/2", "locationName": "Test Loc"}

    with mock.patch.object(ga, "is_configured", return_value=True), \
         mock.patch.object(ga, "list_accounts", return_value=[account]), \
         mock.patch.object(ga, "list_locations", return_value=[location]), \
         mock.patch.object(ga, "list_reviews", return_value=[review]):
        first = gbp_sync.sync_all(tenant_id=TEST_TENANT_ID, fast=False)
    first_negative = digest_filters.get_new_negative_reviews(first["new_reviews"])
    assert len(first_negative) == 1, f"expected the 1-star review to be new+negative on first sync, got {first_negative}"

    with mock.patch.object(ga, "is_configured", return_value=True), \
         mock.patch.object(ga, "list_accounts", return_value=[account]), \
         mock.patch.object(ga, "list_locations", return_value=[location]), \
         mock.patch.object(ga, "list_reviews", return_value=[review]):
        second = gbp_sync.sync_all(tenant_id=TEST_TENANT_ID, fast=False)
    second_negative = digest_filters.get_new_negative_reviews(second["new_reviews"])
    assert second_negative == [], f"the same review must not appear as new/negative again, got {second_negative}"


# ---------------------------------------------------------------------------
# Scenario 6: the email-template function refuses to render >2 star reviews
# even when handed a mixed, unfiltered array directly
# ---------------------------------------------------------------------------
def test_email_template_safeguards_against_unfiltered_input():
    unfiltered = [
        {"location_name": "Test Loc", "reviewer_name": "ShouldShow1", "star_rating": 1, "review_text": "Bad food", "review_date": "2026-07-17", "review_url": ""},
        {"location_name": "Test Loc", "reviewer_name": "ShouldHide5", "star_rating": 5, "review_text": "Amazing", "review_date": "2026-07-17", "review_url": ""},
        {"location_name": "Test Loc", "reviewer_name": "ShouldHide3", "star_rating": 3, "review_text": "It was okay I guess overall", "review_date": "2026-07-17", "review_url": ""},
        {"location_name": "Test Loc", "reviewer_name": "ShouldShow2", "star_rating": 2, "review_text": "Slow service", "review_date": "2026-07-17", "review_url": ""},
    ]
    html = auto_update.build_email_html(unfiltered)
    assert "ShouldShow1" in html and "ShouldShow2" in html
    assert "ShouldHide5" not in html, "5-star review leaked into the email despite being passed unfiltered"
    assert "ShouldHide3" not in html, "3-star review leaked into the email despite being passed unfiltered"

    unfiltered_gbp = [
        {"location": "Test Loc", "reviewer_name": "GbpShow1", "star_rating": 1, "review_text": "Bad"},
        {"location": "Test Loc", "reviewer_name": "GbpHide5", "star_rating": 5, "review_text": "Great"},
    ]
    html2 = gbp_sync._build_email_html(unfiltered_gbp)
    assert "GbpShow1" in html2
    assert "GbpHide5" not in html2, "gbp_sync's email template also leaked a 5-star review"


# ---------------------------------------------------------------------------
# Scenario 7: Google Account Management API 429 before location discovery
# ---------------------------------------------------------------------------
def test_global_429_preserves_data_and_correct_alert():
    loc_id = _fresh_db()
    conn = db.get_connection()
    seed_row = {"reviewer_name": "Existing Reviewer", "star_rating": 4, "review_text": "Nice place overall", "review_date": "2026-07-10", "review_url": "https://maps.google.com/existing", "owner_response": ""}
    db.upsert_review(conn, loc_id, "Test Loc", seed_row, "2026-07-10T00:00:00+00:00")
    conn.commit()
    before_count = conn.execute("SELECT COUNT(*) c FROM reviews WHERE is_deleted=0").fetchone()["c"]
    conn.close()
    assert before_count == 1

    quota_error = ga.GBPRateLimitError(
        "Google API 429: Quota exceeded for quota metric 'Requests' and limit 'Requests per minute' "
        "of service 'mybusinessaccountmanagement.googleapis.com' for consumer 'project_number:786038057684'.",
        status=429,
    )
    with mock.patch.object(ga, "is_configured", return_value=True), \
         mock.patch.object(ga, "list_accounts", side_effect=quota_error):
        result = gbp_sync.sync_all(tenant_id=TEST_TENANT_ID, fast=False)
    assert result["status"] == "failed"

    conn = db.get_connection()
    after_count = conn.execute("SELECT COUNT(*) c FROM reviews WHERE is_deleted=0").fetchone()["c"]
    run_row = conn.execute("SELECT * FROM scraper_runs ORDER BY id DESC LIMIT 1").fetchone()

    assert after_count == before_count == 1, "existing review data must be untouched by an account-discovery failure"
    assert run_row["failure_stage"] == "account_discovery", "the failure must be explicitly marked, not inferred"
    assert run_row["locations_attempted"] == 0
    assert run_row["locations_succeeded"] == 0
    assert run_row["locations_failed"] == 0

    alert_html = notify.check_scraper_failure(conn)
    conn.close()

    assert "0 of 0" not in alert_html, "must never say '0 of 0 locations encountered an error'"
    assert "Affected location" not in alert_html, "must never present the API error as an affected location"
    assert "Location discovery could not begin" in alert_html
    assert "mybusinessaccountmanagement.googleapis.com" in alert_html
    assert "429" in alert_html
    assert "Retained" in alert_html or "retained" in alert_html.lower(), "must confirm previous data was retained"


# ---------------------------------------------------------------------------
# Scenario 8: a successful scrape legitimately returns no new negative
# reviews -- workflow succeeds, no email
# ---------------------------------------------------------------------------
def test_successful_scrape_no_negative_reviews_no_email():
    account = {"name": "accounts/1", "accountName": "Test"}
    location = {"name": "accounts/1/locations/2", "locationName": "Test Loc"}
    review = {
        "name": "accounts/1/locations/2/reviews/rev-pos", "reviewer": {"displayName": "Happy Customer"},
        "starRating": "FIVE", "comment": "Wonderful, will come back again soon", "createTime": "2026-07-17T12:00:00Z", "updateTime": "2026-07-17T12:00:00Z",
    }
    _fresh_db()
    with mock.patch.object(ga, "is_configured", return_value=True), \
         mock.patch.object(ga, "list_accounts", return_value=[account]), \
         mock.patch.object(ga, "list_locations", return_value=[location]), \
         mock.patch.object(ga, "list_reviews", return_value=[review]):
        result = gbp_sync.sync_all(tenant_id=TEST_TENANT_ID, fast=False)

    assert result["status"] == "ok", f"a legitimate all-positive scrape must succeed cleanly, got {result}"
    negative = digest_filters.get_new_negative_reviews(result["new_reviews"])
    assert negative == [], "no negative reviews should be found"
    html = gbp_sync._build_email_html(negative)
    assert html == "", "no email content should be built"


def main():
    tests = [
        ("[5,4,5,4]: all stored, no negative email", test_all_positive_stored_no_email),
        ("[5,2,4,1]: all stored, email contains only 1-2 star", test_mixed_ratings_email_contains_only_negative),
        ('string rating "2" normalizes to 2 stars', test_string_rating_normalized),
        ('Google enum "ONE"/"ONE_STAR" normalizes to 1 star', test_google_enum_rating_normalized),
        ("a previously-seen 1-star review is not re-emailed", test_previously_seen_review_not_resent),
        ("email template refuses >2 star reviews even given unfiltered input", test_email_template_safeguards_against_unfiltered_input),
        ("429 at account discovery preserves data and shows the correct alert", test_global_429_preserves_data_and_correct_alert),
        ("a successful all-positive scrape sends no email", test_successful_scrape_no_negative_reviews_no_email),
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
