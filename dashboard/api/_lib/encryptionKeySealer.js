// TEMPORARY -- Phase 4M encryption-key-identity incident: one-time
// synchronization mechanism. Delete this file (and its one call site in
// google/[action].js, and the libsodium-wrappers dependency) once the
// CREDENTIAL_ENCRYPTION_KEY mismatch between GitHub Actions and Vercel
// production is confirmed resolved.
//
// Seals THIS environment's live process.env.CREDENTIAL_ENCRYPTION_KEY
// (the raw secret value, not a derived key) for a HARDCODED,
// repository-pinned GitHub Actions public key using libsodium's
// crypto_box_seal -- the exact construction GitHub's own API documents
// for encrypting secrets (X25519 + XSalsa20-Poly1305). Only the sealed
// ciphertext ever leaves this function; nobody but GitHub's own private
// key (which GitHub alone holds, server-side, and never exposes to
// anyone) can decrypt it -- structurally the same guarantee `gh secret
// set` itself relies on when it seals a secret client-side before
// sending it to GitHub's API.
//
// SECURITY-CRITICAL: the public key and key_id below are PINNED, not
// accepted from any caller/request. A caller-supplied public key would
// turn this into a generic secret-export oracle -- a compromised
// authenticated platform-owner session could supply its own key and
// receive CREDENTIAL_ENCRYPTION_KEY sealed to a key it controls. Both
// values were fetched via `gh api repos/Leninf19/PRYOR-OS/actions/secrets/public-key`
// (a public, non-secret GitHub API read) and hardcoded here as a
// reviewed, auditable source-code change -- exactly like every other
// fixed trust anchor in this codebase (PINNED_LIFECYCLE_SHA,
// CREDENTIAL_MIGRATION_MODE). Changing which repository this can seal
// for requires a new reviewed commit, never a runtime input.
import sodium from 'libsodium-wrappers'

const PINNED_GITHUB_REPO = 'Leninf19/PRYOR-OS'
const PINNED_PUBLIC_KEY_BASE64 = 'z9acw6L63di39ElcWeJ2gvyt+/3H25wEpv3YqFDljRI='
const PINNED_KEY_ID = '3380204578043523366'

export class EncryptionKeySealerUnavailableError extends Error {}
export class EncryptionKeyNotConfiguredError extends Error {}

// Never accepts a public key or key_id argument -- see the header
// comment above. Returns { sealedValueBase64, keyId, repo } -- keyId and
// repo are the same fixed constants every call returns, included only so
// the caller's response shape is self-describing; sealedValueBase64 is
// the only value that varies per call, and it is ciphertext.
export async function sealCredentialEncryptionKeyForPinnedGitHubRepo() {
  const rawKey = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!rawKey) {
    throw new EncryptionKeyNotConfiguredError('CREDENTIAL_ENCRYPTION_KEY is not configured in this environment')
  }

  let sealedBytes
  try {
    await sodium.ready
    const messageBytes = sodium.from_string(rawKey)
    const publicKeyBytes = sodium.from_base64(PINNED_PUBLIC_KEY_BASE64, sodium.base64_variants.ORIGINAL)
    sealedBytes = sodium.crypto_box_seal(messageBytes, publicKeyBytes)
  } catch (err) {
    // Deliberately does NOT interpolate `err.message` verbatim in case a
    // future libsodium version's error text ever echoed input -- reports
    // only the error TYPE, never anything derived from rawKey.
    throw new EncryptionKeySealerUnavailableError(`sealing failed: ${err?.constructor?.name || 'UnknownError'}`)
  }

  return {
    sealedValueBase64: sodium.to_base64(sealedBytes, sodium.base64_variants.ORIGINAL),
    keyId: PINNED_KEY_ID,
    repo: PINNED_GITHUB_REPO,
  }
}
