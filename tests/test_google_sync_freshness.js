// "Last Successful Sync" investigation (Google Integration + Reviews
// End-to-End Validation, sync-freshness follow-up) -- proves the reported
// production bug is fixed: a routine connectivity check (status(), test-
// connection, a publish reply) must NEVER be recorded as a real data sync.
// "Last Data Sync" is sourced EXCLUSIVELY from gbp-sync.json's own lastRun
// (written only by the Python sync pipeline), independent of
// credentialStore.js's connectivity-check bookkeeping, tenant-wide (not
// per-user), and independent of the linked-location COUNT (linkage is a
// mapping fact; freshness is a separate, time-based fact).
//
// Run directly: node tests/test_google_sync_freshness.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'

import bcrypt from 'bcryptjs'
import { Readable } from 'stream'
import googleHandler from '../dashboard/api/google/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import {
  upsertTenantConfig, recordLocationApproval, markTenantProvisioned,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'
import { _setBlobClientForTests as setBlobClient, _resetBlobClientForTests as resetBlobClient } from '../dashboard/api/_lib/blobStore.js'
import { reviewDbBlobKey, generationPrivateDataBlobKey } from '../dashboard/api/_lib/tenantBlobKeys.js'
import {
  setStoredCredential, getStoredCredential,
  _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis,
} from '../dashboard/api/_lib/credentialStore.js'
import { _setRedisClientForTests as setConnStoreRedis, _resetRedisClientForTests as resetConnStoreRedis } from '../dashboard/api/_lib/googleConnectionStore.js'

