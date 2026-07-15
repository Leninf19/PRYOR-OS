"""
Regression tests for gbp_import.py against a temporary, isolated SQLite DB
and a temporary report path -- never the real dashboard/reviews.db or the
real gbp_import_report.json at the repo root. google_api.py is fully mocked.

Covers: dry-run writes nothing, matched rows get linked (not duplicated --
this is the exact duplicate-insert bug found and fixed earlier in this
project, formalized here as a permanent regression test), and unmatched
API-only reviews get inserted fresh only in --apply mode.

Run directly: py tests/test_gbp_import.py
"""
import sys
import tempfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import gbp_import
import google_api as ga

SAMPLE_ACCOUNT = {"name": "accounts/123", "accountName": "Test Account"}
SAMPLE_LOCATION = {"name": "accounts/123/locations/456", "locationName": "Casa Tequila Testtown"}


def _fresh_env():
    tmpdir = tempfile.mkdtemp(prefix="gbp_import_test_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    gbp_import.REPORT_PATH = Path(tmpdir) / "gbp_import_report.json"  # never the real repo-root file
    conn = db.get_connection()
    db.init_schema(conn)
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Casa Tequila Testtown', 'Testtown', 'Casa Tequila')")
    loc_id = conn.execute("SELECT id FROM locations WHERE name = ?", ("Casa Tequila Testtown",)).fetchone()["id"]
    conn.commit()
    conn.close()
    return loc_id


def _api_review(review_id, stars, date, reviewer, text):
    return {
        "name": f"accounts/123/locations/456/reviews/{review_id}",
        "reviewer": {"displayName": reviewer},
        "starRating": stars,
        "comment": text,
        "createTime": f"{date}T12:00:00Z",
        "updateTime": f"{date}T12:00:00Z",
    }


def _run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        return True
    except AssertionError as e:
        print(f"FAIL: {name} -- {e}")
        return False


def _mocked(reviews):
    return (
        mock.patch.object(ga, "is_configured", return_value=True),
        mock.patch.object(ga, "list_accounts", return_value=[SAMPLE_ACCOUNT]),
        mock.patch.object(ga, "list_locations", return_value=[SAMPLE_LOCATION]),
        mock.patch.object(ga, "list_reviews", return_value=reviews),
    )


def test_dry_run_writes_nothing():
    loc_id = _fresh_env()
    conn = db.get_connection()
    conn.execute(
        """INSERT INTO reviews (location_id, reviewer_name, review_date, star_rating, review_text,
           dedup_key, is_deleted, first_seen_at, last_seen_at)
           VALUES (?, 'Jane Doe', '2026-07-10', 4, 'Great food', 'k1', 0, '2026-07-10', '2026-07-10')""",
        (loc_id,),
    )
    conn.commit()
    conn.close()

    review = _api_review("rev1", "FOUR", "2026-07-10", "Jane Doe", "Great food")
    with _mocked([review])[0], _mocked([review])[1], _mocked([review])[2], _mocked([review])[3]:
        gbp_import.run(apply=False)

    conn = db.get_connection()
    row = conn.execute("SELECT gbp_review_name FROM reviews").fetchone()
    count = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    conn.close()
    assert count == 1, f"dry-run must not insert rows, got {count}"
    assert row["gbp_review_name"] is None, "dry-run must not link/write gbp_review_name either"
    assert gbp_import.REPORT_PATH.exists(), "dry-run should still write the reconciliation report"


def test_matched_review_is_linked_not_duplicated():
    """The exact bug found earlier: using upsert_review() for a matched row
    inserted a duplicate instead of linking the existing one, because
    dedup_key() prefers gbp_review_name, which the old scraped row doesn't
    have yet. Confirms link_review_to_gbp() is used instead."""
    loc_id = _fresh_env()
    conn = db.get_connection()
    conn.execute(
        """INSERT INTO reviews (location_id, reviewer_name, review_date, star_rating, review_text,
           dedup_key, is_deleted, first_seen_at, last_seen_at)
           VALUES (?, 'Jane Doe', '2026-07-10', 4, 'Great food', 'k1', 0, '2026-07-10', '2026-07-10')""",
        (loc_id,),
    )
    conn.commit()
    conn.close()

    review = _api_review("rev1", "FOUR", "2026-07-10", "Jane Doe", "Great food")
    p1, p2, p3, p4 = _mocked([review])
    with p1, p2, p3, p4:
        gbp_import.run(apply=True)

    conn = db.get_connection()
    count = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    row = conn.execute("SELECT gbp_review_name FROM reviews").fetchone()
    conn.close()
    assert count == 1, f"matched review must link the existing row, not duplicate it -- got {count} rows"
    assert row["gbp_review_name"] == "accounts/123/locations/456/reviews/rev1", row["gbp_review_name"]


def test_unmatched_api_review_inserted_only_on_apply():
    loc_id = _fresh_env()
    review = _api_review("rev2", "FIVE", "2026-07-12", "New Reviewer", "Wonderful experience, will come back")
    p1, p2, p3, p4 = _mocked([review])

    with p1, p2, p3, p4:
        gbp_import.run(apply=False)
    conn = db.get_connection()
    assert conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"] == 0, "dry-run must not insert the unmatched review"
    conn.close()

    p1, p2, p3, p4 = _mocked([review])
    with p1, p2, p3, p4:
        gbp_import.run(apply=True)
    conn = db.get_connection()
    count = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    conn.close()
    assert count == 1, f"apply mode should insert the unmatched API-only review, got {count}"


def main():
    tests = [
        ("dry-run writes zero DB changes but still writes the report", test_dry_run_writes_nothing),
        ("a matched review is linked to the existing row, never duplicated", test_matched_review_is_linked_not_duplicated),
        ("an unmatched API-only review is inserted only in --apply mode", test_unmatched_api_review_inserted_only_on_apply),
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
