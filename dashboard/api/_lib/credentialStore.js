// The Google Business Profile OAuth credential store (Phase 8, Milestone
// 8.7) -- replaces the Vercel-env-var-plus-redeploy flow
// (google/_lib/vercel.js's upsertEnvVar/triggerRedeploy) as the LIVE
// storage path for the refresh token. Reconnecting from the dashboard now
// writes here directly; the very next request reads it -- no redeploy, no
// ~60s propagation window, no visible entry in Vercel's deployment history
// for a routine credential rotation.
//
// Multi-Tenant Phase 4A: every public function below REQUIRES an explicit,
// validated tenantId. There is exactly one Google connection per TENANT
// now, not one for the whole application.
//
// Multi-Tenant Phase 4C -- CRITICAL COMPATIBILITY FIX, read this before
// touching this file: Phase 4A made this module always read/write
// gbp_credentials:v2:{tenantId} for every tenant, with zero exception for
// Los Tres Amigos -- deliberately, per Phase 4A's "prefer no automatic
// runtime fallback" instruction. The Phase 4C audit found this created an
// immediate, severe split-brain the moment this code would ship: the
// Python background pipeline (google_api.py, gbp_reply_bridge_reconcile.py
// -- run by update-reviews.yml/critical-alert-check.yml) has ALWAYS read
// gbp_credentials:v1 directly and was untouched by Phase 4A, so it would
// keep working off the real, existing v1 credential -- while this Node
// module would report "never_connected" for Los Tres Amigos (nothing
// exists at v2 yet) and every dashboard feature that depends on it
// (status, Connect, publish/reply) would break, DESPITE the background
// sync/reconcile pipeline still running fine. Two credential systems
// silently active and disagreeing about the same tenant.
//
// THE FIX: the exact same LEGACY/CUTOVER migration-mode system Phase 2's
// tenantDualRead.js already established for the other 9 tenant-scoped
// stores, applied here for the first time. A tenant's authoritative
// credential key is a FIXED, explicit, code-reviewed setting
// (CREDENTIAL_MIGRATION_MODE below) -- NEVER decided by whether v1 or v2
// happens to exist or be populated at runtime (this is what makes it "not
// an automatic runtime fallback": the mode is chosen by this file's own
// source code, once, reviewed, not re-evaluated per-request against
// Redis content). Los Tres Amigos is pinned to LEGACY: for that ONE
// tenant, gbp_credentials:v1 is authoritative for BOTH reads and writes,
// mirroring google_api.py's Python-side tenant_keys.py exactly, so Node
// and Python agree on the same key and neither silently diverges from the
// other. Every other tenant (none exist yet) defaults to CUTOVER: its own
// gbp_credentials:v2:{tenantId}, with v1 never even consulted -- "do not
// use the legacy credential as a fallback for arbitrary tenants" remains
// fully intact, because CUTOVER-mode resolution never looks at v1Key at
// all, for any reason.
//
// This is NOT "silently assigning the legacy credential to Los Tres
// Amigos" -- it is the opposite: an explicit, visible, single-source-of-
// truth code decision (this map), restoring the EXACT pre-Phase-4A
// production behavior for the one tenant that already depends on it,
// exactly as Phase 1/2 already did for the other 9 stores. A future,
// separately reviewed cutover (once a real, controlled OAuth reconnect
// establishes a v2 credential and the Python pipeline is updated to use
// it) is a single-line change to CREDENTIAL_MIGRATION_MODE below -- see
// the Phase 4C report's migration procedure for the exact steps.
//
// Single Redis key per tenant, each holding one JSON blob (not a hash --
// there is exactly one Google connection per tenant, not a per-id
// collection like actionStore.js/contactStore.js). The refresh token
// itself is encrypted at rest with AES-256-GCM (Node's built-in crypto, no
// new dependency) under CREDENTIAL_ENCRYPTION_KEY -- one securely managed
// key encrypts every tenant's credential record; Phase 4A does not
// introduce a per-tenant encryption key. Reading Upstash alone (e.g. from
// the Upstash console) is not sufficient to recover any tenant's token
// without also holding this key.
//
// Node-only, same as actionStore.js/contactStore.js.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto'
import { Redis } from '@upstash/redis'
import { credentialKeyV2 } from './tenantKeys.js'
import { isValidTenantId, DEFAULT_TENANT_ID } from './tenants.js'

