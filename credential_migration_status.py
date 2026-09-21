"""
Read-only, sanitized Google OAuth dual-client migration-status report
(PRYOR OS Google Cloud project migration, Phase 5).

For every known tenant, prints ONLY: tenant_id, credential classification
('legacy-lta' | 'pryor-2026' | 'missing' | 'unknown'), health (if already
non-sensitive and available), and connectedAt (if already non-sensitive
and available).

Makes NO writes and NO Google API calls -- a single Redis GET per tenant
(the same store/keys every other read path in this codebase already
uses), nothing else. Deliberately NEVER decrypts the stored refresh
token: this script reads the raw JSON record and extracts only the
clientKey/health/connectedAt fields, never touching
refreshTokenCiphertext/refreshTokenIv/refreshTokenAuthTag at all -- so
there is no code path here that could ever hold, let alone print, a
refresh token, an authorization code, a client secret, a full client ID,
ciphertext, an IV, or an authentication tag. connectedAccountName (a
business name, not a secret) is read but NOT printed by default, per this
phase's "never print... connected-account names unless explicitly
required" instruction -- pass --show-account-name to opt in.

Usage: python credential_migration_status.py [--show-account-name]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

import google_oauth_clients
import tenant_config_store as tcs
import tenant_keys
import tenant_paths


def _upstash_get(redis_key: str) -> dict | None:
    """Raw GET of one Redis key via the Upstash REST API -- returns the
    parsed JSON record, or None if unset/unreachable/misconfigured. Never
    raises; a per-tenant read failure is reported as 'unknown', not a
    crash of the whole report."""
    url = os.environ.get("UPSTASH_REDIS_REST_URL")
    rest_token = os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    if not url or not rest_token:
        return None
    try:
        req = urllib.request.Request(
            f"{url.rstrip('/')}/get/{urllib.parse.quote(redis_key, safe='')}",
            headers={"Authorization": f"Bearer {rest_token}"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read())
        raw = body.get("result")
        if not raw:
            return None
        return json.loads(raw)
    except Exception:  # noqa: BLE001 -- a read-only diagnostic must never crash on one bad tenant
        return None


def classify_tenant(tenant_id: str, *, show_account_name: bool = False) -> dict:
    redis_key = tenant_keys.resolve_credential_key(tenant_id)
    record = _upstash_get(redis_key)

    row = {"tenant_id": tenant_id, "client_key": "missing", "health": None, "connected_at": None}
    if record is None:
        return row

    raw_client_key = record.get("clientKey")
    if raw_client_key is None:
        row["client_key"] = google_oauth_clients.GOOGLE_OAUTH_CLIENT_KEY_LEGACY
    elif raw_client_key in (google_oauth_clients.GOOGLE_OAUTH_CLIENT_KEY_LEGACY, google_oauth_clients.GOOGLE_OAUTH_CLIENT_KEY_PRYOR):
        row["client_key"] = raw_client_key
    else:
        row["client_key"] = "unknown"  # never printed verbatim -- the raw value itself is never surfaced

    # health/connectedAt are already the same non-sensitive fields
    # credentialStore.js's own getStoredCredential() returns to the
    # dashboard UI today -- safe to report here for the identical reason.
    row["health"] = record.get("health")
    row["connected_at"] = record.get("connectedAt")
    if show_account_name:
        row["connected_account_name"] = record.get("connectedAccountName")
    return row


def enumerate_tenant_ids() -> list[str]:
    """The deduplicated union of both tenant registries -- the same
    pattern activate_review_media_rollout.py established: the static,
    reviewed source-code registry (today, exactly Los Tres Amigos) UNION
    the dynamic Redis-backed tenant_config:v1 registry (every self-service
    tenant). Never relies on either registry alone."""
    ids = set(tenant_paths.list_static_registry_tenant_ids())
    try:
        ids.update(tcs.list_tenant_ids())
    except Exception as e:  # noqa: BLE001 -- report what we can rather than crash entirely
        print(f"::warning::could not enumerate the dynamic tenant registry: {e}", file=sys.stderr)
    return sorted(ids)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--show-account-name", action="store_true",
                         help="Also report connectedAccountName (a business name, not a secret) per tenant.")
    args = parser.parse_args()

    tenant_ids = enumerate_tenant_ids()
    if not tenant_ids:
        print("No tenants found in either registry.")
        return 0

    rows = [classify_tenant(t, show_account_name=args.show_account_name) for t in tenant_ids]

    header = f"{'tenant_id':<40} {'client_key':<14} {'health':<16} connected_at"
    print(header)
    print("-" * len(header))
    for row in rows:
        print(f"{row['tenant_id']:<40} {row['client_key']:<14} {(row['health'] or '-'):<16} {row['connected_at'] or '-'}")
        if args.show_account_name and row.get("connected_account_name"):
            print(f"{'':<40} account: {row['connected_account_name']}")

    counts: dict[str, int] = {}
    for row in rows:
        counts[row["client_key"]] = counts.get(row["client_key"], 0) + 1
    print()
    print("Summary: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
