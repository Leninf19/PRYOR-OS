"""
Regression tests for provider_scraper.py (Phase 3 Milestone 2) -- the
Provider implementation wrapping the existing Playwright scraper
(auto_update.py). Every test mocks auto_update.scrape_location directly (the
same transparent-module-attribute-lookup pattern tests/test_gbp_sync.py
already uses for google_api.py's functions) -- no real Playwright browser or
network call ever runs here.

Run directly: py tests/test_provider_scraper.py
"""
import asyncio
import inspect
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import auto_update
from provider_base import (
    ProviderLocation, ProviderParsingError, ProviderPermissionError,
    ProviderRateLimitError, ProviderServerError, CAP_READ_REVIEWS,
)
from provider_scraper import ScraperProvider, classify_scraper_error, SCRAPER_MAX_RETRIES

results = []


def run(name, fn):
    try:
        asyncio.run(fn()) if inspect.iscoroutinefunction(fn) else fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _sample_row(**overrides):
    row = {
        "reviewer_name": "Jane Doe",
        "star_rating": 5,
        "review_date": "2026-07-01",
        "review_text": "Great food!",
        "owner_response": "Thank you!",
        "review_url": "https://www.google.com/maps/reviews/abc123",
    }
    row.update(overrides)
    return row


def _no_ensure_browser():
    """Patches ScraperProvider._ensure_browser to a no-op so tests never
    launch a real Playwright browser -- auto_update.scrape_location is
    mocked directly below, so no real context is ever needed."""
    return mock.patch.object(ScraperProvider, "_ensure_browser", new=mock.AsyncMock(return_value=None))


def _no_sleep():
    return mock.patch("retry.asyncio.sleep", new=mock.AsyncMock(return_value=None))


# --- Identity, capabilities, no-reply -------------------------------------

def test_provider_identity():
    p = ScraperProvider()
    assert p.name == "scraper"
    assert p.display_name == "Web Scraper"
    assert p.expected_cadence_minutes == 360


def test_capabilities_read_only_no_reply_capability():
    p = ScraperProvider()
    assert p.capabilities == frozenset({CAP_READ_REVIEWS})
    assert "reply" not in p.capabilities


def test_reply_to_review_raises_not_implemented_mentioning_scraper():
    p = ScraperProvider()
    try:
        p.reply_to_review("some/review", "thanks!")
        raise AssertionError("expected NotImplementedError")
    except NotImplementedError as e:
        assert "scraper" in str(e)


def test_is_configured_reflects_playwright_availability():
    p = ScraperProvider()
    with mock.patch("importlib.util.find_spec", return_value=object()):
        assert p.is_configured() is True
    with mock.patch("importlib.util.find_spec", return_value=None):
        assert p.is_configured() is False


# --- discover_locations() --------------------------------------------------

def test_discover_locations_matches_auto_update_locations():
    p = ScraperProvider()
    locations = p.discover_locations()
    assert len(locations) == len(auto_update.LOCATIONS) == 21
    first = locations[0]
    assert isinstance(first, ProviderLocation)
    assert first.external_id is None
    assert first.name == auto_update.LOCATIONS[0]["name"]
    assert first.city == auto_update.LOCATIONS[0]["city"]
    assert first.search_query == auto_update.LOCATIONS[0]["search"]
    assert first.maps_url == ""
    assert first.provider_metadata == {}


# --- classify_scraper_error() ----------------------------------------------

def test_classify_google_rate_limit_as_rate_limit_error_not_retryable():
    err = classify_scraper_error("Google rate-limit / automation block detected")
    assert isinstance(err, ProviderRateLimitError)
    assert err.retryable is False


def test_classify_captcha_as_permission_error_not_retryable():
    err = classify_scraper_error("CAPTCHA detected -- Google identified the runner as a bot")
    assert isinstance(err, ProviderPermissionError)
    assert err.retryable is False


def test_classify_blocked_by_page_as_permission_error_not_retryable():
    err = classify_scraper_error("Blocked by consent page -- dismissal failed")
    assert isinstance(err, ProviderPermissionError)
    assert err.retryable is False


