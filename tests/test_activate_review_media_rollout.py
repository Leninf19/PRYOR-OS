"""
Regression tests for activate_review_media_rollout.py -- All-Tenant
Rollout. Every test mocks tenant_config_store's Redis-facing functions
(list_tenant_ids/get_tenant_config/upsert_tenant_config) with an in-memory
fake, and tenant_paths.py's static registry (_TENANT_REVIEW_DB_REGISTRY)
with a synthetic dict -- no real Redis, no real tenant (including the
real t_los-tres-amigos) is ever touched. The REAL
activate_media_capture()/compute_media_capture_activation_patch()/
bootstrap_legacy_tenant_config() logic runs unmocked, so these tests
exercise the genuine CAS/preserve/bootstrap behavior, not a stand-in for it.

Run directly: py tests/test_activate_review_media_rollout.py
"""
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import activate_review_media_rollout as rollout
import tenant_config_store
import tenant_paths

results = []


def run(name, fn):
    try:
        fn()
        print(f"PASS: {name}")
        results.append(True)
    except Exception as e:
        print(f"FAIL: {name} -- {e}")
        results.append(False)


class FakeStore:
    """In-memory stand-in for the tenant_config:v1 Redis hash -- supports
    exactly the three operations this script needs (list/get/CAS-upsert),
    with real optimistic-concurrency semantics (a write only commits if
    the caller's expected_version still matches, INCLUDING expected_version=0
    for a genuinely nonexistent record -- the same atomic create-if-absent
    semantics the real tenant_config_store.py implements)."""

    def __init__(self):
        self.records: dict[str, dict] = {}

    def add(self, tenant_id: str, status="active", media_capture=None, config_version=1, storage_mode="BLOB"):
        self.records[tenant_id] = {
            "tenantId": tenant_id, "status": status, "storageMode": storage_mode,
            "mediaCapture": media_capture or {"status": "inactive", "startedAt": None},
            "configVersion": config_version,
        }

    def list_tenant_ids(self):
        return list(self.records.keys())

    def get_tenant_config(self, tenant_id):
        record = self.records.get(tenant_id)
        return dict(record) if record is not None else None

    def upsert_tenant_config(self, tenant_id, patch, expected_version=None):
        existing = self.records.get(tenant_id)
        current_version = existing.get("configVersion", 0) if existing else 0
        if expected_version is not None and current_version != expected_version:
            raise tenant_config_store.ConfigVersionConflictError(
                f"version conflict for {tenant_id!r}", dict(existing) if existing else None,
            )
        base = existing or {
            "tenantId": tenant_id, "status": "onboarding", "storageMode": "BLOB",
            "mediaCapture": {"status": "inactive", "startedAt": None},
        }
        next_record = {**base, **patch, "configVersion": current_version + 1}
        self.records[tenant_id] = next_record
        return dict(next_record)


def _patched(fake_store, static_ids=()):
    return (
        mock.patch.object(tenant_config_store, "list_tenant_ids", side_effect=fake_store.list_tenant_ids),
        mock.patch.object(tenant_config_store, "get_tenant_config", side_effect=fake_store.get_tenant_config),
        mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=fake_store.upsert_tenant_config),
        mock.patch.object(tenant_paths, "_TENANT_REVIEW_DB_REGISTRY", {t: f"/fake/{t}.db" for t in static_ids}),
    )


def test_empty_registry():
    fake = FakeStore()
    p1, p2, p3, p4 = _patched(fake)
    with p1, p2, p3, p4:
        report = rollout.run_rollout(apply=True)
    assert report["deduplicated_tenant_count"] == 0
    assert report["valid_tenants_considered"] == 0
    assert report["total_active_after_completion"] == 0
    assert all(v == 0 for v in report["counts"].values())


