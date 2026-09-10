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
import tenant_keys
from provider_base import ProviderAuthError, ProviderConfigError
from provider_gbp import GBPProvider

SYNTHETIC_TENANT_ID = "t_synthetic-second-tenant"
TEST_TENANT_ID = tenant_keys.DEFAULT_TENANT_ID

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
    provider = GBPProvider(tenant_id=TEST_TENANT_ID)
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
    provider = GBPProvider(tenant_id=TEST_TENANT_ID)
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
    provider = GBPProvider(tenant_id=TEST_TENANT_ID)
    accounts = [{"name": "accounts/1"}, {"name": "accounts/2"}]

    def fake_list_locations(tenant_id, account_name):
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


# --- Multi-Tenant Phase 4C -------------------------------------------------

def test_zero_arg_construction_fails_closed_no_implicit_default():
    """Multi-Tenant Phase 4C revision: an earlier pass gave GBPProvider() a
    Los Tres Amigos default so every existing call site kept working
    unchanged -- rejected on review, because it meant any caller that
    forgot to pass a tenant silently operated as Los Tres Amigos instead of
    failing. There is now NO default at all: constructing without a
    tenant_id must raise TypeError before anything else happens."""
    try:
        GBPProvider()
        raise AssertionError("expected TypeError for a missing tenant_id -- GBPProvider must never default")
    except TypeError:
        pass


def test_provider_threads_its_own_tenant_id_into_every_google_api_call():
    """A GBPProvider constructed for a synthetic tenant must pass THAT
    tenant_id to every google_api.py call it makes -- proving the class
    itself is the explicit, validated tenantId carrier the Phase 4C
    architecture requires, not something each call site has to remember."""
    provider = GBPProvider(tenant_id=SYNTHETIC_TENANT_ID)
    captured = {}

    def fake_list_accounts(tenant_id):
        captured["list_accounts_tenant"] = tenant_id
        return [{"name": "accounts/1"}]

    def fake_list_locations(tenant_id, account_name):
        captured["list_locations_tenant"] = tenant_id
        return []

    with mock.patch.object(provider, "is_configured", return_value=True), \
         mock.patch.object(ga, "list_accounts", side_effect=fake_list_accounts), \
         mock.patch.object(ga, "list_locations", side_effect=fake_list_locations):
        provider.discover_locations()

    assert captured["list_accounts_tenant"] == SYNTHETIC_TENANT_ID
    assert captured["list_locations_tenant"] == SYNTHETIC_TENANT_ID


def test_two_providers_for_different_tenants_never_cross_call():
    """Adversarial: construct one provider per tenant and drive both --
    each must only ever request ITS OWN tenant's accounts, proving one
    provider instance can never be tricked into acting for another
    tenant's credential merely by both existing in the same process."""
    lta_provider = GBPProvider(tenant_id=TEST_TENANT_ID)
    tenant_b_provider = GBPProvider(tenant_id=SYNTHETIC_TENANT_ID)
    seen_tenants = []

    def fake_list_accounts(tenant_id):
        seen_tenants.append(tenant_id)
        return []  # empty is fine -- we only care which tenant was asked for

    with mock.patch.object(lta_provider, "is_configured", return_value=True), \
         mock.patch.object(tenant_b_provider, "is_configured", return_value=True), \
         mock.patch.object(ga, "list_accounts", side_effect=fake_list_accounts):
        for provider in (lta_provider, tenant_b_provider):
            try:
                provider.discover_locations()
            except ProviderAuthError:
                pass  # expected for the empty-accounts case; we only assert on seen_tenants

    assert seen_tenants == [TEST_TENANT_ID, SYNTHETIC_TENANT_ID], (
        f"each provider must request exactly its own tenant, got {seen_tenants}"
    )


def test_invalid_tenant_id_rejected_at_construction():
    for bad in (None, "", "not-a-tenant-id", "T_LOS-TRES-AMIGOS"):
        try:
            GBPProvider(tenant_id=bad)
            raise AssertionError(f"expected InvalidTenantIdError for {bad!r}")
        except tenant_keys.InvalidTenantIdError:
            pass


def main():
    tests = [
        ("discover_locations(): zero accounts raises ProviderAuthError, never an empty list", test_zero_accounts_raises_provider_auth_error_not_empty_list),
        ("discover_locations(): not configured raises ProviderConfigError before any API call", test_not_configured_raises_provider_config_error_before_any_api_call),
        ("discover_locations(): one account's failure doesn't abort discovery for other accounts", test_one_account_failing_does_not_abort_discovery_for_others),
        ("GBPProvider() with no tenant_id fails closed (TypeError), never defaults to Los Tres Amigos", test_zero_arg_construction_fails_closed_no_implicit_default),
        ("GBPProvider threads its own tenant_id into every google_api.py call", test_provider_threads_its_own_tenant_id_into_every_google_api_call),
        ("two providers for different tenants never cross-call each other's tenant", test_two_providers_for_different_tenants_never_cross_call),
        ("an invalid tenant_id is rejected at GBPProvider construction", test_invalid_tenant_id_rejected_at_construction),
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
