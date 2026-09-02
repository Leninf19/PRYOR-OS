// Multi-Tenant Phase 4I.1 -- Tenant Entitlements & Google Connection Lock.
//
// "Google authorization determines what a connected Google credential is
// technically capable of seeing. PRYOR tenant entitlements
// (tenantConfigStore.js's approvedLocations) determine what PRYOR is
// actually allowed to retrieve/process/store/display/sync. Connecting or
// reconnecting Google must never automatically expand a tenant's PRYOR
// access -- not even for that tenant's own Owner."
//
// This phase's audit (see the Phase 4I.1 report) found the DATA-ACCESS side
// of that boundary already correctly built: tenants.js's tenantOwnsLocation()/
// tenantOwnsLocationCatalog() are already the sole, canonical answer to
// "does this tenant's approvedLocations cover this location id," already
// gate requireLocationAccess()/isWildcardGrant() (auth.js) so a wildcard
// grant can never mean more than "every approved location in this tenant,"
// and already gate every data-plane consumer (data.js's review reads,
// actions/[action].js's replies). None of that needed to change.
//
// The one REAL gap the audit found: google/[action].js's approveLocations()
// (Owner-only) had no status guard -- an Owner could run discover-locations
// against WHATEVER Google credential is currently connected, then
// approve-locations, and tenantConfigStore.js's recordLocationApproval()
// would unconditionally REPLACE approvedLocations, at ANY point in the
// tenant's lifecycle, not just during onboarding. That is exactly "Google
// authorization silently expanding PRYOR entitlement," gated only by the
// generic 'owner' role rather than by any notion of commercial commitment.
//
// This file tests the fix (recordLocationApproval()'s new
// LOCATION_APPROVAL_ELIGIBLE_STATUSES gate + the HTTP-level 409 it produces)
// and the new, separately-scoped reconnect-reconciliation primitive
// (tenantLocationReconciliation.js) that a FUTURE reconnect flow must call
// before trusting a new credential against a tenant's EXISTING approved
// locations -- per this phase's explicit "do not build the OAuth UI, only
// the backend invariant" scope, that primitive is tested here at the
// function level only; nothing wires it into a live endpoint yet.
//
// No real Upstash, no real Google OAuth, no real Google network call, no
// production Redis/Blob -- everything below is fake stores + mocked fetch,
// matching every other tenant test file's established convention.
//
// Run directly: node tests/test_tenant_entitlement_boundary.js

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
import { requireLocationAccess, isWildcardGrant } from '../dashboard/api/_lib/auth.js'
import {
  DEFAULT_TENANT_ID, tenantOwnsLocationCatalog, tenantOwnsLocation, resolveLocationCatalogAuthz,
  _resetLocationCatalogRegistryForTests,
} from '../dashboard/api/_lib/tenants.js'
import {
  recordLocationApproval, LocationApprovalNotEligibleError, getTenantConfig, upsertTenantConfig, markTenantProvisioned,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import {
  reconcileApprovedLocationsAgainstDiscovery, UnreconciledApprovedLocationError,
} from '../dashboard/api/_lib/tenantLocationReconciliation.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'
import { setStoredCredential, _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis } from '../dashboard/api/_lib/credentialStore.js'
import { _setRedisClientForTests as setDiscoveryRedis, _resetRedisClientForTests as resetDiscoveryRedis } from '../dashboard/api/_lib/locationDiscoveryStore.js'
import { listAuditEntries, _setRedisClientForTests as setAuditRedis, _resetRedisClientForTests as resetAuditRedis } from '../dashboard/api/_lib/auditLog.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TENANT_CONFIG_STORE_SRC = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', '_lib', 'tenantConfigStore.js'), 'utf-8')
const GOOGLE_ACTION_SRC = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', 'google', '[action].js'), 'utf-8')
const CREDENTIAL_STORE_SRC = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', '_lib', 'credentialStore.js'), 'utf-8')

const TENANT_A = 't_synthetic-entitlement-tenant-a'
const TENANT_B = 't_synthetic-entitlement-tenant-b'

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
    resetUserRedis()
    resetCredentialRedis()
    resetDiscoveryRedis()
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

