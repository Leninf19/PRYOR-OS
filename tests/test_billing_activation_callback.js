// Phase B.12 (Decision 1) -- regression tests for POST /api/session?action=
// billing-activation-callback: the primary, event-driven, server-to-server
// Subscription-activation trigger invoked by the GitHub Actions tenant-
// lifecycle workflows immediately after their own `initial_sync.py` step
// succeeds. No real Stripe API, no real Redis -- fake clients injected via
// each module's own test-injection seam, exactly like test_trial_lifecycle.js/
// test_subscription_activation.js.
//
// NOTE on workflow-level requirements: "callback failure after bounded
// retries causes visible workflow failure" is a GitHub Actions YAML/bash
// behavior, not something this Node-level test can exercise directly --
// see tests/test_tenant_lifecycle_dispatch_workflow.py's own new
// test_activate_billing_step_has_retry_and_fails_closed_visibly() for that
// coverage.
//
// Run directly: node tests/test_billing_activation_callback.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import handler from '../dashboard/api/session/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import {
  upsertTenantConfig, getTenantConfig, recordLocationApproval,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import {
  _setRedisClientForTests as setClaimRedis, _resetRedisClientForTests as resetClaimRedis,
} from '../dashboard/api/_lib/trialEligibilityStore.js'
import { buildSelfServicePendingActivationCommercial } from '../dashboard/api/_lib/selfServiceCommercial.js'
import {
  _setRedisClientForTests as setBillingRedis, _resetRedisClientForTests as resetBillingRedis,
  createBillingRecord, getBillingRecord,
} from '../dashboard/api/_lib/billingStore.js'
import { _setStripeClientForTests, _resetStripeClientForTests } from '../dashboard/api/_lib/stripeClient.js'
import {
  upsertUser, UserCreationMode,
  _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis,
} from '../dashboard/api/_lib/userStore.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
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
    resetConfigRedis(); resetClaimRedis(); resetBillingRedis(); resetUserRedis(); _resetStripeClientForTests(); _resetLimiterFactoryForTests()
    delete process.env.VERCEL_ENV
    delete process.env.BILLING_ACTIVATION_CALLBACK_SECRET
    delete process.env.PREVIEW_BILLING_ACTIVATION_CALLBACK_SECRET
    delete process.env.STRIPE_CORE_PRICE_ID
    delete process.env.STRIPE_GROWTH_PRICE_ID
  }
}

// --- fakes (deliberately duplicated across test files, matching this
// codebase's own established convention -- see test_trial_lifecycle.js) ---

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
        if (existing.tenantId === tenantId) return [existing.state, existing.claimToken, existing.reservedAt]
        return ['denied', false, false]
      }
      const [tenantId, claimToken, now] = args
      const existing = store[key]
      if (!existing || existing.tenantId !== tenantId || existing.claimToken !== claimToken) return ['denied', false]
      if (existing.state === 'consumed') return ['consumed', true]
      existing.state = 'consumed'
      existing.consumedAt = now
      return ['consumed', true]
    },
  }
}

function fakeBillingRedis() {
  const hashes = {}
  const strings = {}
  return {
    hget: async (key, field) => hashes[key]?.[field] ?? null,
    hset: async (key, fields) => { hashes[key] = { ...(hashes[key] ?? {}), ...fields } },
    hsetnx: async (key, field, value) => {
      hashes[key] = hashes[key] ?? {}
      if (field in hashes[key]) return false
      hashes[key][field] = value
      return true
    },
    get: async (key) => strings[key]?.value ?? null,
    set: async (key, value) => { strings[key] = { value }; return 'OK' },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      if (args.length === 3) {
        const [field, expectedVersionStr, nextJson] = args
        const raw = hashes[key]?.[field] ?? null
        let currentVersion = '0'
        if (raw) { try { const d = JSON.parse(raw); if (d?.version !== undefined) currentVersion = String(d.version) } catch { /* 0 */ } }
        if (currentVersion !== expectedVersionStr) return raw ?? false
        hashes[key] = { ...(hashes[key] ?? {}), [field]: nextJson }
        return true
      }
      if (args.length === 1) {
        const [tenantId] = args
        const existing = strings[key]?.value ?? null
        if (existing) return existing === tenantId ? 1 : 0
        strings[key] = { value: tenantId }
        return 1
      }
      throw new Error('unexpected eval shape in test fake')
    },
  }
}

