"""
Phase 4M incident diagnosis -- TEMPORARY challenge-response probe proving
whether GitHub Actions' CREDENTIAL_ENCRYPTION_KEY and Vercel production's
CREDENTIAL_ENCRYPTION_KEY are the SAME secret, WITHOUT either value (or
any value derived from decrypting real data) ever being printed,
transmitted in the open, or compared outside of a one-way HMAC.

Split into two subcommands (`create` / `poll`) so the dispatcher workflow
can surface the non-secret request_id via a GitHub Actions artifact
BETWEEN them -- artifacts become downloadable as soon as the uploading
step completes, well before the job finishes, unlike this same script's
own stdout (GitHub's live log streaming was found, in practice, to lag
well behind a human's ability to act on a short-lived challenge).

Protocol:
  1. `create`: generates a random, non-secret request_id and nonce, and
     computes HMAC-SHA256(SHA256(this environment's
     CREDENTIAL_ENCRYPTION_KEY), nonce) -- the exact same key derivation
     credentialStore.js/google_api.py already use for AES-256-GCM, so this
     precisely tests the key actually used to encrypt/decrypt, without
     decrypting anything. Writes ONLY {nonce, hmacGh} to a short-TTL
     (CHALLENGE_TTL_SECONDS, default 300s / 5 minutes), disposable Redis
     key -- never printed, never touches any tenant's real credential
     record. Writes ONLY the request_id (or the literal sentinel "NONE" if
     nothing could be created) to --out, for the workflow to upload as a
     tiny artifact.
  2. A human, authenticated platform owner reads that request_id from the
     artifact and calls the matching TEMPORARY Vercel action
     (POST /api/google/verify-encryption-key-challenge) with it, from
     their own already-authenticated session.
  3. The Vercel action atomically consumes (reads AND deletes) the
     challenge -- single-use, so the same request_id can never be
     replayed -- and writes a companion result key.
  4. `poll`: reads the request_id back from --request-id-file, polls the
     SAME Redis for that result key -- {match: true|false} -- for up to
     POLL_TIMEOUT_SECONDS (default 240s), starting immediately after
     `create` (so the total elapsed time from challenge creation to the
     end of polling stays safely under CHALLENGE_TTL_SECONDS). ALWAYS
     deletes both the challenge key (defensive -- Vercel should have
     already consumed it) and the result key before exiting, regardless
     of outcome. Never needs CREDENTIAL_ENCRYPTION_KEY at all.
  5. Classifies: match True -> SAME_ENCRYPTION_KEY, match False ->
     DIFFERENT_ENCRYPTION_KEY, no result before timeout (or no challenge
     was ever created) -> INCONCLUSIVE.

Never prints or writes to any file CREDENTIAL_ENCRYPTION_KEY, the derived
key, either HMAC value, or the nonce -- only the request_id ever leaves
this process via --out.

TEMPORARY -- remove this script (and the matching Vercel action,
dashboard/api/_lib/encryptionKeyChallengeStore.js, and
credentialStore.js's computeEncryptionKeyChallengeHmac export) once the
Phase 4M encryption-key-identity incident is resolved.

Usage:
  python encryption_key_challenge_probe.py create --out request_id.txt
  python encryption_key_challenge_probe.py poll --request-id-file request_id.txt
"""
import argparse
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

NO_CHALLENGE_SENTINEL = "NONE"


def _challenge_key(request_id: str) -> str:
    return f"credential_key_challenge:{request_id}"


def _result_key(request_id: str) -> str:
    return f"credential_key_challenge_result:{request_id}"


def create(out_path: str) -> int:
    print("=== Encryption key challenge-response probe: create (temporary, Phase 4M incident diagnosis) ===")

    def write_sentinel():
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(NO_CHALLENGE_SENTINEL)

    config = tcs._upstash_config()
    if config is None:
        print("INCONCLUSIVE: UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not configured in this environment.")
        write_sentinel()
        return 0
    url, token = config

    encryption_key = os.environ.get("CREDENTIAL_ENCRYPTION_KEY")
    if not encryption_key:
        print("INCONCLUSIVE: CREDENTIAL_ENCRYPTION_KEY not configured in this environment.")
        write_sentinel()
        return 0

    request_id = secrets_module.token_hex(16)
    nonce = secrets_module.token_hex(32)
    derived_key = hashlib.sha256(encryption_key.encode("utf-8")).digest()
    hmac_gh = hmac_module.new(derived_key, bytes.fromhex(nonce), hashlib.sha256).hexdigest()

    try:
        tcs._upstash_generic_command(url, token, [
            "SET", _challenge_key(request_id), json.dumps({"nonce": nonce, "hmacGh": hmac_gh}),
            "EX", str(CHALLENGE_TTL_SECONDS),
        ])
    except Exception as e:  # noqa: BLE001
        print(f"challenge write: failed ({type(e).__name__})")
        write_sentinel()
        return 0

    print("challenge write: succeeded")
    print(f"request_id: {request_id}")
    print(
        f"\nACTION REQUIRED: as an authenticated platform owner, call "
        f'POST /api/google/verify-encryption-key-challenge with body {{"requestId": "{request_id}"}} '
        f"within {CHALLENGE_TTL_SECONDS} seconds (the challenge's own Redis TTL)."
    )

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(request_id)
    return 0


def poll(request_id_file: str) -> int:
    print("=== Encryption key challenge-response probe: poll (temporary, Phase 4M incident diagnosis) ===")

    with open(request_id_file, "r", encoding="utf-8") as f:
        request_id = f.read().strip()

    if not request_id or request_id == NO_CHALLENGE_SENTINEL:
        print("CLASSIFICATION: INCONCLUSIVE (no challenge was created -- see the create step's own output)")
        return 0

    config = tcs._upstash_config()
    if config is None:
        print("INCONCLUSIVE: UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not configured in this environment.")
        return 0
    url, token = config

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


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="mode", required=True)

    create_parser = sub.add_parser("create")
    create_parser.add_argument("--out", required=True, help="path to write the non-secret request_id (or the NONE sentinel) to")

    poll_parser = sub.add_parser("poll")
    poll_parser.add_argument("--request-id-file", required=True, help="path previously written by `create --out`")

    args = parser.parse_args()
    if args.mode == "create":
        return create(args.out)
    return poll(args.request_id_file)


if __name__ == "__main__":
    sys.exit(main())
