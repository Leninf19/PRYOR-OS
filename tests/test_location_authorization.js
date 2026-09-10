// Full functional coverage for Commit 4 (server-side location
// authorization) of the Multi-Location Authentication & User Access System
// -- the tests referenced by comments in tests/test_authorization_matrix.js
// (that file's own character is registries/meta-tests/static assertions,
// not deep request-mocking for one endpoint's business logic) and by the
// milestone's own Phase 17 security-test list: cross-location API
// tampering, and the TOCTOU-gap fix in publish()'s fallback path.
//
// Mirrors test_publish_reply.js's mocking pattern exactly (fake credential
// Redis, fake publish-bridge Redis, fake global fetch) plus
// reviewLocationIndex.js's test-injection seam.
//
// Run directly: node tests/test_location_authorization.js

import bcrypt from 'bcryptjs'
import googleHandler from '../dashboard/api/google/[action].js'
import actionsHandler from '../dashboard/api/actions/[action].js'
import rewriteHandler from '../dashboard/api/rewrite.js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests as setCredentialRedis, setStoredCredential } from '../dashboard/api/_lib/credentialStore.js'
import { _setRedisClientForTests as setBridgeRedis, _resetRedisClientForTests as resetBridgeRedis, writePublishBridge } from '../dashboard/api/_lib/publishBridgeStore.js'
import { _setReviewLocationIndexForTests, _resetReviewLocationIndexForTests } from '../dashboard/api/_lib/reviewLocationIndex.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

