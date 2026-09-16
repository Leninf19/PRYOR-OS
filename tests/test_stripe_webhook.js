// Phase B.11 -- regression tests for the new POST /api/session?action=
// stripe-webhook handler (setup completion only). Uses the REAL Stripe SDK's
// static webhooks.generateTestHeaderString()/constructEvent() (these need
// no API key -- they are pure signing/verification helpers) so genuine
// cryptographic signature verification is exercised end-to-end, not just a
// mocked pass-through. No real Stripe API account/network call happens
// anywhere in this file.
//
// Run directly: node tests/test_stripe_webhook.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import Stripe from 'stripe'
import handler from '../dashboard/api/session/[action].js'
import {
  _setRedisClientForTests as setBillingClient, _resetRedisClientForTests as resetBillingClient,
  createBillingRecord, getBillingRecord, updateBillingRecord, claimCustomerIndex, claimSubscriptionIndex, getStripeEventRecord,
} from '../dashboard/api/_lib/billingStore.js'
import { _setStripeClientForTests, _resetStripeClientForTests } from '../dashboard/api/_lib/stripeClient.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
import {
  upsertTenantConfig, getTenantConfig, recordLocationApproval,
  _setRedisClientForTests as setConfigClient, _resetRedisClientForTests as resetConfigClient,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import { resolveTenantEntitlementsFromConfig } from '../dashboard/api/_lib/entitlementResolution.js'
import { PLAN_ENTITLEMENTS } from '../dashboard/api/_lib/planEntitlements.js'

const TEST_WEBHOOK_SECRET = 'whsec_test_only_never_a_real_secret_0123456789'

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
    resetBillingClient(); _resetStripeClientForTests(); _resetLimiterFactoryForTests(); resetConfigClient()
    delete process.env.STRIPE_WEBHOOK_SECRET
    delete process.env.STRIPE_CORE_PRICE_ID
    delete process.env.STRIPE_GROWTH_PRICE_ID
  }
}

// Same pitfall already fixed once in this engagement
// (test_billing_activation_callback.js): the factory passed to
// _setRedisClientForTests() is invoked FRESH on every store operation, so
// it must close over a single, already-created store instance -- never
// `() => fakeKeyedHashRedis()`, which would hand back a brand-new empty
// store on every call and never persist anything.
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

function installConfigStore() {
  const configRedis = fakeKeyedHashRedis()
  setConfigClient(() => configRedis)
  return configRedis
}

// Seeds a tenant_config already sitting in a real, canonical 'trial' state
// (mirrors test_trial_lifecycle.js's own seedActiveTenant(), simplified to
// exactly what the paid-active transition tests need: a genuine
// commercial.trial object, never hand-constructed from scratch).
async function seedTrialingTenantConfig(tenantId, { trialStartedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() } = {}) {
  await upsertTenantConfig(tenantId, { status: 'onboarding', locationCatalogEnabled: true }, { allowCreate: true, creationSource: 'migration' })
  await recordLocationApproval(tenantId, [{ googleLocationId: `accounts/acc-${tenantId}/locations/loc-1`, title: 'Primary Location', address: '' }])
  const trialEndsAt = new Date(Date.parse(trialStartedAt) + 7 * 24 * 60 * 60 * 1000).toISOString()
  await upsertTenantConfig(tenantId, {
    status: 'active',
    commercial: {
      commercialStatus: 'trial', plan: 'growth', planSource: 'trial_auto_gbp',
      trial: { status: 'active', startedAt: trialStartedAt, endsAt: trialEndsAt, consumedAt: trialStartedAt },
      limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
      accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null,
      createdAt: trialStartedAt, updatedAt: trialStartedAt,
    },
    trialEligibility: { eligible: true, markedAt: trialStartedAt, source: 'test_fixture' },
  }, {})
  return getTenantConfig(tenantId)
}

// Phase B.13 -- a more flexible sibling of seedTrialingTenantConfig() that
// can seed a tenant already sitting in ANY commercial state (active,
// past_due, suspended with a given reason, etc.) -- needed since B.13's
// delinquency/recovery transitions all start from a state OTHER than
// 'trial'.
async function seedCommercialTenantConfig(tenantId, {
  commercialStatus = 'active', plan = 'growth', suspension = null, cancellation = null,
  trialStartedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
} = {}) {
  await upsertTenantConfig(tenantId, { status: 'onboarding', locationCatalogEnabled: true }, { allowCreate: true, creationSource: 'migration' })
  await recordLocationApproval(tenantId, [{ googleLocationId: `accounts/acc-${tenantId}/locations/loc-1`, title: 'Primary Location', address: '' }])
  const trialEndsAt = new Date(Date.parse(trialStartedAt) + 7 * 24 * 60 * 60 * 1000).toISOString()
  await upsertTenantConfig(tenantId, {
    status: 'active',
    commercial: {
      commercialStatus, plan, planSource: 'stripe_subscription_active',
      trial: { status: 'active', startedAt: trialStartedAt, endsAt: trialEndsAt, consumedAt: trialStartedAt },
      limitsOverride: null, suspension, cancellation, overLimit: null,
      accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null,
      createdAt: trialStartedAt, updatedAt: trialStartedAt,
    },
    trialEligibility: { eligible: true, markedAt: trialStartedAt, source: 'test_fixture' },
  }, {})
  return getTenantConfig(tenantId)
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
    set: async (key, value, opts = {}) => { strings[key] = { value, expiresAtMs: opts?.ex ? Date.now() + opts.ex * 1000 : null }; return 'OK' },
    eval: async (script, keys, args) => {
      const key = keys[0]
      if (script.includes('SCRIPT: BILLING_CAS')) {
        const [field, expectedVersionStr, nextJson] = args
        const raw = hashes[key]?.[field] ?? null
        let currentVersion = '0'
        if (raw) { try { const d = JSON.parse(raw); if (d?.version !== undefined) currentVersion = String(d.version) } catch { /* 0 */ } }
        if (currentVersion !== expectedVersionStr) return raw ?? false
        hashes[key] = { ...(hashes[key] ?? {}), [field]: nextJson }
        return true
      }
      if (script.includes('SCRIPT: INDEX_CLAIM')) {
        const [tenantId] = args
        const existing = strings[key]?.value ?? null
        if (existing) return existing === tenantId ? 1 : 0
        strings[key] = { value: tenantId, expiresAtMs: null }
        return 1
      }
      if (script.includes('SCRIPT: EVENT_CLAIM')) {
        const [nowMsStr, leaseMsStr, newToken, freshRecordJson, ttlSecondsStr] = args
        const nowMs = Number(nowMsStr); const leaseMs = Number(leaseMsStr); const ttlSeconds = Number(ttlSecondsStr)
        const e = strings[key]
        const existingRaw = e ? e.value : null
        if (existingRaw) {
          const rec = JSON.parse(existingRaw)
          if (rec.status === 'processed') return JSON.stringify({ claimed: false, reason: 'already_processed', record: rec })
          if (rec.status === 'claimed' && (rec.leaseExpiresAtMs ?? 0) > nowMs) return JSON.stringify({ claimed: false, reason: 'lease_active', record: rec })
          rec.status = 'claimed'; rec.processingToken = newToken; rec.claimedAtMs = nowMs; rec.leaseExpiresAtMs = nowMs + leaseMs
          rec.attemptCount = (rec.attemptCount ?? 0) + 1
          const nextJson = JSON.stringify(rec)
          strings[key] = { value: nextJson, expiresAtMs: Date.now() + ttlSeconds * 1000 }
          return JSON.stringify({ claimed: true, reason: 'reclaimed', record: nextJson })
        }
        strings[key] = { value: freshRecordJson, expiresAtMs: Date.now() + ttlSeconds * 1000 }
        return JSON.stringify({ claimed: true, reason: 'new', record: freshRecordJson })
      }
      if (script.includes('SCRIPT: EVENT_MARK')) {
        const [processingToken, nowMsStr, finalStatus, resultNote, ttlSecondsStr] = args
        const e = strings[key]
        if (!e) return JSON.stringify({ ok: false, reason: 'not_found' })
        const rec = JSON.parse(e.value)
        if (rec.processingToken !== processingToken) return JSON.stringify({ ok: false, reason: 'stale_token' })
        rec.status = finalStatus
        if (finalStatus === 'processed') rec.processedAtMs = Number(nowMsStr); else rec.failedAtMs = Number(nowMsStr)
        rec.result = resultNote; rec.processingToken = null
        const nextJson = JSON.stringify(rec)
        strings[key] = { value: nextJson, expiresAtMs: Date.now() + Number(ttlSecondsStr) * 1000 }
        return JSON.stringify({ ok: true, record: nextJson })
      }
      throw new Error('unexpected eval() call shape in test fake')
    },
  }
}

// A fake req object that is async-iterable (so collectRawBody()'s `for
// await (const chunk of req)` works) yielding the EXACT raw payload bytes.
// `body` is a POISONED getter -- if the handler (or anything it calls)
// ever reads req.body, this throws immediately, which is exactly the real
// Vercel behavior for a lazily-computed, malformed-JSON-unsafe getter. A
// passing test therefore directly PROVES the webhook handler never touches
// req.body anywhere in its execution path.
function fakeWebhookRequest({ rawBody, signature }) {
  return {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    get body() { throw new Error('req.body must never be accessed by the webhook handler -- raw-body integrity violated') },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(rawBody, 'utf-8')
    },
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}

// Phase B.11 pre-commit correction (Part 6) -- `customerId` (matching
// whatever the test's own Checkout Session payload declares) plus
// `setupIntentOverrides` let individual tests exercise the hardened
// validation (non-succeeded status, customer mismatch, missing
// payment_method) against the exact same realistic default (status:
// 'succeeded', matching customer, a valid payment_method id) every other
// test relies on. Phase B.11 final pre-commit correction (webhook delivery
// semantics) -- `retrieveError`, when supplied, makes setupIntents.retrieve()
// throw instead of resolving, exercising the transient-Stripe-failure path.
function installFakeStripeWithRealSignatureVerification({ customerId = null, setupIntentOverrides = {}, retrieveError = null } = {}) {
  const setupIntentRetrieveCalls = []
  const client = {
    webhooks: {
      // Delegates to the REAL Stripe SDK's static constructEvent -- genuine
      // HMAC signature verification, not a mocked pass-through.
      constructEvent: (payload, sig, secret) => Stripe.webhooks.constructEvent(payload, sig, secret),
    },
    setupIntents: {
      retrieve: async (id) => {
        setupIntentRetrieveCalls.push(id)
        if (retrieveError) throw retrieveError
        return {
          id, status: 'succeeded', customer: customerId, payment_method: 'pm_testsavedcard',
          ...setupIntentOverrides,
        }
      },
    },
  }
  _setStripeClientForTests(() => client)
  return { setupIntentRetrieveCalls }
}

