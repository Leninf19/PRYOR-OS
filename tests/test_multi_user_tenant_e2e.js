// Google Integration + Reviews End-to-End Validation, Part B -- end-to-end
// proof of the exact multi-user scenario requested: one tenant, one Owner
// who originally authenticated Google, two Managers with completely
// different PRYOR emails and NO personal Google OAuth record of their own,
// scoped to different locations, plus a second, wholly separate tenant.
// Driven through the real API handlers (google/[action].js, data.js) --
// the same code paths the frontend actually calls -- never a bare store
// unit test.
//
// FIXTURE MAPPING NOTE: the request's fixture used locationIds:
// ["location-a"]/["location-b"] (string ids) and role: "manager". This
// codebase's real account model requires locationIds to be '*' or an array
// of POSITIVE INTEGERS (accounts.js's isValidLocationIds() -- a location's
// canonical identity is its numeric locationId, the same one Google's own
// resource path and tenantConfigStore.js's locationIdMap use throughout),
// and its role enum has no literal "manager" -- the closest, and only
// applicable, real role is 'location_manager' (permissions.js). This file
// maps location-a -> numeric locationId 1, location-b -> numeric locationId
// 2, and role: manager -> role: 'location_manager', preserving every other
// requested fixture detail (emails, tenantId, Owner-only-authenticated-
// Google) exactly. This is a fixture-representation decision, not a
// discovered defect -- documented here rather than silently changed.
//
// Run directly: node tests/test_multi_user_tenant_e2e.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'

import bcrypt from 'bcryptjs'
import { Readable } from 'stream'
import googleHandler from '../dashboard/api/google/[action].js'
import dataHandler, { _resetMetaLocationsForTests } from '../dashboard/api/data.js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import {
  upsertTenantConfig, recordLocationApproval, markTenantProvisioned,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'
import { getAccountById } from '../dashboard/api/_lib/accountStore.js'
import { _setBlobClientForTests as setBlobClient, _resetBlobClientForTests as resetBlobClient } from '../dashboard/api/_lib/blobStore.js'
import { reviewDbBlobKey, generationPrivateDataBlobKey } from '../dashboard/api/_lib/tenantBlobKeys.js'
import {
  setStoredCredential,
  _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis,
} from '../dashboard/api/_lib/credentialStore.js'
import {
  _setRedisClientForTests as setConnStoreRedis, _resetRedisClientForTests as resetConnStoreRedis,
} from '../dashboard/api/_lib/googleConnectionStore.js'
import { _resetReviewLocationIndexForTests } from '../dashboard/api/_lib/reviewLocationIndex.js'

// isValidTenantId() (tenants.js) requires /^t_[a-z0-9-]+$/ -- no
// underscores after the t_ prefix -- so the requested t_restaurant_group/
// t_other_company are represented here with hyphens instead.
const TENANT = 't_restaurant-group-e2e' // conceptually t_restaurant_group
const OTHER_TENANT = 't_other-company-e2e' // conceptually t_other_company
const TEST_GENERATION = 'gen-1'
const LOCATION_A = 1 // conceptually "location-a"
const LOCATION_B = 2 // conceptually "location-b"

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
    resetConfigRedis()
    resetUserRedis()
    resetBlobClient()
    sharedBlob = null
    resetCredentialRedis()
    resetConnStoreRedis()
    _resetMetaLocationsForTests()
    _resetReviewLocationIndexForTests()
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

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

function wireConfigRedis() {
  const store = {}
  setConfigRedis(() => ({
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
  }))
}

const sharedUsers = {}
function wireUserRedis() {
  const store = { 'users:v1': sharedUsers }
  setUserRedis(() => ({
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hget: async (key, field) => store[key]?.[field] ?? null,
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
  }))
}
function clearUsers() { for (const key of Object.keys(sharedUsers)) delete sharedUsers[key] }
function addUser(record) { sharedUsers[record.userId] = JSON.stringify(record) }

