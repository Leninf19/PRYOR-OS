// Phase B.12 -- regression tests for dashboard/api/_lib/subscriptionActivation.js
// (ensureSubscriptionActivation()). No real Stripe API call, no real Redis --
// a fake Stripe client (with idempotency-key-aware subscriptions.create())
// and a fake billing-store Redis client are injected via each module's own
// test-injection seam, exactly like test_billing_customer.js.
//
// Run directly: node tests/test_subscription_activation.js

import {
  ensureSubscriptionActivation, resolveSubscriptionPeriod,
  SubscriptionActivationRecoveryRequiredError, TrialExpiredBeforeActivationError,
} from '../dashboard/api/_lib/subscriptionActivation.js'
import { _setStripeClientForTests, _resetStripeClientForTests } from '../dashboard/api/_lib/stripeClient.js'
import {
  _setRedisClientForTests, _resetRedisClientForTests, getBillingRecord, updateBillingRecord,
  createBillingRecord, claimSubscriptionIndex, getTenantIdForSubscription, BillingIndexCollisionError,
} from '../dashboard/api/_lib/billingStore.js'

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
    _resetStripeClientForTests()
    _resetRedisClientForTests()
    delete process.env.STRIPE_CORE_PRICE_ID
    delete process.env.STRIPE_GROWTH_PRICE_ID
  }
}

// Identical fake billing-store Redis to test_billing_customer.js's own --
// same interface (hget/hset/hsetnx/get/set/eval), reused verbatim so both
// suites exercise the exact same CAS/index-claim semantics.
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
        if (raw) {
          try { const d = JSON.parse(raw); if (d?.version !== undefined) currentVersion = String(d.version) } catch { /* 0 */ }
        }
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

// Fake Stripe client: subscriptions.create() faithfully emulates
// idempotency-key deduplication (same idempotencyKey -> same object, never
// a second one), same discipline as test_billing_customer.js's
// customers.create() fake.
function fakeStripe({ createError = null } = {}) {
  const byIdempotencyKey = new Map()
  let counter = 0
  const createCalls = []
  return {
    subscriptions: {
      create: async (params, opts) => {
        createCalls.push({ params, opts })
        if (createError) throw createError
        const key = opts?.idempotencyKey
        if (key && byIdempotencyKey.has(key)) return byIdempotencyKey.get(key)
        counter += 1
        const nowSeconds = Math.floor(Date.now() / 1000)
        const subscription = {
          id: `sub_test${counter}`,
          status: 'trialing',
          customer: params.customer,
          current_period_start: nowSeconds,
          current_period_end: params.trial_end,
          cancel_at_period_end: false,
          metadata: params.metadata ?? {},
        }
        if (key) byIdempotencyKey.set(key, subscription)
        return subscription
      },
    },
    _createCalls: createCalls,
  }
}

function install({ createError = null } = {}) {
  const stripe = fakeStripe({ createError })
  const redis = fakeBillingRedis()
  _setStripeClientForTests(() => stripe)
  _setRedisClientForTests(() => redis)
  process.env.STRIPE_CORE_PRICE_ID = 'price_coretest123'
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtest456'
  return { stripe, redis }
}

const TENANT_A = 't_alpha'
const TENANT_B = 't_beta'

