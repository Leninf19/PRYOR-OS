"""
activate_review_media_rollout.py -- All-Tenant Rollout: the smallest safe
administrative command to activate prospective review-media capture for
every EXISTING, legitimate, genuinely-operational Production tenant.

"All tenants" is the DEDUPLICATED UNION of two independent, authoritative
sources -- never either one alone:
  1. tenant_paths.list_static_registry_tenant_ids() -- tenants onboarded via
     a reviewed source-code registry edit (today: Los Tres Amigos, which
     predates the Redis-backed system entirely and, by design, has no
     tenant_config:v1 record of its own -- see tenant_paths.py's own
     "All-Tenant Rollout -- legacy tenant_config bootstrap" section for the
     full audit of why creating one is safe).
  2. tenant_config_store.list_tenant_ids() -- every self-service/admin-
     provisioned tenant with a real tenant_config:v1 Redis record.
A tenant in source 1 with no record yet is BOOTSTRAPPED (a bare,
non-inventive record -- status='active', storageMode='LEGACY_REPO', its
own real, already-true state, nothing else) via
tenant_paths.bootstrap_legacy_tenant_config() before activation, using an
atomic create-if-absent write that never overwrites a concurrently-created
record. A tenant in both sources (should a static-registry tenant later
also gain a real record) is processed exactly once.

Writes ONLY through the supported, hardened, CAS-protected
tenant_config_store.activate_media_capture() function (and, for a
static-registry tenant with no record yet, tenant_paths.bootstrap_legacy_tenant_config()
immediately beforehand) -- never a direct Redis write, never a raw HSET,
and never any field beyond tenant_config:v1's own status/storageMode (bootstrap
only) and mediaCapture (activation). Every activation timestamp is
computed server-side, at the moment this command actually writes it (see
tenant_config_store.compute_media_capture_activation_patch()'s own
docstring) -- this script never accepts, computes, or passes a
caller-supplied timestamp anywhere.

SAFE BY DEFAULT: this command performs a DRY RUN (zero writes) unless
--apply is passed explicitly. It is safe to rerun any number of times in
either mode: an already-active tenant is reported as already_active and
never rewritten (its existing startedAt is never touched), a
static-registry tenant already bootstrapped on a prior run is found via
its now-real record and simply activated normally, and a mid-flight CAS
version conflict (another writer touched the same tenant's config between
this command's read and write) is retried a bounded number of times
against the tenant's own current state before being reported as failed --
never resolved by force-overwriting.

"Legitimate tenant," for this command's purposes: a well-formed tenant_id
(tenant_keys.is_valid_tenant_id()) that is EITHER in the static registry
OR has a tenant_config:v1 record whose status is EXACTLY 'active' -- the
ONLY status this codebase treats as "genuinely, successfully operational"
anywhere else (see tenant_paths.py's _resolve_provisioned_path(),
initial_sync.py's own state machine). Every other status (onboarding,
locations_approved, provisioning, provisioned, initial_sync,
initial_sync_failed, provisioning_failed, provisioning_dispatch_failed,
suspended) -- along with a malformed tenant_id -- is reported as
skipped_invalid, never activated. This command has no concept of "delete
a tenant" (this codebase has none) and never treats a location, a
review-database row, or a test fixture as a tenant.

This command NEVER: calls any Google API, triggers or dispatches a review
sync, requests a media URL, downloads media, modifies reviews.db or any
exported artifact, or touches billing/OAuth/reply/entitlement/any other
tenant setting.

Usage:
    py activate_review_media_rollout.py               # dry run (default, zero writes)
    py activate_review_media_rollout.py --apply        # writes for real
"""
import argparse

import tenant_config_store
import tenant_keys
import tenant_paths

MAX_CAS_RETRIES = 5

RESULT_ALREADY_ACTIVE = "already_active"
RESULT_WOULD_ACTIVATE = "would_activate"
RESULT_ACTIVATED = "activated"
RESULT_WOULD_BOOTSTRAP_AND_ACTIVATE = "would_bootstrap_and_activate"
RESULT_BOOTSTRAPPED_AND_ACTIVATED = "bootstrapped_and_activated"
RESULT_FAILED = "failed"
RESULT_SKIPPED_INVALID = "skipped_invalid"