function fakeCredentialRedis() {
  const strings = {}
  const hashes = {}
  return {
    get: async (key) => (key in strings ? strings[key] : null),
    set: async (key, value) => { strings[key] = value },
    del: async (key) => { delete strings[key] },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      if (args.length === 2) {
        const [expectedVersionStr, nextJson] = args
        const raw = strings[key] ?? null
        let currentVersion = '0'
        if (raw) { try { const d = JSON.parse(raw); if (d?.credentialVersion !== undefined) currentVersion = String(d.credentialVersion) } catch {} }
        if (currentVersion !== expectedVersionStr) return raw ?? false
        strings[key] = nextJson
        return true
      }
      const [field, expectedVersionStr, nextJson] = args
      const raw = hashes[key]?.[field] ?? null
      let currentVersion = '0'
      if (raw) { try { const d = JSON.parse(raw); if (d?.credentialVersion !== undefined) currentVersion = String(d.credentialVersion) } catch {} }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      hashes[key] ??= {}
      hashes[key][field] = nextJson
      return true
    },
    hget: async (key, field) => hashes[key]?.[field] ?? null,
    hset: async (key, fields) => { hashes[key] = { ...(hashes[key] ?? {}), ...fields } },
    hgetall: async (key) => ({ ...(hashes[key] ?? {}) }),
    hdel: async (key, field) => { if (hashes[key]) delete hashes[key][field] },
  }
}
function wireCredentialAndConnectionRedis() {
  const client = fakeCredentialRedis()
  setCredentialRedis(() => client)
  setConnStoreRedis(() => client)
  return client
}

function fakeBlobStore() {
  const objects = new Map()
  const client = {
    put: async (pathname, buffer, opts) => {
      objects.set(pathname, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
      return { url: `https://fake.blob.test/${pathname}`, downloadUrl: `https://fake.blob.test/${pathname}`, pathname, contentType: opts?.contentType ?? 'application/octet-stream', contentDisposition: '', etag: 'fake-etag' }
    },
    get: async (pathname) => {
      if (!objects.has(pathname)) return null
      const data = objects.get(pathname)
      return {
        statusCode: 200, stream: Readable.from([data]), headers: new Map(),
        blob: { url: pathname, downloadUrl: pathname, pathname, contentType: 'application/json', contentDisposition: '', cacheControl: '', size: data.length, uploadedAt: new Date(), etag: 'fake-etag' },
      }
    },
    del: async (pathname) => { objects.delete(pathname) },
  }
  return { client, writeJson(key, data) { objects.set(key, Buffer.from(JSON.stringify(data))) } }
}

let sharedBlob = null
function currentBlob() {
  if (!sharedBlob) { sharedBlob = fakeBlobStore(); setBlobClient(() => sharedBlob.client) }
  return sharedBlob
}

async function provisionTenant(tenantId) {
  const blob = currentBlob()
  // The other tenant gets DISTINCTLY-named locations/reviews (never
  // "Location A"/"Location B") -- otherwise two identically-fixtured
  // tenants would trivially "share" content by coincidence and the
  // isolation assertion below would prove nothing.
  const isOtherTenant = tenantId === OTHER_TENANT
  const nameA = isOtherTenant ? 'Rival Diner' : 'Location A'
  const nameB = isOtherTenant ? 'Rival Grill' : 'Location B'
  const reviewIdA = isOtherTenant ? 'rival-review-1' : 'review-a-1'
  const reviewIdB = isOtherTenant ? 'rival-review-2' : 'review-b-1'

  blob.writeJson(generationPrivateDataBlobKey(tenantId, TEST_GENERATION, 'meta.json'), {
    locations: [
      { locationId: LOCATION_A, name: nameA, city: '', brand: 'Restaurant Group', slug: 'location-a', maps_url: '', hasContact: false },
      { locationId: LOCATION_B, name: nameB, city: '', brand: 'Restaurant Group', slug: 'location-b', maps_url: '', hasContact: false },
    ],
    brands: [], totalReviews: 2, generatedAt: new Date().toISOString(), initialSyncCompleted: true,
  })
  blob.writeJson(generationPrivateDataBlobKey(tenantId, TEST_GENERATION, 'reviews/by-location/location-a.json'), [
    { review_id: reviewIdA, review_url: `https://g.co/${reviewIdA}`, location_name: nameA, star_rating: 5, review_date: '2026-01-01', owner_response: '' },
  ])
  blob.writeJson(generationPrivateDataBlobKey(tenantId, TEST_GENERATION, 'reviews/by-location/location-b.json'), [
    { review_id: reviewIdB, review_url: `https://g.co/${reviewIdB}`, location_name: nameB, star_rating: 3, review_date: '2026-01-02', owner_response: '' },
  ])
  blob.writeJson(generationPrivateDataBlobKey(tenantId, TEST_GENERATION, 'action-items.json'), { unanswered: [] })
  blob.writeJson(generationPrivateDataBlobKey(tenantId, TEST_GENERATION, 'gbp-sync.json'), {
    locations: [
      { locationId: LOCATION_A, name: 'Location A', slug: 'location-a', linked: true, review_count: 1 },
      { locationId: LOCATION_B, name: 'Location B', slug: 'location-b', linked: true, review_count: 1 },
    ],
    lastRun: null,
  })
  blob.writeJson(generationPrivateDataBlobKey(tenantId, TEST_GENERATION, '_internal/review-location-index.json'), {
    'review-a-1': LOCATION_A, 'review-b-1': LOCATION_B,
    'accounts/1/locations/1/reviews/review-a-1': LOCATION_A,
    'accounts/1/locations/2/reviews/review-b-1': LOCATION_B,
  })

  await upsertTenantConfig(tenantId, {}, { allowCreate: true, creationSource: 'migration' })
  const config = await recordLocationApproval(tenantId, [
    { googleLocationId: 'accounts/1/locations/1', title: 'Location A', address: '' },
    { googleLocationId: 'accounts/1/locations/2', title: 'Location B', address: '' },
  ])
  await markTenantProvisioned(tenantId, {
    reviewDbBlobKey: reviewDbBlobKey(tenantId),
    privateDataPrefix: `tenant-data/${tenantId}/private-data/`,
    artifactGeneration: TEST_GENERATION,
    provisionedLocationIds: config.approvedLocations.map(l => l.locationId),
  })
  await upsertTenantConfig(tenantId, { status: 'active' })
}

function tokenFor({ userId, email, role, locationIds, tenantId }) {
  return signSession({ userId, email, role, locationIds, tenantId, sessionVersion: 1 })
}

async function invokeGoogle(action, { method = 'GET', body = {}, token } = {}) {
  const req = { method, query: { action }, body, headers: token ? { cookie: `lta_session=${token}` } : {}, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await googleHandler(req, res)
  return res
}

async function invokeData(fileParam, token) {
  const req = { method: 'GET', query: { file: fileParam }, body: {}, headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {} }
  const res = fakeRes()
  await dataHandler(req, res)
  return res
}

function mockConnectedGoogleFetch() {
  globalThis.fetch = async (url) => {
    if (typeof url === 'string' && url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'fresh-access-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/business.manage' }) }
    }
    if (typeof url === 'string' && url.includes('mybusinessaccountmanagement.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ accounts: [{ accountName: 'Restaurant Group LLC', name: 'accounts/1' }] }) }
    }
    throw new Error(`unexpected fetch during status(): ${url}`)
  }
}

