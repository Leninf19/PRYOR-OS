"""
Regression/adversarial tests for recurring_sync.py.

Reuses the same fixture shape as test_initial_sync.py (this codebase's
established per-test-file convention: duplicate rather than share fakes --
see that file's header). Google is fully mocked at the google_api module
boundary -- no real network call, no real Upstash account, no real Vercel
Blob store, no real Los Tres Amigos data anywhere in this file.

Focuses on what is NEW/DIFFERENT from initial_sync.py (already covered by
test_initial_sync.py's own suite for the shared primitives this script
imports): eligibility filtering (storageMode/status/initialSync gates,
structurally excluding Los Tres Amigos), the recurringSync field's own
lifecycle, dedup-safe re-sync (no duplicates, new reviews picked up), one
tenant's failure never blocking another's in the batch loop, and that a
recurring-sync failure never regresses a tenant's status out of 'active'.

Run directly: py tests/test_recurring_sync.py
"""
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import db  # noqa: E402
import google_api  # noqa: E402
import initial_sync as isync  # noqa: E402
import provision_tenant as pt  # noqa: E402
import recurring_sync as rsync  # noqa: E402
import tenant_artifact_export  # noqa: E402
import tenant_blob_keys  # noqa: E402
import tenant_blob_store  # noqa: E402
import tenant_config_store  # noqa: E402
import tenant_paths  # noqa: E402

TENANT_A = "t_synthetic-recurring-sync-tenant-a"
TENANT_B = "t_synthetic-recurring-sync-tenant-b"

_LTA_REAL_DB_PATH = tenant_paths.BASE_DIR / "dashboard" / "reviews.db"


class FakeTenantConfigStore:
    """Same shape/semantics as test_initial_sync.py's own fake."""

    def __init__(self):
        self.records: dict[str, dict] = {}

    def get(self, tenant_id):
        return self.records.get(tenant_id)

    def upsert(self, tenant_id, patch, expected_version=None):
        existing = self.records.get(tenant_id) or {}
        current_version = existing.get("configVersion", 0)
        if expected_version is not None and current_version != expected_version:
            raise tenant_config_store.ConfigVersionConflictError(
                f"version conflict for {tenant_id!r}: expected {expected_version}, found {current_version}",
                existing,
            )
        next_record = {
            "tenantId": tenant_id, "displayName": tenant_id, "status": "onboarding",
            "locationCatalogEnabled": False, "approvedLocations": [], "locationIdMap": {},
            "nextLocationId": 1, "brands": [], "logoUrl": None, "storageMode": "BLOB",
            "provisioning": {
                "status": "none", "reviewDbBlobKey": None, "privateDataPrefix": None, "reviewDbEtag": None,
                "artifactGeneration": None, "provisionedLocationIds": [], "lastAttemptAt": None, "lastError": None,
            },
            "initialSync": {
                "status": "none", "startedAt": None, "completedAt": None, "failedAt": None,
                "reviewDbEtag": None, "artifactGeneration": None,
                "reviewCount": None, "locationCount": None, "lastError": None,
            },
            **existing,
            **patch,
            "tenantId": tenant_id,
            "configVersion": current_version + 1,
        }
        self.records[tenant_id] = next_record
        return next_record

    def approve(self, tenant_id, locations):
        existing = self.records.get(tenant_id) or {}
        location_id_map = dict(existing.get("locationIdMap") or {})
        next_location_id = existing.get("nextLocationId") or 1
        approved = []
        for google_id, title, address in locations:
            if google_id not in location_id_map:
                location_id_map[google_id] = next_location_id
                next_location_id += 1
            approved.append({"locationId": location_id_map[google_id], "googleLocationId": google_id, "title": title, "address": address})
        return self.upsert(tenant_id, {
            "status": "locations_approved", "locationCatalogEnabled": True,
            "approvedLocations": approved, "locationIdMap": location_id_map, "nextLocationId": next_location_id,
        })

    def list_ids(self):
        return list(self.records.keys())


