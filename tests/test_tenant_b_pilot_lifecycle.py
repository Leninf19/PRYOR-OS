"""
Multi-Tenant Phase 4L -- End-to-End Tenant B Pilot Readiness.

Every other Python test file (test_provision_tenant.py, test_initial_sync.py,
test_apply_entitlement_change.py) proves ONE script's own internal
correctness in isolation. This file's job is different and additive: it
composes all three REAL entry points (provision_tenant.provision_tenant,
initial_sync.initial_sync, apply_entitlement_change.apply_entitlement_change)
against ONE continuously-evolving synthetic pilot tenant, in the exact
sequence the real tenant-lifecycle GitHub Actions workflow would invoke
them, proving the full chain composes correctly end to end -- including a
provisioning failure+retry and an Initial-Sync failure+retry along the way
-- not just that each stage works when tested alone.

Same fixture conventions as the three files above (FakeTenantConfigStore /
FakeBlobStore, google_api module-level mock.patch points, no real Upstash,
no real Vercel Blob, no real Google, no real Los Tres Amigos data).

Run directly: py tests/test_tenant_b_pilot_lifecycle.py
"""
import gc
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/..")

import apply_entitlement_change as aec  # noqa: E402
import db  # noqa: E402
import google_api  # noqa: E402
import initial_sync as isync  # noqa: E402
import provision_tenant as pt  # noqa: E402
import tenant_blob_keys  # noqa: E402
import tenant_blob_store  # noqa: E402
import tenant_config_store  # noqa: E402
import tenant_paths  # noqa: E402

PILOT_TENANT = "t_pilot-test-b-full-lifecycle"

_LTA_REAL_DB_PATH = tenant_paths.BASE_DIR / "dashboard" / "reviews.db"


class FakeTenantConfigStore:
    """Same shape/semantics as the other three Python test files' own
    fakes -- kept as its own local copy (not imported) because each of
    those files' copies is itself the reviewed fixture for ITS OWN
    script's exact record shape expectations, and this file exercises all
    three together."""

    def __init__(self):
        self.records = {}

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
    def __init__(self):
        self.objects = {}
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


def _gbp_review(review_id, text, stars):
    return {
        "name": f"{review_id}", "reviewId": review_id,
        "reviewer": {"displayName": f"Reviewer {review_id}"},
        "starRating": stars, "comment": text,
        "createTime": "2026-07-10T12:00:00Z", "updateTime": "2026-07-10T12:00:00Z",
    }


