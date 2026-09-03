// Regression tests for the TEMPORARY Phase 4M encryption-key-identity
// challenge-response mechanism:
//   - credentialStore.js's computeEncryptionKeyChallengeHmac()
//   - dashboard/api/_lib/encryptionKeyChallengeStore.js
//   - POST /api/google/verify-encryption-key-challenge (google/[action].js)
//
// Proves: Owner-only gating, the HTTP response NEVER carries either HMAC
// value or the nonce, the stored result record carries ONLY a boolean,
// and the match/mismatch classification is computed correctly. No real
// Upstash account anywhere in this file -- same fake-Redis pattern as
// test_credential_store.js/test_google_oauth_quota_blocked.js.
//
// This whole mechanism is TEMPORARY -- delete this test file alongside
// credentialStore.js's computeEncryptionKeyChallengeHmac export,
// encryptionKeyChallengeStore.js, google/[action].js's
// verifyEncryptionKeyChallenge action, and encryption_key_challenge_probe.py
// once the Phase 4M incident is resolved.
//
// Run directly: node tests/test_encryption_key_challenge.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'
// This endpoint is gated to platform owners ONLY (on top of an
// authenticated tenant Owner session) -- see google/[action].js's
// verifyEncryptionKeyChallenge(). Set for every test EXCEPT the dedicated
// "not a platform owner" gating test below, which deletes it temporarily.
process.env.PLATFORM_OWNER_EMAILS = 'owner@example.com'

import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/google/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import {
  computeEncryptionKeyChallengeHmac, EncryptionKeyChallengeError,
} from '../dashboard/api/_lib/credentialStore.js'
import {
  consumeChallenge, writeResult, EncryptionKeyChallengeStoreUnavailableError,
  _setRedisClientForTests, _resetRedisClientForTests,
} from '../dashboard/api/_lib/encryptionKeyChallengeStore.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'

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
    _resetLimiterFactoryForTests()
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

function fakeChallengeRedis(initial = {}) {
  const store = { ...initial }
  return {
    get: async (key) => (key in store ? store[key] : null),
    set: async (key, value) => { store[key] = typeof value === 'string' ? value : JSON.stringify(value) },
    del: async (key) => { delete store[key] },
    // Faithfully atomic here because a plain synchronous JS function body
    // is trivially atomic with respect to any other code in this
    // single-threaded test process -- same reasoning test_credential_store.js's
    // fakeRedis().eval() relies on for its own CAS emulation.
    getdel: async (key) => {
      const value = key in store ? store[key] : null
      delete store[key]
      return value
    },
    _store: store,
  }
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner Person' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Marketing Person' },
    ],
  })
}
const ownerToken = () => signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: 't_los-tres-amigos', sessionVersion: 1 })
const marketingToken = () => signSession({ userId: 'usr_marketing', email: 'marketing@example.com', role: 'marketing', locationIds: '*', tenantId: 't_los-tres-amigos', sessionVersion: 1 })

const REQUEST_ID = 'a'.repeat(32)

// ===========================================================================
// computeEncryptionKeyChallengeHmac (credentialStore.js)
// ===========================================================================

function testHmacRejectsMalformedNonce() {
  for (const bad of ['not-hex', 'ab', '', 'g'.repeat(64), null, undefined, 123]) {
    let threw = false
    try { computeEncryptionKeyChallengeHmac(bad) } catch (e) { threw = e instanceof EncryptionKeyChallengeError }
    assert(threw, `nonce ${JSON.stringify(bad)} must be rejected`)
  }
}

function testHmacIsDeterministicForSameKeyAndNonce() {
  const nonce = crypto.randomBytes(32).toString('hex')
  const a = computeEncryptionKeyChallengeHmac(nonce)
  const b = computeEncryptionKeyChallengeHmac(nonce)
  assert(a === b, 'the same key+nonce must always produce the same HMAC')
  assert(/^[0-9a-f]{64}$/.test(a), `expected a 64-char hex sha256 HMAC, got ${a}`)
}

