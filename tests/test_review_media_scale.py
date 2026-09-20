"""
Large-tenant scale test for the review-media no-backfill gate --
Pre-Integration Audit (Phase 5). Proves, with a real 25,000+ row temporary
SQLite fixture (never the real dashboard/reviews.db), that re-syncing a
large tenant's full historical review set under every non-active
configuration state leaves every single gbp_review_media value exactly
NULL -- no "[]" markers are ever written merely to record ineligibility,
no media-generated review_revisions rows are created, and database growth
stays bounded to ordinary SQLite/journal overhead rather than growing
proportionally to 25,000 written '[]' markers.

Run directly: py tests/test_review_media_scale.py
(Takes on the order of several seconds -- 25,000+ real upsert_review() calls.)
"""
import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db

N_HISTORICAL = 25_000

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="test_review_media_scale_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    conn = db.get_connection()
    db.init_schema(conn)
    loc_id = conn.execute(
        "INSERT INTO locations (name, city, brand) VALUES ('Big Tenant Location', 'Bigtown', 'Casa Tequila')"
    ).lastrowid
    conn.commit()
    return conn, loc_id


def _seed_historical_rows(conn, loc_id, n):
    """Directly inserts `n` rows exactly as they would look coming out of a
    pre-existing tenant's database from before this feature's column ever
    existed -- gbp_review_media is never mentioned in this INSERT at all,
    so SQLite's own column default (NULL, since the ALTER TABLE ADD COLUMN
    migration never specifies one) applies, identically to a real
    historical row."""
    now = "2025-01-01T00:00:00Z"
    rows = [
        (loc_id, f"hist-key-{i}", f"Reviewer {i}", "2025-01-01", 5, "Some historical review text", "", "",
         now, now, f"accounts/1/locations/2/reviews/hist-{i}", "2025-01-01T00:00:00Z")
        for i in range(n)
    ]
    conn.executemany(
        """INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date, star_rating,
           review_text, owner_response, review_url, first_seen_at, last_seen_at, gbp_review_name, gbp_update_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        rows,
    )
    conn.commit()


def _resync_all_historical(conn, loc_id, n, media_capture_started_at):
    """Simulates a full subsequent sync re-fetching all `n` historical
    reviews from Google and calling upsert_review() again for each one --
    exactly the code path a real ~6-hourly full sync exercises for every
    review, every run (see the Scale & No-Backfill Audit's own Audit 1/6
    findings). Each review's own gbp_create_time is fixed at
    2025-01-01 -- always BEFORE any activation timestamp used in this file
    (2026-...), so every case here represents a genuinely historical,
    pre-activation review."""
    now = "2026-09-25T00:00:00Z"
    for i in range(n):
        row = {
            "reviewer_name": f"Reviewer {i}", "review_date": "2025-01-01", "star_rating": 5,
            "review_text": "Some historical review text", "owner_response": "", "review_url": "",
            "gbp_review_name": f"accounts/1/locations/2/reviews/hist-{i}",
            "gbp_update_time": "2025-01-01T00:00:00Z",
            "gbp_create_time": "2025-01-01T00:00:00Z",
            "media": None,
        }
        db.upsert_review(conn, loc_id, "Big Tenant Location", row, now, media_capture_started_at=media_capture_started_at)
    conn.commit()


def _non_null_media_count(conn) -> int:
    return conn.execute("SELECT COUNT(*) c FROM reviews WHERE gbp_review_media IS NOT NULL").fetchone()["c"]


def _revision_count(conn) -> int:
    return conn.execute("SELECT COUNT(*) c FROM review_revisions").fetchone()["c"]


def _db_file_size() -> int:
    return os.path.getsize(db.DB_PATH)


def _run_case(label: str, media_capture_started_at):
    conn, loc_id = _fresh_db()
    _seed_historical_rows(conn, loc_id, N_HISTORICAL)

    before_size = _db_file_size()
    before_non_null = _non_null_media_count(conn)
    before_revisions = _revision_count(conn)
    assert before_non_null == 0, f"[{label}] seed itself must start with zero non-NULL media rows"

    t0 = time.time()
    _resync_all_historical(conn, loc_id, N_HISTORICAL, media_capture_started_at)
    elapsed = time.time() - t0

    after_size = _db_file_size()
    after_non_null = _non_null_media_count(conn)
    after_revisions = _revision_count(conn)

    print(f"    [{label}] {N_HISTORICAL} rows resynced in {elapsed:.2f}s -- "
          f"db size {before_size:,} -> {after_size:,} bytes (diff {after_size - before_size:,}), "
          f"non-NULL media rows {before_non_null} -> {after_non_null}, "
          f"review_revisions {before_revisions} -> {after_revisions}")

    assert after_non_null == 0, f"[{label}] expected 0 non-NULL gbp_review_media rows, found {after_non_null}"
    assert after_revisions == before_revisions == 0, (
        f"[{label}] expected zero review_revisions from a purely historical re-sync, "
        f"found {after_revisions} (started at {before_revisions})"
    )
    # Growth bound: 25,000 written '[]' markers (2 bytes each, plus row
    # overhead) would be many hundreds of KB to low-MB of genuinely NEW
    # payload bytes on top of ordinary journal/page overhead. A correct
    # PRESERVE implementation's growth here is bounded by ordinary SQLite
    # transaction/journal/index-page overhead only -- generously capped at
    # 3 MB, comfortably above realistic journal overhead for this many
    # updates and comfortably below what actually storing '[]' 25,000
    # times over would look like on top of that same overhead.
    growth = after_size - before_size
    assert growth < 3 * 1024 * 1024, (
        f"[{label}] database grew by {growth:,} bytes re-syncing {N_HISTORICAL} historical rows -- "
        f"this is consistent with '[]' being written 25,000 times, not with PRESERVE mode"
    )
    return before_size, after_size, before_non_null, after_non_null


def test_case_a_tenant_inactive():
    _run_case("A: tenant inactive", media_capture_started_at=None)


def test_case_b_missing_activation():
    _run_case("B: missing activation (config record has no mediaCapture)", media_capture_started_at=None)


def test_case_c_config_lookup_failure():
    # At the db.py layer this is represented identically to A/B -- None --
    # since provider_sync.py's own try/except around the ONE Redis lookup
    # collapses every non-active reason (inactive, missing, invalid,
    # unreachable) to the same safe None before ever calling
    # upsert_review(). See test_review_media_feature.py's
    # test_28_config_lookup_failure_fails_closed_in_sync_orchestration for
    # that orchestration-layer proof; this file proves the DOWNSTREAM
    # consequence at real scale.
    _run_case("C: config/Redis lookup failure (represented as None)", media_capture_started_at=None)


def test_case_d_valid_activation_all_reviews_pre_activation():
    _run_case("D: valid activation, every review created before it", media_capture_started_at="2026-01-01T00:00:00Z")


def test_mixed_large_historical_set_plus_a_few_eligible_new_reviews():
    conn, loc_id = _fresh_db()
    _seed_historical_rows(conn, loc_id, N_HISTORICAL)
    before_size = _db_file_size()

    activation = "2026-01-01T00:00:00Z"
    _resync_all_historical(conn, loc_id, N_HISTORICAL, media_capture_started_at=activation)
    assert _non_null_media_count(conn) == 0, "historical rows must still be all-NULL before the eligible rows are added"

    now = "2026-09-25T00:00:00Z"
    for i in range(10):
        row = {
            "reviewer_name": f"New Eligible Reviewer {i}", "review_date": "2026-02-01", "star_rating": 5,
            "review_text": "New review", "owner_response": "", "review_url": "",
            "gbp_review_name": f"accounts/1/locations/2/reviews/new-with-media-{i}",
            "gbp_update_time": "2026-02-01T00:00:00Z", "gbp_create_time": "2026-02-01T00:00:00Z",
            "media": [{"thumbnailUrl": f"https://lh3.googleusercontent.com/new{i}"}],
        }
        db.upsert_review(conn, loc_id, "Big Tenant Location", row, now, media_capture_started_at=activation)
    for i in range(5):
        row = {
            "reviewer_name": f"New Eligible No-Media Reviewer {i}", "review_date": "2026-02-01", "star_rating": 4,
            "review_text": "New review, no photos", "owner_response": "", "review_url": "",
            "gbp_review_name": f"accounts/1/locations/2/reviews/new-no-media-{i}",
            "gbp_update_time": "2026-02-01T00:00:00Z", "gbp_create_time": "2026-02-01T00:00:00Z",
            "media": [],
        }
        db.upsert_review(conn, loc_id, "Big Tenant Location", row, now, media_capture_started_at=activation)
    conn.commit()

    after_size = _db_file_size()
    non_null = _non_null_media_count(conn)
    print(f"    [mixed] {N_HISTORICAL} historical + 15 new eligible: db size {before_size:,} -> {after_size:,} bytes, "
          f"non-NULL media rows = {non_null} (expected 15)")

    assert non_null == 15, f"expected exactly 15 non-NULL media rows (10 with media + 5 with '[]'), found {non_null}"

    with_media = conn.execute(
        "SELECT COUNT(*) c FROM reviews WHERE gbp_review_name LIKE 'accounts/1/locations/2/reviews/new-with-media-%' "
        "AND gbp_review_media IS NOT NULL AND gbp_review_media != '[]'"
    ).fetchone()["c"]
    assert with_media == 10, f"expected 10 rows with a real (non-empty) media array, found {with_media}"

    empty_but_evaluated = conn.execute(
        "SELECT COUNT(*) c FROM reviews WHERE gbp_review_name LIKE 'accounts/1/locations/2/reviews/new-no-media-%' "
        "AND gbp_review_media = '[]'"
    ).fetchone()["c"]
    assert empty_but_evaluated == 5, f"expected 5 rows explicitly stored as '[]' (eligible, no media), found {empty_but_evaluated}"

    still_null_historical = conn.execute(
        "SELECT COUNT(*) c FROM reviews WHERE gbp_review_name LIKE 'accounts/1/locations/2/reviews/hist-%' "
        "AND gbp_review_media IS NULL"
    ).fetchone()["c"]
    assert still_null_historical == N_HISTORICAL, (
        f"expected all {N_HISTORICAL} historical rows to remain NULL, found {still_null_historical} still NULL"
    )


def main() -> int:
    tests = [
        ("Case A: tenant inactive -- 25,000 historical rows stay NULL, zero growth from media", test_case_a_tenant_inactive),
        ("Case B: missing activation config -- 25,000 historical rows stay NULL", test_case_b_missing_activation),
        ("Case C: config/Redis lookup failure -- 25,000 historical rows stay NULL", test_case_c_config_lookup_failure),
        ("Case D: valid activation, all reviews pre-activation -- 25,000 rows stay NULL", test_case_d_valid_activation_all_reviews_pre_activation),
        ("Mixed: 25,000 historical (NULL) + 15 new eligible (10 array + 5 '[]') -> exactly 15 non-NULL", test_mixed_large_historical_set_plus_a_few_eligible_new_reviews),
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
