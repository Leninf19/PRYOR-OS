// Regression tests for dashboard/api/_lib/credentialStore.js -- the
// Google OAuth credential store (Phase 8, Milestone 8.7; tenant-scoped by
// Multi-Tenant Phase 4A). No real Upstash account and no real Google
// credentials anywhere in this file: every test drives the module's
// test-only client-factory seam, same pattern as
// actionStore.js/contactStore.js/auditLog.js.
//
// Run directly: node tests/test_credential_store.js

process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import {
  getStoredCredential,
  setStoredCredential,
  recordSyncOutcome,
  recordOAuthRefresh,
  clearStoredCredential,
  GoogleHealth,
  CredentialStoreUnavailableError,
  CredentialEncryptionKeyMissingError,
  isQuotaExceededError,
  extractQuotaProjectNumber,
  getCredentialMigrationMode,
  CredentialMigrationMode,
  _setRedisClientForTests,
  _resetRedisClientForTests,
} from '../dashboard/api/_lib/credentialStore.js'
import { credentialKeyV2 } from '../dashboard/api/_lib/tenantKeys.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

const SYNTHETIC_TENANT_ID = 't_synthetic-second-tenant'
const LEGACY_V1_KEY = 'gbp_credentials:v1'
const __dirname = dirname(fileURLToPath(import.meta.url))
const CREDENTIAL_STORE_SOURCE = readFileSync(
  join(__dirname, '..', 'dashboard', 'api', '_lib', 'credentialStore.js'), 'utf-8'
)

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
async function run(name, fn) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  } finally {
    _resetRedisClientForTests()
  }
}

// A key-respecting in-memory Redis stand-in -- unlike a single-value fake,
// this is essential here: Phase 4A's whole point is that EACH tenant has
// its OWN key, so a fake that ignores the key argument could never
// actually prove two tenants' credentials are isolated from each other.
// Values are stored exactly as the real client would (JSON strings, not
// pre-parsed), so parseRecord()'s JSON.parse path is genuinely exercised.
function fakeRedis(initial = {}) {
  const store = { ...initial }
  return {
    get: async (key) => (key in store ? store[key] : null),
    set: async (key, value) => { store[key] = value },
    del: async (key) => { delete store[key] },
    // Multi-Tenant Phase 4I.2: faithfully emulates CREDENTIAL_CAS_SCRIPT's
    // GET/compare-credentialVersion/SET logic -- correct because a plain
    // synchronous JS function body is trivially atomic with respect to any
    // other code in this single-threaded test process, exactly like the
    // real Lua script is atomic with respect to any other Redis client.
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [expectedVersionStr, nextJson] = args
      const raw = key in store ? store[key] : null
      let currentVersion = '0'
      if (raw) {
        try {
          const decoded = JSON.parse(raw)
          if (decoded && decoded.credentialVersion !== undefined) currentVersion = String(decoded.credentialVersion)
        } catch { /* malformed stored value -- treat as version 0, same as the real script */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = nextJson
      return true
    },
    _store: store,
  }
}

async function testGetReturnsNullWhenNeverConnected() {
  _setRedisClientForTests(() => fakeRedis())
  const cred = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(cred === null, 'a never-connected tenant must return null, not throw or fabricate a value')
}

async function testUnconfiguredStoreThrows() {
  let threw = false
  try {
    await getStoredCredential(DEFAULT_TENANT_ID)
  } catch (err) {
    threw = err instanceof CredentialStoreUnavailableError
  }
  assert(threw, 'an unconfigured store must throw CredentialStoreUnavailableError, never silently report "not connected"')
}

async function testSetThenGetRoundTripsTheRefreshToken() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'super-secret-refresh-token', connectedAccountName: 'Los Tres Amigos' })
  const cred = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(cred.refreshToken === 'super-secret-refresh-token', 'the exact refresh token must round-trip through encrypt/decrypt')
  assert(cred.connectedAccountName === 'Los Tres Amigos')
  assert(cred.health === GoogleHealth.CONNECTED, 'a freshly connected credential must be health: connected')
  assert(typeof cred.connectedAt === 'string' && typeof cred.lastOAuthRefreshAt === 'string')
}

async function testStoredValueNeverContainsThePlaintextToken() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'super-secret-refresh-token', connectedAccountName: null })
  // Los Tres Amigos is pinned to LEGACY mode (Phase 4C), so its record
  // lives under the literal gbp_credentials:v1 key, not credentialKeyV2().
  const raw = client._store[LEGACY_V1_KEY]
  assert(!raw.includes('super-secret-refresh-token'), 'the raw stored value must never contain the plaintext refresh token')
  assert(raw.includes('refreshTokenCiphertext'), 'the stored value must carry the encrypted form')
}