class FakeBlobStore:
    """Same shape/semantics as test_initial_sync.py's own fake."""

    def __init__(self):
        self.objects: dict[str, dict] = {}
        self._etag_counter = 0

    def _next_etag(self):
        self._etag_counter += 1
        return f"etag-{self._etag_counter}"

    def put_blob(self, pathname, data, *, content_type="application/octet-stream", if_match=None, allow_overwrite=None):
        existing = self.objects.get(pathname)
        if if_match is not None:
            if existing is None or existing["etag"] != if_match:
                raise tenant_blob_store.BlobPreconditionFailedError(f"ETag mismatch for {pathname}")
        elif allow_overwrite is False:
            if existing is not None:
                raise tenant_blob_store.BlobPreconditionFailedError(f"{pathname} already exists")
        new_etag = self._next_etag()
        self.objects[pathname] = {"data": data, "etag": new_etag}
        return {"url": f"https://fake.blob.test/{pathname}", "downloadUrl": f"https://fake.blob.test/{pathname}",
                "pathname": pathname, "contentType": content_type, "contentDisposition": "", "etag": new_etag}

    def head_blob(self, pathname):
        obj = self.objects.get(pathname)
        return None if obj is None else {"etag": obj["etag"], "pathname": pathname, "size": len(obj["data"])}

    def get_blob(self, pathname):
        obj = self.objects.get(pathname)
        return None if obj is None else obj["data"]


def _account(n=1):
    return {"name": f"accounts/{n}", "accountName": f"Account {n}"}


def _gbp_location(google_location_id, name):
    return {"name": google_location_id, "locationName": name}


def _gbp_review(review_id, text, stars, location_suffix="1"):
    return {
        "name": f"accounts/1/locations/{location_suffix}/reviews/{review_id}",
        "reviewId": review_id,
        "reviewer": {"displayName": f"Reviewer {review_id}"},
        "starRating": stars,
        "comment": text,
        "createTime": "2026-07-10T12:00:00Z",
        "updateTime": "2026-07-10T12:00:00Z",
    }


