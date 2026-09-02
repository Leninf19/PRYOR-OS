// Multi-Tenant Phase 4E -- Tenant Location Catalog Ownership.
//
// Phase 4D built correct per-tenant physical isolation for review data
// (private-data roots, per-tenant reviews.db) but tenants.js's
// tenantOwnsLocationCatalog() still hardcoded `tenantId === DEFAULT_TENANT_ID`,
// which meant auth.js's requireLocationAccess()/isWildcardGrant() denied
// EVERY location-scoped and company-wide check outright for any tenant
// other than Los Tres Amigos -- regardless of whether that tenant's own
// data already existed and was already correctly isolated on disk. Phase
// 4E replaces that hardcode with an explicit registry
// (TENANT_LOCATION_CATALOG_REGISTRY in tenants.js) and this file proves
// that a tenant genuinely REGISTERED as owning a location catalog gets
// correctly -- and ONLY -- its own locations authorized, even when its
// location ids, location names, and review keys are deliberately made to
// collide with Los Tres Amigos's own.
//
// Unlike test_tenant_private_data_isolation.js/test_phase4b_cross_tenant_adversarial.js
// (which prove a NON-onboarded synthetic tenant is denied), this file's
// synthetic Tenant B is fully onboarded (registered in the location
// catalog registry, its own private-data root, its own review-location
// index) -- the harder, more meaningful case: authorization must still
// never cross into Los Tres Amigos's data.
//
// No real Upstash account, no real Google OAuth client, no production
// Redis, and no real LTA private-data/reviews.db anywhere in this file --
// "Tenant A" here is a temporary, test-scoped override of Los Tres Amigos's
// OWN private-data root (via the same _setPrivateDataRootForTests seam
// Phase 4D's own tests use), never the real production directory.
//
// Run directly: node tests/test_tenant_location_catalog_isolation.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'

import bcrypt from 'bcryptjs'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import dataHandler from '../dashboard/api/data.js'
import googleHandler from '../dashboard/api/google/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { requireLocationAccess, isWildcardGrant } from '../dashboard/api/_lib/auth.js'
import {
  DEFAULT_TENANT_ID, tenantOwnsLocationCatalog,
  _setLocationCatalogRegistryForTests, _resetLocationCatalogRegistryForTests,
} from '../dashboard/api/_lib/tenants.js'
import {
  _setPrivateDataRootForTests, _resetPrivateDataRootsForTests,
} from '../dashboard/api/_lib/reviewDataPaths.js'
import { _setMetaLocationsForTests, _resetMetaLocationsForTests } from '../dashboard/api/data.js'
import {
  _setReviewLocationIndexForTests, _resetReviewLocationIndexForTests,
} from '../dashboard/api/_lib/reviewLocationIndex.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'
import { _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis } from '../dashboard/api/_lib/credentialStore.js'

const TENANT_B = 't_synthetic-onboarded-catalog-tenant'
const UNKNOWN_TENANT = 't_never-onboarded-catalog-tenant'

// Deliberately colliding numeric ids and names/cities across tenants --
// the whole point of this file is proving these collisions never cause
// cross-tenant matching.
const COLLIDING_LOCATION_ID = 55
const COLLIDING_NAME = 'Downtown Location'
const COLLIDING_CITY = 'Springfield'

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
    _resetLocationCatalogRegistryForTests()
    _resetPrivateDataRootsForTests()
    _resetMetaLocationsForTests()
    _resetReviewLocationIndexForTests()
    resetUserRedis()
    resetCredentialRedis()
    delete globalThis.fetch
  }
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

function fakeUserRedis(users) {
  const store = { 'users:v1': { ...users } }
  return {
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hget: async (key, field) => store[key]?.[field] ?? null,
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.send = (str) => { res.body = str; return res }
  res.setHeader = (name, value) => { res.headers[name] = value; return res }
  res.getHeader = (name) => res.headers[name]
  return res
}

// --- Fixtures ---------------------------------------------------------------

const hash = await passwordHash()

async function setDirectoryWithLocationGrants({ locationIdsA = '*', locationIdsB = '*' } = {}) {
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_a', email: 'a@example.com', passwordHash: hash, role: locationIdsA === '*' ? 'owner' : 'location_manager', locationIds: locationIdsA, sessionVersion: 1, disabled: false },
    ],
  })
  const recordB = {
    userId: 'usr_b', email: 'b@example.com', passwordHash: hash,
    role: locationIdsB === '*' ? 'owner' : 'location_manager', locationIds: locationIdsB,
    sessionVersion: 1, disabled: false, tenantId: TENANT_B,
  }
  setUserRedis(() => fakeUserRedis({ usr_b: JSON.stringify(recordB) }))
}

