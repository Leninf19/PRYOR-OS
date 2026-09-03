// TEMPORARY -- Phase 4N Google-OAuth-client-identity incident: one-time
// synchronization mechanism, same security model as Phase 4M's
// encryptionKeySealer.js. Delete this file (and its one call site in
// google/[action].js, and the libsodium-wrappers dependency, once
// re-added only if nothing else in the codebase still needs it) once the
// GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET mismatch between GitHub Actions
// and Vercel production is confirmed resolved.
//
// Seals THIS environment's live process.env.GOOGLE_CLIENT_ID and
// process.env.GOOGLE_CLIENT_SECRET (the raw values, independently) for a
// HARDCODED, repository-pinned GitHub Actions public key using
// libsodium's crypto_box_seal -- the exact construction GitHub's own API
// documents for encrypting secrets (X25519 + XSalsa20-Poly1305). Only
// the two sealed ciphertexts ever leave this function; nobody but
// GitHub's own private key (which GitHub alone holds, server-side, and
// never exposes to anyone) can decrypt either one.
//
// SECURITY-CRITICAL: the public key and key_id below are PINNED, not
// accepted from any caller/request -- identical values to Phase 4M's
// encryptionKeySealer.js, re-confirmed via
// `gh api repos/Leninf19/PRYOR-OS/actions/secrets/public-key` immediately
// before this file was written. A caller-supplied public key would turn
// this into a generic secret-export oracle. Changing which repository
// this can seal for requires a new reviewed commit, never a runtime
// input.
import sodium from 'libsodium-wrappers'

const PINNED_GITHUB_REPO = 'Leninf19/PRYOR-OS'
const PINNED_PUBLIC_KEY_BASE64 = 'z9acw6L63di39ElcWeJ2gvyt+/3H25wEpv3YqFDljRI='
const PINNED_KEY_ID = '3380204578043523366'

export class OAuthClientSealerUnavailableError extends Error {}
export class OAuthClientNotConfiguredError extends Error {}

async function sealOne(rawValue) {
  await sodium.ready
  const messageBytes = sodium.from_string(rawValue)
  const publicKeyBytes = sodium.from_base64(PINNED_PUBLIC_KEY_BASE64, sodium.base64_variants.ORIGINAL)
  const sealedBytes = sodium.crypto_box_seal(messageBytes, publicKeyBytes)
  return sodium.to_base64(sealedBytes, sodium.base64_variants.ORIGINAL)
}

// Never accepts any argument -- see the header comment above. Returns
// { googleClientIdSealedBase64, googleClientSecretSealedBase64, keyId,
// repo } -- keyId and repo are the same fixed constants every call
// returns; the two sealed fields are the only values that vary per call,
// and both are ciphertext.
export async function sealGoogleOAuthClientForPinnedGitHubRepo() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new OAuthClientNotConfiguredError('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not both configured in this environment')
  }

  let googleClientIdSealedBase64, googleClientSecretSealedBase64
  try {
    googleClientIdSealedBase64 = await sealOne(clientId)
    googleClientSecretSealedBase64 = await sealOne(clientSecret)
  } catch (err) {
    // Deliberately does NOT interpolate `err.message` verbatim in case a
    // future libsodium version's error text ever echoed input -- reports
    // only the error TYPE, never anything derived from either value.
    throw new OAuthClientSealerUnavailableError(`sealing failed: ${err?.constructor?.name || 'UnknownError'}`)
  }

  return {
    googleClientIdSealedBase64,
    googleClientSecretSealedBase64,
    keyId: PINNED_KEY_ID,
    repo: PINNED_GITHUB_REPO,
  }
}