// ===========================================================================
// Setup: the exact requested fixture (identity/role/location details
// preserved verbatim; see the file header for the locationId/role mapping
// note). Only the Owner has ever authenticated Google.
// ===========================================================================

async function setupFixture() {
  wireConfigRedis()
  wireUserRedis()
  wireCredentialAndConnectionRedis()
  clearUsers()
  const hash = await passwordHash()
  addUser({ userId: 'usr_owner', email: 'owner@restaurantgroup.test', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId: TENANT })
  addUser({ userId: 'usr_manager_a', email: 'manager-a@restaurantgroup.test', passwordHash: hash, role: 'location_manager', locationIds: [LOCATION_A], sessionVersion: 1, disabled: false, tenantId: TENANT })
  addUser({ userId: 'usr_manager_b', email: 'manager-b@restaurantgroup.test', passwordHash: hash, role: 'location_manager', locationIds: [LOCATION_B], sessionVersion: 1, disabled: false, tenantId: TENANT })
  addUser({ userId: 'usr_other_owner', email: 'owner@othercompany.test', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId: OTHER_TENANT })
  await provisionTenant(TENANT)
  await provisionTenant(OTHER_TENANT)
  // Only the Owner's OAuth round trip ever wrote a credential -- Manager A
  // and Manager B never call setStoredCredential/setSecondaryConnection at
  // all, for any tenant, anywhere in this file.
  await setStoredCredential(TENANT, { refreshToken: 'restaurant-group-real-refresh-token', connectedAccountName: 'Restaurant Group LLC' })
}

