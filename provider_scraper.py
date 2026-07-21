"""
provider_scraper.py -- Phase 3 Milestone 2: ScraperProvider, the Provider
implementation wrapping the existing Playwright-based scraper
(auto_update.py). Reuses auto_update.LOCATIONS and auto_update.scrape_location()
verbatim -- no scraping/parsing logic is duplicated here.

Not called by any production code path yet: auto_update.py continues to run
unchanged as its own self-contained script for real scheduled traffic (see
update-reviews.yml). This class exists to prove out the Provider seam for
the scraper, validated by unit tests with Playwright fully mocked -- wiring
it into a real sync path is Phase 3 Milestone 4's job (a REVIEW_PROVIDER-
style entrypoint), not this one.
"""
import importlib.util

import auto_update
import retry as retry_lib
from provider_base import (
    Provider, ProviderLocation, ProviderReview, ProviderError,
    ProviderRateLimitError, ProviderPermissionError, ProviderParsingError, ProviderServerError,
    CAP_READ_REVIEWS,
)

# Scraper-tuned retry constants (Phase 3 Milestone 2) -- deliberately
# different from google_api.py's _MAX_RETRIES=5/_BASE_BACKOFF_SECONDS=1.0.
# Each scraper attempt costs several seconds of real page-load time (not a
# fast JSON call), and the whole 21-location run has a fixed 30-minute CI
# budget (update-reviews.yml's `timeout-minutes: 30` on the scrape step) --
# a Google-tuned 5-attempt policy could multiply one bad location's cost far
# beyond what that budget allows.
#
# SCRAPER_MAX_RETRIES follows retry.py's own "max_retries = total attempts"
# convention (see google_api.py's _MAX_RETRIES for the same convention) --
# a value of 3 means 1 initial attempt + 2 retries, matching "maximum of 2
# retries after the initial attempt."
SCRAPER_MAX_RETRIES = 3
SCRAPER_BASE_BACKOFF = 2.0


def classify_scraper_error(message: str) -> ProviderError:
    """Maps one of auto_update.py's existing failure strings (scrape_location()'s
    error_message, exactly as it exists today -- see the auto_update.py line
    references below) onto the shared ProviderError hierarchy. Pattern-matched
    on exact wording, which is inherently brittle: if that wording ever
    changes, an unrecognized message still falls into the conservative
    retryable fallback rather than being silently dropped."""
    text = (message or "").lower()

    # auto_update.py:294 -- "Google rate-limit / automation block detected"
    if "google rate-limit" in text:
        return ProviderRateLimitError(message, retryable=False)

    # auto_update.py:296 -- "CAPTCHA detected -- Google identified the runner as a bot"
    if "captcha detected" in text:
        return ProviderPermissionError(message, retryable=False)

    # auto_update.py:291 -- "Blocked by {state} page -- dismissal failed"
    if text.startswith("blocked by"):
        return ProviderPermissionError(message, retryable=False)

    # auto_update.py:385-388 -- "Could not navigate to place panel after 4
    # strategies..."; auto_update.py:559-562 -- "Reviews tab not found after
    # 5 strategies...". The page loaded, but its structure didn't match what
    # we expect (Maps markup changed, or the place genuinely doesn't exist
    # under that search string) -- not a network problem, not worth
    # retrying immediately.
    if "could not navigate to place panel" in text or "reviews tab not found" in text:
        return ProviderParsingError(message, retryable=False)

    # auto_update.py:276 -- "Navigation timeout/error: {e}" -- plus the
    # conservative fallback for any other/unrecognized exception string:
    # still worth a bounded retry rather than silently swallowing it.
    return ProviderServerError(message, retryable=True)


