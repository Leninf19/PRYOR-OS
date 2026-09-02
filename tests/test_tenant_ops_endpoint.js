// Multi-Tenant Phase 4H.1 -- regression tests for
// dashboard/api/tenant-ops/[action].js (the super-admin-only, read-only
// tenant lifecycle status endpoint) and dashboard/api/_lib/auth.js's
// isSuperAdmin(). No real Upstash account, no real filesystem access, no
// production data.
//
// Run directly: node tests/test_tenant_ops_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-credential-encryption-key-at-least-32-chars'

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/tenant-ops/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import {
  upsertTenantConfig, _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import {
  setStoredCredential, _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis,
} from '../dashboard/api/_lib/credentialStore.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TENANT_OPS_SRC = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', 'tenant-ops', '[action].js'), 'utf-8')

const TENANT_B = 't_synthetic-tenant-ops-b'
const TENANT_C = 't_synthetic-tenant-ops-c'

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
    resetCredentialRedis()
    resetUserRedis()
    delete process.env.ACCOUNT_DIRECTORY_JSON
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
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

function wireCredentialRedis() {
  const store = {}
  const client = {
    get: async (key) => store[key] ?? null,
    set: async (key, value) => { store[key] = value },
  }
  setCredentialRedis(() => client)
}

// A real Tenant B account cannot live in the static ACCOUNT_DIRECTORY_JSON
// (its schema has no tenantId field at all -- static-directory accounts are
// implicitly Los Tres Amigos's own, per accountStore.js's
// resolveBootstrapTenantId() design). It lives in the Redis-backed
// userStore.js instead, keyed in the SAME bootstrap-tenant hash
// getAccountById() always looks up by userId -- the record's OWN tenantId
// field is what makes resolveTenantId() resolve it to Tenant B, not the
// hash it's stored under. Mirrors test_provisioned_tenant_api_reads.js's
// own fakeUserRedis() pattern exactly.
async function passwordHash() {
  return bcrypt.hash('x', 12)
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

async function setDirectory() {
  const hash = await passwordHash()
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_lta_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'LTA Owner' },
      { userId: 'usr_lta_admin', email: 'admin@example.com', passwordHash: hash, role: 'admin', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'LTA Admin' },
      { userId: 'usr_lta_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'LTA Marketing' },
    ],
  })
}

