"""
Regression tests for Phase 2 Milestone 4 (Canonical Location IDs in
Exported Data): every exported review record and location-level record
must carry a stable, numeric `locationId` equal to dashboard/reviews.db's
locations.id -- the same canonical, autoincrement primary key used
throughout db.py, never re-derived from name, slug, sort order, or array
position.

Runs entirely against a scratch SQLite file inside a
tempfile.TemporaryDirectory() and a scratch PRIVATE_DATA_DIR -- the real
dashboard/reviews.db and dashboard/private-data/ are never opened or
written to by this file.

Run directly: py tests/test_export_chunks.py
"""
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import export_chunks

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


def _add_review(conn, location_id, review_date, star_rating=5, reviewer_name="R", review_url=None, owner_response=None):
    key = f"{location_id}|{reviewer_name}|{review_date}|{star_rating}|{review_url or ''}"
    conn.execute(
        """INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date,
                                 star_rating, review_text, owner_response, review_url,
                                 last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (location_id, key, reviewer_name, review_date, star_rating, "text", owner_response, review_url, review_date),
    )
    conn.commit()


def _locations_dict(conn):
    return {row["id"]: dict(row) for row in conn.execute("SELECT * FROM locations").fetchall()}


class ScratchExport:
    """Context manager: scratch DB + scratch PRIVATE_DATA_DIR, with
    export_chunks.PRIVATE_DATA_DIR monkeypatched for the duration and always
    restored -- never touches the real dashboard/private-data/."""

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp_path = Path(self._tmp.name)
        self.conn = _new_conn(tmp_path / "scratch.db")
        self.private_data_dir = tmp_path / "private-data"
        self._original_private_data_dir = export_chunks.PRIVATE_DATA_DIR
        export_chunks.PRIVATE_DATA_DIR = self.private_data_dir
        return self

    def __exit__(self, *exc):
        export_chunks.PRIVATE_DATA_DIR = self._original_private_data_dir
        self.conn.close()
        self._tmp.cleanup()

    def read_json(self, rel_path):
        return json.loads((self.private_data_dir / rel_path).read_text(encoding="utf-8"))


# --- review_to_dict ---------------------------------------------------------

def test_review_to_dict_includes_locationId():
    with ScratchExport() as ex:
        loc_id = _add_location(ex.conn, "Test Location Alpha")
        _add_review(ex.conn, loc_id, "2026-01-01")
        row = ex.conn.execute("SELECT * FROM reviews WHERE location_id = ?", (loc_id,)).fetchone()
        loc = dict(ex.conn.execute("SELECT * FROM locations WHERE id = ?", (loc_id,)).fetchone())
        rec = export_chunks.review_to_dict(row, loc)
        assert rec["locationId"] == loc_id, f"expected locationId {loc_id}, got {rec['locationId']}"
        assert isinstance(rec["locationId"], int), "locationId must be numeric"


# --- export_meta -------------------------------------------------------------

def test_export_meta_locationId_matches_db_id_not_sort_position():
    with ScratchExport() as ex:
        # Inserted in an order that will NOT match export_meta's alphabetical
        # sort -- "Zeta" gets the lowest id but sorts last, "Alpha" gets a
        # higher id but sorts first. Proves locationId tracks the DB row,
        # not the position in the sorted output list.
        zeta_id = _add_location(ex.conn, "Zeta Location")
        alpha_id = _add_location(ex.conn, "Alpha Location")
        locations = _locations_dict(ex.conn)

        export_chunks.export_meta(ex.conn, locations)
        meta = ex.read_json("meta.json")

        by_name = {l["name"]: l for l in meta["locations"]}
        assert meta["locations"][0]["name"] == "Alpha Location", "sanity: alphabetical sort puts Alpha first"
        assert by_name["Alpha Location"]["locationId"] == alpha_id
        assert by_name["Zeta Location"]["locationId"] == zeta_id
        assert by_name["Alpha Location"]["locationId"] != 0, "locationId must be the real id, not a list index"


def test_export_meta_locationId_unaffected_by_name_change():
    with ScratchExport() as ex:
        loc_id = _add_location(ex.conn, "Original Name")
        locations = _locations_dict(ex.conn)
        export_chunks.export_meta(ex.conn, locations)
        first = ex.read_json("meta.json")["locations"][0]["locationId"]

        ex.conn.execute("UPDATE locations SET name = ? WHERE id = ?", ("Renamed Location", loc_id))
        ex.conn.commit()
        locations = _locations_dict(ex.conn)
        export_chunks.export_meta(ex.conn, locations)
        second = ex.read_json("meta.json")["locations"][0]["locationId"]

        assert first == second == loc_id, "locationId must not change when a location's name is edited"


def test_export_meta_locationId_stable_across_repeated_exports():
    with ScratchExport() as ex:
        loc_id = _add_location(ex.conn, "Repeatable Location")
        locations = _locations_dict(ex.conn)
        ids_seen = set()
        for _ in range(3):
            export_chunks.export_meta(ex.conn, locations)
            ids_seen.add(ex.read_json("meta.json")["locations"][0]["locationId"])
        assert ids_seen == {loc_id}, f"locationId must be identical across repeated exports, saw {ids_seen}"


# --- export_gbp_sync_status ---------------------------------------------------

def test_export_gbp_sync_status_includes_locationId():
    with ScratchExport() as ex:
        loc_id = _add_location(ex.conn, "GBP Location")
        locations = _locations_dict(ex.conn)
        export_chunks.export_gbp_sync_status(ex.conn, locations)
        payload = ex.read_json("gbp-sync.json")
        assert payload["locations"][0]["locationId"] == loc_id


# --- export_action_items (unanswered list + trend alerts) --------------------

def test_export_action_items_unanswered_reviews_include_locationId():
    with ScratchExport() as ex:
        loc_id = _add_location(ex.conn, "Unanswered Location")
        _add_review(ex.conn, loc_id, "2026-01-01", star_rating=1, owner_response=None)
        locations = _locations_dict(ex.conn)
        export_chunks.export_action_items(ex.conn, locations)
        payload = ex.read_json("action-items.json")
        assert len(payload["unanswered"]) == 1
        assert payload["unanswered"][0]["locationId"] == loc_id


def test_export_action_items_trend_alerts_include_locationId():
    with ScratchExport() as ex:
        loc_id = _add_location(ex.conn, "Trending Location")
        # 5 reviews in the last 30 days at 5 stars, 5 reviews 30-60 days ago
        # at 1 star -- a >=0.2 delta triggers a trend alert entry.
        for i in range(5):
            _add_review(ex.conn, loc_id, f"2026-07-{10+i:02d}", star_rating=5, reviewer_name=f"recent{i}")
        for i in range(5):
            _add_review(ex.conn, loc_id, f"2026-06-{1+i:02d}", star_rating=1, reviewer_name=f"older{i}")
        locations = _locations_dict(ex.conn)

        # export_action_items() computes "30/60 days ago" from datetime.now(),
        # so pin review dates relative to today instead of a fixed string --
        # rebuild using dynamic offsets to make this deterministic regardless
        # of when the suite runs.
        ex.conn.execute("DELETE FROM reviews")
        ex.conn.commit()
        from datetime import datetime, timedelta, timezone
        now = datetime.now(timezone.utc)
        for i in range(5):
            d = (now - timedelta(days=5 + i)).date().isoformat()
            _add_review(ex.conn, loc_id, d, star_rating=5, reviewer_name=f"recent{i}")
        for i in range(5):
            d = (now - timedelta(days=45 + i)).date().isoformat()
            _add_review(ex.conn, loc_id, d, star_rating=1, reviewer_name=f"older{i}")

        export_chunks.export_action_items(ex.conn, locations)
        payload = ex.read_json("action-items.json")
        assert len(payload["trendAlerts"]) == 1, f"expected one trend alert, got {payload['trendAlerts']}"
        assert payload["trendAlerts"][0]["locationId"] == loc_id


# --- export_validation ---------------------------------------------------------

def test_export_validation_includes_locationId_and_preserves_null():
    with ScratchExport() as ex:
        loc_id = _add_location(ex.conn, "Validation Location")
        ex.conn.execute(
            "INSERT INTO validation_flags (location_id, flag_type, detail) VALUES (?, ?, ?)",
            (loc_id, "some_flag", "detail"),
        )
        # A company-wide flag with no specific location -- location_id is
        # nullable in the schema (validation_flags.location_id has no NOT
        # NULL constraint) for exactly this case.
        ex.conn.execute(
            "INSERT INTO validation_flags (location_id, flag_type, detail) VALUES (NULL, ?, ?)",
            ("company_wide_flag", "detail"),
        )
        ex.conn.commit()

        export_chunks.export_validation(ex.conn)
        payload = ex.read_json("validation.json")
        by_type = {r["flag_type"]: r for r in payload}
        assert by_type["some_flag"]["locationId"] == loc_id
        assert by_type["some_flag"]["location_id"] == loc_id, "existing snake_case field must remain (additive change)"
        assert by_type["company_wide_flag"]["locationId"] is None, "a company-wide flag must keep locationId as null, not a guessed id"


# --- export_scraper_status ------------------------------------------------------

def test_export_scraper_status_includes_locationId():
    with ScratchExport() as ex:
        loc_id = _add_location(ex.conn, "Scraper Location")
        cur = ex.conn.execute(
            "INSERT INTO scraper_runs (started_at, mode) VALUES (?, ?)",
            ("2026-01-01T00:00:00Z", "scrape"),
        )
        run_id = cur.lastrowid
        ex.conn.execute(
            "INSERT INTO scraper_run_locations (run_id, location_id, status) VALUES (?, ?, ?)",
            (run_id, loc_id, "success"),
        )
        ex.conn.commit()

        export_chunks.export_scraper_status(ex.conn)
        payload = ex.read_json("scraper-status.json")
        assert payload[0]["locations"][0]["locationId"] == loc_id
        assert payload[0]["locations"][0]["location_id"] == loc_id, "existing snake_case field must remain (additive change)"


# --- export_intelligence (per-location AI intelligence files) ------------------

def test_export_intelligence_injects_locationId_into_location_detail():
    with ScratchExport() as ex:
        loc_id = _add_location(ex.conn, "Intel Location")
        slug = export_chunks.slugify("Intel Location")
        ex.conn.execute(
            "INSERT INTO analytics_cache (cache_key, payload) VALUES (?, ?)",
            (f"location_detail_{slug}", json.dumps({"name": "Intel Location", "healthScore": 90})),
        )
        ex.conn.commit()
        locations = _locations_dict(ex.conn)

        export_chunks.export_intelligence(ex.conn, locations)
        payload = ex.read_json(f"intelligence/locations/{slug}.json")
        assert payload["locationId"] == loc_id
        assert payload["healthScore"] == 90, "original payload fields must be preserved, not replaced"


def test_export_intelligence_does_not_clobber_existing_locationId():
    with ScratchExport() as ex:
        _add_location(ex.conn, "Preexisting Location")
        slug = export_chunks.slugify("Preexisting Location")
        ex.conn.execute(
            "INSERT INTO analytics_cache (cache_key, payload) VALUES (?, ?)",
            (f"location_detail_{slug}", json.dumps({"locationId": 999999, "name": "Preexisting Location"})),
        )
        ex.conn.commit()
        locations = _locations_dict(ex.conn)

        export_chunks.export_intelligence(ex.conn, locations)
        payload = ex.read_json(f"intelligence/locations/{slug}.json")
        assert payload["locationId"] == 999999, "an already-present locationId in the cached payload must not be overwritten"


def test_export_intelligence_handles_stale_slug_without_crashing():
    with ScratchExport() as ex:
        # A cache entry left over from a since-renamed/removed location --
        # no location in the current table matches this slug.
        ex.conn.execute(
            "INSERT INTO analytics_cache (cache_key, payload) VALUES (?, ?)",
            ("location_detail_ghost-location", json.dumps({"name": "Ghost Location"})),
        )
        ex.conn.commit()
        locations = _locations_dict(ex.conn)  # empty -- no real locations

        export_chunks.export_intelligence(ex.conn, locations)  # must not raise
        payload = ex.read_json("intelligence/locations/ghost-location.json")
        assert "locationId" not in payload, "a slug with no matching location must not get a guessed locationId"
        assert payload["name"] == "Ghost Location", "the original payload must still be written through unchanged"


# --- export_location_detail_reviews (the live per-location review export) ------

def test_export_location_detail_reviews_includes_locationId():
    with ScratchExport() as ex:
        loc_id = _add_location(ex.conn, "Detail Review Location")
        _add_review(ex.conn, loc_id, "2026-01-01")
        locations = _locations_dict(ex.conn)

        export_chunks.export_location_detail_reviews(ex.conn, locations)
        slug = export_chunks.slugify("Detail Review Location")
        payload = ex.read_json(f"reviews/by-location/{slug}.json")
        assert len(payload) == 1
        assert payload[0]["locationId"] == loc_id


def main():
    run("review_to_dict() includes a numeric locationId matching locations.id", test_review_to_dict_includes_locationId)
    run("export_meta(): locationId matches the DB id, not the sorted list position", test_export_meta_locationId_matches_db_id_not_sort_position)
    run("export_meta(): locationId is unaffected by a location name change", test_export_meta_locationId_unaffected_by_name_change)
    run("export_meta(): locationId is stable across repeated exports", test_export_meta_locationId_stable_across_repeated_exports)
    run("export_gbp_sync_status(): includes locationId", test_export_gbp_sync_status_includes_locationId)
    run("export_action_items(): unanswered reviews include locationId", test_export_action_items_unanswered_reviews_include_locationId)
    run("export_action_items(): trend alerts include locationId", test_export_action_items_trend_alerts_include_locationId)
    run("export_validation(): includes locationId, preserves null for company-wide flags", test_export_validation_includes_locationId_and_preserves_null)
    run("export_scraper_status(): includes locationId", test_export_scraper_status_includes_locationId)
    run("export_intelligence(): injects locationId into location_detail_* payloads", test_export_intelligence_injects_locationId_into_location_detail)
    run("export_intelligence(): does not clobber an already-present locationId", test_export_intelligence_does_not_clobber_existing_locationId)
    run("export_intelligence(): a stale slug with no matching location does not crash or get a guessed id", test_export_intelligence_handles_stale_slug_without_crashing)
    run("export_location_detail_reviews(): includes locationId (the live per-location review export)", test_export_location_detail_reviews_includes_locationId)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
