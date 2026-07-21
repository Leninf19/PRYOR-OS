"""
Regression tests for provider_base.py (Phase 3 Milestone 1) -- the common
Provider contract, its dataclasses, and its exception hierarchy.

Run directly: py tests/test_provider_base.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from provider_base import (
    Provider, ProviderLocation, ProviderReview,
    ProviderError, ProviderAuthError, ProviderRateLimitError,
    ProviderPermissionError, ProviderNotFoundError, ProviderServerError,
    ProviderConfigError, ProviderParsingError,
    CAP_READ_REVIEWS, CAP_REPLY, CAP_DELETE_REPLY,
)

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


def test_provider_error_defaults():
    err = ProviderError("something broke")
    assert err.status is None
    assert err.retryable is False
    assert str(err) == "something broke"


def test_provider_error_carries_status_and_retryable():
    err = ProviderError("rate limited", status=429, retryable=True)
    assert err.status == 429
    assert err.retryable is True


def test_every_subclass_is_a_provider_error():
    for subclass in (ProviderAuthError, ProviderRateLimitError, ProviderPermissionError,
                      ProviderNotFoundError, ProviderServerError, ProviderConfigError):
        assert issubclass(subclass, ProviderError), f"{subclass.__name__} must inherit from ProviderError"
        instance = subclass("test message")
        assert isinstance(instance, ProviderError)
        assert isinstance(instance, Exception)


def test_provider_location_defaults():
    loc = ProviderLocation(external_id=None, name="Test Location")
    assert loc.external_id is None
    assert loc.name == "Test Location"
    assert loc.city == ""
    assert loc.address == {}
    assert loc.verification_status is None
    assert loc.search_query == ""
    assert loc.maps_url == ""


def test_provider_location_full_fields():
    loc = ProviderLocation(
        external_id="accounts/123/locations/456", name="Casa Tequila Brighton",
        city="Brighton", address={"locality": "Brighton"},
        verification_status="VERIFIED", search_query="Casa Tequila Brighton MI",
        maps_url="https://maps.google.com/x",
    )
    assert loc.external_id == "accounts/123/locations/456"
    assert loc.address == {"locality": "Brighton"}


def test_provider_location_metadata_defaults_empty_and_is_independent_per_instance():
    """provider_metadata must default to an empty dict, and -- since it's a
    mutable default -- each instance must get its OWN dict, not a single
    dict object shared/mutated across every ProviderLocation ever created
    (the classic Python mutable-default-argument trap, avoided here via
    dataclasses.field(default_factory=dict))."""
    a = ProviderLocation(external_id="1", name="A")
    b = ProviderLocation(external_id="2", name="B")
    assert a.provider_metadata == {}
    a.provider_metadata["account_name"] = "accounts/123"
    assert b.provider_metadata == {}, "mutating one instance's metadata must never leak into another instance"


def test_provider_review_as_row_matches_db_upsert_review_expected_keys():
    """db.upsert_review()'s `row` dict is read via row.get(...) for exactly
    these keys (db.py: reviewer_name, review_date, star_rating, review_text,
    owner_response, review_url, gbp_review_name, gbp_update_time,
    gbp_reply_update_time, gbp_language_code) -- as_row() must produce
    precisely this shape so introducing a Provider never requires a
    storage-layer change."""
    review = ProviderReview(
        reviewer_name="Jane Doe", review_date="2026-07-01", star_rating=5,
        review_text="Great food!", owner_response="Thank you!",
        review_url="https://maps.google.com/review/x",
        gbp_review_name="accounts/1/locations/2/reviews/3",
        gbp_update_time="2026-07-01T12:00:00Z",
        gbp_reply_update_time="2026-07-02T12:00:00Z",
        gbp_language_code="en",
    )
    row = review.as_row()
    expected_keys = {
        "reviewer_name", "review_date", "star_rating", "review_text",
        "owner_response", "review_url", "gbp_review_name", "gbp_update_time",
        "gbp_reply_update_time", "gbp_language_code",
    }
    assert set(row.keys()) == expected_keys, f"as_row() keys {set(row.keys())} must exactly match db.upsert_review()'s expected shape"
    assert row["reviewer_name"] == "Jane Doe"
    assert row["star_rating"] == 5
    assert row["gbp_review_name"] == "accounts/1/locations/2/reviews/3"


def test_provider_review_defaults_for_scraper_sourced_row():
    """A scraper-sourced review (no Google identity) must leave every
    gbp_* field as None, matching db.upsert_review()'s documented
    "always absent (None) for scraper-sourced rows" contract."""
    review = ProviderReview(reviewer_name="John Smith", review_date="2026-07-01", star_rating=3)
    row = review.as_row()
    assert row["gbp_review_name"] is None
    assert row["gbp_update_time"] is None
    assert row["gbp_reply_update_time"] is None
    assert row["gbp_language_code"] is None
    assert row["review_text"] == ""
    assert row["owner_response"] == ""
    assert row["review_url"] == ""


def test_provider_cannot_be_instantiated_directly():
    """Provider is an ABC -- a subclass that forgets an abstract method
    must fail loudly at instantiation, not silently at first use."""
    try:
        Provider()
        raise AssertionError("expected TypeError instantiating the abstract Provider class directly")
    except TypeError:
        pass


def test_incomplete_provider_subclass_cannot_be_instantiated():
    class IncompleteProvider(Provider):
        name = "incomplete"

        def is_configured(self):
            return True
        # discover_locations() and fetch_reviews() deliberately omitted

    try:
        IncompleteProvider()
        raise AssertionError("expected TypeError -- missing abstract methods")
    except TypeError:
        pass


def test_complete_provider_subclass_can_be_instantiated_and_reply_defaults_to_not_implemented():
    class CompleteProvider(Provider):
        name = "complete"

        def is_configured(self):
            return True

        def discover_locations(self):
            return []

        def fetch_reviews(self, location, *, fast=False):
            return []

    instance = CompleteProvider()
    assert instance.is_configured() is True
    assert instance.discover_locations() == []
    try:
        instance.reply_to_review("some/review", "thanks!")
        raise AssertionError("expected NotImplementedError from the default reply_to_review()")
    except NotImplementedError as e:
        assert "complete" in str(e)


def test_provider_parsing_error_is_a_provider_error():
    """Phase 3 Milestone 2: ProviderParsingError -- the response was
    reachable but could not be parsed / had an unexpected structure (e.g.
    the scraper's page loaded but its DOM didn't match what was expected)."""
    assert issubclass(ProviderParsingError, ProviderError)
    err = ProviderParsingError("could not find the reviews tab")
    assert isinstance(err, ProviderError)
    assert err.retryable is False  # default, same as every other ProviderError subclass


def test_provider_capabilities_default_to_empty_frozenset():
    """Phase 3 Milestone 2: additive capabilities attribute. A Provider
    subclass that declares nothing beyond the ABC's abstract methods must
    default to capable-of-nothing, not silently inherit some other
    provider's capabilities."""
    class BareProvider(Provider):
        def is_configured(self):
            return True

        def discover_locations(self):
            return []

        def fetch_reviews(self, location, *, fast=False):
            return []

    assert BareProvider.capabilities == frozenset()
    assert BareProvider().expected_cadence_minutes is None


