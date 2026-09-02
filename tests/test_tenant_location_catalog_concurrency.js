// Multi-Tenant Phase 4E, final security closure -- concurrency proof for
// the request-bound authorization architecture.
//
// An earlier revision cached tenant authorization state
// ({status, locationCatalogEnabled, approvedLocationIds}) in a
// process-global Map keyed by tenantId, "primed" once per request by
// auth.js's evaluateSession() and read synchronously afterward. That was
// REJECTED on review: "every request primes first" only guarantees a
// request sees a FRESH value at the moment it primes -- it says nothing
// about what happens between that prime and that request's own later
// read, during which OTHER concurrent requests (for the same tenant) can
// run their own async work (a rate-limit check, a credential-store read,
// anything else a real handler awaits) and overwrite the shared Map. A
// slower, chronologically OLDER request's write could land AFTER a newer
// request's write and silently resurrect stale authorization for whatever
// request reads the Map next -- even a third, unrelated one.
//
// The fix (tenants.js's resolveLocationCatalogAuthz()) returns a fresh,
// frozen, independent snapshot object on every call -- it writes to
// NOTHING shared. auth.js's evaluateSession() attaches the result directly
// onto that request's own account object, never into a structure a second
// request could read or overwrite.
//
// This file proves that architecture holds under exactly the failure
// modes described above, using a controllable/gated fake Redis client so
// interleaving order is deterministic rather than timing-dependent.
//
// Run directly: node tests/test_tenant_location_catalog_concurrency.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  DEFAULT_TENANT_ID, tenantOwnsLocationCatalog, tenantOwnsLocation, resolveLocationCatalogAuthz,
  _resetLocationCatalogRegistryForTests,
} from '../dashboard/api/_lib/tenants.js'
import {
  activateLocationCatalog, upsertTenantConfig,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TENANTS_SRC_PATH = path.resolve(__dirname, '..', 'dashboard', 'api', '_lib', 'tenants.js')

const TENANT_A = 't_synthetic-concurrency-tenant-a'
const TENANT_B = 't_synthetic-concurrency-tenant-b'

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

// A hash-shaped fake Redis whose hget() can be told to CAPTURE its value
// immediately (simulating a real read that already reached Redis) but
// DELAY its return until a gate is manually opened -- this is what lets
// this file deterministically construct "an older request's read finishes
// after a newer one's" without depending on real wall-clock timing.
function makeGatedHashRedis() {
  const store = {}
  const gates = {}
  // Tracks whether the CURRENTLY-armed gate for a field has already been
  // handed out to a caller (consumed) -- a NEW armGate() call always
  // installs a fresh gate, but a gate, once handed to a waiting hget()
  // call, must remain resolvable by openGate() (looked up by field) until
  // it is actually opened. Consumption must not delete the gate entry
  // itself, only mark it so a LATER, unrelated hget() call for the same
  // field (after this gate is opened) does not block on the same
  // already-resolved gate again.
  const consumed = new Set()
  return {
    client: {
      hget: async (key, field) => {
        const valueAtCallTime = store[key]?.[field] ?? null
        const gate = gates[field]
        if (gate && !consumed.has(field)) {
          consumed.add(field)
          await gate.promise
        }
        return valueAtCallTime
      },
      hgetall: async (key) => ({ ...(store[key] ?? {}) }),
      hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
      hdel: async (key, field) => { if (store[key]) delete store[key][field] },
    },
    // The NEXT hget() call for this field will block until openGate() is
    // called for it.
    armGate(field) {
      let resolveFn
      const promise = new Promise(r => { resolveFn = r })
      gates[field] = { promise, resolve: resolveFn }
      consumed.delete(field)
    },
    openGate(field) {
      gates[field]?.resolve()
    },
  }
}

function wireConfigRedis() {
  const client = { hget: async () => null, hgetall: async () => ({}), hset: async () => {}, hdel: async () => {} }
  const store = {}
  client.hget = async (key, field) => store[key]?.[field] ?? null
  client.hgetall = async (key) => ({ ...(store[key] ?? {}) })
  client.hset = async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } }
  client.hdel = async (key, field) => { if (store[key]) delete store[key][field] }
  setConfigRedis(() => client)
  return client
}

async function activateWithApprovedCount(tenantId, count) {
  const selectedLocations = Array.from({ length: count }, (_, i) => ({
    googleLocationId: `accounts/${tenantId}/locations/${i + 1}`, title: `Location ${i + 1}`, address: '',
  }))
  await activateLocationCatalog(tenantId, selectedLocations)
}

