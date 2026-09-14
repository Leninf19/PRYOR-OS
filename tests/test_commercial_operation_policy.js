// Phase B.7 -- commercial status + suspension enforcement. Regression
// tests for:
//   - dashboard/api/_lib/commercialOperationPolicy.js (requireCommercialOperation()/
//     commercialDenialResponse() -- the ONE centralized operation-class
//     policy decision, and its resolver-failure asymmetry)
//   - Every call site wired into it this phase: google/[action].js's
//     publish()/discover-locations/trigger-sync/trigger-import,
//     tenantConfigStore.js's recordLocationApproval() CAPACITY_EXPANSION
//     gate, settings/[action].js's invite-user/enable-user/resend-invite/
//     contacts-send-test-email, session/[action].js's accept-invite,
//     tasks/[action].js's create/update, content/[action].js's
//     upsert-campaign/create-text-asset, actions/[action].js's
//     send-review-email/update-email-status/update.
//
// Phase A/B.2-B.6 behavior (rate limits, numeric location/seat limits, AI/
// storage quota, feature gating, trial lifecycle) is covered by its own
// existing test files and is not re-tested here except where this phase's
// new operation-class layer interacts with it.
//
// Run directly: node tests/test_commercial_operation_policy.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'

import bcrypt from 'bcryptjs'
import { Readable } from 'stream'
import { readFileSync } from 'fs'
import {
  requireCommercialOperation, commercialDenialResponse, CommercialOperationClass,
} from '../dashboard/api/_lib/commercialOperationPolicy.js'
import { COMMERCIAL_STATUSES, RESOLUTION_FAILURE_STATUSES, LEGACY_UNMANAGED_PLAN, legacyUnmanagedBundle } from '../dashboard/api/_lib/entitlementResolution.js'

import googleHandler from '../dashboard/api/google/[action].js'
import settingsHandler from '../dashboard/api/settings/[action].js'
import sessionHandler from '../dashboard/api/session/[action].js'
import tasksHandler from '../dashboard/api/tasks/[action].js'
import contentHandler from '../dashboard/api/content/[action].js'

import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import {
  upsertTenantConfig, getTenantConfig, recordLocationApproval, markTenantProvisioned,
  CommercialCapacityRestrictedError,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import {
  upsertUser, UserCreationMode,
  _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis,
} from '../dashboard/api/_lib/userStore.js'
import {
  peekInviteToken,
  _setRedisClientForTests as setTokenRedis, _resetRedisClientForTests as resetTokenRedis,
} from '../dashboard/api/_lib/tokenStore.js'
import {
  _setRedisClientForTests as setSeatLockRedis, _resetRedisClientForTests as resetSeatLockRedis,
} from '../dashboard/api/_lib/seatAllocationLock.js'
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
import { _setRedisClientForTests as setTaskRedis, _resetRedisClientForTests as resetTaskRedis } from '../dashboard/api/_lib/taskStore.js'
import { _setRedisClientForTests as setCampaignRedis, _resetRedisClientForTests as resetCampaignRedis } from '../dashboard/api/_lib/campaignStore.js'
import {
  getAllAssets, createAsset,
  _setRedisClientForTests as setContentAssetRedis, _resetRedisClientForTests as resetContentAssetRedis,
} from '../dashboard/api/_lib/contentAssetStore.js'
import { _setLimiterFactoryForTests, _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
import { _setRedisClientForTests as setAuditRedis, _resetRedisClientForTests as resetAuditRedis } from '../dashboard/api/_lib/auditLog.js'
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
    resetConfigRedis(); resetUserRedis(); resetTokenRedis(); resetSeatLockRedis()
    resetBlobClient(); sharedBlob = null
    resetCredentialRedis(); resetConnStoreRedis(); _resetReviewLocationIndexForTests()
    resetTaskRedis(); resetCampaignRedis(); resetContentAssetRedis(); resetAuditRedis()
    _resetLimiterFactoryForTests()
  }
}

// ===========================================================================
// Part 1: pure requireCommercialOperation()/commercialDenialResponse() --
// the full status x class matrix, resolver-failure asymmetry, legacy.
// ===========================================================================

function bundleFor(commercialStatus, plan = 'growth') {
  return { plan, effectivePlan: plan, commercialStatus, reason: `${commercialStatus}_reason`, limits: {}, features: {} }
}

const ALL_CLASSES = Object.values(CommercialOperationClass)

function testEveryClassAllowsTrialAndActive() {
  for (const cls of ALL_CLASSES) {
    for (const status of ['trial', 'active']) {
      const result = requireCommercialOperation(bundleFor(status), cls)
      assert(result.allowed === true, `${cls} must allow ${status}, got ${JSON.stringify(result)}`)
    }
  }
}

function testSuspendedAndCanceledDenyEveryRiskClass() {
  const riskClasses = [
    CommercialOperationClass.OPERATIONAL_WRITE, CommercialOperationClass.COST_GENERATING,
    CommercialOperationClass.INTEGRATION_OPERATION, CommercialOperationClass.INTEGRATION_EXPANSION,
    CommercialOperationClass.CAPACITY_EXPANSION,
  ]
  for (const cls of riskClasses) {
    for (const status of ['suspended', 'canceled']) {
      const result = requireCommercialOperation(bundleFor(status), cls)
      assert(result.allowed === false && result.denialKind === 'commercial_status',
        `${cls} must deny ${status} as a commercial_status denial, got ${JSON.stringify(result)}`)
      assert(result.commercialStatus === status, `denial must echo back the real commercialStatus, got ${JSON.stringify(result)}`)
    }
  }
}

function testSafeClassesAlwaysAllowedRegardlessOfStatus() {
  const safeClasses = [CommercialOperationClass.READ_BASIC, CommercialOperationClass.SECURITY_MAINTENANCE, CommercialOperationClass.RESOURCE_REDUCTION]
  for (const cls of safeClasses) {
    for (const status of COMMERCIAL_STATUSES) {
      const result = requireCommercialOperation(bundleFor(status), cls)
      assert(result.allowed === true, `${cls} must always allow ${status} (safe class), got ${JSON.stringify(result)}`)
    }
  }
}

function testPastDueBoundary() {
  // past_due is the single most important boundary in this phase: real
  // OPERATIONAL_WRITE/COST_GENERATING/INTEGRATION_OPERATION (ordinary use
  // of an ALREADY-connected integration -- sync/import) must continue
  // (billing grace), but CAPACITY_EXPANSION/INTEGRATION_EXPANSION (new
  // integration capability, or exploring for more capacity) must NOT
  // (grace is not a license to grow).
  assert(requireCommercialOperation(bundleFor('past_due'), CommercialOperationClass.OPERATIONAL_WRITE).allowed === true, 'past_due must allow OPERATIONAL_WRITE')
  assert(requireCommercialOperation(bundleFor('past_due'), CommercialOperationClass.COST_GENERATING).allowed === true, 'past_due must allow COST_GENERATING')
  assert(requireCommercialOperation(bundleFor('past_due'), CommercialOperationClass.INTEGRATION_OPERATION).allowed === true, 'past_due must allow INTEGRATION_OPERATION (existing sync/import continues during billing grace)')
  assert(requireCommercialOperation(bundleFor('past_due'), CommercialOperationClass.CAPACITY_EXPANSION).allowed === false, 'past_due must deny CAPACITY_EXPANSION')
  assert(requireCommercialOperation(bundleFor('past_due'), CommercialOperationClass.INTEGRATION_EXPANSION).allowed === false, 'past_due must deny INTEGRATION_EXPANSION (new connect/reconnect/discovery)')
}

function testLegacyUnmanagedAlwaysAllowedForEveryClass() {
  const legacy = legacyUnmanagedBundle('bootstrap')
  assert(legacy.plan === LEGACY_UNMANAGED_PLAN, 'sanity: legacyUnmanagedBundle must report the sentinel plan')
  for (const cls of ALL_CLASSES) {
    const result = requireCommercialOperation(legacy, cls)
    assert(result.allowed === true, `legacy/unmanaged must be allowed for ${cls} regardless of its reported commercialStatus, got ${JSON.stringify(result)}`)
  }
}

function testResolverFailureFailsClosedForRiskClassesOnly() {
  for (const failureStatus of RESOLUTION_FAILURE_STATUSES) {
    const bundle = bundleFor(failureStatus)
    for (const cls of [CommercialOperationClass.OPERATIONAL_WRITE, CommercialOperationClass.COST_GENERATING, CommercialOperationClass.INTEGRATION_OPERATION, CommercialOperationClass.INTEGRATION_EXPANSION, CommercialOperationClass.CAPACITY_EXPANSION]) {
      const result = requireCommercialOperation(bundle, cls)
      assert(result.allowed === false && result.denialKind === 'resolver_failure', `${cls} must fail closed on ${failureStatus}, got ${JSON.stringify(result)}`)
    }
    for (const cls of [CommercialOperationClass.READ_BASIC, CommercialOperationClass.SECURITY_MAINTENANCE, CommercialOperationClass.RESOURCE_REDUCTION]) {
      const result = requireCommercialOperation(bundle, cls)
      assert(result.allowed === true, `${cls} must remain allowed even on a resolver failure (${failureStatus}) -- security/reduction must not become impossible during an outage, got ${JSON.stringify(result)}`)
    }
  }
}

function testNullOrMissingEntitlementsTreatedAsResolverFailure() {
  const risky = requireCommercialOperation(null, CommercialOperationClass.CAPACITY_EXPANSION)
  assert(risky.allowed === false && risky.denialKind === 'resolver_failure', `null entitlements must fail closed for a risk class, got ${JSON.stringify(risky)}`)
  const safe = requireCommercialOperation(undefined, CommercialOperationClass.RESOURCE_REDUCTION)
  assert(safe.allowed === true, `null entitlements must still allow a safe class, got ${JSON.stringify(safe)}`)
}