def test_classify_navigation_failure_as_parsing_error_not_retryable():
    err = classify_scraper_error(
        "Could not navigate to place panel after 4 strategies. Final state: unknown"
    )
    assert isinstance(err, ProviderParsingError)
    assert err.retryable is False


def test_classify_reviews_tab_not_found_as_parsing_error_not_retryable():
    err = classify_scraper_error("Reviews tab not found after 5 strategies | URL: ... | Elements found: []")
    assert isinstance(err, ProviderParsingError)
    assert err.retryable is False


def test_classify_navigation_timeout_as_server_error_retryable():
    err = classify_scraper_error("Navigation timeout/error: Timeout 35000ms exceeded")
    assert isinstance(err, ProviderServerError)
    assert err.retryable is True


def test_classify_unrecognized_message_falls_back_to_retryable_server_error():
    err = classify_scraper_error("some completely new failure string never seen before")
    assert isinstance(err, ProviderServerError)
    assert err.retryable is True


# --- fetch_reviews(): success / normalization ------------------------------

async def test_successful_fetch_returns_normalized_provider_reviews():
    location = ProviderLocation(external_id=None, name="Los Tres Amigos Livonia", city="Livonia",
                                 search_query="Los Tres Amigos 29441 Five Mile Rd Livonia MI")
    row = _sample_row()
    with _no_ensure_browser(), \
         mock.patch.object(auto_update, "scrape_location", new=mock.AsyncMock(
             return_value=([row], None, "https://maps.google.com/place/x"))):
        p = ScraperProvider()
        reviews = await p.fetch_reviews(location)

    assert len(reviews) == 1
    r = reviews[0]
    assert r.reviewer_name == "Jane Doe"
    assert r.review_date == "2026-07-01"
    assert r.star_rating == 5
    assert r.review_text == "Great food!"
    assert r.owner_response == "Thank you!"
    assert r.review_url == "https://www.google.com/maps/reviews/abc123"
    assert r.gbp_review_name is None
    assert r.gbp_update_time is None
    assert r.gbp_reply_update_time is None
    assert r.gbp_language_code is None
    # maps_url side effect: mutated in place on the passed-in location
    assert location.maps_url == "https://maps.google.com/place/x"


async def test_star_rating_zero_or_falsy_normalizes_to_none_not_fabricated():
    location = ProviderLocation(external_id=None, name="X", city="Y", search_query="z")
    row = _sample_row(star_rating=0)
    with _no_ensure_browser(), \
         mock.patch.object(auto_update, "scrape_location", new=mock.AsyncMock(return_value=([row], None, ""))):
        p = ScraperProvider()
        reviews = await p.fetch_reviews(location)
    assert reviews[0].star_rating is None


async def test_missing_optional_text_fields_pass_through_as_empty_strings_not_fabricated():
    location = ProviderLocation(external_id=None, name="X", city="Y", search_query="z")
    row = _sample_row(review_text="", owner_response="", review_url="")
    with _no_ensure_browser(), \
         mock.patch.object(auto_update, "scrape_location", new=mock.AsyncMock(return_value=([row], None, ""))):
        p = ScraperProvider()
        reviews = await p.fetch_reviews(location)
    assert reviews[0].review_text == ""
    assert reviews[0].owner_response == ""
    assert reviews[0].review_url == ""


async def test_no_maps_url_returned_leaves_location_maps_url_untouched():
    location = ProviderLocation(external_id=None, name="X", city="Y", search_query="z", maps_url="https://old")
    with _no_ensure_browser(), \
         mock.patch.object(auto_update, "scrape_location", new=mock.AsyncMock(return_value=([], None, ""))):
        p = ScraperProvider()
        await p.fetch_reviews(location)
    assert location.maps_url == "https://old"


# --- fetch_reviews(): failure classification + retry behavior -------------

async def test_network_failure_retries_then_succeeds():
    location = ProviderLocation(external_id=None, name="X", city="Y", search_query="z")
    mock_scrape = mock.AsyncMock(side_effect=[
        ([], "Navigation timeout/error: boom", ""),
        ([_sample_row()], None, ""),
    ])
    with _no_ensure_browser(), _no_sleep(), \
         mock.patch.object(auto_update, "scrape_location", new=mock_scrape):
        p = ScraperProvider()
        reviews = await p.fetch_reviews(location)
    assert len(reviews) == 1
    assert mock_scrape.await_count == 2


