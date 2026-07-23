"""
Regression tests for provider_sync.py (Phase 3 Milestone 4) -- the generic,
provider-agnostic sync orchestrator. Exercises it against fake sync AND fake
async Provider implementations (proving _maybe_await handles both
transparently, matching GBPProvider/MockProvider's sync style and
ScraperProvider's async style) against a scratch DB -- never the real
dashboard/reviews.db.

Run directly: py tests/test_provider_sync.py
"""
import asyncio
import inspect
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
import provider_sync
from provider_base import Provider, ProviderLocation, ProviderReview, ProviderRateLimitError
from provider_gbp import GBPProvider
from provider_mock import MockProvider
from provider_scraper import ScraperProvider

results = []


def run(name, fn):
    try:
        asyncio.run(fn()) if inspect.iscoroutinefunction(fn) else fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def _fresh_db():
    tmpdir = tempfile.mkdtemp(prefix="provider_sync_test_")
    db.DB_PATH = Path(tmpdir) / "reviews.db"
    conn = db.get_connection()
    db.init_schema(conn)
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Casa Tequila Testtown', 'Testtown', 'Casa Tequila')")
    conn.commit()
    conn.close()


def _review(reviewer_name="Jane Doe", review_date="2026-07-01", star_rating=5,
            review_text="Great!", review_url="", gbp_review_name=None):
    return ProviderReview(reviewer_name=reviewer_name, review_date=review_date, star_rating=star_rating,
                           review_text=review_text, review_url=review_url, gbp_review_name=gbp_review_name)


class FakeProvider(Provider):
    """A synchronous fake Provider -- matches GBPProvider/MockProvider's
    plain (non-async) style."""
    name = "fake"
    display_name = "Fake Provider"

    def __init__(self, locations=None, reviews_by_name=None, discover_error=None,
                 fetch_errors=None, configured=True):
        self._locations = locations if locations is not None else []
        self._reviews_by_name = reviews_by_name or {}
        self._discover_error = discover_error
        self._fetch_errors = fetch_errors or {}
        self._configured = configured

    def is_configured(self):
        return self._configured

    def discover_locations(self):
        if self._discover_error:
            raise self._discover_error
        return self._locations

    def fetch_reviews(self, location, *, fast=False):
        if location.name in self._fetch_errors:
            raise self._fetch_errors[location.name]
        return self._reviews_by_name.get(location.name, [])


class FakeAsyncProvider(FakeProvider):
    """Same behavior as FakeProvider, but discover_locations()/
    fetch_reviews() are async -- matches ScraperProvider's style -- to
    prove provider_sync._maybe_await() handles both uniformly."""
    name = "fakeasync"
    display_name = "Fake Async Provider"

    async def discover_locations(self):
        return super().discover_locations()

    async def fetch_reviews(self, location, *, fast=False):
        return super().fetch_reviews(location, fast=fast)


# --- sync_all() against both a sync and an async provider --------------------

async def _run_new_review_scenario(provider_cls):
    _fresh_db()
    loc = ProviderLocation(external_id=None, name="Casa Tequila Testtown", city="Testtown")
    provider = provider_cls(locations=[loc], reviews_by_name={"Casa Tequila Testtown": [_review()]})
    result = await provider_sync.sync_all(provider)

    assert result["status"] == "ok", result
    assert result["new"] == 1, result

    conn = db.get_connection()
    count = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    conn.close()
    assert count == 1


async def test_sync_all_with_sync_provider():
    await _run_new_review_scenario(FakeProvider)


async def test_sync_all_with_async_provider():
    await _run_new_review_scenario(FakeAsyncProvider)


async def test_sync_all_skipped_when_not_configured():
    _fresh_db()
    provider = FakeProvider(configured=False)
    result = await provider_sync.sync_all(provider)
    assert result["status"] == "skipped", result
    assert "Fake Provider" in result["reason"]


# --- Discovery failure --------------------------------------------------------

