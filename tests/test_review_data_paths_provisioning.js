// Multi-Tenant Phase 4F -- tests for reviewDataPaths.js's
// resolveProvisionedPrivateDataRoot(), the dynamic, provisioning-backed
// counterpart to resolvePrivateDataRoot()'s static registry. No real
// Upstash account, no real filesystem access, no production data.
//
// Run directly: node tests/test_review_data_paths_provisioning.js

import {
  resolveProvisionedPrivateDataRoot,
} from '../dashboard/api/_lib/reviewDataPaths.js'
import {
  upsertTenantConfig,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'

const TENANT_A = 't_synthetic-provisioned-path-tenant'
const UNKNOWN_TENANT = 't_never-onboarded-provisioned-path-tenant'

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
  }
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

// IMPORTANT: the client must be constructed ONCE and the factory must
// return that SAME instance every time -- _setRedisClientForTests's
// factory is invoked fresh on every getClient() call, so a factory that
// constructs a new store inline would silently hand back an empty store on
// every read, discarding whatever a prior write wrote.
function wireConfigRedis() {
  const client = fakeHashRedis()
  setConfigRedis(() => client)
}

async function testProvisionedTenantResolves() {
  wireConfigRedis()
  await upsertTenantConfig(TENANT_A, {
    status: 'active',
    storageMode: 'BLOB',
    provisioning: { status: 'provisioned', reviewDbBlobKey: 'tenant-data/x/reviews.db', privateDataPrefix: 'tenant-data/x/private-data/', reviewDbEtag: 'etag-1', provisionedLocationIds: [1], lastAttemptAt: null, lastError: null },
  })
  const storage = await resolveProvisionedPrivateDataRoot(TENANT_A)
  assert(storage !== null && storage.mode === 'BLOB' && storage.privateDataPrefix === 'tenant-data/x/private-data/', `expected the provisioned BLOB storage descriptor, got ${JSON.stringify(storage)}`)
}

async function testLocationsApprovedButNotYetProvisionedReturnsNull() {
  wireConfigRedis()
  await upsertTenantConfig(TENANT_A, { status: 'locations_approved' })
  const root = await resolveProvisionedPrivateDataRoot(TENANT_A)
  assert(root === null, 'a tenant that has only approved locations, not been provisioned, must resolve to null')
}

async function testProvisioningFailedReturnsNull() {
  wireConfigRedis()
  await upsertTenantConfig(TENANT_A, {
    status: 'provisioning_failed',
    provisioning: { status: 'failed', reviewDbBlobKey: null, privateDataPrefix: null, reviewDbEtag: null, provisionedLocationIds: [], lastAttemptAt: null, lastError: 'boom' },
  })
  const root = await resolveProvisionedPrivateDataRoot(TENANT_A)
  assert(root === null, 'a failed provisioning attempt must never resolve to a path')
}

async function testSuspendedTenantReturnsNullEvenIfPreviouslyProvisioned() {
  wireConfigRedis()
  await upsertTenantConfig(TENANT_A, {
    status: 'suspended',
    storageMode: 'BLOB',
    provisioning: { status: 'provisioned', reviewDbBlobKey: 'tenant-data/x/reviews.db', privateDataPrefix: 'tenant-data/x/private-data/', reviewDbEtag: 'etag-1', provisionedLocationIds: [1], lastAttemptAt: null, lastError: null },
  })
  const root = await resolveProvisionedPrivateDataRoot(TENANT_A)
  assert(root === null, 'a suspended tenant must resolve to null even if its provisioning record is still marked provisioned')
}

async function testUnknownTenantReturnsNull() {
  wireConfigRedis()
  const root = await resolveProvisionedPrivateDataRoot(UNKNOWN_TENANT)
  assert(root === null, 'an unknown tenant (no config record at all) must resolve to null')
}

async function testStoreOutageReturnsNullNeverThrows() {
  setConfigRedis(() => ({ hget: async () => { throw new Error('simulated outage') } }))
  const root = await resolveProvisionedPrivateDataRoot(TENANT_A)
  assert(root === null, 'a tenant config store outage must fail closed to null, never throw')
}

async function main() {
  await run('a genuinely provisioned tenant resolves its private-data root', testProvisionedTenantResolves)
  await run('locations approved but not yet provisioned resolves to null', testLocationsApprovedButNotYetProvisionedReturnsNull)
  await run('a failed provisioning attempt resolves to null', testProvisioningFailedReturnsNull)
  await run('a suspended tenant resolves to null even if previously provisioned', testSuspendedTenantReturnsNullEvenIfPreviouslyProvisioned)
  await run('an unknown tenant resolves to null', testUnknownTenantReturnsNull)
  await run('a store outage fails closed to null, never throws', testStoreOutageReturnsNullNeverThrows)

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