function buildCheckoutSessionCompletedPayload({ eventId = 'evt_test1', customerId, tenantIdMetadata, setupIntentId = 'seti_test1', mode = 'setup' }) {
  const payload = {
    id: eventId,
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'cs_test1', mode, customer: customerId, setup_intent: setupIntentId,
        metadata: tenantIdMetadata ? { tenantId: tenantIdMetadata } : {},
      },
    },
  }
  return JSON.stringify(payload)
}

async function invokeWebhookProperly(rawBody, signature) {
  const req = fakeWebhookRequest({ rawBody, signature })
  req.query = { action: 'stripe-webhook' }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function testValidSignatureAndSetupCompletionAppliesPaymentMethod() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_test1' })

  const tenantId = 't_test-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_test1' })
  await claimCustomerIndex('cus_test1', tenantId)

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_ok1', customerId: 'cus_test1', tenantIdMetadata: tenantId })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })

  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)

  const record = await getBillingRecord(tenantId)
  assert(record.defaultPaymentMethodId === 'pm_testsavedcard', 'the saved payment method must be projected onto the billing record')
}

async function testForgedSignatureIsRejected() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_forged1', customerId: 'cus_test1' })
  // Signed with a DIFFERENT secret than the one configured -- must fail.
  const badSignature = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_completely_different_secret' })

  const res = await invokeWebhookProperly(payload, badSignature)
  assert(res.statusCode === 400 && res.body.error === 'invalid_signature', 'a forged/mismatched signature must be rejected with 400 invalid_signature')
}

async function testTamperedPayloadWithOtherwiseValidSignatureIsRejected() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_tamper1', customerId: 'cus_test1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  // The signature was computed over `payload`, but a DIFFERENT byte
  // sequence is what actually arrives -- must fail closed.
  const tamperedPayload = payload.replace('cus_test1', 'cus_attacker')

  const res = await invokeWebhookProperly(tamperedPayload, signature)
  assert(res.statusCode === 400 && res.body.error === 'invalid_signature')
}

async function testMissingSignatureHeaderIsRejected() {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()
  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_nosig1', customerId: 'cus_test1' })
  const res = await invokeWebhookProperly(payload, undefined)
  assert(res.statusCode === 400 && res.body.error === 'invalid_request')
}

async function testWrongCustomerTenantMappingIsDenied() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()
  // No claimCustomerIndex() was ever called for this customer id -- the
  // reverse index has no record of it.
  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_unknown1', customerId: 'cus_neverbound1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  // Acknowledged (200) so Stripe does not retry forever, but NOT processed.
  assert(res.statusCode === 200)
  let threw = null
  try { await getBillingRecord('t_test-tenant-1') } catch (err) { threw = err }
  // No billing record was ever created for anyone as a side effect.
  assert(threw === null, 'an unrecognized customer must never cause any billing record to be created/modified')
}

async function testMetadataMismatchDoesNotOverrideReverseIndex() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_test2' })

  const realTenantId = 't_real-tenant-1'
  await createBillingRecord(realTenantId, { stripeCustomerId: 'cus_test2' })
  await claimCustomerIndex('cus_test2', realTenantId)

  // Metadata CLAIMS a different, spoofed tenantId -- the reverse index
  // (bound to the real tenant above) must win.
  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_meta1', customerId: 'cus_test2', tenantIdMetadata: 't_spoofed-tenant' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)

  const realRecord = await getBillingRecord(realTenantId)
  assert(realRecord.defaultPaymentMethodId === 'pm_testsavedcard', 'the payment method must be applied to the REAL (reverse-index-resolved) tenant, never the metadata-claimed one')
}

async function testDuplicateEventIsIdempotent() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  const { setupIntentRetrieveCalls } = installFakeStripeWithRealSignatureVerification({ customerId: 'cus_dup1' })

  const tenantId = 't_dup-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_dup1' })
  await claimCustomerIndex('cus_dup1', tenantId)

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_dup1', customerId: 'cus_dup1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })

  const first = await invokeWebhookProperly(payload, signature)
  const second = await invokeWebhookProperly(payload, signature)
  assert(first.statusCode === 200 && second.statusCode === 200)
  assert(setupIntentRetrieveCalls.length === 1, 'a duplicate delivery of the same event must never reprocess it -- setupIntents.retrieve must be called exactly once')
}

async function testNonSetupModeSessionIsIgnored() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()
  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_wrongmode1', customerId: 'cus_test1', mode: 'subscription' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200, 'a non-setup-mode session must be acknowledged but ignored, not processed by this B.11 handler')
}

// ===========================================================================
// Phase B.12 -- customer.subscription.updated/deleted minimal projection.
// ===========================================================================

function buildSubscriptionEventPayload({
  eventId = 'evt_sub1', type = 'customer.subscription.updated', subscriptionId, status = 'active',
  cancelAtPeriodEnd = false, created, customer, priceId, metadataTenantId, currentPeriodEnd,
}) {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const object = {
    id: subscriptionId, status, cancel_at_period_end: cancelAtPeriodEnd,
    current_period_start: nowSeconds, current_period_end: currentPeriodEnd ?? (nowSeconds + 30 * 24 * 60 * 60),
  }
  if (customer !== undefined) object.customer = customer
  if (priceId !== undefined) object.items = { data: [{ price: { id: priceId } }] }
  if (metadataTenantId !== undefined) object.metadata = { tenantId: metadataTenantId }
  const payload = { id: eventId, type, created: created ?? nowSeconds, data: { object } }
  return JSON.stringify(payload)
}

async function seedTenantWithSubscription(tenantId, subscriptionId, { stripeCustomerId, pendingPaidPlan } = {}) {
  await createBillingRecord(tenantId, {
    stripeSubscriptionId: subscriptionId, subscriptionStatus: 'trialing',
    ...(stripeCustomerId !== undefined ? { stripeCustomerId } : {}),
    ...(pendingPaidPlan !== undefined ? { pendingPaidPlan } : {}),
  })
  await claimSubscriptionIndex(subscriptionId, tenantId)
}

async function testSubscriptionUpdatedProjectsActiveStatus() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_sub-tenant-1'
  await seedTenantWithSubscription(tenantId, 'sub_test1')

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_subactive1', subscriptionId: 'sub_test1', status: 'active' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)

  const record = await getBillingRecord(tenantId)
  assert(record.subscriptionStatus === 'active', 'the projected status must land on the billing record')
}

async function testSubscriptionDeletedAlwaysProjectsCanceled() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_sub-tenant-2'
  await seedTenantWithSubscription(tenantId, 'sub_test2')

  // Stripe's own contract: the object's own `status` field on a
  // customer.subscription.deleted event may not itself read 'canceled' --
  // the EVENT TYPE is what is authoritative for this transition.
  const payload = buildSubscriptionEventPayload({ eventId: 'evt_subdeleted1', type: 'customer.subscription.deleted', subscriptionId: 'sub_test2', status: 'active' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)

  const record = await getBillingRecord(tenantId)
  assert(record.subscriptionStatus === 'canceled', 'a customer.subscription.deleted event must always project canceled, regardless of the object\'s own reported status')
}

async function testTrialingSubscriptionEventNeverTouchesTenantConfig() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_sub-tenant-3'
  await seedTenantWithSubscription(tenantId, 'sub_test3')

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_subtrialing1', subscriptionId: 'sub_test3', status: 'trialing' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)

  const record = await getBillingRecord(tenantId)
  // billingStore.js's own record has NO commercialStatus/trial field at
  // all (that lives exclusively in tenant_config.commercial, a completely
  // separate store this handler never imports or touches) -- a 'trialing'
  // projection can therefore structurally never start or restart a PRYOR
  // trial. This asserts the ONLY field this handler could have written
  // reflects the raw Stripe status, and nothing resembling a PRYOR trial
  // shape was ever introduced onto the billing record.
  assert(record.subscriptionStatus === 'trialing')
  assert(!('commercialStatus' in record) && !('trial' in record), 'a Stripe trialing projection must never introduce any PRYOR trial-shaped field')
}

async function testPastDueUnpaidCanceledProjectionIntroducesNoEnforcementFields() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  for (const status of ['past_due', 'unpaid', 'canceled']) {
    const tenantId = `t_sub-tenant-status-${status.replace(/_/g, '-')}`
    const subscriptionId = `sub_test${status.replace(/_/g, '')}`
    await seedTenantWithSubscription(tenantId, subscriptionId)
    const payload = buildSubscriptionEventPayload({ eventId: `evt_${status.replace(/_/g, '')}1`, subscriptionId, status })
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
    const res = await invokeWebhookProperly(payload, signature)
    assert(res.statusCode === 200)
    const record = await getBillingRecord(tenantId)
    assert(record.subscriptionStatus === status, `${status} must be recorded as a plain fact on the billing record`)
    // B.13 scope (suspension/cancellation POLICY, Customer Portal,
    // cancel-at-period-end UX) is never implemented here -- there is no
    // suspension/enforcement field on this record type at all to check for
    // absence beyond the projection fields billingStore.js itself defines;
    // this test's real assertion is structural (see the source-scan test
    // below) that the handler never imports tenantConfigStore.js.
    assert(record.stripeSubscriptionId === subscriptionId)
  }
}

async function testDuplicateSubscriptionWebhookDeliveryIsIdempotent() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_sub-tenant-dup1'
  await seedTenantWithSubscription(tenantId, 'sub_dup1')

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_subdup1', subscriptionId: 'sub_dup1', status: 'active' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })

  const first = await invokeWebhookProperly(payload, signature)
  const recordAfterFirst = await getBillingRecord(tenantId)
  // Mutate the record's version out from under a hypothetical re-apply by
  // recording a DIFFERENT status directly, then redeliver the SAME event --
  // if redelivery were not idempotent, it would blindly overwrite this.
  await updateBillingRecord(tenantId, { subscriptionStatus: 'past_due' }, { expectedVersion: recordAfterFirst.version })

  const second = await invokeWebhookProperly(payload, signature)
  assert(first.statusCode === 200 && second.statusCode === 200)
  const finalRecord = await getBillingRecord(tenantId)
  assert(finalRecord.subscriptionStatus === 'past_due', 'a duplicate delivery of an already-processed event must never reprocess/overwrite a later legitimate change')
}

async function testUnrecognizedSubscriptionIsAcknowledgedNotProcessed() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()
  // No claimSubscriptionIndex() was ever called for this subscription id.
  const payload = buildSubscriptionEventPayload({ eventId: 'evt_subunknown1', subscriptionId: 'sub_neverbound1', status: 'active' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200, 'an unrecognized subscription must be acknowledged (200) so Stripe does not retry forever')
}

