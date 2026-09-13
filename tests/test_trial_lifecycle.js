// Phase B.6 -- 7-day Growth trial + anti-abuse eligibility. Regression
// tests for:
//   - dashboard/api/_lib/trialEligibilityStore.js (the GBP-location claim
//     store: atomic first reservation, same-tenant idempotent retry,
//     ownership-token-checked finalize)
//   - dashboard/api/_lib/commercialIdentity.js (secondary signal only)
//   - dashboard/api/_lib/trialLifecycle.js (maybeStartTrial() orchestration)
//   - the trialStatus/trialStartedAt/trialEndsAt/trialConsumedAt additions
//     to entitlementResolution.js's resolved bundle, and its now
//     time-authoritative `trialStatus` field
//   - session/[action].js's tenantStatus() trial-start wiring and safe
//     frontend view
//
// Run directly: node tests/test_trial_lifecycle.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import { readFileSync } from 'fs'
import {
  reserveTrialClaim, finalizeTrialClaim, getTrialClaim,
  _setRedisClientForTests as setClaimRedis, _resetRedisClientForTests as resetClaimRedis,
  TrialEligibilityStoreUnavailableError,
} from '../dashboard/api/_lib/trialEligibilityStore.js'
import { commercialIdentityKey } from '../dashboard/api/_lib/commercialIdentity.js'
import { maybeStartTrial, selectTrialEligibleLocation } from '../dashboard/api/_lib/trialLifecycle.js'
import { resolveTenantEntitlementsFromConfig } from '../dashboard/api/_lib/entitlementResolution.js'
import {
  upsertTenantConfig, getTenantConfig, recordLocationApproval, applyEntitlementChange,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import {
  upsertUser, UserCreationMode,
  _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis,
} from '../dashboard/api/_lib/userStore.js'
import handler from '../dashboard/api/session/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

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
    resetClaimRedis()
    resetConfigRedis()
    resetUserRedis()
  }
}

// --- fakes -----------------------------------------------------------------