const ownerToken = () => tokenFor({ userId: 'usr_owner', email: 'owner@restaurantgroup.test', role: 'owner', locationIds: '*', tenantId: TENANT })
const managerAToken = () => tokenFor({ userId: 'usr_manager_a', email: 'manager-a@restaurantgroup.test', role: 'location_manager', locationIds: [LOCATION_A], tenantId: TENANT })
const managerBToken = () => tokenFor({ userId: 'usr_manager_b', email: 'manager-b@restaurantgroup.test', role: 'location_manager', locationIds: [LOCATION_B], tenantId: TENANT })
const otherOwnerToken = () => tokenFor({ userId: 'usr_other_owner', email: 'owner@othercompany.test', role: 'owner', locationIds: '*', tenantId: OTHER_TENANT })

// ===========================================================================
// #1-4: Owner, Manager A, and Manager B ALL see the organization's Google
// connection as connected -- neither manager is asked to reconnect merely
// because their own PRYOR email differs from whoever authenticated Google.
// ===========================================================================

async function testAllThreeUsersSeeTheOrganizationConnectionAsConnected() {
  await setupFixture()

  mockConnectedGoogleFetch()
  const ownerRes = await invokeGoogle('status', { token: await ownerToken() })
  mockConnectedGoogleFetch()
  const managerARes = await invokeGoogle('status', { token: await managerAToken() })
  mockConnectedGoogleFetch()
  const managerBRes = await invokeGoogle('status', { token: await managerBToken() })

  assert(ownerRes.body.connected === true, '#1 Owner must see the organization connection as connected')
  assert(managerARes.body.connected === true, '#2 Manager A must see the organization connection as connected')
  assert(managerBRes.body.connected === true, '#3 Manager B must see the organization connection as connected')
  assert(ownerRes.body.state === managerARes.body.state && managerARes.body.state === managerBRes.body.state)

  // #4: neither manager's response ever asks them to reconnect -- the
  // 'state' is the literal signal the frontend renders a Reconnect prompt
  // from (GoogleBusinessProfile.jsx's `needsRecovery`/RECOVERY_COPY); it
  // must be 'connected', never token_expired/token_revoked/auth_failed/
  // never_connected, for either manager, purely because manager-a@/
  // manager-b@restaurantgroup.test differ from whichever email actually
  // clicked "Connect Google Account".
  assert(managerARes.body.state === 'connected', '#4 Manager A must never be asked to reconnect merely because their PRYOR email differs from the connecting account')
  assert(managerBRes.body.state === 'connected', '#4 Manager B must never be asked to reconnect merely because their PRYOR email differs from the connecting account')
}

// ===========================================================================
// #5-7: location-scoped review visibility.
// ===========================================================================

async function testManagerASeesOnlyLocationAReviews() {
  await setupFixture()
  const res = await invokeData('reviews/by-location/location-a.json', await managerAToken())
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  const reviews = JSON.parse(res.body)
  assert(reviews.length === 1 && reviews[0].review_id === 'review-a-1')

  const deniedRes = await invokeData('reviews/by-location/location-b.json', await managerAToken())
  assert(deniedRes.statusCode === 404, `#5 Manager A must never see location-b's reviews, got ${deniedRes.statusCode}`)
}

async function testManagerBSeesOnlyLocationBReviews() {
  await setupFixture()
  const res = await invokeData('reviews/by-location/location-b.json', await managerBToken())
  assert(res.statusCode === 200)
  const reviews = JSON.parse(res.body)
  assert(reviews.length === 1 && reviews[0].review_id === 'review-b-1')

  const deniedRes = await invokeData('reviews/by-location/location-a.json', await managerBToken())
  assert(deniedRes.statusCode === 404, `#6 Manager B must never see location-a's reviews, got ${deniedRes.statusCode}`)
}

async function testOwnerSeesAllAuthorizedTenantLocations() {
  await setupFixture()
  const metaRes = await invokeData('meta.json', await ownerToken())
  const meta = JSON.parse(metaRes.body)
  assert(meta.locations.length === 2, `#7 Owner must see all of the tenant's authorized locations, got ${meta.locations.length}`)

  const aRes = await invokeData('reviews/by-location/location-a.json', await ownerToken())
  const bRes = await invokeData('reviews/by-location/location-b.json', await ownerToken())
  assert(aRes.statusCode === 200 && bRes.statusCode === 200, "the Owner's wildcard grant must reach both locations")
}

// ===========================================================================
// #8: the other tenant sees none of this tenant's reviews or credentials.
// ===========================================================================

