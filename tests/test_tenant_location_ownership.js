// Multi-Tenant Phase 4E, final security closure -- tenant-level location
// ownership and tenant status/cache-failure semantics.
//
// The prior revision made `locationCatalogEnabled === true` the whole
// authorization answer -- this file exists because that is not enough:
// (1) a tenant being "activated" must never mean it owns every possible
//     numeric location id, only the ones it actually approved
//     (tenantConfigStore.js's approvedLocations, written by
//     google/[action].js's approveLocations() via a STABLE
//     googleLocationId -> localLocationId mapping);
// (2) "active" is not a single boolean -- status ('onboarding'|'active'|
//     'suspended') and locationCatalogEnabled are two independent fields on
//     the same record, and BOTH must be exactly right;
// (3) a snapshot that answered `true` on a prior resolve must never keep
//     answering `true` once the underlying record is removed, corrupted,
//     or unreadable on a later resolve.
//
// This file drives tenants.js's tenantOwnsLocation()/tenantOwnsLocationCatalog()/
// requireLocationAccess() directly against REAL tenantConfigStore.js
// records (a fake Redis, never production) -- it deliberately does not
// re-drive the full HTTP discover/approve transaction (that is
// test_tenant_location_catalog_activation.js's job); this file is the
// authorization-primitive-level proof, the same level test_permissions.js/
// test_tenant_session_authorization.js already operate at.
//
// Final review closure: there is no more process-global cache to "prime" --
// resolveLocationCatalogAuthz(tenantId) returns a fresh, independent
// snapshot on every call, and requireLocationAccess()/isWildcardGrant()
// read it off account.locationCatalogAuthz (exactly how auth.js's
// evaluateSession() attaches it to a real request's account). Hand-built
// test accounts here attach a freshly resolved snapshot explicitly, the
// same way a real request would receive one.
//
// Run directly: node tests/test_tenant_location_ownership.js

import { requireLocationAccess } from '../dashboard/api/_lib/auth.js'
import {
  DEFAULT_TENANT_ID, tenantOwnsLocationCatalog, tenantOwnsLocation, resolveLocationCatalogAuthz,
  _resetLocationCatalogRegistryForTests,
} from '../dashboard/api/_lib/tenants.js'
import {
  activateLocationCatalog, upsertTenantConfig,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'

const TENANT_A = 't_synthetic-ownership-tenant-a'
const TENANT_B = 't_synthetic-ownership-tenant-b'
const UNKNOWN_TENANT = 't_never-onboarded-ownership-tenant'
const TENANT_CONFIG_KEY = 'tenant_config:v1'

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
  }
}

function fakeHashRedis() {
  const store = {}
  const client = {
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
  }
  return client
}

function wireConfigRedis() {
  const client = fakeHashRedis()
  setConfigRedis(() => client)
  return client
}

// Activates tenantId with N synthetic Google-discovered locations. Since
// each test uses a FRESH tenant (no prior approval), tenantConfigStore.js's
// reconciliation (see activateLocationCatalog()) assigns stable ids 1..N in
// encounter order -- the same result a hand-assigned sequential scheme
// would produce for a first-ever approval, but arrived at via the real,
// persistent googleLocationId -> localLocationId mechanism, not array
// position.
async function activateWithApprovedCount(tenantId, count) {
  const selectedLocations = Array.from({ length: count }, (_, i) => ({
    googleLocationId: `accounts/${tenantId}/locations/${i + 1}`, title: `Location ${i + 1}`, address: '',
  }))
  await activateLocationCatalog(tenantId, selectedLocations)
}

async function wildcardAccount(tenantId) {
  return { role: 'owner', locationIds: '*', tenantId, locationCatalogAuthz: await resolveLocationCatalogAuthz(tenantId) }
}
async function scopedAccount(tenantId, locationIds) {
  return { role: 'location_manager', locationIds, tenantId, locationCatalogAuthz: await resolveLocationCatalogAuthz(tenantId) }
}

