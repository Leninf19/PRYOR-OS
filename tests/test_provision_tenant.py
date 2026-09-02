"""
Regression/adversarial tests for provision_tenant.py -- Multi-Tenant
Phase 4F (revised in Phase 4F.1 for durable Blob-backed storage). Drives the
real provisioning logic against a real (temp-file) SQLite file plus a fake,
in-memory tenant_config_store AND a fake, in-memory tenant_blob_store (no
real Upstash account, no real Vercel Blob store, no real network call, no
real Los Tres Amigos data anywhere in this file). The real dashboard/
reviews.db / dashboard/private-data (Los Tres Amigos's own production paths)
are asserted untouched throughout.

The fake Blob store below mimics the REAL semantics
tenant_blob_store.py's put_blob() exposes (allow_overwrite=False requires
non-existence, if_match requires the current ETag to match, raising
BlobPreconditionFailedError otherwise) -- this is what lets the concurrency
tests below prove the actual race-safety guarantee, not just that "a mock
was called."

Run directly: py tests/test_provision_tenant.py
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

import db  # noqa: E402
import provision_tenant as pt  # noqa: E402
import tenant_blob_keys  # noqa: E402
import tenant_blob_store  # noqa: E402
import tenant_config_store  # noqa: E402
import tenant_keys  # noqa: E402
import tenant_paths  # noqa: E402

TENANT_A = "t_synthetic-provision-tenant-a"
TENANT_B = "t_synthetic-provision-tenant-b"
UNKNOWN_TENANT = "t_never-onboarded-provision-tenant"

_LTA_REAL_DB_PATH = tenant_paths.BASE_DIR / "dashboard" / "reviews.db"


class FakeTenantConfigStore:
    """In-memory stand-in for the Redis-backed tenant_config:v1 hash,
    mirroring tenant_config_store.py's own default-merge shape exactly so
    provision_tenant.py sees byte-identical behavior to the real store."""

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
        """locations: [(googleLocationId, title, address)] -- mirrors
        tenantConfigStore.js's recordLocationApproval() reconciliation
        exactly, so tests can build realistic approvedLocations/
        locationIdMap state without going through the Node HTTP layer."""
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


class FakeBlobStore:
    """In-memory stand-in for Vercel Blob, matching tenant_blob_store.py's
    put_blob/head_blob/get_blob contract closely enough to exercise real
    optimistic-concurrency behavior: allow_overwrite=False rejects an
    already-existing pathname, if_match rejects a stale ETag -- both via
    BlobPreconditionFailedError, exactly like the real Blob API."""

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


class ProvisionTenantTestCase(unittest.TestCase):
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

        self._lta_db_mtime_before = _LTA_REAL_DB_PATH.stat().st_mtime if _LTA_REAL_DB_PATH.exists() else None

    def tearDown(self):
        self._get_patch.stop()
        self._upsert_patch.stop()
        self._put_blob_patch.stop()
        self._head_blob_patch.stop()
        self._get_blob_patch.stop()
        # Regression guard on EVERY test: Los Tres Amigos's real production
        # database must never be touched by any provisioning test.
        if self._lta_db_mtime_before is not None:
            self.assertEqual(_LTA_REAL_DB_PATH.stat().st_mtime, self._lta_db_mtime_before,
                              "a provisioning test must never modify the real Los Tres Amigos reviews.db")

    def _download_db(self, review_db_blob_key):
        """Downloads the fake Blob store's current bytes for this key to a
        real local temp file and returns its Path, so tests can run normal
        sqlite3 queries against it."""
        data = self.fake_blob.get_blob(review_db_blob_key)
        self.assertIsNotNone(data, f"expected a reviews.db Blob at {review_db_blob_key!r}")
        fd, tmp_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        Path(tmp_path).write_bytes(data)
        self.addCleanup(lambda: os.path.exists(tmp_path) and os.remove(tmp_path))
        return Path(tmp_path)

    def _private_data_json(self, generation, tenant_id, rel_path):
        key = tenant_blob_keys.generation_private_data_blob_key(tenant_id, generation, rel_path)
        data = self.fake_blob.get_blob(key)
        self.assertIsNotNone(data, f"expected a private-data Blob at {key!r}")
        return json.loads(data)

    def _locations_table(self, db_path):
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        try:
            return {row["id"]: dict(row) for row in conn.execute("SELECT * FROM locations").fetchall()}
        finally:
            conn.close()

    def _review_count(self, db_path):
        conn = sqlite3.connect(db_path)
        try:
            return conn.execute("SELECT COUNT(*) FROM reviews").fetchone()[0]
        finally:
            conn.close()

    # -----------------------------------------------------------------
    # Fresh provisioning
    # -----------------------------------------------------------------

    def test_fresh_provisioning_creates_db_and_private_data(self):
        self.fake_store.approve(TENANT_A, [
            ("accounts/1/locations/1", "Restaurant A", "1 Main St, Springfield"),
            ("accounts/1/locations/2", "Restaurant B", "2 Main St, Springfield"),
        ])
        result = pt.provision_tenant(TENANT_A)
        self.assertEqual(result["outcome"], "provisioned")
        self.assertEqual(result["locationIds"], [1, 2])

        db_path = self._download_db(result["reviewDbBlobKey"])
        meta = self._private_data_json(result["artifactGeneration"], TENANT_A, "meta.json")

        locations = self._locations_table(db_path)
        self.assertEqual(set(locations.keys()), {1, 2})
        self.assertEqual(locations[1]["gbp_location_name"], "accounts/1/locations/1")
        self.assertEqual(locations[2]["gbp_location_name"], "accounts/1/locations/2")
        self.assertEqual(self._review_count(db_path), 0, "a freshly provisioned database must contain zero reviews")

        self.assertEqual(meta["totalReviews"], 0)
        self.assertFalse(meta["initialSyncCompleted"])
        self.assertEqual({l["locationId"] for l in meta["locations"]}, {1, 2})

        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "provisioned")
        self.assertEqual(config["provisioning"]["status"], "provisioned")
        self.assertEqual(config["storageMode"], "BLOB")
        self.assertIsNotNone(config["provisioning"]["reviewDbEtag"])

    def test_no_fabricated_review_statistics(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/1", "Restaurant A", "")])
        result = pt.provision_tenant(TENANT_A)
        meta = self._private_data_json(result["artifactGeneration"], TENANT_A, "meta.json")
        self.assertEqual(meta["totalReviews"], 0)
        gbp_sync = self._private_data_json(result["artifactGeneration"], TENANT_A, "gbp-sync.json")
        self.assertTrue(gbp_sync["neverSynced"])
        action_items = self._private_data_json(result["artifactGeneration"], TENANT_A, "action-items.json")
        self.assertEqual(action_items["items"], [])

    # -----------------------------------------------------------------
    # Idempotency
    # -----------------------------------------------------------------

    def test_idempotent_reprovisioning_is_a_safe_no_op(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/1", "Restaurant A", "")])
        first = pt.provision_tenant(TENANT_A)
        locations_after_first = self._locations_table(self._download_db(first["reviewDbBlobKey"]))

        second = pt.provision_tenant(TENANT_A)
        self.assertEqual(second["outcome"], "already_provisioned")
        self.assertEqual(second["locationIds"], first["locationIds"])
        locations_after_second = self._locations_table(self._download_db(second["reviewDbBlobKey"]))
        self.assertEqual(locations_after_first, locations_after_second, "a re-run must never duplicate or alter existing location rows")

    def test_idempotent_reprovisioning_after_real_reviews_exist_is_still_a_no_op(self):
        """Even once Initial Sync has written real reviews (out of this
        phase's scope, but simulated here), a consistent re-run must remain
        a safe no-op -- it must never re-touch the database at all."""
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/1", "Restaurant A", "")])
        first = pt.provision_tenant(TENANT_A)
        db_path = self._download_db(first["reviewDbBlobKey"])
        conn = sqlite3.connect(db_path)
        conn.execute(
            "INSERT INTO reviews (location_id, dedup_key, reviewer_name, review_date, star_rating, review_text) "
            "VALUES (1, 'dedup-1', 'Alice', '2026-01-01', 5, 'Great!')"
        )
        conn.commit()
        conn.close()
        # Manually re-upload the mutated file to the fake Blob store at the
        # SAME etag-bearing key, simulating a real review having been
        # synced there by a (not-yet-built) Initial Sync process.
        existing_etag = self.fake_blob.objects[first["reviewDbBlobKey"]]["etag"]
        self.fake_blob.objects[first["reviewDbBlobKey"]] = {"data": db_path.read_bytes(), "etag": existing_etag}

        second = pt.provision_tenant(TENANT_A)
        self.assertEqual(second["outcome"], "already_provisioned")
        self.assertEqual(self._review_count(self._download_db(second["reviewDbBlobKey"])), 1, "the real review row must survive an idempotent re-run untouched")

    # -----------------------------------------------------------------
    # Failed mid-provision retry
    # -----------------------------------------------------------------

    def test_failed_provisioning_leaves_no_db_blob_and_retry_succeeds(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/1", "Restaurant A", "")])
        db_key = tenant_blob_keys.review_db_blob_key(TENANT_A)

        with mock.patch.object(pt, "_build_initial_artifacts", side_effect=RuntimeError("simulated crash mid-provision")):
            with self.assertRaises(RuntimeError):
                pt.provision_tenant(TENANT_A)

        self.assertNotIn(db_key, self.fake_blob.objects, "a failed provisioning attempt must leave NO reviews.db Blob at all")
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "provisioning_failed")
        self.assertIn("simulated crash", config["provisioning"]["lastError"])

        result = pt.provision_tenant(TENANT_A)
        self.assertEqual(result["outcome"], "provisioned")
        self.assertIn(db_key, self.fake_blob.objects)

    def test_failed_upload_between_db_and_private_data_recovers_on_retry(self):
        """The reviews.db upload can succeed while a LATER private-data
        upload fails (two separate Blob objects, no cross-object atomicity)
        -- a retry must detect and repair the incomplete private-data set,
        never silently confirm 'provisioned' with missing artifacts."""
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/1", "Restaurant A", "")])

        with mock.patch.object(pt, "_upload_private_data_artifacts", side_effect=RuntimeError("simulated network failure uploading private-data")):
            with self.assertRaises(RuntimeError):
                pt.provision_tenant(TENANT_A)

        db_key = tenant_blob_keys.review_db_blob_key(TENANT_A)
        self.assertIn(db_key, self.fake_blob.objects, "the reviews.db upload that already completed must not be rolled back")
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "provisioning_failed")

        result = pt.provision_tenant(TENANT_A)
        self.assertEqual(result["outcome"], "already_provisioned", "the retry finds the already-uploaded, consistent database")
        meta = self._private_data_json(result["artifactGeneration"], TENANT_A, "meta.json")
        self.assertEqual({l["locationId"] for l in meta["locations"]}, {1}, "the retry must repair the missing private-data artifacts")
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "provisioned")

    # -----------------------------------------------------------------
    # Stable location IDs: add / remove / re-add / reorder
    # -----------------------------------------------------------------

    def test_stable_ids_survive_reapproving_a_subset(self):
        self.fake_store.approve(TENANT_A, [
            ("accounts/1/locations/a", "A", ""),
            ("accounts/1/locations/b", "B", ""),
            ("accounts/1/locations/c", "C", ""),
        ])
        first = pt.provision_tenant(TENANT_A)
        self.assertEqual(first["locationIds"], [1, 2, 3])

        self.fake_store.approve(TENANT_A, [
            ("accounts/1/locations/b", "B", ""),
            ("accounts/1/locations/c", "C", ""),
        ])
        second = pt.provision_tenant(TENANT_A)
        self.assertEqual(second["outcome"], "already_provisioned", "B and C already have consistent rows -- nothing to change")
        locations = self._locations_table(self._download_db(second["reviewDbBlobKey"]))
        self.assertEqual(locations[2]["gbp_location_name"], "accounts/1/locations/b", "B must keep id 2")
        self.assertEqual(locations[3]["gbp_location_name"], "accounts/1/locations/c", "C must keep id 3")
        self.assertIn(1, locations, "A's row must not be deleted merely because it left the approved set")

    def test_adding_a_new_location_allocates_a_never_before_used_id(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        pt.provision_tenant(TENANT_A)

        self.fake_store.approve(TENANT_A, [
            ("accounts/1/locations/a", "A", ""),
            ("accounts/1/locations/d", "D", ""),
        ])
        result = pt.provision_tenant(TENANT_A)
        self.assertEqual(result["outcome"], "reconciled")
        self.assertEqual(result["locationIds"], [1, 2])
        locations = self._locations_table(self._download_db(result["reviewDbBlobKey"]))
        self.assertEqual(locations[1]["gbp_location_name"], "accounts/1/locations/a", "A must keep its original id 1")
        self.assertEqual(locations[2]["gbp_location_name"], "accounts/1/locations/d", "D must get a genuinely new id, never 1")

    def test_removing_then_readding_a_location_restores_its_original_id_never_drifts(self):
        self.fake_store.approve(TENANT_A, [
            ("accounts/1/locations/a", "A", ""),
            ("accounts/1/locations/b", "B", ""),
            ("accounts/1/locations/c", "C", ""),
        ])
        pt.provision_tenant(TENANT_A)  # A=1, B=2, C=3

        self.fake_store.approve(TENANT_A, [
            ("accounts/1/locations/a", "A", ""),
            ("accounts/1/locations/c", "C", ""),
        ])
        pt.provision_tenant(TENANT_A)

        result = self.fake_store.approve(TENANT_A, [
            ("accounts/1/locations/a", "A", ""),
            ("accounts/1/locations/b", "B", ""),
            ("accounts/1/locations/c", "C", ""),
        ])
        self.assertEqual(result["locationIdMap"]["accounts/1/locations/b"], 2, "B's re-approval must reuse its ORIGINAL id 2, never a new one")
        final = pt.provision_tenant(TENANT_A)
        locations = self._locations_table(self._download_db(final["reviewDbBlobKey"]))
        self.assertEqual(locations[2]["gbp_location_name"], "accounts/1/locations/b", "B's former id must never silently refer to C or D")

    def test_reordering_an_already_established_set_changes_nothing(self):
        self.fake_store.approve(TENANT_A, [
            ("accounts/1/locations/a", "A", ""),
            ("accounts/1/locations/b", "B", ""),
            ("accounts/1/locations/c", "C", ""),
        ])
        first = pt.provision_tenant(TENANT_A)
        self.assertEqual(first["locationIds"], [1, 2, 3])

        self.fake_store.approve(TENANT_A, [
            ("accounts/1/locations/c", "C", ""),
            ("accounts/1/locations/b", "B", ""),
            ("accounts/1/locations/a", "A", ""),
        ])
        second = pt.provision_tenant(TENANT_A)
        locations = self._locations_table(self._download_db(second["reviewDbBlobKey"]))
        self.assertEqual(locations[1]["gbp_location_name"], "accounts/1/locations/a", "A must keep id 1 regardless of array order in the re-approval")
        self.assertEqual(locations[2]["gbp_location_name"], "accounts/1/locations/b", "B must keep id 2 regardless of array order in the re-approval")
        self.assertEqual(locations[3]["gbp_location_name"], "accounts/1/locations/c", "C must keep id 3 regardless of array order in the re-approval")

    # -----------------------------------------------------------------
    # Duplicate / conflicting mapping rejection
    # -----------------------------------------------------------------

    def test_conflicting_location_id_map_fails_closed_before_any_blob_access(self):
        self.fake_store.upsert(TENANT_A, {
            "status": "locations_approved", "locationCatalogEnabled": True,
            "approvedLocations": [
                {"locationId": 1, "googleLocationId": "accounts/1/locations/a", "title": "A", "address": ""},
                {"locationId": 1, "googleLocationId": "accounts/1/locations/b", "title": "B", "address": ""},
            ],
            "locationIdMap": {"accounts/1/locations/a": 1, "accounts/1/locations/b": 1},
        })
        with self.assertRaises(pt.LocationMappingConsistencyError):
            pt.provision_tenant(TENANT_A)
        self.assertEqual(self.fake_blob.objects, {}, "a conflicting mapping must never upload any Blob resource")

    def test_approved_location_missing_from_map_fails_closed(self):
        self.fake_store.upsert(TENANT_A, {
            "status": "locations_approved", "locationCatalogEnabled": True,
            "approvedLocations": [{"locationId": 1, "googleLocationId": "accounts/1/locations/a", "title": "A", "address": ""}],
            "locationIdMap": {},
        })
        with self.assertRaises(pt.LocationMappingConsistencyError):
            pt.provision_tenant(TENANT_A)

    def test_approved_location_disagreeing_with_map_fails_closed(self):
        self.fake_store.upsert(TENANT_A, {
            "status": "locations_approved", "locationCatalogEnabled": True,
            "approvedLocations": [{"locationId": 1, "googleLocationId": "accounts/1/locations/a", "title": "A", "address": ""}],
            "locationIdMap": {"accounts/1/locations/a": 2},
        })
        with self.assertRaises(pt.LocationMappingConsistencyError):
            pt.provision_tenant(TENANT_A)

    def test_existing_database_with_mismatched_id_is_refused_not_overwritten(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        pt.provision_tenant(TENANT_A)

        record = self.fake_store.get(TENANT_A)
        record["approvedLocations"] = [{"locationId": 1, "googleLocationId": "accounts/1/locations/ZZZ", "title": "Z", "address": ""}]
        record["locationIdMap"] = {"accounts/1/locations/ZZZ": 1}

        with self.assertRaises(pt.ProvisioningRefusedError):
            pt.provision_tenant(TENANT_A)

    # -----------------------------------------------------------------
    # Tenant isolation
    # -----------------------------------------------------------------

    def test_tenant_a_provisioning_cannot_touch_tenant_bs_db(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        self.fake_store.approve(TENANT_B, [("accounts/2/locations/b", "B", "")])
        result_a = pt.provision_tenant(TENANT_A)
        result_b = pt.provision_tenant(TENANT_B)

        self.assertNotEqual(result_a["reviewDbBlobKey"], result_b["reviewDbBlobKey"])
        locations_a = self._locations_table(self._download_db(result_a["reviewDbBlobKey"]))
        locations_b = self._locations_table(self._download_db(result_b["reviewDbBlobKey"]))
        self.assertEqual(list(locations_a.values())[0]["gbp_location_name"], "accounts/1/locations/a")
        self.assertEqual(list(locations_b.values())[0]["gbp_location_name"], "accounts/2/locations/b")

    def test_a_failed_tenant_a_attempt_cannot_alter_tenant_b(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        self.fake_store.approve(TENANT_B, [("accounts/2/locations/b", "B", "")])
        result_b = pt.provision_tenant(TENANT_B)
        b_locations_before = self._locations_table(self._download_db(result_b["reviewDbBlobKey"]))

        with mock.patch.object(pt, "_build_initial_artifacts", side_effect=RuntimeError("simulated crash for A only")):
            with self.assertRaises(RuntimeError):
                pt.provision_tenant(TENANT_A)

        config_b = self.fake_store.get(TENANT_B)
        self.assertEqual(config_b["status"], "provisioned", "Tenant B's status must be completely unaffected by Tenant A's failure")
        self.assertEqual(self._locations_table(self._download_db(result_b["reviewDbBlobKey"])), b_locations_before)

    def test_path_traversal_shaped_tenant_id_fails_closed_before_any_access(self):
        for bad in ("t_../../etc", "t_..", "t_/etc/passwd", "../t_evil", "t_a/b"):
            with mock.patch.object(tenant_config_store, "get_tenant_config") as mock_get:
                with self.assertRaises(tenant_keys.InvalidTenantIdError, msg=f"expected rejection for {bad!r}"):
                    pt.provision_tenant(bad)
                mock_get.assert_not_called()

    def test_unknown_tenant_fails_closed_before_any_blob_access(self):
        with self.assertRaises(pt.UnknownTenantConfigError):
            pt.provision_tenant(UNKNOWN_TENANT)
        self.assertEqual(self.fake_blob.objects, {})

    def test_unapproved_tenant_fails_closed(self):
        self.fake_store.upsert(TENANT_A, {"status": "onboarding"})
        with self.assertRaises(pt.TenantNotApprovedError):
            pt.provision_tenant(TENANT_A)

        self.fake_store.upsert(TENANT_A, {"status": "suspended"})
        with self.assertRaises(pt.TenantNotApprovedError):
            pt.provision_tenant(TENANT_A)

    def test_no_approved_locations_fails_closed(self):
        self.fake_store.upsert(TENANT_A, {"status": "locations_approved", "approvedLocations": []})
        with self.assertRaises(pt.NoApprovedLocationsError):
            pt.provision_tenant(TENANT_A)

    def test_legacy_repo_tenant_is_refused_not_provisioned(self):
        """This script only ever provisions BLOB-mode tenants -- Los Tres
        Amigos (or any hypothetical future LEGACY_REPO tenant) must be
        refused outright, never silently 'adapted to'."""
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        self.fake_store.upsert(TENANT_A, {"storageMode": "LEGACY_REPO"})
        with self.assertRaises(pt.UnsupportedStorageModeError):
            pt.provision_tenant(TENANT_A)
        self.assertEqual(self.fake_blob.objects, {})

    # -----------------------------------------------------------------
    # No LTA fallback / no copying of LTA artifacts
    # -----------------------------------------------------------------

    def test_provisioned_blob_key_never_resembles_the_real_lta_path(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        result = pt.provision_tenant(TENANT_A)
        self.assertNotIn("dashboard", result["reviewDbBlobKey"])
        self.assertTrue(result["reviewDbBlobKey"].startswith(f"tenant-data/{TENANT_A}/"))

    def test_generated_artifacts_never_contain_lta_brand_or_location_names(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "Tenant A's Own Restaurant", "")])
        result = pt.provision_tenant(TENANT_A)
        meta_text = json.dumps(self._private_data_json(result["artifactGeneration"], TENANT_A, "meta.json"))
        for lta_brand in db.BRANDS:
            self.assertNotIn(lta_brand, meta_text, f"generated meta.json must never contain LTA's own brand name {lta_brand!r}")

    # -----------------------------------------------------------------
    # Multi-Tenant Phase 4F closure -- tenant_config:v1 concurrency /
    # optimistic-versioning adversarial tests (unchanged in spirit under
    # Phase 4F.1: still proves the configVersion CAS binding holds, just
    # against the Blob-backed orchestration).
    # -----------------------------------------------------------------

    def test_suspension_during_provisioning_cannot_be_overwritten_by_completion(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        original_verify = pt._verify_staging

        def verify_then_suspend(*args, **kwargs):
            original_verify(*args, **kwargs)
            self.fake_store.upsert(TENANT_A, {"status": "suspended"})

        with mock.patch.object(pt, "_verify_staging", side_effect=verify_then_suspend):
            with self.assertRaises(pt.StaleProvisioningAttemptError):
                pt.provision_tenant(TENANT_A)

        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "suspended", "the newer suspension must survive -- a stale completion must never overwrite it")

    def test_changed_approved_locations_during_provisioning_causes_stale_completion_to_fail(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        original_verify = pt._verify_staging

        def verify_then_change_locations(*args, **kwargs):
            original_verify(*args, **kwargs)
            self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", ""), ("accounts/1/locations/d", "D", "")])

        with mock.patch.object(pt, "_verify_staging", side_effect=verify_then_change_locations):
            with self.assertRaises(pt.StaleProvisioningAttemptError):
                pt.provision_tenant(TENANT_A)

        config = self.fake_store.get(TENANT_A)
        self.assertEqual(len(config["approvedLocations"]), 2, "the newer approved-locations change must survive completely")
        self.assertNotEqual(config["status"], "provisioned", "the stale attempt (validated against only 1 location) must never have published itself as successful")

    def test_two_overlapping_provisioning_attempts_cannot_corrupt_the_record(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        original_verify = pt._verify_staging
        ran_inner = []

        def verify_then_run_concurrent_attempt(*args, **kwargs):
            original_verify(*args, **kwargs)
            if not ran_inner:
                ran_inner.append(True)
                pt.provision_tenant(TENANT_A)

        with mock.patch.object(pt, "_verify_staging", side_effect=verify_then_run_concurrent_attempt):
            try:
                pt.provision_tenant(TENANT_A)
            except Exception:
                pass

        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "provisioned", "exactly one attempt's success must be recorded, cleanly")
        self.assertEqual(config["provisioning"]["status"], "provisioned")
        locations = self._locations_table(self._download_db(config["provisioning"]["reviewDbBlobKey"]))
        self.assertEqual(set(locations.keys()), {1}, "the final database must be fully consistent, never a partial/corrupted hybrid of both attempts")
        self.assertEqual(locations[1]["gbp_location_name"], "accounts/1/locations/a")

    def test_stale_failed_attempt_cannot_overwrite_newer_successful_attempt(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        original_build = pt._build_database_file
        triggered = []

        def build_then_fail(*args, **kwargs):
            if not triggered:
                triggered.append(True)
                pt.provision_tenant(TENANT_A)
                raise RuntimeError("simulated failure in the stale attempt")
            return original_build(*args, **kwargs)

        with mock.patch.object(pt, "_build_database_file", side_effect=build_then_fail):
            with self.assertRaises(RuntimeError):
                pt.provision_tenant(TENANT_A)

        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "provisioned", "the newer successful attempt must survive a stale failure report")
        self.assertEqual(config["provisioning"]["status"], "provisioned")
        self.assertIsNone(config["provisioning"]["lastError"], "a stale failure must never overwrite the newer success's clean state")

    def test_unrelated_fields_survive_provisioning_updates(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        self.fake_store.upsert(TENANT_A, {"displayName": "My Restaurant Group", "brands": ["Brand X"], "logoUrl": "https://example.com/logo.png"})
        pt.provision_tenant(TENANT_A)
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["displayName"], "My Restaurant Group")
        self.assertEqual(config["brands"], ["Brand X"])
        self.assertEqual(config["logoUrl"], "https://example.com/logo.png")

    def test_no_whole_record_stale_write_can_erase_newer_node_owned_fields(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        original_verify = pt._verify_staging

        def verify_then_node_writes(*args, **kwargs):
            original_verify(*args, **kwargs)
            self.fake_store.upsert(TENANT_A, {"displayName": "Renamed By Node", "brands": ["New Brand"]})

        with mock.patch.object(pt, "_verify_staging", side_effect=verify_then_node_writes):
            with self.assertRaises(pt.StaleProvisioningAttemptError):
                pt.provision_tenant(TENANT_A)

        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["displayName"], "Renamed By Node", "Node's newer write must survive completely untouched")
        self.assertEqual(config["brands"], ["New Brand"])
        self.assertNotEqual(config["status"], "provisioned", "the stale Python attempt must never commit ANY part of its write -- whole-record rejection, not a partial merge")

    # -----------------------------------------------------------------
    # Multi-Tenant Phase 4F.1 -- reviews.db Blob-level optimistic
    # concurrency (independent of, and in ADDITION to, the tenant_config
    # CAS above). These prove the guarantee comes from Vercel Blob's own
    # ifMatch/allowOverwrite mechanism, not merely "this probably won't
    # race in practice."
    # -----------------------------------------------------------------

    def test_reconcile_upload_rejects_a_stale_etag(self):
        """A worker that read the database's ETag before someone else
        uploaded a newer version must never be able to overwrite that newer
        version -- proven directly against the upload helper, independent
        of the whole provision_tenant() orchestration."""
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        first = pt.provision_tenant(TENANT_A)
        stale_etag = self.fake_blob.objects[first["reviewDbBlobKey"]]["etag"]

        # Someone else (e.g. a future sync worker) publishes a newer
        # generation directly, bumping the Blob's ETag.
        self.fake_blob.put_blob(first["reviewDbBlobKey"], b"newer-generation-bytes", if_match=stale_etag)

        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp) / "reviews.db"
            local.write_bytes(b"attempted-stale-overwrite")
            with self.assertRaises(pt.StaleProvisioningAttemptError):
                pt._upload_reconciled_database(first["reviewDbBlobKey"], local, stale_etag)

        # The newer generation's bytes must be exactly what survives.
        self.assertEqual(self.fake_blob.get_blob(first["reviewDbBlobKey"]), b"newer-generation-bytes")

    def test_fresh_upload_rejects_a_racing_first_writer(self):
        """Two 'workers' race to create the SAME tenant's reviews.db for
        the first time -- only one may succeed; the other must be refused
        by Blob itself (allow_overwrite=False), never silently overwrite."""
        key = tenant_blob_keys.review_db_blob_key(TENANT_A)
        with tempfile.TemporaryDirectory() as tmp:
            winner = Path(tmp) / "winner.db"
            winner.write_bytes(b"winner-bytes")
            loser = Path(tmp) / "loser.db"
            loser.write_bytes(b"loser-bytes")

            pt._upload_fresh_database(key, winner)
            with self.assertRaises(pt.StaleProvisioningAttemptError):
                pt._upload_fresh_database(key, loser)

        self.assertEqual(self.fake_blob.get_blob(key), b"winner-bytes", "the second (losing) writer must never overwrite the first")

    def test_two_concurrent_reconcile_attempts_only_one_survives(self):
        """Both attempts read the SAME starting ETag (a genuinely
        simultaneous race, not merely sequential retries) -- exactly one
        upload may succeed; the other must fail with
        StaleProvisioningAttemptError, and the surviving content must be
        internally consistent (never a corrupted hybrid)."""
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        first = pt.provision_tenant(TENANT_A)
        shared_starting_etag = self.fake_blob.objects[first["reviewDbBlobKey"]]["etag"]

        with tempfile.TemporaryDirectory() as tmp:
            attempt_1 = Path(tmp) / "attempt1.db"
            attempt_1.write_bytes(b"attempt-1-bytes")
            attempt_2 = Path(tmp) / "attempt2.db"
            attempt_2.write_bytes(b"attempt-2-bytes")

            pt._upload_reconciled_database(first["reviewDbBlobKey"], attempt_1, shared_starting_etag)
            with self.assertRaises(pt.StaleProvisioningAttemptError):
                pt._upload_reconciled_database(first["reviewDbBlobKey"], attempt_2, shared_starting_etag)

        self.assertEqual(self.fake_blob.get_blob(first["reviewDbBlobKey"]), b"attempt-1-bytes")

    def test_a_failed_upload_never_advances_the_confirmed_generation(self):
        """If the Blob upload itself throws (a genuine transport failure,
        not a precondition rejection), tenant_config must never be told a
        new generation was confirmed -- the previously confirmed ETag must
        remain exactly what it was."""
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        first = pt.provision_tenant(TENANT_A)
        confirmed_etag_before = self.fake_store.get(TENANT_A)["provisioning"]["reviewDbEtag"]

        with mock.patch.object(tenant_blob_store, "put_blob", side_effect=tenant_blob_store.BlobStoreUnavailableError("simulated transport failure")):
            with tempfile.TemporaryDirectory() as tmp:
                local = Path(tmp) / "reviews.db"
                local.write_bytes(b"irrelevant")
                with self.assertRaises(tenant_blob_store.BlobStoreUnavailableError):
                    pt._upload_reconciled_database(first["reviewDbBlobKey"], local, confirmed_etag_before)

        config_after = self.fake_store.get(TENANT_A)
        self.assertEqual(config_after["provisioning"]["reviewDbEtag"], confirmed_etag_before, "a failed upload must never advance the confirmed generation")

    def test_retry_after_reconcile_race_starts_from_the_current_durable_version(self):
        """After losing a reconcile race, a fresh top-level retry must
        re-read whatever generation actually won and reconcile against
        THAT, never retry blindly against its own stale view."""
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", "")])
        first = pt.provision_tenant(TENANT_A)

        # A newer generation (e.g. a future sync worker) publishes directly.
        winner_etag = self.fake_blob.put_blob(first["reviewDbBlobKey"], self.fake_blob.get_blob(first["reviewDbBlobKey"]), if_match=self.fake_blob.objects[first["reviewDbBlobKey"]]["etag"])["etag"]

        self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", ""), ("accounts/1/locations/d", "D", "")])
        result = pt.provision_tenant(TENANT_A)
        self.assertEqual(result["outcome"], "reconciled")
        self.assertNotEqual(self.fake_blob.objects[result["reviewDbBlobKey"]]["etag"], winner_etag, "the retry must produce a NEW generation on top of the current durable one, not reuse a stale etag")
        locations = self._locations_table(self._download_db(result["reviewDbBlobKey"]))
        self.assertEqual(set(locations.keys()), {1, 2})


if __name__ == "__main__":
    unittest.main()