async def test_discovery_failure_records_early_failure_with_provider_name():
    _fresh_db()
    provider = FakeProvider(discover_error=ProviderRateLimitError("simulated 429", status=429))
    result = await provider_sync.sync_all(provider)

    assert result["status"] == "failed", result
    assert "429" in result["reason"]

    conn = db.get_connection()
    run_row = conn.execute(
        "SELECT status, mode, provider, failure_stage FROM scraper_runs ORDER BY id DESC LIMIT 1"
    ).fetchone()
    conn.close()
    assert run_row["status"] == "failed"
    assert run_row["mode"] == "api_sync"
    assert run_row["provider"] == "fake"
    assert run_row["failure_stage"] == "account_discovery"


async def test_discovery_failure_result_carries_error_type_and_status():
    """Diagnostics-only enrichment: the returned dict must also carry the
    original exception's class name and HTTP status (not just its stringified
    message under 'reason') -- this is what lets a caller like
    critical_alert_check.py distinguish a quota block (429/GBPRateLimitError)
    from a genuine auth failure (401/GBPAuthError) from anything else,
    instead of the two of them being indistinguishable strings. Purely
    additive: 'status'/'reason' (asserted above in the sibling test) are
    completely unchanged."""
    _fresh_db()
    provider = FakeProvider(discover_error=ProviderRateLimitError("simulated 429", status=429))
    result = await provider_sync.sync_all(provider)

    assert result["status"] == "failed", result
    assert result["error_type"] == "ProviderRateLimitError", result
    assert result["error_status"] == 429, result
    assert result["error_traceback"] and "ProviderRateLimitError" in result["error_traceback"], \
        "a traceback must be captured for the discovery failure"


async def test_non_provider_error_during_discovery_propagates_uncaught():
    """Error propagation: only ProviderError is caught and turned into a
    graceful {"status": "failed"} result -- a plain, unexpected exception
    must still propagate to the caller, exactly like the original
    gbp_sync.py behavior (which only ever caught ProviderError)."""
    _fresh_db()
    provider = FakeProvider(discover_error=RuntimeError("something truly unexpected"))
    try:
        await provider_sync.sync_all(provider)
        raise AssertionError("expected the RuntimeError to propagate, not be swallowed")
    except RuntimeError as e:
        assert "something truly unexpected" in str(e)


# --- Per-location failure isolation + statistics ------------------------------

async def test_per_location_failure_is_isolated_status_partial():
    _fresh_db()
    conn = db.get_connection()
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Second Spot', 'Elsewhere', 'Casa Tequila')")
    conn.commit()
    conn.close()

    loc_a = ProviderLocation(external_id=None, name="Casa Tequila Testtown", city="Testtown")
    loc_b = ProviderLocation(external_id=None, name="Second Spot", city="Elsewhere")
    provider = FakeProvider(
        locations=[loc_a, loc_b],
        reviews_by_name={"Casa Tequila Testtown": [_review()]},
        fetch_errors={"Second Spot": ProviderRateLimitError("simulated outage", status=503)},
    )
    result = await provider_sync.sync_all(provider)

    assert result["status"] == "partial", result
    assert result["locations_succeeded"] == 1, result
    assert result["locations_failed"] == 1, result
    assert result["new"] == 1, result


async def test_all_locations_failing_yields_status_failed_not_partial():
    _fresh_db()
    loc = ProviderLocation(external_id=None, name="Casa Tequila Testtown", city="Testtown")
    provider = FakeProvider(
        locations=[loc],
        fetch_errors={"Casa Tequila Testtown": ProviderRateLimitError("simulated outage", status=503)},
    )
    result = await provider_sync.sync_all(provider)
    assert result["status"] == "failed", result
    assert result["locations_succeeded"] == 0
    assert result["locations_failed"] == 1


