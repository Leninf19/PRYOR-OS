// Multi-Tenant Phase 4I.3 -- Platform-Controlled Tenant Entitlement Changes.
//
// Tests dashboard/api/tenant-entitlements/[action].js (the platform-admin-
// only mutation endpoint) and tenantConfigStore.js's applyEntitlementChange()/
// markEntitlementChangeCompleted()/markEntitlementChangeFailed() directly.
// Phase 4I.1/4I.2 already proved a tenant Owner cannot self-service-expand
// or silently reconnect their way into a wider entitlement; this phase adds
// the ONE supported way an already-committed tenant's approvedLocations may
// still change -- an explicit, platform-admin-only, CAS-protected, audited
// mutation -- and this file proves that boundary from every adversarial
// angle the spec requires.
//
// No real Upstash, no real Google network call, no production data.
//
// Run directly: node tests/test_tenant_entitlement_change.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/tenant-entitlements/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { requireLocationAccess, isWildcardGrant } from '../dashboard/api/_lib/auth.js'
import {
  DEFAULT_TENANT_ID, tenantOwnsLocation, resolveLocationCatalogAuthz, _resetLocationCatalogRegistryForTests,
} from '../dashboard/api/_lib/tenants.js'
import {
  recordLocationApproval, getTenantConfig, upsertTenantConfig, markTenantProvisioned,
  applyEntitlementChange, markEntitlementChangeCompleted, markEntitlementChangeFailed,
  EntitlementChangeNotEligibleError, UnknownLocationRemovalError, LocationAlreadyApprovedError, ConfigVersionConflictError,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import {
  getStoredCredential, setStoredCredential, _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis,
} from '../dashboard/api/_lib/credentialStore.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis, getUserById, upsertUser } from '../dashboard/api/_lib/userStore.js'
import { _setRedisClientForTests as setAuditRedis, _resetRedisClientForTests as resetAuditRedis, listAuditEntries } from '../dashboard/api/_lib/auditLog.js'

const TENANT_A = 't_synthetic-entitlement-change-a'
const TENANT_B = 't_synthetic-entitlement-change-b'

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
    resetConfigRedis()
    resetCredentialRedis()
    resetUserRedis()
    resetAuditRedis()
    delete process.env.ACCOUNT_DIRECTORY_JSON
    delete globalThis.fetch
  }
}

