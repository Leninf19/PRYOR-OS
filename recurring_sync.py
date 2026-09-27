"""
recurring_sync.py -- proposed ongoing Google Business Profile review sync
for every BLOB-mode tenant that has already completed Initial Sync
(initial_sync.py) and is currently 'active'. Los Tres Amigos (LEGACY_REPO,
its own dedicated cron-scheduled update-reviews.yml pipeline) is never
touched by this script.

WHY A SEPARATE SCRIPT FROM initial_sync.py, NOT AN EXTENSION OF IT:
initial_sync.py's own state machine (provisioned/initial_sync_failed ->
initial_sync -> active) is a ONE-TIME transition -- see its own
`_ELIGIBLE_STATUSES` -- and structurally refuses to run again once a
tenant reaches 'active' (TenantNotEligibleError). This script targets the
DISJOINT complement: tenants ALREADY 'active' with initialSync.status ==
'completed'. A tenant is eligible for exactly one of these two scripts at
any given moment, never both, so there is no possible double-sync race
between them.

WHY REUSE, NOT REWRITE: every Blob download/verify/upload and artifact
generation/publication step below is the IDENTICAL function initial_sync.py
already defines, imported directly -- matching this codebase's own
established precedent of importing another module's underscore-prefixed
helper (initial_sync.py itself imports provision_tenant._inspect_database_file()).
Only three things differ from Initial Sync:
  1. Eligibility (already-active tenants, not provisioned/failed ones).
  2. What tenant_config field records the attempt -- a NEW `recurringSync`
     object, never touching `initialSync` or the tenant's `status` at all.
     A recurring sync's success or failure never moves a tenant out of
     'active'.
  3. Orchestration processes EVERY eligible tenant in one run (or exactly
     one, via --tenant-id, for manual/rollout dispatch), not a single
     tenant the caller already knows is eligible.

MULTI-TENANT ENUMERATION: reuses the SAME registry-union pattern
credential_migration_status.py and activate_review_media_rollout.py
already established (tenant_paths.list_static_registry_tenant_ids() |
tenant_config_store.list_tenant_ids()), then filters explicitly on
storageMode == 'BLOB' -- a structural exclusion of Los Tres Amigos (always
LEGACY_REPO -- see tenant_config_store.py's own comment that LEGACY_REPO is
reserved for it) that can never accidentally include or exclude it based
on registry-membership edge cases, regardless of whether LTA also happens
to have a bootstrapped Redis record.

ONE TENANT'S FAILURE NEVER BLOCKS ANOTHER'S: tenants are processed
sequentially in one process (matching the existing "loop tenants
in-language" precedent -- credential_migration_status.py -- since no
GitHub Actions workflow in this repo uses `strategy: matrix`, and to avoid
any concurrent-request burst against Google's API, which has no proactive
rate limiter anywhere in this codebase -- see google_api.py/retry.py, only
reactive per-call exponential backoff). Each tenant's sync is fully
isolated: a failure is recorded in THAT tenant's own
recurringSync.lastError and the loop continues. The process exits non-zero
if at least one tenant failed, so CI surfaces it, but this never prevents
any other tenant's successful sync from being durably recorded first.

CONCURRENCY: identical two-CAS-guarantee design as initial_sync.py (tenant
configVersion + Blob ETag) -- see that file's header for the full
rationale. This script adds nothing new here; it reuses the same
primitives with the same guarantees, per tenant, per attempt.

Run directly: py recurring_sync.py [--tenant-id t_example-restaurant]
"""
from __future__ import annotations

import argparse
import gc
import shutil
import sqlite3
import sys
import tempfile
import uuid
from pathlib import Path

import db
import google_api
import tenant_artifact_export
import tenant_blob_keys
import tenant_blob_store
import tenant_config_store
import tenant_keys
import tenant_location_mapping
import tenant_paths
from initial_sync import (
    ArtifactPublicationError,
    DatabaseIdentityMismatchError,
    _download_and_verify_database,
    _now_iso,
    _run_google_sync,
    _run_integrity_check,
    _safe_error,
    _upload_artifact_generation,
    _verify_artifact_generation,
    _verify_database_identity,
    _verify_uploaded_generation,
)


class RecurringSyncError(Exception):
    """Base class for every fail-closed refusal below."""


class StaleRecurringSyncAttemptError(RecurringSyncError):
    """Raised whenever this attempt's tenant_config write is rejected
    because configVersion changed since this attempt started, OR whenever
    a reviews.db Blob upload is rejected because its ETag changed since
    this attempt last read it. This attempt's work (if any) is NOT
    published. Never a genuine failure -- the next scheduled run will
    re-read current state and try again; never recorded in
    recurringSync.lastError."""