// ===========================================================================
// 1: An older "active" read finishing after a newer "suspended" read
//    cannot restore authorization
// ===========================================================================

async function testOlderActiveReadFinishingLateCannotRestoreAuthorization() {
  const gated = makeGatedHashRedis()
  setConfigRedis(() => gated.client)
  await activateLocationCatalog(TENANT_A, [{ googleLocationId: 'accounts/x/locations/1', title: 'X', address: '' }])

  // Arm the gate, then start the OLDER resolve -- its hget() call captures
  // today's "active" value immediately but will not RETURN until we open
  // the gate below, simulating a slow/delayed response for a read that
  // started before the suspension below.
  gated.armGate(TENANT_A)
  const olderPromise = resolveLocationCatalogAuthz(TENANT_A)

  // The tenant is suspended WHILE the older read is still in flight.
  await upsertTenantConfig(TENANT_A, { status: 'suspended' })

  // A NEWER resolve, issued and completed entirely after the suspension,
  // correctly sees it.
  const newerAuthz = await resolveLocationCatalogAuthz(TENANT_A)
  assert(!tenantOwnsLocationCatalog(TENANT_A, newerAuthz), 'a newer resolve issued after suspension must see the suspension')

  // Now let the older, stale read finish.
  gated.openGate(TENANT_A)
  const olderAuthz = await olderPromise
  assert(tenantOwnsLocationCatalog(TENANT_A, olderAuthz), 'sanity: the older snapshot itself correctly reflects what it actually read (active) -- it is not corrupted, just stale')

  // The critical assertion: the older read finishing LAST must never
  // affect anything else. A fresh resolve issued after everything above
  // has settled must still see the CURRENT real state (suspended), never
  // anything influenced by the older promise's completion timing -- there
  // is no shared Map for the older read to have clobbered.
  const afterAllAuthz = await resolveLocationCatalogAuthz(TENANT_A)
  assert(!tenantOwnsLocationCatalog(TENANT_A, afterAllAuthz), 'an older "active" read finishing after a newer "suspended" read must never restore authorization for anyone reading afterward')
}

// ===========================================================================
// 2: Request A's snapshot cannot mutate Request B's
// ===========================================================================

async function testOneSnapshotCannotMutateAnother() {
  wireConfigRedis()
  await activateWithApprovedCount(TENANT_A, 2)

  const snapshotA1 = await resolveLocationCatalogAuthz(TENANT_A)
  const snapshotA2 = await resolveLocationCatalogAuthz(TENANT_A) // a second, INDEPENDENT resolve for the same tenant
  assert(snapshotA1 !== snapshotA2, 'sanity: two resolves produce two distinct object instances, never a shared/reused one')

  let threwOnStatus = false
  try { snapshotA1.status = 'suspended' } catch { threwOnStatus = true }
  assert(threwOnStatus, 'a frozen snapshot must reject a direct mutation attempt (ESM strict mode)')
  assert(snapshotA1.status === 'active', 'the snapshot itself must remain unchanged after a rejected mutation attempt')

  let threwOnArray = false
  try { snapshotA1.approvedLocationIds.push(999) } catch { threwOnArray = true }
  assert(threwOnArray, 'the approvedLocationIds array must also be frozen -- a mutation attempt on it must be rejected')

  // The independent snapshot must be completely unaffected either way.
  assert(snapshotA2.status === 'active' && snapshotA2.approvedLocationIds.length === 2,
    'a mutation attempt (successful or rejected) on one snapshot must never be visible on an independently-resolved snapshot for the same tenant')
}

// ===========================================================================
// 3: Simultaneous Tenant A / Tenant B requests remain isolated
// ===========================================================================

