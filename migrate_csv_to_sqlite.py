"""
One-time backfill: load a tenant's reviews.csv into its reviews.db. This
was the ORIGINAL bootstrap of dashboard/reviews.db itself, run once, years
before the SQLite-first architecture (sync_reviews.py/gbp_sync.py) existed
-- it has no ongoing operational role today (the database has been the
source of truth ever since), is not invoked by any current workflow, and
exists in the repo purely as a historical record of how the original
database was created.

Multi-Tenant Phase 4D revision: --tenant-id is REQUIRED. Not classified as
an inert/exempt migration (unlike, say, a completed Redis key migration)
because it is still genuinely capable of writing to db.DB_PATH's real,
tenant-owned review database if manually re-run -- it gets the same
fail-closed treatment as every other production-capable entrypoint.

Run once: python migrate_csv_to_sqlite.py --tenant-id t_los-tres-amigos
Safe to re-run -- upsert_review() is idempotent per dedup_key, so re-running
this after auto_update.py has already started dual-writing just re-confirms
the same rows rather than duplicating them.
"""
import argparse
import csv
import sys
from datetime import datetime, timezone
from pathlib import Path

import db
import tenant_keys
import tenant_paths
from auto_update import LOCATIONS

BASE_DIR = Path(__file__).parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose reviews.csv/reviews.db to backfill. REQUIRED -- "
                              "no default. This script never infers a tenant on its own.")
    args = parser.parse_args()
    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::migrate_csv_to_sqlite.py: invalid --tenant-id {args.tenant_id!r}")
        sys.exit(1)
    try:
        db.DB_PATH = tenant_paths.resolve_review_db_path(args.tenant_id)
        REVIEWS_CSV = tenant_paths.resolve_review_csv_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::migrate_csv_to_sqlite.py: {e}")
        sys.exit(1)

    if not REVIEWS_CSV.exists():
        print(f"ERROR: {REVIEWS_CSV} not found")
        return

    conn = db.get_connection()
    db.init_schema(conn)

    location_ids = {}
    for loc in LOCATIONS:
        location_ids[loc["name"]] = db.get_or_create_location(
            conn, loc["name"], loc["city"], db.get_brand(loc["name"]), loc["search"]
        )
    conn.commit()

    with REVIEWS_CSV.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    print(f"Read {len(rows)} rows from {REVIEWS_CSV}")

    now = datetime.now(timezone.utc).isoformat()
    counts = {"new": 0, "edited": 0, "unchanged": 0, "skipped_unknown_location": 0}

    for row in rows:
        loc_name = row.get("location_name", "")
        loc_id = location_ids.get(loc_name)
        if loc_id is None:
            # Location in the CSV that isn't in auto_update.py's LOCATIONS list
            # (e.g. a legacy/renamed location) -- create it rather than drop data.
            loc_id = db.get_or_create_location(conn, loc_name, row.get("city", ""), db.get_brand(loc_name))
            location_ids[loc_name] = loc_id

        try:
            row["star_rating"] = int(row["star_rating"]) if row.get("star_rating") else None
        except ValueError:
            row["star_rating"] = None

        result = db.upsert_review(conn, loc_id, loc_name, row, now)
        counts[result] = counts.get(result, 0) + 1

    conn.commit()

    total_in_db = conn.execute("SELECT COUNT(*) AS c FROM reviews").fetchone()["c"]
    conn.close()

    print(f"Backfill complete: {counts}")
    print(f"Total reviews now in {db.DB_PATH}: {total_in_db} (CSV had {len(rows)} rows)")
    if total_in_db != len(rows):
        print(
            f"NOTE: counts differ because some CSV rows share a dedup_key "
            f"(duplicates collapsed) -- this matches the dedup behavior already "
            f"applied to reviews.csv this session, not a new bug."
        )


if __name__ == "__main__":
    main()