// The legacy, single GLOBAL key production holds real data under --
// authoritative ONLY for a tenant explicitly pinned to LEGACY mode below
// (Los Tres Amigos, today). Never referenced outside resolveCredentialKey().
const CREDENTIAL_KEY = 'gbp_credentials:v1'

function assertValidTenantId(tenantId, fnName) {
  if (!isValidTenantId(tenantId)) {
    throw new TypeError(`${fnName}: invalid tenantId ${JSON.stringify(tenantId)}`)
  }
}

// --- Migration mode (Multi-Tenant Phase 4C) -------------------------------
// Mirrors dashboard/api/_lib/tenantDualRead.js's TenantMigrationMode
// exactly (see this file's header comment for why credentials needed
// their own copy rather than routing through that shared module directly
// -- tenantDualRead.js's resolvers are shaped for the OTHER 9 stores'
// v1-vs-v2 key PAIRS; a single-record-per-tenant store with a differently-
// named legacy key benefits from its own small, equally-hardened version
// rather than overloading that module's existing contract). Also mirrored
// in this repo's Python pipeline as tenant_keys.py's
// get_credential_migration_mode()/resolve_credential_key() -- the two
// must stay in agreement for Los Tres Amigos, which is exactly the
// critical compatibility fix this phase makes.
export const CredentialMigrationMode = Object.freeze({
  LEGACY: 'legacy',
  CUTOVER: 'cutover',
})

// Single source of truth for every tenant's CREDENTIAL migration mode. A
// plain object literal, not derived from any env var/request/runtime
// state -- changing a tenant's mode is a reviewed source change, exactly
// like tenantDualRead.js's own TENANT_MIGRATION_MODE map. Los Tres Amigos
// stays LEGACY (gbp_credentials:v1 authoritative) until a separately
// reviewed cutover -- see the Phase 4C report's migration procedure.
//
// TODO(multi-tenant-cutover): LEGACY mode exists ONLY as a transitional
// bridge for Los Tres Amigos's controlled migration off the pre-Phase-4A
// single global credential -- it is not a general "grandfather this
// tenant" mechanism and must not be extended to any other tenant. Once
// migrate-tenant-backfill.js has copied gbp_credentials:v1 to
// gbp_credentials:v2:t_los-tres-amigos, the Python pipeline's matching
// tenant_keys.py entry has been flipped in the same reviewed change, and a
// controlled OAuth reconnect has confirmed v2 is live, remove this entry
// (and the one in tenant_keys.py) so every tenant is CUTOVER-only and this
// LEGACY branch can be deleted entirely.
const CREDENTIAL_MIGRATION_MODE = Object.freeze({
  [DEFAULT_TENANT_ID]: CredentialMigrationMode.LEGACY,
})

// Any tenantId not explicitly listed defaults to CUTOVER -- a new tenant
// (none onboarded yet) has no legacy credential to be compatible with, so
// it is v2-only from the moment it exists, with legacy fallback
// structurally impossible (resolveCredentialKey() never even evaluates
// CREDENTIAL_KEY in this branch).
export function getCredentialMigrationMode(tenantId) {
  assertValidTenantId(tenantId, 'getCredentialMigrationMode')
  return CREDENTIAL_MIGRATION_MODE[tenantId] ?? CredentialMigrationMode.CUTOVER
}

// THE one function that decides which physical key is authoritative for a
// tenant's Google credential -- synchronous, side-effect-free, and never
// consults Redis to decide (authority is a property of the tenant's
// migration mode alone). Every read AND write below calls this exact
// function, which is what makes it structurally impossible for a read to
// resolve one key while a write resolves another (the split-brain
// tenantDualRead.js's own hardening pass eliminated for the other 9
// stores, applied here for the first time).
function resolveCredentialKey(tenantId) {
  assertValidTenantId(tenantId, 'resolveCredentialKey')
  return getCredentialMigrationMode(tenantId) === CredentialMigrationMode.LEGACY
    ? CREDENTIAL_KEY
    : credentialKeyV2(tenantId)
}

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class CredentialStoreUnavailableError extends Error {}

