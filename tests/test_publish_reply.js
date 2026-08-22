// Regression tests for dashboard/api/google/publish.js against a fully
// mocked global fetch -- no real network call, no real Google credentials,
// no real reply ever published. Covers both the preferred direct
// `reviewName` path and the legacy `locationName`+`reviewerName` fuzzy-match
// fallback (including the corrected account/location endpoint hosts and
// v4-path reconstruction fixed on 2026-07-15).
//
// Run directly: node tests/test_publish_reply.js

import bcrypt from 'bcryptjs'
import googleHandler from '../dashboard/api/google/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests as _setCredentialRedisForTests, setStoredCredential } from '../dashboard/api/_lib/credentialStore.js'
import {
  _setRedisClientForTests as _setBridgeRedisForTests,
  _resetRedisClientForTests as _resetBridgeRedisForTests,
} from '../dashboard/api/_lib/publishBridgeStore.js'

// publish.js was merged into the consolidated dispatch file (Phase 8,
// Milestone 8.2) -- this wrapper keeps every call site below exactly as it
// read before the merge, just routing through req.query.action.
function handler(req, res) { return googleHandler({ ...req, query: { ...req.query, action: 'publish' } }, res) }

process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

// Phase 8, Milestone 8.7: the refresh token now lives in credentialStore.js
// (Redis), not GOOGLE_REFRESH_TOKEN -- a fake in-memory store, seeded with a
// connected credential, replaces the old env var for every test below.
function fakeCredentialRedis(initial = null) {
  let value = initial
  return { get: async () => value, set: async (_key, v) => { value = v }, del: async () => { value = null } }
}
const credentialClient = fakeCredentialRedis()
_setCredentialRedisForTests(() => credentialClient)
await setStoredCredential({ refreshToken: 'fake-refresh-token', connectedAccountName: null })

// Recovery Milestone 6B: publishBridgeStore.js's own Redis client -- a
// separate fake from the credential one above, matching the real app
// (both live in the same Upstash instance, but this test suite fakes each
// module's client independently so a bridge-specific test can simulate an
// outage there without disturbing the (already-working) credential store).
// A working fake is installed by default so every pre-existing test in
// this file (written before Milestone 6B) keeps getting the exact
// `{ success: true }` shape it already asserts -- those tests all now
// include `localReviewId` in their request bodies (below) so the write
// actually succeeds rather than hitting the bridgeWarning path.
function fakeBridgeRedis(initial = {}) {
  const store = { ...initial }
  return {
    set: async (key, value) => { store[key] = value },
    mget: async (...keys) => keys.map(k => store[k] ?? null),
    del: async (key) => { delete store[key] },
    _store: store,
  }
}

// publish.js now requires an authenticated Owner/Marketing session (Phase 1
// endpoint-authorization work) -- every test below authenticates as Owner
// first so the underlying publish logic these tests actually target is
// still exercised the same way it always was.
process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
  accounts: [{
    userId: 'usr_owner', email: 'owner@example.com',
    passwordHash: await bcrypt.hash('x', 12),
    role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false,
  }],
})
const AUTH_COOKIE = await signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', sessionVersion: 1 })

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}

async function invoke(body, fetchImpl) {
  globalThis.fetch = fetchImpl
  const res = fakeRes()
  await handler({ method: 'POST', body, headers: { cookie: `lta_session=${AUTH_COOKIE}` } }, res)
  return res
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
async function run(name, fn) {
  // A fresh, working bridge Redis client before every test -- tests that
  // want to simulate an unavailable/broken bridge store call
  // _setBridgeRedisForTests() themselves inside fn() to override this.
  _setBridgeRedisForTests(() => fakeBridgeRedis())
  try {
    await fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  } finally {
    _resetBridgeRedisForTests()
  }
}

async function testDirectReviewNameSuccess() {
  const res = await invoke(
    { reviewName: 'accounts/123/locations/456/reviews/789', replyText: 'Thank you!', localReviewId: 'r1' },
    async (url, opts) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'fake-token' }) }
      }
      if (url.endsWith('/reviews/789/reply')) {
        assert(opts.method === 'PUT', 'reply must be a PUT request')
        return { ok: true, status: 200, json: async () => ({}) }
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
  )
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.success === true, 'expected { success: true }')
}