async function tokenFor(userId, email, tenantId, role, locationIds) {
  return signSession({ userId, email, role, locationIds, tenantId, sessionVersion: 1 })
}
async function tokenA(locationIds = '*') {
  return tokenFor('usr_a', 'a@example.com', DEFAULT_TENANT_ID, locationIds === '*' ? 'owner' : 'location_manager', locationIds)
}
async function tokenB(locationIds = '*') {
  return tokenFor('usr_b', 'b@example.com', TENANT_B, locationIds === '*' ? 'owner' : 'location_manager', locationIds)
}

function writeJson(root, relPath, data) {
  const full = path.join(root, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, JSON.stringify(data))
}

function makeTenantDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

// Registers TENANT_B as owning a location catalog (Phase 4E's new gate)
// AND gives both tenants their own private-data roots with deliberately
// colliding location ids/names, plus per-tenant review-location indexes
// with colliding keys and colliding numeric ids pointing at DIFFERENT
// underlying reviews.
function setupBothTenants() {
  _setLocationCatalogRegistryForTests([DEFAULT_TENANT_ID, TENANT_B])

  const rootA = makeTenantDir('tenant-a-catalog-')
  writeJson(rootA, 'meta.json', {
    distinctiveMarker: 'tenant-a-meta',
    locations: [{ locationId: COLLIDING_LOCATION_ID, name: COLLIDING_NAME, city: COLLIDING_CITY, slug: 'downtown-location' }],
    totalReviews: 1,
  })
  writeJson(rootA, 'reviews/by-location/downtown-location.json', [
    { review_id: 'a1', reviewer_name: 'Tenant A Reviewer', star_rating: 5, review_text: 'Tenant A exclusive review text.' },
  ])
  writeJson(rootA, 'action-items.json', { items: [] })
  _setPrivateDataRootForTests(DEFAULT_TENANT_ID, rootA)

  const rootB = makeTenantDir('tenant-b-catalog-')
  writeJson(rootB, 'meta.json', {
    distinctiveMarker: 'tenant-b-meta',
    locations: [{ locationId: COLLIDING_LOCATION_ID, name: COLLIDING_NAME, city: COLLIDING_CITY, slug: 'downtown-location' }],
    totalReviews: 1,
  })
  writeJson(rootB, 'reviews/by-location/downtown-location.json', [
    { review_id: 'b1', reviewer_name: 'Tenant B Reviewer', star_rating: 1, review_text: 'Tenant B exclusive review text.' },
  ])
  writeJson(rootB, 'action-items.json', { items: [] })
  _setPrivateDataRootForTests(TENANT_B, rootB)

  return { rootA, rootB }
}

async function invokeData(fileParam, token, extra = {}) {
  const req = {
    method: 'GET',
    query: { file: fileParam, ...(extra.query ?? {}) },
    body: extra.body,
    headers: { cookie: token ? `${SESSION_COOKIE}=${token}` : '', ...(extra.headers ?? {}) },
  }
  const res = fakeRes()
  await dataHandler(req, res)
  return res
}

// ===========================================================================
// Registry unit tests
// ===========================================================================

function testRegistryDefaultsToLtaOnly() {
  assert(tenantOwnsLocationCatalog(DEFAULT_TENANT_ID), 'Los Tres Amigos must own a location catalog by default')
  assert(!tenantOwnsLocationCatalog(TENANT_B), 'an unregistered tenant must not own a location catalog by default')
  assert(!tenantOwnsLocationCatalog(UNKNOWN_TENANT), 'an unknown tenant must not own a location catalog')
  assert(!tenantOwnsLocationCatalog(null) && !tenantOwnsLocationCatalog(undefined) && !tenantOwnsLocationCatalog(42), 'a malformed tenantId must never own a location catalog')
}

function testRegistryOverrideIsTestOnlyAndResets() {
  assert(!tenantOwnsLocationCatalog(TENANT_B), 'sanity: not registered before override')
  _setLocationCatalogRegistryForTests([DEFAULT_TENANT_ID, TENANT_B])
  assert(tenantOwnsLocationCatalog(TENANT_B), 'override must register TENANT_B')
  _resetLocationCatalogRegistryForTests()
  assert(!tenantOwnsLocationCatalog(TENANT_B), 'reset must restore the real, LTA-only production registry')
}

// ===========================================================================
// 1 & 2: Cross-tenant location rejection, both directions
// ===========================================================================

