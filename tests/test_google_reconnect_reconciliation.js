// Multi-Tenant Phase 4I.2 -- Google Credential / Tenant Entitlement
// Reconciliation.
//
// Phase 4I.1 made approvedLocations the tenant's canonical, self-service-
// immutable-once-committed entitlement. This phase closes the remaining
// gap: "OAuth succeeded" must never be silently treated as "this Google
// account is authorized to service this tenant." A COMMITTED tenant's
// reconnect must prove the NEW credential can still see every
// already-approved location BEFORE that credential is ever persisted --
// and if it cannot, the tenant's PREVIOUS working credential must remain
// untouched, exactly as if the reconnect attempt had never happened.
//
// This file drives dashboard/api/google/[action].js's real callback()
// handler end to end (mocked Google fetch, fake Redis-backed stores, no
// real network, no real Upstash, no production data) -- it does not unit
// test tenantLocationReconciliation.js's pure function in isolation (that
// is test_tenant_entitlement_boundary.js's job); this file proves the
// FULL OAuth callback wires that primitive correctly, fails closed, holds
// candidate credentials only transiently, and cannot be raced or spoofed.
//
// Run directly: node tests/test_google_reconnect_reconciliation.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import bcrypt from 'bcryptjs'
import googleHandler from '../dashboard/api/google/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { signOAuthState } from '../dashboard/api/google/_lib/oauthState.js'
import { requireLocationAccess, isWildcardGrant } from '../dashboard/api/_lib/auth.js'
import {
  resolveLocationCatalogAuthz, tenantOwnsLocationCatalog, tenantOwnsLocation,
  _resetLocationCatalogRegistryForTests,
} from '../dashboard/api/_lib/tenants.js'
import {
  recordLocationApproval, getTenantConfig, upsertTenantConfig, markTenantProvisioned,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import {
  getStoredCredential, setStoredCredential,
  _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis,
} from '../dashboard/api/_lib/credentialStore.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'
import { listAuditEntries, _setRedisClientForTests as setAuditRedis, _resetRedisClientForTests as resetAuditRedis } from '../dashboard/api/_lib/auditLog.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GOOGLE_ACTION_SRC = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', 'google', '[action].js'), 'utf-8')

const STATE_COOKIE = 'gbp_oauth_state'
const TENANT_A = 't_synthetic-reconnect-tenant-a'
const TENANT_B = 't_synthetic-reconnect-tenant-b'

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
    lrange: async (key, start, end) => {
      const l = Array.isArray(store[key]) ? store[key] : []
      return end === -1 ? l.slice(start) : l.slice(start, end + 1)
    },
    lpush: async (key, val) => { store[key] = [val, ...(Array.isArray(store[key]) ? store[key] : [])]; return store[key].length },
    ltrim: async () => 'OK',
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.send = (str) => { res.body = str; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value; return res }
  res.getHeader = (name) => res.headers[name]
  return res
}

// IMPORTANT: each client must be constructed ONCE and the factory must
// return that SAME instance every time -- a factory that constructs a new
// store inline would silently hand back an empty store on every read,
// discarding whatever a prior write (e.g. a second setupOwner() call for a
// different tenant in the same test) wrote. sharedUserClient is kept at
// module scope so setupOwner() (possibly called more than once per test,
// once per tenant) always writes into the SAME hash the current test's
// wireSharedStores() call wired up.
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

async function setupOwner(tenantId, userId = 'usr_owner') {
  const hash = await passwordHash()
  const record = { userId, email: `${userId}@example.com`, passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId }
  await sharedUserClient.hset('users:v1', { [userId]: JSON.stringify(record) })
}

// Approves, provisions, and activates tenantId with exactly the given
// googleLocationId strings -- the exact three-step sequence Phase 4G/4H.1
// established (recordLocationApproval -> markTenantProvisioned ->
// status: 'active'), matching every other tenant test file's convention.
async function commitTenant(tenantId, googleLocationIds) {
  await recordLocationApproval(tenantId, googleLocationIds.map((id, i) => ({ googleLocationId: id, title: `Location ${i + 1}`, address: '' })))
  const approvedConfig = await getTenantConfig(tenantId)
  await markTenantProvisioned(tenantId, {
    reviewDbBlobKey: `tenant-data/${tenantId}/reviews.db`,
    privateDataPrefix: `tenant-data/${tenantId}/private-data/`,
    provisionedLocationIds: approvedConfig.approvedLocations.map(l => l.locationId),
  })
  await upsertTenantConfig(tenantId, { status: 'active' })
  return getTenantConfig(tenantId)
}

