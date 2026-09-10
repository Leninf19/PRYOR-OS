"""
reconcile_gbp_replies.py -- one-time (and safely re-runnable) repair for
rows where link_review_to_gbp() (before its 2026-07-28 fix) recorded that
Google has reply metadata without ever capturing the actual reply text.

Root cause (see db.py's link_review_to_gbp() docstring): gbp_import.py's
historical backfill linked a scraper-only row to its real GBP identity and
carried gbp_reply_update_time (reply metadata) onto it, but discarded
owner_response (the reply text) -- every consumer of "is this replied"
reads owner_response, never gbp_reply_update_time, so this silently produced
reviews Google shows as replied that the dashboard, alerts, and digest all
still treated as unanswered. Confirmed in production: 77 rows, five of them
1-2 star and each re-alerted as unanswered by the nightly digest weeks after
Google's own reply timestamp -- some over a year old.

This script only ever touches rows matching MATCH_PREDICATE below. It never
touches reviews.text/star_rating/review_date, never touches locations, never
touches any other table, and never invents or infers reply text -- every
backfilled value comes from a live Google API response for that exact
review, fetched by its own gbp_review_name.

Usage:
    py reconcile_gbp_replies.py                    # report-only (dry run)
    py reconcile_gbp_replies.py --db path/to.db     # against a scratch copy
    py reconcile_gbp_replies.py --apply             # re-fetch + backfill for real
"""
import argparse
import hashlib
import sqlite3
from pathlib import Path

import google_api as ga
import tenant_keys
import tenant_paths

MATCH_PREDICATE = "gbp_reply_update_time IS NOT NULL AND TRIM(COALESCE(owner_response, '')) = ''"


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def find_matching_rows(conn: sqlite3.Connection) -> list:
    return conn.execute(
        f"""SELECT r.id, r.gbp_review_name, r.location_id, l.name AS location_name
            FROM reviews r JOIN locations l ON l.id = r.location_id
            WHERE {MATCH_PREDICATE}"""
    ).fetchall()


def preflight(conn: sqlite3.Connection, db_path: Path) -> dict:
    """Read-only. Never writes anything."""
    rows = find_matching_rows(conn)
    by_location: dict = {}
    for r in rows:
        by_location[r["location_name"]] = by_location.get(r["location_name"], 0) + 1

    return {
        "matching_rows": len(rows),
        "by_location": by_location,
        "total_reviews": conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"],
        "total_locations": conn.execute("SELECT COUNT(*) c FROM locations").fetchone()["c"],
        "integrity_check": conn.execute("PRAGMA integrity_check").fetchone()[0],
        "file_hash": file_hash(db_path),
        "file_size_bytes": db_path.stat().st_size,
    }


def print_preflight(report: dict) -> None:
    print("=== Preflight report (reconcile_gbp_replies.py) ===")
    print(f"Matching rows (gbp_reply_update_time set, owner_response empty): {report['matching_rows']}")
    print("Per-location breakdown:")
    for loc, count in sorted(report["by_location"].items(), key=lambda kv: -kv[1]):
        print(f"  {loc:<40} {count}")
    print(f"Total reviews:   {report['total_reviews']}")
    print(f"Total locations: {report['total_locations']}")
    print(f"PRAGMA integrity_check: {report['integrity_check']}")
    print(f"File hash (sha256): {report['file_hash']}")