function fakeStripe() {
  const byIdempotencyKey = new Map()
  let counter = 0
  const createCalls = []
  return {
    subscriptions: {
      create: async (params, opts) => {
        createCalls.push({ params, opts })
        const key = opts?.idempotencyKey
        if (key && byIdempotencyKey.has(key)) return byIdempotencyKey.get(key)
        counter += 1
        const nowSeconds = Math.floor(Date.now() / 1000)
        const subscription = {
          id: `sub_test${counter}`, status: 'trialing', customer: params.customer,
          current_period_start: nowSeconds, current_period_end: params.trial_end,
          cancel_at_period_end: false, metadata: params.metadata ?? {},
        }
        if (key) byIdempotencyKey.set(key, subscription)
        return subscription
      },
    },
    _createCalls: createCalls,
  }
}

function install({ vercelEnv = 'production', secret = 'prod-secret-value-0123456789', previewSecret } = {}) {
  // Each fake must be instantiated ONCE and returned via closure -- the
  // factory passed to _setRedisClientForTests() is invoked fresh on EVERY
  // store operation (matching the real getClient() lazy-init contract), so
  // `() => fakeKeyedHashRedis()` would hand back a brand-new, empty store
  // on every single call and nothing would ever persist between them.
  const configRedis = fakeKeyedHashRedis()
  const claimRedis = fakeTrialClaimRedis()
  const billingRedis = fakeBillingRedis()
  const userRedis = fakeKeyedHashRedis()
  const stripe = fakeStripe()
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: true, remaining: 99 }) }))
  setConfigRedis(() => configRedis)
  setClaimRedis(() => claimRedis)
  setBillingRedis(() => billingRedis)
  setUserRedis(() => userRedis)
  _setStripeClientForTests(() => stripe)
  process.env.STRIPE_CORE_PRICE_ID = 'price_coretest123'
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtest456'
  if (vercelEnv != null) process.env.VERCEL_ENV = vercelEnv
  if (secret != null) process.env.BILLING_ACTIVATION_CALLBACK_SECRET = secret
  if (previewSecret != null) process.env.PREVIEW_BILLING_ACTIVATION_CALLBACK_SECRET = previewSecret
  return { stripe }
}

let tenantCounter = 0
function freshTenantId() { return `t_billing-cb-${++tenantCounter}` }

// Mirrors test_trial_lifecycle.js's own seedActiveTenant() -- a tenant
// already through onboarding -> locations_approved -> 'active', with a
// pending-activation self-service commercial shape and a real
// initialSync.completedAt (initial_sync.py's own write-once field).
async function seedActiveTenant(tenantId, {
  googleLocationId = `accounts/acc-${tenantId}/locations/loc-1`,
  trialEligible = true,
  initialSyncCompletedAt = new Date().toISOString(),
  includeInitialSync = true,
} = {}) {
  await upsertTenantConfig(tenantId, { status: 'onboarding', locationCatalogEnabled: true }, { allowCreate: true, creationSource: 'migration' })
  await recordLocationApproval(tenantId, [{ googleLocationId, title: 'Primary Location', address: '' }])
  const patch = { status: includeInitialSync ? 'active' : 'provisioning' }
  if (includeInitialSync) {
    patch.initialSync = {
      status: 'completed', startedAt: initialSyncCompletedAt, completedAt: initialSyncCompletedAt,
      reviewCount: 0, locationCount: 1, lastError: null,
    }
  }
  if (trialEligible) {
    const { commercial, trialEligibility } = buildSelfServicePendingActivationCommercial()
    patch.commercial = commercial
    patch.trialEligibility = trialEligibility
  }
  await upsertTenantConfig(tenantId, patch, {})
  return getTenantConfig(tenantId)
}

async function seedReadyBillingRecord(tenantId, { plan = 'growth' } = {}) {
  return createBillingRecord(tenantId, {
    stripeCustomerId: 'cus_test1', defaultPaymentMethodId: 'pm_testsavedcard', pendingPaidPlan: plan,
  })
}

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}

