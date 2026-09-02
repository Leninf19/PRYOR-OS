// Multi-Tenant Phase 4E Revision -- Tenant Location Catalog Activation.
//
// Phase 4E's first pass replaced tenantOwnsLocationCatalog()'s hardcode
// with TENANT_LOCATION_CATALOG_REGISTRY, a Set still committed with the
// application -- correct isolation, but activating a real tenant still
// required a source-code change and a deploy, which conflicts with PRYOR
// OS's self-service onboarding model. This revision replaces that
// registry with a real runtime source of truth (tenantConfigStore.js,
// Redis-backed) and a server-controlled activation transaction:
//   authenticated Owner -> discover-locations (Google, this tenant's own
//   credential) -> approve-locations (validated against a short-lived,
//   tenant-bound discovery-session record) -> tenantConfigStore's
//   locationCatalogEnabled flips true.
//
// This file proves the 9 properties required of that transaction. No real
// Upstash account, no real Google OAuth client, no production Redis, and
// no real Google network call anywhere in this file -- Google itself is a
// mocked globalThis.fetch, matching test_publish_reply.js/
// test_phase4b_cross_tenant_adversarial.js's established convention.
//
// Run directly: node tests/test_tenant_location_catalog_activation.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'

import bcrypt from 'bcryptjs'
import googleHandler from '../dashboard/api/google/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { requireLocationAccess } from '../dashboard/api/_lib/auth.js'
import {
  DEFAULT_TENANT_ID, tenantOwnsLocationCatalog, resolveLocationCatalogAuthz,
  _resetLocationCatalogRegistryForTests,
} from '../dashboard/api/_lib/tenants.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'
import { setStoredCredential, _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis } from '../dashboard/api/_lib/credentialStore.js'
import { getTenantConfig, upsertTenantConfig, _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis } from '../dashboard/api/_lib/tenantConfigStore.js'
import { createDiscoverySession, _setRedisClientForTests as setDiscoveryRedis, _resetRedisClientForTests as resetDiscoveryRedis } from '../dashboard/api/_lib/locationDiscoveryStore.js'

const TENANT_B = 't_synthetic-activation-tenant'
const UNKNOWN_TENANT = 't_never-onboarded-activation-tenant'

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
    resetUserRedis()
    resetCredentialRedis()
    resetConfigRedis()
    resetDiscoveryRedis()
    delete globalThis.fetch
  }
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

function fakeHashRedis() {
  const store = {}
  return {
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
  }
}

function fakeKeyValueRedis() {
  const store = {}
  return {
    get: async (key) => store[key] ?? null,
    set: async (key, value) => { store[key] = value },
    del: async (key) => { delete store[key] },
  }
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
  res.setHeader = (name, value) => { res.headers[name] = value; return res }
  res.getHeader = (name) => res.headers[name]
  return res
}

// Mocks Google's OAuth token endpoint + accounts.list + locations.list --
// every call this file's flows make, whichever tenant is authenticated.
// `locationsByAccountName` maps a fake Google account resource name to the
// list of raw location objects Google would return for it, so Tenant A and
// Tenant B can be given distinct, independently-controlled discovery
// results within the same test.
function mockGoogleFetch(locationsByAccountName) {
  return async (url) => {
    const u = String(url)
    if (u.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'fake-access-token', expires_in: 3600, scope: 'x' }) }
    }
    if (u.includes('mybusinessaccountmanagement.googleapis.com/v1/accounts')) {
      return { ok: true, status: 200, json: async () => ({ accounts: Object.keys(locationsByAccountName).map(name => ({ name, accountName: name })) }) }
    }
    const acctMatch = Object.keys(locationsByAccountName).find(name => u.includes(`${name}/locations`))
    if (acctMatch) {
      return { ok: true, status: 200, json: async () => ({ locations: locationsByAccountName[acctMatch] }) }
    }
    throw new Error(`unexpected fetch in test: ${u}`)
  }
}

async function setupTenant(tenantId, { userId, email }) {
  const hash = await passwordHash()
  if (tenantId === DEFAULT_TENANT_ID) {
    process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
      accounts: [{ userId, email, passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false }],
    })
  } else {
    const record = { userId, email, passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId }
    setUserRedis(() => fakeUserRedis({ [userId]: JSON.stringify(record) }))
  }
  await setStoredCredential(tenantId, { refreshToken: `fake-refresh-token-${tenantId}`, connectedAccountName: 'Fake Account' })
}