class ScraperProvider(Provider):
    name = "scraper"
    display_name = "Web Scraper"
    # Read-only: auto_update.py never posts anything back to Google --
    # owner_response is scraped/read only. reply_to_review() is
    # intentionally NOT overridden below, so it inherits the ABC default
    # (raises NotImplementedError), correctly modeling "this provider can't
    # reply" -- matches the capability declaration exactly.
    capabilities = frozenset({CAP_READ_REVIEWS})
    # Matches update-reviews.yml's real 6-hour cron.
    expected_cadence_minutes = 360

    def __init__(self):
        self._playwright = None
        self._browser = None
        self._context = None

    def is_configured(self) -> bool:
        """Cheap, no-network, no-browser-launch check: is playwright
        importable at all? Mirrors GBPProvider.is_configured()'s
        no-network-call gate pattern."""
        return importlib.util.find_spec("playwright") is not None

    def discover_locations(self) -> list[ProviderLocation]:
        """auto_update.LOCATIONS is the scraper's actual source of truth for
        "what locations exist" (mirrors GBPProvider calling the live
        accounts/locations API as *its* source of truth) -- not the DB,
        which is only ever a downstream cache seeded from this list. No
        network call, no exception path: this is a static, in-memory list."""
        return [
            ProviderLocation(
                external_id=None,  # no stable external ID -- only a free-text search string
                name=loc["name"],
                city=loc["city"],
                search_query=loc["search"],
            )
            for loc in auto_update.LOCATIONS
        ]

    async def _ensure_browser(self) -> None:
        """Lazily launches one browser/context, reused across every
        fetch_reviews() call on this instance -- mirrors auto_update.py's
        current one-browser/21-locations model. auto_update.py has no
        standalone launch-browser function to import (this setup is inline
        in _scrape_and_write()), so the launch args/context options below
        are duplicated from there verbatim rather than reimplemented or
        simplified -- this is environment setup, not scraping/parsing
        logic, and fidelity to the real anti-bot-detection args matters for
        whenever this is eventually exercised against real Maps pages."""
        if self._context is not None:
            return
        from playwright.async_api import async_playwright

        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-infobars",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-popup-blocking",
            ],
        )
        self._context = await self._browser.new_context(
            viewport={"width": 1280, "height": 900},
            locale="en-US",
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/137.0.0.0 Safari/537.36"
            ),
        )
        await self._context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined })"
        )

    async def fetch_reviews(self, location: ProviderLocation, *, fast: bool = False) -> list[ProviderReview]:
        """fast=True is currently a no-op: the scraper has no existing
        "first page only" concept, and inventing one here would risk
        rewriting scraper internals this milestone explicitly avoids.
        Accepted as a valid, safely-ignorable hint -- nothing calls this
        with fast=True in production today."""
        await self._ensure_browser()
        loc_dict = {"name": location.name, "city": location.city, "search": location.search_query}

        async def _attempt():
            rows, error, maps_url = await auto_update.scrape_location(self._context, loc_dict)
            if error:
                raise classify_scraper_error(error)
            if maps_url:
                # In-place side effect, mirroring auto_update.py's own
                # discover-then-thread-back convention for maps_url -- a
                # future sync-layer orchestrator reads this after the call
                # to decide whether to persist an update.
                location.maps_url = maps_url
            return rows

        rows = await retry_lib.with_retry_async(
            _attempt,
            max_retries=SCRAPER_MAX_RETRIES,
            base_backoff=SCRAPER_BASE_BACKOFF,
        )
        return [self._to_provider_review(row) for row in rows]

    @staticmethod
    def _to_provider_review(row: dict) -> ProviderReview:
        """Field-for-field the same shape auto_update.py's own _scrape_and_write()
        already normalizes (db_row["star_rating"] = row["star_rating"] or None) --
        moved, not rewritten. gbp_* fields are left at their ProviderReview
        defaults (None), matching db.py's documented contract for
        scraper-sourced rows exactly. review_url is preserved verbatim
        (never blanked) -- db.dedup_key() falls back to
        canonical_review_id(review_url) when gbp_review_name is absent, so a
        correct review_url is load-bearing for dedup fidelity."""
        return ProviderReview(
            reviewer_name=row["reviewer_name"],
            review_date=row["review_date"],
            star_rating=row["star_rating"] or None,
            review_text=row["review_text"],
            owner_response=row["owner_response"],
            review_url=row["review_url"],
        )

    async def aclose(self) -> None:
        """Closes the browser/playwright instance this provider launched, if
        any. Callers that construct a ScraperProvider and call
        fetch_reviews() must eventually call this (or use the instance as an
        async context manager) to avoid leaking a browser process."""
        if self._browser is not None:
            await self._browser.close()
            self._browser = None
        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None
        self._context = None

    async def __aenter__(self) -> "ScraperProvider":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.aclose()