async function invokeCallback({ tenantId, secret, method = 'POST', extraBodyFields = {}, noAuthHeader = false }) {
  const req = {
    method,
    query: { action: 'billing-activation-callback' },
    headers: noAuthHeader ? {} : { authorization: `Bearer ${secret}` },
    body: tenantId === undefined ? { ...extraBodyFields } : { tenantId, ...extraBodyFields },
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function invokeTenantStatus(tenantId) {
  const record = { userId: `usr_owner_${tenantId}`, email: `owner-${tenantId}@example.com`, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1, disabled: false, displayName: 'Owner' }
  await upsertUser(tenantId, { ...record, passwordHash: 'x' }, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  const token = await signSession({ userId: record.userId, email: record.email, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
  const req = { method: 'GET', query: { action: 'tenant-status' }, headers: { cookie: `${SESSION_COOKIE}=${token}` } }
  const res = fakeRes()
  await handler(req, res)
  return res
}

const PROD_SECRET = 'prod-secret-value-0123456789'
const PREVIEW_SECRET = 'preview-secret-value-9876543210'

// ===========================================================================
// 1 -- successful initial_sync triggers billing callback without browser
// polling.
// ===========================================================================

async function testCallbackWorksWithoutAnyBrowserOrSessionContext() {
  install()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  await seedReadyBillingRecord(tenantId)
  const req = {
    method: 'POST', query: { action: 'billing-activation-callback' },
    headers: { authorization: `Bearer ${PROD_SECRET}` }, // no cookie header at all
    body: { tenantId },
  }
  const res = fakeRes()
  await handler(req, res)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.subscription.outcome === 'created')
}

// ===========================================================================
// 2 -- callback starts canonical trial only from valid initialSync.completedAt.
// ===========================================================================

async function testCallbackDoesNotStartTrialWithoutInitialSync() {
  install()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId, { includeInitialSync: false })
  const res = await invokeCallback({ tenantId, secret: PROD_SECRET })
  assert(res.statusCode === 200)
  assert(res.body.subscription.outcome === 'not_ready' && res.body.subscription.reason === 'no_initial_sync')
  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'trial_pending_activation', 'the trial must NOT have started without a real initialSync.completedAt')
}

async function testCallbackStartsTrialWhenInitialSyncPresent() {
  install()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  const res = await invokeCallback({ tenantId, secret: PROD_SECRET })
  assert(res.statusCode === 200)
  assert(res.body.trial.status === 'trial', `expected the canonical trial to have started, got ${JSON.stringify(res.body.trial)}`)
  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'trial' && config.commercial.trial.status === 'active')
}

// ===========================================================================
// 3 -- callback invokes ensureSubscriptionActivation after canonical trial
// exists (in the SAME call).
// ===========================================================================

async function testCallbackActivatesSubscriptionAfterTrialInSameCall() {
  install()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  await seedReadyBillingRecord(tenantId)
  const res = await invokeCallback({ tenantId, secret: PROD_SECRET })
  assert(res.statusCode === 200)
  assert(res.body.trial.status === 'trial')
  assert(res.body.subscription.outcome === 'created')
  const record = await getBillingRecord(tenantId)
  assert(record.stripeSubscriptionId, 'a real subscription id must be recorded after one callback call')
}

// ===========================================================================
// 4 -- callback replay is idempotent.
// ===========================================================================

async function testCallbackReplayIsIdempotent() {
  install()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  await seedReadyBillingRecord(tenantId)
  const first = await invokeCallback({ tenantId, secret: PROD_SECRET })
  const second = await invokeCallback({ tenantId, secret: PROD_SECRET })
  assert(first.body.subscription.outcome === 'created')
  assert(second.body.subscription.outcome === 'already_active')
  assert(second.body.subscription.reason === null)
  const record = await getBillingRecord(tenantId)
  assert(record.stripeSubscriptionId === (await getBillingRecord(tenantId)).stripeSubscriptionId)
}

// ===========================================================================
// 5 -- callback + later tenantStatus polling still produces one subscription.
// ===========================================================================

async function testCallbackThenTenantStatusPollingProducesOneSubscription() {
  install()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  await seedReadyBillingRecord(tenantId)
  await invokeCallback({ tenantId, secret: PROD_SECRET })
  const firstSubId = (await getBillingRecord(tenantId)).stripeSubscriptionId
  assert(firstSubId)

  const statusRes = await invokeTenantStatus(tenantId)
  assert(statusRes.statusCode === 200, `expected 200 from tenantStatus, got ${statusRes.statusCode}: ${JSON.stringify(statusRes.body)}`)
  const secondSubId = (await getBillingRecord(tenantId)).stripeSubscriptionId
  assert(secondSubId === firstSubId, 'tenantStatus()\'s own fallback reconciliation must never create a second subscription after the callback already created one')
}

// ===========================================================================
// 6/7 -- invalid/absent callback auth rejected.
// ===========================================================================

async function testInvalidAuthRejected() {
  install()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  const res = await invokeCallback({ tenantId, secret: 'totally-wrong-secret' })
  assert(res.statusCode === 401 && res.body.error === 'unauthorized')
  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'trial_pending_activation', 'an unauthenticated call must never start a trial')
}

