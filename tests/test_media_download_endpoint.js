// Regression tests for dashboard/api/actions/[action].js's 'download-media'
// action -- the Review Media View/Download feature's authenticated,
// server-side proxy-download endpoint (GET /api/actions/download-media).
// Drives the real handler with a fake req/res, same pattern as
// test_actions_endpoint.js/test_send_review_email.js, controlling
// review->location resolution and the review's own stored media via
// reviewLocationIndex.js's/reviewMediaLookup.js's test-only seams. All
// outbound HTTP is mocked via globalThis.fetch -- this file never makes a
// real network call to Google or anywhere else.
//
// Run directly: node tests/test_media_download_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import handler from '../dashboard/api/actions/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setReviewLocationIndexForTests, _resetReviewLocationIndexForTests } from '../dashboard/api/_lib/reviewLocationIndex.js'
import { _setReviewMediaLookupTestData, _resetReviewMediaLookupTestData } from '../dashboard/api/_lib/reviewMediaLookup.js'
import { _setPrivateDataRootForTests, _resetPrivateDataRootsForTests } from '../dashboard/api/_lib/reviewDataPaths.js'
import { _setMediaFetchTimeoutForTests, _resetMediaFetchTimeoutForTests } from '../dashboard/api/_lib/reviewMediaFetch.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

const TENANT_B = 't_synthetic-media-tenant'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const originalFetch = globalThis.fetch
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
    _resetReviewLocationIndexForTests()
    _resetReviewMediaLookupTestData()
    _resetPrivateDataRootsForTests()
    _resetMediaFetchTimeoutForTests()
    _resetLimiterFactoryForTests()
    globalThis.fetch = originalFetch
    delete process.env.VERCEL_ENV
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.send = (body) => { res.body = body; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

async function invoke({ method = 'GET', token, query = {} }) {
  const req = {
    method,
    query: { action: 'download-media', ...query },
    body: {},
    headers: token ? { cookie: `lta_session=${token}` } : {},
    socket: {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

async function setDirectory() {
  const hash = await passwordHash()
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner Person' },
      { userId: 'usr_lm7', email: 'lm7@example.com', passwordHash: hash, role: 'location_manager', locationIds: [7], sessionVersion: 1, disabled: false, displayName: 'LM Seven' },
    ],
  })
}

async function ownerToken() {
  return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
}
async function lm7Token() {
  return signSession({ userId: 'usr_lm7', email: 'lm7@example.com', role: 'location_manager', locationIds: [7], tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
}

function makeHeaders(obj = {}) {
  const map = new Map(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (name) => (map.has(name.toLowerCase()) ? map.get(name.toLowerCase()) : null) }
}

function makeImageResponse({ status = 200, contentType = 'image/jpeg', bytes = new TextEncoder().encode('fake-jpeg-bytes'), extraHeaders = {} } = {}) {
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close() },
  })
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: makeHeaders({ 'content-type': contentType, 'content-length': String(bytes.length), ...extraHeaders }),
    body: stream,
  }
}

const VALID_REVIEW_MEDIA = [
  { type: 'photo', thumbnailUrl: 'https://lh3.googleusercontent.com/real-photo-0', thumbnailLabel: '', videoUrl: null, sortOrder: 0 },
  { type: 'video', thumbnailUrl: 'https://lh3.googleusercontent.com/real-thumb-1', thumbnailLabel: '', videoUrl: 'https://lh3.googleusercontent.com/real-video-1', sortOrder: 1 },
]

// Wires up a single-tenant (DEFAULT_TENANT_ID) fixture via the lightweight
// in-memory test seams (no real filesystem) -- one review, id 'r1', owned
// by locationId 7, slug 'the-diner'.
function setupSingleTenantFixture({ media = VALID_REVIEW_MEDIA, locationId = 7 } = {}) {
  _setReviewLocationIndexForTests({ r1: locationId })
  _setReviewMediaLookupTestData({
    meta: { locations: [{ locationId, name: 'The Diner', slug: 'the-diner' }] },
    reviewsByLocationId: {
      [locationId]: [
        { review_id: 'r1', reviewer_name: 'Alex', review_date: '2024-01-01', media },
      ],
    },
  })
}

// --- auth / validation --------------------------------------------------------

