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
  createBillingRecord, getBillingRecord, claimCustomerIndex, getStripeEventRecord,
} from '../dashboard/api/_lib/billingStore.js'
import { _setStripeClientForTests, _resetStripeClientForTests } from '../dashboard/api/_lib/stripeClient.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'

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
    resetBillingClient(); _resetStripeClientForTests(); _resetLimiterFactoryForTests()
    delete process.env.STRIPE_WEBHOOK_SECRET
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
