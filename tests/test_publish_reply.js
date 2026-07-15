// Regression tests for dashboard/api/google/publish.js against a fully
// mocked global fetch -- no real network call, no real Google credentials,
// no real reply ever published. Covers both the preferred direct
// `reviewName` path and the legacy `locationName`+`reviewerName` fuzzy-match
// fallback (including the corrected account/location endpoint hosts and
// v4-path reconstruction fixed on 2026-07-15).
//
// Run directly: node tests/test_publish_reply.js

import handler from '../dashboard/api/google/publish.js'

process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'
process.env.GOOGLE_REFRESH_TOKEN = 'fake-refresh-token'

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}

async function invoke(body, fetchImpl) {
  globalThis.fetch = fetchImpl
  const res = fakeRes()
  await handler({ method: 'POST', body }, res)
  return res
}

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
  }
}

async function testDirectReviewNameSuccess() {
  const res = await invoke(
    { reviewName: 'accounts/123/locations/456/reviews/789', replyText: 'Thank you!' },
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
    { locationName: 'Casa Tequila Testtown', reviewerName: 'Jane Doe', replyText: 'Thanks Jane!' },
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

async function main() {
  await run('direct reviewName path: successful reply', testDirectReviewNameSuccess)
  await run('direct reviewName path: 403 maps to missing_permission', testDirectReviewNamePermissionDenied)
  await run('direct reviewName path: 404 maps to review_gone', testDirectReviewNameGone)
  await run('legacy locationName+reviewerName fallback resolves via the correct current API hosts', testLegacyFallbackPathResolvesCorrectHosts)
  await run('missing Google credentials returns 503 not_connected without any fetch', testMissingCredentialsReturns503)
  await run('missing replyText returns 400 without any fetch', testMissingReplyTextReturns400)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
