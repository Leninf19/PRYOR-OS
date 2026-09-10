// Regression tests for dashboard/api/data.js -- the authenticated
// replacement for direct fetch('/data/...') access to
// dashboard/private-data/. Runs against the REAL private-data directory
// (no mocked filesystem) so the allowlist is exercised against what
// export_chunks.py actually produces; traversal/reject cases never touch
// the filesystem at all if the allowlist is doing its job.
//
// Run directly: node tests/test_data_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFile, writeFile, unlink } from 'fs/promises'
import handler from '../dashboard/api/data.js'
import { signSession } from '../dashboard/api/_lib/session.js'
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
  }
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false },
      { userId: 'usr_readonly', email: 'readonly@example.com', passwordHash: hash, role: 'read_only', locationIds: '*', sessionVersion: 1, disabled: false },
      { userId: 'usr_locmgr', email: 'locmgr@example.com', passwordHash: hash, role: 'location_manager', locationIds: [3], sessionVersion: 1, disabled: false },
    ],
  })
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.send = (str) => { res.body = str; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

// pathSegments is joined with '/' into the single ?file= query string value
// the real endpoint now reads (see dashboard/api/data.js's header comment
// for why this moved off a dynamic catch-all route) -- kept as an array
// here purely so the many call sites below stay readable.
async function invoke(pathSegments, token) {
  const fileParam = Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments
  const req = {
    method: 'GET',
    query: { file: fileParam },
    headers: token ? { cookie: `lta_session=${token}` } : {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function ownerToken() {
  return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
}

async function testUnauthenticatedReturns401() {
  await setDirectory()
  const res = await invoke(['meta.json'], null)
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testOwnerCanReadMeta() {
  await setDirectory()
  const token = await ownerToken()
  const res = await invoke(['meta.json'], token)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
  const parsed = JSON.parse(res.body)
  assert(Array.isArray(parsed.locations), 'meta.json payload has a locations array')
}

async function testMarketingCanReadMeta() {
  await setDirectory()
  const token = await signSession({ userId: 'usr_marketing', email: 'marketing@example.com', role: 'marketing', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  const res = await invoke(['meta.json'], token)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
}

// REVISED (Multi-Location Authentication & User Access System, Commit 4):
// the flat role-block this test used to assert is exactly what Commit 4
// closes -- replaced by real per-file/per-location authorization tests
// below, run against the real private-data directory. Fixture facts used
// throughout: locationId 3 = "Los Tres Amigos Owosso" (slug
// los-tres-amigos-owosso), locationId 20 = "Casa Tequila Brighton" (slug
// casa-tequila-brighton) -- usr_locmgr above is scoped to [3] only.
async function testReadOnlyWildcardNowFullyAllowed() {
  await setDirectory()
  const roToken = await signSession({ userId: 'usr_readonly', email: 'readonly@example.com', role: 'read_only', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  const roRes = await invoke(['meta.json'], roToken)
  assert(roRes.statusCode === 200, `a company-wide (locationIds: '*') read_only account must now be fully allowed, got ${roRes.statusCode}`)
  assert(Number.isInteger(JSON.parse(roRes.body).totalReviews), 'a wildcard account must still see the real, unfiltered totalReviews')
}

async function testLocationManagerMetaJsonFilteredToOwnLocationOnly() {
  await setDirectory()
  const lmToken = await signSession({ userId: 'usr_locmgr', email: 'locmgr@example.com', role: 'location_manager', locationIds: [3], tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  const res = await invoke(['meta.json'], lmToken)
  assert(res.statusCode === 200, `meta.json itself must never be blocked outright for a scoped account, got ${res.statusCode}`)
  const body = JSON.parse(res.body)
  assert(body.locations.length === 1 && body.locations[0].locationId === 3, `expected exactly location 3, got ${JSON.stringify(body.locations.map(l => l.locationId))}`)
  assert(body.totalReviews === null, 'totalReviews (a company-wide aggregate) must never be exposed to a scoped account')
}

async function testLocationManagerCanReadItsOwnLocationReviews() {
  await setDirectory()
  const lmToken = await signSession({ userId: 'usr_locmgr', email: 'locmgr@example.com', role: 'location_manager', locationIds: [3], tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  const res = await invoke(['reviews', 'by-location', 'los-tres-amigos-owosso.json'], lmToken)
  assert(res.statusCode === 200, `expected 200 for the account's own location, got ${res.statusCode}`)
}

async function testLocationManagerCannotReadAForeignLocationReviews() {
  await setDirectory()
  const lmToken = await signSession({ userId: 'usr_locmgr', email: 'locmgr@example.com', role: 'location_manager', locationIds: [3], tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  const res = await invoke(['reviews', 'by-location', 'casa-tequila-brighton.json'], lmToken)
  assert(res.statusCode === 404, `expected 404 (never 403, existence-hiding) for a foreign location, got ${res.statusCode}`)
}

async function testLocationManagerBlockedFromCompanyWideAggregates() {
  await setDirectory()
  const lmToken = await signSession({ userId: 'usr_locmgr', email: 'locmgr@example.com', role: 'location_manager', locationIds: [3], tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  for (const file of ['analytics/kpis.json', 'action-items.json', 'intelligence/company-summary.json']) {
    const res = await invoke(file.split('/'), lmToken)
    assert(res.statusCode === 403, `${file}: a company-wide aggregate must be permanently blocked (403) for a scoped account, got ${res.statusCode}`)
  }
}

async function testUnknownFileReturns404() {
  await setDirectory()
  const token = await ownerToken()
  const res = await invoke(['this-file-does-not-exist.json'], token)
  assert(res.statusCode === 404, `expected 404, got ${res.statusCode}`)
}

async function testDisallowedFileReturns404() {
  await setDirectory()
  const token = await ownerToken()
  // A real file that exists in private-data but is NOT on the allowlist
  // would still 404 -- simulated here with a plausible-but-not-exported name.
  const res = await invoke(['analytics', 'not-a-real-export.json'], token)
  assert(res.statusCode === 404, `expected 404, got ${res.statusCode}`)
}

async function testDotDotTraversalRejected() {
  await setDirectory()
  const token = await ownerToken()
  const res = await invoke(['..', '..', 'reviews.db'], token)
  assert(res.statusCode === 404, `.. traversal must be rejected with 404, got ${res.statusCode}`)
}

async function testEncodedTraversalRejected() {
  await setDirectory()
  const token = await ownerToken()
  // Simulates what a raw %2e%2e%2f would decode to if it ever reached this
  // far -- the segment validator rejects '..' as a segment regardless of
  // how the request encoded it, and ordinary query-string parsing already
  // decodes the ?file= value before this handler ever sees it.
  const res = await invoke(['..%2f..%2freviews.db'], token)
  assert(res.statusCode === 404, `encoded traversal must be rejected, got ${res.statusCode}`)
}

async function testAbsolutePathAttemptRejected() {
  await setDirectory()
  const token = await ownerToken()
  const res = await invoke(['', 'etc', 'passwd'], token)
  assert(res.statusCode === 404, `absolute-path-shaped request must be rejected, got ${res.statusCode}`)
}

async function testReviewsDbRejected() {
  await setDirectory()
  const token = await ownerToken()
  const res = await invoke(['reviews.db'], token)
  assert(res.statusCode === 404, `reviews.db must never be servable, got ${res.statusCode}`)
}

async function testSourceAndEnvFilesRejected() {
  await setDirectory()
  const token = await ownerToken()
  for (const segs of [['..', 'api', 'data.js'], ['..', '..', '.env'], ['..', '..', '.git', 'config']]) {
    const res = await invoke(segs, token)
    assert(res.statusCode === 404, `${segs.join('/')} must be rejected, got ${res.statusCode}`)
  }
}

async function testNoStoreCacheHeader() {
  await setDirectory()
  const token = await ownerToken()
  const res = await invoke(['meta.json'], token)
  assert(res.headers['Cache-Control'] === 'private, no-store', `expected private,no-store cache header, got ${res.headers['Cache-Control']}`)
}

async function testErrorBodyNeverLeaksAbsolutePath() {
  await setDirectory()
  const token = await ownerToken()
  const res = await invoke(['this-file-does-not-exist.json'], token)
  const asString = JSON.stringify(res.body)
  assert(!asString.includes(':\\') && !asString.includes('/home/') && !asString.toLowerCase().includes('private-data'),
    `error body must not reveal filesystem paths: ${asString}`)
}

async function testQueryStringIgnoredHarmlessly() {
  await setDirectory()
  const token = await ownerToken()
  // An unrelated extra query param alongside ?file= must neither break the
  // happy path nor help smuggle anything past the allowlist.
  const req = { method: 'GET', query: { file: 'meta.json', extra: 'ignored', foo: '../../reviews.db' }, headers: { cookie: `lta_session=${token}` } }
  const res = fakeRes()
  await handler(req, res)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
}

async function testDoubleEncodedTraversalRejected() {
  await setDirectory()
  const token = await ownerToken()
  // %252e%252e%252f is '..%2f' with the '%' itself re-encoded -- simulates
  // a double-decode attempt. Even if some upstream layer decoded once
  // before Vercel's own routing decoded again, the resulting segment must
  // still fail the allowlist/segment-shape check.
  const res = await invoke(['%252e%252e%252freviews.db'], token)
  assert(res.statusCode === 404, `double-encoded traversal must be rejected, got ${res.statusCode}`)
}

async function testMixedSlashBackslashRejected() {
  await setDirectory()
  const token = await ownerToken()
  const attempts = [
    ['reviews\\by-location\\..\\..\\reviews.db'],
    ['..\\..\\reviews.db'],
    ['reviews', 'by-location\\..\\..\\reviews.db'],
  ]
  for (const segs of attempts) {
    const res = await invoke(segs, token)
    assert(res.statusCode === 404, `backslash-mixed path ${JSON.stringify(segs)} must be rejected, got ${res.statusCode}`)
  }
}

async function testCaseVariationOfKnownFileRejected() {
  await setDirectory()
  const token = await ownerToken()
  // The allowlist is case-sensitive on purpose -- export_chunks.py always
  // writes lowercase names, so 'Meta.json'/'META.JSON' must not match.
  for (const segs of [['Meta.json'], ['META.JSON'], ['Analytics', 'Kpis.json']]) {
    const res = await invoke(segs, token)
    assert(res.statusCode === 404, `case-varied path ${JSON.stringify(segs)} must be rejected, got ${res.statusCode}`)
  }
}

async function testEmptyCatchAllPathRejected() {
  await setDirectory()
  const token = await ownerToken()
  for (const fileValue of ['', undefined, null]) {
    const req = { method: 'GET', query: { file: fileValue }, headers: { cookie: `lta_session=${token}` } }
    const res = fakeRes()
    await handler(req, res)
    assert(res.statusCode === 404, `empty/missing ?file= (${JSON.stringify(fileValue)}) must be rejected, got ${res.statusCode}`)
  }
}

async function testNonexistentAllowlistShapedPathReturns404() {
  await setDirectory()
  const token = await ownerToken()
  // Matches the DYNAMIC_ALLOWLIST regex shape exactly (a plausible
  // per-location slug) but no such file exists on disk -- distinct from
  // testUnknownFileReturns404, which uses a name that doesn't match any
  // pattern at all. Both must 404 identically (no distinguishing signal).
  const res = await invoke(['reviews', 'by-location', 'zzz-not-a-real-location-slug.json'], token)
  assert(res.statusCode === 404, `expected 404, got ${res.statusCode}`)
}

async function testMalformedJsonArtifactReturns500NotCorruptData() {
  await setDirectory()
  const token = await ownerToken()
  const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'private-data', 'validation.json')
  const original = await readFile(fixturePath, 'utf-8').catch(() => null)
  await writeFile(fixturePath, '{ this is not valid json ][', 'utf-8')
  try {
    const res = await invoke(['validation.json'], token)
    assert(res.statusCode === 500, `expected 500 for a corrupted artifact, got ${res.statusCode}`)
    assert(res.body.error === 'server_error', res.body.error)
  } finally {
    if (original !== null) await writeFile(fixturePath, original, 'utf-8')
    else await unlink(fixturePath).catch(() => {})
  }
}

async function testProviderHealthIsAllowlistedForOwner() {
  // Phase 3 Milestone 5: provider-health.json didn't exist in the
  // allowlist before this milestone -- write a real temporary fixture
  // (mirrors testMalformedJsonArtifactReturns500NotCorruptData's
  // write-then-restore pattern) since no pipeline run has generated one in
  // this checkout, then confirm the new allowlist entry actually serves it.
  await setDirectory()
  const token = await ownerToken()
  const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'private-data', 'provider-health.json')
  const original = await readFile(fixturePath, 'utf-8').catch(() => null)
  await writeFile(fixturePath, JSON.stringify({
    gbp: { state: 'offline', reason: 'gbp is not configured' },
    scraper: { state: 'healthy', reason: 'most recent run succeeded and is within the expected cadence' },
  }), 'utf-8')
  try {
    const res = await invoke(['provider-health.json'], token)
    assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
    const parsed = JSON.parse(res.body)
    assert(parsed.scraper?.state === 'healthy', 'provider-health.json payload is served through unchanged')
  } finally {
    if (original !== null) await writeFile(fixturePath, original, 'utf-8')
    else await unlink(fixturePath).catch(() => {})
  }
}

async function testProviderHealthStillRequiresAuth() {
  // Confirms the new allowlist entry didn't bypass requireAuth() -- an
  // unauthenticated request for it must 401 exactly like every other file.
  await setDirectory()
  const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'private-data', 'provider-health.json')
  const original = await readFile(fixturePath, 'utf-8').catch(() => null)
  await writeFile(fixturePath, JSON.stringify({ gbp: { state: 'offline', reason: 'x' } }), 'utf-8')
  try {
    const res = await invoke(['provider-health.json'], null)
    assert(res.statusCode === 401, `expected 401 for unauthenticated request, got ${res.statusCode}`)
  } finally {
    if (original !== null) await writeFile(fixturePath, original, 'utf-8')
    else await unlink(fixturePath).catch(() => {})
  }
}

async function testContentTypeIsJson() {
  await setDirectory()
  const token = await ownerToken()
  const res = await invoke(['meta.json'], token)
  assert(res.headers['Content-Type'] === 'application/json; charset=utf-8', `expected JSON content type, got ${res.headers['Content-Type']}`)
}

async function testNoPublicOrCdnCacheDirectives() {
  await setDirectory()
  const token = await ownerToken()
  const res = await invoke(['meta.json'], token)
  const cacheControl = (res.headers['Cache-Control'] || '').toLowerCase()
  assert(!cacheControl.includes('public'), `Cache-Control must never include "public": ${cacheControl}`)
  assert(!res.headers['CDN-Cache-Control'] && !res.headers['Vercel-CDN-Cache-Control'], 'no CDN-specific caching header should be set')
}

async function main() {
  await run('unauthenticated request -> 401', testUnauthenticatedReturns401)
  await run('authenticated Owner request -> expected payload', testOwnerCanReadMeta)
  await run('authenticated Marketing request -> expected payload', testMarketingCanReadMeta)
  await run('a company-wide (wildcard) read_only account is now fully allowed', testReadOnlyWildcardNowFullyAllowed)
  await run('location_manager: meta.json is filtered to its own location, totalReviews stripped', testLocationManagerMetaJsonFilteredToOwnLocationOnly)
  await run('location_manager: can read its own location\'s reviews', testLocationManagerCanReadItsOwnLocationReviews)
  await run('location_manager: cannot read a foreign location\'s reviews (404)', testLocationManagerCannotReadAForeignLocationReviews)
  await run('location_manager: blocked (403) from company-wide aggregate files', testLocationManagerBlockedFromCompanyWideAggregates)
  await run('unknown file -> 404', testUnknownFileReturns404)
  await run('disallowed (non-allowlisted) file -> 404', testDisallowedFileReturns404)
  await run('.. traversal -> rejected', testDotDotTraversalRejected)
  await run('URL-encoded traversal -> rejected', testEncodedTraversalRejected)
  await run('absolute-path attempt -> rejected', testAbsolutePathAttemptRejected)
  await run('reviews.db request -> rejected', testReviewsDbRejected)
  await run('source/env/git file requests -> rejected', testSourceAndEnvFilesRejected)
  await run('response uses Cache-Control: private, no-store', testNoStoreCacheHeader)
  await run('error body never contains an absolute filesystem path', testErrorBodyNeverLeaksAbsolutePath)
  await run('an extra/unrelated query string is ignored harmlessly', testQueryStringIgnoredHarmlessly)
  await run('double-encoded traversal -> rejected', testDoubleEncodedTraversalRejected)
  await run('mixed slash/backslash traversal attempts -> rejected', testMixedSlashBackslashRejected)
  await run('case-varied known filenames -> rejected (allowlist is case-sensitive)', testCaseVariationOfKnownFileRejected)
  await run('empty/missing catch-all path -> rejected', testEmptyCatchAllPathRejected)
  await run('nonexistent but allowlist-pattern-shaped path -> 404 (same as any other unknown file)', testNonexistentAllowlistShapedPathReturns404)
  await run('a corrupted/malformed JSON artifact on disk -> safe 500, never served as-is', testMalformedJsonArtifactReturns500NotCorruptData)
  await run('provider-health.json is allowlisted and served to an Owner', testProviderHealthIsAllowlistedForOwner)
  await run('provider-health.json still requires authentication', testProviderHealthStillRequiresAuth)
  await run('response Content-Type is application/json', testContentTypeIsJson)
  await run('no public/CDN caching directive is ever present', testNoPublicOrCdnCacheDirectives)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