async function setTenantBAccount() {
  const hash = await passwordHash()
  const record = { userId: 'usr_tenantb_owner', email: 'ownerb@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId: TENANT_B }
  setUserRedis(() => fakeUserRedis({ usr_tenantb_owner: JSON.stringify(record) }))
}

const ltaOwnerToken = () => signSession({ userId: 'usr_lta_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
const ltaAdminToken = () => signSession({ userId: 'usr_lta_admin', email: 'admin@example.com', role: 'admin', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
const ltaMarketingToken = () => signSession({ userId: 'usr_lta_marketing', email: 'marketing@example.com', role: 'marketing', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
const tenantBOwnerToken = () => signSession({ userId: 'usr_tenantb_owner', email: 'ownerb@example.com', role: 'owner', locationIds: '*', tenantId: TENANT_B, sessionVersion: 1 })

async function invoke({ method = 'GET', token, query = {} } = {}) {
  const req = {
    method,
    query: { action: 'list', ...query },
    body: {},
    headers: token ? { cookie: `lta_session=${token}` } : {},
    socket: {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

// ===========================================================================
// Authorization boundary
// ===========================================================================

async function testUnauthenticatedRejected() {
  await setDirectory()
  wireConfigRedis()
  const res = await invoke({})
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testTenantOwnerFromAnotherTenantRejected() {
  // A real Tenant B's own Owner is authenticated and holds role 'owner' --
  // but they are NOT Los Tres Amigos, so isSuperAdmin() must still deny
  // them. This is the core "cross-tenant access attempt" proof: Tenant B's
  // Owner must never see the platform-wide tenant list.
  await setTenantBAccount()
  wireConfigRedis()
  const res = await invoke({ token: await tenantBOwnerToken() })
  assert(res.statusCode === 403, `expected 403 for a non-LTA owner, got ${res.statusCode}`)
}

async function testLtaAdminRejected() {
  // isSuperAdmin() requires role === 'owner' specifically -- LTA's own
  // Admin (a real, high-privilege role for everything ELSE) still must not
  // see cross-tenant provisioning/sync state.
  await setDirectory()
  wireConfigRedis()
  const res = await invoke({ token: await ltaAdminToken() })
  assert(res.statusCode === 403, `expected 403 for LTA admin (not owner), got ${res.statusCode}`)
}

async function testLtaMarketingRejected() {
  await setDirectory()
  wireConfigRedis()
  const res = await invoke({ token: await ltaMarketingToken() })
  assert(res.statusCode === 403, `expected 403 for LTA marketing, got ${res.statusCode}`)
}

async function testLtaOwnerAllowed() {
  await setDirectory()
  wireConfigRedis()
  wireCredentialRedis()
  const res = await invoke({ token: await ltaOwnerToken() })
  assert(res.statusCode === 200, `expected 200 for LTA owner, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  assert(Array.isArray(res.body.tenants), 'expected a tenants array')
}

async function testNonGetMethodRejected() {
  await setDirectory()
  wireConfigRedis()
  const res = await invoke({ method: 'POST', token: await ltaOwnerToken() })
  assert(res.statusCode === 405, `expected 405 for POST, got ${res.statusCode}`)
}

async function testNoStoreCacheHeader() {
  await setDirectory()
  wireConfigRedis()
  wireCredentialRedis()
  const res = await invoke({ token: await ltaOwnerToken() })
  assert(res.headers['Cache-Control'] === 'private, no-store', `expected private, no-store, got ${res.headers['Cache-Control']}`)
}

// ===========================================================================
// Sanitization
// ===========================================================================

async function testResponseNeverIncludesRawSensitiveFields() {
  await setDirectory()
  wireConfigRedis()
  wireCredentialRedis()
  await upsertTenantConfig(TENANT_B, {
    status: 'provisioned',
    storageMode: 'BLOB',
    approvedLocations: [{ locationId: 1, googleLocationId: 'accounts/1/locations/1', title: 'A', address: '123 Main St' }],
    locationIdMap: { 'accounts/1/locations/1': 1 },
    provisioning: { status: 'provisioned', reviewDbBlobKey: 'tenant-data/x/reviews.db', privateDataPrefix: 'tenant-data/x/private-data/', reviewDbEtag: 'etag-1', artifactGeneration: 'gen-1', provisionedLocationIds: [1], lastAttemptAt: null, lastError: null },
  })
  await setStoredCredential(TENANT_B, { refreshToken: 'super-secret-refresh-token-value', connectedAccountName: 'accounts/1' })

  const res = await invoke({ token: await ltaOwnerToken() })
  const raw = JSON.stringify(res.body)
  assert(!raw.includes('super-secret-refresh-token-value'), 'response must never include a raw refresh token')
  assert(!raw.includes('accounts/1/locations/1'), 'response must never include raw Google location resource ids')
  assert(!raw.includes('123 Main St'), 'response must never include raw location addresses')
  assert(!raw.includes('locationIdMap'), 'response must never include the raw locationIdMap')
  assert(!raw.includes('reviewDbBlobKey'), 'response must never include the raw Blob key')
  assert(!raw.includes('privateDataPrefix'), 'response must never include the raw Blob prefix')

  const tenantB = res.body.tenants.find(t => t.tenantId === TENANT_B)
  assert(tenantB, 'expected Tenant B to appear in the list')
  assert(tenantB.hasGoogleCredential === true, 'expected hasGoogleCredential to be true once a credential is stored')
  assert(tenantB.approvedLocationCount === 1, 'expected the approved-location COUNT, not the raw array')
  assert(tenantB.provisioning.artifactGeneration === 'gen-1', 'expected the artifact generation to be surfaced')
}

async function testHasGoogleCredentialFalseWhenNeverConnected() {
  await setDirectory()
  wireConfigRedis()
  wireCredentialRedis()
  await upsertTenantConfig(TENANT_C, { status: 'locations_approved', storageMode: 'BLOB' })
  const res = await invoke({ token: await ltaOwnerToken() })
  const tenantC = res.body.tenants.find(t => t.tenantId === TENANT_C)
  assert(tenantC, 'expected Tenant C to appear in the list')
  assert(tenantC.hasGoogleCredential === false, 'expected hasGoogleCredential to be false when never connected')
}

// ===========================================================================
// State eligibility
// ===========================================================================

async function eligibilityFor(status, storageMode = 'BLOB') {
  await setDirectory()
  wireConfigRedis()
  wireCredentialRedis()
  await upsertTenantConfig(TENANT_B, { status, storageMode })
  const res = await invoke({ token: await ltaOwnerToken() })
  return res.body.tenants.find(t => t.tenantId === TENANT_B).eligibility
}

async function testEligibilityMatrix() {
  const cases = [
    { status: 'onboarding', canProvision: false, canInitialSync: false },
    { status: 'locations_approved', canProvision: true, canInitialSync: false },
    { status: 'provisioning', canProvision: true, canInitialSync: false },
    { status: 'provisioning_failed', canProvision: true, canInitialSync: false },
    { status: 'provisioned', canProvision: true, canInitialSync: true },
    { status: 'initial_sync', canProvision: false, canInitialSync: false },
    { status: 'initial_sync_failed', canProvision: false, canInitialSync: true },
    { status: 'active', canProvision: true, canInitialSync: false },
    { status: 'suspended', canProvision: false, canInitialSync: false },
  ]
  for (const c of cases) {
    const eligibility = await eligibilityFor(c.status)
    assert(eligibility.canProvision === c.canProvision, `status ${c.status}: expected canProvision=${c.canProvision}, got ${eligibility.canProvision}`)
    assert(eligibility.canInitialSync === c.canInitialSync, `status ${c.status}: expected canInitialSync=${c.canInitialSync}, got ${eligibility.canInitialSync}`)
  }
}

async function testLegacyRepoTenantNeverEligible() {
  // LTA (or any hypothetical LEGACY_REPO tenant) must never show as
  // eligible for either operation, regardless of its status field --
  // provision_tenant.py/initial_sync.py both refuse non-BLOB tenants
  // unconditionally, and this page's eligibility must reflect that.
  const eligibility = await eligibilityFor('provisioned', 'LEGACY_REPO')
  assert(eligibility.canProvision === false, 'a LEGACY_REPO tenant must never show canProvision=true')
  assert(eligibility.canInitialSync === false, 'a LEGACY_REPO tenant must never show canInitialSync=true')
}

// ===========================================================================
// No duplicated provisioning/sync implementation, no direct writes to
// 'active'
// ===========================================================================

function testEndpointNeverMutatesOrDuplicatesLifecycleLogic() {
  // This file is READ-ONLY -- it must never call upsertTenantConfig()/
  // markTenantProvisioned()/markTenantActive() (Node) or shell out to
  // provision_tenant.py/initial_sync.py (Python) itself. Mutation happens
  // exclusively through the human-operated, confirmation-gated GitHub
  // Actions workflow (.github/workflows/tenant-lifecycle.yml).
  assert(!/upsertTenantConfig|markTenantProvisioned|markTenantActive|markTenantInitialSync/.test(TENANT_OPS_SRC),
    'tenant-ops/[action].js must never call a tenant_config WRITE function -- it is read-only by design')
  assert(!/status:\s*['"]active['"]/.test(TENANT_OPS_SRC),
    'tenant-ops/[action].js must contain no literal active-status assignment')
  // Checks for actual PROCESS-SPAWNING capability, not a textual mention --
  // this file's own comments legitimately name provision_tenant.py/
  // initial_sync.py to explain where mutation DOES happen instead.
  assert(!/child_process|require\(['"]child_process['"]\)|\bexec\(|\bspawn\(/.test(TENANT_OPS_SRC),
    'tenant-ops/[action].js must never shell out to provision_tenant.py/initial_sync.py -- it is read-only by design')
  // The behavioral proof that a raw credential/refreshToken never reaches
  // the response is testResponseNeverIncludesRawSensitiveFields() above --
  // a real end-to-end assertion is more reliable here than a source regex.
}

async function main() {
  await run('unauthenticated caller is rejected', testUnauthenticatedRejected)
  await run('a tenant-scoped owner from another tenant is rejected (cross-tenant access)', testTenantOwnerFromAnotherTenantRejected)
  await run('LTA admin (not owner) is rejected', testLtaAdminRejected)
  await run('LTA marketing is rejected', testLtaMarketingRejected)
  await run('LTA owner is allowed', testLtaOwnerAllowed)
  await run('non-GET method is rejected', testNonGetMethodRejected)
  await run('response sets Cache-Control: private, no-store', testNoStoreCacheHeader)
  await run('response never includes raw sensitive fields', testResponseNeverIncludesRawSensitiveFields)
  await run('hasGoogleCredential is false when never connected', testHasGoogleCredentialFalseWhenNeverConnected)
  await run('eligibility matrix matches the Python state machines', testEligibilityMatrix)
  await run('a LEGACY_REPO tenant is never shown as eligible for either operation', testLegacyRepoTenantNeverEligible)
  await run('the endpoint never mutates or duplicates provisioning/sync logic', () => testEndpointNeverMutatesOrDuplicatesLifecycleLogic())

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
