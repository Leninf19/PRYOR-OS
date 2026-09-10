"""
Phase 4M incident diagnosis -- READ-ONLY. Reproduces exactly what
dashboard/api/google/[action].js's status() action does for one tenant,
using the real, already-tested google_api.py functions (never
reimplemented): has_tenant_credential(), list_accounts(),
list_locations(). Exists so CREDENTIAL_ENCRYPTION_KEY/GOOGLE_CLIENT_SECRET
(both Vercel Sensitive variables, unobtainable via env pull) can be used
via the existing GitHub Actions secret store instead, through the same
trusted tenant-lifecycle.yml dispatch boundary every other tenant
operation already goes through -- same tenant_id/confirmation validation,
same per-tenant concurrency group.

Makes NO writes of any kind: no Redis write, no credential mutation, no
Blob access, no reconnect (uses the ALREADY-STORED refresh token via a
normal token refresh inside get_access_token() -- never re-runs the OAuth
authorization/consent flow), no provisioning, no Initial Sync.

Prints ONLY: whether a credential exists, HTTP status codes, Google's own
error message text (diagnostic, not secret), and counts. NEVER prints an
access token, refresh token, GOOGLE_CLIENT_SECRET, or
CREDENTIAL_ENCRYPTION_KEY -- confirmed by inspecting google_api.py's own
exception messages, which are built only from Google's response body
content, never from request headers/credentials.

Usage: python diagnose_google_status.py --tenant-id t_blue-seafood-grill
"""
import argparse
import sys

import google_api as ga


def classify_error(exc_type: str, status, message: str, context: str = "accounts") -> None:
    text = (message or "").lower()
    if exc_type == "GBPRateLimitError" or status == 429 or "resource_exhausted" in text:
        print(f"\nCLASSIFICATION: API_NOT_ENABLED or QUOTA/RATE_LIMIT (429/RESOURCE_EXHAUSTED on {context})")
        print("  - If the message says the API/service is disabled or has never been used for this project")
        print('    ("has not been used in project" / "SERVICE_DISABLED"), classify API_NOT_ENABLED --')
        print("    the Business Profile APIs require an explicit Google-side access grant beyond just")
        print("    enabling them in Cloud Console (see credentialStore.js's header comment referencing")
        print("    a prior real incident with this exact symptom, project 786038057684).")
        print("  - If it instead describes exceeding a numeric per-day/per-100s quota that WAS previously")
        print("    working, classify QUOTA/RATE_LIMIT instead (genuine usage-based throttling).")
    elif exc_type == "GBPPermissionError" or status == 403:
        print(f"\nCLASSIFICATION: INSUFFICIENT_GOOGLE_PERMISSION (403 on {context})")
    elif exc_type == "GBPAuthError" or status == 401:
        print(f"\nCLASSIFICATION: TOKEN/CREDENTIAL_ERROR (401/auth failure on {context})")
    elif exc_type == "GBPNotFoundError" or status == 404:
        print(f"\nCLASSIFICATION: OTHER (404 on {context} -- unexpected for a list call)")
    else:
        print(f"\nCLASSIFICATION: OTHER (unrecognized error shape on {context})")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tenant-id", required=True)
    args = parser.parse_args()
    tenant_id = args.tenant_id

    print(f"=== Google status diagnosis for {tenant_id} ===")

    print("\n--- 1. Credential existence (Redis-backed store) ---")
    has_cred = ga.has_tenant_credential(tenant_id)
    print(f"has_tenant_credential: {has_cred}")
    if not has_cred:
        print("\nCLASSIFICATION: TOKEN/CREDENTIAL_ERROR (no credential stored for this tenant)")
        return 0

    print("\n--- 2. List accounts (first live Google API call after OAuth) ---")
    try:
        accounts = ga.list_accounts(tenant_id)
    except ga.GBPError as e:
        status = getattr(e, "status", None)
        message = str(e)
        print(f"Exception type: {type(e).__name__}")
        print(f"HTTP status: {status}")
        print(f"Message (Google's own error text, safe to display): {message}")
        classify_error(type(e).__name__, status, message, context="accounts")
        return 0

    print(f"accounts returned: {len(accounts)}")
    if not accounts:
        print("\nCLASSIFICATION: NO_GBP_ACCOUNT (list-accounts succeeded but returned zero accounts)")
        return 0

    print("\n--- 3. List locations for the first account ---")
    first_account_name = accounts[0].get("name")
    try:
        locations = ga.list_locations(tenant_id, first_account_name)
    except ga.GBPError as e:
        status = getattr(e, "status", None)
        message = str(e)
        print(f"Exception type: {type(e).__name__}")
        print(f"HTTP status: {status}")
        print(f"Message (Google's own error text, safe to display): {message}")
        classify_error(type(e).__name__, status, message, context="locations")
        return 0

    print(f"locations returned: {len(locations)}")
    if not locations:
        print("\nCLASSIFICATION: NO_LOCATIONS (accounts and locations both listable, zero locations on this account)")
    else:
        print("\nCLASSIFICATION: none -- accounts AND locations both listed successfully just now.")
        print("If the dashboard recently showed quota_blocked, this may indicate the underlying condition")
        print("was TRANSIENT (already resolved) or intermittent -- worth re-checking the dashboard's")
        print("current state rather than assuming a code error without further evidence.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
