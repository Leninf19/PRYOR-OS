"""
Regression tests for Phase 2 Milestone 5 (Option C: per-location analytics
alongside company-wide analytics): refresh_analytics.py's new
analytics_location_<id> cache entries, export_chunks.py's
export_location_analytics()/validate_location_analytics(), and the
reconciliation invariants between company-wide and per-location output.

Runs entirely against a scratch SQLite file inside a
tempfile.TemporaryDirectory() and a scratch PRIVATE_DATA_DIR -- the real
dashboard/reviews.db and dashboard/private-data/ are never opened or
written to by this file. No AI API key is required or used (ai_engine.
is_available() returns False without one, which is the same condition
this repo's CI runs under).

Run directly: py tests/test_location_analytics.py
"""
import json
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import export_chunks
import refresh_analytics
import tenant_keys
import tenant_paths

TEST_TENANT_ID = tenant_keys.DEFAULT_TENANT_ID

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _new_conn(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    db.init_schema(conn)
    return conn


def _add_location(conn, name, city="City", brand="Brand") -> int:
    cur = conn.execute(
        "INSERT INTO locations (name, city, brand) VALUES (?, ?, ?)",
        (name, city, brand),
    )
    conn.commit()
    return cur.lastrowid


def _add_review(conn, location_id, review_date, star_rating=5, reviewer_name="R", review_url=None, owner_response=None, review_text="text"):
    key = f"{location_id}|{reviewer_name}|{review_date}|{star_rating}|{review_url or ''}"
    conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date,
                                 star_rating, review_text, owner_response, review_url,
                                 last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (location_id, key, reviewer_name, review_date, star_rating, review_text, owner_response, review_url, review_date),
    )
    conn.commit()


class ScratchPipeline:
    """Context manager: a scratch DB (db.DB_PATH redirected) + scratch
    PRIVATE_DATA_DIR (export_chunks.PRIVATE_DATA_DIR redirected), both
    restored on exit. Never touches the real reviews.db or private-data/.
    Deliberately does NOT call export_chunks.main() (which would write
    dashboard/reviews.csv relative to the real db.BASE_DIR, unaffected by
    the DB_PATH override) -- only the specific functions under test."""

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp_path = Path(self._tmp.name)
        self.db_path = tmp_path / "scratch.db"
        self.conn = _new_conn(self.db_path)
        self.private_data_dir = tmp_path / "private-data"

        self._orig_db_path = db.DB_PATH
        self._orig_private_data_dir = export_chunks.PRIVATE_DATA_DIR
        db.DB_PATH = self.db_path
        export_chunks.PRIVATE_DATA_DIR = self.private_data_dir
        tenant_paths._set_review_db_path_for_tests(TEST_TENANT_ID, self.db_path)
        tenant_paths._set_export_dir_for_tests(TEST_TENANT_ID, self.private_data_dir)
        return self

    def __exit__(self, *exc):
        db.DB_PATH = self._orig_db_path
        export_chunks.PRIVATE_DATA_DIR = self._orig_private_data_dir
        tenant_paths._reset_review_db_paths_for_tests()
        tenant_paths._reset_export_dirs_for_tests()
        self.conn.close()
        self._tmp.cleanup()

    def run_analytics(self):
        """refresh_analytics.main() opens its own connection via
        db.get_connection(), which reads the (redirected) db.DB_PATH --
        refresh_analytics.main() itself re-resolves db.DB_PATH from
        --tenant-id (Multi-Tenant Phase 4D), so the tenant_paths override
        above must point at the same scratch db_path for this to work."""
        with mock.patch.object(sys, "argv", ["refresh_analytics.py", "--tenant-id", TEST_TENANT_ID]):
            refresh_analytics.main()

    def export(self):
        locations = {row["id"]: dict(row) for row in self.conn.execute("SELECT * FROM locations").fetchall()}
        export_chunks.export_analytics_cache(self.conn)
        export_chunks.export_location_analytics(self.conn, locations)
        return locations

    def validate(self, locations):
        return export_chunks.validate_location_analytics(self.conn, locations)

    def read_location_file(self, loc_id):
        return json.loads((self.private_data_dir / "analytics" / "locations" / f"{loc_id}.json").read_text(encoding="utf-8"))

    def read_kpis(self):
        return json.loads((self.private_data_dir / "analytics" / "kpis.json").read_text(encoding="utf-8"))

    def location_files(self):
        d = self.private_data_dir / "analytics" / "locations"
        return sorted(d.glob("*.json")) if d.exists() else []


