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
import digest_filters
from provider_base import ProviderError
from provider_gbp import GBPProvider


def _norm_name(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _link_locations(conn, provider_locations: list, our_locations: list, now: str) -> dict:
    """Matches every Google-discovered location (already fetched via
    GBPProvider.discover_locations()) to -- or creates -- the corresponding
    internal row. Returns {external_id: {"id", "name", "location"}}, keeping
    the original ProviderLocation alongside so the per-location review-fetch
    loop below doesn't need to reconstruct one.

    This is the exact matching/linking logic gbp_sync.py always had
    (_discover_and_link_locations, before Phase 3 Milestone 1) -- only the
    external API calls that used to happen inline here now happen inside
    GBPProvider.discover_locations() instead."""
    by_name = {_norm_name(l["name"]): l for l in our_locations}
    linked = {}

    for ploc in provider_locations:
        existing_row = db.get_location_by_gbp_name(conn, ploc.external_id)
        if existing_row:
            loc_id, loc_name = existing_row["id"], existing_row["name"]
        else:
            gname = _norm_name(ploc.name)
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
                loc_name = ploc.name or gname
                loc_id = db.get_or_create_location(conn, loc_name, city=ploc.city)
                print(f"gbp_sync.py: discovered new location '{loc_name}' -- added automatically")

        account_name = ploc.provider_metadata.get("account_name")
        db.set_location_gbp_info(conn, loc_id, account_name, ploc.external_id,
                                  ploc.verification_status, now)
        linked[ploc.external_id] = {"id": loc_id, "name": loc_name, "location": ploc}

    return linked


def _record_early_failure(conn, now: str, reason: str) -> None:
    """A failure at account discovery (before any location is even known)
    previously left no scraper_runs row at all, so Data Health / Location
    Sync showed nothing rather than a visible failure. This gives every
    sync attempt a row, matching the per-location failure path below.
    failure_stage='account_discovery' is the explicit marker notify.py uses
    to pick the global-failure template instead of the per-location one --
    it is NEVER inferred from zeroed location counters, only set here."""
    conn.execute(
        """INSERT INTO scraper_runs (started_at, finished_at, mode, status, error_summary, failure_stage, provider)
           VALUES (?, ?, 'api_sync', 'failed', ?, 'account_discovery', 'gbp')""",
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

    provider = GBPProvider()
    if not provider.is_configured():
        return {"status": "skipped", "reason": "Google credentials not configured"}

    try:
        provider_locations = provider.discover_locations()
    except ProviderError as e:
        _record_early_failure(conn, now, str(e))
        return {"status": "failed", "reason": str(e)}

    our_locations = [dict(r) for r in conn.execute("SELECT * FROM locations WHERE is_active = 1").fetchall()]
    linked = _link_locations(conn, provider_locations, our_locations, now)
    conn.commit()

    run_id = conn.execute(
        """INSERT INTO scraper_runs (started_at, mode, status, locations_attempted, provider)
           VALUES (?, 'api_sync', 'running', ?, 'gbp')""",
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
            provider_reviews = provider.fetch_reviews(loc["location"], fast=fast)
        except ProviderError as e:
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

        for preview in provider_reviews:
            row = preview.as_row()
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
            (run_id, loc["id"], len(provider_reviews), loc_new,
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


def _build_email_html(negative_reviews: list) -> str:
    """Simple summary HTML for the negative-review notification step in
    update-reviews.yml (dawidd6/action-send-mail). Callers are expected to
    pass an already-filtered (1-2 star only) list -- via
    digest_filters.get_new_negative_reviews() -- but this still re-checks
    every row itself before rendering, so a mistakenly-unfiltered array can
    never leak a 3-5 star review into the email (Requirement #3)."""
    negative_reviews = [r for r in negative_reviews if digest_filters.is_negative_review_for_notification(r)]
    if not negative_reviews:
        return ""
    rows = "".join(
        f"<li><strong>{r['location']}</strong> — {digest_filters.normalize_rating(r)}★ from "
        f"{r['reviewer_name']}: "
        f"{(r['review_text'] or '').strip()[:150] or 'Rating only — no written review.'}</li>"
        for r in negative_reviews[:20]
    )
    more = f"<p>+ {len(negative_reviews) - 20} more</p>" if len(negative_reviews) > 20 else ""
    return f"<ul>{rows}</ul>{more}"


def _write_github_output(new_count: int, negative_count: int, email_html: str) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        print(f"\nResult: {new_count} new reviews found ({negative_count} new 1-2 star)")
        return
    with open(output_path, "a", encoding="utf-8") as f:
        f.write(f"new_count={new_count}\n")
        f.write(f"negative_count={negative_count}\n")
        delimiter = "EOF_EMAIL"
        f.write(f"email_html<<{delimiter}\n{email_html}\n{delimiter}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fast", action="store_true",
                         help="First page of reviews per location only (for frequent critical-alert checks)")
    args = parser.parse_args()
    result = sync_all(fast=args.fast)
    print(result)

    print(f"gbp_sync.py: locations succeeded={result.get('locations_succeeded', 0)}, "
          f"failed={result.get('locations_failed', 0)}")
    if result.get("status") == "failed":
        stage = "before location discovery" if not result.get("locations_succeeded") and not result.get("locations_failed") else "during location scraping"
        print(f"gbp_sync.py: failure occurred {stage}")

    if not args.fast:
        # The fast/critical-check path doesn't touch this GH Actions output --
        # it's only meaningful for the main scheduled sync step.
        new_reviews = result.get("new_reviews", [])
        new_negative = digest_filters.get_new_negative_reviews(new_reviews)
        excluded = len(new_reviews) - len(new_negative)
        print(f"gbp_sync.py: {len(new_reviews)} genuinely new review(s), "
              f"{len(new_negative)} new 1-2 star, {excluded} excluded (3-5 star)")
        print(f"gbp_sync.py: negative-review email {'will be sent' if new_negative else 'skipped (no new 1-2 star reviews)'}")
        _write_github_output(len(new_reviews), len(new_negative), _build_email_html(new_negative))

    if result.get("status") == "failed":
        sys.exit(1)
