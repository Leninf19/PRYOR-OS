// Phase B.8 -- Access Code + Commercial State Modernization. Regression
// tests for:
//   - dashboard/api/_lib/accessCodeCommercial.js (buildAccessCodeCommercialWrite())
//   - dashboard/api/_lib/trialLifecycle.js's maybeStartAccessCodeTrial() and
//     maybeStartTrial()'s new accessCodeGrant exclusion
//   - the end-to-end redeem-access-code flow (session/[action].js), covering
//     paymentRequired rejection-without-burning-the-code, the partial-failure/
//     retry contract, trial vs. non-trial canonical writes, discount
//     preservation, plan/trialDays validation, and B.7 compatibility
//
// Phase B.2-B.7 behavior (the resolver itself, the commercial operation
// policy, numeric quota enforcement) is covered by its own existing test
// files and is not re-tested here except where this phase's access-code
// modernization interacts with it.
//
// Run directly: node tests/test_access_code_commercial_modernization.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import handler from '../dashboard/api/session/[action].js'
import {
  buildAccessCodeCommercialWrite, PaymentRequiredNotSupportedError, InvalidAccessCodeGrantError,
} from '../dashboard/api/_lib/accessCodeCommercial.js'
import {
  maybeStartAccessCodeTrial, maybeStartTrial, TRIAL_ELIGIBILITY_SOURCES,
} from '../dashboard/api/_lib/trialLifecycle.js'
import { resolveTenantEntitlementsFromConfig } from '../dashboard/api/_lib/entitlementResolution.js'
import { requireCommercialOperation, commercialDenialResponse, CommercialOperationClass } from '../dashboard/api/_lib/commercialOperationPolicy.js'
import {
  _setRedisClientForTests as setPendingClient, _resetRedisClientForTests as resetPendingClient, getPendingRegistration,
} from '../dashboard/api/_lib/pendingRegistrationStore.js'
import { _setRedisClientForTests as setTokenClient, _resetRedisClientForTests as resetTokenClient } from '../dashboard/api/_lib/tokenStore.js'
import {
  _setRedisClientForTests as setTenantConfigClient, _resetRedisClientForTests as resetTenantConfigClient,
  getTenantConfig, upsertTenantConfig,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setUserStoreClient, _resetRedisClientForTests as resetUserStoreClient, getUserByEmail } from '../dashboard/api/_lib/userStore.js'
import {
  _setRedisClientForTests as setAccessCodeClient, _resetRedisClientForTests as resetAccessCodeClient,
  createAccessCode, getAccessCodeByHash, hashAccessCode, getAccessCodeRedemptionClaim,
} from '../dashboard/api/_lib/accessCodeStore.js'
import { _setTransportForTests, _resetTransportForTests } from '../dashboard/api/_lib/emailSender.js'
import { PENDING_SIGNUP_COOKIE, signPendingSignupToken } from '../dashboard/api/_lib/pendingSignupSession.js'
import settingsHandler from '../dashboard/api/settings/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { upsertUser, UserCreationMode } from '../dashboard/api/_lib/userStore.js'
import { _setRedisClientForTests as setSeatLockClient, _resetRedisClientForTests as resetSeatLockClient } from '../dashboard/api/_lib/seatAllocationLock.js'
import { _setRedisClientForTests as setAuditClient, _resetRedisClientForTests as resetAuditClient } from '../dashboard/api/_lib/auditLog.js'
import { _setLimiterFactoryForTests, _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'

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
    resetPendingClient(); resetTokenClient(); resetTenantConfigClient(); resetUserStoreClient(); resetAccessCodeClient()
    resetSeatLockClient(); resetAuditClient(); _resetLimiterFactoryForTests()
    _resetTransportForTests()
    delete process.env.ACCOUNT_DIRECTORY_JSON
  }
}

// ===========================================================================
// Part 1: buildAccessCodeCommercialWrite() -- pure conversion logic.
// ===========================================================================

function redemptionFor(overrides = {}) {
  return {
    plan: 'growth', discountPercent: null, discountFixedCents: null,
    trialDays: null, paymentRequired: false, codeHash: 'fake-hash-abc123',
    ...overrides,
  }
}

function testNonTrialProducesImmediateActiveCanonicalCommercial() {
  const { commercial, accessCodeGrant } = buildAccessCodeCommercialWrite(redemptionFor({ trialDays: null }))
  assert(accessCodeGrant === null, 'a non-trial grant must never leave a pending accessCodeGrant')
  assert(commercial.commercialStatus === 'active' && commercial.plan === 'growth' && commercial.planSource === 'access_code')
  assert(commercial.trial === null, 'a non-trial grant must have a null trial sub-object')
  assert(commercial.accessCodeHash === 'fake-hash-abc123')
  assert(commercial.paymentRequired === false)
}

function testTrialDaysZeroIsTreatedAsNonTrial() {
  const { commercial, accessCodeGrant } = buildAccessCodeCommercialWrite(redemptionFor({ trialDays: 0 }))
  assert(accessCodeGrant === null && commercial.commercialStatus === 'active', 'trialDays: 0 must produce immediate active state, never a pending trial')
}

function testTrialGrantDefersCommercialUntilActivation() {
  // Phase B.8 pre-commit correction (Part 1): commercial must be an
  // EXPLICIT, resolver-recognized 'trial_pending_activation' state
  // immediately -- NEVER null (which would fall through to
  // legacyUnmanagedBundle and grant unrestricted legacy access during
  // onboarding). accessCodeGrant still carries the real trial's own
  // trialDays/plan/hash through to eventual activation.
  const { commercial, accessCodeGrant } = buildAccessCodeCommercialWrite(redemptionFor({ trialDays: 14 }))
  assert(commercial !== null, 'a trial grant must NEVER leave commercial null -- that would resolve as legacy/unmanaged during onboarding')
  assert(commercial.commercialStatus === 'trial_pending_activation' && commercial.plan === 'growth' && commercial.planSource === 'access_code_trial')
  assert(commercial.trial === null, 'no real trial dates exist yet -- those are written later by maybeStartAccessCodeTrial()')
  assert(commercial.accessCodeHash === 'fake-hash-abc123')
  assert(accessCodeGrant.grantType === 'trial' && accessCodeGrant.trialDays === 14 && accessCodeGrant.planSource === 'access_code_trial')
  assert(accessCodeGrant.accessCodeHash === 'fake-hash-abc123', 'provenance must carry through to the eventual commercial write')
}

function testPaymentRequiredTrueIsRejected() {
  let threw = null
  try {
    buildAccessCodeCommercialWrite(redemptionFor({ paymentRequired: true }))
  } catch (e) { threw = e }
  assert(threw instanceof PaymentRequiredNotSupportedError, 'paymentRequired: true must be rejected, never silently produce active/paid access')
}

function testInvalidPlanIsRejected() {
  let threw = null
  try {
    buildAccessCodeCommercialWrite(redemptionFor({ plan: 'not_a_real_plan' }))
  } catch (e) { threw = e }
  assert(threw instanceof InvalidAccessCodeGrantError, 'an invalid plan must be rejected defensively even at this layer')
}

