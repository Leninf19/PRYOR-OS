"""
gbp_import.py -- ONE-TIME historical backfill: pages through every review for
every location via the Google Business Profile API and reconciles it against
the existing scraped rows in reviews.db, so every review gets a
gbp_review_name (see db.py's dedup_key()/upsert_review()) without creating
duplicate rows for reviews the scraper already captured.

This is explicitly the highest-risk script in the Google integration -- run
it against a SCRATCH COPY of reviews.db first (override db.DB_PATH, the
pattern used throughout this project) and inspect gbp_import_report.json
before ever running --apply against the real database.

Usage:
    py gbp_import.py             # dry-run: writes a reconciliation report, no DB writes
    py gbp_import.py --apply     # actually commits matched/inserted rows
"""
import argparse
import json
import re
import sys
from datetime import datetime, timezone

import db
import google_api as ga

STAR_MAP = {"ONE": 1, "TWO": 2, "THREE": 3, "FOUR": 4, "FIVE": 5}
REPORT_PATH = db.BASE_DIR / "gbp_import_report.json"


def _norm_name(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _review_to_row(api_review: dict) -> dict:
    reviewer = api_review.get("reviewer", {}) or {}
    reply = api_review.get("reviewReply") or {}
    create_time = api_review.get("createTime", "") or ""
    return {
        "gbp_review_name": api_review.get("name"),
        "reviewer_name": reviewer.get("displayName") or "A Google User",
        "review_date": create_time[:10],
        "star_rating": STAR_MAP.get(api_review.get("starRating")),
        "review_text": api_review.get("comment") or "",
        "owner_response": reply.get("comment") or "",
        "gbp_update_time": api_review.get("updateTime"),
        "gbp_reply_update_time": reply.get("updateTime"),
        "gbp_language_code": api_review.get("languageCode"),
        "review_url": "",  # API-sourced rows have no Maps URL
    }


def _find_scraped_match(candidates: list, row: dict, consumed_ids: set):
    """Best-effort match against an existing (not yet gbp-linked) scraped
    row: same star rating (pre-filtered by caller), review_date within +/-1
    day (Maps' relative-date parsing vs. the API's exact createTime can
    disagree by a day), and a fuzzy reviewer-name match. Each scraped row can
    only be consumed by one API review, tracked via consumed_ids."""
    if not row["review_date"]:
        return None
    target_date = datetime.fromisoformat(row["review_date"])
    target_name = _norm_name(row["reviewer_name"])
    for c in candidates:
        if c["id"] in consumed_ids or not c["review_date"]:
            continue
        try:
            c_date = datetime.fromisoformat(c["review_date"])
        except ValueError:
            continue
        if abs((c_date - target_date).days) > 1:
            continue
        if _norm_name(c["reviewer_name"]) != target_name:
            continue
        return c
    return None


def run(apply: bool = False):
    conn = db.get_connection()
    db.init_schema(conn)

    if not ga.is_configured():
        print("gbp_import.py: Google credentials not configured (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN) -- aborting.")
        sys.exit(1)

    locations = conn.execute("SELECT * FROM locations WHERE is_active = 1").fetchall()
    try:
        accounts = ga.list_accounts()
    except ga.GBPError as e:
        print(f"gbp_import.py: could not list Google accounts -- {e}")
        sys.exit(1)
    if not accounts:
        print("gbp_import.py: no Google Business Profile accounts found for this token -- aborting.")
        sys.exit(1)

    now = datetime.now(timezone.utc).isoformat()
    report = {"generated_at": now, "dry_run": not apply, "locations": []}

    # Fetch every account's full location list ONCE up front rather than
    # per-internal-location (this loop runs once per account/location pair
    # total, not once per one of our 21 locations x every account).
    all_api_locations = []  # list of (account, gbp_location)
    for account in accounts:
        try:
            for gloc in ga.list_locations(account["name"]):
                all_api_locations.append((account, gloc))
        except ga.GBPError as e:
            print(f"gbp_import.py: could not list locations for account {account.get('name')}: {e}")

    for loc in locations:
        loc_report = {"location": loc["name"], "api_location_name": None,
                       "matched": 0, "new_from_api": 0, "unmatched_examples": []}

        api_location = None
        api_account = None
        lname = _norm_name(loc["name"])
        for account, gloc in all_api_locations:
            gname = _norm_name(gloc.get("locationName"))
            if gname == lname or lname in gname or gname in lname:
                api_location, api_account = gloc, account
                break

        if not api_location:
            loc_report.setdefault("error", "No matching Google location found by name")
            report["locations"].append(loc_report)
            continue

        loc_report["api_location_name"] = api_location["name"]

        if apply:
            verified = (api_location.get("locationState") or {}).get("isVerified")
            db.set_location_gbp_info(
                conn, loc["id"], api_account["name"], api_location["name"],
                "VERIFIED" if verified else "UNVERIFIED", now,
            )

        try:
            api_reviews = ga.list_reviews(api_location["name"])
        except ga.GBPError as e:
            loc_report["error"] = f"Could not list reviews: {e}"
            report["locations"].append(loc_report)
            continue

        # Pre-fetch unlinked scraped rows for this location once, grouped by
        # star rating, so each API review only scans its own rating bucket.
        unlinked_by_rating = {}
        for r in conn.execute(
            "SELECT * FROM reviews WHERE location_id = ? AND gbp_review_name IS NULL AND is_deleted = 0",
            (loc["id"],),
        ).fetchall():
            unlinked_by_rating.setdefault(r["star_rating"], []).append(r)
        consumed_ids = set()

        for api_review in api_reviews:
            row = _review_to_row(api_review)

            already_linked = conn.execute(
                "SELECT id FROM reviews WHERE gbp_review_name = ?", (row["gbp_review_name"],)
            ).fetchone()
            if already_linked:
                loc_report["matched"] += 1
                continue

            candidates = unlinked_by_rating.get(row["star_rating"], [])
            scraped_match = _find_scraped_match(candidates, row, consumed_ids)

            if scraped_match:
                loc_report["matched"] += 1
                consumed_ids.add(scraped_match["id"])
                if apply:
                    # Link by the matched row's own id -- NOT upsert_review(),
                    # which would look the row up by gbp_review_name (absent
                    # on it until this call) and insert a duplicate instead.
                    db.link_review_to_gbp(
                        conn, scraped_match["id"], row["gbp_review_name"],
                        row["gbp_update_time"], row["gbp_reply_update_time"], row["gbp_language_code"],
                    )
            else:
                loc_report["new_from_api"] += 1
                if len(loc_report["unmatched_examples"]) < 5:
                    loc_report["unmatched_examples"].append({
                        "reviewer": row["reviewer_name"], "date": row["review_date"],
                        "stars": row["star_rating"], "text": row["review_text"][:100],
                    })
                if apply:
                    db.upsert_review(conn, loc["id"], loc["name"], row, now)

        report["locations"].append(loc_report)

    if apply:
        conn.commit()
        print("gbp_import.py: changes committed.")
    else:
        conn.rollback()
        print("gbp_import.py: DRY RUN -- no changes written (pass --apply to commit).")

    REPORT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    total_matched = sum(l.get("matched", 0) for l in report["locations"])
    total_new = sum(l.get("new_from_api", 0) for l in report["locations"])
    errors = [l for l in report["locations"] if l.get("error")]
    print(f"Report written to {REPORT_PATH}")
    print(f"Summary: {total_matched} reconciled to existing scraped reviews, "
          f"{total_new} new reviews found only via the API, {len(errors)} location(s) with errors.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Actually write changes (default: dry-run report only)")
    args = parser.parse_args()
    run(apply=args.apply)