function testHmacDiffersForDifferentEncryptionKeys() {
  const nonce = crypto.randomBytes(32).toString('hex')
  const original = process.env.CREDENTIAL_ENCRYPTION_KEY
  const a = computeEncryptionKeyChallengeHmac(nonce)
  process.env.CREDENTIAL_ENCRYPTION_KEY = 'a-completely-different-encryption-key'
  const b = computeEncryptionKeyChallengeHmac(nonce)
  process.env.CREDENTIAL_ENCRYPTION_KEY = original
  assert(a !== b, 'different encryption keys must produce different HMACs for the same nonce')
}

// ===========================================================================
// encryptionKeyChallengeStore.js
// ===========================================================================

async function testConsumeChallengeReturnsNullForMissingOrMalformedRequestId() {
  const client = fakeChallengeRedis()
  _setRedisClientForTests(() => client)
  assert(await consumeChallenge(REQUEST_ID) === null, 'a missing key must return null')
  assert(await consumeChallenge('not-32-hex-chars') === null, 'a malformed requestId must return null, never reach Redis with it')
}

async function testConsumeChallengeReturnsParsedRecordAndDeletesIt() {
  const key = `credential_key_challenge:${REQUEST_ID}`
  const client = fakeChallengeRedis({ [key]: JSON.stringify({ nonce: 'ab'.repeat(32), hmacGh: 'cd'.repeat(32) }) })
  _setRedisClientForTests(() => client)
  const record = await consumeChallenge(REQUEST_ID)
  assert(record.nonce === 'ab'.repeat(32) && record.hmacGh === 'cd'.repeat(32), 'must return the exact stored nonce/hmacGh')
  assert(!(key in client._store), 'consumeChallenge must delete the record atomically (single-use)')
  assert(await consumeChallenge(REQUEST_ID) === null, 'a second consume of the same requestId must find nothing')
}

async function testWriteResultStoresOnlyABoolean() {
  const client = fakeChallengeRedis()
  _setRedisClientForTests(() => client)
  await writeResult(REQUEST_ID, true)
  const stored = JSON.parse(client._store[`credential_key_challenge_result:${REQUEST_ID}`])
  assert(Object.keys(stored).length === 1 && stored.match === true, `result record must contain ONLY {match: true}, got ${JSON.stringify(stored)}`)
}

async function testWriteResultRejectsMalformedRequestId() {
  const client = fakeChallengeRedis()
  _setRedisClientForTests(() => client)
  let threw = false
  try { await writeResult('bad-id', true) } catch { threw = true }
  assert(threw, 'a malformed requestId must be rejected before any Redis write')
}

async function testStoreThrowsWhenUnconfigured() {
  _setRedisClientForTests(() => null)
  let threw = false
  try { await consumeChallenge(REQUEST_ID) } catch (e) { threw = e instanceof EncryptionKeyChallengeStoreUnavailableError }
  assert(threw, 'an unconfigured store must throw EncryptionKeyChallengeStoreUnavailableError, never silently report "no challenge"')
}

// ===========================================================================
// POST /api/google/verify-encryption-key-challenge (end to end)
// ===========================================================================

async function invoke(body, token) {
  await setDirectory()
  const client = fakeChallengeRedis(
    body?.__seed ? { [`credential_key_challenge:${body.requestId}`]: JSON.stringify(body.__seed) } : {}
  )
  _setRedisClientForTests(() => client)
  const req = { method: 'POST', query: { action: 'verify-encryption-key-challenge' }, body: { requestId: body?.requestId }, headers: { cookie: token ? `lta_session=${await token}` : '' } }
  const res = fakeRes()
  await handler(req, res)
  return { res, client }
}

async function testRequiresOwnerRole() {
  const nonce = crypto.randomBytes(32).toString('hex')
  const hmacGh = computeEncryptionKeyChallengeHmac(nonce)
  const { res } = await invoke({ requestId: REQUEST_ID, __seed: { nonce, hmacGh } }, marketingToken())
  assert(res.statusCode === 403, `a non-Owner role must be rejected with 403, got ${res.statusCode}`)
}

async function testRejectsUnauthenticated() {
  const { res } = await invoke({ requestId: REQUEST_ID }, null)
  assert(res.statusCode === 401, `no session must be rejected with 401, got ${res.statusCode}`)
}

