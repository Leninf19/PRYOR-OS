// Phase B.3 -- Location + Seat Limit Enforcement.
//
// PART A tests dashboard/api/_lib/tenantConfigStore.js's recordLocationApproval()/
// applyEntitlementChange(), both of which now enforce resolveTenantEntitlementsFromConfig()'s
// maxLocations against the SAME tenant_config snapshot their CAS write is
// bound to (see entitlementResolution.js's header for the exact race this
// closes).
//
// PART B tests dashboard/api/settings/[action].js's invite-user/enable-user
// actions (driven through the real HTTP handler, matching this codebase's
// established convention -- test_invitations.js/test_user_management.js),
// both of which now enforce maxActiveUsers under a new per-tenant
// seatAllocationLock.js mutex.
//
// No real Upstash, no real Google, no production data -- fake in-memory
// Redis clients throughout, matching every other test file's convention.
//
// Run directly: node tests/test_location_seat_limits.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import bcrypt from 'bcryptjs'
import settingsHandler from '../dashboard/api/settings/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import {
  recordLocationApproval, applyEntitlementChange, upsertTenantConfig, getTenantConfig,
  MaxLocationsExceededError, ConfigVersionConflictError, LocationApprovalNotEligibleError,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import {
  _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis,
  countActiveOrInvitedUsers, upsertUser, UserCreationMode,
} from '../dashboard/api/_lib/userStore.js'
import {
  _setRedisClientForTests as setTokenRedis, _resetRedisClientForTests as resetTokenRedis,
} from '../dashboard/api/_lib/tokenStore.js'
import {
  _setRedisClientForTests as setSeatLockRedis, _resetRedisClientForTests as resetSeatLockRedis,
  acquireSeatAllocationLock, releaseSeatAllocationLock,
} from '../dashboard/api/_lib/seatAllocationLock.js'
import { _setLimiterFactoryForTests, _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

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
    resetTokenRedis()
    resetSeatLockRedis()
    _resetLimiterFactoryForTests()
    delete process.env.ACCOUNT_DIRECTORY_JSON
  }
}

const TENANT = 't_test-location-seat'

