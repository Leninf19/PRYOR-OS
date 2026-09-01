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
implementation via sync_reviews.py.

Multi-Tenant Phase 4C revision: sync_all() takes tenant_id as a required
keyword-only argument -- no default. Every caller (critical_alert_check.py,
this file's own CLI below) must resolve and pass its own explicit tenant.

Usage:
    py gbp_sync.py --tenant-id t_los-tres-amigos            # full sync
    py gbp_sync.py --tenant-id t_los-tres-amigos --fast     # first page of
                               # reviews per location only -- for the
                               # frequent critical-alert-check workflow
"""
import argparse
import asyncio
import os
import sys

import db
import digest_filters
import provider_sync
import tenant_keys
import tenant_paths
from provider_gbp import GBPProvider


def sync_all(*, tenant_id: str, fast: bool = False) -> dict:
    """Runs one full sync pass against Google Business Profile. Returns run
    stats (new/edited/deleted counts) in the same shape auto_update.py's run
    stats use, so the scheduled workflow and the frequent critical-check can
    treat either data source identically. Delegates to
    provider_sync.sync_all() (Phase 3 Milestone 4) -- see this module's own
    docstring.

    Multi-Tenant Phase 4C revision: tenant_id is REQUIRED, with no default
    of any kind. The original Phase 4C pass gave this a Los Tres Amigos
    default so critical_alert_check.py's call kept working unchanged --
    that was rejected on review, because it meant a caller that omitted the
    tenant silently synced Los Tres Amigos's data instead of failing.
    critical_alert_check.py now resolves and passes its own explicit
    tenant_id (see that file).

    Multi-Tenant Phase 4D: also resolves and sets db.DB_PATH to THIS
    tenant's own review database before provider_sync.sync_all() ever opens
    a connection -- idempotent and cheap (a dict lookup), so it is safe to
    call this from any context (a caller that already set db.DB_PATH for
    the same tenant, e.g. critical_alert_check.py, simply gets the same
    value back) without requiring every caller to remember to do it first."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "gbp_sync.sync_all")
    db.DB_PATH = tenant_paths.resolve_review_db_path(tenant_id)
    return asyncio.run(provider_sync.sync_all(GBPProvider(tenant_id=tenant_id), fast=fast))


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
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant to sync. REQUIRED -- no default. The calling workflow "
                              "must pass this explicitly (e.g. --tenant-id t_los-tres-amigos); this "
                              "script never infers a tenant on its own. See the Multi-Tenant Phase 4C report.")
    args = parser.parse_args()
    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::gbp_sync.py: invalid --tenant-id {args.tenant_id!r}")
        sys.exit(1)
    try:
        result = sync_all(tenant_id=args.tenant_id, fast=args.fast)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::gbp_sync.py: {e}")
        sys.exit(1)
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