function fakeCredentialRedis(initial = null) {
  let value = initial
  return {
    get: async () => value,
    set: async (_key, v) => { value = v },
    del: async () => { value = null },
    // Multi-Tenant Phase 4I.2: recordSyncOutcome()/recordOAuthRefresh() now
    // write via a CAS EVAL, not a plain set() -- see credentialStore.js's
    // CREDENTIAL_CAS_SCRIPT. Faithfully emulated here (single-threaded JS,
    // so trivially atomic).
    eval: async (_script, _keys, args) => {
      const [expectedVersionStr, nextJson] = args
      let currentVersion = '0'
      if (value) {
        try {
          const decoded = JSON.parse(value)
          if (decoded && decoded.credentialVersion !== undefined) currentVersion = String(decoded.credentialVersion)
        } catch { /* treat as version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return value ?? false
      value = nextJson
      return true
    },
  }
}
const credentialClient = fakeCredentialRedis()
setCredentialRedis(() => credentialClient) // same instance every call -- getClient() has no caching for the test-factory path
await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'fake-refresh-token', connectedAccountName: null })

function fakeBridgeRedis(initial = {}) {
  const store = { ...initial }
  return {
    set: async (key, value) => { store[key] = value },
    mget: async (...keys) => keys.map(k => store[k] ?? null),
    del: async (key) => { delete store[key] },
    _store: store,
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
async function run(name, fn) {
  const bridgeClient = fakeBridgeRedis()
  setBridgeRedis(() => bridgeClient) // same instance across every call within this one test
  try {
    await fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  } finally {
    resetBridgeRedis()
    _resetReviewLocationIndexForTests()
    delete process.env.ANTHROPIC_API_KEY
  }
}

async function seedDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false },
      { userId: 'usr_lm', email: 'lm@example.com', passwordHash: hash, role: 'location_manager', locationIds: [7], sessionVersion: 1, disabled: false },
      { userId: 'usr_ro', email: 'ro@example.com', passwordHash: hash, role: 'read_only', locationIds: [7], sessionVersion: 1, disabled: false },
    ],
  })
}

async function lmToken() {
  return signSession({ userId: 'usr_lm', email: 'lm@example.com', role: 'location_manager', locationIds: [7], tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
}
async function roToken() {
  return signSession({ userId: 'usr_ro', email: 'ro@example.com', role: 'read_only', locationIds: [7], tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
}

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}

async function publish(body, token, fetchImpl) {
  globalThis.fetch = fetchImpl ?? (async () => { throw new Error('fetch must not be called') })
  const res = fakeRes()
  await googleHandler({ method: 'POST', query: { action: 'publish' }, body, headers: { cookie: `lta_session=${token}` } }, res)
  return res
}

const successFetch = async (url) => {
  if (url.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'fake-token' }) }
  if (url.endsWith('/reply')) return { ok: true, status: 200, json: async () => ({}) }
  throw new Error(`unexpected fetch: ${url}`)
}

// --- publish(): location-scoped success/denial -----------------------------

async function testLocationManagerCanPublishForOwnLocationViaReviewName() {
  await seedDirectory()
  _setReviewLocationIndexForTests({ 'accounts/1/locations/7/reviews/1': 7 })
  const res = await publish(
    { reviewName: 'accounts/1/locations/7/reviews/1', replyText: 'Thank you!', localReviewId: 'r1' },
    await lmToken(), successFetch,
  )
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testLocationManagerDeniedForForeignLocationReviewNoFetchAttempted() {
  await seedDirectory()
  _setReviewLocationIndexForTests({ 'accounts/1/locations/99/reviews/1': 99 }) // not in usr_lm's [7] grant
  const res = await publish(
    { reviewName: 'accounts/1/locations/99/reviews/1', replyText: 'Thank you!' },
    await lmToken(), // no fetchImpl -- the default throws if called at all
  )
  assert(res.statusCode === 404, `expected 404 (existence-hiding, never 403), got ${res.statusCode}`)
}

// TOCTOU regression: even with a legitimate own-location localReviewId, a
// scoped caller MUST NOT be able to reach the fuzzy locationName/reviewerName
// fallback path -- that path resolves the actual write target by a
// server-side name-match against Google's live location list, which is
// never cross-checked against the review the authorization check verified.
// See google/[action].js's publish() comment for the full explanation.
async function testLocationManagerCannotUseFuzzyFallbackEvenWithOwnLocationId() {
  await seedDirectory()
  _setReviewLocationIndexForTests({ 'r-own': 7 })
  const res = await publish(
    { locationName: 'Some Other Location Entirely', reviewerName: 'Jane Doe', replyText: 'Thank you!', localReviewId: 'r-own' },
    await lmToken(), // no fetchImpl -- must be rejected before any GBP lookup
  )
  assert(res.statusCode === 400 && res.body.error === 'review_name_required', `a scoped caller must be rejected before the fuzzy-match fallback ever runs, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testReadOnlyDeniedEntirelyNoFetchAttempted() {
  await seedDirectory()
  const res = await publish(
    { reviewName: 'accounts/1/locations/7/reviews/1', replyText: 'Thank you!' },
    await roToken(),
  )
  assert(res.statusCode === 403, `read_only holds neither REPLY nor REPLY_ASSIGNED, expected 403, got ${res.statusCode}`)
}

// --- publish-bridge: bulk read filtered by location -------------------------

async function testPublishBridgeBulkReadFiltersForeignLocationRecords() {
  await seedDirectory()
  await writePublishBridge(DEFAULT_TENANT_ID, 'mine', { gbpReviewName: 'accounts/1/locations/7/reviews/1', responseText: 'x', locationName: null, reviewerName: null, reviewDate: null })
  await writePublishBridge(DEFAULT_TENANT_ID, 'foreign', { gbpReviewName: 'accounts/1/locations/99/reviews/1', responseText: 'x', locationName: null, reviewerName: null, reviewDate: null })
  _setReviewLocationIndexForTests({ mine: 7, foreign: 99 })

  const res = fakeRes()
  await googleHandler({ method: 'POST', query: { action: 'publish-bridge' }, body: { ids: ['mine', 'foreign'] }, headers: { cookie: `lta_session=${await lmToken()}` } }, res)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.bridges.mine, 'the account\'s own location\'s bridge record must be present')
  assert(!res.body.bridges.foreign, 'a foreign location\'s bridge record must never be leaked, even in a bulk read')
}

// --- direct API tampering: a scoped caller cannot expand access by editing
// the request body directly (simulates a Postman/DevTools-style attack,
// not just "the UI never shows a foreign location's button") -----------------

async function testDirectApiTamperingWithAForeignLocationIdIsRejected() {
  await seedDirectory()
  _setReviewLocationIndexForTests({ 'foreign-review': 42 })
  // A caller who knows another location's review id and tries to act on it
  // directly, bypassing any UI -- must be denied server-side exactly the
  // same as the update()/preview/send-review-email paths.
  const res = fakeRes()
  await actionsHandler({
    method: 'POST', query: { action: 'update' },
    body: { id: 'foreign-review', patch: { status: 'Dismissed' } },
    headers: { cookie: `lta_session=${await lmToken()}` },
  }, res)
  assert(res.statusCode === 404, `direct API tampering with a foreign location's review id must be rejected (404), got ${res.statusCode}`)
}

// --- rewrite.js: optional localReviewId gates a scoped caller --------------

async function testRewriteDeniesScopedCallerWithoutLocalReviewId() {
  await seedDirectory()
  process.env.ANTHROPIC_API_KEY = 'fake-key'
  const res = fakeRes()
  await rewriteHandler({ method: 'POST', body: { tone: 'friendly', reviewText: 'x' }, headers: { cookie: `lta_session=${await lmToken()}` } }, res)
  assert(res.statusCode === 404, `a scoped caller omitting localReviewId must be denied (never treated as company-wide), got ${res.statusCode}`)
}

async function testRewriteAllowsScopedCallerWithOwnLocationReviewId() {
  await seedDirectory()
  process.env.ANTHROPIC_API_KEY = 'fake-key'
  _setReviewLocationIndexForTests({ 'r-own': 7 })
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: 'A generated reply.' }] }) })
  const res = fakeRes()
  await rewriteHandler({ method: 'POST', body: { tone: 'friendly', reviewText: 'x', localReviewId: 'r-own' }, headers: { cookie: `lta_session=${await lmToken()}` } }, res)
  assert(res.statusCode === 200, `a scoped caller with its own location's localReviewId must be allowed, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function main() {
  await run('publish(): location_manager can publish for its own location via reviewName', testLocationManagerCanPublishForOwnLocationViaReviewName)
  await run('publish(): location_manager denied (404) for a foreign location -- no GBP fetch attempted', testLocationManagerDeniedForForeignLocationReviewNoFetchAttempted)
  await run('publish(): TOCTOU regression -- fuzzy fallback rejected (400) even with a legitimate own-location localReviewId', testLocationManagerCannotUseFuzzyFallbackEvenWithOwnLocationId)
  await run('publish(): read_only denied entirely (403), no GBP fetch attempted', testReadOnlyDeniedEntirelyNoFetchAttempted)
  await run('publish-bridge: bulk read filters out foreign-location records', testPublishBridgeBulkReadFiltersForeignLocationRecords)
  await run('direct API tampering with a foreign location\'s review id is rejected server-side (404)', testDirectApiTamperingWithAForeignLocationIdIsRejected)
  await run('rewrite.js: a scoped caller omitting localReviewId is denied, never treated as company-wide', testRewriteDeniesScopedCallerWithoutLocalReviewId)
  await run('rewrite.js: a scoped caller with its own location\'s localReviewId is allowed', testRewriteAllowsScopedCallerWithOwnLocationReviewId)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
