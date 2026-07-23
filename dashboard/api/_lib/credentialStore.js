// The Google Business Profile OAuth credential store (Phase 8, Milestone
// 8.7) -- replaces the Vercel-env-var-plus-redeploy flow
// (google/_lib/vercel.js's upsertEnvVar/triggerRedeploy) as the LIVE
// storage path for the refresh token. Reconnecting from the dashboard now
// writes here directly; the very next request reads it -- no redeploy, no
// ~60s propagation window, no visible entry in Vercel's deployment history
// for a routine credential rotation.
//
// Single Redis key (CREDENTIAL_KEY) holding one JSON blob (not a hash --
// there is exactly one Google connection for the whole account, not a
// per-id collection like actionStore.js/contactStore.js). The refresh
// token itself is encrypted at rest with AES-256-GCM (Node's built-in
// crypto, no new dependency) under CREDENTIAL_ENCRYPTION_KEY -- this is a
// deliberate departure from Vercel's own env-var encryption, made so
// reconnecting never touches Vercel again; the blast radius shifts to
// CREDENTIAL_ENCRYPTION_KEY, the same class of risk GOOGLE_REFRESH_TOKEN
// already was. Reading Upstash alone (e.g. from the Upstash console) is
// not sufficient to recover the token without also holding this key.
//
// Node-only, same as actionStore.js/contactStore.js.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto'
import { Redis } from '@upstash/redis'

const CREDENTIAL_KEY = 'gbp_credentials:v1'

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

async function readRaw(client) {
  try {
    return parseRecord(await client.get(CREDENTIAL_KEY))
  } catch (err) {
    throw new CredentialStoreUnavailableError(`credential store unreachable: ${err.message}`)
  }
}

async function writeRaw(client, record) {
  try {
    await client.set(CREDENTIAL_KEY, JSON.stringify(record))
  } catch (err) {
    throw new CredentialStoreUnavailableError(`credential store unreachable: ${err.message}`)
  }
}

// Returns the decrypted credential + all stored metadata, or null if never
// connected. Throws CredentialStoreUnavailableError if Redis itself is
// unreachable/unconfigured (never silently reports "not connected" for an
// outage -- that would misrepresent a real problem as "never connected").
export async function getStoredCredential() {
  const client = getClient()
  if (!client) throw new CredentialStoreUnavailableError('credential store is not configured')

  const record = await readRaw(client)
  if (!record) return null

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
      return { ...record, refreshToken: null, health: GoogleHealth.AUTH_FAILED, lastFailureReason: 'decryption_failed' }
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
  }
}

// Writes a brand-new connection (Connect/Reconnect) -- always supersedes
// whatever was there before, resetting failure state, since a successful
// OAuth round trip proves the new token is good right now.
export async function setStoredCredential({ refreshToken, connectedAccountName }) {
  const client = getClient()
  if (!client) throw new CredentialStoreUnavailableError('credential store is not configured')

  const { ciphertext, iv, authTag } = encrypt(refreshToken)
  const now = new Date().toISOString()
  await writeRaw(client, {
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
  })
}

// Records the outcome of any live Google API interaction that exercises
// the stored refresh token (a status check, test-connection, or a
// publish/reply attempt) -- this is the "automatic recovery" mechanism:
// call this the MOMENT a Google auth failure is detected, from any of
// those call sites, so the very next status read reflects "Reconnect
// Required" immediately, never waiting for a separate user-initiated check.
export async function recordSyncOutcome({ success, reason, errorDescription } = {}) {
  const client = getClient()
  if (!client) throw new CredentialStoreUnavailableError('credential store is not configured')

  const record = await readRaw(client)
  if (!record) return // nothing connected to update

  const now = new Date().toISOString()
  if (success) {
    record.lastSuccessfulSyncAt = now
    record.lastFailureReason = null
    record.health = GoogleHealth.CONNECTED
  } else {
    record.lastFailedSyncAt = now
    record.lastFailureReason = reason ?? 'unknown'
    record.health = healthForFailure(reason, errorDescription)
  }
  await writeRaw(client, record)
}

// Records a successful access-token exchange (a refresh actually happened),
// independent of whether the SUBSEQUENT API call using that token
// succeeded -- "Last OAuth Refresh" tracks token minting, "Last Successful
// Sync"/"Last Failed Sync" (recordSyncOutcome above) track what was DONE
// with it.
export async function recordOAuthRefresh() {
  const client = getClient()
  if (!client) throw new CredentialStoreUnavailableError('credential store is not configured')

  const record = await readRaw(client)
  if (!record) return
  record.lastOAuthRefreshAt = new Date().toISOString()
  await writeRaw(client, record)
}

// Disconnect -- genuine removal, not a soft "disabled" flag; a fresh
// Connect afterward is indistinguishable from a first-time connection.
export async function clearStoredCredential() {
  const client = getClient()
  if (!client) throw new CredentialStoreUnavailableError('credential store is not configured')
  try {
    await client.del(CREDENTIAL_KEY)
  } catch (err) {
    throw new CredentialStoreUnavailableError(`credential store unreachable: ${err.message}`)
  }
}
