// Multi-Tenant Phase 4O -- automatic post-approval provisioning handoff.
//
// Covers what test_tenant_location_catalog_activation.js does not: the
// dispatch-outcome classification (accepted/rejected/ambiguous), the
// concurrent-approval dispatch-once guarantee, lazy reconciliation of a
// stuck/ambiguous dispatch on tenant-status reads, and the LTA exclusion
// proven through the real HTTP approve-locations path (not a unit call to
// an unexported helper). No real Upstash account, no real GitHub API call,
// no real Google network call anywhere in this file.
//
// Run directly: node tests/test_phase4o_automatic_provisioning.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'
process.env.TENANT_PROVISIONING_DISPATCH_PAT = 'fake-dispatch-pat-not-a-real-secret'

import bcrypt from 'bcryptjs'
import googleHandler from '../dashboard/api/google/[action].js'
import sessionHandler from '../dashboard/api/session/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'
import { setStoredCredential, _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis } from '../dashboard/api/_lib/credentialStore.js'
import {
  getTenantConfig, upsertTenantConfig, recordLocationApproval, reconcileStuckProvisioningDispatch,
  markTenantProvisioningDispatched, ConfigVersionConflictError,
  LocationApprovalNotEligibleError, _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setDiscoveryRedis, _resetRedisClientForTests as resetDiscoveryRedis } from '../dashboard/api/_lib/locationDiscoveryStore.js'

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
    resetUserRedis()
    resetCredentialRedis()
    resetConfigRedis()
    resetDiscoveryRedis()
    delete globalThis.fetch
    delete process.env.ACCOUNT_DIRECTORY_JSON
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
    // Faithfully emulates tenantConfigStore.js's CAS_UPSERT_SCRIPT
    // (HGET/compare-configVersion/HSET) for markTenantProvisioningDispatched()/
    // markTenantProvisioningDispatchFailed()'s CAS writes -- a synchronous JS
    // function body is trivially atomic with respect to any other code in
    // this single-threaded test process, exactly as the real Lua script is
    // atomic against Redis. Mirrors test_tenant_entitlement_change.js's own
    // fake exactly.
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [field, expectedVersionStr, nextJson] = args
      const raw = store[key]?.[field] ?? null
      let currentVersion = '0'
      if (raw) {
        try {
          const decoded = JSON.parse(raw)
          if (decoded && decoded.configVersion !== undefined) currentVersion = String(decoded.configVersion)
        } catch { /* treat as version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
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

function wireSharedStores() {
  const configClient = fakeHashRedis()
  setConfigRedis(() => configClient)
  const credentialClient = fakeKeyValueRedis()
  setCredentialRedis(() => credentialClient)
  const discoveryClient = fakeKeyValueRedis()
  setDiscoveryRedis(() => discoveryClient)
}

// Routes Google's own endpoints to mockGoogleFetch's shape, and GitHub's
// workflow_dispatch endpoint to a caller-supplied, callable response --
// so a single globalThis.fetch can serve both the discover-locations flow
// AND triggerAutomaticProvisioning()'s own dispatch call within one test.
function mockFetchRouter(locationsByAccountName, { githubDispatch, onGithubDispatch } = {}) {
  return async (url, opts) => {
    const u = String(url)
    if (u.includes('api.github.com/repos/') && u.includes('/actions/workflows/')) {
      if (onGithubDispatch) onGithubDispatch(url, opts)
      return githubDispatch(url, opts)
    }
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

async function discover(token) {
  const req = { method: 'POST', query: { action: 'discover-locations' }, headers: { cookie: `${SESSION_COOKIE}=${token}` } }
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

async function tenantStatus(token) {
  const req = { method: 'GET', query: { action: 'tenant-status' }, headers: { cookie: `${SESSION_COOKIE}=${token}` }, socket: {} }
  const res = fakeRes()
  await sessionHandler(req, res)
  return res
}

async function approveFreshLocation(tenantId, accountName, googleLocationId, fetchImpl) {
  await setupTenant(tenantId, { userId: `usr_${tenantId}`, email: `${tenantId}@example.com` })
  const token = await tokenFor(`usr_${tenantId}`, `${tenantId}@example.com`, tenantId)
  globalThis.fetch = fetchImpl ?? mockFetchRouter({ [accountName]: [{ name: googleLocationId, title: 'Location' }] }, { githubDispatch: async () => ({ status: 204 }) })
  const discoverRes = await discover(token)
  assert(discoverRes.statusCode === 200, `sanity: discover must succeed, got ${discoverRes.statusCode} ${JSON.stringify(discoverRes.body)}`)
  const discoveredGoogleLocationId = discoverRes.body.locations[0].googleLocationId
  const approveRes = await approve(token, { discoverySessionId: discoverRes.body.discoverySessionId, selectedGoogleLocationIds: [discoveredGoogleLocationId] })
  return { token, approveRes }
}

const TENANT_A = 't_phase4o-a'

// ===========================================================================
// 1. Dispatch outcome classification
// ===========================================================================

async function testAcceptedDispatchLeavesTenantInProvisioningNoError() {
  wireSharedStores()
  const { approveRes } = await approveFreshLocation(TENANT_A, 'accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, { githubDispatch: async () => ({ status: 204 }) }))
  assert(approveRes.statusCode === 200, `sanity: approval must succeed, got ${approveRes.statusCode}`)
  assert(approveRes.body.status === 'provisioning', `expected 'provisioning' after an accepted dispatch, got ${approveRes.body.status}`)

  const config = await getTenantConfig(TENANT_A)
  assert(config.status === 'provisioning', `expected 'provisioning', got ${config.status}`)
  assert(config.provisioning?.lastError == null, 'an accepted dispatch must never leave a lastError behind')
}

async function testRejected4xxDispatchMarksProvisioningDispatchFailedImmediately() {
  wireSharedStores()
  const { approveRes } = await approveFreshLocation(TENANT_A, 'accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
      githubDispatch: async () => ({ status: 422, json: async () => ({ message: 'Invalid inputs.' }) }),
    }))
  assert(approveRes.statusCode === 200, 'sanity: the approval itself must still succeed even if the dispatch is rejected')
  assert(approveRes.body.status === 'provisioning_dispatch_failed',
    `expected 'provisioning_dispatch_failed' reflected in the SAME response after a clean 4xx rejection, got ${approveRes.body.status}`)

  const config = await getTenantConfig(TENANT_A)
  assert(config.status === 'provisioning_dispatch_failed', `expected 'provisioning_dispatch_failed', got ${config.status}`)
  assert(typeof config.provisioning?.lastError === 'string' && /422/.test(config.provisioning.lastError),
    `expected lastError to record the rejection detail, got ${JSON.stringify(config.provisioning?.lastError)}`)
}

async function testAmbiguous5xxDispatchStaysInProvisioningNeverDowngraded() {
  wireSharedStores()
  const { approveRes } = await approveFreshLocation(TENANT_A, 'accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
      githubDispatch: async () => ({ status: 503 }),
    }))
  assert(approveRes.body.status === 'provisioning', `a 5xx (ambiguous) dispatch outcome must NEVER be treated as failure, got ${approveRes.body.status}`)

  const config = await getTenantConfig(TENANT_A)
  assert(config.status === 'provisioning', `expected 'provisioning' to persist, got ${config.status}`)
  assert(typeof config.provisioning?.dispatchedAt === 'string', 'the CAS claim\'s dispatchedAt must still be stamped even when the dispatch itself is ambiguous')
}

async function testAmbiguousNetworkErrorDispatchStaysInProvisioning() {
  wireSharedStores()
  const { approveRes } = await approveFreshLocation(TENANT_A, 'accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
      githubDispatch: async () => { throw new Error('socket hang up') },
    }))
  assert(approveRes.body.status === 'provisioning', `a network-level exception must be classified ambiguous, never a definite failure, got ${approveRes.body.status}`)
}

// ===========================================================================
// 2. Concurrent approval -- exactly one CAS winner, one dispatch attempt
// ===========================================================================

// A double submit/double-click of approve-locations for the SAME tenant.
// With this fake store's near-synchronous timing, the first request's
// entire chain (including the automatic dispatch) completes before the
// second request's own recordLocationApproval() read runs -- so the SECOND
// request is rejected earlier, by the pre-existing eligibility gate
// (LOCATION_APPROVAL_ELIGIBLE_STATUSES: the tenant is no longer
// 'onboarding'/'locations_approved' by the time it reads). This is a real,
// desirable defense-in-depth outcome in its own right: the naive double-
// submit case never even reaches the CAS claim. It does NOT by itself prove
// the CAS claim is correct under genuinely overlapping timing (e.g. two
// servers racing against the same already-'locations_approved' snapshot) --
// see testConcurrentDispatchClaimsResultInExactlyOneCasWinner() below for
// that direct proof.
async function testDoubleSubmitApprovalIsRejectedByTheEligibilityGateBeforeAnySecondDispatch() {
  wireSharedStores()
  await setupTenant(TENANT_A, { userId: 'usr_a', email: 'a@example.com' })
  const token = await tokenFor('usr_a', 'a@example.com', TENANT_A)

  let dispatchCallCount = 0
  globalThis.fetch = mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
    githubDispatch: async () => ({ status: 204 }),
    onGithubDispatch: () => { dispatchCallCount += 1 },
  })

  const discoverRes = await discover(token)
  const googleLocationId = discoverRes.body.locations[0].googleLocationId
  const body = { discoverySessionId: discoverRes.body.discoverySessionId, selectedGoogleLocationIds: [googleLocationId] }

  const [res1, res2] = await Promise.all([approve(token, body), approve(token, body)])
  const statuses = [res1.statusCode, res2.statusCode].sort()
  assert(statuses[0] === 200 && statuses[1] === 409, `expected exactly one 200 and one 409 (eligibility gate) across the double submit, got ${statuses.join('/')}`)
  assert(dispatchCallCount === 1, `expected exactly ONE GitHub dispatch call across both concurrent requests, got ${dispatchCallCount}`)

  const config = await getTenantConfig(TENANT_A)
  assert(config.status === 'provisioning', `expected the tenant to end up in 'provisioning', got ${config.status}`)
  assert(typeof config.provisioning?.dispatchAttemptId === 'string' && config.provisioning.dispatchAttemptId, 'exactly one dispatchAttemptId must have been stamped')
}

// The direct proof: two callers that BOTH already hold the SAME
// 'locations_approved' config snapshot (the genuinely-overlapping-timing
// case the eligibility gate does not by itself rule out on a real,
// network-latency-bearing server) attempt the CAS claim concurrently.
// Exactly one may win; the other must fail with ConfigVersionConflictError
// and, per triggerAutomaticProvisioning()'s own contract, return
// immediately without ever attempting a dispatch.
async function testConcurrentDispatchClaimsResultInExactlyOneCasWinner() {
  wireSharedStores()
  const config = await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' }])

  const [r1, r2] = await Promise.allSettled([
    markTenantProvisioningDispatched(TENANT_A, { dispatchAttemptId: 'attempt-1', expectedVersion: config.configVersion }),
    markTenantProvisioningDispatched(TENANT_A, { dispatchAttemptId: 'attempt-2', expectedVersion: config.configVersion }),
  ])

  const fulfilled = [r1, r2].filter(r => r.status === 'fulfilled')
  const rejected = [r1, r2].filter(r => r.status === 'rejected')
  assert(fulfilled.length === 1, `expected exactly one CAS winner among two concurrent claims against the same configVersion, got ${fulfilled.length}`)
  assert(rejected.length === 1 && rejected[0].reason instanceof ConfigVersionConflictError,
    `the losing claim must fail with ConfigVersionConflictError specifically (so the caller can distinguish "lost the race" from a real store failure), got ${rejected[0]?.reason?.constructor?.name}`)

  const final = await getTenantConfig(TENANT_A)
  assert(final.status === 'provisioning', `expected 'provisioning' after the single winning claim, got ${final.status}`)
  assert([fulfilled[0].value.provisioning.dispatchAttemptId].includes(final.provisioning.dispatchAttemptId),
    'the persisted dispatchAttemptId must be the WINNING claim\'s own id, never the loser\'s')
}

// ===========================================================================
// 3. LTA exclusion -- proven through the real HTTP approve-locations path
// ===========================================================================

async function testLtaNeverTriggersAutomaticDispatch() {
  wireSharedStores()
  let dispatchCallCount = 0
  const { approveRes } = await approveFreshLocation(DEFAULT_TENANT_ID, 'accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
      githubDispatch: async () => ({ status: 204 }),
      onGithubDispatch: () => { dispatchCallCount += 1 },
    }))
  assert(approveRes.statusCode === 200, `sanity: LTA's own approval must still succeed, got ${approveRes.statusCode} ${JSON.stringify(approveRes.body)}`)
  assert(dispatchCallCount === 0, 'Los Tres Amigos must NEVER trigger an automatic GitHub dispatch, under any circumstances')
  assert(approveRes.body.status !== 'provisioning' && approveRes.body.status !== 'provisioning_dispatch_failed',
    `LTA's status must never be advanced by the automatic-provisioning path, got ${approveRes.body.status}`)
}

// ===========================================================================
// 4. Lazy reconciliation of a stuck/ambiguous dispatch
// ===========================================================================

async function seedStuckProvisioning(tenantId, { dispatchedAgoMs, lastAttemptAt = null }) {
  await recordLocationApproval(tenantId, [{ googleLocationId: 'accounts/1/locations/1', title: 'A', address: '' }])
  const dispatchedAt = new Date(Date.now() - dispatchedAgoMs).toISOString()
  const config = await getTenantConfig(tenantId)
  await upsertTenantConfig(tenantId, {
    status: 'provisioning',
    provisioning: { ...(config.provisioning ?? {}), status: 'in_progress', dispatchAttemptId: 'test-attempt-id', dispatchedAt, lastAttemptAt },
  })
}

async function testReconciliationLeavesFreshDispatchAlone() {
  wireSharedStores()
  await seedStuckProvisioning(TENANT_A, { dispatchedAgoMs: 60 * 1000 }) // 1 minute ago -- well under the timeout
  const result = await reconcileStuckProvisioningDispatch(TENANT_A)
  assert(result.status === 'provisioning', `a dispatch younger than the reconciliation timeout must be left alone, got ${result.status}`)
}

async function testReconciliationLeavesProgressedDispatchAloneEvenIfOld() {
  wireSharedStores()
  // dispatchedAt is old (past the timeout), but lastAttemptAt (stamped by
  // provision_tenant.py's own first write) is AFTER it -- a real run
  // genuinely started; must never be downgraded regardless of how old
  // dispatchedAt itself is.
  const lastAttemptAt = new Date(Date.now() - 4 * 60 * 1000).toISOString()
  await seedStuckProvisioning(TENANT_A, { dispatchedAgoMs: 10 * 60 * 1000, lastAttemptAt })
  const result = await reconcileStuckProvisioningDispatch(TENANT_A)
  assert(result.status === 'provisioning', `a dispatch with observed progress must never be downgraded, got ${result.status}`)
}

async function testReconciliationMarksDispatchFailedAfterTimeoutWithNoProgress() {
  wireSharedStores()
  await seedStuckProvisioning(TENANT_A, { dispatchedAgoMs: 6 * 60 * 1000 }) // 6 minutes ago -- past the 5-minute timeout, no lastAttemptAt at all
  const result = await reconcileStuckProvisioningDispatch(TENANT_A)
  assert(result.status === 'provisioning_dispatch_failed', `expected 'provisioning_dispatch_failed' after the timeout with zero progress, got ${result.status}`)
  assert(typeof result.provisioning?.lastError === 'string' && result.provisioning.lastError.length > 0, 'reconciliation must record a human-readable lastError')
}

async function testReconciliationIsWiredIntoTheRealTenantStatusEndpoint() {
  wireSharedStores()
  await setupTenant(TENANT_A, { userId: 'usr_a', email: 'a@example.com' })
  await seedStuckProvisioning(TENANT_A, { dispatchedAgoMs: 6 * 60 * 1000 })
  const res = await tenantStatus(await tokenFor('usr_a', 'a@example.com', TENANT_A))
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.status === 'provisioning_dispatch_failed',
    `GET tenant-status must trigger lazy reconciliation itself and reflect the result, got ${res.body.status}`)
}

// ===========================================================================
// 5. Manual recovery: 'provisioning_dispatch_failed' is not self-service
//    re-approvable (recovery is the operator's pinned manual dispatcher only)
// ===========================================================================

async function testProvisioningDispatchFailedBlocksSelfServiceReapproval() {
  wireSharedStores()
  await seedStuckProvisioning(TENANT_A, { dispatchedAgoMs: 6 * 60 * 1000 })
  await reconcileStuckProvisioningDispatch(TENANT_A) // -> 'provisioning_dispatch_failed'

  let threw = null
  try {
    await recordLocationApproval(TENANT_A, [{ googleLocationId: 'accounts/1/locations/99', title: 'Attacker-selected', address: '' }])
  } catch (e) {
    threw = e
  }
  assert(threw instanceof LocationApprovalNotEligibleError,
    `'provisioning_dispatch_failed' must not be self-service re-approvable -- recovery is the operator's pinned manual dispatcher only, got ${threw?.constructor?.name ?? 'no throw'}`)
}

const tests = [
  ['acceptedDispatchLeavesTenantInProvisioningNoError', testAcceptedDispatchLeavesTenantInProvisioningNoError],
  ['rejected4xxDispatchMarksProvisioningDispatchFailedImmediately', testRejected4xxDispatchMarksProvisioningDispatchFailedImmediately],
  ['ambiguous5xxDispatchStaysInProvisioningNeverDowngraded', testAmbiguous5xxDispatchStaysInProvisioningNeverDowngraded],
  ['ambiguousNetworkErrorDispatchStaysInProvisioning', testAmbiguousNetworkErrorDispatchStaysInProvisioning],
  ['doubleSubmitApprovalIsRejectedByTheEligibilityGateBeforeAnySecondDispatch', testDoubleSubmitApprovalIsRejectedByTheEligibilityGateBeforeAnySecondDispatch],
  ['concurrentDispatchClaimsResultInExactlyOneCasWinner', testConcurrentDispatchClaimsResultInExactlyOneCasWinner],
  ['ltaNeverTriggersAutomaticDispatch', testLtaNeverTriggersAutomaticDispatch],
  ['reconciliationLeavesFreshDispatchAlone', testReconciliationLeavesFreshDispatchAlone],
  ['reconciliationLeavesProgressedDispatchAloneEvenIfOld', testReconciliationLeavesProgressedDispatchAloneEvenIfOld],
  ['reconciliationMarksDispatchFailedAfterTimeoutWithNoProgress', testReconciliationMarksDispatchFailedAfterTimeoutWithNoProgress],
  ['reconciliationIsWiredIntoTheRealTenantStatusEndpoint', testReconciliationIsWiredIntoTheRealTenantStatusEndpoint],
  ['provisioningDispatchFailedBlocksSelfServiceReapproval', testProvisioningDispatchFailedBlocksSelfServiceReapproval],
]

for (const [name, fn] of tests) {
  await run(name, fn)
}

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} tests passed`)
process.exit(passed === results.length ? 0 : 1)