async function testDirectReviewNamePermissionDenied() {
  const res = await invoke(
    { reviewName: 'accounts/123/locations/456/reviews/789', replyText: 'Thank you!' },
    async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'fake-token' }) }
      }
      if (url.endsWith('/reviews/789/reply')) {
        return { ok: false, status: 403, json: async () => ({ error: { message: 'The caller does not have permission' } }) }
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
  )
  assert(res.statusCode === 403, `expected 403, got ${res.statusCode}`)
  assert(res.body.error === 'missing_permission', `expected missing_permission, got ${res.body.error}`)
}

async function testDirectReviewNameGone() {
  const res = await invoke(
    { reviewName: 'accounts/123/locations/456/reviews/789', replyText: 'Thank you!' },
    async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'fake-token' }) }
      }
      if (url.endsWith('/reviews/789/reply')) {
        return { ok: false, status: 404, json: async () => ({ error: { message: 'Requested entity was not found' } }) }
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
  )
  assert(res.statusCode === 404, `expected 404, got ${res.statusCode}`)
  assert(res.body.error === 'review_gone', `expected review_gone, got ${res.body.error}`)
}

async function testLegacyFallbackPathResolvesCorrectHosts() {
  const calledUrls = []
  const res = await invoke(
    { locationName: 'Casa Tequila Testtown', reviewerName: 'Jane Doe', replyText: 'Thanks Jane!', localReviewId: 'r2' },
    async (url, opts) => {
      calledUrls.push(url)
      if (url.includes('oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'fake-token' }) }
      }
      if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) {
        return { ok: true, status: 200, json: async () => ({ accounts: [{ name: 'accounts/123', accountName: 'Test Account' }] }) }
      }
      if (url.startsWith('https://mybusinessbusinessinformation.googleapis.com/v1/accounts/123/locations')) {
        assert(url.includes('readMask='), 'locations.list must include the required readMask param')
        return { ok: true, status: 200, json: async () => ({ locations: [{ name: 'locations/456', title: 'Casa Tequila Testtown' }] }) }
      }
      if (url.startsWith('https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews') && !url.includes('/reply')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            reviews: [{ name: 'accounts/123/locations/456/reviews/999', reviewer: { displayName: 'Jane Doe' } }],
          }),
        }
      }
      if (url === 'https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews/999/reply') {
        assert(opts.method === 'PUT', 'reply must be a PUT request')
        return { ok: true, status: 200, json: async () => ({}) }
      }
      throw new Error(`unexpected fetch: ${url}`)
    }
  )
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
  assert(res.body.success === true, 'expected { success: true }')
  assert(calledUrls.some(u => u.includes('mybusinessaccountmanagement.googleapis.com')), 'must call the current account-listing host')
  assert(calledUrls.some(u => u.includes('mybusinessbusinessinformation.googleapis.com')), 'must call the current location-listing host')
  assert(!calledUrls.some(u => u.startsWith('https://mybusiness.googleapis.com/v4/accounts?') || u === 'https://mybusiness.googleapis.com/v4/accounts'),
    'must never call the deprecated v4 accounts endpoint')
}

async function testMissingCredentialsReturns503() {
  const savedId = process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_ID
  try {
    const res = await invoke({ reviewName: 'accounts/1/locations/2/reviews/3', replyText: 'x' }, async () => {
      throw new Error('fetch must not be called when credentials are missing')
    })
    assert(res.statusCode === 503, `expected 503, got ${res.statusCode}`)
    assert(res.body.error === 'not_connected', res.body.error)
  } finally {
    process.env.GOOGLE_CLIENT_ID = savedId
  }
}

