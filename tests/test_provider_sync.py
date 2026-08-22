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
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
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


# --- Run-lifecycle resilience: every run must get a terminal status ----------
# (the run #159 incident: a non-ProviderError exception escaping the
# per-location loop left a scraper_runs row at status='running' forever,
# with no finished_at, since nothing wrapped that loop in a try/except.)

async def _latest_run_row(conn=None):
    conn = conn or db.get_connection()
    row = conn.execute("SELECT * FROM scraper_runs ORDER BY id DESC LIMIT 1").fetchone()
    return dict(row)


async def test_non_provider_error_during_fetch_still_gets_terminal_status_and_reraises():
    """A raw, unclassified exception (never wrapped as ProviderError -- e.g.
    an uncaught Playwright crash) during a location's fetch must still
    propagate uncaught (preserving the existing "genuinely unexpected errors
    crash loudly" contract -- see
    test_non_provider_error_during_discovery_propagates_uncaught above) AND
    must leave the run row with a terminal status, not stuck at 'running'."""
    _fresh_db()
    loc = ProviderLocation(external_id=None, name="Casa Tequila Testtown", city="Testtown")
    provider = FakeProvider(
        locations=[loc],
        fetch_errors={"Casa Tequila Testtown": RuntimeError("simulated browser crash")},
    )
    try:
        await provider_sync.sync_all(provider)
        raise AssertionError("expected the RuntimeError to propagate, not be swallowed")
    except RuntimeError as e:
        assert "simulated browser crash" in str(e)

    row = await _latest_run_row()
    assert row["status"] == "failed", row
    assert row["finished_at"] is not None, "a terminal run must always have finished_at set"
    assert "simulated browser crash" in (row["error_summary"] or "")


async def test_cancelled_error_during_fetch_marks_run_cancelled_and_reraises():
    _fresh_db()
    loc = ProviderLocation(external_id=None, name="Casa Tequila Testtown", city="Testtown")
    provider = FakeProvider(
        locations=[loc],
        fetch_errors={"Casa Tequila Testtown": asyncio.CancelledError()},
    )
    try:
        await provider_sync.sync_all(provider)
        raise AssertionError("expected CancelledError to propagate")
    except asyncio.CancelledError:
        pass

    row = await _latest_run_row()
    assert row["status"] == "cancelled", row
    assert row["finished_at"] is not None


async def test_successful_run_records_workflow_run_id_from_environment():
    _fresh_db()
    loc = ProviderLocation(external_id=None, name="Casa Tequila Testtown", city="Testtown")
    provider = FakeProvider(locations=[loc], reviews_by_name={"Casa Tequila Testtown": [_review()]})
    old = os.environ.get("GITHUB_RUN_ID")
    os.environ["GITHUB_RUN_ID"] = "123456789"
    try:
        await provider_sync.sync_all(provider)
    finally:
        if old is None:
            os.environ.pop("GITHUB_RUN_ID", None)
        else:
            os.environ["GITHUB_RUN_ID"] = old

    row = await _latest_run_row()
    assert row["workflow_run_id"] == "123456789", row


async def test_successful_run_after_an_abandoned_run_is_recorded_independently():
    """A previously-abandoned run (reconciled to 'timed_out' by the watchdog)
    must never block or corrupt a later, genuinely successful run -- each
    run is its own row, and reconciliation never touches review data."""
    _fresh_db()
    conn = db.get_connection()
    old_run_id = conn.execute(
        "INSERT INTO scraper_runs (started_at, mode, status, provider) VALUES (?, 'cloud', 'running', 'scraper')",
        ((datetime.now(timezone.utc) - timedelta(hours=10)).isoformat(),),
    ).lastrowid
    conn.commit()
    reconciled = provider_sync.reconcile_stuck_runs(conn, now=datetime.now(timezone.utc))
    assert [r["id"] for r in reconciled] == [old_run_id]
    conn.close()

    loc = ProviderLocation(external_id=None, name="Casa Tequila Testtown", city="Testtown")
    provider = FakeProvider(locations=[loc], reviews_by_name={"Casa Tequila Testtown": [_review()]})
    result = await provider_sync.sync_all(provider)
    assert result["status"] == "ok", result
    assert result["new"] == 1

    conn = db.get_connection()
    old_row = conn.execute("SELECT status FROM scraper_runs WHERE id = ?", (old_run_id,)).fetchone()
    new_row = conn.execute("SELECT status FROM scraper_runs WHERE id = ?", (result["run_id"],)).fetchone()
    conn.close()
    assert old_row["status"] == "timed_out", "the abandoned run's own status must be left untouched"
    assert new_row["status"] == "ok"


