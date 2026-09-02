"""
apply_entitlement_change.py -- Multi-Tenant Phase 4I.3: the data-plane
follow-up for a platform-admin entitlement change already COMMITTED to
tenant_config by dashboard/api/_lib/tenantConfigStore.js's
applyEntitlementChange() (Node, via the platform-admin-only
tenant-entitlements/[action].js endpoint).

THIS SCRIPT DOES NOT DECIDE WHAT CHANGED. That decision -- which Google
locations to add, which local locationIds to remove, whether the caller is
even a platform admin -- was already made, authorized, and committed
atomically (a configVersion CAS write) before this script ever runs. This
script's only job is to make an already-approved ADDITION operational:
insert its DB row(s), run a sync scoped to the tenant's full current
approved set, publish a fresh artifact generation, and only then flip the
new location(s)' `operational` flag from false to true. A REMOVAL needs no
data-plane work at all -- authorization was already fully revoked the
moment the config CAS committed (tenants.js's tenantOwnsLocation() reads
approvedLocations live) -- so this script has nothing to do for a
removal-only change and Node never marks one 'pending' in the first place
(see tenantConfigStore.js's applyEntitlementChange()).

WHY REUSE, NOT REWRITE: this is deliberately built from the SAME proven
primitives initial_sync.py already established, not a new pipeline --
provision_tenant.py's _reconcile_missing_locations()/
_insert_location_with_explicit_id() for the DB row insert (the exact
"stable numeric id, never SQLite autoincrement" discipline this whole
multi-tenant architecture depends on), tenant_approved_locations_provider.
ApprovedLocationsOnlyGBPProvider + provider_sync.sync_all() for the Google
sync, tenant_artifact_export.generate_tenant_artifacts() for the artifact
set, and tenant_blob_store's ETag-conditional upload for the reviews.db
Blob -- all completely unchanged. Los Tres Amigos's own sync path
(sync_reviews.py/gbp_sync.py) is untouched by this file, exactly as it is
by initial_sync.py.

WHY A FULL SYNC, NOT AN INCREMENTAL ONE: there is no incremental
artifact-publication mechanism anywhere in this codebase (every existing
artifact-producing run -- provision_tenant.py's empty-state build,
initial_sync.py's own run -- regenerates the COMPLETE artifact set from the
whole database under a brand-new generation id). Building a true
incremental pipeline is explicitly out of scope for this phase; this
script instead re-syncs the tenant's ENTIRE current approved set (not just
the newly-added location) via provider_sync.py's own dedup-key-based
review upsert, which is idempotent and safe to re-run against
already-synced data -- "sync only the newly-added locations unless a full
refresh is required for correctness" resolves to "a full refresh," because
correctness (one coherent, freshly-regenerated artifact generation) is
what this architecture's existing publication model actually requires.

STATE MACHINE: does NOT touch tenant_config's top-level `status` at all --
an entitlement change never changes whether a tenant is active/suspended/
etc, only whether specific locations are operational within that status.
Reads/writes only `entitlementChange` (pending -> none on success, pending
-> failed on failure) and `approvedLocations[].operational` (false -> true,
ONLY for the ids named in entitlementChange.addedLocationIds, ONLY on
success).

CONCURRENCY: the SAME configVersion CAS discipline as provision_tenant.py/
initial_sync.py -- captured at the start, chained +1 after every write this
run makes, and the SAME reviews.db Blob ETag conditional-write. A stale
attempt (tenant_config changed underneath it -- a suspension, a NEWER
entitlement change, a concurrent initial_sync somehow starting) is
converted to StaleEntitlementChangeAttemptError and simply never published.

Run directly: py apply_entitlement_change.py --tenant-id t_example-restaurant
"""
from __future__ import annotations

import argparse
import asyncio
import gc
import shutil
import sqlite3
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

import db
import google_api
import provider_sync
import provision_tenant  # reuses _inspect_database_file()/_reconcile_missing_locations()
import tenant_approved_locations_provider as approved_provider
import tenant_artifact_export
import tenant_blob_keys
import tenant_blob_store
import tenant_config_store
import tenant_keys
import tenant_location_mapping