function hasUpstashConfig() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

function getClient() {
  if (testClientFactory) return testClientFactory()
  if (!hasUpstashConfig()) return null
  if (!redisClient) {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
  return redisClient
}

// --- Encryption --------------------------------------------------------
// CREDENTIAL_ENCRYPTION_KEY can be any sufficiently-random string (same UX
// as SESSION_SIGNING_SECRET -- e.g.
// `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`)
// -- SHA-256 derives a proper 32-byte AES-256 key from it regardless of the
// raw string's length/encoding, so the operator never has to hand-format a
// key themselves.

export class CredentialEncryptionKeyMissingError extends Error {}

function getEncryptionKey() {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!raw) throw new CredentialEncryptionKeyMissingError('CREDENTIAL_ENCRYPTION_KEY is not configured')
  return createHash('sha256').update(raw).digest()
}

function encrypt(plaintext) {
  const iv = randomBytes(12) // AES-GCM's standard 96-bit IV
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  }
}

function decrypt({ ciphertext, iv, authTag }) {
  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(authTag, 'base64'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()])
  return plaintext.toString('utf8')
}

// --- Health state enum ---------------------------------------------------
// Six states the Settings -> Google Business Profile page requires.
// 'auth_failed' covers any non-token-specific, non-quota failure (a
// generic 401/403/network/API error) -- token_expired/token_revoked are
// reserved for what Google's own error text actually distinguishes (it
// does not cleanly separate the two at the error-CODE level -- both
// surface as `invalid_grant`, so the distinction is drawn from the
// human-readable error_description text Google returns, e.g. this
// project's own real production error: "Token has been expired or
// revoked"). 'quota_blocked' is a DELIBERATELY separate state from
// 'auth_failed' (added after a real production incident, project
// 786038057684): a 429/RESOURCE_EXHAUSTED from the Business Profile
// Account Management API happens AFTER a successful OAuth token exchange
// -- it's a Google Cloud project-level quota/access problem, not a broken
// connection, and must never tell the operator to reconnect (reconnecting
// does nothing for a quota block).
export const GoogleHealth = Object.freeze({
  CONNECTED: 'connected',
  TOKEN_EXPIRED: 'token_expired',
  TOKEN_REVOKED: 'token_revoked',
  AUTH_FAILED: 'auth_failed',
  QUOTA_BLOCKED: 'quota_blocked',
  NEVER_CONNECTED: 'never_connected',
})

function healthForFailure(reason, errorDescription) {
  if (reason === 'invalid_grant') {
    const text = (errorDescription || '').toLowerCase()
    if (text.includes('expired') && !text.includes('revoked')) return GoogleHealth.TOKEN_EXPIRED
    return GoogleHealth.TOKEN_REVOKED // default for invalid_grant: Google's own text usually says "expired or revoked"
  }
  if (reason === 'quota_exceeded') return GoogleHealth.QUOTA_BLOCKED
  // 'permission_denied' (403), 'unauthorized' (401), 'api_error', and any
  // other reason all remain AUTH_FAILED -- a deliberate design choice, not
  // an oversight: Settings -> Google Business Profile doesn't have a
  // dedicated "permission" badge distinct from a generic auth problem
  // today, so 403/401/unknown correctly surface as "Authentication
  // Failed" with Google's own message text still preserved verbatim in
  // the response's `error` field either way.
  return GoogleHealth.AUTH_FAILED
}

// Google's Business Profile Account Management API returns a 429 with the
// JSON body's error.status set to "RESOURCE_EXHAUSTED" when the Cloud
// project hasn't been granted (or has exhausted) quota/allowlist access
// for this API. Detected via EITHER signal -- the HTTP status code OR the
// error.status field -- since Google is not perfectly consistent about
// which one a given response actually carries.
export function isQuotaExceededError(status, errorBody) {
  return status === 429 || errorBody?.error?.status === 'RESOURCE_EXHAUSTED'
}