async function testAbsentAuthRejected() {
  install()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  const res = await invokeCallback({ tenantId, noAuthHeader: true })
  assert(res.statusCode === 401 && res.body.error === 'unauthorized')
}

async function testLosTresAmigosTenantIsRejected() {
  install()
  const res = await invokeCallback({ tenantId: DEFAULT_TENANT_ID, secret: PROD_SECRET })
  assert(res.statusCode === 400 && res.body.error === 'invalid_request', 'Los Tres Amigos is never managed through this multi-tenant callback')
}

async function testMalformedTenantIdRejected() {
  install()
  const res = await invokeCallback({ tenantId: 'not-a-real-tenant-id', secret: PROD_SECRET })
  assert(res.statusCode === 400 && res.body.error === 'invalid_request')
}

// ===========================================================================
// 8 -- forged tenant financial fields have no effect.
// ===========================================================================

async function testForgedFinancialFieldsHaveNoEffect() {
  install()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  await seedReadyBillingRecord(tenantId, { plan: 'growth' })
  const res = await invokeCallback({
    tenantId, secret: PROD_SECRET,
    extraBodyFields: {
      plan: 'core', price: 'price_forged', stripePriceId: 'price_forged',
      customerId: 'cus_attacker', stripeCustomerId: 'cus_attacker',
      paymentMethodId: 'pm_attacker', defaultPaymentMethodId: 'pm_attacker',
      trialStartedAt: '2000-01-01T00:00:00.000Z', trialEndsAt: '2099-01-01T00:00:00.000Z',
      subscriptionId: 'sub_forged', stripeSubscriptionId: 'sub_forged',
    },
  })
  assert(res.statusCode === 200)
  assert(res.body.subscription.outcome === 'created')
  const record = await getBillingRecord(tenantId)
  assert(record.stripeCustomerId === 'cus_test1', 'the forged customerId must have no effect -- only the tenant\'s own bound Customer is ever used')
  assert(record.defaultPaymentMethodId === 'pm_testsavedcard', 'the forged paymentMethodId must have no effect')
  assert(record.stripeSubscriptionId !== 'sub_forged', 'the forged subscriptionId must have no effect -- the real Stripe-returned id is used')
  const config = await getTenantConfig(tenantId)
  assert(config.commercial.plan === 'growth', 'the forged plan must have no effect -- the server-derived pendingPaidPlan (growth) governs the trial experience')
  assert(Date.parse(config.commercial.trial.startedAt) !== Date.parse('2000-01-01T00:00:00.000Z'), 'the forged trialStartedAt must have no effect')
}

// ===========================================================================
// 9/10/11 -- Preview/Production callback secret isolation.
// ===========================================================================