# --- Watchdog reconciliation (health_check.py's reconcile_stuck_runs) --------

async def test_reconcile_marks_only_runs_past_the_timeout():
    _fresh_db()
    conn = db.get_connection()
    now = datetime.now(timezone.utc)
    stuck_id = conn.execute(
        "INSERT INTO scraper_runs (started_at, mode, status) VALUES (?, 'cloud', 'running')",
        ((now - timedelta(hours=8)).isoformat(),),
    ).lastrowid
    fresh_id = conn.execute(
        "INSERT INTO scraper_runs (started_at, mode, status) VALUES (?, 'cloud', 'running')",
        ((now - timedelta(minutes=5)).isoformat(),),
    ).lastrowid
    conn.commit()

    reconciled = provider_sync.reconcile_stuck_runs(conn, now=now, timeout=timedelta(hours=6))
    assert [r["id"] for r in reconciled] == [stuck_id]

    rows = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM scraper_runs").fetchall()}
    conn.close()
    assert rows[stuck_id]["status"] == "timed_out"
    assert rows[stuck_id]["finished_at"] is not None
    assert rows[fresh_id]["status"] == "running", "a genuinely recent run must not be touched"
    assert rows[fresh_id]["finished_at"] is None


async def test_reconcile_never_touches_completed_runs_or_review_data():
    _fresh_db()
    conn = db.get_connection()
    now = datetime.now(timezone.utc)
    old_ok_id = conn.execute(
        "INSERT INTO scraper_runs (started_at, finished_at, mode, status) VALUES (?, ?, 'cloud', 'ok')",
        ((now - timedelta(hours=20)).isoformat(), (now - timedelta(hours=19)).isoformat()),
    ).lastrowid
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Kept Location', 'Testtown', 'Casa Tequila')")
    conn.commit()
    review_count_before = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]

    reconciled = provider_sync.reconcile_stuck_runs(conn, now=now, timeout=timedelta(hours=6))
    assert reconciled == []

    row = conn.execute("SELECT status FROM scraper_runs WHERE id = ?", (old_ok_id,)).fetchone()
    review_count_after = conn.execute("SELECT COUNT(*) c FROM reviews").fetchone()["c"]
    conn.close()
    assert row["status"] == "ok", "reconciliation must never touch an already-completed run"
    assert review_count_after == review_count_before


async def test_reconcile_is_idempotent_across_repeated_calls():
    """Calling reconciliation twice must never re-report or re-touch a row
    already reconciled -- it's a one-way transition out of 'running'."""
    _fresh_db()
    conn = db.get_connection()
    now = datetime.now(timezone.utc)
    stuck_id = conn.execute(
        "INSERT INTO scraper_runs (started_at, mode, status) VALUES (?, 'cloud', 'running')",
        ((now - timedelta(hours=8)).isoformat(),),
    ).lastrowid
    conn.commit()

    first = provider_sync.reconcile_stuck_runs(conn, now=now, timeout=timedelta(hours=6))
    second = provider_sync.reconcile_stuck_runs(conn, now=now + timedelta(hours=1), timeout=timedelta(hours=6))
    conn.close()
    assert [r["id"] for r in first] == [stuck_id]
    assert second == [], "an already-reconciled run must never be reconciled (or reported) again"


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


