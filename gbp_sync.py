"""
gbp_sync.py -- scheduled incremental sync via the Google Business Profile
API: auto-discovers locations (new restaurant locations need zero manual
configuration), and upserts new/edited/deleted reviews for every location
through the exact same db.py functions auto_update.py (the Playwright
scraper, kept in the repo as a dormant fallback -- see README) already
uses. Also captures owner-reply text *and* timestamp, which the scraper
never could.

Usage:
    py gbp_sync.py            # full sync (all review pages per location)
    py gbp_sync.py --fast     # first page of reviews per location only --
                               # for the frequent critical-alert-check workflow
"""
import argparse
import os
import re
import sys
from datetime import datetime, timezone

import db
import google_api as ga

STAR_MAP = {"ONE": 1, "TWO": 2, "THREE": 3, "FOUR": 4, "FIVE": 5}


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
        "review_url": "",
    }


def _discover_and_link_locations(conn, accounts: list, our_locations: list, now: str) -> dict:
    """Auto-discovers every Google-side location and links it to (or creates)
    the matching internal row. Returns {gbp_location_name: {"id", "name"}}."""
    by_name = {_norm_name(l["name"]): l for l in our_locations}
    linked = {}

    for account in accounts:
        try:
            gbp_locations = ga.list_locations(account["name"])
        except ga.GBPError as e:
            print(f"gbp_sync.py: could not list locations for {account.get('name')}: {e}")
            continue

        for gloc in gbp_locations:
            existing_row = db.get_location_by_gbp_name(conn, gloc["name"])
            if existing_row:
                loc_id, loc_name = existing_row["id"], existing_row["name"]
            else:
                gname = _norm_name(gloc.get("locationName"))
                match = by_name.get(gname) or next(
                    (l for l in our_locations
                     if gname and (gname in _norm_name(l["name"]) or _norm_name(l["name"]) in gname)),
                    None,
                )
                if match:
                    loc_id, loc_name = match["id"], match["name"]
                else:
                    # Genuinely new to us -- create it. Brand/city are
                    # best-effort from the API; correctable later in Settings.
                    address = gloc.get("address", {}) or {}
                    loc_name = gloc.get("locationName") or gname
                    loc_id = db.get_or_create_location(conn, loc_name, city=address.get("locality", ""))
                    print(f"gbp_sync.py: discovered new location '{loc_name}' -- added automatically")

            verified = (gloc.get("locationState") or {}).get("isVerified")
            db.set_location_gbp_info(conn, loc_id, account["name"], gloc["name"],
                                      "VERIFIED" if verified else "UNVERIFIED", now)
            linked[gloc["name"]] = {"id": loc_id, "name": loc_name}

    return linked


def _record_early_failure(conn, now: str, reason: str) -> None:
    """A failure at account discovery (before any location is even known)
    previously left no scraper_runs row at all, so Data Health / Location
    Sync showed nothing rather than a visible failure. This gives every
    sync attempt a row, matching the per-location failure path below."""
    conn.execute(
        """INSERT INTO scraper_runs (started_at, finished_at, mode, status, error_summary)
           VALUES (?, ?, 'api_sync', 'failed', ?)""",
        (now, datetime.now(timezone.utc).isoformat(), reason[:2000]),
    )
    conn.commit()