// ===========================================================================
// Phase B.12 (Decision 2) -- the minimal canonical paid-active transition.
// Every test below seeds a REAL tenant_config via tenantConfigStore.js
// (never a hand-built object), exactly mirroring test_trial_lifecycle.js's
// own discipline.
// ===========================================================================

async function testTrialingWebhookDoesNotMutatePryorTrial() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_paid-trialing-1'
  const configBefore = await seedTrialingTenantConfig(tenantId)
  await seedTenantWithSubscription(tenantId, 'sub_trialing1', { stripeCustomerId: 'cus_trialing1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_trialingpaid1', subscriptionId: 'sub_trialing1', status: 'trialing', customer: 'cus_trialing1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)

  const configAfter = await getTenantConfig(tenantId)
  assert(configAfter.commercial.commercialStatus === 'trial', 'trialing must never advance commercialStatus')
  assert(configAfter.commercial.trial.startedAt === configBefore.commercial.trial.startedAt, 'trialing must never touch trial.startedAt')
  assert(configAfter.commercial.trial.endsAt === configBefore.commercial.trial.endsAt, 'trialing must never touch trial.endsAt')
  assert(configAfter.configVersion === configBefore.configVersion, 'a trialing event must never write tenant_config at all')

  const record = await getBillingRecord(tenantId)
  assert(record.subscriptionStatus === 'trialing', 'the raw Stripe status is still projected onto the billing record')
}

async function testValidActiveWebhookTransitionsToPaidActiveExactlyOnce() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtest1'
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_paid-active-1'
  await seedTrialingTenantConfig(tenantId)
  await seedTenantWithSubscription(tenantId, 'sub_active1', { stripeCustomerId: 'cus_active1' })

  const payload = buildSubscriptionEventPayload({
    eventId: 'evt_active1', subscriptionId: 'sub_active1', status: 'active',
    customer: 'cus_active1', priceId: 'price_growthtest1',
  })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'active', `expected active, got ${config.commercial.commercialStatus}`)
  assert(config.commercial.plan === 'growth')
  assert(config.commercial.planSource === 'stripe_subscription_active')
  assert(config.commercial.trial != null && config.commercial.trial.status === 'active', 'the historical trial record must be preserved, never wiped')

  // A second, later 'active' delivery for the same (already-active) tenant
  // must be a pure no-op -- this transition only ever fires OUT of 'trial'.
  const payload2 = buildSubscriptionEventPayload({
    eventId: 'evt_active2', subscriptionId: 'sub_active1', status: 'active',
    customer: 'cus_active1', priceId: 'price_growthtest1', created: Math.floor(Date.now() / 1000) + 10,
  })
  const signature2 = Stripe.webhooks.generateTestHeaderString({ payload: payload2, secret: TEST_WEBHOOK_SECRET })
  const res2 = await invokeWebhookProperly(payload2, signature2)
  assert(res2.statusCode === 200)
  const configAfterSecond = await getTenantConfig(tenantId)
  assert(configAfterSecond.configVersion === config.configVersion, 'a second active event must never re-apply the transition -- exactly once')
}

async function testDuplicateActiveEventIsIdempotent() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtestdup'
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_paid-active-dup1'
  await seedTrialingTenantConfig(tenantId)
  await seedTenantWithSubscription(tenantId, 'sub_activedup1', { stripeCustomerId: 'cus_activedup1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_activedup1', subscriptionId: 'sub_activedup1', status: 'active', customer: 'cus_activedup1', priceId: 'price_growthtestdup' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })

  const first = await invokeWebhookProperly(payload, signature)
  const configAfterFirst = await getTenantConfig(tenantId)
  const second = await invokeWebhookProperly(payload, signature) // exact same event id -- redelivery
  const configAfterSecond = await getTenantConfig(tenantId)

  assert(first.statusCode === 200 && second.statusCode === 200)
  assert(configAfterFirst.commercial.commercialStatus === 'active')
  assert(configAfterSecond.configVersion === configAfterFirst.configVersion, 'a duplicate delivery of the SAME event id must never reapply the transition')
}

async function testStaleActiveEventIsIgnoredAppropriately() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthteststale'
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_paid-active-stale1'
  await seedTrialingTenantConfig(tenantId)
  await seedTenantWithSubscription(tenantId, 'sub_stale1', { stripeCustomerId: 'cus_stale1' })

  const now = Math.floor(Date.now() / 1000)
  const newerPayload = buildSubscriptionEventPayload({ eventId: 'evt_stalenew1', subscriptionId: 'sub_stale1', status: 'active', customer: 'cus_stale1', priceId: 'price_growthteststale', created: now + 1000 })
  const newerSignature = Stripe.webhooks.generateTestHeaderString({ payload: newerPayload, secret: TEST_WEBHOOK_SECRET })
  const newerRes = await invokeWebhookProperly(newerPayload, newerSignature)
  assert(newerRes.statusCode === 200)
  const configAfterActive = await getTenantConfig(tenantId)
  assert(configAfterActive.commercial.commercialStatus === 'active')

  // An OLDER event (a different eventId, so it isn't just deduplicated by
  // the event ledger) delivered AFTER the newer one -- must be ignored by
  // isStaleBillingEvent()'s own guard, never overwriting the already-applied
  // newer status.
  const olderPayload = buildSubscriptionEventPayload({ eventId: 'evt_staleold1', subscriptionId: 'sub_stale1', status: 'past_due', customer: 'cus_stale1', priceId: 'price_growthteststale', created: now })
  const olderSignature = Stripe.webhooks.generateTestHeaderString({ payload: olderPayload, secret: TEST_WEBHOOK_SECRET })
  const olderRes = await invokeWebhookProperly(olderPayload, olderSignature)
  assert(olderRes.statusCode === 200)

  const record = await getBillingRecord(tenantId)
  assert(record.subscriptionStatus === 'active', 'a stale (older) event must never overwrite an already-applied newer status')
  const configAfterStale = await getTenantConfig(tenantId)
  assert(configAfterStale.commercial.commercialStatus === 'active', 'the canonical commercial state must remain unaffected by an ignored stale event')
}

async function testWrongSubscriptionReverseIndexRejectsActiveTransition() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtestwrongsub'
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_paid-active-wrongsub1'
  await seedTrialingTenantConfig(tenantId)
  // The billing record's OWN recorded subscription is 'sub_real1', but the
  // reverse index below (deliberately, to simulate a data inconsistency)
  // maps a DIFFERENT subscription id to this same tenant.
  await createBillingRecord(tenantId, { stripeSubscriptionId: 'sub_real1', stripeCustomerId: 'cus_wrongsub1', subscriptionStatus: 'trialing' })
  await claimSubscriptionIndex('sub_event1', tenantId)

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_wrongsub1', subscriptionId: 'sub_event1', status: 'active', customer: 'cus_wrongsub1', priceId: 'price_growthtestwrongsub' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'trial', 'a subscription-id mismatch against the tenant\'s own billing record must reject the paid-active transition')
}

async function testWrongCustomerRejectsActiveTransition() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtestwrongcust'
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_paid-active-wrongcust1'
  await seedTrialingTenantConfig(tenantId)
  await seedTenantWithSubscription(tenantId, 'sub_wrongcust1', { stripeCustomerId: 'cus_real1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_wrongcust1', subscriptionId: 'sub_wrongcust1', status: 'active', customer: 'cus_attacker1', priceId: 'price_growthtestwrongcust' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'trial', 'a customer mismatch against the tenant\'s own billing record must reject the paid-active transition')
}

async function testWrongPriceMappingRejectsActiveTransition() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtestwrongprice'
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_paid-active-wrongprice1'
  await seedTrialingTenantConfig(tenantId)
  await seedTenantWithSubscription(tenantId, 'sub_wrongprice1', { stripeCustomerId: 'cus_wrongprice1' })

  // An unmapped price -- neither the configured Core nor Growth price id.
  const payload = buildSubscriptionEventPayload({ eventId: 'evt_wrongprice1', subscriptionId: 'sub_wrongprice1', status: 'active', customer: 'cus_wrongprice1', priceId: 'price_totallyunmapped999' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'trial', 'an unmapped/unrecognized price must reject the paid-active transition')
}

async function testPaidActiveTransitionCannotGrantEnterprise() {
  // There is no STRIPE_ENTERPRISE_PRICE_ID concept anywhere in this
  // codebase (stripePriceMap.js's SELF_SERVICE_PLAN_IDS structurally
  // excludes Enterprise) -- any price that does not match the configured
  // Core/Growth price ids (including one that might represent an
  // Enterprise deal in Stripe's own dashboard) can never resolve to a
  // plan here, and therefore can never grant paid-active status.
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_CORE_PRICE_ID = 'price_coretestentcheck'
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtestentcheck'
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_paid-active-noenterprise1'
  await seedTrialingTenantConfig(tenantId)
  await seedTenantWithSubscription(tenantId, 'sub_noenterprise1', { stripeCustomerId: 'cus_noenterprise1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_noenterprise1', subscriptionId: 'sub_noenterprise1', status: 'active', customer: 'cus_noenterprise1', priceId: 'price_enterprise_deal_xyz' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.plan !== 'enterprise', 'the paid-active transition must never result in plan: enterprise')
  assert(config.commercial.commercialStatus === 'trial', 'an Enterprise-looking price must never advance PRYOR out of trial via this self-service transition')
}

async function testForgedMetadataTenantIdCannotRedirectPaidActiveState() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtestmeta'
  installFakeStripeWithRealSignatureVerification()

  const realTenantId = 't_paid-active-real1'
  const spoofedTenantId = 't_paid-active-spoofed1'
  await seedTrialingTenantConfig(realTenantId)
  await seedTenantWithSubscription(realTenantId, 'sub_meta1', { stripeCustomerId: 'cus_meta1' })

  const payload = buildSubscriptionEventPayload({
    eventId: 'evt_metaactive1', subscriptionId: 'sub_meta1', status: 'active',
    customer: 'cus_meta1', priceId: 'price_growthtestmeta', metadataTenantId: spoofedTenantId,
  })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)

  const realConfig = await getTenantConfig(realTenantId)
  assert(realConfig.commercial.commercialStatus === 'active', 'the REAL, reverse-index-resolved tenant must receive the transition')
  const spoofedConfig = await getTenantConfig(spoofedTenantId)
  assert(spoofedConfig === null, 'the metadata-claimed tenant must never be touched -- it does not even exist')
}

// ===========================================================================
// Phase B.13 -- Cancellation model (items 15-21).
// ===========================================================================

async function testCancelAtPeriodEndDoesNotRemoveAccess() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_cancel-intent-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'active' })
  await seedTenantWithSubscription(tenantId, 'sub_cancelintent1', { stripeCustomerId: 'cus_cancelintent1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_cancelintent1', subscriptionId: 'sub_cancelintent1', status: 'active', customer: 'cus_cancelintent1', cancelAtPeriodEnd: true })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'active', 'cancel_at_period_end must never remove access -- commercialStatus stays active')
  assert(config.commercial.cancellation?.status === 'pending_at_period_end')
}

