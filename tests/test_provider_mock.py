"""
Regression tests for provider_mock.py (Phase 3 Milestone 3) -- MockProvider,
the local-development-only Provider implementation that replays historical
review data from a snapshot database.

Every test builds its own tiny scratch snapshot DB via
tempfile.TemporaryDirectory() + db.init_schema() -- the same convention every
other test file in this repo already uses (test_export_chunks.py,
test_location_analytics.py) -- never the real, large, gitignored snapshot
MockProvider reads by default.

Run directly: py tests/test_provider_mock.py
"""
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import db
from provider_base import (
    ProviderLocation, ProviderAuthError, ProviderRateLimitError, ProviderServerError, CAP_READ_REVIEWS,
)
from provider_mock import MockProvider

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


class _ScratchSnapshot:
    """Context manager: a scratch snapshot DB with the real schema (via
    db.init_schema()), auto-cleaned up. `self.path` is the Path MockProvider
    should be pointed at."""

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "scratch_snapshot.db"
        conn = sqlite3.connect(str(self.path))
        conn.row_factory = sqlite3.Row
        db.init_schema(conn)
        self.conn = conn
        return self

    def __exit__(self, *exc):
        self.conn.close()
        self._tmp.cleanup()

    def add_location(self, name, city="City", brand="Brand", search_query="", maps_url="",
                      gbp_account_name=None, gbp_location_name=None, gbp_verification_status=None):
        cur = self.conn.execute(
            """INSERT INTO locations (name, city, brand, search_query, maps_url,
                                       gbp_account_name, gbp_location_name, gbp_verification_status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (name, city, brand, search_query, maps_url,
             gbp_account_name, gbp_location_name, gbp_verification_status),
        )
        self.conn.commit()
        return cur.lastrowid

    def add_review(self, location_id, reviewer_name, review_date, star_rating=5,
                    review_text="", owner_response="", review_url="", is_deleted=0,
                    gbp_review_name=None):
        key = f"{location_id}|{reviewer_name}|{review_date}|{star_rating}|{review_url}"
        self.conn.execute(
            """INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date,
                                     star_rating, review_text, owner_response, review_url,
                                     is_deleted, gbp_review_name, last_seen_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (location_id, key, reviewer_name, review_date, star_rating, review_text,
             owner_response, review_url, is_deleted, gbp_review_name, review_date),
        )
        self.conn.commit()


# --- Identity, capabilities, no-reply, is_configured ------------------------

def test_identity_and_capabilities():
    p = MockProvider()
    assert p.name == "mock"
    assert p.display_name == "Mock Provider (local dev)"
    assert p.capabilities == frozenset({CAP_READ_REVIEWS})
    assert p.expected_cadence_minutes is None


def test_reply_to_review_raises_not_implemented_mentioning_mock():
    p = MockProvider()
    try:
        p.reply_to_review("some/review", "thanks!")
        raise AssertionError("expected NotImplementedError")
    except NotImplementedError as e:
        assert "mock" in str(e)


def test_is_configured_false_when_snapshot_missing_true_when_present():
    with tempfile.TemporaryDirectory() as tmp:
        missing_path = Path(tmp) / "nope.db"
        assert MockProvider(snapshot_path=missing_path).is_configured() is False
    with _ScratchSnapshot() as snap:
        assert MockProvider(snapshot_path=snap.path).is_configured() is True


def test_unknown_fail_with_value_rejected_at_construction():
    try:
        MockProvider(fail_with="not_a_real_fault")
        raise AssertionError("expected ValueError for an unrecognized fail_with value")
    except ValueError:
        pass


# --- discover_locations() ---------------------------------------------------