def test_multiple_tenants_dry_run():
    fake = FakeStore()
    fake.add("t_alpha")
    fake.add("t_beta")
    fake.add("t_gamma")
    p1, p2, p3, p4 = _patched(fake)
    with p1, p2, p3, p4:
        report = rollout.run_rollout(apply=False)
    assert report["deduplicated_tenant_count"] == 3
    assert report["valid_tenants_considered"] == 3
    assert report["counts"][rollout.RESULT_WOULD_ACTIVATE] == 3
    assert report["counts"][rollout.RESULT_ACTIVATED] == 0
    for tenant_id in ("t_alpha", "t_beta", "t_gamma"):
        assert fake.records[tenant_id]["mediaCapture"]["status"] == "inactive"


def test_multiple_tenants_apply():
    fake = FakeStore()
    fake.add("t_alpha")
    fake.add("t_beta")
    p1, p2, p3, p4 = _patched(fake)
    with p1, p2, p3, p4:
        report = rollout.run_rollout(apply=True)
    assert report["counts"][rollout.RESULT_ACTIVATED] == 2
    assert report["total_active_after_completion"] == 2
    for tenant_id in ("t_alpha", "t_beta"):
        assert fake.records[tenant_id]["mediaCapture"]["status"] == "active"
        assert fake.records[tenant_id]["mediaCapture"]["startedAt"] is not None


def test_already_active_tenant_not_rewritten():
    fake = FakeStore()
    fake.add("t_already", media_capture={"status": "active", "startedAt": "2026-01-01T00:00:00+00:00"})
    p1, p2, p3, p4 = _patched(fake)
    with p1, p2, p3, p4:
        report = rollout.run_rollout(apply=True)
    assert report["counts"][rollout.RESULT_ALREADY_ACTIVE] == 1
    assert report["counts"][rollout.RESULT_ACTIVATED] == 0
    assert fake.records["t_already"]["mediaCapture"]["startedAt"] == "2026-01-01T00:00:00+00:00"
    assert fake.records["t_already"]["configVersion"] == 1, "an already-active tenant must not even be written to"


def test_malformed_tenant_id_skipped_invalid():
    fake = FakeStore()
    fake.records["not-a-valid-tenant-id"] = {"tenantId": "not-a-valid-tenant-id", "status": "active", "configVersion": 1}
    p1, p2, p3, p4 = _patched(fake)
    with p1, p2, p3, p4:
        report = rollout.run_rollout(apply=True)
    assert report["counts"][rollout.RESULT_SKIPPED_INVALID] == 1
    assert report["valid_tenants_considered"] == 0


def test_non_active_status_skipped_invalid():
    fake = FakeStore()
    statuses = {
        "t_onboarding": "onboarding", "t_provisioning": "provisioning",
        "t_provisioning-failed": "provisioning_failed", "t_initial-sync-failed": "initial_sync_failed",
        "t_suspended": "suspended",
    }
    for tenant_id, status in statuses.items():
        fake.add(tenant_id, status=status)
    p1, p2, p3, p4 = _patched(fake)
    with p1, p2, p3, p4:
        report = rollout.run_rollout(apply=True)
    assert report["counts"][rollout.RESULT_SKIPPED_INVALID] == 5
    assert report["counts"][rollout.RESULT_ACTIVATED] == 0


def test_partial_failure_one_tenant_config_lookup_fails():
    fake = FakeStore()
    fake.add("t_good-one")
    fake.add("t_broken")
    fake.add("t_good-two")

    original_get = fake.get_tenant_config

    def flaky_get(tenant_id):
        if tenant_id == "t_broken":
            raise tenant_config_store.TenantConfigStoreUnavailableError("simulated outage for this one tenant")
        return original_get(tenant_id)

    with mock.patch.object(tenant_config_store, "list_tenant_ids", side_effect=fake.list_tenant_ids), \
         mock.patch.object(tenant_config_store, "get_tenant_config", side_effect=flaky_get), \
         mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=fake.upsert_tenant_config), \
         mock.patch.object(tenant_paths, "_TENANT_REVIEW_DB_REGISTRY", {}):
        report = rollout.run_rollout(apply=True)

    assert report["counts"][rollout.RESULT_FAILED] == 1
    assert report["counts"][rollout.RESULT_ACTIVATED] == 2, "a single tenant's failure must not block the others"
    assert fake.records["t_good-one"]["mediaCapture"]["status"] == "active"
    assert fake.records["t_good-two"]["mediaCapture"]["status"] == "active"


