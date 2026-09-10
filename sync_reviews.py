"""
sync_reviews.py -- Phase 3 Milestone 4: the REVIEW_PROVIDER-style entrypoint.
Selects a Provider (gbp/scraper/mock) by env var or CLI flag and runs
provider_sync.sync_all() against it -- giving ScraperProvider/MockProvider
their first real, runnable sync path, and proving the same generic
orchestrator gbp_sync.py now delegates to works identically for every
provider.

Not called by any production workflow yet: update-reviews.yml/
critical-alert-check.yml still call auto_update.py/gbp_sync.py directly.
Wiring an actual production workflow to call this instead is Phase 3
Milestone 4b's job, deliberately deferred -- see provider_sync.py's
docstring.

Exit code on a total sync failure (Phase 3 Milestone 4.1, a deliberate
architectural decision, not an oversight): main() returns 1 when
result["status"] == "failed", unlike auto_update.py's historical cloud/CI
behavior, which never exits non-zero for a "normal" failure (every
per-location try/except there swallows and continues; only --local-only
safety checks ever raise). This is intentionally NOT preserved. Reasoning:
update-reviews.yml never gates its commit/deploy steps on the sync step's
own outcome -- both are gated on `steps.integrity.outcome` (check_db_
integrity.py's own exit code) instead, and every step from "Upload debug
snapshots" onward runs `if: always()`. So a non-zero exit here changes
nothing about whether data gets committed or deployed; it only makes the
workflow run's own overall conclusion accurately reflect "the sync
attempted and completely failed" instead of silently reporting "success"
for a run that scraped/synced nothing. Verified against update-reviews.yml
(Milestone 4b's design review): no downstream step reads
`steps.scrape.outcome` anywhere.

Usage:
    py sync_reviews.py                       # provider from $REVIEW_PROVIDER, default 'scraper'
    py sync_reviews.py --provider gbp
    py sync_reviews.py --provider mock --fast
"""
import argparse
import asyncio
import os

import db
import digest_filters
import provider_sync
import tenant_keys
import tenant_paths
from provider_base import Provider
from provider_gbp import GBPProvider
from provider_mock import MockProvider
from provider_scraper import ScraperProvider

PROVIDERS: dict = {
    "gbp": GBPProvider,
    "scraper": ScraperProvider,
    "mock": MockProvider,
}


def _build_email_html(negative_reviews: list) -> str:
    """Identical in spirit to gbp_sync.py's own _build_email_html() -- this
    is now the shared entrypoint any provider's sync goes through. Still
    re-checks every row itself before rendering, so a mistakenly-unfiltered
    array can never leak a 3-5 star review into the email."""
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
    """Byte-for-byte the same output contract auto_update.py/gbp_sync.py
    already produce (new_count/negative_count/email_html), so a future
    Milestone 4b workflow swap needs zero downstream step changes."""
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        print(f"\nResult: {new_count} new reviews found ({negative_count} new 1-2 star)")
        return
    with open(output_path, "a", encoding="utf-8") as f:
        f.write(f"new_count={new_count}\n")
        f.write(f"negative_count={negative_count}\n")
        delimiter = "EOF_EMAIL"
        f.write(f"email_html<<{delimiter}\n{email_html}\n{delimiter}\n")


def resolve_provider_name(cli_provider: str | None) -> str:
    return cli_provider or os.environ.get("REVIEW_PROVIDER", "scraper")