async function testCancellationRequestedAtAnchoredToFirstAcceptedEvent() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_cancel-requestedat-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'active' })
  await seedTenantWithSubscription(tenantId, 'sub_reqat1', { stripeCustomerId: 'cus_reqat1' })

  const firstEventCreated = Math.floor(Date.now() / 1000)
  const payload = buildSubscriptionEventPayload({ eventId: 'evt_reqat1', subscriptionId: 'sub_reqat1', status: 'active', customer: 'cus_reqat1', cancelAtPeriodEnd: true, created: firstEventCreated })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  await invokeWebhookProperly(payload, signature)

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.cancellation.requestedAt === new Date(firstEventCreated * 1000).toISOString(), 'requestedAt must be derived from the first accepted event.created, never Date.now()')
}

async function testRepeatedCancelEventDoesNotResetRequestedAt() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_cancel-repeated-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'active' })
  await seedTenantWithSubscription(tenantId, 'sub_repeated1', { stripeCustomerId: 'cus_repeated1' })

  const firstCreated = Math.floor(Date.now() / 1000)
  const first = buildSubscriptionEventPayload({ eventId: 'evt_repeated1', subscriptionId: 'sub_repeated1', status: 'active', customer: 'cus_repeated1', cancelAtPeriodEnd: true, created: firstCreated })
  await invokeWebhookProperly(first, Stripe.webhooks.generateTestHeaderString({ payload: first, secret: TEST_WEBHOOK_SECRET }))

  // A LATER, different event, still cancelAtPeriodEnd: true (e.g. Stripe
  // redelivering/re-confirming the same intent).
  const laterCreated = firstCreated + 1000
  const second = buildSubscriptionEventPayload({ eventId: 'evt_repeated2', subscriptionId: 'sub_repeated1', status: 'active', customer: 'cus_repeated1', cancelAtPeriodEnd: true, created: laterCreated })
  await invokeWebhookProperly(second, Stripe.webhooks.generateTestHeaderString({ payload: second, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.cancellation.requestedAt === new Date(firstCreated * 1000).toISOString(), 'a repeated cancel-intent event must never reset requestedAt to a later timestamp')
}

async function testCancellationEffectiveAtEqualsCurrentPeriodEnd() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_cancel-effectiveat-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'active' })
  await seedTenantWithSubscription(tenantId, 'sub_effat1', { stripeCustomerId: 'cus_effat1' })

  const nowSeconds = Math.floor(Date.now() / 1000)
  const currentPeriodEnd = nowSeconds + 30 * 24 * 60 * 60
  const payload = buildSubscriptionEventPayload({ eventId: 'evt_effat1', subscriptionId: 'sub_effat1', status: 'active', customer: 'cus_effat1', cancelAtPeriodEnd: true, currentPeriodEnd })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.cancellation.effectiveAt === new Date(currentPeriodEnd * 1000).toISOString(), 'effectiveAt must equal the validated current_period_end')
}

async function testReactivationClearsCancellation() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_reactivate-1'
  await seedCommercialTenantConfig(tenantId, {
    commercialStatus: 'active',
    cancellation: { status: 'pending_at_period_end', requestedAt: new Date().toISOString(), effectiveAt: new Date().toISOString() },
  })
  await seedTenantWithSubscription(tenantId, 'sub_reactivate1', { stripeCustomerId: 'cus_reactivate1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_reactivate1', subscriptionId: 'sub_reactivate1', status: 'active', customer: 'cus_reactivate1', cancelAtPeriodEnd: false })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.cancellation === null, 'a cancel_at_period_end: true -> false transition must clear the cancellation intent')
  assert(config.commercial.commercialStatus === 'active', 'reactivation must never itself change commercialStatus')
}

async function testActualDeletedEventTransitionsToCanceled() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_actual-deleted-1'
  await seedCommercialTenantConfig(tenantId, {
    commercialStatus: 'active',
    cancellation: { status: 'pending_at_period_end', requestedAt: new Date().toISOString(), effectiveAt: new Date().toISOString() },
  })
  await seedTenantWithSubscription(tenantId, 'sub_actualdeleted1', { stripeCustomerId: 'cus_actualdeleted1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_actualdeleted1', type: 'customer.subscription.deleted', subscriptionId: 'sub_actualdeleted1', status: 'active', customer: 'cus_actualdeleted1' })
  const res = await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))
  assert(res.statusCode === 200)

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'canceled', 'an actual completed cancellation must transition commercialStatus to canceled')
  assert(config.commercial.cancellation === null, 'the pending-intent marker must be cleared once cancellation is actually complete')
}

async function testCanceledPreservesPlanAndData() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_canceled-preserve-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'active', plan: 'core' })
  await seedTenantWithSubscription(tenantId, 'sub_preserve1', { stripeCustomerId: 'cus_preserve1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_preserve1', type: 'customer.subscription.deleted', subscriptionId: 'sub_preserve1', status: 'active', customer: 'cus_preserve1' })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'canceled')
  assert(config.commercial.plan === 'core', 'plan must be preserved, never wiped, on cancellation')
  assert(config.commercial.trial != null, 'trial history must be preserved')
  const record = await getBillingRecord(tenantId)
  assert(record.stripeCustomerId === 'cus_preserve1' && record.stripeSubscriptionId === 'sub_preserve1', 'billing identifiers/auditability must be preserved -- no destructive deletion')
}

// ===========================================================================
// Phase B.13 -- Delinquency: past_due (items 22-28).
// ===========================================================================

async function testFirstPastDueSetsCommercialStatusAndPastDueSince() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_pastdue-first-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'active' })
  await seedTenantWithSubscription(tenantId, 'sub_pdfirst1', { stripeCustomerId: 'cus_pdfirst1' })

  const eventCreated = Math.floor(Date.now() / 1000)
  const payload = buildSubscriptionEventPayload({ eventId: 'evt_pdfirst1', subscriptionId: 'sub_pdfirst1', status: 'past_due', customer: 'cus_pdfirst1', created: eventCreated })
  const res = await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))
  assert(res.statusCode === 200)

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'past_due', 'the first validated past_due event must set commercialStatus=past_due')
  const record = await getBillingRecord(tenantId)
  assert(record.pastDueSince === new Date(eventCreated * 1000).toISOString(), 'pastDueSince must be derived from event.created, never Date.now()')
}

async function testDuplicatePastDueDoesNotResetClock() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_pastdue-dup-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'active' })
  await seedTenantWithSubscription(tenantId, 'sub_pddup1', { stripeCustomerId: 'cus_pddup1' })

  const eventCreated = Math.floor(Date.now() / 1000)
  const payload = buildSubscriptionEventPayload({ eventId: 'evt_pddup1', subscriptionId: 'sub_pddup1', status: 'past_due', customer: 'cus_pddup1', created: eventCreated })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  await invokeWebhookProperly(payload, signature)
  // Exact same event id, redelivered.
  await invokeWebhookProperly(payload, signature)

  const record = await getBillingRecord(tenantId)
  assert(record.pastDueSince === new Date(eventCreated * 1000).toISOString(), 'a duplicate delivery of the SAME event must never alter pastDueSince')
}

async function testLaterPastDueDoesNotExtendClock() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_pastdue-later-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'active' })
  await seedTenantWithSubscription(tenantId, 'sub_pdlater1', { stripeCustomerId: 'cus_pdlater1' })

  const firstCreated = Math.floor(Date.now() / 1000)
  const first = buildSubscriptionEventPayload({ eventId: 'evt_pdlater1', subscriptionId: 'sub_pdlater1', status: 'past_due', customer: 'cus_pdlater1', created: firstCreated })
  await invokeWebhookProperly(first, Stripe.webhooks.generateTestHeaderString({ payload: first, secret: TEST_WEBHOOK_SECRET }))

  // A LATER, DIFFERENT past_due event for the SAME ongoing episode --
  // must never push pastDueSince forward.
  const laterCreated = firstCreated + 5000
  const second = buildSubscriptionEventPayload({ eventId: 'evt_pdlater2', subscriptionId: 'sub_pdlater1', status: 'past_due', customer: 'cus_pdlater1', created: laterCreated })
  await invokeWebhookProperly(second, Stripe.webhooks.generateTestHeaderString({ payload: second, secret: TEST_WEBHOOK_SECRET }))

  const record = await getBillingRecord(tenantId)
  assert(record.pastDueSince === new Date(firstCreated * 1000).toISOString(), 'a later past_due event for the same ongoing episode must never extend/reset the grace clock')
}

async function testStalePastDueIgnored() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_pastdue-stale-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'active' })
  await seedTenantWithSubscription(tenantId, 'sub_pdstale1', { stripeCustomerId: 'cus_pdstale1' })

  const now = Math.floor(Date.now() / 1000)
  // Apply a NEWER active event first (establishes lastStripeEventCreatedAt).
  const newer = buildSubscriptionEventPayload({ eventId: 'evt_pdstale_newer', subscriptionId: 'sub_pdstale1', status: 'active', customer: 'cus_pdstale1', created: now + 1000 })
  await invokeWebhookProperly(newer, Stripe.webhooks.generateTestHeaderString({ payload: newer, secret: TEST_WEBHOOK_SECRET }))

  // A STALE (older), different-eventId past_due delivery must be ignored entirely.
  const stale = buildSubscriptionEventPayload({ eventId: 'evt_pdstale_older', subscriptionId: 'sub_pdstale1', status: 'past_due', customer: 'cus_pdstale1', created: now })
  await invokeWebhookProperly(stale, Stripe.webhooks.generateTestHeaderString({ payload: stale, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'active', 'a stale past_due event must never overwrite an already-applied newer active status')
  const record = await getBillingRecord(tenantId)
  assert(record.pastDueSince === null, 'a stale past_due event must never set pastDueSince')
}

async function testPastDueRetainsNormalPlanEntitlements() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_pastdue-entitlements-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'active', plan: 'growth' })
  await seedTenantWithSubscription(tenantId, 'sub_pdent1', { stripeCustomerId: 'cus_pdent1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_pdent1', subscriptionId: 'sub_pdent1', status: 'past_due', customer: 'cus_pdent1' })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  const entitlements = resolveTenantEntitlementsFromConfig(config)
  assert(entitlements.commercialStatus === 'past_due')
  assert(entitlements.limits.maxLocations !== 0 && entitlements.limits.maxLocations === PLAN_ENTITLEMENTS.growth.limits.maxLocations, 'past_due must retain the plan\'s REAL numeric limits, never deny-all')
  assert(entitlements.features.reviewPublishing !== false || Object.values(entitlements.features).some(Boolean), 'past_due must retain the plan\'s real feature set')
}