# ---------------------------------------------------------------------------
# Eligibility
# ---------------------------------------------------------------------------

def _load_and_validate_config(tenant_id: str) -> dict | None:
    """Returns the tenant's config if eligible for a recurring sync
    attempt, or None if not eligible. Unlike initial_sync.py's single-tenant
    CLI (where ineligibility is the caller's mistake, raised as an error),
    this returns None for the ordinary, expected case of scanning every
    tenant and skipping the ones not currently due -- e.g. Los Tres Amigos,
    a tenant mid-onboarding, or one that already failed Initial Sync.

    Eligible: storageMode 'BLOB', status 'active', provisioning.status
    'provisioned', initialSync.status 'completed', at least one approved
    location, and a real, tenant-specific Google credential on file."""
    config = tenant_config_store.get_tenant_config(tenant_id)
    if config is None:
        return None
    if config.get("storageMode") != "BLOB":
        return None
    if config.get("status") != "active":
        return None
    if (config.get("provisioning") or {}).get("status") != "provisioned":
        return None
    if (config.get("initialSync") or {}).get("status") != "completed":
        return None
    if not (config.get("approvedLocations") or []):
        return None
    if not google_api.has_tenant_credential(tenant_id):
        return None
    return config


def _enumerate_tenant_ids() -> list[str]:
    ids = set(tenant_paths.list_static_registry_tenant_ids())
    try:
        ids.update(tenant_config_store.list_tenant_ids())
    except tenant_config_store.TenantConfigStoreUnavailableError:
        raise  # a genuine store outage must abort the whole run -- see main()
    return sorted(i for i in ids if tenant_keys.is_valid_tenant_id(i))


# ---------------------------------------------------------------------------
# One tenant's sync attempt -- mirrors initial_sync.py's own orchestration,
# minus the one-time status transition and mediaCapture enrollment (a
# recurring sync never moves a tenant's status, only its recurringSync and
# provisioning.reviewDbEtag/artifactGeneration pointers).
# ---------------------------------------------------------------------------

