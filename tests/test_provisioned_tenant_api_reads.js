// Multi-Tenant Phase 4F, final closure (revised in Phase 4F.1 for
// Blob-backed storage) -- API-level proof that data.js (and, by the same
// readPrivateDataFile() code path, reviewLocationIndex.js/
// notificationEvents.js/reviewAssignmentProgress.js/locationContacts.js/
// settings/[action].js) resolves a genuinely provisioned-and-active
// tenant's OWN private-data artifacts dynamically from Vercel Blob -- never
// falling back to Los Tres Amigos's static (LEGACY_REPO) registry entry,
// never trusting a client-supplied tenantId, and never serving anything for
// a tenant that has not completed Initial Sync (status must be 'active',
// not merely 'provisioned').
//
// Uses a FAKE in-memory Blob client (blobStore.js's own
// _setBlobClientForTests seam) holding real JSON bytes at the exact keys
// tenantBlobKeys.js's formula computes, so this exercises the actual
// dynamic-resolution + Blob-read code path end to end, exactly as a real
// BLOB-mode tenant's request would -- no real Vercel Blob store, no real
// Upstash account, no real Google OAuth, no production data.
//
// Run directly: node tests/test_provisioned_tenant_api_reads.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import { Readable } from 'stream'
import dataHandler from '../dashboard/api/data.js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import {
  upsertTenantConfig, recordLocationApproval, markTenantProvisioned,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'
import { _setBlobClientForTests as setBlobClient, _resetBlobClientForTests as resetBlobClient } from '../dashboard/api/_lib/blobStore.js'
import { reviewDbBlobKey, privateDataPrefix as computePrivateDataPrefix, privateDataBlobKey } from '../dashboard/api/_lib/tenantBlobKeys.js'
import { _setMetaLocationsForTests, _resetMetaLocationsForTests } from '../dashboard/api/data.js'

const TENANT_B = 't_synthetic-provisioned-api-tenant'
const UNKNOWN_TENANT = 't_never-onboarded-provisioned-api-tenant'

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
    _resetMetaLocationsForTests()
  }
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