def test_duplicate_identifiers_processed_once():
    # Redis's own HKEYS can never return duplicates, but the underlying
    # set-union logic is verified defensively regardless: a tenant present
    # in BOTH the Redis registry and (hypothetically) reported twice is
    # still exactly one entry in the deduplicated union.
    fake = FakeStore()
    fake.add("t_dup")
    p1, p2, p3, p4 = _patched(fake)
    with p1, p2, p3, p4:
        report = rollout.run_rollout(apply=True)
    assert report["deduplicated_tenant_count"] == 1
    assert report["counts"][rollout.RESULT_ACTIVATED] == 1
    assert fake.records["t_dup"]["configVersion"] == 2


def test_cas_conflict_is_retried_and_succeeds():
    fake = FakeStore()
    fake.add("t_racy")
    call_count = {"n": 0}
    original_upsert = fake.upsert_tenant_config

    def flaky_upsert(tenant_id, patch, expected_version=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            fake.records[tenant_id]["configVersion"] += 1
            raise tenant_config_store.ConfigVersionConflictError("simulated concurrent write", dict(fake.records[tenant_id]))
        return original_upsert(tenant_id, patch, expected_version=expected_version)

    with mock.patch.object(tenant_config_store, "list_tenant_ids", side_effect=fake.list_tenant_ids), \
         mock.patch.object(tenant_config_store, "get_tenant_config", side_effect=fake.get_tenant_config), \
         mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=flaky_upsert), \
         mock.patch.object(tenant_paths, "_TENANT_REVIEW_DB_REGISTRY", {}):
        report = rollout.run_rollout(apply=True)

    assert report["counts"][rollout.RESULT_ACTIVATED] == 1
    assert report["counts"][rollout.RESULT_FAILED] == 0
    assert call_count["n"] == 2, "expected exactly one retry after the simulated conflict"
    assert fake.records["t_racy"]["mediaCapture"]["status"] == "active"


def test_cas_conflict_exhausting_retries_reports_failed():
    fake = FakeStore()
    fake.add("t_always-racy")

    def always_conflicting_upsert(tenant_id, patch, expected_version=None):
        fake.records[tenant_id]["configVersion"] += 1
        raise tenant_config_store.ConfigVersionConflictError("always conflicts", dict(fake.records[tenant_id]))

    with mock.patch.object(tenant_config_store, "list_tenant_ids", side_effect=fake.list_tenant_ids), \
         mock.patch.object(tenant_config_store, "get_tenant_config", side_effect=fake.get_tenant_config), \
         mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=always_conflicting_upsert), \
         mock.patch.object(tenant_paths, "_TENANT_REVIEW_DB_REGISTRY", {}):
        report = rollout.run_rollout(apply=True)

    assert report["counts"][rollout.RESULT_FAILED] == 1
    assert report["counts"][rollout.RESULT_ACTIVATED] == 0


def test_rerunning_after_success_is_a_safe_no_op():
    fake = FakeStore()
    fake.add("t_idempotent")
    p1, p2, p3, p4 = _patched(fake)
    with p1, p2, p3, p4:
        first = rollout.run_rollout(apply=True)
    assert first["counts"][rollout.RESULT_ACTIVATED] == 1
    started_at_after_first = fake.records["t_idempotent"]["mediaCapture"]["startedAt"]
    version_after_first = fake.records["t_idempotent"]["configVersion"]

    p1, p2, p3, p4 = _patched(fake)
    with p1, p2, p3, p4:
        second = rollout.run_rollout(apply=True)
    assert second["counts"][rollout.RESULT_ALREADY_ACTIVE] == 1
    assert second["counts"][rollout.RESULT_ACTIVATED] == 0
    assert fake.records["t_idempotent"]["mediaCapture"]["startedAt"] == started_at_after_first
    assert fake.records["t_idempotent"]["configVersion"] == version_after_first, "a rerun after success must not write at all"


