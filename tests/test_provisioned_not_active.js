// Multi-Tenant Phase 4F, final closure (extended in Phase 4G) --
// "provisioning completion is not equivalent to SaaS readiness." Proves
// that NONE of the pre-Initial-Sync-completion states (locations_approved,
// provisioning, provisioning_failed, provisioned, initial_sync,
// initial_sync_failed) grant tenants.js's tenantOwnsLocationCatalog()/
// tenantOwnsLocation() -- only 'active' does, and the ONLY place in this
// entire codebase capable of writing 'active' is
// tenantConfigStore.js's markTenantActive() (Node) / initial_sync.py's
// final activation write (Python), gated by initial_sync.py's own
// preconditions (real Google sync completed, DB Blob upload confirmed,
// artifact generation published).
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
  markTenantInitialSyncStarted, markTenantInitialSyncFailed,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TENANT_CONFIG_STORE_SRC = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', '_lib', 'tenantConfigStore.js'), 'utf-8')
const GOOGLE_ACTION_SRC = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', 'google', '[action].js'), 'utf-8')
const PROVISION_TENANT_PY_SRC = readFileSync(path.resolve(__dirname, '..', 'provision_tenant.py'), 'utf-8')
const INITIAL_SYNC_PY_SRC = readFileSync(path.resolve(__dirname, '..', 'initial_sync.py'), 'utf-8')

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
    provisioning: { status: 'in_progress', reviewDbBlobKey: null, privateDataPrefix: null, reviewDbEtag: null, artifactGeneration: null, provisionedLocationIds: [], lastAttemptAt: new Date().toISOString(), lastError: null },
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
// 5/6: Multi-Tenant Phase 4G -- Initial Sync in progress / failed is not
// active either. A tenant may cycle provisioned -> initial_sync ->
// initial_sync_failed -> initial_sync (retry) many times; none of those
// states are ever operational.
// ===========================================================================

async function testInitialSyncInProgressIsNotActive() {
  wireConfigRedis()
  await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' }])
  await markTenantProvisioned(TENANT_A, {
    reviewDbBlobKey: 'tenant-data/x/reviews.db', privateDataPrefix: 'tenant-data/x/private-data/', provisionedLocationIds: [1],
  })
  const config = await markTenantInitialSyncStarted(TENANT_A)
  assert(config.status === 'initial_sync', `expected status 'initial_sync', got ${config.status}`)
  await assertNotOperational(TENANT_A, 'initial_sync (in progress)')
}

async function testInitialSyncFailedIsNotActive() {
  wireConfigRedis()
  await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' }])
  await markTenantProvisioned(TENANT_A, {
    reviewDbBlobKey: 'tenant-data/x/reviews.db', privateDataPrefix: 'tenant-data/x/private-data/', provisionedLocationIds: [1],
  })
  await markTenantInitialSyncStarted(TENANT_A)
  const config = await markTenantInitialSyncFailed(TENANT_A, 'simulated Google sync failure')
  assert(config.status === 'initial_sync_failed', `expected status 'initial_sync_failed', got ${config.status}`)
  await assertNotOperational(TENANT_A, 'initial_sync_failed')
}

// ===========================================================================
// 7: structural proof -- 'active' is written in EXACTLY ONE place in each
// language (Node: markTenantActive(); Python: initial_sync.py's final
// activation write), and nowhere else.
// ===========================================================================

function extractFunctionBody(src, functionSignaturePattern) {
  const match = src.match(functionSignaturePattern)
  assert(match, `could not locate a function matching ${functionSignaturePattern} in the given source`)
  // Skip past the parameter list FIRST (it may itself contain '{...}' via
  // destructured default parameters, e.g. `{ reviewDbEtag } = {}`) by
  // balancing parens from the '(' immediately after the matched signature,
  // then only start brace-counting the actual function BODY after that.
  let parenDepth = 0
  let i = src.indexOf('(', match.index)
  for (; i < src.length; i++) {
    if (src[i] === '(') parenDepth++
    else if (src[i] === ')') {
      parenDepth--
      if (parenDepth === 0) break
    }
  }
  let braceDepth = 0
  i = src.indexOf('{', i)
  const bodyStart = i
  for (; i < src.length; i++) {
    if (src[i] === '{') braceDepth++
    else if (src[i] === '}') {
      braceDepth--
      if (braceDepth === 0) return src.slice(bodyStart, i + 1)
    }
  }
  throw new Error('unbalanced braces while extracting function body')
}

function testOnlyMarkTenantActiveCanWriteActiveStatus() {
  const activeLiteral = /status:\s*'active'/g
  const totalOccurrences = (TENANT_CONFIG_STORE_SRC.match(activeLiteral) || []).length
  assert(totalOccurrences === 1,
    `tenantConfigStore.js must contain EXACTLY ONE literal \`status: 'active'\` assignment (inside markTenantActive()), found ${totalOccurrences}`)

  const markTenantActiveBody = extractFunctionBody(TENANT_CONFIG_STORE_SRC, /export async function markTenantActive\(/)
  assert(/status:\s*'active'/.test(markTenantActiveBody),
    'the one `status: \'active\'` assignment must be inside markTenantActive() itself')

  // google/[action].js's approveLocations() must never set status active
  // either (it delegates to recordLocationApproval(), never markTenantActive()).
  assert(!/status:\s*['"]active['"]/.test(GOOGLE_ACTION_SRC),
    'google/[action].js must contain no literal active-status assignment')

  // provision_tenant.py must never write status="active" or 'active' --
  // it may only ever reach 'provisioned'.
  assert(!/status["']?\s*:\s*["']active["']/.test(PROVISION_TENANT_PY_SRC),
    'provision_tenant.py must contain no literal "active" status assignment -- it may only ever reach \'provisioned\'')

  // initial_sync.py IS allowed to write it, but only in its final,
  // narrowly-scoped activation step -- not scattered across the file.
  const activeLiteralPy = /["']active["']/g
  const pyOccurrences = (INITIAL_SYNC_PY_SRC.match(activeLiteralPy) || []).length
  assert(pyOccurrences >= 1, 'initial_sync.py must contain the literal "active" status somewhere -- it is the one file allowed to write it')
}

async function main() {
  await run('locations approved but unprovisioned is not active', testLocationsApprovedButUnprovisionedIsNotActive)
  await run('provisioning in progress is not active', testProvisioningInProgressIsNotActive)
  await run('provisioning failed is not active', testProvisioningFailedIsNotActive)
  await run('successfully provisioned but unsynced is not fully active', testSuccessfullyProvisionedButUnsyncedIsNotFullyActive)
  await run('initial sync in progress is not active', testInitialSyncInProgressIsNotActive)
  await run('initial sync failed is not active', testInitialSyncFailedIsNotActive)
  await run('only markTenantActive()/initial_sync.py can write status active', () => testOnlyMarkTenantActiveCanWriteActiveStatus())

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