async function testPastDueDoesNotSuspend() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_pastdue-nosuspend-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'active' })
  await seedTenantWithSubscription(tenantId, 'sub_pdnosusp1', { stripeCustomerId: 'cus_pdnosusp1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_pdnosusp1', subscriptionId: 'sub_pdnosusp1', status: 'past_due', customer: 'cus_pdnosusp1' })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'past_due', 'past_due must set commercialStatus=past_due')
  assert(config.commercial.suspension === null, 'past_due must NEVER suspend PRYOR commercial access -- only unpaid does, in B.13')
}

// ===========================================================================
// Phase B.13 -- Delinquency: unpaid / terminal suspension (items 29-37).
// ===========================================================================

async function testValidatedUnpaidSuspendsWithExactShape() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_unpaid-suspend-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'past_due', plan: 'growth' })
  await seedTenantWithSubscription(tenantId, 'sub_unpaidsusp1', { stripeCustomerId: 'cus_unpaidsusp1' })

  const eventCreated = Math.floor(Date.now() / 1000)
  const payload = buildSubscriptionEventPayload({ eventId: 'evt_unpaidsusp1', subscriptionId: 'sub_unpaidsusp1', status: 'unpaid', customer: 'cus_unpaidsusp1', created: eventCreated })
  const res = await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))
  assert(res.statusCode === 200)

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'suspended', 'a validated unpaid event must suspend')
  assert(config.commercial.suspension.reason === 'stripe_unpaid_terminal', 'the suspension reason must be the exact enum value')
  assert(config.commercial.suspension.suspendedAt === new Date(eventCreated * 1000).toISOString(), 'suspendedAt must be derived from Stripe event.created')
  assert(config.commercial.plan === 'growth', 'plan must be preserved on suspension')
}

async function testDuplicateUnpaidEventIsIdempotent() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_unpaid-dup-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'past_due' })
  await seedTenantWithSubscription(tenantId, 'sub_unpaiddup1', { stripeCustomerId: 'cus_unpaiddup1' })

  const eventCreated = Math.floor(Date.now() / 1000)
  const payload = buildSubscriptionEventPayload({ eventId: 'evt_unpaiddup1', subscriptionId: 'sub_unpaiddup1', status: 'unpaid', customer: 'cus_unpaiddup1', created: eventCreated })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  await invokeWebhookProperly(payload, signature)
  const configAfterFirst = await getTenantConfig(tenantId)
  await invokeWebhookProperly(payload, signature) // exact same event id, redelivered
  const configAfterSecond = await getTenantConfig(tenantId)

  assert(configAfterFirst.commercial.commercialStatus === 'suspended')
  assert(configAfterSecond.configVersion === configAfterFirst.configVersion, 'a duplicate unpaid delivery must never reapply the suspension transition')
  assert(configAfterSecond.commercial.suspension.suspendedAt === configAfterFirst.commercial.suspension.suspendedAt)
}

async function testStaleUnpaidIgnored() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthteststaleunpaid'
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_unpaid-stale-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'past_due', plan: 'growth' })
  await seedTenantWithSubscription(tenantId, 'sub_unpaidstale1', { stripeCustomerId: 'cus_unpaidstale1' })

  const now = Math.floor(Date.now() / 1000)
  const newer = buildSubscriptionEventPayload({ eventId: 'evt_unpaidstalenewer', subscriptionId: 'sub_unpaidstale1', status: 'active', customer: 'cus_unpaidstale1', created: now + 1000, priceId: 'price_growthteststaleunpaid' })
  await invokeWebhookProperly(newer, Stripe.webhooks.generateTestHeaderString({ payload: newer, secret: TEST_WEBHOOK_SECRET }))

  const stale = buildSubscriptionEventPayload({ eventId: 'evt_unpaidstaleolder', subscriptionId: 'sub_unpaidstale1', status: 'unpaid', customer: 'cus_unpaidstale1', created: now })
  await invokeWebhookProperly(stale, Stripe.webhooks.generateTestHeaderString({ payload: stale, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'active', 'a stale unpaid event must never override an already-applied newer active status')
}

async function testWrongSubscriptionRejectedForUnpaid() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_unpaid-wrongsub-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'past_due' })
  await createBillingRecord(tenantId, { stripeSubscriptionId: 'sub_realunpaid1', stripeCustomerId: 'cus_wrongsubunpaid1', subscriptionStatus: 'past_due' })
  await claimSubscriptionIndex('sub_eventunpaid1', tenantId)

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_wrongsubunpaid1', subscriptionId: 'sub_eventunpaid1', status: 'unpaid', customer: 'cus_wrongsubunpaid1' })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'past_due', 'a subscription-id mismatch must reject the suspension')
}

async function testWrongCustomerRejectedForUnpaid() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_unpaid-wrongcust-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'past_due' })
  await seedTenantWithSubscription(tenantId, 'sub_wrongcustunpaid1', { stripeCustomerId: 'cus_realunpaid1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_wrongcustunpaid1', subscriptionId: 'sub_wrongcustunpaid1', status: 'unpaid', customer: 'cus_attackerunpaid1' })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'past_due', 'a customer mismatch must reject the suspension')
}

async function testUnpaidPreservesPlanAndTrialHistory() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_unpaid-preserve-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'past_due', plan: 'core' })
  await seedTenantWithSubscription(tenantId, 'sub_unpaidpreserve1', { stripeCustomerId: 'cus_unpaidpreserve1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_unpaidpreserve1', subscriptionId: 'sub_unpaidpreserve1', status: 'unpaid', customer: 'cus_unpaidpreserve1' })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.plan === 'core', 'plan must be preserved on suspension')
  assert(config.commercial.trial != null, 'trial history must be preserved on suspension')
  const record = await getBillingRecord(tenantId)
  assert(record.stripeCustomerId === 'cus_unpaidpreserve1' && record.stripeSubscriptionId === 'sub_unpaidpreserve1', 'billing identifiers must be preserved -- no destructive action')
}

async function testUnpaidNeverAutoCancels() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_unpaid-noautocancel-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'past_due' })
  await seedTenantWithSubscription(tenantId, 'sub_noautocancel1', { stripeCustomerId: 'cus_noautocancel1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_noautocancel1', subscriptionId: 'sub_noautocancel1', status: 'unpaid', customer: 'cus_noautocancel1' })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'suspended', 'unpaid must suspend')
  assert(config.commercial.commercialStatus !== 'canceled', 'unpaid must NEVER auto-cancel -- suspended only')
}

// ===========================================================================
// Phase B.13 -- paused (items 38-39, Amendment 3).
// ===========================================================================

async function testPausedUpdatesBillingProjectionOnly() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_paused-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'active' })
  await seedTenantWithSubscription(tenantId, 'sub_paused1', { stripeCustomerId: 'cus_paused1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_paused1', subscriptionId: 'sub_paused1', status: 'paused', customer: 'cus_paused1' })
  const res = await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))
  assert(res.statusCode === 200)

  const record = await getBillingRecord(tenantId)
  assert(record.subscriptionStatus === 'paused', 'paused must still be recorded as a billing:v1 fact')
}

async function testPausedDoesNotCreateCanonicalSuspension() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_paused-nosuspend-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'active' })
  await seedTenantWithSubscription(tenantId, 'sub_pausednosusp1', { stripeCustomerId: 'cus_pausednosusp1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_pausednosusp1', subscriptionId: 'sub_pausednosusp1', status: 'paused', customer: 'cus_pausednosusp1' })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'active', 'paused must NEVER be used as canonical suspension authority in B.13 (Amendment 3) -- billingStatusProjection.js\'s own paused->suspended mapping is deliberately not acted on here')
  assert(config.commercial.suspension === null)
}

// ===========================================================================
// Phase B.13 -- Recovery (items 40-44).
// ===========================================================================

async function testActiveClearsPastDueSince() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtestrecoverpd'
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_recover-pastdue-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'past_due', plan: 'growth' })
  await seedTenantWithSubscription(tenantId, 'sub_recoverpd1', { stripeCustomerId: 'cus_recoverpd1' })
  await updateBillingRecord(tenantId, { pastDueSince: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() }, { expectedVersion: (await getBillingRecord(tenantId)).version })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_recoverpd1', subscriptionId: 'sub_recoverpd1', status: 'active', customer: 'cus_recoverpd1', priceId: 'price_growthtestrecoverpd' })
  const res = await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))
  assert(res.statusCode === 200)

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'active', 'a validated active event must recover a past_due tenant to active')
  const record = await getBillingRecord(tenantId)
  assert(record.pastDueSince === null, 'a validated active event must clear pastDueSince')
}

async function testActiveResumesAndClearsStripeUnpaidTerminalSuspension() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtestresume'
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_resume-suspend-1'
  await seedCommercialTenantConfig(tenantId, {
    commercialStatus: 'suspended', plan: 'growth',
    suspension: { reason: 'stripe_unpaid_terminal', suspendedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() },
  })
  await seedTenantWithSubscription(tenantId, 'sub_resume1', { stripeCustomerId: 'cus_resume1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_resume1', subscriptionId: 'sub_resume1', status: 'active', customer: 'cus_resume1', priceId: 'price_growthtestresume' })
  const res = await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))
  assert(res.statusCode === 200)

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'active', 'a validated active event must resume a stripe_unpaid_terminal-suspended tenant')
  assert(config.commercial.suspension === null, 'the suspension marker must be cleared on resume')
  assert(config.commercial.plan === 'growth', 'plan must remain unchanged through suspend/resume')
}

async function testOtherSuspensionReasonIsNotAutoResumed() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtestnoautoresume'
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_no-autoresume-1'
  // Simulates a hypothetical future manual/admin/fraud suspension reason
  // via direct fixture setup -- no production writer of this value exists
  // in B.13; this test exists specifically to prove the reason-scoping is
  // real, not accidental.
  await seedCommercialTenantConfig(tenantId, {
    commercialStatus: 'suspended', plan: 'growth',
    suspension: { reason: 'manual_admin_review', suspendedAt: new Date().toISOString() },
  })
  await seedTenantWithSubscription(tenantId, 'sub_noautoresume1', { stripeCustomerId: 'cus_noautoresume1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_noautoresume1', subscriptionId: 'sub_noautoresume1', status: 'active', customer: 'cus_noautoresume1', priceId: 'price_growthtestnoautoresume' })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'suspended', 'a suspension for any OTHER reason must never be auto-resumed by the stripe_unpaid_terminal-specific recovery path')
  assert(config.commercial.suspension.reason === 'manual_admin_review')
}

