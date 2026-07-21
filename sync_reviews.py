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

Usage:
    py sync_reviews.py                       # provider from $REVIEW_PROVIDER, default 'scraper'
    py sync_reviews.py --provider gbp
    py sync_reviews.py --provider mock --fast
"""
import argparse
import asyncio
import os

import digest_filters
import provider_sync
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


def build_provider(provider_name: str) -> Provider:
    if provider_name not in PROVIDERS:
        raise ValueError(f"unknown provider {provider_name!r}, expected one of {sorted(PROVIDERS)}")
    return PROVIDERS[provider_name]()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=sorted(PROVIDERS), default=None,
                         help="Which provider to sync (default: $REVIEW_PROVIDER env var, else 'scraper')")
    parser.add_argument("--fast", action="store_true",
                         help="First page of reviews per location only (for frequent critical-alert checks)")
    args = parser.parse_args()

    provider_name = resolve_provider_name(args.provider)
    try:
        provider = build_provider(provider_name)
    except ValueError as e:
        print(f"::error::sync_reviews.py: {e}")
        return 1

    result = asyncio.run(provider_sync.sync_all(provider, fast=args.fast))
    print(result)

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
        print(f"sync_reviews.py: {len(new_reviews)} genuinely new review(s), "
              f"{len(new_negative)} new 1-2 star, {excluded} excluded (3-5 star)")
        print(f"sync_reviews.py: negative-review email "
              f"{'will be sent' if new_negative else 'skipped (no new 1-2 star reviews)'}")
        _write_github_output(len(new_reviews), len(new_negative), _build_email_html(new_negative))

    if result.get("status") == "failed":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