// Mocks Google's OAuth token endpoint + accounts.list + locations.list.
// `locationsByAccountName` maps a fake Google account resource name to the
// raw location objects that account exposes. Handles both the plain
// (fetchWithRetry, no query string) accounts call callback() makes for
// connectedAccountName AND gbpGetAllPages's paginated (?pageSize=...) calls
// callback()'s new reconciliation step makes -- both hit the same
// mybusinessaccountmanagement.googleapis.com/v1/accounts URL family.
function mockGoogleFetch(locationsByAccountName, { refreshToken = 'fake-refresh-token' } = {}) {
  return async (url) => {
    const u = String(url)
    if (u.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'fake-access-token', refresh_token: refreshToken, expires_in: 3600 }) }
    }
    if (u.includes('mybusinessaccountmanagement.googleapis.com') && u.includes('/accounts')) {
      return { ok: true, status: 200, json: async () => ({ accounts: Object.keys(locationsByAccountName).map(name => ({ name, accountName: name })) }) }
    }
    const acctMatch = Object.keys(locationsByAccountName).find(name => u.includes(`${name}/locations`))
    if (acctMatch) {
      return { ok: true, status: 200, json: async () => ({ locations: locationsByAccountName[acctMatch] }) }
    }
    throw new Error(`unexpected fetch in test: ${u}`)
  }
}

