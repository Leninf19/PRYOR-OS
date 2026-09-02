"""
initial_sync.py -- Multi-Tenant Phase 4G: the FIRST real Google Business
Profile synchronization for a newly provisioned BLOB tenant. Takes a
tenant from 'provisioned' (Phase 4F/4F.1: durable, verified, EMPTY
reviews.db + private-data artifacts exist in Vercel Blob) through
'initial_sync' to 'active' -- the ONLY status tenants.js's
tenantOwnsLocationCatalog() authorizes, and the ONLY transition this file
is allowed to make (see tenantConfigStore.js's isValidStatus() comment and
tests/test_provisioned_not_active.js's structural assertion).

STATE MACHINE:
    provisioned / initial_sync_failed --> initial_sync --> active (success)
                                                        --> initial_sync_failed (failure)

A tenant sitting at 'initial_sync' itself is NOT a valid retry starting
point for a NEW invocation -- that would mean a run is already (or was
recently) in flight. This phase does not build a stuck-run watchdog for
Initial Sync (unlike provider_sync.py's reconcile_stuck_runs() for ordinary
scraper_runs); a tenant stuck at 'initial_sync' after a crashed worker
requires a reviewed manual intervention, not an automatic reset, since
this file's own CAS discipline (below) is what guarantees a truly stale
attempt can never publish itself as successful regardless.

WHY REUSE, NOT REWRITE, THE GOOGLE SYNC PIPELINE: sync_reviews.py already
proves the exact pattern this file needs -- bind db.DB_PATH to one
tenant's own database, build a tenant-scoped GBPProvider, call
provider_sync.sync_all(), and trust its own location-linking/dedup-upsert/
run-bookkeeping logic completely unchanged. The ONE adaptation required is
tenant_approved_locations_provider.ApprovedLocationsOnlyGBPProvider, which
narrows GBPProvider.discover_locations() to exactly this tenant's
approvedLocations before provider_sync.py's linking logic ever sees the
result -- see that module's header for why this alone is sufficient to
guarantee no new/unapproved location can ever be created or synced,
without touching provider_sync.py's or gbp_sync.py's production logic at
all (Los Tres Amigos's own sync path is completely untouched by this file).

BLOB LIFECYCLE (reviews.db): mirrors provision_tenant.py's reconciliation
path exactly, reusing the SAME primitives (tenant_blob_store.head_blob/
get_blob/put_blob, the SAME BlobPreconditionFailedError-based optimistic
concurrency): read the current ETag, verify it matches tenant_config's own
recorded provisioning.reviewDbEtag (a defensive check against Blob having
been tampered with or drifted out of band -- never trusted implicitly),
download, sync, then upload the replacement with `if_match=<the ETag just
read>`. A worker that started from an older generation can never overwrite
a newer one -- Blob's own conditional-write mechanism rejects it atomically
(see tenant_blob_store.py's header), converted here to
StaleInitialSyncAttemptError.

ARTIFACT PUBLICATION (generation-versioned, per this phase's explicit
design): reuses tenant_artifact_export.generate_tenant_artifacts() (itself
a thin wrapper over export_chunks.py's own real, production export
functions -- never a second, duplicated computation) to build the complete
artifact set from the freshly-synced database, uploads EVERY file under a
single, brand-new generation id
(tenant_blob_keys.generation_private_data_blob_key --
tenant-data/{tenantId}/generations/{generation}/private-data/...), verifies
the upload, and ONLY THEN lets the final activation CAS point
tenant_config's provisioning.artifactGeneration at it. Node's
reviewDataPaths.js reads exclusively through that recorded pointer -- a
reader can never observe a mix of an old and a new sync's artifacts,
because the old generation's objects are simply never referenced again
once the pointer moves (and are left in place, harmlessly orphaned, if the
pointer never moves at all -- e.g. this attempt fails before the final
CAS).

CONCURRENCY -- TWO independent CAS guarantees, exactly like
provision_tenant.py's Phase 4F.1 design:
  (a) tenant_config's own configVersion CAS -- every write after the
      initial read is checked against `expected_version`, chained by +1
      after each of this run's own successful writes. A stale write raises
      ConfigVersionConflictError, converted to StaleInitialSyncAttemptError.
  (b) the reviews.db Blob object's own ETag, enforced natively by Vercel
      Blob's conditional-write support -- a stale upload raises
      BlobPreconditionFailedError, ALSO converted to
      StaleInitialSyncAttemptError.
Either failing means this attempt's work is simply never published as the
tenant's authoritative state -- an orphaned local temp file is discarded,
an orphaned successful-but-unconfirmed Blob upload (database OR artifact
generation) is left in place, unpublished. A fresh retry re-reads current
state from scratch and starts over; because provider_sync.py's own
review-upsert is dedup-key-based, re-running Google sync against an
ALREADY-synced database (the case after "DB uploaded but process died
before activation") is safe and idempotent -- it produces the identical
review set, never duplicates, and correctly picks up anything genuinely
new since the interrupted attempt.

Run directly: py initial_sync.py --tenant-id t_example-restaurant
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
import provision_tenant  # reuses _inspect_database_file() -- see below
import tenant_approved_locations_provider as approved_provider
import tenant_artifact_export
import tenant_blob_keys
import tenant_blob_store
import tenant_config_store
import tenant_keys
import tenant_location_mapping


class InitialSyncError(Exception):
    """Base class for every fail-closed Initial Sync refusal below."""


class UnknownTenantConfigError(InitialSyncError):
    """The tenant has no tenant_config record at all -- unknown tenant."""


class TenantNotEligibleError(InitialSyncError):
    """The tenant's current status/storageMode/provisioning state does not
    permit Initial Sync to run (not 'provisioned' or 'initial_sync_failed',
    not BLOB-mode, or storage was never actually verified-provisioned)."""


class NoApprovedLocationsError(InitialSyncError):
    """The tenant has approved zero locations -- nothing to sync."""


class LocationMappingConsistencyError(InitialSyncError):
    """approvedLocations/locationIdMap disagree -- see
    tenant_location_mapping.py. Refuses to guess."""


class NoGoogleCredentialError(InitialSyncError):
    """No real, tenant-specific Google credential exists in the Redis
    credential store for this tenant -- see google_api.has_tenant_credential()'s
    header for why the GOOGLE_REFRESH_TOKEN global fallback is deliberately
    NOT accepted as a substitute here."""


class DatabaseNotFoundError(InitialSyncError):
    """No reviews.db Blob exists at this tenant's key -- provisioning did
    not actually complete, despite tenant_config claiming otherwise."""


class DatabaseIdentityMismatchError(InitialSyncError):
    """The downloaded database's `locations` table does not correspond
    exactly to tenant_config's locationIdMap -- either an ETag drift (the
    recorded reviewDbEtag no longer matches what Blob actually holds) or a
    genuine data inconsistency (a location id missing or mapped to a
    different Google location than expected). Initial Sync NEVER silently
    repairs this -- see this file's header."""


