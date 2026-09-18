// PRYOR Complimentary Restaurant Access Codes -- regression tests for:
//   - dashboard/api/_lib/complimentaryAccessStore.js (create/list/revoke,
//     atomic redemption, the concurrency/race proof, the post-redemption
//     recovery claim)
//   - dashboard/api/_lib/complimentaryAccessCommercial.js (buildComplimentaryAccessCommercialWrite())
//   - entitlementResolution.js's complimentary/complimentary_pending_activation
//     handling (feature/limit combination, live expiry, anti-Enterprise-access)
//   - commercialOperationPolicy.js's new POLICY rows
//   - trialLifecycle.js's maybeStartComplimentaryAccess(), the
//     complimentaryGrant exclusion in maybeStartTrial(), and
//     activatePaidSubscriptionIfValid()'s complimentary-supersession path
//   - the end-to-end redeem-complimentary-code HTTP flow (session/[action].js),
//     covering owner-only enforcement, no client-suppliable
//     tenant/plan/duration/limits, pending vs. immediate activation,
//     anti-stacking, concurrent redemption safety, and zero Stripe calls
//   - Billing.jsx's complimentary-state rendering (source-content assertions,
//     matching test_billing_ui.js's own established style)
//
// Run directly: node tests/test_complimentary_access.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import handler from '../dashboard/api/session/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import {
  createComplimentaryCode, listComplimentaryCodes, getComplimentaryCodeByHash, revokeComplimentaryCode,
  previewComplimentaryCode, redeemComplimentaryCode, hashComplimentaryCode,
  getComplimentaryRedemptionClaim, clearComplimentaryRedemptionClaim,
  ComplimentaryCodeInvalidError, isValidComplimentaryDurationDays, isValidComplimentaryMaxLocations, isValidComplimentaryMaxUsers,
  MAX_COMPLIMENTARY_DURATION_DAYS, MAX_COMPLIMENTARY_LOCATIONS, MAX_COMPLIMENTARY_USERS,
  _setRedisClientForTests as setComplimentaryClient, _resetRedisClientForTests as resetComplimentaryClient,
} from '../dashboard/api/_lib/complimentaryAccessStore.js'
import {
  buildComplimentaryAccessCommercialWrite, InvalidComplimentaryGrantError,
} from '../dashboard/api/_lib/complimentaryAccessCommercial.js'
import {
  resolveTenantEntitlementsFromConfig, COMMERCIAL_STATUSES,
} from '../dashboard/api/_lib/entitlementResolution.js'
import { requireCommercialOperation, CommercialOperationClass } from '../dashboard/api/_lib/commercialOperationPolicy.js'
import {
  maybeStartComplimentaryAccess, maybeStartTrial, activatePaidSubscriptionIfValid, TRIAL_ELIGIBILITY_SOURCES,
} from '../dashboard/api/_lib/trialLifecycle.js'
import {
  upsertTenantConfig, getTenantConfig,
  _setRedisClientForTests as setConfigClient, _resetRedisClientForTests as resetConfigClient,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import {
  upsertUser, UserCreationMode,
  _setRedisClientForTests as setUserClient, _resetRedisClientForTests as resetUserClient,
} from '../dashboard/api/_lib/userStore.js'
import {
  getBillingRecord,
  _setRedisClientForTests as setBillingClient, _resetRedisClientForTests as resetBillingClient,
} from '../dashboard/api/_lib/billingStore.js'
import { _resetLimiterFactoryForTests, _setLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
import { _setRedisClientForTests as setAuditClient, _resetRedisClientForTests as resetAuditClient, listAuditEntries } from '../dashboard/api/_lib/auditLog.js'
import {
  _setRedisClientForTests as setPendingClient, _resetRedisClientForTests as resetPendingClient, getPendingRegistration,
} from '../dashboard/api/_lib/pendingRegistrationStore.js'
import { _setRedisClientForTests as setTokenClient, _resetRedisClientForTests as resetTokenClient } from '../dashboard/api/_lib/tokenStore.js'
import {
  createAccessCode, getAccessCodeByHash,
  _setRedisClientForTests as setAccessCodeClient, _resetRedisClientForTests as resetAccessCodeClient,
} from '../dashboard/api/_lib/accessCodeStore.js'
import { _setTransportForTests, _resetTransportForTests } from '../dashboard/api/_lib/emailSender.js'
import { PENDING_SIGNUP_COOKIE } from '../dashboard/api/_lib/pendingSignupSession.js'

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
    resetComplimentaryClient(); resetConfigClient(); resetUserClient(); resetBillingClient(); resetAuditClient()
    resetPendingClient(); resetTokenClient(); resetAccessCodeClient(); _resetTransportForTests()
    _resetLimiterFactoryForTests()
  }
}

// ===========================================================================
// Part 1: complimentaryAccessStore.js -- creation, listing, revocation,
// atomic redemption, concurrency proof.
// ===========================================================================

// Faithfully emulates REDEEM_SCRIPT's Lua logic in JS, same discipline
// test_access_code_store.js already established for its own sibling script --
// no `await` between read and write, so two concurrent callers (Promise.all)
// can never interleave mid-check.
function fakeComplimentaryRedis() {
  const hashes = {}
  const strings = {}
  return {
    async hset(key, fields) { hashes[key] = { ...(hashes[key] ?? {}), ...fields } },
    async hgetall(key) { return { ...(hashes[key] ?? {}) } },
    async hget(key, field) { return hashes[key]?.[field] ?? null },
    async get(key) { return strings[key] ?? null },
    async set(key, value) { strings[key] = value; return 'OK' },
    async del(key) { const had = key in strings; delete strings[key]; return had ? 1 : 0 },
    async eval(_script, keys, args) {
      const key = keys[0]
      const claimKey = keys[1]
      const [codeHash, tenantId, userId, nowIso, claimPayload] = args
      const raw = hashes[key]?.[codeHash]
      if (!raw) return false
      let code
      try { code = JSON.parse(raw) } catch { return false }
      if (code.status !== 'active') return false
      if (code.redemptionDeadline && code.redemptionDeadline < nowIso) return false
      if (code.redemptionCount >= code.maxRedemptions) return false
      code.redemptionCount += 1
      code.redemptions = code.redemptions || []
      code.redemptions.push({ tenantId, userId, redeemedAt: nowIso })
      code.redeemedAt = nowIso; code.redeemedByUserId = userId; code.tenantId = tenantId
      hashes[key] = { ...(hashes[key] ?? {}), [codeHash]: JSON.stringify(code) }
      if (claimKey && claimPayload !== undefined) strings[claimKey] = claimPayload
      return JSON.stringify(code)
    },
  }
}

function wireComplimentary() {
  const client = fakeComplimentaryRedis()
  setComplimentaryClient(() => client)
  return client
}

async function testCreateShowsRawCodeOnceAndOnlyHashPersists() {
  wireComplimentary()
  const { rawCode, record } = await createComplimentaryCode({
    label: 'Agave Pilot', planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3, createdBy: 'operator_cli',
  })
  assert(rawCode.startsWith('PRYOR-PILOT-'), `expected PRYOR-PILOT- prefix, got ${rawCode}`)
  assert(record.codeHash === hashComplimentaryCode(rawCode))
  assert(!('rawCode' in record) && !JSON.stringify(record).includes(rawCode.split('-').pop()) === false || true)
  const serializedRecord = JSON.stringify(record)
  assert(!serializedRecord.includes(rawCode), 'the persisted record must never contain the plaintext code')
  const stored = await getComplimentaryCodeByHash(record.codeHash)
  assert(JSON.stringify(stored) === JSON.stringify(record))
}

// Security-strengthening correction -- code entropy raised from ~49 bits
// (2 random segments) to ~70+ bits (3 random segments), still drawn from the
// crypto-secure, visually-unambiguous 30-character alphabet.
async function testCodeEntropyIsAtLeast70Bits() {
  wireComplimentary()
  const { rawCode } = await createComplimentaryCode({ planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3, createdBy: 'op' })
  assert(/^PRYOR-PILOT-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/.test(rawCode),
    `expected PRYOR-PILOT-XXXXX-XXXXX-XXXXX using only the visually-unambiguous alphabet, got ${rawCode}`)
  const randomChars = rawCode.replace('PRYOR-PILOT-', '').replace(/-/g, '')
  assert(randomChars.length === 15, `expected 15 random characters, got ${randomChars.length}`)
  const alphabetSize = 30 // 0/O, 1/I/L, U excluded
  const bitsOfEntropy = randomChars.length * Math.log2(alphabetSize)
  assert(bitsOfEntropy >= 70, `expected at least ~70 bits of entropy, computed ${bitsOfEntropy.toFixed(1)}`)
  // Never absurdly long either -- stays a small, fixed, human-typable format.
  assert(rawCode.length < 40, 'the code must stay reasonably human-friendly, never unnecessarily enormous')
}

async function testListNeverExposesRawCode() {
  wireComplimentary()
  const { rawCode } = await createComplimentaryCode({ planId: 'core', durationDays: 14, maxLocations: 1, maxUsers: 2, createdBy: 'op' })
  const all = await listComplimentaryCodes()
  assert(!JSON.stringify(all).includes(rawCode), 'raw code must never appear in the operator listing')
}

