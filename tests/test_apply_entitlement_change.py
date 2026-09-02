"""
Regression/adversarial tests for apply_entitlement_change.py -- Multi-Tenant
Phase 4I.3.

Reuses the REAL provision_tenant.py to build a genuinely provisioned BLOB
tenant fixture, and simulates a completed Initial Sync (Phase 4G, already
covered by test_initial_sync.py) by hand to reach 'active' with real,
already-synced review data for one location -- then drives
apply_entitlement_change.py against a pending entitlement-change addition,
exactly mirroring test_initial_sync.py's own harness conventions (same
FakeTenantConfigStore/FakeBlobStore shapes, same google_api mock points).

No real network call, no real Upstash account, no real Vercel Blob store,
no real Los Tres Amigos data anywhere in this file.

Run directly: py tests/test_apply_entitlement_change.py
"""
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import apply_entitlement_change as aec  # noqa: E402
import db  # noqa: E402
import google_api  # noqa: E402
import provider_sync  # noqa: E402
import provision_tenant as pt  # noqa: E402
import tenant_blob_keys  # noqa: E402
import tenant_blob_store  # noqa: E402
import tenant_config_store  # noqa: E402
import tenant_keys  # noqa: E402
import tenant_paths  # noqa: E402

TENANT_A = "t_synthetic-entitlement-change-tenant-a"
TENANT_B = "t_synthetic-entitlement-change-tenant-b"
UNKNOWN_TENANT = "t_never-onboarded-entitlement-change-tenant"

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
            "entitlementChange": {
                "status": "none", "requestedAt": None, "completedAt": None, "failedAt": None,
                "addedLocationIds": [], "removedLocationIds": [], "lastError": None,
            },
            **existing,
            **patch,
            "tenantId": tenant_id,
            "configVersion": current_version + 1,
        }
        self.records[tenant_id] = next_record
        return next_record

    def approve(self, tenant_id, locations):
        """locations: [(googleLocationId, title, address)]."""
        existing = self.records.get(tenant_id) or {}
        location_id_map = dict(existing.get("locationIdMap") or {})
        next_location_id = existing.get("nextLocationId") or 1
        approved = []
        for google_id, title, address in locations:
            if google_id not in location_id_map:
                location_id_map[google_id] = next_location_id
                next_location_id += 1
            approved.append({"locationId": location_id_map[google_id], "googleLocationId": google_id, "title": title, "address": address, "operational": True})
        return self.upsert(tenant_id, {
            "status": "locations_approved", "locationCatalogEnabled": True,
            "approvedLocations": approved, "locationIdMap": location_id_map, "nextLocationId": next_location_id,
        })

    def request_entitlement_change(self, tenant_id, add_google_location_id, title, address):
        """Simulates Node's applyEntitlementChange(): reserves (or reuses)
        a stable id for the new location, appends it to approvedLocations
        with operational: False, and marks entitlementChange 'pending' --
        exactly the committed state apply_entitlement_change.py expects to
        find waiting for it."""
        existing = self.records[tenant_id]
        location_id_map = dict(existing["locationIdMap"])
        next_location_id = existing["nextLocationId"]
        if add_google_location_id not in location_id_map:
            location_id_map[add_google_location_id] = next_location_id
            next_location_id += 1
        new_location_id = location_id_map[add_google_location_id]
        approved = list(existing["approvedLocations"]) + [{
            "locationId": new_location_id, "googleLocationId": add_google_location_id,
            "title": title, "address": address, "operational": False,
        }]
        return self.upsert(tenant_id, {
            "approvedLocations": approved, "locationIdMap": location_id_map, "nextLocationId": next_location_id,
            "entitlementChange": {
                "status": "pending", "requestedAt": "2026-01-01T00:00:00Z", "completedAt": None, "failedAt": None,
                "addedLocationIds": [new_location_id], "removedLocationIds": [], "lastError": None,
            },
        })


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