function testUnrecognizedCommercialStatusTreatedAsResolverFailure() {
  // Defensive: the resolver's own closed output set should never produce
  // this, but requireCommercialOperation() must never silently allow an
  // out-of-band status value.
  const bundle = bundleFor('some-made-up-status')
  const result = requireCommercialOperation(bundle, CommercialOperationClass.OPERATIONAL_WRITE)
  assert(result.allowed === false && result.denialKind === 'resolver_failure', `an unrecognized status must be treated as a resolver failure, got ${JSON.stringify(result)}`)
}

function testUnknownOperationClassThrows() {
  let threw = false
  try { requireCommercialOperation(bundleFor('active'), 'NOT_A_REAL_CLASS') } catch { threw = true }
  assert(threw, 'an unrecognized operation class must throw, never silently allow or deny')
}

function testCommercialDenialResponseShapes() {
  const statusDenial = requireCommercialOperation(bundleFor('suspended'), CommercialOperationClass.OPERATIONAL_WRITE)
  const r1 = commercialDenialResponse(statusDenial)
  assert(r1.status === 403 && r1.body.error === 'commercial_access_restricted' && r1.body.commercialStatus === 'suspended',
    `a real denial must be a safe 403 commercial_access_restricted, got ${JSON.stringify(r1)}`)
  assert(!('accessCodeHash' in r1.body) && !('billingProviderId' in r1.body), 'denial body must never leak internal claim/billing fields')

  const failureDenial = requireCommercialOperation(bundleFor('unknown'), CommercialOperationClass.OPERATIONAL_WRITE)
  const r2 = commercialDenialResponse(failureDenial)
  assert(r2.status === 503 && r2.body.error === 'service_unavailable',
    `a resolver failure must be a 503 service_unavailable, never disguised as an upgrade prompt, got ${JSON.stringify(r2)}`)
  assert(!('commercialStatus' in r2.body), 'a resolver-failure response must never claim a commercialStatus it does not actually know')
}

// ===========================================================================
// Fixture plumbing shared by the HTTP-level proofs below (adapted from
// test_multi_user_tenant_e2e.js's established multi-tenant Google fixture).
// ===========================================================================

const TENANT = 't_b7-policy-tenant'
const LOCATION_A = 1
const TEST_GENERATION = 'gen-1'

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {}, redirectedTo: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.send = (str) => { res.body = str; return res }
  res.setHeader = (name, value) => { res.headers[name] = value; return res }
  res.getHeader = (name) => res.headers[name]
  // auth()'s SUCCESS path (a real OAuth redirect to Google) calls this --
  // needed so a test proving "not denied" for a class that allows
  // INTEGRATION_EXPANSION doesn't crash before ever reaching the
  // commercial check's own res.status()/res.send() denial path.
  res.redirect = (code, url) => { res.statusCode = code; res.redirectedTo = url; return res }
  return res
}

function noopRateLimit() {
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: true, remaining: 999, reset: Date.now() + 60000 }) }))
}

