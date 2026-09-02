"""
tenant_status_report.py -- Multi-Tenant Phase 4H.1: prints a SANITIZED,
Markdown-formatted summary of one tenant's current lifecycle state, for
.github/workflows/tenant-lifecycle.yml's GitHub Actions Job Summary.

READ-ONLY: performs no mutation of any kind, never calls provision_tenant.py
or initial_sync.py, and duplicates none of their logic -- this is purely a
formatted view over tenant_config_store.get_tenant_config() (the same
authoritative record those scripts themselves write) plus a boolean
Google-credential-exists check.

SAFE TO PRINT: tenant_config never stores a credential, refresh token, Blob
token, or Redis token (see tenant_config_store.py's own header) -- only
operational metadata (status, timestamps, counts). `lastError` fields are
already sanitized by construction at the point initial_sync.py/
provision_tenant.py write them (class name + message only, see
initial_sync.py's _safe_error()) -- this script does not attempt to
re-sanitize them further, but never prints anything else (no raw
exception object, no traceback, no request/response body).

Run directly: py tenant_status_report.py --tenant-id t_example-restaurant --operation initial_sync
"""
from __future__ import annotations

import argparse

import google_api
import tenant_config_store
import tenant_keys


def _fmt(value) -> str:
    return str(value) if value not in (None, "") else "_none_"


def build_summary(tenant_id: str, operation: str) -> str:
    lines = [f"## Tenant Lifecycle Operation: `{operation}`", "", f"**Tenant:** `{tenant_id}`", ""]

    try:
        config = tenant_config_store.get_tenant_config(tenant_id)
    except tenant_config_store.TenantConfigStoreUnavailableError as e:
        lines.append(f"WARNING: Could not read tenant configuration: store unavailable ({type(e).__name__}).")
        return "\n".join(lines)

    if config is None:
        lines.append("WARNING: No tenant_config record exists for this tenant.")
        return "\n".join(lines)

    provisioning = config.get("provisioning") or {}
    initial_sync = config.get("initialSync") or {}

    try:
        has_credential = google_api.has_tenant_credential(tenant_id)
    except Exception:  # noqa: BLE001 -- a summary must never crash the workflow step
        has_credential = None

    lines += [
        "| Field | Value |",
        "|---|---|",
        f"| Status | `{config.get('status')}` |",
        f"| Storage mode | `{config.get('storageMode')}` |",
        f"| Approved locations | {len(config.get('approvedLocations') or [])} |",
        f"| Provisioning status | `{provisioning.get('status')}` |",
        f"| Provisioning last attempt | {_fmt(provisioning.get('lastAttemptAt'))} |",
        f"| Initial Sync status | `{initial_sync.get('status')}` |",
        f"| Initial Sync started | {_fmt(initial_sync.get('startedAt'))} |",
        f"| Initial Sync completed | {_fmt(initial_sync.get('completedAt'))} |",
        f"| Initial Sync failed at | {_fmt(initial_sync.get('failedAt'))} |",
        f"| Reviews synced | {_fmt(initial_sync.get('reviewCount'))} |",
        f"| Locations synced | {_fmt(initial_sync.get('locationCount'))} |",
        f"| Artifact generation | `{_fmt(provisioning.get('artifactGeneration'))}` |",
        f"| Google credential present | {'unknown' if has_credential is None else has_credential} |",
    ]

    last_error = initial_sync.get("lastError") or provisioning.get("lastError")
    if last_error:
        lines += ["", f"**Last error:** `{last_error}`"]

    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", required=True)
    parser.add_argument("--operation", required=True)
    args = parser.parse_args()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"## Tenant Lifecycle Operation\n\nWARNING: Invalid tenant id: `{args.tenant_id}`")
        return 0

    print(build_summary(args.tenant_id, args.operation))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
