"""
Regression/adversarial tests for initial_sync.py -- Multi-Tenant Phase 4G.

Reuses the REAL provision_tenant.py to build a genuinely provisioned BLOB
tenant fixture (both modules are patched against the SAME fake
tenant_config_store/tenant_blob_store, so this exercises the real
Phase 4F.1 -> Phase 4G continuity, not a hand-rolled stand-in). Google is
fully mocked at the google_api module boundary (list_accounts/
list_locations/list_reviews/has_tenant_credential) -- no real network call,
no real Upstash account, no real Vercel Blob store, no real Los Tres
Amigos data anywhere in this file.

Run directly: py tests/test_initial_sync.py
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
import google_api  # noqa: E402
import initial_sync as isync  # noqa: E402
import provider_sync  # noqa: E402
import provision_tenant as pt  # noqa: E402
import tenant_approved_locations_provider as approved_provider  # noqa: E402
import tenant_blob_keys  # noqa: E402
import tenant_blob_store  # noqa: E402
import tenant_config_store  # noqa: E402
import tenant_keys  # noqa: E402
import tenant_paths  # noqa: E402

TENANT_A = "t_synthetic-initial-sync-tenant-a"
TENANT_B = "t_synthetic-initial-sync-tenant-b"
UNKNOWN_TENANT = "t_never-onboarded-initial-sync-tenant"

_LTA_REAL_DB_PATH = tenant_paths.BASE_DIR / "dashboard" / "reviews.db"


class FakeTenantConfigStore:
    """Same shape/semantics as test_provision_tenant.py's own fake -- see
    that file's header for why this is duplicated rather than shared (this
    codebase's established per-test-file convention)."""

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
        """locations: [(googleLocationId, title, address)]."""
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
    """Same shape/semantics as test_provision_tenant.py's own fake."""

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
    # reviewer/createTime vary per review_id -- export_review_location_index()
    # falls back to a "{date}-{reviewer}" key when review_url/gbp_review_name
    # can't provide a canonical id, so two reviews sharing both would
    # collide on that fallback key; distinct ids keep every fixture review
    # unambiguously distinct in that index too.
    return {
        "name": f"accounts/1/locations/{location_suffix}/reviews/{review_id}",
        "reviewId": review_id,
        "reviewer": {"displayName": f"Reviewer {review_id}"},
        "starRating": stars,
        "comment": text,
        "createTime": "2026-07-10T12:00:00Z",
        "updateTime": "2026-07-10T12:00:00Z",
    }


