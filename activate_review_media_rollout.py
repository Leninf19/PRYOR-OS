"""
activate_review_media_rollout.py -- All-Tenant Rollout: the smallest safe
administrative command to activate prospective review-media capture for
every EXISTING, legitimate, genuinely-operational Production tenant.

Writes ONLY through the supported, hardened, CAS-protected
tenant_config_store.activate_media_capture() function -- never a direct
Redis write, never a raw HSET, and never any field beyond
tenant_config:v1.mediaCapture. Every activation timestamp is computed
server-side, at the moment this command actually writes it (see
tenant_config_store.compute_media_capture_activation_patch()'s own
docstring) -- this script never accepts, computes, or passes a
caller-supplied timestamp anywhere.

SAFE BY DEFAULT: this command performs a DRY RUN (zero writes) unless
--apply is passed explicitly. It is safe to rerun any number of times in
either mode: an already-active tenant is reported as already_active and
never rewritten (its existing startedAt is never touched), and a
mid-flight CAS version conflict (another writer touched the same tenant's
config between this command's read and write) is retried a bounded number
of times against the tenant's own current state before being reported as
failed -- never resolved by force-overwriting.

"Legitimate tenant," for this command's purposes: a well-formed tenant_id
(tenant_keys.is_valid_tenant_id()) with a tenant_config:v1 record whose
status is EXACTLY 'active' -- the ONLY status this codebase treats as
"genuinely, successfully operational" anywhere else (see
tenant_paths.py's _resolve_provisioned_path(), initial_sync.py's own
state machine). Every other status (onboarding, locations_approved,
provisioning, provisioned, initial_sync, initial_sync_failed,
provisioning_failed, provisioning_dispatch_failed, suspended) -- along
with a malformed tenant_id, or a discovered key with no config record at
all -- is reported as skipped_invalid, never activated. This command has
no concept of "delete a tenant" (this codebase has none) and never treats
a location, a review-database row, or a test fixture as a tenant --
enumeration is scoped exclusively to tenant_config_store.list_tenant_ids(),
the same Redis hash every other tenant-config reader/writer in this
codebase already treats as the single authoritative store.

This command NEVER: calls any Google API, triggers or dispatches a review
sync, requests a media URL, downloads media, modifies reviews.db or any
exported artifact, or touches billing/OAuth/reply/entitlement/any other
tenant setting.

Usage:
    py activate_review_media_rollout.py               # dry run (default, zero writes)
    py activate_review_media_rollout.py --apply        # writes for real
"""
import argparse
import sys

import tenant_config_store
import tenant_keys

MAX_CAS_RETRIES = 5

RESULT_ALREADY_ACTIVE = "already_active"
RESULT_WOULD_ACTIVATE = "would_activate"
RESULT_ACTIVATED = "activated"
RESULT_FAILED = "failed"
RESULT_SKIPPED_INVALID = "skipped_invalid"


def _is_already_active(config: dict) -> bool:
    media_capture = (config or {}).get("mediaCapture") or {}
    return (
        media_capture.get("status") == "active"
        and tenant_config_store._is_valid_iso_utc_timestamp(media_capture.get("startedAt"))
    )