async function testStoredValueForACutoverTenantNeverContainsThePlaintextToken() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential(SYNTHETIC_TENANT_ID, { refreshToken: 'tenant-b-secret-token', connectedAccountName: null })
  // A non-default (CUTOVER-mode) tenant still uses its own v2 key.
  const raw = client._store[credentialKeyV2(SYNTHETIC_TENANT_ID)]
  assert(!raw.includes('tenant-b-secret-token'), 'the raw stored value must never contain the plaintext refresh token')
  assert(raw.includes('refreshTokenCiphertext'), 'the stored value must carry the encrypted form')
}

async function testWrongEncryptionKeyFailsClosedNotThrow() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'super-secret-refresh-token', connectedAccountName: null })

  const original = process.env.CREDENTIAL_ENCRYPTION_KEY
  process.env.CREDENTIAL_ENCRYPTION_KEY = 'a-completely-different-key'
  try {
    const cred = await getStoredCredential(DEFAULT_TENANT_ID)
    assert(cred.refreshToken === null, 'a wrong encryption key must never return a garbage/wrong token')
    assert(cred.health === GoogleHealth.AUTH_FAILED, 'a decryption failure must surface as an auth_failed health state, not an unhandled exception')
  } finally {
    process.env.CREDENTIAL_ENCRYPTION_KEY = original
  }
}

async function testMissingEncryptionKeyThrowsOnSet() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const original = process.env.CREDENTIAL_ENCRYPTION_KEY
  delete process.env.CREDENTIAL_ENCRYPTION_KEY
  try {
    let threw = false
    try {
      await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'x', connectedAccountName: null })
    } catch (err) {
      threw = err instanceof CredentialEncryptionKeyMissingError
    }
    assert(threw, 'setStoredCredential must throw a distinct, named error when CREDENTIAL_ENCRYPTION_KEY is missing')
  } finally {
    process.env.CREDENTIAL_ENCRYPTION_KEY = original
  }
}

async function testRecordSyncOutcomeSuccessRestoresConnectedHealth() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'x', connectedAccountName: null })
  await recordSyncOutcome(DEFAULT_TENANT_ID, { success: false, reason: 'invalid_grant', errorDescription: 'Token has been expired or revoked.' })
  let cred = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(cred.health === GoogleHealth.TOKEN_REVOKED, 'a failed sync must flip health away from connected')

  await recordSyncOutcome(DEFAULT_TENANT_ID, { success: true })
  cred = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(cred.health === GoogleHealth.CONNECTED, 'a subsequent successful sync must restore health: connected')
  assert(typeof cred.lastSuccessfulSyncAt === 'string')
  assert(cred.lastFailureReason === null, 'a successful sync must clear the prior failure reason')
}

async function testRecordSyncOutcomeFailureMapsRevokedVsExpired() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'x', connectedAccountName: null })

  await recordSyncOutcome(DEFAULT_TENANT_ID, { success: false, reason: 'invalid_grant', errorDescription: 'Token has expired.' })
  let cred = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(cred.health === GoogleHealth.TOKEN_EXPIRED, `expected token_expired for "Token has expired.", got ${cred.health}`)

  await recordSyncOutcome(DEFAULT_TENANT_ID, { success: false, reason: 'invalid_grant', errorDescription: 'Token has been revoked.' })
  cred = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(cred.health === GoogleHealth.TOKEN_REVOKED, `expected token_revoked for "Token has been revoked.", got ${cred.health}`)

  await recordSyncOutcome(DEFAULT_TENANT_ID, { success: false, reason: 'network_error', errorDescription: 'ECONNRESET' })
  cred = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(cred.health === GoogleHealth.AUTH_FAILED, `a non-token-specific failure must map to auth_failed, got ${cred.health}`)
}

async function testRecordSyncOutcomeIsANoOpWhenNeverConnected() {
  _setRedisClientForTests(() => fakeRedis())
  await recordSyncOutcome(DEFAULT_TENANT_ID, { success: false, reason: 'invalid_grant' }) // must not throw
  const cred = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(cred === null, 'recording an outcome with no stored credential must not fabricate one')
}

async function testRecordOAuthRefreshUpdatesTimestampIndependently() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'x', connectedAccountName: null })
  const before = (await getStoredCredential(DEFAULT_TENANT_ID)).lastOAuthRefreshAt
  await new Promise(resolve => setTimeout(resolve, 5))
  await recordOAuthRefresh(DEFAULT_TENANT_ID)
  const after = (await getStoredCredential(DEFAULT_TENANT_ID)).lastOAuthRefreshAt
  assert(after !== before, 'recordOAuthRefresh must update lastOAuthRefreshAt')
}

