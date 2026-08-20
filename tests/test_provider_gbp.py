"""
Regression tests for provider_gbp.py's GBPProvider -- specifically the
account/location discovery paths. Every test mocks google_api.py's
functions directly (no real network/credentials) -- the same pattern
tests/test_gbp_sync.py and tests/test_provider_scraper.py already use.

Recovery audit (2026-08-20): production's actual failure (invalid_grant on
every sync attempt) is already covered end-to-end by
tests/test_google_api_endpoints.py (the token-exchange failure itself) and
tests/test_critical_alert_check.py (the fallback behavior when a GBP sync
fails). What was NOT covered anywhere: the specific "Google returned zero
accounts for this token" case -- a distinct failure mode from an auth
error (the token itself worked; there's just nothing behind it), and
provider_gbp.py's own docstring is explicit that this must raise
ProviderAuthError rather than silently returning an empty location list.

Run directly: py tests/test_provider_gbp.py
"""
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import google_api as ga
from provider_base import ProviderAuthError, ProviderConfigError
from provider_gbp import GBPProvider

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def test_zero_accounts_raises_provider_auth_error_not_empty_list():
    provider = GBPProvider()
    with mock.patch.object(provider, "is_configured", return_value=True), \
         mock.patch.object(ga, "list_accounts", return_value=[]):
        try:
            provider.discover_locations()
            raise AssertionError("expected ProviderAuthError, got a normal return")
        except ProviderAuthError as e:
            assert "No Google Business Profile accounts" in str(e)
        except Exception as e:
            raise AssertionError(f"expected ProviderAuthError specifically, got {type(e).__name__}: {e}")


def test_not_configured_raises_provider_config_error_before_any_api_call():
    provider = GBPProvider()
    with mock.patch.object(provider, "is_configured", return_value=False), \
         mock.patch.object(ga, "list_accounts") as list_accounts_mock:
        try:
            provider.discover_locations()
            raise AssertionError("expected ProviderConfigError")
        except ProviderConfigError:
            pass
        except Exception as e:
            raise AssertionError(f"expected ProviderConfigError specifically, got {type(e).__name__}: {e}")
    list_accounts_mock.assert_not_called()


def test_one_account_failing_does_not_abort_discovery_for_others():
    """Preserves gbp_sync.py's original per-account skip-and-continue
    behavior: one account's location-listing failure must never abort
    discovery for every other account."""
    provider = GBPProvider()
    accounts = [{"name": "accounts/1"}, {"name": "accounts/2"}]

    def fake_list_locations(account_name):
        if account_name == "accounts/1":
            raise ga.GBPServerError("boom", status=500)
        return [{
            "name": "locations/999", "locationName": "Working Location",
            "address": {"locality": "Anytown"}, "locationState": {"isVerified": True},
        }]

    with mock.patch.object(provider, "is_configured", return_value=True), \
         mock.patch.object(ga, "list_accounts", return_value=accounts), \
         mock.patch.object(ga, "list_locations", side_effect=fake_list_locations):
        locations = provider.discover_locations()

    assert len(locations) == 1, f"expected exactly 1 location from the surviving account, got {len(locations)}"
    assert locations[0].name == "Working Location"


def main():
    tests = [
        ("discover_locations(): zero accounts raises ProviderAuthError, never an empty list", test_zero_accounts_raises_provider_auth_error_not_empty_list),
        ("discover_locations(): not configured raises ProviderConfigError before any API call", test_not_configured_raises_provider_config_error_before_any_api_call),
        ("discover_locations(): one account's failure doesn't abort discovery for other accounts", test_one_account_failing_does_not_abort_discovery_for_others),
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