async def test_retry_exhaustion_raises_the_classified_error():
    location = ProviderLocation(external_id=None, name="X", city="Y", search_query="z")
    mock_scrape = mock.AsyncMock(return_value=([], "Navigation timeout/error: still broken", ""))
    with _no_ensure_browser(), _no_sleep(), \
         mock.patch.object(auto_update, "scrape_location", new=mock_scrape):
        p = ScraperProvider()
        try:
            await p.fetch_reviews(location)
            raise AssertionError("expected ProviderServerError to be raised")
        except ProviderServerError:
            pass
    assert mock_scrape.await_count == SCRAPER_MAX_RETRIES


async def test_non_retryable_captcha_failure_raises_immediately_no_retry():
    location = ProviderLocation(external_id=None, name="X", city="Y", search_query="z")
    mock_scrape = mock.AsyncMock(
        return_value=([], "CAPTCHA detected -- Google identified the runner as a bot", ""))
    with _no_ensure_browser(), _no_sleep(), \
         mock.patch.object(auto_update, "scrape_location", new=mock_scrape):
        p = ScraperProvider()
        try:
            await p.fetch_reviews(location)
            raise AssertionError("expected ProviderPermissionError to be raised")
        except ProviderPermissionError:
            pass
    assert mock_scrape.await_count == 1, "a CAPTCHA/blocked result must never be retried within the same run"


async def test_parsing_failure_raises_immediately_no_retry():
    location = ProviderLocation(external_id=None, name="X", city="Y", search_query="z")
    mock_scrape = mock.AsyncMock(
        return_value=([], "Reviews tab not found after 5 strategies | URL: x | Elements found: []", ""))
    with _no_ensure_browser(), _no_sleep(), \
         mock.patch.object(auto_update, "scrape_location", new=mock_scrape):
        p = ScraperProvider()
        try:
            await p.fetch_reviews(location)
            raise AssertionError("expected ProviderParsingError to be raised")
        except ProviderParsingError:
            pass
    assert mock_scrape.await_count == 1


async def test_partial_location_failure_does_not_affect_other_locations():
    """One location failing outright must not affect a second, independent
    fetch_reviews() call on the same provider instance -- mirrors
    auto_update.py's own per-location isolation (scrape_location()'s own
    try/except never aborts the whole run)."""
    loc_a = ProviderLocation(external_id=None, name="A", city="A", search_query="a")
    loc_b = ProviderLocation(external_id=None, name="B", city="B", search_query="b")
    mock_scrape = mock.AsyncMock(side_effect=[
        ([], "CAPTCHA detected -- Google identified the runner as a bot", ""),  # location A: hard fail
        ([_sample_row()], None, ""),                                            # location B: succeeds
    ])
    with _no_ensure_browser(), _no_sleep(), \
         mock.patch.object(auto_update, "scrape_location", new=mock_scrape):
        p = ScraperProvider()
        try:
            await p.fetch_reviews(loc_a)
            raise AssertionError("expected location A to raise")
        except ProviderPermissionError:
            pass
        reviews_b = await p.fetch_reviews(loc_b)
    assert len(reviews_b) == 1


# --- Browser lifecycle ------------------------------------------------------

async def test_aclose_is_a_safe_no_op_when_never_launched():
    p = ScraperProvider()
    await p.aclose()  # must not raise even though _ensure_browser() was never called