async function testClearStoredCredentialRemovesItCompletely() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'x', connectedAccountName: 'Los Tres Amigos' })
  await clearStoredCredential(DEFAULT_TENANT_ID)
  const cred = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(cred === null, 'after clearStoredCredential, a fresh connect must look indistinguishable from never having connected')
}

// --- Health classification (Phase 8: 429/RESOURCE_EXHAUSTED quota block) --
// Production incident, project 786038057684: Settings -> Google Business
// Profile was showing "Authentication Failed" (and recommending Reconnect)
// for a genuine Google Cloud project-level quota block, discovered via a
// live Test Connection run whose "accounts" check returned the exact
// Google error: "Quota exceeded for quota metric 'Requests' and limit
// 'Requests per minute' of service 'mybusinessaccountmanagement.googleapis.com'
// for consumer 'project_number:786038057684'." These tests lock in the
// four distinct classifications the fix requires so none of them can
// silently regress into the wrong bucket again.

async function testUnauthorizedReasonMapsToAuthFailed() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'x', connectedAccountName: null })
  await recordSyncOutcome(DEFAULT_TENANT_ID, { success: false, reason: 'unauthorized', errorDescription: 'Request had invalid authentication credentials.' })
  const cred = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(cred.health === GoogleHealth.AUTH_FAILED, `a 401 (reason: unauthorized) must map to auth_failed, got ${cred.health}`)
}

async function testInvalidGrantMapsToExpiredOrRevoked() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'x', connectedAccountName: null })
  await recordSyncOutcome(DEFAULT_TENANT_ID, { success: false, reason: 'invalid_grant', errorDescription: 'Token has been expired or revoked.' })
  const cred = await getStoredCredential(DEFAULT_TENANT_ID)
  assert([GoogleHealth.TOKEN_EXPIRED, GoogleHealth.TOKEN_REVOKED].includes(cred.health),
    `invalid_grant must map to token_expired or token_revoked, got ${cred.health}`)
}

async function testPermissionDeniedReasonMapsToAuthFailed() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'x', connectedAccountName: null })
  await recordSyncOutcome(DEFAULT_TENANT_ID, { success: false, reason: 'permission_denied', errorDescription: 'The caller does not have permission.' })
  const cred = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(cred.health === GoogleHealth.AUTH_FAILED, `a 403 (reason: permission_denied) must map to auth_failed, got ${cred.health}`)
}

async function testQuotaExceededReasonMapsToQuotaBlockedNotAuthFailed() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'x', connectedAccountName: null })
  await recordSyncOutcome(DEFAULT_TENANT_ID, {
    success: false, reason: 'quota_exceeded',
    errorDescription: "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute' of service 'mybusinessaccountmanagement.googleapis.com' for consumer 'project_number:786038057684'.",
  })
  const cred = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(cred.health === GoogleHealth.QUOTA_BLOCKED, `429/RESOURCE_EXHAUSTED (reason: quota_exceeded) must map to its own quota_blocked state, never auth_failed, got ${cred.health}`)
  assert(cred.health !== GoogleHealth.AUTH_FAILED, 'quota_blocked must be a genuinely distinct state from auth_failed')
}

function testIsQuotaExceededErrorDetectsBothSignals() {
  assert(isQuotaExceededError(429, {}) === true, 'a bare HTTP 429 must be detected even with no parseable error body')
  assert(isQuotaExceededError(200, { error: { status: 'RESOURCE_EXHAUSTED' } }) === true,
    'error.status === RESOURCE_EXHAUSTED must be detected even if the HTTP status itself is somehow not 429')
  assert(isQuotaExceededError(403, { error: { status: 'PERMISSION_DENIED' } }) === false, 'a genuine 403/PERMISSION_DENIED must never be misdetected as quota')
  assert(isQuotaExceededError(401, {}) === false, 'a genuine 401 must never be misdetected as quota')
}

function testExtractQuotaProjectNumberParsesGooglesRealMessage() {
  const real = "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute' of service 'mybusinessaccountmanagement.googleapis.com' for consumer 'project_number:786038057684'."
  assert(extractQuotaProjectNumber(real) === '786038057684', `expected to parse the real project number, got ${extractQuotaProjectNumber(real)}`)
  assert(extractQuotaProjectNumber('some unrelated error text') === null, 'text with no project_number must return null, never a guessed value')
  assert(extractQuotaProjectNumber(undefined) === null, 'undefined input must return null, never throw')
}

async function testReadFailureThrowsUnavailable() {
  _setRedisClientForTests(() => ({ get: async () => { throw new Error('ECONNREFUSED fake-upstash-outage') } }))
  let threw = false
  try {
    await getStoredCredential(DEFAULT_TENANT_ID)
  } catch (err) {
    threw = err instanceof CredentialStoreUnavailableError
  }
  assert(threw, 'a Redis read failure must surface as CredentialStoreUnavailableError')
}