async function connectViaCallback(tenantId, userId = 'usr_owner') {
  const token = await signSession({ userId, email: `${userId}@example.com`, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
  const state = await signOAuthState({ nonce: `nonce-${Math.random()}`, tenantId, userId })
  const req = {
    method: 'GET',
    query: { code: 'fake-auth-code', state },
    body: {},
    headers: { cookie: `${SESSION_COOKIE}=${token}; ${STATE_COOKIE}=${state}` },
  }
  const res = fakeRes()
  await googleHandler({ ...req, query: { ...req.query, action: 'callback' } }, res)
  return res
}

// ===========================================================================
// 1-4. Accept / reject reconciliation outcomes
// ===========================================================================

async function testCandidateSeeingExactlyApprovedIsAccepted() {
  wireSharedStores()
  await setupOwner(TENANT_A)
  await commitTenant(TENANT_A, ['accounts/1/locations/A', 'accounts/1/locations/B', 'accounts/1/locations/C'])
  await setStoredCredential(TENANT_A, { refreshToken: 'old-token', connectedAccountName: 'Old Account' })

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [
    { name: 'locations/A', title: 'A' }, { name: 'locations/B', title: 'B' }, { name: 'locations/C', title: 'C' },
  ] }, { refreshToken: 'new-token-abc' })

  const res = await connectViaCallback(TENANT_A)
  assert(res.statusCode === null || res.statusCode === 200, `expected the success page, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  const stored = await getStoredCredential(TENANT_A)
  assert(stored.refreshToken === 'new-token-abc', 'a credential that sees exactly the approved set must be accepted')
}

async function testCandidateSeeingApprovedPlusExtraIsAcceptedButExtraNeverApproved() {
  wireSharedStores()
  await setupOwner(TENANT_A)
  const before = await commitTenant(TENANT_A, ['accounts/1/locations/A', 'accounts/1/locations/B', 'accounts/1/locations/C'])
  await setStoredCredential(TENANT_A, { refreshToken: 'old-token', connectedAccountName: 'Old Account' })

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [
    { name: 'locations/A', title: 'A' }, { name: 'locations/B', title: 'B' }, { name: 'locations/C', title: 'C' },
    { name: 'locations/D', title: 'D' }, { name: 'locations/E', title: 'E' },
  ] }, { refreshToken: 'new-token-with-extras' })

  const res = await connectViaCallback(TENANT_A)
  assert(res.statusCode === null || res.statusCode === 200, `expected the success page, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  const stored = await getStoredCredential(TENANT_A)
  assert(stored.refreshToken === 'new-token-with-extras', 'a credential that sees the approved set PLUS extras must still be accepted')

  const after = await getTenantConfig(TENANT_A)
  assert(after.approvedLocations.length === 3, `extra Google-visible locations must never become approved -- expected 3 approved locations, got ${after.approvedLocations.length}`)
  const googleIds = after.approvedLocations.map(l => l.googleLocationId).sort()
  assert(JSON.stringify(googleIds) === JSON.stringify(before.approvedLocations.map(l => l.googleLocationId).sort()),
    'the approved set itself must be byte-identical before and after a reconnect that merely happens to see more')
}

async function testCandidateMissingApprovedLocationIsRejected() {
  wireSharedStores()
  await setupOwner(TENANT_A)
  await commitTenant(TENANT_A, ['accounts/1/locations/A', 'accounts/1/locations/B', 'accounts/1/locations/C'])
  await setStoredCredential(TENANT_A, { refreshToken: 'old-token', connectedAccountName: 'Old Account' })

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A', title: 'A' }, { name: 'locations/B', title: 'B' }] })

  const res = await connectViaCallback(TENANT_A)
  assert(res.statusCode === 409, `a credential missing an approved location must be rejected, got ${res.statusCode}`)
  const stored = await getStoredCredential(TENANT_A)
  assert(stored.refreshToken === 'old-token', 'the previous working credential must be preserved when reconciliation fails')
}

async function testCandidateCompletelyUnrelatedIsRejected() {
  wireSharedStores()
  await setupOwner(TENANT_A)
  await commitTenant(TENANT_A, ['accounts/1/locations/A', 'accounts/1/locations/B', 'accounts/1/locations/C'])
  await setStoredCredential(TENANT_A, { refreshToken: 'old-token', connectedAccountName: 'Old Account' })

  globalThis.fetch = mockGoogleFetch({ 'accounts/9': [{ name: 'locations/X', title: 'X' }, { name: 'locations/Y', title: 'Y' }, { name: 'locations/Z', title: 'Z' }] })

  const res = await connectViaCallback(TENANT_A)
  assert(res.statusCode === 409, `a completely unrelated Google account must be rejected, got ${res.statusCode}`)
  const stored = await getStoredCredential(TENANT_A)
  assert(stored.refreshToken === 'old-token', 'the previous working credential must be preserved when the candidate is wholly unrelated')
}

// ===========================================================================
// 5-6. Failed reconciliation preserves credential AND leaves approvedLocations untouched
// ===========================================================================

async function testFailedReconciliationMutatesNeitherCredentialNorApprovedLocations() {
  wireSharedStores()
  await setupOwner(TENANT_A)
  const before = await commitTenant(TENANT_A, ['accounts/1/locations/A', 'accounts/1/locations/B', 'accounts/1/locations/C'])
  await setStoredCredential(TENANT_A, { refreshToken: 'old-token', connectedAccountName: 'Old Account' })

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A', title: 'A' }] }) // missing B and C

  const res = await connectViaCallback(TENANT_A)
  assert(res.statusCode === 409, `expected rejection, got ${res.statusCode}`)

  const stored = await getStoredCredential(TENANT_A)
  assert(stored.refreshToken === 'old-token' && stored.connectedAccountName === 'Old Account', 'credential record must be byte-identical after a rejected reconnect')

  const after = await getTenantConfig(TENANT_A)
  assert(JSON.stringify(after.approvedLocations) === JSON.stringify(before.approvedLocations), 'approvedLocations must be byte-identical after a rejected reconnect')
  assert(after.configVersion === before.configVersion, `a rejected reconnect must not write tenant_config at all -- configVersion changed from ${before.configVersion} to ${after.configVersion}`)
}

// ===========================================================================
// 7. Successful reconnect does not mutate stable locationIdMap
// ===========================================================================

async function testSuccessfulReconnectDoesNotMutateLocationIdMap() {
  wireSharedStores()
  await setupOwner(TENANT_A)
  const before = await commitTenant(TENANT_A, ['accounts/1/locations/A', 'accounts/1/locations/B', 'accounts/1/locations/C'])
  await setStoredCredential(TENANT_A, { refreshToken: 'old-token', connectedAccountName: 'Old Account' })

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [
    { name: 'locations/A', title: 'A' }, { name: 'locations/B', title: 'B' }, { name: 'locations/C', title: 'C' },
    { name: 'locations/D', title: 'D' },
  ] }, { refreshToken: 'new-token' })

  const res = await connectViaCallback(TENANT_A)
  assert(res.statusCode === null || res.statusCode === 200, `expected success, got ${res.statusCode}`)

  const after = await getTenantConfig(TENANT_A)
  assert(JSON.stringify(after.locationIdMap) === JSON.stringify(before.locationIdMap),
    'a successful reconnect must never renumber or add to the stable googleLocationId -> localLocationId map, even when the new credential sees an unapproved extra location')
  assert(after.nextLocationId === before.nextLocationId, 'nextLocationId (the map\'s own counter) must be untouched by a reconnect')
}