function wireConfigRedis() {
  const store = {}
  const client = {
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
  }
  setConfigRedis(() => client)
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

// Multi-Tenant Phase 4F.1 -- a minimal, in-memory stand-in for @vercel/blob
// itself (put/get/del), the SAME shape blobStore.js's real getClient()
// returns. Constructed ONCE per test and wired via
// _setBlobClientForTests(() => client) (never a factory that recreates the
// store on every call -- see this test suite's other files for why that
// bug pattern matters).
function fakeBlobStore() {
  const objects = new Map()
  const client = {
    put: async (pathname, buffer, opts) => {
      objects.set(pathname, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
      return { url: `https://fake.blob.test/${pathname}`, downloadUrl: `https://fake.blob.test/${pathname}`, pathname, contentType: opts?.contentType ?? 'application/octet-stream', contentDisposition: '', etag: 'fake-etag-1' }
    },
    get: async (pathname) => {
      if (!objects.has(pathname)) return null
      const data = objects.get(pathname)
      return {
        statusCode: 200,
        stream: Readable.from([data]),
        headers: new Map(),
        blob: { url: pathname, downloadUrl: pathname, pathname, contentType: 'application/json', contentDisposition: '', cacheControl: '', size: data.length, uploadedAt: new Date(), etag: 'fake-etag-1' },
      }
    },
    del: async (pathname) => { objects.delete(pathname) },
  }
  return {
    client,
    writeJson(key, data) { objects.set(key, Buffer.from(JSON.stringify(data))) },
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

async function setupTenantBAccount() {
  const hash = await passwordHash()
  const record = { userId: 'usr_b', email: 'b@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId: TENANT_B }
  setUserRedis(() => fakeUserRedis({ usr_b: JSON.stringify(record) }))
}

async function tokenForTenantB() {
  return signSession({ userId: 'usr_b', email: 'b@example.com', role: 'owner', locationIds: '*', tenantId: TENANT_B, sessionVersion: 1 })
}

async function invoke(fileParam, token, extra = {}) {
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

// Provisions TENANT_B for real: recordLocationApproval() (which also sets
// storageMode: 'BLOB') -> markTenantProvisioned() -> (simulated Phase 4G)
// status: 'active', with the exact empty-state artifacts provision_tenant.py
// would produce uploaded to the fake Blob store at the exact keys
// tenantBlobKeys.js's formula computes.
async function provisionTenantBWithBlobArtifacts() {
  const blob = fakeBlobStore()
  setBlobClient(() => blob.client)
  const prefix = computePrivateDataPrefix(TENANT_B)

  blob.writeJson(privateDataBlobKey(TENANT_B, 'meta.json', prefix), {
    distinctiveMarker: 'tenant-b-provisioned-meta',
    locations: [{ locationId: 1, name: 'Tenant B Restaurant', city: '', brand: 'Other', slug: 'tenant-b-restaurant', maps_url: '', hasContact: false }],
    brands: [], totalReviews: 0, generatedAt: new Date().toISOString(), initialSyncCompleted: false,
  })
  blob.writeJson(privateDataBlobKey(TENANT_B, 'reviews/by-location/tenant-b-restaurant.json', prefix), [])
  blob.writeJson(privateDataBlobKey(TENANT_B, 'action-items.json', prefix), { items: [] })
  blob.writeJson(privateDataBlobKey(TENANT_B, 'gbp-sync.json', prefix), { locations: [], neverSynced: true })
  blob.writeJson(privateDataBlobKey(TENANT_B, '_internal/review-location-index.json', prefix), {})

  const config = await recordLocationApproval(TENANT_B, [{ googleLocationId: 'accounts/1/locations/1', title: 'Tenant B Restaurant', address: '' }])
  await markTenantProvisioned(TENANT_B, {
    reviewDbBlobKey: reviewDbBlobKey(TENANT_B),
    privateDataPrefix: prefix,
    provisionedLocationIds: config.approvedLocations.map(l => l.locationId),
  })
  await upsertTenantConfig(TENANT_B, { status: 'active' }) // simulates Phase 4G's Initial Sync completion
  return blob
}

// ===========================================================================
// 1: Tenant B reads its own provisioned (empty) artifacts
// ===========================================================================

async function testTenantBReadsItsOwnProvisionedArtifacts() {
  wireConfigRedis()
  await setupTenantBAccount()
  await provisionTenantBWithBlobArtifacts()
  const token = await tokenForTenantB()

  const metaRes = await invoke('meta.json', token)
  assert(metaRes.statusCode === 200, `expected 200, got ${metaRes.statusCode} ${JSON.stringify(metaRes.body)}`)
  const meta = JSON.parse(metaRes.body)
  assert(meta.distinctiveMarker === 'tenant-b-provisioned-meta', 'must read Tenant B\'s own dynamically-resolved meta.json, not a static/LTA one')
  assert(meta.totalReviews === 0 && meta.initialSyncCompleted === false, 'a provisioned tenant\'s meta.json must honestly show zero reviews and sync-not-completed')

  const reviewsRes = await invoke('reviews/by-location/tenant-b-restaurant.json', token)
  assert(reviewsRes.statusCode === 200, `expected 200, got ${reviewsRes.statusCode}`)
  assert(JSON.parse(reviewsRes.body).length === 0, 'a provisioned-but-unsynced tenant\'s per-location file must be an empty array, never fabricated reviews')
}

// ===========================================================================
// 2: Tenant B cannot read LTA's real artifacts
// ===========================================================================

async function testTenantBCannotReadLtaArtifacts() {
  wireConfigRedis()
  await setupTenantBAccount()
  await provisionTenantBWithBlobArtifacts()
  const token = await tokenForTenantB()

  // Tenant B's own meta.json must never contain anything resembling LTA's
  // real location roster (proven via the distinctive marker above, which
  // already establishes the file read came from Tenant B's own Blob
  // objects, not LTA's static dashboard/private-data/meta.json).
  const metaRes = await invoke('meta.json', token)
  const meta = JSON.parse(metaRes.body)
  assert(!JSON.stringify(meta).includes('Los Tres Amigos'), 'Tenant B must never receive any LTA-identifying content')

  // A path that only exists in LTA's real, static private-data directory
  // (never uploaded to Blob for Tenant B) must 404, never silently fall
  // back to LTA's own file for the same relative path.
  const foreignSlugRes = await invoke('reviews/by-location/casa-tequila-prime.json', token)
  assert(foreignSlugRes.statusCode === 404, `a slug that only exists for LTA must 404 for Tenant B, got ${foreignSlugRes.statusCode}`)
}

// ===========================================================================
// 3: A provisioned-but-not-yet-active tenant still fails closed on reads
// ===========================================================================

async function testProvisionedButNotActiveTenantFailsClosedOnReads() {
  wireConfigRedis()
  await setupTenantBAccount()
  await provisionTenantBWithBlobArtifacts()
  // Undo the simulated Phase 4G step -- back to genuinely 'provisioned'
  // (real, verified Blob objects exist, exactly like a real pre-Initial-
  // Sync tenant), never 'active'.
  await upsertTenantConfig(TENANT_B, { status: 'provisioned' })
  const token = await tokenForTenantB()

  const res = await invoke('meta.json', token)
  assert(res.statusCode === 404, `a provisioned-but-not-active tenant must fail closed (404) on every data read, got ${res.statusCode}`)
}

// ===========================================================================
// 4: Forged tenantId in query/body/header cannot redirect the read
// ===========================================================================

async function testForgedTenantIdCannotRedirectRead() {
  wireConfigRedis()
  await setupTenantBAccount()
  await provisionTenantBWithBlobArtifacts()
  const token = await tokenForTenantB()

  const res = await invoke('meta.json', token, {
    query: { tenantId: DEFAULT_TENANT_ID },
    body: { tenantId: DEFAULT_TENANT_ID },
    headers: { 'x-tenant-id': DEFAULT_TENANT_ID },
  })
  assert(res.statusCode === 200, `Tenant B's own legitimate read must still succeed despite the forged fields, got ${res.statusCode}`)
  const meta = JSON.parse(res.body)
  assert(meta.distinctiveMarker === 'tenant-b-provisioned-meta', 'a forged tenantId anywhere in the request must never redirect the resolved root')
}

// ===========================================================================
// 5: Unknown tenant fails closed before any Blob access
// ===========================================================================

async function testUnknownTenantFailsClosed() {
  wireConfigRedis()
  const hash = await passwordHash()
  const record = { userId: 'usr_unknown', email: 'unknown@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId: UNKNOWN_TENANT }
  setUserRedis(() => fakeUserRedis({ usr_unknown: JSON.stringify(record) }))
  const token = await signSession({ userId: 'usr_unknown', email: 'unknown@example.com', role: 'owner', locationIds: '*', tenantId: UNKNOWN_TENANT, sessionVersion: 1 })

  const res = await invoke('meta.json', token)
  assert(res.statusCode === 404, `an unknown tenant must fail closed (404), got ${res.statusCode}`)
}

async function main() {
  await run('Tenant B reads its own provisioned (empty) artifacts', testTenantBReadsItsOwnProvisionedArtifacts)
  await run('Tenant B cannot read LTA\'s real artifacts', testTenantBCannotReadLtaArtifacts)
  await run('a provisioned-but-not-yet-active tenant fails closed on reads', testProvisionedButNotActiveTenantFailsClosedOnReads)
  await run('a forged tenantId in query/body/header cannot redirect the read', testForgedTenantIdCannotRedirectRead)
  await run('an unknown tenant fails closed', testUnknownTenantFailsClosed)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exitCode = 0
    return
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exitCode = 1
}

main()