function fakeHashRedis() {
  const store = {}
  return {
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
    // Faithfully emulates tenantConfigStore.js's CAS_UPSERT_SCRIPT
    // (HGET/compare-configVersion/HSET) for applyEntitlementChange()'s
    // required CAS write -- a synchronous JS function body is trivially
    // atomic with respect to any other code in this single-threaded test
    // process, exactly as the real Lua script is atomic against Redis.
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [field, expectedVersionStr, nextJson] = args
      const raw = store[key]?.[field] ?? null
      let currentVersion = '0'
      if (raw) {
        try {
          const decoded = JSON.parse(raw)
          if (decoded && decoded.configVersion !== undefined) currentVersion = String(decoded.configVersion)
        } catch { /* treat as version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
  }
}

function fakeKeyValueRedis() {
  const store = {}
  return { get: async (key) => store[key] ?? null, set: async (key, value) => { store[key] = value }, del: async (key) => { delete store[key] } }
}

function fakeUserRedis() {
  const store = { 'users:v1': {} }
  return {
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hget: async (key, field) => store[key]?.[field] ?? null,
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
  }
}

function fakeListRedis() {
  const store = {}
  return {
    lrange: async (key, start, end) => { const l = Array.isArray(store[key]) ? store[key] : []; return end === -1 ? l.slice(start) : l.slice(start, end + 1) },
    lpush: async (key, val) => { store[key] = [val, ...(Array.isArray(store[key]) ? store[key] : [])]; return store[key].length },
    ltrim: async () => 'OK',
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value; return res }
  res.getHeader = (name) => res.headers[name]
  return res
}

let sharedUserClient = null
function wireSharedStores() {
  const configClient = fakeHashRedis()
  setConfigRedis(() => configClient)
  const credentialClient = fakeKeyValueRedis()
  setCredentialRedis(() => credentialClient)
  const auditClient = fakeListRedis()
  setAuditRedis(() => auditClient)
  sharedUserClient = fakeUserRedis()
  setUserRedis(() => sharedUserClient)
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

async function setSuperAdminDirectory() {
  const hash = await passwordHash()
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{ userId: 'usr_super', email: 'super@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Platform Admin' }],
  })
}
const superAdminToken = () => signSession({ userId: 'usr_super', email: 'super@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })

async function setupTenantUser(tenantId, { userId, role = 'owner', locationIds = '*' }) {
  const hash = await passwordHash()
  // Multi-Tenant Phase 4K: written via the REAL upsertUser(tenantId, ...) --
  // for a TENANT_SCOPED-mode tenant (any synthetic tenant used in this
  // file), this correctly writes to that tenant's OWN hash
  // (usersKeyV2(tenantId)) AND populates the global identity index, so
  // accountStore.js's getAccountById()/getAccountByEmail() (used by
  // requireAuth() on every request) resolve it exactly the way a real
  // invited/promoted user would be resolved in production -- not a
  // hand-rolled write to the bootstrap hash.
  await upsertUser(tenantId, {
    userId, email: `${userId}@example.com`, passwordHash: hash, role, locationIds,
    sessionVersion: 1, disabled: false, tenantId,
  })
}
function tenantUserToken(tenantId, userId, role = 'owner', locationIds = '*') {
  return signSession({ userId, email: `${userId}@example.com`, role, locationIds, tenantId, sessionVersion: 1 })
}

async function commitTenant(tenantId, googleLocationIds) {
  await recordLocationApproval(tenantId, googleLocationIds.map((id, i) => ({ googleLocationId: id, title: `Location ${i + 1}`, address: '' })))
  const approvedConfig = await getTenantConfig(tenantId)
  await markTenantProvisioned(tenantId, {
    reviewDbBlobKey: `tenant-data/${tenantId}/reviews.db`,
    privateDataPrefix: `tenant-data/${tenantId}/private-data/`,
    provisionedLocationIds: approvedConfig.approvedLocations.map(l => l.locationId),
  })
  await upsertTenantConfig(tenantId, { status: 'active' })
  await setStoredCredential(tenantId, { refreshToken: `fake-refresh-token-${tenantId}`, connectedAccountName: 'Fake Account' })
  return getTenantConfig(tenantId)
}

function mockGoogleFetch(locationsByAccountName) {
  return async (url) => {
    const u = String(url)
    if (u.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'fake-access-token', expires_in: 3600, scope: 'x' }) }
    }
    if (u.includes('mybusinessaccountmanagement.googleapis.com') && u.includes('/accounts')) {
      return { ok: true, status: 200, json: async () => ({ accounts: Object.keys(locationsByAccountName).map(name => ({ name, accountName: name })) }) }
    }
    const acctMatch = Object.keys(locationsByAccountName).find(name => u.includes(`${name}/locations`))
    if (acctMatch) return { ok: true, status: 200, json: async () => ({ locations: locationsByAccountName[acctMatch] }) }
    throw new Error(`unexpected fetch in test: ${u}`)
  }
}

async function discover(tokenOrPromise, tenantId) {
  const token = await tokenOrPromise
  const req = { method: 'GET', query: { action: 'discover', tenantId }, headers: { cookie: `${SESSION_COOKIE}=${token}` } }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function apply(tokenOrPromise, body) {
  const token = await tokenOrPromise
  const req = { method: 'POST', query: { action: 'apply' }, body, headers: { cookie: `${SESSION_COOKIE}=${token}` } }
  const res = fakeRes()
  await handler(req, res)
  return res
}

// ===========================================================================
// 1. A tenant Owner cannot call the platform entitlement mutation
// ===========================================================================

async function testTenantOwnerCannotCallApply() {
  wireSharedStores()
  await setupTenantUser(TENANT_A, { userId: 'usr_a_owner' })
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  const res = await apply(tenantUserToken(TENANT_A, 'usr_a_owner'), { tenantId: TENANT_A, addGoogleLocationIds: [], removeLocationIds: [config.approvedLocations[0].locationId], expectedConfigVersion: config.configVersion })
  assert(res.statusCode === 403, `a tenant Owner must never be able to call the platform entitlement mutation, got ${res.statusCode}`)
  const after = await getTenantConfig(TENANT_A)
  assert(after.configVersion === config.configVersion, 'a rejected attempt must never write tenant_config')
}

async function testUnauthenticatedRejected() {
  wireSharedStores()
  const res = await apply(null, { tenantId: TENANT_A, addGoogleLocationIds: [], removeLocationIds: [1], expectedConfigVersion: 1 }).catch(() => null)
  // No cookie at all -- build the request directly to avoid a bad token string.
  const req = { method: 'POST', query: { action: 'apply' }, body: { tenantId: TENANT_A }, headers: {} }
  const res2 = fakeRes()
  await handler(req, res2)
  assert(res2.statusCode === 401, `expected 401 for an unauthenticated request, got ${res2.statusCode}`)
}

// ===========================================================================
// 2-3. Platform admin can add a valid discovered location; unverified cannot
// ===========================================================================

async function testPlatformAdminCanAddValidDiscoveredLocation() {
  wireSharedStores()
  await setSuperAdminDirectory()
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A'])

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A', title: 'A' }, { name: 'locations/B', title: 'B' }] })
  const res = await apply(superAdminToken(), { tenantId: TENANT_A, addGoogleLocationIds: ['accounts/1/locations/B'], removeLocationIds: [], expectedConfigVersion: config.configVersion })
  assert(res.statusCode === 200, `expected success, got ${res.statusCode} ${JSON.stringify(res.body)}`)

  const after = await getTenantConfig(TENANT_A)
  const added = after.approvedLocations.find(l => l.googleLocationId === 'accounts/1/locations/B')
  assert(added, 'the newly added location must appear in approvedLocations')
  assert(added.operational === false, 'a newly added location must NOT be operational until the data-plane follow-up succeeds')
  assert(after.entitlementChange.status === 'pending', `expected entitlementChange.status 'pending', got ${after.entitlementChange.status}`)

  const authz = await resolveLocationCatalogAuthz(TENANT_A)
  assert(!tenantOwnsLocation(TENANT_A, added.locationId, authz), 'a pending (non-operational) addition must not be authorized yet')
}

async function testUnverifiedLocationCannotBeAdded() {
  wireSharedStores()
  await setSuperAdminDirectory()
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A'])

  // The Google credential only sees A -- the admin nonetheless requests to
  // add a location the credential cannot currently see.
  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A', title: 'A' }] })
  const res = await apply(superAdminToken(), { tenantId: TENANT_A, addGoogleLocationIds: ['accounts/1/locations/UNSEEN'], removeLocationIds: [], expectedConfigVersion: config.configVersion })
  assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`)
  assert(res.body.error === 'unverified_location', `expected error 'unverified_location', got ${JSON.stringify(res.body)}`)

  const after = await getTenantConfig(TENANT_A)
  assert(after.configVersion === config.configVersion, 'an unverified addition must never mutate tenant_config at all')
  assert(after.approvedLocations.length === 1, 'approvedLocations must remain exactly as it was')
}

// ===========================================================================
// 4-6. Removal revokes wildcard/explicit access immediately; addition never widens
// ===========================================================================

async function testRemovingLocationImmediatelyRevokesWildcardAccess() {
  wireSharedStores()
  await setSuperAdminDirectory()
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A', 'accounts/1/locations/B'])
  const [locA, locB] = config.approvedLocations

  const res = await apply(superAdminToken(), { tenantId: TENANT_A, addGoogleLocationIds: [], removeLocationIds: [locB.locationId], expectedConfigVersion: config.configVersion })
  assert(res.statusCode === 200, `expected success, got ${res.statusCode} ${JSON.stringify(res.body)}`)

  const authz = await resolveLocationCatalogAuthz(TENANT_A)
  const wildcardAccount = { tenantId: TENANT_A, locationIds: '*', locationCatalogAuthz: authz }
  assert(isWildcardGrant(wildcardAccount), 'sanity: a real wildcard grant')
  assert(requireLocationAccess(wildcardAccount, locA.locationId), 'the surviving location must remain reachable via wildcard')
  assert(!requireLocationAccess(wildcardAccount, locB.locationId), 'the removed location must be immediately unreachable via wildcard, with no further steps required')
}

async function testRemovingLocationImmediatelyRevokesExplicitUserAccess() {
  wireSharedStores()
  await setSuperAdminDirectory()
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A', 'accounts/1/locations/B'])
  const [locA, locB] = config.approvedLocations

  const authzBefore = await resolveLocationCatalogAuthz(TENANT_A)
  const scopedAccount = { tenantId: TENANT_A, locationIds: [locA.locationId, locB.locationId], locationCatalogAuthz: authzBefore }
  assert(requireLocationAccess(scopedAccount, locB.locationId), 'sanity: reachable before removal')

  await apply(superAdminToken(), { tenantId: TENANT_A, addGoogleLocationIds: [], removeLocationIds: [locB.locationId], expectedConfigVersion: config.configVersion })

  const authzAfter = await resolveLocationCatalogAuthz(TENANT_A)
  const scopedAccountAfter = { tenantId: TENANT_A, locationIds: [locA.locationId, locB.locationId], locationCatalogAuthz: authzAfter }
  assert(!requireLocationAccess(scopedAccountAfter, locB.locationId), 'an explicitly-scoped account must be immediately denied the removed location, even though its OWN array still lists it')
  assert(requireLocationAccess(scopedAccountAfter, locA.locationId), 'the surviving location must remain reachable for the same account')
}

async function testAddingLocationDoesNotWidenNonWildcardUserGrant() {
  wireSharedStores()
  await setSuperAdminDirectory()
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  const locA = config.approvedLocations[0]

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A', title: 'A' }, { name: 'locations/B', title: 'B' }] })
  await apply(superAdminToken(), { tenantId: TENANT_A, addGoogleLocationIds: ['accounts/1/locations/B'], removeLocationIds: [], expectedConfigVersion: config.configVersion })

  // Simulate the data-plane follow-up succeeding, promoting B to operational.
  const afterAdd = await getTenantConfig(TENANT_A)
  await markEntitlementChangeCompleted(TENANT_A, { expectedVersion: afterAdd.configVersion })
  const locB = (await getTenantConfig(TENANT_A)).approvedLocations.find(l => l.googleLocationId === 'accounts/1/locations/B')

  const authz = await resolveLocationCatalogAuthz(TENANT_A)
  // A non-wildcard account scoped ONLY to A, unchanged by the admin's addition.
  const scopedAccount = { tenantId: TENANT_A, locationIds: [locA.locationId], locationCatalogAuthz: authz }
  assert(requireLocationAccess(scopedAccount, locA.locationId), 'sanity: A remains reachable')
  assert(!requireLocationAccess(scopedAccount, locB.locationId), 'adding a new tenant-approved location must never widen an existing non-wildcard account\'s own explicit grant')
}

// ===========================================================================
// 7-8. Stable ids: unchanged on survival, never recycled on removal
// ===========================================================================

async function testExistingLocationIdsRemainUnchanged() {
  wireSharedStores()
  await setSuperAdminDirectory()
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A', 'accounts/1/locations/B', 'accounts/1/locations/C'])
  const [locA, locB, locC] = config.approvedLocations

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A' }, { name: 'locations/B' }, { name: 'locations/C' }, { name: 'locations/D' }] })
  await apply(superAdminToken(), { tenantId: TENANT_A, addGoogleLocationIds: ['accounts/1/locations/D'], removeLocationIds: [locB.locationId], expectedConfigVersion: config.configVersion })

  const after = await getTenantConfig(TENANT_A)
  const survivingA = after.approvedLocations.find(l => l.googleLocationId === 'accounts/1/locations/A')
  const survivingC = after.approvedLocations.find(l => l.googleLocationId === 'accounts/1/locations/C')
  assert(survivingA.locationId === locA.locationId, `A's locationId must never change, expected ${locA.locationId} got ${survivingA.locationId}`)
  assert(survivingC.locationId === locC.locationId, `C's locationId must never change, expected ${locC.locationId} got ${survivingC.locationId}`)
}

async function testRemovedIdsAreNeverRecycled() {
  wireSharedStores()
  await setSuperAdminDirectory()
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A', 'accounts/1/locations/B'])
  const [locA, locB] = config.approvedLocations

  // Remove B, then add a brand-new, unrelated location E.
  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A' }, { name: 'locations/E' }] })
  await apply(superAdminToken(), { tenantId: TENANT_A, addGoogleLocationIds: ['accounts/1/locations/E'], removeLocationIds: [locB.locationId], expectedConfigVersion: config.configVersion })

  const after = await getTenantConfig(TENANT_A)
  const locE = after.approvedLocations.find(l => l.googleLocationId === 'accounts/1/locations/E')
  assert(locE.locationId !== locB.locationId, `the removed id (${locB.locationId}) must never be recycled for a new, unrelated location -- got the same id for E`)
  assert(after.locationIdMap['accounts/1/locations/B'] === locB.locationId, 'the removed location\'s id reservation must remain PERMANENT in locationIdMap even though it is no longer approved')
  assert(!after.approvedLocations.some(l => l.googleLocationId === 'accounts/1/locations/B'), 'B must no longer appear in approvedLocations at all')

  // Re-adding B later must restore its ORIGINAL id, never a new one.
  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A' }, { name: 'locations/E' }, { name: 'locations/B' }] })
  await apply(superAdminToken(), { tenantId: TENANT_A, addGoogleLocationIds: ['accounts/1/locations/B'], removeLocationIds: [], expectedConfigVersion: after.configVersion })
  const reAdded = (await getTenantConfig(TENANT_A)).approvedLocations.find(l => l.googleLocationId === 'accounts/1/locations/B')
  assert(reAdded.locationId === locB.locationId, `re-adding a previously removed location must restore its ORIGINAL id (${locB.locationId}), got ${reAdded.locationId}`)
}

// ===========================================================================
// 9-10. Concurrency: stale CAS fails; simultaneous edits cannot clobber
// ===========================================================================

async function testStaleConfigCasFails() {
  wireSharedStores()
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  // Someone else mutates the config (e.g. a branding change) in between.
  await upsertTenantConfig(TENANT_A, { displayName: 'New Display Name' })

  let threw = null
  try {
    await applyEntitlementChange(TENANT_A, { addGoogleLocations: [], removeLocationIds: [config.approvedLocations[0].locationId] }, config.configVersion)
  } catch (e) {
    threw = e
  }
  assert(threw instanceof ConfigVersionConflictError, `expected ConfigVersionConflictError, got ${threw?.constructor?.name ?? 'no throw'}`)
  const after = await getTenantConfig(TENANT_A)
  assert(after.approvedLocations.length === 1, 'a stale-CAS attempt must never mutate approvedLocations')
}

async function testSimultaneousEntitlementEditsCannotClobberEachOther() {
  wireSharedStores()
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A', 'accounts/1/locations/B'])
  const [locA, locB] = config.approvedLocations

  // Two admins both read the SAME starting configVersion, then both
  // attempt their own (different) edit.
  const editorOneResult = await applyEntitlementChange(TENANT_A, { addGoogleLocations: [], removeLocationIds: [locA.locationId] }, config.configVersion)
  assert(editorOneResult.config.configVersion === config.configVersion + 1, 'sanity: the first edit succeeds and advances the version')

  let threw = null
  try {
    await applyEntitlementChange(TENANT_A, { addGoogleLocations: [], removeLocationIds: [locB.locationId] }, config.configVersion) // stale -- built on the OLD version
  } catch (e) {
    threw = e
  }
  assert(threw instanceof ConfigVersionConflictError, 'the second, stale edit (based on the pre-first-edit version) must fail closed rather than silently clobbering the first')

  const final = await getTenantConfig(TENANT_A)
  assert(!final.approvedLocations.some(l => l.locationId === locA.locationId), 'the first (successful) edit\'s removal must be preserved')
  assert(final.approvedLocations.some(l => l.locationId === locB.locationId), 'B must still be approved -- the second, rejected edit must never have taken effect')
}

// ===========================================================================
// 11. Cross-tenant isolation
// ===========================================================================

async function testTenantAAdminOperationCannotTouchTenantB() {
  wireSharedStores()
  await setSuperAdminDirectory()
  const configA = await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  const configB = await commitTenant(TENANT_B, ['accounts/2/locations/B'])

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A' }] })
  const res = await apply(superAdminToken(), { tenantId: TENANT_A, addGoogleLocationIds: [], removeLocationIds: [configA.approvedLocations[0].locationId], expectedConfigVersion: configA.configVersion })
  assert(res.statusCode === 200, `sanity: Tenant A's own operation succeeds, got ${res.statusCode}`)

  const tenantBAfter = await getTenantConfig(TENANT_B)
  assert(tenantBAfter.configVersion === configB.configVersion, 'an operation targeting Tenant A must never touch Tenant B\'s configVersion')
  assert(JSON.stringify(tenantBAfter.approvedLocations) === JSON.stringify(configB.approvedLocations), 'Tenant B\'s approvedLocations must be byte-identical after an operation against Tenant A')
}

async function testDiscoverTargetsOnlyTheRequestedTenantsCredential() {
  wireSharedStores()
  await setSuperAdminDirectory()
  await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  await commitTenant(TENANT_B, ['accounts/2/locations/B'])

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A' }, { name: 'locations/EXTRA' }] })
  const res = await discover(superAdminToken(), TENANT_A)
  assert(res.statusCode === 200, `expected success, got ${res.statusCode}`)
  assert(res.body.tenantId === TENANT_A, 'the discovery response must be scoped to the requested tenant')
  assert(res.body.discoveredLocations.some(l => l.googleLocationId === 'accounts/1/locations/EXTRA'), 'discovery must reflect Tenant A\'s OWN credential, not any other tenant\'s')
}

// ===========================================================================
// 12. Failed data-plane work never makes a location operational
// ===========================================================================

async function testFailedDataPlaneWorkDoesNotMakeLocationOperational() {
  wireSharedStores()
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  const result = await applyEntitlementChange(TENANT_A, { addGoogleLocations: [{ googleLocationId: 'accounts/1/locations/B', title: 'B', address: '' }], removeLocationIds: [] }, config.configVersion)

  const pending = await getTenantConfig(TENANT_A)
  assert(pending.entitlementChange.status === 'pending', 'sanity: pending after the config mutation')

  // Simulates apply_entitlement_change.py's OWN failure path (a Google
  // sync error, an artifact upload failure, a stale Blob ETag, etc).
  await markEntitlementChangeFailed(TENANT_A, 'GoogleSyncFailedError: simulated failure', { expectedVersion: pending.configVersion })

  const after = await getTenantConfig(TENANT_A)
  assert(after.entitlementChange.status === 'failed', `expected entitlementChange.status 'failed', got ${after.entitlementChange.status}`)
  const addedEntry = after.approvedLocations.find(l => l.locationId === result.addedLocationIds[0])
  assert(addedEntry.operational === false, 'a location whose data-plane follow-up failed must remain non-operational')

  const authz = await resolveLocationCatalogAuthz(TENANT_A)
  assert(!tenantOwnsLocation(TENANT_A, result.addedLocationIds[0], authz), 'a failed addition must never become accessible, regardless of entitlementChange.status')
}

// ===========================================================================
// Additional adversarial coverage: eligibility, unknown removal, duplicate
// addition, account-grant reconciliation, audit trail
// ===========================================================================

async function testIneligibleTenantStatusRejected() {
  wireSharedStores()
  await setSuperAdminDirectory()
  // A fresh tenant, still onboarding -- this admin path is for COMMITTED
  // tenants only; a pre-commit tenant uses the ordinary approve-locations flow.
  await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/A', title: 'A', address: '' }])
  const config = await getTenantConfig(TENANT_A) // status: 'locations_approved'

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A' }] })
  const res = await apply(superAdminToken(), { tenantId: TENANT_A, addGoogleLocationIds: [], removeLocationIds: [config.approvedLocations[0].locationId], expectedConfigVersion: config.configVersion })
  assert(res.statusCode === 409, `expected 409 not_eligible for a pre-commit tenant, got ${res.statusCode}`)
  assert(res.body.error === 'not_eligible', `expected error 'not_eligible', got ${JSON.stringify(res.body)}`)
}

async function testUnknownLocationRemovalRejected() {
  wireSharedStores()
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  let threw = null
  try {
    await applyEntitlementChange(TENANT_A, { addGoogleLocations: [], removeLocationIds: [99999] }, config.configVersion)
  } catch (e) {
    threw = e
  }
  assert(threw instanceof UnknownLocationRemovalError, `expected UnknownLocationRemovalError, got ${threw?.constructor?.name ?? 'no throw'}`)
}

async function testDuplicateAdditionOfAlreadyApprovedLocationRejected() {
  wireSharedStores()
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  let threw = null
  try {
    await applyEntitlementChange(TENANT_A, { addGoogleLocations: [{ googleLocationId: 'accounts/1/locations/A', title: 'A', address: '' }], removeLocationIds: [] }, config.configVersion)
  } catch (e) {
    threw = e
  }
  assert(threw instanceof LocationAlreadyApprovedError, `re-adding an already-approved location must be rejected, got ${threw?.constructor?.name ?? 'no throw'}`)
}

async function testAccountGrantReconciliationNarrowsAndAudits() {
  wireSharedStores()
  await setSuperAdminDirectory()
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A', 'accounts/1/locations/B'])
  const [locA, locB] = config.approvedLocations
  await setupTenantUser(TENANT_A, { userId: 'usr_a_manager', role: 'location_manager', locationIds: [locA.locationId, locB.locationId] })

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A' }] })
  const res = await apply(superAdminToken(), { tenantId: TENANT_A, addGoogleLocationIds: [], removeLocationIds: [locB.locationId], expectedConfigVersion: config.configVersion })
  assert(res.statusCode === 200, `expected success, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  assert(res.body.accountReconciliation.narrowed.includes('usr_a_manager'), 'the affected account must be reported as narrowed')

  // Multi-Tenant Phase 4K: reconcileAccountGrantsAfterLocationRemoval() now
  // reads/writes TENANT_A's own store directly -- no more bootstrap detour.
  const managerAfter = await getUserById(TENANT_A, 'usr_a_manager')
  assert(JSON.stringify(managerAfter.locationIds) === JSON.stringify([locA.locationId]), `expected the manager's grant to be narrowed to [${locA.locationId}], got ${JSON.stringify(managerAfter.locationIds)}`)
  assert(managerAfter.sessionVersion === 2, 'the affected account\'s sessionVersion must be bumped to force re-auth')

  const { entries } = await listAuditEntries(TENANT_A, {})
  const successEntry = entries.find(e => e.action === 'entitlement.changed')
  assert(successEntry, 'a successful entitlement change must be audit-logged')
  assert(successEntry.result === 'success', 'the audit entry must record success')
  assert(successEntry.changes.removedLocationIds.includes(locB.locationId), 'the audit entry must record which location(s) were removed')
  assert(!JSON.stringify(successEntry).toLowerCase().includes('fake-refresh-token'), 'the audit entry must never contain credential material')
}

async function main() {
  console.log('--- Authorization ---')
  await run('a tenant Owner cannot call the platform entitlement mutation', testTenantOwnerCannotCallApply)
  await run('an unauthenticated request is rejected', testUnauthenticatedRejected)

  console.log('\n--- Add / verify ---')
  await run('a platform admin can add a valid discovered location', testPlatformAdminCanAddValidDiscoveredLocation)
  await run('an unverified Google location cannot be added', testUnverifiedLocationCannotBeAdded)

  console.log('\n--- Authorization revocation / non-widening ---')
  await run('removing a location immediately revokes wildcard access', testRemovingLocationImmediatelyRevokesWildcardAccess)
  await run('removing a location immediately revokes explicit user access', testRemovingLocationImmediatelyRevokesExplicitUserAccess)
  await run('adding a location does not widen a non-wildcard user\'s grant', testAddingLocationDoesNotWidenNonWildcardUserGrant)

  console.log('\n--- Stable identifiers ---')
  await run('existing location ids remain unchanged', testExistingLocationIdsRemainUnchanged)
  await run('removed ids are never recycled', testRemovedIdsAreNeverRecycled)

  console.log('\n--- Concurrency ---')
  await run('a stale config CAS fails', testStaleConfigCasFails)
  await run('simultaneous entitlement edits cannot clobber each other', testSimultaneousEntitlementEditsCannotClobberEachOther)

  console.log('\n--- Cross-tenant isolation ---')
  await run('Tenant A\'s admin operation cannot touch Tenant B', testTenantAAdminOperationCannotTouchTenantB)
  await run('discovery targets only the requested tenant\'s own credential', testDiscoverTargetsOnlyTheRequestedTenantsCredential)

  console.log('\n--- Failure semantics ---')
  await run('failed data-plane work never makes a location operational', testFailedDataPlaneWorkDoesNotMakeLocationOperational)

  console.log('\n--- Additional adversarial coverage ---')
  await run('an ineligible (pre-commit) tenant status is rejected', testIneligibleTenantStatusRejected)
  await run('removing an unknown location id is rejected', testUnknownLocationRemovalRejected)
  await run('re-adding an already-approved location is rejected', testDuplicateAdditionOfAlreadyApprovedLocationRejected)
  await run('account-grant reconciliation narrows grants and is audited', testAccountGrantReconciliationNarrowsAndAudits)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