async def test_statistics_sum_correctly_across_multiple_locations():
    _fresh_db()
    conn = db.get_connection()
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Second Spot', 'Elsewhere', 'Casa Tequila')")
    conn.commit()
    conn.close()

    loc_a = ProviderLocation(external_id=None, name="Casa Tequila Testtown", city="Testtown")
    loc_b = ProviderLocation(external_id=None, name="Second Spot", city="Elsewhere")
    provider = FakeProvider(
        locations=[loc_a, loc_b],
        reviews_by_name={
            "Casa Tequila Testtown": [_review(reviewer_name="A"), _review(reviewer_name="B")],
            "Second Spot": [_review(reviewer_name="C")],
        },
    )
    result = await provider_sync.sync_all(provider)
    assert result["status"] == "ok"
    assert result["new"] == 3
    assert result["locations_succeeded"] == 2
    assert result["locations_failed"] == 0


# --- Location linking: no-external-id locations never collide ----------------

async def test_multiple_no_external_id_locations_do_not_collide():
    """Every ScraperProvider/MockProvider location has external_id=None --
    if the linked-locations dict were still keyed by external_id directly
    (the pre-generalization gbp_sync.py behavior), every such location would
    collide on the same key and all but the last would be silently dropped.
    This proves both locations are actually attempted."""
    _fresh_db()
    conn = db.get_connection()
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Second Spot', 'Elsewhere', 'Casa Tequila')")
    conn.commit()
    conn.close()

    loc_a = ProviderLocation(external_id=None, name="Casa Tequila Testtown", city="Testtown")
    loc_b = ProviderLocation(external_id=None, name="Second Spot", city="Elsewhere")
    provider = FakeProvider(
        locations=[loc_a, loc_b],
        reviews_by_name={"Casa Tequila Testtown": [_review()], "Second Spot": [_review()]},
    )
    result = await provider_sync.sync_all(provider)
    assert result["locations_succeeded"] == 2, \
        f"expected both no-external-id locations to be attempted independently, got {result}"
    assert result["new"] == 2


async def test_gbp_info_only_written_when_external_id_present():
    """db.set_location_gbp_info() (which sets gbp_last_synced_at) must only
    run for a location with a real external identity -- never for a
    Scraper/Mock-style location (external_id=None), which would otherwise
    falsely imply a GBP sync happened for that location."""
    _fresh_db()
    conn = db.get_connection()
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Linked Spot', 'Linkville', 'Casa Tequila')")
    conn.commit()
    conn.close()

    unlinked = ProviderLocation(external_id=None, name="Casa Tequila Testtown", city="Testtown")
    linked = ProviderLocation(external_id="accounts/1/locations/2", name="Linked Spot", city="Linkville",
                               verification_status="VERIFIED", provider_metadata={"account_name": "accounts/1"})
    provider = FakeProvider(locations=[unlinked, linked], reviews_by_name={})
    await provider_sync.sync_all(provider)

    conn = db.get_connection()
    rows = {r["name"]: r for r in conn.execute("SELECT name, gbp_location_name, gbp_last_synced_at FROM locations").fetchall()}
    conn.close()
    assert rows["Casa Tequila Testtown"]["gbp_last_synced_at"] is None, \
        "a location from a provider with no external identity must never get gbp_last_synced_at set"
    assert rows["Linked Spot"]["gbp_location_name"] == "accounts/1/locations/2"
    assert rows["Linked Spot"]["gbp_last_synced_at"] is not None


# --- Provider-dependent mode (Phase 3 Milestone 4.1) --------------------------

def test_mode_for_matches_each_real_provider_class():
    """Tied directly to the real provider classes' own .name values (not
    fabricated strings) -- GBPProvider.name/ScraperProvider.name/
    MockProvider.name are class attributes, so no instantiation (and no
    credentials/Playwright/snapshot file) is needed to check this mapping."""
    assert provider_sync._mode_for(GBPProvider) == "api_sync"
    assert provider_sync._mode_for(ScraperProvider) == "cloud"
    assert provider_sync._mode_for(MockProvider) == "mock"


