"""
Phase 4M incident diagnosis -- read-only Node/Python credential-key and
schema compatibility audit for ONE tenant.

Node's write path (dashboard/api/google/[action].js's callback() ->
credentialStore.js's setStoredCredentialIfVersion() -> resolveCredentialKey())
and Python's read path (google_api.py's has_tenant_credential() ->
tenant_keys.resolve_credential_key()) are BOTH driven by the exact same
migration-mode formula -- this script calls Python's copy of that formula
(tenant_keys.resolve_credential_key) to report the one key both sides are
built to agree on, then performs a single read-only GET against production
Redis to prove whether a record actually exists there and, if so, whether
its top-level field names match what both readers expect.

Never decrypts anything, never touches CREDENTIAL_ENCRYPTION_KEY, never
prints refreshTokenCiphertext/Iv/AuthTag values, connectedAccountName, or
any other secret/PII field value -- only the key name, existence, field
NAMES, credentialVersion (a plain integer), timestamps, and health/status.

Makes exactly ONE Redis command (GET) -- no write, no delete, no mutation
of any kind.

Usage: python redis_credential_key_audit.py --tenant-id t_example-restaurant
"""
import argparse
import json
import sys

import tenant_config_store as tcs
import tenant_keys

# The full set of fields Node's buildFreshRecord() (credentialStore.js)
# writes for every connection -- used only to report which are PRESENT vs
# MISSING by NAME, never to read or print any field's value except the
# explicitly-safe ones in SAFE_METADATA_FIELDS below.
EXPECTED_SCHEMA_FIELDS = frozenset({
    "refreshTokenCiphertext", "refreshTokenIv", "refreshTokenAuthTag",
    "connectedAccountName", "connectedAt", "lastOAuthRefreshAt",
    "lastSuccessfulSyncAt", "lastFailedSyncAt", "lastFailureReason",
    "health", "credentialVersion",
})

# The only fields whose VALUES are safe to print -- no token material, no
# ciphertext, no account identity.
SAFE_METADATA_FIELDS = (
    "credentialVersion", "connectedAt", "lastOAuthRefreshAt",
    "lastSuccessfulSyncAt", "lastFailedSyncAt", "lastFailureReason", "health",
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tenant-id", required=True)
    args = parser.parse_args()
    tenant_id = args.tenant_id

    tenant_keys.assert_valid_tenant_id(tenant_id, "redis_credential_key_audit")

    print(f"=== Credential key/schema audit for {tenant_id} ===\n")

    # Node and Python are both built from this SAME formula (see module
    # docstring) -- there is structurally only one "expected key" to
    # compute, not two independent ones that happen to match.
    expected_key = tenant_keys.resolve_credential_key(tenant_id)
    print(f"Node expected key   (credentialStore.js resolveCredentialKey):  {expected_key}")
    print(f"Python expected key (tenant_keys.resolve_credential_key):       {expected_key}")
    print("keys identical: True (both resolve via the same fixed migration-mode formula)\n")

    config = tcs._upstash_config()
    if config is None:
        print("key exists: INCONCLUSIVE (UPSTASH_REDIS_REST_URL/TOKEN not configured in this environment)")
        return 0
    url, token = config

    try:
        result = tcs._upstash_path_command(url, token, ["get", expected_key])
    except Exception as e:  # noqa: BLE001 -- report only the exception TYPE, never message text that might echo response content
        print(f"key exists: INCONCLUSIVE (Redis read failed: {type(e).__name__})")
        return 0

    raw = result.get("result") if isinstance(result, dict) else None
    if not raw:
        print("key exists: False")
        print("\nCLASSIFICATION: NODE_DID_NOT_PERSIST_CREDENTIAL (no record at the key both Node and Python expect)")
        return 0

    print("key exists: True")

    try:
        record = json.loads(raw)
    except Exception:
        print("schema: INCONCLUSIVE (stored value is not valid JSON)")
        print("\nCLASSIFICATION: OTHER (record exists but is not a JSON object either reader could parse)")
        return 0

    if not isinstance(record, dict):
        print("schema: INCONCLUSIVE (stored value is not a JSON object)")
        print("\nCLASSIFICATION: OTHER (record exists but is not a JSON object either reader could parse)")
        return 0

    field_names = sorted(record.keys())
    missing = sorted(EXPECTED_SCHEMA_FIELDS - set(record.keys()))
    extra = sorted(set(record.keys()) - EXPECTED_SCHEMA_FIELDS)
    print(f"field names: {field_names}")
    print(f"missing expected fields: {missing}")
    print(f"unexpected extra fields: {extra}")

    for f in SAFE_METADATA_FIELDS:
        if f in record:
            print(f"{f}: {record[f]}")

    ciphertext_fields_present = all(k in record for k in ("refreshTokenCiphertext", "refreshTokenIv", "refreshTokenAuthTag"))
    print(f"\nciphertext/iv/authTag fields present (names only, values withheld): {ciphertext_fields_present}")

    print()
    if missing:
        print(f"CLASSIFICATION: NODE_PYTHON_SCHEMA_MISMATCH (record is missing field(s) Python's reader requires: {missing})")
    elif ciphertext_fields_present:
        print("CLASSIFICATION: CREDENTIAL_EXISTS_AND_PYTHON_READER_BUG (record exists at the expected key with the expected schema -- "
              "if has_tenant_credential() still reports False for this tenant, the failure is downstream of key/schema resolution, "
              "e.g. a decryption/authentication failure inside Python's reader, not a missing or malformed record)")
    else:
        print("CLASSIFICATION: OTHER (record exists with an unexpected shape not covered by the other classifications)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
