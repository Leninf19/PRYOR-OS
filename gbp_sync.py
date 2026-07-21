"""
gbp_sync.py -- scheduled incremental sync via the Google Business Profile
API: auto-discovers locations (new restaurant locations need zero manual
configuration), and upserts new/edited/deleted reviews for every location
through the exact same db.py functions auto_update.py (the Playwright
scraper, kept in the repo as a dormant fallback -- see README) already
uses. Also captures owner-reply text *and* timestamp, which the scraper
never could.

Phase 3 Milestone 4: this module is now a thin, behavior-preserving wrapper
over provider_sync.py's generic, provider-agnostic sync_all() orchestrator
-- the actual discover/link/upsert/record-run logic lives there now (moved,
not duplicated), so ScraperProvider/MockProvider share the exact same
implementation via sync_reviews.py. sync_all()'s external signature, return
shape, and behavior for GBPProvider are unchanged; every existing caller
(critical_alert_check.py, this file's own CLI below) needs zero changes.

Usage:
    py gbp_sync.py            # full sync (all review pages per location)
    py gbp_sync.py --fast     # first page of reviews per location only --
                               # for the frequent critical-alert-check workflow
"""
import argparse
import asyncio
import os
import sys

import digest_filters
import provider_sync
from provider_gbp import GBPProvider


def sync_all(fast: bool = False) -> dict:
    """Runs one full sync pass against Google Business Profile. Returns run
    stats (new/edited/deleted counts) in the same shape auto_update.py's run
    stats use, so the scheduled workflow and the frequent critical-check can
    treat either data source identically. Delegates to
    provider_sync.sync_all() (Phase 3 Milestone 4) -- see this module's own
    docstring."""
    return asyncio.run(provider_sync.sync_all(GBPProvider(), fast=fast))


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