async function testDuplicateRecoveryIsIdempotent() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtestduprecovery'
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_recover-dup-1'
  await seedCommercialTenantConfig(tenantId, {
    commercialStatus: 'suspended', plan: 'growth',
    suspension: { reason: 'stripe_unpaid_terminal', suspendedAt: new Date().toISOString() },
  })
  await seedTenantWithSubscription(tenantId, 'sub_recoverdup1', { stripeCustomerId: 'cus_recoverdup1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_recoverdup1', subscriptionId: 'sub_recoverdup1', status: 'active', customer: 'cus_recoverdup1', priceId: 'price_growthtestduprecovery' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  await invokeWebhookProperly(payload, signature)
  const configAfterFirst = await getTenantConfig(tenantId)
  await invokeWebhookProperly(payload, signature) // exact same event id, redelivered
  const configAfterSecond = await getTenantConfig(tenantId)

  assert(configAfterFirst.commercial.commercialStatus === 'active')
  assert(configAfterSecond.configVersion === configAfterFirst.configVersion, 'a duplicate recovery delivery must never reapply the transition')
}

// ===========================================================================
// Phase B.13 -- invoice.payment_failed (items 45-49).
// ===========================================================================

function buildInvoicePaymentFailedPayload({ eventId = 'evt_invfail1', subscriptionId, customer, created }) {
  const payload = {
    id: eventId, type: 'invoice.payment_failed', created: created ?? Math.floor(Date.now() / 1000),
    data: { object: { id: 'in_test1', subscription: subscriptionId, customer } },
  }
  return JSON.stringify(payload)
}

async function testInvoicePaymentFailedIsLedgerIdempotent() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_invfail-idempotent-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'past_due' })
  await seedTenantWithSubscription(tenantId, 'sub_invfailidem1', { stripeCustomerId: 'cus_invfailidem1' })

  const payload = buildInvoicePaymentFailedPayload({ eventId: 'evt_invfailidem1', subscriptionId: 'sub_invfailidem1', customer: 'cus_invfailidem1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const first = await invokeWebhookProperly(payload, signature)
  const second = await invokeWebhookProperly(payload, signature)
  assert(first.statusCode === 200 && second.statusCode === 200)
  const eventRecord = await getStripeEventRecord('evt_invfailidem1')
  assert(eventRecord.status === 'processed')
}

async function testInvoicePaymentFailedResolvesCorrectTenantServerSide() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_invfail-correct-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'past_due' })
  await seedTenantWithSubscription(tenantId, 'sub_invfailcorrect1', { stripeCustomerId: 'cus_invfailcorrect1' })

  const payload = buildInvoicePaymentFailedPayload({ eventId: 'evt_invfailcorrect1', subscriptionId: 'sub_invfailcorrect1', customer: 'cus_invfailcorrect1' })
  const res = await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))
  assert(res.statusCode === 200)
  const eventRecord = await getStripeEventRecord('evt_invfailcorrect1')
  assert(eventRecord.tenantId === tenantId, 'the tenant must be resolved server-side via the reverse index')
}

async function testInvoicePaymentFailedWrongCustomerRejected() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_invfail-wrongcust-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'past_due' })
  await seedTenantWithSubscription(tenantId, 'sub_invfailwrongcust1', { stripeCustomerId: 'cus_realinvfail1' })

  const payload = buildInvoicePaymentFailedPayload({ eventId: 'evt_invfailwrongcust1', subscriptionId: 'sub_invfailwrongcust1', customer: 'cus_attackerinvfail1' })
  const res = await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))
  assert(res.statusCode === 200, 'wrong customer must still be acknowledged (200) so Stripe does not retry forever')
  const eventRecord = await getStripeEventRecord('evt_invfailwrongcust1')
  assert(eventRecord.result === 'wrong_customer_or_subscription')
}

async function testInvoicePaymentFailedNeverSuspends() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_invfail-nosuspend-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'past_due' })
  await seedTenantWithSubscription(tenantId, 'sub_invfailnosusp1', { stripeCustomerId: 'cus_invfailnosusp1' })

  const payload = buildInvoicePaymentFailedPayload({ eventId: 'evt_invfailnosusp1', subscriptionId: 'sub_invfailnosusp1', customer: 'cus_invfailnosusp1' })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'past_due', 'invoice.payment_failed must never itself suspend -- only a validated unpaid subscription status does')
}

async function testInvoicePaymentFailedNeverResetsGraceClock() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_invfail-noreset-1'
  await seedCommercialTenantConfig(tenantId, { commercialStatus: 'past_due' })
  await seedTenantWithSubscription(tenantId, 'sub_invfailnoreset1', { stripeCustomerId: 'cus_invfailnoreset1' })
  const originalPastDueSince = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
  await updateBillingRecord(tenantId, { pastDueSince: originalPastDueSince }, { expectedVersion: (await getBillingRecord(tenantId)).version })

  const payload = buildInvoicePaymentFailedPayload({ eventId: 'evt_invfailnoreset1', subscriptionId: 'sub_invfailnoreset1', customer: 'cus_invfailnoreset1' })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const record = await getBillingRecord(tenantId)
  assert(record.pastDueSince === originalPastDueSince, 'invoice.payment_failed must never reset/alter pastDueSince')
}

// ===========================================================================
// Phase B.13 -- Security (items 50-51).
// ===========================================================================

async function testMetadataTenantIdCannotRedirectPastDueOrUnpaidTransition() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()

  const realTenantId = 't_meta-pastdue-real-1'
  const spoofedTenantId = 't_meta-pastdue-spoofed-1'
  await seedCommercialTenantConfig(realTenantId, { commercialStatus: 'active' })
  await seedTenantWithSubscription(realTenantId, 'sub_metapd1', { stripeCustomerId: 'cus_metapd1' })

  const payload = buildSubscriptionEventPayload({
    eventId: 'evt_metapd1', subscriptionId: 'sub_metapd1', status: 'past_due',
    customer: 'cus_metapd1', metadataTenantId: spoofedTenantId,
  })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const realConfig = await getTenantConfig(realTenantId)
  assert(realConfig.commercial.commercialStatus === 'past_due', 'the REAL, reverse-index-resolved tenant must receive the transition')
  const spoofedConfig = await getTenantConfig(spoofedTenantId)
  assert(spoofedConfig === null, 'the metadata-claimed tenant must never be touched')
}

async function testRecoveryNeverChangesPlanToEnterprise() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtestnoent'
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_recovery-noenterprise-1'
  await seedCommercialTenantConfig(tenantId, {
    commercialStatus: 'suspended', plan: 'growth',
    suspension: { reason: 'stripe_unpaid_terminal', suspendedAt: new Date().toISOString() },
  })
  await seedTenantWithSubscription(tenantId, 'sub_recoverynoent1', { stripeCustomerId: 'cus_recoverynoent1' })

  // Even if the incoming price somehow resolved to something unexpected,
  // the recovery path's own plan-match guard (trialLifecycle.js) refuses
  // any mismatch -- and no price in this codebase can ever resolve to
  // 'enterprise' at all (stripePriceMap.js's own SELF_SERVICE_PLAN_IDS gate).
  const payload = buildSubscriptionEventPayload({ eventId: 'evt_recoverynoent1', subscriptionId: 'sub_recoverynoent1', status: 'active', customer: 'cus_recoverynoent1', priceId: 'price_growthtestnoent' })
  await invokeWebhookProperly(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET }))

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.plan !== 'enterprise')
  assert(config.commercial.plan === 'growth', 'recovery must never change plan at all')
}

async function testPaidActiveTransitionCannotCreateAnotherFreeTrial() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  installConfigStore()
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthtestnotrial'
  installFakeStripeWithRealSignatureVerification()

  const tenantId = 't_paid-active-notrial1'
  const configBefore = await seedTrialingTenantConfig(tenantId)
  await seedTenantWithSubscription(tenantId, 'sub_notrial1', { stripeCustomerId: 'cus_notrial1' })

  const payload = buildSubscriptionEventPayload({ eventId: 'evt_notrial1', subscriptionId: 'sub_notrial1', status: 'active', customer: 'cus_notrial1', priceId: 'price_growthtestnotrial' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)

  const config = await getTenantConfig(tenantId)
  assert(config.commercial.commercialStatus === 'active')
  assert(JSON.stringify(config.trialEligibility) === JSON.stringify(configBefore.trialEligibility), 'the paid-active transition must never touch trialEligibility -- it cannot create/re-arm another free trial')
  assert(config.commercial.commercialStatus !== 'trial_pending_activation', 'the transition must never leave/re-enter a pending-activation trial state')
}

async function testOtherEventTypesAreIgnored() {
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification()
  const payload = JSON.stringify({ id: 'evt_other1', type: 'invoice.paid', created: Math.floor(Date.now() / 1000), data: { object: {} } })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)
}

async function testRawBodyIntegrityReqBodyNeverAccessed() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_rawbody1' })

  const tenantId = 't_rawbody-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_rawbody1' })
  await claimCustomerIndex('cus_rawbody1', tenantId)

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_rawbody1', customerId: 'cus_rawbody1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  // fakeWebhookRequest()'s `body` getter throws if ever accessed -- a
  // passing result here is a direct, mechanical proof the handler never
  // reads req.body anywhere in its execution path.
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200, `handler must succeed WITHOUT ever accessing req.body: ${JSON.stringify(res.body)}`)
}

async function testNoSubscriptionOrTrialSideEffects() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_notrial1' })

  const tenantId = 't_notrial-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_notrial1' })
  await claimCustomerIndex('cus_notrial1', tenantId)

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_notrial1', customerId: 'cus_notrial1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  await invokeWebhookProperly(payload, signature)

  const record = await getBillingRecord(tenantId)
  assert(record.stripeSubscriptionId === null, 'Setup completion must never create/record a Subscription')
  assert(record.subscriptionStatus === null, 'Setup completion must never set a subscriptionStatus')
  assert(!('commercialStatus' in record), 'the billing record has no commercialStatus field at all -- it cannot start a PRYOR trial by construction')
  assert(!('trialStartedAt' in record) && !('trialEndsAt' in record), 'no trial timestamp field exists on the billing record at all')
}

async function testEventLedgerRecordExistsAfterProcessing() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_ledger1' })

  const tenantId = 't_ledger-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_ledger1' })
  await claimCustomerIndex('cus_ledger1', tenantId)

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_ledger1', customerId: 'cus_ledger1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  await invokeWebhookProperly(payload, signature)

  const eventRecord = await getStripeEventRecord('evt_ledger1')
  assert(eventRecord.status === 'processed')
}

// ===========================================================================
// Phase B.11 pre-commit correction (Part 6) -- hardened Setup completion
// validation: every SetupIntent fact is verified before anything is
// persisted, exactly per Stripe's own documented contract.
// ===========================================================================