async function testTenantALocationRejectedUnderTenantB() {
  await setDirectoryWithLocationGrants()
  setupBothTenants()
  const res = await invokeData('reviews/by-location/downtown-location.json', await tokenB())
  const body = JSON.parse(res.body)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(Array.isArray(body) && body.length === 1 && body[0].reviewer_name === 'Tenant B Reviewer',
    'Tenant B must see only its OWN "downtown-location" file content, never Tenant A\'s, despite the identical slug/locationId')
}

async function testTenantBLocationRejectedUnderTenantA() {
  await setDirectoryWithLocationGrants()
  setupBothTenants()
  const res = await invokeData('reviews/by-location/downtown-location.json', await tokenA())
  const body = JSON.parse(res.body)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(Array.isArray(body) && body.length === 1 && body[0].reviewer_name === 'Tenant A Reviewer',
    'Tenant A must see only its OWN "downtown-location" file content, never Tenant B\'s, despite the identical slug/locationId')
}

// ===========================================================================
// 3: Wildcard grants stay tenant-bounded (now a MEANINGFUL test -- TENANT_B
//    is genuinely registered, unlike test_tenant_private_data_isolation.js's
//    non-onboarded TENANT_B, so this is not a vacuous pass on an empty array)
// ===========================================================================

async function testWildcardGrantStaysTenantBounded() {
  await setDirectoryWithLocationGrants()
  setupBothTenants()
  assert(isWildcardGrant({ role: 'owner', locationIds: '*', tenantId: TENANT_B }), 'Tenant B is registered, so its wildcard grant must now mean something (all of ITS OWN locations)')

  const resB = await invokeData('meta.json', await tokenB())
  const bodyB = JSON.parse(resB.body)
  assert(bodyB.distinctiveMarker === 'tenant-b-meta', 'Tenant B\'s wildcard meta.json read must resolve to its own root')
  assert(bodyB.locations.length === 1 && bodyB.locations[0].name === COLLIDING_NAME, 'Tenant B wildcard must see exactly its own one location')

  const resA = await invokeData('meta.json', await tokenA())
  const bodyA = JSON.parse(resA.body)
  assert(bodyA.distinctiveMarker === 'tenant-a-meta', 'Tenant A\'s own wildcard meta.json read must be completely unaffected by Tenant B\'s onboarding')
}

// ===========================================================================
// 4: Forged query/body/header tenant IDs cannot switch catalogs
// ===========================================================================

async function testForgedTenantIdInQueryCannotSwitchCatalog() {
  await setDirectoryWithLocationGrants()
  setupBothTenants()
  const res = await invokeData('meta.json', await tokenB(), { query: { tenantId: DEFAULT_TENANT_ID } })
  const body = JSON.parse(res.body)
  assert(body.distinctiveMarker === 'tenant-b-meta', 'a forged tenantId query param must never switch which tenant\'s catalog is read')
}

async function testForgedTenantIdInBodyCannotSwitchCatalog() {
  await setDirectoryWithLocationGrants()
  setupBothTenants()
  const res = await invokeData('meta.json', await tokenB(), { body: { tenantId: DEFAULT_TENANT_ID } })
  const body = JSON.parse(res.body)
  assert(body.distinctiveMarker === 'tenant-b-meta', 'a forged tenantId in the request body must never switch which tenant\'s catalog is read')
}

async function testForgedTenantIdInHeaderCannotSwitchCatalog() {
  await setDirectoryWithLocationGrants()
  setupBothTenants()
  const res = await invokeData('meta.json', await tokenB(), { headers: { 'x-tenant-id': DEFAULT_TENANT_ID } })
  const body = JSON.parse(res.body)
  assert(body.distinctiveMarker === 'tenant-b-meta', 'a forged x-tenant-id header must never switch which tenant\'s catalog is read')
}

// ===========================================================================
// 5: Review-to-location resolution cannot cross tenants, even with
//    colliding review keys resolving to the same colliding numeric id
// ===========================================================================