// ===========================================================================
// 8. Extra discovered locations do not widen wildcard authorization
// ===========================================================================

async function testExtraDiscoveredLocationsDoNotWidenWildcardAuthorization() {
  wireSharedStores()
  await setupOwner(TENANT_A)
  const config = await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  await setStoredCredential(TENANT_A, { refreshToken: 'old-token', connectedAccountName: 'Old Account' })

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A', title: 'A' }, { name: 'locations/EXTRA', title: 'Extra' }] }, { refreshToken: 'new-token' })
  const res = await connectViaCallback(TENANT_A)
  assert(res.statusCode === null || res.statusCode === 200, `expected success, got ${res.statusCode}`)

  const authz = await resolveLocationCatalogAuthz(TENANT_A)
  const wildcardAccount = { tenantId: TENANT_A, locationIds: '*', locationCatalogAuthz: authz }
  assert(isWildcardGrant(wildcardAccount), 'sanity: this is a real, tenant-owning wildcard grant')
  const approvedLocalId = config.approvedLocations[0].locationId
  assert(requireLocationAccess(wildcardAccount, approvedLocalId), 'wildcard must still reach the one genuinely approved location')
  // "locations/EXTRA" never received a local numeric id at all (locationIdMap
  // untouched -- test 7), so there is no id for a wildcard to even resolve to;
  // the authoritative snapshot itself must only ever list the approved id.
  assert(authz.approvedLocationIds.length === 1 && authz.approvedLocationIds[0] === approvedLocalId,
    `the authorization snapshot must contain only the approved location, got ${JSON.stringify(authz.approvedLocationIds)}`)
}

// ===========================================================================
// 9. Candidate credential for Tenant A cannot install for Tenant B
// ===========================================================================

async function testTenantAReconnectNeverTouchesTenantBCredential() {
  wireSharedStores()
  await setupOwner(TENANT_A, 'usr_a')
  await setupOwner(TENANT_B, 'usr_b')
  await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  await commitTenant(TENANT_B, ['accounts/2/locations/B'])
  await setStoredCredential(TENANT_B, { refreshToken: 'tenant-b-original-token', connectedAccountName: 'Tenant B Account' })

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A', title: 'A' }] }, { refreshToken: 'tenant-a-new-token' })
  const res = await connectViaCallback(TENANT_A, 'usr_a')
  assert(res.statusCode === null || res.statusCode === 200, `sanity: Tenant A's own reconnect must succeed, got ${res.statusCode}`)

  const tenantBCredential = await getStoredCredential(TENANT_B)
  assert(tenantBCredential.refreshToken === 'tenant-b-original-token', 'Tenant A\'s reconnect must never alter Tenant B\'s stored credential')
}

// ===========================================================================
// 10. Forged tenantId in query/body/header cannot redirect reconnect
// ===========================================================================

async function testForgedTenantIdCannotRedirectReconnect() {
  wireSharedStores()
  await setupOwner(TENANT_A, 'usr_a')
  await setupOwner(TENANT_B, 'usr_b')
  await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  await commitTenant(TENANT_B, ['accounts/2/locations/B'])
  await setStoredCredential(TENANT_B, { refreshToken: 'tenant-b-original-token', connectedAccountName: 'Tenant B Account' })

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A', title: 'A' }] }, { refreshToken: 'forged-attempt-token' })

  const token = await signSession({ userId: 'usr_a', email: 'usr_a@example.com', role: 'owner', locationIds: '*', tenantId: TENANT_A, sessionVersion: 1 })
  const state = await signOAuthState({ nonce: 'forge-nonce', tenantId: TENANT_A, userId: 'usr_a' })
  const req = {
    method: 'GET',
    query: { code: 'fake-auth-code', state, tenantId: TENANT_B },
    body: { tenantId: TENANT_B },
    headers: { cookie: `${SESSION_COOKIE}=${token}; ${STATE_COOKIE}=${state}`, 'x-tenant-id': TENANT_B },
  }
  const res = fakeRes()
  await googleHandler({ ...req, query: { ...req.query, action: 'callback' } }, res)
  assert(res.statusCode === null || res.statusCode === 200, `sanity: the (unaffected) real flow must still succeed, got ${res.statusCode}`)

  const tenantACredential = await getStoredCredential(TENANT_A)
  const tenantBCredential = await getStoredCredential(TENANT_B)
  assert(tenantACredential.refreshToken === 'forged-attempt-token', 'the credential must be written under the VERIFIED (session/state-derived) tenant')
  assert(tenantBCredential.refreshToken === 'tenant-b-original-token', 'a forged tenantId in query/body/header must never redirect the write to a different tenant')
}

