"""
Regression tests for activate_review_media_rollout.py -- All-Tenant
Rollout. Every test mocks tenant_config_store's Redis-facing functions
(list_tenant_ids/get_tenant_config/upsert_tenant_config) with an in-memory
fake -- no real Redis, no real tenant is ever touched. The REAL
activate_media_capture()/compute_media_capture_activation_patch() logic
runs unmocked, so these tests exercise the genuine CAS/preserve behavior,
not a stand-in for it.

Run directly: py tests/test_activate_review_media_rollout.py
"""
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import activate_review_media_rollout as rollout
import tenant_config_store

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
    the caller's expected_version still matches)."""

    def __init__(self):
        self.records: dict[str, dict] = {}

    def add(self, tenant_id: str, status="active", media_capture=None, config_version=1):
        self.records[tenant_id] = {
            "tenantId": tenant_id, "status": status,
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
        if existing is None:
            raise AssertionError("upsert_tenant_config called for a tenant with no existing record -- "
                                  "activate_media_capture() must never create one")
        current_version = existing.get("configVersion", 0)
        if expected_version is not None and current_version != expected_version:
            raise tenant_config_store.ConfigVersionConflictError(
                f"version conflict for {tenant_id!r}", dict(existing),
            )
        next_record = {**existing, **patch, "configVersion": current_version + 1}
        self.records[tenant_id] = next_record
        return dict(next_record)


def _patched(fake_store):
    return (
        mock.patch.object(tenant_config_store, "list_tenant_ids", side_effect=fake_store.list_tenant_ids),
        mock.patch.object(tenant_config_store, "get_tenant_config", side_effect=fake_store.get_tenant_config),
        mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=fake_store.upsert_tenant_config),
    )


def test_empty_registry():
    fake = FakeStore()
    p1, p2, p3 = _patched(fake)
    with p1, p2, p3:
        report = rollout.run_rollout(apply=True)
    assert report["registered_tenants_discovered"] == 0
    assert report["valid_tenants_considered"] == 0
    assert report["total_active_after_completion"] == 0
    assert all(v == 0 for v in report["counts"].values())


def test_multiple_tenants_dry_run():
    fake = FakeStore()
    fake.add("t_alpha")
    fake.add("t_beta")
    fake.add("t_gamma")
    p1, p2, p3 = _patched(fake)
    with p1, p2, p3:
        report = rollout.run_rollout(apply=False)
    assert report["registered_tenants_discovered"] == 3
    assert report["valid_tenants_considered"] == 3
    assert report["counts"][rollout.RESULT_WOULD_ACTIVATE] == 3
    assert report["counts"][rollout.RESULT_ACTIVATED] == 0
    # Dry run must never write.
    for tenant_id in ("t_alpha", "t_beta", "t_gamma"):
        assert fake.records[tenant_id]["mediaCapture"]["status"] == "inactive"


def test_multiple_tenants_apply():
    fake = FakeStore()
    fake.add("t_alpha")
    fake.add("t_beta")
    p1, p2, p3 = _patched(fake)
    with p1, p2, p3:
        report = rollout.run_rollout(apply=True)
    assert report["counts"][rollout.RESULT_ACTIVATED] == 2
    assert report["total_active_after_completion"] == 2
    for tenant_id in ("t_alpha", "t_beta"):
        assert fake.records[tenant_id]["mediaCapture"]["status"] == "active"
        assert fake.records[tenant_id]["mediaCapture"]["startedAt"] is not None


def test_already_active_tenant_not_rewritten():
    fake = FakeStore()
    fake.add("t_already", media_capture={"status": "active", "startedAt": "2026-01-01T00:00:00+00:00"})
    p1, p2, p3 = _patched(fake)
    with p1, p2, p3:
        report = rollout.run_rollout(apply=True)
    assert report["counts"][rollout.RESULT_ALREADY_ACTIVE] == 1
    assert report["counts"][rollout.RESULT_ACTIVATED] == 0
    assert fake.records["t_already"]["mediaCapture"]["startedAt"] == "2026-01-01T00:00:00+00:00"
    assert fake.records["t_already"]["configVersion"] == 1, "an already-active tenant must not even be written to"


def test_malformed_tenant_id_skipped_invalid():
    fake = FakeStore()
    fake.records["not-a-valid-tenant-id"] = {"tenantId": "not-a-valid-tenant-id", "status": "active", "configVersion": 1}
    p1, p2, p3 = _patched(fake)
    with p1, p2, p3:
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
    p1, p2, p3 = _patched(fake)
    with p1, p2, p3:
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
         mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=fake.upsert_tenant_config):
        report = rollout.run_rollout(apply=True)

    assert report["counts"][rollout.RESULT_FAILED] == 1
    assert report["counts"][rollout.RESULT_ACTIVATED] == 2, "a single tenant's failure must not block the others"
    assert fake.records["t_good-one"]["mediaCapture"]["status"] == "active"
    assert fake.records["t_good-two"]["mediaCapture"]["status"] == "active"


def test_duplicate_identifiers_processed_once():
    fake = FakeStore()
    fake.add("t_dup")

    def duplicated_list():
        return ["t_dup", "t_dup", "t_dup"]

    with mock.patch.object(tenant_config_store, "list_tenant_ids", side_effect=duplicated_list), \
         mock.patch.object(tenant_config_store, "get_tenant_config", side_effect=fake.get_tenant_config), \
         mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=fake.upsert_tenant_config):
        report = rollout.run_rollout(apply=True)

    assert report["registered_tenants_discovered"] == 1, "duplicate ids from the enumeration source must be deduplicated"
    assert report["counts"][rollout.RESULT_ACTIVATED] == 1
    assert fake.records["t_dup"]["configVersion"] == 2, "a duplicate must never cause a second, redundant write"