async function testOtherTenantSeesNoneOfThisTenantsReviewsOrCredential() {
  await setupFixture()
  const otherToken = await otherOwnerToken()

  const statusRes = await invokeGoogle('status', { token: otherToken })
  assert(statusRes.body.connected === false, "#8 the other tenant must never inherit this tenant's Google connection")
  assert(statusRes.body.state === 'never_connected')

  const metaRes = await invokeData('meta.json', otherToken)
  const meta = JSON.parse(metaRes.body)
  assert(!JSON.stringify(meta).includes('Location A') && !JSON.stringify(meta).includes('Location B'),
    "#8 the other tenant's own meta.json must never contain this tenant's location names -- each tenant reads its own Blob-prefixed data")
}

// ===========================================================================
// #9-10: Manager A can publish for location-a using the TENANT credential;
// cannot publish for location-b.
// ===========================================================================

async function testManagerACanPublishForLocationAUsingTheTenantCredential() {
  await setupFixture()
  globalThis.fetch = async (url) => {
    if (typeof url === 'string' && url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'fresh-access-token', expires_in: 3600 }) }
    }
    if (typeof url === 'string' && url.includes('/reviews/review-a-1/reply')) {
      return { ok: true, status: 200, json: async () => ({ name: 'accounts/1/locations/1/reviews/review-a-1/reply' }) }
    }
    throw new Error(`unexpected fetch during publish(): ${url}`)
  }
  const res = await invokeGoogle('publish', {
    method: 'POST', token: await managerAToken(),
    body: { reviewName: 'accounts/1/locations/1/reviews/review-a-1', replyText: 'Thank you!', localReviewId: 'review-a-1' },
  })
  assert(res.statusCode === 200, `#9 expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.success === true)
}

async function testManagerACannotPublishForLocationB() {
  await setupFixture()
  globalThis.fetch = async (url) => { throw new Error(`must never reach Google for a request that should be denied first: ${url}`) }
  const res = await invokeGoogle('publish', {
    method: 'POST', token: await managerAToken(),
    body: { reviewName: 'accounts/1/locations/2/reviews/review-b-1', replyText: 'Thank you!', localReviewId: 'review-b-1' },
  })
  assert(res.statusCode === 404, `#10 Manager A must be denied publishing for location-b (404, existence-hiding), got ${res.statusCode}`)
}

// ===========================================================================
// #11: no Google credential is ever copied into either manager's own user
// record -- their stored account has no refresh-token-shaped field at all.
// ===========================================================================

async function testNoGoogleCredentialIsEverCopiedIntoAManagersUserRecord() {
  await setupFixture()
  // getAccountById() -- the same resolver evaluateSession() uses on every
  // authenticated request -- rather than userStore.js's tenant-scoped
  // getUserByEmail() directly, since these fixture records were seeded
  // straight into the shared bootstrap hash (addUser()), exactly mirroring
  // how a real un-indexed identity resolves in this codebase today.
  const managerA = await getAccountById('usr_manager_a')
  const managerB = await getAccountById('usr_manager_b')
  for (const [label, record] of [['Manager A', managerA], ['Manager B', managerB]]) {
    assert(record, `${label}'s user record must exist`)
    const serialized = JSON.stringify(record)
    assert(!('refreshToken' in record) && !('refreshTokenCiphertext' in record) && !('googleRefreshToken' in record),
      `#11 ${label}'s own user record must never carry any Google credential field`)
    assert(!serialized.includes('restaurant-group-real-refresh-token'), `#11 the Owner's real refresh token must never appear anywhere in ${label}'s own user record`)
  }
}

const tests = [
  ['#1-4: Owner, Manager A, and Manager B all see the organization connection as connected; neither manager is asked to reconnect over an email mismatch', testAllThreeUsersSeeTheOrganizationConnectionAsConnected],
  ['#5: Manager A sees only location-a reviews', testManagerASeesOnlyLocationAReviews],
  ['#6: Manager B sees only location-b reviews', testManagerBSeesOnlyLocationBReviews],
  ['#7: Owner sees all authorized tenant locations', testOwnerSeesAllAuthorizedTenantLocations],
  ["#8: the other tenant sees none of this tenant's reviews or credential", testOtherTenantSeesNoneOfThisTenantsReviewsOrCredential],
  ['#9: Manager A can publish for location-a using the tenant credential', testManagerACanPublishForLocationAUsingTheTenantCredential],
  ['#10: Manager A cannot publish for location-b', testManagerACannotPublishForLocationB],
  ["#11: no Google credential is ever copied into either manager's own user record", testNoGoogleCredentialIsEverCopiedIntoAManagersUserRecord],
]

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