def test_mode_for_unknown_provider_defaults_to_api_sync():
    import types
    assert provider_sync._mode_for(types.SimpleNamespace(name="some_future_provider")) == "api_sync"


async def test_scraper_run_records_cloud_mode_never_api_sync():
    _fresh_db()
    provider = FakeProvider(locations=[])
    provider.name = "scraper"
    await provider_sync.sync_all(provider)
    conn = db.get_connection()
    row = conn.execute("SELECT mode FROM scraper_runs ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()
    assert row["mode"] == "cloud"
    assert row["mode"] != "api_sync", "a scraper run must never record mode='api_sync'"


async def test_gbp_run_always_records_api_sync_mode():
    _fresh_db()
    provider = FakeProvider(locations=[])
    provider.name = "gbp"
    await provider_sync.sync_all(provider)
    conn = db.get_connection()
    row = conn.execute("SELECT mode FROM scraper_runs ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()
    assert row["mode"] == "api_sync"


async def test_mock_run_records_mock_mode():
    _fresh_db()
    provider = FakeProvider(locations=[])
    provider.name = "mock"
    await provider_sync.sync_all(provider)
    conn = db.get_connection()
    row = conn.execute("SELECT mode FROM scraper_runs ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()
    assert row["mode"] == "mock"


async def test_early_discovery_failure_also_records_provider_dependent_mode():
    """The mode fix must apply to the _record_early_failure() path too, not
    only the success path."""
    _fresh_db()
    provider = FakeProvider(discover_error=ProviderRateLimitError("simulated", status=429))
    provider.name = "scraper"
    await provider_sync.sync_all(provider)
    conn = db.get_connection()
    row = conn.execute("SELECT mode, status FROM scraper_runs ORDER BY id DESC LIMIT 1").fetchone()
    conn.close()
    assert row["status"] == "failed"
    assert row["mode"] == "cloud", "an early-failure row must also use the provider-dependent mode, not 'api_sync'"


def main():
    tests = [
        ("sync_all() with a synchronous provider (matches GBPProvider/MockProvider)", test_sync_all_with_sync_provider),
        ("sync_all() with an async provider (matches ScraperProvider) -- _maybe_await works for both", test_sync_all_with_async_provider),
        ("sync_all() returns 'skipped' with the provider's display_name when not configured", test_sync_all_skipped_when_not_configured),
        ("a discovery-level ProviderError records an early failure with the correct provider name", test_discovery_failure_records_early_failure_with_provider_name),
        ("a discovery failure's result carries error_type/error_status/error_traceback", test_discovery_failure_result_carries_error_type_and_status),
        ("a non-ProviderError exception during discovery propagates uncaught", test_non_provider_error_during_discovery_propagates_uncaught),
        ("a single location's failure is isolated -- status 'partial'", test_per_location_failure_is_isolated_status_partial),
        ("every location failing yields 'failed', not 'partial'", test_all_locations_failing_yields_status_failed_not_partial),
        ("new/edited/deleted statistics sum correctly across multiple locations", test_statistics_sum_correctly_across_multiple_locations),
        ("multiple external_id=None locations are linked independently, never collide", test_multiple_no_external_id_locations_do_not_collide),
        ("gbp_last_synced_at is only written for a location with a real external_id", test_gbp_info_only_written_when_external_id_present),
        ("_mode_for() maps each real provider class to its correct mode value", test_mode_for_matches_each_real_provider_class),
        ("_mode_for() defaults an unknown provider to 'api_sync'", test_mode_for_unknown_provider_defaults_to_api_sync),
        ("a scraper run records mode='cloud', never 'api_sync'", test_scraper_run_records_cloud_mode_never_api_sync),
        ("a gbp run always records mode='api_sync'", test_gbp_run_always_records_api_sync_mode),
        ("a mock run records mode='mock'", test_mock_run_records_mock_mode),
        ("an early discovery failure also records the provider-dependent mode", test_early_discovery_failure_also_records_provider_dependent_mode),
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