def _seed_two_locations_with_reviews(px):
    """A small, realistic dataset: two locations, varied ratings, one
    unanswered negative review, spanning the 30/60-day windows."""
    loc_a = _add_location(px.conn, "Alpha Diner", city="Alpha City", brand="Brand A")
    loc_b = _add_location(px.conn, "Beta Bistro", city="Beta City", brand="Brand B")
    now = datetime.now(timezone.utc)
    for i, star in enumerate([5, 4, 5, 1, 3]):
        d = (now - timedelta(days=5 + i)).date().isoformat()
        _add_review(px.conn, loc_a, d, star_rating=star, reviewer_name=f"a{i}",
                     owner_response=None if star <= 2 else "thanks!")
    for i, star in enumerate([2, 4, 4]):
        d = (now - timedelta(days=10 + i)).date().isoformat()
        _add_review(px.conn, loc_b, d, star_rating=star, reviewer_name=f"b{i}", owner_response="thanks!")
    return loc_a, loc_b


# --- Section 1: existing outputs preserved -----------------------------------

def test_company_wide_files_still_generated_alongside_new_location_files():
    with ScratchPipeline() as px:
        _seed_two_locations_with_reviews(px)
        px.run_analytics()
        px.export()
        for name in ("kpis.json", "monthly-trend.json", "location-stats.json", "rankings-30d.json"):
            assert (px.private_data_dir / "analytics" / name).exists(), f"existing company-wide file {name} must still be generated"


def test_kpis_gains_starBreakdown_additively_without_losing_existing_fields():
    with ScratchPipeline() as px:
        _seed_two_locations_with_reviews(px)
        px.run_analytics()
        px.export()
        kpis = px.read_kpis()
        for field in ("totalReviews", "totalLocations", "lifetimeAvgRating", "period30dSentiment",
                      "avgRating30d", "ratingDelta30d", "unansweredCount", "healthScore", "computedAt"):
            assert field in kpis, f"pre-existing kpis field '{field}' must still be present"
        assert "starBreakdown" in kpis, "kpis must gain the new starBreakdown field"
        assert {e["star"] for e in kpis["starBreakdown"]} == {1, 2, 3, 4, 5}


# --- Section 2/3: per-location artifacts, canonical structure ---------------

def test_every_location_produces_exactly_one_analytics_artifact():
    with ScratchPipeline() as px:
        loc_a, loc_b = _seed_two_locations_with_reviews(px)
        px.run_analytics()
        locations = px.export()
        files = px.location_files()
        assert len(files) == len(locations) == 2
        stems = {f.stem for f in files}
        assert stems == {str(loc_a), str(loc_b)}


def test_artifact_filenames_are_deterministic_canonical_ids_not_slugs():
    with ScratchPipeline() as px:
        loc_a, _ = _seed_two_locations_with_reviews(px)
        px.run_analytics()
        px.export()
        files = {f.name for f in px.location_files()}
        assert f"{loc_a}.json" in files, "filename must be the canonical integer id, not a slug"
        assert not any("alpha" in f.lower() or "beta" in f.lower() for f in files), \
            "filenames must never be derived from location name/slug"


def test_every_artifact_contains_the_correct_locationId():
    with ScratchPipeline() as px:
        loc_a, loc_b = _seed_two_locations_with_reviews(px)
        px.run_analytics()
        px.export()
        assert px.read_location_file(loc_a)["locationId"] == loc_a
        assert px.read_location_file(loc_b)["locationId"] == loc_b


def test_no_duplicate_location_ids_across_artifacts():
    with ScratchPipeline() as px:
        _seed_two_locations_with_reviews(px)
        px.run_analytics()
        locations = px.export()
        ids = [int(f.stem) for f in px.location_files()]
        assert len(ids) == len(set(ids)), "no two artifacts may claim the same location id"
        ok, issues, _ = px.validate(locations)
        assert ok, f"validation must pass for a clean, duplicate-free export: {issues}"


# --- Section 5/7: reconciliation -----------------------------------------------

def test_review_totals_reconcile_between_company_and_locations():
    with ScratchPipeline() as px:
        _seed_two_locations_with_reviews(px)
        px.run_analytics()
        locations = px.export()
        ok, issues, details = px.validate(locations)
        assert ok, issues
        assert details["companyReviewTotal"] == details["sumLocationReviewTotals"] == 8


def test_star_distribution_reconciles_between_company_and_locations():
    with ScratchPipeline() as px:
        _seed_two_locations_with_reviews(px)
        px.run_analytics()
        locations = px.export()
        ok, issues, details = px.validate(locations)
        assert ok, issues
        assert details["companyStarDistribution"] == details["reconstructedStarDistribution"]
        # Known from the seeded data: ratings 5,4,5,1,3,2,4,4 -> one each of 1/2/3, two of 4... let's just assert the total matches n.
        assert sum(details["companyStarDistribution"].values()) == 8