// ===========================================================================
// Tenant-level ownership (approvedLocations-backed)
// ===========================================================================

async function testTenantAApprovedLocationCannotBeAccessedByTenantB() {
  wireConfigRedis()
  await activateWithApprovedCount(TENANT_A, 3) // ids 1,2,3
  await activateWithApprovedCount(TENANT_B, 1) // id 1 (deliberately collides with A's id 1)

  assert(requireLocationAccess(await wildcardAccount(TENANT_A), 2), 'sanity: Tenant A must reach its own approved location 2')
  assert(!requireLocationAccess(await wildcardAccount(TENANT_B), 2), 'Tenant A\'s approved location 2 must never be reachable under a Tenant B account, even a wildcard one')
  assert(!requireLocationAccess(await wildcardAccount(TENANT_B), 3), 'Tenant A\'s approved location 3 must never be reachable under a Tenant B account')
}

async function testTenantBWildcardCannotAccessLocationAbsentFromItsOwnApprovedSet() {
  wireConfigRedis()
  await activateWithApprovedCount(TENANT_B, 1) // only id 1 is approved for B

  assert(requireLocationAccess(await wildcardAccount(TENANT_B), 1), 'sanity: Tenant B\'s wildcard account must reach its own approved location 1')
  assert(!requireLocationAccess(await wildcardAccount(TENANT_B), 999), 'a wildcard grant must never reach a location id absent from Tenant B\'s own approved set')
}

async function testTenantBExplicitGrantForUnapprovedLocationStillDenied() {
  wireConfigRedis()
  await activateWithApprovedCount(TENANT_B, 1) // only id 1 approved

  const account = await scopedAccount(TENANT_B, [999])
  assert(!requireLocationAccess(account, 999), 'an account explicitly granted a location id the tenant never approved must still be denied')
}

async function testAccountGrantsCannotWidenTenantOwnership() {
  wireConfigRedis()
  await activateWithApprovedCount(TENANT_A, 3) // A owns 1,2,3
  await activateWithApprovedCount(TENANT_B, 1) // B owns only 1

  // A Tenant B account explicitly (mis)granted location id 2 -- a REAL,
  // existing numeric id, just one that belongs to Tenant A, not Tenant B.
  const account = await scopedAccount(TENANT_B, [2])
  assert(!requireLocationAccess(account, 2), 'an account\'s own explicit grant can never widen its tenant\'s ownership to a location id that belongs to a different tenant')
}

async function testTenantApprovedLocationsDoNotWidenNonWildcardUsersGrant() {
  wireConfigRedis()
  await activateWithApprovedCount(TENANT_B, 4) // Tenant B owns 1,2,3,4

  // The account is only assigned location 1, even though its OWN tenant
  // also legitimately owns 2, 3, and 4.
  const account = await scopedAccount(TENANT_B, [1])
  assert(requireLocationAccess(account, 1), 'sanity: the account must reach its own assigned location')
  assert(!requireLocationAccess(account, 4), 'the tenant owning a location must never widen an individual non-wildcard account\'s own narrower grant')
}

async function testForgedLocationIdsFailClosed() {
  wireConfigRedis()
  await activateWithApprovedCount(TENANT_A, 1) // id 1 is real and approved
  const account = await wildcardAccount(TENANT_A)

  for (const forged of ['1', 1.5, -1, 0, NaN, null, undefined, '1 ']) {
    assert(!requireLocationAccess(account, forged), `a forged/malformed location id ${JSON.stringify(forged)} must fail closed (false), never coerced-match a real approved id`)
  }
  assert(requireLocationAccess(account, 1), 'sanity: the genuine integer id must still be granted')
}

async function testUnknownTenantFailsClosedForOwnership() {
  wireConfigRedis()
  await activateWithApprovedCount(TENANT_A, 1) // id 1 is a real approved id -- for TENANT_A, not the unknown tenant
  const unknownAuthz = await resolveLocationCatalogAuthz(UNKNOWN_TENANT)

  assert(!tenantOwnsLocation(UNKNOWN_TENANT, 1, unknownAuthz), 'an unknown/never-onboarded tenant must own no location, even one that is a real approved id for a different tenant')
  assert(!requireLocationAccess(await wildcardAccount(UNKNOWN_TENANT), 1), 'an unknown tenant\'s wildcard account must be denied regardless of the requested location id')
}