async function testMissingReplyTextReturns400() {
  const res = await invoke({ reviewName: 'accounts/1/locations/2/reviews/3' }, async () => {
    throw new Error('fetch must not be called for an invalid request')
  })
  assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`)
}

// --- Response contract (Recovery Milestone 5: Reviews.jsx's handlePublish()
// only ever reads `res.ok` on success and `data.error`/`data.message` on
// failure -- it never inspects any other field. This locks that exact
// shape down so a backend response-shape change can never again silently
// leave the frontend's fetch() resolved-but-misread, or (the actual
// production incident this milestone fixes) waiting indefinitely on a
// request that already completed. ---------------------------------------

async function testSuccessResponseShapeIsExactlySuccessTrue() {
  const res = await invoke(
    { reviewName: 'accounts/1/locations/2/reviews/3', replyText: 'Thanks!', localReviewId: 'r3' },
    async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) }
      if (url.endsWith('/reply')) return { ok: true, status: 200, json: async () => ({}) }
      throw new Error(`unexpected fetch: ${url}`)
    }
  )
  assert(res.statusCode === 200, `success must be HTTP 200, got ${res.statusCode}`)
  assert(Object.keys(res.body).length === 1 && res.body.success === true,
    `success body must be exactly { success: true }, got ${JSON.stringify(res.body)}`)
}

async function testEveryFailureResponseHasErrorAndMessageStrings() {
  const scenarios = [
    ['missing replyText (400)', { reviewName: 'accounts/1/locations/2/reviews/3' }, async () => { throw new Error('no fetch expected') }],
    ['permission denied (403)', { reviewName: 'accounts/1/locations/2/reviews/3', replyText: 'x' }, async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) }
      return { ok: false, status: 403, json: async () => ({ error: { message: 'denied' } }) }
    }],
    ['review gone (404)', { reviewName: 'accounts/1/locations/2/reviews/3', replyText: 'x' }, async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) }
      return { ok: false, status: 404, json: async () => ({ error: { message: 'gone' } }) }
    }],
    ['unexpected 5xx from GBP (502)', { reviewName: 'accounts/1/locations/2/reviews/3', replyText: 'x' }, async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) }
      // fetchWithRetry retries 5xx up to 3 times -- always return 500 so it exhausts retries and returns the last response.
      return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) }
    }],
  ]
  for (const [label, body, fetchImpl] of scenarios) {
    const res = await invoke(body, fetchImpl)
    assert(res.statusCode >= 400, `${label}: expected an error status, got ${res.statusCode}`)
    assert(typeof res.body.error === 'string' && res.body.error.length > 0,
      `${label}: body.error must be a non-empty string, got ${JSON.stringify(res.body)}`)
    assert(typeof res.body.message === 'string' && res.body.message.length > 0,
      `${label}: body.message must be a non-empty string, got ${JSON.stringify(res.body)}`)
  }
}

async function testWrongHttpMethodReturns405WithConsistentShape() {
  const res = fakeRes()
  await handler({ method: 'GET', body: {}, headers: { cookie: `lta_session=${AUTH_COOKIE}` } }, res)
  assert(res.statusCode === 405, `expected 405, got ${res.statusCode}`)
  assert(res.body.error === 'method_not_allowed', `expected error code 'method_not_allowed', got ${JSON.stringify(res.body)}`)
  assert(typeof res.body.message === 'string' && res.body.message.length > 0, 'a 405 must also carry a message string')
}

// --- Recovery Milestone 6B: durable publish bridge (Part 1/2). ------------

function bridgeHandler(req, res) { return googleHandler({ ...req, query: { ...req.query, action: 'publish-bridge' } }, res) }

async function testBridgeIsWrittenAfterGoogleSuccessDirectPath() {
  const client = fakeBridgeRedis()
  _setBridgeRedisForTests(() => client)
  const res = await invoke(
    { reviewName: 'accounts/1/locations/2/reviews/42', replyText: 'Thanks so much!', localReviewId: 'r4', reviewDate: '2026-08-07' },
    async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) }
      if (url.endsWith('/reply')) return { ok: true, status: 200, json: async () => ({}) }
      throw new Error(`unexpected fetch: ${url}`)
    }
  )
  assert(res.statusCode === 200 && res.body.success === true, 'publish must still succeed')
  assert(!res.body.bridgeWarning, 'no bridgeWarning expected when the bridge write succeeds')
  const stored = JSON.parse(client._store['publish_bridge:v1:r4'])
  assert(stored.gbpReviewName === 'accounts/1/locations/2/reviews/42', 'bridge must record the resolved gbpReviewName')
  assert(stored.responseText === 'Thanks so much!', 'bridge must record the actual reply text')
  assert(stored.status === 'pending_google_reconciliation', 'a freshly written bridge is pending reconciliation')
  assert(stored.source === 'future_insights', 'bridge must record its own source')
}

async function testBridgeRecordsResolvedGbpReviewNameOnFallbackPath() {
  // The fallback (locationName+reviewerName) path only discovers the real
  // gbp_review_name AFTER matching the review server-side -- the bridge
  // must record THAT resolved identity, not something derived from the
  // request body (which never had it).
  const client = fakeBridgeRedis()
  _setBridgeRedisForTests(() => client)
  await invoke(
    { locationName: 'Casa Tequila Testtown', reviewerName: 'Jane Doe', replyText: 'Thanks Jane!', localReviewId: 'r5' },
    async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) }
      if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) {
        return { ok: true, status: 200, json: async () => ({ accounts: [{ name: 'accounts/123', accountName: 'Test' }] }) }
      }
      if (url.startsWith('https://mybusinessbusinessinformation.googleapis.com/v1/accounts/123/locations')) {
        return { ok: true, status: 200, json: async () => ({ locations: [{ name: 'locations/456', title: 'Casa Tequila Testtown' }] }) }
      }
      if (url.includes('/reviews') && !url.includes('/reply')) {
        return { ok: true, status: 200, json: async () => ({ reviews: [{ name: 'accounts/123/locations/456/reviews/999', reviewer: { displayName: 'Jane Doe' } }] }) }
      }
      if (url.endsWith('/reviews/999/reply')) return { ok: true, status: 200, json: async () => ({}) }
      throw new Error(`unexpected fetch: ${url}`)
    }
  )
  const stored = JSON.parse(client._store['publish_bridge:v1:r5'])
  assert(stored.gbpReviewName === 'accounts/123/locations/456/reviews/999',
    `bridge must record the SERVER-RESOLVED review identity, got ${stored.gbpReviewName}`)
}

async function testGoogleSuccessRedisFailureIsPartialSuccessNotFailure() {
  _setBridgeRedisForTests(() => ({
    set: async () => { throw new Error('Upstash unreachable') },
    mget: async (...keys) => keys.map(() => null),
    del: async () => {},
  }))
  const res = await invoke(
    { reviewName: 'accounts/1/locations/2/reviews/3', replyText: 'Thanks!', localReviewId: 'r6' },
    async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) }
      if (url.endsWith('/reply')) return { ok: true, status: 200, json: async () => ({}) }
      throw new Error(`unexpected fetch: ${url}`)
    }
  )
  assert(res.statusCode === 200, `Google already succeeded -- this must never be reported as a non-200 failure, got ${res.statusCode}`)
  assert(res.body.success === true, 'success:true must still be reported -- Google DID publish the reply')
  assert(res.body.bridgeWarning === true, 'bridgeWarning must be set so the frontend can show the reconciliation message')
  assert(!res.body.error, 'must never carry an error field -- this is not a failure')
}

async function testMissingLocalReviewIdStillSucceedsWithBridgeWarning() {
  const res = await invoke(
    { reviewName: 'accounts/1/locations/2/reviews/3', replyText: 'Thanks!' }, // no localReviewId at all
    async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) }
      if (url.endsWith('/reply')) return { ok: true, status: 200, json: async () => ({}) }
      throw new Error(`unexpected fetch: ${url}`)
    }
  )
  assert(res.statusCode === 200 && res.body.success === true, 'a caller not sending localReviewId must still get a successful publish')
  assert(res.body.bridgeWarning === true, 'nothing to key a bridge record by -- bridgeWarning must be set')
}

async function testGoogleFailureNeverWritesABridgeRecord() {
  const client = fakeBridgeRedis()
  _setBridgeRedisForTests(() => client)
  const res = await invoke(
    { reviewName: 'accounts/1/locations/2/reviews/3', replyText: 'Thanks!', localReviewId: 'r7' },
    async (url) => {
      if (url.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) }
      return { ok: false, status: 403, json: async () => ({ error: { message: 'denied' } }) }
    }
  )
  assert(res.statusCode === 403, `expected a failure status, got ${res.statusCode}`)
  assert(Object.keys(client._store).length === 0, 'a Google failure must never write a bridge record -- write only happens AFTER Google confirms success')
}

async function testBulkBridgeReadReturnsOnlyMatchingIds() {
  const client = fakeBridgeRedis()
  _setBridgeRedisForTests(() => client)
  await invoke({ reviewName: 'accounts/1/locations/2/reviews/9', replyText: 'Thanks!', localReviewId: 'r8' }, async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) }
    if (url.endsWith('/reply')) return { ok: true, status: 200, json: async () => ({}) }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const res = fakeRes()
  await bridgeHandler({ method: 'POST', body: { ids: ['r8', 'r-unknown'] }, headers: { cookie: `lta_session=${AUTH_COOKIE}` } }, res)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.bridges.r8 && res.body.bridges.r8.responseText === 'Thanks!', 'r8 must be present with its response text')
  assert(!('r-unknown' in res.body.bridges), 'an id with no bridge record must simply be absent')
}

async function testBulkBridgeReadRequiresAuth() {
  const res = fakeRes()
  await bridgeHandler({ method: 'POST', body: { ids: ['r1'] }, headers: {} }, res)
  assert(res.statusCode === 401 || res.statusCode === 403, `expected an auth failure status, got ${res.statusCode}`)
}

async function testBulkBridgeReadDegradesGracefullyWhenUnavailable() {
  _setBridgeRedisForTests(() => ({
    mget: async () => { throw new Error('Upstash unreachable') },
  }))
  const res = fakeRes()
  await bridgeHandler({ method: 'POST', body: { ids: ['r1'] }, headers: { cookie: `lta_session=${AUTH_COOKIE}` } }, res)
  assert(res.statusCode === 200, `an unavailable bridge store must degrade gracefully, not fail the whole request, got ${res.statusCode}`)
  assert(res.body.degraded === true, 'must flag degraded:true so callers know this result is incomplete, not authoritative')
}

async function main() {
  await run('direct reviewName path: successful reply', testDirectReviewNameSuccess)
  await run('direct reviewName path: 403 maps to missing_permission', testDirectReviewNamePermissionDenied)
  await run('direct reviewName path: 404 maps to review_gone', testDirectReviewNameGone)
  await run('legacy locationName+reviewerName fallback resolves via the correct current API hosts', testLegacyFallbackPathResolvesCorrectHosts)
  await run('missing Google credentials returns 503 not_connected without any fetch', testMissingCredentialsReturns503)
  await run('missing replyText returns 400 without any fetch', testMissingReplyTextReturns400)
  await run('success response shape is exactly { success: true }', testSuccessResponseShapeIsExactlySuccessTrue)
  await run('every failure response carries non-empty error + message strings', testEveryFailureResponseHasErrorAndMessageStrings)
  await run('a non-POST request returns 405 with the same error+message shape as every other failure', testWrongHttpMethodReturns405WithConsistentShape)
  await run('bridge is written after Google success (direct reviewName path)', testBridgeIsWrittenAfterGoogleSuccessDirectPath)
  await run('bridge records the server-resolved gbp_review_name on the fallback path', testBridgeRecordsResolvedGbpReviewNameOnFallbackPath)
  await run('Google success + Redis failure is partial success, never reported as a publish failure', testGoogleSuccessRedisFailureIsPartialSuccessNotFailure)
  await run('missing localReviewId still succeeds, with bridgeWarning set', testMissingLocalReviewIdStillSucceedsWithBridgeWarning)
  await run('a Google failure never writes a bridge record', testGoogleFailureNeverWritesABridgeRecord)
  await run('bulk bridge read returns only ids that have a record', testBulkBridgeReadReturnsOnlyMatchingIds)
  await run('bulk bridge read requires authentication', testBulkBridgeReadRequiresAuth)
  await run('bulk bridge read degrades gracefully (200, degraded:true) when the store is unavailable', testBulkBridgeReadDegradesGracefullyWhenUnavailable)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