async function testSimultaneousDifferentTenantRequestsRemainIsolated() {
  wireConfigRedis()
  await activateWithApprovedCount(TENANT_A, 2) // ids 1,2
  await activateWithApprovedCount(TENANT_B, 3) // ids 1,2,3

  const [authzA, authzB] = await Promise.all([
    resolveLocationCatalogAuthz(TENANT_A),
    resolveLocationCatalogAuthz(TENANT_B),
  ])

  assert(authzA.tenantId === TENANT_A && authzB.tenantId === TENANT_B, 'each concurrently-resolved snapshot must carry its own tenantId')
  assert(authzA.approvedLocationIds.length === 2 && authzB.approvedLocationIds.length === 3, 'each snapshot must reflect only its own tenant\'s approved locations')
  assert(tenantOwnsLocation(TENANT_A, 2, authzA) && !tenantOwnsLocation(TENANT_A, 3, authzA), 'Tenant A\'s own snapshot must resolve Tenant A\'s own locations correctly')
  assert(tenantOwnsLocation(TENANT_B, 3, authzB), 'Tenant B\'s own snapshot must resolve Tenant B\'s own locations correctly')

  // Cross-wiring guard: even if a caller mistakenly passed Tenant A's
  // snapshot while asking about Tenant B (or vice versa), the tenantId
  // cross-check inside tenantOwnsLocation()/tenantOwnsLocationCatalog()
  // must deny it outright.
  assert(!tenantOwnsLocation(TENANT_B, 1, authzA), 'a snapshot resolved for a different tenant must never authorize this tenant, even if passed in by mistake')
  assert(!tenantOwnsLocationCatalog(TENANT_B, authzA), 'the same cross-tenant guard must apply at the tenant-level catalog check too')
}

// ===========================================================================
// 4: A Redis failure in one request cannot make another request inherit
//    stale (or any) authorization
// ===========================================================================

async function testRedisFailureInOneRequestDoesNotAffectAnother() {
  const realClient = wireConfigRedis()
  await activateWithApprovedCount(TENANT_A, 1)
  await activateWithApprovedCount(TENANT_B, 1)

  // A client that fails ONLY for Tenant A's field, succeeding normally for
  // everything else -- simulating a partial outage affecting one tenant's
  // read while a concurrent, unrelated tenant's read succeeds.
  setConfigRedis(() => ({
    hget: async (key, field) => {
      if (field === TENANT_A) throw new Error('simulated outage for Tenant A only')
      return realClient.hget(key, field)
    },
    hgetall: realClient.hgetall,
    hset: realClient.hset,
    hdel: realClient.hdel,
  }))

  const [authzA, authzB] = await Promise.all([
    resolveLocationCatalogAuthz(TENANT_A),
    resolveLocationCatalogAuthz(TENANT_B),
  ])
  assert(!tenantOwnsLocationCatalog(TENANT_A, authzA), 'a Redis failure for Tenant A must deny Tenant A (fail closed)')
  assert(tenantOwnsLocationCatalog(TENANT_B, authzB), 'a concurrent, unrelated Tenant B resolve must succeed normally despite Tenant A\'s failure in the same moment')

  // Restore the healthy client and confirm Tenant A recovers cleanly on
  // its very next resolve -- no residual corruption from the concurrent
  // failure (there is nothing shared for it to have corrupted).
  setConfigRedis(() => realClient)
  const authzARecovered = await resolveLocationCatalogAuthz(TENANT_A)
  assert(tenantOwnsLocationCatalog(TENANT_A, authzARecovered), 'Tenant A must recover cleanly once Redis is healthy again, independent of the earlier concurrent failure')
}

// ===========================================================================
// 5: No production authorization path depends on a shared mutable Map
// ===========================================================================

function testNoProductionAuthorizationPathUsesASharedMutableMap() {
  const src = readFileSync(TENANTS_SRC_PATH, 'utf-8')
  assert(!/locationCatalogStateCache/.test(src), 'the prior process-global cache variable must be completely removed from tenants.js, not merely unused')
  assert(!/new Map\(\)/.test(src), 'tenants.js must not declare any module-level Map for authorization state')
  assert(/export async function resolveLocationCatalogAuthz\(/.test(src), 'resolveLocationCatalogAuthz() must exist as the request-bound snapshot resolver')
  assert(/export function tenantOwnsLocationCatalog\(tenantId, authz\)/.test(src), 'tenantOwnsLocationCatalog() must accept an explicit authz parameter, not read a global slot')
  assert(/export function tenantOwnsLocation\(tenantId, locationId, authz\)/.test(src), 'tenantOwnsLocation() must accept an explicit authz parameter, not read a global slot')
}

async function main() {
  await run('an older "active" read finishing after a newer "suspended" read cannot restore authorization', testOlderActiveReadFinishingLateCannotRestoreAuthorization)
  await run('Request A\'s snapshot cannot mutate Request B\'s', testOneSnapshotCannotMutateAnother)
  await run('simultaneous Tenant A / Tenant B requests remain isolated', testSimultaneousDifferentTenantRequestsRemainIsolated)
  await run('a Redis failure in one request cannot make another request inherit stale authorization', testRedisFailureInOneRequestDoesNotAffectAnother)
  await run('no production authorization path depends on a shared mutable Map', testNoProductionAuthorizationPathUsesASharedMutableMap)

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
