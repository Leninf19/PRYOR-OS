// Dual-client Google Business Profile OAuth credential resolution
// (PRYOR OS Google Cloud project migration, Phase 5).
//
// WHY THIS EXISTS: every tenant's stored refresh token was issued by
// whichever OAuth client was active at connect time. Google's OAuth2
// refresh grant REQUIRES the exact same client_id/client_secret that
// issued a token -- using a different (even if otherwise valid) client
// pair fails with invalid_grant/unauthorized_client. Migrating this
// application from the legacy Los Tres Amigos Google Cloud project's
// OAuth client to the new PRYOR OS Production project's own client
// therefore cannot be a single global env-var swap: every credential
// issued before the swap would break instantly. This module is the ONE
// place that decides which client pair a given piece of provenance
// ('legacy-lta' or 'pryor-2026') resolves to -- every Node caller that
// needs to exchange a code or refresh a token goes through here, never
// reading GOOGLE_CLIENT_ID*/GOOGLE_CLIENT_SECRET* directly itself.
//
// Deliberately separate from dashboard/api/_lib/credentialStore.js's own
// LEGACY/CUTOVER "which Redis KEY is authoritative for this tenant"
// migration-mode system -- that is an orthogonal concern (which physical
// record) from this one (which OAuth client issued the token INSIDE
// whichever record). A tenant can be CUTOVER-mode (gbp_credentials:v2)
// while its credential's clientKey is still 'legacy-lta', and vice versa;
// neither system is aware of the other's state.
//
// GBP credentials (GOOGLE_CLIENT_ID*/GOOGLE_CLIENT_SECRET*) are never
// conflated with PRYOR's own separate "Sign in with Google" login client
// (GOOGLE_AUTH_CLIENT_ID/GOOGLE_AUTH_CLIENT_SECRET, see googleAuthClient.js)
// -- this module never reads or references those names.

export const GoogleOAuthClientKey = Object.freeze({
  LEGACY: 'legacy-lta',
  PRYOR: 'pryor-2026',
})

const RECOGNIZED_CLIENT_KEYS = new Set(Object.values(GoogleOAuthClientKey))

// Thrown when a clientKey is present but is not exactly one of the two
// recognized values (blank, malformed, wrong case, or simply unknown).
// NEVER caught and silently downgraded to legacy anywhere in this
// codebase -- an explicit-but-wrong value is a configuration/data
// integrity problem that must fail closed and loud, never be guessed at.
export class UnrecognizedClientKeyError extends Error {
  constructor(rawValueForInternalUseOnly) {
    // The raw value is intentionally NOT included in the message --
    // it may originate from stored data and this error's .message is
    // exactly the kind of string that ends up in a log line. Callers
    // that need to inspect the raw value for their OWN sanitized
    // handling may still read it off this property, but nothing in this
    // module ever logs or displays it.
    super('unrecognized Google OAuth clientKey')
    this.name = 'UnrecognizedClientKeyError'
    Object.defineProperty(this, 'rawValue', { value: rawValueForInternalUseOnly, enumerable: false })
  }
}

// Thrown when a recognized clientKey's required environment variables
// are not (yet) fully configured -- e.g. GOOGLE_CLIENT_ID_PRYOR/SECRET_PRYOR
// not set yet during an early migration stage, or (extremely unlikely)
// neither the suffixed nor bare legacy pair configured at all.
export class GoogleOAuthClientNotConfiguredError extends Error {
  constructor(clientKey) {
    super(`Google OAuth client "${clientKey}" is not configured`)
    this.name = 'GoogleOAuthClientNotConfiguredError'
    this.clientKey = clientKey
  }
}