// This diagnostic tests the single, application-wide
// CREDENTIAL_ENCRYPTION_KEY -- not anything scoped to the caller's own
// tenant -- so an ordinary tenant Owner is deliberately NOT sufficient;
// the caller's email must also be on the PLATFORM_OWNER_EMAILS allowlist.
async function testRejectsTenantOwnerNotOnPlatformOwnerAllowlist() {
  const original = process.env.PLATFORM_OWNER_EMAILS
  delete process.env.PLATFORM_OWNER_EMAILS // empty allowlist -- the production default today
  try {
    const nonce = crypto.randomBytes(32).toString('hex')
    const hmacGh = computeEncryptionKeyChallengeHmac(nonce)
    const { res } = await invoke({ requestId: REQUEST_ID, __seed: { nonce, hmacGh } }, ownerToken())
    assert(res.statusCode === 403, `an Owner not on PLATFORM_OWNER_EMAILS must be rejected with 403, got ${res.statusCode}`)
  } finally {
    process.env.PLATFORM_OWNER_EMAILS = original
  }
}

async function testMissingRequestIdIs400() {
  const { res } = await invoke({}, ownerToken())
  assert(res.statusCode === 400, `a missing requestId must be 400, got ${res.statusCode}`)
}

async function testMissingChallengeIs404() {
  const { res } = await invoke({ requestId: REQUEST_ID }, ownerToken())
  assert(res.statusCode === 404, `a missing/expired challenge must be 404, got ${res.statusCode}`)
}

async function testMatchingKeyWritesMatchTrueAndResponseCarriesNoSecretMaterial() {
  const nonce = crypto.randomBytes(32).toString('hex')
  const hmacGh = computeEncryptionKeyChallengeHmac(nonce) // same process env key -> same HMAC
  const { res, client } = await invoke({ requestId: REQUEST_ID, __seed: { nonce, hmacGh } }, ownerToken())
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(Object.keys(res.body).length === 1 && res.body.ok === true, `response must be exactly {ok: true}, got ${JSON.stringify(res.body)}`)
  const stored = JSON.parse(client._store[`credential_key_challenge_result:${REQUEST_ID}`])
  assert(stored.match === true, 'matching keys must record match: true')
  assert(!('nonce' in stored) && !('hmacGh' in stored) && !('hmacVercel' in stored), 'the result record must never carry the nonce or either HMAC')
}

async function testMismatchedKeyWritesMatchFalse() {
  const nonce = crypto.randomBytes(32).toString('hex')
  const foreignHmac = crypto.createHmac('sha256', crypto.createHash('sha256').update('a-totally-different-key').digest()).update(Buffer.from(nonce, 'hex')).digest('hex')
  const { res, client } = await invoke({ requestId: REQUEST_ID, __seed: { nonce, hmacGh: foreignHmac } }, ownerToken())
  assert(res.statusCode === 200)
  assert(res.body.ok === true, 'the HTTP response must stay {ok: true} regardless of match/mismatch -- classification is never echoed to the caller')
  const stored = JSON.parse(client._store[`credential_key_challenge_result:${REQUEST_ID}`])
  assert(stored.match === false, 'a genuinely different key must record match: false')
}

// ===========================================================================
// Single-use / replay prevention
// ===========================================================================

async function testChallengeIsSingleUseReplayIsRejected() {
  await setDirectory()
  const nonce = crypto.randomBytes(32).toString('hex')
  const hmacGh = computeEncryptionKeyChallengeHmac(nonce)
  const client = fakeChallengeRedis({ [`credential_key_challenge:${REQUEST_ID}`]: JSON.stringify({ nonce, hmacGh }) })
  _setRedisClientForTests(() => client)

  const firstReq = { method: 'POST', query: { action: 'verify-encryption-key-challenge' }, body: { requestId: REQUEST_ID }, headers: { cookie: `lta_session=${await ownerToken()}` } }
  const firstRes = fakeRes()
  await handler(firstReq, firstRes)
  assert(firstRes.statusCode === 200, `the first use must succeed, got ${firstRes.statusCode}: ${JSON.stringify(firstRes.body)}`)
  assert(!(`credential_key_challenge:${REQUEST_ID}` in client._store), 'the challenge record must be deleted (consumed) after a successful use')

  const secondRes = fakeRes()
  await handler(firstReq, secondRes)
  assert(secondRes.statusCode === 404, `replaying the SAME requestId must be rejected with 404, got ${secondRes.statusCode}`)
}