// Extracts the Google Cloud project number from Google's own error message
// text (e.g. "...for consumer 'project_number:786038057684'.") so the
// Settings page can name exactly which project needs its quota/access
// fixed -- computed fresh from the live error every time, never hardcoded,
// so it stays correct even if the OAuth client is later moved to a
// different Google Cloud project. Returns null if the text doesn't
// contain a recognizable project number (e.g. a differently-worded quota
// error from a future API version).
export function extractQuotaProjectNumber(message) {
  const match = /project_number:(\d+)/.exec(message || '')
  return match ? match[1] : null
}

function parseRecord(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// Both helpers derive the tenant's key via resolveCredentialKey() -- which
// itself validates tenantId -- so the tenant is validated as an
// inseparable part of deriving the key, never after. assertValidTenantId()
// is ALSO called at the top of every public function below, before even
// checking Redis configuration, so an invalid tenantId fails immediately
// and identically regardless of runtime/store state.
async function readRaw(client, tenantId) {
  try {
    return parseRecord(await client.get(resolveCredentialKey(tenantId)))
  } catch (err) {
    throw new CredentialStoreUnavailableError(`credential store unreachable: ${err.message}`)
  }
}

async function writeRaw(client, tenantId, record) {
  try {
    await client.set(resolveCredentialKey(tenantId), JSON.stringify(record))
  } catch (err) {
    throw new CredentialStoreUnavailableError(`credential store unreachable: ${err.message}`)
  }
}

// --- Credential CAS (Multi-Tenant Phase 4I.2 concurrency closure) ---------
// Every stored record carries `credentialVersion`, a monotonically
// increasing integer bumped on every mutation (the credential-record
// equivalent of tenantConfigStore.js's configVersion, and the SAME CAS
// discipline -- a Lua script executed server-side via Redis EVAL, atomic
// end to end, never a GET-then-compare-in-JS-then-SET). A never-connected
// tenant's implicit version is 0 (mirrors tenantConfigStore's CAS_UPSERT_SCRIPT
// treating a missing hash field the same way), so setStoredCredentialIfVersion()
// below can express "install this candidate only if nothing has connected
// since I last read this tenant's version" identically to "only if version N
// is still current."
//
// WHY THIS WAS NECESSARY (not merely "narrowing a window"): a JS-level
// read -> compare -> write, no matter how close together the read and write
// are, still has a real gap two concurrent requests can land inside --
// both can observe the same "current" state and then both proceed to write,
// sequentially, with the second (chronologically) call silently overwriting
// the first. Only pushing the compare-and-write into ONE atomic Redis
// operation removes that gap entirely, the same reasoning tenantConfigStore.js's
// own CAS_UPSERT_SCRIPT is built on.
const CREDENTIAL_CAS_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local currentVersion = '0'
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and decoded and decoded.credentialVersion then
    currentVersion = tostring(decoded.credentialVersion)
  end
end
if currentVersion ~= ARGV[1] then
  return raw or false
end
redis.call('SET', KEYS[1], ARGV[2])
return true
`

// Thrown by setStoredCredentialIfVersion() when the atomic version check
// fails -- something else (a concurrently-completed reconnect, most likely)
// wrote this tenant's credential after the caller captured expectedVersion.
// Carries the CURRENT raw record (parsed from what the Lua script itself
// read, the same atomic read used for the comparison -- never a second,
// separate, racy GET), or null if the credential was deleted (disconnected)
// in the interim. Never carries a decrypted token -- callers that need the
// current state call getStoredCredential() themselves.
export class CredentialVersionConflictError extends Error {
  constructor(message, currentRecord) {
    super(message)
    this.currentRecord = currentRecord ?? null
  }
}

// Returns the decrypted credential + all stored metadata, or null if this
// tenant has never connected. Throws CredentialStoreUnavailableError if
// Redis itself is unreachable/unconfigured (never silently reports "not
// connected" for an outage -- that would misrepresent a real problem as
// "never connected").
export async function getStoredCredential(tenantId) {
  assertValidTenantId(tenantId, 'getStoredCredential')
  const client = getClient()
  if (!client) throw new CredentialStoreUnavailableError('credential store is not configured')

  const record = await readRaw(client, tenantId)
  if (!record) return null

  const credentialVersion = Number.isInteger(record.credentialVersion) ? record.credentialVersion : 0

  let refreshToken = null
  if (record.refreshTokenCiphertext) {
    try {
      refreshToken = decrypt({
        ciphertext: record.refreshTokenCiphertext,
        iv: record.refreshTokenIv,
        authTag: record.refreshTokenAuthTag,
      })
    } catch (err) {
      // A wrong/rotated CREDENTIAL_ENCRYPTION_KEY must never crash the
      // caller -- surface it as an auth failure the dashboard can display
      // and recover from via reconnect, not an unhandled exception.
      console.error(`[credentialStore] failed to decrypt stored refresh token: ${err.message}`)
      return { ...record, refreshToken: null, health: GoogleHealth.AUTH_FAILED, lastFailureReason: 'decryption_failed', credentialVersion }
    }
  }

  return {
    refreshToken,
    connectedAccountName: record.connectedAccountName ?? null,
    connectedAt: record.connectedAt ?? null,
    lastOAuthRefreshAt: record.lastOAuthRefreshAt ?? null,
    lastSuccessfulSyncAt: record.lastSuccessfulSyncAt ?? null,
    lastFailedSyncAt: record.lastFailedSyncAt ?? null,
    lastFailureReason: record.lastFailureReason ?? null,
    health: record.health ?? GoogleHealth.CONNECTED,
    credentialVersion,
  }
}

function buildFreshRecord({ refreshToken, connectedAccountName }, credentialVersion) {
  const { ciphertext, iv, authTag } = encrypt(refreshToken)
  const now = new Date().toISOString()
  return {
    refreshTokenCiphertext: ciphertext,
    refreshTokenIv: iv,
    refreshTokenAuthTag: authTag,
    connectedAccountName: connectedAccountName ?? null,
    connectedAt: now,
    lastOAuthRefreshAt: now,
    lastSuccessfulSyncAt: null,
    lastFailedSyncAt: null,
    lastFailureReason: null,
    health: GoogleHealth.CONNECTED,
    credentialVersion,
  }
}

// Writes a brand-new connection UNCONDITIONALLY -- always supersedes
// whatever was there before FOR THAT TENANT ONLY, resetting failure state,
// since a successful OAuth round trip proves the new token is good right
// now. Never touches any other tenant's key.
//
// Multi-Tenant Phase 4I.2: no LONGER the production Connect/Reconnect write
// path -- google/[action].js's callback() uses setStoredCredentialIfVersion()
// below exclusively, so a reconnect can never race another reconnect for
// the same tenant. This plain, unconditional form remains exported for
// test fixtures and any future one-shot seeding use (it still correctly
// stamps credentialVersion, incrementing from whatever was there, so a
// record it creates is fully compatible with a subsequent CAS call against
// it) but production code no longer calls it as of this phase.
export async function setStoredCredential(tenantId, { refreshToken, connectedAccountName }) {
  assertValidTenantId(tenantId, 'setStoredCredential')
  const client = getClient()
  if (!client) throw new CredentialStoreUnavailableError('credential store is not configured')

  const existing = await readRaw(client, tenantId)
  const nextVersion = (Number.isInteger(existing?.credentialVersion) ? existing.credentialVersion : 0) + 1
  await writeRaw(client, tenantId, buildFreshRecord({ refreshToken, connectedAccountName }, nextVersion))
}

// THE production Connect/Reconnect write path (Multi-Tenant Phase 4I.2).
// Installs a brand-new connection ONLY IF this tenant's credential is still
// at exactly `expectedVersion` -- checked and applied in ONE atomic Redis
// EVAL, never as a separate read-then-write pair. Throws
// CredentialVersionConflictError (fail closed, no retry -- see this file's
// header) if the version has moved on: another reconnect for this SAME
// tenant completed between the caller capturing expectedVersion and this
// call. The caller (google/[action].js's callback()) must NOT retry
// automatically on this error -- the user explicitly reconnects again if
// they still want to.
//
// expectedVersion 0 means "install only if nothing has ever connected, or
// the tenant's credential is still at its NEVER-EXPLICITLY-VERSIONED
// baseline" -- mirrors getStoredCredential()'s own `?? 0` default for a
// missing/legacy record, so a first-ever connect (captured expectedVersion
// via getStoredCredential() returning null, i.e. version 0) and a genuine
// version-0 record behave identically.
export async function setStoredCredentialIfVersion(tenantId, { refreshToken, connectedAccountName }, expectedVersion) {
  assertValidTenantId(tenantId, 'setStoredCredentialIfVersion')
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new TypeError('setStoredCredentialIfVersion: expectedVersion must be a non-negative integer')
  }
  const client = getClient()
  if (!client) throw new CredentialStoreUnavailableError('credential store is not configured')

  const next = buildFreshRecord({ refreshToken, connectedAccountName }, expectedVersion + 1)

  let evalResult
  try {
    evalResult = await client.eval(CREDENTIAL_CAS_SCRIPT, [resolveCredentialKey(tenantId)], [String(expectedVersion), JSON.stringify(next)])
  } catch (err) {
    throw new CredentialStoreUnavailableError(`credential store unreachable: ${err.message}`)
  }
  if (evalResult !== true && evalResult !== 1) {
    // The script's own atomic check failed (a writer -- almost certainly a
    // concurrent reconnect for this same tenant -- committed between our
    // caller's read and this EVAL) -- evalResult is the CURRENT raw record
    // the script itself read, or false/null if the credential was deleted
    // (disconnected) in the interim.
    const currentRecord = typeof evalResult === 'string' ? parseRecord(evalResult) : null
    throw new CredentialVersionConflictError(
      `setStoredCredentialIfVersion: version conflict for tenant ${JSON.stringify(tenantId)} -- expected ${expectedVersion}, credential has moved on`,
      currentRecord,
    )
  }
  return { credentialVersion: next.credentialVersion }
}

// Records the outcome of any live Google API interaction that exercises
// the stored refresh token (a status check, test-connection, or a
// publish/reply attempt) for `tenantId` -- this is the "automatic
// recovery" mechanism: call this the MOMENT a Google auth failure is
// detected, from any of those call sites, so the very next status read
// for THIS tenant reflects "Reconnect Required" immediately, never
// waiting for a separate user-initiated check. Never affects any other
// tenant's stored health.
//
// Multi-Tenant Phase 4I.2: this is a read-then-write, same shape as
// before, but the write is now a CAS against the version this call itself
// just read -- if a reconnect for this SAME tenant completes in the gap
// between that read and this write, the CAS fails and this update is
// SILENTLY SKIPPED rather than retried or forced through. This is a
// deliberate, safe trade-off: without the CAS, this call would otherwise
// write back the ENTIRE previously-read record (a stale, whole-object
// read-modify-write) with only its own field changed -- silently
// resurrecting the OLD encrypted refresh token over a credential a
// reconnect just replaced. Losing one observability timestamp to a
// genuine race is acceptable; reverting a newer credential to an older one
// is not. Never throws on a conflict -- every existing call site treats
// this as fire-and-forget and must keep doing so.
export async function recordSyncOutcome(tenantId, { success, reason, errorDescription } = {}) {
  assertValidTenantId(tenantId, 'recordSyncOutcome')
  const client = getClient()
  if (!client) throw new CredentialStoreUnavailableError('credential store is not configured')

  const record = await readRaw(client, tenantId)
  if (!record) return // nothing connected for this tenant to update
  const currentVersion = Number.isInteger(record.credentialVersion) ? record.credentialVersion : 0

  const now = new Date().toISOString()
  const next = { ...record, credentialVersion: currentVersion + 1 }
  if (success) {
    next.lastSuccessfulSyncAt = now
    next.lastFailureReason = null
    next.health = GoogleHealth.CONNECTED
  } else {
    next.lastFailedSyncAt = now
    next.lastFailureReason = reason ?? 'unknown'
    next.health = healthForFailure(reason, errorDescription)
  }

  try {
    await client.eval(CREDENTIAL_CAS_SCRIPT, [resolveCredentialKey(tenantId)], [String(currentVersion), JSON.stringify(next)])
  } catch (err) {
    throw new CredentialStoreUnavailableError(`credential store unreachable: ${err.message}`)
  }
}

// Records a successful access-token exchange (a refresh actually happened)
// for `tenantId`, independent of whether the SUBSEQUENT API call using
// that token succeeded -- "Last OAuth Refresh" tracks token minting, "Last
// Successful Sync"/"Last Failed Sync" (recordSyncOutcome above) track what
// was DONE with it. Never affects any other tenant's record.
//
// Multi-Tenant Phase 4I.2: same CAS-protected, silently-skip-on-conflict
// discipline as recordSyncOutcome() above, and for the identical reason --
// a stale refresh-token-exchange record must never revert a newer
// reconnect's credential.
export async function recordOAuthRefresh(tenantId) {
  assertValidTenantId(tenantId, 'recordOAuthRefresh')
  const client = getClient()
  if (!client) throw new CredentialStoreUnavailableError('credential store is not configured')

  const record = await readRaw(client, tenantId)
  if (!record) return
  const currentVersion = Number.isInteger(record.credentialVersion) ? record.credentialVersion : 0
  const next = { ...record, lastOAuthRefreshAt: new Date().toISOString(), credentialVersion: currentVersion + 1 }

  try {
    await client.eval(CREDENTIAL_CAS_SCRIPT, [resolveCredentialKey(tenantId)], [String(currentVersion), JSON.stringify(next)])
  } catch (err) {
    throw new CredentialStoreUnavailableError(`credential store unreachable: ${err.message}`)
  }
}

// Disconnect -- genuine removal, not a soft "disabled" flag; a fresh
// Connect afterward is indistinguishable from a first-time connection.
// Deletes ONLY `tenantId`'s own authoritative key (v1 for a LEGACY-mode
// tenant, its own v2 key otherwise) -- structurally cannot reach, and
// never touches, any other tenant's credential.
//
// Multi-Tenant Phase 4I.2 -- DISCONNECT vs. RECONNECT RACE, DEFINED: this
// is deliberately NOT version-gated -- Disconnect is an explicit user
// action ("remove Google access now") that must always win outright
// against whatever credential currently exists, never conditioned on a
// version it didn't capture. The two possible orderings against a
// concurrent reconnect are both already safe by construction, with no
// extra code needed here:
//   Reconnect completes, THEN Disconnect runs -- the key is deleted
//     unconditionally; final state is "not connected," exactly what
//     clicking Disconnect means, regardless of how recently a reconnect
//     finished.
//   Disconnect runs, THEN Reconnect's OWN CAS-write executes -- the
//     reconnect captured its expectedVersion BEFORE the disconnect
//     happened, so setStoredCredentialIfVersion()'s atomic check finds no
//     record at the expected version (or no record at all) and throws
//     CredentialVersionConflictError, exactly as it would for any other
//     concurrent write. The reconnect is rejected as "connection changed,"
//     the user reconnects again, and that fresh attempt reads reality (no
//     credential) and proceeds as a genuine first-time connect.
// Both outcomes are deterministic and safe; only reconnect-vs-reconnect
// needed a version to compare against, since only that case can otherwise
// silently choose the "wrong" (chronologically earlier) winner.
export async function clearStoredCredential(tenantId) {
  assertValidTenantId(tenantId, 'clearStoredCredential')
  const client = getClient()
  if (!client) throw new CredentialStoreUnavailableError('credential store is not configured')
  try {
    await client.del(resolveCredentialKey(tenantId))
  } catch (err) {
    throw new CredentialStoreUnavailableError(`credential store unreachable: ${err.message}`)
  }
}