def test_totals_reconcile_in_a_mixed_scenario():
    fake = FakeStore()
    fake.add("t_active-1")
    fake.add("t_active-2", media_capture={"status": "active", "startedAt": "2026-01-01T00:00:00+00:00"})
    fake.add("t_onboarding", status="onboarding")
    fake.records["malformed id"] = {"tenantId": "malformed id", "status": "active", "configVersion": 1}
    p1, p2, p3, p4 = _patched(fake)
    with p1, p2, p3, p4:
        report = rollout.run_rollout(apply=True)

    assert report["deduplicated_tenant_count"] == 4
    assert report["valid_tenants_considered"] == 2  # t_active-1, t_active-2 only
    assert report["counts"][rollout.RESULT_ALREADY_ACTIVE] == 1
    assert report["counts"][rollout.RESULT_ACTIVATED] == 1
    assert report["counts"][rollout.RESULT_SKIPPED_INVALID] == 2  # t_onboarding + malformed id
    assert report["counts"][rollout.RESULT_FAILED] == 0
    reconciled = report["valid_tenants_considered"] == sum(
        report["counts"][c] for c in rollout._ALL_RESULT_CATEGORIES if c != rollout.RESULT_SKIPPED_INVALID
    )
    assert reconciled
    assert report["total_active_after_completion"] == 2


def test_never_writes_any_field_other_than_media_capture_for_an_existing_record():
    fake = FakeStore()
    fake.add("t_narrow")
    original_upsert = fake.upsert_tenant_config

    def asserting_upsert(tenant_id, patch, expected_version=None):
        assert set(patch.keys()) == {"mediaCapture"}, f"activation of an EXISTING record must only ever patch mediaCapture, got {set(patch.keys())}"
        return original_upsert(tenant_id, patch, expected_version=expected_version)

    with mock.patch.object(tenant_config_store, "list_tenant_ids", side_effect=fake.list_tenant_ids), \
         mock.patch.object(tenant_config_store, "get_tenant_config", side_effect=fake.get_tenant_config), \
         mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=asserting_upsert), \
         mock.patch.object(tenant_paths, "_TENANT_REVIEW_DB_REGISTRY", {}):
        rollout.run_rollout(apply=True)


def test_dry_run_prints_no_credentials_or_google_calls():
    import urllib.request

    def poison(*a, **k):
        raise AssertionError("the rollout command must never make an HTTP call to anything but the config store")

    fake = FakeStore()
    fake.add("t_safe")
    original_urlopen = urllib.request.urlopen
    urllib.request.urlopen = poison
    try:
        p1, p2, p3, p4 = _patched(fake)
        with p1, p2, p3, p4:
            rollout.run_rollout(apply=False)
    finally:
        urllib.request.urlopen = original_urlopen


# ---------------------------------------------------------------------------
# Dual-registry union: static-registry (legacy) tenants + bootstrap.
# ---------------------------------------------------------------------------

def test_union_includes_static_only_tenant():
    fake = FakeStore()  # no Redis-registered tenants at all
    p1, p2, p3, p4 = _patched(fake, static_ids=["t_legacy-only"])
    with p1, p2, p3, p4:
        report = rollout.run_rollout(apply=False)
    assert report["static_registry_count"] == 1
    assert report["redis_registry_count"] == 0
    assert report["deduplicated_tenant_count"] == 1
    assert report["counts"][rollout.RESULT_WOULD_BOOTSTRAP_AND_ACTIVATE] == 1


def test_union_includes_redis_only_tenant():
    fake = FakeStore()
    fake.add("t_self-service")
    p1, p2, p3, p4 = _patched(fake, static_ids=[])
    with p1, p2, p3, p4:
        report = rollout.run_rollout(apply=False)
    assert report["static_registry_count"] == 0
    assert report["redis_registry_count"] == 1
    assert report["counts"][rollout.RESULT_WOULD_ACTIVATE] == 1


