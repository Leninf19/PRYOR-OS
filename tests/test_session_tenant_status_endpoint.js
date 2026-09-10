// Multi-Tenant Phase 4J -- regression tests for
// GET /api/session/tenant-status (dashboard/api/session/[action].js), the
// ONE endpoint the frontend uses to answer "what lifecycle state is MY OWN
// tenant in." No real Upstash account, no real filesystem access, no
// production data.
//
// Run directly: node tests/test_session_tenant_status_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/session/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import {
  recordLocationApproval, upsertTenantConfig, markTenantProvisioned, getTenantConfig,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'

const TENANT_A = 't_synthetic-tenant-status-a'
const TENANT_B = 't_synthetic-tenant-status-b'

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
    delete process.env.ACCOUNT_DIRECTORY_JSON
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value; return res }
  return res
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
// constructs a new store inline (`() => fakeHashRedis()`) would silently
// hand back an empty store on every read, discarding whatever a prior
// write wrote.
function wireConfigRedis() {
  const client = fakeHashRedis()
  setConfigRedis(() => client)
  return client
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

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

async function setLtaDirectory() {
  const hash = await passwordHash()
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{ userId: 'usr_lta_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'LTA Owner' }],
  })
}
const ltaOwnerToken = () => signSession({ userId: 'usr_lta_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })

async function setupTenantUser(tenantId, userId) {
  const hash = await passwordHash()
  const record = { userId, email: `${userId}@example.com`, passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId }
  const client = fakeUserRedis()
  setUserRedis(() => client)
  await client.hset('users:v1', { [userId]: JSON.stringify(record) })
}
const tenantOwnerToken = (tenantId, userId) => signSession({ userId, email: `${userId}@example.com`, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })

async function invoke(tokenOrPromise) {
  const token = await tokenOrPromise
  const req = { method: 'GET', query: { action: 'tenant-status' }, headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}, socket: {} }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function commitTenant(tenantId, googleLocationIds, { status = 'active' } = {}) {
  await recordLocationApproval(tenantId, googleLocationIds.map((id, i) => ({ googleLocationId: id, title: `Location ${i + 1}`, address: `${i + 1} Main St` })))
  const config = await getTenantConfig(tenantId)
  await markTenantProvisioned(tenantId, {
    reviewDbBlobKey: `tenant-data/${tenantId}/reviews.db`,
    privateDataPrefix: `tenant-data/${tenantId}/private-data/`,
    provisionedLocationIds: config.approvedLocations.map(l => l.locationId),
  })
  await upsertTenantConfig(tenantId, { status, displayName: 'Test Restaurant Co', logoUrl: 'https://example.com/logo.png', brands: ['Test Brand'] })
}

async function testUnauthenticatedRejected() {
  wireConfigRedis()
  const res = await invoke(null)
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testLtaAlwaysReportsActiveRegardlessOfConfigStore() {
  await setLtaDirectory()
  wireConfigRedis() // no tenant_config record for LTA anywhere
  const res = await invoke(await ltaOwnerToken())
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.status === 'active', `LTA must always report status 'active', got ${res.body.status}`)
  assert(res.body.displayName === 'Los Tres Amigos', `expected LTA's exact display name preserved, got ${res.body.displayName}`)
  assert(res.body.approvedLocations === null, 'LTA must report approvedLocations: null -- it never uses the approved-locations catalog')
}

async function testFreshTenantReportsOnboarding() {
  wireConfigRedis()
  await setupTenantUser(TENANT_A, 'usr_a')
  const res = await invoke(tenantOwnerToken(TENANT_A, 'usr_a'))
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.status === 'onboarding', `a never-onboarded tenant must report status 'onboarding', got ${res.body.status}`)
  assert(Array.isArray(res.body.approvedLocations) && res.body.approvedLocations.length === 0, 'a fresh tenant must report an empty approvedLocations array, never null')
}

async function testActiveTenantReportsStatusAndBranding() {
  wireConfigRedis()
  await setupTenantUser(TENANT_A, 'usr_a')
  await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  const res = await invoke(tenantOwnerToken(TENANT_A, 'usr_a'))
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.status === 'active', `expected 'active', got ${res.body.status}`)
  assert(res.body.displayName === 'Test Restaurant Co', `expected tenant-configured display name, got ${res.body.displayName}`)
  assert(res.body.logoUrl === 'https://example.com/logo.png', 'expected tenant-configured logoUrl')
  assert(res.body.approvedLocations.length === 1 && res.body.approvedLocations[0].operational === true, 'expected one operational approved location')
  assert(res.body.approvedLocations[0].title === 'Location 1', 'expected the approved location\'s title')
  assert(!('googleLocationId' in res.body.approvedLocations[0]), 'the response must never include the raw googleLocationId')
  assert(res.body.locationIdMap === undefined, 'the response must never include locationIdMap')
}