async function testPreviewWorkflowUsesOnlyItsOwnSecret() {
  install({ vercelEnv: 'preview', secret: PROD_SECRET, previewSecret: PREVIEW_SECRET })
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  const res = await invokeCallback({ tenantId, secret: PREVIEW_SECRET })
  assert(res.statusCode === 200, `expected the Preview secret to be accepted under VERCEL_ENV=preview, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testProductionCannotFallBackToPreviewSecret() {
  install({ vercelEnv: 'production', secret: undefined, previewSecret: PREVIEW_SECRET })
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  const res = await invokeCallback({ tenantId, secret: PREVIEW_SECRET })
  assert(res.statusCode === 401, 'a production dispatch presenting the Preview secret must be rejected -- production must never consult the Preview secret name at all')
}

async function testPreviewCannotFallBackToProductionSecret() {
  install({ vercelEnv: 'preview', secret: PROD_SECRET, previewSecret: undefined })
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  const res = await invokeCallback({ tenantId, secret: PROD_SECRET })
  assert(res.statusCode === 401, 'a preview dispatch presenting the Production secret must be rejected -- preview must never consult the Production secret name at all')
}

async function testUnsupportedVercelEnvFailsClosed() {
  install({ vercelEnv: undefined, secret: PROD_SECRET })
  delete process.env.VERCEL_ENV
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  const res = await invokeCallback({ tenantId, secret: PROD_SECRET })
  assert(res.statusCode === 401, 'with no VERCEL_ENV (local/dev), the callback must fail closed regardless of any secret presented')
}

// ===========================================================================
// 13 -- workflow retry does not restart trial or create duplicate subscription.
// ===========================================================================

async function testWorkflowRetryDoesNotRestartTrialOrDuplicateSubscription() {
  install()
  const tenantId = freshTenantId()
  await seedActiveTenant(tenantId)
  await seedReadyBillingRecord(tenantId)
  const first = await invokeCallback({ tenantId, secret: PROD_SECRET })
  const firstConfig = await getTenantConfig(tenantId)
  const firstSubId = (await getBillingRecord(tenantId)).stripeSubscriptionId

  // Simulates a GitHub Actions "workflow rerun" -- the SAME dispatch,
  // re-invoked from scratch.
  const retry = await invokeCallback({ tenantId, secret: PROD_SECRET })
  const retryConfig = await getTenantConfig(tenantId)
  const retrySubId = (await getBillingRecord(tenantId)).stripeSubscriptionId

  assert(first.body.subscription.outcome === 'created' && retry.body.subscription.outcome === 'already_active')
  assert(firstConfig.commercial.trial.startedAt === retryConfig.commercial.trial.startedAt, 'a retry must never restart/extend the trial\'s startedAt')
  assert(firstConfig.commercial.trial.endsAt === retryConfig.commercial.trial.endsAt, 'a retry must never restart/extend the trial\'s endsAt')
  assert(firstSubId === retrySubId, 'a retry must never create a duplicate subscription')
}

const tests = [
  ['the callback works with no browser/session/cookie context at all', testCallbackWorksWithoutAnyBrowserOrSessionContext],
  ['the callback does not start a trial without a real initialSync.completedAt', testCallbackDoesNotStartTrialWithoutInitialSync],
  ['the callback starts the canonical trial once initialSync.completedAt exists', testCallbackStartsTrialWhenInitialSyncPresent],
  ['the callback activates the subscription right after the trial exists, in the same call', testCallbackActivatesSubscriptionAfterTrialInSameCall],
  ['a callback replay is idempotent', testCallbackReplayIsIdempotent],
  ['callback + later tenantStatus polling still produces exactly one subscription', testCallbackThenTenantStatusPollingProducesOneSubscription],
  ['an invalid callback secret is rejected', testInvalidAuthRejected],
  ['an absent callback auth header is rejected', testAbsentAuthRejected],
  ['Los Tres Amigos\'s own tenant id is rejected', testLosTresAmigosTenantIsRejected],
  ['a malformed tenant id is rejected', testMalformedTenantIdRejected],
  ['forged tenant financial fields in the request body have no effect', testForgedFinancialFieldsHaveNoEffect],
  ['a Preview dispatch is accepted using only its own Preview secret', testPreviewWorkflowUsesOnlyItsOwnSecret],
  ['a Production dispatch cannot fall back to the Preview secret', testProductionCannotFallBackToPreviewSecret],
  ['a Preview dispatch cannot fall back to the Production secret', testPreviewCannotFallBackToProductionSecret],
  ['an unsupported/absent VERCEL_ENV fails closed regardless of any secret presented', testUnsupportedVercelEnvFailsClosed],
  ['a workflow retry never restarts the trial or duplicates the subscription', testWorkflowRetryDoesNotRestartTrialOrDuplicateSubscription],
]

async function main() {
  for (const [name, fn] of tests) await run(name, fn)
  const failed = results.filter(r => !r).length
  if (failed > 0) {
    console.log(`\n${failed} of ${tests.length} TESTS FAILED`)
    process.exit(1)
  }
  console.log(`\nALL ${tests.length} TESTS PASSED`)
}

main()