// --- Legacy compatibility bridge -------------------------------------------
//
// Mandatory bridge (approved Phase 5 correction): dual-client code must be
// safely deployable BEFORE GOOGLE_CLIENT_ID_LEGACY/GOOGLE_CLIENT_SECRET_LEGACY
// exist as Production variables, since introducing them is a separate,
// later configuration step. Resolution rules, in order:
//   1. Both suffixed legacy vars non-empty -> use that pair.
//   2. Both absent -> use the bare GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET
//      (today's only pair) as a temporary fallback.
//   3. Exactly one suffixed var present -> fail closed (never silently
//      complete a pair from the bare fallback -- see rule 5).
//   4. Suffixed pair absent AND bare fallback pair partial/missing -> fail
//      closed.
//   5. NEVER mix one suffixed value with one bare value, in either
//      direction -- each resolution uses ONE complete pair from ONE
//      family only.
//   6. The bare GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET names are NEVER used
//      to resolve a 'pryor-2026' credential, only ever 'legacy-lta'.
//
// TODO(google-oauth-migration-cutover): remove this bridge (rules 1-2, 5-6
// collapse to "always read GOOGLE_CLIENT_ID_LEGACY/SECRET_LEGACY") once
// Production Vercel + GitHub Actions have both been configured with the
// suffixed legacy pair and that configuration has been verified present --
// see the migration's Phase 6/7 configuration order. Do not remove in this
// phase.
function resolveLegacyClientPair() {
  const suffixedId = process.env.GOOGLE_CLIENT_ID_LEGACY
  const suffixedSecret = process.env.GOOGLE_CLIENT_SECRET_LEGACY
  const suffixedIdPresent = Boolean(suffixedId)
  const suffixedSecretPresent = Boolean(suffixedSecret)

  if (suffixedIdPresent && suffixedSecretPresent) {
    return { clientId: suffixedId, clientSecret: suffixedSecret }
  }
  if (suffixedIdPresent !== suffixedSecretPresent) {
    // Exactly one suffixed value present -- rule 3, never complete the
    // pair from the bare fallback (that would be exactly the "mixing"
    // rule 5 forbids).
    return null
  }

  // Neither suffixed var present -- rule 2: try the bare fallback pair.
  const bareId = process.env.GOOGLE_CLIENT_ID
  const bareSecret = process.env.GOOGLE_CLIENT_SECRET
  if (bareId && bareSecret) {
    return { clientId: bareId, clientSecret: bareSecret }
  }
  // Bare pair partial or missing too -- rule 4.
  return null
}

function resolvePryorClientPair() {
  const clientId = process.env.GOOGLE_CLIENT_ID_PRYOR
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET_PRYOR
  if (clientId && clientSecret) return { clientId, clientSecret }
  return null
}

// THE one function every Node caller uses to turn a clientKey (from a
// stored credential record or a verified OAuth state claim) into the
// actual client_id/client_secret to use for a Google token request.
//
// `clientKey` should already have had "absent -> 'legacy-lta'" applied by
// the CALLER (reading a record/state field) before reaching here -- this
// function itself only ever recognizes the two exact enum values; passing
// it anything else (including null/undefined) throws
// UnrecognizedClientKeyError rather than guessing. This split is
// deliberate: "the field was never written" (a legitimate historical
// fact, safe to default) and "the field holds a value nobody recognizes"
// (a data-integrity problem) must never be handled by the same code path.
export function resolveGoogleOAuthClientCredentials(clientKey) {
  if (!RECOGNIZED_CLIENT_KEYS.has(clientKey)) {
    throw new UnrecognizedClientKeyError(clientKey)
  }
  const pair = clientKey === GoogleOAuthClientKey.LEGACY ? resolveLegacyClientPair() : resolvePryorClientPair()
  if (!pair) throw new GoogleOAuthClientNotConfiguredError(clientKey)
  return { clientKey, clientId: pair.clientId, clientSecret: pair.clientSecret }
}

// Coarse "is Google Business Profile integration configured AT ALL in
// this deployment" check -- used only for the pre-existing early
// not_configured short-circuits in status()/testConnection(), which run
// before any specific tenant's credential (and therefore its clientKey)
// is even read. Never throws; a boolean is all these call sites need.
export function hasAnyGoogleOAuthClientConfigured() {
  return Boolean(resolveLegacyClientPair() || resolvePryorClientPair())
}

// --- Authorization feature flag ---------------------------------------------
//
// GOOGLE_GBP_AUTH_CLIENT_KEY -- server-only switch controlling which
// client auth() uses for BRAND-NEW authorization flows. Never read from,
// settable by, or overridable by the browser/request in any way; this
// function takes no arguments and reads only process.env.
//   - unset               -> 'legacy-lta' (today's behavior, unchanged)
//   - 'legacy-lta'        -> 'legacy-lta'
//   - 'pryor-2026'        -> 'pryor-2026'
//   - anything else       -> throws UnrecognizedClientKeyError (fails
//                            closed exactly like a bad stored/state
//                            clientKey -- never silently treated as legacy)
export function resolveAuthClientKeyFromFlag() {
  const raw = process.env.GOOGLE_GBP_AUTH_CLIENT_KEY
  const key = raw == null || raw === '' ? GoogleOAuthClientKey.LEGACY : raw
  if (!RECOGNIZED_CLIENT_KEYS.has(key)) throw new UnrecognizedClientKeyError(key)
  return key
}