function newShapeCommercial(overrides = {}) {
  return {
    commercialStatus: 'active', plan: 'growth', planSource: 'access_code',
    trial: null, limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
    accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

function fakeKeyedHashRedis() {
  const store = {}
  return {
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [field, expectedVersionStr, nextJson] = args
      const raw = store[key]?.[field] ?? null
      let currentVersion = '0'
      if (raw) {
        try { const decoded = JSON.parse(raw); if (decoded && decoded.configVersion !== undefined) currentVersion = String(decoded.configVersion) } catch { /* version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
  }
}
function installFakeConfigRedis() { const c = fakeKeyedHashRedis(); setConfigRedis(() => c); return c }
function installFakeUserRedis() { const c = fakeKeyedHashRedis(); setUserRedis(() => c); return c }
function installFakeTaskRedis() { const c = fakeKeyedHashRedis(); setTaskRedis(() => c); return c }
function installFakeCampaignRedis() { const c = fakeKeyedHashRedis(); setCampaignRedis(() => c); return c }
function installFakeSeatLock() {
  const held = new Set()
  setSeatLockRedis(() => ({
    set: async (key, _v, opts) => { if (opts?.nx && held.has(key)) return null; held.add(key); return 'OK' },
    del: async (key) => { held.delete(key); return 1 },
    eval: async (_s, keys) => { held.delete(keys[0]); return 1 },
  }))
}
function fakeTokenRedis() {
  const store = {}
  return {
    set: async (k, v) => { store[k] = v },
    get: async (k) => store[k] ?? null,
    getdel: async (k) => { const v = store[k] ?? null; delete store[k]; return v },
    del: async (k) => { delete store[k] },
  }
}

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

let sharedBlob = null
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
function currentBlob() {
  if (!sharedBlob) { sharedBlob = fakeBlobStore(); setBlobClient(() => sharedBlob.client) }
  return sharedBlob
}

// Provisions TENANT with one location, one review, a stored Google
// credential, and (by default) an ACTIVE commercial state -- callers then
// flip commercialStatus with seedCommercial() to exercise each status.
async function provisionTenant() {
  const blob = currentBlob()
  blob.writeJson(generationPrivateDataBlobKey(TENANT, TEST_GENERATION, 'meta.json'), {
    locations: [{ locationId: LOCATION_A, name: 'Test Location', city: '', brand: 'Test Group', slug: 'test-location', maps_url: '', hasContact: false }],
    brands: [], totalReviews: 1, generatedAt: new Date().toISOString(), initialSyncCompleted: true,
  })
  blob.writeJson(generationPrivateDataBlobKey(TENANT, TEST_GENERATION, 'reviews/by-location/test-location.json'), [
    { review_id: 'review-1', review_url: 'https://g.co/review-1', location_name: 'Test Location', star_rating: 5, review_date: '2026-01-01', owner_response: '' },
  ])
  blob.writeJson(generationPrivateDataBlobKey(TENANT, TEST_GENERATION, 'action-items.json'), { unanswered: [] })
  blob.writeJson(generationPrivateDataBlobKey(TENANT, TEST_GENERATION, '_internal/review-location-index.json'), {
    'review-1': LOCATION_A,
    'accounts/1/locations/1/reviews/review-1': LOCATION_A,
  })

  await upsertTenantConfig(TENANT, { commercial: newShapeCommercial() }, { allowCreate: true, creationSource: 'migration' })
  const config = await recordLocationApproval(TENANT, [{ googleLocationId: 'accounts/1/locations/1', title: 'Test Location', address: '' }])
  await markTenantProvisioned(TENANT, {
    reviewDbBlobKey: reviewDbBlobKey(TENANT),
    privateDataPrefix: `tenant-data/${TENANT}/private-data/`,
    artifactGeneration: TEST_GENERATION,
    provisionedLocationIds: config.approvedLocations.map(l => l.locationId),
  })
  await upsertTenantConfig(TENANT, { status: 'active' })

  await setStoredCredential(TENANT, { refreshToken: 'fake-refresh-token', connectedAccountName: 'Test Group LLC' })

  const owner = { userId: 'usr_owner', email: 'owner@example.com', passwordHash: await passwordHash(), role: 'owner', locationIds: '*', tenantId: TENANT, sessionVersion: 1, disabled: false, displayName: 'Owner' }
  await upsertUser(TENANT, owner, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: owner })
  return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: TENANT, sessionVersion: 1 })
}

// Overwrites just the commercial sub-object of an already-provisioned
// tenant, via a normal CAS write (never bypassing the store).
async function setCommercialStatus(commercialStatus, overrides = {}) {
  const existing = await getTenantConfig(TENANT)
  await upsertTenantConfig(TENANT, { commercial: newShapeCommercial({ commercialStatus, ...overrides }) }, { expectedVersion: existing.configVersion })
}

async function invokeGoogle(action, { method = 'GET', body = {}, token } = {}) {
  const req = { method, query: { action }, body, headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await googleHandler(req, res)
  return res
}
async function invokeSettings(action, { method = 'GET', body = {}, token } = {}) {
  const req = { method, query: { action }, body, headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await settingsHandler(req, res)
  return res
}
async function invokeSession(action, { method = 'GET', body = {}, token } = {}) {
  const req = { method, query: { action }, body, headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await sessionHandler(req, res)
  return res
}
async function invokeTasks(action, { method = 'GET', body = {}, token } = {}) {
  const req = { method, query: { action }, body, headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await tasksHandler(req, res)
  return res
}
async function invokeContent(action, { method = 'GET', body = {}, token } = {}) {
  const req = { method, query: { action }, body, headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await contentHandler(req, res)
  return res
}

function setupFixtures() {
  installFakeConfigRedis(); installFakeUserRedis(); wireCredentialAndConnectionRedis()
  // A single shared client instance, never a factory that mints a fresh
  // (empty) store on every internal access -- otherwise a write from one
  // caller (e.g. invite-user's createInviteToken()) and a read from
  // another (accept-invite's consumeInviteToken()) would silently talk to
  // two different in-memory stores.
  const tokenClient = fakeTokenRedis()
  setTokenRedis(() => tokenClient)
  installFakeSeatLock()
  installFakeTaskRedis(); installFakeCampaignRedis(); installFakeContentAssetRedis()
  setAuditRedis(() => null) // audit log unconfigured is fine (best-effort, logged not thrown) for these tests
  noopRateLimit()
}
// Unkeyed (single flat store), unlike fakeKeyedHashRedis() -- these tests
// only ever seed ONE tenant's content assets at a time, and this shape
// additionally supports the plain set/del/eval calls
// acquireContentUploadLock()/releaseContentUploadLock() need (a lock is a
// plain string key, not a hash field) -- mirrors test_storage_commercial_quota.js's
// own fakeRedis().
function fakeContentAssetRedis() {
  const store = {}
  const strings = {}
  return {
    hgetall: async () => ({ ...store }),
    hget: async (_key, field) => store[field] ?? null,
    hset: async (_key, fields) => { Object.assign(store, fields) },
    hdel: async (_key, field) => { const had = field in store; delete store[field]; return had ? 1 : 0 },
    set: async (key, value, opts) => {
      if (opts?.nx && key in strings) return null
      strings[key] = value
      return 'OK'
    },
    del: async (key) => { const had = key in strings; delete strings[key]; return had ? 1 : 0 },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [token] = args
      if (strings[key] !== token) return 0
      if (args.length === 1) delete strings[key] // RELEASE_SCRIPT
      return 1 // RENEW_SCRIPT
    },
  }
}
function installFakeContentAssetRedis() { const c = fakeContentAssetRedis(); setContentAssetRedis(() => c); return c }

// ===========================================================================
// Part 2: Google publish() -- suspended/canceled deny with ZERO Google
// network traffic; past_due/active/trial allow.
// ===========================================================================

async function testPublishDeniedForSuspendedWithZeroGoogleRequests() {
  setupFixtures()
  const token = await provisionTenant()
  await setCommercialStatus('suspended')
  // Any fetch call at all (OAuth token refresh, accounts.list, the PUT
  // itself) is a hard test failure -- proves the commercial check runs
  // strictly before any Google-bound network I/O.
  globalThis.fetch = async (url) => { throw new Error(`unexpected Google network call during a denied suspended publish: ${url}`) }
  const res = await invokeGoogle('publish', { method: 'POST', token, body: { reviewName: 'accounts/1/locations/1/reviews/review-1', replyText: 'Thanks!' } })
  assert(res.statusCode === 403 && res.body.error === 'commercial_access_restricted' && res.body.commercialStatus === 'suspended',
    `a suspended tenant's publish must be denied via commercial_access_restricted, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testPublishDeniedForCanceled() {
  setupFixtures()
  const token = await provisionTenant()
  await setCommercialStatus('canceled')
  globalThis.fetch = async (url) => { throw new Error(`unexpected Google network call during a denied canceled publish: ${url}`) }
  const res = await invokeGoogle('publish', { method: 'POST', token, body: { reviewName: 'accounts/1/locations/1/reviews/review-1', replyText: 'Thanks!' } })
  assert(res.statusCode === 403 && res.body.commercialStatus === 'canceled', `a canceled tenant's publish must be denied, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testPublishAllowedForPastDueReachesGoogle() {
  setupFixtures()
  const token = await provisionTenant()
  await setCommercialStatus('past_due')
  let fetchCalled = false
  globalThis.fetch = async (url) => {
    fetchCalled = true
    if (String(url).includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) }
    return { ok: true, status: 200, json: async () => ({ name: 'accounts/1/locations/1/reviews/review-1', reviewReply: { comment: 'Thanks!' } }) }
  }
  const res = await invokeGoogle('publish', { method: 'POST', token, body: { reviewName: 'accounts/1/locations/1/reviews/review-1', replyText: 'Thanks!' } })
  assert(fetchCalled, 'past_due must be allowed through to the actual Google call (billing grace continues normal operations)')
  assert(res.statusCode !== 403, `past_due must not be commercially denied, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testPublishResolverFailureIs503NeverAnUpgradePrompt() {
  setupFixtures()
  const token = await provisionTenant()
  await setCommercialStatus('not-a-real-status') // resolves to commercialStatus: 'unconfigured'
  globalThis.fetch = async (url) => { throw new Error(`unexpected Google network call during a resolver-failure-denied publish: ${url}`) }
  const res = await invokeGoogle('publish', { method: 'POST', token, body: { reviewName: 'accounts/1/locations/1/reviews/review-1', replyText: 'Thanks!' } })
  assert(res.statusCode === 503 && res.body.error === 'service_unavailable', `a resolver failure must be 503 service_unavailable, never a commercial_access_restricted upgrade prompt, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// ===========================================================================
// Part 3: discover-locations and connect/reconnect -- INTEGRATION_EXPANSION
// denies past_due too (Phase B.7 pre-commit correction #1: split from the
// single, too-coarse INTEGRATION_OPERATION class).
// ===========================================================================

async function testDiscoverLocationsDeniedForPastDue() {
  setupFixtures()
  const token = await provisionTenant()
  await setCommercialStatus('past_due')
  globalThis.fetch = async (url) => { throw new Error(`unexpected Google network call during a denied discover-locations: ${url}`) }
  const res = await invokeGoogle('discover-locations', { method: 'POST', token })
  assert(res.statusCode === 403 && res.body.commercialStatus === 'past_due',
    `discover-locations must deny past_due (INTEGRATION_EXPANSION, stricter than INTEGRATION_OPERATION) -- no reason to browse for more capacity while expansion is frozen, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testGoogleConnectDeniedForPastDue() {
  setupFixtures()
  const token = await provisionTenant()
  await setCommercialStatus('past_due')
  const req = { method: 'GET', query: { action: 'auth' }, body: {}, headers: { cookie: `${SESSION_COOKIE}=${token}`, host: 'app.example.com' }, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await googleHandler(req, res)
  assert(res.statusCode === 403, `connect/reconnect (auth()) must deny past_due (INTEGRATION_EXPANSION: establishing a new/replacement integration is not part of "existing operations continue") -- got ${res.statusCode}: ${res.body}`)
}

async function testGoogleConnectDeniedForSuspended() {
  setupFixtures()
  const token = await provisionTenant()
  await setCommercialStatus('suspended')
  const req = { method: 'GET', query: { action: 'auth' }, body: {}, headers: { cookie: `${SESSION_COOKIE}=${token}`, host: 'app.example.com' }, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await googleHandler(req, res)
  assert(res.statusCode === 403, `connect/reconnect (auth()) must deny suspended, got ${res.statusCode}: ${res.body}`)
}

// Structural guard (Part Q) -- prevents future code drift back to using ONE
// class for both "establish/replace integration" and "use an existing
// integration," which is exactly the bug this correction fixes: reading the
// literal source confirms auth()/discover-locations use the EXPANSION
// class and trigger-sync/trigger-import use the (narrower, past_due-
// allowed) OPERATION class, never the other way around or merged into one.
function testConnectAndSyncAreStructurallyClassifiedDifferently() {
  const src = readFileSync(new URL('../dashboard/api/google/[action].js', import.meta.url), 'utf8')
  const authFn = /async function auth\(req, res\)[\s\S]*?\n}\n/.exec(src)
  const discoverFn = /async function discoverLocations[\s\S]*?\n}\n/.exec(src)
  const syncFn = /async function triggerSync[\s\S]*?\n}\n/.exec(src)
  const importFn = /async function triggerImport[\s\S]*?\n}\n/.exec(src)
  assert(authFn && discoverFn && syncFn && importFn, 'sanity: could not locate all four functions -- update this scan if any was renamed')
  assert(authFn[0].includes('CommercialOperationClass.INTEGRATION_EXPANSION'), 'auth() (connect/reconnect) must use INTEGRATION_EXPANSION')
  assert(discoverFn[0].includes('CommercialOperationClass.INTEGRATION_EXPANSION'), 'discoverLocations() must use INTEGRATION_EXPANSION')
  assert(syncFn[0].includes('CommercialOperationClass.INTEGRATION_OPERATION'), 'triggerSync() must use the narrower INTEGRATION_OPERATION (allowed past_due)')
  assert(importFn[0].includes('CommercialOperationClass.INTEGRATION_OPERATION'), 'triggerImport() must use the narrower INTEGRATION_OPERATION (allowed past_due)')
  assert(!authFn[0].includes('CommercialOperationClass.INTEGRATION_OPERATION,') && !authFn[0].includes('CommercialOperationClass.INTEGRATION_OPERATION)'),
    'auth() must never ALSO be classified INTEGRATION_OPERATION')
  assert(!syncFn[0].includes('CommercialOperationClass.INTEGRATION_EXPANSION'), 'triggerSync() must never be classified INTEGRATION_EXPANSION (would wrongly deny past_due)')
  assert(!importFn[0].includes('CommercialOperationClass.INTEGRATION_EXPANSION'), 'triggerImport() must never be classified INTEGRATION_EXPANSION (would wrongly deny past_due)')
}

// ===========================================================================
// Phase B.8 final pre-commit correction -- 'trial_pending_activation'
// (an access-code trial grant awaiting its first successful initial sync)
// must ALLOW exactly the onboarding actions it needs (Google connect,
// discover-locations) and DENY everything else product-related (publish,
// content creation), reusing this file's existing fully-provisioned
// tenant fixture (credential + location catalog already set up by
// provisionTenant()) -- only the commercial status changes.
// ===========================================================================

async function testGooglePublishDeniedDuringPendingActivation() {
  setupFixtures()
  const token = await provisionTenant()
  await setCommercialStatus('trial_pending_activation', { planSource: 'access_code_trial', accessCodeHash: 'h', paymentRequired: false })
  globalThis.fetch = async (url) => { throw new Error(`unexpected Google network call during a pending-activation-denied publish: ${url}`) }
  const res = await invokeGoogle('publish', { method: 'POST', token, body: { reviewName: 'accounts/1/locations/1/reviews/review-1', replyText: 'Thanks!' } })
  assert(res.statusCode === 403 && res.body.commercialStatus === 'trial_pending_activation',
    `Google publish must be denied (zero Google traffic) during pending-trial activation, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testDiscoverLocationsAllowedDuringPendingActivation() {
  setupFixtures()
  const token = await provisionTenant()
  await setCommercialStatus('trial_pending_activation', { planSource: 'access_code_trial', accessCodeHash: 'h', paymentRequired: false })
  globalThis.fetch = async (url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) }
    return { ok: true, status: 200, json: async () => ({ accounts: [] }) }
  }
  const res = await invokeGoogle('discover-locations', { method: 'POST', token })
  assert(res.statusCode !== 403, `discover-locations (required GBP onboarding) must remain allowed during pending-trial activation, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testGoogleConnectAllowedDuringPendingActivation() {
  setupFixtures()
  const token = await provisionTenant()
  await setCommercialStatus('trial_pending_activation', { planSource: 'access_code_trial', accessCodeHash: 'h', paymentRequired: false })
  const req = { method: 'GET', query: { action: 'auth' }, body: {}, headers: { cookie: `${SESSION_COOKIE}=${token}`, host: 'app.example.com' }, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await googleHandler(req, res)
  assert(res.statusCode !== 403, `Google connect/reconnect (required onboarding) must remain allowed during pending-trial activation, got ${res.statusCode}: ${res.body}`)
}

async function testDiscoverLocationsAllowedForActive() {
  setupFixtures()
  const token = await provisionTenant()
  globalThis.fetch = async (url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) }
    return { ok: true, status: 200, json: async () => ({ accounts: [] }) }
  }
  const res = await invokeGoogle('discover-locations', { method: 'POST', token })
  assert(res.statusCode !== 403, `an active tenant must not be commercially denied for discover-locations, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// ===========================================================================
// Part 4: location capacity expansion (recordLocationApproval) -- denies
// past_due/suspended/canceled additions, never blocks a pure reduction.
// ===========================================================================

async function testRecordLocationApprovalDeniesAdditionWhilePastDue() {
  installFakeConfigRedis()
  await upsertTenantConfig(TENANT, { commercial: newShapeCommercial({ commercialStatus: 'past_due' }) }, { allowCreate: true, creationSource: 'migration' })
  let threw = null
  try {
    await recordLocationApproval(TENANT, [{ googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' }])
  } catch (err) { threw = err }
  assert(threw instanceof CommercialCapacityRestrictedError, `adding a location while past_due must be denied via CommercialCapacityRestrictedError, got ${threw?.constructor?.name}: ${threw?.message}`)
  assert(threw.commercialStatus === 'past_due', `denial must report the real status, got ${threw.commercialStatus}`)
}

async function testRecordLocationApprovalStillAllowsPureReductionWhilePastDue() {
  // Deliberately past_due, not suspended/canceled: suspended/canceled
  // resolve to zeroLimits() (maxLocations: 0) via the PRE-EXISTING B.2/B.3
  // resolver behavior (unrelated to this phase's new gate) -- ANY non-empty
  // selection, including a pure reduction, would fail recordLocationApproval()'s
  // own long-standing "does the final selection fit" numeric check while
  // suspended/canceled, regardless of B.7. past_due is the status this
  // phase's own correction (entitlementResolution.js) made retain REAL
  // plan limits, so it is the status that actually exercises "financially
  // restricted but still allowed to reduce itself" cleanly: the numeric
  // check passes on its own merits, and this test isolates proof that the
  // NEW CommercialCapacityRestrictedError gate specifically does not
  // additionally block a net decrease.
  installFakeConfigRedis()
  await upsertTenantConfig(TENANT, { commercial: newShapeCommercial({ commercialStatus: 'active' }) }, { allowCreate: true, creationSource: 'migration' })
  await recordLocationApproval(TENANT, [
    { googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' },
    { googleLocationId: 'accounts/1/locations/2', title: 'B', address: '' },
  ])
  const existing = await getTenantConfig(TENANT)
  await upsertTenantConfig(TENANT, { commercial: newShapeCommercial({ commercialStatus: 'past_due' }) }, { expectedVersion: existing.configVersion })
  // A smaller re-selection (removal only, no net increase) must succeed
  // even though the tenant is now past_due -- Part E's explicit requirement.
  const result = await recordLocationApproval(TENANT, [{ googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' }])
  assert(result.approvedLocations.length === 1, `a pure reduction must remain possible while past_due, got ${JSON.stringify(result.approvedLocations)}`)
}

// ===========================================================================
// Part 5: seat/invite capacity -- invite-user/enable-user denied while
// suspended; disable-user always allowed (security/reduction).
// ===========================================================================

async function seedSettingsTenant(commercial) {
  const owner = { userId: 'usr_owner', email: 'owner@example.com', passwordHash: await passwordHash(), role: 'owner', locationIds: '*', tenantId: TENANT, sessionVersion: 1, disabled: false, displayName: 'Owner' }
  await upsertTenantConfig(TENANT, { status: 'active', locationCatalogEnabled: true, commercial }, { allowCreate: true, creationSource: 'migration' })
  await upsertUser(TENANT, owner, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: owner })
  return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: TENANT, sessionVersion: 1 })
}

async function testInviteUserDeniedWhileSuspended() {
  setupFixtures()
  const token = await seedSettingsTenant(newShapeCommercial({ commercialStatus: 'suspended' }))
  const res = await invokeSettings('invite-user', { method: 'POST', token, body: { name: 'New', email: 'new@example.com', role: 'read_only', locationIds: '*' } })
  assert(res.statusCode === 403 && res.body.error === 'commercial_access_restricted', `invite-user must be denied while suspended, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testInviteUserDeniedWhilePastDue() {
  setupFixtures()
  const token = await seedSettingsTenant(newShapeCommercial({ commercialStatus: 'past_due' }))
  const res = await invokeSettings('invite-user', { method: 'POST', token, body: { name: 'New', email: 'new@example.com', role: 'read_only', locationIds: '*' } })
  assert(res.statusCode === 403 && res.body.error === 'commercial_access_restricted', `invite-user (CAPACITY_EXPANSION) must be denied while past_due, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testDisableUserAlwaysAllowedWhileSuspended() {
  setupFixtures()
  const token = await seedSettingsTenant(newShapeCommercial({ commercialStatus: 'suspended' }))
  const target = { userId: 'usr_target', email: 'target@example.com', passwordHash: await passwordHash(), role: 'location_manager', locationIds: [LOCATION_A], tenantId: TENANT, sessionVersion: 1, disabled: false, displayName: 'Target' }
  await upsertUser(TENANT, target, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: target })
  const res = await invokeSettings('disable-user', { method: 'POST', token, body: { userId: 'usr_target' } })
  assert(res.statusCode === 200, `disable-user (RESOURCE_REDUCTION) must remain allowed while suspended -- an over-restricted tenant must still be able to reduce its own footprint, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testDisableUserAllowedEvenOnResolverFailure() {
  setupFixtures()
  const token = await seedSettingsTenant(newShapeCommercial({ commercialStatus: 'not-a-real-status' }))
  const target = { userId: 'usr_target', email: 'target@example.com', passwordHash: await passwordHash(), role: 'location_manager', locationIds: [LOCATION_A], tenantId: TENANT, sessionVersion: 1, disabled: false, displayName: 'Target' }
  await upsertUser(TENANT, target, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: target })
  const res = await invokeSettings('disable-user', { method: 'POST', token, body: { userId: 'usr_target' } })
  assert(res.statusCode === 200, `disable-user must remain usable even during a resolver outage -- blocking it would trap the Owner with no way to reduce risk, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// ===========================================================================
// Part 6: accept-invite -- OPERATIONAL_WRITE (allowed past_due, denied
// suspended/canceled), even though no NEW seat is consumed by acceptance.
// ===========================================================================

// Issues a real invite while active, returns the raw token -- shared setup
// for every test below that then flips commercial status AFTER issuance.
async function issueInviteAndGetRawToken(email = 'invited@example.com') {
  const token = await seedSettingsTenant(newShapeCommercial({ commercialStatus: 'active' }))
  const inviteRes = await invokeSettings('invite-user', { method: 'POST', token, body: { name: 'Invited', email, role: 'read_only', locationIds: '*' } })
  assert(inviteRes.statusCode === 200, `sanity: invite-user must succeed while active, got ${inviteRes.statusCode}: ${JSON.stringify(inviteRes.body)}`)
  return inviteRes.body.inviteUrl.split('token=')[1]
}

async function flipCommercialStatus(commercialStatus) {
  const existing = await getTenantConfig(TENANT)
  await upsertTenantConfig(TENANT, { commercial: newShapeCommercial({ commercialStatus }) }, { expectedVersion: existing.configVersion })
}

async function testAcceptInviteDeniedWhileSuspendedTokenSurvives() {
  setupFixtures()
  const rawToken = await issueInviteAndGetRawToken()
  await flipCommercialStatus('suspended')

  const res = await invokeSession('accept-invite', { method: 'POST', body: { token: rawToken, name: 'Invited Person', password: 'a-strong-enough-password-123' } })
  assert(res.statusCode === 403 && res.body.error === 'commercial_access_restricted', `accepting an invite must be denied while the tenant is suspended, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(!res.headers[SESSION_COOKIE] && !String(res.headers['Set-Cookie'] ?? '').includes(SESSION_COOKIE), 'a denied acceptance must never issue a real session cookie')

  // The token must NOT have been burned -- a non-destructive peek must
  // still find it.
  const stillThere = await peekInviteToken(rawToken)
  assert(stillThere !== null, 'a suspended denial must leave the invitation token usable for a future legitimate reactivation')
}

async function testAcceptInviteDeniedWhileCanceledTokenSurvives() {
  setupFixtures()
  const rawToken = await issueInviteAndGetRawToken()
  await flipCommercialStatus('canceled')

  const res = await invokeSession('accept-invite', { method: 'POST', body: { token: rawToken, name: 'Invited Person', password: 'a-strong-enough-password-123' } })
  assert(res.statusCode === 403 && res.body.error === 'commercial_access_restricted', `accepting an invite must be denied while the tenant is canceled, got ${res.statusCode}: ${JSON.stringify(res.body)}`)

  const stillThere = await peekInviteToken(rawToken)
  assert(stillThere !== null, 'a canceled denial must leave the invitation token usable for a future legitimate reactivation')
}

async function testAcceptInviteResolverFailureTokenSurvives() {
  setupFixtures()
  const rawToken = await issueInviteAndGetRawToken()
  await flipCommercialStatus('not-a-real-status') // resolves to commercialStatus: 'unconfigured'

  const res = await invokeSession('accept-invite', { method: 'POST', body: { token: rawToken, name: 'Invited Person', password: 'a-strong-enough-password-123' } })
  assert(res.statusCode === 503 && res.body.error === 'service_unavailable', `a resolver failure must deny activation via service_unavailable, never burning the token, got ${res.statusCode}: ${JSON.stringify(res.body)}`)

  const stillThere = await peekInviteToken(rawToken)
  assert(stillThere !== null, 'a resolver-failure denial must never burn the invitation token merely because the commercial resolver was briefly unavailable')
}

async function testAcceptInviteLaterActiveRetrySucceeds() {
  setupFixtures()
  const rawToken = await issueInviteAndGetRawToken()
  await flipCommercialStatus('suspended')
  const denied = await invokeSession('accept-invite', { method: 'POST', body: { token: rawToken, name: 'Invited Person', password: 'a-strong-enough-password-123' } })
  assert(denied.statusCode === 403, `sanity: must be denied while suspended, got ${denied.statusCode}`)

  // Tenant is reactivated (e.g. the customer resolves billing) -- the SAME
  // link, never reissued, must now work.
  await flipCommercialStatus('active')
  const res = await invokeSession('accept-invite', { method: 'POST', body: { token: rawToken, name: 'Invited Person', password: 'a-strong-enough-password-123' } })
  assert(res.statusCode === 200, `the same invitation link must succeed once the tenant is reactivated, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.account?.email === 'invited@example.com', 'the activated account must be the originally-invited identity')
}

async function testAcceptInvitePastDueSucceeds() {
  setupFixtures()
  const rawToken = await issueInviteAndGetRawToken()
  await flipCommercialStatus('past_due')
  const res = await invokeSession('accept-invite', { method: 'POST', body: { token: rawToken, name: 'Invited Person', password: 'a-strong-enough-password-123' } })
  assert(res.statusCode === 200, `accepting an invite must succeed while past_due -- the invitation already consumed its seat at issue time, so activation is not new capacity, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testSuccessfulAcceptInviteConsumesTokenExactlyOnceAndReplayFails() {
  setupFixtures()
  const rawToken = await issueInviteAndGetRawToken()
  const res = await invokeSession('accept-invite', { method: 'POST', body: { token: rawToken, name: 'Invited Person', password: 'a-strong-enough-password-123' } })
  assert(res.statusCode === 200, `sanity: a normal (active) acceptance must succeed, got ${res.statusCode}: ${JSON.stringify(res.body)}`)

  const afterSuccess = await peekInviteToken(rawToken)
  assert(afterSuccess === null, 'a successful acceptance must consume the token -- it must no longer be peekable')

  // Replay: the exact same request again, with the token now fully spent.
  const replay = await invokeSession('accept-invite', { method: 'POST', body: { token: rawToken, name: 'Replay Attempt', password: 'a-strong-enough-password-123' } })
  assert(replay.statusCode === 400 && replay.body.error === 'invalid_or_expired_token', `a replay of an already-consumed invite must still fail, got ${replay.statusCode}: ${JSON.stringify(replay.body)}`)
}

// ===========================================================================
// Part 7: tasks -- create/update OPERATIONAL_WRITE, denied suspended/
// canceled, allowed past_due; delete (reduction) untouched.
// ===========================================================================

async function testTaskCreateDeniedWhileCanceled() {
  setupFixtures()
  const token = await seedSettingsTenant(newShapeCommercial({ commercialStatus: 'canceled' }))
  const res = await invokeTasks('create', { method: 'POST', token, body: { title: 'Fix sign', type: 'general', locationIds: [LOCATION_A], priority: 'medium' } })
  assert(res.statusCode === 403 && res.body.error === 'commercial_access_restricted', `task create must be denied while canceled, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testTaskCreateAllowedWhilePastDue() {
  setupFixtures()
  const token = await seedSettingsTenant(newShapeCommercial({ commercialStatus: 'past_due' }))
  const res = await invokeTasks('create', { method: 'POST', token, body: { title: 'Fix sign', type: 'general', locationIds: [LOCATION_A], priority: 'medium' } })
  assert(res.statusCode !== 403, `task create/operational work must continue during past_due billing grace, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// ===========================================================================
// Part 8: content -- upsert-campaign/create-text-asset OPERATIONAL_WRITE.
// ===========================================================================

async function testUpsertCampaignDeniedWhileSuspended() {
  setupFixtures()
  const token = await seedSettingsTenant(newShapeCommercial({ commercialStatus: 'suspended' }))
  const res = await invokeContent('upsert-campaign', { method: 'POST', token, body: { name: 'Fall Promo', locationIds: '*' } })
  assert(res.statusCode === 403 && res.body.error === 'commercial_access_restricted', `campaign creation must be denied while suspended, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testUpsertCampaignAllowedWhileActive() {
  setupFixtures()
  const token = await seedSettingsTenant(newShapeCommercial({ commercialStatus: 'active' }))
  const res = await invokeContent('upsert-campaign', { method: 'POST', token, body: { name: 'Fall Promo', locationIds: '*' } })
  assert(res.statusCode === 201, `campaign creation must succeed while active, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// ===========================================================================
// Part 8b: Phase B.7 pre-commit correction (Part 4) -- create-text-asset was
// bypassing the commercial storage/asset-count quota entirely (a caption IS
// a counted content_assets:v1 record, but nothing checked it against
// entitlements.limits.assetCount/storageBytes or Phase A's hard ceiling).
// Fixed by routing it through the exact same quota mechanism upload() uses.
// upsert-campaign is confirmed NOT part of asset/storage accounting at all
// (a structural fact, not a quota decision) and is tested separately below.
// ===========================================================================

async function seedContentQuotaTenant(commercial) {
  const owner = { userId: 'usr_owner', email: 'owner@example.com', passwordHash: await passwordHash(), role: 'owner', locationIds: '*', tenantId: TENANT, sessionVersion: 1, disabled: false, displayName: 'Owner' }
  await upsertTenantConfig(TENANT, { status: 'active', locationCatalogEnabled: true, commercial }, { allowCreate: true, creationSource: 'migration' })
  await upsertUser(TENANT, owner, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: owner })
  const token = await signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: TENANT, sessionVersion: 1 })
  const campaignRes = await invokeContent('upsert-campaign', { method: 'POST', token, body: { name: 'Quota Test Campaign', locationIds: '*' } })
  assert(campaignRes.statusCode === 201, `sanity: campaign setup must succeed, got ${campaignRes.statusCode}: ${JSON.stringify(campaignRes.body)}`)
  return { token, campaignId: campaignRes.body.campaign.id }
}

async function testCreateTextAssetDeniedDuringPendingActivation() {
  setupFixtures()
  // Set up the campaign while genuinely active (upsert-campaign is itself
  // OPERATIONAL_WRITE, denied during pending activation -- setup must
  // happen before flipping status, exactly like every other "corrupt
  // status after setup" test in this file).
  const { token, campaignId } = await seedContentQuotaTenant(newShapeCommercial({ plan: 'growth' }))
  const existing = await getTenantConfig(TENANT)
  await upsertTenantConfig(TENANT, { commercial: newShapeCommercial({ commercialStatus: 'trial_pending_activation', plan: 'growth', planSource: 'access_code_trial', accessCodeHash: 'h', paymentRequired: false }) }, { expectedVersion: existing.configVersion })
  const res = await invokeContent('create-text-asset', { method: 'POST', token, body: { campaignId, captionText: 'Should be denied before activation' } })
  assert(res.statusCode === 403, `create-text-asset must be denied during pending-trial activation (zero AI/storage/content consumption before activation), got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testCreateTextAssetDeniedAtCommercialAssetCountCeiling() {
  setupFixtures()
  // Core plan's real per-plan asset-count ceiling (matches
  // test_storage_commercial_quota.js's own Core fixture) -- seeded already
  // AT the ceiling so even one more caption (which never touches Blob) must
  // still be rejected by the SAME commercial quota check upload() uses.
  const { token, campaignId } = await seedContentQuotaTenant(newShapeCommercial({ plan: 'core' }))
  // Fill to Core's asset-count ceiling (500) via the real createAsset()
  // write path -- no Blob needed, contentAssetStore.js's getAllAssets()
  // only reads metadata.
  const fakeAccount = { userId: 'usr_owner' }
  for (let i = 0; i < 500; i++) {
    await createAsset(TENANT, { campaignId, type: 'other', filename: `x${i}.png`, mimeType: 'image/png', sizeBytes: 10, blobPathname: `content/${campaignId}/x${i}.png`, captionText: null }, fakeAccount)
  }
  const res = await invokeContent('create-text-asset', { method: 'POST', token, body: { campaignId, captionText: 'One more caption' } })
  assert(res.statusCode === 409 && res.body.error === 'storage_limit_reached',
    `create-text-asset must be denied by the SAME commercial asset-count ceiling upload() enforces -- a caption is a counted asset, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const afterCount = Object.keys(await getAllAssets(TENANT)).length
  assert(afterCount === 500, `a denied create-text-asset must not have written a new asset record, got ${afterCount}`)
}

async function testCreateTextAssetAllowedUnderCeiling() {
  setupFixtures()
  const { token, campaignId } = await seedContentQuotaTenant(newShapeCommercial({ plan: 'core' }))
  const res = await invokeContent('create-text-asset', { method: 'POST', token, body: { campaignId, captionText: 'A totally normal caption' } })
  assert(res.statusCode === 201, `a caption well under the ceiling must still succeed, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testCreateTextAssetResolverFailureFailsClosed() {
  setupFixtures()
  // Seed with a VALID plan first (campaign creation is itself gated
  // OPERATIONAL_WRITE, which fails closed on a resolver failure -- see
  // test_storage_commercial_quota.js's identical correction for upload()'s
  // equivalent test), then corrupt the commercial config to a resolver
  // failure AFTER the campaign already exists.
  //
  // Unlike upload() (which has NO explicit commercial-status gate of its
  // own -- it relies solely on B.4's quota mechanism, so its equivalent
  // resolver-failure test observes the quota check's own 409/0-0 shape),
  // create-text-asset ALSO has an explicit OPERATIONAL_WRITE gate ahead of
  // the quota check (added earlier in this phase). That gate denies a
  // resolver failure FIRST, via 503 service_unavailable -- never reaching
  // the quota check at all. Both outcomes are "fail closed"; 503 here is
  // in fact the more correct shape per Part A's error-semantics rule
  // (never conflate an infrastructure failure with a business limit).
  const { token, campaignId } = await seedContentQuotaTenant(newShapeCommercial({ plan: 'core' }))
  const existing = await getTenantConfig(TENANT)
  await upsertTenantConfig(TENANT, { commercial: newShapeCommercial({ plan: 'not_a_real_plan' }) }, { expectedVersion: existing.configVersion })
  const res = await invokeContent('create-text-asset', { method: 'POST', token, body: { campaignId, captionText: 'First caption ever' } })
  assert(res.statusCode === 503 && res.body.error === 'service_unavailable',
    `a resolver failure must fail closed and deny even the very first caption, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// ===========================================================================
// Part 8c: Phase B.7 final storage-integrity assertion -- create-text-asset's
// BYTE accounting (not just asset-count). captionText is small (server-
// enforced <=5000 UTF-16 code units, so <=~20KB worst case for 4-byte UTF-8
// characters) but must still be genuinely server-computed, persisted, and
// folded into existingBytes -- never trusting client-supplied size fields,
// and never a second, independently-drifting counter.
// ===========================================================================

const MB = 1024 * 1024
const GB = 1024 * MB

async function seedFakeAsset(campaignId, sizeBytes, idSuffix = '') {
  await createAsset(TENANT, { campaignId, type: 'other', filename: `filler${idSuffix}.png`, mimeType: 'image/png', sizeBytes, blobPathname: `content/${campaignId}/filler${idSuffix}.png`, captionText: null }, { userId: 'usr_owner' })
}

async function testCreateTextAssetByteSizeIsServerComputedNeverTrustedFromClient() {
  setupFixtures()
  const { token, campaignId } = await seedContentQuotaTenant(newShapeCommercial({ plan: 'core' }))
  const captionText = 'A real caption with a known byte length'
  const realBytes = Buffer.byteLength(captionText, 'utf8')
  // Spoofed fields that look like size overrides -- create-text-asset never
  // reads any of these from the request body.
  const res = await invokeContent('create-text-asset', {
    method: 'POST', token,
    body: { campaignId, captionText, sizeBytes: 999999999, size: 1, byteLength: 0 },
  })
  assert(res.statusCode === 201, `sanity: creation must succeed, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.asset.sizeBytes === realBytes, `the persisted sizeBytes must be the server-computed UTF-8 byte length (${realBytes}), never a client-supplied field, got ${res.body.asset.sizeBytes}`)

  const stored = Object.values(await getAllAssets(TENANT))[0]
  assert(stored.sizeBytes === realBytes, `the record actually persisted in content_assets:v1 must carry the server-computed byte size, got ${stored.sizeBytes}`)
}

async function testCreateTextAssetDeniedAtCommercialByteCeiling() {
  setupFixtures()
  const { token, campaignId } = await seedContentQuotaTenant(newShapeCommercial({ plan: 'core' })) // 500MB commercial ceiling
  // Leave only a few hundred bytes of headroom under Core's 500MB byte
  // ceiling using a plain (non-text) filler asset -- existingBytes sums
  // every asset's sizeBytes regardless of type, so this proves the SAME
  // byte accounting upload() uses also governs create-text-asset.
  await seedFakeAsset(campaignId, 500 * MB - 200)
  const captionText = 'x'.repeat(1000) // 1000 real UTF-8 bytes, well over the 200-byte headroom
  const res = await invokeContent('create-text-asset', { method: 'POST', token, body: { campaignId, captionText } })
  assert(res.statusCode === 409 && res.body.error === 'storage_limit_reached',
    `a caption that would cross the commercial BYTE ceiling must be denied, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const count = Object.keys(await getAllAssets(TENANT)).length
  assert(count === 1, `a denied caption must not have written a new asset record (only the filler should remain), got ${count}`)
}

async function testCreateTextAssetDeniedAtPhaseATwoGbCeiling() {
  setupFixtures()
  // Legacy/unmanaged tenant (commercial: null) -- the commercial byte
  // ceiling is unenforced (limits.storageBytes === null), so Phase A's
  // hard 2GB safety ceiling is the ONLY thing that can still deny this,
  // proving it applies underneath even a caption.
  const { token, campaignId } = await seedContentQuotaTenant(null)
  await seedFakeAsset(campaignId, 2 * GB - 200)
  const captionText = 'x'.repeat(1000)
  const res = await invokeContent('create-text-asset', { method: 'POST', token, body: { campaignId, captionText } })
  assert(res.statusCode === 413 && res.body.error === 'storage_limit_exceeded',
    `a caption that would cross Phase A's hard 2GB ceiling must be denied even for a legacy/unmanaged tenant, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testCreateTextAssetSuspendedWritesZeroPersistentRecord() {
  setupFixtures()
  const { token, campaignId } = await seedContentQuotaTenant(newShapeCommercial({ plan: 'core' }))
  const existing = await getTenantConfig(TENANT)
  await upsertTenantConfig(TENANT, { commercial: newShapeCommercial({ plan: 'core', commercialStatus: 'suspended' }) }, { expectedVersion: existing.configVersion })
  const res = await invokeContent('create-text-asset', { method: 'POST', token, body: { campaignId, captionText: 'Should never be written' } })
  assert(res.statusCode === 403, `suspended must deny create-text-asset, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const count = Object.keys(await getAllAssets(TENANT)).length
  assert(count === 0, `a suspended denial must result in ZERO persistent text writes, got ${count} asset record(s)`)
}

async function testCreateTextAssetResolverFailureWritesZeroPersistentRecord() {
  setupFixtures()
  const { token, campaignId } = await seedContentQuotaTenant(newShapeCommercial({ plan: 'core' }))
  const existing = await getTenantConfig(TENANT)
  await upsertTenantConfig(TENANT, { commercial: newShapeCommercial({ plan: 'not_a_real_plan' }) }, { expectedVersion: existing.configVersion })
  const res = await invokeContent('create-text-asset', { method: 'POST', token, body: { campaignId, captionText: 'Should never be written' } })
  assert(res.statusCode === 503, `a resolver failure must deny create-text-asset, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const count = Object.keys(await getAllAssets(TENANT)).length
  assert(count === 0, `a resolver-failure denial must result in ZERO persistent text writes, got ${count} asset record(s)`)
}

async function testCreateTextAssetPastDueSucceedsSubjectToNormalQuota() {
  setupFixtures()
  const { token, campaignId } = await seedContentQuotaTenant(newShapeCommercial({ plan: 'core' }))
  const existing = await getTenantConfig(TENANT)
  await upsertTenantConfig(TENANT, { commercial: newShapeCommercial({ plan: 'core', commercialStatus: 'past_due' }) }, { expectedVersion: existing.configVersion })

  // Under quota -- succeeds.
  const okRes = await invokeContent('create-text-asset', { method: 'POST', token, body: { campaignId, captionText: 'Fits fine' } })
  assert(okRes.statusCode === 201, `past_due must allow a caption under normal plan quota, got ${okRes.statusCode}: ${JSON.stringify(okRes.body)}`)

  // Now push right up against Core's byte ceiling and confirm past_due
  // still enforces it (billing grace is not unlimited storage).
  await seedFakeAsset(campaignId, 500 * MB - 200, '-2')
  const overRes = await invokeContent('create-text-asset', { method: 'POST', token, body: { campaignId, captionText: 'x'.repeat(1000) } })
  assert(overRes.statusCode === 409 && overRes.body.error === 'storage_limit_reached',
    `past_due must still enforce the normal commercial byte ceiling, got ${overRes.statusCode}: ${JSON.stringify(overRes.body)}`)
}

async function testDeletingTextAssetFreesAssetCountAndBytes() {
  setupFixtures()
  const { token, campaignId } = await seedContentQuotaTenant(newShapeCommercial({ plan: 'core' }))
  const createRes = await invokeContent('create-text-asset', { method: 'POST', token, body: { campaignId, captionText: 'Temporary caption' } })
  assert(createRes.statusCode === 201, `sanity: creation must succeed, got ${createRes.statusCode}`)
  const assetId = createRes.body.asset.id

  const beforeDelete = Object.values(await getAllAssets(TENANT))
  assert(beforeDelete.length === 1 && beforeDelete[0].sizeBytes > 0, 'sanity: the caption must be a real, counted, non-zero-byte record before deletion')

  const deleteRes = await invokeContent('delete-asset', { method: 'POST', token, body: { id: assetId } })
  assert(deleteRes.statusCode === 200, `sanity: delete must succeed, got ${deleteRes.statusCode}: ${JSON.stringify(deleteRes.body)}`)

  const afterDelete = Object.values(await getAllAssets(TENANT))
  assert(afterDelete.length === 0, `deleting the text asset must free its asset-count slot, got ${afterDelete.length} remaining`)
  const bytesAfter = afterDelete.reduce((sum, a) => sum + (a.sizeBytes ?? 0), 0)
  assert(bytesAfter === 0, `deleting the text asset must free its recorded bytes -- no drifting counter, got ${bytesAfter} bytes still counted`)
}

async function testConcurrentFinalCapacityTextCreationsExactlyOneSucceeds() {
  setupFixtures()
  const { token, campaignId } = await seedContentQuotaTenant(newShapeCommercial({ plan: 'core' }))
  // Exactly ONE more asset fits under Core's 500-asset ceiling.
  const fakeAccount = { userId: 'usr_owner' }
  for (let i = 0; i < 499; i++) {
    await createAsset(TENANT, { campaignId, type: 'other', filename: `x${i}.png`, mimeType: 'image/png', sizeBytes: 10, blobPathname: `content/${campaignId}/x${i}.png`, captionText: null }, fakeAccount)
  }
  const createOnce = () => invokeContent('create-text-asset', { method: 'POST', token, body: { campaignId, captionText: 'Racing for the last slot' } })
  const [resA, resB] = await Promise.all([createOnce(), createOnce()])
  const successes = [resA, resB].filter(r => r.statusCode === 201)
  const rejections = [resA, resB].filter(r => r.statusCode !== 201)
  assert(successes.length === 1, `exactly one of two concurrent final-capacity text creations must succeed, got ${successes.length} (statuses: ${resA.statusCode}, ${resB.statusCode})`)
  assert(rejections.length === 1 && [409].includes(rejections[0].statusCode), `the loser must be deterministically rejected (409 -- either the quota ceiling or lock contention), got ${rejections[0]?.statusCode}`)
  const finalCount = Object.keys(await getAllAssets(TENANT)).length
  assert(finalCount === 500, `the tenant must end at exactly its 500-asset ceiling, never over it, got ${finalCount}`)
}

async function testUpsertCampaignNeverCreatesAnAssetRecord() {
  setupFixtures()
  const { token } = await seedContentQuotaTenant(newShapeCommercial({ plan: 'core' }))
  // upsert-campaign was already called once by the seed helper above -- a
  // SECOND campaign, then confirm getAllAssets() (the exact set every
  // storage-quota check reads) is still completely empty, proving
  // campaigns are structurally outside asset/storage accounting, not
  // merely small by convention.
  const before = await getAllAssets(TENANT)
  const res = await invokeContent('upsert-campaign', { method: 'POST', token, body: { name: 'Second Campaign', locationIds: '*' } })
  assert(res.statusCode === 201, `sanity: second campaign creation must succeed, got ${res.statusCode}`)
  const after = await getAllAssets(TENANT)
  assert(Object.keys(before).length === 0 && Object.keys(after).length === 0,
    'upsert-campaign must never create a content_assets:v1 record -- campaigns are metadata-only and outside asset/storage accounting')
}

// Structural guard (Part Q) -- every customer-reachable asset-CREATING
// path in content/[action].js must either pass through the SAME
// getAllAssets()-based commercial/platform storage accounting (upload(),
// create-text-asset()) or be a confirmed non-asset-creating action
// (upsert-campaign, which writes to campaignStore.js, never
// contentAssetStore.js). Prevents a future new content-mutation action
// from silently reintroducing the bypass this correction just fixed.
function testEveryAssetCreatingPathIsQuotaChecked() {
  const src = readFileSync(new URL('../dashboard/api/content/[action].js', import.meta.url), 'utf8')
  const uploadFn = /async function upload\(req, res\)[\s\S]*?\n}\n/.exec(src)
  const createTextAssetFn = /async function createTextAsset[\s\S]*?\n}\n/.exec(src)
  assert(uploadFn && createTextAssetFn, 'sanity: could not locate upload()/createTextAsset() -- update this scan if renamed')
  for (const [name, fn] of [['upload', uploadFn], ['create-text-asset', createTextAssetFn]]) {
    assert(fn[0].includes('acquireContentUploadLock'), `${name} must acquire the same per-tenant upload lock used for quota serialization`)
    assert(fn[0].includes('getAllAssets'), `${name} must read the live, current asset list (never a separate drifting counter)`)
    assert(fn[0].includes('clampToSafetyCeiling'), `${name} must clamp commercial limits to Phase A's safety ceiling`)
    assert(fn[0].includes('MAX_TENANT_ASSET_COUNT') && fn[0].includes('MAX_TENANT_STORAGE_BYTES'), `${name} must still enforce the Phase A hard ceiling underneath the commercial quota`)
  }
}

// ===========================================================================
// Part 10: Phase B.7 pre-commit correction (Part 3) -- directional
// access-expansion/reduction. update-user-role-locations and
// update-user-can-create-tasks can each either EXPAND or REDUCE an
// existing user's authority; the decision must follow the actual
// before/after state, never the endpoint name.
// ===========================================================================

async function seedOwnerAndTarget(commercial, targetRole, targetLocationIds) {
  const token = await seedSettingsTenant(commercial)
  const target = { userId: 'usr_target', email: 'target@example.com', passwordHash: await passwordHash(), role: targetRole, locationIds: targetLocationIds, tenantId: TENANT, sessionVersion: 1, disabled: false, displayName: 'Target' }
  await upsertUser(TENANT, target, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: target })
  return token
}

async function testRoleDemotionAllowedWhileSuspended() {
  setupFixtures()
  // owner -> location_manager is a REDUCTION (rank 3 -> 2). seedOwnerAndTarget()
  // already seeds a SEPARATE acting Owner (usr_owner, via seedSettingsTenant())
  // distinct from the target being demoted, so last-owner protection is
  // never in play here.
  const token = await seedOwnerAndTarget(newShapeCommercial({ commercialStatus: 'active' }), 'owner', '*')
  const existing = await getTenantConfig(TENANT)
  await upsertTenantConfig(TENANT, { commercial: newShapeCommercial({ commercialStatus: 'suspended' }) }, { expectedVersion: existing.configVersion })
  const res = await invokeSettings('update-user-role-locations', { method: 'POST', token, body: { userId: 'usr_target', role: 'location_manager', locationIds: [LOCATION_A] } })
  assert(res.statusCode === 200, `a role DEMOTION (reduction) must remain allowed while suspended, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testRolePromotionDeniedWhileSuspended() {
  setupFixtures()
  // location_manager -> owner is an EXPANSION (rank 2 -> 3).
  const token = await seedOwnerAndTarget(newShapeCommercial({ commercialStatus: 'suspended' }), 'location_manager', [LOCATION_A])
  const res = await invokeSettings('update-user-role-locations', { method: 'POST', token, body: { userId: 'usr_target', role: 'owner', locationIds: '*' } })
  assert(res.statusCode === 403 && res.body.error === 'commercial_access_restricted', `a role PROMOTION (expansion) must be denied while suspended, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testRolePromotionDeniedWhilePastDue() {
  setupFixtures()
  const token = await seedOwnerAndTarget(newShapeCommercial({ commercialStatus: 'past_due' }), 'location_manager', [LOCATION_A])
  const res = await invokeSettings('update-user-role-locations', { method: 'POST', token, body: { userId: 'usr_target', role: 'admin', locationIds: '*' } })
  assert(res.statusCode === 403 && res.body.error === 'commercial_access_restricted', `an authority expansion must be denied while past_due -- billing grace is not a license to grow, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testLocationScopeAdditionDeniedWhileSuspended() {
  setupFixtures()
  const token = await seedOwnerAndTarget(newShapeCommercial({ commercialStatus: 'suspended' }), 'location_manager', [LOCATION_A])
  const res = await invokeSettings('update-user-role-locations', { method: 'POST', token, body: { userId: 'usr_target', role: 'location_manager', locationIds: [LOCATION_A, 2] } })
  assert(res.statusCode === 403 && res.body.error === 'commercial_access_restricted', `adding a new location to an existing user's scope is an expansion, must be denied while suspended, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testLocationScopeRemovalAllowedWhileSuspended() {
  setupFixtures()
  const token = await seedOwnerAndTarget(newShapeCommercial({ commercialStatus: 'suspended' }), 'location_manager', [LOCATION_A, 2])
  const res = await invokeSettings('update-user-role-locations', { method: 'POST', token, body: { userId: 'usr_target', role: 'location_manager', locationIds: [LOCATION_A] } })
  assert(res.statusCode === 200, `narrowing an existing user's location scope is a reduction, must remain allowed while suspended, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testGrantCanCreateTasksDeniedWhileSuspended() {
  setupFixtures()
  const token = await seedOwnerAndTarget(newShapeCommercial({ commercialStatus: 'suspended' }), 'location_manager', [LOCATION_A])
  const res = await invokeSettings('update-user-can-create-tasks', { method: 'POST', token, body: { userId: 'usr_target', canCreateTasks: true } })
  assert(res.statusCode === 403 && res.body.error === 'commercial_access_restricted', `granting a capability is an expansion, must be denied while suspended, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testRevokeCanCreateTasksAllowedWhileSuspended() {
  setupFixtures()
  const token = await seedSettingsTenant(newShapeCommercial({ commercialStatus: 'suspended' }))
  const target = { userId: 'usr_target', email: 'target@example.com', passwordHash: await passwordHash(), role: 'location_manager', locationIds: [LOCATION_A], tenantId: TENANT, sessionVersion: 1, disabled: false, displayName: 'Target', canCreateTasks: true }
  await upsertUser(TENANT, target, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: target })
  const res = await invokeSettings('update-user-can-create-tasks', { method: 'POST', token, body: { userId: 'usr_target', canCreateTasks: false } })
  assert(res.statusCode === 200, `revoking a capability is a reduction, must remain allowed while suspended, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testRolePromotionToOwnerStillRequiresOwnerActor() {
  // Do NOT allow a tenant Admin to exploit the new directional logic to
  // become Owner if canAssignRole()'s existing elevation-of-privilege rule
  // forbids it -- that authorization check is untouched and still runs
  // before the commercial directional check even executes.
  setupFixtures()
  const admin = { userId: 'usr_admin', email: 'admin@example.com', passwordHash: await passwordHash(), role: 'admin', locationIds: '*', tenantId: TENANT, sessionVersion: 1, disabled: false, displayName: 'Admin' }
  await upsertTenantConfig(TENANT, { status: 'active', locationCatalogEnabled: true, commercial: newShapeCommercial({ commercialStatus: 'active' }) }, { allowCreate: true, creationSource: 'migration' })
  await upsertUser(TENANT, admin, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: admin })
  const adminToken = await signSession({ userId: 'usr_admin', email: 'admin@example.com', role: 'admin', locationIds: '*', tenantId: TENANT, sessionVersion: 1 })
  const target = { userId: 'usr_target', email: 'target@example.com', passwordHash: await passwordHash(), role: 'location_manager', locationIds: [LOCATION_A], tenantId: TENANT, sessionVersion: 1, disabled: false, displayName: 'Target' }
  await upsertUser(TENANT, target, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: target })
  const res = await invokeSettings('update-user-role-locations', { method: 'POST', token: adminToken, body: { userId: 'usr_target', role: 'owner', locationIds: '*' } })
  assert(res.statusCode === 403 && res.body.error === 'forbidden', `an Admin must still be rejected by canAssignRole() before any commercial check runs, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// ===========================================================================
// Part 9: LTA/legacy is completely unaffected by every gate added this
// phase, for every operation class.
// ===========================================================================

async function testLtaBootstrapUnaffectedByEveryNewGate() {
  setupFixtures()
  const owner = { userId: 'usr_lta_owner', email: 'owner@lta.example.com', passwordHash: await passwordHash(), role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'LTA Owner' }
  await upsertUser(DEFAULT_TENANT_ID, owner, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: owner })
  const token = await signSession({ userId: 'usr_lta_owner', email: 'owner@lta.example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  // trigger-sync/trigger-import are hardcoded LTA-only and reach the real
  // GITHUB_SYNC_PAT check (which is unset in tests) -- 503 not_configured is
  // the expected non-commercial outcome, proving the new defensive gate
  // never fires for LTA.
  const res = await invokeGoogle('trigger-sync', { method: 'POST', token })
  assert(res.statusCode === 503 && res.body.error === 'not_configured',
    `LTA/BOOTSTRAP must reach the real GITHUB_SYNC_PAT check (503 not_configured in this test env), never be commercially denied by the new defensive trigger-sync gate, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// ===========================================================================

const tests = [
  // --- Part 1: pure policy module ---
  ['every class allows trial and active', testEveryClassAllowsTrialAndActive],
  ['suspended/canceled deny every risk class as commercial_status', testSuspendedAndCanceledDenyEveryRiskClass],
  ['safe classes (READ_BASIC/SECURITY_MAINTENANCE/RESOURCE_REDUCTION) always allowed', testSafeClassesAlwaysAllowedRegardlessOfStatus],
  ['past_due boundary: operational/cost allowed, expansion/integration denied', testPastDueBoundary],
  ['legacy/unmanaged always allowed for every class', testLegacyUnmanagedAlwaysAllowedForEveryClass],
  ['resolver failure fails closed for risk classes only', testResolverFailureFailsClosedForRiskClassesOnly],
  ['null/missing entitlements treated as resolver failure', testNullOrMissingEntitlementsTreatedAsResolverFailure],
  ['unrecognized commercialStatus treated as resolver failure', testUnrecognizedCommercialStatusTreatedAsResolverFailure],
  ['unknown operation class throws', testUnknownOperationClassThrows],
  ['commercialDenialResponse() shapes are safe and correct', testCommercialDenialResponseShapes],

  // --- Part 2: Google publish() ---
  ['publish denied for suspended with ZERO Google network requests', testPublishDeniedForSuspendedWithZeroGoogleRequests],
  ['publish denied for canceled', testPublishDeniedForCanceled],
  ['publish allowed for past_due, reaches Google', testPublishAllowedForPastDueReachesGoogle],
  ['publish resolver failure is 503, never an upgrade prompt', testPublishResolverFailureIs503NeverAnUpgradePrompt],

  // --- Part 3: discover-locations ---
  ['discover-locations denied for past_due (INTEGRATION_EXPANSION)', testDiscoverLocationsDeniedForPastDue],
  ['discover-locations allowed for active', testDiscoverLocationsAllowedForActive],
  ['google connect/reconnect denied for past_due (INTEGRATION_EXPANSION)', testGoogleConnectDeniedForPastDue],
  ['google connect/reconnect denied for suspended', testGoogleConnectDeniedForSuspended],
  ['connect/reconnect and sync/import are structurally classified differently', testConnectAndSyncAreStructurallyClassifiedDifferently],
  ['Google publish denied during pending-trial activation (zero Google traffic)', testGooglePublishDeniedDuringPendingActivation],
  ['discover-locations allowed during pending-trial activation (required onboarding)', testDiscoverLocationsAllowedDuringPendingActivation],
  ['Google connect/reconnect allowed during pending-trial activation (required onboarding)', testGoogleConnectAllowedDuringPendingActivation],

  // --- Part 4: location capacity expansion ---
  ['recordLocationApproval denies an addition while past_due', testRecordLocationApprovalDeniesAdditionWhilePastDue],
  ['recordLocationApproval still allows a pure reduction while past_due', testRecordLocationApprovalStillAllowsPureReductionWhilePastDue],

  // --- Part 5: seat/invite capacity ---
  ['invite-user denied while suspended', testInviteUserDeniedWhileSuspended],
  ['invite-user denied while past_due (capacity expansion frozen during grace)', testInviteUserDeniedWhilePastDue],
  ['disable-user always allowed while suspended', testDisableUserAlwaysAllowedWhileSuspended],
  ['disable-user allowed even on resolver failure', testDisableUserAllowedEvenOnResolverFailure],

  // --- Part 6: accept-invite ---
  ['accept-invite denied while suspended, token remains valid', testAcceptInviteDeniedWhileSuspendedTokenSurvives],
  ['accept-invite denied while canceled, token remains valid', testAcceptInviteDeniedWhileCanceledTokenSurvives],
  ['accept-invite resolver failure denies activation, token remains valid', testAcceptInviteResolverFailureTokenSurvives],
  ['accept-invite: same token succeeds on a later active retry', testAcceptInviteLaterActiveRetrySucceeds],
  ['accept-invite succeeds while past_due', testAcceptInvitePastDueSucceeds],
  ['accept-invite consumes the token exactly once; replay still fails', testSuccessfulAcceptInviteConsumesTokenExactlyOnceAndReplayFails],

  // --- Part 7: tasks ---
  ['task create denied while canceled', testTaskCreateDeniedWhileCanceled],
  ['task create allowed while past_due', testTaskCreateAllowedWhilePastDue],

  // --- Part 8: content ---
  ['upsert-campaign denied while suspended', testUpsertCampaignDeniedWhileSuspended],
  ['upsert-campaign allowed while active', testUpsertCampaignAllowedWhileActive],

  // --- Part 8b: content non-upload storage-quota bypass (pre-commit correction #4) ---
  ['create-text-asset denied during pending-trial activation', testCreateTextAssetDeniedDuringPendingActivation],
  ['create-text-asset denied at the commercial asset-count ceiling', testCreateTextAssetDeniedAtCommercialAssetCountCeiling],
  ['create-text-asset allowed under the ceiling', testCreateTextAssetAllowedUnderCeiling],
  ['create-text-asset resolver failure fails closed (0/0), denies the very first caption', testCreateTextAssetResolverFailureFailsClosed],
  ['upsert-campaign never creates a content_assets:v1 record', testUpsertCampaignNeverCreatesAnAssetRecord],
  ['every asset-creating content path is quota-checked (structural)', testEveryAssetCreatingPathIsQuotaChecked],

  // --- Part 8c: create-text-asset BYTE accounting (final storage-integrity assertion) ---
  ['create-text-asset byte size is server-computed, never trusted from the client', testCreateTextAssetByteSizeIsServerComputedNeverTrustedFromClient],
  ['create-text-asset denied at the commercial BYTE ceiling', testCreateTextAssetDeniedAtCommercialByteCeiling],
  ['create-text-asset denied at Phase A\'s hard 2GB ceiling', testCreateTextAssetDeniedAtPhaseATwoGbCeiling],
  ['create-text-asset suspended writes ZERO persistent record', testCreateTextAssetSuspendedWritesZeroPersistentRecord],
  ['create-text-asset resolver failure writes ZERO persistent record', testCreateTextAssetResolverFailureWritesZeroPersistentRecord],
  ['create-text-asset past_due succeeds subject to normal quota', testCreateTextAssetPastDueSucceedsSubjectToNormalQuota],
  ['deleting a text asset frees both asset count and recorded bytes', testDeletingTextAssetFreesAssetCountAndBytes],
  ['concurrent final-capacity text creations: exactly one succeeds', testConcurrentFinalCapacityTextCreationsExactlyOneSucceeds],

  // --- Part 10: directional access-expansion/reduction (pre-commit correction #3) ---
  ['role demotion (reduction) allowed while suspended', testRoleDemotionAllowedWhileSuspended],
  ['role promotion (expansion) denied while suspended', testRolePromotionDeniedWhileSuspended],
  ['role promotion (expansion) denied while past_due', testRolePromotionDeniedWhilePastDue],
  ['location scope addition (expansion) denied while suspended', testLocationScopeAdditionDeniedWhileSuspended],
  ['location scope removal (reduction) allowed while suspended', testLocationScopeRemovalAllowedWhileSuspended],
  ['granting canCreateTasks (expansion) denied while suspended', testGrantCanCreateTasksDeniedWhileSuspended],
  ['revoking canCreateTasks (reduction) allowed while suspended', testRevokeCanCreateTasksAllowedWhileSuspended],
  ['an Admin still cannot self-promote to Owner (canAssignRole unaffected)', testRolePromotionToOwnerStillRequiresOwnerActor],

  // --- Part 9: legacy ---
  ["LTA/BOOTSTRAP unaffected by every new gate", testLtaBootstrapUnaffectedByEveryNewGate],
]

async function main() {
  for (const [name, fn] of tests) await run(name, fn)
  console.log()
  const passed = results.filter(Boolean).length
  if (passed === results.length) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.length - passed} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