async function testUnauthenticatedReturns401() {
  await setDirectory()
  const res = await invoke({ query: { reviewId: 'r1', index: '0' } })
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testWrongMethodReturns405() {
  await setDirectory()
  const res = await invoke({ method: 'POST', token: await ownerToken(), query: { reviewId: 'r1', index: '0' } })
  assert(res.statusCode === 405, `expected 405, got ${res.statusCode}`)
}

async function testMissingReviewIdReturns400() {
  await setDirectory()
  setupSingleTenantFixture()
  const res = await invoke({ token: await ownerToken(), query: { index: '0' } })
  assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`)
  assert(res.body.error === 'invalid_request')
}

async function testInvalidIndexReturns400() {
  await setDirectory()
  setupSingleTenantFixture()
  const ownerTok = await ownerToken()
  for (const badIndex of ['abc', '-1', '1.5']) {
    const res = await invoke({ token: ownerTok, query: { reviewId: 'r1', index: badIndex } })
    assert(res.statusCode === 400, `index=${badIndex} expected 400, got ${res.statusCode}`)
  }
}

// --- not found ------------------------------------------------------------

async function testUnknownReviewReturns404() {
  await setDirectory()
  let fetchCalled = false
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('must not be called') }
  _setReviewLocationIndexForTests({}) // r1 resolves to nothing
  _setReviewMediaLookupTestData({ meta: { locations: [] }, reviewsByLocationId: {} })
  const res = await invoke({ token: await ownerToken(), query: { reviewId: 'r1', index: '0' } })
  assert(res.statusCode === 404, `expected 404, got ${res.statusCode}`)
  assert(fetchCalled === false, 'an unknown review must never trigger an outbound fetch')
}

async function testMediaIndexOutOfRangeReturns404() {
  await setDirectory()
  setupSingleTenantFixture()
  const res = await invoke({ token: await ownerToken(), query: { reviewId: 'r1', index: '99' } })
  assert(res.statusCode === 404, `expected 404, got ${res.statusCode}`)
}

async function testReviewWithNoMediaReturns404() {
  await setDirectory()
  _setReviewLocationIndexForTests({ r1: 7 })
  _setReviewMediaLookupTestData({
    meta: { locations: [{ locationId: 7, name: 'The Diner', slug: 'the-diner' }] },
    reviewsByLocationId: { 7: [{ review_id: 'r1', reviewer_name: 'Alex', review_date: '2024-01-01' }] }, // no `media` field at all
  })
  const res = await invoke({ token: await ownerToken(), query: { reviewId: 'r1', index: '0' } })
  assert(res.statusCode === 404, `expected 404, got ${res.statusCode}`)
}

// --- video rejection --------------------------------------------------------

async function testVideoItemRejectedWithoutFetching() {
  await setDirectory()
  setupSingleTenantFixture()
  let fetchCalled = false
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('must not be called') }
  const res = await invoke({ token: await ownerToken(), query: { reviewId: 'r1', index: '1' } }) // index 1 is the video item
  assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`)
  assert(res.body.error === 'not_downloadable', `expected not_downloadable, got ${res.body.error}`)
  assert(fetchCalled === false, 'a video item must never trigger an outbound fetch')
}

// --- location scoping --------------------------------------------------------

async function testLocationScopedAccountDeniedForForeignLocation() {
  await setDirectory()
  setupSingleTenantFixture({ locationId: 9 }) // review belongs to location 9
  let fetchCalled = false
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('must not be called') }
  const res = await invoke({ token: await lm7Token(), query: { reviewId: 'r1', index: '0' } }) // lm7 only has [7]
  assert(res.statusCode === 404, `a foreign location must be existence-hidden as 404, got ${res.statusCode}`)
  assert(fetchCalled === false)
}

async function testLocationScopedAccountAllowedForOwnLocation() {
  await setDirectory()
  setupSingleTenantFixture({ locationId: 7 })
  globalThis.fetch = async () => makeImageResponse()
  const res = await invoke({ token: await lm7Token(), query: { reviewId: 'r1', index: '0' } })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
}

// --- cross-tenant isolation (real per-tenant filesystem roots) --------------
// Mirrors test_tenant_private_data_isolation.js's own approach -- the
// lightweight in-memory reviewLocationIndex/reviewMediaLookup seams are
// intentionally NOT used here (they are single, tenant-agnostic overrides,
// not real per-tenant isolation) so this test proves the REAL boundary:
// readPrivateDataFile(tenantId, ...) can only ever read the CALLING
// account's own tenant root.

function makeTenantDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}
function writeJson(root, relPath, data) {
  const full = path.join(root, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, JSON.stringify(data))
}
function setupTenantRoot(tenantId, { reviewId, locationId, slug, media }) {
  const root = makeTenantDir(`tenant-${tenantId}-media-`)
  writeJson(root, '_internal/review-location-index.json', { [reviewId]: locationId })
  writeJson(root, 'meta.json', { locations: [{ locationId, name: 'Some Location', slug }] })
  writeJson(root, `reviews/by-location/${slug}.json`, [
    { review_id: reviewId, reviewer_name: 'Someone', review_date: '2024-01-01', media },
  ])
  _setPrivateDataRootForTests(tenantId, root)
  return root
}

async function testCrossTenantReviewNeverReadable() {
  await setDirectory()
  // Tenant A (Los Tres Amigos, DEFAULT_TENANT_ID) is BOOTSTRAP mode, so its
  // wildcard owner account owns every locationId unconditionally -- this
  // override replaces its real private-data root for the duration of this
  // test so no real production file is ever touched.
  setupTenantRoot(DEFAULT_TENANT_ID, { reviewId: 'a-review-1', locationId: 1, slug: 'tenant-a-location', media: VALID_REVIEW_MEDIA })
  // Tenant B: a separate, synthetic tenant with its OWN root and its OWN
  // review, containing media that must never be reachable by Tenant A.
  setupTenantRoot(TENANT_B, { reviewId: 'b-review-1', locationId: 900, slug: 'tenant-b-location', media: VALID_REVIEW_MEDIA })

  let fetchCalled = false
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('must not be called -- this would mean Tenant B\'s media was reached') }

  const tokenA = await ownerToken() // resolves to DEFAULT_TENANT_ID
  const res = await invoke({ token: tokenA, query: { reviewId: 'b-review-1', index: '0' } })
  assert(res.statusCode === 404, `Tenant A must never be able to read Tenant B's review media, got ${res.statusCode}`)
  assert(fetchCalled === false, 'Tenant B\'s media must never be fetched on Tenant A\'s behalf')
}