async function testSuspendedTenantReportsSuspended() {
  wireConfigRedis()
  await setupTenantUser(TENANT_A, 'usr_a')
  await commitTenant(TENANT_A, ['accounts/1/locations/A'], { status: 'suspended' })
  const res = await invoke(tenantOwnerToken(TENANT_A, 'usr_a'))
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.status === 'suspended', `expected 'suspended', got ${res.body.status}`)
}

async function testProvisioningFailedSurfacesLastError() {
  wireConfigRedis()
  await setupTenantUser(TENANT_A, 'usr_a')
  await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/A', title: 'A', address: '' }])
  await upsertTenantConfig(TENANT_A, {
    status: 'provisioning_failed',
    provisioning: { status: 'failed', lastError: 'ProvisioningRefusedError: simulated failure', reviewDbBlobKey: null, privateDataPrefix: null, reviewDbEtag: null, artifactGeneration: null, provisionedLocationIds: [], lastAttemptAt: null },
  })
  const res = await invoke(tenantOwnerToken(TENANT_A, 'usr_a'))
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.status === 'provisioning_failed', `expected 'provisioning_failed', got ${res.body.status}`)
  assert(res.body.provisioning.lastError === 'ProvisioningRefusedError: simulated failure', 'expected the sanitized provisioning error to be surfaced')
}

async function testTenantACannotSeeTenantBStatus() {
  wireConfigRedis()
  await setupTenantUser(TENANT_A, 'usr_a')
  await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  await commitTenant(TENANT_B, ['accounts/2/locations/B'])
  await upsertTenantConfig(TENANT_B, { displayName: 'Tenant B Restaurant' })

  const res = await invoke(tenantOwnerToken(TENANT_A, 'usr_a'))
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.tenantId === TENANT_A, 'the response must be scoped to the SERVER-DERIVED tenant, never any other')
  assert(res.body.displayName !== 'Tenant B Restaurant', 'Tenant A\'s Owner must never see Tenant B\'s branding/status')
}

async function testForgedTenantIdInQueryCannotRedirectTheRead() {
  wireConfigRedis()
  await setupTenantUser(TENANT_A, 'usr_a')
  await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  await commitTenant(TENANT_B, ['accounts/2/locations/B'])
  await upsertTenantConfig(TENANT_B, { displayName: 'Tenant B Restaurant' })

  const token = await tenantOwnerToken(TENANT_A, 'usr_a')
  const req = { method: 'GET', query: { action: 'tenant-status', tenantId: TENANT_B }, body: { tenantId: TENANT_B }, headers: { cookie: `${SESSION_COOKIE}=${token}`, 'x-tenant-id': TENANT_B }, socket: {} }
  const res = fakeRes()
  await handler(req, res)
  assert(res.body.tenantId === TENANT_A, `a forged tenantId in query/body/header must never redirect the read -- got ${res.body.tenantId}`)
  assert(res.body.displayName !== 'Tenant B Restaurant', 'must never leak Tenant B\'s data via a forged tenantId')
}

async function main() {
  console.log('--- GET /api/session/tenant-status ---')
  await run('unauthenticated request is rejected', testUnauthenticatedRejected)
  await run('LTA always reports active regardless of the tenant_config store', testLtaAlwaysReportsActiveRegardlessOfConfigStore)
  await run('a fresh, never-onboarded tenant reports onboarding', testFreshTenantReportsOnboarding)
  await run('an active tenant reports its status and branding', testActiveTenantReportsStatusAndBranding)
  await run('a suspended tenant reports suspended', testSuspendedTenantReportsSuspended)
  await run('a provisioning_failed tenant surfaces its last error', testProvisioningFailedSurfacesLastError)
  await run('Tenant A cannot see Tenant B\'s status', testTenantACannotSeeTenantBStatus)
  await run('a forged tenantId in query/body/header cannot redirect the read', testForgedTenantIdInQueryCannotRedirectTheRead)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