// Phase B.11 final pre-commit correction (webhook delivery semantics, Part
// 8) -- Stripe's own documented Checkout Session contract states that
// `status: 'complete'` (what drives this event) can fire while "payment
// processing may still be in progress." A still-progressable SetupIntent
// status is therefore NOT a deterministic dead end and must be retried
// (via Stripe's own webhook redelivery of this same event), never
// permanently acknowledged as if it were a final rejection -- that would
// silently strand a signup whose card setup goes on to legitimately
// succeed moments later.
async function testNonSucceededSetupIntentStatusIsRetryableNotTerminal() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_pending1', setupIntentOverrides: { status: 'requires_action' } })

  const tenantId = 't_pending-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_pending1' })
  await claimCustomerIndex('cus_pending1', tenantId)

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_pending1', customerId: 'cus_pending1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode >= 500 && res.statusCode < 600, `a still-progressable SetupIntent status must be retryable (5xx), got ${res.statusCode}`)

  const record = await getBillingRecord(tenantId)
  assert(record.defaultPaymentMethodId === null, 'a SetupIntent that has not succeeded must never result in a persisted payment method')
  const eventRecord = await getStripeEventRecord('evt_pending1')
  assert(eventRecord.status === 'failed', 'a still-progressable status must leave the event retryable (failed), never permanently processed')
}

// A genuinely terminal SetupIntent status (canceled can never later become
// succeeded) IS a deterministic dead end -- unlike 'requires_action' etc.,
// retrying this same event can never produce a different outcome, so it is
// correctly acknowledged as processed/rejected rather than retried forever.
async function testCanceledSetupIntentIsTerminalNotRetried() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_canceled1', setupIntentOverrides: { status: 'canceled' } })

  const tenantId = 't_canceled-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_canceled1' })
  await claimCustomerIndex('cus_canceled1', tenantId)

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_canceled1', customerId: 'cus_canceled1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200, 'a canceled SetupIntent is a deterministic terminal outcome and must be acknowledged, not retried')

  const record = await getBillingRecord(tenantId)
  assert(record.defaultPaymentMethodId === null)
  const eventRecord = await getStripeEventRecord('evt_canceled1')
  assert(eventRecord.status === 'processed' && eventRecord.result === 'setup_intent_canceled')
}

// ===========================================================================
// Phase B.11 final pre-commit correction -- webhook delivery-semantics
// reliability contract: a verified webhook must NEVER receive a success
// acknowledgement merely because another worker currently owns the event,
// or because a transient provider/storage failure occurred before the
// event was actually applied.
// ===========================================================================

async function testActiveProcessingLeaseReturnsRetryableNotFalseSuccess() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_lease1' })

  const tenantId = 't_lease-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_lease1' })
  await claimCustomerIndex('cus_lease1', tenantId)

  const eventId = 'evt_lease1'
  // Pre-seed the ledger exactly as claimStripeEvent() would leave it for a
  // delivery another worker currently owns -- an active, unexpired lease
  // held by a DIFFERENT processingToken.
  const claimedRecord = {
    eventId, eventType: 'checkout.session.completed', stripeCreatedAt: Math.floor(Date.now() / 1000),
    providerObjectId: 'cus_lease1', tenantId, status: 'claimed', processingToken: 'other-worker-token',
    claimedAtMs: Date.now(), leaseExpiresAtMs: Date.now() + 60000, processedAtMs: null, failedAtMs: null,
    attemptCount: 1, result: null,
  }
  await redis.set(`stripe_event:v1:${eventId}`, JSON.stringify(claimedRecord))

  const payload = buildCheckoutSessionCompletedPayload({ eventId, customerId: 'cus_lease1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode >= 500 && res.statusCode < 600, `an active lease held by another worker must return a retryable non-2xx, not a false 200, got ${res.statusCode}`)

  const eventRecord = await getStripeEventRecord(eventId)
  assert(eventRecord.status === 'claimed' && eventRecord.processingToken === 'other-worker-token', 'a losing delivery must never mutate the ledger or steal the active owner\'s lease')

  const record = await getBillingRecord(tenantId)
  assert(record.defaultPaymentMethodId === null, 'a losing delivery must never itself apply the projection')
}

async function testSetupIntentRetrievalTransientFailureIsRetryable() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_timeout1', retrieveError: new Error('ETIMEDOUT: request to Stripe timed out') })

  const tenantId = 't_timeout-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_timeout1' })
  await claimCustomerIndex('cus_timeout1', tenantId)

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_timeout1', customerId: 'cus_timeout1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode >= 500 && res.statusCode < 600, `a SetupIntent retrieval timeout must be retryable, got ${res.statusCode}`)

  const eventRecord = await getStripeEventRecord('evt_timeout1')
  assert(eventRecord.status === 'failed', 'a transient retrieval failure must never be marked processed')
  const record = await getBillingRecord(tenantId)
  assert(record.defaultPaymentMethodId === null)
}

async function testStripeApiServerErrorDuringRetrievalIsRetryable() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  const stripe5xx = Object.assign(new Error('An error occurred with our connection to Stripe'), { statusCode: 500, type: 'StripeAPIError' })
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_5xx1', retrieveError: stripe5xx })

  const tenantId = 't_5xx-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_5xx1' })
  await claimCustomerIndex('cus_5xx1', tenantId)

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_5xx1', customerId: 'cus_5xx1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode >= 500 && res.statusCode < 600, `a Stripe 5xx during retrieval must be retryable, got ${res.statusCode}`)

  const eventRecord = await getStripeEventRecord('evt_5xx1')
  assert(eventRecord.status === 'failed')
}

async function testBillingStoreOutageDuringProjectionIsRetryable() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_outage1' })

  const tenantId = 't_outage-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_outage1' })
  await claimCustomerIndex('cus_outage1', tenantId)

  // Simulate a genuine transient storage outage exactly where the handler
  // reads the billing record to apply the projection -- AFTER the event has
  // already been claimed. getBillingRecord()/updateBillingRecord() wrap
  // this into BillingStoreUnavailableError automatically.
  redis.hget = async () => { throw new Error('simulated Redis outage') }

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_outage1', customerId: 'cus_outage1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode >= 500 && res.statusCode < 600, `a transient billing-store outage must return a retryable 5xx, got ${res.statusCode}`)

  const eventRecord = await getStripeEventRecord('evt_outage1')
  assert(eventRecord.status === 'failed', 'a transient storage outage must mark the event failed (retryable), never processed')
}

// A CAS conflict is not automatically a failure -- if the CURRENT record
// (whatever raced this write) already carries the EXACT SAME payment
// method this delivery was trying to write, the desired end state is
// already satisfied and must be acknowledged as such, not endlessly
// retried against a fact that will never change.
async function testCasConflictWithDesiredStateAlreadyAppliedIsIdempotentlySatisfied() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_cas1' })

  const tenantId = 't_cas-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_cas1' })
  await claimCustomerIndex('cus_cas1', tenantId)

  const originalEval = redis.eval.bind(redis)
  let injected = false
  redis.eval = async (script, keys, args) => {
    if (!injected && script.includes('SCRIPT: BILLING_CAS')) {
      injected = true
      // Simulate a CONCURRENT delivery/mutation that already wrote the
      // EXACT same payment-method fact between this handler's read and its
      // own write attempt.
      const [key] = keys
      const [field] = args
      const rawRecord = await redis.hget(key, field)
      const rec = JSON.parse(rawRecord)
      rec.version += 1
      rec.defaultPaymentMethodId = 'pm_testsavedcard'
      await redis.hset(key, { [field]: JSON.stringify(rec) })
    }
    return originalEval(script, keys, args)
  }

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_cas1', customerId: 'cus_cas1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200, `a CAS conflict where the desired state is already applied must be idempotently satisfied (200), got ${res.statusCode}: ${JSON.stringify(res.body)}`)

  const eventRecord = await getStripeEventRecord('evt_cas1')
  assert(eventRecord.status === 'processed' && eventRecord.result === 'setup_completed_already_applied', 'must be marked processed with a result distinguishing it from a fresh application, never a silent identical result')
}

// A CAS conflict where the CURRENT record does NOT already reflect this
// delivery's payment method (some OTHER concurrent legitimate mutation won
// the race) must never be treated as a false success -- it is genuinely
// retryable.
async function testCasConflictWithDifferentConcurrentStateIsRetryable() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_cas2' })

  const tenantId = 't_cas2-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_cas2' })
  await claimCustomerIndex('cus_cas2', tenantId)

  const originalEval = redis.eval.bind(redis)
  let injected = false
  redis.eval = async (script, keys, args) => {
    if (!injected && script.includes('SCRIPT: BILLING_CAS')) {
      injected = true
      const [key] = keys
      const [field] = args
      const rawRecord = await redis.hget(key, field)
      const rec = JSON.parse(rawRecord)
      rec.version += 1
      // A DIFFERENT concurrent write, not the fact this delivery wanted.
      rec.defaultPaymentMethodId = 'pm_completelydifferentcard'
      await redis.hset(key, { [field]: JSON.stringify(rec) })
    }
    return originalEval(script, keys, args)
  }

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_cas2', customerId: 'cus_cas2' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode >= 500 && res.statusCode < 600, `a CAS conflict against a DIFFERENT concurrent state must be retryable, not a false success, got ${res.statusCode}`)

  const eventRecord = await getStripeEventRecord('evt_cas2')
  assert(eventRecord.status === 'failed')

  const record = await getBillingRecord(tenantId)
  assert(record.defaultPaymentMethodId === 'pm_completelydifferentcard', 'the genuinely concurrent write must not be clobbered by this delivery\'s own failed retry')
}

// Phase B.11 final pre-commit correction (Part 6) -- a missing billing
// record for a tenantId the reverse index resolved to is a structural
// anomaly (the record is always created BEFORE the index is claimed -- see
// billingCustomer.js's ensureStripeCustomerForTenant()). It must never be
// silently acknowledged as a false success.
async function testMissingBillingRecordIsNeverSilentlyAcknowledged() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_norecord1' })

  const tenantId = 't_norecord-tenant-1'
  // Deliberately claim the reverse index WITHOUT ever creating a billing
  // record -- an anomaly that should be structurally impossible via the
  // real code paths, but must still fail closed if it somehow occurs.
  await claimCustomerIndex('cus_norecord1', tenantId)

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_norecord1', customerId: 'cus_norecord1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode >= 500 && res.statusCode < 600, `a missing billing record must never be silently acknowledged as success, got ${res.statusCode}`)

  const eventRecord = await getStripeEventRecord('evt_norecord1')
  assert(eventRecord.status === 'failed', 'this anomaly must leave the event retryable, never processed')
}