// ===========================================================================
// Multi-Tenant Phase 4A -- tenant-scoped credential storage
// ===========================================================================

// --- Tenant credential keys differ / cannot cross-write --------------------

function testTenantCredentialKeysDiffer() {
  const a = credentialKeyV2(DEFAULT_TENANT_ID)
  const b = credentialKeyV2(SYNTHETIC_TENANT_ID)
  assert(a !== b, 'two different tenants must never resolve to the same credential key')
  assert(a === `gbp_credentials:v2:${DEFAULT_TENANT_ID}`)
  assert(b === `gbp_credentials:v2:${SYNTHETIC_TENANT_ID}`)
}

async function testSavingTenantACredentialCannotOverwriteTenantB() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'lta-refresh-token', connectedAccountName: 'Los Tres Amigos' })
  await setStoredCredential(SYNTHETIC_TENANT_ID, { refreshToken: 'tenant-b-refresh-token', connectedAccountName: 'Tenant B Business' })

  const lta = await getStoredCredential(DEFAULT_TENANT_ID)
  const tenantB = await getStoredCredential(SYNTHETIC_TENANT_ID)
  assert(lta.refreshToken === 'lta-refresh-token', 'Tenant A must still have its own, unaltered refresh token')
  assert(tenantB.refreshToken === 'tenant-b-refresh-token', 'Tenant B must have its own, distinct refresh token')
  assert(lta.connectedAccountName === 'Los Tres Amigos')
  assert(tenantB.connectedAccountName === 'Tenant B Business')

  // Re-save Tenant B -- must not touch Tenant A's stored record at all.
  await setStoredCredential(SYNTHETIC_TENANT_ID, { refreshToken: 'tenant-b-rotated-token', connectedAccountName: 'Tenant B Business' })
  const ltaAfter = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(ltaAfter.refreshToken === 'lta-refresh-token', 'writing Tenant B\'s credential must never alter Tenant A\'s stored credential')
}

async function testLoadingTenantBNeverFallsBackToLegacyV1() {
  // A real, working v1 credential sits in Redis (as it does in
  // production) -- Tenant B (which never had one) must see NOTHING, not
  // the global credential, no matter how it's spelled.
  const client = fakeRedis({ [LEGACY_V1_KEY]: JSON.stringify({ refreshTokenCiphertext: 'x', refreshTokenIv: 'y', refreshTokenAuthTag: 'z', health: GoogleHealth.CONNECTED }) })
  _setRedisClientForTests(() => client)
  const cred = await getStoredCredential(SYNTHETIC_TENANT_ID)
  assert(cred === null, 'a tenant with no v2 credential must never fall back to the legacy global gbp_credentials:v1 key')
}

async function testDefaultTenantCorrectlyUsesLegacyV1UnderLegacyMode() {
  // Phase 4C supersedes Phase 4A's blanket "never touch v1" rule for the
  // one tenant explicitly pinned to LEGACY mode (Los Tres Amigos). Phase
  // 4A's original no-fallback design would have made Node (v2-only) and
  // the still-v1-only Python background pipeline permanently disagree
  // about whether LTA is connected -- a split-brain. The fix: LTA's
  // resolveCredentialKey() intentionally resolves to the literal v1 key,
  // so a real, pre-existing v1 credential (exactly what production holds
  // today) is read correctly, with zero migration and zero OAuth
  // reconnect required. This is a deliberate, reviewed reversal of the
  // old assumption, not a regression of it.
  // Hand-crafted ciphertext can't actually decrypt -- seed a REAL v1
  // record the same way the legacy pipeline would have produced one (via
  // this module's own encryption), simulating a fresh process reading a
  // pre-existing production record it did not itself just write.
  const seedClient = fakeRedis()
  _setRedisClientForTests(() => seedClient)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'legacy-production-refresh-token', connectedAccountName: 'Los Tres Amigos' })

  const client = fakeRedis({ [LEGACY_V1_KEY]: seedClient._store[LEGACY_V1_KEY] })
  _setRedisClientForTests(() => client)
  const cred = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(cred !== null, 'Los Tres Amigos (LEGACY mode) must correctly read its pre-existing gbp_credentials:v1 record')
  assert(cred.refreshToken === 'legacy-production-refresh-token', 'the pre-existing v1 refresh token must decrypt correctly')
  assert(cred.health === GoogleHealth.CONNECTED)
}