function fakeUserRedis(users) {
  const store = { 'users:v1': { ...users } }
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
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value; return res }
  res.getHeader = (name) => res.headers[name]
  return res
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

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

function wireSharedStores() {
  const configClient = fakeHashRedis()
  setConfigRedis(() => configClient)
  const credentialClient = fakeKeyValueRedis()
  setCredentialRedis(() => credentialClient)
  const discoveryClient = fakeKeyValueRedis()
  setDiscoveryRedis(() => discoveryClient)
  const auditClient = fakeListRedis()
  setAuditRedis(() => auditClient)
}

async function setupTenant(tenantId, { userId, email }) {
  const hash = await passwordHash()
  const record = { userId, email, passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId }
  setUserRedis(() => fakeUserRedis({ [userId]: JSON.stringify(record) }))
  await setStoredCredential(tenantId, { refreshToken: `fake-refresh-token-${tenantId}`, connectedAccountName: 'Fake Account' })
}

async function tokenFor(userId, email, tenantId) {
  return signSession({ userId, email, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
}

async function discover(token) {
  const req = { method: 'POST', query: { action: 'discover-locations' }, body: {}, headers: { cookie: `${SESSION_COOKIE}=${token}` } }
  const res = fakeRes()
  await googleHandler(req, res)
  return res
}

async function approve(token, body) {
  const req = { method: 'POST', query: { action: 'approve-locations' }, body, headers: { cookie: `${SESSION_COOKIE}=${token}` } }
  const res = fakeRes()
  await googleHandler(req, res)
  return res
}

async function approveFreshLocation(tenantId, accountName, googleLocationId) {
  await setupTenant(tenantId, { userId: `usr_${tenantId}`, email: `${tenantId}@example.com` })
  const token = await tokenFor(`usr_${tenantId}`, `${tenantId}@example.com`, tenantId)
  globalThis.fetch = mockGoogleFetch({ [accountName]: [{ name: googleLocationId, title: 'Location' }] })
  const discoverRes = await discover(token)
  assert(discoverRes.statusCode === 200, `sanity: discover must succeed, got ${discoverRes.statusCode} ${JSON.stringify(discoverRes.body)}`)
  const discoveredGoogleLocationId = discoverRes.body.locations[0].googleLocationId
  const approveRes = await approve(token, { discoverySessionId: discoverRes.body.discoverySessionId, selectedGoogleLocationIds: [discoveredGoogleLocationId] })
  assert(approveRes.statusCode === 200, `sanity: initial approval must succeed, got ${approveRes.statusCode} ${JSON.stringify(approveRes.body)}`)
  return { token, discoveredGoogleLocationId }
}

// ===========================================================================
// 1. recordLocationApproval() eligibility gate -- unit level
// ===========================================================================

async function testFreshTenantApprovalSucceeds() {
  wireSharedStores()
  const config = await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' }])
  assert(config.status === 'locations_approved', `expected 'locations_approved', got ${config.status}`)
}

async function testOnboardingStatusAllowsApproval() {
  wireSharedStores()
  await upsertTenantConfig(TENANT_A, { status: 'onboarding' })
  const config = await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' }])
  assert(config.status === 'locations_approved', `expected 'locations_approved', got ${config.status}`)
}

async function testLocationsApprovedStatusAllowsRevision() {
  wireSharedStores()
  await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' }])
  // Revising the selection BEFORE provisioning begins is still onboarding,
  // not a live entitlement change -- must remain allowed.
  const config = await recordLocationApproval(TENANT_A, [
    { googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' },
    { googleLocationId: 'accounts/1/locations/2', title: 'B', address: '' },
  ])
  assert(config.approvedLocations.length === 2, `expected 2 approved locations after revision, got ${config.approvedLocations.length}`)
}

async function assertStatusIsIneligible(status, setup) {
  wireSharedStores()
  await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' }])
  if (setup) await setup()
  await upsertTenantConfig(TENANT_A, { status })
  const before = await getTenantConfig(TENANT_A)

  let threw = null
  try {
    await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/99', title: 'Attacker-selected', address: '' }])
  } catch (e) {
    threw = e
  }
  assert(threw instanceof LocationApprovalNotEligibleError, `expected LocationApprovalNotEligibleError for status ${status}, got ${threw?.constructor?.name ?? 'no throw'}`)
  assert(threw.currentStatus === status, `error must carry the actual blocking status, got ${threw.currentStatus}`)

  const after = await getTenantConfig(TENANT_A)
  assert(after.configVersion === before.configVersion, `a rejected approval attempt must not write anything -- configVersion changed from ${before.configVersion} to ${after.configVersion}`)
  assert(JSON.stringify(after.approvedLocations) === JSON.stringify(before.approvedLocations), 'a rejected approval attempt must never change approvedLocations')
}

async function testProvisioningStatusBlocksApproval() { await assertStatusIsIneligible('provisioning') }
async function testProvisioningFailedStatusBlocksApproval() { await assertStatusIsIneligible('provisioning_failed') }
async function testProvisionedStatusBlocksApproval() { await assertStatusIsIneligible('provisioned') }
async function testInitialSyncStatusBlocksApproval() { await assertStatusIsIneligible('initial_sync') }
async function testInitialSyncFailedStatusBlocksApproval() { await assertStatusIsIneligible('initial_sync_failed') }
async function testActiveStatusBlocksApproval() { await assertStatusIsIneligible('active') }
async function testSuspendedStatusBlocksApproval() { await assertStatusIsIneligible('suspended') }

// ===========================================================================
// 2. approveLocations() HTTP surface -- the Owner-triggered path
// ===========================================================================

async function testHttpApproveLocationsRejectedOnceProvisioned() {
  wireSharedStores()
  const { token } = await approveFreshLocation(TENANT_B, 'accounts/1', 'locations/1')
  const config1 = await getTenantConfig(TENANT_B)
  await markTenantProvisioned(TENANT_B, {
    reviewDbBlobKey: `tenant-data/${TENANT_B}/reviews.db`,
    privateDataPrefix: `tenant-data/${TENANT_B}/private-data/`,
    provisionedLocationIds: config1.approvedLocations.map(l => l.locationId),
  })

  // The Owner reconnects with a DIFFERENT Google account/location and tries
  // to re-run discover+approve, exactly the unilateral-expansion path this
  // gate exists to close.
  globalThis.fetch = mockGoogleFetch({ 'accounts/9': [{ name: 'locations/9', title: 'A brand new location' }] })
  const discoverRes = await discover(token)
  assert(discoverRes.statusCode === 200, 'sanity: discovery itself is read-only and must still succeed')
  const approveRes = await approve(token, { discoverySessionId: discoverRes.body.discoverySessionId, selectedGoogleLocationIds: [discoverRes.body.locations[0].googleLocationId] })

  assert(approveRes.statusCode === 409, `expected 409 not_eligible once provisioned, got ${approveRes.statusCode} ${JSON.stringify(approveRes.body)}`)
  assert(approveRes.body.error === 'not_eligible', `expected error code 'not_eligible', got ${JSON.stringify(approveRes.body)}`)

  const configAfter = await getTenantConfig(TENANT_B)
  assert(configAfter.approvedLocations.length === 1 && configAfter.approvedLocations[0].googleLocationId === 'accounts/1/locations/1',
    'the tenant\'s approved location must remain exactly what it was before the rejected attempt')
}

async function testHttpApproveLocationsRejectedOnceActiveAndAuditLogged() {
  wireSharedStores()
  const { token } = await approveFreshLocation(TENANT_B, 'accounts/1', 'locations/1')
  await upsertTenantConfig(TENANT_B, { status: 'active' }) // simulates Phase 4G's Initial Sync completion

  globalThis.fetch = mockGoogleFetch({ 'accounts/9': [{ name: 'locations/9', title: 'A brand new location' }] })
  const discoverRes = await discover(token)
  const approveRes = await approve(token, { discoverySessionId: discoverRes.body.discoverySessionId, selectedGoogleLocationIds: [discoverRes.body.locations[0].googleLocationId] })
  assert(approveRes.statusCode === 409, `expected 409, got ${approveRes.statusCode} ${JSON.stringify(approveRes.body)}`)

  const { entries } = await listAuditEntries(TENANT_B, {})
  const denial = entries.find(e => e.action === 'location_catalog.approval_denied_not_eligible')
  assert(denial, 'a denied self-service re-approval attempt on an active tenant must be audit-logged')
  assert(denial.result === 'denied', `expected result 'denied', got ${denial.result}`)
  // Never a token, never raw Google response content -- only the fact and status.
  assert(!JSON.stringify(denial).toLowerCase().includes('fake-refresh-token'), 'audit entry must never contain credential material')
}

// ===========================================================================
// 3. reconcileApprovedLocationsAgainstDiscovery() -- reconnect invariant
// ===========================================================================

function approvedLocationsOf(googleLocationIds) {
  return googleLocationIds.map((id, i) => ({ locationId: i + 1, googleLocationId: id, title: `Loc ${i + 1}`, address: '' }))
}

async function testReconciliationPassesWhenDiscoveryCoversApproved() {
  const approved = approvedLocationsOf(['g/A', 'g/B', 'g/C'])
  // discovery ⊇ approved (A/B/C plus extras X/Y) -- must not throw, and must
  // never mutate anything (it is a pure function with no store access at all).
  reconcileApprovedLocationsAgainstDiscovery(approved, ['g/A', 'g/B', 'g/C', 'g/X', 'g/Y'])
}

async function testReconciliationIgnoresExtraDiscoveredLocations() {
  const approved = approvedLocationsOf(['g/A'])
  let threw = false
  try {
    reconcileApprovedLocationsAgainstDiscovery(approved, ['g/A', 'g/EXTRA-1', 'g/EXTRA-2'])
  } catch {
    threw = true
  }
  assert(!threw, 'extra Google-visible locations beyond the approved set must never fail reconciliation -- only missing ones may')
}

async function testReconciliationFailsClosedWhenApprovedLocationMissing() {
  const approved = approvedLocationsOf(['g/A', 'g/B', 'g/C'])
  let threw = null
  try {
    reconcileApprovedLocationsAgainstDiscovery(approved, ['g/X', 'g/Y', 'g/Z'])
  } catch (e) {
    threw = e
  }
  assert(threw instanceof UnreconciledApprovedLocationError, `expected UnreconciledApprovedLocationError, got ${threw?.constructor?.name ?? 'no throw'}`)
  assert(threw.missingGoogleLocationIds.length === 3 &&
    ['g/A', 'g/B', 'g/C'].every(id => threw.missingGoogleLocationIds.includes(id)),
    `expected all 3 approved ids reported missing, got ${JSON.stringify(threw.missingGoogleLocationIds)}`)
}

async function testReconciliationFailsClosedForPartialOverlap() {
  const approved = approvedLocationsOf(['g/A', 'g/B', 'g/C'])
  let threw = null
  try {
    reconcileApprovedLocationsAgainstDiscovery(approved, ['g/A', 'g/B']) // C missing
  } catch (e) {
    threw = e
  }
  assert(threw instanceof UnreconciledApprovedLocationError, 'a credential that can see MOST but not all approved locations must still fail closed')
  assert(JSON.stringify(threw.missingGoogleLocationIds) === JSON.stringify(['g/C']), `expected only 'g/C' reported missing, got ${JSON.stringify(threw.missingGoogleLocationIds)}`)
}

async function testReconciliationPassesForEmptyApprovedList() {
  // A brand-new, never-onboarded tenant has no approved locations yet -- an
  // empty entitlement set is trivially satisfied by any discovery result,
  // including an empty one. There is nothing to fail closed against.
  reconcileApprovedLocationsAgainstDiscovery([], [])
  reconcileApprovedLocationsAgainstDiscovery([], ['g/anything'])
}

// ===========================================================================
// 4. Structural regression -- source-scan proofs
// ===========================================================================

async function testDiscoverLocationsNeverWritesApprovedLocations() {
  const match = /async function discoverLocations[\s\S]*?\n}\n/.exec(GOOGLE_ACTION_SRC)
  assert(match, 'sanity: could not locate discoverLocations() in google/[action].js -- update this test\'s scan if the function was renamed')
  const body = match[0]
  assert(!/recordLocationApproval|upsertTenantConfig/.test(body),
    'discoverLocations() must never call recordLocationApproval()/upsertTenantConfig() -- discovery is read-only and must never itself write entitlement state')
}

async function testOAuthCallbackNeverWritesApprovedLocations() {
  const match = /async function callback[\s\S]*?\n}\n/.exec(GOOGLE_ACTION_SRC)
  assert(match, 'sanity: could not locate the OAuth callback handler in google/[action].js -- update this test\'s scan if the function was renamed')
  const body = match[0]
  // Checks for an actual CALL (`recordLocationApproval(`), not the bare
  // identifier -- Phase 4I.2 added explanatory comments inside callback()
  // that legitimately NAME recordLocationApproval() while explaining why
  // the pre-commit/committed split matters, which a bare substring check
  // would misflag.
  assert(!/recordLocationApproval\(/.test(body),
    'the OAuth connect/reconnect callback must never call recordLocationApproval() -- connecting/reconnecting Google must never itself expand or change approvedLocations')
}

async function testCredentialStoreNeverConsultsGlobalRefreshTokenEnvVar() {
  assert(!/GOOGLE_REFRESH_TOKEN/.test(CREDENTIAL_STORE_SRC),
    'credentialStore.js must never reference a global GOOGLE_REFRESH_TOKEN fallback -- that legacy fallback is Python/google_api.py-only and must never make an unconnected multi-tenant tenant appear connected on the Node side')
}

async function testRecordLocationApprovalSourceContainsEligibilityGate() {
  assert(/LOCATION_APPROVAL_ELIGIBLE_STATUSES/.test(TENANT_CONFIG_STORE_SRC),
    'recordLocationApproval() must be guarded by an explicit eligible-status allowlist, not left open to any tenant status')
  assert(/class LocationApprovalNotEligibleError/.test(TENANT_CONFIG_STORE_SRC),
    'a distinct, named error must exist so callers (and tests) can distinguish "not eligible" from a generic store failure')
}

// ===========================================================================
// 5. Cross-tenant independence of the new gate
// ===========================================================================

async function testGateOnOneTenantDoesNotAffectAnother() {
  wireSharedStores()
  await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/a/locations/1', title: 'A', address: '' }])
  await upsertTenantConfig(TENANT_A, { status: 'active' })

  // TENANT_B is untouched, fresh -- its own first approval must succeed
  // regardless of TENANT_A's lifecycle state.
  const configB = await recordLocationApproval(TENANT_B, [{ googleLocationId: 'accounts/b/locations/1', title: 'B', address: '' }])
  assert(configB.status === 'locations_approved', `TENANT_B's own approval must be unaffected by TENANT_A's status, got ${configB.status}`)

  let threwForA = false
  try {
    await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/a/locations/2', title: 'A2', address: '' }])
  } catch (e) {
    threwForA = e instanceof LocationApprovalNotEligibleError
  }
  assert(threwForA, 'TENANT_A must remain blocked independent of TENANT_B\'s state')
}

// ===========================================================================
// 6. Wildcard / tenant-owner boundary reconfirmation (already-correct
//    architecture, re-proven directly against the primitives this phase's
//    audit inspected -- not new behavior, but this phase's own explicit
//    testing requirement)
// ===========================================================================

async function testWildcardNeverExceedsTenantApprovedCatalog() {
  wireSharedStores()
  const config = await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/a/locations/1', title: 'A', address: '' }])
  await markTenantProvisioned(TENANT_A, {
    reviewDbBlobKey: `tenant-data/${TENANT_A}/reviews.db`, privateDataPrefix: `tenant-data/${TENANT_A}/private-data/`,
    provisionedLocationIds: config.approvedLocations.map(l => l.locationId),
  })
  await upsertTenantConfig(TENANT_A, { status: 'active' })

  const authz = await resolveLocationCatalogAuthz(TENANT_A)
  const wildcardAccount = { tenantId: TENANT_A, locationIds: '*', locationCatalogAuthz: authz }
  assert(isWildcardGrant(wildcardAccount), 'sanity: this account has a real, tenant-owning wildcard grant')
  assert(requireLocationAccess(wildcardAccount, config.approvedLocations[0].locationId), 'wildcard must reach the tenant\'s own approved location')
  assert(!requireLocationAccess(wildcardAccount, 999999), 'wildcard must NOT reach a location outside the tenant\'s approved catalog, no matter what a Google credential could technically see')
  assert(!tenantOwnsLocation(TENANT_A, 999999, authz), 'tenantOwnsLocation() itself must deny an unapproved id even for an otherwise-active tenant')
}

async function testTenantOwnerCannotSelfServiceExpandAnActiveTenant() {
  // Restates test 2's HTTP-level proof as a direct, one-line assertion
  // against the primitive an Owner's request ultimately reaches -- an
  // Owner-authenticated call is exactly what google/[action].js's
  // approveLocations() supplies to recordLocationApproval(); this confirms
  // the block is enforced at that layer regardless of caller.
  wireSharedStores()
  await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/a/locations/1', title: 'A', address: '' }])
  await upsertTenantConfig(TENANT_A, { status: 'active' })
  let threw = false
  try {
    await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/a/locations/2', title: 'A2', address: '' }])
  } catch (e) {
    threw = e instanceof LocationApprovalNotEligibleError
  }
  assert(threw, 'an active tenant\'s Owner must not be able to unilaterally expand approvedLocations via the self-service path')
}

async function main() {
  console.log('--- recordLocationApproval() eligibility gate ---')
  await run('fresh tenant approval succeeds', testFreshTenantApprovalSucceeds)
  await run('onboarding status allows approval', testOnboardingStatusAllowsApproval)
  await run('locations_approved status allows revision before provisioning', testLocationsApprovedStatusAllowsRevision)
  await run('provisioning status blocks approval', testProvisioningStatusBlocksApproval)
  await run('provisioning_failed status blocks approval', testProvisioningFailedStatusBlocksApproval)
  await run('provisioned status blocks approval', testProvisionedStatusBlocksApproval)
  await run('initial_sync status blocks approval', testInitialSyncStatusBlocksApproval)
  await run('initial_sync_failed status blocks approval', testInitialSyncFailedStatusBlocksApproval)
  await run('active status blocks approval', testActiveStatusBlocksApproval)
  await run('suspended status blocks approval', testSuspendedStatusBlocksApproval)

  console.log('\n--- approveLocations() HTTP surface ---')
  await run('HTTP approve-locations rejected once provisioned', testHttpApproveLocationsRejectedOnceProvisioned)
  await run('HTTP approve-locations rejected once active, and audit-logged', testHttpApproveLocationsRejectedOnceActiveAndAuditLogged)

  console.log('\n--- reconcileApprovedLocationsAgainstDiscovery() (reconnect invariant) ---')
  await run('reconciliation passes when discovery covers approved', testReconciliationPassesWhenDiscoveryCoversApproved)
  await run('reconciliation ignores extra discovered locations', testReconciliationIgnoresExtraDiscoveredLocations)
  await run('reconciliation fails closed when an approved location is missing', testReconciliationFailsClosedWhenApprovedLocationMissing)
  await run('reconciliation fails closed for partial overlap', testReconciliationFailsClosedForPartialOverlap)
  await run('reconciliation passes for an empty approved list', testReconciliationPassesForEmptyApprovedList)

  console.log('\n--- Structural regression ---')
  await run('discoverLocations() never writes approvedLocations', testDiscoverLocationsNeverWritesApprovedLocations)
  await run('OAuth callback never writes approvedLocations', testOAuthCallbackNeverWritesApprovedLocations)
  await run('credentialStore.js never consults a global refresh-token env var', testCredentialStoreNeverConsultsGlobalRefreshTokenEnvVar)
  await run('recordLocationApproval source contains the eligibility gate', testRecordLocationApprovalSourceContainsEligibilityGate)

  console.log('\n--- Cross-tenant independence ---')
  await run('the gate on one tenant does not affect another', testGateOnOneTenantDoesNotAffectAnother)

  console.log('\n--- Wildcard / Tenant Owner boundary reconfirmation ---')
  await run('wildcard never exceeds the tenant\'s approved catalog', testWildcardNeverExceedsTenantApprovedCatalog)
  await run('a Tenant Owner cannot self-service-expand an active tenant', testTenantOwnerCannotSelfServiceExpandAnActiveTenant)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