function testInvalidTrialDaysIsRejected() {
  for (const bad of [-1, 91, 14.5, NaN]) {
    let threw = null
    try {
      buildAccessCodeCommercialWrite(redemptionFor({ trialDays: bad }))
    } catch (e) { threw = e }
    assert(threw instanceof InvalidAccessCodeGrantError, `trialDays=${bad} must be rejected defensively, got ${threw?.constructor?.name}`)
  }
}

function testDiscountMetadataIsPreservedButNeverInterpreted() {
  const { commercial } = buildAccessCodeCommercialWrite(redemptionFor({ discountPercent: 25 }))
  assert(commercial.discountPercent === 25 && commercial.discountFixedCents === null)
  // Never allowed to influence limits/features -- resolveNewShapeCommercial()
  // itself never reads either field; this proves the RESOLVED entitlements
  // for a discounted vs. non-discounted tenant on the same plan are identical.
  const withDiscount = resolveTenantEntitlementsFromConfig({ commercial, createdAt: new Date().toISOString() })
  const { commercial: noDiscount } = buildAccessCodeCommercialWrite(redemptionFor({ discountPercent: null }))
  const withoutDiscount = resolveTenantEntitlementsFromConfig({ commercial: noDiscount, createdAt: new Date().toISOString() })
  assert(JSON.stringify(withDiscount.limits) === JSON.stringify(withoutDiscount.limits), 'a discount must never change resolved limits')
  assert(JSON.stringify(withDiscount.features) === JSON.stringify(withoutDiscount.features), 'a discount must never change resolved features')
}

// ===========================================================================
// Part 2: maybeStartAccessCodeTrial() -- lazy activation anchored to
// initialSync.completedAt, independent of trialEligibilityStore.js.
// ===========================================================================