// ===========================================================================
// Tenant status authorization semantics
// ===========================================================================

async function testActiveAndEnabledIsAllowed() {
  wireConfigRedis()
  await activateWithApprovedCount(TENANT_A, 1)
  const authz = await resolveLocationCatalogAuthz(TENANT_A)
  assert(tenantOwnsLocationCatalog(TENANT_A, authz), 'status active + locationCatalogEnabled true must be allowed')
}

async function testActiveButDisabledIsDenied() {
  wireConfigRedis()
  await upsertTenantConfig(TENANT_A, { status: 'active', locationCatalogEnabled: false, approvedLocations: [{ locationId: 1, googleLocationId: 'x', title: '', address: '' }] })
  const authz = await resolveLocationCatalogAuthz(TENANT_A)
  assert(!tenantOwnsLocationCatalog(TENANT_A, authz), 'status active but locationCatalogEnabled false must be denied')
  assert(!tenantOwnsLocation(TENANT_A, 1, authz), 'a specific location must also be denied when the tenant-level gate is closed, even if it appears in approvedLocations')
}

async function testOnboardingStatusIsDenied() {
  wireConfigRedis()
  await upsertTenantConfig(TENANT_A, { status: 'onboarding', locationCatalogEnabled: true, approvedLocations: [{ locationId: 1, googleLocationId: 'x', title: '', address: '' }] })
  const authz = await resolveLocationCatalogAuthz(TENANT_A)
  assert(!tenantOwnsLocationCatalog(TENANT_A, authz), 'status onboarding must be denied even if locationCatalogEnabled is (incorrectly) true')
}

async function testSuspendedStatusIsDenied() {
  wireConfigRedis()
  await upsertTenantConfig(TENANT_A, { status: 'suspended', locationCatalogEnabled: true, approvedLocations: [{ locationId: 1, googleLocationId: 'x', title: '', address: '' }] })
  const authz = await resolveLocationCatalogAuthz(TENANT_A)
  assert(!tenantOwnsLocationCatalog(TENANT_A, authz), 'a suspended tenant must be denied even though locationCatalogEnabled is still true on the record -- suspension supersedes it')
}

async function testActiveTenantSubsequentlySuspendedIsDeniedNextRequest() {
  wireConfigRedis()
  await activateWithApprovedCount(TENANT_A, 1)
  const authzBefore = await resolveLocationCatalogAuthz(TENANT_A)
  assert(tenantOwnsLocationCatalog(TENANT_A, authzBefore), 'sanity: active immediately after activation')

  await upsertTenantConfig(TENANT_A, { status: 'suspended' })
  // Simulates the NEXT authenticated request's own fresh resolve -- a
  // brand-new snapshot object, never a mutation of authzBefore.
  const authzAfter = await resolveLocationCatalogAuthz(TENANT_A)
  assert(!tenantOwnsLocationCatalog(TENANT_A, authzAfter), 'the very next authenticated request after suspension must be denied')
  assert(tenantOwnsLocationCatalog(TENANT_A, authzBefore), 'the OLDER snapshot object itself is untouched (it simply must never be reused for a new request) -- proves snapshots are immutable, independent values, not a shared mutable slot')
}

async function testConfigRemovedAfterPriorTrueIsDeniedInRedisOnlyMode() {
  const client = wireConfigRedis()
  await activateWithApprovedCount(TENANT_A, 1)
  const authzBefore = await resolveLocationCatalogAuthz(TENANT_A)
  assert(tenantOwnsLocationCatalog(TENANT_A, authzBefore), 'sanity: active before removal')

  await client.hdel(TENANT_CONFIG_KEY, TENANT_A) // simulates the record being deleted
  const authzAfter = await resolveLocationCatalogAuthz(TENANT_A)
  assert(!tenantOwnsLocationCatalog(TENANT_A, authzAfter), 'a removed config record must deny the next resolve -- a prior `true` snapshot must never be reused in its place')
}