class TenantBPilotLifecycleTestCase(unittest.TestCase):
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
        gc.collect()
        if self._lta_db_mtime_before is not None:
            self.assertEqual(_LTA_REAL_DB_PATH.stat().st_mtime, self._lta_db_mtime_before,
                              "a pilot-lifecycle test must never modify the real Los Tres Amigos reviews.db")

    def _mock_google(self, account, locations, reviews_by_location_name=None):
        reviews_by_location_name = reviews_by_location_name or {}

        def list_reviews_side_effect(tenant_id, location_name, page_size=50, max_pages=None):
            return reviews_by_location_name.get(location_name, [])

        return [
            mock.patch.object(google_api, "is_configured", return_value=True),
            mock.patch.object(google_api, "list_accounts", return_value=[account]),
            mock.patch.object(google_api, "list_locations", return_value=locations),
            mock.patch.object(google_api, "list_reviews", side_effect=list_reviews_side_effect),
        ]

    def _artifact_json(self, tenant_id, generation, rel_path):
        key = tenant_blob_keys.generation_private_data_blob_key(tenant_id, generation, rel_path)
        data = self.fake_blob.get_blob(key)
        self.assertIsNotNone(data, f"expected a private-data Blob at {key!r}")
        return json.loads(data)

    def _download_db(self, review_db_blob_key):
        data = self.fake_blob.get_blob(review_db_blob_key)
        self.assertIsNotNone(data, f"expected a reviews.db Blob at {review_db_blob_key!r}")
        fd, tmp_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        Path(tmp_path).write_bytes(data)

        def _cleanup():
            gc.collect()
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass
        self.addCleanup(_cleanup)
        return Path(tmp_path)

    def _review_count(self, db_path):
        conn = sqlite3.connect(db_path)
        try:
            return conn.execute("SELECT COUNT(*) FROM reviews WHERE is_deleted = 0").fetchone()[0]
        finally:
            conn.close()

    def test_full_pilot_lifecycle_composes_provision_sync_and_entitlement_change(self):
        # --- Stage 1: onboarding -> locations_approved (the Node-side
        # self-service flow, simulated the same way every other Python
        # test file does: directly on the fake store, since this file's
        # job is the PYTHON scripts' composition, not re-proving the
        # Node HTTP layer already covered by tests/test_tenant_entitlement_change.js).
        self.fake_store.approve(PILOT_TENANT, [
            ("accounts/1/locations/downtown", "Pilot B Downtown", "1 Main St"),
        ])
        self.assertEqual(self.fake_store.get(PILOT_TENANT)["status"], "locations_approved")

        # --- Stage 2: provisioning FAILS (simulated), then a retry
        # succeeds -- proves the real operator workflow ("run provision_tenant.py
        # again for the same tenant_id after a failure") actually recovers,
        # not just that a failure is recorded.
        with mock.patch.object(pt, "_upload_private_data_artifacts", side_effect=RuntimeError("simulated Blob outage during provisioning")):
            with self.assertRaises(RuntimeError):
                pt.provision_tenant(PILOT_TENANT)
        self.assertEqual(self.fake_store.get(PILOT_TENANT)["status"], "provisioning_failed")
        self.assertIn("simulated Blob outage", self.fake_store.get(PILOT_TENANT)["provisioning"]["lastError"])

        provision_result = pt.provision_tenant(PILOT_TENANT)
        self.assertEqual(provision_result["outcome"], "already_provisioned")
        self.assertEqual(self.fake_store.get(PILOT_TENANT)["status"], "provisioned")

        # --- Stage 3: Initial Sync FAILS (simulated: the DB upload
        # succeeds but the artifact upload does not), then a retry
        # succeeds and activates the tenant.
        review_db_blob_key = tenant_blob_keys.review_db_blob_key(PILOT_TENANT)
        locations = [_gbp_location("accounts/1/locations/downtown", "Pilot B Downtown")]
        reviews = {"accounts/1/locations/downtown": [
            _gbp_review("r1", "Loved it here", "FIVE"),
            _gbp_review("r2", "Would not come back", "TWO"),
        ]}
        patches = self._mock_google(_account(), locations, reviews)

        def _raise_after_db_upload():
            calls = {"n": 0}
            real_put = self.fake_blob.put_blob

            def _side_effect(pathname, data, **kwargs):
                calls["n"] += 1
                if calls["n"] == 1:
                    return real_put(pathname, data, **kwargs)
                raise RuntimeError("simulated network failure uploading Initial Sync artifacts")
            return _side_effect

        with mock.patch.object(tenant_blob_store, "put_blob", side_effect=_raise_after_db_upload()), \
             patches[0], patches[1], patches[2], patches[3]:
            with self.assertRaises(RuntimeError):
                isync.initial_sync(PILOT_TENANT)
        self.assertEqual(self.fake_store.get(PILOT_TENANT)["status"], "initial_sync_failed")

        with patches[0], patches[1], patches[2], patches[3]:
            sync_outcome = isync.initial_sync(PILOT_TENANT)
        self.assertEqual(sync_outcome["outcome"], "active")
        self.assertEqual(sync_outcome["reviewCount"], 2)
        config = self.fake_store.get(PILOT_TENANT)
        self.assertEqual(config["status"], "active")

        db_path = self._download_db(review_db_blob_key)
        self.assertEqual(self._review_count(db_path), 2)
        meta = self._artifact_json(PILOT_TENANT, sync_outcome["artifactGeneration"], "meta.json")
        self.assertEqual(meta["totalReviews"], 2)
        # Never a fabricated statistic and never LTA's own brand/location
        # data leaking into a synthetic pilot tenant's real artifacts.
        for lta_brand in db.BRANDS:
            self.assertNotIn(lta_brand, json.dumps(meta))

        # --- Stage 4: platform-admin entitlement change (add one location)
        # against the SAME now-active tenant -- proves the full chain
        # (onboarding -> provisioning [with a real failure+retry] ->
        # Initial Sync [with a real failure+retry] -> active ->
        # entitlement change) composes on one continuously-evolving
        # tenant, exactly as the real GitHub Actions workflow would drive
        # it across three separate dispatches for the same tenant_id.
        self.fake_store.request_entitlement_change(PILOT_TENANT, "accounts/1/locations/uptown", "Pilot B Uptown", "2 Main St")
        locations_after = locations + [_gbp_location("accounts/1/locations/uptown", "Pilot B Uptown")]
        reviews_after = {**reviews, "accounts/1/locations/uptown": [_gbp_review("r3", "New location, great start", "FIVE")]}
        patches2 = self._mock_google(_account(), locations_after, reviews_after)
        with patches2[0], patches2[1], patches2[2], patches2[3]:
            change_outcome = aec.apply_entitlement_change(PILOT_TENANT)

        final_config = self.fake_store.get(PILOT_TENANT)
        self.assertEqual(final_config["status"], "active", "a completed entitlement change must return the tenant to active, not leave it in a transitional state")
        # apply_entitlement_change.py's own contract (see its header
        # comment): a successful run resets entitlementChange.status from
        # 'pending' back to 'none' -- there is no lingering 'completed'
        # status, since "no change in progress" is the correct terminal
        # state, not a a stale completion marker.
        self.assertEqual(final_config["entitlementChange"]["status"], "none")
        self.assertIsNotNone(final_config["entitlementChange"]["completedAt"])
        added_location_id = final_config["entitlementChange"]["addedLocationIds"][0]
        promoted = next(l for l in final_config["approvedLocations"] if l["locationId"] == added_location_id)
        self.assertTrue(promoted["operational"], "the newly added location must be promoted to operational: true once the entitlement change completes")

        final_meta = self._artifact_json(PILOT_TENANT, change_outcome["artifactGeneration"], "meta.json")
        self.assertEqual({l["locationId"] for l in final_meta["locations"]}, {1, 2}, "the published artifacts must reflect BOTH the original and the newly added location")
        self.assertEqual(final_meta["totalReviews"], 3, "the full re-sync must include every currently-approved location's reviews, not just the newly added one")


if __name__ == "__main__":
    unittest.main()