async function testConcurrentConsumeOfSameRequestIdOnlySucceedsOnce() {
  // Two "simultaneous" calls against the same underlying store -- proves
  // consumeChallenge()'s atomic GETDEL, not a separate get-then-del pair,
  // is what's actually being exercised (a naive get-then-del could let
  // both branches observe the record before either deletes it).
  await setDirectory()
  const nonce = crypto.randomBytes(32).toString('hex')
  const hmacGh = computeEncryptionKeyChallengeHmac(nonce)
  const client = fakeChallengeRedis({ [`credential_key_challenge:${REQUEST_ID}`]: JSON.stringify({ nonce, hmacGh }) })
  _setRedisClientForTests(() => client)

  const makeReq = async () => ({ method: 'POST', query: { action: 'verify-encryption-key-challenge' }, body: { requestId: REQUEST_ID }, headers: { cookie: `lta_session=${await ownerToken()}` } })
  const [reqA, reqB] = await Promise.all([makeReq(), makeReq()])
  const resA = fakeRes()
  const resB = fakeRes()
  await Promise.all([handler(reqA, resA), handler(reqB, resB)])

  const codes = [resA.statusCode, resB.statusCode].sort()
  assert(JSON.stringify(codes) === JSON.stringify([200, 404]), `exactly one concurrent consume must succeed (200) and the other must see it already gone (404), got ${JSON.stringify(codes)}`)
}

async function main() {
  await run('computeEncryptionKeyChallengeHmac rejects a malformed nonce', testHmacRejectsMalformedNonce)
  await run('computeEncryptionKeyChallengeHmac is deterministic for the same key+nonce', testHmacIsDeterministicForSameKeyAndNonce)
  await run('computeEncryptionKeyChallengeHmac differs for different encryption keys', testHmacDiffersForDifferentEncryptionKeys)
  await run('consumeChallenge returns null for a missing or malformed requestId', testConsumeChallengeReturnsNullForMissingOrMalformedRequestId)
  await run('consumeChallenge returns the exact stored nonce/hmacGh and deletes it (single-use)', testConsumeChallengeReturnsParsedRecordAndDeletesIt)
  await run('writeResult stores ONLY a boolean match field', testWriteResultStoresOnlyABoolean)
  await run('writeResult rejects a malformed requestId', testWriteResultRejectsMalformedRequestId)
  await run('an unconfigured store throws rather than silently reporting no challenge', testStoreThrowsWhenUnconfigured)
  await run('verify-encryption-key-challenge requires the Owner role', testRequiresOwnerRole)
  await run('verify-encryption-key-challenge rejects an unauthenticated request', testRejectsUnauthenticated)
  await run('a tenant Owner not on PLATFORM_OWNER_EMAILS is rejected with 403', testRejectsTenantOwnerNotOnPlatformOwnerAllowlist)
  await run('a missing requestId is 400', testMissingRequestIdIs400)
  await run('a missing/expired challenge is 404', testMissingChallengeIs404)
  await run('a matching encryption key writes match: true and the response carries no secret material', testMatchingKeyWritesMatchTrueAndResponseCarriesNoSecretMaterial)
  await run('a mismatched encryption key writes match: false', testMismatchedKeyWritesMatchFalse)
  await run('a challenge is single-use -- replaying the same requestId is rejected', testChallengeIsSingleUseReplayIsRejected)
  await run('two concurrent consumes of the same requestId: exactly one succeeds', testConcurrentConsumeOfSameRequestIdOnlySucceedsOnce)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  } else {
    console.log(`${results.filter((r) => !r).length} of ${results.length} TESTS FAILED`)
    process.exit(1)
  }
}

main()