async function tokenFor(userId, email, tenantId) {
  return signSession({ userId, email, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
}

// Resolves a FRESH, request-bound authorization snapshot for tenantId
// (tenants.js's resolveLocationCatalogAuthz()) and immediately checks
// tenantOwnsLocationCatalog() against it -- the replacement for the prior
// primeLocationCatalogState()+bare-tenantOwnsLocationCatalog() pattern, now
// that there is no process-global cache to prime. Mirrors exactly how a
// real request would resolve+check within auth.js's evaluateSession().
async function ownsCatalog(tenantId) {
  const authz = await resolveLocationCatalogAuthz(tenantId)
  return tenantOwnsLocationCatalog(tenantId, authz)
}

// Two Owner accounts in the SAME (non-LTA) tenant -- both records live in
// the same fake Redis-backed user store hash, unlike setupTenant() (which
// replaces the whole store per call and would lose the first user).
async function setupTenantWithTwoOwners(tenantId, userA, userB) {
  const hash = await passwordHash()
  const recordA = { userId: userA.userId, email: userA.email, passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId }
  const recordB = { userId: userB.userId, email: userB.email, passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId }
  setUserRedis(() => fakeUserRedis({ [userA.userId]: JSON.stringify(recordA), [userB.userId]: JSON.stringify(recordB) }))
  await setStoredCredential(tenantId, { refreshToken: `fake-refresh-token-${tenantId}`, connectedAccountName: 'Fake Account' })
}

async function discover(token, extra = {}) {
  const req = { method: 'POST', query: { action: 'discover-locations', ...(extra.query ?? {}) }, body: extra.body, headers: { cookie: `${SESSION_COOKIE}=${token}`, ...(extra.headers ?? {}) } }
  const res = fakeRes()
  await googleHandler(req, res)
  return res
}

async function approve(token, body, extra = {}) {
  const req = { method: 'POST', query: { action: 'approve-locations', ...(extra.query ?? {}) }, body, headers: { cookie: `${SESSION_COOKIE}=${token}`, ...(extra.headers ?? {}) } }
  const res = fakeRes()
  await googleHandler(req, res)
  return res
}

// Both stores below are hash-shaped -- shared across tenants within one
// test, matching production (single Redis hash per store, tenant-namespaced
// by field/key, not by a separate client per tenant).
function wireSharedStores() {
  // IMPORTANT: each client must be constructed ONCE and the factory must
  // return that SAME instance every time -- _setRedisClientForTests's
  // factory is invoked fresh on every getClient() call (by design, so a
  // test can vary behavior call-by-call), so a factory that constructs a
  // new store inline (`() => fakeHashRedis()`) would silently hand back an
  // empty store on every read, discarding whatever a prior write wrote.
  const configClient = fakeHashRedis()
  setConfigRedis(() => configClient)
  const credentialClient = fakeKeyValueRedis()
  setCredentialRedis(() => credentialClient)
  const discoveryClient = fakeKeyValueRedis()
  setDiscoveryRedis(() => discoveryClient)
}

// ===========================================================================
// 1: A tenant can become catalog-enabled without a source-code change
// ===========================================================================

async function testTenantCanBecomeCatalogEnabledWithoutSourceChange() {
  wireSharedStores()
  await setupTenant(TENANT_B, { userId: 'usr_b', email: 'b@example.com' })
  const tokenB = await tokenFor('usr_b', 'b@example.com', TENANT_B)

  assert(!tenantOwnsLocationCatalog(TENANT_B), 'sanity: TENANT_B owns no catalog before onboarding')

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/1', title: 'Tenant B Restaurant', storefrontAddress: { locality: 'Springfield' } }] })
  const discoverRes = await discover(tokenB)
  assert(discoverRes.statusCode === 200, `discover-locations must succeed, got ${discoverRes.statusCode} ${JSON.stringify(discoverRes.body)}`)
  assert(discoverRes.body.locations.length === 1, 'exactly one location must be discovered')
  const googleLocationId = discoverRes.body.locations[0].googleLocationId

  const approveRes = await approve(tokenB, { discoverySessionId: discoverRes.body.discoverySessionId, selectedGoogleLocationIds: [googleLocationId] })
  assert(approveRes.statusCode === 200, `approve-locations must succeed, got ${approveRes.statusCode} ${JSON.stringify(approveRes.body)}`)
  assert(approveRes.body.activatedLocationCount === 1, 'exactly one location must be recorded as activated')

  // No _setLocationCatalogRegistryForTests call anywhere in this test --
  // this is entirely a runtime/Redis-backed activation, exactly what a
  // real deploy with zero source changes would produce.
  assert(await ownsCatalog(TENANT_B), 'TENANT_B must now own a location catalog, purely from runtime state')

  const config = await getTenantConfig(TENANT_B)
  assert(config.status === 'active' && config.locationCatalogEnabled === true, 'the persisted tenant config record must reflect activation')
}

// ===========================================================================
// 2: Tenant A cannot activate Tenant B
// ===========================================================================

async function testTenantACannotActivateTenantB() {
  wireSharedStores()
  await setupTenant(DEFAULT_TENANT_ID, { userId: 'usr_a', email: 'a@example.com' })
  await setupTenant(TENANT_B, { userId: 'usr_b', email: 'b@example.com' })
  const tokenA = await tokenFor('usr_a', 'a@example.com', DEFAULT_TENANT_ID)
  const tokenB = await tokenFor('usr_b', 'b@example.com', TENANT_B)

  globalThis.fetch = mockGoogleFetch({ 'accounts/2': [{ name: 'locations/2', title: 'Tenant B Only Location' }] })
  const discoverB = await discover(tokenB)
  const googleLocationId = discoverB.body.locations[0].googleLocationId

  // Tenant A attempts to approve using TENANT B's own discovery session id.
  const approveAsA = await approve(tokenA, { discoverySessionId: discoverB.body.discoverySessionId, selectedGoogleLocationIds: [googleLocationId] })
  assert(approveAsA.statusCode === 404, `Tenant A must never be able to consume Tenant B's discovery session, got ${approveAsA.statusCode}`)

  assert(!(await ownsCatalog(TENANT_B)), 'Tenant B must remain un-activated after Tenant A\'s attempt')
}

// ===========================================================================
// 2b: A different Owner in the SAME tenant cannot approve another Owner's
//     discovery session (final review's discovery-session user binding)
// ===========================================================================

async function testDifferentOwnerInSameTenantCannotApproveAnothersDiscoverySession() {
  wireSharedStores()
  await setupTenantWithTwoOwners(TENANT_B, { userId: 'usr_b1', email: 'b1@example.com' }, { userId: 'usr_b2', email: 'b2@example.com' })
  const tokenB1 = await tokenFor('usr_b1', 'b1@example.com', TENANT_B)
  const tokenB2 = await tokenFor('usr_b2', 'b2@example.com', TENANT_B)

  globalThis.fetch = mockGoogleFetch({ 'accounts/2b': [{ name: 'locations/2b', title: 'Discovered By Owner 1' }] })
  const discoverByOwner1 = await discover(tokenB1)
  const googleLocationId = discoverByOwner1.body.locations[0].googleLocationId

  const approveByOwner2 = await approve(tokenB2, { discoverySessionId: discoverByOwner1.body.discoverySessionId, selectedGoogleLocationIds: [googleLocationId] })
  assert(approveByOwner2.statusCode === 404, `a different Owner in the same tenant must not be able to approve another Owner's discovery session, got ${approveByOwner2.statusCode}`)

  assert(!(await ownsCatalog(TENANT_B)), 'the tenant must remain un-activated after a same-tenant, wrong-user approval attempt')

  // The discovering Owner's own approval of their own session must still work.
  const approveByOwner1 = await approve(tokenB1, { discoverySessionId: discoverByOwner1.body.discoverySessionId, selectedGoogleLocationIds: [googleLocationId] })
  assert(approveByOwner1.statusCode === 200, `the discovering Owner's own approval must still succeed, got ${approveByOwner1.statusCode} ${JSON.stringify(approveByOwner1.body)}`)
}

// ===========================================================================
// 3: A forged tenantId in query/body/header cannot activate another tenant
// ===========================================================================

async function testForgedTenantIdCannotActivateAnotherTenant() {
  wireSharedStores()
  await setupTenant(TENANT_B, { userId: 'usr_b', email: 'b@example.com' })
  const tokenB = await tokenFor('usr_b', 'b@example.com', TENANT_B)

  globalThis.fetch = mockGoogleFetch({ 'accounts/3': [{ name: 'locations/3', title: 'Tenant B Location' }] })
  const discoverB = await discover(tokenB, { query: { tenantId: DEFAULT_TENANT_ID }, headers: { 'x-tenant-id': DEFAULT_TENANT_ID } })
  const googleLocationId = discoverB.body.locations[0].googleLocationId

  const approveRes = await approve(
    tokenB,
    { discoverySessionId: discoverB.body.discoverySessionId, selectedGoogleLocationIds: [googleLocationId], tenantId: DEFAULT_TENANT_ID },
    { query: { tenantId: DEFAULT_TENANT_ID }, headers: { 'x-tenant-id': DEFAULT_TENANT_ID } },
  )
  assert(approveRes.statusCode === 200, `Tenant B's own legitimate approval must still succeed despite the forged fields, got ${approveRes.statusCode}`)
  assert(approveRes.body.tenantId === TENANT_B, 'activation must be recorded against the AUTHENTICATED tenant, never the forged one')

  assert(await ownsCatalog(TENANT_B), 'TENANT_B must be the one actually activated')
  const ltaConfig = await getTenantConfig(DEFAULT_TENANT_ID)
  assert(ltaConfig === null, 'Los Tres Amigos\'s config record must be completely untouched by a forged tenantId in Tenant B\'s request')
}

// ===========================================================================
// 4: A client cannot approve a Google location not in the trusted
//    discovery result
// ===========================================================================

async function testClientCannotApproveUndiscoveredLocation() {
  wireSharedStores()
  await setupTenant(TENANT_B, { userId: 'usr_b', email: 'b@example.com' })
  const tokenB = await tokenFor('usr_b', 'b@example.com', TENANT_B)

  globalThis.fetch = mockGoogleFetch({ 'accounts/4': [{ name: 'locations/4', title: 'Real Discovered Location' }] })
  const discoverB = await discover(tokenB)
  const realId = discoverB.body.locations[0].googleLocationId
  const forgedId = 'accounts/999/locations/999'

  const approveRes = await approve(tokenB, { discoverySessionId: discoverB.body.discoverySessionId, selectedGoogleLocationIds: [realId, forgedId] })
  assert(approveRes.statusCode === 400, `an undiscovered location id must be rejected, got ${approveRes.statusCode} ${JSON.stringify(approveRes.body)}`)
  assert(approveRes.body.error === 'location_not_discovered', `expected error 'location_not_discovered', got ${JSON.stringify(approveRes.body)}`)

  assert(!(await ownsCatalog(TENANT_B)), 'the catalog must NOT be activated when any selected location fails discovery validation')
}

// ===========================================================================
// 5: A discovery result from Tenant A cannot be replayed under Tenant B
// ===========================================================================

async function testDiscoveryResultCannotBeReplayedAcrossTenants() {
  wireSharedStores()
  await setupTenant(DEFAULT_TENANT_ID, { userId: 'usr_a', email: 'a@example.com' })
  await setupTenant(TENANT_B, { userId: 'usr_b', email: 'b@example.com' })
  const tokenA = await tokenFor('usr_a', 'a@example.com', DEFAULT_TENANT_ID)
  const tokenB = await tokenFor('usr_b', 'b@example.com', TENANT_B)

  globalThis.fetch = mockGoogleFetch({ 'accounts/5': [{ name: 'locations/5', title: 'Los Tres Amigos Real Location' }] })
  const discoverA = await discover(tokenA)
  const locationIdFromA = discoverA.body.locations[0].googleLocationId

  const replayUnderB = await approve(tokenB, { discoverySessionId: discoverA.body.discoverySessionId, selectedGoogleLocationIds: [locationIdFromA] })
  assert(replayUnderB.statusCode === 404, `Tenant A's discovery session must be unusable under Tenant B's session, got ${replayUnderB.statusCode}`)

  assert(!(await ownsCatalog(TENANT_B)), 'Tenant B must not become activated via a replayed Tenant A discovery session')
}

// ===========================================================================
// 6: An expired discovery result cannot be used
// ===========================================================================

async function testExpiredDiscoverySessionCannotBeUsed() {
  wireSharedStores()
  await setupTenant(TENANT_B, { userId: 'usr_b', email: 'b@example.com' })
  const tokenB = await tokenFor('usr_b', 'b@example.com', TENANT_B)

  // Rewire the discovery store's backing Redis with a factory that exposes
  // its raw storage object, so the just-written record's expiresAt can be
  // rewritten into the past -- simulating a session that has aged out,
  // without depending on real Redis TTL eviction (the fake client here has
  // no TTL support at all).
  const store = {}
  setDiscoveryRedis(() => ({
    get: async (key) => store[key] ?? null,
    set: async (key, value) => { store[key] = value },
  }))
  const { discoverySessionId: expiredId } = await createDiscoverySession({
    tenantId: TENANT_B, userId: 'usr_b',
    discoveredLocations: [{ googleLocationId: 'accounts/6/locations/6', title: 'Expiring Location', address: '' }],
  })
  // Mutate the just-written record's expiresAt into the past.
  for (const key of Object.keys(store)) {
    const record = JSON.parse(store[key])
    record.expiresAt = new Date(Date.now() - 60_000).toISOString()
    store[key] = JSON.stringify(record)
  }

  const approveRes = await approve(tokenB, { discoverySessionId: expiredId, selectedGoogleLocationIds: ['accounts/6/locations/6'] })
  assert(approveRes.statusCode === 404, `an expired discovery session must be rejected, got ${approveRes.statusCode} ${JSON.stringify(approveRes.body)}`)

  assert(!(await ownsCatalog(TENANT_B)), 'the catalog must not be activated via an expired discovery session')
}

// ===========================================================================
// 7: Catalog activation does not grant account access to locations outside
//    the approved set
// ===========================================================================

async function testActivationDoesNotGrantAccessBeyondApprovedLocations() {
  wireSharedStores()
  await setupTenant(TENANT_B, { userId: 'usr_b', email: 'b@example.com' })
  const tokenB = await tokenFor('usr_b', 'b@example.com', TENANT_B)

  globalThis.fetch = mockGoogleFetch({ 'accounts/7': [{ name: 'locations/7', title: 'Approved Location' }] })
  const discoverB = await discover(tokenB)
  const approvedId = discoverB.body.locations[0].googleLocationId
  const approveRes = await approve(tokenB, { discoverySessionId: discoverB.body.discoverySessionId, selectedGoogleLocationIds: [approvedId] })
  assert(approveRes.statusCode === 200, 'sanity: activation must succeed')

  assert(await ownsCatalog(TENANT_B), 'sanity: the tenant now owns a catalog')

  // Activation flips the TENANT-level gate open -- it must never act as a
  // blanket per-account grant, and an account's own grant must never widen
  // it either. The one approved location was stamped locationId 1 (first
  // ever googleLocationId seen for this tenant) -- id 99 was never
  // approved for this tenant at all. requireLocationAccess() reads its
  // tenant-authorization snapshot off account.locationCatalogAuthz (the
  // request-bound field evaluateSession() attaches -- see auth.js), so a
  // hand-built test account needs it resolved and attached explicitly,
  // exactly like a real request would receive it.
  const authz = await resolveLocationCatalogAuthz(TENANT_B)
  const approvedNumericId = 1
  const scopedAccountAssignedToApproved = { role: 'location_manager', locationIds: [approvedNumericId], tenantId: TENANT_B, locationCatalogAuthz: authz }
  const scopedAccountAssignedToUnapproved = { role: 'location_manager', locationIds: [99], tenantId: TENANT_B, locationCatalogAuthz: authz }
  const wildcardAccount = { role: 'owner', locationIds: '*', tenantId: TENANT_B, locationCatalogAuthz: authz }

  assert(requireLocationAccess(scopedAccountAssignedToApproved, approvedNumericId),
    'a scoped account assigned to a location the tenant actually approved must reach it')
  assert(!requireLocationAccess(scopedAccountAssignedToUnapproved, 99),
    'an account\'s own grant for an id the tenant never approved must never grant access -- account grants cannot widen tenant ownership')
  assert(!requireLocationAccess(wildcardAccount, 99),
    'even a wildcard account must never reach a location outside the tenant\'s own approved catalog')
}

// ===========================================================================
// 8: LTA remains functional under the transitional compatibility mechanism
// ===========================================================================

async function testLtaRemainsFunctionalUnderTransitionalMechanism() {
  wireSharedStores()
  await setupTenant(DEFAULT_TENANT_ID, { userId: 'usr_a', email: 'a@example.com' })
  await setupTenant(TENANT_B, { userId: 'usr_b', email: 'b@example.com' })
  const tokenB = await tokenFor('usr_b', 'b@example.com', TENANT_B)

  // Activate a second, real, Redis-backed tenant alongside LTA, to prove
  // LTA's own transitional bootstrap keeps working even once the real
  // tenant_config store is genuinely in use for someone else.
  globalThis.fetch = mockGoogleFetch({ 'accounts/8': [{ name: 'locations/8', title: 'Tenant B Location' }] })
  const discoverB = await discover(tokenB)
  await approve(tokenB, { discoverySessionId: discoverB.body.discoverySessionId, selectedGoogleLocationIds: [discoverB.body.locations[0].googleLocationId] })

  // Los Tres Amigos has never been migrated into tenant_config:v1 (this
  // phase writes no production Redis) -- getTenantConfig() for it must
  // still report "no record," and the explicit LTA-only bootstrap must
  // still answer true.
  const ltaConfig = await getTenantConfig(DEFAULT_TENANT_ID)
  assert(ltaConfig === null, 'sanity: Los Tres Amigos genuinely has no tenant_config record')
  assert(await ownsCatalog(DEFAULT_TENANT_ID), 'Los Tres Amigos must remain catalog-enabled via the transitional bootstrap')

  const status = await discover(await tokenFor('usr_a', 'a@example.com', DEFAULT_TENANT_ID))
  assert(status.statusCode === 200, `Los Tres Amigos's own discover-locations call must keep working, got ${status.statusCode}`)
}

// ===========================================================================
// 9: Unknown tenants fail closed
// ===========================================================================

async function testUnknownTenantsFailClosed() {
  wireSharedStores()
  const hash = await passwordHash()
  const record = { userId: 'usr_unknown', email: 'unknown@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId: UNKNOWN_TENANT }
  setUserRedis(() => fakeUserRedis({ usr_unknown: JSON.stringify(record) }))
  const token = await tokenFor('usr_unknown', 'unknown@example.com', UNKNOWN_TENANT)

  let fetchCalled = false
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => ({}) } }

  const discoverRes = await discover(token)
  assert(discoverRes.statusCode === 503, `an unknown tenant has no credential either way, but must never reach a successful discovery, got ${discoverRes.statusCode}`)

  assert(!(await ownsCatalog(UNKNOWN_TENANT)), 'an unknown tenant must never own a location catalog')

  const config = await getTenantConfig(UNKNOWN_TENANT).catch(() => null)
  assert(config === null, 'an unknown tenant must have no tenant_config record')
}

async function main() {
  console.log('--- 1: activation without a source-code change ---')
  await run('a tenant can become catalog-enabled purely via runtime state (no registry edit)', testTenantCanBecomeCatalogEnabledWithoutSourceChange)

  console.log('\n--- 2: cross-tenant activation ---')
  await run('Tenant A cannot activate Tenant B', testTenantACannotActivateTenantB)

  console.log('\n--- 2b: discovery-session user binding ---')
  await run('a different Owner in the same tenant cannot approve another Owner\'s discovery session', testDifferentOwnerInSameTenantCannotApproveAnothersDiscoverySession)

  console.log('\n--- 3: forged tenant ids ---')
  await run('a forged tenantId in query/body/header cannot activate another tenant', testForgedTenantIdCannotActivateAnotherTenant)

  console.log('\n--- 4: undiscovered locations ---')
  await run('a client cannot approve a Google location outside the trusted discovery result', testClientCannotApproveUndiscoveredLocation)

  console.log('\n--- 5: cross-tenant discovery replay ---')
  await run('a discovery result from Tenant A cannot be replayed under Tenant B', testDiscoveryResultCannotBeReplayedAcrossTenants)

  console.log('\n--- 6: expiration ---')
  await run('an expired discovery result cannot be used', testExpiredDiscoverySessionCannotBeUsed)

  console.log('\n--- 7: activation scope ---')
  await run('catalog activation does not grant account access beyond the approved/assigned set', testActivationDoesNotGrantAccessBeyondApprovedLocations)

  console.log('\n--- 8: LTA compatibility ---')
  await run('Los Tres Amigos remains functional under the transitional compatibility mechanism', testLtaRemainsFunctionalUnderTransitionalMechanism)

  console.log('\n--- 9: unknown tenants ---')
  await run('unknown tenants fail closed', testUnknownTenantsFailClosed)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
