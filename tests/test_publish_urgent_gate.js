// Regression tests for the PART 7/8/13/14 server-authoritative safety gate
// added to dashboard/api/google/[action].js's publish(): a high-risk review
// (per reviewRiskClassifier.js's classifyReviewRisk()) can never be
// published without an explicit confirmedUrgent: true body field, and this
// is re-derived from the ORIGINAL review's own text on every call --
// never trusted from a client-echoed risk flag. Mirrors
// test_location_authorization.js's mocking pattern exactly (fake
// credential Redis, fake publish-bridge Redis, fake global fetch).
//
// Run directly: node tests/test_publish_urgent_gate.js

import bcrypt from 'bcryptjs'
import googleHandler from '../dashboard/api/google/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests as setCredentialRedis, setStoredCredential } from '../dashboard/api/_lib/credentialStore.js'
import { _setRedisClientForTests as setBridgeRedis, _resetRedisClientForTests as resetBridgeRedis } from '../dashboard/api/_lib/publishBridgeStore.js'
import { _setReviewLocationIndexForTests, _resetReviewLocationIndexForTests } from '../dashboard/api/_lib/reviewLocationIndex.js'
import { _setGbpLocationLinkMapForTests, _resetGbpLocationLinkMapForTests } from '../dashboard/api/_lib/gbpLocationAuthorization.js'
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
setCredentialRedis(() => credentialClient)
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
  setBridgeRedis(() => bridgeClient)
  _setGbpLocationLinkMapForTests({ 'accounts/1/locations/7': 7 })
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
    _resetGbpLocationLinkMapForTests()
  }
}

async function seedDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false },
    ],
  })
}

async function ownerToken() {
  return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
}

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}

async function publish(body, token, fetchImpl) {
  globalThis.fetch = fetchImpl ?? (async (url) => { throw new Error(`fetch must not be called, but was invoked for: ${url}`) })
  const res = fakeRes()
  await googleHandler({ method: 'POST', query: { action: 'publish' }, body, headers: { cookie: `lta_session=${token}` } }, res)
  return res
}

const successFetch = async (url) => {
  if (url.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'fake-token' }) }
  if (url.endsWith('/reply')) return { ok: true, status: 200, json: async () => ({}) }
  throw new Error(`unexpected fetch: ${url}`)
}

const REVIEW_NAME = 'accounts/1/locations/7/reviews/1'

// --- A high-risk review can never be published without confirmedUrgent ------

async function testHighRiskReviewWithoutConfirmationIsRejected() {
  await seedDirectory()
  _setReviewLocationIndexForTests({ [REVIEW_NAME]: 7 })
  const res = await publish(
    { reviewName: REVIEW_NAME, replyText: 'We take this seriously and will follow up.', localReviewId: 'r1', reviewText: 'I found glass in my food and got injured.' },
    await ownerToken(),
    // no fetchImpl -- publishing must be rejected before any GBP network call
  )
  assert(res.statusCode === 409, `expected 409, got ${res.statusCode} (${JSON.stringify(res.body)})`)
  assert(res.body.error === 'urgent_review_confirmation_required', `expected urgent_review_confirmation_required, got ${JSON.stringify(res.body)}`)
}

async function testHighRiskReviewWithConfirmationIsAllowed() {
  await seedDirectory()
  _setReviewLocationIndexForTests({ [REVIEW_NAME]: 7 })
  const res = await publish(
    { reviewName: REVIEW_NAME, replyText: 'We take this seriously and will follow up.', localReviewId: 'r1', reviewText: 'I found glass in my food and got injured.', confirmedUrgent: true },
    await ownerToken(), successFetch,
  )
  assert(res.statusCode === 200, `expected 200 once confirmed, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testConfirmedUrgentTruthyButNotBooleanTrueIsRejected() {
  await seedDirectory()
  _setReviewLocationIndexForTests({ [REVIEW_NAME]: 7 })
  // A truthy-but-not-strictly-true value (e.g. the string "true", as a
  // careless client might send) must still be rejected -- only the literal
  // boolean true counts as an explicit confirmation.
  const res = await publish(
    { reviewName: REVIEW_NAME, replyText: 'We take this seriously.', localReviewId: 'r1', reviewText: 'I found glass in my food.', confirmedUrgent: 'true' },
    await ownerToken(),
  )
  assert(res.statusCode === 409, `a non-boolean truthy confirmedUrgent must still be rejected, got ${res.statusCode}`)
}

// --- An ordinary (non-high-risk) review needs no confirmation at all --------

async function testOrdinaryReviewNeedsNoConfirmation() {
  await seedDirectory()
  _setReviewLocationIndexForTests({ [REVIEW_NAME]: 7 })
  const res = await publish(
    { reviewName: REVIEW_NAME, replyText: 'Thanks so much for the kind words!', localReviewId: 'r1', reviewText: 'Great food and service, we will be back!' },
    await ownerToken(), successFetch,
  )
  assert(res.statusCode === 200, `an ordinary review must publish without any confirmedUrgent field, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testNoReviewTextAtAllNeedsNoConfirmation() {
  await seedDirectory()
  _setReviewLocationIndexForTests({ [REVIEW_NAME]: 7 })
  const res = await publish(
    { reviewName: REVIEW_NAME, replyText: 'Thanks for the 5 stars!', localReviewId: 'r1' }, // no reviewText field at all
    await ownerToken(), successFetch,
  )
  assert(res.statusCode === 200, `a review with no text has nothing to classify as high risk, must publish normally, got ${res.statusCode}`)
}

// --- Server-authoritative: the gate re-derives risk from the review's own
// text on every call -- there is no client-supplied "risk"/"isHighRisk"
// field this endpoint even reads, so a caller cannot claim "not urgent" by
// sending a falsified flag alongside genuinely high-risk text. -------------

async function testClientCannotBypassByOmittingAnyRiskFlagField() {
  await seedDirectory()
  _setReviewLocationIndexForTests({ [REVIEW_NAME]: 7 })
  const res = await publish(
    {
      reviewName: REVIEW_NAME, replyText: 'We are looking into this.', localReviewId: 'r1',
      reviewText: 'The manager threatened me, this was a hostile and violent situation.',
      // Attempted spoof fields a naive client-trusting implementation might
      // have read instead of re-classifying server-side -- must have zero
      // effect either way.
      isHighRisk: false, riskLevel: 'normal', riskCategories: [],
    },
    await ownerToken(),
  )
  assert(res.statusCode === 409, `spoofed low-risk fields must never override the server's own re-classification of reviewText, got ${res.statusCode}`)
}

async function main() {
  await run('a high-risk review is rejected (409) without confirmedUrgent, no GBP fetch attempted', testHighRiskReviewWithoutConfirmationIsRejected)
  await run('a high-risk review is allowed once confirmedUrgent: true is sent', testHighRiskReviewWithConfirmationIsAllowed)
  await run('confirmedUrgent must be the literal boolean true, not merely truthy', testConfirmedUrgentTruthyButNotBooleanTrueIsRejected)
  await run('an ordinary (non-high-risk) review needs no confirmedUrgent at all', testOrdinaryReviewNeedsNoConfirmation)
  await run('a review with no text at all has nothing to flag, publishes normally', testNoReviewTextAtAllNeedsNoConfirmation)
  await run('a client cannot bypass the gate by sending spoofed low-risk fields alongside real high-risk text', testClientCannotBypassByOmittingAnyRiskFlagField)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
