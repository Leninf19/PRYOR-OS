// Regression tests for dashboard/api/_lib/credentialStore.js -- the
// Google OAuth credential store (Phase 8, Milestone 8.7). No real Upstash
// account and no real Google credentials anywhere in this file: every test
// drives the module's test-only client-factory seam, same pattern as
// actionStore.js/contactStore.js/auditLog.js.
//
// Run directly: node tests/test_credential_store.js

process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'

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
  _setRedisClientForTests,
  _resetRedisClientForTests,
} from '../dashboard/api/_lib/credentialStore.js'

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

// A tiny in-memory stand-in for the single Redis key this module uses
// (get/set/del), storing the value exactly as the real client would --
// a JSON string, not pre-parsed, so parseRecord()'s JSON.parse path is
// genuinely exercised.
function fakeRedis(initial = null) {
  let value = initial
  return {
    get: async () => value,
    set: async (_key, v) => { value = v },
    del: async () => { value = null },
  }
}

async function testGetReturnsNullWhenNeverConnected() {
  _setRedisClientForTests(() => fakeRedis())
  const cred = await getStoredCredential()
  assert(cred === null, 'a never-connected store must return null, not throw or fabricate a value')
}

async function testUnconfiguredStoreThrows() {
  let threw = false
  try {
    await getStoredCredential()
  } catch (err) {
    threw = err instanceof CredentialStoreUnavailableError
  }
  assert(threw, 'an unconfigured store must throw CredentialStoreUnavailableError, never silently report "not connected"')
}

async function testSetThenGetRoundTripsTheRefreshToken() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential({ refreshToken: 'super-secret-refresh-token', connectedAccountName: 'Los Tres Amigos' })
  const cred = await getStoredCredential()
  assert(cred.refreshToken === 'super-secret-refresh-token', 'the exact refresh token must round-trip through encrypt/decrypt')
  assert(cred.connectedAccountName === 'Los Tres Amigos')
  assert(cred.health === GoogleHealth.CONNECTED, 'a freshly connected credential must be health: connected')
  assert(typeof cred.connectedAt === 'string' && typeof cred.lastOAuthRefreshAt === 'string')
}

async function testStoredValueNeverContainsThePlaintextToken() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential({ refreshToken: 'super-secret-refresh-token', connectedAccountName: null })
  const raw = await client.get()
  assert(!raw.includes('super-secret-refresh-token'), 'the raw stored value must never contain the plaintext refresh token')
  assert(raw.includes('refreshTokenCiphertext'), 'the stored value must carry the encrypted form')
}

async function testWrongEncryptionKeyFailsClosedNotThrow() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential({ refreshToken: 'super-secret-refresh-token', connectedAccountName: null })

  const original = process.env.CREDENTIAL_ENCRYPTION_KEY
  process.env.CREDENTIAL_ENCRYPTION_KEY = 'a-completely-different-key'
  try {
    const cred = await getStoredCredential()
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
      await setStoredCredential({ refreshToken: 'x', connectedAccountName: null })
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
  await setStoredCredential({ refreshToken: 'x', connectedAccountName: null })
  await recordSyncOutcome({ success: false, reason: 'invalid_grant', errorDescription: 'Token has been expired or revoked.' })
  let cred = await getStoredCredential()
  assert(cred.health === GoogleHealth.TOKEN_REVOKED, 'a failed sync must flip health away from connected')

  await recordSyncOutcome({ success: true })
  cred = await getStoredCredential()
  assert(cred.health === GoogleHealth.CONNECTED, 'a subsequent successful sync must restore health: connected')
  assert(typeof cred.lastSuccessfulSyncAt === 'string')
  assert(cred.lastFailureReason === null, 'a successful sync must clear the prior failure reason')
}