async def test_context_manager_closes_browser_on_exit():
    """The `playwright` package isn't installed in this test environment
    (confirmed: is_configured() -> False here) -- rather than requiring it
    as a real dependency just to test lifecycle bookkeeping, this test
    injects a fake playwright.async_api module via sys.modules so
    _ensure_browser()'s `from playwright.async_api import async_playwright`
    resolves to fully-controlled fakes instead of raising ModuleNotFoundError."""
    fake_context = mock.MagicMock()
    fake_context.add_init_script = mock.AsyncMock(return_value=None)

    fake_browser = mock.MagicMock()
    fake_browser.new_context = mock.AsyncMock(return_value=fake_context)
    fake_browser.close = mock.AsyncMock(return_value=None)

    fake_chromium = mock.MagicMock()
    fake_chromium.launch = mock.AsyncMock(return_value=fake_browser)

    fake_playwright_instance = mock.MagicMock()
    fake_playwright_instance.chromium = fake_chromium
    fake_playwright_instance.stop = mock.AsyncMock(return_value=None)

    fake_cm = mock.MagicMock()
    fake_cm.start = mock.AsyncMock(return_value=fake_playwright_instance)

    fake_async_api_module = mock.MagicMock()
    fake_async_api_module.async_playwright = mock.MagicMock(return_value=fake_cm)

    with mock.patch.dict(sys.modules, {
        "playwright": mock.MagicMock(),
        "playwright.async_api": fake_async_api_module,
    }):
        async with ScraperProvider() as p:
            await p._ensure_browser()
            assert p._context is fake_context
        # __aexit__ must have closed the browser and stopped playwright
        fake_browser.close.assert_awaited_once()
        fake_playwright_instance.stop.assert_awaited_once()
        assert p._context is None


def main():
    tests = [
        ("Provider identity (name, display_name, cadence)", test_provider_identity),
        ("capabilities are read-only, no reply capability", test_capabilities_read_only_no_reply_capability),
        ("reply_to_review() raises NotImplementedError mentioning 'scraper'", test_reply_to_review_raises_not_implemented_mentioning_scraper),
        ("is_configured() reflects playwright availability", test_is_configured_reflects_playwright_availability),
        ("discover_locations() matches auto_update.LOCATIONS exactly", test_discover_locations_matches_auto_update_locations),
        ("classify: Google rate-limit -> ProviderRateLimitError, not retryable", test_classify_google_rate_limit_as_rate_limit_error_not_retryable),
        ("classify: CAPTCHA -> ProviderPermissionError, not retryable", test_classify_captcha_as_permission_error_not_retryable),
        ("classify: blocked-by page -> ProviderPermissionError, not retryable", test_classify_blocked_by_page_as_permission_error_not_retryable),
        ("classify: navigation failure -> ProviderParsingError, not retryable", test_classify_navigation_failure_as_parsing_error_not_retryable),
        ("classify: reviews tab not found -> ProviderParsingError, not retryable", test_classify_reviews_tab_not_found_as_parsing_error_not_retryable),
        ("classify: navigation timeout -> ProviderServerError, retryable", test_classify_navigation_timeout_as_server_error_retryable),
        ("classify: unrecognized message falls back to retryable ProviderServerError", test_classify_unrecognized_message_falls_back_to_retryable_server_error),
        ("successful fetch returns normalized ProviderReviews + maps_url side effect", test_successful_fetch_returns_normalized_provider_reviews),
        ("falsy star_rating normalizes to None, never fabricated", test_star_rating_zero_or_falsy_normalizes_to_none_not_fabricated),
        ("missing optional text fields pass through as empty strings, never fabricated", test_missing_optional_text_fields_pass_through_as_empty_strings_not_fabricated),
        ("no maps_url returned leaves location.maps_url untouched", test_no_maps_url_returned_leaves_location_maps_url_untouched),
        ("network failure retries then succeeds", test_network_failure_retries_then_succeeds),
        ("retry exhaustion raises the classified error", test_retry_exhaustion_raises_the_classified_error),
        ("non-retryable CAPTCHA failure raises immediately, no retry", test_non_retryable_captcha_failure_raises_immediately_no_retry),
        ("parsing failure raises immediately, no retry", test_parsing_failure_raises_immediately_no_retry),
        ("one location's hard failure doesn't affect another location's fetch", test_partial_location_failure_does_not_affect_other_locations),
        ("aclose() is a safe no-op when the browser was never launched", test_aclose_is_a_safe_no_op_when_never_launched),
        ("async context manager closes the browser on exit", test_context_manager_closes_browser_on_exit),
    ]
    for name, fn in tests:
        run(name, fn)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