def test_discover_locations_preserves_gbp_external_id_when_present():
    with _ScratchSnapshot() as snap:
        snap.add_location("Linked Loc", gbp_account_name="accounts/1",
                           gbp_location_name="accounts/1/locations/2",
                           gbp_verification_status="VERIFIED")
        loc = MockProvider(snapshot_path=snap.path).discover_locations()[0]
        assert loc.external_id == "accounts/1/locations/2"
        assert loc.verification_status == "VERIFIED"
        assert loc.provider_metadata == {"gbp_account_name": "accounts/1"}


def test_discover_locations_external_id_none_when_never_linked():
    with _ScratchSnapshot() as snap:
        snap.add_location("Unlinked Loc")
        loc = MockProvider(snapshot_path=snap.path).discover_locations()[0]
        assert loc.external_id is None
        assert loc.provider_metadata == {}


# --- fetch_reviews(): normal reads -------------------------------------------

def test_fetch_reviews_returns_reviews_newest_first():
    with _ScratchSnapshot() as snap:
        loc_id = snap.add_location("Loc A")
        snap.add_review(loc_id, "Bob", "2026-06-01", star_rating=3)
        snap.add_review(loc_id, "Alice", "2026-07-01", star_rating=5, review_text="Great!")
        p = MockProvider(snapshot_path=snap.path)
        location = p.discover_locations()[0]
        reviews = p.fetch_reviews(location)
        assert len(reviews) == 2
        assert reviews[0].reviewer_name == "Alice"
        assert reviews[0].review_text == "Great!"
        assert reviews[1].reviewer_name == "Bob"


def test_fetch_reviews_excludes_soft_deleted_rows():
    with _ScratchSnapshot() as snap:
        loc_id = snap.add_location("Loc A")
        snap.add_review(loc_id, "Alice", "2026-07-01")
        snap.add_review(loc_id, "Deleted Reviewer", "2026-06-01", is_deleted=1)
        p = MockProvider(snapshot_path=snap.path)
        location = p.discover_locations()[0]
        reviews = p.fetch_reviews(location)
        assert len(reviews) == 1
        assert reviews[0].reviewer_name == "Alice"


def test_fast_limits_to_20_most_recent():
    with _ScratchSnapshot() as snap:
        loc_id = snap.add_location("Loc A")
        for i in range(25):
            snap.add_review(loc_id, f"Reviewer{i}", f"2026-01-{i + 1:02d}")
        p = MockProvider(snapshot_path=snap.path)
        location = p.discover_locations()[0]
        assert len(p.fetch_reviews(location)) == 25
        assert len(p.fetch_reviews(location, fast=True)) == 20


def test_fetch_reviews_for_unknown_location_returns_empty_not_error():
    with _ScratchSnapshot() as snap:
        p = MockProvider(snapshot_path=snap.path)
        ghost = ProviderLocation(external_id=None, name="Ghost Location", city="", search_query="")
        assert p.fetch_reviews(ghost) == []


def test_gbp_fields_preserved_verbatim_for_a_gbp_sourced_snapshot_row():
    with _ScratchSnapshot() as snap:
        loc_id = snap.add_location("Loc A")
        snap.add_review(loc_id, "Alice", "2026-07-01", gbp_review_name="accounts/1/locations/2/reviews/3")
        p = MockProvider(snapshot_path=snap.path)
        location = p.discover_locations()[0]
        review = p.fetch_reviews(location)[0]
        assert review.gbp_review_name == "accounts/1/locations/2/reviews/3"


# --- Fault injection ---------------------------------------------------------

def test_fail_with_rate_limit_raises_retryable_from_both_methods():
    with _ScratchSnapshot() as snap:
        snap.add_location("Loc A")
        p = MockProvider(snapshot_path=snap.path, fail_with="rate_limit")
        try:
            p.discover_locations()
            raise AssertionError("expected ProviderRateLimitError from discover_locations")
        except ProviderRateLimitError as e:
            assert e.retryable is True

        location = ProviderLocation(external_id=None, name="Loc A", city="", search_query="")
        try:
            p.fetch_reviews(location)
            raise AssertionError("expected ProviderRateLimitError from fetch_reviews")
        except ProviderRateLimitError as e:
            assert e.retryable is True