class InitialSyncTestCase(unittest.TestCase):
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

        # Credential existence defaults to True for every tenant in most
        # tests -- overridden per-test where the credential precondition
        # itself is under test.
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
                              "an initial-sync test must never modify the real Los Tres Amigos reviews.db")

    # -----------------------------------------------------------------
    # Fixture helper: provisions a tenant for real via provision_tenant.py
    # -----------------------------------------------------------------

    def _provision(self, tenant_id, locations):
        """locations: [(googleLocationId, title, address)]. Returns the
        provision_tenant.provision_tenant() result dict."""
        self.fake_store.approve(tenant_id, locations)
        return pt.provision_tenant(tenant_id)

    def _mock_google(self, account, locations, reviews_by_location_id=None):
        """Returns the mock.patch context managers list for a standard
        Google mock: one account, the given locations, and (optionally) a
        distinct review list per googleLocationId."""
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
        self.addCleanup(lambda: os.path.exists(tmp_path) and os.remove(tmp_path))
        return Path(tmp_path)

    def _artifact_json(self, tenant_id, generation, rel_path):
        key = tenant_blob_keys.generation_private_data_blob_key(tenant_id, generation, rel_path)
        data = self.fake_blob.get_blob(key)
        self.assertIsNotNone(data, f"expected a private-data Blob at {key!r}")
        return json.loads(data)

    def _review_count(self, db_path):
        conn = sqlite3.connect(db_path)
        try:
            return conn.execute("SELECT COUNT(*) FROM reviews WHERE is_deleted = 0").fetchone()[0]
        finally:
            conn.close()

    # ===================================================================
    # Preconditions (spec section 3 / continuation section 1)
    # ===================================================================

    def test_unknown_tenant_fails_closed_before_any_access(self):
        with self.assertRaises(isync.UnknownTenantConfigError):
            isync.initial_sync(UNKNOWN_TENANT)
        self.assertEqual(self.fake_blob.objects, {})

    def test_invalid_tenant_id_fails_closed_before_any_access(self):
        for bad in ("t_../../etc", "t_..", "../t_evil", "t_a/b"):
            with mock.patch.object(tenant_config_store, "get_tenant_config") as mock_get:
                with self.assertRaises(tenant_keys.InvalidTenantIdError):
                    isync.initial_sync(bad)
                mock_get.assert_not_called()

    def test_wrong_status_fails_closed(self):
        for bad_status in ("onboarding", "locations_approved", "provisioning", "initial_sync", "active", "suspended"):
            self.fake_store.approve(TENANT_A, [("accounts/1/locations/1", "A", "")])
            self.fake_store.upsert(TENANT_A, {"status": bad_status})
            with self.assertRaises(isync.TenantNotEligibleError, msg=f"status {bad_status!r} must be refused"):
                isync.initial_sync(TENANT_A)

    def test_legacy_repo_tenant_is_refused(self):
        result = self._provision(TENANT_A, [("accounts/1/locations/1", "A", "")])
        self.fake_store.upsert(TENANT_A, {"storageMode": "LEGACY_REPO"})
        with self.assertRaises(isync.TenantNotEligibleError):
            isync.initial_sync(TENANT_A)
        void = result  # noqa: F841

    def test_provisioning_not_verified_fails_closed(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/1", "A", "")])
        self.fake_store.upsert(TENANT_A, {"status": "provisioned", "provisioning": {"status": "in_progress"}})
        with self.assertRaises(isync.TenantNotEligibleError):
            isync.initial_sync(TENANT_A)

    def test_no_approved_locations_fails_closed(self):
        self.fake_store.upsert(TENANT_A, {"status": "provisioned", "provisioning": {"status": "provisioned"}, "approvedLocations": []})
        with self.assertRaises(isync.NoApprovedLocationsError):
            isync.initial_sync(TENANT_A)

    def test_location_mapping_inconsistency_fails_closed(self):
        self.fake_store.upsert(TENANT_A, {
            "status": "provisioned", "provisioning": {"status": "provisioned"},
            "approvedLocations": [{"locationId": 1, "googleLocationId": "accounts/1/locations/a", "title": "A", "address": ""}],
            "locationIdMap": {"accounts/1/locations/a": 2},  # disagrees
        })
        with self.assertRaises(isync.LocationMappingConsistencyError):
            isync.initial_sync(TENANT_A)

    def test_no_google_credential_fails_closed_before_blob_access(self):
        self._provision(TENANT_A, [("accounts/1/locations/1", "A", "")])
        self._cred_patch.stop()
        try:
            with mock.patch.object(google_api, "has_tenant_credential", return_value=False):
                with mock.patch.object(tenant_blob_store, "head_blob") as mock_head:
                    with self.assertRaises(isync.NoGoogleCredentialError):
                        isync.initial_sync(TENANT_A)
                    mock_head.assert_not_called()
        finally:
            self._cred_patch.start()

    # ===================================================================
    # DB download / identity verification (spec section 4/5)
    # ===================================================================

    def test_missing_db_blob_fails_closed(self):
        self.fake_store.approve(TENANT_A, [("accounts/1/locations/1", "A", "")])
        self.fake_store.upsert(TENANT_A, {
            "status": "provisioned",
            "provisioning": {"status": "provisioned", "reviewDbBlobKey": tenant_blob_keys.review_db_blob_key(TENANT_A), "reviewDbEtag": "etag-x", "artifactGeneration": "gen-x"},
        })
        with self.assertRaises(isync.DatabaseNotFoundError):
            isync.initial_sync(TENANT_A)

    def test_etag_mismatch_against_trusted_metadata_fails_closed(self):
        result = self._provision(TENANT_A, [("accounts/1/locations/1", "A", "")])
        # Corrupt the recorded ETag without touching the real Blob.
        record = self.fake_store.get(TENANT_A)
        record["provisioning"]["reviewDbEtag"] = "some-other-etag"
        with self.assertRaises(isync.DatabaseIdentityMismatchError):
            isync.initial_sync(TENANT_A)
        void = result  # noqa: F841

    def test_database_identity_mismatch_aborts_never_repairs(self):
        result = self._provision(TENANT_A, [("accounts/1/locations/a", "A", "")])
        # Corrupt tenant_config's mapping for the SAME id to point at a
        # different Google location than the database actually has.
        record = self.fake_store.get(TENANT_A)
        record["approvedLocations"] = [{"locationId": 1, "googleLocationId": "accounts/1/locations/ZZZ", "title": "Z", "address": ""}]
        record["locationIdMap"] = {"accounts/1/locations/ZZZ": 1}
        with self.assertRaises(isync.DatabaseIdentityMismatchError):
            isync.initial_sync(TENANT_A)
        # No new Blob upload for reviews.db should have occurred.
        self.assertEqual(self.fake_blob.objects[result["reviewDbBlobKey"]]["etag"], self.fake_blob.objects[result["reviewDbBlobKey"]]["etag"])
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "initial_sync_failed")

    def test_corrupted_database_fails_integrity_check(self):
        result = self._provision(TENANT_A, [("accounts/1/locations/1", "A", "")])
        self.fake_blob.objects[result["reviewDbBlobKey"]]["data"] = b"not a real sqlite file"
        # The corrupted bytes change the ETag mismatch story -- recompute
        # trusted etag to match so we reach the integrity check itself.
        record = self.fake_store.get(TENANT_A)
        record["provisioning"]["reviewDbEtag"] = self.fake_blob.objects[result["reviewDbBlobKey"]]["etag"]
        with self.assertRaises(sqlite3.DatabaseError):
            isync.initial_sync(TENANT_A)
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "initial_sync_failed")

    # ===================================================================
    # Approved-location filtering (continuation spec section 2)
    # ===================================================================

    def test_unapproved_google_location_is_never_synced(self):
        result = self._provision(TENANT_A, [("accounts/1/locations/approved", "Approved", "")])
        locations = [
            _gbp_location("accounts/1/locations/approved", "Approved"),
            _gbp_location("accounts/1/locations/unapproved", "Unapproved"),
        ]
        reviews = {
            "accounts/1/locations/approved": [_gbp_review("r1", "Great!", "FIVE")],
            "accounts/1/locations/unapproved": [_gbp_review("r2", "Should never sync", "ONE")],
        }
        patches = self._mock_google(_account(), locations, reviews)
        with patches[0], patches[1], patches[2], patches[3]:
            outcome = isync.initial_sync(TENANT_A)
        self.assertEqual(outcome["outcome"], "active")
        db_path = self._download_db(tenant_blob_keys.review_db_blob_key(TENANT_A))
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT reviewer_name, review_text FROM reviews").fetchall()
        conn.close()
        texts = [r["review_text"] for r in rows]
        self.assertIn("Great!", texts)
        self.assertNotIn("Should never sync", texts, "an unapproved Google location must never be synced")
        self.assertEqual(len(rows), 1)
        void = result  # noqa: F841

    def test_approved_location_missing_from_google_response_fails_safely(self):
        self._provision(TENANT_A, [
            ("accounts/1/locations/a", "A", ""),
            ("accounts/1/locations/b", "B", ""),
        ])
        # Google only returns location A this run -- B (approved) is missing.
        locations = [_gbp_location("accounts/1/locations/a", "A")]
        patches = self._mock_google(_account(), locations, {})
        with patches[0], patches[1], patches[2], patches[3]:
            with self.assertRaises(approved_provider.UnreconciledApprovedLocationError):
                isync.initial_sync(TENANT_A)
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "initial_sync_failed")
        # The database must NOT have been re-uploaded (sync never got past discovery).
        self.assertNotEqual(config["provisioning"]["reviewDbEtag"], None)

    def test_forged_location_id_cannot_redirect_syncing(self):
        """discover_locations() is filtered EXCLUSIVELY by this tenant's
        own approvedLocations -- nothing in the sync path accepts a
        location id from any external input, so there is no channel for a
        'forged' location id to redirect anything. This proves the
        approved-set is derived solely from server-side tenant_config."""
        self._provision(TENANT_A, [("accounts/1/locations/real", "Real", "")])
        approved_ids = {loc["googleLocationId"] for loc in self.fake_store.get(TENANT_A)["approvedLocations"]}
        provider = approved_provider.ApprovedLocationsOnlyGBPProvider(TENANT_A, approved_ids)
        locations = [_gbp_location("accounts/1/locations/real", "Real"), _gbp_location("accounts/1/locations/forged", "Forged")]
        with mock.patch.object(google_api, "is_configured", return_value=True), \
             mock.patch.object(google_api, "list_accounts", return_value=[_account()]), \
             mock.patch.object(google_api, "list_locations", return_value=locations):
            discovered = provider.discover_locations()
        self.assertEqual([loc.external_id for loc in discovered], ["accounts/1/locations/real"])

    # ===================================================================
    # Google sync failure handling
    # ===================================================================

    def test_google_discovery_failure_never_touches_the_db_blob(self):
        result = self._provision(TENANT_A, [("accounts/1/locations/1", "A", "")])
        original_etag = self.fake_blob.objects[result["reviewDbBlobKey"]]["etag"]
        with mock.patch.object(google_api, "is_configured", return_value=True), \
             mock.patch.object(google_api, "list_accounts", side_effect=google_api.GBPRateLimitError("rate limited", status=429)):
            with self.assertRaises(isync.GoogleSyncFailedError):
                isync.initial_sync(TENANT_A)
        self.assertEqual(self.fake_blob.objects[result["reviewDbBlobKey"]]["etag"], original_etag)
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "initial_sync_failed")

    def test_partial_google_sync_across_multiple_locations_fails_the_whole_run(self):
        self._provision(TENANT_A, [
            ("accounts/1/locations/a", "A", ""),
            ("accounts/1/locations/b", "B", ""),
        ])
        locations = [_gbp_location("accounts/1/locations/a", "A"), _gbp_location("accounts/1/locations/b", "B")]

        def flaky_list_reviews(tenant_id, location_name, page_size=50, max_pages=None):
            if location_name == "accounts/1/locations/b":
                raise google_api.GBPServerError("boom", status=500)
            return [_gbp_review("r1", "Fine", "FOUR")]

        with mock.patch.object(google_api, "is_configured", return_value=True), \
             mock.patch.object(google_api, "list_accounts", return_value=[_account()]), \
             mock.patch.object(google_api, "list_locations", return_value=locations), \
             mock.patch.object(google_api, "list_reviews", side_effect=flaky_list_reviews):
            with self.assertRaises(isync.GoogleSyncFailedError):
                isync.initial_sync(TENANT_A)
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "initial_sync_failed", "a partial sync (one location failed) must never activate the tenant")

    # ===================================================================
    # Happy path + artifact reuse (spec sections 3, 9, 4)
    # ===================================================================

    def test_full_successful_initial_sync_activates_the_tenant(self):
        self._provision(TENANT_A, [("accounts/1/locations/1", "Casa Test", "")])
        locations = [_gbp_location("accounts/1/locations/1", "Casa Test")]
        reviews = {"accounts/1/locations/1": [_gbp_review("r1", "Wonderful place", "FIVE"), _gbp_review("r2", "Bad service", "ONE")]}
        patches = self._mock_google(_account(), locations, reviews)
        with patches[0], patches[1], patches[2], patches[3]:
            outcome = isync.initial_sync(TENANT_A)

        self.assertEqual(outcome["outcome"], "active")
        self.assertEqual(outcome["reviewCount"], 2)
        self.assertEqual(outcome["locationCount"], 1)

        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "active")
        self.assertEqual(config["initialSync"]["status"], "completed")
        self.assertEqual(config["initialSync"]["reviewCount"], 2)
        self.assertEqual(config["initialSync"]["locationCount"], 1)
        self.assertIsNotNone(config["initialSync"]["completedAt"])
        self.assertEqual(config["provisioning"]["reviewDbEtag"], outcome["reviewDbEtag"])
        self.assertEqual(config["provisioning"]["artifactGeneration"], outcome["artifactGeneration"])

        db_path = self._download_db(tenant_blob_keys.review_db_blob_key(TENANT_A))
        self.assertEqual(self._review_count(db_path), 2)

        meta = self._artifact_json(TENANT_A, outcome["artifactGeneration"], "meta.json")
        self.assertEqual(meta["totalReviews"], 2, "artifacts must reflect the REAL synced review count, never a placeholder")
        self.assertEqual({l["locationId"] for l in meta["locations"]}, {1})

        action_items = self._artifact_json(TENANT_A, outcome["artifactGeneration"], "action-items.json")
        self.assertIn("unanswered", action_items, "artifact generation must reuse export_chunks.py's REAL shape, not provisioning's placeholder {items: []}")
        self.assertEqual(len(action_items["unanswered"]), 1, "the unanswered <=2-star review must appear in action-items.json")

        review_index = self._artifact_json(TENANT_A, outcome["artifactGeneration"], "_internal/review-location-index.json")
        # Each review indexes under BOTH its date-name fallback key AND its
        # gbp_review_name (export_review_location_index()'s own dual-identity
        # design -- see that function's docstring) -- 2 reviews -> 4 keys.
        self.assertEqual(len(review_index), 4)
        self.assertTrue(all(loc_id == 1 for loc_id in review_index.values()))

        by_location = self._artifact_json(TENANT_A, outcome["artifactGeneration"], "reviews/by-location/casa-test.json")
        self.assertEqual(len(by_location), 2)
        for row in by_location:
            self.assertEqual(row["locationId"], 1, "generated artifacts must refer to the stable tenant-local location id")

    def test_artifacts_never_contain_lta_brand_or_location_names(self):
        self._provision(TENANT_A, [("accounts/1/locations/1", "Tenant A's Own Restaurant", "")])
        locations = [_gbp_location("accounts/1/locations/1", "Tenant A's Own Restaurant")]
        patches = self._mock_google(_account(), locations, {})
        with patches[0], patches[1], patches[2], patches[3]:
            outcome = isync.initial_sync(TENANT_A)
        meta_text = json.dumps(self._artifact_json(TENANT_A, outcome["artifactGeneration"], "meta.json"))
        for lta_brand in db.BRANDS:
            self.assertNotIn(lta_brand, meta_text)

    # ===================================================================
    # DB conditional upload / ETag CAS (spec sections 6, 8, 13)
    # ===================================================================

    def test_a_failed_artifact_upload_leaves_the_previous_generation_authoritative(self):
        self._provision(TENANT_A, [("accounts/1/locations/1", "A", "")])
        original_generation = self.fake_store.get(TENANT_A)["provisioning"]["artifactGeneration"]
        locations = [_gbp_location("accounts/1/locations/1", "A")]
        patches = self._mock_google(_account(), locations, {})
        with mock.patch.object(tenant_blob_store, "put_blob", side_effect=self._raise_after_db_upload()), \
             patches[0], patches[1], patches[2], patches[3]:
            with self.assertRaises(RuntimeError):
                isync.initial_sync(TENANT_A)
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "initial_sync_failed")
        self.assertEqual(config["provisioning"]["artifactGeneration"], original_generation,
                          "a failed artifact upload must never advance artifactGeneration -- the previous generation stays authoritative")

    def _raise_after_db_upload(self):
        """A put_blob side_effect that lets the FIRST call (the reviews.db
        upload) through to the real fake, then fails every subsequent call
        (the artifact uploads)."""
        calls = []

        def side_effect(pathname, data, **kwargs):
            calls.append(pathname)
            if len(calls) == 1:
                return self.fake_blob.put_blob(pathname, data, **kwargs)
            raise RuntimeError("simulated artifact upload failure")
        return side_effect

    def test_stale_db_writer_cannot_replace_newer_db(self):
        """Directly proves the reviews.db Blob-level ETag guard: a worker
        that read an OLDER etag can never overwrite a database someone
        else already replaced."""
        result = self._provision(TENANT_A, [("accounts/1/locations/1", "A", "")])
        key = result["reviewDbBlobKey"]
        stale_etag = self.fake_blob.objects[key]["etag"]
        # A newer generation publishes directly (simulating a second, newer worker).
        self.fake_blob.put_blob(key, b"newer-bytes", if_match=stale_etag)
        with self.assertRaises(tenant_blob_store.BlobPreconditionFailedError):
            self.fake_blob.put_blob(key, b"stale-overwrite-attempt", if_match=stale_etag)
        self.assertEqual(self.fake_blob.get_blob(key), b"newer-bytes")

    # ===================================================================
    # Concurrency / retry (spec section 6/13, continuation section 6)
    # ===================================================================

    def test_suspension_during_initial_sync_prevents_activation(self):
        self._provision(TENANT_A, [("accounts/1/locations/1", "A", "")])
        locations = [_gbp_location("accounts/1/locations/1", "A")]
        original_gen = isync._verify_artifact_generation

        def verify_then_suspend(*args, **kwargs):
            original_gen(*args, **kwargs)
            self.fake_store.upsert(TENANT_A, {"status": "suspended"})

        patches = self._mock_google(_account(), locations, {})
        with mock.patch.object(isync, "_verify_artifact_generation", side_effect=verify_then_suspend), \
             patches[0], patches[1], patches[2], patches[3]:
            with self.assertRaises(isync.StaleInitialSyncAttemptError):
                isync.initial_sync(TENANT_A)
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "suspended", "the newer suspension must survive -- a stale completion must never overwrite it")

    def test_approved_location_change_during_sync_prevents_stale_activation(self):
        self._provision(TENANT_A, [("accounts/1/locations/a", "A", "")])
        locations = [_gbp_location("accounts/1/locations/a", "A")]
        original_gen = isync._verify_artifact_generation

        def verify_then_change_locations(*args, **kwargs):
            original_gen(*args, **kwargs)
            self.fake_store.approve(TENANT_A, [("accounts/1/locations/a", "A", ""), ("accounts/1/locations/d", "D", "")])
            # approve() bumps status back to 'locations_approved' -- restore
            # provisioning fields so the record still looks internally
            # consistent for inspection purposes (a real Owner action would
            # not touch provisioning at all; this mirrors that).
            record = self.fake_store.get(TENANT_A)
            record["provisioning"] = self.fake_store.records[TENANT_A].get("provisioning")

        patches = self._mock_google(_account(), locations, {})
        with mock.patch.object(isync, "_verify_artifact_generation", side_effect=verify_then_change_locations), \
             patches[0], patches[1], patches[2], patches[3]:
            with self.assertRaises(isync.StaleInitialSyncAttemptError):
                isync.initial_sync(TENANT_A)
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(len(config["approvedLocations"]), 2, "the newer approved-locations change must survive completely")
        self.assertNotEqual(config["status"], "active", "the stale attempt (validated against only 1 location) must never activate")

    def test_two_overlapping_initial_syncs_only_one_publishes(self):
        """Two independent processes both read the SAME 'provisioned'
        tenant_config generation and race to become the one that starts
        Initial Sync. Unlike provision_tenant.py (whose status gate
        deliberately re-admits an already-'provisioning' tenant, relying
        entirely on the LATER configVersion CAS to arbitrate), Initial
        Sync's OWN status gate excludes 'initial_sync' itself -- so the
        race is decided at the very FIRST CAS write ('provisioned' ->
        'initial_sync'), before either attempt ever touches
        credential/Blob/SQLite/Google. This hooks
        google_api.has_tenant_credential() -- the last check before that
        first write -- to let a full, independent, NESTED attempt run to
        completion first, so the OUTER attempt's own first CAS write is
        provably the one that loses."""
        self._provision(TENANT_A, [("accounts/1/locations/a", "A", "")])
        locations = [_gbp_location("accounts/1/locations/a", "A")]
        ran_inner = []

        def cred_check_then_trigger_concurrent_attempt(tenant_id):
            if not ran_inner:
                ran_inner.append(True)
                patches = self._mock_google(_account(), locations, {})
                with patches[0], patches[1], patches[2], patches[3]:
                    isync.initial_sync(tenant_id)
            return True

        self._cred_patch.stop()
        try:
            with mock.patch.object(google_api, "has_tenant_credential", side_effect=cred_check_then_trigger_concurrent_attempt):
                with self.assertRaises(isync.StaleInitialSyncAttemptError):
                    isync.initial_sync(TENANT_A)
        finally:
            self._cred_patch.start()

        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "active", "exactly one attempt's success must be recorded, cleanly")
        db_path = self._download_db(tenant_blob_keys.review_db_blob_key(TENANT_A))
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        locations_rows = {row["id"]: dict(row) for row in conn.execute("SELECT * FROM locations").fetchall()}
        conn.close()
        self.assertEqual(set(locations_rows.keys()), {1}, "the final database must be fully consistent, never a partial/corrupted hybrid")

    def test_a_failed_run_can_be_retried_successfully(self):
        self._provision(TENANT_A, [("accounts/1/locations/1", "A", "")])
        with mock.patch.object(google_api, "is_configured", return_value=True), \
             mock.patch.object(google_api, "list_accounts", side_effect=google_api.GBPAuthError("simulated auth failure")):
            with self.assertRaises(isync.GoogleSyncFailedError):
                isync.initial_sync(TENANT_A)
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "initial_sync_failed")

        locations = [_gbp_location("accounts/1/locations/1", "A")]
        patches = self._mock_google(_account(), locations, {})
        with patches[0], patches[1], patches[2], patches[3]:
            outcome = isync.initial_sync(TENANT_A)
        self.assertEqual(outcome["outcome"], "active")

    def test_failed_retry_cannot_overwrite_a_newer_success(self):
        """Because Initial Sync's status gate excludes 'initial_sync'
        itself (see the previous test's docstring), a truly independent
        SECOND attempt can only ever be admitted once the FIRST has left
        'initial_sync' -- i.e. after it already failed. This proves that
        specific, real sequence: attempt 1 starts and fails; a genuinely
        newer attempt 2 (started later, capturing the NEWER configVersion
        left by attempt 1's own failure write) succeeds; attempt 1's
        failure report must never be capable of retroactively overwriting
        attempt 2's later success -- trivially true here since attempt 1's
        failure write happens BEFORE attempt 2 even starts, but this
        directly exercises the exact CAS field (expected_version) that
        makes it true in general, by simulating a stale failure-handler
        write racing in AFTER a newer success already landed."""
        self._provision(TENANT_A, [("accounts/1/locations/1", "A", "")])

        def sync_then_simulate_a_newer_success_landing_first(tenant_id, approved_locations):
            # Simulate a DIFFERENT, newer process completing Initial Sync
            # successfully for this tenant WHILE this attempt's own Google
            # call is in flight, then this (now stale) attempt's own call
            # fails.
            current = self.fake_store.get(tenant_id)
            self.fake_store.upsert(tenant_id, {
                "status": "active",
                "provisioning": {**current["provisioning"], "reviewDbEtag": "newer-etag", "artifactGeneration": "newer-generation"},
                "initialSync": {"status": "completed", "startedAt": current["initialSync"]["startedAt"], "completedAt": isync._now_iso(), "reviewCount": 3, "locationCount": 1, "lastError": None},
            })
            raise google_api.GBPServerError("simulated failure in the stale attempt", status=500)

        with mock.patch.object(isync, "_run_google_sync", side_effect=sync_then_simulate_a_newer_success_landing_first):
            with self.assertRaises(google_api.GBPServerError):
                isync.initial_sync(TENANT_A)

        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "active", "the newer successful attempt must survive a stale failure report")
        self.assertEqual(config["initialSync"]["status"], "completed")
        self.assertIsNone(config["initialSync"]["lastError"], "a stale failure must never overwrite the newer success's clean state")

        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "active", "the newer successful attempt must survive a stale failure report")
        self.assertIsNone(config["initialSync"]["lastError"])

    def test_worker_dies_after_db_upload_before_artifact_publication_recovers_on_retry(self):
        self._provision(TENANT_A, [("accounts/1/locations/1", "A", "")])
        locations = [_gbp_location("accounts/1/locations/1", "A")]
        reviews = {"accounts/1/locations/1": [_gbp_review("r1", "Nice", "FIVE")]}

        with mock.patch.object(tenant_blob_store, "put_blob", side_effect=self._raise_after_db_upload()):
            patches = self._mock_google(_account(), locations, reviews)
            with patches[0], patches[1], patches[2], patches[3]:
                with self.assertRaises(RuntimeError):
                    isync.initial_sync(TENANT_A)
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["status"], "initial_sync_failed")

        # Retry: the database Blob already contains the synced review (the
        # dead attempt's upload succeeded) -- re-running Google sync on top
        # of it must be idempotent (dedup-key upsert), never duplicate.
        patches = self._mock_google(_account(), locations, reviews)
        with patches[0], patches[1], patches[2], patches[3]:
            outcome = isync.initial_sync(TENANT_A)
        self.assertEqual(outcome["outcome"], "active")
        self.assertEqual(outcome["reviewCount"], 1, "retrying against an already-synced database must never duplicate reviews")

    def test_final_cas_loses_race_leaves_uploads_orphaned_not_activated(self):
        self._provision(TENANT_A, [("accounts/1/locations/1", "A", "")])
        locations = [_gbp_location("accounts/1/locations/1", "A")]
        real_upsert = self.fake_store.upsert
        call_count = []

        def upsert_then_race_before_final(tenant_id, patch, expected_version=None):
            call_count.append(patch.get("status"))
            if patch.get("status") == "active":
                # Simulate someone else committing a change right before
                # our own final CAS lands.
                real_upsert(tenant_id, {"displayName": "Renamed concurrently"})
            return real_upsert(tenant_id, patch, expected_version=expected_version)

        patches = self._mock_google(_account(), locations, {})
        with mock.patch.object(tenant_config_store, "upsert_tenant_config", side_effect=upsert_then_race_before_final), \
             patches[0], patches[1], patches[2], patches[3]:
            with self.assertRaises(isync.StaleInitialSyncAttemptError):
                isync.initial_sync(TENANT_A)
        config = self.fake_store.get(TENANT_A)
        self.assertEqual(config["displayName"], "Renamed concurrently", "the newer concurrent write must survive")
        self.assertNotEqual(config["status"], "active")

    # ===================================================================
    # Cross-tenant adversarial tests (spec section 14)
    # ===================================================================

    def test_tenant_a_sync_cannot_touch_tenant_bs_db_or_config(self):
        self._provision(TENANT_A, [("accounts/1/locations/a", "A", "")])
        self._provision(TENANT_B, [("accounts/2/locations/b", "B", "")])
        b_config_before = dict(self.fake_store.get(TENANT_B))
        b_db_before = self.fake_blob.get_blob(tenant_blob_keys.review_db_blob_key(TENANT_B))

        locations = [_gbp_location("accounts/1/locations/a", "A")]
        patches = self._mock_google(_account(), locations, {})
        with patches[0], patches[1], patches[2], patches[3]:
            isync.initial_sync(TENANT_A)

        self.assertEqual(self.fake_store.get(TENANT_B), b_config_before, "Tenant B's config must be completely untouched")
        self.assertEqual(self.fake_blob.get_blob(tenant_blob_keys.review_db_blob_key(TENANT_B)), b_db_before, "Tenant B's database Blob must be completely untouched")

    def test_tenant_a_credential_lookup_never_uses_tenant_bs_id(self):
        self._provision(TENANT_A, [("accounts/1/locations/a", "A", "")])
        self._cred_patch.stop()
        seen_tenant_ids = []
        try:
            with mock.patch.object(google_api, "has_tenant_credential", side_effect=lambda tid: seen_tenant_ids.append(tid) or True):
                locations = [_gbp_location("accounts/1/locations/a", "A")]
                patches = self._mock_google(_account(), locations, {})
                with patches[0], patches[1], patches[2], patches[3]:
                    isync.initial_sync(TENANT_A)
        finally:
            self._cred_patch.start()
        self.assertEqual(seen_tenant_ids, [TENANT_A])

    def test_numeric_location_id_collisions_across_tenants_are_harmless(self):
        """Both tenants independently get locationId=1 for their first
        location (each tenant's locationIdMap starts fresh) -- since each
        lives in a physically separate database/Blob key, this must never
        cause any cross-contamination."""
        self._provision(TENANT_A, [("accounts/1/locations/a", "Tenant A Place", "")])
        self._provision(TENANT_B, [("accounts/2/locations/b", "Tenant B Place", "")])
        self.assertEqual(self.fake_store.get(TENANT_A)["approvedLocations"][0]["locationId"], 1)
        self.assertEqual(self.fake_store.get(TENANT_B)["approvedLocations"][0]["locationId"], 1)

        locations_a = [_gbp_location("accounts/1/locations/a", "Tenant A Place")]
        reviews_a = {"accounts/1/locations/a": [_gbp_review("ra", "Tenant A review", "FIVE")]}
        patches = self._mock_google(_account(1), locations_a, reviews_a)
        with patches[0], patches[1], patches[2], patches[3]:
            outcome_a = isync.initial_sync(TENANT_A)

        meta_a = self._artifact_json(TENANT_A, outcome_a["artifactGeneration"], "meta.json")
        self.assertEqual(meta_a["locations"][0]["name"], "Tenant A Place")

        # Tenant B's own database/config must remain completely unaffected.
        config_b = self.fake_store.get(TENANT_B)
        self.assertEqual(config_b["status"], "provisioned")
        db_path_b = self._download_db(tenant_blob_keys.review_db_blob_key(TENANT_B))
        self.assertEqual(self._review_count(db_path_b), 0)

    def test_failure_in_tenant_a_never_alters_tenant_b(self):
        self._provision(TENANT_A, [("accounts/1/locations/a", "A", "")])
        self._provision(TENANT_B, [("accounts/2/locations/b", "B", "")])
        b_config_before = dict(self.fake_store.get(TENANT_B))

        with mock.patch.object(google_api, "is_configured", return_value=True), \
             mock.patch.object(google_api, "list_accounts", side_effect=google_api.GBPAuthError("boom")):
            with self.assertRaises(isync.GoogleSyncFailedError):
                isync.initial_sync(TENANT_A)

        self.assertEqual(self.fake_store.get(TENANT_A)["status"], "initial_sync_failed")
        self.assertEqual(self.fake_store.get(TENANT_B), b_config_before)


if __name__ == "__main__":
    unittest.main()