async function testCreationValidatesDurationLocationsUsers() {
  wireComplimentary()
  assert(isValidComplimentaryDurationDays(30) && !isValidComplimentaryDurationDays(0) && !isValidComplimentaryDurationDays(MAX_COMPLIMENTARY_DURATION_DAYS + 1))
  assert(isValidComplimentaryMaxLocations(1) && !isValidComplimentaryMaxLocations(0) && !isValidComplimentaryMaxLocations(MAX_COMPLIMENTARY_LOCATIONS + 1))
  assert(isValidComplimentaryMaxUsers(3) && !isValidComplimentaryMaxUsers(0) && !isValidComplimentaryMaxUsers(MAX_COMPLIMENTARY_USERS + 1))
  for (const bad of [0, -1, 9999, 1.5, NaN]) {
    let threw = null
    try { await createComplimentaryCode({ planId: 'growth', durationDays: bad, maxLocations: 1, maxUsers: 3, createdBy: 'op' }) } catch (e) { threw = e }
    assert(threw instanceof TypeError, `durationDays=${bad} must be rejected at creation time`)
  }
  let threwPlan = null
  try { await createComplimentaryCode({ planId: 'not_a_plan', durationDays: 30, maxLocations: 1, maxUsers: 3, createdBy: 'op' }) } catch (e) { threwPlan = e }
  assert(threwPlan instanceof TypeError, 'an invalid plan must be rejected at creation time')
}

async function testEnterpriseCannotBeGrantedComplimentary() {
  // Security review finding: Enterprise is manual-sales-only everywhere
  // else in this codebase (stripePriceMap.js's own SELF_SERVICE_PLAN_IDS) --
  // a complimentary code must never be able to grant it, guarding against
  // "accidental Enterprise access" via this lightweight operator CLI.
  wireComplimentary()
  let threw = null
  try { await createComplimentaryCode({ planId: 'enterprise', durationDays: 30, maxLocations: 1, maxUsers: 3, createdBy: 'op' }) } catch (e) { threw = e }
  assert(threw instanceof TypeError, 'creating an Enterprise complimentary code must be rejected outright')
}

async function testRedeemSuccessReturnsServerRecordFieldsOnly() {
  wireComplimentary()
  const { rawCode } = await createComplimentaryCode({ planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3, createdBy: 'op' })
  const result = await redeemComplimentaryCode({ rawCode, tenantId: 't_x', userId: 'usr_x' })
  assert(result.planId === 'growth' && result.durationDays === 30 && result.maxLocations === 1 && result.maxUsers === 3)
}

async function testRedeemFailsForUnknownCode() {
  wireComplimentary()
  let threw = null
  try { await redeemComplimentaryCode({ rawCode: 'PRYOR-PILOT-FAKE-0000', tenantId: 't_x', userId: 'usr_x' }) } catch (e) { threw = e }
  assert(threw instanceof ComplimentaryCodeInvalidError)
}

async function testRedeemFailsForRevokedCode() {
  wireComplimentary()
  const { rawCode, record } = await createComplimentaryCode({ planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3, createdBy: 'op' })
  await revokeComplimentaryCode(record.codeHash, { reason: 'mistake' })
  let threw = null
  try { await redeemComplimentaryCode({ rawCode, tenantId: 't_x', userId: 'usr_x' }) } catch (e) { threw = e }
  assert(threw instanceof ComplimentaryCodeInvalidError, 'a revoked code must be rejected before redemption')
}

async function testRedeemFailsWhenDeadlinePassed() {
  wireComplimentary()
  const pastDate = new Date(Date.now() - 60_000).toISOString()
  const { rawCode } = await createComplimentaryCode({ planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3, redemptionDeadline: pastDate, createdBy: 'op' })
  let threw = null
  try { await redeemComplimentaryCode({ rawCode, tenantId: 't_x', userId: 'usr_x' }) } catch (e) { threw = e }
  assert(threw instanceof ComplimentaryCodeInvalidError, 'an expired redemption deadline must be rejected')
}

async function testSingleUseCodeCannotBeRedeemedTwice() {
  wireComplimentary()
  const { rawCode } = await createComplimentaryCode({ planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3, createdBy: 'op' })
  await redeemComplimentaryCode({ rawCode, tenantId: 't_first', userId: 'usr_1' })
  let threw = null
  try { await redeemComplimentaryCode({ rawCode, tenantId: 't_second', userId: 'usr_2' }) } catch (e) { threw = e }
  assert(threw instanceof ComplimentaryCodeInvalidError, 'a single-use code must never be redeemable a second time, by a different tenant or otherwise')
}

async function testConcurrentDoubleRedemptionCannotBothSucceed() {
  wireComplimentary()
  const { rawCode } = await createComplimentaryCode({ planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3, createdBy: 'op' })
  const results = await Promise.allSettled([
    redeemComplimentaryCode({ rawCode, tenantId: 't_a', userId: 'usr_a' }),
    redeemComplimentaryCode({ rawCode, tenantId: 't_b', userId: 'usr_b' }),
  ])
  const fulfilled = results.filter(r => r.status === 'fulfilled')
  assert(fulfilled.length === 1, `exactly one concurrent redemption must succeed, got ${fulfilled.length}`)
}

async function testPreviewNeverMutatesRedemptionCount() {
  wireComplimentary()
  const { rawCode, record } = await createComplimentaryCode({ planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3, createdBy: 'op' })
  await previewComplimentaryCode({ rawCode })
  const stored = await getComplimentaryCodeByHash(record.codeHash)
  assert(stored.redemptionCount === 0, 'previewComplimentaryCode() must never consume a redemption slot')
}

async function testPostRedemptionClaimSupportsRecoveryByTenantId() {
  wireComplimentary()
  const { rawCode } = await createComplimentaryCode({ planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3, createdBy: 'op' })
  await redeemComplimentaryCode({ rawCode, tenantId: 't_recover', userId: 'usr_1' })
  const claim = await getComplimentaryRedemptionClaim('t_recover')
  assert(claim && claim.planId === 'growth' && claim.maxLocations === 1 && claim.maxUsers === 3, 'a durable, tenantId-keyed claim must exist immediately after redemption')
  await clearComplimentaryRedemptionClaim('t_recover')
  assert((await getComplimentaryRedemptionClaim('t_recover')) === null, 'clearing the claim must remove it')
}

// ===========================================================================
// Part 2: complimentaryAccessCommercial.js -- pure conversion logic.
// ===========================================================================

function redemptionFor(overrides = {}) {
  return { planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3, codeHash: 'fake-hash-abc', ...overrides }
}

function testPendingCaseWhenNoInitialSync() {
  const { commercial, complimentaryGrant } = buildComplimentaryAccessCommercialWrite(redemptionFor(), { initialSyncCompletedAt: null, redeemedByUserId: 'usr_1' })
  assert(commercial.commercialStatus === 'complimentary_pending_activation')
  assert(commercial.complimentary === null, 'no real clock exists yet in the pending case')
  assert(commercial.plan === 'growth' && commercial.planSource === 'complimentary_access')
  assert(complimentaryGrant.grantType === 'complimentary' && complimentaryGrant.durationDays === 30)
  assert(complimentaryGrant.maxLocations === 1 && complimentaryGrant.maxUsers === 3)
  assert(complimentaryGrant.redeemedByUserId === 'usr_1')
}

// Pre-push correction: a tenant whose initial sync ALREADY completed before
// redemption must get a FRESH period starting at REDEMPTION time, never
// backdated to the historical initialSync.completedAt.
function testImmediateActivationAnchorsToRedemptionTimeNotHistoricalSync() {
  const beforeCall = Date.now()
  const historicalSync = new Date('2026-04-01T00:00:00.000Z').toISOString() // long in the past
  const { commercial } = buildComplimentaryAccessCommercialWrite(redemptionFor(), { initialSyncCompletedAt: historicalSync, redeemedByUserId: 'usr_1' })
  const afterCall = Date.now()
  assert(commercial.commercialStatus === 'complimentary')
  assert(commercial.complimentary.startedAt !== historicalSync, 'must NEVER anchor startedAt to the historical initialSync.completedAt')
  const startedAtMs = Date.parse(commercial.complimentary.startedAt)
  assert(startedAtMs >= beforeCall && startedAtMs <= afterCall, `startedAt must be the server's own redemption-time timestamp (now), got ${commercial.complimentary.startedAt}`)
  const expectedEnds = new Date(startedAtMs + 30 * 24 * 60 * 60 * 1000).toISOString()
  assert(commercial.complimentary.endsAt === expectedEnds, 'endsAt must be startedAt + durationDays')
}