// Phase B.8 pre-commit correction: `commercial` is the explicit
// 'trial_pending_activation' shape from the start -- never null (see
// accessCodeCommercial.js's own header for the legacy-fallthrough hole
// that would otherwise open).
function pendingActivationCommercial(overrides = {}) {
  return {
    commercialStatus: 'trial_pending_activation', plan: 'growth', planSource: 'access_code_trial',
    trial: null, limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
    accessCodeHash: 'hash-1', discountPercent: null, discountFixedCents: null, paymentRequired: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function baseConfigWithGrant(overrides = {}) {
  return {
    configVersion: 1, status: 'onboarding', commercial: pendingActivationCommercial(),
    accessCodeGrant: { grantType: 'trial', trialDays: 14, plan: 'growth', planSource: 'access_code_trial', discountPercent: null, discountFixedCents: null, accessCodeHash: 'hash-1', grantedAt: new Date().toISOString() },
    ...overrides,
  }
}

async function testAccessCodeTrialDoesNotStartBeforeActivation() {
  setTenantConfigClient(() => ({}))
  const config = baseConfigWithGrant({ status: 'onboarding' })
  const result = await maybeStartAccessCodeTrial('t_test-tenant', config)
  assert(result === config, 'must be a no-op (same object) while status is not yet active')
}

async function testAccessCodeTrialDoesNotStartWithoutInitialSyncAnchor() {
  const config = baseConfigWithGrant({ status: 'active', initialSync: null })
  const result = await maybeStartAccessCodeTrial('t_test-tenant', config)
  assert(result === config, 'must refuse to start without an authoritative initialSync.completedAt anchor, even if status is active')
}

const TENANT_CONFIG_KEY = 'tenant_config:v1'

// Seeds the fake tenant_config:v1 hash with `config` itself, so
// upsertTenantConfig()'s CAS write (expectedVersion: config.configVersion)
// finds a genuinely pre-existing record to compare against -- exactly like
// a real tenantStatus() read-then-maybe-write cycle against a real,
// already-persisted tenant.
function installFakeTenantConfigStoreSeededWith(tenantId, config) {
  const store = { [TENANT_CONFIG_KEY]: { [tenantId]: JSON.stringify(config) } }
  setTenantConfigClient(() => ({
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
}

async function testAccessCodeTrialStartsAnchoredToInitialSyncNotRegistration() {
  const registeredAt = new Date('2026-01-01T00:00:00.000Z')
  const syncCompletedAt = new Date('2026-03-15T12:00:00.000Z') // MUCH later than registration
  const config = baseConfigWithGrant({
    status: 'active', createdAt: registeredAt.toISOString(),
    initialSync: { completedAt: syncCompletedAt.toISOString() },
  })
  installFakeTenantConfigStoreSeededWith('t_test-tenant', config)
  const updated = await maybeStartAccessCodeTrial('t_test-tenant', config)
  assert(updated.commercial !== null, 'sanity: trial must have started')
  assert(updated.commercial.trial.startedAt === syncCompletedAt.toISOString(),
    `trial must anchor to initialSync.completedAt, NOT registration time -- got ${updated.commercial.trial.startedAt}`)
  const expectedEnds = new Date(syncCompletedAt.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString()
  assert(updated.commercial.trial.endsAt === expectedEnds, `expected a 14-day duration from the anchor (the code's own trialDays, never the normal 7-day duration), got ${updated.commercial.trial.endsAt}`)
  assert(updated.commercial.planSource === 'access_code_trial')
  assert(updated.commercial.accessCodeHash === 'hash-1', 'provenance must carry through to the final commercial record')
  assert(updated.commercial.commercialStatus === 'trial')
}

async function testAccessCodeTrialDoesNotUseNormalSevenDayDuration() {
  const anchor = new Date('2026-05-01T00:00:00.000Z')
  const config = baseConfigWithGrant({
    status: 'active', initialSync: { completedAt: anchor.toISOString() },
    accessCodeGrant: { grantType: 'trial', trialDays: 30, plan: 'core', planSource: 'access_code_trial', discountPercent: null, discountFixedCents: null, accessCodeHash: 'h', grantedAt: anchor.toISOString() },
  })
  installFakeTenantConfigStoreSeededWith('t_test-tenant', config)
  const updated = await maybeStartAccessCodeTrial('t_test-tenant', config)
  const sevenDayEnd = new Date(anchor.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const thirtyDayEnd = new Date(anchor.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  assert(updated.commercial.trial.endsAt !== sevenDayEnd, 'must NOT use the normal automatic-trial 7-day duration')
  assert(updated.commercial.trial.endsAt === thirtyDayEnd, `must use the code's own 30-day duration, got ${updated.commercial.trial.endsAt}`)
}

async function testAccessCodeTrialDoesNotTouchNormalTrialEligibilityMarker() {
  // No trialEligibilityStore.js redis client is wired at all in this test --
  // if maybeStartAccessCodeTrial() ever called reserveTrialClaim()/
  // finalizeTrialClaim(), it would throw (store unconfigured -> Unavailable
  // error propagating as an uncaught rejection) rather than silently
  // succeed. A clean pass here is itself the proof it never touches that
  // system.
  const anchor = new Date().toISOString()
  const config = baseConfigWithGrant({ status: 'active', initialSync: { completedAt: anchor } })
  installFakeTenantConfigStoreSeededWith('t_test-tenant', config)
  const updated = await maybeStartAccessCodeTrial('t_test-tenant', config)
  assert(updated.commercial !== null, 'the trial must still start successfully with no trialEligibilityStore wiring at all')
}

async function testAccessCodeGrantExcludesAutomaticGbpTrialEvenWhilePending() {
  // A tenant with accessCodeGrant set (commercial still null, pending
  // activation) must NEVER also start the automatic self-service trial,
  // even if trialEligibility somehow got set too (a future-bug defensive
  // proof, per this phase's own "do not rely solely on commercial !== null"
  // requirement).
  const config = baseConfigWithGrant({
    status: 'active',
    trialEligibility: { eligible: true, markedAt: new Date().toISOString(), source: TRIAL_ELIGIBILITY_SOURCES[0] },
  })
  const result = await maybeStartTrial('t_test-tenant', config)
  assert(result === config, 'maybeStartTrial() must refuse to fire for a tenant with an accessCodeGrant on file, even if trialEligibility is also (incorrectly) set')
}

// ===========================================================================
// Part 3: end-to-end redeem-access-code HTTP flow.
// ===========================================================================

function tick(fn) {
  return new Promise((resolve, reject) => {
    setImmediate(() => { try { resolve(fn()) } catch (err) { reject(err) } })
  })
}

function fakeRedis() {
  const data = {}
  function expired(entry) { return entry.expiresAtMs !== null && Date.now() >= entry.expiresAtMs }
  return {
    get: (key) => tick(() => {
      const e = data[key]
      if (!e || e.kind !== 'string' || expired(e)) return null
      return e.value
    }),
    set: (key, value, opts = {}) => tick(() => {
      const existing = data[key]
      const alive = existing && existing.kind === 'string' && !expired(existing)
      if (opts.nx && alive) return null
      data[key] = { kind: 'string', value, expiresAtMs: opts.ex ? Date.now() + opts.ex * 1000 : null }
      return 'OK'
    }),
    getdel: (key) => tick(() => {
      const e = data[key]
      if (!e || e.kind !== 'string' || expired(e)) { delete data[key]; return null }
      delete data[key]
      return e.value
    }),
    del: (key) => tick(() => {
      const existed = key in data
      delete data[key]
      return existed ? 1 : 0
    }),
    hget: (key, field) => tick(() => {
      const e = data[key]
      if (!e || e.kind !== 'hash') return null
      return e.value[field] ?? null
    }),
    hgetall: (key) => tick(() => (data[key]?.kind === 'hash' ? { ...data[key].value } : {})),
    hset: (key, fields) => tick(() => {
      data[key] ??= { kind: 'hash', value: {}, expiresAtMs: null }
      Object.assign(data[key].value, fields)
    }),
    hdel: (key, field) => tick(() => {
      const e = data[key]
      if (!e || !(field in e.value)) return 0
      delete e.value[field]
      return 1
    }),
    // Phase B.8 pre-commit correction: also emulates REDEEM_SCRIPT's
    // durable redemption-claim write (KEYS[2]/ARGV[5]/ARGV[6]) atomically
    // alongside the redemptionCount increment.
    eval: (_script, keys, args) => tick(() => {
      const key = keys[0]
      const claimKey = keys[1]
      const [codeHash, tenantId, userId, nowIso, claimPayload, claimTtlSecondsStr] = args
      const entry = data[key]
      const raw = entry?.kind === 'hash' ? entry.value[codeHash] : null
      if (!raw) return false
      let code
      try { code = JSON.parse(raw) } catch { return false }
      if (code.status !== 'active') return false
      if (code.expiresAt && code.expiresAt < nowIso) return false
      if (code.redemptionCount >= code.maxRedemptions) return false
      code.redemptionCount += 1
      code.redemptions = code.redemptions || []
      code.redemptions.push({ tenantId, userId, redeemedAt: nowIso })
      entry.value[codeHash] = JSON.stringify(code)
      if (claimKey && claimPayload !== undefined) {
        data[claimKey] = { kind: 'string', value: claimPayload, expiresAtMs: Date.now() + Number(claimTtlSecondsStr) * 1000 }
      }
      return JSON.stringify(code)
    }),
    _raw: data,
  }
}

function installFakeRedis() {
  const client = fakeRedis()
  setPendingClient(() => client)
  setTokenClient(() => client)
  setTenantConfigClient(() => client)
  setUserStoreClient(() => client)
  setAccessCodeClient(() => client)
  return client
}

let sentEmails
function installWorkingEmailTransport() {
  sentEmails = []
  _setTransportForTests(() => ({
    sendMail: async (opts) => { sentEmails.push(opts); return { messageId: 'test-message-id', response: '250 OK' } },
  }))
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

function cookieFromRes(res, name) {
  const setCookie = res.headers['Set-Cookie']
  if (!setCookie) return null
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const c of list) {
    if (c.startsWith(`${name}=`)) return `${name}=${c.split(`${name}=`)[1].split(';')[0]}`
  }
  return null
}

const VALID_PASSWORD = 'correct-horse-battery-staple'
function registerBody(overrides = {}) {
  return {
    email: 'newowner@example.com', password: VALID_PASSWORD, passwordConfirmation: VALID_PASSWORD,
    displayName: 'New Owner', companyName: 'Sunset Grill Group', ...overrides,
  }
}

function extractVerifyToken() {
  const { text } = sentEmails[sentEmails.length - 1]
  return decodeURIComponent(text.match(/token=([A-Za-z0-9%_-]+)/)[1])
}

async function registerAndVerify(overrides = {}) {
  const body = registerBody(overrides)
  await invoke('register', body)
  const token = extractVerifyToken()
  const verifyRes = await invoke('verify-email', { token })
  const cookie = cookieFromRes(verifyRes, PENDING_SIGNUP_COOKIE)
  const pending = await getPendingRegistration(body.email)
  return { body, cookie, pending }
}

async function makeAccessCode(overrides = {}) {
  const { rawCode, record } = await createAccessCode({ prefix: 'LTA-B8', plan: 'core', paymentRequired: false, createdBy: 'usr_admin', ...overrides })
  return { rawCode, record }
}

async function testCoreNonTrialCodeProducesActiveCanonicalState() {
  installFakeRedis(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify()
  const { rawCode } = await makeAccessCode({ plan: 'core' })
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const config = await getTenantConfig(pending.tenantIdReserved)
  assert(config.commercial.commercialStatus === 'active' && config.commercial.plan === 'core' && config.commercial.planSource === 'access_code')
  const entitlements = resolveTenantEntitlementsFromConfig(config)
  assert(entitlements.plan === 'core' && entitlements.commercialStatus === 'active', 'the resolver must see a real, enforced Core tenant, never legacy/unmanaged')
}

async function testGrowthNonTrialCodeProducesActiveCanonicalState() {
  installFakeRedis(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'growth-owner@example.com' })
  const { rawCode } = await makeAccessCode({ prefix: 'LTA-GRW', plan: 'growth' })
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const config = await getTenantConfig(pending.tenantIdReserved)
  assert(config.commercial.plan === 'growth' && config.commercial.commercialStatus === 'active')
}

async function testEnterpriseCodeProducesActiveCanonicalStateWithBaselineLimits() {
  installFakeRedis(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'ent-owner@example.com' })
  const { rawCode } = await makeAccessCode({ prefix: 'LTA-ENT', plan: 'enterprise' })
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const config = await getTenantConfig(pending.tenantIdReserved)
  assert(config.commercial.plan === 'enterprise' && config.commercial.limitsOverride === null,
    'an access code must never itself carry a custom limitsOverride -- enterprise access codes get the baseline enterprise entitlement only')
}

async function testTrialCodeLeavesCommercialNullUntilActivation() {
  installFakeRedis(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'trial-owner@example.com' })
  const { rawCode } = await makeAccessCode({ prefix: 'LTA-TRL', plan: 'growth', trialDays: 21 })
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const config = await getTenantConfig(pending.tenantIdReserved)
  // Phase B.8 pre-commit correction (final): commercial is the EXPLICIT
  // 'trial_pending_activation' shape immediately -- NEVER null. A trial
  // access code must not silently start the real clock at tenant-creation
  // time, but it must ALSO never resolve as unrestricted legacy/unmanaged
  // during onboarding, which a null commercial would.
  assert(config.commercial !== null, 'a trial access code must NEVER leave commercial null -- that would resolve as legacy/unmanaged during onboarding')
  assert(config.commercial.commercialStatus === 'trial_pending_activation' && config.commercial.plan === 'growth')
  assert(config.commercial.trial === null, 'no real trial dates exist yet -- the clock has not started')
  assert(config.accessCodeGrant.grantType === 'trial' && config.accessCodeGrant.trialDays === 21)

  // The resolver must see genuine, restrictive pending-activation
  // entitlements -- never legacy/unmanaged, never full trial access.
  const entitlements = resolveTenantEntitlementsFromConfig(config)
  assert(entitlements.reason === 'trial_pending_activation', `sanity: must resolve to the explicit pending-activation reason, got reason=${entitlements.reason}`)
  assert(entitlements.plan !== 'legacy_unmanaged', 'must never resolve as legacy/unmanaged')
  assert(entitlements.limits.aiAllowanceMonthly.usageUnits === 0, 'AI allowance before activation must be zero')
  assert(entitlements.limits.storageBytes === 0 && entitlements.limits.assetCount === 0, 'storage/asset creation before activation must be zero')
  assert(entitlements.limits.maxLocations === 1 && entitlements.limits.maxActiveUsers === 3, 'onboarding numeric capacity must use the Trial safety limits')
  assert(Object.values(entitlements.features).every(v => v === false), 'premium features before activation must all be false')
}

async function testPaymentRequiredCodeRejectedWithoutBurningIt() {
  installFakeRedis(); installWorkingEmailTransport()
  const { cookie } = await registerAndVerify({ email: 'payer@example.com' })
  const { rawCode, record } = await makeAccessCode({ prefix: 'LTA-PAY', plan: 'growth', paymentRequired: true, maxRedemptions: 1 })
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 400 && res.body.error === 'payment_not_yet_supported', `expected a stable payment_not_yet_supported error, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const stored = await getAccessCodeByHash(record.codeHash)
  assert(stored.redemptionCount === 0, 'a rejected payment-required code must NEVER be burned -- redemptionCount must stay 0')
  assert((await getTenantConfig((await getPendingRegistration('payer@example.com'))?.tenantIdReserved)) === null, 'no tenant/commercial state may be created for a rejected payment-required code')
}

async function testDiscountMetadataPreservedThroughRedemption() {
  installFakeRedis(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'discount-owner@example.com' })
  const { rawCode } = await makeAccessCode({ prefix: 'LTA-DISC', plan: 'growth', discountPercent: 30 })
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const config = await getTenantConfig(pending.tenantIdReserved)
  assert(config.commercial.discountPercent === 30, 'discount metadata must be preserved into the canonical commercial write')
}

async function testInvalidPlanCannotBeUsedToRedeem() {
  // createAccessCode() itself is the authoritative gate -- a code can never
  // even be MINTED with an invalid plan, so this proves the gate, not a
  // redemption-time bypass.
  installFakeRedis()
  let threw = null
  try {
    await createAccessCode({ prefix: 'LTA-BADPLAN', plan: 'ultra_mega_plan', createdBy: 'usr_admin' })
  } catch (e) { threw = e }
  assert(threw instanceof TypeError, 'an invalid plan must be rejected at code-creation time, the authoritative gate')
}

async function testInvalidTrialDaysCannotBeUsedToRedeem() {
  installFakeRedis()
  let threw = null
  try {
    await createAccessCode({ prefix: 'LTA-BADTRIAL', plan: 'growth', trialDays: 9999, createdBy: 'usr_admin' })
  } catch (e) { threw = e }
  assert(threw instanceof TypeError, 'an absurd trialDays value must be rejected at code-creation time, never able to grant a multi-year trial')
}

async function testExpiredCodeCreatesNoTenantOrCommercialState() {
  installFakeRedis(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'expired-owner@example.com' })
  const pastDate = new Date(Date.now() - 60_000).toISOString()
  const { rawCode } = await makeAccessCode({ prefix: 'LTA-EXP', expiresAt: pastDate })
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 400 && res.body.error === 'invalid_access_code')
  assert((await getTenantConfig(pending.tenantIdReserved)) === null, 'an expired code must never result in tenant/commercial state')
}

async function testMaxRedemptionReachedCreatesNoTenantOrCommercialState() {
  installFakeRedis(); installWorkingEmailTransport()
  const { rawCode } = await makeAccessCode({ prefix: 'LTA-MAX', maxRedemptions: 1 })
  // Burn the single slot with an unrelated redemption first.
  const { cookie: firstCookie } = await registerAndVerify({ email: 'first-user@example.com' })
  const firstRes = await invoke('redeem-access-code', { code: rawCode }, { cookie: firstCookie })
  assert(firstRes.statusCode === 200, 'sanity: first redemption must succeed')

  const { cookie, pending } = await registerAndVerify({ email: 'second-user@example.com' })
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 400 && res.body.error === 'invalid_access_code')
  assert((await getTenantConfig(pending.tenantIdReserved)) === null, 'a maxRedemptions-exhausted code must never result in a second tenant')
}

async function testEmailMismatchCreatesNoTenantOrCommercialState() {
  installFakeRedis(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'wrong-person@example.com' })
  const { rawCode } = await makeAccessCode({ prefix: 'LTA-VIP', allowedEmail: 'vip@example.com' })
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 400 && res.body.error === 'invalid_access_code')
  assert((await getTenantConfig(pending.tenantIdReserved)) === null)
}

async function testDomainMismatchCreatesNoTenantOrCommercialState() {
  installFakeRedis(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'someone@othercompany.com' })
  const { rawCode } = await makeAccessCode({ prefix: 'LTA-DOM', allowedEmailDomain: 'realcompany.com' })
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 400 && res.body.error === 'invalid_access_code')
  assert((await getTenantConfig(pending.tenantIdReserved)) === null)
}

// --- Atomicity / partial-failure / retry -----------------------------------

async function testFinalRedemptionRaceExactlyOneWins() {
  installFakeRedis(); installWorkingEmailTransport()
  const { rawCode } = await makeAccessCode({ prefix: 'LTA-RACE', maxRedemptions: 1 })
  const { cookie: cookieA } = await registerAndVerify({ email: 'racer-a@example.com' })
  const { cookie: cookieB } = await registerAndVerify({ email: 'racer-b@example.com' })
  const [a, b] = await Promise.all([
    invoke('redeem-access-code', { code: rawCode }, { cookie: cookieA }),
    invoke('redeem-access-code', { code: rawCode }, { cookie: cookieB }),
  ])
  const successes = [a, b].filter(r => r.statusCode === 200)
  const failures = [a, b].filter(r => r.statusCode !== 200)
  assert(successes.length === 1, `expected exactly one winner, got ${successes.length} (statuses: ${a.statusCode}, ${b.statusCode})`)
  assert(failures.length === 1 && failures[0].body.error === 'invalid_access_code')
}

async function testPartialFailureAfterRedemptionThenLegitimateRetrySucceedsExactlyOnce() {
  installWorkingEmailTransport()
  // Wrap the SAME underlying fake store's set() (never a second, separate
  // fakeRedis() instance -- that would silently lose every record
  // registerAndVerify() already wrote) so exactly one call to the
  // tenant-creation lock key fails, simulating a transient store outage
  // between a successful code redemption and tenant creation completing.
  const client = fakeRedis()
  let failNext = true
  const originalSet = client.set.bind(client)
  client.set = async (key, value, opts) => {
    if (failNext && key.startsWith('pending_registration_lock:')) {
      failNext = false
      throw new Error('simulated-lock-store-outage')
    }
    return originalSet(key, value, opts)
  }
  setPendingClient(() => client); setTokenClient(() => client); setTenantConfigClient(() => client); setUserStoreClient(() => client); setAccessCodeClient(() => client)

  const { body, cookie, pending } = await registerAndVerify({ email: 'partial-fail@example.com' })
  const { rawCode, record } = await makeAccessCode({ prefix: 'LTA-PARTIAL', maxRedemptions: 1 })

  const firstAttempt = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(firstAttempt.statusCode === 503, `sanity: the simulated outage must surface as 503, got ${firstAttempt.statusCode}: ${JSON.stringify(firstAttempt.body)}`)

  // The code IS already consumed (redeemAccessCode() succeeded before the
  // simulated failure) -- confirm the DURABLE redemption-claim ledger
  // (accessCodeStore.js) recorded it atomically, independent of the
  // pending-registration record's own (shorter-lived) lifecycle.
  const claim = await getAccessCodeRedemptionClaim(body.email)
  assert(claim && claim.plan === 'core', 'the successful redemption must be recorded in the durable claim ledger before tenant creation is attempted')

  // The legitimate customer retries with the SAME cookie (no code needed --
  // the endpoint resumes from the durable claim).
  const retry = await invoke('redeem-access-code', {}, { cookie })
  assert(retry.statusCode === 200, `the legitimate retry must succeed WITHOUT re-redeeming the code, got ${retry.statusCode}: ${JSON.stringify(retry.body)}`)

  const finalConfig = await getTenantConfig(pending.tenantIdReserved)
  assert(finalConfig && finalConfig.commercial.plan === 'core', 'the tenant must now exist with the correct commercial state')
  const codeAfter = await getAccessCodeByHash(record.codeHash)
  assert(codeAfter.redemptionCount === 1, 'the code must have been consumed EXACTLY once across both attempts, never twice')

  // Successful tenant creation must finalize (clear) the durable claim.
  assert((await getAccessCodeRedemptionClaim(body.email)) === null, 'a successful tenant creation must clear the redemption claim')
}

// Phase B.8 -- COMMIT-approval correction (Section 3, code-expiry case).
// The recovery claim represents an already-consumed, already-authorized
// grant -- not a fresh redemption attempt -- so it must survive the
// underlying code SUBSEQUENTLY expiring after the original successful
// consume. getAccessCodeRedemptionClaim() re-derives its fields directly
// from the access-code record via the stored codeHash pointer, never
// re-running validateAccessCodeForRedemption()'s status/expiry/count
// checks -- this test proves that design choice is actually exercised
// end-to-end, not just true by code inspection.
async function testRetrySucceedsEvenAfterCodeSubsequentlyExpires() {
  installWorkingEmailTransport()
  const client = fakeRedis()
  let failNext = true
  const originalSet = client.set.bind(client)
  client.set = async (key, value, opts) => {
    if (failNext && key.startsWith('pending_registration_lock:')) {
      failNext = false
      throw new Error('simulated-lock-store-outage')
    }
    return originalSet(key, value, opts)
  }
  setPendingClient(() => client); setTokenClient(() => client); setTenantConfigClient(() => client); setUserStoreClient(() => client); setAccessCodeClient(() => client)

  const { body, cookie, pending } = await registerAndVerify({ email: 'expires-after-consume@example.com' })
  const { rawCode, record } = await makeAccessCode({ prefix: 'LTA-EXP', maxRedemptions: 1 })

  const firstAttempt = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(firstAttempt.statusCode === 503, `sanity: the simulated outage must surface as 503, got ${firstAttempt.statusCode}: ${JSON.stringify(firstAttempt.body)}`)

  const claim = await getAccessCodeRedemptionClaim(body.email)
  assert(claim && claim.plan === 'core', 'sanity: the redemption must already be recorded as a durable claim before the code is made to expire')

  // The code subsequently expires -- this must NOT invalidate an
  // already-authorized recovery claim.
  const stored = JSON.parse(client._raw['access_codes:v1'].value[record.codeHash])
  stored.expiresAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  client._raw['access_codes:v1'].value[record.codeHash] = JSON.stringify(stored)

  const retry = await invoke('redeem-access-code', {}, { cookie })
  assert(retry.statusCode === 200, `retry must succeed even though the underlying code has since expired, got ${retry.statusCode}: ${JSON.stringify(retry.body)}`)

  const finalConfig = await getTenantConfig(pending.tenantIdReserved)
  assert(finalConfig && finalConfig.commercial.plan === 'core', 'the tenant must be created from the recovered claim despite the code now being expired')
}

// Same principle as above, for the maxRedemptions-reached case: other
// legitimate redeemers consuming the remaining slots after this
// registrant's own successful (but not-yet-finalized) redemption must not
// strip them of their already-authorized recovery claim.
async function testRetrySucceedsEvenAfterMaxRedemptionsSubsequentlyReached() {
  installWorkingEmailTransport()
  const client = fakeRedis()
  let failNext = true
  const originalSet = client.set.bind(client)
  client.set = async (key, value, opts) => {
    if (failNext && key.startsWith('pending_registration_lock:')) {
      failNext = false
      throw new Error('simulated-lock-store-outage')
    }
    return originalSet(key, value, opts)
  }
  setPendingClient(() => client); setTokenClient(() => client); setTenantConfigClient(() => client); setUserStoreClient(() => client); setAccessCodeClient(() => client)

  const { body, cookie, pending } = await registerAndVerify({ email: 'exhausted-after-consume@example.com' })
  const { rawCode, record } = await makeAccessCode({ prefix: 'LTA-MAX', maxRedemptions: 2 })

  const firstAttempt = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(firstAttempt.statusCode === 503, `sanity: the simulated outage must surface as 503, got ${firstAttempt.statusCode}: ${JSON.stringify(firstAttempt.body)}`)

  const claim = await getAccessCodeRedemptionClaim(body.email)
  assert(claim && claim.plan === 'core', 'sanity: the redemption must already be recorded as a durable claim before the code is exhausted by other redeemers')

  // Other legitimate redeemers consume the remaining slots -- the code is
  // now fully exhausted from a fresh-redemption point of view. This must
  // NOT invalidate this registrant's own already-authorized recovery claim.
  const stored = JSON.parse(client._raw['access_codes:v1'].value[record.codeHash])
  stored.redemptionCount = stored.maxRedemptions
  client._raw['access_codes:v1'].value[record.codeHash] = JSON.stringify(stored)

  const retry = await invoke('redeem-access-code', {}, { cookie })
  assert(retry.statusCode === 200, `retry must succeed even though the code is now fully exhausted, got ${retry.statusCode}: ${JSON.stringify(retry.body)}`)

  const finalConfig = await getTenantConfig(pending.tenantIdReserved)
  assert(finalConfig && finalConfig.commercial.plan === 'core', 'the tenant must be created from the recovered claim despite the code now being exhausted')
}

async function testDifferentUserCannotReplayAnotherRegistrantsStoredRedemption() {
  installFakeRedis(); installWorkingEmailTransport()
  const { cookie: cookieA } = await registerAndVerify({ email: 'owner-a@example.com' })
  const { rawCode } = await makeAccessCode({ prefix: 'LTA-ISOL', maxRedemptions: 5 })
  const resA = await invoke('redeem-access-code', { code: rawCode }, { cookie: cookieA })
  assert(resA.statusCode === 200, 'sanity: A must succeed')

  // A completely different registrant, with their OWN pending-signup
  // cookie, must never be able to "resume" using A's stored redemption --
  // there is structurally no shared state between the two (each pending
  // registration is its own Redis record, keyed by the registrant's own
  // email), and B never even attempted a redemption, so B must still need
  // to supply a real code.
  const { cookie: cookieB } = await registerAndVerify({ email: 'owner-b@example.com' })
  const resB = await invoke('redeem-access-code', {}, { cookie: cookieB })
  assert(resB.statusCode === 400 && resB.body.error === 'invalid_request', "a registrant with no code and no stored redemption of their own must be asked for a code, never silently inherit another registrant's")
}

// ===========================================================================
// Part 4: security / spoofing.
// ===========================================================================

async function testClientCannotSpoofPlanTrialDaysDiscountsPaymentOrStatus() {
  installFakeRedis(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'spoofer@example.com' })
  const { rawCode } = await makeAccessCode({ prefix: 'LTA-SPF', plan: 'core', trialDays: null, discountPercent: null })
  const res = await invoke('redeem-access-code', {
    code: rawCode,
    // Every one of these must be completely ignored -- redeemAccessCodeAction()
    // never even destructures them from the body.
    plan: 'enterprise', trialDays: 365, discountPercent: 100, discountFixedCents: 99999,
    paymentRequired: false, commercialStatus: 'active', trialStartedAt: '2000-01-01T00:00:00.000Z', trialEndsAt: '2999-01-01T00:00:00.000Z',
  }, { cookie })
  assert(res.statusCode === 200)
  const config = await getTenantConfig(pending.tenantIdReserved)
  assert(config.commercial.plan === 'core', `plan must come only from the server-validated code, got ${config.commercial.plan}`)
  assert(config.commercial.trial === null, 'trialDays must come only from the code, never the request body')
  assert(config.commercial.discountPercent === null, 'discountPercent must come only from the code')
  assert(config.commercial.createdAt !== '2000-01-01T00:00:00.000Z', 'timestamps must be server-generated, never client-supplied')
}

async function testRawAccessCodeNeverPersistedInTenantConfig() {
  installFakeRedis(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'rawcheck@example.com' })
  const { rawCode } = await makeAccessCode({ prefix: 'LTA-RAWCHK' })
  await invoke('redeem-access-code', { code: rawCode }, { cookie })
  const config = await getTenantConfig(pending.tenantIdReserved)
  const serialized = JSON.stringify(config)
  assert(!serialized.includes(rawCode), 'the raw access code must never be persisted anywhere in tenant_config')
  assert(config.commercial.accessCodeHash === hashAccessCode(rawCode), 'only the hash may be persisted')
}

// ===========================================================================
// Part 5: old-shape compatibility.
// ===========================================================================

function testOldShapeAccessCodeCommercialStillResolvesAsLegacyUnmanaged() {
  // A pre-B.8 tenant, written before this phase existed -- must remain
  // exactly as unenforced/legacy as it always was; no automatic
  // reinterpretation as newly-paid-active, and no crash.
  const oldShapeConfig = {
    commercial: { plan: 'growth', source: 'access_code', accessCodeHash: 'old-hash', trialEndsAt: null },
    createdAt: new Date().toISOString(),
  }
  const entitlements = resolveTenantEntitlementsFromConfig(oldShapeConfig)
  assert(entitlements.reason === 'legacy_commercial_shape', `an old-shape access-code record must still resolve as legacy/unmanaged, got reason=${entitlements.reason}`)
}

// ===========================================================================
// Part 6: B.7 compatibility -- the new canonical commercial state
// automatically participates in every existing B.7 operation-class check,
// with NO endpoint-specific access-code exceptions.
// ===========================================================================

async function seedAccessCodeActiveTenant(tenantId, plan, commercialStatus = 'active') {
  const owner = { userId: 'usr_owner', email: 'owner@example.com', passwordHash: 'x', role: 'owner', locationIds: '*', tenantId, sessionVersion: 1, disabled: false, displayName: 'Owner' }
  await upsertTenantConfig(tenantId, {
    status: 'active', locationCatalogEnabled: true,
    commercial: {
      commercialStatus, plan, planSource: 'access_code', trial: null,
      limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
      accessCodeHash: 'h', discountPercent: null, discountFixedCents: null, paymentRequired: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
  }, { allowCreate: true, creationSource: 'self_service' })
  await upsertUser(tenantId, owner, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: owner })
  return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
}

async function testAccessCodeSuspendedTenantGetsNormalB7Enforcement() {
  installFakeRedis()
  setSeatLockClient(() => ({
    set: async (key, _v, opts) => 'OK',
    del: async () => 1,
    eval: async () => 1,
  }))
  setAuditClient(() => null)
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: true, remaining: 999, reset: Date.now() + 60000 }) }))
  const tenantId = 't_b8-b7-compat'
  const token = await seedAccessCodeActiveTenant(tenantId, 'growth', 'suspended')
  const req = {
    method: 'POST', query: { action: 'invite-user' },
    body: { name: 'New', email: 'new@example.com', role: 'read_only', locationIds: '*' },
    headers: { cookie: `${SESSION_COOKIE}=${await token}` }, socket: { remoteAddress: '127.0.0.1' },
  }
  const res = fakeRes()
  await settingsHandler(req, res)
  assert(res.statusCode === 403 && res.body.error === 'commercial_access_restricted',
    `an access-code-created tenant must get NORMAL B.7 suspended enforcement, no special-casing, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// ===========================================================================
// Part 7: pending-trial ('trial_pending_activation') operation-class policy
// -- the exact allow/deny matrix every endpoint (Google publish/connect/
// discover, content upload/create-text-asset, tasks, invite-user,
// recordLocationApproval, AI) consults via requireCommercialOperation().
// This is the single source of truth every one of those call sites already
// reads from (unchanged by this phase) -- proving the matrix here is a
// faithful proof of the behavior at every one of those endpoints, since
// none of them special-case access codes or this status.
// ===========================================================================

function pendingActivationEntitlements() {
  return resolveTenantEntitlementsFromConfig({ commercial: pendingActivationCommercial(), createdAt: new Date().toISOString() })
}

function testPendingActivationDeniesAllProductConsumptionButAllowsOnboarding() {
  const entitlements = pendingActivationEntitlements()
  assert(entitlements.commercialStatus === 'trial_pending_activation')

  // DENY: normal product consumption / cost-generating actions. This is
  // exactly the class every AI call (rewrite/executive-brief), Google
  // review publish, content upload/create-text-asset, and ordinary task/
  // campaign mutation is gated by.
  for (const cls of [CommercialOperationClass.OPERATIONAL_WRITE, CommercialOperationClass.COST_GENERATING, CommercialOperationClass.INTEGRATION_OPERATION]) {
    const result = requireCommercialOperation(entitlements, cls)
    assert(result.allowed === false, `${cls} must be denied during pending-trial activation, got ${JSON.stringify(result)}`)
  }

  // ALLOW: exactly what onboarding needs -- Google connect/discover
  // (INTEGRATION_EXPANSION) and first-location/seat capacity
  // (CAPACITY_EXPANSION), plus the universally-safe classes.
  for (const cls of [CommercialOperationClass.INTEGRATION_EXPANSION, CommercialOperationClass.CAPACITY_EXPANSION, CommercialOperationClass.READ_BASIC, CommercialOperationClass.SECURITY_MAINTENANCE, CommercialOperationClass.RESOURCE_REDUCTION]) {
    const result = requireCommercialOperation(entitlements, cls)
    assert(result.allowed === true, `${cls} must be allowed during pending-trial activation (required for onboarding), got ${JSON.stringify(result)}`)
  }
}

function testPendingActivationAiAndStorageAreZeroed() {
  const entitlements = pendingActivationEntitlements()
  assert(entitlements.limits.aiAllowanceMonthly.usageUnits === 0, 'AI allowance before activation must be zero -- denies every AI call via B.4\'s existing quota mechanism, no new code needed')
  assert(entitlements.limits.storageBytes === 0 && entitlements.limits.assetCount === 0, 'storage/asset creation before activation must be zero -- denies every upload/create-text-asset via B.4\'s existing quota mechanism')
  assert(Object.values(entitlements.features).every(v => v === false), 'every premium feature must be denied before activation')
}

function testPendingActivationOnboardingNumericCapacityMatchesTrialSafetyLimits() {
  const entitlements = pendingActivationEntitlements()
  assert(entitlements.limits.maxLocations === 1, 'maxLocations must match the Trial safety limit (enough for the first approved location)')
  assert(entitlements.limits.maxActiveUsers === 3, 'maxActiveUsers must match the Trial safety limit')
}

async function testFirstLocationApprovalSucceedsDuringPendingActivation() {
  installFakeConfigRedisForResolver()
  const tenantId = 't_b8-pending-loc'
  await upsertTenantConfig(tenantId, { commercial: pendingActivationCommercial() }, { allowCreate: true, creationSource: 'self_service' })
  const { recordLocationApproval } = await import('../dashboard/api/_lib/tenantConfigStore.js')
  const result = await recordLocationApproval(tenantId, [{ googleLocationId: 'accounts/1/locations/1', title: 'First Location', address: '' }])
  assert(result.approvedLocations.length === 1, 'the first location approval (CAPACITY_EXPANSION, bounded by maxLocations: 1) must succeed during pending-trial activation')
}

async function testSecondLocationDeniedDuringPendingActivationNumericCeiling() {
  installFakeConfigRedisForResolver()
  const tenantId = 't_b8-pending-loc2'
  await upsertTenantConfig(tenantId, { commercial: pendingActivationCommercial() }, { allowCreate: true, creationSource: 'self_service' })
  const { recordLocationApproval, MaxLocationsExceededError } = await import('../dashboard/api/_lib/tenantConfigStore.js')
  let threw = null
  try {
    await recordLocationApproval(tenantId, [
      { googleLocationId: 'accounts/1/locations/1', title: 'First', address: '' },
      { googleLocationId: 'accounts/1/locations/2', title: 'Second', address: '' },
    ])
  } catch (e) { threw = e }
  assert(threw instanceof MaxLocationsExceededError, 'a second location must still be denied by the numeric maxLocations: 1 ceiling even though CAPACITY_EXPANSION itself is allowed')
}

function installFakeConfigRedisForResolver() {
  const store = {}
  setTenantConfigClient(() => ({
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
}

async function testDelayedReconciliationPreservesOriginalClock() {
  // The tenantStatus() poll that eventually observes 'active' + a real
  // initialSync.completedAt can happen an arbitrary amount of time AFTER
  // the sync itself completed (infrequent polling, an outage, etc.) --
  // trialStartedAt/trialEndsAt must be computed from the ANCHOR, never
  // from whenever this function happens to run.
  installFakeConfigRedisForResolver()
  const tenantId = 't_b8-delayed-reconcile'
  const anchor = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) // 10 days ago
  const config = {
    configVersion: 0, status: 'active', commercial: pendingActivationCommercial(),
    accessCodeGrant: { grantType: 'trial', trialDays: 14, plan: 'growth', planSource: 'access_code_trial', discountPercent: null, discountFixedCents: null, accessCodeHash: 'h', grantedAt: anchor.toISOString() },
    initialSync: { completedAt: anchor.toISOString() },
  }
  await upsertTenantConfig(tenantId, config, { allowCreate: true, creationSource: 'self_service' })
  const stored = await getTenantConfig(tenantId)
  // Simulate this observation running "late" (well after the anchor) --
  // Date.now() at call time is naturally already 10 days after the anchor.
  const updated = await maybeStartAccessCodeTrial(tenantId, stored)
  assert(updated.commercial.trial.startedAt === anchor.toISOString(), `trialStartedAt must equal the original anchor regardless of when this observation runs, got ${updated.commercial.trial.startedAt}`)
  const expectedEnds = new Date(anchor.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString()
  assert(updated.commercial.trial.endsAt === expectedEnds, 'trialEndsAt must be computed from the original anchor, never extended by the delay')
}

async function testExpiredBeforeReconciliationBecomesImmediatelySuspended() {
  // The anchor is far enough in the past that trialDays has ALREADY
  // elapsed by the time this observation runs -- maybeStartAccessCodeTrial()
  // still writes the (now-already-expired) trial object faithfully (no
  // fresh clock), and the VERY NEXT resolution immediately reports
  // suspended/trial_expired -- no separate grace window.
  installFakeConfigRedisForResolver()
  const tenantId = 't_b8-expired-before-reconcile'
  const anchor = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago
  const config = {
    configVersion: 0, status: 'active', commercial: pendingActivationCommercial(),
    accessCodeGrant: { grantType: 'trial', trialDays: 14, plan: 'growth', planSource: 'access_code_trial', discountPercent: null, discountFixedCents: null, accessCodeHash: 'h', grantedAt: anchor.toISOString() },
    initialSync: { completedAt: anchor.toISOString() },
  }
  await upsertTenantConfig(tenantId, config, { allowCreate: true, creationSource: 'self_service' })
  const stored = await getTenantConfig(tenantId)
  const updated = await maybeStartAccessCodeTrial(tenantId, stored)
  const entitlements = resolveTenantEntitlementsFromConfig(updated)
  assert(entitlements.commercialStatus === 'suspended' && entitlements.reason === 'trial_expired',
    `a trial whose anchor already precedes trialDays' elapse must resolve as suspended/trial_expired immediately, got ${entitlements.commercialStatus}/${entitlements.reason}`)
}

const tests = [
  // --- Part 1 ---
  ['non-trial redemption produces immediate active canonical commercial state', testNonTrialProducesImmediateActiveCanonicalCommercial],
  ['trialDays: 0 is treated as non-trial', testTrialDaysZeroIsTreatedAsNonTrial],
  ['a trial grant defers commercial until activation', testTrialGrantDefersCommercialUntilActivation],
  ['paymentRequired: true is rejected', testPaymentRequiredTrueIsRejected],
  ['an invalid plan is rejected defensively', testInvalidPlanIsRejected],
  ['invalid trialDays is rejected defensively', testInvalidTrialDaysIsRejected],
  ['discount metadata is preserved but never changes limits/features', testDiscountMetadataIsPreservedButNeverInterpreted],

  // --- Part 2 ---
  ['access-code trial does not start before activation', testAccessCodeTrialDoesNotStartBeforeActivation],
  ['access-code trial does not start without an initialSync anchor', testAccessCodeTrialDoesNotStartWithoutInitialSyncAnchor],
  ['access-code trial starts anchored to initialSync.completedAt, not registration', testAccessCodeTrialStartsAnchoredToInitialSyncNotRegistration],
  ['access-code trial does not use the normal 7-day duration', testAccessCodeTrialDoesNotUseNormalSevenDayDuration],
  ['access-code trial never touches the normal trialEligibilityStore claim system', testAccessCodeTrialDoesNotTouchNormalTrialEligibilityMarker],
  ['a pending accessCodeGrant excludes the automatic GBP trial even before activation', testAccessCodeGrantExcludesAutomaticGbpTrialEvenWhilePending],

  // --- Part 3: end-to-end ---
  ['Core non-trial code produces active canonical state', testCoreNonTrialCodeProducesActiveCanonicalState],
  ['Growth non-trial code produces active canonical state', testGrowthNonTrialCodeProducesActiveCanonicalState],
  ['Enterprise code produces active canonical state with baseline limits only', testEnterpriseCodeProducesActiveCanonicalStateWithBaselineLimits],
  ['trial code leaves commercial null until activation', testTrialCodeLeavesCommercialNullUntilActivation],
  ['paymentRequired code is rejected WITHOUT burning it', testPaymentRequiredCodeRejectedWithoutBurningIt],
  ['discount metadata preserved through real redemption', testDiscountMetadataPreservedThroughRedemption],
  ['invalid plan cannot be used to create a code at all', testInvalidPlanCannotBeUsedToRedeem],
  ['invalid trialDays cannot be used to create a code at all', testInvalidTrialDaysCannotBeUsedToRedeem],
  ['expired code creates no tenant/commercial state', testExpiredCodeCreatesNoTenantOrCommercialState],
  ['max-redemption-reached code creates no tenant/commercial state', testMaxRedemptionReachedCreatesNoTenantOrCommercialState],
  ['email-mismatch code creates no tenant/commercial state', testEmailMismatchCreatesNoTenantOrCommercialState],
  ['domain-mismatch code creates no tenant/commercial state', testDomainMismatchCreatesNoTenantOrCommercialState],

  ['final redemption race: exactly one wins', testFinalRedemptionRaceExactlyOneWins],
  ['partial failure after redemption: legitimate retry succeeds, code consumed exactly once', testPartialFailureAfterRedemptionThenLegitimateRetrySucceedsExactlyOnce],
  ['retry succeeds even after the underlying code subsequently expires', testRetrySucceedsEvenAfterCodeSubsequentlyExpires],
  ['retry succeeds even after maxRedemptions is subsequently reached by others', testRetrySucceedsEvenAfterMaxRedemptionsSubsequentlyReached],
  ["a different user cannot replay another registrant's stored redemption", testDifferentUserCannotReplayAnotherRegistrantsStoredRedemption],

  // --- Part 4: security ---
  ['client cannot spoof plan/trialDays/discounts/payment/status/timestamps', testClientCannotSpoofPlanTrialDaysDiscountsPaymentOrStatus],
  ['the raw access code is never persisted in tenant_config', testRawAccessCodeNeverPersistedInTenantConfig],

  // --- Part 5: compatibility ---
  ['an old-shape access-code commercial record still resolves as legacy/unmanaged', testOldShapeAccessCodeCommercialStillResolvesAsLegacyUnmanaged],

  // --- Part 6: B.7 compatibility ---
  ['an access-code suspended tenant gets normal B.7 enforcement, no exceptions', testAccessCodeSuspendedTenantGetsNormalB7Enforcement],

  // --- Part 7: pending-trial ('trial_pending_activation') policy ---
  ['pending-activation denies product consumption, allows onboarding', testPendingActivationDeniesAllProductConsumptionButAllowsOnboarding],
  ['pending-activation AI/storage allowance is zero', testPendingActivationAiAndStorageAreZeroed],
  ['pending-activation onboarding numeric capacity matches Trial safety limits', testPendingActivationOnboardingNumericCapacityMatchesTrialSafetyLimits],
  ['first location approval succeeds during pending activation', testFirstLocationApprovalSucceedsDuringPendingActivation],
  ['a second location is still denied by the numeric ceiling during pending activation', testSecondLocationDeniedDuringPendingActivationNumericCeiling],
  ['delayed reconciliation preserves the original clock', testDelayedReconciliationPreservesOriginalClock],
  ['a trial already expired before reconciliation becomes immediately suspended', testExpiredBeforeReconciliationBecomesImmediatelySuspended],
]

async function main() {
  for (const [name, fn] of tests) await run(name, fn)
  console.log()
  const passed = results.filter(Boolean).length
  if (passed === results.length) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.length - passed} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
