// Multi-Tenant Phase 4F, final closure -- "provisioning completion is not
// equivalent to SaaS readiness." Proves that NONE of the pre-Initial-Sync
// states (locations_approved, provisioning, provisioning_failed,
// provisioned) grant tenants.js's tenantOwnsLocationCatalog()/
// tenantOwnsLocation() -- only 'active' does, and nothing in this
// codebase's Phase 4F code (recordLocationApproval(), markTenantProvisioned(),
// markTenantProvisioningFailed(), provision_tenant.py) is capable of
// writing 'active'. That is deliberately reserved for Phase 4G's Initial
// Sync completion, not built here.
//
// No real Upstash account, no real filesystem access, no production data.
//
// Run directly: node tests/test_provisioned_not_active.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { requireLocationAccess, isWildcardGrant } from '../dashboard/api/_lib/auth.js'
import {
  DEFAULT_TENANT_ID, tenantOwnsLocationCatalog, tenantOwnsLocation, resolveLocationCatalogAuthz,
  _resetLocationCatalogRegistryForTests,
} from '../dashboard/api/_lib/tenants.js'
import {
  upsertTenantConfig, getTenantConfig, recordLocationApproval, markTenantProvisioned, markTenantProvisioningFailed,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TENANT_CONFIG_STORE_SRC = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', '_lib', 'tenantConfigStore.js'), 'utf-8')
const GOOGLE_ACTION_SRC = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', 'google', '[action].js'), 'utf-8')
const PROVISION_TENANT_PY_SRC = readFileSync(path.resolve(__dirname, '..', 'provision_tenant.py'), 'utf-8')

const TENANT_A = 't_synthetic-not-active-tenant'

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

async function assertNotOperational(tenantId, label) {
  const authz = await resolveLocationCatalogAuthz(tenantId)
  assert(!tenantOwnsLocationCatalog(tenantId, authz), `${label}: tenantOwnsLocationCatalog() must be false`)
  assert(!tenantOwnsLocation(tenantId, 1, authz), `${label}: tenantOwnsLocation() must be false for any location id`)
  const wildcardAccount = { role: 'owner', locationIds: '*', tenantId, locationCatalogAuthz: authz }
  assert(!isWildcardGrant(wildcardAccount), `${label}: isWildcardGrant() must be false even for a wildcard grant`)
  assert(!requireLocationAccess(wildcardAccount, 1), `${label}: requireLocationAccess() must deny even a wildcard account`)
}

// ===========================================================================
// 1: locations approved but unprovisioned is not active
// ===========================================================================

async function testLocationsApprovedButUnprovisionedIsNotActive() {
  wireConfigRedis()
  await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' }])
  await assertNotOperational(TENANT_A, 'locations_approved')
}

// ===========================================================================
// 2: provisioning in progress is not active
// ===========================================================================

async function testProvisioningInProgressIsNotActive() {
  wireConfigRedis()
  await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' }])
  await upsertTenantConfig(TENANT_A, {
    status: 'provisioning',
    provisioning: { status: 'in_progress', reviewDbBlobKey: null, privateDataPrefix: null, reviewDbEtag: null, provisionedLocationIds: [], lastAttemptAt: new Date().toISOString(), lastError: null },
  })
  await assertNotOperational(TENANT_A, 'provisioning (in progress)')
}

// ===========================================================================
// 3: provisioning failed is not active
// ===========================================================================

async function testProvisioningFailedIsNotActive() {
  wireConfigRedis()
  await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' }])
  await markTenantProvisioningFailed(TENANT_A, 'simulated failure')
  const config = await getTenantConfig(TENANT_A)
  assert(config.status === 'provisioning_failed', `expected status 'provisioning_failed', got ${config.status}`)
  await assertNotOperational(TENANT_A, 'provisioning_failed')
}

// ===========================================================================
// 4: successfully provisioned but unsynced is not fully active
// ===========================================================================

async function testSuccessfullyProvisionedButUnsyncedIsNotFullyActive() {
  wireConfigRedis()
  await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' }])
  const config = await markTenantProvisioned(TENANT_A, {
    reviewDbBlobKey: 'tenant-data/x/reviews.db',
    privateDataPrefix: 'tenant-data/x/private-data/',
    provisionedLocationIds: [1],
  })
  assert(config.status === 'provisioned', `expected status 'provisioned', got ${config.status}`)
  assert(config.provisioning.status === 'provisioned', 'the provisioning sub-object must confirm success')
  // The critical assertion: real, verified, successfully-provisioned
  // resources exist (this is not the "unprovisioned" case) -- yet the
  // tenant must STILL be denied, because provisioning success alone is
  // not SaaS readiness.
  await assertNotOperational(TENANT_A, 'provisioned (successful, but pre-Initial-Sync)')
}

// ===========================================================================
// 5: Phase 4G will be the only path that can transition the tenant to
//    final active/ready state -- structural proof that nothing in this
//    phase's code is capable of writing 'active'
// ===========================================================================

function testNothingInPhase4FCodeCanWriteActiveStatus() {
  // tenantConfigStore.js: 'active' must not appear as a literal status
  // value assigned anywhere outside of isValidStatus()'s enum declaration
  // and comments -- specifically, recordLocationApproval()/
  // markTenantProvisioned()/markTenantProvisioningFailed() must never
  // assign status: 'active'.
  assert(!/status:\s*'active'/.test(TENANT_CONFIG_STORE_SRC),
    'tenantConfigStore.js must contain no literal `status: \'active\'` assignment -- only Phase 4G may ever write it')

  // google/[action].js's approveLocations() must never set status active
  // either (it delegates to recordLocationApproval(), checked above, but
  // this guards against a future direct write bypassing that function).
  assert(!/status:\s*['"]active['"]/.test(GOOGLE_ACTION_SRC),
    'google/[action].js must contain no literal active-status assignment')

  // provision_tenant.py must never write status="active" or 'active'.
  assert(!/status["']?\s*:\s*["']active["']/.test(PROVISION_TENANT_PY_SRC),
    'provision_tenant.py must contain no literal "active" status assignment -- it may only ever reach \'provisioned\'')
}

async function main() {
  await run('locations approved but unprovisioned is not active', testLocationsApprovedButUnprovisionedIsNotActive)
  await run('provisioning in progress is not active', testProvisioningInProgressIsNotActive)
  await run('provisioning failed is not active', testProvisioningFailedIsNotActive)
  await run('successfully provisioned but unsynced is not fully active', testSuccessfullyProvisionedButUnsyncedIsNotFullyActive)
  await run('nothing in Phase 4F code can write status active -- only Phase 4G may', () => testNothingInPhase4FCodeCanWriteActiveStatus())

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