# --- GBP location collisions (Recovery Milestone 3) ---------------------------
#
# Real production case, found via gbp_location_diagnostic.py (2026-08-22):
# Casa Tequila Prime has two live GBP listings, same name and address --
#   accounts/109439479242615524495/locations/1272278994573166380  (linked, 61 real reviews)
#   accounts/109439479242615524495/locations/6020849166564084064  (duplicate, 0 reviews)
# The fixtures below use clearly-fake IDs (never the real ones above, which
# only appear in this comment for traceability) so no production identifier
# ever appears in application logic or test data.

def _link_local(name="Casa Tequila Prime", city="Testtown", gbp_location_name=None):
    conn = db.get_connection()
    conn.execute(
        "INSERT INTO locations (name, city, brand, gbp_account_name, gbp_location_name) "
        "VALUES (?, ?, 'Casa Tequila', ?, ?)",
        (name, city, "accounts/999" if gbp_location_name else None, gbp_location_name),
    )
    conn.commit()
    conn.close()


async def test_exact_resource_id_match_is_always_allowed():
    """Linked local row + rediscovering the SAME resource ID -- unaffected
    by the collision logic, exactly like before."""
    _fresh_db()
    _link_local(gbp_location_name="accounts/999/locations/AAA111")

    ploc = ProviderLocation(external_id="accounts/999/locations/AAA111", name="Casa Tequila Prime",
                             city="Testtown", provider_metadata={"account_name": "accounts/999"})
    provider = FakeProvider(locations=[ploc], reviews_by_name={"Casa Tequila Prime": [_review()]})
    result = await provider_sync.sync_all(provider)

    assert result["status"] == "ok", result
    assert result["location_collisions"] == [], result
    assert result["locations_succeeded"] == 1
    assert result["new"] == 1

    conn = db.get_connection()
    row = conn.execute("SELECT gbp_location_name FROM locations WHERE name = 'Casa Tequila Prime'").fetchone()
    conn.close()
    assert row["gbp_location_name"] == "accounts/999/locations/AAA111"


async def test_unlinked_local_row_unique_fuzzy_match_allowed_to_link():
    """A never-before-linked local row + one uniquely-matching discovered
    name -- an ordinary first-time link, not a collision."""
    _fresh_db()
    _link_local(gbp_location_name=None)  # not yet linked to any GBP resource

    ploc = ProviderLocation(external_id="accounts/999/locations/AAA111", name="Casa Tequila Prime",
                             city="Testtown", provider_metadata={"account_name": "accounts/999"})
    provider = FakeProvider(locations=[ploc], reviews_by_name={"Casa Tequila Prime": [_review()]})
    result = await provider_sync.sync_all(provider)

    assert result["location_collisions"] == [], result
    assert result["locations_succeeded"] == 1
    conn = db.get_connection()
    row = conn.execute("SELECT gbp_location_name FROM locations WHERE name = 'Casa Tequila Prime'").fetchone()
    conn.close()
    assert row["gbp_location_name"] == "accounts/999/locations/AAA111"


async def test_two_completely_different_names_no_collision():
    """Two discovered locations with genuinely different names never collide
    with each other or with an unrelated existing local row."""
    _fresh_db()
    _link_local(name="Casa Tequila Prime", gbp_location_name="accounts/999/locations/AAA111")

    ploc = ProviderLocation(external_id="accounts/999/locations/ZZZ999", name="Rio Luna Tacos",
                             city="Elsewhere", provider_metadata={"account_name": "accounts/999"})
    provider = FakeProvider(locations=[ploc], reviews_by_name={"Rio Luna Tacos": [_review()]})
    result = await provider_sync.sync_all(provider)

    assert result["location_collisions"] == [], result
    conn = db.get_connection()
    names = {r["name"] for r in conn.execute("SELECT name FROM locations").fetchall()}
    conn.close()
    assert "Rio Luna Tacos" in names, "a genuinely new, non-colliding location must still be created"