async function testTenantOwnDataStillReachableAfterRootOverride() {
  // Sanity/positive control for the test above: Tenant A's OWN review,
  // under the SAME override mechanism, must still succeed -- proving the
  // 404 above is genuine cross-tenant isolation, not just a broken fixture.
  await setDirectory()
  setupTenantRoot(DEFAULT_TENANT_ID, { reviewId: 'a-review-1', locationId: 1, slug: 'tenant-a-location', media: VALID_REVIEW_MEDIA })
  globalThis.fetch = async () => makeImageResponse()
  const res = await invoke({ token: await ownerToken(), query: { reviewId: 'a-review-1', index: '0' } })
  assert(res.statusCode === 200, `Tenant A must still be able to read its own review's media, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
}

// --- SSRF: a malicious stored URL is rejected before any fetch --------------

async function testMaliciousStoredUrlRejected() {
  await setDirectory()
  setupSingleTenantFixture({
    media: [{ type: 'photo', thumbnailUrl: 'http://internal.evil.example/steal', thumbnailLabel: '', videoUrl: null, sortOrder: 0 }],
  })
  let fetchCalled = false
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('must not be called') }
  const res = await invoke({ token: await ownerToken(), query: { reviewId: 'r1', index: '0' } })
  assert(res.statusCode === 502, `expected 502, got ${res.statusCode}`)
  assert(res.body.error === 'invalid_media_source', `expected invalid_media_source, got ${res.body.error}`)
  assert(fetchCalled === false, 'a malicious stored URL must never be fetched')
}

// --- client-supplied URL is never accepted -----------------------------------

async function testClientSuppliedUrlIsIgnored() {
  await setDirectory()
  setupSingleTenantFixture() // r1's real stored photo URL is .../real-photo-0
  let calledWith = null
  globalThis.fetch = async (url) => { calledWith = url; return makeImageResponse() }
  const res = await invoke({
    token: await ownerToken(),
    query: { reviewId: 'r1', index: '0', url: 'https://attacker.example.com/payload.jpg', thumbnailUrl: 'https://attacker.example.com/payload.jpg' },
  })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(calledWith === 'https://lh3.googleusercontent.com/real-photo-0', `must only ever fetch the server-resolved URL, got ${calledWith}`)
}

// --- upstream fetch failures surfaced with the correct status ---------------

async function testOversizedResponseNotServedAs200() {
  await setDirectory()
  setupSingleTenantFixture()
  globalThis.fetch = async () => makeImageResponse({ extraHeaders: { 'content-length': String(30 * 1024 * 1024) } })
  const res = await invoke({ token: await ownerToken(), query: { reviewId: 'r1', index: '0' } })
  assert(res.statusCode !== 200, 'an oversized response must never be served as a successful download')
  assert(res.body.error === 'too_large', `expected too_large, got ${res.body?.error}`)
}

async function testInvalidContentTypeNotServedAs200() {
  await setDirectory()
  setupSingleTenantFixture()
  globalThis.fetch = async () => makeImageResponse({ contentType: 'text/html' })
  const res = await invoke({ token: await ownerToken(), query: { reviewId: 'r1', index: '0' } })
  assert(res.statusCode !== 200)
  assert(res.body.error === 'invalid_content_type', `expected invalid_content_type, got ${res.body?.error}`)
}

async function testTimeoutHandledCleanlyAtEndpointLevel() {
  await setDirectory()
  setupSingleTenantFixture()
  _setMediaFetchTimeoutForTests(50)
  globalThis.fetch = (_url, { signal } = {}) => new Promise((_resolve, reject) => {
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    if (signal?.aborted) return reject(abortErr)
    signal?.addEventListener('abort', () => reject(abortErr))
  })
  const start = Date.now()
  const res = await invoke({ token: await ownerToken(), query: { reviewId: 'r1', index: '0' } })
  assert(Date.now() - start < 2000, 'a timed-out upstream must not hang the request')
  assert(res.statusCode === 504, `expected 504, got ${res.statusCode}`)
  assert(res.body.error === 'timeout', `expected timeout, got ${res.body?.error}`)
}

// --- happy path ---------------------------------------------------------------

async function testHappyPathHeadersAndBody() {
  await setDirectory()
  setupSingleTenantFixture()
  const bytes = new TextEncoder().encode('fake-jpeg-bytes')
  globalThis.fetch = async () => makeImageResponse({ bytes })
  const res = await invoke({ token: await ownerToken(), query: { reviewId: 'r1', index: '0' } })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
  assert(res.headers['Content-Type'] === 'image/jpeg', `expected image/jpeg, got ${res.headers['Content-Type']}`)
  assert(res.headers['Content-Disposition'] === 'attachment; filename="review-r1-photo-0.jpg"', `unexpected Content-Disposition: ${res.headers['Content-Disposition']}`)
  assert(res.headers['Cache-Control'] === 'private, no-store')
  assert(Buffer.compare(res.body, Buffer.from(bytes)) === 0, 'response body must be the exact fetched bytes')
}

async function main() {
  await run('unauthenticated -> 401', testUnauthenticatedReturns401)
  await run('wrong method -> 405', testWrongMethodReturns405)
  await run('missing reviewId -> 400', testMissingReviewIdReturns400)
  await run('invalid index -> 400', testInvalidIndexReturns400)

  await run('unknown review -> 404, never fetched', testUnknownReviewReturns404)
  await run('media index out of range -> 404', testMediaIndexOutOfRangeReturns404)
  await run('review with no media array -> 404', testReviewWithNoMediaReturns404)

  await run('video item rejected (400 not_downloadable), never fetched', testVideoItemRejectedWithoutFetching)

  await run('location-scoped account denied for a foreign location (404)', testLocationScopedAccountDeniedForForeignLocation)
  await run('location-scoped account allowed for its own location', testLocationScopedAccountAllowedForOwnLocation)

  await run('cross-tenant: Tenant A can never read Tenant B\'s review media', testCrossTenantReviewNeverReadable)
  await run('cross-tenant fixture sanity check: Tenant A can still read its own media', testTenantOwnDataStillReachableAfterRootOverride)

  await run('a malicious stored media URL is rejected before any fetch (SSRF)', testMaliciousStoredUrlRejected)
  await run('a client-supplied URL in the request is never used', testClientSuppliedUrlIsIgnored)

  await run('an oversized upstream response is never served as 200', testOversizedResponseNotServedAs200)
  await run('an invalid upstream content-type is never served as 200', testInvalidContentTypeNotServedAs200)
  await run('an upstream timeout is handled cleanly (504, no hang)', testTimeoutHandledCleanlyAtEndpointLevel)

  await run('happy path: correct Content-Type/Content-Disposition/body', testHappyPathHeadersAndBody)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
