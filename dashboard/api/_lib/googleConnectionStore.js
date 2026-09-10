// Multi-Tenant Google Integration Architecture Fix -- additive multi-
// connection support layered ON TOP OF credentialStore.js, never replacing
// it. This file does NOT touch credentialStore.js's internals (its own
// LEGACY/CUTOVER key-resolution logic, and the frozen regression test
// tests/test_credential_store.js's source-scan of it, are both left
// completely unchanged) -- it is a genuinely separate, additional store for
// connections BEYOND the one "primary" connection credentialStore.js
// already manages per tenant.
//
// WHY A SEPARATE FILE RATHER THAN REWRITING credentialStore.js: Los Tres
// Amigos's real, currently-working Google refresh token lives at
// credentialStore.js's exact existing key (gbp_credentials:v1, LEGACY
// mode) and is read directly by that same key from Python
// (tenant_keys.py's resolve_credential_key()). The smallest-blast-radius,
// zero-migration-risk way to add "a tenant MAY have more than one Google
// connection" is to leave that one proven path completely alone and add
// storage ONLY for connections beyond it:
//   - connectionId === PRIMARY_CONNECTION_ID ('primary') for any tenant
//     -> delegates straight through to credentialStore.js's own exported
//        functions (getStoredCredential/setStoredCredentialIfVersion/
//        recordSyncOutcome/recordOAuthRefresh/clearStoredCredential),
//        which already implement the correct LEGACY-vs-CUTOVER key choice.
//        No new Redis key, no new encryption, no new migration.
//   - any OTHER connectionId -> a NEW Redis HASH per tenant
//     (google_connections:v1:{tenantId}, field = connectionId), genuinely
//     exercised only when an operator explicitly registers a second
//     connection for a tenant -- proving multi-connection support is real
//     (tests/test_google_multi_connection.js) without putting the one
//     real credential that exists today at any risk.
//
// OWNERSHIP MODEL (see also credentialStore.js's own header): every
// connection record's `connectedByUserId` is purely an AUDIT field --
// which PRYOR user happened to click through the OAuth flow. Ownership of
// the connection itself is the tenantId the record lives under, never that
// field; nothing in this codebase authorizes access based on
// connectedByUserId.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto'
import { Redis } from '@upstash/redis'
import { isValidTenantId, DEFAULT_TENANT_ID } from './tenants.js'
import {
  getStoredCredential, setStoredCredentialIfVersion, recordSyncOutcome, recordOAuthRefresh,
  clearStoredCredential, GoogleHealth, CredentialStoreUnavailableError, CredentialVersionConflictError,
} from './credentialStore.js'

export const PRIMARY_CONNECTION_ID = 'primary'

const CONNECTIONS_HASH_PREFIX = 'google_connections:v1'

function connectionsHashKey(tenantId) {
  return `${CONNECTIONS_HASH_PREFIX}:${tenantId}`
}

function assertValidTenantId(tenantId, fnName) {
  if (!isValidTenantId(tenantId)) {
    throw new TypeError(`${fnName}: invalid tenantId ${JSON.stringify(tenantId)}`)
  }
}

// Reserved so a caller can never register a second connection that
// collides with the primary slot's own id via the hash-based path.
function assertValidSecondaryConnectionId(connectionId, fnName) {
  if (typeof connectionId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(connectionId)) {
    throw new TypeError(`${fnName}: invalid connectionId ${JSON.stringify(connectionId)}`)
  }
  if (connectionId === PRIMARY_CONNECTION_ID) {
    throw new TypeError(`${fnName}: connectionId ${JSON.stringify(connectionId)} is reserved for the primary connection`)
  }
}

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class GoogleConnectionStoreUnavailableError extends Error {}

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

// --- Encryption (identical scheme to credentialStore.js's, copied rather
// than imported since that file does not export its encrypt/decrypt
// helpers -- both derive the same 32-byte key from the same
// CREDENTIAL_ENCRYPTION_KEY env var, so a record written by either is
// readable by the other; this file simply never writes to the OTHER
// file's key, so that convergence is never exercised in practice, only
// kept for shape/algorithm consistency.) ------------------------------------

export class CredentialEncryptionKeyMissingError extends Error {}

