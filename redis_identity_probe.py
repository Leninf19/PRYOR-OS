"""
Phase 4M incident diagnosis -- proves whether GitHub Actions' Redis
secrets and the live Vercel deployment's Redis point at the SAME Upstash
database, using ONE disposable, throwaway invite-token-shaped record with
no relationship to Blue Seafood & Grill or Los Tres Amigos at all.

Reuses tenant_config_store.py's own low-level Upstash REST helpers
(_upstash_config/_upstash_generic_command) rather than reimplementing the
REST protocol. Reuses tokenStore.js's EXACT key format
(invite:{sha256(raw_token)}, a JSON payload, a TTL) so the probe can be
read back through the real, already-existing, unauthenticated
GET /api/session/invite-status endpoint on live production -- confirmed
byte-identical between whatever is actually deployed (main) and
feature/multi-tenant-pryor, so a mismatch here isolates Redis identity,
never code version.

Makes exactly ONE write (SET, 5-minute TTL as a safety net even if
cleanup somehow fails), one HTTP GET to production, and one cleanup
write (DEL) -- no LTA record, no Blue Seafood record, no Google API call,
no other production data touched. Never prints a secret, the probe's raw
token, or any record contents beyond booleans/status codes.

Usage: python redis_identity_probe.py
"""
import hashlib
import json
import secrets as secrets_module
import sys
import urllib.error
import urllib.request

import tenant_config_store as tcs

PRODUCTION_ORIGIN = "https://pryor-os.vercel.app"
PROBE_TTL_SECONDS = 300
PROBE_USER_ID = f"probe-{secrets_module.token_hex(8)}"
PROBE_EMAIL = "redis-identity-probe@example.invalid"


def main() -> int:
    config = tcs._upstash_config()
    if config is None:
        print("INCONCLUSIVE: UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not configured in this environment.")
        return 0
    url, token = config

    raw_probe_token = secrets_module.token_hex(32)
    token_hash = hashlib.sha256(raw_probe_token.encode("utf-8")).hexdigest()
    redis_key = f"invite:{token_hash}"
    payload = {
        "userId": PROBE_USER_ID, "email": PROBE_EMAIL, "role": "owner", "locationIds": "*",
        "invitedBy": "redis-identity-probe",
    }

    print("=== Redis identity probe (disposable record, unrelated to any real tenant) ===")

    creation_ok = False
    try:
        tcs._upstash_generic_command(url, token, ["SET", redis_key, json.dumps(payload), "EX", str(PROBE_TTL_SECONDS)])
        creation_ok = True
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        print(f"probe creation error: {e}")
    print(f"probe creation: {'succeeded' if creation_ok else 'failed'}")

    if not creation_ok:
        print("\nCLASSIFICATION: INCONCLUSIVE (could not write the probe at all)")
        return 0

    live_status = None
    live_valid = None
    try:
        req = urllib.request.Request(f"{PRODUCTION_ORIGIN}/api/session/invite-status?token={raw_probe_token}")
        with urllib.request.urlopen(req, timeout=15) as resp:
            live_status = resp.status
            body = json.loads(resp.read())
            live_valid = body.get("valid") is True
    except urllib.error.HTTPError as e:
        live_status = e.code
        live_valid = False
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        print(f"live request error: {e}")

    print(f"live HTTP status: {live_status}")
    print(f"live app saw probe: {live_valid}")

    # Cleanup ALWAYS runs, regardless of what the live check returned.
    cleanup_ok = False
    try:
        tcs._upstash_generic_command(url, token, ["DEL", redis_key])
        cleanup_ok = True
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        print(f"cleanup error: {e}")
    print(f"cleanup: {'succeeded' if cleanup_ok else 'failed'}")

    print()
    if live_status is None:
        print("CLASSIFICATION: INCONCLUSIVE (could not reach the live app at all)")
    elif live_valid is True:
        print("CLASSIFICATION: SAME_REDIS")
    elif live_valid is False and live_status == 200:
        print("CLASSIFICATION: DIFFERENT_REDIS")
    else:
        print("CLASSIFICATION: INCONCLUSIVE (unexpected live response shape)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