// ===========================================================================
// 11. Same-tenant concurrent reconnects: an older candidate cannot overwrite a newer accepted credential
// ===========================================================================

async function testStaleConcurrentReconnectCannotOverwriteNewerCredential() {
  wireSharedStores()
  await setupOwner(TENANT_A)
  await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  await setStoredCredential(TENANT_A, { refreshToken: 'original-token', connectedAccountName: 'Original' })

  let injected = false
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('oauth2.googleapis.com/token')) {
      if (!injected) {
        injected = true
        // Simulates a DIFFERENT, concurrent reconnect request completing
        // entirely while THIS request's own token exchange is in flight --
        // exactly the race the race-guard exists to catch.
        await setStoredCredential(TENANT_A, { refreshToken: 'concurrent-winner-token', connectedAccountName: 'Concurrent Winner' })
      }
      return { ok: true, status: 200, json: async () => ({ access_token: 'fake-access-token', refresh_token: 'stale-candidate-token', expires_in: 3600 }) }
    }
    if (u.includes('mybusinessaccountmanagement.googleapis.com') && u.includes('/accounts')) {
      return { ok: true, status: 200, json: async () => ({ accounts: [{ name: 'accounts/1', accountName: 'accounts/1' }] }) }
    }
    if (u.includes('accounts/1/locations')) {
      return { ok: true, status: 200, json: async () => ({ locations: [{ name: 'locations/A', title: 'A' }] }) }
    }
    throw new Error(`unexpected fetch: ${u}`)
  }

  const res = await connectViaCallback(TENANT_A)
  assert(res.statusCode === 409, `a stale reconnect (its race-guard snapshot outdated by a concurrently-completed reconnect) must be rejected, got ${res.statusCode}`)
  const stored = await getStoredCredential(TENANT_A)
  assert(stored.refreshToken === 'concurrent-winner-token', 'the concurrently-completed, newer credential must remain in effect -- a stale attempt must never clobber it')
}

// ===========================================================================
// 12. Reconnect during an unsafe lifecycle transition fails closed
// ===========================================================================

async function testReconnectBlockedDuringInitialSync() {
  wireSharedStores()
  await setupOwner(TENANT_A)
  await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  await upsertTenantConfig(TENANT_A, { status: 'initial_sync' })
  await setStoredCredential(TENANT_A, { refreshToken: 'original-token', connectedAccountName: 'Original' })

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A', title: 'A' }] })
  const res = await connectViaCallback(TENANT_A)
  assert(res.statusCode === 409, `reconnect must be blocked outright while initial_sync is in progress, got ${res.statusCode}`)
  const stored = await getStoredCredential(TENANT_A)
  assert(stored.refreshToken === 'original-token', 'the credential must remain unchanged while initial_sync is in progress')

  const { entries } = await listAuditEntries(TENANT_A, {})
  assert(entries.some(e => e.action === 'google.reconnect_blocked_lifecycle'), 'a blocked reconnect attempt must be audit-logged')
}

// ===========================================================================
// 13. Suspended tenant does not become authorization-active merely due to reconnect
// ===========================================================================

async function testSuspendedTenantReconnectDoesNotRestoreAuthorization() {
  wireSharedStores()
  await setupOwner(TENANT_A)
  await commitTenant(TENANT_A, ['accounts/1/locations/A'])
  await upsertTenantConfig(TENANT_A, { status: 'suspended' })

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A', title: 'A' }] }, { refreshToken: 'fresh-token-while-suspended' })
  const res = await connectViaCallback(TENANT_A)
  // A suspended tenant's reconnect is still reconciled (this credential DOES
  // see every approved location) and the credential swap itself is allowed
  // to succeed -- but that must never, by itself, reactivate the tenant.
  assert(res.statusCode === null || res.statusCode === 200, `sanity: a reconciled reconnect while suspended is allowed to succeed as a pure credential update, got ${res.statusCode}`)

  const config = await getTenantConfig(TENANT_A)
  assert(config.status === 'suspended', 'reconnecting must never itself change tenant status away from suspended')

  const authz = await resolveLocationCatalogAuthz(TENANT_A)
  assert(!tenantOwnsLocationCatalog(TENANT_A, authz), 'a suspended tenant must remain authorization-denied regardless of a successful Google reconnect')
  assert(!tenantOwnsLocation(TENANT_A, config.approvedLocations[0].locationId, authz), 'no individual approved location may be accessed while suspended, reconnect notwithstanding')
}