async function testReviewLocationResolutionCannotCrossTenants() {
  await setDirectoryWithLocationGrants({ locationIdsA: [COLLIDING_LOCATION_ID], locationIdsB: [COLLIDING_LOCATION_ID] })
  setupBothTenants()
  // NOTE: _setReviewLocationIndexForTests is a single global override (see
  // reviewLocationIndex.js) -- it stands in for whichever tenant's index is
  // requested, so this proves the LOOKUP KEY isolation (a review id that
  // simply doesn't exist for a tenant resolves to null), which is the real
  // per-tenant boundary in production (separate index files per tenant).
  _setReviewLocationIndexForTests({ 'tenant-a-review': COLLIDING_LOCATION_ID })

  globalThis.fetch = async () => { throw new Error('must never call Google for a review this account cannot resolve') }
  setCredentialRedis(() => ({ get: async () => { throw new Error('must never touch a credential store for a denied request') } }))

  const req = {
    method: 'POST', query: { action: 'publish' },
    body: { localReviewId: 'tenant-b-review-that-does-not-exist-in-the-shared-test-index', replyText: 'hi', locationName: COLLIDING_NAME, reviewerName: 'x' },
    headers: { cookie: `${SESSION_COOKIE}=${await tokenB([COLLIDING_LOCATION_ID])}` },
  }
  const res = fakeRes()
  await googleHandler(req, res)
  assert(res.statusCode === 404, `a review id unresolvable in the caller's own index must be denied (404), got ${res.statusCode} ${JSON.stringify(res.body)}`)
}

// ===========================================================================
// 6: Publish/reply cannot cross tenants
// ===========================================================================

async function testPublishCannotCrossTenants() {
  await setDirectoryWithLocationGrants({ locationIdsA: [COLLIDING_LOCATION_ID], locationIdsB: [COLLIDING_LOCATION_ID] })
  setupBothTenants()
  // Tenant B's own index only knows about ITS OWN review key.
  _setReviewLocationIndexForTests({})

  let fetchCalled = false
  let credentialCalled = false
  globalThis.fetch = async () => { fetchCalled = true; return { status: 200, json: async () => ({}) } }
  setCredentialRedis(() => ({ get: async () => { credentialCalled = true; return null } }))

  const req = {
    method: 'POST', query: { action: 'publish' },
    body: { localReviewId: 'tenant-a-only-review', replyText: 'hi', locationName: 'Tenant A Restaurant', reviewerName: 'someone' },
    headers: { cookie: `${SESSION_COOKIE}=${await tokenB([COLLIDING_LOCATION_ID])}` },
  }
  const res = fakeRes()
  await googleHandler(req, res)
  assert(res.statusCode === 404, `Tenant B replying to a review it cannot resolve in its own index must be denied, got ${res.statusCode}`)
  assert(!fetchCalled, 'Google must never be called for a denied cross-tenant publish attempt')
  assert(!credentialCalled, 'the credential store must never be consulted for a denied cross-tenant publish attempt')
}

// ===========================================================================
// 7: Unknown tenants fail before location-owned data or Google credentials
//    are touched
// ===========================================================================