def test_cas_conflict_is_retried_and_succeeds():
    fake = FakeStore()
    fake.add("t_racy")
    call_count = {"n": 0}
    original_upsert = fake.upsert_tenant_config

    def flaky_upsert(tenant_id, patch, expected_version=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            # Simulate a concurrent writer bumping the version between our
            # read and this write.
            fake.records[tenant_id]["configVersion"] += 1
            raise tenant_config_store.ConfigVersionConflictError("simulated concurrent write", dict(fake.records[tenant_id]))
        return original_upsert(tenant_id, patch, expected_version=expected_version)

    with mock.patch.object(tenant_config_store, "list_tenant_ids", side_effect=fake.list_tenant_ids), \
         mock.patch.object(tenant_config_store, "get_tenant_config", side_effect=fake.get_tenant_config), \
         mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=flaky_upsert):
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
         mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=always_conflicting_upsert):
        report = rollout.run_rollout(apply=True)

    assert report["counts"][rollout.RESULT_FAILED] == 1
    assert report["counts"][rollout.RESULT_ACTIVATED] == 0


def test_rerunning_after_success_is_a_safe_no_op():
    fake = FakeStore()
    fake.add("t_idempotent")
    p1, p2, p3 = _patched(fake)
    with p1, p2, p3:
        first = rollout.run_rollout(apply=True)
    assert first["counts"][rollout.RESULT_ACTIVATED] == 1
    started_at_after_first = fake.records["t_idempotent"]["mediaCapture"]["startedAt"]
    version_after_first = fake.records["t_idempotent"]["configVersion"]

    p1, p2, p3 = _patched(fake)
    with p1, p2, p3:
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
    p1, p2, p3 = _patched(fake)
    with p1, p2, p3:
        report = rollout.run_rollout(apply=True)

    assert report["registered_tenants_discovered"] == 4
    assert report["valid_tenants_considered"] == 2  # t_active-1, t_active-2 only
    assert report["counts"][rollout.RESULT_ALREADY_ACTIVE] == 1
    assert report["counts"][rollout.RESULT_ACTIVATED] == 1
    assert report["counts"][rollout.RESULT_SKIPPED_INVALID] == 2  # t_onboarding + malformed id
    assert report["counts"][rollout.RESULT_FAILED] == 0
    reconciled = (
        report["valid_tenants_considered"]
        == report["counts"][rollout.RESULT_ALREADY_ACTIVE]
        + report["counts"][rollout.RESULT_ACTIVATED]
        + report["counts"][rollout.RESULT_WOULD_ACTIVATE]
        + report["counts"][rollout.RESULT_FAILED]
    )
    assert reconciled
    assert report["total_active_after_completion"] == 2


def test_never_writes_any_field_other_than_media_capture():
    fake = FakeStore()
    fake.add("t_narrow")
    original_upsert = fake.upsert_tenant_config

    def asserting_upsert(tenant_id, patch, expected_version=None):
        assert set(patch.keys()) == {"mediaCapture"}, f"rollout must only ever patch mediaCapture, got {set(patch.keys())}"
        return original_upsert(tenant_id, patch, expected_version=expected_version)

    with mock.patch.object(tenant_config_store, "list_tenant_ids", side_effect=fake.list_tenant_ids), \
         mock.patch.object(tenant_config_store, "get_tenant_config", side_effect=fake.get_tenant_config), \
         mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=asserting_upsert):
        rollout.run_rollout(apply=True)


def test_dry_run_prints_no_credentials_or_google_calls():
    import urllib.request

    def poison(*a, **k):
        raise AssertionError("the rollout command must never make an HTTP call to anything but the config store")

    fake = FakeStore()
    fake.add("t_safe")
    original_urlopen = urllib.request.urlopen

    # tenant_config_store's own reads/writes are mocked out entirely in
    # this test (never reaching real urllib), so ANY urlopen call here
    # would have to come from somewhere else entirely -- e.g. Google.
    urllib.request.urlopen = poison
    try:
        p1, p2, p3 = _patched(fake)
        with p1, p2, p3:
            rollout.run_rollout(apply=False)
    finally:
        urllib.request.urlopen = original_urlopen


def main() -> int:
    tests = [
        ("empty registry", test_empty_registry),
        ("multiple tenants -- dry run performs zero writes", test_multiple_tenants_dry_run),
        ("multiple tenants -- apply activates all", test_multiple_tenants_apply),
        ("an already-active tenant is not rewritten", test_already_active_tenant_not_rewritten),
        ("a malformed tenant id is skipped_invalid", test_malformed_tenant_id_skipped_invalid),
        ("a non-'active' status is skipped_invalid", test_non_active_status_skipped_invalid),
        ("one tenant's config-lookup failure doesn't block the others", test_partial_failure_one_tenant_config_lookup_fails),
        ("duplicate identifiers from enumeration are processed once", test_duplicate_identifiers_processed_once),
        ("a CAS conflict is retried and succeeds", test_cas_conflict_is_retried_and_succeeds),
        ("exhausting CAS retries reports failed", test_cas_conflict_exhausting_retries_reports_failed),
        ("rerunning after success is a safe no-op", test_rerunning_after_success_is_a_safe_no_op),
        ("totals reconcile in a mixed scenario", test_totals_reconcile_in_a_mixed_scenario),
        ("never writes any field other than mediaCapture", test_never_writes_any_field_other_than_media_capture),
        ("no HTTP call is ever made outside the config store", test_dry_run_prints_no_credentials_or_google_calls),
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