async def test_casa_tequila_prime_regression_duplicate_gbp_listing_blocked():
    """THE regression fixture for the real production case: a local row
    already linked to A, discovery returns the SAME business twice under
    two different resource IDs (B first, then A -- matching the real
    discovery order gbp_location_diagnostic.py observed). Asserts every
    behavior Recovery Milestone 3 requires."""
    _fresh_db()
    _link_local(gbp_location_name="accounts/999/locations/AAA111")

    ploc_b = ProviderLocation(external_id="accounts/999/locations/BBB222", name="Casa Tequila Prime",
                               city="Testtown", provider_metadata={"account_name": "accounts/999"})
    ploc_a = ProviderLocation(external_id="accounts/999/locations/AAA111", name="Casa Tequila Prime",
                               city="Testtown", provider_metadata={"account_name": "accounts/999"})
    provider = FakeProvider(locations=[ploc_b, ploc_a], reviews_by_name={"Casa Tequila Prime": [_review()]})
    result = await provider_sync.sync_all(provider)

    # local row remains linked to A; B never overwrites A
    conn = db.get_connection()
    row = conn.execute("SELECT id, gbp_location_name FROM locations WHERE name = 'Casa Tequila Prime'").fetchone()
    assert row["gbp_location_name"] == "accounts/999/locations/AAA111", \
        "B must never overwrite the existing A link"

    # collision is detected and surfaced in the result
    assert len(result["location_collisions"]) == 1, result
    collision = result["location_collisions"][0]
    assert collision["kind"] == "duplicate_gbp_listing"
    assert collision["existing_gbp_id"] == "accounts/999/locations/AAA111"
    assert collision["conflicting_gbp_id"] == "accounts/999/locations/BBB222"
    assert collision["location_id"] == row["id"]

    # collision is surfaced as a validation flag
    flag = conn.execute(
        "SELECT location_id, flag_type, detail, resolved_at FROM validation_flags "
        "WHERE flag_type = 'duplicate_gbp_listing'"
    ).fetchone()
    assert flag is not None, "a duplicate_gbp_listing validation flag must be written"
    assert flag["location_id"] == row["id"]
    assert flag["resolved_at"] is None
    assert "BBB222" in flag["detail"] and "AAA111" in flag["detail"]

    # B's reviews are not silently attached to A's local identity: only the
    # one review from the single fetch_reviews() call (against A, the only
    # entry that made it into `linked`) exists.
    reviews = conn.execute("SELECT COUNT(*) c FROM reviews WHERE location_id = ?", (row["id"],)).fetchone()
    assert reviews["c"] == 1, "exactly one review (fetched for A) must exist -- B was never fetched"

    # healthy accounting: the collision is not counted as a failure
    assert result["status"] == "ok", result
    assert result["locations_succeeded"] == 1, "only A was attempted -- B was excluded from linking entirely"
    assert result["locations_failed"] == 0, "a collision is not a fetch failure"
    conn.close()


async def test_collision_does_not_affect_healthy_locations_in_same_run():
    """A collision on one location must not prevent an unrelated, healthy
    location discovered in the same batch from syncing normally."""
    _fresh_db()
    _link_local(name="Casa Tequila Prime", gbp_location_name="accounts/999/locations/AAA111")
    conn = db.get_connection()
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Rio Luna Tacos', 'Elsewhere', 'Rio Luna')")
    conn.commit()
    conn.close()

    ploc_b = ProviderLocation(external_id="accounts/999/locations/BBB222", name="Casa Tequila Prime",
                               city="Testtown", provider_metadata={"account_name": "accounts/999"})
    ploc_healthy = ProviderLocation(external_id="accounts/999/locations/CCC333", name="Rio Luna Tacos",
                                     city="Elsewhere", provider_metadata={"account_name": "accounts/999"})
    provider = FakeProvider(
        locations=[ploc_b, ploc_healthy],
        reviews_by_name={"Rio Luna Tacos": [_review()]},
    )
    result = await provider_sync.sync_all(provider)

    assert result["status"] == "ok", result
    assert result["locations_succeeded"] == 1, "the healthy location must still sync despite the collision"
    assert len(result["location_collisions"]) == 1
    assert result["new"] == 1