def run_reconcile(conn: sqlite3.Connection, tenant_id: str, fetch_review=None) -> dict:
    """Re-fetches each matching row from Google by its exact gbp_review_name
    and backfills only when Google returns a genuine, non-empty reply
    comment. Each row is committed independently the moment its own update
    is known-good -- a fetch failure or an unresolved (still-no-reply) row
    never blocks or affects any other row, and is left completely
    untouched. Safe to re-run: a row backfilled on a prior run no longer
    matches MATCH_PREDICATE, so it's simply not selected again.

    Multi-Tenant Phase 4C revision: tenant_id is REQUIRED, with no default,
    and is validated unconditionally -- even when fetch_review is
    overridden and tenant_id ends up unused by that path -- because this
    function performs reconciliation (a SQLite write path) explicitly
    called out as requiring an explicit tenant, regardless of which
    Google-fetch implementation is plugged in.

    fetch_review defaults to google_api.get_review (the real Google API
    call, bound to tenant_id) -- overridable so callers (tests, scratch
    validation) can inject a deterministic stand-in without ever
    fabricating what a real API would have returned."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "reconcile_gbp_replies.run_reconcile")
    if fetch_review is None:
        fetch_review = lambda review_name: ga.get_review(tenant_id, review_name)  # noqa: E731
    rows = find_matching_rows(conn)

    before_reviews = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    before_locations = conn.execute("SELECT COUNT(*) c FROM locations").fetchone()["c"]

    backfilled, unresolved, failed = [], [], []

    for row in rows:
        review_id, gbp_review_name = row["id"], row["gbp_review_name"]
        try:
            api_review = fetch_review(gbp_review_name)
        except Exception as e:
            failed.append({"id": review_id, "gbp_review_name": gbp_review_name,
                            "error": f"{type(e).__name__}: {e}"})
            continue

        reply = api_review.get("reviewReply") or {}
        comment = (reply.get("comment") or "").strip()
        update_time = reply.get("updateTime")

        if not comment:
            # Google still returns no reply comment for this review -- the
            # anomaly is real, not a fetch problem. Leave the row exactly as
            # it is; report it so a human can look at the actual review.
            unresolved.append({"id": review_id, "gbp_review_name": gbp_review_name,
                                "reason": "Google returned no reply comment on re-fetch"})
            continue

        conn.execute(
            "UPDATE reviews SET owner_response = ?, gbp_reply_update_time = ? WHERE id = ?",
            (comment, update_time, review_id),
        )
        conn.commit()
        backfilled.append({"id": review_id, "gbp_review_name": gbp_review_name})

    after_reviews = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    after_locations = conn.execute("SELECT COUNT(*) c FROM locations").fetchone()["c"]
    if after_reviews != before_reviews:
        raise RuntimeError(f"review count changed ({before_reviews} -> {after_reviews}) -- this must never happen")
    if after_locations != before_locations:
        raise RuntimeError(f"location count changed ({before_locations} -> {after_locations}) -- this must never happen")

    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]

    return {
        "matched": len(rows),
        "backfilled": backfilled,
        "unresolved": unresolved,
        "failed": failed,
        "reviews_unchanged": after_reviews == before_reviews,
        "locations_unchanged": after_locations == before_locations,
        "integrity_after": integrity,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=None,
                         help="Path to the SQLite DB to operate on (default: the --tenant-id's own "
                              "registered review database -- see tenant_paths.py). Use this to point "
                              "at a SCRATCH COPY, never the real database, for a first dry-run.")
    parser.add_argument("--apply", action="store_true",
                         help="Actually re-fetch from Google and backfill (default: report-only, no writes)")
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose credential to use for the re-fetch. REQUIRED -- "
                              "no default. This script never infers a tenant on its own.")
    args = parser.parse_args()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::reconcile_gbp_replies.py: invalid --tenant-id {args.tenant_id!r}")
        return 1

    # Multi-Tenant Phase 4D: resolve THIS tenant's own review database
    # before any file/DB access -- --db still exists to point at a scratch
    # copy for a safe first dry-run, but its default is now the tenant's
    # own registered database, never a bare global.
    try:
        db_path = args.db or tenant_paths.resolve_review_db_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::reconcile_gbp_replies.py: {e}")
        return 1
    if not db_path.exists():
        print(f"::error::reconcile_gbp_replies.py: no database at {db_path}")
        return 1

    conn = _connect(db_path)
    report = preflight(conn, db_path)
    print_preflight(report)

    if report["integrity_check"] != "ok":
        print("\n::error::reconcile_gbp_replies.py: STOPPING -- integrity_check is not 'ok'.")
        conn.close()
        return 1

    if not args.apply:
        print("\nDRY RUN -- no changes written, no Google API calls made (pass --apply to reconcile).")
        conn.close()
        return 0

    result = run_reconcile(conn, tenant_id=args.tenant_id)
    print(f"\nmatched={result['matched']} backfilled={len(result['backfilled'])} "
          f"unresolved={len(result['unresolved'])} failed={len(result['failed'])}")
    print(f"reviews_unchanged={result['reviews_unchanged']} locations_unchanged={result['locations_unchanged']} "
          f"integrity={result['integrity_after']}")
    if result["unresolved"]:
        print("\nUnresolved (Google still shows no reply -- needs a human look):")
        for u in result["unresolved"]:
            print(f"  id={u['id']} gbp_review_name={u['gbp_review_name']}")
    if result["failed"]:
        print("\nFailed to fetch (left completely unchanged):")
        for f in result["failed"]:
            print(f"  id={f['id']} gbp_review_name={f['gbp_review_name']} error={f['error']}")

    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