const TENANT = 't_sync-freshness-e2e'
const TEST_GENERATION = 'gen-1'

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
    globalThis.fetch = undefined
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
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
    // Phase A3 ("fix location approval concurrency"): recordLocationApproval()
    // now always CAS-writes via client.eval -- faithfully emulates
    // tenantConfigStore.js's CAS_UPSERT_SCRIPT (HGET/compare-configVersion/HSET).
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [field, expectedVersionStr, nextJson] = args
      const raw = store[key]?.[field] ?? null
      let currentVersion = '0'
      if (raw) {
        try { const decoded = JSON.parse(raw); if (decoded && decoded.configVersion !== undefined) currentVersion = String(decoded.configVersion) } catch { /* treat as version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
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

// Provisions the tenant with two linked locations and an explicit
// gbp-sync.json `lastRun` -- the ONLY thing that should ever move
// lastDataSyncAt/lastDataSyncStatus in the status() response.
async function provisionTenant({ lastRun } = {}) {
  const blob = currentBlob()
  blob.writeJson(generationPrivateDataBlobKey(TENANT, TEST_GENERATION, 'meta.json'), {
    locations: [{ locationId: 1, name: 'Location One', city: '', brand: 'Brand', slug: 'location-one', maps_url: '', hasContact: false }],
    brands: [], totalReviews: 1, generatedAt: new Date().toISOString(), initialSyncCompleted: true,
  })
  blob.writeJson(generationPrivateDataBlobKey(TENANT, TEST_GENERATION, 'reviews/by-location/location-one.json'), [])
  blob.writeJson(generationPrivateDataBlobKey(TENANT, TEST_GENERATION, 'action-items.json'), { unanswered: [] })
  blob.writeJson(generationPrivateDataBlobKey(TENANT, TEST_GENERATION, 'gbp-sync.json'), {
    locations: [{ locationId: 1, name: 'Location One', slug: 'location-one', linked: true, review_count: 0 }],
    lastRun: lastRun ?? null,
  })
  blob.writeJson(generationPrivateDataBlobKey(TENANT, TEST_GENERATION, '_internal/review-location-index.json'), {})

  await upsertTenantConfig(TENANT, {}, { allowCreate: true, creationSource: 'migration' })
  const config = await recordLocationApproval(TENANT, [{ googleLocationId: 'accounts/1/locations/1', title: 'Location One', address: '' }])
  await markTenantProvisioned(TENANT, {
    reviewDbBlobKey: reviewDbBlobKey(TENANT),
    privateDataPrefix: `tenant-data/${TENANT}/private-data/`,
    artifactGeneration: TEST_GENERATION,
    provisionedLocationIds: config.approvedLocations.map(l => l.locationId),
  })
  await upsertTenantConfig(TENANT, { status: 'active' })
}

function tokenFor({ userId, email, role, locationIds }) {
  return signSession({ userId, email, role, locationIds, tenantId: TENANT, sessionVersion: 1 })
}

async function invokeGoogle(action, { method = 'GET', body = {}, token } = {}) {
  const req = { method, query: { action }, body, headers: token ? { cookie: `lta_session=${token}` } : {}, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await googleHandler(req, res)
  return res
}

async function setupWithOwnerAndManager() {
  wireConfigRedis()
  wireUserRedis()
  wireCredentialAndConnectionRedis()
  clearUsers()
  const hash = await passwordHash()
  addUser({ userId: 'usr_owner', email: 'owner@sync-freshness.test', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId: TENANT })
  addUser({ userId: 'usr_manager', email: 'manager@sync-freshness.test', passwordHash: hash, role: 'location_manager', locationIds: [1], sessionVersion: 1, disabled: false, tenantId: TENANT })
}

const ownerToken = () => tokenFor({ userId: 'usr_owner', email: 'owner@sync-freshness.test', role: 'owner', locationIds: '*' })
const managerToken = () => tokenFor({ userId: 'usr_manager', email: 'manager@sync-freshness.test', role: 'location_manager', locationIds: [1] })

function mockConnectedGoogleFetch() {
  globalThis.fetch = async (url) => {
    if (typeof url === 'string' && url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'fresh-access-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/business.manage' }) }
    }
    if (typeof url === 'string' && url.includes('mybusinessaccountmanagement.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ accounts: [{ accountName: 'Sync Freshness Test Co', name: 'accounts/1' }] }) }
    }
    throw new Error(`unexpected fetch during status(): ${url}`)
  }
}

// ===========================================================================
// A real sync (gbp-sync.json's own lastRun) sets lastDataSyncAt/Status.
// ===========================================================================

async function testARealSyncSetsLastDataSyncFields() {
  await setupWithOwnerAndManager()
  const finishedAt = '2026-09-06T20:17:04.505736+00:00'
  await provisionTenant({ lastRun: { mode: 'api_sync', status: 'success', started_at: '2026-09-06T20:10:00Z', finished_at: finishedAt } })
  await setStoredCredential(TENANT, { refreshToken: 'real-refresh-token', connectedAccountName: 'Sync Freshness Test Co' })

  mockConnectedGoogleFetch()
  const res = await invokeGoogle('status', { token: await ownerToken() })
  assert(res.body.lastDataSyncAt === finishedAt, `expected lastDataSyncAt to come from gbp-sync.json's lastRun.finished_at, got ${res.body.lastDataSyncAt}`)
  assert(res.body.lastDataSyncStatus === 'success')
}

async function testAFailedSyncNeverReportsSuccess() {
  await setupWithOwnerAndManager()
  await provisionTenant({ lastRun: { mode: 'api_sync', status: 'failed', started_at: '2026-09-06T20:10:00Z', finished_at: '2026-09-06T20:11:00Z' } })
  await setStoredCredential(TENANT, { refreshToken: 'real-refresh-token', connectedAccountName: 'Sync Freshness Test Co' })

  mockConnectedGoogleFetch()
  const res = await invokeGoogle('status', { token: await ownerToken() })
  assert(res.body.lastDataSyncStatus === 'failed', `a failed sync run must report its real status, not "success", got ${res.body.lastDataSyncStatus}`)
}

// ===========================================================================
// The core reported bug: token refresh / status() / test-connection / a
// publish reply must NEVER move lastDataSyncAt -- it is read-only from
// gbp-sync.json inside google/[action].js, entirely independent of
// credentialStore.js's own bookkeeping.
// ===========================================================================

async function testRepeatedStatusChecksNeverChangeLastDataSyncAt() {
  await setupWithOwnerAndManager()
  const fixedLastRun = { mode: 'api_sync', status: 'success', started_at: '2026-09-06T20:10:00Z', finished_at: '2026-09-06T20:17:04Z' }
  await provisionTenant({ lastRun: fixedLastRun })
  await setStoredCredential(TENANT, { refreshToken: 'real-refresh-token', connectedAccountName: 'Sync Freshness Test Co' })

  mockConnectedGoogleFetch()
  const first = await invokeGoogle('status', { token: await ownerToken() })
  mockConnectedGoogleFetch()
  const second = await invokeGoogle('status', { token: await ownerToken() })
  mockConnectedGoogleFetch()
  const third = await invokeGoogle('status', { token: await ownerToken() })

  assert(first.body.lastDataSyncAt === fixedLastRun.finished_at)
  assert(second.body.lastDataSyncAt === fixedLastRun.finished_at, 'a second, later status() call must report the exact same lastDataSyncAt -- no polling can move it')
  assert(third.body.lastDataSyncAt === fixedLastRun.finished_at, 'nor can a third')

  // Directly confirms the underlying credential record itself was never
  // touched in a way that would fabricate a sync -- lastSuccessfulSyncAt
  // stays null throughout.
  const credential = await getStoredCredential(TENANT)
  assert(credential.lastSuccessfulSyncAt === null, 'repeated status() polling must never stamp lastSuccessfulSyncAt')
}

async function testTestConnectionNeverChangesLastDataSyncAt() {
  await setupWithOwnerAndManager()
  const fixedLastRun = { mode: 'api_sync', status: 'success', started_at: '2026-09-06T20:10:00Z', finished_at: '2026-09-06T20:17:04Z' }
  await provisionTenant({ lastRun: fixedLastRun })
  await setStoredCredential(TENANT, { refreshToken: 'real-refresh-token', connectedAccountName: 'Sync Freshness Test Co' })

  globalThis.fetch = async (url) => {
    if (typeof url !== 'string') throw new Error('unexpected non-string fetch url')
    if (url.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600, scope: 'https://www.googleapis.com/auth/business.manage' }) }
    if (url.includes('mybusinessaccountmanagement.googleapis.com')) return { ok: true, status: 200, json: async () => ({ accounts: [{ accountName: 'Sync Freshness Test Co', name: 'accounts/1' }] }) }
    if (url.includes('mybusinessbusinessinformation.googleapis.com')) return { ok: true, status: 200, json: async () => ({ locations: [{ name: 'locations/1', title: 'Location One' }] }) }
    if (url.includes('mybusiness.googleapis.com/v4') && url.includes('/reviews')) return { ok: true, status: 200, json: async () => ({ reviews: [] }) }
    throw new Error(`unexpected fetch during test-connection: ${url}`)
  }
  const res = await invokeGoogle('test-connection', { token: await ownerToken() })
  assert(res.body.overallStatus === 'pass', `expected the diagnostic to pass, got ${JSON.stringify(res.body)}`)

  const credential = await getStoredCredential(TENANT)
  assert(credential.lastSuccessfulSyncAt === null, 'running the full test-connection diagnostic (a real, multi-call live walk) must still never stamp lastSuccessfulSyncAt')
  assert(credential.lastConnectionCheckStatus === 'success', 'it IS recorded as a connectivity check, just never as a data sync')

  mockConnectedGoogleFetch()
  const statusAfter = await invokeGoogle('status', { token: await ownerToken() })
  assert(statusAfter.body.lastDataSyncAt === fixedLastRun.finished_at, 'lastDataSyncAt must be completely unaffected by having just run test-connection')
}

// ===========================================================================
// Linked-location count is independent of sync freshness -- "linked" is a
// mapping fact (does PRYOR know which Google location this maps to), not a
// claim about how recently that location's data was refreshed.
// ===========================================================================

async function testLinkedLocationCountIsIndependentOfSyncFreshness() {
  await setupWithOwnerAndManager()
  // No lastRun at all (never synced) -- the location is still marked
  // `linked: true` in the fixture (PRYOR knows the mapping), simulating a
  // freshly-linked-but-never-actually-synced location.
  await provisionTenant({ lastRun: null })
  await setStoredCredential(TENANT, { refreshToken: 'real-refresh-token', connectedAccountName: 'Sync Freshness Test Co' })

  mockConnectedGoogleFetch()
  const res = await invokeGoogle('status', { token: await ownerToken() })
  assert(res.body.linkedLocationCount === 1, 'linkage must be reported even when this tenant has never had a real sync run')
  assert(res.body.lastDataSyncAt === null, 'no sync has ever run, so there must be no fabricated sync timestamp')
  assert(res.body.lastDataSyncStatus === null)
}

// ===========================================================================
// Organization-wide, not personal: the Owner and a completely different
// Manager (different email, own location grant) see the IDENTICAL
// lastDataSyncAt -- there is no such thing as "my own" sync timestamp.
// ===========================================================================

async function testSameTenantUsersSeeTheIdenticalOrganizationSyncTimestamp() {
  await setupWithOwnerAndManager()
  const fixedLastRun = { mode: 'api_sync', status: 'success', started_at: '2026-09-06T20:10:00Z', finished_at: '2026-09-06T20:17:04Z' }
  await provisionTenant({ lastRun: fixedLastRun })
  await setStoredCredential(TENANT, { refreshToken: 'real-refresh-token', connectedAccountName: 'Sync Freshness Test Co' })

  mockConnectedGoogleFetch()
  const ownerRes = await invokeGoogle('status', { token: await ownerToken() })
  mockConnectedGoogleFetch()
  const managerRes = await invokeGoogle('status', { token: await managerToken() })

  assert(ownerRes.body.lastDataSyncAt === managerRes.body.lastDataSyncAt, "the Owner and a Manager with a completely different email must see the SAME organization sync timestamp, never a personal one")
  assert(ownerRes.body.lastDataSyncAt === fixedLastRun.finished_at)
  assert(ownerRes.body.lastDataSyncStatus === managerRes.body.lastDataSyncStatus)
}

const tests = [
  ["a real sync (gbp-sync.json's own lastRun) sets lastDataSyncAt/lastDataSyncStatus", testARealSyncSetsLastDataSyncFields],
  ['a failed sync run reports its real failed status, never success', testAFailedSyncNeverReportsSuccess],
  ['repeated status() polling never changes lastDataSyncAt or stamps lastSuccessfulSyncAt', testRepeatedStatusChecksNeverChangeLastDataSyncAt],
  ['running the full test-connection diagnostic never changes lastDataSyncAt or stamps lastSuccessfulSyncAt', testTestConnectionNeverChangesLastDataSyncAt],
  ['the linked-location count is reported independently of whether a sync has ever run', testLinkedLocationCountIsIndependentOfSyncFreshness],
  ['the Owner and a Manager with a different email see the identical, organization-wide sync timestamp -- never a personal one', testSameTenantUsersSeeTheIdenticalOrganizationSyncTimestamp],
]

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