async def test_ambiguous_fuzzy_match_never_chosen_arbitrarily():
    """A discovered name that fuzzy-matches MORE than one local row is
    ambiguous -- must never guess (the old next()-based fallback silently
    picked the first candidate). Neither 'Los Tres Amigos' nor 'Los Tres
    Amigos Jackson' normalizes to exactly 'lostresamigosjacksonheights' (so
    neither takes the exact-normalized-name path), but BOTH are substrings
    of it, which is exactly the ambiguity this guards against."""
    _fresh_db()
    conn = db.get_connection()
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Los Tres Amigos', 'Metro', 'Los Tres Amigos')")
    conn.execute("INSERT INTO locations (name, city, brand) VALUES ('Los Tres Amigos Jackson', 'Jackson', 'Los Tres Amigos')")
    conn.commit()
    conn.close()

    ploc = ProviderLocation(external_id="accounts/999/locations/DDD444", name="Los Tres Amigos Jackson Heights",
                             city="Jackson Heights", provider_metadata={"account_name": "accounts/999"})
    provider = FakeProvider(locations=[ploc], reviews_by_name={})
    result = await provider_sync.sync_all(provider)

    assert len(result["location_collisions"]) == 1, result
    assert result["location_collisions"][0]["kind"] == "ambiguous_fuzzy_match"
    assert result["locations_succeeded"] == 0, "an ambiguous match must not be linked to either candidate"

    conn = db.get_connection()
    rows = conn.execute("SELECT name, gbp_location_name FROM locations").fetchall()
    conn.close()
    for r in rows:
        assert r["gbp_location_name"] is None, \
            f"neither ambiguous candidate ({r['name']}) may be linked arbitrarily"


async def test_repeated_collision_across_multiple_runs_deterministic_no_duplicate_growth():
    """The same collision recurring on every sync (the expected state until
    the duplicate Google listing is merged/excluded) must stay at exactly
    one open validation flag, never grow, and never flip which resource ID
    is linked."""
    _fresh_db()
    _link_local(gbp_location_name="accounts/999/locations/AAA111")

    def _discovery():
        return [
            ProviderLocation(external_id="accounts/999/locations/BBB222", name="Casa Tequila Prime",
                              city="Testtown", provider_metadata={"account_name": "accounts/999"}),
            ProviderLocation(external_id="accounts/999/locations/AAA111", name="Casa Tequila Prime",
                              city="Testtown", provider_metadata={"account_name": "accounts/999"}),
        ]

    for _ in range(3):
        provider = FakeProvider(locations=_discovery(), reviews_by_name={"Casa Tequila Prime": [_review()]})
        result = await provider_sync.sync_all(provider)
        assert len(result["location_collisions"]) == 1, result

    conn = db.get_connection()
    open_flags = conn.execute(
        "SELECT COUNT(*) c FROM validation_flags WHERE flag_type = 'duplicate_gbp_listing' AND resolved_at IS NULL"
    ).fetchone()
    all_flags = conn.execute(
        "SELECT COUNT(*) c FROM validation_flags WHERE flag_type = 'duplicate_gbp_listing'"
    ).fetchone()
    row = conn.execute("SELECT gbp_location_name FROM locations WHERE name = 'Casa Tequila Prime'").fetchone()
    conn.close()
    assert open_flags["c"] == 1, "exactly one open flag after 3 runs -- no duplicate growth"
    assert all_flags["c"] == 1, "no resolved-then-reopened churn either -- the same row stays open throughout"
    assert row["gbp_location_name"] == "accounts/999/locations/AAA111", "A must never flip to B across repeated runs"