async function testUnknownTenantFailsBeforeCredentialsOrDataTouched() {
  const record = {
    userId: 'usr_unknown', email: 'unknown@example.com', passwordHash: hash,
    role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId: UNKNOWN_TENANT,
  }
  setUserRedis(() => fakeUserRedis({ usr_unknown: JSON.stringify(record) }))

  let fetchCalled = false
  let credentialCalled = false
  globalThis.fetch = async () => { fetchCalled = true; return { status: 200, json: async () => ({}) } }
  setCredentialRedis(() => ({ get: async () => { credentialCalled = true; return null } }))

  const token = await tokenFor('usr_unknown', 'unknown@example.com', UNKNOWN_TENANT, 'owner', '*')
  const req = {
    method: 'POST', query: { action: 'publish' },
    body: { localReviewId: 'anything', replyText: 'hi', locationName: 'Anywhere', reviewerName: 'someone' },
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  }
  const res = fakeRes()
  await googleHandler(req, res)
  assert(res.statusCode === 404, `an unknown/unregistered tenant must fail closed before reaching Google, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  assert(!fetchCalled, 'Google must never be called for an unknown tenant')
  assert(!credentialCalled, 'the credential store must never be consulted for an unknown tenant')

  // Also confirm the data-plane endpoint fails closed the same way, before
  // any filesystem access to location-owned data.
  const dataRes = await invokeData('meta.json', token)
  assert(dataRes.statusCode === 404, `an unknown tenant must fail closed (404) on the data plane too, got ${dataRes.statusCode}`)
}

// ===========================================================================
// 8: Duplicate-looking location names/addresses do not cause cross-tenant
//    matching
// ===========================================================================

async function testDuplicateNamesAndAddressesNeverCrossMatch() {
  await setDirectoryWithLocationGrants()
  setupBothTenants()
  // Both tenants' meta.json declare a location with the IDENTICAL name,
  // city, slug, and numeric locationId (COLLIDING_LOCATION_ID/COLLIDING_NAME/
  // COLLIDING_CITY, set up in setupBothTenants()). Confirm each tenant's own
  // read is entirely self-consistent and never contaminated by the other's
  // record for the "same" location.
  const resA = await invokeData('meta.json', await tokenA())
  const bodyA = JSON.parse(resA.body)
  const resB = await invokeData('meta.json', await tokenB())
  const bodyB = JSON.parse(resB.body)

  assert(bodyA.locations.length === 1 && bodyB.locations.length === 1, 'sanity: each tenant declares exactly one (colliding-looking) location')
  assert(bodyA.locations[0].name === COLLIDING_NAME && bodyB.locations[0].name === COLLIDING_NAME, 'sanity: names really do collide')
  assert(bodyA.distinctiveMarker === 'tenant-a-meta' && bodyB.distinctiveMarker === 'tenant-b-meta',
    'despite identical name/city/slug/locationId, each tenant\'s meta.json must resolve to its OWN physical file')

  const reviewsA = JSON.parse((await invokeData('reviews/by-location/downtown-location.json', await tokenA())).body)
  const reviewsB = JSON.parse((await invokeData('reviews/by-location/downtown-location.json', await tokenB())).body)
  assert(reviewsA[0].review_text === 'Tenant A exclusive review text.', 'Tenant A\'s reviews for the colliding location name must be Tenant A\'s own')
  assert(reviewsB[0].review_text === 'Tenant B exclusive review text.', 'Tenant B\'s reviews for the colliding location name must be Tenant B\'s own')
  assert(reviewsA[0].review_text !== reviewsB[0].review_text, 'the two tenants\' reviews for the "same" location name must never be blended or cross-served')
}

// ===========================================================================
// Regression: Los Tres Amigos unaffected by Tenant B's onboarding
// ===========================================================================

async function testLtaCompletelyUnaffectedByTenantBOnboarding() {
  await setDirectoryWithLocationGrants()
  setupBothTenants()
  const res = await invokeData('meta.json', await tokenA())
  assert(res.statusCode === 200, `Los Tres Amigos must be unaffected by a second tenant being onboarded, got ${res.statusCode}`)
  const body = JSON.parse(res.body)
  assert(body.distinctiveMarker === 'tenant-a-meta' && body.locations.length === 1, 'Los Tres Amigos must still see exactly its own real location data')
}

async function main() {
  console.log('--- Registry ---')
  await run('the registry defaults to Los Tres Amigos only', testRegistryDefaultsToLtaOnly)
  await run('the test override registers/resets without touching the production registry', testRegistryOverrideIsTestOnlyAndResets)

  console.log('\n--- 1 & 2: cross-tenant location rejection, both directions ---')
  await run('Tenant A\'s location content is rejected/absent under Tenant B', testTenantALocationRejectedUnderTenantB)
  await run('Tenant B\'s location content is rejected/absent under Tenant A', testTenantBLocationRejectedUnderTenantA)

  console.log('\n--- 3: wildcard grants stay tenant-bounded ---')
  await run('a wildcard grant for a registered tenant means "all of ITS OWN locations," never platform-wide', testWildcardGrantStaysTenantBounded)

  console.log('\n--- 4: forged tenant ids cannot switch catalogs ---')
  await run('a forged tenantId query param cannot switch catalogs', testForgedTenantIdInQueryCannotSwitchCatalog)
  await run('a forged tenantId in the request body cannot switch catalogs', testForgedTenantIdInBodyCannotSwitchCatalog)
  await run('a forged tenantId header cannot switch catalogs', testForgedTenantIdInHeaderCannotSwitchCatalog)

  console.log('\n--- 5: review-to-location resolution cannot cross tenants ---')
  await run('review-location resolution cannot cross tenants even with colliding numeric ids', testReviewLocationResolutionCannotCrossTenants)

  console.log('\n--- 6: publish/reply cannot cross tenants ---')
  await run('publish cannot cross tenants, and never touches Google/credentials when denied', testPublishCannotCrossTenants)

  console.log('\n--- 7: unknown tenants fail before data/credentials are touched ---')
  await run('an unknown tenant fails closed before Google or the credential store or location data is touched', testUnknownTenantFailsBeforeCredentialsOrDataTouched)

  console.log('\n--- 8: duplicate names/addresses never cross-match ---')
  await run('duplicate-looking location names/addresses across tenants never cause cross-tenant matching', testDuplicateNamesAndAddressesNeverCrossMatch)

  console.log('\n--- Regression ---')
  await run('Los Tres Amigos is completely unaffected by Tenant B being onboarded', testLtaCompletelyUnaffectedByTenantBOnboarding)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