def _classify_and_maybe_activate(tenant_id: str, apply: bool) -> tuple[str, str]:
    """Returns (result_category, safe_detail). `safe_detail` is a short,
    non-sensitive string (a status name, a retry count, an exception class
    name) -- never a full config dict, never a Redis value, never a
    credential."""
    try:
        config = tenant_config_store.get_tenant_config(tenant_id)
    except tenant_config_store.TenantConfigStoreUnavailableError as e:
        return RESULT_FAILED, f"config lookup failed: {type(e).__name__}"

    if config is None:
        return RESULT_SKIPPED_INVALID, "no tenant_config record"
    status = config.get("status")
    if status != "active":
        return RESULT_SKIPPED_INVALID, f"status={status!r} (not operational)"

    if _is_already_active(config):
        return RESULT_ALREADY_ACTIVE, config["mediaCapture"]["startedAt"]

    if not apply:
        return RESULT_WOULD_ACTIVATE, "dry run -- no write performed"

    current_config = config
    for attempt in range(MAX_CAS_RETRIES):
        # Re-check on every attempt (including the first) -- another writer
        # may have already activated this tenant between our initial read
        # above and this attempt; never re-activate what's already done.
        if _is_already_active(current_config):
            return RESULT_ALREADY_ACTIVE, current_config["mediaCapture"]["startedAt"]
        try:
            updated = tenant_config_store.activate_media_capture(
                tenant_id, expected_version=current_config.get("configVersion", 0),
            )
            return RESULT_ACTIVATED, updated["mediaCapture"]["startedAt"]
        except tenant_config_store.ConfigVersionConflictError as e:
            if e.current_record is not None:
                current_config = e.current_record
            else:
                try:
                    current_config = tenant_config_store.get_tenant_config(tenant_id)
                except tenant_config_store.TenantConfigStoreUnavailableError as read_err:
                    return RESULT_FAILED, f"re-read after CAS conflict failed: {type(read_err).__name__}"
                if current_config is None:
                    return RESULT_FAILED, "tenant_config disappeared during CAS retry"
            continue
        except tenant_config_store.TenantConfigStoreUnavailableError as e:
            return RESULT_FAILED, f"write failed: {type(e).__name__}"
        except ValueError as e:
            return RESULT_FAILED, f"activation rejected: {type(e).__name__}"

    return RESULT_FAILED, f"exhausted {MAX_CAS_RETRIES} CAS retries"


def run_rollout(apply: bool) -> dict:
    """Pure orchestration -- discovers tenants, classifies/activates each
    one, and returns the full reconciliation dict. Never prints anything
    itself (see main() for the only print statements this module makes),
    so this function is directly usable from a test without capturing
    stdout."""
    discovered = tenant_config_store.list_tenant_ids()
    seen: set[str] = set()
    deduped: list[str] = []
    for tenant_id in discovered:
        if tenant_id not in seen:
            seen.add(tenant_id)
            deduped.append(tenant_id)

    per_tenant: list[dict] = []
    counts = {
        RESULT_ALREADY_ACTIVE: 0, RESULT_WOULD_ACTIVATE: 0, RESULT_ACTIVATED: 0,
        RESULT_FAILED: 0, RESULT_SKIPPED_INVALID: 0,
    }

    for tenant_id in sorted(deduped):
        if not tenant_keys.is_valid_tenant_id(tenant_id):
            result, detail = RESULT_SKIPPED_INVALID, "malformed tenant_id"
        else:
            result, detail = _classify_and_maybe_activate(tenant_id, apply)
        counts[result] += 1
        per_tenant.append({"tenant_id": tenant_id, "result": result, "detail": detail})

    valid_considered = len(deduped) - counts[RESULT_SKIPPED_INVALID]
    active_after = counts[RESULT_ALREADY_ACTIVE] + counts[RESULT_ACTIVATED]
    if not apply:
        # Dry run never activates anything -- "total active after
        # completion" in a dry run reflects the CURRENT active count only
        # (already_active), since would_activate performs no write.
        active_after = counts[RESULT_ALREADY_ACTIVE]

    return {
        "apply": apply,
        "registered_tenants_discovered": len(deduped),
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
    print(f"Registered tenants discovered: {report['registered_tenants_discovered']}")
    print(f"Valid tenants considered:      {report['valid_tenants_considered']}")
    print(f"Already active:                {report['counts'][RESULT_ALREADY_ACTIVE]}")
    if report["apply"]:
        print(f"Newly activated:               {report['counts'][RESULT_ACTIVATED]}")
    else:
        print(f"Would activate:                {report['counts'][RESULT_WOULD_ACTIVATE]}")
    print(f"Skipped (invalid):             {report['counts'][RESULT_SKIPPED_INVALID]}")
    print(f"Failed:                        {report['counts'][RESULT_FAILED]}")
    print(f"Total active after completion: {report['total_active_after_completion']}")

    reconciled = (
        report["valid_tenants_considered"]
        == report["counts"][RESULT_ALREADY_ACTIVE]
        + report["counts"][RESULT_ACTIVATED]
        + report["counts"][RESULT_WOULD_ACTIVATE]
        + report["counts"][RESULT_FAILED]
    )
    print(f"Totals reconcile: {reconciled}")
    print()
    if report["apply"]:
        print("=== END -- writes limited to tenant_config:v1.mediaCapture only; no sync, no Google call, no media fetch ===")
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