def test_fail_with_outage_raises_retryable_server_error():
    with _ScratchSnapshot() as snap:
        snap.add_location("Loc A")
        p = MockProvider(snapshot_path=snap.path, fail_with="outage")
        try:
            p.discover_locations()
            raise AssertionError("expected ProviderServerError")
        except ProviderServerError as e:
            assert e.retryable is True


def test_fail_with_auth_error_raises_non_retryable_auth_error():
    with _ScratchSnapshot() as snap:
        snap.add_location("Loc A")
        p = MockProvider(snapshot_path=snap.path, fail_with="auth_error")
        try:
            p.discover_locations()
            raise AssertionError("expected ProviderAuthError")
        except ProviderAuthError as e:
            assert e.retryable is False


# --- Latency simulation -------------------------------------------------------

def test_latency_seconds_sleeps_the_configured_duration():
    with mock.patch("provider_mock.time.sleep") as sleep_mock, _ScratchSnapshot() as snap:
        snap.add_location("Loc A")
        MockProvider(snapshot_path=snap.path, latency_seconds=2.5).discover_locations()
        sleep_mock.assert_called_once_with(2.5)


def test_zero_latency_never_sleeps():
    with mock.patch("provider_mock.time.sleep") as sleep_mock, _ScratchSnapshot() as snap:
        snap.add_location("Loc A")
        MockProvider(snapshot_path=snap.path, latency_seconds=0).discover_locations()
        sleep_mock.assert_not_called()


# --- Mutation simulation -------------------------------------------------------

def test_simulate_mutations_off_by_default_never_mutates():
    with _ScratchSnapshot() as snap:
        loc_id = snap.add_location("Loc A")
        snap.add_review(loc_id, "Alice", "2026-07-01", review_text="Stable")
        p = MockProvider(snapshot_path=snap.path)
        location = p.discover_locations()[0]
        first = p.fetch_reviews(location)
        second = p.fetch_reviews(location)
        assert len(first) == len(second) == 1
        assert second[0].review_text == "Stable"


def test_simulate_mutations_second_call_edits_first_review_and_drops_last():
    with _ScratchSnapshot() as snap:
        loc_id = snap.add_location("Loc A")
        snap.add_review(loc_id, "Alice", "2026-07-03", review_text="Newest")
        snap.add_review(loc_id, "Bob", "2026-07-02", review_text="Middle")
        snap.add_review(loc_id, "Carol", "2026-07-01", review_text="Oldest")
        p = MockProvider(snapshot_path=snap.path, simulate_mutations=True)
        location = p.discover_locations()[0]

        first_call = p.fetch_reviews(location)
        assert len(first_call) == 3
        assert first_call[0].review_text == "Newest"

        second_call = p.fetch_reviews(location)
        assert len(second_call) == 2, "one fewer review -- simulated deletion"
        assert second_call[0].review_text == "Newest [mock-edited]", "first review simulated-edited"
        assert second_call[-1].review_text == "Middle", "the oldest review (Carol) was simulated-deleted"


def test_simulate_mutations_tracks_call_count_per_location_independently():
    with _ScratchSnapshot() as snap:
        loc_a = snap.add_location("Loc A")
        loc_b = snap.add_location("Loc B")
        snap.add_review(loc_a, "Alice", "2026-07-01", review_text="A review")
        snap.add_review(loc_b, "Bob", "2026-07-01", review_text="B review")
        p = MockProvider(snapshot_path=snap.path, simulate_mutations=True)
        locations = {l.name: l for l in p.discover_locations()}

        p.fetch_reviews(locations["Loc A"])  # Loc A: call 1
        p.fetch_reviews(locations["Loc A"])  # Loc A: call 2 -- now mutated

        loc_b_first_call = p.fetch_reviews(locations["Loc B"])  # Loc B: still call 1
        assert loc_b_first_call[0].review_text == "B review", \
            "a different location's call count must not be affected by Loc A's calls"