def test_provider_capabilities_are_declared_and_checkable_by_a_generic_caller():
    """A future UI/caller checks capabilities via `CAP_X in provider.capabilities`
    -- never by catching NotImplementedError from reply_to_review()."""
    class ReadOnlyProvider(Provider):
        capabilities = frozenset({CAP_READ_REVIEWS})

        def is_configured(self):
            return True

        def discover_locations(self):
            return []

        def fetch_reviews(self, location, *, fast=False):
            return []

    provider = ReadOnlyProvider()
    assert CAP_READ_REVIEWS in provider.capabilities
    assert CAP_REPLY not in provider.capabilities
    assert CAP_DELETE_REPLY not in provider.capabilities


def test_provider_identity_attributes_are_additive_with_safe_defaults():
    """Phase 3 Milestone 2: name/display_name/capabilities/expected_cadence_minutes
    are all additive class attributes with safe defaults -- a Provider
    subclass predating this milestone (conceptually) still instantiates fine
    without declaring any of them."""
    class MinimalProvider(Provider):
        def is_configured(self):
            return True

        def discover_locations(self):
            return []

        def fetch_reviews(self, location, *, fast=False):
            return []

    p = MinimalProvider()
    assert p.name == "unknown"
    assert p.display_name == "Unknown Provider"
    assert p.capabilities == frozenset()
    assert p.expected_cadence_minutes is None