async function testCutoverTenantNeverFallsBackToLegacyV1EvenWhenV1HasData() {
  // The behavior Phase 4A actually wanted still holds -- just scoped to
  // any tenant NOT explicitly pinned to LEGACY (i.e. every real future
  // client). A real v1 credential sitting in Redis must never leak into
  // a CUTOVER-mode tenant's read, no matter how it's spelled.
  const client = fakeRedis({ [LEGACY_V1_KEY]: JSON.stringify({ refreshTokenCiphertext: 'x', refreshTokenIv: 'y', refreshTokenAuthTag: 'z', health: GoogleHealth.CONNECTED }) })
  _setRedisClientForTests(() => client)
  const cred = await getStoredCredential(SYNTHETIC_TENANT_ID)
  assert(cred === null, 'a CUTOVER-mode tenant must never automatically inherit the legacy v1 credential')
  assert(client._store[LEGACY_V1_KEY] !== undefined, 'the legacy v1 record must still exist, untouched, after this read')
}

async function testClearingLtaCorrectlyDeletesLegacyV1ButNeverTenantB() {
  // Los Tres Amigos's authoritative key IS gbp_credentials:v1 (LEGACY
  // mode), so disconnecting LTA correctly deletes it now -- that's the
  // point of pinning LTA to v1, not a gap. What must still never happen:
  // a CUTOVER-mode tenant's own (v2) credential is untouched by an LTA
  // disconnect, and an LTA disconnect must never reach into any other
  // tenant's key.
  const client = fakeRedis({ [LEGACY_V1_KEY]: JSON.stringify({ refreshTokenCiphertext: 'x', refreshTokenIv: 'y', refreshTokenAuthTag: 'z' }) })
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'lta-token', connectedAccountName: null })
  await setStoredCredential(SYNTHETIC_TENANT_ID, { refreshToken: 'tenant-b-token', connectedAccountName: null })

  await clearStoredCredential(DEFAULT_TENANT_ID)

  assert(await getStoredCredential(DEFAULT_TENANT_ID) === null, 'Tenant A (LTA) must be disconnected')
  assert(client._store[LEGACY_V1_KEY] === undefined, 'disconnecting LTA must delete gbp_credentials:v1 -- that key is LTA\'s authoritative record under LEGACY mode')
  const tenantB = await getStoredCredential(SYNTHETIC_TENANT_ID)
  assert(tenantB && tenantB.refreshToken === 'tenant-b-token', 'disconnecting Tenant A must never remove Tenant B\'s (CUTOVER-mode) credential')
}

async function testClearingCutoverTenantNeverTouchesLegacyV1OrLta() {
  const client = fakeRedis({ [LEGACY_V1_KEY]: JSON.stringify({ refreshTokenCiphertext: 'x', refreshTokenIv: 'y', refreshTokenAuthTag: 'z' }) })
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'lta-token', connectedAccountName: null })
  await setStoredCredential(SYNTHETIC_TENANT_ID, { refreshToken: 'tenant-b-token', connectedAccountName: null })

  await clearStoredCredential(SYNTHETIC_TENANT_ID)

  assert(await getStoredCredential(SYNTHETIC_TENANT_ID) === null, 'Tenant B must be disconnected')
  const lta = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(lta && lta.refreshToken === 'lta-token', 'disconnecting a CUTOVER-mode tenant must never remove LTA\'s (LEGACY-mode) credential')
}

async function testRecordSyncOutcomeAndRefreshStayWithinTheSameTenant() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'lta-token', connectedAccountName: null })
  await setStoredCredential(SYNTHETIC_TENANT_ID, { refreshToken: 'tenant-b-token', connectedAccountName: null })

  await recordSyncOutcome(SYNTHETIC_TENANT_ID, { success: false, reason: 'invalid_grant', errorDescription: 'Token has been revoked.' })
  const lta = await getStoredCredential(DEFAULT_TENANT_ID)
  const tenantB = await getStoredCredential(SYNTHETIC_TENANT_ID)
  assert(lta.health === GoogleHealth.CONNECTED, 'recording a failure for Tenant B must never affect Tenant A\'s health')
  assert(tenantB.health === GoogleHealth.TOKEN_REVOKED, 'the recorded failure must apply to the tenant it was recorded for')

  const beforeRefresh = lta.lastOAuthRefreshAt
  await recordOAuthRefresh(SYNTHETIC_TENANT_ID)
  const ltaAfter = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(ltaAfter.lastOAuthRefreshAt === beforeRefresh, 'a token refresh recorded for Tenant B must never update Tenant A\'s lastOAuthRefreshAt')
}

// --- Invalid tenant IDs fail closed -----------------------------------------