def sync_all(fast: bool = False) -> dict:
    """Runs one full sync pass. Returns run stats (new/edited/deleted counts)
    in the same shape auto_update.py's run stats use, so the scheduled
    workflow and the frequent critical-check can treat either data source
    identically."""
    conn = db.get_connection()
    db.init_schema(conn)
    now = datetime.now(timezone.utc).isoformat()

    if not ga.is_configured():
        return {"status": "skipped", "reason": "Google credentials not configured"}

    try:
        accounts = ga.list_accounts()
    except ga.GBPError as e:
        _record_early_failure(conn, now, str(e))
        return {"status": "failed", "reason": str(e)}
    if not accounts:
        reason = "No Google Business Profile accounts found for this token"
        _record_early_failure(conn, now, reason)
        return {"status": "failed", "reason": reason}

    our_locations = [dict(r) for r in conn.execute("SELECT * FROM locations WHERE is_active = 1").fetchall()]
    linked = _discover_and_link_locations(conn, accounts, our_locations, now)
    conn.commit()

    run_id = conn.execute(
        """INSERT INTO scraper_runs (started_at, mode, status, locations_attempted)
           VALUES (?, 'api_sync', 'running', ?)""",
        (now, len(linked)),
    ).lastrowid
    conn.commit()

    total_new = total_edited = total_deleted = 0
    locations_succeeded = locations_failed = 0
    errors = []
    new_reviews_detail = []

    for gbp_location_name, loc in linked.items():
        loc_start = datetime.now(timezone.utc)
        try:
            max_pages = 1 if fast else None
            api_reviews = ga.list_reviews(gbp_location_name, max_pages=max_pages)
        except ga.GBPError as e:
            locations_failed += 1
            errors.append(f"{loc['name']}: {e}")
            conn.execute(
                """INSERT INTO scraper_run_locations (run_id, location_id, status, error_message)
                   VALUES (?, ?, 'failed', ?)""",
                (run_id, loc["id"], str(e)),
            )
            conn.commit()
            continue

        scraped_keys = set()
        window_min_date = None
        loc_new = loc_edited = 0

        for api_review in api_reviews:
            row = _review_to_row(api_review)
            key = db.dedup_key(loc["name"], row)
            scraped_keys.add(key)
            if row["review_date"] and (window_min_date is None or row["review_date"] < window_min_date):
                window_min_date = row["review_date"]
            result = db.upsert_review(conn, loc["id"], loc["name"], row, now)
            if result == "new":
                loc_new += 1
                new_reviews_detail.append({
                    "location": loc["name"], "reviewer_name": row["reviewer_name"],
                    "star_rating": row["star_rating"], "review_text": row["review_text"],
                })
            elif result == "edited":
                loc_edited += 1

        # Skipped on the fast/partial path -- a one-page fetch doesn't cover
        # enough of the review window for detect_deletions to judge absence
        # correctly (it would misread "not on this page" as "deleted").
        loc_deleted = (
            db.detect_deletions(conn, loc["id"], scraped_keys, window_min_date, now)
            if (window_min_date and not fast) else 0
        )

        conn.execute(
            """INSERT INTO scraper_run_locations
               (run_id, location_id, status, reviews_found, reviews_new, duration_ms)
               VALUES (?, ?, 'success', ?, ?, ?)""",
            (run_id, loc["id"], len(api_reviews), loc_new,
             int((datetime.now(timezone.utc) - loc_start).total_seconds() * 1000)),
        )
        conn.commit()

        locations_succeeded += 1
        total_new += loc_new
        total_edited += loc_edited
        total_deleted += loc_deleted

    status = "ok" if locations_failed == 0 else ("partial" if locations_succeeded > 0 else "failed")
    conn.execute(
        """UPDATE scraper_runs SET finished_at = ?, status = ?, locations_succeeded = ?,
           locations_failed = ?, new_reviews_count = ?, edited_reviews_count = ?,
           deleted_reviews_count = ?, error_summary = ? WHERE id = ?""",
        (datetime.now(timezone.utc).isoformat(), status, locations_succeeded, locations_failed,
         total_new, total_edited, total_deleted, "; ".join(errors)[:2000] or None, run_id),
    )
    conn.commit()

    return {
        "status": status, "run_id": run_id,
        "locations_succeeded": locations_succeeded, "locations_failed": locations_failed,
        "new": total_new, "edited": total_edited, "deleted": total_deleted, "errors": errors,
        "new_reviews": new_reviews_detail,
    }


def _build_email_html(new_reviews: list) -> str:
    """Simple summary HTML for the existing 'N new reviews' notification step
    in update-reviews.yml (dawidd6/action-send-mail) -- deliberately kept
    plain rather than replicating auto_update.py's full review-card design,
    since that email is out of scope for this integration (left as-is,
    just needs to keep receiving a new_count/email_html pair)."""
    if not new_reviews:
        return ""
    rows = "".join(
        f"<li><strong>{r['location']}</strong> — {r['star_rating'] or '?'}★ from "
        f"{r['reviewer_name']}: {(r['review_text'] or '')[:150]}</li>"
        for r in new_reviews[:20]
    )
    more = f"<p>+ {len(new_reviews) - 20} more</p>" if len(new_reviews) > 20 else ""
    return f"<ul>{rows}</ul>{more}"


def _write_github_output(new_count: int, email_html: str) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        print(f"\nResult: {new_count} new reviews found")
        return
    with open(output_path, "a", encoding="utf-8") as f:
        f.write(f"new_count={new_count}\n")
        delimiter = "EOF_EMAIL"
        f.write(f"email_html<<{delimiter}\n{email_html}\n{delimiter}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fast", action="store_true",
                         help="First page of reviews per location only (for frequent critical-alert checks)")
    args = parser.parse_args()
    result = sync_all(fast=args.fast)
    print(result)

    if not args.fast:
        # The fast/critical-check path doesn't touch this GH Actions output --
        # it's only meaningful for the main scheduled sync step.
        new_reviews = result.get("new_reviews", [])
        _write_github_output(len(new_reviews), _build_email_html(new_reviews))

    if result.get("status") == "failed":
        sys.exit(1)