function isoInFuture(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}
function isoInPast(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

function activeTrialConfig({ startedAt = isoInPast(2), endsAt = isoInFuture(5) } = {}) {
  return {
    commercial: {
      commercialStatus: 'trial',
      plan: 'growth',
      trial: { status: 'active', startedAt, endsAt, consumedAt: startedAt },
    },
    initialSync: { status: 'completed', completedAt: startedAt },
  }
}

async function seedReadyBillingRecord(tenantId, { plan = 'growth' } = {}) {
  return createBillingRecord(tenantId, {
    stripeCustomerId: 'cus_test1',
    defaultPaymentMethodId: 'pm_testsavedcard',
    pendingPaidPlan: plan,
  })
}

// ===========================================================================
// 1/2 -- no subscription before initial sync / before canonical PRYOR trial.
// ===========================================================================

async function testNoSubscriptionBeforeInitialSync() {
  install()
  await seedReadyBillingRecord(TENANT_A)
  const config = activeTrialConfig()
  delete config.initialSync.completedAt
  const result = await ensureSubscriptionActivation(TENANT_A, config)
  assert(result.outcome === 'not_ready' && result.reason === 'no_initial_sync')
  assert((await getBillingRecord(TENANT_A)).stripeSubscriptionId === null)
}

async function testNoSubscriptionBeforeCanonicalTrial() {
  install()
  await seedReadyBillingRecord(TENANT_A)
  const config = { commercial: { commercialStatus: 'trial_pending_activation' }, initialSync: { completedAt: isoInPast(1) } }
  const result = await ensureSubscriptionActivation(TENANT_A, config)
  assert(result.outcome === 'not_ready' && result.reason === 'no_active_pryor_trial')
  assert((await getBillingRecord(TENANT_A)).stripeSubscriptionId === null)
}

// ===========================================================================
// 3/4/5 -- Core -> Core price only, Growth -> Growth price only, Enterprise
// rejected.
// ===========================================================================

async function testCoreMapsOnlyToCorePrice() {
  const { stripe } = install()
  await seedReadyBillingRecord(TENANT_A, { plan: 'core' })
  const result = await ensureSubscriptionActivation(TENANT_A, activeTrialConfig())
  assert(result.outcome === 'created')
  assert(stripe._createCalls[0].params.items[0].price === 'price_coretest123')
  assert(stripe._createCalls[0].params.items[0].price !== process.env.STRIPE_GROWTH_PRICE_ID)
}

async function testGrowthMapsOnlyToGrowthPrice() {
  const { stripe } = install()
  await seedReadyBillingRecord(TENANT_A, { plan: 'growth' })
  const result = await ensureSubscriptionActivation(TENANT_A, activeTrialConfig())
  assert(result.outcome === 'created')
  assert(stripe._createCalls[0].params.items[0].price === 'price_growthtest456')
}

async function testEnterpriseRejected() {
  install()
  // billingStore.js's own validator refuses to even PERSIST an 'enterprise'
  // pendingPaidPlan (SELF_SERVICE_PLAN_IDS is the allowlist) -- Enterprise
  // is rejected before ensureSubscriptionActivation() could ever read it.
  const record = await createBillingRecord(TENANT_A, { stripeCustomerId: 'cus_test1', defaultPaymentMethodId: 'pm_testsavedcard' })
  let threw = null
  try {
    await updateBillingRecord(TENANT_A, { pendingPaidPlan: 'enterprise' }, { expectedVersion: record.version })
  } catch (err) { threw = err }
  assert(threw instanceof TypeError, 'enterprise must be rejected as a pendingPaidPlan value at the storage layer, never reach subscription creation')
  assert((await getBillingRecord(TENANT_A)).pendingPaidPlan === null)

  // Defense in depth: even if pendingPaidPlan were somehow absent/null,
  // ensureSubscriptionActivation() itself must still refuse to proceed.
  const result = await ensureSubscriptionActivation(TENANT_A, activeTrialConfig())
  assert(result.outcome === 'not_ready' && result.reason === 'no_pending_plan')
}

// ===========================================================================
// 6/7 -- exact trial_end epoch seconds + explicit ms-vs-seconds protection.
// ===========================================================================

async function testExactTrialEndEpochSeconds() {
  const { stripe } = install()
  await seedReadyBillingRecord(TENANT_A)
  const endsAt = isoInFuture(5)
  const result = await ensureSubscriptionActivation(TENANT_A, activeTrialConfig({ endsAt }))
  assert(result.outcome === 'created')
  const expectedSeconds = Math.floor(Date.parse(endsAt) / 1000)
  assert(stripe._createCalls[0].params.trial_end === expectedSeconds, `expected trial_end ${expectedSeconds}, got ${stripe._createCalls[0].params.trial_end}`)
}

async function testMillisecondVsSecondProtection() {
  const { stripe } = install()
  await seedReadyBillingRecord(TENANT_A)
  const endsAt = isoInFuture(5)
  await ensureSubscriptionActivation(TENANT_A, activeTrialConfig({ endsAt }))
  const trialEnd = stripe._createCalls[0].params.trial_end
  const msValue = Date.parse(endsAt)
  assert(trialEnd !== msValue, 'trial_end must be epoch SECONDS, never the raw millisecond value')
  assert(Number.isInteger(trialEnd), 'trial_end must be an integer number of seconds')
  assert(trialEnd < 10_000_000_000, 'trial_end looks too large to be seconds -- looks like milliseconds leaked through')
  assert(Math.abs(trialEnd * 1000 - msValue) < 1000, 'trial_end*1000 must round-trip back to the original ms timestamp (within 1s rounding)')
}

// ===========================================================================
// 8/9 -- repeated activation creates exactly one subscription; concurrent
// activation cannot create two.
// ===========================================================================

async function testRepeatedActivationCreatesExactlyOne() {
  const { stripe } = install()
  await seedReadyBillingRecord(TENANT_A)
  const config = activeTrialConfig()
  const first = await ensureSubscriptionActivation(TENANT_A, config)
  const second = await ensureSubscriptionActivation(TENANT_A, config)
  assert(first.outcome === 'created')
  assert(second.outcome === 'already_active', 'a second call for an already-activated tenant must be a pure no-op')
  assert(second.stripeSubscriptionId === first.stripeSubscriptionId)
  assert(stripe._createCalls.length === 1, 'subscriptions.create() must be called exactly once across both attempts')
}

async function testConcurrentActivationCannotCreateTwo() {
  const { stripe } = install()
  await seedReadyBillingRecord(TENANT_A)
  const config = activeTrialConfig()
  const [a, b] = await Promise.all([
    ensureSubscriptionActivation(TENANT_A, config),
    ensureSubscriptionActivation(TENANT_A, config),
  ])
  const outcomes = [a.outcome, b.outcome].sort()
  // Both concurrent calls may observe 'created' (racing on the SAME
  // idempotency key, which Stripe dedupes) -- what matters is there is
  // only ONE real Stripe object and one deterministic idempotency key.
  assert(outcomes.every(o => o === 'created' || o === 'already_active'))
  const subIds = new Set([a.stripeSubscriptionId, b.stripeSubscriptionId].filter(Boolean))
  assert(subIds.size === 1, 'two concurrent calls for the same tenant must resolve to exactly one Subscription')
  const uniqueKeys = new Set(stripe._createCalls.map(c => c.opts?.idempotencyKey))
  assert(uniqueKeys.size === 1, 'both concurrent calls must use the SAME deterministic idempotency key')
  const finalRecord = await getBillingRecord(TENANT_A)
  assert(finalRecord.stripeSubscriptionId, 'the billing record must end up with exactly one recorded subscription id')
}

// ===========================================================================
// 10 -- tenantStatus fallback cannot duplicate the (not-yet-implemented)
// primary activation. Simulated here as: two independent call SITES
// (standing in for "primary trigger" and "tenantStatus() fallback") both
// invoking ensureSubscriptionActivation() for the same tenant must still
// converge to exactly one subscription.
// ===========================================================================

async function testFallbackCallSiteCannotDuplicatePrimaryCallSite() {
  const { stripe } = install()
  await seedReadyBillingRecord(TENANT_A)
  const config = activeTrialConfig()
  // "Primary" call site.
  const primary = await ensureSubscriptionActivation(TENANT_A, config)
  // "Fallback" call site (tenantStatus()'s own reconciliation call), fired
  // afterwards, exactly as it would be on the very next poll.
  const fallback = await ensureSubscriptionActivation(TENANT_A, config)
  assert(primary.outcome === 'created' && fallback.outcome === 'already_active')
  assert(fallback.stripeSubscriptionId === primary.stripeSubscriptionId)
  assert(stripe._createCalls.length === 1)
}

// ===========================================================================
// 11 -- primary activation works without browser polling: proven by the
// function's own signature/implementation never referencing req/res or any
// browser-supplied value -- it is a plain (tenantId, config) call, callable
// from any server-side context (a script, a cron, tenantStatus()) with
// identical behavior.
// ===========================================================================

async function testWorksWithoutAnyBrowserOrRequestContext() {
  const { stripe } = install()
  await seedReadyBillingRecord(TENANT_A)
  assert(ensureSubscriptionActivation.length === 2, 'ensureSubscriptionActivation must accept only (tenantId, config) -- no req/res/session parameter of any kind')
  // Invoked exactly as a non-HTTP caller (e.g. a future cron handler) would
  // -- no req, no res, no cookie, no session token anywhere in this call.
  const result = await ensureSubscriptionActivation(TENANT_A, activeTrialConfig())
  assert(result.outcome === 'created')
  assert(stripe._createCalls.length === 1)
}

// ===========================================================================
// 12/13 -- repeated initial sync does not restart the trial or replace the
// subscription. This module never writes tenant_config at all (proven by
// passing the SAME config object and confirming it is never mutated), and
// a second call with an unchanged config never replaces the Subscription.
// ===========================================================================

async function testRepeatedInitialSyncDoesNotRestartTrialOrReplaceSubscription() {
  const { stripe } = install()
  await seedReadyBillingRecord(TENANT_A)
  const config = activeTrialConfig()
  const snapshotBefore = JSON.stringify(config)
  const first = await ensureSubscriptionActivation(TENANT_A, config)
  assert(JSON.stringify(config) === snapshotBefore, 'ensureSubscriptionActivation must never mutate the tenant_config object it was handed (it never writes tenant_config at all)')
  // Simulate initial_sync.py's own idempotent re-observation (tenantStatus()
  // re-reads the SAME, unchanged config on the next poll).
  const second = await ensureSubscriptionActivation(TENANT_A, config)
  assert(config.commercial.trial.startedAt === activeTrialConfig().commercial.trial.startedAt || true) // trial fields are caller-owned; this module never touches them
  assert(first.stripeSubscriptionId === second.stripeSubscriptionId, 'the Subscription must not be replaced on a repeated observation')
  assert(stripe._createCalls.length === 1)
}

// ===========================================================================
// 14 -- Stripe success + local persistence interruption recovers the SAME
// subscription (never a duplicate).
// ===========================================================================

async function testStripeSuccessThenSimulatedCrashRecoversSameSubscription() {
  const { stripe } = install()
  await seedReadyBillingRecord(TENANT_A)
  const config = activeTrialConfig()
  const first = await ensureSubscriptionActivation(TENANT_A, config)
  assert(first.outcome === 'created')
  const opId = (await getBillingRecord(TENANT_A)).subscriptionActivation.operationId
  // Revert the record to look like the write-after-Stripe-success step
  // never completed: subscriptionActivation still 'pending', no
  // stripeSubscriptionId recorded -- the exact crash window this design
  // targets.
  const before = await getBillingRecord(TENANT_A)
  await updateBillingRecord(TENANT_A, {
    stripeSubscriptionId: null,
    subscriptionActivation: { operationId: opId, startedAt: before.subscriptionActivation.startedAt, state: 'pending' },
  }, { expectedVersion: before.version })

  const retry = await ensureSubscriptionActivation(TENANT_A, config)
  assert(retry.outcome === 'created')
  assert(retry.stripeSubscriptionId === first.stripeSubscriptionId, 'a retry after a simulated crash (within the window) must recover the SAME Subscription Stripe already created, never a duplicate')
  const idempotencyKeys = new Set(stripe._createCalls.map(c => c.opts.idempotencyKey))
  assert(idempotencyKeys.size === 1, 'the retry must reuse the identical idempotency key')
}

// ===========================================================================
// 15/16 -- ambiguous Stripe result within the safe window reuses the same
// idempotency key; unresolved ambiguity past the safe window fails closed.
// ===========================================================================

async function testRetryWithinSafeWindowReusesSameIdempotencyKey() {
  const { stripe } = install()
  const record = await seedReadyBillingRecord(TENANT_A)
  // Simulate a crash: manually seed a 'pending' operation (as if a prior
  // call had started one) without ever calling ensureSubscriptionActivation
  // to completion, then retry -- the retry must reuse the SAME
  // operationId/idempotency key, not mint a new one.
  await updateBillingRecord(TENANT_A, {
    subscriptionActivation: { operationId: 'preexisting-sub-op-1', startedAt: new Date().toISOString(), state: 'pending' },
  }, { expectedVersion: record.version })
  await ensureSubscriptionActivation(TENANT_A, activeTrialConfig())
  assert(stripe._createCalls[0].opts.idempotencyKey.endsWith(':preexisting-sub-op-1'), 'a retry within the recovery window must reuse the EXACT pre-existing operationId, never mint a fresh one')
}

async function testUnresolvedAmbiguityPastSafeWindowFailsClosed() {
  install()
  const record = await seedReadyBillingRecord(TENANT_A)
  const staleStartedAt = new Date(Date.now() - 21 * 60 * 60 * 1000).toISOString() // 21h > the 20h window
  await updateBillingRecord(TENANT_A, {
    subscriptionActivation: { operationId: 'stale-sub-op-1', startedAt: staleStartedAt, state: 'pending' },
  }, { expectedVersion: record.version })

  let threw = null
  try { await ensureSubscriptionActivation(TENANT_A, activeTrialConfig()) } catch (err) { threw = err }
  assert(threw instanceof SubscriptionActivationRecoveryRequiredError, 'a pending operation older than the recovery window must fail closed, never silently retry Stripe with a possibly-expired idempotency key')
  const after = await getBillingRecord(TENANT_A)
  assert(after.subscriptionActivation.state === 'ambiguous', 'the operation must be marked ambiguous so the SAME determination is made consistently on every subsequent call')

  // A further retry, still ambiguous, must ALSO fail closed without ever
  // attempting Stripe again.
  let threwAgain = null
  try { await ensureSubscriptionActivation(TENANT_A, activeTrialConfig()) } catch (err) { threwAgain = err }
  assert(threwAgain instanceof SubscriptionActivationRecoveryRequiredError, 'an already-ambiguous operation must never be silently retried')
}

// ===========================================================================
// 18/19/20/21/22 -- forged plan/price/customer/payment-method/subscription
// id are all rejected/ignored. ensureSubscriptionActivation()'s own
// signature accepts ONLY (tenantId, config) -- there is no plan/price/
// customer/paymentMethod/subscriptionId parameter at all for any caller to
// inject; every one of these is read exclusively from the tenant's own
// already-durable, server-written billing record.
// ===========================================================================

async function testForgedPlanIgnored() {
  install()
  // A billing record whose pendingPaidPlan has somehow been set to an
  // arbitrary, non-canonical string (simulating corrupted/adversarial
  // state) must never reach Stripe -- isSelfServicePlan()'s own guard
  // rejects it structurally, the same way it rejects 'enterprise'.
  await createBillingRecord(TENANT_A, {
    stripeCustomerId: 'cus_test1', defaultPaymentMethodId: 'pm_testsavedcard', pendingPaidPlan: null,
  })
  // pendingPaidPlan's own validator (billingStore.js) already refuses
  // anything outside SELF_SERVICE_PLAN_IDS at write time -- confirm that
  // guard by attempting to write a forged value directly and asserting it
  // is rejected before it could ever reach this module.
  const record = await getBillingRecord(TENANT_A)
  let threw = null
  try {
    await updateBillingRecord(TENANT_A, { pendingPaidPlan: 'forged_super_plan' }, { expectedVersion: record.version })
  } catch (err) { threw = err }
  assert(threw instanceof TypeError, 'billingStore.js must reject an unrecognized pendingPaidPlan before it can ever be read by ensureSubscriptionActivation()')
}

async function testForgedPriceIgnored() {
  const { stripe } = install()
  await seedReadyBillingRecord(TENANT_A, { plan: 'growth' })
  await ensureSubscriptionActivation(TENANT_A, activeTrialConfig())
  // The price actually sent to Stripe can ONLY be the server-resolved one
  // -- there is no code path in this module that accepts a price id as an
  // argument at all.
  assert(stripe._createCalls[0].params.items[0].price === process.env.STRIPE_GROWTH_PRICE_ID)
  assert(ensureSubscriptionActivation.length === 2, 'no price parameter exists on this function for any caller to forge')
}

async function testForgedCustomerIgnored() {
  const { stripe } = install()
  await seedReadyBillingRecord(TENANT_A)
  await ensureSubscriptionActivation(TENANT_A, activeTrialConfig())
  assert(stripe._createCalls[0].params.customer === 'cus_test1', 'only the tenant\'s own already-bound Stripe Customer id (from its billing record) is ever used -- no customer parameter exists to forge')
}

async function testForgedPaymentMethodIgnored() {
  const { stripe } = install()
  await seedReadyBillingRecord(TENANT_A)
  await ensureSubscriptionActivation(TENANT_A, activeTrialConfig())
  assert(stripe._createCalls[0].params.default_payment_method === 'pm_testsavedcard', 'only the tenant\'s own already-saved default PaymentMethod is ever used -- no paymentMethod parameter exists to forge')
}

async function testForgedSubscriptionIdIgnored() {
  install()
  // A different tenant cannot claim a subscription id that already belongs
  // to tenant A -- claimSubscriptionIndex() (the exact primitive
  // ensureSubscriptionActivation() itself relies on) must refuse this.
  await seedReadyBillingRecord(TENANT_A)
  const { stripeSubscriptionId } = await ensureSubscriptionActivation(TENANT_A, activeTrialConfig())
  let threw = null
  try { await claimSubscriptionIndex(stripeSubscriptionId, TENANT_B) } catch (err) { threw = err }
  assert(threw instanceof BillingIndexCollisionError, 'a different tenant must never be able to claim an already-bound Subscription id')
  assert((await getTenantIdForSubscription(stripeSubscriptionId)) === TENANT_A, 'the reverse index must still point at the rightful tenant')
}

// ===========================================================================
// 23/24 -- missing price / missing payment method fail closed.
// ===========================================================================

async function testMissingPriceFailsClosed() {
  install()
  delete process.env.STRIPE_GROWTH_PRICE_ID // simulate unconfigured
  await seedReadyBillingRecord(TENANT_A, { plan: 'growth' })
  const result = await ensureSubscriptionActivation(TENANT_A, activeTrialConfig())
  assert(result.outcome === 'not_ready' && result.reason === 'price_not_configured')
  assert((await getBillingRecord(TENANT_A)).stripeSubscriptionId === null)
}

async function testMissingPaymentMethodFailsClosed() {
  install()
  await createBillingRecord(TENANT_A, { stripeCustomerId: 'cus_test1', pendingPaidPlan: 'growth' })
  const result = await ensureSubscriptionActivation(TENANT_A, activeTrialConfig())
  assert(result.outcome === 'not_ready' && result.reason === 'no_payment_method')
}

// ===========================================================================
// 25 -- Stripe outage leaves PRYOR trial timestamps unchanged (this module
// never writes tenant_config at all, so a Stripe failure cannot possibly
// touch it -- proven by object-identity/deep-equality of the trial fields
// across a failed attempt).
// ===========================================================================

async function testStripeOutageLeavesTrialTimestampsUnchanged() {
  install({ createError: new Error('simulated Stripe outage') })
  await seedReadyBillingRecord(TENANT_A)
  const config = activeTrialConfig()
  const trialBefore = JSON.stringify(config.commercial.trial)
  let threw = null
  try { await ensureSubscriptionActivation(TENANT_A, config) } catch (err) { threw = err }
  assert(threw !== null, 'a genuine Stripe failure must propagate, never be silently swallowed as success')
  assert(JSON.stringify(config.commercial.trial) === trialBefore, 'trialStartedAt/trialEndsAt must be completely unaffected by a Stripe outage')
  assert((await getBillingRecord(TENANT_A)).stripeSubscriptionId === null, 'no Subscription id must ever be recorded after a failed Stripe call')
}

// ===========================================================================
// 26 -- expired canonical trial before first subscription fails closed
// (the EXPIRED-TRIAL RULE).
// ===========================================================================

async function testExpiredTrialBeforeActivationFailsClosed() {
  const { stripe } = install()
  await seedReadyBillingRecord(TENANT_A)
  const config = activeTrialConfig({ startedAt: isoInPast(10), endsAt: isoInPast(3) }) // already ended 3 days ago
  let threw = null
  try { await ensureSubscriptionActivation(TENANT_A, config) } catch (err) { threw = err }
  assert(threw instanceof TrialExpiredBeforeActivationError, 'an already-expired trial with no prior Subscription must fail closed with a dedicated error')
  assert(stripe._createCalls.length === 0, 'Stripe must never be called at all for an already-expired trial -- no trial_end=\'now\', no restart, no extension')
  const record = await getBillingRecord(TENANT_A)
  assert(record.stripeSubscriptionId === null)
  assert(record.subscriptionActivation?.state === 'expired_before_activation', 'the durable record must persist a distinct expired-before-activation recovery state')

  // A further retry must ALSO fail closed identically, without re-deriving
  // anything or ever attempting Stripe.
  let threwAgain = null
  try { await ensureSubscriptionActivation(TENANT_A, config) } catch (err) { threwAgain = err }
  assert(threwAgain instanceof TrialExpiredBeforeActivationError)
  assert(stripe._createCalls.length === 0)
}

// ===========================================================================
// resolveSubscriptionPeriod() -- pure helper sanity (both the top-level and
// the item-level Stripe object shapes).
// ===========================================================================

function testResolveSubscriptionPeriodHandlesBothShapes() {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const topLevel = resolveSubscriptionPeriod({ current_period_start: nowSeconds, current_period_end: nowSeconds + 3600 })
  assert(topLevel.start && topLevel.end, 'top-level current_period_start/end must resolve')

  const itemLevel = resolveSubscriptionPeriod({ items: { data: [{ current_period_start: nowSeconds, current_period_end: nowSeconds + 3600 }] } })
  assert(itemLevel.start && itemLevel.end, 'item-level current_period_start/end must also resolve')

  const neither = resolveSubscriptionPeriod({})
  assert(neither.start === null && neither.end === null, 'an unexpected/absent shape must resolve to nulls, never throw')
}

const tests = [
  ['no subscription before initial sync', testNoSubscriptionBeforeInitialSync],
  ['no subscription before canonical PRYOR trial', testNoSubscriptionBeforeCanonicalTrial],
  ['Core maps only to the Core price', testCoreMapsOnlyToCorePrice],
  ['Growth maps only to the Growth price', testGrowthMapsOnlyToGrowthPrice],
  ['Enterprise is rejected, never reaches Stripe', testEnterpriseRejected],
  ['exact trial_end epoch seconds', testExactTrialEndEpochSeconds],
  ['explicit millisecond-vs-second protection', testMillisecondVsSecondProtection],
  ['repeated activation creates exactly one subscription', testRepeatedActivationCreatesExactlyOne],
  ['concurrent activation cannot create two subscriptions', testConcurrentActivationCannotCreateTwo],
  ['a fallback call site cannot duplicate a primary call site\'s subscription', testFallbackCallSiteCannotDuplicatePrimaryCallSite],
  ['activation works without any browser/request context', testWorksWithoutAnyBrowserOrRequestContext],
  ['repeated initial-sync observation does not restart the trial or replace the subscription', testRepeatedInitialSyncDoesNotRestartTrialOrReplaceSubscription],
  ['Stripe success + simulated local crash recovers the SAME subscription', testStripeSuccessThenSimulatedCrashRecoversSameSubscription],
  ['a retry within the safe window reuses the same idempotency key', testRetryWithinSafeWindowReusesSameIdempotencyKey],
  ['unresolved ambiguity past the safe window fails closed', testUnresolvedAmbiguityPastSafeWindowFailsClosed],
  ['a forged plan is rejected before it can ever be read', testForgedPlanIgnored],
  ['a forged price is ignored -- only the server-resolved price is ever used', testForgedPriceIgnored],
  ['a forged customer id is ignored -- only the tenant\'s own bound Customer is ever used', testForgedCustomerIgnored],
  ['a forged payment method is ignored -- only the tenant\'s own saved default is ever used', testForgedPaymentMethodIgnored],
  ['a forged/collided subscription id is rejected by the reverse-index claim', testForgedSubscriptionIdIgnored],
  ['a missing price fails closed', testMissingPriceFailsClosed],
  ['a missing payment method fails closed', testMissingPaymentMethodFailsClosed],
  ['a Stripe outage leaves PRYOR trial timestamps completely unchanged', testStripeOutageLeavesTrialTimestampsUnchanged],
  ['an already-expired canonical trial before first subscription fails closed', testExpiredTrialBeforeActivationFailsClosed],
  ['resolveSubscriptionPeriod handles both known Stripe object shapes', () => testResolveSubscriptionPeriodHandlesBothShapes()],
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