def test_average_rating_reconciles_between_company_and_locations():
    with ScratchPipeline() as px:
        _seed_two_locations_with_reviews(px)
        px.run_analytics()
        locations = px.export()
        ok, issues, details = px.validate(locations)
        assert ok, issues
        assert details["companyAverageRating"] == details["reconstructedAverageRating"]


def test_company_analytics_equals_aggregation_of_all_location_analytics():
    """Direct comparison test: company kpis vs. independently re-aggregated
    per-location artifact data, computed here in the test (not by calling
    validate_location_analytics), as a second, independent proof."""
    with ScratchPipeline() as px:
        _seed_two_locations_with_reviews(px)
        px.run_analytics()
        locations = px.export()
        kpis = px.read_kpis()

        total_from_locations = sum(px.read_location_file(loc_id)["reviewCounts"]["lifetime"] for loc_id in locations)
        assert total_from_locations == kpis["totalReviews"]

        star_totals = {s: 0 for s in range(1, 6)}
        for loc_id in locations:
            for entry in px.read_location_file(loc_id)["starDistribution"]["lifetime"]:
                star_totals[entry["star"]] += entry["count"]
        company_star = {e["star"]: e["count"] for e in kpis["starBreakdown"]}
        assert star_totals == company_star


# --- Section 6: intelligence separation / no contamination -------------------

def test_no_cross_location_contamination_in_review_counts():
    with ScratchPipeline() as px:
        loc_a, loc_b = _seed_two_locations_with_reviews(px)
        px.run_analytics()
        px.export()
        a = px.read_location_file(loc_a)
        b = px.read_location_file(loc_b)
        assert a["reviewCounts"]["lifetime"] == 5, "location A has exactly 5 seeded reviews"
        assert b["reviewCounts"]["lifetime"] == 3, "location B has exactly 3 seeded reviews"
        assert a["name"] == "Alpha Diner" and b["name"] == "Beta Bistro"


def test_location_artifact_never_contains_cross_location_ranking_or_comparison_keys():
    with ScratchPipeline() as px:
        _seed_two_locations_with_reviews(px)
        px.run_analytics()
        locations = px.export()
        forbidden_keys = {"rankings", "ranking", "actionCenter", "operationsImpact", "consistency", "companyRanking"}
        for loc_id in locations:
            payload = px.read_location_file(loc_id)
            present = forbidden_keys & set(payload.keys())
            assert not present, f"location {loc_id} artifact must not contain cross-location keys, found: {present}"


# --- empty location / missing / orphan ----------------------------------------

def test_empty_location_still_generates_valid_analytics():
    with ScratchPipeline() as px:
        loc_empty = _add_location(px.conn, "Empty Location")
        _add_location(px.conn, "Populated Location")  # at least one location needs data so refresh_analytics has something to chew on
        loc_pop = list(px.conn.execute("SELECT id FROM locations WHERE name = 'Populated Location'"))[0]["id"]
        _add_review(px.conn, loc_pop, "2026-01-01", star_rating=5)
        px.run_analytics()
        locations = px.export()

        payload = px.read_location_file(loc_empty)
        assert payload["locationId"] == loc_empty
        assert payload["reviewCounts"]["lifetime"] == 0
        assert payload["averageRating"]["lifetime"] is None, "an empty location must not fabricate an average rating"
        assert payload["starDistribution"]["lifetime"] == [{"star": s, "count": 0} for s in range(1, 6)]

        ok, issues, _ = px.validate(locations)
        assert ok, f"an empty-but-real location must still pass validation: {issues}"


def test_missing_location_analytics_fails_validation():
    with ScratchPipeline() as px:
        loc_a, loc_b = _seed_two_locations_with_reviews(px)
        px.run_analytics()
        locations = px.export()
        # Simulate a missing artifact: delete one of the two written files.
        (px.private_data_dir / "analytics" / "locations" / f"{loc_b}.json").unlink()

        ok, issues, details = px.validate(locations)
        assert not ok, "a location lacking an analytics artifact must fail validation"
        assert any(str(loc_b) in issue for issue in issues)
        assert loc_b in details["locationsMissingAnalytics"]