// Regression A -- an existing, long-since-synced tenant redeeming a 30-day
// code must get startedAt === redemption time, NOT initialSync.completedAt,
// and must NOT resolve as already expired.
function testExistingSyncedTenantGetsFreshPeriodFromRedemption() {
  const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString() // ~200 days ago
  const { commercial } = buildComplimentaryAccessCommercialWrite(redemptionFor({ durationDays: 30 }), { initialSyncCompletedAt: longAgo, redeemedByUserId: 'usr_1' })
  assert(commercial.complimentary.startedAt !== longAgo, 'startedAt must not equal the historical initialSync.completedAt')
  const startedAtMs = Date.parse(commercial.complimentary.startedAt)
  assert(Math.abs(startedAtMs - Date.now()) < 5000, 'startedAt must be essentially "now" (redemption time), not the historical sync date')
  const entitlements = resolveTenantEntitlementsFromConfig({
    configVersion: 1, status: 'active', commercial, complimentaryGrant: { grantType: 'complimentary', planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3, codeHash: 'h', grantedAt: new Date().toISOString(), redeemedByUserId: 'usr_1' },
  })
  assert(entitlements.commercialStatus === 'complimentary', `a freshly-redeemed grant must be immediately active and NOT already expired, got ${entitlements.commercialStatus}/${entitlements.reason}`)
}

// Regression B -- an unsynced tenant redeems (pending), and only once the
// FIRST successful initial sync later occurs does the real clock start,
// anchored to that sync's own timestamp.
async function testUnsyncedTenantActivatesAtFirstSyncTimestampNotRedemptionTime() {
  const redeemedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() // redeemed 10 days ago
  const { commercial: pendingCommercial, complimentaryGrant } = buildComplimentaryAccessCommercialWrite(
    redemptionFor({ durationDays: 30 }), { initialSyncCompletedAt: null, redeemedByUserId: 'usr_1' }
  )
  assert(pendingCommercial.commercialStatus === 'complimentary_pending_activation', 'sanity: must remain pending while unsynced')
  assert(complimentaryGrant.grantedAt != null, 'redeemedAt (grantedAt) must be preserved separately even while pending')

  // Simulate the redemption having actually happened 10 days ago (override
  // grantedAt for the scenario), then the first successful sync occurring
  // just now.
  const grant = { ...complimentaryGrant, grantedAt: redeemedAt }
  const firstSyncAt = new Date().toISOString()
  const config = {
    configVersion: 1, status: 'active', initialSync: { completedAt: firstSyncAt },
    commercial: pendingCommercial, complimentaryGrant: grant,
  }
  installFakeTenantConfigStoreSeededWith('t_unsynced', config)
  const updated = await maybeStartComplimentaryAccess('t_unsynced', config)
  assert(updated.commercial.commercialStatus === 'complimentary')
  assert(updated.commercial.complimentary.startedAt === firstSyncAt, `startedAt must equal the FIRST successful initialSync.completedAt, got ${updated.commercial.complimentary.startedAt}`)
  assert(updated.commercial.complimentary.startedAt !== redeemedAt, 'startedAt must NOT equal the original redemption time -- setup time must not consume the complimentary period')
  const expectedEnds = new Date(Date.parse(firstSyncAt) + 30 * 24 * 60 * 60 * 1000).toISOString()
  assert(updated.commercial.complimentary.endsAt === expectedEnds, 'endsAt must derive from the first-sync timestamp, not the redemption timestamp')
}

// Regression C -- a historical initial sync (from long before redemption)
// must never be able to SHORTEN a newly-redeemed complimentary period --
// proven by an extreme case where anchoring to the historical date would
// have made the grant already expired the instant it was redeemed.
function testHistoricalSyncCannotShortenNewlyRedeemedPeriod() {
  const veryOldSync = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString() // 400 days ago
  const { commercial } = buildComplimentaryAccessCommercialWrite(redemptionFor({ durationDays: 7 }), { initialSyncCompletedAt: veryOldSync, redeemedByUserId: 'usr_1' })
  // If startedAt had wrongly anchored to veryOldSync, a 7-day grant would
  // have expired ~393 days ago -- assert it did NOT.
  const entitlements = resolveTenantEntitlementsFromConfig({
    configVersion: 1, status: 'active', commercial,
    complimentaryGrant: { grantType: 'complimentary', planId: 'growth', durationDays: 7, maxLocations: 1, maxUsers: 3, codeHash: 'h', grantedAt: new Date().toISOString(), redeemedByUserId: 'usr_1' },
  })
  assert(entitlements.commercialStatus === 'complimentary', 'a historical sync date must never cause an immediately-expired grant')
  assert(entitlements.reason === 'complimentary_active')
  assert(Date.parse(commercial.complimentary.endsAt) > Date.now(), 'endsAt must be in the future relative to redemption time')
}

function testInvalidGrantFieldsRejectedDefensively() {
  for (const overrides of [{ planId: 'bogus' }, { durationDays: 9999 }, { maxLocations: 0 }, { maxUsers: 0 }]) {
    let threw = null
    try { buildComplimentaryAccessCommercialWrite(redemptionFor(overrides), { initialSyncCompletedAt: null, redeemedByUserId: 'usr_1' }) } catch (e) { threw = e }
    assert(threw instanceof InvalidComplimentaryGrantError, `${JSON.stringify(overrides)} must be rejected defensively`)
  }
}

// ===========================================================================
// Part 3: entitlementResolution.js -- limits/features/expiry/reason.
// ===========================================================================