class ApplyEntitlementChangeError(Exception):
    """Base class for every fail-closed refusal below."""


class UnknownTenantConfigError(ApplyEntitlementChangeError):
    """The tenant has no tenant_config record at all -- unknown tenant."""


class TenantNotEligibleError(ApplyEntitlementChangeError):
    """The tenant's current status/storageMode does not permit this script
    to run -- mirrors tenantConfigStore.js's ENTITLEMENT_CHANGE_ELIGIBLE_STATUSES
    exactly, so Node and Python can never disagree about which lifecycle
    states are in scope."""


class NoPendingEntitlementChangeError(ApplyEntitlementChangeError):
    """entitlementChange.status is not 'pending' -- there is no committed
    addition awaiting its data-plane follow-up. Not an error condition in
    the CLI/workflow sense (running this against a tenant with nothing
    pending is simply a no-op you should not have dispatched), but this
    script still refuses rather than silently doing nothing indefinitely."""


class LocationMappingConsistencyError(ApplyEntitlementChangeError):
    """approvedLocations/locationIdMap disagree -- see tenant_location_mapping.py."""


class NoGoogleCredentialError(ApplyEntitlementChangeError):
    """No real, tenant-specific Google credential exists in the Redis
    credential store for this tenant -- see google_api.has_tenant_credential()."""


class DatabaseNotFoundError(ApplyEntitlementChangeError):
    """No reviews.db Blob exists at this tenant's key."""


class DatabaseIdentityMismatchError(ApplyEntitlementChangeError):
    """The downloaded database's `locations` table does not correspond to
    tenant_config's locationIdMap for every location EXPECTED TO ALREADY
    EXIST (the newly-added ones are expected to be MISSING until this
    script inserts them -- see _verify_pre_insert_identity() below, which
    checks exactly that distinction)."""


class GoogleSyncFailedError(ApplyEntitlementChangeError):
    """provider_sync.sync_all() did not report a clean 'ok' status for
    every currently-approved location."""


class StaleEntitlementChangeAttemptError(ApplyEntitlementChangeError):
    """tenant_config or the reviews.db Blob changed underneath this
    attempt -- its work (if any) is NOT published as authoritative.
    Never raised for a fixable input error -- always retry-worthy."""


class ArtifactPublicationError(ApplyEntitlementChangeError):
    """A required artifact failed to upload, or failed post-upload
    verification -- the new generation is simply abandoned."""