def test_overlapping_tenant_processed_exactly_once():
    fake = FakeStore()
    fake.add("t_both", status="active")  # already has a real record
    p1, p2, p3, p4 = _patched(fake, static_ids=["t_both"])  # ALSO in the static registry
    with p1, p2, p3, p4:
        report = rollout.run_rollout(apply=True)
    assert report["overlap_count"] == 1
    assert report["deduplicated_tenant_count"] == 1, "an id in both registries must count once, not twice"
    assert len(report["per_tenant"]) == 1
    assert report["counts"][rollout.RESULT_ACTIVATED] == 1  # activated normally -- record already existed, no bootstrap needed


def test_static_tenant_with_no_config_is_would_bootstrap_and_activate_dry_run():
    fake = FakeStore()
    p1, p2, p3, p4 = _patched(fake, static_ids=["t_legacy-tenant"])
    with p1, p2, p3, p4:
        report = rollout.run_rollout(apply=False)
    assert report["missing_legacy_config_count"] == 1
    assert report["counts"][rollout.RESULT_WOULD_BOOTSTRAP_AND_ACTIVATE] == 1
    assert "t_legacy-tenant" not in fake.records, "dry run must never write the bootstrap record"


def test_apply_bootstraps_and_activates_a_static_only_tenant():
    fake = FakeStore()
    p1, p2, p3, p4 = _patched(fake, static_ids=["t_legacy-tenant"])
    with p1, p2, p3, p4:
        report = rollout.run_rollout(apply=True)
    assert report["counts"][rollout.RESULT_BOOTSTRAPPED_AND_ACTIVATED] == 1
    record = fake.records["t_legacy-tenant"]
    assert record["status"] == "active"
    assert record["storageMode"] == "LEGACY_REPO"
    assert record["mediaCapture"]["status"] == "active"
    assert record["mediaCapture"]["startedAt"] is not None


def test_bootstrap_is_atomic_create_if_absent_never_overwrites():
    fake = FakeStore()
    # Pre-seed a record as if a concurrent process already bootstrapped it --
    # with DIFFERENT storageMode than bootstrap_legacy_tenant_config() would
    # choose, to prove the rollout's own write never overwrites it.
    fake.add("t_legacy-tenant", status="active", storage_mode="BLOB")
    with mock.patch.object(tenant_config_store, "get_tenant_config", side_effect=fake.get_tenant_config), \
         mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=fake.upsert_tenant_config), \
         mock.patch.object(tenant_paths, "_TENANT_REVIEW_DB_REGISTRY", {"t_legacy-tenant": "/fake/path.db"}):
        result = tenant_paths.bootstrap_legacy_tenant_config("t_legacy-tenant")
    assert result["storageMode"] == "BLOB", "an existing record must never be overwritten by bootstrap"
    assert fake.records["t_legacy-tenant"]["configVersion"] == 1


def test_unknown_tenant_cannot_be_bootstrapped():
    with mock.patch.object(tenant_paths, "_TENANT_REVIEW_DB_REGISTRY", {"t_legacy-tenant": "/fake/path.db"}):
        raised = False
        try:
            tenant_paths.bootstrap_legacy_tenant_config("t_completely-unknown")
        except tenant_paths.NotInStaticRegistryError:
            raised = True
        assert raised, "bootstrap must refuse any tenant_id not in the static registry"


def test_bootstrap_race_does_not_lose_data():
    """Simulates another process creating the record between this call's
    read (implicit inside upsert's own CAS check) and its own write --
    the caller must re-read and return the winning record, never error,
    never silently proceed as if its own (never-written) view were real."""
    fake = FakeStore()
    call_count = {"n": 0}
    original_upsert = fake.upsert_tenant_config

    def racy_upsert(tenant_id, patch, expected_version=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            # A "concurrent" writer wins first.
            fake.records[tenant_id] = {
                "tenantId": tenant_id, "status": "active", "storageMode": "LEGACY_REPO",
                "mediaCapture": {"status": "inactive", "startedAt": None}, "configVersion": 1,
            }
            raise tenant_config_store.ConfigVersionConflictError("lost the race", dict(fake.records[tenant_id]))
        return original_upsert(tenant_id, patch, expected_version=expected_version)

    with mock.patch.object(tenant_config_store, "get_tenant_config", side_effect=fake.get_tenant_config), \
         mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=racy_upsert), \
         mock.patch.object(tenant_paths, "_TENANT_REVIEW_DB_REGISTRY", {"t_legacy-tenant": "/fake/path.db"}):
        result = tenant_paths.bootstrap_legacy_tenant_config("t_legacy-tenant")
    assert result["status"] == "active"
    assert call_count["n"] == 1, "bootstrap must never retry its own create -- it re-reads and accepts the winner"