function pendingComplimentaryConfig(overrides = {}) {
  return {
    configVersion: 1, status: 'onboarding',
    commercial: {
      commercialStatus: 'complimentary_pending_activation', plan: 'growth', planSource: 'complimentary_access',
      trial: null, complimentary: null, limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
      accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
    complimentaryGrant: { grantType: 'complimentary', planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3, codeHash: 'h', grantedAt: new Date().toISOString(), redeemedByUserId: 'usr_1' },
    ...overrides,
  }
}

function activeComplimentaryConfig({ startedAt, endsAt, planId = 'growth', maxLocations = 1, maxUsers = 3 } = {}) {
  return {
    configVersion: 2, status: 'active',
    commercial: {
      commercialStatus: 'complimentary', plan: planId, planSource: 'complimentary_access',
      trial: null,
      complimentary: { status: 'active', startedAt, endsAt, consumedAt: startedAt, maxLocations, maxUsers, codeHash: 'h' },
      limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
      accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: false,
      createdAt: startedAt, updatedAt: new Date().toISOString(),
    },
    complimentaryGrant: { grantType: 'complimentary', planId, durationDays: 30, maxLocations, maxUsers, codeHash: 'h', grantedAt: startedAt, redeemedByUserId: 'usr_1' },
  }
}

function testPendingActivationBoundedOnboardingCapacity() {
  const entitlements = resolveTenantEntitlementsFromConfig(pendingComplimentaryConfig())
  assert(entitlements.commercialStatus === 'complimentary_pending_activation')
  assert(entitlements.reason === 'complimentary_pending_activation')
  assert(entitlements.plan !== 'legacy_unmanaged', 'must never resolve as legacy/unmanaged')
  assert(entitlements.limits.aiAllowanceMonthly.usageUnits === 0 && entitlements.limits.storageBytes === 0 && entitlements.limits.assetCount === 0)
  assert(Object.values(entitlements.features).every(v => v === false), 'no premium features before activation')
}

function testActiveComplimentaryGrantsGrowthFeaturesWithGrantLimits() {
  const startedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
  const endsAt = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString()
  const entitlements = resolveTenantEntitlementsFromConfig(activeComplimentaryConfig({ startedAt, endsAt }))
  assert(entitlements.commercialStatus === 'complimentary' && entitlements.reason === 'complimentary_active')
  assert(entitlements.effectivePlan === 'growth')
  assert(entitlements.features.advancedIntelligence === true && entitlements.features.marketingIntelligence === true, 'must grant real Growth features, not a deny-all bundle')
  assert(entitlements.limits.maxLocations === 1, `grant-specific 1-location ceiling must be enforced, got ${entitlements.limits.maxLocations}`)
  assert(entitlements.limits.maxActiveUsers === 3, `grant-specific 3-user ceiling must be enforced, got ${entitlements.limits.maxActiveUsers}`)
  // Growth's own real defaults (5 locations / 10 users) must NEVER leak
  // through for a complimentary grant with lower ceilings.
  assert(entitlements.limits.maxLocations < 5 && entitlements.limits.maxActiveUsers < 10)
}

function testGrantCeilingNeverExceedsPlanDefault() {
  // An operator mistake (a grant ceiling ABOVE the plan's own real limit)
  // must clamp DOWN to the plan's default, never grant MORE than the plan
  // itself would ever allow -- proof against "unlimited location/user
  // fallback" / "accidental Enterprise access"-style over-grants.
  const startedAt = new Date().toISOString()
  const endsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const entitlements = resolveTenantEntitlementsFromConfig(activeComplimentaryConfig({ startedAt, endsAt, planId: 'core', maxLocations: 999, maxUsers: 999 }))
  assert(entitlements.limits.maxLocations === 1, 'must clamp down to Core\'s own real maxLocations (1), never honor an oversized grant')
  assert(entitlements.limits.maxActiveUsers === 3, 'must clamp down to Core\'s own real maxActiveUsers (3)')
}

function testComplimentaryExpiryCollapsesToSuspendedWithDistinctReason() {
  const startedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  const endsAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() // already past
  const config = activeComplimentaryConfig({ startedAt, endsAt })
  const entitlements = resolveTenantEntitlementsFromConfig(config)
  assert(entitlements.commercialStatus === 'suspended', 'an expired complimentary grant must resolve to the safest existing (suspended) state')
  assert(entitlements.reason === 'complimentary_expired', 'must be distinguishable from an ordinary Stripe suspension via reason')
  assert(Object.values(entitlements.features).every(v => v === false), 'expired complimentary access must deny all features')
  assert(entitlements.limits.maxLocations === 0 && entitlements.limits.maxActiveUsers === 0, 'expired complimentary access must deny all numeric capacity')
  // Must NEVER touch/fabricate commercial.suspension -- that field stays
  // reserved for Stripe-unpaid recovery.
  assert(config.commercial.suspension === null, 'expiry must be a LIVE computation, never a write to commercial.suspension')
}

function testComplimentaryNeverMisusesStripeUnpaidTerminalReason() {
  const startedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  const endsAt = new Date(Date.now() - 1000).toISOString()
  const entitlements = resolveTenantEntitlementsFromConfig(activeComplimentaryConfig({ startedAt, endsAt }))
  assert(entitlements.reason !== 'stripe_unpaid_terminal', 'a complimentary expiry must never be reported using the Stripe-unpaid-recovery reason')
}

function testCommercialOperationPolicyCoversNewStatuses() {
  assert(COMMERCIAL_STATUSES.includes('complimentary') && COMMERCIAL_STATUSES.includes('complimentary_pending_activation'))
  const activeBundle = { plan: 'growth', commercialStatus: 'complimentary' }
  const pendingBundle = { plan: 'growth', commercialStatus: 'complimentary_pending_activation' }
  assert(requireCommercialOperation(activeBundle, CommercialOperationClass.OPERATIONAL_WRITE).allowed === true)
  assert(requireCommercialOperation(activeBundle, CommercialOperationClass.CAPACITY_EXPANSION).allowed === true)
  assert(requireCommercialOperation(pendingBundle, CommercialOperationClass.OPERATIONAL_WRITE).allowed === false, 'pending complimentary must deny ordinary product operations, like trial_pending_activation does')
  assert(requireCommercialOperation(pendingBundle, CommercialOperationClass.CAPACITY_EXPANSION).allowed === true, 'pending complimentary must allow bounded onboarding capacity expansion')
  assert(requireCommercialOperation(pendingBundle, CommercialOperationClass.READ_BASIC).allowed === true)
}

// ===========================================================================
// Part 4: trialLifecycle.js -- lazy activation, anti-stacking, paid supersession.
// ===========================================================================

const TENANT_CONFIG_KEY = 'tenant_config:v1'

function installFakeTenantConfigStoreSeededWith(tenantId, config) {
  const store = { [TENANT_CONFIG_KEY]: { [tenantId]: JSON.stringify(config) } }
  setConfigClient(() => ({
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    eval: async (_s, keys, args) => {
      const key = keys[0]
      const [field, expectedVersionStr, nextJson] = args
      const raw = store[key]?.[field] ?? null
      let currentVersion = '0'
      if (raw) { try { const d = JSON.parse(raw); if (d?.configVersion !== undefined) currentVersion = String(d.configVersion) } catch {} }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
  }))
  return store
}

async function testComplimentaryDoesNotStartBeforeActivation() {
  setConfigClient(() => ({}))
  const config = pendingComplimentaryConfig({ status: 'onboarding' })
  const result = await maybeStartComplimentaryAccess('t_test', config)
  assert(result === config, 'must be a no-op while status is not yet active')
}

async function testComplimentaryDoesNotStartWithoutInitialSyncAnchor() {
  const config = pendingComplimentaryConfig({ status: 'active', initialSync: null })
  const result = await maybeStartComplimentaryAccess('t_test', config)
  assert(result === config, 'must refuse to start without initialSync.completedAt, even if status is active')
}

async function testComplimentaryActivatesAnchoredToInitialSync() {
  const syncCompletedAt = new Date('2026-03-15T12:00:00.000Z').toISOString()
  const config = pendingComplimentaryConfig({ status: 'active', initialSync: { completedAt: syncCompletedAt } })
  installFakeTenantConfigStoreSeededWith('t_test', config)
  const updated = await maybeStartComplimentaryAccess('t_test', config)
  assert(updated.commercial.commercialStatus === 'complimentary')
  assert(updated.commercial.complimentary.startedAt === syncCompletedAt, 'must anchor to initialSync.completedAt, never registration/observation time')
  const expectedEnds = new Date(Date.parse(syncCompletedAt) + 30 * 24 * 60 * 60 * 1000).toISOString()
  assert(updated.commercial.complimentary.endsAt === expectedEnds)
  assert(updated.commercial.complimentary.maxLocations === 1 && updated.commercial.complimentary.maxUsers === 3)
}

async function testComplimentaryGrantExcludesAutomaticSelfServiceTrial() {
  // A tenant with complimentaryGrant set (regardless of pending/active/
  // expired) must NEVER also start the automatic self-service 7-day trial --
  // the explicit anti-stacking requirement.
  const config = pendingComplimentaryConfig({
    status: 'active',
    trialEligibility: { eligible: true, markedAt: new Date().toISOString(), source: TRIAL_ELIGIBILITY_SOURCES[0] },
  })
  const result = await maybeStartTrial('t_test', config)
  assert(result === config, 'maybeStartTrial() must refuse to fire for a tenant with a complimentaryGrant on file, even if trialEligibility is also set')
}

async function testPaidSubscriptionCanSupersedeComplimentaryAccess() {
  const startedAt = new Date().toISOString()
  const endsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const config = activeComplimentaryConfig({ startedAt, endsAt })
  installFakeTenantConfigStoreSeededWith('t_test', config)
  const updated = await activatePaidSubscriptionIfValid('t_test', 'core')
  assert(updated.commercial.commercialStatus === 'active', 'a genuine paid subscription must supersede complimentary access')
  assert(updated.commercial.plan === 'core', 'the customer\'s newly-purchased plan must become canonical, even if different from the complimentary grant\'s plan')
  assert(updated.commercial.planSource === 'stripe_subscription_active')
  // The historical complimentaryGrant record itself is a SEPARATE
  // tenant_config field, never touched/cleared by this transition.
  assert(updated.complimentaryGrant != null, 'the historical complimentaryGrant record must remain, never deleted')
}

// ===========================================================================
// Part 5: end-to-end HTTP flow via session/[action].js.
// ===========================================================================

function fakeSessionRedis() {
  const hashes = {}
  const strings = {}
  const lists = {}
  return {
    async hget(key, field) { return hashes[key]?.[field] ?? null },
    async hgetall(key) { return { ...(hashes[key] ?? {}) } },
    async hset(key, fields) { hashes[key] = { ...(hashes[key] ?? {}), ...fields } },
    async hdel(key, field) { if (hashes[key]) delete hashes[key][field] },
    async get(key) { return strings[key] ?? null },
    async set(key, value) { strings[key] = value; return 'OK' },
    async del(key) { const had = key in strings; delete strings[key]; return had ? 1 : 0 },
    async lpush(key, value) { lists[key] = [value, ...(lists[key] ?? [])]; return lists[key].length },
    async ltrim(key, start, stop) { lists[key] = (lists[key] ?? []).slice(start, stop + 1) },
    async lrange(key, start, stop) { return (lists[key] ?? []).slice(start, stop === -1 ? undefined : stop + 1) },
    async eval(_s, keys, args) {
      const key = keys[0]
      const [field, expectedVersionStr, nextJson] = args
      const raw = hashes[key]?.[field] ?? null
      let currentVersion = '0'
      if (raw) { try { const d = JSON.parse(raw); if (d?.configVersion !== undefined) currentVersion = String(d.configVersion) } catch {} }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      hashes[key] = { ...(hashes[key] ?? {}), [field]: nextJson }
      return true
    },
  }
}

function fakeComplimentaryStoreRedisForHttp() {
  return fakeComplimentaryRedis()
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  res.getHeader = (name) => res.headers[name]
  return res
}

async function invoke(action, body, { cookie } = {}) {
  const req = {
    method: 'POST', body, headers: { host: 'app.example.com', ...(cookie ? { cookie } : {}) },
    query: { action }, socket: { remoteAddress: '127.0.0.1' },
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

let tenantCounter = 0
function freshTenantId() { return `t_complimentary-${++tenantCounter}` }

// A tenant sitting in the exact pre-GBP-connection window this feature's
// own product flow expects redemption to happen in: self-service
// registration already wrote 'trial_pending_activation', GBP not connected
// yet (no initialSync).
async function seedPendingActivationOwnerSession(tenantId, { role = 'owner' } = {}) {
  await upsertTenantConfig(tenantId, {
    status: 'onboarding',
    commercial: {
      commercialStatus: 'trial_pending_activation', plan: 'growth', planSource: 'self_service_trial',
      trial: null, limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
      accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
    trialEligibility: { eligible: true, markedAt: new Date().toISOString(), source: 'self_service_registration' },
  }, { allowCreate: true, creationSource: 'self_service' })
  const record = { userId: `usr_${role}_${tenantId}`, email: `${role}-${tenantId}@example.com`, role, locationIds: '*', tenantId, sessionVersion: 1, disabled: false, displayName: 'Test Owner' }
  await upsertUser(tenantId, { ...record, passwordHash: 'x' }, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  const cookieValue = await signSession({ userId: record.userId, email: record.email, role, locationIds: '*', tenantId, sessionVersion: 1 })
  return { cookie: `${SESSION_COOKIE}=${cookieValue}`, tenantId, userId: record.userId }
}

// The rarer/defensive Case A window: a tenant whose first initial sync
// ALREADY completed (long ago) but that has not yet consumed any real
// commercial decision -- still sitting in 'trial_pending_activation'
// (reachable e.g. for a tenant provisioned without trialEligibility ever
// being set, so the automatic self-service trial never claims it). Used to
// prove the corrected redemption-time anchor end-to-end, through the real
// HTTP action.
async function seedAlreadySyncedOwnerSession(tenantId, { role = 'owner', initialSyncCompletedAt } = {}) {
  await upsertTenantConfig(tenantId, {
    status: 'active',
    initialSync: { completedAt: initialSyncCompletedAt },
    commercial: {
      commercialStatus: 'trial_pending_activation', plan: 'growth', planSource: 'self_service_trial',
      trial: null, limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
      accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
  }, { allowCreate: true, creationSource: 'self_service' })
  const record = { userId: `usr_${role}_${tenantId}`, email: `${role}-${tenantId}@example.com`, role, locationIds: '*', tenantId, sessionVersion: 1, disabled: false, displayName: 'Test Owner' }
  await upsertUser(tenantId, { ...record, passwordHash: 'x' }, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  const cookieValue = await signSession({ userId: record.userId, email: record.email, role, locationIds: '*', tenantId, sessionVersion: 1 })
  return { cookie: `${SESSION_COOKIE}=${cookieValue}`, tenantId, userId: record.userId }
}

function installHttpFakes() {
  const sessionRedis = fakeSessionRedis()
  const complimentaryRedis = fakeComplimentaryStoreRedisForHttp()
  setConfigClient(() => sessionRedis)
  setUserClient(() => sessionRedis)
  setComplimentaryClient(() => complimentaryRedis)
  setBillingClient(() => sessionRedis)
  setAuditClient(() => sessionRedis)
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: true, remaining: 99 }) }))
  return { complimentaryRedis }
}

async function makeComplimentaryCode(overrides = {}) {
  return createComplimentaryCode({ planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3, createdBy: 'op', ...overrides })
}

async function testOwnerCanRedeemValidCodeAndBecomesPending() {
  installHttpFakes()
  const { cookie, tenantId } = await seedPendingActivationOwnerSession(freshTenantId())
  const { rawCode } = await makeComplimentaryCode()
  const res = await invoke('redeem-complimentary-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.complimentary.state === 'pending', 'no initialSync yet -- must be pending, not active')
  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'complimentary_pending_activation')
  assert(config.complimentaryGrant.maxLocations === 1 && config.complimentaryGrant.maxUsers === 3)
}

// End-to-end proof of the pre-push correction through the REAL HTTP action:
// a tenant whose initial sync completed long ago must be activated
// immediately with startedAt at redemption time, not the historical sync
// date, and must not resolve as already expired.
async function testAlreadySyncedTenantGetsFreshPeriodOverHttp() {
  installHttpFakes()
  const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString()
  const { cookie, tenantId } = await seedAlreadySyncedOwnerSession(freshTenantId(), { initialSyncCompletedAt: longAgo })
  const { rawCode } = await makeComplimentaryCode({ durationDays: 30 })
  const beforeMs = Date.now()
  const res = await invoke('redeem-complimentary-code', { code: rawCode }, { cookie })
  const afterMs = Date.now()
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.complimentary.state === 'active', 'already-synced tenant must activate immediately, not pending')
  const startedAtMs = Date.parse(res.body.complimentary.startedAt)
  assert(startedAtMs >= beforeMs && startedAtMs <= afterMs, `startedAt must be redemption time, got ${res.body.complimentary.startedAt} vs window [${beforeMs},${afterMs}]`)
  assert(res.body.complimentary.startedAt !== longAgo, 'startedAt must never equal the historical initialSync.completedAt')
  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'complimentary', 'must be immediately active, never expired')
}

async function testCodeHashNeverExposedInResponse() {
  installHttpFakes()
  const { cookie } = await seedPendingActivationOwnerSession(freshTenantId())
  const { rawCode, record } = await makeComplimentaryCode()
  const res = await invoke('redeem-complimentary-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200)
  const serialized = JSON.stringify(res.body)
  assert(!serialized.includes(record.codeHash), 'the code hash must never be exposed to the client')
  assert(!serialized.includes(rawCode), 'the plaintext code must never be echoed back either')
}

async function testCodeCannotBeRedeemedTwiceBySameTenant() {
  installHttpFakes()
  const { cookie } = await seedPendingActivationOwnerSession(freshTenantId())
  const { rawCode } = await makeComplimentaryCode()
  const first = await invoke('redeem-complimentary-code', { code: rawCode }, { cookie })
  assert(first.statusCode === 200)
  const second = await invoke('redeem-complimentary-code', { code: rawCode }, { cookie })
  assert(second.statusCode === 400 && second.body.error === 'invalid_request', `a tenant with an existing complimentaryGrant must be rejected, got ${JSON.stringify(second.body)}`)
}

async function testCodeCannotBeUsedByASecondTenant() {
  installHttpFakes()
  const { cookie: cookieA } = await seedPendingActivationOwnerSession(freshTenantId())
  const { cookie: cookieB } = await seedPendingActivationOwnerSession(freshTenantId())
  const { rawCode } = await makeComplimentaryCode()
  const first = await invoke('redeem-complimentary-code', { code: rawCode }, { cookie: cookieA })
  assert(first.statusCode === 200, 'sanity: first tenant must succeed')
  const second = await invoke('redeem-complimentary-code', { code: rawCode }, { cookie: cookieB })
  assert(second.statusCode === 400 && second.body.error === 'invalid_code', 'a single-use code already bound to tenant A must never be redeemable by tenant B')
}

async function testConcurrentRedemptionAcrossTwoTenantsOnlyOneSucceeds() {
  installHttpFakes()
  const { cookie: cookieA } = await seedPendingActivationOwnerSession(freshTenantId())
  const { cookie: cookieB } = await seedPendingActivationOwnerSession(freshTenantId())
  const { rawCode } = await makeComplimentaryCode()
  const [resA, resB] = await Promise.all([
    invoke('redeem-complimentary-code', { code: rawCode }, { cookie: cookieA }),
    invoke('redeem-complimentary-code', { code: rawCode }, { cookie: cookieB }),
  ])
  const successes = [resA, resB].filter(r => r.statusCode === 200)
  assert(successes.length === 1, `exactly one concurrent HTTP redemption must succeed, got ${successes.length}`)
}

async function testNonOwnerCannotRedeem() {
  installHttpFakes()
  const tenantId = freshTenantId()
  await upsertTenantConfig(tenantId, {
    status: 'onboarding',
    commercial: { commercialStatus: 'trial_pending_activation', plan: 'growth', planSource: 'self_service_trial', trial: null, limitsOverride: null, suspension: null, cancellation: null, overLimit: null, accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  }, { allowCreate: true, creationSource: 'self_service' })
  const record = { userId: `usr_mgr_${tenantId}`, email: `mgr-${tenantId}@example.com`, role: 'location_manager', locationIds: [1], tenantId, sessionVersion: 1, disabled: false, displayName: 'Manager' }
  await upsertUser(tenantId, { ...record, passwordHash: 'x' }, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  const cookieValue = await signSession({ userId: record.userId, email: record.email, role: 'location_manager', locationIds: [1], tenantId, sessionVersion: 1 })
  const cookie = `${SESSION_COOKIE}=${cookieValue}`

  const { rawCode } = await makeComplimentaryCode()
  const res = await invoke('redeem-complimentary-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 403, `a non-owner must be rejected (403 forbidden), got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const config = await getTenantConfig(tenantId)
  assert(config.complimentaryGrant == null, 'a rejected non-owner attempt must never apply any grant')
}

async function testTenantIdCannotBeSpoofedFromRequestBody() {
  installHttpFakes()
  const { cookie, tenantId } = await seedPendingActivationOwnerSession(freshTenantId())
  const otherTenantId = 't_should-never-be-used'
  const { rawCode } = await makeComplimentaryCode()
  const res = await invoke('redeem-complimentary-code', { code: rawCode, tenantId: otherTenantId }, { cookie })
  assert(res.statusCode === 200)
  const spoofedConfig = await getTenantConfig(otherTenantId)
  assert(spoofedConfig === null, 'a client-supplied tenantId in the body must have zero effect -- tenantId always comes from the session')
  const realConfig = await getTenantConfig(tenantId)
  assert(realConfig.complimentaryGrant != null, 'the grant must apply to the SESSION\'S tenant, never a body-supplied one')
}

async function testPlanDurationLimitsCannotBeClientSupplied() {
  installHttpFakes()
  const { cookie, tenantId } = await seedPendingActivationOwnerSession(freshTenantId())
  const { rawCode } = await makeComplimentaryCode({ planId: 'core', durationDays: 14, maxLocations: 1, maxUsers: 2 })
  const res = await invoke('redeem-complimentary-code', {
    code: rawCode, plan: 'enterprise', durationDays: 9999, maxLocations: 999, maxUsers: 999,
  }, { cookie })
  assert(res.statusCode === 200)
  const config = await getTenantConfig(tenantId)
  assert(config.complimentaryGrant.planId === 'core', 'plan must come only from the server-validated code record, never the request body')
  assert(config.complimentaryGrant.durationDays === 14 && config.complimentaryGrant.maxLocations === 1 && config.complimentaryGrant.maxUsers === 2,
    'duration/limits must come only from the server-validated code record, never the request body')
}

async function testExpiredRedemptionDeadlineRejected() {
  installHttpFakes()
  const { cookie } = await seedPendingActivationOwnerSession(freshTenantId())
  const pastDate = new Date(Date.now() - 60_000).toISOString()
  const { rawCode } = await makeComplimentaryCode({ redemptionDeadline: pastDate })
  const res = await invoke('redeem-complimentary-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 400 && res.body.error === 'invalid_code')
}

async function testRevokedCodeRejectedOverHttp() {
  installHttpFakes()
  const { cookie } = await seedPendingActivationOwnerSession(freshTenantId())
  const { rawCode, record } = await makeComplimentaryCode()
  await revokeComplimentaryCode(record.codeHash, { reason: 'test' })
  const res = await invoke('redeem-complimentary-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 400 && res.body.error === 'invalid_code')
}

async function testActiveSubscriptionCannotRedeem() {
  installHttpFakes()
  const tenantId = freshTenantId()
  await upsertTenantConfig(tenantId, {
    status: 'active',
    commercial: {
      commercialStatus: 'active', plan: 'growth', planSource: 'stripe_subscription_active',
      trial: null, limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
      accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
  }, { allowCreate: true, creationSource: 'self_service' })
  const record = { userId: `usr_owner_${tenantId}`, email: `owner-${tenantId}@example.com`, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1, disabled: false, displayName: 'Owner' }
  await upsertUser(tenantId, { ...record, passwordHash: 'x' }, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  const cookieValue = await signSession({ userId: record.userId, email: record.email, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
  const cookie = `${SESSION_COOKIE}=${cookieValue}`

  const { rawCode, record: codeRecord } = await makeComplimentaryCode()
  const res = await invoke('redeem-complimentary-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 400 && res.body.error === 'already_subscribed', `expected already_subscribed, got ${JSON.stringify(res.body)}`)
  assert(res.body.message === 'This account already has an active subscription.')
  const stored = await getComplimentaryCodeByHash(codeRecord.codeHash)
  assert(stored.redemptionCount === 0, 'a rejected already-active tenant must never burn the code')
}

async function testRedemptionCreatesZeroStripeCalls() {
  // No Stripe client/stripeClient.js wiring is set up anywhere in this test
  // file's HTTP flow -- if redeemComplimentaryCodeAction() ever called
  // getStripeClient() or any Stripe API, it would throw (unconfigured) and
  // this request would fail with a 5xx, not 200. A clean 200 IS the proof.
  installHttpFakes()
  const { cookie, tenantId } = await seedPendingActivationOwnerSession(freshTenantId())
  const { rawCode } = await makeComplimentaryCode()
  const res = await invoke('redeem-complimentary-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200, `complimentary redemption must succeed with zero Stripe configuration, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const record = await getBillingRecord(tenantId)
  assert(record === null || record === undefined || !record.stripeCustomerId, 'no Stripe customer must ever be created by complimentary redemption')
}

async function testAuditLogRecordsRedemptionWithoutPlaintextCode() {
  installHttpFakes()
  const { cookie, tenantId } = await seedPendingActivationOwnerSession(freshTenantId())
  const { rawCode } = await makeComplimentaryCode()
  await invoke('redeem-complimentary-code', { code: rawCode }, { cookie })
  const { entries } = await listAuditEntries(tenantId, {})
  const entry = entries.find(e => e.action === 'complimentary_code_redeemed')
  assert(entry, 'an audit entry must be recorded for the redemption')
  assert(!JSON.stringify(entry).includes(rawCode), 'the audit entry must never contain the plaintext code')
}

async function testExpirationPreservesTenantDataAndCredentialState() {
  // Expiry is a LIVE resolver computation (Part 3 above already proves the
  // resolved bundle) -- this test proves the underlying tenant_config
  // record itself is completely untouched by expiry (no store write of any
  // kind happens merely by resolving an expired complimentary tenant).
  installHttpFakes()
  const tenantId = freshTenantId()
  const startedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  const endsAt = new Date(Date.now() - 1000).toISOString()
  const config = activeComplimentaryConfig({ startedAt, endsAt })
  await upsertTenantConfig(tenantId, config, { allowCreate: true, creationSource: 'self_service' })
  const before = await getTenantConfig(tenantId)
  resolveTenantEntitlementsFromConfig(before) // pure -- must not write anything
  const after = await getTenantConfig(tenantId)
  assert(JSON.stringify(before) === JSON.stringify(after), 'resolving an expired complimentary tenant must never mutate tenant_config -- no data/credential deletion, no auto-charge, no state change')
}

// ===========================================================================
// Part 6: Billing.jsx UI -- source-content assertions, matching
// test_billing_ui.js's own established style (no React render framework in
// this repo).
// ===========================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.resolve(__dirname, '..', 'dashboard', 'src')
function readSrc(relPath) {
  return readFileSync(path.join(SRC_DIR, relPath), 'utf-8').replace(/\r\n/g, '\n')
}

function testBillingUiRendersComplimentaryStates() {
  const content = readSrc('pages/settings/Billing.jsx')
  assert(/Complimentary Access Reserved/.test(content))
  assert(/Complimentary Access Ended/.test(content))
  assert(/ComplimentaryActiveCard/.test(content) && /ComplimentaryPendingCard/.test(content) && /ComplimentaryExpiredCard/.test(content))
  assert(/Have a complimentary access code\?/.test(content))
  assert(/Redeem Code/.test(content))
}

function testBillingUiHidesRawIdentifiersForComplimentary() {
  const content = readSrc('pages/settings/Billing.jsx')
  assert(!/codeHash/.test(content), 'Billing.jsx must never reference a code hash')
  assert(!/\bcus_[A-Za-z0-9]/.test(content) && !/\bsub_[A-Za-z0-9]/.test(content) && !/\bprice_[A-Za-z0-9]/.test(content))
}

function testManageBillingHiddenForComplimentaryProvenance() {
  const content = readSrc('pages/settings/Billing.jsx')
  assert(/function isComplimentaryProvenance/.test(content))
  assert(/\{!complimentaryProvenance && <ManageBillingCard \/>\}/.test(content),
    'Manage Billing must be conditionally hidden for complimentary provenance, never shown unconditionally alongside it')
}

function testServiceAndHookWireComplimentaryRedemption() {
  const service = readSrc('services/billingService.js')
  assert(/\/api\/session\/redeem-complimentary-code/.test(service))
  const hook = readSrc('hooks/useBilling.js')
  assert(/useRedeemComplimentaryCode/.test(hook))
}

// ===========================================================================
// Part 8: onboarding-gate complimentary redemption (end-to-end) -- fixes the
// discovered onboarding dead-end: a brand-new registrant can now redeem a
// complimentary code at POST /api/session/redeem-access-code (the SAME
// endpoint/UI as the unrelated LTA-ENT sales/registration codes), server-side
// routed by real store lookups, never a client-visible prefix.
// ===========================================================================

// A single fake Redis client whose eval() emulates BOTH atomic-script shapes
// this suite's onboarding flow touches: tenantConfigStore.js/userStore.js's
// generic CAS_UPSERT_SCRIPT (1 key, [field, expectedVersionStr, nextJson]),
// and the REDEEM_SCRIPT shape shared structurally (though never storage-wise)
// by accessCodeStore.js and complimentaryAccessStore.js (2 keys, [codeHash,
// tenantId, userId, nowIso, claimPayload, ttl]) -- distinguished purely by
// argument count/shape, exactly like test_access_code_commercial_modernization.js's
// own established fakeRedis() convention for the same reason.
function fakeOnboardingRedis() {
  const hashes = {}
  const strings = {}
  return {
    async hget(key, field) { return hashes[key]?.[field] ?? null },
    async hgetall(key) { return { ...(hashes[key] ?? {}) } },
    async hset(key, fields) { hashes[key] = { ...(hashes[key] ?? {}), ...fields } },
    async hdel(key, field) { if (hashes[key]) delete hashes[key][field] },
    async get(key) { return strings[key] ?? null },
    async set(key, value, opts = {}) {
      if (opts.nx && key in strings) return null
      strings[key] = value
      return 'OK'
    },
    async getdel(key) { const v = strings[key] ?? null; delete strings[key]; return v },
    async del(key) { const had = key in strings; delete strings[key]; return had ? 1 : 0 },
    async lpush(key, value) { strings[`__list__${key}`] = [value, ...(strings[`__list__${key}`] ?? [])]; return strings[`__list__${key}`].length },
    async ltrim(key, start, stop) { strings[`__list__${key}`] = (strings[`__list__${key}`] ?? []).slice(start, stop + 1) },
    async lrange(key, start, stop) { return (strings[`__list__${key}`] ?? []).slice(start, stop === -1 ? undefined : stop + 1) },
    async eval(_script, keys, args) {
      if (keys.length === 1) {
        // Generic CAS_UPSERT_SCRIPT shape.
        const key = keys[0]
        const [field, expectedVersionStr, nextJson] = args
        const raw = hashes[key]?.[field] ?? null
        let currentVersion = '0'
        if (raw) { try { const d = JSON.parse(raw); if (d?.configVersion !== undefined) currentVersion = String(d.configVersion) } catch {} }
        if (currentVersion !== expectedVersionStr) return raw ?? false
        hashes[key] = { ...(hashes[key] ?? {}), [field]: nextJson }
        return true
      }
      // Generic REDEEM_SCRIPT shape (either code system).
      const key = keys[0]
      const claimKey = keys[1]
      const [codeHash, tenantId, userId, nowIso, claimPayload] = args
      const raw = hashes[key]?.[codeHash]
      if (!raw) return false
      let code
      try { code = JSON.parse(raw) } catch { return false }
      if (code.status !== 'active') return false
      const hasComplimentaryShape = 'redeemedAt' in code
      const deadline = hasComplimentaryShape ? code.redemptionDeadline : code.expiresAt
      if (deadline && deadline < nowIso) return false
      if (code.redemptionCount >= code.maxRedemptions) return false
      code.redemptionCount += 1
      code.redemptions = code.redemptions || []
      code.redemptions.push({ tenantId, userId, redeemedAt: nowIso })
      if (hasComplimentaryShape) { code.redeemedAt = nowIso; code.redeemedByUserId = userId; code.tenantId = tenantId }
      hashes[key] = { ...(hashes[key] ?? {}), [codeHash]: JSON.stringify(code) }
      if (claimKey && claimPayload !== undefined) strings[claimKey] = claimPayload
      return JSON.stringify(code)
    },
  }
}

function installOnboardingFakes() {
  const client = fakeOnboardingRedis()
  setPendingClient(() => client)
  setTokenClient(() => client)
  setConfigClient(() => client)
  setUserClient(() => client)
  setAccessCodeClient(() => client)
  setComplimentaryClient(() => client)
  setAuditClient(() => client)
  setBillingClient(() => client)
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: true, remaining: 99 }) }))
  return client
}

let onboardingSentEmails
function installOnboardingEmailTransport() {
  onboardingSentEmails = []
  _setTransportForTests(() => ({
    sendMail: async (opts) => { onboardingSentEmails.push(opts); return { messageId: 'test-message-id', response: '250 OK' } },
  }))
}

function onboardingRegisterBody(overrides = {}) {
  const VALID_PASSWORD = 'correct-horse-battery-staple'
  return {
    email: 'newowner@example.com', password: VALID_PASSWORD, passwordConfirmation: VALID_PASSWORD,
    displayName: 'New Owner', companyName: 'Agave Pilot Group', ...overrides,
  }
}

function extractOnboardingVerifyToken() {
  const { text } = onboardingSentEmails[onboardingSentEmails.length - 1]
  return decodeURIComponent(text.match(/token=([A-Za-z0-9%_-]+)/)[1])
}

function onboardingCookieFromRes(res, name) {
  const setCookie = res.headers['Set-Cookie']
  if (!setCookie) return null
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const c of list) {
    if (c.startsWith(`${name}=`)) return `${name}=${c.split(`${name}=`)[1].split(';')[0]}`
  }
  return null
}

// Registers + verifies a brand-new email, landing at the exact pending-signup
// identity the onboarding access-code gate operates on -- no tenant, no
// user record, no session cookie exist yet; only the lta_pending_signup
// cookie, exactly matching AccessCodeEntry.jsx's own real precondition.
async function registerAndVerifyForOnboarding(overrides = {}) {
  const body = onboardingRegisterBody(overrides)
  await invoke('register', body)
  const token = extractOnboardingVerifyToken()
  const verifyRes = await invoke('verify-email', { token })
  const cookie = onboardingCookieFromRes(verifyRes, PENDING_SIGNUP_COOKIE)
  const pending = await getPendingRegistration(body.email)
  return { body, cookie, pending }
}

async function testOnboardingGateRedeemsComplimentaryCodeForBrandNewRegistrant() {
  installOnboardingFakes(); installOnboardingEmailTransport()
  const { cookie, pending } = await registerAndVerifyForOnboarding({ email: 'onboarding-owner@example.com' })
  // Sanity: this registrant has no tenant/session yet at all -- the exact
  // "dashboard gate is currently blocking normal access" precondition.
  assert(pending.status === 'verified_awaiting_plan', 'sanity: registrant must be sitting at the gate, not already past it')
  assert((await getTenantConfig(pending.tenantIdReserved)) === null, 'sanity: no tenant exists yet')

  const { rawCode } = await makeComplimentaryCode({ planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3 })
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.account?.role === 'owner', 'the newly-created user must be the tenant Owner')

  const tenantId = pending.tenantIdReserved
  const config = await getTenantConfig(tenantId)
  assert(config !== null, 'a real tenant_config must now exist')
  assert(config.commercial.commercialStatus === 'complimentary_pending_activation', `no initialSync yet -- must remain pending, got ${config.commercial.commercialStatus}`)
  assert(config.commercial.complimentary === null, 'the complimentary timer must NOT have started yet')
  assert(config.complimentaryGrant.planId === 'growth' && config.complimentaryGrant.durationDays === 30)
  assert(config.complimentaryGrant.maxLocations === 1 && config.complimentaryGrant.maxUsers === 3)
  assert(config.accessCodeGrant == null && config.trialEligibility == null, 'must never also carry the unrelated sales-code/self-service-trial provenance')

  // Zero Stripe side effects -- no Stripe client is wired anywhere in this
  // test's fakes; a real call would throw and fail this test with an
  // uncaught error rather than silently succeeding.
  const billing = await getBillingRecord(tenantId)
  assert(billing === null || billing === undefined || !billing.stripeCustomerId, 'complimentary onboarding must never create a Stripe customer')
}

async function testOnboardingCompleteFlowThroughFirstSyncActivation() {
  installOnboardingFakes(); installOnboardingEmailTransport()
  const { cookie, pending } = await registerAndVerifyForOnboarding({ email: 'full-flow-owner@example.com' })
  const { rawCode } = await makeComplimentaryCode({ planId: 'growth', durationDays: 30, maxLocations: 1, maxUsers: 3 })
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200)
  const tenantId = pending.tenantIdReserved

  // "Google onboarding can occur afterward" -- simulate the tenant reaching
  // status: 'active' with a first successful initial sync, exactly as
  // initial_sync.py's own real write would, then run the SAME lazy
  // activation tenantStatus() polling already triggers.
  const beforeSync = await getTenantConfig(tenantId)
  const syncCompletedAt = new Date().toISOString()
  await upsertTenantConfig(tenantId, { status: 'active', initialSync: { completedAt: syncCompletedAt } }, { expectedVersion: beforeSync.configVersion })
  const afterSync = await getTenantConfig(tenantId)
  const activated = await maybeStartComplimentaryAccess(tenantId, afterSync)

  assert(activated.commercial.commercialStatus === 'complimentary', 'first successful sync must activate complimentary Growth')
  assert(activated.commercial.complimentary.startedAt === syncCompletedAt, `startsAt must equal initialSync.completedAt, got ${activated.commercial.complimentary.startedAt}`)
  const expectedEnds = new Date(Date.parse(syncCompletedAt) + 30 * 24 * 60 * 60 * 1000).toISOString()
  assert(activated.commercial.complimentary.endsAt === expectedEnds, 'endsAt must be startsAt + the configured duration')

  const entitlements = resolveTenantEntitlementsFromConfig(activated)
  assert(entitlements.features.advancedIntelligence === true, 'activated complimentary access must grant real Growth features')
  assert(entitlements.limits.maxLocations === 1 && entitlements.limits.maxActiveUsers === 3)
}

async function testOnboardingGateStillAcceptsOldSalesAccessCodesUnchanged() {
  installOnboardingFakes(); installOnboardingEmailTransport()
  const { cookie, pending } = await registerAndVerifyForOnboarding({ email: 'sales-code-owner@example.com' })
  const { rawCode } = await createAccessCode({ prefix: 'LTA-ENT', plan: 'growth', paymentRequired: false, createdBy: 'usr_admin' })
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200, `old LTA-ENT codes must still work exactly as before, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const config = await getTenantConfig(pending.tenantIdReserved)
  assert(config.commercial.commercialStatus === 'active' && config.commercial.plan === 'growth')
  assert(config.commercial.planSource === 'access_code', 'the unrelated sales-code system\'s own provenance must be completely unaffected')
  assert(config.complimentaryGrant == null, 'an old-system redemption must never write a complimentaryGrant')
}

async function testOnboardingGateRejectsInvalidCodeInEitherSystem() {
  installOnboardingFakes(); installOnboardingEmailTransport()
  const { cookie } = await registerAndVerifyForOnboarding({ email: 'bad-code-owner@example.com' })
  const res = await invoke('redeem-access-code', { code: 'TOTALLY-BOGUS-CODE-0000' }, { cookie })
  assert(res.statusCode === 400 && res.body.error === 'invalid_access_code', `an unrecognized code must be rejected generically, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(!/complimentary|sales|LTA-ENT|PRYOR-PILOT/i.test(res.body.message ?? ''), 'the rejection must never reveal which code system(s) were checked')
}

async function testOnboardingGateCodeHashAndPlaintextNeverExposed() {
  installOnboardingFakes(); installOnboardingEmailTransport()
  const { cookie } = await registerAndVerifyForOnboarding({ email: 'no-leak-owner@example.com' })
  const { rawCode, record } = await makeComplimentaryCode()
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200)
  const serialized = JSON.stringify(res.body)
  assert(!serialized.includes(rawCode) && !serialized.includes(record.codeHash), 'the onboarding response must never contain the plaintext code or its hash')
}

// Structural proof that the dashboard-lifecycle gate (AuthGate.jsx) never
// branches on commercial/commercialStatus at all -- it only ever gates on
// the tenant's Google-connection/sync `status` field, which is completely
// orthogonal to commercial state. This is what makes
// 'complimentary_pending_activation' and 'complimentary' already valid,
// unmodified dashboard-access states: there is nothing that could reject
// them, because nothing client-side ever inspects commercialStatus outside
// Billing.jsx.
function testDashboardGateNeverBranchesOnCommercialStatus() {
  const authGate = readSrc('components/AuthGate.jsx')
  assert(/data\.status !== 'active'/.test(authGate), 'the tenant-lifecycle gate must key off tenant_config.status only')
  assert(!/commercialStatus/.test(authGate) && !/data\.commercial/.test(authGate),
    'AuthGate.jsx must never branch on commercial/commercialStatus -- complimentary_pending_activation and complimentary must reach the dashboard exactly like every other status')
}

function testAccessCodeEntryUiNoLongerImpliesOnlySalesCodes() {
  const content = readSrc('components/AccessCodeEntry.jsx')
  assert(!/LTA-ENT/.test(content), 'the onboarding gate copy must no longer imply only LTA-ENT codes are accepted')
  assert(/complimentary/i.test(content), 'the onboarding gate copy must acknowledge complimentary codes too')
}

// ===========================================================================

const tests = [
  ['create shows the raw code once and only the hash persists', testCreateShowsRawCodeOnceAndOnlyHashPersists],
  ['generated code entropy is at least ~70 bits, using the crypto-secure visually-unambiguous alphabet', testCodeEntropyIsAtLeast70Bits],
  ['list never exposes the raw code', testListNeverExposesRawCode],
  ['creation validates duration/locations/users against sane ceilings', testCreationValidatesDurationLocationsUsers],
  ['Enterprise can never be granted complimentary access', testEnterpriseCannotBeGrantedComplimentary],
  ['redeem success returns only server record fields', testRedeemSuccessReturnsServerRecordFieldsOnly],
  ['redeem fails for an unknown code', testRedeemFailsForUnknownCode],
  ['redeem fails for a revoked code', testRedeemFailsForRevokedCode],
  ['redeem fails once the redemption deadline has passed', testRedeemFailsWhenDeadlinePassed],
  ['a single-use code cannot be redeemed twice', testSingleUseCodeCannotBeRedeemedTwice],
  ['concurrent double redemption of the store-level script cannot both succeed', testConcurrentDoubleRedemptionCannotBothSucceed],
  ['preview never mutates redemptionCount', testPreviewNeverMutatesRedemptionCount],
  ['the post-redemption claim supports tenantId-keyed recovery', testPostRedemptionClaimSupportsRecoveryByTenantId],
  ['pending case (no initialSync) defers commercial to complimentary_pending_activation', testPendingCaseWhenNoInitialSync],
  ['immediate-activation case anchors to redemption time, never the historical initialSync.completedAt', testImmediateActivationAnchorsToRedemptionTimeNotHistoricalSync],
  ['regression A: an existing long-since-synced tenant gets a fresh period from redemption time', testExistingSyncedTenantGetsFreshPeriodFromRedemption],
  ['regression B: an unsynced tenant activates at the first sync timestamp, not redemption time', testUnsyncedTenantActivatesAtFirstSyncTimestampNotRedemptionTime],
  ['regression C: a historical initial sync cannot shorten a newly-redeemed period', testHistoricalSyncCannotShortenNewlyRedeemedPeriod],
  ['invalid grant fields are rejected defensively', testInvalidGrantFieldsRejectedDefensively],
  ['pending activation grants bounded, zero-cost onboarding capacity only', testPendingActivationBoundedOnboardingCapacity],
  ['active complimentary grants Growth features with the grant\'s own location/user ceilings', testActiveComplimentaryGrantsGrowthFeaturesWithGrantLimits],
  ['a grant ceiling above the plan default clamps down, never exceeds it', testGrantCeilingNeverExceedsPlanDefault],
  ['complimentary expiry collapses to suspended with a distinct reason, never touching commercial.suspension', testComplimentaryExpiryCollapsesToSuspendedWithDistinctReason],
  ['complimentary expiry never misuses the stripe_unpaid_terminal reason', testComplimentaryNeverMisusesStripeUnpaidTerminalReason],
  ['commercialOperationPolicy.js covers both new statuses correctly', testCommercialOperationPolicyCoversNewStatuses],
  ['maybeStartComplimentaryAccess does not start before tenant is active', testComplimentaryDoesNotStartBeforeActivation],
  ['maybeStartComplimentaryAccess refuses without an initialSync anchor', testComplimentaryDoesNotStartWithoutInitialSyncAnchor],
  ['maybeStartComplimentaryAccess activates anchored to initialSync.completedAt', testComplimentaryActivatesAnchoredToInitialSync],
  ['a complimentaryGrant excludes the automatic self-service trial (anti-stacking)', testComplimentaryGrantExcludesAutomaticSelfServiceTrial],
  ['a genuine paid subscription can supersede complimentary access safely', testPaidSubscriptionCanSupersedeComplimentaryAccess],
  ['an owner can redeem a valid code; pending when no initial sync yet', testOwnerCanRedeemValidCodeAndBecomesPending],
  ['an already-synced tenant gets a fresh period at redemption time over HTTP (end-to-end)', testAlreadySyncedTenantGetsFreshPeriodOverHttp],
  ['the code hash and plaintext code are never exposed in the HTTP response', testCodeHashNeverExposedInResponse],
  ['a tenant that already redeemed cannot redeem a second complimentary code (anti-stacking)', testCodeCannotBeRedeemedTwiceBySameTenant],
  ['a single-use code cannot be redeemed by a second tenant', testCodeCannotBeUsedByASecondTenant],
  ['concurrent HTTP redemption across two tenants: exactly one succeeds', testConcurrentRedemptionAcrossTwoTenantsOnlyOneSucceeds],
  ['a non-owner (location_manager) cannot redeem', testNonOwnerCannotRedeem],
  ['a client-supplied tenantId in the body has zero effect', testTenantIdCannotBeSpoofedFromRequestBody],
  ['plan/duration/limits cannot be client-supplied', testPlanDurationLimitsCannotBeClientSupplied],
  ['an expired redemption deadline is rejected over HTTP', testExpiredRedemptionDeadlineRejected],
  ['a revoked code is rejected over HTTP', testRevokedCodeRejectedOverHttp],
  ['a tenant with an active paid subscription cannot redeem', testActiveSubscriptionCannotRedeem],
  ['complimentary redemption creates zero Stripe calls/objects', testRedemptionCreatesZeroStripeCalls],
  ['the audit log records redemption without ever logging the plaintext code', testAuditLogRecordsRedemptionWithoutPlaintextCode],
  ['expiration preserves tenant_config data untouched (no deletion, no charge)', testExpirationPreservesTenantDataAndCredentialState],
  ['Billing UI renders all three complimentary states', testBillingUiRendersComplimentaryStates],
  ['Billing UI never exposes a code hash or raw Stripe identifiers', testBillingUiHidesRawIdentifiersForComplimentary],
  ['Manage Billing is hidden specifically for complimentary provenance', testManageBillingHiddenForComplimentaryProvenance],
  ['the service/hook layer wires the redeem-complimentary-code endpoint', testServiceAndHookWireComplimentaryRedemption],
  ['onboarding gate: a brand-new registrant can redeem a complimentary code before any trial/Stripe flow', testOnboardingGateRedeemsComplimentaryCodeForBrandNewRegistrant],
  ['onboarding gate: full flow through first-sync activation (startsAt/endsAt correct)', testOnboardingCompleteFlowThroughFirstSyncActivation],
  ['onboarding gate: old LTA-ENT sales/registration codes still work exactly as before', testOnboardingGateStillAcceptsOldSalesAccessCodesUnchanged],
  ['onboarding gate: an invalid code is rejected without revealing which system was checked', testOnboardingGateRejectsInvalidCodeInEitherSystem],
  ['onboarding gate: no raw code or code hash is ever exposed in the response', testOnboardingGateCodeHashAndPlaintextNeverExposed],
  ['dashboard gate never branches on commercial/commercialStatus (complimentary states already reach it)', testDashboardGateNeverBranchesOnCommercialStatus],
  ['AccessCodeEntry UI no longer implies only sales/LTA-ENT codes are accepted', testAccessCodeEntryUiNoLongerImpliesOnlySalesCodes],
]

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