def build_provider(provider_name: str, tenant_id: str) -> Provider:
    """Multi-Tenant Phase 4C revision: tenant_id is REQUIRED, with no
    default -- even though it is only actually USED by the 'gbp' provider
    (the only one that touches a Google credential at all; scraper/mock
    never accept it). It is still validated here, unconditionally, before
    any provider is built, for two reasons: (1) main()'s own --tenant-id
    flag is required regardless of --provider, so every invocation of this
    script explicitly states which tenant it is running for, not just GBP
    runs; (2) a caller can't accidentally skip validation by picking a
    provider that happens not to need the value. The original Phase 4C
    pass defaulted this to Los Tres Amigos -- rejected on review as exactly
    the implicit-tenant fallback this architecture must not have."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "sync_reviews.build_provider")
    if provider_name not in PROVIDERS:
        raise ValueError(f"unknown provider {provider_name!r}, expected one of {sorted(PROVIDERS)}")
    if provider_name == "gbp":
        return GBPProvider(tenant_id=tenant_id)
    return PROVIDERS[provider_name]()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=sorted(PROVIDERS), default=None,
                         help="Which provider to sync (default: $REVIEW_PROVIDER env var, else 'scraper')")
    parser.add_argument("--fast", action="store_true",
                         help="First page of reviews per location only (for frequent critical-alert checks)")
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant to sync. REQUIRED -- no default, even for non-gbp "
                              "providers. The calling workflow must pass this explicitly (e.g. "
                              "--tenant-id t_los-tres-amigos); this script never infers a tenant on "
                              "its own. See the Multi-Tenant Phase 4C report.")
    args = parser.parse_args()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::sync_reviews.py: invalid --tenant-id {args.tenant_id!r}")
        return 1

    # Multi-Tenant Phase 4D: resolve THIS tenant's own review database
    # before any provider/sync/DB code runs. db.DB_PATH is a process-global
    # (this script is a short-lived, single-tenant-per-invocation batch
    # process, never a long-running multi-tenant server) -- setting it here
    # is the one point that determines which physical SQLite file every
    # downstream db.get_connection() call in this process will open.
    try:
        db.DB_PATH = tenant_paths.resolve_review_db_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::sync_reviews.py: {e}")
        return 1

    provider_name = resolve_provider_name(args.provider)
    print(f"[sync_reviews] stage=start provider={provider_name} fast={args.fast} tenant_id={args.tenant_id}")
    try:
        provider = build_provider(provider_name, tenant_id=args.tenant_id)
    except ValueError as e:
        print(f"::error::sync_reviews.py: {e}")
        return 1

    result = asyncio.run(provider_sync.sync_all(provider, fast=args.fast))
    print(result)
    print(f"[sync_reviews] stage=sync_complete status={result.get('status')} "
          f"new={result.get('new', 0)} edited={result.get('edited', 0)} deleted={result.get('deleted', 0)}")

    print(f"sync_reviews.py: provider={provider_name} locations succeeded={result.get('locations_succeeded', 0)}, "
          f"failed={result.get('locations_failed', 0)}")
    if result.get("status") == "failed":
        stage = ("before location discovery" if not result.get("locations_succeeded")
                  and not result.get("locations_failed") else "during location scraping")
        print(f"sync_reviews.py: failure occurred {stage}")

    if not args.fast:
        # The fast/critical-check path doesn't touch this GH Actions output --
        # it's only meaningful for a full sync step.
        new_reviews = result.get("new_reviews", [])
        new_negative = digest_filters.get_new_negative_reviews(new_reviews)
        excluded = len(new_reviews) - len(new_negative)
        print(f"[sync_reviews] stage=negative_review_filter new_total={len(new_reviews)} "
              f"new_negative={len(new_negative)} excluded_positive={excluded}")
        print(f"sync_reviews.py: {len(new_reviews)} genuinely new review(s), "
              f"{len(new_negative)} new 1-2 star, {excluded} excluded (3-5 star)")
        print(f"sync_reviews.py: negative-review email "
              f"{'will be sent' if new_negative else 'skipped (no new 1-2 star reviews)'}")
        _write_github_output(len(new_reviews), len(new_negative), _build_email_html(new_negative))

    # Deliberately NOT matching auto_update.py's historical always-exits-0
    # behavior for a total failure -- see this module's docstring
    # (Phase 3 Milestone 4.1) for why this is an intentional improvement,
    # not a compatibility gap.
    if result.get("status") == "failed":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