async function testConfigLoadFailureAfterPriorTrueNeverLeavesStaleAuthorization() {
  wireConfigRedis()
  await activateWithApprovedCount(TENANT_A, 1)
  const authzBefore = await resolveLocationCatalogAuthz(TENANT_A)
  assert(tenantOwnsLocationCatalog(TENANT_A, authzBefore), 'sanity: active before the simulated outage')

  setConfigRedis(() => ({ hget: async () => { throw new Error('simulated Redis outage') } }))
  const authzAfter = await resolveLocationCatalogAuthz(TENANT_A)
  assert(!tenantOwnsLocationCatalog(TENANT_A, authzAfter), 'a Redis/config read failure must produce a fresh denial snapshot, never fall back to reusing a prior `true` one')
}

async function testLtaBootstrapUnaffectedByStatusSemantics() {
  // Los Tres Amigos never consults tenantConfigStore.js at all (BOOTSTRAP
  // mode) -- resolveLocationCatalogAuthz() returns null for it, and
  // tenantOwnsLocationCatalog()/tenantOwnsLocation() must still answer
  // true unconditionally without ever looking at that null snapshot.
  wireConfigRedis()
  const authz = await resolveLocationCatalogAuthz(DEFAULT_TENANT_ID)
  assert(authz === null, 'sanity: BOOTSTRAP-mode tenants resolve no snapshot at all')
  assert(tenantOwnsLocationCatalog(DEFAULT_TENANT_ID, authz), 'Los Tres Amigos must remain catalog-enabled under BOOTSTRAP mode')
  assert(tenantOwnsLocation(DEFAULT_TENANT_ID, 1, authz) && tenantOwnsLocation(DEFAULT_TENANT_ID, 999999, authz),
    'Los Tres Amigos must remain unconstrained for any location id under BOOTSTRAP mode')
}

async function main() {
  console.log('--- Tenant-level location ownership ---')
  await run('Tenant A\'s approved location cannot be accessed by Tenant B', testTenantAApprovedLocationCannotBeAccessedByTenantB)
  await run('Tenant B wildcard cannot access a location absent from its own approved set', testTenantBWildcardCannotAccessLocationAbsentFromItsOwnApprovedSet)
  await run('Tenant B account explicitly granted an unapproved location is still denied', testTenantBExplicitGrantForUnapprovedLocationStillDenied)
  await run('account grants cannot widen tenant ownership', testAccountGrantsCannotWidenTenantOwnership)
  await run('tenant approved locations do not widen a non-wildcard user\'s own grant', testTenantApprovedLocationsDoNotWidenNonWildcardUsersGrant)
  await run('forged location ids fail closed', testForgedLocationIdsFailClosed)
  await run('unknown tenant fails closed for ownership', testUnknownTenantFailsClosedForOwnership)

  console.log('\n--- Tenant status authorization semantics ---')
  await run('active + enabled -> allowed', testActiveAndEnabledIsAllowed)
  await run('active + disabled -> denied', testActiveButDisabledIsDenied)
  await run('onboarding -> denied', testOnboardingStatusIsDenied)
  await run('suspended -> denied', testSuspendedStatusIsDenied)
  await run('active tenant subsequently suspended -> next request denied', testActiveTenantSubsequentlySuspendedIsDeniedNextRequest)
  await run('previously cached true + config removed -> denied (REDIS_ONLY)', testConfigRemovedAfterPriorTrueIsDeniedInRedisOnlyMode)
  await run('previously cached true + Redis/config load failure -> no stale-true authorization', testConfigLoadFailureAfterPriorTrueNeverLeavesStaleAuthorization)
  await run('Los Tres Amigos\'s BOOTSTRAP mode is unaffected by the new status/ownership machinery', testLtaBootstrapUnaffectedByStatusSemantics)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