async function testRecordSyncOutcomeFailureMapsRevokedVsExpired() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential({ refreshToken: 'x', connectedAccountName: null })

  await recordSyncOutcome({ success: false, reason: 'invalid_grant', errorDescription: 'Token has expired.' })
  let cred = await getStoredCredential()
  assert(cred.health === GoogleHealth.TOKEN_EXPIRED, `expected token_expired for "Token has expired.", got ${cred.health}`)

  await recordSyncOutcome({ success: false, reason: 'invalid_grant', errorDescription: 'Token has been revoked.' })
  cred = await getStoredCredential()
  assert(cred.health === GoogleHealth.TOKEN_REVOKED, `expected token_revoked for "Token has been revoked.", got ${cred.health}`)

  await recordSyncOutcome({ success: false, reason: 'network_error', errorDescription: 'ECONNRESET' })
  cred = await getStoredCredential()
  assert(cred.health === GoogleHealth.AUTH_FAILED, `a non-token-specific failure must map to auth_failed, got ${cred.health}`)
}

async function testRecordSyncOutcomeIsANoOpWhenNeverConnected() {
  _setRedisClientForTests(() => fakeRedis())
  await recordSyncOutcome({ success: false, reason: 'invalid_grant' }) // must not throw
  const cred = await getStoredCredential()
  assert(cred === null, 'recording an outcome with no stored credential must not fabricate one')
}

async function testRecordOAuthRefreshUpdatesTimestampIndependently() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential({ refreshToken: 'x', connectedAccountName: null })
  const before = (await getStoredCredential()).lastOAuthRefreshAt
  await new Promise(resolve => setTimeout(resolve, 5))
  await recordOAuthRefresh()
  const after = (await getStoredCredential()).lastOAuthRefreshAt
  assert(after !== before, 'recordOAuthRefresh must update lastOAuthRefreshAt')
}

async function testClearStoredCredentialRemovesItCompletely() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential({ refreshToken: 'x', connectedAccountName: 'Los Tres Amigos' })
  await clearStoredCredential()
  const cred = await getStoredCredential()
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
  await setStoredCredential({ refreshToken: 'x', connectedAccountName: null })
  await recordSyncOutcome({ success: false, reason: 'unauthorized', errorDescription: 'Request had invalid authentication credentials.' })
  const cred = await getStoredCredential()
  assert(cred.health === GoogleHealth.AUTH_FAILED, `a 401 (reason: unauthorized) must map to auth_failed, got ${cred.health}`)
}

async function testInvalidGrantMapsToExpiredOrRevoked() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential({ refreshToken: 'x', connectedAccountName: null })
  await recordSyncOutcome({ success: false, reason: 'invalid_grant', errorDescription: 'Token has been expired or revoked.' })
  const cred = await getStoredCredential()
  assert([GoogleHealth.TOKEN_EXPIRED, GoogleHealth.TOKEN_REVOKED].includes(cred.health),
    `invalid_grant must map to token_expired or token_revoked, got ${cred.health}`)
}

async function testPermissionDeniedReasonMapsToAuthFailed() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential({ refreshToken: 'x', connectedAccountName: null })
  await recordSyncOutcome({ success: false, reason: 'permission_denied', errorDescription: 'The caller does not have permission.' })
  const cred = await getStoredCredential()
  assert(cred.health === GoogleHealth.AUTH_FAILED, `a 403 (reason: permission_denied) must map to auth_failed, got ${cred.health}`)
}

async function testQuotaExceededReasonMapsToQuotaBlockedNotAuthFailed() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential({ refreshToken: 'x', connectedAccountName: null })
  await recordSyncOutcome({
    success: false, reason: 'quota_exceeded',
    errorDescription: "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute' of service 'mybusinessaccountmanagement.googleapis.com' for consumer 'project_number:786038057684'.",
  })
  const cred = await getStoredCredential()
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
    await getStoredCredential()
  } catch (err) {
    threw = err instanceof CredentialStoreUnavailableError
  }
  assert(threw, 'a Redis read failure must surface as CredentialStoreUnavailableError')
}

async function main() {
  await run('getStoredCredential returns null when never connected', testGetReturnsNullWhenNeverConnected)
  await run('an unconfigured store throws on read', testUnconfiguredStoreThrows)
  await run('set then get round-trips the exact refresh token', testSetThenGetRoundTripsTheRefreshToken)
  await run('the raw stored value never contains the plaintext token', testStoredValueNeverContainsThePlaintextToken)
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

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