def test_existing_gbp_provider_remains_compatible_with_the_new_additive_attributes():
    """Phase 3 Milestone 2's additive Provider changes must not require any
    change to the already-shipped GBPProvider beyond declaring its own
    capabilities/cadence -- it must still instantiate, still be a Provider,
    and its identity attributes must reflect what google_api.py/provider_gbp.py
    actually implement today."""
    from provider_gbp import GBPProvider
    provider = GBPProvider()
    assert isinstance(provider, Provider)
    assert provider.name == "gbp"
    assert provider.display_name == "Google Business Profile"
    assert provider.capabilities == frozenset({CAP_READ_REVIEWS, CAP_REPLY})
    assert provider.expected_cadence_minutes == 15


def main():
    run("ProviderError defaults (status=None, retryable=False)", test_provider_error_defaults)
    run("ProviderError carries status and retryable through", test_provider_error_carries_status_and_retryable)
    run("every ProviderError subclass is itself a ProviderError and an Exception", test_every_subclass_is_a_provider_error)
    run("ProviderLocation defaults", test_provider_location_defaults)
    run("ProviderLocation full field set", test_provider_location_full_fields)
    run("ProviderLocation.provider_metadata defaults to an empty dict, independent per instance", test_provider_location_metadata_defaults_empty_and_is_independent_per_instance)
    run("ProviderReview.as_row() matches db.upsert_review()'s exact expected keys", test_provider_review_as_row_matches_db_upsert_review_expected_keys)
    run("ProviderReview defaults produce None gbp_* fields for scraper-sourced rows", test_provider_review_defaults_for_scraper_sourced_row)
    run("Provider (the ABC itself) cannot be instantiated directly", test_provider_cannot_be_instantiated_directly)
    run("a Provider subclass missing an abstract method cannot be instantiated", test_incomplete_provider_subclass_cannot_be_instantiated)
    run("a complete Provider subclass instantiates; reply_to_review() defaults to NotImplementedError", test_complete_provider_subclass_can_be_instantiated_and_reply_defaults_to_not_implemented)
    run("ProviderParsingError is a ProviderError (Phase 3 Milestone 2)", test_provider_parsing_error_is_a_provider_error)
    run("Provider.capabilities defaults to an empty frozenset", test_provider_capabilities_default_to_empty_frozenset)
    run("capabilities are declared and checkable via `CAP_X in provider.capabilities`", test_provider_capabilities_are_declared_and_checkable_by_a_generic_caller)
    run("identity attributes (name/display_name/capabilities/cadence) are additive with safe defaults", test_provider_identity_attributes_are_additive_with_safe_defaults)
    run("existing GBPProvider remains compatible with the new additive attributes", test_existing_gbp_provider_remains_compatible_with_the_new_additive_attributes)

    print()
    if all(results):
        print(f"ALL {len(results)} TESTS PASSED")
        return 0
    print(f"{results.count(False)} of {len(results)} TESTS FAILED")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