# Mirrors tenantConfigStore.js's ENTITLEMENT_CHANGE_ELIGIBLE_STATUSES
# exactly -- one authoritative status classification, not two
# independently-maintained enums that could drift apart. 'initial_sync'
# itself is correctly absent from both: Node's admin endpoint already
# refuses to commit a NEW entitlement change while a sync is in flight
# (same reasoning as Phase 4I.2's reconnect block), so this script should
# never actually observe that status with a 'pending' entitlementChange in
# practice -- it is still excluded here as defense-in-depth.
_ELIGIBLE_STATUSES = {"provisioned", "active", "initial_sync_failed", "provisioning_failed", "suspended"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_error(e: Exception) -> str:
    return f"{type(e).__name__}: {e}"[:2000]


# ---------------------------------------------------------------------------
# Step 1: load + validate tenant_config state
# ---------------------------------------------------------------------------

def _load_and_validate_config(tenant_id: str) -> dict:
    config = tenant_config_store.get_tenant_config(tenant_id)
    if config is None:
        raise UnknownTenantConfigError(f"tenant {tenant_id!r} has no tenant_config record -- unknown tenant")

    status = config.get("status")
    if status not in _ELIGIBLE_STATUSES:
        raise TenantNotEligibleError(
            f"tenant {tenant_id!r} has status {status!r} -- entitlement changes may only be applied for "
            f"{sorted(_ELIGIBLE_STATUSES)}"
        )
    if config.get("storageMode") != "BLOB":
        raise TenantNotEligibleError(
            f"tenant {tenant_id!r} has storageMode {config.get('storageMode')!r} -- this script only runs "
            f"for BLOB-mode tenants; Los Tres Amigos (LEGACY_REPO) must never reach it"
        )

    entitlement_change = config.get("entitlementChange") or {}
    if entitlement_change.get("status") != "pending":
        raise NoPendingEntitlementChangeError(
            f"tenant {tenant_id!r} has entitlementChange.status {entitlement_change.get('status')!r} -- "
            f"nothing is awaiting its data-plane follow-up"
        )
    added_location_ids = entitlement_change.get("addedLocationIds") or []
    if not added_location_ids:
        raise NoPendingEntitlementChangeError(
            f"tenant {tenant_id!r}: entitlementChange is 'pending' but addedLocationIds is empty -- nothing to do"
        )

    return config


def _validate_stable_id_consistency(approved_locations: list[dict], location_id_map: dict) -> dict[int, str]:
    try:
        return tenant_location_mapping.validate_stable_id_consistency(approved_locations, location_id_map)
    except tenant_location_mapping.LocationMappingConsistencyError as e:
        raise LocationMappingConsistencyError(str(e)) from e


# ---------------------------------------------------------------------------
# Step 2: Blob download + pre-insert identity verification
# ---------------------------------------------------------------------------

def _download_database(tenant_id: str, review_db_blob_key: str, trusted_etag: str, dest_path: Path) -> str:
    head = tenant_blob_store.head_blob(review_db_blob_key)
    if head is None:
        raise DatabaseNotFoundError(f"tenant {tenant_id!r}: no reviews.db Blob exists at {review_db_blob_key!r}")
    if head["etag"] != trusted_etag:
        raise DatabaseIdentityMismatchError(
            f"tenant {tenant_id!r}: reviews.db Blob's current ETag {head['etag']!r} does not match "
            f"tenant_config's trusted provisioning.reviewDbEtag {trusted_etag!r}"
        )
    content = tenant_blob_store.get_blob(review_db_blob_key)
    if content is None:
        raise DatabaseNotFoundError(f"tenant {tenant_id!r}: reviews.db Blob vanished between head and get")
    dest_path.write_bytes(content)
    return head["etag"]


def _verify_pre_insert_identity(db_path: Path, expected: dict[int, str], added_location_ids: list[int]) -> None:
    """Unlike initial_sync.py's _verify_database_identity() (which requires
    EVERY expected location to already exist), the newly-added location ids
    are expected to be MISSING at this point -- this script is what inserts
    them. Any MISMATCH (an id present but mapped to the wrong
    googleLocationId) is still a hard abort; any id missing that is NOT one
    of this run's own additions is also a hard abort (a genuine, unrelated
    inconsistency this script must never silently paper over)."""
    inspection = provision_tenant._inspect_database_file(db_path, expected)
    unexpected_missing = [lid for lid in inspection["missing"] if lid not in added_location_ids]
    if inspection["mismatched"] or unexpected_missing:
        raise DatabaseIdentityMismatchError(
            f"database locations table is inconsistent with tenant_config's locationIdMap -- "
            f"mismatched={inspection['mismatched']} unexpected_missing={unexpected_missing}"
        )


def _run_integrity_check(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    try:
        result = conn.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        conn.close()
    if result != "ok":
        raise ApplyEntitlementChangeError(f"PRAGMA integrity_check failed for {db_path}: {result}")


def _insert_added_locations(db_path: Path, approved_locations: list[dict], added_location_ids: list[int]) -> None:
    """Reuses provision_tenant.py's own _reconcile_missing_locations() --
    the SAME "insert exactly these missing ids, touch nothing else"
    primitive that module already established, never a second,
    independently-maintained copy of it. Its docstring caveat ("never
    called unless the existing database's reviews table is verified
    empty") describes THAT module's own caller precondition, not a runtime
    requirement of the function itself -- it only ever inserts rows for
    the ids explicitly passed in `added_location_ids`, so it is equally
    safe to call here against a database that already has real review
    history for OTHER, unrelated locations."""
    provision_tenant._reconcile_missing_locations(db_path, approved_locations, added_location_ids)


# ---------------------------------------------------------------------------
# Step 3: Google sync (scoped to the tenant's FULL current approved set)
# ---------------------------------------------------------------------------

def _run_google_sync(tenant_id: str, approved_locations: list[dict]) -> dict:
    approved_google_location_ids = {loc["googleLocationId"] for loc in approved_locations}
    provider = approved_provider.ApprovedLocationsOnlyGBPProvider(tenant_id, approved_google_location_ids)
    result = asyncio.run(provider_sync.sync_all(provider, fast=False))
    if result.get("status") != "ok":
        raise GoogleSyncFailedError(
            f"tenant {tenant_id!r}: Google sync did not complete cleanly for every approved location -- "
            f"status={result.get('status')!r} reason={result.get('reason')!r} "
            f"locations_succeeded={result.get('locations_succeeded', 0)} "
            f"locations_failed={result.get('locations_failed', 0)} errors={result.get('errors')}"
        )
    return result


# ---------------------------------------------------------------------------
# Step 4: artifact generation + publication (identical model to initial_sync.py)
# ---------------------------------------------------------------------------

def _verify_artifact_generation(artifacts: dict[str, bytes], locations: dict[int, dict]) -> None:
    for rel_path in tenant_artifact_export.REQUIRED_RELATIVE_PATHS:
        if rel_path not in artifacts:
            raise ArtifactPublicationError(f"required artifact {rel_path!r} was not generated")
    for loc in locations.values():
        slug_key = f"reviews/by-location/{provision_tenant._slugify(loc['name'])}.json"
        if slug_key not in artifacts:
            raise ArtifactPublicationError(f"required per-location artifact {slug_key!r} was not generated")


def _upload_artifact_generation(tenant_id: str, generation: str, artifacts: dict[str, bytes]) -> None:
    for rel_path, content in artifacts.items():
        tenant_blob_store.put_blob(
            tenant_blob_keys.generation_private_data_blob_key(tenant_id, generation, rel_path),
            content, content_type="application/json", allow_overwrite=True,
        )


def _verify_uploaded_generation(tenant_id: str, generation: str, artifacts: dict[str, bytes]) -> None:
    for rel_path in artifacts:
        key = tenant_blob_keys.generation_private_data_blob_key(tenant_id, generation, rel_path)
        if tenant_blob_store.head_blob(key) is None:
            raise ArtifactPublicationError(f"artifact {rel_path!r} was not found in Blob immediately after upload")


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def apply_entitlement_change(tenant_id: str) -> dict:
    tenant_keys.assert_valid_tenant_id(tenant_id, "apply_entitlement_change")
    config = _load_and_validate_config(tenant_id)
    expected_version = config.get("configVersion", 0)
    approved_locations = config["approvedLocations"]
    location_id_map = config.get("locationIdMap") or {}
    added_location_ids = config["entitlementChange"]["addedLocationIds"]
    expected = _validate_stable_id_consistency(approved_locations, location_id_map)

    if not google_api.has_tenant_credential(tenant_id):
        raise NoGoogleCredentialError(f"tenant {tenant_id!r} has no real Google credential in the Redis-backed store")

    review_db_blob_key = tenant_blob_keys.review_db_blob_key(tenant_id)
    trusted_etag = (config.get("provisioning") or {}).get("reviewDbEtag")
    if not trusted_etag:
        raise DatabaseIdentityMismatchError(f"tenant {tenant_id!r}: tenant_config has no recorded provisioning.reviewDbEtag")

    new_etag = None
    tmp = tempfile.mkdtemp(prefix=f"entitlement-change-{tenant_id}-")
    try:
        tmp_db_path = Path(tmp) / "reviews.db"
        starting_etag = _download_database(tenant_id, review_db_blob_key, trusted_etag, tmp_db_path)

        _run_integrity_check(tmp_db_path)
        _verify_pre_insert_identity(tmp_db_path, expected, added_location_ids)
        _insert_added_locations(tmp_db_path, approved_locations, added_location_ids)
        # Every expected id (old AND newly-inserted) must now be present
        # and correctly mapped -- no exceptions for the new ones anymore.
        _verify_pre_insert_identity(tmp_db_path, expected, [])

        original_db_path = db.DB_PATH
        db.DB_PATH = tmp_db_path
        try:
            sync_result = _run_google_sync(tenant_id, approved_locations)
        finally:
            db.DB_PATH = original_db_path
            gc.collect()  # Windows file-lock cleanup, same as initial_sync.py

        _run_integrity_check(tmp_db_path)
        _verify_pre_insert_identity(tmp_db_path, expected, [])

        new_db_data = tmp_db_path.read_bytes()
        try:
            put_result = tenant_blob_store.put_blob(review_db_blob_key, new_db_data, content_type="application/octet-stream", if_match=starting_etag)
        except tenant_blob_store.BlobPreconditionFailedError as e:
            raise StaleEntitlementChangeAttemptError(
                f"tenant {tenant_id!r}: reviews.db at {review_db_blob_key!r} changed since this attempt "
                f"last read it -- rejecting the stale upload"
            ) from e
        new_etag = put_result["etag"]

        conn = sqlite3.connect(tmp_db_path)
        conn.row_factory = sqlite3.Row
        try:
            locations_by_id = {row["id"]: dict(row) for row in conn.execute("SELECT * FROM locations").fetchall()}
            review_count = conn.execute("SELECT COUNT(*) AS c FROM reviews WHERE is_deleted = 0").fetchone()["c"]
            artifacts = tenant_artifact_export.generate_tenant_artifacts(conn)
        finally:
            conn.close()

        _verify_artifact_generation(artifacts, locations_by_id)
        generation = uuid.uuid4().hex
        _upload_artifact_generation(tenant_id, generation, artifacts)
        _verify_uploaded_generation(tenant_id, generation, artifacts)
    except StaleEntitlementChangeAttemptError:
        raise
    except Exception as e:
        try:
            failure_patch = {
                "entitlementChange": {**config["entitlementChange"], "status": "failed", "failedAt": _now_iso(), "lastError": _safe_error(e)},
            }
            if new_etag is not None:
                failure_patch["provisioning"] = {**(config.get("provisioning") or {}), "reviewDbEtag": new_etag}
            tenant_config_store.upsert_tenant_config(tenant_id, failure_patch, expected_version=expected_version)
        except tenant_config_store.ConfigVersionConflictError:
            pass  # something newer already happened -- a stale failure report must never overwrite it
        raise
    finally:
        gc.collect()
        shutil.rmtree(tmp, ignore_errors=True)

    added_set = set(added_location_ids)
    next_approved_locations = [
        {**loc, "operational": True} if loc["locationId"] in added_set else loc
        for loc in approved_locations
    ]
    try:
        tenant_config_store.upsert_tenant_config(tenant_id, {
            "approvedLocations": next_approved_locations,
            "provisioning": {**(config.get("provisioning") or {}), "reviewDbEtag": new_etag, "artifactGeneration": generation},
            "entitlementChange": {**config["entitlementChange"], "status": "none", "completedAt": _now_iso(), "failedAt": None, "lastError": None},
        }, expected_version=expected_version)
    except tenant_config_store.ConfigVersionConflictError as e:
        raise StaleEntitlementChangeAttemptError(
            f"tenant {tenant_id!r}: tenant_config changed while this run was in progress -- the synced "
            f"database and artifact generation were not published; retry will re-evaluate current state"
        ) from e

    return {
        "outcome": "completed", "addedLocationIds": added_location_ids, "reviewDbEtag": new_etag,
        "artifactGeneration": generation, "reviewCount": review_count, "locationCount": len(locations_by_id),
        "locationsSucceeded": sync_result.get("locations_succeeded", 0), "newReviews": sync_result.get("new", 0),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Apply the data-plane follow-up for a pending platform-admin entitlement change (Multi-Tenant Phase 4I.3).")
    parser.add_argument("--tenant-id", required=True, help="The tenant to process, e.g. t_example-restaurant")
    args = parser.parse_args()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::apply_entitlement_change.py: invalid --tenant-id {args.tenant_id!r}")
        return 1

    try:
        result = apply_entitlement_change(args.tenant_id)
    except ApplyEntitlementChangeError as e:
        print(f"::error::apply_entitlement_change.py: {e}")
        return 1

    print(f"apply_entitlement_change.py: tenant={args.tenant_id!r} outcome={result['outcome']} "
          f"addedLocationIds={result['addedLocationIds']} reviews={result['reviewCount']} "
          f"artifactGeneration={result['artifactGeneration']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