async function testSetupIntentCustomerMismatchIsNotPersisted() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  // The SetupIntent itself claims a DIFFERENT customer than the Checkout
  // Session it supposedly came from -- a structural anomaly that must be
  // treated as suspicious, never trusted.
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_mismatch1', setupIntentOverrides: { customer: 'cus_totally_different' } })

  const tenantId = 't_mismatch-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_mismatch1' })
  await claimCustomerIndex('cus_mismatch1', tenantId)

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_mismatch1', customerId: 'cus_mismatch1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)

  const record = await getBillingRecord(tenantId)
  assert(record.defaultPaymentMethodId === null, 'a SetupIntent/Session customer mismatch must never result in a persisted payment method')
}

async function testMissingPaymentMethodOnSucceededIntentIsNotPersisted() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  installFakeStripeWithRealSignatureVerification({ customerId: 'cus_nopm1', setupIntentOverrides: { payment_method: null } })

  const tenantId = 't_nopm-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_nopm1' })
  await claimCustomerIndex('cus_nopm1', tenantId)

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_nopm1', customerId: 'cus_nopm1' })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)

  const record = await getBillingRecord(tenantId)
  assert(record.defaultPaymentMethodId === null, 'a succeeded SetupIntent with no payment_method must never persist a null-shaped success')
}

async function testMissingSetupIntentOnSessionIsNotPersisted() {
  const redis = fakeBillingRedis()
  setBillingClient(() => redis)
  process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET
  const { setupIntentRetrieveCalls } = installFakeStripeWithRealSignatureVerification({ customerId: 'cus_nosi1' })

  const tenantId = 't_nosi-tenant-1'
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_nosi1' })
  await claimCustomerIndex('cus_nosi1', tenantId)

  const payload = buildCheckoutSessionCompletedPayload({ eventId: 'evt_nosi1', customerId: 'cus_nosi1', setupIntentId: null })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: TEST_WEBHOOK_SECRET })
  const res = await invokeWebhookProperly(payload, signature)
  assert(res.statusCode === 200)
  assert(setupIntentRetrieveCalls.length === 0, 'no SetupIntent retrieval should even be attempted when the session carries none')

  const record = await getBillingRecord(tenantId)
  assert(record.defaultPaymentMethodId === null)
}

const tests = [
  ['a valid signature applies the saved payment method to the correct tenant', testValidSignatureAndSetupCompletionAppliesPaymentMethod],
  ['a forged signature is rejected', testForgedSignatureIsRejected],
  ['a tampered payload with an otherwise-valid signature is rejected', testTamperedPayloadWithOtherwiseValidSignatureIsRejected],
  ['a missing signature header is rejected', testMissingSignatureHeaderIsRejected],
  ['an unrecognized customer/tenant mapping is denied (acknowledged, not processed)', testWrongCustomerTenantMappingIsDenied],
  ['a metadata tenantId mismatch never overrides the reverse index', testMetadataMismatchDoesNotOverrideReverseIndex],
  ['a duplicate event delivery is idempotent', testDuplicateEventIsIdempotent],
  ['a non-setup-mode session is acknowledged but ignored', testNonSetupModeSessionIsIgnored],
  ['event types other than checkout.session.completed are ignored', testOtherEventTypesAreIgnored],
  ['req.body is never accessed anywhere in the handler (raw-body integrity)', testRawBodyIntegrityReqBodyNeverAccessed],
  ['no Subscription/trial side effects occur', testNoSubscriptionOrTrialSideEffects],
  ['the event ledger records the processed event', testEventLedgerRecordExistsAfterProcessing],
  ['a non-succeeded SetupIntent status is retryable, not terminal', testNonSucceededSetupIntentStatusIsRetryableNotTerminal],
  ['a canceled SetupIntent is terminal and not retried', testCanceledSetupIntentIsTerminalNotRetried],
  ['a SetupIntent/Session customer mismatch is not persisted', testSetupIntentCustomerMismatchIsNotPersisted],
  ['a succeeded SetupIntent with no payment_method is not persisted', testMissingPaymentMethodOnSucceededIntentIsNotPersisted],
  ['a session with no setup_intent at all is not persisted', testMissingSetupIntentOnSessionIsNotPersisted],
  ['an active processing lease returns retryable, not a false success', testActiveProcessingLeaseReturnsRetryableNotFalseSuccess],
  ['a SetupIntent retrieval timeout is retryable', testSetupIntentRetrievalTransientFailureIsRetryable],
  ['a Stripe 5xx during retrieval is retryable', testStripeApiServerErrorDuringRetrievalIsRetryable],
  ['a transient billing-store outage during projection is retryable', testBillingStoreOutageDuringProjectionIsRetryable],
  ['a CAS conflict with the desired state already applied is idempotently satisfied', testCasConflictWithDesiredStateAlreadyAppliedIsIdempotentlySatisfied],
  ['a CAS conflict against a different concurrent state is retryable', testCasConflictWithDifferentConcurrentStateIsRetryable],
  ['a missing billing record is never silently acknowledged', testMissingBillingRecordIsNeverSilentlyAcknowledged],
  // Phase B.12 -- customer.subscription.updated/deleted minimal projection.
  ['customer.subscription.updated projects an active status', testSubscriptionUpdatedProjectsActiveStatus],
  ['customer.subscription.deleted always projects canceled', testSubscriptionDeletedAlwaysProjectsCanceled],
  ['a trialing subscription event never touches/introduces a PRYOR trial field', testTrialingSubscriptionEventNeverTouchesTenantConfig],
  ['past_due/unpaid/canceled projection introduces no B.13 enforcement fields', testPastDueUnpaidCanceledProjectionIntroducesNoEnforcementFields],
  ['a duplicate subscription webhook delivery is idempotent', testDuplicateSubscriptionWebhookDeliveryIsIdempotent],
  ['an unrecognized subscription is acknowledged, not processed', testUnrecognizedSubscriptionIsAcknowledgedNotProcessed],
  // Phase B.12 (Decision 2) -- the minimal canonical paid-active transition.
  ['a trialing webhook does not mutate the PRYOR trial', testTrialingWebhookDoesNotMutatePryorTrial],
  ['a valid active webhook transitions to paid-active exactly once', testValidActiveWebhookTransitionsToPaidActiveExactlyOnce],
  ['a duplicate active event is idempotent', testDuplicateActiveEventIsIdempotent],
  ['a stale active event is ignored appropriately', testStaleActiveEventIsIgnoredAppropriately],
  ['a subscription-id mismatch against the billing record rejects the active transition', testWrongSubscriptionReverseIndexRejectsActiveTransition],
  ['a customer mismatch against the billing record rejects the active transition', testWrongCustomerRejectsActiveTransition],
  ['an unmapped price rejects the active transition', testWrongPriceMappingRejectsActiveTransition],
  ['the paid-active transition can never grant Enterprise', testPaidActiveTransitionCannotGrantEnterprise],
  ['a forged metadata tenantId cannot redirect the paid-active transition', testForgedMetadataTenantIdCannotRedirectPaidActiveState],
  ['the paid-active transition can never create another free trial', testPaidActiveTransitionCannotCreateAnotherFreeTrial],
  // Phase B.13 -- Cancellation model.
  ['cancel_at_period_end does not remove access', testCancelAtPeriodEndDoesNotRemoveAccess],
  ['cancellation requestedAt is anchored to the first accepted event', testCancellationRequestedAtAnchoredToFirstAcceptedEvent],
  ['a repeated cancel event does not reset requestedAt', testRepeatedCancelEventDoesNotResetRequestedAt],
  ['cancellation effectiveAt equals the validated current_period_end', testCancellationEffectiveAtEqualsCurrentPeriodEnd],
  ['reactivation clears the cancellation intent', testReactivationClearsCancellation],
  ['an actual deleted event transitions to canceled', testActualDeletedEventTransitionsToCanceled],
  ['canceled preserves plan and data -- no destructive deletion', testCanceledPreservesPlanAndData],
  // Phase B.13 -- Delinquency: past_due.
  ['the first past_due event sets commercialStatus and pastDueSince from event.created', testFirstPastDueSetsCommercialStatusAndPastDueSince],
  ['a duplicate past_due event does not reset the grace clock', testDuplicatePastDueDoesNotResetClock],
  ['a later past_due event does not extend the grace clock', testLaterPastDueDoesNotExtendClock],
  ['a stale past_due event is ignored', testStalePastDueIgnored],
  ['past_due retains normal plan entitlements', testPastDueRetainsNormalPlanEntitlements],
  ['past_due does not suspend', testPastDueDoesNotSuspend],
  // Phase B.13 -- Delinquency: unpaid (terminal suspension).
  ['a validated unpaid event suspends with the exact reason/timestamp shape', testValidatedUnpaidSuspendsWithExactShape],
  ['a duplicate unpaid event is idempotent', testDuplicateUnpaidEventIsIdempotent],
  ['a stale unpaid event is ignored', testStaleUnpaidIgnored],
  ['a wrong subscription id rejects the unpaid suspension', testWrongSubscriptionRejectedForUnpaid],
  ['a wrong customer id rejects the unpaid suspension', testWrongCustomerRejectedForUnpaid],
  ['unpaid preserves plan and trial history', testUnpaidPreservesPlanAndTrialHistory],
  ['unpaid never auto-cancels', testUnpaidNeverAutoCancels],
  // Phase B.13 -- paused (Amendment 3: never canonical suspension authority).
  ['paused updates the billing projection only', testPausedUpdatesBillingProjectionOnly],
  ['paused does not create canonical suspension', testPausedDoesNotCreateCanonicalSuspension],
  // Phase B.13 -- Recovery.
  ['a validated active event clears pastDueSince', testActiveClearsPastDueSince],
  ['a validated active event resumes and clears a stripe_unpaid_terminal suspension', testActiveResumesAndClearsStripeUnpaidTerminalSuspension],
  ['a suspension for any other reason is never auto-resumed', testOtherSuspensionReasonIsNotAutoResumed],
  ['a duplicate recovery delivery is idempotent', testDuplicateRecoveryIsIdempotent],
  // Phase B.13 -- invoice.payment_failed (audit/notification only).
  ['invoice.payment_failed is ledger-idempotent', testInvoicePaymentFailedIsLedgerIdempotent],
  ['invoice.payment_failed resolves the correct tenant server-side', testInvoicePaymentFailedResolvesCorrectTenantServerSide],
  ['invoice.payment_failed with a wrong customer is rejected', testInvoicePaymentFailedWrongCustomerRejected],
  ['invoice.payment_failed never suspends', testInvoicePaymentFailedNeverSuspends],
  ['invoice.payment_failed never resets the grace clock', testInvoicePaymentFailedNeverResetsGraceClock],
  // Phase B.13 -- Security.
  ['a forged metadata tenantId cannot redirect a past_due/unpaid transition', testMetadataTenantIdCannotRedirectPastDueOrUnpaidTransition],
  ['recovery never changes plan, and can never result in Enterprise', testRecoveryNeverChangesPlanToEnterprise],
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