def test_lta_resolves_to_the_same_database_path_before_and_after_bootstrap():
    """The core safety claim of this whole change: creating a tenant_config
    record for a static-registry tenant must not alter its own review
    database resolution at all -- resolve_review_db_path() checks the
    static dict FIRST and returns before ever consulting tenant_config."""
    fake_path = Path("/fake/legacy-tenant-reviews.db")
    with mock.patch.object(tenant_paths, "_TENANT_REVIEW_DB_REGISTRY", {"t_legacy-tenant": fake_path}):
        before = tenant_paths.resolve_review_db_path("t_legacy-tenant")
        fake = FakeStore()
        with mock.patch.object(tenant_config_store, "get_tenant_config", side_effect=fake.get_tenant_config), \
             mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=fake.upsert_tenant_config):
            tenant_paths.bootstrap_legacy_tenant_config("t_legacy-tenant")
        after = tenant_paths.resolve_review_db_path("t_legacy-tenant")
    assert before == after == fake_path


def main() -> int:
    tests = [
        ("empty registry", test_empty_registry),
        ("multiple tenants -- dry run performs zero writes", test_multiple_tenants_dry_run),
        ("multiple tenants -- apply activates all", test_multiple_tenants_apply),
        ("an already-active tenant is not rewritten", test_already_active_tenant_not_rewritten),
        ("a malformed tenant id is skipped_invalid", test_malformed_tenant_id_skipped_invalid),
        ("a non-'active' status is skipped_invalid", test_non_active_status_skipped_invalid),
        ("one tenant's config-lookup failure doesn't block the others", test_partial_failure_one_tenant_config_lookup_fails),
        ("duplicate identifiers from the union are processed once", test_duplicate_identifiers_processed_once),
        ("a CAS conflict is retried and succeeds", test_cas_conflict_is_retried_and_succeeds),
        ("exhausting CAS retries reports failed", test_cas_conflict_exhausting_retries_reports_failed),
        ("rerunning after success is a safe no-op", test_rerunning_after_success_is_a_safe_no_op),
        ("totals reconcile in a mixed scenario", test_totals_reconcile_in_a_mixed_scenario),
        ("never writes any field other than mediaCapture for an existing record", test_never_writes_any_field_other_than_media_capture_for_an_existing_record),
        ("no HTTP call is ever made outside the config store", test_dry_run_prints_no_credentials_or_google_calls),
        ("the union includes a static-only tenant", test_union_includes_static_only_tenant),
        ("the union includes a Redis-only tenant", test_union_includes_redis_only_tenant),
        ("an overlapping tenant (both registries) is processed exactly once", test_overlapping_tenant_processed_exactly_once),
        ("a static tenant with no config is would_bootstrap_and_activate on dry run", test_static_tenant_with_no_config_is_would_bootstrap_and_activate_dry_run),
        ("apply bootstraps and activates a static-only tenant", test_apply_bootstraps_and_activates_a_static_only_tenant),
        ("bootstrap is atomic create-if-absent -- never overwrites", test_bootstrap_is_atomic_create_if_absent_never_overwrites),
        ("an unknown tenant cannot be bootstrapped", test_unknown_tenant_cannot_be_bootstrapped),
        ("a bootstrap race does not lose data", test_bootstrap_race_does_not_lose_data),
        ("a static tenant resolves to the same DB path before/after bootstrap", test_lta_resolves_to_the_same_database_path_before_and_after_bootstrap),
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