async function testInvalidTenantIdsFailClosedOnEveryFunction() {
  _setRedisClientForTests(() => fakeRedis())
  const badTenantIds = [null, undefined, '', 'not-a-tenant-id', 'T_LOS-TRES-AMIGOS', 123, {}, []]
  for (const bad of badTenantIds) {
    for (const [label, fn] of [
      ['getStoredCredential', () => getStoredCredential(bad)],
      ['setStoredCredential', () => setStoredCredential(bad, { refreshToken: 'x', connectedAccountName: null })],
      ['recordSyncOutcome', () => recordSyncOutcome(bad, { success: true })],
      ['recordOAuthRefresh', () => recordOAuthRefresh(bad)],
      ['clearStoredCredential', () => clearStoredCredential(bad)],
    ]) {
      let threw = false
      try {
        await fn()
      } catch (err) {
        threw = err instanceof TypeError
      }
      assert(threw, `${label}(${JSON.stringify(bad)}) must throw a TypeError -- invalid tenant ids must fail closed, never silently proceed`)
    }
  }
}

async function testValidationHappensBeforeAnyRedisCall() {
  // A client that would throw/blow up if actually invoked -- proves the
  // tenantId is rejected BEFORE the store ever tries to derive a key or
  // touch Redis, not merely before returning a result.
  const explosiveClient = {
    get: async () => { throw new Error('must never be called for an invalid tenantId') },
    set: async () => { throw new Error('must never be called for an invalid tenantId') },
    del: async () => { throw new Error('must never be called for an invalid tenantId') },
  }
  _setRedisClientForTests(() => explosiveClient)
  let threw = false
  try {
    await getStoredCredential('not-a-valid-tenant-id')
  } catch (err) {
    threw = err instanceof TypeError
  }
  assert(threw, 'an invalid tenantId must be rejected before any Redis call is attempted')
}

// ===========================================================================
// Multi-Tenant Phase 4C revision -- LEGACY credential mode, explicit review.
// These prove LEGACY is a narrow, reviewed, transitional mechanism for Los
// Tres Amigos ONLY -- never a general implicit fallback -- per each
// invariant the Phase 4C revision explicitly required be verified and
// tested.
// ===========================================================================

const OTHER_TENANT_IDS = [SYNTHETIC_TENANT_ID, 't_client-2', 't_another-tenant', 't_z']

function testOnlyTheExplicitlyRegisteredLtaTenantIsLegacy() {
  assert(getCredentialMigrationMode(DEFAULT_TENANT_ID) === CredentialMigrationMode.LEGACY,
    'Los Tres Amigos must be the LEGACY-mode tenant')
  for (const other of OTHER_TENANT_IDS) {
    assert(getCredentialMigrationMode(other) === CredentialMigrationMode.CUTOVER,
      `${other} must never be LEGACY -- only the one explicitly registered tenant may be`)
  }
}

async function testAnUnknownTenantCanNeverResolveV1() {
  // A real v1 record sits in Redis (as it does in production) -- every
  // tenant NOT explicitly registered as LEGACY must see nothing, no matter
  // how plausible-looking its id is.
  const client = fakeRedis({ [LEGACY_V1_KEY]: JSON.stringify({ refreshTokenCiphertext: 'x', refreshTokenIv: 'y', refreshTokenAuthTag: 'z', health: GoogleHealth.CONNECTED }) })
  _setRedisClientForTests(() => client)
  for (const unknown of OTHER_TENANT_IDS) {
    const cred = await getStoredCredential(unknown)
    assert(cred === null, `unknown tenant ${unknown} must never resolve to the legacy v1 credential`)
  }
  assert(client._store[LEGACY_V1_KEY] !== undefined, 'the legacy v1 record must remain untouched by any of these reads')
}

function testAnInvalidTenantCanNeverResolveV1() {
  for (const bad of [null, undefined, '', 'not-a-tenant-id', 'T_LOS-TRES-AMIGOS', 123, {}, []]) {
    let threw = false
    try {
      getCredentialMigrationMode(bad)
    } catch (err) {
      threw = err instanceof TypeError
    }
    assert(threw, `getCredentialMigrationMode(${JSON.stringify(bad)}) must throw before resolving any mode/key`)
  }
}

async function testAbsenceOfAV2CredentialNeverFallsBackToV1() {
  // No v2 key exists for this CUTOVER tenant at all (not merely empty) --
  // AND a real v1 record exists -- yet the read must still return null,
  // never silently substitute the legacy credential just because nothing
  // else was found.
  const client = fakeRedis({ [LEGACY_V1_KEY]: JSON.stringify({ refreshTokenCiphertext: 'x', refreshTokenIv: 'y', refreshTokenAuthTag: 'z', health: GoogleHealth.CONNECTED }) })
  _setRedisClientForTests(() => client)
  assert(client._store[credentialKeyV2(SYNTHETIC_TENANT_ID)] === undefined, 'sanity: no v2 record exists for this tenant')
  const cred = await getStoredCredential(SYNTHETIC_TENANT_ID)
  assert(cred === null, 'a missing v2 credential must never cause a fallback to v1')
}