def test_orphan_location_analytics_fails_validation():
    with ScratchPipeline() as px:
        loc_a, loc_b = _seed_two_locations_with_reviews(px)
        px.run_analytics()
        locations = px.export()
        # Simulate an orphan: write an artifact for a location id that was
        # since removed from the `locations` table.
        ghost_id = 999999
        (px.private_data_dir / "analytics" / "locations" / f"{ghost_id}.json").write_text(
            json.dumps({"locationId": ghost_id, "reviewCounts": {"lifetime": 0}}), encoding="utf-8"
        )

        ok, issues, details = px.validate(locations)
        assert not ok, "an analytics artifact for an unknown location id must fail validation"
        assert ghost_id in details["orphanAnalytics"]


def test_locationId_mismatch_between_filename_and_content_fails_validation():
    with ScratchPipeline() as px:
        loc_a, loc_b = _seed_two_locations_with_reviews(px)
        px.run_analytics()
        locations = px.export()
        # Corrupt one file's content so its declared locationId doesn't
        # match the filename it's stored under.
        path = px.private_data_dir / "analytics" / "locations" / f"{loc_a}.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["locationId"] = loc_b  # wrong on purpose
        path.write_text(json.dumps(payload), encoding="utf-8")

        ok, issues, _ = px.validate(locations)
        assert not ok, "a filename/content locationId mismatch must fail validation"


def test_contamination_detected_via_independent_db_recount():
    with ScratchPipeline() as px:
        loc_a, loc_b = _seed_two_locations_with_reviews(px)
        px.run_analytics()
        locations = px.export()
        # Tamper with a written artifact's claimed review count so it no
        # longer matches an independent DB query for that location_id --
        # simulates contamination or a miscounted export.
        path = px.private_data_dir / "analytics" / "locations" / f"{loc_a}.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["reviewCounts"]["lifetime"] = 999
        path.write_text(json.dumps(payload), encoding="utf-8")

        ok, issues, _ = px.validate(locations)
        assert not ok, "a claimed review count disagreeing with an independent DB recount must fail validation"
        assert any("independent database count" in issue for issue in issues)


# --- stability ------------------------------------------------------------------

def test_repeated_exports_produce_identical_location_artifacts():
    with ScratchPipeline() as px:
        loc_a, loc_b = _seed_two_locations_with_reviews(px)
        px.run_analytics()
        px.export()
        first = {loc_id: px.read_location_file(loc_id) for loc_id in (loc_a, loc_b)}

        px.run_analytics()  # recompute against the exact same, unchanged data
        px.export()
        second = {loc_id: px.read_location_file(loc_id) for loc_id in (loc_a, loc_b)}

        # computedAt legitimately differs between runs -- strip it before comparing.
        for d in (first, second):
            for payload in d.values():
                payload.pop("computedAt", None)
        assert first == second, "repeated exports against unchanged data must produce byte-identical (modulo timestamp) artifacts"


def main():
    run("company-wide files still generated alongside new per-location files", test_company_wide_files_still_generated_alongside_new_location_files)
    run("kpis.json gains starBreakdown additively, all existing fields preserved", test_kpis_gains_starBreakdown_additively_without_losing_existing_fields)
    run("every location produces exactly one analytics artifact", test_every_location_produces_exactly_one_analytics_artifact)
    run("artifact filenames are deterministic canonical ids, never slugs", test_artifact_filenames_are_deterministic_canonical_ids_not_slugs)
    run("every artifact contains the correct locationId", test_every_artifact_contains_the_correct_locationId)
    run("no duplicate location ids across artifacts", test_no_duplicate_location_ids_across_artifacts)
    run("review totals reconcile between company and locations", test_review_totals_reconcile_between_company_and_locations)
    run("star distribution reconciles between company and locations", test_star_distribution_reconciles_between_company_and_locations)
    run("average rating reconciles between company and locations", test_average_rating_reconciles_between_company_and_locations)
    run("company analytics == aggregation of all location analytics (independent comparison)", test_company_analytics_equals_aggregation_of_all_location_analytics)
    run("no cross-location contamination in review counts", test_no_cross_location_contamination_in_review_counts)
    run("location artifact never contains cross-location ranking/comparison keys", test_location_artifact_never_contains_cross_location_ranking_or_comparison_keys)
    run("an empty location still generates valid analytics", test_empty_location_still_generates_valid_analytics)
    run("a missing location analytics artifact fails validation", test_missing_location_analytics_fails_validation)
    run("an orphan location analytics artifact fails validation", test_orphan_location_analytics_fails_validation)
    run("a filename/content locationId mismatch fails validation", test_locationId_mismatch_between_filename_and_content_fails_validation)
    run("contamination/miscounting is caught via independent DB recount", test_contamination_detected_via_independent_db_recount)
    run("repeated exports produce identical location artifacts", test_repeated_exports_produce_identical_location_artifacts)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