# --- Env var overrides ---------------------------------------------------------

def test_env_var_overrides_used_when_kwargs_not_passed():
    with mock.patch.dict(os.environ, {
        "MOCK_PROVIDER_FAIL_WITH": "outage",
        "MOCK_PROVIDER_LATENCY_SECONDS": "1.5",
        "MOCK_PROVIDER_SIMULATE_MUTATIONS": "true",
    }):
        p = MockProvider()
        assert p.fail_with == "outage"
        assert p.latency_seconds == 1.5
        assert p.simulate_mutations is True


def test_explicit_kwargs_take_precedence_over_env_vars():
    with mock.patch.dict(os.environ, {"MOCK_PROVIDER_FAIL_WITH": "outage"}):
        p = MockProvider(fail_with=None)  # explicitly forces "no fault" despite the env var
        assert p.fail_with is None


def test_defaults_with_no_env_vars_and_no_kwargs():
    with mock.patch.dict(os.environ, {}, clear=True):
        p = MockProvider()
        assert p.fail_with is None
        assert p.latency_seconds == 0.0
        assert p.simulate_mutations is False


def main():
    tests = [
        ("identity: name/display_name/capabilities/cadence", test_identity_and_capabilities),
        ("reply_to_review() raises NotImplementedError mentioning 'mock'", test_reply_to_review_raises_not_implemented_mentioning_mock),
        ("is_configured() reflects snapshot file presence", test_is_configured_false_when_snapshot_missing_true_when_present),
        ("an unrecognized fail_with value is rejected at construction", test_unknown_fail_with_value_rejected_at_construction),
        ("discover_locations() preserves gbp external_id when present", test_discover_locations_preserves_gbp_external_id_when_present),
        ("discover_locations() external_id is None when never linked", test_discover_locations_external_id_none_when_never_linked),
        ("fetch_reviews() returns reviews newest-first", test_fetch_reviews_returns_reviews_newest_first),
        ("fetch_reviews() excludes soft-deleted rows", test_fetch_reviews_excludes_soft_deleted_rows),
        ("fast=True limits to the 20 most recent reviews", test_fast_limits_to_20_most_recent),
        ("fetch_reviews() for an unknown location returns [] not an error", test_fetch_reviews_for_unknown_location_returns_empty_not_error),
        ("gbp_* fields are preserved verbatim for a gbp-sourced snapshot row", test_gbp_fields_preserved_verbatim_for_a_gbp_sourced_snapshot_row),
        ("fail_with='rate_limit' raises a retryable ProviderRateLimitError from both methods", test_fail_with_rate_limit_raises_retryable_from_both_methods),
        ("fail_with='outage' raises a retryable ProviderServerError", test_fail_with_outage_raises_retryable_server_error),
        ("fail_with='auth_error' raises a non-retryable ProviderAuthError", test_fail_with_auth_error_raises_non_retryable_auth_error),
        ("latency_seconds sleeps the configured duration", test_latency_seconds_sleeps_the_configured_duration),
        ("zero latency never sleeps", test_zero_latency_never_sleeps),
        ("simulate_mutations off by default never mutates", test_simulate_mutations_off_by_default_never_mutates),
        ("simulate_mutations: second call edits the first review and drops the last", test_simulate_mutations_second_call_edits_first_review_and_drops_last),
        ("simulate_mutations tracks call count per location independently", test_simulate_mutations_tracks_call_count_per_location_independently),
        ("env var overrides are used when kwargs aren't passed", test_env_var_overrides_used_when_kwargs_not_passed),
        ("explicit kwargs take precedence over env vars", test_explicit_kwargs_take_precedence_over_env_vars),
        ("defaults apply with no env vars and no kwargs", test_defaults_with_no_env_vars_and_no_kwargs),
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