function testMigrationModeCannotBeInfluencedByRedisContent() {
  // Structural: getCredentialMigrationMode takes ONLY a tenantId -- there
  // is no Redis client, no request, no env var it could read -- so it
  // cannot possibly vary based on what a key currently contains. Proven
  // two ways: the function's own arity, and that it returns the identical
  // answer whether or not a Redis client has even been configured.
  assert(getCredentialMigrationMode.length === 1, 'getCredentialMigrationMode must take exactly one argument (tenantId) -- no Redis/client parameter')
  _resetRedisClientForTests()  // no client configured at all
  const withoutClient = getCredentialMigrationMode(DEFAULT_TENANT_ID)
  _setRedisClientForTests(() => fakeRedis({ [LEGACY_V1_KEY]: 'anything, even garbage' }))
  const withClient = getCredentialMigrationMode(DEFAULT_TENANT_ID)
  assert(withoutClient === withClient, 'migration mode must be identical regardless of Redis state')
}

async function testTenantBCanNeverCauseTheResolverToReturnV1() {
  const client = fakeRedis({ [LEGACY_V1_KEY]: JSON.stringify({ refreshTokenCiphertext: 'x', refreshTokenIv: 'y', refreshTokenAuthTag: 'z' }) })
  _setRedisClientForTests(() => client)
  for (const tenantB of OTHER_TENANT_IDS) {
    await setStoredCredential(tenantB, { refreshToken: `${tenantB}-token`, connectedAccountName: null })
    assert(client._store[LEGACY_V1_KEY] !== undefined, `writing ${tenantB}'s credential must never delete/overwrite gbp_credentials:v1`)
    const readBack = await getStoredCredential(tenantB)
    assert(readBack.refreshToken === `${tenantB}-token`, `${tenantB} must read back its own credential, never LTA's v1 one`)
  }
  const lta = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(lta === null || lta.refreshToken !== undefined, 'sanity check only -- LTA path unaffected by the loop above')
}

function testNoRuntimeCodeOutsideTheResolverDirectlyAccessesLegacyV1() {
  // Source-scan (same discipline test_tenant_model.js already applies to
  // its own V1_TO_V2_KEY_MAP): the CREDENTIAL_KEY identifier -- the only
  // thing that resolves to the literal 'gbp_credentials:v1' string -- must
  // appear in exactly two places in this file: its own declaration, and
  // its single use inside resolveCredentialKey(). If a future edit ever
  // reads/writes CREDENTIAL_KEY from readRaw/writeRaw/clearStoredCredential
  // directly (bypassing resolveCredentialKey()), this test fails loudly.
  // Strip line comments first -- prose mentioning "CREDENTIAL_KEY" (e.g.
  // explaining why a branch never evaluates it) must not count as a code
  // reference; only actual identifier usage in executable source matters.
  const codeOnly = CREDENTIAL_STORE_SOURCE.split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n')
  const declarationMatches = codeOnly.match(/const CREDENTIAL_KEY = 'gbp_credentials:v1'/g) || []
  const allReferences = codeOnly.match(/\bCREDENTIAL_KEY\b/g) || []
  assert(declarationMatches.length === 1, 'expected exactly one CREDENTIAL_KEY declaration')
  assert(allReferences.length === 2,
    `CREDENTIAL_KEY must be referenced exactly twice in actual code (its declaration + resolveCredentialKey()'s one use) -- ` +
    `found ${allReferences.length}. Any other reference means some function is bypassing resolveCredentialKey().`)

  const resolveFnMatch = CREDENTIAL_STORE_SOURCE.match(/function resolveCredentialKey\(tenantId\) \{[\s\S]*?\n\}/)
  assert(resolveFnMatch, 'could not locate resolveCredentialKey() to verify its body')
  assert(resolveFnMatch[0].includes('CREDENTIAL_KEY'), 'resolveCredentialKey() itself must be the one place that references CREDENTIAL_KEY')
}