_ALL_RESULT_CATEGORIES = (
    RESULT_ALREADY_ACTIVE, RESULT_WOULD_ACTIVATE, RESULT_ACTIVATED,
    RESULT_WOULD_BOOTSTRAP_AND_ACTIVATE, RESULT_BOOTSTRAPPED_AND_ACTIVATED,
    RESULT_FAILED, RESULT_SKIPPED_INVALID,
)


def _is_already_active(config: dict) -> bool:
    media_capture = (config or {}).get("mediaCapture") or {}
    return (
        media_capture.get("status") == "active"
        and tenant_config_store._is_valid_iso_utc_timestamp(media_capture.get("startedAt"))
    )


def _activate_with_retries(tenant_id: str, config: dict) -> tuple[bool, str]:
    """Returns (ok, detail). Shared by both the ordinary and
    just-bootstrapped activation paths -- exactly one CAS-retry
    implementation, never duplicated."""
    current_config = config
    for _attempt in range(MAX_CAS_RETRIES):
        if _is_already_active(current_config):
            return True, current_config["mediaCapture"]["startedAt"]
        try:
            updated = tenant_config_store.activate_media_capture(
                tenant_id, expected_version=current_config.get("configVersion", 0),
            )
            return True, updated["mediaCapture"]["startedAt"]
        except tenant_config_store.ConfigVersionConflictError as e:
            if e.current_record is not None:
                current_config = e.current_record
            else:
                try:
                    current_config = tenant_config_store.get_tenant_config(tenant_id)
                except tenant_config_store.TenantConfigStoreUnavailableError as read_err:
                    return False, f"re-read after CAS conflict failed: {type(read_err).__name__}"
                if current_config is None:
                    return False, "tenant_config disappeared during CAS retry"
            continue
        except tenant_config_store.TenantConfigStoreUnavailableError as e:
            return False, f"write failed: {type(e).__name__}"
        except ValueError as e:
            return False, f"activation rejected: {type(e).__name__}"
    return False, f"exhausted {MAX_CAS_RETRIES} CAS retries"


def _classify_and_maybe_act(tenant_id: str, in_static_registry: bool, apply: bool) -> tuple[str, str]:
    """Returns (result_category, safe_detail). `safe_detail` is a short,
    non-sensitive string (a status name, a retry count, an exception class
    name, an already-stored timestamp) -- never a full config dict, never
    a Redis value, never a credential."""
    try:
        config = tenant_config_store.get_tenant_config(tenant_id)
    except tenant_config_store.TenantConfigStoreUnavailableError as e:
        return RESULT_FAILED, f"config lookup failed: {type(e).__name__}"

    if config is None:
        if not in_static_registry:
            # Structurally shouldn't happen -- every Redis-sourced id has a
            # record by definition -- but never assumed away.
            return RESULT_SKIPPED_INVALID, "no tenant_config record"
        if not apply:
            return RESULT_WOULD_BOOTSTRAP_AND_ACTIVATE, "dry run -- no write performed"
        try:
            config = tenant_paths.bootstrap_legacy_tenant_config(tenant_id)
        except tenant_config_store.TenantConfigStoreUnavailableError as e:
            return RESULT_FAILED, f"bootstrap failed: {type(e).__name__}"
        ok, detail = _activate_with_retries(tenant_id, config)
        return (RESULT_BOOTSTRAPPED_AND_ACTIVATED if ok else RESULT_FAILED), detail

    status = config.get("status")
    if status != "active":
        return RESULT_SKIPPED_INVALID, f"status={status!r} (not operational)"

    if _is_already_active(config):
        return RESULT_ALREADY_ACTIVE, config["mediaCapture"]["startedAt"]

    if not apply:
        return RESULT_WOULD_ACTIVATE, "dry run -- no write performed"

    ok, detail = _activate_with_retries(tenant_id, config)
    return (RESULT_ACTIVATED if ok else RESULT_FAILED), detail