class GoogleSyncFailedError(InitialSyncError):
    """provider_sync.sync_all() did not report a clean 'ok' status for
    every approved location (a failure, partial success, or the provider
    reporting itself unconfigured) -- Initial Sync requires ALL approved
    locations to succeed; a partial sync must never activate the tenant."""


class StaleInitialSyncAttemptError(InitialSyncError):
    """Raised whenever this attempt's tenant_config write is rejected
    because configVersion changed since this attempt started, OR whenever
    a reviews.db Blob upload is rejected because its ETag changed since
    this attempt last read it. This attempt's work (if any) is NOT
    published as the tenant's authoritative state. Never raised for a
    fixable input error -- always retry-worthy."""


class ArtifactPublicationError(InitialSyncError):
    """A required artifact failed to upload, or failed post-upload
    verification -- the new generation is simply abandoned, never pointed
    at by tenant_config."""


_ELIGIBLE_STATUSES = {"provisioned", "initial_sync_failed"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_error(e: Exception) -> str:
    """A short, operator-facing error string -- class name + message, never
    a raw credential/token (this codebase's exception messages never embed
    one; google_api.py's own typed errors carry only HTTP status + Google's
    own error text)."""
    return f"{type(e).__name__}: {e}"[:2000]


# ---------------------------------------------------------------------------
# Step 1: load + validate tenant_config state (no credential/Blob/SQLite/
# Google access yet)
# ---------------------------------------------------------------------------

def _load_and_validate_config(tenant_id: str) -> dict:
    config = tenant_config_store.get_tenant_config(tenant_id)
    if config is None:
        raise UnknownTenantConfigError(f"tenant {tenant_id!r} has no tenant_config record -- unknown tenant")

    status = config.get("status")
    if status not in _ELIGIBLE_STATUSES:
        raise TenantNotEligibleError(
            f"tenant {tenant_id!r} has status {status!r} -- Initial Sync requires 'provisioned' or a "
            f"retryable 'initial_sync_failed', never any other state (including 'initial_sync' itself, "
            f"'suspended', or 'active')"
        )

    if config.get("storageMode") != "BLOB":
        raise TenantNotEligibleError(
            f"tenant {tenant_id!r} has storageMode {config.get('storageMode')!r} -- Initial Sync only runs "
            f"for BLOB-mode tenants; Los Tres Amigos (LEGACY_REPO) must never reach this script"
        )

    provisioning = config.get("provisioning") or {}
    if provisioning.get("status") != "provisioned":
        raise TenantNotEligibleError(
            f"tenant {tenant_id!r} has provisioning.status {provisioning.get('status')!r} -- durable storage "
            f"must be verified 'provisioned' (provision_tenant.py) before Initial Sync can run"
        )

    approved_locations = config.get("approvedLocations") or []
    if not approved_locations:
        raise NoApprovedLocationsError(f"tenant {tenant_id!r} has no approved locations to sync")

    return config


def _validate_stable_id_consistency(approved_locations: list[dict], location_id_map: dict) -> dict[int, str]:
    try:
        return tenant_location_mapping.validate_stable_id_consistency(approved_locations, location_id_map)
    except tenant_location_mapping.LocationMappingConsistencyError as e:
        raise LocationMappingConsistencyError(str(e)) from e


# ---------------------------------------------------------------------------
# Step 2: Blob download + database identity verification
# ---------------------------------------------------------------------------

def _download_and_verify_database(tenant_id: str, review_db_blob_key: str, trusted_etag: str, dest_path: Path) -> str:
    """Downloads the current reviews.db Blob and verifies its ETag matches
    `trusted_etag` (tenant_config's OWN recorded provisioning.reviewDbEtag)
    BEFORE any mutation -- the exact "verify expected ETag/version" and
    "durable reviews.db Blob exists" preconditions. Returns the confirmed
    ETag (== trusted_etag) for later use as the conditional-upload's
    if_match value."""
    head = tenant_blob_store.head_blob(review_db_blob_key)
    if head is None:
        raise DatabaseNotFoundError(
            f"tenant {tenant_id!r}: no reviews.db Blob exists at {review_db_blob_key!r} -- provisioning did "
            f"not actually complete despite tenant_config claiming status 'provisioned'"
        )
    if head["etag"] != trusted_etag:
        raise DatabaseIdentityMismatchError(
            f"tenant {tenant_id!r}: reviews.db Blob's current ETag {head['etag']!r} does not match "
            f"tenant_config's trusted provisioning.reviewDbEtag {trusted_etag!r} -- refusing to sync "
            f"against a database that may have changed out of band"
        )
    content = tenant_blob_store.get_blob(review_db_blob_key)
    if content is None:
        raise DatabaseNotFoundError(f"tenant {tenant_id!r}: reviews.db Blob vanished between head and get")
    dest_path.write_bytes(content)
    return head["etag"]


def _verify_database_identity(db_path: Path, expected: dict[int, str]) -> None:
    """Reuses provision_tenant.py's own _inspect_database_file() -- the
    SAME location-identity check that module already enforces, never a
    second, independently-maintained copy of it. Requires exact
    consistency (no mismatches, nothing missing) -- Initial Sync NEVER
    silently repairs an inconsistency the way provision_tenant.py's own
    additive reconciliation branch does; a location gap here means
    something is genuinely wrong and must abort."""
    inspection = provision_tenant._inspect_database_file(db_path, expected)
    if inspection["mismatched"] or inspection["missing"]:
        raise DatabaseIdentityMismatchError(
            f"database locations table does not correspond exactly to tenant_config's locationIdMap -- "
            f"mismatched={inspection['mismatched']} missing={inspection['missing']}"
        )


def _run_integrity_check(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    try:
        result = conn.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        conn.close()
    if result != "ok":
        raise InitialSyncError(f"PRAGMA integrity_check failed for {db_path}: {result}")


# ---------------------------------------------------------------------------
# Step 3: Google sync (tenant- and approved-location-scoped)
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
# Step 4: artifact generation + publication
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
    """Uploads every artifact under a brand-new generation id. Safe to use
    allow_overwrite=True per-object: a freshly-minted uuid4 generation id
    has never been used before, so there is nothing to race against for
    THIS generation specifically -- the actual concurrency guarantee is the
    final tenant_config CAS deciding whether this generation ever becomes
    the published one at all."""
    for rel_path, content in artifacts.items():
        tenant_blob_store.put_blob(
            tenant_blob_keys.generation_private_data_blob_key(tenant_id, generation, rel_path),
            content, content_type="application/json", allow_overwrite=True,
        )


def _verify_uploaded_generation(tenant_id: str, generation: str, artifacts: dict[str, bytes]) -> None:
    """Post-upload verification (HEAD, no re-download) -- confirms every
    uploaded object genuinely exists in Blob before this generation is
    ever pointed at by tenant_config."""
    for rel_path in artifacts:
        key = tenant_blob_keys.generation_private_data_blob_key(tenant_id, generation, rel_path)
        if tenant_blob_store.head_blob(key) is None:
            raise ArtifactPublicationError(f"artifact {rel_path!r} was not found in Blob immediately after upload")


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def initial_sync(tenant_id: str) -> dict:
    """The full state machine -- see this file's header for the complete
    rationale. Summary of the happy path:
      1. Load + validate tenant_config (status/storageMode/provisioning/
         approvedLocations/locationIdMap) -- no external access yet.
      2. Verify a real, tenant-specific Google credential exists (a Redis
         read, never a Google API call yet).
      3. CAS-write status 'initial_sync' (captures expected_version at the
         START, chained +1 after every one of this run's own successful
         writes -- see CONCURRENCY in this file's header).
      4. Download reviews.db, verifying its ETag against tenant_config's
         own trusted provisioning.reviewDbEtag first.
      5. Bind db.DB_PATH to the downloaded temp file; verify integrity and
         that the locations table matches locationIdMap EXACTLY (abort,
         never repair, on any mismatch).
      6. Run Google sync via ApprovedLocationsOnlyGBPProvider -- ONLY this
         tenant's own approved Google locations are ever fetched or
         written; requires a clean 'ok' result for every one of them.
      7. Re-verify integrity + location identity (defense-in-depth against
         a corrupting write during sync).
      8. Upload the replacement reviews.db with if_match bound to the ETag
         read in step 4 -- rejected atomically by Blob if anything else
         changed the database in the meantime.
      9. Generate the real private-data artifact set (reusing
         export_chunks.py's own functions) and upload every file under a
         brand-new generation id; verify the upload.
     10. Final CAS: status 'active', provisioning.reviewDbEtag/
         artifactGeneration updated, initialSync marked 'completed' with
         review/location counts. ANY failure at any prior step marks the
         tenant 'initial_sync_failed' instead, via the SAME CAS discipline,
         and never touches Blob any further.
    """
    tenant_keys.assert_valid_tenant_id(tenant_id, "initial_sync")
    config = _load_and_validate_config(tenant_id)
    expected_version = config.get("configVersion", 0)
    approved_locations = config["approvedLocations"]
    location_id_map = config.get("locationIdMap") or {}
    expected = _validate_stable_id_consistency(approved_locations, location_id_map)

    if not google_api.has_tenant_credential(tenant_id):
        raise NoGoogleCredentialError(
            f"tenant {tenant_id!r} has no real Google credential in the Redis-backed store -- "
            f"Initial Sync will not fall back to any shared/global credential"
        )

    review_db_blob_key = tenant_blob_keys.review_db_blob_key(tenant_id)
    trusted_etag = (config.get("provisioning") or {}).get("reviewDbEtag")
    if not trusted_etag:
        raise DatabaseIdentityMismatchError(
            f"tenant {tenant_id!r}: tenant_config has no recorded provisioning.reviewDbEtag to verify against"
        )

    attempt_started_at = _now_iso()
    # Tracked across the whole attempt so the failure handler below can
    # honestly update tenant_config's trusted provisioning.reviewDbEtag
    # even when this attempt ultimately fails AFTER its own DB upload
    # already succeeded and was confirmed by Blob (e.g. the process dies
    # before the final activation CAS) -- see this file's CONCURRENCY
    # section: the recorded etag must always reflect Blob's actual current
    # state for THIS pipeline's own confirmed writes, or a subsequent
    # retry's precondition check (etag-must-match-trusted-value) would
    # permanently and incorrectly refuse to proceed.
    new_etag = None
    try:
        tenant_config_store.upsert_tenant_config(tenant_id, {
            "status": "initial_sync",
            "initialSync": {**(config.get("initialSync") or {}), "status": "in_progress", "startedAt": attempt_started_at, "completedAt": None, "failedAt": None, "lastError": None},
        }, expected_version=expected_version)
    except tenant_config_store.ConfigVersionConflictError as e:
        raise StaleInitialSyncAttemptError(
            f"tenant {tenant_id!r}: tenant_config changed before Initial Sync could start (expected version "
            f"{expected_version}) -- aborting without touching Blob/SQLite/Google; retry will re-read current state"
        ) from e
    expected_version += 1

    # A plain tempfile.mkdtemp() + manual, best-effort cleanup -- NOT
    # tempfile.TemporaryDirectory()'s own context-manager cleanup, which
    # raises if anything inside it still holds an OS-level lock on Windows
    # at __exit__ time. provider_sync.sync_all() (called below) never
    # explicitly closes its own sqlite3.Connection (fine for its real
    # callers -- a short-lived, one-shot process that exits right after,
    # releasing the OS handle on process exit); THIS process does not exit
    # here, it goes on to open further connections to the SAME file. A
    # forced gc.collect() before cleanup (see below) resolves this in
    # practice, but cleanup itself stays best-effort (ignore_errors=True,
    # exactly like provision_tenant.py's own shutil.rmtree() cleanup for
    # its staging directory) so a residual lock can never turn a real
    # success or a real, already-handled failure into a crash of this
    # function itself -- it is a scratch OS temp directory the OS will
    # reclaim regardless.
    tmp = tempfile.mkdtemp(prefix=f"initial-sync-{tenant_id}-")
    try:
        tmp_db_path = Path(tmp) / "reviews.db"
        starting_etag = _download_and_verify_database(tenant_id, review_db_blob_key, trusted_etag, tmp_db_path)

        _run_integrity_check(tmp_db_path)
        _verify_database_identity(tmp_db_path, expected)

        original_db_path = db.DB_PATH
        db.DB_PATH = tmp_db_path
        try:
            sync_result = _run_google_sync(tenant_id, approved_locations)
        finally:
            db.DB_PATH = original_db_path
            gc.collect()  # see this function's header comment above

        _run_integrity_check(tmp_db_path)
        _verify_database_identity(tmp_db_path, expected)

        new_db_data = tmp_db_path.read_bytes()
        try:
            put_result = tenant_blob_store.put_blob(review_db_blob_key, new_db_data, content_type="application/octet-stream", if_match=starting_etag)
        except tenant_blob_store.BlobPreconditionFailedError as e:
            raise StaleInitialSyncAttemptError(
                f"tenant {tenant_id!r}: reviews.db at {review_db_blob_key!r} changed since this attempt "
                f"last read it (expected ETag {starting_etag!r}) -- rejecting the stale upload; a fresh "
                f"retry will re-download the current durable database"
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
    except StaleInitialSyncAttemptError:
        # No tenant_config write to make here -- the caller (a fresh retry)
        # will correctly re-evaluate current state. Marking 'failed' would
        # be WRONG if a newer/concurrent attempt is what caused this one to
        # go stale (that newer attempt's own state must never be
        # overwritten) -- see this file's CONCURRENCY section.
        raise
    except Exception as e:
        try:
            failure_patch = {
                "status": "initial_sync_failed",
                "initialSync": {
                    "status": "failed", "startedAt": attempt_started_at, "completedAt": None,
                    "failedAt": _now_iso(), "reviewDbEtag": new_etag, "artifactGeneration": None,
                    "reviewCount": None, "locationCount": None, "lastError": _safe_error(e),
                },
            }
            if new_etag is not None:
                # This attempt's OWN reviews.db upload already succeeded
                # and was confirmed by Blob before something later failed
                # (e.g. an artifact upload, or the process dying before
                # the final CAS) -- update the trusted etag to match
                # reality now, so a subsequent retry's precondition check
                # (Blob's current etag must match this recorded value)
                # doesn't permanently deadlock against its own prior
                # progress. artifactGeneration is deliberately left
                # untouched -- no artifact generation was confirmed.
                failure_patch["provisioning"] = {**(config.get("provisioning") or {}), "reviewDbEtag": new_etag}
            tenant_config_store.upsert_tenant_config(tenant_id, failure_patch, expected_version=expected_version)
        except tenant_config_store.ConfigVersionConflictError:
            # Something NEWER already happened to this tenant (suspension,
            # a concurrent attempt's own success, an approved-locations
            # change) -- a stale failure report must never overwrite it.
            pass
        raise
    finally:
        gc.collect()
        shutil.rmtree(tmp, ignore_errors=True)

    try:
        tenant_config_store.upsert_tenant_config(tenant_id, {
            "status": "active",
            "provisioning": {
                **(config.get("provisioning") or {}),
                "reviewDbEtag": new_etag, "artifactGeneration": generation,
            },
            "initialSync": {
                "status": "completed", "startedAt": attempt_started_at,
                "completedAt": _now_iso(), "failedAt": None,
                "reviewDbEtag": new_etag, "artifactGeneration": generation,
                "reviewCount": review_count, "locationCount": len(locations_by_id),
                "lastError": None,
            },
        }, expected_version=expected_version)
    except tenant_config_store.ConfigVersionConflictError as e:
        # The Blob uploads above (database AND artifact generation) are
        # genuinely done and internally consistent -- they are simply NOT
        # published as this tenant's authoritative state, because
        # tenant_config changed underneath this attempt while syncing ran.
        raise StaleInitialSyncAttemptError(
            f"tenant {tenant_id!r}: tenant_config changed while Initial Sync was running (expected version "
            f"{expected_version}) -- the synced database and artifact generation were not published as "
            f"successful; retry will re-evaluate them against current state"
        ) from e

    return {
        "outcome": "active", "reviewDbEtag": new_etag, "artifactGeneration": generation,
        "reviewCount": review_count, "locationCount": len(locations_by_id),
        "locationsSucceeded": sync_result.get("locations_succeeded", 0), "newReviews": sync_result.get("new", 0),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the first real Google sync for a provisioned BLOB tenant (Multi-Tenant Phase 4G).")
    parser.add_argument("--tenant-id", required=True, help="The tenant to sync, e.g. t_example-restaurant")
    args = parser.parse_args()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::initial_sync.py: invalid --tenant-id {args.tenant_id!r}")
        return 1

    try:
        result = initial_sync(args.tenant_id)
    except InitialSyncError as e:
        print(f"::error::initial_sync.py: {e}")
        return 1

    print(f"initial_sync.py: tenant={args.tenant_id!r} outcome={result['outcome']} "
          f"reviews={result['reviewCount']} locations={result['locationCount']} "
          f"artifactGeneration={result['artifactGeneration']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