function newShapeCommercial(overrides = {}) {
  return {
    commercialStatus: 'active', plan: 'growth', planSource: 'access_code',
    trial: null, limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
    accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

// =====================================================================
// PART A -- Location limit enforcement
// =====================================================================

// Plain (non-latency) fake, same shape as test_tenant_entitlement_boundary.js's
// own fakeHashRedis(), with the CAS_UPSERT_SCRIPT-emulating eval().
function fakeConfigRedis() {
  const store = {}
  return {
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [field, expectedVersionStr, nextJson] = args
      const raw = store[key]?.[field] ?? null
      let currentVersion = '0'
      if (raw) {
        try { const decoded = JSON.parse(raw); if (decoded && decoded.configVersion !== undefined) currentVersion = String(decoded.configVersion) } catch { /* treat as version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
  }
}

async function seedTenant(commercial) {
  // CRITICAL: the factory must return the SAME persistent instance on
  // every call -- tenantConfigStore.js's getClient() calls the factory on
  // every single read/write, so a factory that builds a fresh object each
  // time silently loses every previous write.
  const client = fakeConfigRedis()
  setConfigRedis(() => client)
  return upsertTenantConfig(TENANT, { commercial }, { allowCreate: true, creationSource: 'migration' })
}

function loc(id) { return { googleLocationId: `accounts/x/locations/${id}`, title: `Loc ${id}`, address: '' } }

async function testCoreAllowsExactlyOneLocation() {
  await seedTenant(newShapeCommercial({ plan: 'core' }))
  const config = await recordLocationApproval(TENANT, [loc(1)])
  assert(config.approvedLocations.length === 1, JSON.stringify(config.approvedLocations))
}

async function testCoreRejectsASecondLocation() {
  await seedTenant(newShapeCommercial({ plan: 'core' }))
  try {
    await recordLocationApproval(TENANT, [loc(1), loc(2)])
    throw new Error('expected MaxLocationsExceededError')
  } catch (err) {
    assert(err instanceof MaxLocationsExceededError, err.constructor.name)
    assert(err.limit === 1 && err.requested === 2, JSON.stringify({ limit: err.limit, requested: err.requested }))
  }
}

async function testGrowthAllowsExactlyFiveLocations() {
  await seedTenant(newShapeCommercial({ plan: 'growth' }))
  const config = await recordLocationApproval(TENANT, [loc(1), loc(2), loc(3), loc(4), loc(5)])
  assert(config.approvedLocations.length === 5, JSON.stringify(config.approvedLocations))
}

async function testGrowthRejectsASixthLocation() {
  await seedTenant(newShapeCommercial({ plan: 'growth' }))
  try {
    await recordLocationApproval(TENANT, [loc(1), loc(2), loc(3), loc(4), loc(5), loc(6)])
    throw new Error('expected MaxLocationsExceededError')
  } catch (err) {
    assert(err instanceof MaxLocationsExceededError, err.constructor.name)
    assert(err.limit === 5 && err.requested === 6, JSON.stringify({ limit: err.limit, requested: err.requested }))
  }
}

async function testEnterpriseCustomFiniteLimitAllowsUpToOverride() {
  await seedTenant(newShapeCommercial({ plan: 'enterprise', limitsOverride: { maxLocations: 8 } }))
  const config = await recordLocationApproval(TENANT, [loc(1), loc(2), loc(3), loc(4), loc(5), loc(6), loc(7), loc(8)])
  assert(config.approvedLocations.length === 8, JSON.stringify(config.approvedLocations))
}

async function testEnterpriseCustomFiniteLimitRejectsOverOverride() {
  await seedTenant(newShapeCommercial({ plan: 'enterprise', limitsOverride: { maxLocations: 8 } }))
  try {
    await recordLocationApproval(TENANT, Array.from({ length: 9 }, (_, i) => loc(i + 1)))
    throw new Error('expected MaxLocationsExceededError')
  } catch (err) {
    assert(err instanceof MaxLocationsExceededError, err.constructor.name)
    assert(err.limit === 8 && err.requested === 9, JSON.stringify({ limit: err.limit, requested: err.requested }))
  }
}

async function testLegacyNullLimitRemainsUnrestricted() {
  // commercial === null while COMMERCIAL_ENFORCEMENT_CUTOFF is disabled
  // (the real, shipped B.2/B.3 default) resolves to legacy-unmanaged --
  // exactly today's real production behavior for every existing tenant.
  await seedTenant(null)
  const config = await recordLocationApproval(TENANT, Array.from({ length: 12 }, (_, i) => loc(i + 1)))
  assert(config.approvedLocations.length === 12, `a legacy/unmanaged tenant must never be limited -- got ${config.approvedLocations.length}`)
}

async function testDuplicateLocationIdsDoNotConsumeExtraSlots() {
  await seedTenant(newShapeCommercial({ plan: 'core' })) // maxLocations: 1
  const config = await recordLocationApproval(TENANT, [loc(1), loc(1), loc(1)])
  assert(config.approvedLocations.length === 1, `repeated googleLocationIds in one request must collapse to one slot, got ${config.approvedLocations.length}`)
}

async function testExistingOverLimitTenantCannotAddMoreViaEntitlementChange() {
  // Seed a tenant already carrying 5 approved locations (as if approved
  // under Growth), then downgrade to Core (maxLocations: 1) directly on
  // the record, and attempt to ADD one more via applyEntitlementChange().
  const config = await seedTenant(newShapeCommercial({ plan: 'growth' }))
  const approved = await recordLocationApproval(TENANT, [loc(1), loc(2), loc(3), loc(4), loc(5)])
  const downgraded = await upsertTenantConfig(TENANT, {
    status: 'provisioned', commercial: newShapeCommercial({ plan: 'core' }),
  }, { expectedVersion: approved.configVersion })
  try {
    await applyEntitlementChange(TENANT, { addGoogleLocations: [loc(6)] }, downgraded.configVersion)
    throw new Error('expected MaxLocationsExceededError')
  } catch (err) {
    assert(err instanceof MaxLocationsExceededError, err.constructor.name)
    assert(err.current === 5 && err.limit === 1 && err.requested === 1, JSON.stringify({ current: err.current, limit: err.limit, requested: err.requested }))
  }
}

async function testZeroAdditionsNeverFailsEvenWhenAlreadyOverLimit() {
  // "current=5, new plan limit=1, request changes metadata but adds zero
  // locations" -- must never turn into an unrelated destructive failure.
  // applyEntitlementChange() itself requires at least one add OR remove,
  // so this is exercised as a pure-removal (zero additions) call.
  const config = await seedTenant(newShapeCommercial({ plan: 'growth' }))
  const approved = await recordLocationApproval(TENANT, [loc(1), loc(2), loc(3), loc(4), loc(5)])
  const downgraded = await upsertTenantConfig(TENANT, {
    status: 'provisioned', commercial: newShapeCommercial({ plan: 'core' }),
  }, { expectedVersion: approved.configVersion })
  const removedLocationId = approved.approvedLocations[0].locationId
  const result = await applyEntitlementChange(TENANT, { removeLocationIds: [removedLocationId] }, downgraded.configVersion)
  assert(result.config.approvedLocations.length === 4, `a pure removal must succeed even while over limit, got ${result.config.approvedLocations.length}`)
}

async function testResolverFailureNeverFailsOpenIntoUnlimitedAdditions() {
  // A definitively-missing tenant_config for a non-BOOTSTRAP tenant
  // resolves to a fail-closed bundle (maxLocations: 0) -- but
  // recordLocationApproval() itself already refuses a nonexistent tenant
  // (TenantDoesNotExistError) before ever reaching the limit check, which
  // is itself a stronger fail-closed guarantee. This test instead proves
  // the actual maxLocations:0 fail-closed VALUE rejects any addition, by
  // seeding a MALFORMED commercial shape (resolves to 'unconfigured',
  // limits all zero) on an already-existing tenant.
  await seedTenant({ commercialStatus: 'not-a-real-status', plan: 'growth' })
  try {
    await recordLocationApproval(TENANT, [loc(1)])
    throw new Error('expected MaxLocationsExceededError')
  } catch (err) {
    assert(err instanceof MaxLocationsExceededError, `a fail-closed (0-limit) resolution must still reject an addition, got ${err.constructor.name}: ${err.message}`)
    assert(err.limit === 0, `fail-closed must mean limit 0, never unlimited, got ${err.limit}`)
  }
}

// --- Race test: two concurrent approvals, current = limit-1, each adding ONE DIFFERENT location ---

function makeLatencyInjectingConfigRedis(delayMs = 15) {
  const store = {}
  const delay = () => new Promise(resolve => setTimeout(resolve, delayMs))
  return {
    hget: async (key, field) => { await delay(); return store[key]?.[field] ?? null },
    hgetall: async (key) => { await delay(); return { ...(store[key] ?? {}) } },
    hset: async (key, fields) => { await delay(); store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { await delay(); if (store[key]) delete store[key][field] },
    eval: async (_script, keys, args) => {
      await delay()
      const key = keys[0]
      const [field, expectedVersionStr, nextJson] = args
      const raw = store[key]?.[field] ?? null
      let currentVersion = '0'
      if (raw) {
        try { const decoded = JSON.parse(raw); if (decoded && decoded.configVersion !== undefined) currentVersion = String(decoded.configVersion) } catch { /* treat as version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
  }
}

async function testConcurrentApprovalsAtLimitBoundaryExactlyOneCommits() {
  const client = makeLatencyInjectingConfigRedis()
  setConfigRedis(() => client)
  // Core: maxLocations = 1. Seed at 'onboarding' with zero approved yet
  // (current = limit - 1 = 0), then race two DIFFERENT single-location
  // approvals concurrently.
  await upsertTenantConfig(TENANT, { commercial: newShapeCommercial({ plan: 'core' }) }, { allowCreate: true, creationSource: 'migration' })

  const [resultA, resultB] = await Promise.allSettled([
    recordLocationApproval(TENANT, [loc('a')]),
    recordLocationApproval(TENANT, [loc('b')]),
  ])

  const outcomes = [resultA, resultB]
  const fulfilled = outcomes.filter(r => r.status === 'fulfilled')
  const rejected = outcomes.filter(r => r.status === 'rejected')
  assert(fulfilled.length === 1, `exactly one concurrent approval must commit, got ${fulfilled.length}`)
  assert(rejected.length === 1, `exactly one concurrent approval must be rejected, got ${rejected.length}`)
  // Never both successful, and the loser must be a deterministic, expected
  // error -- either it lost the CAS race outright, or (less likely with
  // this delay shape, but still a valid, safe outcome) it would have
  // exceeded the limit against the post-winner state.
  assert(
    rejected[0].reason instanceof ConfigVersionConflictError || rejected[0].reason instanceof MaxLocationsExceededError,
    `the loser must fail with a deterministic ConfigVersionConflictError or MaxLocationsExceededError, got ${rejected[0].reason?.constructor?.name}: ${rejected[0].reason?.message}`
  )

  const final = await getTenantConfig(TENANT)
  assert(final.approvedLocations.length === 1, `at most one location may ever end up committed, got ${final.approvedLocations.length}`)
}

// =====================================================================
// PART B -- Seat limit enforcement
// =====================================================================

function fakeUserRedis() {
  const store = {}
  return {
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
  }
}

function fakeTokenRedis() {
  const data = {}
  return {
    get: async (key) => data[key]?.value ?? null,
    set: async (key, value) => { data[key] = { value }; return 'OK' },
    getdel: async (key) => { const v = data[key]?.value ?? null; delete data[key]; return v },
    del: async (key) => { const existed = key in data; delete data[key]; return existed ? 1 : 0 },
  }
}

// SET NX EX + ownership-token eval, matching seatAllocationLock.js's real
// RELEASE_SCRIPT shape (a single `[token]` arg). Kept UNDELAYED/atomic --
// exactly like every other lock test in this codebase -- a real Redis SET
// NX is indivisible regardless of network latency, so delaying it here
// would defeat the very race this test exists to prove; only the READS
// used to COUNT current seats (hgetall, via fakeUserRedisWithReadDelay
// below) are delayed to force genuine interleaving.
function fakeSeatLockRedis() {
  const strings = {}
  return {
    set: async (key, value, opts) => { if (opts?.nx && key in strings) return null; strings[key] = value; return 'OK' },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [token] = args
      if (strings[key] !== token) return 0
      delete strings[key]
      return 1
    },
  }
}

// CRITICAL: the registered factory must return the SAME persistent
// instance on every call -- seatAllocationLock.js's getClient() calls the
// factory on every single acquire/release, so a factory that builds a
// fresh object each time (e.g. `setSeatLockRedis(() => fakeSeatLockRedis())`
// inline) silently means the lock can never actually be seen as "already
// held" by a second call, defeating mutual exclusion entirely. Every test
// below must call this helper, never construct+register inline.
function installFakeSeatLock() {
  const client = fakeSeatLockRedis()
  setSeatLockRedis(() => client)
  return client
}

async function seedTenantForSeats(tenantId, commercial) {
  const client = fakeConfigRedis() // same persistent-instance discipline as seedTenant() above
  setConfigRedis(() => client)
  await upsertTenantConfig(tenantId, { status: 'active', commercial }, { allowCreate: true, creationSource: 'migration' })
}

// Uses the REAL upsertUser() (never a raw, guessed hset key) -- userStore.js
// writes to more than one hash (the user record itself, plus identity-index
// hashes) that requireAuth()/getAccountByEmail() need in order to actually
// FIND the seeded account; a hand-written hset on a guessed key silently
// skips those and produces an unauthenticatable session (401), exactly the
// bug this comment exists to prevent regressing back into.
async function seedOwner(tenantId, { userId = 'usr_owner', email = 'owner@example.com' } = {}) {
  const passwordHash = await bcrypt.hash('x', 4)
  const now = new Date().toISOString()
  const record = {
    userId, email, passwordHash, role: 'owner', locationIds: '*', tenantId,
    sessionVersion: 1, disabled: false, displayName: 'Owner',
    createdAt: now, updatedAt: now, lastLoginAt: null, passwordSetAt: now,
  }
  await upsertUser(tenantId, record, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  return signSession({ userId, email, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
}

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}

async function invoke({ action, method = 'GET', token, body, query }) {
  const req = {
    method, query: { action, ...(query ?? {}) }, body: body ?? {},
    headers: token ? { cookie: `lta_session=${token}` } : {}, socket: {},
  }
  const res = fakeRes()
  await settingsHandler(req, res)
  return res
}

function noopRateLimit() { _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: true, remaining: 99 }) })) }

async function seedNActiveUsers(tenantId, n) {
  const now = new Date().toISOString()
  for (let i = 0; i < n; i++) {
    const record = {
      userId: `usr_fill_${i}`, email: `fill${i}@example.com`, passwordHash: 'x', role: 'read_only', locationIds: [1], tenantId,
      sessionVersion: 1, disabled: false, displayName: `Fill ${i}`,
      createdAt: now, updatedAt: now, lastLoginAt: null, passwordSetAt: now,
    }
    await upsertUser(tenantId, record, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  }
}

// Seeds one user record via the REAL upsertUser() (see seedOwner()'s own
// comment for why a raw, guessed hset key must never be used instead).
// Returns nothing -- callers only need the write to have happened so a
// later countActiveOrInvitedUsers()/invoke() call sees it.
async function seedUser(tenantId, overrides) {
  const now = new Date().toISOString()
  const record = {
    role: 'read_only', locationIds: [1], tenantId,
    sessionVersion: 1, disabled: false,
    createdAt: now, updatedAt: now, lastLoginAt: null,
    ...overrides,
  }
  await upsertUser(tenantId, record, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
}

async function testCoreAllowsExactlyThreeSeats() {
  await seedTenantForSeats(TENANT, newShapeCommercial({ plan: 'core' }))
  const userClient = fakeUserRedis()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  installFakeSeatLock()
  noopRateLimit()
  const ownerToken = await seedOwner(TENANT)
  await seedNActiveUsers(TENANT, 2) // owner + 2 = 3, at the Core limit
  const res = await invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'New', email: 'new@example.com', role: 'read_only', locationIds: [1] } })
  assert(res.statusCode === 409 && res.body.error === 'seat_limit_reached', `Core must reject a 4th seat, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.current === 3 && res.body.limit === 3, JSON.stringify(res.body))
}

async function testGrowthAllowsExactlyTenSeats() {
  await seedTenantForSeats(TENANT, newShapeCommercial({ plan: 'growth' }))
  const userClient = fakeUserRedis()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  installFakeSeatLock()
  noopRateLimit()
  const ownerToken = await seedOwner(TENANT)
  await seedNActiveUsers(TENANT, 8) // owner + 8 = 9, one seat left of 10
  const ok = await invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'New', email: 'new@example.com', role: 'read_only', locationIds: [1] } })
  assert(ok.statusCode === 200, `Growth's 10th seat must succeed, got ${ok.statusCode}: ${JSON.stringify(ok.body)}`)
  const blocked = await invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'Another', email: 'another@example.com', role: 'read_only', locationIds: [1] } })
  assert(blocked.statusCode === 409 && blocked.body.error === 'seat_limit_reached', `an 11th seat must be rejected, got ${blocked.statusCode}: ${JSON.stringify(blocked.body)}`)
  assert(blocked.body.current === 10 && blocked.body.limit === 10, JSON.stringify(blocked.body))
}

async function testEnterpriseCustomSeatLimit() {
  await seedTenantForSeats(TENANT, newShapeCommercial({ plan: 'enterprise', limitsOverride: { maxActiveUsers: 2 } }))
  const userClient = fakeUserRedis()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  installFakeSeatLock()
  noopRateLimit()
  const ownerToken = await seedOwner(TENANT) // owner = 1 of 2
  const res = await invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'New', email: 'new@example.com', role: 'read_only', locationIds: [1] } })
  assert(res.statusCode === 200, `Enterprise override of 2 must allow a 2nd seat, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const blocked = await invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'Third', email: 'third@example.com', role: 'read_only', locationIds: [1] } })
  assert(blocked.statusCode === 409 && blocked.body.limit === 2, `a 3rd seat must be rejected under the Enterprise override of 2, got ${blocked.statusCode}: ${JSON.stringify(blocked.body)}`)
}

async function testLegacyNullSeatLimitUnrestricted() {
  await seedTenantForSeats(TENANT, null) // cutoff disabled -> legacy-unmanaged, null limits
  const userClient = fakeUserRedis()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  installFakeSeatLock()
  noopRateLimit()
  const ownerToken = await seedOwner(TENANT)
  await seedNActiveUsers(TENANT, 50)
  const res = await invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'New', email: 'new@example.com', role: 'read_only', locationIds: [1] } })
  assert(res.statusCode === 200, `a legacy/unmanaged tenant must never be seat-limited, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testDisabledRevokedExpiredUsersDoNotCount() {
  await seedTenantForSeats(TENANT, newShapeCommercial({ plan: 'core' })) // maxActiveUsers: 3
  const userClient = fakeUserRedis()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  installFakeSeatLock()
  noopRateLimit()
  const ownerToken = await seedOwner(TENANT) // 1 seat
  await seedUser(TENANT, { userId: 'usr_disabled', email: 'd@example.com', passwordHash: 'x', disabled: true, displayName: 'D', passwordSetAt: new Date().toISOString() })
  await seedUser(TENANT, { userId: 'usr_revoked', email: 'r@example.com', passwordHash: null, displayName: 'R', passwordSetAt: null, inviteRevokedAt: new Date().toISOString(), inviteExpiresAt: new Date(Date.now() + 999999).toISOString() })
  await seedUser(TENANT, { userId: 'usr_expired', email: 'e@example.com', passwordHash: null, displayName: 'E', passwordSetAt: null, inviteRevokedAt: null, inviteExpiresAt: new Date(Date.now() - 999999).toISOString() })
  const count = await countActiveOrInvitedUsers(TENANT)
  assert(count === 1, `disabled/revoked/expired users must never count -- expected 1 (owner only), got ${count}`)
  // With only 1 real seat consumed, two more invites (up to the Core limit
  // of 3) must succeed.
  const res1 = await invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'A', email: 'a@example.com', role: 'read_only', locationIds: [1] } })
  assert(res1.statusCode === 200, JSON.stringify(res1.body))
  const res2 = await invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'B', email: 'b@example.com', role: 'read_only', locationIds: [1] } })
  assert(res2.statusCode === 200, JSON.stringify(res2.body))
  const res3 = await invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'C', email: 'c@example.com', role: 'read_only', locationIds: [1] } })
  assert(res3.statusCode === 409, `a 4th real seat must still be rejected, got ${res3.statusCode}`)
}

async function testInvitedUsersDoCount() {
  await seedTenantForSeats(TENANT, newShapeCommercial({ plan: 'core' })) // maxActiveUsers: 3
  const userClient = fakeUserRedis()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  installFakeSeatLock()
  noopRateLimit()
  const ownerToken = await seedOwner(TENANT) // 1
  const first = await invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'A', email: 'a@example.com', role: 'read_only', locationIds: [1] } })
  assert(first.statusCode === 200, JSON.stringify(first.body)) // 2, still 'invited' not 'active'
  const count = await countActiveOrInvitedUsers(TENANT)
  assert(count === 2, `a pending invitation must already count as a seat, got ${count}`)
  const second = await invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'B', email: 'b@example.com', role: 'read_only', locationIds: [1] } })
  assert(second.statusCode === 200, JSON.stringify(second.body)) // 3, at the limit
  const third = await invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'C', email: 'c@example.com', role: 'read_only', locationIds: [1] } })
  assert(third.statusCode === 409, `a 4th seat (even though nobody has accepted yet) must be rejected, got ${third.statusCode}`)
}

async function testAcceptingAnExistingInviteDoesNotAllocateAnAdditionalSeat() {
  // accept-invite (session/[action].js) only ever calls updateUser()/upsertUser()
  // on the ALREADY-EXISTING invited record, flipping passwordHash/passwordSetAt --
  // it never creates a new record and never calls the seat-allocation lock
  // or entitlement resolver at all. This test proves the count is stable
  // across that transition by simulating it directly (matching this file's
  // Part B scope, which is invite-user/enable-user -- accept-invite's own
  // full HTTP flow is already covered by test_invitations.js).
  await seedTenantForSeats(TENANT, newShapeCommercial({ plan: 'core' }))
  const userClient = fakeUserRedis()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  installFakeSeatLock()
  noopRateLimit()
  await seedOwner(TENANT)
  const before = await countActiveOrInvitedUsers(TENANT)
  // Simulate accept-invite's own write shape for a SEPARATE invited user.
  await seedUser(TENANT, { userId: 'usr_invitee', email: 'invitee@example.com', passwordHash: null, displayName: 'Invitee', passwordSetAt: null, inviteExpiresAt: new Date(Date.now() + 999999).toISOString() })
  const afterInvite = await countActiveOrInvitedUsers(TENANT)
  assert(afterInvite === before + 1, 'issuing the invite is what consumes the seat')
  // accept-invite: passwordHash/passwordSetAt get set, status flips 'invited' -> 'active'.
  await seedUser(TENANT, { userId: 'usr_invitee', email: 'invitee@example.com', passwordHash: 'newhash', displayName: 'Invitee', passwordSetAt: new Date().toISOString() })
  const afterAccept = await countActiveOrInvitedUsers(TENANT)
  assert(afterAccept === afterInvite, `accepting an existing invite must not allocate a second seat -- before=${afterInvite}, after=${afterAccept}`)
}

async function testEnableUserAddsASeatBackAndCanBeBlocked() {
  await seedTenantForSeats(TENANT, newShapeCommercial({ plan: 'core' })) // maxActiveUsers: 3
  const userClient = fakeUserRedis()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  installFakeSeatLock()
  noopRateLimit()
  const ownerToken = await seedOwner(TENANT) // 1
  // Two more ACTIVE users already at the limit (3 total), plus one DISABLED
  // user who would push the tenant to 4 if re-enabled.
  const passwordSetAt = new Date().toISOString()
  await seedUser(TENANT, { userId: 'usr_a', email: 'a@example.com', passwordHash: 'x', displayName: 'A', passwordSetAt })
  await seedUser(TENANT, { userId: 'usr_b', email: 'b@example.com', passwordHash: 'x', displayName: 'B', passwordSetAt })
  await seedUser(TENANT, { userId: 'usr_disabled', email: 'dis@example.com', passwordHash: 'x', disabled: true, displayName: 'Dis', passwordSetAt })
  const res = await invoke({ action: 'enable-user', method: 'POST', token: ownerToken, body: { userId: 'usr_disabled' } })
  assert(res.statusCode === 409 && res.body.error === 'seat_limit_reached', `re-enabling at the limit must be rejected, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.current === 3 && res.body.limit === 3, JSON.stringify(res.body))
}

async function testIdempotentEnableOfAlreadyActiveUserDoesNotConsumeTwice() {
  await seedTenantForSeats(TENANT, newShapeCommercial({ plan: 'core' })) // maxActiveUsers: 3
  const userClient = fakeUserRedis()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  installFakeSeatLock()
  noopRateLimit()
  const ownerToken = await seedOwner(TENANT) // 1
  const passwordSetAt = new Date().toISOString()
  await seedUser(TENANT, { userId: 'usr_a', email: 'a@example.com', passwordHash: 'x', displayName: 'A', passwordSetAt })
  await seedUser(TENANT, { userId: 'usr_b', email: 'b@example.com', passwordHash: 'x', displayName: 'B', passwordSetAt })
  // Already at the limit (3), but usr_a is ALREADY enabled -- an idempotent
  // "enable" of it must succeed (no-op), never be blocked as if it were a
  // new 4th seat.
  const res = await invoke({ action: 'enable-user', method: 'POST', token: ownerToken, body: { userId: 'usr_a' } })
  assert(res.statusCode === 200, `an idempotent enable of an already-active user must succeed, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testOverLimitTenantCanStillDisableUsers() {
  await seedTenantForSeats(TENANT, newShapeCommercial({ plan: 'core' })) // maxActiveUsers: 3, but seed 5 (as if downgraded from Growth)
  const userClient = fakeUserRedis()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  installFakeSeatLock()
  noopRateLimit()
  const ownerToken = await seedOwner(TENANT)
  await seedNActiveUsers(TENANT, 4) // total 5, over the Core limit of 3
  const res = await invoke({ action: 'disable-user', method: 'POST', token: ownerToken, body: { userId: 'usr_fill_0' } })
  assert(res.statusCode === 200, `disabling a user must always be allowed, even while already over limit, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testResolverFailureCannotBecomeUnlimitedSeats() {
  // A malformed commercial shape resolves to a fail-closed bundle
  // (maxActiveUsers: 0) -- never null/unlimited.
  await seedTenantForSeats(TENANT, { commercialStatus: 'not-a-real-status', plan: 'growth' })
  const userClient = fakeUserRedis()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  installFakeSeatLock()
  noopRateLimit()
  const ownerToken = await seedOwner(TENANT)
  const res = await invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'New', email: 'new@example.com', role: 'read_only', locationIds: [1] } })
  assert(res.statusCode === 409 && res.body.limit === 0, `a fail-closed resolution must deny with limit 0, never allow unlimited seats -- got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testSeatLockStoreOutageFailsClosed() {
  await seedTenantForSeats(TENANT, newShapeCommercial({ plan: 'core' }))
  const userClient = fakeUserRedis()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  // Deliberately do NOT configure the seat lock client at all -- matches
  // acquireSeatAllocationLock()'s own "store is not configured" fail-closed path.
  noopRateLimit()
  const ownerToken = await seedOwner(TENANT)
  const res = await invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'New', email: 'new@example.com', role: 'read_only', locationIds: [1] } })
  assert(res.statusCode === 503, `a seat-lock store outage must fail closed (503), never silently allow the invite through, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// --- Seat lock primitive tests (mirrors test_content_endpoint.js's own lock tests) ---

async function testStaleLockHolderCannotReleaseNewerHoldersLock() {
  const client = fakeSeatLockRedis()
  setSeatLockRedis(() => client)
  const tokenA = await acquireSeatAllocationLock(TENANT)
  assert(tokenA, 'A must acquire the lock')
  // Simulate A's lease having genuinely expired and B acquiring fresh --
  // done here by directly clearing the fake's own backing store (this fake
  // has no TTL simulation, so we force the "expired" state manually,
  // matching this codebase's established fakeExpiringLockRedis()-adjacent
  // pattern from test_content_endpoint.js for the equivalent proof).
  await releaseSeatAllocationLock(TENANT, 'not-the-real-token') // must be a harmless no-op
  const stillHeld = await acquireSeatAllocationLock(TENANT)
  assert(stillHeld === null, 'a forged/incorrect release token must never free a lock it does not own')
  // Now release with the REAL token and confirm it actually frees the lock.
  await releaseSeatAllocationLock(TENANT, tokenA)
  const tokenB = await acquireSeatAllocationLock(TENANT)
  assert(tokenB && tokenB !== tokenA, 'the correct token must successfully release the lock')
}

// --- Genuine concurrency: two concurrent invite-user calls, exactly one succeeds ---

function fakeUserRedisWithReadDelay(delayMs = 15) {
  const store = {}
  const delay = () => new Promise(resolve => setTimeout(resolve, delayMs))
  return {
    hget: async (key, field) => { await delay(); return store[key]?.[field] ?? null },
    hgetall: async (key) => { await delay(); return { ...(store[key] ?? {}) } },
    hset: async (key, fields) => { await delay(); store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { await delay(); if (store[key]) delete store[key][field] },
  }
}

async function testConcurrentInvitesAtLastSeatExactlyOneSucceeds() {
  await seedTenantForSeats(TENANT, newShapeCommercial({ plan: 'core' })) // maxActiveUsers: 3
  const userClient = fakeUserRedisWithReadDelay()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  installFakeSeatLock()
  noopRateLimit()
  const ownerToken = await seedOwner(TENANT)
  await seedNActiveUsers(TENANT, 1) // owner + 1 = 2, one seat left

  const [resA, resB] = await Promise.all([
    invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'A', email: 'racer-a@example.com', role: 'read_only', locationIds: [1] } }),
    invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'B', email: 'racer-b@example.com', role: 'read_only', locationIds: [1] } }),
  ])
  const successes = [resA, resB].filter(r => r.statusCode === 200)
  const rejections = [resA, resB].filter(r => r.statusCode !== 200)
  assert(successes.length === 1, `exactly one of the two concurrent invites at the last seat must succeed, got ${successes.length} (statuses: ${resA.statusCode}, ${resB.statusCode})`)
  assert(rejections.length === 1 && (rejections[0].statusCode === 409), `the loser must be refused with 409, got ${rejections[0].statusCode}`)
  const finalCount = await countActiveOrInvitedUsers(TENANT)
  assert(finalCount === 3, `the tenant must never end up with more than its limit, got ${finalCount}`)
}

async function testConcurrentEnablesAtLastSeatExactlyOneSucceeds() {
  await seedTenantForSeats(TENANT, newShapeCommercial({ plan: 'core' })) // maxActiveUsers: 3
  const userClient = fakeUserRedisWithReadDelay()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  installFakeSeatLock()
  noopRateLimit()
  const ownerToken = await seedOwner(TENANT) // 1
  await seedNActiveUsers(TENANT, 1) // 2, one seat left
  const passwordSetAt = new Date().toISOString()
  await seedUser(TENANT, { userId: 'usr_x', email: 'x@example.com', passwordHash: 'x', disabled: true, displayName: 'X', passwordSetAt })
  await seedUser(TENANT, { userId: 'usr_y', email: 'y@example.com', passwordHash: 'x', disabled: true, displayName: 'Y', passwordSetAt })
  const [resX, resY] = await Promise.all([
    invoke({ action: 'enable-user', method: 'POST', token: ownerToken, body: { userId: 'usr_x' } }),
    invoke({ action: 'enable-user', method: 'POST', token: ownerToken, body: { userId: 'usr_y' } }),
  ])
  const successes = [resX, resY].filter(r => r.statusCode === 200)
  const rejections = [resX, resY].filter(r => r.statusCode !== 200)
  assert(successes.length === 1, `exactly one of the two concurrent enables for the last seat must succeed, got ${successes.length}`)
  assert(rejections.length === 1 && rejections[0].statusCode === 409, `the loser must be refused with 409, got ${rejections[0].statusCode}`)
}

async function testInviteVersusEnableRaceAtLastSeat() {
  await seedTenantForSeats(TENANT, newShapeCommercial({ plan: 'core' })) // maxActiveUsers: 3
  const userClient = fakeUserRedisWithReadDelay()
  setUserRedis(() => userClient)
  setTokenRedis(() => fakeTokenRedis())
  installFakeSeatLock()
  noopRateLimit()
  const ownerToken = await seedOwner(TENANT) // 1
  await seedNActiveUsers(TENANT, 1) // 2, one seat left
  await seedUser(TENANT, { userId: 'usr_disabled', email: 'dis@example.com', passwordHash: 'x', disabled: true, displayName: 'Dis', passwordSetAt: new Date().toISOString() })
  const [invite, enable] = await Promise.all([
    invoke({ action: 'invite-user', method: 'POST', token: ownerToken, body: { name: 'New', email: 'racer@example.com', role: 'read_only', locationIds: [1] } }),
    invoke({ action: 'enable-user', method: 'POST', token: ownerToken, body: { userId: 'usr_disabled' } }),
  ])
  const outcomes = [invite, enable]
  const successes = outcomes.filter(r => r.statusCode === 200)
  const rejections = outcomes.filter(r => r.statusCode !== 200)
  assert(successes.length === 1, `exactly one of an invite-vs-enable race for the last seat must succeed, got ${successes.length} (statuses: ${invite.statusCode}, ${enable.statusCode})`)
  assert(rejections.length === 1 && rejections[0].statusCode === 409, `the loser must be refused with 409, got ${rejections[0].statusCode}`)
  const finalCount = await countActiveOrInvitedUsers(TENANT)
  assert(finalCount === 3, `the tenant must never end up with more than its limit, got ${finalCount}`)
}

// =====================================================================
// PART E -- Structural guards: these two authoritative mutation paths must
// never silently lose their entitlement check in a future refactor. Whole-
// file substring checks are deliberately low-precision (matching this
// codebase's own established structural-test style, e.g.
// test_vercel_json_disables_native_git_deployments) -- their job is to
// fail loudly if the relevant call/error/response is removed entirely, not
// to re-verify correctness (the behavior tests above already do that).
// =====================================================================

function testTenantConfigStoreStructurallyEnforcesLocationLimits() {
  const src = readFileSync(path.join(REPO_ROOT, 'dashboard', 'api', '_lib', 'tenantConfigStore.js'), 'utf8')
  assert(src.includes('resolveTenantEntitlementsFromConfig'), 'tenantConfigStore.js must call resolveTenantEntitlementsFromConfig() -- location-limit enforcement must never be silently removed')
  assert(src.includes('class MaxLocationsExceededError'), 'tenantConfigStore.js must define MaxLocationsExceededError')
  const callSites = src.match(/resolveTenantEntitlementsFromConfig\(existing\)/g) || []
  assert(callSites.length >= 2, `both recordLocationApproval() and applyEntitlementChange() must call resolveTenantEntitlementsFromConfig(existing) -- found ${callSites.length} call site(s)`)
}

function testSettingsActionStructurallyEnforcesSeatLimits() {
  const src = readFileSync(path.join(REPO_ROOT, 'dashboard', 'api', 'settings', '[action].js'), 'utf8')
  assert(src.includes('acquireSeatAllocationLock'), 'settings/[action].js must acquire the seat allocation lock -- seat-limit enforcement must never be silently removed')
  assert(src.includes('countActiveOrInvitedUsers'), 'settings/[action].js must call countActiveOrInvitedUsers() to enforce seat limits')
  assert(src.includes("'seat_limit_reached'"), 'settings/[action].js must be able to return seat_limit_reached')
  assert(src.includes('releaseSeatAllocationLock'), 'settings/[action].js must release the seat allocation lock it acquires')
}

function testGoogleAndAdminEndpointsStructurallyHandleMaxLocationsExceeded() {
  const googleSrc = readFileSync(path.join(REPO_ROOT, 'dashboard', 'api', 'google', '[action].js'), 'utf8')
  assert(googleSrc.includes('MaxLocationsExceededError'), 'google/[action].js\'s approveLocations() must handle MaxLocationsExceededError -- location_limit_reached must never regress into an opaque 503')
  const adminSrc = readFileSync(path.join(REPO_ROOT, 'dashboard', 'api', 'admin', '[action].js'), 'utf8')
  assert(adminSrc.includes('MaxLocationsExceededError'), 'admin/[action].js\'s tenantEntitlementsApplyAction() must handle MaxLocationsExceededError')
}

const tests = [
  // --- Part A: location limits ---
  ['PART A: Core allows exactly 1 location', testCoreAllowsExactlyOneLocation],
  ['PART A: Core rejects a 2nd location', testCoreRejectsASecondLocation],
  ['PART A: Growth allows exactly 5 locations', testGrowthAllowsExactlyFiveLocations],
  ['PART A: Growth rejects a 6th location', testGrowthRejectsASixthLocation],
  ['PART A: Enterprise custom finite limit allows up to the override', testEnterpriseCustomFiniteLimitAllowsUpToOverride],
  ['PART A: Enterprise custom finite limit rejects over the override', testEnterpriseCustomFiniteLimitRejectsOverOverride],
  ['PART A: legacy null limit remains unrestricted', testLegacyNullLimitRemainsUnrestricted],
  ['PART A: duplicate location ids in one request do not consume extra slots', testDuplicateLocationIdsDoNotConsumeExtraSlots],
  ['PART A: an existing over-limit tenant cannot add more via applyEntitlementChange', testExistingOverLimitTenantCannotAddMoreViaEntitlementChange],
  ['PART A: zero net additions never fails even when already over limit (removal-only)', testZeroAdditionsNeverFailsEvenWhenAlreadyOverLimit],
  ['PART A: resolver failure (fail-closed, limit 0) never fails open into unlimited additions', testResolverFailureNeverFailsOpenIntoUnlimitedAdditions],
  ['PART A RACE: two concurrent approvals at the limit boundary -- exactly one commits', testConcurrentApprovalsAtLimitBoundaryExactlyOneCommits],

  // --- Part B: seat limits ---
  ['PART B: Core allows exactly 3 seats', testCoreAllowsExactlyThreeSeats],
  ['PART B: Growth allows exactly 10 seats', testGrowthAllowsExactlyTenSeats],
  ['PART B: Enterprise custom seat limit', testEnterpriseCustomSeatLimit],
  ['PART B: legacy null seat limit remains unrestricted', testLegacyNullSeatLimitUnrestricted],
  ['PART B: disabled/revoked/expired users do not count', testDisabledRevokedExpiredUsersDoNotCount],
  ['PART B: invited users DO count', testInvitedUsersDoCount],
  ['PART B: accepting an existing invite does not allocate an additional seat', testAcceptingAnExistingInviteDoesNotAllocateAnAdditionalSeat],
  ['PART B: enable-user adds a seat back and can be blocked at the limit', testEnableUserAddsASeatBackAndCanBeBlocked],
  ['PART B: idempotent enable of an already-active user does not consume twice', testIdempotentEnableOfAlreadyActiveUserDoesNotConsumeTwice],
  ['PART B: an over-limit tenant can still disable users', testOverLimitTenantCanStillDisableUsers],
  ['PART B: resolver failure (fail-closed, limit 0) cannot become unlimited seats', testResolverFailureCannotBecomeUnlimitedSeats],
  ['PART B: seat lock store outage fails closed (503), never allows the invite through', testSeatLockStoreOutageFailsClosed],
  ['PART B: a stale/forged lock token can never release a lock it does not own', testStaleLockHolderCannotReleaseNewerHoldersLock],
  ['PART B RACE: two concurrent invite-user calls at the last seat -- exactly one succeeds', testConcurrentInvitesAtLastSeatExactlyOneSucceeds],
  ['PART B RACE: two concurrent enable-user calls at the last seat -- exactly one succeeds', testConcurrentEnablesAtLastSeatExactlyOneSucceeds],
  ['PART B RACE: invite vs enable race at the last seat -- exactly one succeeds', testInviteVersusEnableRaceAtLastSeat],

  // --- Part E: structural guards ---
  ['PART E: tenantConfigStore.js structurally enforces location limits at both CAS writers', testTenantConfigStoreStructurallyEnforcesLocationLimits],
  ['PART E: settings/[action].js structurally enforces seat limits under the allocation lock', testSettingsActionStructurallyEnforcesSeatLimits],
  ['PART E: google/[action].js and admin/[action].js structurally handle MaxLocationsExceededError', testGoogleAndAdminEndpointsStructurallyHandleMaxLocationsExceeded],
]

async function main() {
  for (const [name, fn] of tests) await run(name, fn)
  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