class RecurringSyncTestCase(unittest.TestCase):
    def setUp(self):
        self.fake_store = FakeTenantConfigStore()
        self._get_patch = mock.patch.object(tenant_config_store, "get_tenant_config", side_effect=self.fake_store.get)
        self._upsert_patch = mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=self.fake_store.upsert)
        self._list_patch = mock.patch.object(tenant_config_store, "list_tenant_ids", side_effect=self.fake_store.list_ids)
        self._get_patch.start()
        self._upsert_patch.start()
        self._list_patch.start()

        self.fake_blob = FakeBlobStore()
        self._put_blob_patch = mock.patch.object(tenant_blob_store, "put_blob", side_effect=self.fake_blob.put_blob)
        self._head_blob_patch = mock.patch.object(tenant_blob_store, "head_blob", side_effect=self.fake_blob.head_blob)
        self._get_blob_patch = mock.patch.object(tenant_blob_store, "get_blob", side_effect=self.fake_blob.get_blob)
        self._put_blob_patch.start()
        self._head_blob_patch.start()
        self._get_blob_patch.start()

        self._cred_patch = mock.patch.object(google_api, "has_tenant_credential", return_value=True)
        self._cred_patch.start()

        # The static registry always contains Los Tres Amigos -- reused
        # here (rather than patched away) specifically so the "never
        # touches LTA" tests exercise the REAL enumeration path, not a
        # stand-in that trivially can't include it.
        self._static_registry_patch = mock.patch.object(
            tenant_paths, "list_static_registry_tenant_ids", return_value=["t_los-tres-amigos"]
        )
        self._static_registry_patch.start()

        self._real_db_path = db.DB_PATH
        self._lta_db_mtime_before = _LTA_REAL_DB_PATH.stat().st_mtime if _LTA_REAL_DB_PATH.exists() else None

    def tearDown(self):
        self._get_patch.stop()
        self._upsert_patch.stop()
        self._list_patch.stop()
        self._put_blob_patch.stop()
        self._head_blob_patch.stop()
        self._get_blob_patch.stop()
        self._cred_patch.stop()
        self._static_registry_patch.stop()
        db.DB_PATH = self._real_db_path
        if self._lta_db_mtime_before is not None:
            self.assertEqual(_LTA_REAL_DB_PATH.stat().st_mtime, self._lta_db_mtime_before,
                              "a recurring-sync test must never modify the real Los Tres Amigos reviews.db")

    def _provision_and_initial_sync(self, tenant_id, locations, reviews_by_location_id=None):
        """Builds a genuinely 'active' tenant fixture via the REAL
        provision_tenant.py -> initial_sync.py pipeline (not a hand-rolled
        stand-in), so recurring_sync.py is tested against exactly the state
        shape those two modules actually produce."""
        self.fake_store.approve(tenant_id, locations)
        pt.provision_tenant(tenant_id)
        with self._mock_google(_account(), [_gbp_location(g, t) for g, t, _ in locations], reviews_by_location_id):
            isync.initial_sync(tenant_id)
        return self.fake_store.get(tenant_id)

    def _mock_google(self, account, locations, reviews_by_location_id=None):
        reviews_by_location_id = reviews_by_location_id or {}

        def list_reviews_side_effect(tenant_id, location_name, page_size=50, max_pages=None):
            return reviews_by_location_id.get(location_name, [])

        return _MultiGooglePatch(account, locations, list_reviews_side_effect)

    def _review_count_in_blob(self, tenant_id):
        key = tenant_blob_keys.review_db_blob_key(tenant_id)
        data = self.fake_blob.get_blob(key)
        fd, tmp_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        Path(tmp_path).write_bytes(data)
        self.addCleanup(lambda: os.path.exists(tmp_path) and os.remove(tmp_path))
        conn = sqlite3.connect(tmp_path)
        try:
            return conn.execute("SELECT COUNT(*) FROM reviews WHERE is_deleted = 0").fetchone()[0]
        finally:
            conn.close()

    # ===================================================================
    # Eligibility filtering
    # ===================================================================

    def test_los_tres_amigos_is_never_eligible_regardless_of_registry_membership(self):
        # Simulates LTA having a bootstrapped Redis record (as
        # activate_review_media_rollout.py can produce) -- storageMode
        # LEGACY_REPO must still exclude it structurally.
        self.fake_store.upsert("t_los-tres-amigos", {"status": "active", "storageMode": "LEGACY_REPO"})
        self.assertIsNone(rsync._load_and_validate_config("t_los-tres-amigos"))

    def test_onboarding_tenant_is_not_eligible(self):
        self.fake_store.approve(TENANT_A, [("locations/1", "Test Cafe", "1 Main St")])
        # status is 'locations_approved' at this point, not 'active'
        self.assertIsNone(rsync._load_and_validate_config(TENANT_A))

    def test_tenant_with_initial_sync_not_completed_is_not_eligible(self):
        self.fake_store.upsert(TENANT_A, {"status": "active", "storageMode": "BLOB",
                                           "initialSync": {"status": "in_progress"}})
        self.assertIsNone(rsync._load_and_validate_config(TENANT_A))

    def test_unknown_tenant_is_not_eligible(self):
        self.assertIsNone(rsync._load_and_validate_config("t_never-onboarded-recurring-sync-tenant"))

    def test_enumeration_never_includes_los_tres_amigos_in_the_batch_run(self):
        self.fake_store.upsert("t_los-tres-amigos", {"status": "active", "storageMode": "LEGACY_REPO"})
        ids = rsync._enumerate_tenant_ids()
        self.assertIn("t_los-tres-amigos", ids)  # enumeration includes it...
        self.assertIsNone(rsync._load_and_validate_config("t_los-tres-amigos"))  # ...but it is never eligible

    # ===================================================================
    # Happy path -- dedup-safe re-sync, new reviews picked up, dashboard
    # pointer (provisioning.artifactGeneration/reviewDbEtag) updated
    # ===================================================================

    def test_recurring_sync_picks_up_new_reviews_without_duplicating_existing_ones(self):
        locations = [("locations/1", "Test Cafe", "1 Main St")]
        initial_reviews = {"locations/1": [_gbp_review("r1", "Great!", 5), _gbp_review("r2", "Good", 4)]}
        config = self._provision_and_initial_sync(TENANT_A, locations, initial_reviews)
        self.assertEqual(config["initialSync"]["reviewCount"], 2)
        first_generation = config["provisioning"]["artifactGeneration"]

        # A third, genuinely new review appears upstream, plus the same two
        # from before (Google's own full-history pull would return all of
        # them every time -- see initial_sync.py's header on why this is
        # safe: upsert_review dedups on dedup_key()).
        updated_reviews = {"locations/1": [
            _gbp_review("r1", "Great!", 5), _gbp_review("r2", "Good", 4), _gbp_review("r3", "New review!", 5),
        ]}
        with self._mock_google(_account(), [_gbp_location("locations/1", "Test Cafe")], updated_reviews):
            result = rsync.sync_one_tenant(TENANT_A, self.fake_store.get(TENANT_A))

        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["reviewCount"], 3, "the new review must be picked up")
        self.assertEqual(self._review_count_in_blob(TENANT_A), 3, "no duplicates -- exactly 3 rows, not 5")

        final_config = self.fake_store.get(TENANT_A)
        self.assertEqual(final_config["status"], "active", "a successful recurring sync must never change tenant status")
        self.assertEqual(final_config["recurringSync"]["status"], "completed")
        self.assertEqual(final_config["recurringSync"]["lastReviewCount"], 3)
        self.assertNotEqual(final_config["provisioning"]["artifactGeneration"], first_generation,
                             "a new generation must be published so the dashboard can see the update")

    # ===================================================================
    # Failure isolation -- a recurring-sync failure never regresses status
    # ===================================================================

    def test_google_sync_failure_is_recorded_without_touching_tenant_status(self):
        locations = [("locations/1", "Test Cafe", "1 Main St")]
        self._provision_and_initial_sync(TENANT_A, locations, {"locations/1": [_gbp_review("r1", "Great!", 5)]})

        def failing_list_reviews(tenant_id, location_name, page_size=50, max_pages=None):
            raise google_api.GBPServerError("simulated transient failure")

        with mock.patch.object(google_api, "is_configured", return_value=True), \
             mock.patch.object(google_api, "list_accounts", return_value=[_account()]), \
             mock.patch.object(google_api, "list_locations", return_value=[_gbp_location("locations/1", "Test Cafe")]), \
             mock.patch.object(google_api, "list_reviews", side_effect=failing_list_reviews):
            with self.assertRaises(Exception):
                rsync.sync_one_tenant(TENANT_A, self.fake_store.get(TENANT_A))

        final_config = self.fake_store.get(TENANT_A)
        self.assertEqual(final_config["status"], "active", "a failed recurring sync must never regress tenant status")
        self.assertEqual(final_config["initialSync"]["status"], "completed", "initialSync's own record must be untouched")
        self.assertEqual(final_config["recurringSync"]["status"], "failed")
        self.assertIsNotNone(final_config["recurringSync"]["lastError"])

    def test_stale_cas_conflict_is_never_recorded_as_a_failure(self):
        locations = [("locations/1", "Test Cafe", "1 Main St")]
        config = self._provision_and_initial_sync(TENANT_A, locations, {"locations/1": [_gbp_review("r1", "Great!", 5)]})
        stale_config = dict(config)  # captured BEFORE a concurrent write bumps configVersion
        self.fake_store.upsert(TENANT_A, {})  # simulates a concurrent write bumping configVersion

        with self.assertRaises(rsync.StaleRecurringSyncAttemptError):
            rsync.sync_one_tenant(TENANT_A, stale_config)

        final_config = self.fake_store.get(TENANT_A)
        self.assertNotEqual(final_config.get("recurringSync", {}).get("status"), "failed",
                             "a stale CAS conflict must never be recorded as a real sync failure")

    # ===================================================================
    # Batch orchestration -- one tenant's failure never blocks another's
    # ===================================================================

    def test_one_tenant_failure_does_not_prevent_another_tenants_successful_sync(self):
        locations = [("locations/1", "Loc A", "1 Main St")]
        self._provision_and_initial_sync(TENANT_A, locations, {"locations/1": [_gbp_review("r1", "Great!", 5)]})
        self._provision_and_initial_sync(TENANT_B, locations, {"locations/1": [_gbp_review("r1", "Great!", 5)]})

        config_a = self.fake_store.get(TENANT_A)
        config_b = self.fake_store.get(TENANT_B)

        def list_reviews_side_effect(tenant_id, location_name, page_size=50, max_pages=None):
            if tenant_id == TENANT_A:
                raise google_api.GBPServerError("simulated failure for A only")
            return [_gbp_review("r1", "Great!", 5), _gbp_review("r2", "New!", 4)]

        with mock.patch.object(google_api, "is_configured", return_value=True), \
             mock.patch.object(google_api, "list_accounts", return_value=[_account()]), \
             mock.patch.object(google_api, "list_locations", return_value=[_gbp_location("locations/1", "Loc")]), \
             mock.patch.object(google_api, "list_reviews", side_effect=list_reviews_side_effect):
            with self.assertRaises(Exception):
                rsync.sync_one_tenant(TENANT_A, config_a)
            result_b = rsync.sync_one_tenant(TENANT_B, config_b)

        self.assertEqual(result_b["outcome"], "completed")
        self.assertEqual(result_b["reviewCount"], 2, "tenant B's own successful sync must be fully recorded")
        self.assertEqual(self.fake_store.get(TENANT_A)["recurringSync"]["status"], "failed")
        self.assertEqual(self.fake_store.get(TENANT_B)["recurringSync"]["status"], "completed")


class _MultiGooglePatch:
    """Small context-manager helper: patches is_configured/list_accounts/
    list_locations/list_reviews together, mirroring
    test_initial_sync.py's own `_mock_google` list-of-patches convention but
    as a single `with` target for readability at each call site here."""

    def __init__(self, account, locations, list_reviews_side_effect):
        self._patches = [
            mock.patch.object(google_api, "is_configured", return_value=True),
            mock.patch.object(google_api, "list_accounts", return_value=[account]),
            mock.patch.object(google_api, "list_locations", return_value=locations),
            mock.patch.object(google_api, "list_reviews", side_effect=list_reviews_side_effect),
        ]

    def __enter__(self):
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc_info):
        for p in reversed(self._patches):
            p.stop()
        return False


if __name__ == "__main__":
    unittest.main()
