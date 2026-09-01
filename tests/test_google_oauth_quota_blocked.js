// Regression tests for the GBP account-listing 429/RESOURCE_EXHAUSTED quota
// block (production incident, Google Cloud project 786038057684). Before
// this fix, GET /api/google/status treated ANY non-2xx response from
// mybusinessaccountmanagement.googleapis.com/v1/accounts identically --
// reason: 'api_error' -> health: auth_failed -- which showed "Authentication
// Failed" and recommended reconnecting for a genuine Google Cloud
// project-level quota block that reconnecting cannot fix. These tests drive
// the REAL status handler end-to-end (mocked fetch, no real Google/Upstash)
// and confirm:
//   - a 429 (with or without a parseable RESOURCE_EXHAUSTED body) is
//     classified as its own quota_blocked state, never auth_failed
//   - connected stays true (the refresh token and access-token exchange
//     both genuinely succeeded -- only the accounts call was blocked)
//   - the Google Cloud project number is extracted from Google's own error
//     text and returned to the frontend
//   - a genuine 403/401 at the same call site still correctly falls back to
//     auth_failed (this fix must not blur the two apart)
//
// Run directly: node tests/test_google_oauth_quota_blocked.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/google/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import {
  _setRedisClientForTests, _resetRedisClientForTests, setStoredCredential, getStoredCredential, GoogleHealth,
} from '../dashboard/api/_lib/credentialStore.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

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

function fakeCredentialRedis(initial = null) {
  let value = initial
  return { get: async () => value, set: async (_key, v) => { value = v }, del: async () => { value = null } }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{ userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner Person' }],
  })
}
const ownerToken = () => signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })

const REAL_QUOTA_MESSAGE = "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute' of service 'mybusinessaccountmanagement.googleapis.com' for consumer 'project_number:786038057684'."

async function invokeStatus(accountsResponse) {
  await setDirectory()
  const client = fakeCredentialRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential({ refreshToken: 'a-valid-refresh-token', connectedAccountName: 'Los Tres Amigos' })

  globalThis.fetch = async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'fresh-access-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/business.manage' }) }
    }
    if (url.includes('mybusinessaccountmanagement.googleapis.com')) {
      return accountsResponse
    }
    throw new Error(`unexpected fetch: ${url}`)
  }

  const req = { method: 'GET', query: { action: 'status' }, body: {}, headers: { cookie: `lta_session=${await ownerToken()}` } }
  const res = fakeRes()
  await handler(req, res)
  return { res, client }
}

// fetchWithRetry() (dashboard/api/google/_lib/http.js) calls
// res.headers.get('Retry-After') on any 429/5xx before giving up -- every
// fake accounts-endpoint response below needs a `headers` stub for
// exactly that reason, or fetchWithRetry itself throws and the failure
// gets masked as a generic caught exception instead of exercising the
// real r.ok/r.status classification logic these tests are for.
function fakeHeaders() {
  return { get: () => null }
}

async function testRealProduction429ResponseMapsToQuotaBlocked() {
  const { res } = await invokeStatus({
    ok: false, status: 429, headers: fakeHeaders(),
    json: async () => ({ error: { code: 429, message: REAL_QUOTA_MESSAGE, status: 'RESOURCE_EXHAUSTED' } }),
  })
  assert(res.statusCode === 200, `status is always 200 -- state carries the signal, got ${res.statusCode}`)
  assert(res.body.state === GoogleHealth.QUOTA_BLOCKED, `expected state quota_blocked, got ${res.body.state}`)
  assert(res.body.state !== GoogleHealth.AUTH_FAILED, 'a genuine 429/RESOURCE_EXHAUSTED must never surface as auth_failed')
  assert(res.body.error === REAL_QUOTA_MESSAGE, 'Google\'s own error message must be preserved verbatim')
}

async function testQuotaBlockKeepsConnectedTrue() {
  const { res, client } = await invokeStatus({
    ok: false, status: 429, headers: fakeHeaders(),
    json: async () => ({ error: { code: 429, message: REAL_QUOTA_MESSAGE, status: 'RESOURCE_EXHAUSTED' } }),
  })
  assert(res.body.connected === true,
    'the Google account connection itself must stay reported as connected -- the refresh token and access-token exchange both succeeded, only the accounts call was quota-blocked')
  const stored = JSON.parse(await client.get())
  assert(stored.health === GoogleHealth.QUOTA_BLOCKED, 'the persisted health must also be quota_blocked')
}

async function testQuotaProjectNumberIsExtractedAndReturned() {
  const { res } = await invokeStatus({
    ok: false, status: 429, headers: fakeHeaders(),
    json: async () => ({ error: { code: 429, message: REAL_QUOTA_MESSAGE, status: 'RESOURCE_EXHAUSTED' } }),
  })
  assert(res.body.quotaProjectNumber === '786038057684', `expected the real project number extracted from Google's message, got ${res.body.quotaProjectNumber}`)
}

async function testBareHttp429WithNoParseableBodyIsStillDetected() {
  // Google doesn't always return a body that matches the documented shape
  // -- the HTTP status code alone must be sufficient.
  const { res } = await invokeStatus({ ok: false, status: 429, headers: fakeHeaders(), json: async () => { throw new Error('not json') } })
  assert(res.body.state === GoogleHealth.QUOTA_BLOCKED, `a bare 429 with no parseable body must still map to quota_blocked, got ${res.body.state}`)
  assert(res.body.quotaProjectNumber === null, 'with no parseable error message, the project number must be null, never guessed')
}

async function testGenuine403StillMapsToAuthFailedNotQuota() {
  const { res } = await invokeStatus({
    ok: false, status: 403, headers: fakeHeaders(),
    json: async () => ({ error: { code: 403, message: 'The caller does not have permission.', status: 'PERMISSION_DENIED' } }),
  })
  assert(res.body.state === GoogleHealth.AUTH_FAILED, `a genuine 403 must still map to auth_failed, got ${res.body.state}`)
  assert(res.body.connected === false, 'a genuine 403 (not a quota block) must still report connected: false')
  assert(res.body.quotaProjectNumber === null, 'a non-quota failure must never carry a quotaProjectNumber')
}

async function testGenuine401StillMapsToAuthFailedNotQuota() {
  const { res } = await invokeStatus({
    ok: false, status: 401, headers: fakeHeaders(),
    json: async () => ({ error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }),
  })
  assert(res.body.state === GoogleHealth.AUTH_FAILED, `a genuine 401 must still map to auth_failed, got ${res.body.state}`)
  assert(res.body.connected === false)
}

async function main() {
  await run('the real production 429/RESOURCE_EXHAUSTED response maps to quota_blocked, never auth_failed', testRealProduction429ResponseMapsToQuotaBlocked)
  await run('a quota block keeps connected: true (the OAuth connection itself is fine)', testQuotaBlockKeepsConnectedTrue)
  await run('the Google Cloud project number is extracted from the live error and returned', testQuotaProjectNumberIsExtractedAndReturned)
  await run('a bare HTTP 429 with an unparseable body is still detected via the status code alone', testBareHttp429WithNoParseableBodyIsStillDetected)
  await run('a genuine 403 still maps to auth_failed, not quota_blocked', testGenuine403StillMapsToAuthFailedNotQuota)
  await run('a genuine 401 still maps to auth_failed, not quota_blocked', testGenuine401StillMapsToAuthFailedNotQuota)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