class ApplyEntitlementChangeTestCase(unittest.TestCase):
    def setUp(self):
        self.fake_store = FakeTenantConfigStore()
        self._get_patch = mock.patch.object(tenant_config_store, "get_tenant_config", side_effect=self.fake_store.get)
        self._upsert_patch = mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=self.fake_store.upsert)
        self._get_patch.start()
        self._upsert_patch.start()

        self.fake_blob = FakeBlobStore()
        self._put_blob_patch = mock.patch.object(tenant_blob_store, "put_blob", side_effect=self.fake_blob.put_blob)
        self._head_blob_patch = mock.patch.object(tenant_blob_store, "head_blob", side_effect=self.fake_blob.head_blob)
        self._get_blob_patch = mock.patch.object(tenant_blob_store, "get_blob", side_effect=self.fake_blob.get_blob)
        self._put_blob_patch.start()
        self._head_blob_patch.start()
        self._get_blob_patch.start()

        self._cred_patch = mock.patch.object(google_api, "has_tenant_credential", return_value=True)
        self._cred_patch.start()

        self._real_db_path = db.DB_PATH
        self._lta_db_mtime_before = _LTA_REAL_DB_PATH.stat().st_mtime if _LTA_REAL_DB_PATH.exists() else None

    def tearDown(self):
        self._get_patch.stop()
        self._upsert_patch.stop()
        self._put_blob_patch.stop()
        self._head_blob_patch.stop()
        self._get_blob_patch.stop()
        self._cred_patch.stop()
        db.DB_PATH = self._real_db_path
        if self._lta_db_mtime_before is not None:
            self.assertEqual(_LTA_REAL_DB_PATH.stat().st_mtime, self._lta_db_mtime_before,
                              "a test must never modify the real Los Tres Amigos reviews.db")

    def _mock_google(self, account, locations, reviews_by_location_id=None):
        reviews_by_location_id = reviews_by_location_id or {}

        def list_reviews_side_effect(tenant_id, location_name, page_size=50, max_pages=None):
            return reviews_by_location_id.get(location_name, [])

        return [
            mock.patch.object(google_api, "is_configured", return_value=True),
            mock.patch.object(google_api, "list_accounts", return_value=[account]),
            mock.patch.object(google_api, "list_locations", return_value=locations),
            mock.patch.object(google_api, "list_reviews", side_effect=list_reviews_side_effect),
        ]

    def _download_db(self, review_db_blob_key):
        data = self.fake_blob.get_blob(review_db_blob_key)
        self.assertIsNotNone(data, f"expected a reviews.db Blob at {review_db_blob_key!r}")
        fd, tmp_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        Path(tmp_path).write_bytes(data)

        def _cleanup():
            # provider_sync.sync_all() never explicitly closes its own
            # sqlite3.Connection (see apply_entitlement_change.py's/
            # initial_sync.py's own header) -- best-effort cleanup only,
            # exactly like their own production cleanup paths; a residual
            # Windows file lock on a scratch temp file must never fail a
            # test that already got the assertions it needed.
            import gc
            gc.collect()
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass

        self.addCleanup(_cleanup)
        return Path(tmp_path)

    def _artifact_json(self, tenant_id, generation, rel_path):
        key = tenant_blob_keys.generation_private_data_blob_key(tenant_id, generation, rel_path)
        data = self.fake_blob.get_blob(key)
        self.assertIsNotNone(data, f"expected a private-data Blob at {key!r}")
        return json.loads(data)

    def _make_active_tenant_with_one_synced_location(self, tenant_id, google_location_id="accounts/1/locations/1", review_ids=("r1", "r2")):
        """Provisions (real provision_tenant.py) + simulates a completed
        Initial Sync by directly writing the reviews.db Blob with real
        review rows for ONE location, then marks the config 'active' --
        exactly the state a genuinely active tenant would be in before a
        platform admin requests an entitlement change."""
        self.fake_store.approve(tenant_id, [(google_location_id, "Location One", "1 Main St")])
        pt.provision_tenant(tenant_id)
        review_db_blob_key = tenant_blob_keys.review_db_blob_key(tenant_id)

        account = _account(1)
        location = _gbp_location(google_location_id, "Location One")
        reviews = [_gbp_review(rid, f"Great! ({rid})", 5) for rid in review_ids]
        patches = self._mock_google(account, [location], {google_location_id: reviews})
        for p in patches:
            p.start()
        try:
            tmp_db_path = self._download_db(review_db_blob_key)
            original_db_path = db.DB_PATH
            db.DB_PATH = tmp_db_path
            try:
                import asyncio
                import tenant_approved_locations_provider as approved_provider
                provider = approved_provider.ApprovedLocationsOnlyGBPProvider(tenant_id, {google_location_id})
                asyncio.run(provider_sync.sync_all(provider, fast=False))
            finally:
                db.DB_PATH = original_db_path
                import gc
                gc.collect()
        finally:
            for p in patches:
                p.stop()

        new_data = tmp_db_path.read_bytes()
        config = self.fake_store.get(tenant_id)
        current_etag = self.fake_blob.head_blob(review_db_blob_key)["etag"]
        self.fake_blob.put_blob(review_db_blob_key, new_data, content_type="application/octet-stream", if_match=current_etag)
        final_etag = self.fake_blob.head_blob(review_db_blob_key)["etag"]

        self.fake_store.upsert(tenant_id, {
            "status": "active",
            "provisioning": {**config["provisioning"], "reviewDbEtag": final_etag},
        }, expected_version=config["configVersion"])
        return tenant_id, google_location_id

    # ===================================================================
    # Preconditions
    # ===================================================================

    def test_unknown_tenant_fails_closed(self):
        with self.assertRaises(aec.UnknownTenantConfigError):
            aec.apply_entitlement_change(UNKNOWN_TENANT)
        self.assertEqual(self.fake_blob.objects, {})

    def test_ineligible_status_rejected(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/1", "A", "")])  # status: locations_approved
        with self.assertRaises(aec.TenantNotEligibleError):
            aec.apply_entitlement_change(TENANT_A)

    def test_no_pending_entitlement_change_rejected(self):
        self._make_active_tenant_with_one_synced_location(TENANT_A)
        with self.assertRaises(aec.NoPendingEntitlementChangeError):
            aec.apply_entitlement_change(TENANT_A)

    def test_no_credential_fails_closed(self):
        self._make_active_tenant_with_one_synced_location(TENANT_A)
        self.fake_store.request_entitlement_change(TENANT_A, "accounts/1/locations/2", "Location Two", "2 Main St")
        self._cred_patch.stop()
        try:
            with mock.patch.object(google_api, "has_tenant_credential", return_value=False):
                with self.assertRaises(aec.NoGoogleCredentialError):
                    aec.apply_entitlement_change(TENANT_A)
        finally:
            self._cred_patch.start()

    # ===================================================================
    # Happy path + historical data integrity (spec item 13)
    # ===================================================================

    def test_happy_path_adds_location_and_promotes_to_operational(self):
        tenant_id, existing_google_id = self._make_active_tenant_with_one_synced_location(TENANT_A, review_ids=("r1", "r2"))
        pending = self.fake_store.request_entitlement_change(tenant_id, "accounts/1/locations/2", "Location Two", "2 Main St")
        new_location_id = pending["entitlementChange"]["addedLocationIds"][0]

        account = _account(1)
        locations = [_gbp_location(existing_google_id, "Location One"), _gbp_location("accounts/1/locations/2", "Location Two")]
        reviews_by_loc = {existing_google_id: [_gbp_review("r1", "Great! (r1)", 5), _gbp_review("r2", "Great! (r2)", 5)],
                           "accounts/1/locations/2": [_gbp_review("r3", "New location review", 4, location_suffix="2")]}
        patches = self._mock_google(account, locations, reviews_by_loc)
        for p in patches:
            p.start()
        try:
            result = aec.apply_entitlement_change(tenant_id)
        finally:
            for p in patches:
                p.stop()

        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["addedLocationIds"], [new_location_id])

        final_config = self.fake_store.get(tenant_id)
        self.assertEqual(final_config["entitlementChange"]["status"], "none")
        new_entry = next(l for l in final_config["approvedLocations"] if l["locationId"] == new_location_id)
        self.assertTrue(new_entry["operational"], "the newly added location must be promoted to operational on success")

        # A fresh artifact generation was published.
        generation = final_config["provisioning"]["artifactGeneration"]
        self.assertIsNotNone(generation)
        meta = self._artifact_json(tenant_id, generation, "meta.json")
        self.assertEqual(len(meta.get("locations", [])), 2, "the fresh artifact generation must reflect BOTH locations")

    def test_historical_reviews_are_not_reassigned_to_the_new_location(self):
        """Spec item 13: adding a new location must never touch existing
        rows for OTHER, already-synced locations."""
        tenant_id, existing_google_id = self._make_active_tenant_with_one_synced_location(TENANT_A, review_ids=("r1", "r2"))
        config_before = self.fake_store.get(tenant_id)
        existing_location_id = config_before["approvedLocations"][0]["locationId"]

        pending = self.fake_store.request_entitlement_change(tenant_id, "accounts/1/locations/2", "Location Two", "2 Main St")
        new_location_id = pending["entitlementChange"]["addedLocationIds"][0]
        self.assertNotEqual(new_location_id, existing_location_id, "sanity: the new location must get its OWN id")

        account = _account(1)
        locations = [_gbp_location(existing_google_id, "Location One"), _gbp_location("accounts/1/locations/2", "Location Two")]
        reviews_by_loc = {existing_google_id: [_gbp_review("r1", "Great! (r1)", 5), _gbp_review("r2", "Great! (r2)", 5)],
                           "accounts/1/locations/2": [_gbp_review("r3", "New location review", 4, location_suffix="2")]}
        patches = self._mock_google(account, locations, reviews_by_loc)
        for p in patches:
            p.start()
        try:
            aec.apply_entitlement_change(tenant_id)
        finally:
            for p in patches:
                p.stop()

        final_config = self.fake_store.get(tenant_id)
        review_db_blob_key = tenant_blob_keys.review_db_blob_key(tenant_id)
        tmp_db_path = self._download_db(review_db_blob_key)
        conn = sqlite3.connect(tmp_db_path)
        conn.row_factory = sqlite3.Row
        try:
            r1_row = conn.execute("SELECT location_id FROM reviews WHERE gbp_review_name LIKE ?", ("%/reviews/r1",)).fetchone()
            r2_row = conn.execute("SELECT location_id FROM reviews WHERE gbp_review_name LIKE ?", ("%/reviews/r2",)).fetchone()
            r3_row = conn.execute("SELECT location_id FROM reviews WHERE gbp_review_name LIKE ?", ("%/reviews/r3",)).fetchone()
        finally:
            conn.close()
        self.assertIsNotNone(r1_row, "r1 must still exist after the entitlement change")
        self.assertIsNotNone(r2_row, "r2 must still exist after the entitlement change")
        self.assertEqual(r1_row["location_id"], existing_location_id, "r1 must remain assigned to its ORIGINAL location -- never reassigned to the newly added one")
        self.assertEqual(r2_row["location_id"], existing_location_id, "r2 must remain assigned to its ORIGINAL location")
        self.assertIsNotNone(r3_row, "the new location's own review must be synced")
        self.assertEqual(r3_row["location_id"], new_location_id, "the new location's review must be assigned to the NEW location's own id")

    # ===================================================================
    # Failure semantics
    # ===================================================================

    def test_google_sync_failure_leaves_addition_non_operational(self):
        tenant_id, existing_google_id = self._make_active_tenant_with_one_synced_location(TENANT_A)
        self.fake_store.request_entitlement_change(tenant_id, "accounts/1/locations/2", "Location Two", "2 Main St")

        # Google now fails outright for every call (simulates an outage).
        with mock.patch.object(google_api, "is_configured", return_value=False):
            with self.assertRaises(aec.ApplyEntitlementChangeError):
                aec.apply_entitlement_change(tenant_id)

        final_config = self.fake_store.get(tenant_id)
        self.assertEqual(final_config["entitlementChange"]["status"], "failed")
        new_entry = next(l for l in final_config["approvedLocations"] if l["googleLocationId"] == "accounts/1/locations/2")
        self.assertFalse(new_entry["operational"], "a failed data-plane run must never promote the addition to operational")

    def test_stale_blob_etag_fails_closed_without_publishing(self):
        tenant_id, existing_google_id = self._make_active_tenant_with_one_synced_location(TENANT_A)
        self.fake_store.request_entitlement_change(tenant_id, "accounts/1/locations/2", "Location Two", "2 Main St")

        review_db_blob_key = tenant_blob_keys.review_db_blob_key(tenant_id)
        # Something else uploads a newer reviews.db between this run's read
        # and its own upload attempt.
        original_put_blob = tenant_blob_store.put_blob

        call_count = {"n": 0}
        real_side_effect = self.fake_blob.put_blob

        def racing_put_blob(pathname, data, **kwargs):
            call_count["n"] += 1
            if pathname == review_db_blob_key and call_count["n"] == 1:
                # A concurrent writer's own upload lands first.
                self.fake_blob.put_blob(pathname, b"concurrent-writer-data", content_type="application/octet-stream", if_match=kwargs.get("if_match"))
            return real_side_effect(pathname, data, **kwargs)

        account = _account(1)
        locations = [_gbp_location(existing_google_id, "Location One"), _gbp_location("accounts/1/locations/2", "Location Two")]
        patches = self._mock_google(account, locations, {})
        for p in patches:
            p.start()
        try:
            with mock.patch.object(tenant_blob_store, "put_blob", side_effect=racing_put_blob):
                with self.assertRaises(aec.StaleEntitlementChangeAttemptError):
                    aec.apply_entitlement_change(tenant_id)
        finally:
            for p in patches:
                p.stop()

        # No tenant_config write occurred for a stale attempt.
        final_config = self.fake_store.get(tenant_id)
        self.assertEqual(final_config["entitlementChange"]["status"], "pending", "a stale-CAS attempt must leave entitlementChange exactly as it was -- neither completed nor failed")


if __name__ == "__main__":
    unittest.main()