def sync_one_tenant(tenant_id: str, config: dict) -> dict:
    tenant_keys.assert_valid_tenant_id(tenant_id, "recurring_sync")
    expected_version = config.get("configVersion", 0)
    approved_locations = config["approvedLocations"]
    location_id_map = config.get("locationIdMap") or {}
    expected = tenant_location_mapping.validate_stable_id_consistency(approved_locations, location_id_map)

    review_db_blob_key = tenant_blob_keys.review_db_blob_key(tenant_id)
    trusted_etag = (config.get("provisioning") or {}).get("reviewDbEtag")
    if not trusted_etag:
        raise DatabaseIdentityMismatchError(
            f"tenant {tenant_id!r}: tenant_config has no recorded provisioning.reviewDbEtag to verify against"
        )

    attempt_started_at = _now_iso()
    try:
        tenant_config_store.upsert_tenant_config(tenant_id, {
            "recurringSync": {**(config.get("recurringSync") or {}), "status": "in_progress", "startedAt": attempt_started_at, "lastError": None},
        }, expected_version=expected_version)
    except tenant_config_store.ConfigVersionConflictError as e:
        raise StaleRecurringSyncAttemptError(
            f"tenant {tenant_id!r}: tenant_config changed before this attempt could start -- skipping, "
            f"next scheduled run will re-read current state"
        ) from e
    expected_version += 1

    tmp = tempfile.mkdtemp(prefix=f"recurring-sync-{tenant_id}-")
    new_etag = None
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
            gc.collect()  # see initial_sync.py's identical comment: releases the sqlite3 handle before cleanup

        _run_integrity_check(tmp_db_path)
        _verify_database_identity(tmp_db_path, expected)

        new_db_data = tmp_db_path.read_bytes()
        try:
            put_result = tenant_blob_store.put_blob(review_db_blob_key, new_db_data, content_type="application/octet-stream", if_match=starting_etag)
        except tenant_blob_store.BlobPreconditionFailedError as e:
            raise StaleRecurringSyncAttemptError(
                f"tenant {tenant_id!r}: reviews.db at {review_db_blob_key!r} changed since this attempt "
                f"last read it -- skipping this run; a fresh run will re-download the current database"
            ) from e
        new_etag = put_result["etag"]

        conn = sqlite3.connect(tmp_db_path)
        conn.row_factory = sqlite3.Row
        try:
            locations_by_id = {row["id"]: dict(row) for row in conn.execute("SELECT * FROM locations").fetchall()}
            review_count = conn.execute("SELECT COUNT(*) AS c FROM reviews WHERE is_deleted = 0").fetchone()["c"]
            artifacts = tenant_artifact_export.generate_tenant_artifacts(conn, tenant_id)
        finally:
            conn.close()

        _verify_artifact_generation(artifacts, locations_by_id)
        generation = uuid.uuid4().hex
        _upload_artifact_generation(tenant_id, generation, artifacts)
        _verify_uploaded_generation(tenant_id, generation, artifacts)
    except StaleRecurringSyncAttemptError:
        raise
    except Exception as e:
        try:
            failure_patch = {
                "recurringSync": {
                    "status": "failed", "startedAt": attempt_started_at,
                    "completedAt": None, "failedAt": _now_iso(),
                    "lastError": _safe_error(e), "lastReviewCount": None, "lastNewReviews": None,
                },
            }
            if new_etag is not None:
                # This attempt's own reviews.db upload already succeeded and
                # was confirmed by Blob before something later failed -- see
                # initial_sync.py's identical reasoning for why the trusted
                # etag must be updated to match reality regardless.
                failure_patch["provisioning"] = {**(config.get("provisioning") or {}), "reviewDbEtag": new_etag}
            tenant_config_store.upsert_tenant_config(tenant_id, failure_patch, expected_version=expected_version)
        except tenant_config_store.ConfigVersionConflictError:
            pass  # something newer already happened -- a stale failure report must never overwrite it
        raise
    finally:
        gc.collect()
        shutil.rmtree(tmp, ignore_errors=True)

    try:
        tenant_config_store.upsert_tenant_config(tenant_id, {
            "provisioning": {**(config.get("provisioning") or {}), "reviewDbEtag": new_etag, "artifactGeneration": generation},
            "recurringSync": {
                "status": "completed", "startedAt": attempt_started_at,
                "completedAt": _now_iso(), "failedAt": None, "lastError": None,
                "lastReviewCount": review_count, "lastNewReviews": sync_result.get("new", 0),
            },
        }, expected_version=expected_version)
    except tenant_config_store.ConfigVersionConflictError as e:
        raise StaleRecurringSyncAttemptError(
            f"tenant {tenant_id!r}: tenant_config changed while this sync was running -- the synced database "
            f"and artifact generation were not published; a fresh run will re-evaluate them"
        ) from e

    return {
        "outcome": "completed", "reviewCount": review_count, "locationCount": len(locations_by_id),
        "newReviews": sync_result.get("new", 0),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Ongoing Google review sync for every eligible BLOB-mode tenant (or one, via --tenant-id).")
    parser.add_argument("--tenant-id", required=False, default=None, help="Sync only this tenant, for manual/rollout dispatch. Omit to process every eligible tenant.")
    args = parser.parse_args()

    if args.tenant_id is not None and not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::recurring_sync.py: invalid --tenant-id {args.tenant_id!r}")
        return 1

    try:
        tenant_ids = [args.tenant_id] if args.tenant_id else _enumerate_tenant_ids()
    except tenant_config_store.TenantConfigStoreUnavailableError as e:
        print(f"::error::recurring_sync.py: tenant config store unavailable, aborting entirely: {e}")
        return 1

    if not tenant_ids:
        print("recurring_sync.py: no tenants found in either registry.")
        return 0

    any_failed = False
    any_synced = False
    any_eligible = False
    for tenant_id in tenant_ids:
        try:
            config = _load_and_validate_config(tenant_id)
        except tenant_config_store.TenantConfigStoreUnavailableError as e:
            print(f"::error::recurring_sync.py: tenant config store unavailable, aborting entirely: {e}")
            return 1
        if config is None:
            if args.tenant_id:
                print(f"::error::recurring_sync.py: tenant={tenant_id!r} is not currently eligible for recurring sync "
                      f"(requires storageMode=BLOB, status=active, provisioning.status=provisioned, "
                      f"initialSync.status=completed, an approved location, and a Google credential)")
                return 1
            continue  # scanning every tenant -- most are simply not due; skip silently

        any_eligible = True
        try:
            result = sync_one_tenant(tenant_id, config)
        except StaleRecurringSyncAttemptError as e:
            print(f"::warning::recurring_sync.py: tenant={tenant_id!r} stale attempt, next scheduled run will retry: {e}")
            continue
        except Exception as e:
            print(f"::error::recurring_sync.py: tenant={tenant_id!r} failed: {_safe_error(e)}")
            any_failed = True
            continue

        any_synced = True
        print(f"recurring_sync.py: tenant={tenant_id!r} outcome=completed reviews={result['reviewCount']} "
              f"locations={result['locationCount']} newReviews={result['newReviews']}")

    if not any_eligible:
        print("recurring_sync.py: no eligible tenants found this run.")
    return 1 if any_failed else 0


if __name__ == "__main__":
    sys.exit(main())