async def test_collision_flag_resolves_once_no_longer_detected():
    """If a future discovery run no longer finds the duplicate (the Google
    listing was merged/removed), the previously-open flag must resolve --
    matching validate.py's own resolve-when-condition-clears behavior."""
    _fresh_db()
    _link_local(gbp_location_name="accounts/999/locations/AAA111")

    colliding = FakeProvider(
        locations=[
            ProviderLocation(external_id="accounts/999/locations/BBB222", name="Casa Tequila Prime",
                              city="Testtown", provider_metadata={"account_name": "accounts/999"}),
            ProviderLocation(external_id="accounts/999/locations/AAA111", name="Casa Tequila Prime",
                              city="Testtown", provider_metadata={"account_name": "accounts/999"}),
        ],
        reviews_by_name={"Casa Tequila Prime": [_review()]},
    )
    await provider_sync.sync_all(colliding)

    conn = db.get_connection()
    still_open = conn.execute(
        "SELECT COUNT(*) c FROM validation_flags WHERE flag_type = 'duplicate_gbp_listing' AND resolved_at IS NULL"
    ).fetchone()["c"]
    conn.close()
    assert still_open == 1, "flag must be open after the colliding run"

    # Next run: the duplicate is gone (merged on Google's side).
    healthy = FakeProvider(
        locations=[
            ProviderLocation(external_id="accounts/999/locations/AAA111", name="Casa Tequila Prime",
                              city="Testtown", provider_metadata={"account_name": "accounts/999"}),
        ],
        reviews_by_name={"Casa Tequila Prime": [_review()]},
    )
    result = await provider_sync.sync_all(healthy)
    assert result["location_collisions"] == [], result

    conn = db.get_connection()
    resolved = conn.execute(
        "SELECT COUNT(*) c FROM validation_flags WHERE flag_type = 'duplicate_gbp_listing' AND resolved_at IS NOT NULL"
    ).fetchone()["c"]
    conn.close()
    assert resolved == 1, "the flag must resolve once the collision is no longer detected"


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
        ("a non-ProviderError exception during fetch still leaves a terminal status and reraises", test_non_provider_error_during_fetch_still_gets_terminal_status_and_reraises),
        ("a CancelledError during fetch marks the run 'cancelled' and reraises", test_cancelled_error_during_fetch_marks_run_cancelled_and_reraises),
        ("a successful run records workflow_run_id from $GITHUB_RUN_ID", test_successful_run_records_workflow_run_id_from_environment),
        ("a successful run after an abandoned/reconciled run is recorded independently", test_successful_run_after_an_abandoned_run_is_recorded_independently),
        ("reconcile_stuck_runs only marks runs past the timeout, leaves fresh ones alone", test_reconcile_marks_only_runs_past_the_timeout),
        ("reconcile_stuck_runs never touches completed runs or review data", test_reconcile_never_touches_completed_runs_or_review_data),
        ("reconcile_stuck_runs is idempotent across repeated calls", test_reconcile_is_idempotent_across_repeated_calls),
        ("a single location's failure is isolated -- status 'partial'", test_per_location_failure_is_isolated_status_partial),
        ("every location failing yields 'failed', not 'partial'", test_all_locations_failing_yields_status_failed_not_partial),
        ("new/edited/deleted statistics sum correctly across multiple locations", test_statistics_sum_correctly_across_multiple_locations),
        ("multiple external_id=None locations are linked independently, never collide", test_multiple_no_external_id_locations_do_not_collide),
        ("gbp_last_synced_at is only written for a location with a real external_id", test_gbp_info_only_written_when_external_id_present),
        ("exact resource-ID match is always allowed, unaffected by collision logic", test_exact_resource_id_match_is_always_allowed),
        ("an unlinked local row + a unique fuzzy name match is allowed to link", test_unlinked_local_row_unique_fuzzy_match_allowed_to_link),
        ("two completely different names never collide", test_two_completely_different_names_no_collision),
        ("Casa Tequila Prime regression: a duplicate GBP listing is blocked, not silently merged", test_casa_tequila_prime_regression_duplicate_gbp_listing_blocked),
        ("a location collision does not affect healthy locations synced in the same run", test_collision_does_not_affect_healthy_locations_in_same_run),
        ("an ambiguous fuzzy match (matches >1 local row) is never chosen arbitrarily", test_ambiguous_fuzzy_match_never_chosen_arbitrarily),
        ("a repeated collision across multiple runs stays deterministic, no duplicate flag growth", test_repeated_collision_across_multiple_runs_deterministic_no_duplicate_growth),
        ("a collision flag resolves once the collision is no longer detected", test_collision_flag_resolves_once_no_longer_detected),
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