async function main() {
  await run('getStoredCredential returns null when never connected', testGetReturnsNullWhenNeverConnected)
  await run('an unconfigured store throws on read', testUnconfiguredStoreThrows)
  await run('set then get round-trips the exact refresh token', testSetThenGetRoundTripsTheRefreshToken)
  await run('the raw stored value never contains the plaintext token', testStoredValueNeverContainsThePlaintextToken)
  await run('the raw stored value for a CUTOVER-mode tenant never contains the plaintext token', testStoredValueForACutoverTenantNeverContainsThePlaintextToken)
  await run('a wrong encryption key fails closed (auth_failed), never throws or returns a garbage token', testWrongEncryptionKeyFailsClosedNotThrow)
  await run('a missing encryption key throws a distinct error on set', testMissingEncryptionKeyThrowsOnSet)
  await run('recordSyncOutcome: success restores connected health and clears the failure reason', testRecordSyncOutcomeSuccessRestoresConnectedHealth)
  await run('recordSyncOutcome: failure maps to token_expired vs token_revoked vs auth_failed correctly', testRecordSyncOutcomeFailureMapsRevokedVsExpired)
  await run('a 401 (reason: unauthorized) maps to auth_failed', testUnauthorizedReasonMapsToAuthFailed)
  await run('invalid_grant maps to token_expired or token_revoked', testInvalidGrantMapsToExpiredOrRevoked)
  await run('a 403 (reason: permission_denied) maps to auth_failed', testPermissionDeniedReasonMapsToAuthFailed)
  await run('a 429/RESOURCE_EXHAUSTED (reason: quota_exceeded) maps to quota_blocked, not auth_failed', testQuotaExceededReasonMapsToQuotaBlockedNotAuthFailed)
  await run('isQuotaExceededError detects both the HTTP-429 and error.status=RESOURCE_EXHAUSTED signals', testIsQuotaExceededErrorDetectsBothSignals)
  await run('extractQuotaProjectNumber parses the real production error message', testExtractQuotaProjectNumberParsesGooglesRealMessage)
  await run('recordSyncOutcome is a no-op (never fabricates a credential) when nothing is connected', testRecordSyncOutcomeIsANoOpWhenNeverConnected)
  await run('recordOAuthRefresh updates its timestamp independently of sync outcome', testRecordOAuthRefreshUpdatesTimestampIndependently)
  await run('clearStoredCredential removes the credential completely', testClearStoredCredentialRemovesItCompletely)
  await run('a Redis read failure surfaces as CredentialStoreUnavailableError', testReadFailureThrowsUnavailable)

  console.log('\n--- MULTI-TENANT PHASE 4A ---')
  await run('tenant credential keys differ between Tenant A and Tenant B', testTenantCredentialKeysDiffer)
  await run('saving Tenant A\'s credential cannot overwrite Tenant B\'s', testSavingTenantACredentialCannotOverwriteTenantB)
  await run('loading a synthetic Tenant B never falls back to gbp_credentials:v1', testLoadingTenantBNeverFallsBackToLegacyV1)
  console.log('\n--- MULTI-TENANT PHASE 4C -- credential migration mode (LEGACY/CUTOVER) ---')
  await run('Los Tres Amigos (LEGACY mode) correctly uses its pre-existing gbp_credentials:v1 record', testDefaultTenantCorrectlyUsesLegacyV1UnderLegacyMode)
  await run('a CUTOVER-mode tenant never falls back to gbp_credentials:v1, even when v1 has real data', testCutoverTenantNeverFallsBackToLegacyV1EvenWhenV1HasData)
  await run('disconnecting LTA correctly deletes gbp_credentials:v1 but never Tenant B\'s credential', testClearingLtaCorrectlyDeletesLegacyV1ButNeverTenantB)
  await run('disconnecting a CUTOVER-mode tenant never touches gbp_credentials:v1 or LTA\'s credential', testClearingCutoverTenantNeverTouchesLegacyV1OrLta)
  await run('recordSyncOutcome/recordOAuthRefresh stay strictly inside the tenant they were called for', testRecordSyncOutcomeAndRefreshStayWithinTheSameTenant)
  await run('invalid tenant ids fail closed (TypeError) on every public function', testInvalidTenantIdsFailClosedOnEveryFunction)
  await run('tenant validation happens before any Redis call is attempted', testValidationHappensBeforeAnyRedisCall)

  console.log('\n--- MULTI-TENANT PHASE 4C REVISION -- LEGACY mode invariants, explicitly verified ---')
  await run('only the explicitly registered LTA tenant is ever LEGACY-mode', testOnlyTheExplicitlyRegisteredLtaTenantIsLegacy)
  await run('an unknown tenant can never resolve gbp_credentials:v1', testAnUnknownTenantCanNeverResolveV1)
  await run('an invalid tenant can never resolve gbp_credentials:v1 (fails before resolving any mode)', testAnInvalidTenantCanNeverResolveV1)
  await run('absence of a v2 credential can never cause a fallback to gbp_credentials:v1', testAbsenceOfAV2CredentialNeverFallsBackToV1)
  await run('migration mode cannot be influenced by Redis content (structural + behavioral proof)', testMigrationModeCannotBeInfluencedByRedisContent)
  await run('Tenant B can never cause the resolver to return gbp_credentials:v1', testTenantBCanNeverCauseTheResolverToReturnV1)
  await run('no runtime code outside resolveCredentialKey() directly references gbp_credentials:v1', testNoRuntimeCodeOutsideTheResolverDirectlyAccessesLegacyV1)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
