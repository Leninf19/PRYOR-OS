"""
Phase 4M incident diagnosis -- TEMPORARY challenge-response probe proving
whether GitHub Actions' CREDENTIAL_ENCRYPTION_KEY and Vercel production's
CREDENTIAL_ENCRYPTION_KEY are the SAME secret, WITHOUT either value (or
any value derived from decrypting real data) ever being printed,
transmitted in the open, or compared outside of a one-way HMAC.

Protocol:
  1. This script generates a random, non-secret nonce and computes
     HMAC-SHA256(SHA256(this environment's CREDENTIAL_ENCRYPTION_KEY), nonce)
     -- the exact same key derivation credentialStore.js/google_api.py
     already use for AES-256-GCM, so this precisely tests the key actually
     used to encrypt/decrypt, without decrypting anything.
  2. Writes ONLY {nonce, hmacGh} to a short-TTL (<= 5 minute), disposable
     Redis key -- never printed, never touches any tenant's real
     credential record.
  3. Prints only a non-secret request_id and asks a human, authenticated
     platform owner to trigger the matching TEMPORARY Vercel action
     (POST /api/google/verify-encryption-key-challenge) with that
     request_id, from their own already-authenticated session, within a
     few minutes.
  4. The Vercel action atomically consumes (reads AND deletes) the
     challenge -- single-use, so the same request_id can never be
     replayed -- and writes a companion result key.
  5. Polls the SAME Redis for that result key -- {match: true|false} --
     for up to POLL_TIMEOUT_SECONDS.
  6. ALWAYS deletes both the challenge key (defensive -- Vercel should
     have already consumed it) and the result key before exiting,
     regardless of outcome.
  7. Classifies: match True -> SAME_ENCRYPTION_KEY, match False ->
     DIFFERENT_ENCRYPTION_KEY, no result before timeout -> INCONCLUSIVE.

Never prints CREDENTIAL_ENCRYPTION_KEY, the derived key, either HMAC
value, or the nonce.

TEMPORARY -- remove this script (and the matching Vercel action,
dashboard/api/_lib/encryptionKeyChallengeStore.js, and
credentialStore.js's computeEncryptionKeyChallengeHmac export) once the
Phase 4M encryption-key-identity incident is resolved.

Usage: python encryption_key_challenge_probe.py
"""
import hashlib
import hmac as hmac_module
import json
import os
import secrets as secrets_module
import sys
import time

import tenant_config_store as tcs

POLL_INTERVAL_SECONDS = 10
POLL_TIMEOUT_SECONDS = 240
CHALLENGE_TTL_SECONDS = 300


def _challenge_key(request_id: str) -> str:
    return f"credential_key_challenge:{request_id}"


def _result_key(request_id: str) -> str:
    return f"credential_key_challenge_result:{request_id}"


def main() -> int:
    print("=== Encryption key challenge-response probe (temporary, Phase 4M incident diagnosis) ===")

    config = tcs._upstash_config()
    if config is None:
        print("INCONCLUSIVE: UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not configured in this environment.")
        return 0
    url, token = config

    encryption_key = os.environ.get("CREDENTIAL_ENCRYPTION_KEY")
    if not encryption_key:
        print("INCONCLUSIVE: CREDENTIAL_ENCRYPTION_KEY not configured in this environment.")
        return 0

    request_id = secrets_module.token_hex(16)
    nonce = secrets_module.token_hex(32)
    derived_key = hashlib.sha256(encryption_key.encode("utf-8")).digest()
    hmac_gh = hmac_module.new(derived_key, bytes.fromhex(nonce), hashlib.sha256).hexdigest()

    print(f"request_id: {request_id}")

    try:
        tcs._upstash_generic_command(url, token, [
            "SET", _challenge_key(request_id), json.dumps({"nonce": nonce, "hmacGh": hmac_gh}),
            "EX", str(CHALLENGE_TTL_SECONDS),
        ])
    except Exception as e:  # noqa: BLE001
        print(f"challenge write: failed ({type(e).__name__})")
        print("\nCLASSIFICATION: INCONCLUSIVE (could not write the challenge)")
        return 0

    print("challenge write: succeeded")
    print(
        f"\nACTION REQUIRED: as an authenticated platform owner, call "
        f'POST /api/google/verify-encryption-key-challenge with body {{"requestId": "{request_id}"}} '
        f"within {POLL_TIMEOUT_SECONDS} seconds."
    )

    match = None
    deadline = time.monotonic() + POLL_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            result = tcs._upstash_path_command(url, token, ["get", _result_key(request_id)])
        except Exception:  # noqa: BLE001 -- a transient read failure just means "keep polling"
            result = None
        raw = result.get("result") if isinstance(result, dict) else None
        if raw:
            try:
                parsed_match = json.loads(raw).get("match")
            except Exception:  # noqa: BLE001
                parsed_match = None
            if isinstance(parsed_match, bool):
                match = parsed_match
                break
        time.sleep(POLL_INTERVAL_SECONDS)

    # Cleanup ALWAYS runs, regardless of outcome -- same discipline as
    # redis_identity_probe.py's own disposable-record cleanup.
    cleanup_ok = True
    for key in (_challenge_key(request_id), _result_key(request_id)):
        try:
            tcs._upstash_generic_command(url, token, ["DEL", key])
        except Exception:  # noqa: BLE001
            cleanup_ok = False
    print(f"cleanup: {'succeeded' if cleanup_ok else 'failed'}")

    print()
    if isinstance(match, bool):
        print(f"CLASSIFICATION: {'SAME_ENCRYPTION_KEY' if match else 'DIFFERENT_ENCRYPTION_KEY'}")
    else:
        print("CLASSIFICATION: INCONCLUSIVE (timed out waiting for the Vercel-side check -- the operator may not have triggered it in time)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