def run_rollout(apply: bool) -> dict:
    """Pure orchestration -- discovers the deduplicated union of both
    tenant registries, classifies/acts on each one, and returns the full
    reconciliation dict. Never prints anything itself (see main() for the
    only print statements this module makes), so this function is
    directly usable from a test without capturing stdout."""
    redis_ids = set(tenant_config_store.list_tenant_ids())
    static_ids = set(tenant_paths.list_static_registry_tenant_ids())
    union_ids = redis_ids | static_ids
    overlap_ids = redis_ids & static_ids

    per_tenant: list[dict] = []
    counts = {category: 0 for category in _ALL_RESULT_CATEGORIES}

    for tenant_id in sorted(union_ids):
        if not tenant_keys.is_valid_tenant_id(tenant_id):
            result, detail = RESULT_SKIPPED_INVALID, "malformed tenant_id"
        else:
            result, detail = _classify_and_maybe_act(tenant_id, tenant_id in static_ids, apply)
        counts[result] += 1
        per_tenant.append({"tenant_id": tenant_id, "result": result, "detail": detail})

    valid_considered = len(union_ids) - counts[RESULT_SKIPPED_INVALID]
    if apply:
        active_after = counts[RESULT_ALREADY_ACTIVE] + counts[RESULT_ACTIVATED] + counts[RESULT_BOOTSTRAPPED_AND_ACTIVATED]
    else:
        # Dry run never writes anything -- "total active after completion"
        # reflects the CURRENT active count only.
        active_after = counts[RESULT_ALREADY_ACTIVE]

    return {
        "apply": apply,
        "static_registry_count": len(static_ids),
        "redis_registry_count": len(redis_ids),
        "overlap_count": len(overlap_ids),
        "deduplicated_tenant_count": len(union_ids),
        "existing_config_count": len(redis_ids),
        "missing_legacy_config_count": len(static_ids - redis_ids),
        "valid_tenants_considered": valid_considered,
        "counts": counts,
        "total_active_after_completion": active_after,
        "per_tenant": per_tenant,
    }


def _print_report(report: dict) -> None:
    mode = "APPLY" if report["apply"] else "DRY RUN"
    print(f"=== Review Media Rollout -- {mode} ===")
    for row in report["per_tenant"]:
        # Only ever a tenant_id (a validated t_[a-z0-9-]+ string, never a
        # secret), its result category, and a short, pre-sanitized detail
        # string (a status name, a timestamp already stored in tenant
        # config, a retry count, or an exception class name).
        print(f"  {row['tenant_id']}: {row['result']} ({row['detail']})")
    print()
    print("--- Reconciliation ---")
    print(f"Static registry tenants:       {report['static_registry_count']}")
    print(f"Redis registry tenants:        {report['redis_registry_count']}")
    print(f"Overlap (both registries):     {report['overlap_count']}")
    print(f"Deduplicated tenants:          {report['deduplicated_tenant_count']}")
    print(f"Already had a config record:   {report['existing_config_count']}")
    print(f"Missing legacy config record:  {report['missing_legacy_config_count']}")
    print(f"Valid tenants considered:      {report['valid_tenants_considered']}")
    print(f"Already active:                {report['counts'][RESULT_ALREADY_ACTIVE]}")
    if report["apply"]:
        print(f"Newly activated:               {report['counts'][RESULT_ACTIVATED]}")
        print(f"Bootstrapped and activated:    {report['counts'][RESULT_BOOTSTRAPPED_AND_ACTIVATED]}")
    else:
        print(f"Would activate:                {report['counts'][RESULT_WOULD_ACTIVATE]}")
        print(f"Would bootstrap and activate:  {report['counts'][RESULT_WOULD_BOOTSTRAP_AND_ACTIVATE]}")
    print(f"Skipped (invalid):             {report['counts'][RESULT_SKIPPED_INVALID]}")
    print(f"Failed:                        {report['counts'][RESULT_FAILED]}")
    print(f"Total active after completion: {report['total_active_after_completion']}")

    reconciled = report["valid_tenants_considered"] == sum(
        report["counts"][c] for c in _ALL_RESULT_CATEGORIES if c != RESULT_SKIPPED_INVALID
    )
    print(f"Totals reconcile: {reconciled}")
    print()
    if report["apply"]:
        print("=== END -- writes limited to tenant_config:v1 status/storageMode (bootstrap only) and mediaCapture; no sync, no Google call, no media fetch ===")
    else:
        print("=== END -- DRY RUN: zero writes performed ===")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                         help="Write activations for real. Without this flag, performs a dry run only (default).")
    args = parser.parse_args()

    try:
        report = run_rollout(apply=args.apply)
    except tenant_config_store.TenantConfigStoreUnavailableError as e:
        print(f"::error::activate_review_media_rollout.py: could not enumerate tenants: {type(e).__name__}: {e}")
        return 1

    _print_report(report)

    if report["counts"][RESULT_FAILED] > 0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