// ===========================================================================
// Structural regression -- Phase 4I.2 additions
// ===========================================================================

async function testCallbackNeverWritesApprovedLocationsOrLocationIdMap() {
  const match = /async function callback[\s\S]*?\n}\n/.exec(GOOGLE_ACTION_SRC)
  assert(match, 'sanity: could not locate the OAuth callback handler -- update this test\'s scan if the function was renamed')
  const body = match[0]
  assert(!/recordLocationApproval\(/.test(body), 'callback() must never call recordLocationApproval()')
  assert(!/approvedLocations\s*:/.test(body), 'callback() must never assign approvedLocations directly via upsertTenantConfig() either')
  assert(!/locationIdMap\s*:/.test(body), 'callback() must never assign locationIdMap directly')
}

async function testPreCommitTenantNeverTriggersLocationDiscovery() {
  wireSharedStores()
  await setupOwner(TENANT_A)
  // No commitTenant() call -- TENANT_A has no tenant_config record at all,
  // i.e. implicitly 'onboarding' (pre-commit). Reconciliation must never
  // even attempt to discover Google locations for a pre-commit tenant --
  // any /locations call from this test would be a bug.
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'fake-access-token', refresh_token: 'onboarding-token', expires_in: 3600 }) }
    }
    if (u.includes('mybusinessaccountmanagement.googleapis.com') && u.includes('/accounts')) {
      return { ok: true, status: 200, json: async () => ({ accounts: [{ name: 'accounts/1', accountName: 'Fresh Tenant Account' }] }) }
    }
    throw new Error(`a pre-commit tenant's reconnect must never call ${u} -- there is nothing to reconcile against yet`)
  }
  const res = await connectViaCallback(TENANT_A)
  assert(res.statusCode === null || res.statusCode === 200, `expected the ordinary onboarding connect to succeed untouched, got ${res.statusCode}`)
  const stored = await getStoredCredential(TENANT_A)
  assert(stored.refreshToken === 'onboarding-token', 'a pre-commit tenant\'s connect must persist normally')
}

async function main() {
  console.log('--- Accept / reject reconciliation outcomes ---')
  await run('candidate seeing exactly the approved set is accepted', testCandidateSeeingExactlyApprovedIsAccepted)
  await run('candidate seeing approved + extra is accepted but extra never becomes approved', testCandidateSeeingApprovedPlusExtraIsAcceptedButExtraNeverApproved)
  await run('candidate missing an approved location is rejected', testCandidateMissingApprovedLocationIsRejected)
  await run('candidate completely unrelated to the tenant is rejected', testCandidateCompletelyUnrelatedIsRejected)

  console.log('\n--- Failed reconciliation leaves state untouched ---')
  await run('failed reconciliation mutates neither credential nor approvedLocations', testFailedReconciliationMutatesNeitherCredentialNorApprovedLocations)

  console.log('\n--- Stable identifiers ---')
  await run('successful reconnect does not mutate locationIdMap', testSuccessfulReconnectDoesNotMutateLocationIdMap)

  console.log('\n--- Wildcard authorization ---')
  await run('extra discovered locations do not widen wildcard authorization', testExtraDiscoveredLocationsDoNotWidenWildcardAuthorization)

  console.log('\n--- Cross-tenant isolation ---')
  await run('Tenant A\'s reconnect never touches Tenant B\'s credential', testTenantAReconnectNeverTouchesTenantBCredential)
  await run('a forged tenantId in query/body/header cannot redirect reconnect', testForgedTenantIdCannotRedirectReconnect)

  console.log('\n--- Concurrency ---')
  await run('a stale concurrent reconnect cannot overwrite a newer accepted credential', testStaleConcurrentReconnectCannotOverwriteNewerCredential)

  console.log('\n--- Lifecycle restrictions ---')
  await run('reconnect is blocked outright during initial_sync', testReconnectBlockedDuringInitialSync)
  await run('a suspended tenant\'s reconnect does not restore authorization', testSuspendedTenantReconnectDoesNotRestoreAuthorization)

  console.log('\n--- Structural regression ---')
  await run('callback() never writes approvedLocations or locationIdMap', testCallbackNeverWritesApprovedLocationsOrLocationIdMap)
  await run('a pre-commit tenant\'s reconnect never triggers location discovery', testPreCommitTenantNeverTriggersLocationDiscovery)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