function getEncryptionKey() {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!raw) throw new CredentialEncryptionKeyMissingError('CREDENTIAL_ENCRYPTION_KEY is not configured')
  return createHash('sha256').update(raw).digest()
}

function encrypt(plaintext) {
  const iv = randomBytes(12)
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

function parseRecord(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const CAS_SCRIPT_HASH = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local currentVersion = '0'
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and decoded and decoded.credentialVersion then
    currentVersion = tostring(decoded.credentialVersion)
  end
end
if currentVersion ~= ARGV[2] then
  return raw or false
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return true
`

export class ConnectionVersionConflictError extends Error {
  constructor(message, currentRecord) {
    super(message)
    this.currentRecord = currentRecord ?? null
  }
}

function buildFreshRecord({ refreshToken, connectedAccountName, connectedByUserId }, credentialVersion, existing) {
  const { ciphertext, iv, authTag } = encrypt(refreshToken)
  const now = new Date().toISOString()
  return {
    refreshTokenCiphertext: ciphertext,
    refreshTokenIv: iv,
    refreshTokenAuthTag: authTag,
    connectedAccountName: connectedAccountName ?? null,
    connectedByUserId: connectedByUserId ?? existing?.connectedByUserId ?? null,
    connectedAt: now,
    lastOAuthRefreshAt: now,
    lastSuccessfulSyncAt: null,
    lastFailedSyncAt: null,
    lastFailureReason: null,
    health: GoogleHealth.CONNECTED,
    credentialVersion,
    status: 'active',
  }
}

function shapeSecondaryRecord(tenantId, connectionId, record) {
  const { refreshTokenCiphertext, refreshTokenIv, refreshTokenAuthTag, ...meta } = record
  return { connectionId, tenantId, provider: 'google_business_profile', ...meta }
}

// --- Secondary-connection raw storage (hash-based) --------------------

async function readSecondaryRecord(client, tenantId, connectionId) {
  try {
    return parseRecord(await client.hget(connectionsHashKey(tenantId), connectionId))
  } catch (err) {
    throw new GoogleConnectionStoreUnavailableError(`google connection store unreachable: ${err.message}`)
  }
}

async function writeSecondaryRecord(client, tenantId, connectionId, record) {
  try {
    await client.hset(connectionsHashKey(tenantId), { [connectionId]: JSON.stringify(record) })
  } catch (err) {
    throw new GoogleConnectionStoreUnavailableError(`google connection store unreachable: ${err.message}`)
  }
}

// --- Public API ----------------------------------------------------------

// Returns the decrypted connection (refreshToken included), or null if this
// (tenantId, connectionId) has never connected. For connectionId ===
// PRIMARY_CONNECTION_ID this is a byte-for-byte pass-through to
// credentialStore.js's getStoredCredential() (LTA's real record, or any
// other tenant's own single legacy-shaped record), reshaped to also carry
// connectionId/tenantId/provider.
export async function getConnection(tenantId, connectionId) {
  assertValidTenantId(tenantId, 'getConnection')
  if (connectionId === PRIMARY_CONNECTION_ID) {
    const credential = await getStoredCredential(tenantId)
    if (!credential) return null
    return { connectionId: PRIMARY_CONNECTION_ID, tenantId, provider: 'google_business_profile', connectedByUserId: null, ...credential }
  }
  assertValidSecondaryConnectionId(connectionId, 'getConnection')
  const client = getClient()
  if (!client) throw new GoogleConnectionStoreUnavailableError('google connection store is not configured')

  const record = await readSecondaryRecord(client, tenantId, connectionId)
  if (!record) return null
  const credentialVersion = Number.isInteger(record.credentialVersion) ? record.credentialVersion : 0
  const meta = shapeSecondaryRecord(tenantId, connectionId, { ...record, credentialVersion })

  if (!record.refreshTokenCiphertext) return { ...meta, refreshToken: null }
  try {
    const refreshToken = decrypt({
      ciphertext: record.refreshTokenCiphertext, iv: record.refreshTokenIv, authTag: record.refreshTokenAuthTag,
    })
    return { ...meta, refreshToken }
  } catch (err) {
    console.error(`[googleConnectionStore] failed to decrypt stored refresh token for ${tenantId}/${connectionId}: ${err.message}`)
    return { ...meta, refreshToken: null, health: GoogleHealth.AUTH_FAILED, lastFailureReason: 'decryption_failed' }
  }
}

// Metadata-only listing (NEVER decrypts/returns a refresh token) -- every
// connection under this tenant, primary first. For a tenant that has never
// registered a second connection, this is exactly a one-element array
// (or empty), identical in spirit to credentialStore.js's single-record
// behavior today.
export async function listConnectionsMetadata(tenantId) {
  assertValidTenantId(tenantId, 'listConnectionsMetadata')

  const results = []
  const primary = await getConnection(tenantId, PRIMARY_CONNECTION_ID)
  if (primary) {
    const { refreshToken, ...meta } = primary
    results.push(meta)
  }

  const client = getClient()
  if (!client) throw new GoogleConnectionStoreUnavailableError('google connection store is not configured')
  let raw
  try {
    raw = await client.hgetall(connectionsHashKey(tenantId))
  } catch (err) {
    throw new GoogleConnectionStoreUnavailableError(`google connection store unreachable: ${err.message}`)
  }
  for (const [connectionId, value] of Object.entries(raw ?? {})) {
    const record = parseRecord(value)
    if (!record) continue
    const { refreshTokenCiphertext, refreshTokenIv, refreshTokenAuthTag, ...meta } = record
    results.push({ connectionId, tenantId, provider: 'google_business_profile', ...meta })
  }
  return results
}

// Unconditional write for a SECONDARY connection -- test fixtures / one-shot
// seeding, mirrors credentialStore.js's setStoredCredential() shape. The
// primary slot is never created/overwritten through this file -- use
// credentialStore.js's own setStoredCredential()/setStoredCredentialIfVersion()
// directly for that, exactly as every existing call site already does.
export async function setSecondaryConnection(tenantId, connectionId, { refreshToken, connectedAccountName, connectedByUserId }) {
  assertValidTenantId(tenantId, 'setSecondaryConnection')
  assertValidSecondaryConnectionId(connectionId, 'setSecondaryConnection')
  const client = getClient()
  if (!client) throw new GoogleConnectionStoreUnavailableError('google connection store is not configured')

  const existing = await readSecondaryRecord(client, tenantId, connectionId)
  const nextVersion = (Number.isInteger(existing?.credentialVersion) ? existing.credentialVersion : 0) + 1
  await writeSecondaryRecord(client, tenantId, connectionId, buildFreshRecord({ refreshToken, connectedAccountName, connectedByUserId }, nextVersion, existing))
}

// CAS write for a SECONDARY connection -- same atomicity guarantee as
// credentialStore.js's setStoredCredentialIfVersion(), scoped to this
// tenant's own hash field so it can never race or collide with any other
// connectionId, including 'primary' (a completely different key/store).
export async function setSecondaryConnectionIfVersion(tenantId, connectionId, { refreshToken, connectedAccountName, connectedByUserId }, expectedVersion) {
  assertValidTenantId(tenantId, 'setSecondaryConnectionIfVersion')
  assertValidSecondaryConnectionId(connectionId, 'setSecondaryConnectionIfVersion')
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new TypeError('setSecondaryConnectionIfVersion: expectedVersion must be a non-negative integer')
  }
  const client = getClient()
  if (!client) throw new GoogleConnectionStoreUnavailableError('google connection store is not configured')

  const existing = await readSecondaryRecord(client, tenantId, connectionId)
  const next = buildFreshRecord({ refreshToken, connectedAccountName, connectedByUserId }, expectedVersion + 1, existing)

  let evalResult
  try {
    evalResult = await client.eval(CAS_SCRIPT_HASH, [connectionsHashKey(tenantId)], [connectionId, String(expectedVersion), JSON.stringify(next)])
  } catch (err) {
    throw new GoogleConnectionStoreUnavailableError(`google connection store unreachable: ${err.message}`)
  }
  if (evalResult !== true && evalResult !== 1) {
    const currentRecord = typeof evalResult === 'string' ? parseRecord(evalResult) : null
    throw new ConnectionVersionConflictError(
      `setSecondaryConnectionIfVersion: version conflict for tenant ${JSON.stringify(tenantId)} connection ${JSON.stringify(connectionId)}`,
      currentRecord,
    )
  }
  return { credentialVersion: next.credentialVersion }
}

// Dispatches sync-outcome/OAuth-refresh recording to the correct
// underlying store -- primary goes through credentialStore.js's own
// functions unchanged; a secondary connection updates its own hash field.
export async function recordConnectionSyncOutcome(tenantId, connectionId, outcome = {}) {
  assertValidTenantId(tenantId, 'recordConnectionSyncOutcome')
  if (connectionId === PRIMARY_CONNECTION_ID) return recordSyncOutcome(tenantId, outcome)
  assertValidSecondaryConnectionId(connectionId, 'recordConnectionSyncOutcome')
  const client = getClient()
  if (!client) throw new GoogleConnectionStoreUnavailableError('google connection store is not configured')

  const record = await readSecondaryRecord(client, tenantId, connectionId)
  if (!record) return
  const currentVersion = Number.isInteger(record.credentialVersion) ? record.credentialVersion : 0
  const now = new Date().toISOString()
  const next = { ...record, credentialVersion: currentVersion + 1 }
  if (outcome.success) {
    next.lastSuccessfulSyncAt = now
    next.lastFailureReason = null
    next.health = GoogleHealth.CONNECTED
  } else {
    next.lastFailedSyncAt = now
    next.lastFailureReason = outcome.reason ?? 'unknown'
    next.health = GoogleHealth.AUTH_FAILED
  }
  try {
    const evalResult = await client.eval(CAS_SCRIPT_HASH, [connectionsHashKey(tenantId)], [connectionId, String(currentVersion), JSON.stringify(next)])
    if (evalResult !== true && evalResult !== 1) return // lost the race -- silently skip, same discipline as credentialStore.js
  } catch (err) {
    throw new GoogleConnectionStoreUnavailableError(`google connection store unreachable: ${err.message}`)
  }
}

export async function recordConnectionOAuthRefresh(tenantId, connectionId) {
  assertValidTenantId(tenantId, 'recordConnectionOAuthRefresh')
  if (connectionId === PRIMARY_CONNECTION_ID) return recordOAuthRefresh(tenantId)
  assertValidSecondaryConnectionId(connectionId, 'recordConnectionOAuthRefresh')
  const client = getClient()
  if (!client) throw new GoogleConnectionStoreUnavailableError('google connection store is not configured')

  const record = await readSecondaryRecord(client, tenantId, connectionId)
  if (!record) return
  const currentVersion = Number.isInteger(record.credentialVersion) ? record.credentialVersion : 0
  const next = { ...record, lastOAuthRefreshAt: new Date().toISOString(), credentialVersion: currentVersion + 1 }
  try {
    const evalResult = await client.eval(CAS_SCRIPT_HASH, [connectionsHashKey(tenantId)], [connectionId, String(currentVersion), JSON.stringify(next)])
    if (evalResult !== true && evalResult !== 1) return
  } catch (err) {
    throw new GoogleConnectionStoreUnavailableError(`google connection store unreachable: ${err.message}`)
  }
}

// Deletes ONE connection. The primary slot dispatches to
// credentialStore.js's own clearStoredCredential() unchanged; a secondary
// connection removes just its own hash field, never the whole tenant hash,
// so sibling connections are completely unaffected.
export async function deleteConnection(tenantId, connectionId) {
  assertValidTenantId(tenantId, 'deleteConnection')
  if (connectionId === PRIMARY_CONNECTION_ID) return clearStoredCredential(tenantId)
  assertValidSecondaryConnectionId(connectionId, 'deleteConnection')
  const client = getClient()
  if (!client) throw new GoogleConnectionStoreUnavailableError('google connection store is not configured')
  try {
    await client.hdel(connectionsHashKey(tenantId), connectionId)
  } catch (err) {
    throw new GoogleConnectionStoreUnavailableError(`google connection store unreachable: ${err.message}`)
  }
}

export { GoogleHealth, CredentialStoreUnavailableError, CredentialVersionConflictError }