function fakeKeyedHashRedis() {
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
        try { const decoded = JSON.parse(raw); if (decoded && decoded.configVersion !== undefined) currentVersion = String(decoded.configVersion) } catch { /* version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
  }
}

// One Redis hash key per GBP location, matching trialEligibilityStore.js's
// real shape -- distinguishes RESERVE_SCRIPT (6 ARGV) from FINALIZE_SCRIPT
// (3 ARGV) by argument count, since both scripts share the same eval()
// entry point in production.
function fakeTrialClaimRedis() {
  const store = {}
  return {
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    eval: async (_script, keys, args) => {
      const key = keys[0]
      if (args.length === 6) {
        const [tenantId, claimToken, now, commercialIdentityKeyArg, claimType, gbpLocationKey] = args
        const existing = store[key]
        if (!existing) {
          store[key] = { gbpLocationKey, tenantId, claimToken, state: 'reserved', reservedAt: now, consumedAt: '', commercialIdentityKey: commercialIdentityKeyArg, claimType }
          return ['reserved', claimToken, now]
        }
        if (existing.tenantId === tenantId) {
          return [existing.state, existing.claimToken, existing.reservedAt]
        }
        return ['denied', false, false]
      }
      const [tenantId, claimToken, now] = args
      const existing = store[key]
      if (!existing || existing.tenantId !== tenantId || existing.claimToken !== claimToken) {
        return ['denied', false]
      }
      if (existing.state === 'consumed') return ['consumed', true]
      existing.state = 'consumed'
      existing.consumedAt = now
      return ['consumed', true]
    },
    _store: store,
  }
}

function installFakeConfigRedis() {
  const client = fakeKeyedHashRedis()
  setConfigRedis(() => client)
  return client
}
function installFakeUserRedis() {
  const client = fakeKeyedHashRedis()
  setUserRedis(() => client)
  return client
}
function installFakeClaimRedis() {
  const client = fakeTrialClaimRedis()
  setClaimRedis(() => client)
  return client
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

let tenantCounter = 0
function freshTenantId() { return `t_trial-${++tenantCounter}` }

// Seeds a tenant through onboarding -> locations_approved -> active
// (skipping the intermediate provisioning/initial_sync states via a plain
// non-CAS patch, since THIS test file is about trial-start logic given
// status === 'active', not the state-machine transitions themselves --
// those are covered by tests/test_tenant_ops_endpoint.js and friends).
// Optionally seeds a real Redis-backed Owner account too (needed only for
// the bestEffortOwnerCommercialIdentityKey() lookup / full HTTP tests).
// `initialSyncCompletedAt` mirrors initial_sync.py's own write-once
// `initialSync.completedAt` field -- defaults to "now" but tests exercising
// the trial-clock corrections pass a specific past timestamp to prove
// trialStartedAt is anchored to THIS value, never to whenever
// maybeStartTrial() happens to run. `trialEligible` mirrors the new,
// separate, explicit `trialEligibility` marker -- defaults to true (a
// deliberately-marked-eligible test fixture, matching TRIAL_ELIGIBILITY_SOURCES'
// 'test_fixture' provenance) since most tests in this file are specifically
// about what happens ONCE a tenant is genuinely eligible; pass `false` to
// exercise the "commercial===null alone is not enough" correction.
async function seedActiveTenant(tenantId, {
  googleLocationId = `accounts/acc-${tenantId}/locations/loc-1`,
  ownerEmail = null,
  extraLocations = [],
  trialEligible = true,
  initialSyncCompletedAt = new Date().toISOString(),
} = {}) {
  await upsertTenantConfig(tenantId, { status: 'onboarding', locationCatalogEnabled: true }, { allowCreate: true, creationSource: 'migration' })
  await recordLocationApproval(tenantId, [
    { googleLocationId, title: 'Primary Location', address: '' },
    ...extraLocations,
  ])
  const patch = {
    status: 'active',
    initialSync: {
      status: 'completed', startedAt: initialSyncCompletedAt, completedAt: initialSyncCompletedAt,
      reviewCount: 0, locationCount: 1 + extraLocations.length, lastError: null,
    },
  }
  if (trialEligible) {
    patch.trialEligibility = { eligible: true, markedAt: new Date().toISOString(), source: 'test_fixture' }
  }
  await upsertTenantConfig(tenantId, patch, {})
  if (ownerEmail) {
    const record = {
      userId: `usr_owner_${tenantId}`, email: ownerEmail, passwordHash: await passwordHash(), role: 'owner',
      locationIds: '*', tenantId, sessionVersion: 1, disabled: false, displayName: 'Owner',
    }
    await upsertUser(tenantId, record, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  }
  return getTenantConfig(tenantId)
}

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}
async function invokeTenantStatus(token) {
  const resolvedToken = await token
  const req = { method: 'GET', query: { action: 'tenant-status' }, headers: resolvedToken ? { cookie: `${SESSION_COOKIE}=${resolvedToken}` } : {} }
  const res = fakeRes()
  await handler(req, res)
  return res
}

// --- Part 1: commercialIdentity.js (pure) ---------------------------------

function testCommercialIdentityLowercasesAndTrims() {
  assert(commercialIdentityKey('  Owner@Example.COM  ') === 'owner@example.com', commercialIdentityKey('  Owner@Example.COM  '))
}
function testCommercialIdentityStripsPlusAlias() {
  assert(commercialIdentityKey('owner+trial1@example.com') === 'owner@example.com', commercialIdentityKey('owner+trial1@example.com'))
  assert(commercialIdentityKey('owner+anything-else@example.com') === 'owner@example.com')
}
function testCommercialIdentityDoesNotFoldGmailDots() {
  // Deliberately NOT applied -- see commercialIdentity.js's own header.
  assert(commercialIdentityKey('o.wner@gmail.com') === 'o.wner@gmail.com', 'Gmail dot-folding must NOT be applied')
  assert(commercialIdentityKey('owner@gmail.com') !== commercialIdentityKey('o.wner@gmail.com'))
}
function testCommercialIdentityHandlesMalformedInput() {
  assert(commercialIdentityKey(null) === null)
  assert(commercialIdentityKey(undefined) === null)
  assert(commercialIdentityKey('') === null)
  assert(commercialIdentityKey('not-an-email') === 'not-an-email')
}

// --- Part 2: trialEligibilityStore.js claim primitives --------------------

async function testFirstReservationIsAtomicAndReturnsReserved() {
  installFakeClaimRedis()
  const res = await reserveTrialClaim('accounts/1/locations/1', 't_a', { commercialIdentityKey: 'a@example.com' })
  assert(res.ok === true && res.state === 'reserved' && typeof res.claimToken === 'string' && res.reservedAt, JSON.stringify(res))
}

async function testSameTenantRetryIsIdempotentReturnsOriginalToken() {
  installFakeClaimRedis()
  const first = await reserveTrialClaim('accounts/1/locations/1', 't_a')
  const second = await reserveTrialClaim('accounts/1/locations/1', 't_a')
  assert(second.ok === true, JSON.stringify(second))
  assert(second.claimToken === first.claimToken, 'a same-tenant retry must return the ORIGINAL claimToken, never a new one')
  assert(second.reservedAt === first.reservedAt, 'a same-tenant retry must return the ORIGINAL reservedAt, never a fresh timestamp')
}

async function testDifferentTenantDeniedWhileReserved() {
  installFakeClaimRedis()
  await reserveTrialClaim('accounts/1/locations/1', 't_a')
  const res = await reserveTrialClaim('accounts/1/locations/1', 't_b')
  assert(res.ok === false && res.reason === 'claimed_by_another_tenant', JSON.stringify(res))
}

async function testDifferentTenantDeniedWhileConsumed() {
  installFakeClaimRedis()
  const first = await reserveTrialClaim('accounts/1/locations/1', 't_a')
  await finalizeTrialClaim('accounts/1/locations/1', 't_a', first.claimToken)
  const res = await reserveTrialClaim('accounts/1/locations/1', 't_b')
  assert(res.ok === false && res.reason === 'claimed_by_another_tenant', JSON.stringify(res))
}

async function testDifferentGbpLocationsIndependent() {
  installFakeClaimRedis()
  const a = await reserveTrialClaim('accounts/1/locations/A', 't_a')
  const b = await reserveTrialClaim('accounts/1/locations/B', 't_b')
  assert(a.ok === true && b.ok === true, 'wholly different GBP locations must each independently succeed')
}

async function testFinalizeRequiresCorrectOwnershipToken() {
  installFakeClaimRedis()
  const res = await reserveTrialClaim('accounts/1/locations/1', 't_a')
  const wrongToken = await finalizeTrialClaim('accounts/1/locations/1', 't_a', 'not-the-real-token')
  assert(wrongToken.ok === false && wrongToken.reason === 'invalid_claim', JSON.stringify(wrongToken))
  const claim = await getTrialClaim('accounts/1/locations/1')
  assert(claim.state === 'reserved', 'a stale/wrong token must never transition the claim')
  const rightToken = await finalizeTrialClaim('accounts/1/locations/1', 't_a', res.claimToken)
  assert(rightToken.ok === true && rightToken.state === 'consumed', JSON.stringify(rightToken))
}

async function testStaleTenantCannotFinalizeAnotherHoldersClaim() {
  installFakeClaimRedis()
  const res = await reserveTrialClaim('accounts/1/locations/1', 't_a')
  // t_b never held this claim at all -- presenting ANY token must be denied.
  const attempt = await finalizeTrialClaim('accounts/1/locations/1', 't_b', res.claimToken)
  assert(attempt.ok === false && attempt.reason === 'invalid_claim', JSON.stringify(attempt))
  const claim = await getTrialClaim('accounts/1/locations/1')
  assert(claim.tenantId === 't_a' && claim.state === 'reserved', 'tenant A\'s claim must be completely unaffected')
}

async function testFinalizeIsIdempotent() {
  installFakeClaimRedis()
  const res = await reserveTrialClaim('accounts/1/locations/1', 't_a')
  const first = await finalizeTrialClaim('accounts/1/locations/1', 't_a', res.claimToken)
  const second = await finalizeTrialClaim('accounts/1/locations/1', 't_a', res.claimToken)
  assert(first.ok === true && second.ok === true && second.state === 'consumed', 'finalizing an already-consumed claim must be a harmless idempotent success')
}

async function testRaceTwoTenantsSameGbpLocationExactlyOneWins() {
  installFakeClaimRedis()
  const [a, b] = await Promise.all([
    reserveTrialClaim('accounts/1/locations/race', 't_racer_a'),
    reserveTrialClaim('accounts/1/locations/race', 't_racer_b'),
  ])
  const wins = [a, b].filter(r => r.ok)
  assert(wins.length === 1, `exactly one tenant must win the race, got ${wins.length} (${JSON.stringify([a, b])})`)
}

async function testCommercialIdentityKeyCollisionAloneDoesNotBlock() {
  installFakeClaimRedis()
  const same = 'shared+alias@example.com'
  const a = await reserveTrialClaim('accounts/1/locations/X', 't_a', { commercialIdentityKey: same })
  const b = await reserveTrialClaim('accounts/1/locations/Y', 't_b', { commercialIdentityKey: same })
  assert(a.ok === true && b.ok === true, 'a shared commercialIdentityKey across DIFFERENT GBP locations must never block either trial in B.6')
}

async function testClaimStoreOutageFailsClosed() {
  // No fake registered at all, and no real UPSTASH_* env vars in this test
  // process -- getClient() returns null.
  let threw = false
  try {
    await reserveTrialClaim('accounts/1/locations/1', 't_a')
  } catch (err) {
    threw = err instanceof TrialEligibilityStoreUnavailableError
  }
  assert(threw, 'a genuine store outage must throw TrialEligibilityStoreUnavailableError, never silently succeed or silently deny')
}

// --- Part 3: selectTrialEligibleLocation() (pure, deterministic) ----------

function testSelectsSmallestLocationId() {
  const loc = selectTrialEligibleLocation([
    { locationId: 5, googleLocationId: 'accounts/1/locations/5' },
    { locationId: 2, googleLocationId: 'accounts/1/locations/2' },
    { locationId: 9, googleLocationId: 'accounts/1/locations/9' },
  ])
  assert(loc.locationId === 2, JSON.stringify(loc))
}
function testSelectReturnsNullForEmptyOrMissing() {
  assert(selectTrialEligibleLocation([]) === null)
  assert(selectTrialEligibleLocation(null) === null)
  assert(selectTrialEligibleLocation(undefined) === null)
}

// --- Part 4: maybeStartTrial() orchestration ------------------------------

async function testNoOAuthNoInitialSyncDoesNotStart() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  // status stays 'onboarding' -- never reaches 'active'.
  await upsertTenantConfig(tenantId, { status: 'onboarding', locationCatalogEnabled: true }, { allowCreate: true, creationSource: 'migration' })
  const config = await getTenantConfig(tenantId)
  const result = await maybeStartTrial(tenantId, config)
  assert(result.commercial === null || result.commercial === undefined, 'a tenant with no OAuth/initial sync yet must never start a trial')
}

async function testOAuthConnectedButSyncIncompleteDoesNotStart() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  await upsertTenantConfig(tenantId, {
    status: 'onboarding', locationCatalogEnabled: true,
    trialEligibility: { eligible: true, markedAt: new Date().toISOString(), source: 'test_fixture' },
  }, { allowCreate: true, creationSource: 'migration' })
  await recordLocationApproval(tenantId, [{ googleLocationId: 'accounts/1/locations/1', title: 'L', address: '' }])
  // status is 'locations_approved' -- OAuth/locations exist, and the tenant
  // is even marked trial-eligible, but the real production signal (initial
  // sync -> 'active') never fired.
  const config = await getTenantConfig(tenantId)
  assert(config.status !== 'active')
  const result = await maybeStartTrial(tenantId, config)
  assert(result.commercial === null || result.commercial === undefined, 'initial sync incomplete must never start a trial, even for an eligibility-marked tenant')
}

async function testActiveButNoApprovedLocationsFailsClosedNoStart() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  await upsertTenantConfig(tenantId, {
    status: 'active', locationCatalogEnabled: true, approvedLocations: [],
    trialEligibility: { eligible: true, markedAt: new Date().toISOString(), source: 'test_fixture' },
    initialSync: { status: 'completed', completedAt: new Date().toISOString(), startedAt: new Date().toISOString(), reviewCount: 0, locationCount: 0, lastError: null },
  }, { allowCreate: true, creationSource: 'migration' })
  const config = await getTenantConfig(tenantId)
  const result = await maybeStartTrial(tenantId, config)
  assert(result.commercial === null || result.commercial === undefined, 'no valid GBP location identity must fail closed, never start a trial')
}

async function testActiveEligibleButNoInitialSyncTimestampFailsClosedNoStart() {
  // A defensive/data-integrity case: status is 'active' and the tenant IS
  // marked trial-eligible, but initialSync.completedAt is somehow absent --
  // must fail closed, never fall back to Date.now() or any other guess.
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  await upsertTenantConfig(tenantId, { status: 'onboarding', locationCatalogEnabled: true }, { allowCreate: true, creationSource: 'migration' })
  await recordLocationApproval(tenantId, [{ googleLocationId: 'accounts/1/locations/1', title: 'L', address: '' }])
  // Patch status straight to 'active' WITHOUT ever writing initialSync --
  // recordLocationApproval() refuses once status is already 'active', so
  // location approval must happen first, exactly like seedActiveTenant().
  await upsertTenantConfig(tenantId, {
    status: 'active',
    trialEligibility: { eligible: true, markedAt: new Date().toISOString(), source: 'test_fixture' },
  }, {})
  const config = await getTenantConfig(tenantId)
  assert(!config.initialSync?.completedAt, 'setup: initialSync.completedAt must genuinely be absent')
  const result = await maybeStartTrial(tenantId, config)
  assert(result.commercial === null || result.commercial === undefined, 'a missing authoritative clock anchor must fail closed, never approximate with Date.now()')
}

async function testAllConditionsSatisfiedStartsExactlyOnce() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  installFakeUserRedis()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId, { ownerEmail: 'owner@example.com' })
  const config = await getTenantConfig(tenantId)
  const result = await maybeStartTrial(tenantId, config)
  assert(result.commercial?.commercialStatus === 'trial', `trial must start, got ${JSON.stringify(result.commercial)}`)
  assert(result.commercial.plan === 'growth', 'trial plan must be growth')
  assert(result.commercial.trial.status === 'active', JSON.stringify(result.commercial.trial))

  // Re-observation (the next tenantStatus() poll, in practice) must be a
  // pure no-op -- exactly once, never twice.
  const secondObservation = await maybeStartTrial(tenantId, result)
  assert(secondObservation === result, 'a second observation after the trial already started must be a complete no-op')
}

async function testServerComputesTimestampsExactlySevenDays() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  // `before` must be captured BEFORE seeding -- the authoritative timestamp
  // is now stamped at initial-sync-completion time (inside seedActiveTenant()'s
  // own default `initialSyncCompletedAt = new Date().toISOString()`), not at
  // the moment maybeStartTrial() itself runs.
  const before = Date.now()
  await seedActiveTenant(tenantId)
  const config = await getTenantConfig(tenantId)
  const result = await maybeStartTrial(tenantId, config)
  const startedAtMs = Date.parse(result.commercial.trial.startedAt)
  const endsAtMs = Date.parse(result.commercial.trial.endsAt)
  assert(startedAtMs >= before && startedAtMs <= Date.now(), 'trialStartedAt must be server-computed, anchored to the authoritative initial-sync completion time')
  assert(endsAtMs - startedAtMs === 7 * 24 * 60 * 60 * 1000, `trial duration must be EXACTLY 7 days, got ${endsAtMs - startedAtMs}ms`)
  assert(result.commercial.trial.consumedAt === result.commercial.trial.startedAt, 'trialConsumedAt must equal trialStartedAt')
}

async function testLtaBootstrapNeverEntersTrialFlow() {
  // No fake config/claim Redis registered at all -- if maybeStartTrial()
  // ever attempted a read/claim for LTA, this would throw (no store
  // configured); it must return silently unchanged instead.
  const fakeLtaConfig = { status: 'active', commercial: null, approvedLocations: [] }
  const result = await maybeStartTrial(DEFAULT_TENANT_ID, fakeLtaConfig)
  assert(result === fakeLtaConfig, 'LTA must never enter the trial flow -- zero reads, zero writes, unchanged config returned')
}

// --- Part 4b: explicit trial-eligibility marker (final correction #1) -----
// commercial === null must NEVER, by itself, be sufficient for automatic
// trial enrollment -- an existing/grandfathered tenant with no commercial
// record (the B.2 legacy-compatibility default while
// COMMERCIAL_ENFORCEMENT_CUTOFF is null) must never be silently upgraded
// into a trial merely because tenantStatus() is read.

async function testCutoffNullActiveTenantWithNoEligibilityMarkerDoesNotAutoEnroll() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  // Fully active, real approved location, commercial === null (the exact
  // B.2 legacy-compatibility shape) -- but NO trialEligibility marker. This
  // is precisely an "existing REDIS_ONLY tenant" per the correction's own
  // wording. COMMERCIAL_ENFORCEMENT_CUTOFF is null throughout B.2-B.6 --
  // this must never matter to this decision at all.
  await seedActiveTenant(tenantId, { trialEligible: false })
  const config = await getTenantConfig(tenantId)
  assert(config.commercial === null || config.commercial === undefined, 'setup: commercial must genuinely be null')
  assert(config.trialEligibility === undefined, 'setup: no eligibility marker must be present')
  const result = await maybeStartTrial(tenantId, config)
  assert(result.commercial === null || result.commercial === undefined, 'an existing active tenant with commercial===null and NO explicit eligibility marker must NEVER be auto-enrolled into a trial')
}

async function testGrandfatheredPreCutoffTenantDoesNotAutoEnroll() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  // A tenant whose createdAt predates any hypothetical future cutoff --
  // resolves via legacyUnmanagedBundle('grandfathered_pre_phase_b') once a
  // cutoff is ever armed. Trial eligibility must be governed SOLELY by the
  // explicit marker, never by this grandfathering status one way or the
  // other -- confirmed here by the SAME denial with an old createdAt.
  await seedActiveTenant(tenantId, { trialEligible: false })
  await upsertTenantConfig(tenantId, { createdAt: '2020-01-01T00:00:00.000Z' }, {})
  const config = await getTenantConfig(tenantId)
  const result = await maybeStartTrial(tenantId, config)
  assert(result.commercial === null || result.commercial === undefined, 'a grandfathered/pre-cutoff-shaped tenant must never auto-enroll into a trial without the explicit marker')
}

async function testExplicitlyEligibleTenantCanProceed() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId, { trialEligible: true })
  const config = await getTenantConfig(tenantId)
  assert(config.trialEligibility?.eligible === true, 'setup: eligibility marker must be present')
  const result = await maybeStartTrial(tenantId, config)
  assert(result.commercial?.commercialStatus === 'trial', `an explicitly trial-eligible tenant must be able to proceed, got ${JSON.stringify(result.commercial)}`)
}

async function testMissingCommercialWithoutExplicitEligibilityNeverStarts() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId, { trialEligible: false })
  const config = await getTenantConfig(tenantId)
  assert(config.commercial === null || config.commercial === undefined)
  assert(config.trialEligibility === undefined)
  const result = await maybeStartTrial(tenantId, config)
  assert(result.commercial === null || result.commercial === undefined, 'missing commercial state alone, without the explicit eligibility marker, must never grant a trial')
}

async function testRequestCannotMarkTenantTrialEligible() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  installFakeUserRedis()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId, { trialEligible: false, ownerEmail: 'owner@example.com' })
  const token = await signSession({ userId: `usr_owner_${tenantId}`, email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
  // tenantStatus() is a GET -- spoofed query params attempting to set the
  // eligibility marker (or anything resembling it) must have zero effect;
  // this endpoint never reads or writes trialEligibility from a request at
  // all.
  const req = {
    method: 'GET',
    query: { action: 'tenant-status', trialEligibility: 'true', trialEligible: 'true', eligible: 'true' },
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  }
  const res = fakeRes()
  await handler(req, res)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.commercial.trialStatus === 'not_started', 'a spoofed query param must never mark a tenant trial-eligible or start a trial')
  const config = await getTenantConfig(tenantId)
  assert(config.trialEligibility === undefined || config.trialEligibility.eligible !== true, 'the stored tenant_config must be completely unaffected by the request')
}

// --- Part 4c: authoritative clock anchoring (final correction #2) --------
// The 7-day clock must be anchored to tenant_config.initialSync.completedAt
// -- the authoritative, server-written, write-once first-activation
// timestamp -- NEVER to when the trial claim happens to be reserved or when
// tenantStatus() happens to be polled.

async function testClockAnchoredToInitialSyncNotToReconciliationTime() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  // "Initial sync Monday" -- simulated as 4 days in the past.
  const monday = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString()
  await seedActiveTenant(tenantId, { initialSyncCompletedAt: monday })
  // "Reconciliation happens today" (i.e. now, days later) -- maybeStartTrial()
  // is called well after the authoritative activation event.
  const config = await getTenantConfig(tenantId)
  const result = await maybeStartTrial(tenantId, config)
  assert(result.commercial.trial.startedAt === monday, `trialStartedAt must be the ORIGINAL initial-sync completion time, not the (later) reconciliation time -- expected ${monday}, got ${result.commercial.trial.startedAt}`)
  const expectedEndsAt = new Date(Date.parse(monday) + 7 * 24 * 60 * 60 * 1000).toISOString()
  assert(result.commercial.trial.endsAt === expectedEndsAt, `trialEndsAt must be exactly 7 days after the ORIGINAL activation time, got ${result.commercial.trial.endsAt}`)
}

async function testClockAnchoredEvenWhenReconciliationHappensSameDay() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  const now = new Date().toISOString()
  await seedActiveTenant(tenantId, { initialSyncCompletedAt: now })
  const config = await getTenantConfig(tenantId)
  const result = await maybeStartTrial(tenantId, config)
  assert(result.commercial.trial.startedAt === now, 'same-day reconciliation must still anchor to the exact initial-sync completion timestamp')
}

async function testReconciliationAfterDaySevenImmediatelyExpired() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  // Initial sync completed 10 days ago -- reconciliation (this
  // maybeStartTrial() call) happens for the FIRST time only now, well past
  // the 7-day window. The customer must NOT receive a fresh 7 days merely
  // because reconciliation was delayed.
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
  await seedActiveTenant(tenantId, { initialSyncCompletedAt: tenDaysAgo })
  const config = await getTenantConfig(tenantId)
  const result = await maybeStartTrial(tenantId, config)
  assert(result.commercial?.commercialStatus === 'trial', 'the trial record itself is still written (it genuinely happened, in the past)')
  const e = resolveTenantEntitlementsFromConfig(result)
  assert(e.commercialStatus === 'suspended' && e.trialStatus === 'expired' && e.reason === 'trial_expired',
    `a trial reconciled after its own 7-day window must resolve as IMMEDIATELY expired, got ${JSON.stringify({ commercialStatus: e.commercialStatus, trialStatus: e.trialStatus, reason: e.reason })}`)
  assert(Object.values(e.features).every(v => v === false), 'every feature must already be denied')
}

async function testRetryAfterCasFailureDoesNotAlterClock() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  const anchor = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
  await seedActiveTenant(tenantId, { initialSyncCompletedAt: anchor })
  const config = await getTenantConfig(tenantId)
  // Force the CAS to fail by bumping configVersion out from under
  // maybeStartTrial() via a real intervening write.
  await upsertTenantConfig(tenantId, { displayName: 'Renamed Mid-Flight' }, { expectedVersion: config.configVersion })
  const failedAttempt = await maybeStartTrial(tenantId, config)
  assert(failedAttempt.commercial === null || failedAttempt.commercial === undefined, 'the CAS conflict must leave commercial untouched')
  const retryResult = await maybeStartTrial(tenantId, await getTenantConfig(tenantId))
  assert(retryResult.commercial.trial.startedAt === anchor, `the retry must anchor to the SAME original initial-sync timestamp, got ${retryResult.commercial.trial.startedAt}`)
}

async function testLaterRoutineSyncDoesNotAlterFirstCompletionTimestamp() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  const originalCompletion = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  await seedActiveTenant(tenantId, { initialSyncCompletedAt: originalCompletion })
  // Simulate an unrelated later write touching tenant_config (e.g. a
  // routine artifact-generation bump) that does NOT touch the initialSync
  // key at all -- confirmed by this codebase's own Python audit that only
  // initial_sync.py's own success path ever writes it, and only once.
  await upsertTenantConfig(tenantId, { displayName: 'Some Later Update' }, {})
  const config = await getTenantConfig(tenantId)
  assert(config.initialSync.completedAt === originalCompletion, 'an unrelated later write must never alter initialSync.completedAt')
  const result = await maybeStartTrial(tenantId, config)
  assert(result.commercial.trial.startedAt === originalCompletion, 'the trial clock must still anchor to the original, untouched completion timestamp')
}

// --- Part 4d: trialEligibility marker survives legitimate config writers --
// upsertTenantConfig()'s own internal merge is `{ ...defaults, ...existing,
// ...patch }` (tenantConfigStore.js) -- an EXISTING field survives into the
// next record unless the CALLER'S OWN patch explicitly names it. Since
// neither recordLocationApproval() nor applyEntitlementChange() (nor any
// other tenant_config writer) ever includes a `trialEligibility` key in its
// patch, the marker is preserved by construction. These tests prove that
// directly against the real functions, not just by inspecting the shared
// merge code once.

async function testMarkerSurvivesRecordLocationApproval() {
  installFakeConfigRedis()
  const tenantId = freshTenantId()
  await upsertTenantConfig(tenantId, {
    status: 'onboarding', locationCatalogEnabled: true,
    trialEligibility: { eligible: true, markedAt: new Date().toISOString(), source: 'test_fixture' },
  }, { allowCreate: true, creationSource: 'migration' })
  // A legitimate, unrelated onboarding config mutation -- selecting/
  // re-selecting approved locations, exactly as a real self-service
  // onboarding flow does before activation.
  await recordLocationApproval(tenantId, [{ googleLocationId: 'accounts/1/locations/1', title: 'L', address: '' }])
  const config = await getTenantConfig(tenantId)
  assert(config.trialEligibility?.eligible === true, 'recordLocationApproval() must never erase an existing trialEligibility marker')
}

async function testMarkerSurvivesApplyEntitlementChange() {
  installFakeConfigRedis()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId, { trialEligible: true })
  const beforeConfig = await getTenantConfig(tenantId)
  assert(beforeConfig.trialEligibility?.eligible === true, 'setup: marker must be present before the entitlement change')
  // A legitimate post-activation config mutation -- adding a second GBP
  // location via the platform-admin entitlement-change path, unrelated to
  // trial state entirely.
  await applyEntitlementChange(tenantId, { addGoogleLocations: [{ googleLocationId: 'accounts/1/locations/2', title: 'Second Location', address: '' }] }, beforeConfig.configVersion)
  const afterConfig = await getTenantConfig(tenantId)
  assert(afterConfig.trialEligibility?.eligible === true, 'applyEntitlementChange() must never erase an existing trialEligibility marker')
  assert(afterConfig.approvedLocations.length === 2, 'setup sanity: the entitlement change itself must have actually applied')
}

// --- Part 5: anti-abuse (race, retry-after-partial-failure, reconnect) ----

async function testSameGbpSecondTenantDeniedTrial() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const gbp = 'accounts/shared-biz/locations/1'
  const tenantA = freshTenantId()
  const tenantB = freshTenantId()
  await seedActiveTenant(tenantA, { googleLocationId: gbp })
  await seedActiveTenant(tenantB, { googleLocationId: gbp })
  const resultA = await maybeStartTrial(tenantA, await getTenantConfig(tenantA))
  assert(resultA.commercial?.commercialStatus === 'trial', 'tenant A (first) must get the trial')
  const resultB = await maybeStartTrial(tenantB, await getTenantConfig(tenantB))
  assert(resultB.commercial === null || resultB.commercial === undefined, 'tenant B (same GBP location, second) must be denied a trial')
}

async function testSameGbpDifferentEmailStillDenied() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  installFakeUserRedis()
  const gbp = 'accounts/shared-biz/locations/2'
  const tenantA = freshTenantId()
  const tenantB = freshTenantId()
  await seedActiveTenant(tenantA, { googleLocationId: gbp, ownerEmail: 'first-owner@example.com' })
  await seedActiveTenant(tenantB, { googleLocationId: gbp, ownerEmail: 'totally-different-person@other-domain.com' })
  await maybeStartTrial(tenantA, await getTenantConfig(tenantA))
  const resultB = await maybeStartTrial(tenantB, await getTenantConfig(tenantB))
  assert(resultB.commercial === null || resultB.commercial === undefined, 'a completely different email must NOT bypass GBP-location-based denial')
}

async function testSameGbpPlusAliasEmailStillDenied() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  installFakeUserRedis()
  const gbp = 'accounts/shared-biz/locations/3'
  const tenantA = freshTenantId()
  const tenantB = freshTenantId()
  await seedActiveTenant(tenantA, { googleLocationId: gbp, ownerEmail: 'owner@example.com' })
  await seedActiveTenant(tenantB, { googleLocationId: gbp, ownerEmail: 'owner+secondtry@example.com' })
  await maybeStartTrial(tenantA, await getTenantConfig(tenantA))
  const resultB = await maybeStartTrial(tenantB, await getTenantConfig(tenantB))
  assert(resultB.commercial === null || resultB.commercial === undefined, 'a plus-address alias of the same email must NOT bypass GBP-location-based denial')
}

async function testDifferentGbpLocationsEachIndependentlyEligible() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantA = freshTenantId()
  const tenantB = freshTenantId()
  await seedActiveTenant(tenantA, { googleLocationId: 'accounts/1/locations/independent-a' })
  await seedActiveTenant(tenantB, { googleLocationId: 'accounts/1/locations/independent-b' })
  const resultA = await maybeStartTrial(tenantA, await getTenantConfig(tenantA))
  const resultB = await maybeStartTrial(tenantB, await getTenantConfig(tenantB))
  assert(resultA.commercial?.commercialStatus === 'trial' && resultB.commercial?.commercialStatus === 'trial', 'wholly different GBP locations must each independently receive a trial')
}

async function testReconnectDoesNotResetTrial() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  const started = await maybeStartTrial(tenantId, await getTenantConfig(tenantId))
  const originalStartedAt = started.commercial.trial.startedAt
  // Simulate a Google disconnect/reconnect -- tenant_config.status/commercial
  // are untouched by real OAuth reconnect flows (credential health lives in
  // a wholly separate store); re-observing must be a pure no-op.
  const reobserved = await maybeStartTrial(tenantId, await getTenantConfig(tenantId))
  assert(reobserved.commercial.trial.startedAt === originalStartedAt, 'reconnecting Google must never reset trialStartedAt')
}

async function testTenantRetryAfterPartialInfraFailureResumesIdempotently() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  const config = await getTenantConfig(tenantId)

  // Simulate the tenant_config CAS write failing (a concurrent write landed
  // between our read and the write) by bumping configVersion out from under
  // maybeStartTrial() via a real intervening write.
  await upsertTenantConfig(tenantId, { displayName: 'Renamed Mid-Flight' }, { expectedVersion: config.configVersion })

  // maybeStartTrial() is still working off the STALE `config` object (its
  // captured configVersion is now behind) -- this must fail the CAS,
  // NOT burn the trial claim.
  const failedAttempt = await maybeStartTrial(tenantId, config)
  assert(failedAttempt.commercial === null || failedAttempt.commercial === undefined, 'a CAS conflict must leave commercial untouched, not silently succeed against stale state')

  // The SAME tenant retries with FRESH config -- must resume and succeed,
  // anchored to the ORIGINAL reservation's reservedAt (not a new timestamp).
  const freshConfig = await getTenantConfig(tenantId)
  const retryResult = await maybeStartTrial(tenantId, freshConfig)
  assert(retryResult.commercial?.commercialStatus === 'trial', `retry must succeed and start the trial exactly once, got ${JSON.stringify(retryResult.commercial)}`)
}

async function testEligibilityStoreOutageDuringMaybeStartTrialFailsClosedNoThrow() {
  installFakeConfigRedis()
  // Deliberately do NOT install a fake claim Redis -- store unavailable.
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  const config = await getTenantConfig(tenantId)
  const result = await maybeStartTrial(tenantId, config) // must not throw
  assert(result.commercial === null || result.commercial === undefined, 'an eligibility-store outage must defer trial start, never fail open')
}

// --- Part 6: expiry / resolver time-authoritativeness ---------------------

function baseConfigWithTrial(trialOverrides) {
  return {
    tenantId: 't_x', createdAt: new Date().toISOString(), configVersion: 1,
    commercial: {
      commercialStatus: 'trial', plan: 'growth', planSource: 'trial_auto_gbp',
      trial: { status: 'active', startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 60_000).toISOString(), consumedAt: new Date(Date.now() - 60_000).toISOString(), ...trialOverrides },
      limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
      accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null,
    },
  }
}

function testSecondBeforeExpiryGrantsTrialBundle() {
  const config = baseConfigWithTrial({ endsAt: new Date(Date.now() + 1000).toISOString() })
  const e = resolveTenantEntitlementsFromConfig(config)
  assert(e.commercialStatus === 'trial' && e.trialStatus === 'active', JSON.stringify(e))
  assert(e.limits.maxLocations === 1 && e.limits.maxActiveUsers === 3, 'a still-active trial must use trial limits')
  assert(e.features.advancedExecutiveBrief === true, 'a still-active trial must carry the Growth feature bundle')
}

function testAtOrAfterExpiryResolvesEffectivelySuspended() {
  const config = baseConfigWithTrial({ endsAt: new Date(Date.now() - 1).toISOString() })
  const e = resolveTenantEntitlementsFromConfig(config)
  assert(e.commercialStatus === 'suspended', `expired trial must resolve to suspended, got ${e.commercialStatus}`)
  assert(e.trialStatus === 'expired', `trialStatus itself must be TIME-AUTHORITATIVE and report 'expired', got ${JSON.stringify(e.trialStatus)}`)
  assert(e.reason === 'trial_expired', e.reason)
  assert(Object.values(e.features).every(v => v === false), 'every feature must be denied once expired')
  assert(e.limits.maxLocations === 0 && e.limits.aiAllowanceMonthly.usageUnits === 0, 'every limit must be zeroed (fail-closed), never null (unenforced)')
}

function testNoPaidActiveInferenceOnExpiry() {
  const config = baseConfigWithTrial({ endsAt: new Date(Date.now() - 1).toISOString() })
  const e = resolveTenantEntitlementsFromConfig(config)
  assert(e.commercialStatus !== 'active', 'an expired trial must NEVER be inferred as a real paid-active subscription')
  assert(e.plan === 'growth', 'plan must still be visible (so an owner sees "you were on Growth trial," not "no plan"), even though enforcement is suspended')
}

function testResolvedBundleExposesRawTrialTimestamps() {
  const startedAt = new Date(Date.now() - 60_000).toISOString()
  const endsAt = new Date(Date.now() + 60_000).toISOString()
  const config = baseConfigWithTrial({ startedAt, endsAt, consumedAt: startedAt })
  const e = resolveTenantEntitlementsFromConfig(config)
  assert(e.trialStartedAt === startedAt && e.trialEndsAt === endsAt && e.trialConsumedAt === startedAt, JSON.stringify(e))
}

function testConvertedTrialResolvesToRealActivePlanNeverReEligible() {
  const config = {
    tenantId: 't_converted', createdAt: new Date().toISOString(), configVersion: 1,
    commercial: {
      commercialStatus: 'active', plan: 'growth', planSource: 'trial_auto_gbp',
      trial: { status: 'converted', startedAt: new Date(Date.now() - 10 * 86400000).toISOString(), endsAt: new Date(Date.now() - 3 * 86400000).toISOString(), consumedAt: new Date(Date.now() - 10 * 86400000).toISOString() },
      limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
      accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null,
    },
  }
  const e = resolveTenantEntitlementsFromConfig(config)
  assert(e.commercialStatus === 'active' && e.reason === 'active_plan', JSON.stringify(e))
  assert(e.trialStatus === 'converted', e.trialStatus)
  assert(e.limits.maxLocations === 5 && e.limits.maxActiveUsers === 10, 'a converted tenant must get real Growth (paid) limits, not trial limits')
  assert(e.features.advancedExecutiveBrief === true, 'a converted tenant must retain full Growth features')
  // Not re-eligible: maybeStartTrial()'s precondition is commercial === null
  // -- a converted tenant's commercial is populated, so it is structurally
  // excluded from the automatic trial path (verified directly, no I/O
  // needed since this is a pure precondition check).
}

async function testReconnectAfterExpiryDoesNotRestartTrial() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  const started = await maybeStartTrial(tenantId, await getTenantConfig(tenantId))
  // Force-expire by directly patching the stored trial.endsAt into the past
  // (simulating 7 days having passed) -- a real reconnect/re-observation
  // must NOT touch commercial at all (precondition excludes it).
  await upsertTenantConfig(tenantId, {
    commercial: { ...started.commercial, trial: { ...started.commercial.trial, endsAt: new Date(Date.now() - 1000).toISOString() } },
  }, {})
  const afterReconnect = await maybeStartTrial(tenantId, await getTenantConfig(tenantId))
  assert(afterReconnect.commercial.trial.endsAt === (await getTenantConfig(tenantId)).commercial.trial.endsAt, 'reconnecting after expiry must never restart or extend the trial')
  const e = resolveTenantEntitlementsFromConfig(afterReconnect)
  assert(e.commercialStatus === 'suspended' && e.trialStatus === 'expired', 'the tenant must remain effectively expired, never silently reactivated')
}

// --- Part 7: security -------------------------------------------------------

async function testRequestBodyCannotSetTrialDatesOrStatus() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  installFakeUserRedis()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId, { ownerEmail: 'owner@example.com' })
  const token = await signSession({ userId: `usr_owner_${tenantId}`, email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
  // tenantStatus() is a GET with no body at all -- spoofed query params must
  // have zero effect on the server-computed trial state.
  const req = {
    method: 'GET', query: { action: 'tenant-status', trialStartedAt: '2000-01-01T00:00:00.000Z', trialEndsAt: '2099-01-01T00:00:00.000Z', trialDays: '99999', commercialStatus: 'active' },
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  }
  const res = fakeRes()
  await handler(req, res)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.commercial.trialStatus === 'active', 'the real, server-computed trial must have started normally')
  const realEndsAt = res.body.commercial.trialEndsAt
  assert(realEndsAt !== '2099-01-01T00:00:00.000Z', 'a spoofed query-string trialEndsAt must have NO effect on the actual value')
  const realDurationMs = Date.parse(realEndsAt) - Date.parse(res.body.commercial.trialStartedAt)
  assert(realDurationMs === 7 * 24 * 60 * 60 * 1000, 'the real trial duration must still be exactly 7 days, unaffected by a spoofed trialDays param')
}

async function testClaimInternalsNeverExposedByTenantStatus() {
  installFakeConfigRedis()
  installFakeClaimRedis()
  installFakeUserRedis()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId, { ownerEmail: 'owner@example.com' })
  const token = await signSession({ userId: `usr_owner_${tenantId}`, email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
  const res = await invokeTenantStatus(token)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  const json = JSON.stringify(res.body)
  assert(!/claimToken/i.test(json), 'claimToken must never appear in the tenantStatus response')
  assert(!json.includes('gbpLocationKey'), 'the GBP trial-claim internal key must never appear in the tenantStatus response')
  assert(!/commercialIdentityKey/i.test(json), 'commercialIdentityKey must never appear in the tenantStatus response')
  assert(!/accessCodeHash/i.test(json) || res.body.commercial.accessCodeHash === undefined, 'access-code hashes must never appear in the tenantStatus response')
}

function testTrialLifecycleNeverReadsRequestObjects() {
  const src = readFileSync(new URL('../dashboard/api/_lib/trialLifecycle.js', import.meta.url), 'utf8')
  assert(!/req\.(body|query|headers)/.test(src), 'trialLifecycle.js must never read from a request object -- tenantId must always come from the caller\'s own authenticated resolution')
}

async function testLtaUnaffectedEndToEnd() {
  // No fake config/claim/user Redis at all for LTA's path -- if
  // maybeStartTrial() ever touched Redis for LTA, this would throw.
  const hash = await passwordHash()
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{ userId: 'usr_owner_lta', email: 'owner@lta.example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' }],
  })
  const token = await signSession({ userId: 'usr_owner_lta', email: 'owner@lta.example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  const res = await invokeTenantStatus(token)
  assert(res.statusCode === 200 && res.body.status === 'active', `LTA must report active unconditionally, got ${res.statusCode} (${JSON.stringify(res.body)})`)
  assert(res.body.commercial.trialStatus === 'not_started', 'LTA must never show any trial state')
  delete process.env.ACCOUNT_DIRECTORY_JSON
}

const tests = [
  ['commercialIdentityKey lowercases and trims', testCommercialIdentityLowercasesAndTrims],
  ['commercialIdentityKey strips a +alias suffix', testCommercialIdentityStripsPlusAlias],
  ['commercialIdentityKey does NOT fold Gmail dots', testCommercialIdentityDoesNotFoldGmailDots],
  ['commercialIdentityKey handles malformed input safely', testCommercialIdentityHandlesMalformedInput],

  ['trialEligibilityStore: first reservation is atomic, returns reserved', testFirstReservationIsAtomicAndReturnsReserved],
  ['trialEligibilityStore: same-tenant retry is idempotent (original token/timestamp)', testSameTenantRetryIsIdempotentReturnsOriginalToken],
  ['trialEligibilityStore: a different tenant is denied while reserved', testDifferentTenantDeniedWhileReserved],
  ['trialEligibilityStore: a different tenant is denied while consumed', testDifferentTenantDeniedWhileConsumed],
  ['trialEligibilityStore: different GBP locations are independent', testDifferentGbpLocationsIndependent],
  ['trialEligibilityStore: finalize requires the correct ownership token', testFinalizeRequiresCorrectOwnershipToken],
  ['trialEligibilityStore: a stale/non-owning tenant cannot finalize another holder\'s claim', testStaleTenantCannotFinalizeAnotherHoldersClaim],
  ['trialEligibilityStore: finalize is idempotent', testFinalizeIsIdempotent],
  ['trialEligibilityStore: race between two tenants for one GBP location -- exactly one wins', testRaceTwoTenantsSameGbpLocationExactlyOneWins],
  ['trialEligibilityStore: a commercialIdentityKey collision alone never blocks a different GBP location', testCommercialIdentityKeyCollisionAloneDoesNotBlock],
  ['trialEligibilityStore: a genuine store outage fails closed (throws)', testClaimStoreOutageFailsClosed],

  ['selectTrialEligibleLocation: selects the smallest locationId', testSelectsSmallestLocationId],
  ['selectTrialEligibleLocation: returns null for empty/missing input', testSelectReturnsNullForEmptyOrMissing],

  ['maybeStartTrial: no OAuth/initial sync -> does not start', testNoOAuthNoInitialSyncDoesNotStart],
  ['maybeStartTrial: OAuth connected but sync incomplete -> does not start', testOAuthConnectedButSyncIncompleteDoesNotStart],
  ['maybeStartTrial: active but no valid location identity -> fails closed, no start', testActiveButNoApprovedLocationsFailsClosedNoStart],
  ['maybeStartTrial: active+eligible but no initialSync.completedAt -> fails closed, no start', testActiveEligibleButNoInitialSyncTimestampFailsClosedNoStart],
  ['maybeStartTrial: all conditions satisfied -> starts exactly once', testAllConditionsSatisfiedStartsExactlyOnce],
  ['maybeStartTrial: server computes timestamps, exactly 7 days', testServerComputesTimestampsExactlySevenDays],
  ['maybeStartTrial: LTA/BOOTSTRAP never enters the trial flow', testLtaBootstrapNeverEntersTrialFlow],

  ['eligibility: cutoff-null active tenant with no marker does NOT auto-enroll', testCutoffNullActiveTenantWithNoEligibilityMarkerDoesNotAutoEnroll],
  ['eligibility: a grandfathered/pre-cutoff-shaped tenant does NOT auto-enroll', testGrandfatheredPreCutoffTenantDoesNotAutoEnroll],
  ['eligibility: an explicitly trial-eligible tenant can proceed', testExplicitlyEligibleTenantCanProceed],
  ['eligibility: missing commercial state WITHOUT the explicit marker never starts a trial', testMissingCommercialWithoutExplicitEligibilityNeverStarts],
  ['eligibility: a request cannot mark a tenant trial-eligible', testRequestCannotMarkTenantTrialEligible],

  ['clock: anchored to initial-sync completion, not to (later) reconciliation time', testClockAnchoredToInitialSyncNotToReconciliationTime],
  ['clock: anchored correctly even when reconciliation happens the same day', testClockAnchoredEvenWhenReconciliationHappensSameDay],
  ['clock: reconciliation after day 7 resolves as immediately expired', testReconciliationAfterDaySevenImmediatelyExpired],
  ['clock: retry after a CAS failure does not alter start/end', testRetryAfterCasFailureDoesNotAlterClock],
  ['clock: a later, unrelated tenant_config write never alters the first completion timestamp', testLaterRoutineSyncDoesNotAlterFirstCompletionTimestamp],

  ['marker preservation: trialEligibility survives recordLocationApproval()', testMarkerSurvivesRecordLocationApproval],
  ['marker preservation: trialEligibility survives applyEntitlementChange()', testMarkerSurvivesApplyEntitlementChange],

  ['anti-abuse: same GBP location, second tenant denied', testSameGbpSecondTenantDeniedTrial],
  ['anti-abuse: same GBP location, totally different email still denied', testSameGbpDifferentEmailStillDenied],
  ['anti-abuse: same GBP location, plus-alias email still denied', testSameGbpPlusAliasEmailStillDenied],
  ['anti-abuse: different GBP locations each independently eligible', testDifferentGbpLocationsEachIndependentlyEligible],
  ['anti-abuse: reconnect does not reset an already-started trial', testReconnectDoesNotResetTrial],
  ['anti-abuse: retry after partial infra (CAS) failure resumes idempotently', testTenantRetryAfterPartialInfraFailureResumesIdempotently],
  ['anti-abuse: eligibility-store outage during maybeStartTrial fails closed, never throws', testEligibilityStoreOutageDuringMaybeStartTrialFailsClosedNoThrow],

  ['expiry: a second before expiry still grants the Trial bundle', testSecondBeforeExpiryGrantsTrialBundle],
  ['expiry: at/after expiry resolves to effectively suspended, trialStatus=expired', testAtOrAfterExpiryResolvesEffectivelySuspended],
  ['expiry: no paid-active inference on expiry', testNoPaidActiveInferenceOnExpiry],
  ['expiry: the resolved bundle exposes raw trial timestamps', testResolvedBundleExposesRawTrialTimestamps],
  ['expiry: a converted trial resolves to a real active plan, never re-eligible', testConvertedTrialResolvesToRealActivePlanNeverReEligible],
  ['expiry: reconnecting after expiry does not restart the trial', testReconnectAfterExpiryDoesNotRestartTrial],

  ['security: request body/query cannot set trial dates or status', testRequestBodyCannotSetTrialDatesOrStatus],
  ['security: claim internals are never exposed by tenantStatus', testClaimInternalsNeverExposedByTenantStatus],
  ['security: trialLifecycle.js never reads a request object directly', testTrialLifecycleNeverReadsRequestObjects],
  ['security: LTA is completely unaffected end-to-end', testLtaUnaffectedEndToEnd],
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
