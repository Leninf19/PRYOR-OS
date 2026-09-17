// Phase B.11 -- regression tests for dashboard/api/_lib/billingCustomer.js
// (ensureStripeCustomerForTenant()/createSetupCheckoutSession()). No real
// Stripe API call, no real Redis -- a fake Stripe client (with idempotency-
// key-aware customers.create()) and a fake billing-store Redis client are
// injected via each module's own test-injection seam.
//
// Run directly: node tests/test_billing_customer.js

import {
  ensureStripeCustomerForTenant, createSetupCheckoutSession, BillingUrlNotConfiguredError, BillingSetupRecoveryRequiredError,
} from '../dashboard/api/_lib/billingCustomer.js'
import { _setStripeClientForTests, _resetStripeClientForTests } from '../dashboard/api/_lib/stripeClient.js'
import {
  _setRedisClientForTests, _resetRedisClientForTests, getTenantIdForCustomer, BillingIndexCollisionError,
  claimCustomerIndex, getBillingRecord, updateBillingRecord, createBillingRecord,
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
    delete process.env.DASHBOARD_BASE_URL
    delete process.env.VERCEL_URL
  }
}

// A fake Stripe client that faithfully emulates idempotency-key
// deduplication for customers.create() (concurrent/retried calls with the
// SAME idempotencyKey get back the exact same object, never a new one --
// exactly what real Stripe guarantees) and records every call it receives
// for assertion.
function fakeStripe() {
  const byIdempotencyKey = new Map()
  let counter = 0
  const createCalls = []
  const sessionCreateCalls = []
  return {
    customers: {
      create: async (params, opts) => {
        createCalls.push({ params, opts })
        const key = opts?.idempotencyKey
        if (key && byIdempotencyKey.has(key)) return byIdempotencyKey.get(key)
        counter += 1
        const customer = { id: `cus_test${counter}`, email: params.email, metadata: params.metadata ?? {} }
        if (key) byIdempotencyKey.set(key, customer)
        return customer
      },
    },
    checkout: {
      sessions: {
        create: async (params) => {
          sessionCreateCalls.push(params)
          counter += 1
          return { id: `cs_test${counter}`, url: `https://checkout.stripe.com/test/session_${counter}`, ...params }
        },
      },
    },
    _createCalls: createCalls,
    _sessionCreateCalls: sessionCreateCalls,
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

function install() {
  const stripe = fakeStripe()
  const redis = fakeBillingRedis()
  _setStripeClientForTests(() => stripe)
  _setRedisClientForTests(() => redis)
  process.env.DASHBOARD_BASE_URL = 'https://app.example.com'
  return { stripe, redis }
}

const TENANT_A = 't_alpha'
const TENANT_B = 't_beta'

async function testFirstSetupCreatesCustomer() {
  const { stripe } = install()
  const { customerId, created } = await ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com')
  assert(created === true && typeof customerId === 'string' && customerId.startsWith('cus_'))
  assert(stripe._createCalls.length === 1)
  assert((await getTenantIdForCustomer(customerId)) === TENANT_A, 'the reverse index must bind the new Customer to this tenant')
}

async function testRetryReusesCustomer() {
  const { stripe } = install()
  const first = await ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com')
  const second = await ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com')
  assert(first.customerId === second.customerId, 'a retry for the same tenant must reuse the SAME Customer, never create a second one')
  assert(second.created === false, 'the second call must recognize the Customer already exists')
  assert(stripe._createCalls.length === 1, 'customers.create() must be called exactly once across both attempts')
}

async function testConcurrentInitializationCannotBindDuplicates() {
  const { stripe } = install()
  const [a, b] = await Promise.all([
    ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com'),
    ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com'),
  ])
  assert(a.customerId === b.customerId, 'two concurrent calls for the same tenant must resolve to exactly one Customer')
  // Stripe's own idempotency key guarantees exactly one real customer
  // object is minted even though customers.create() was called twice.
  const uniqueIds = new Set(stripe._createCalls.map(c => c.opts?.idempotencyKey))
  assert(uniqueIds.size === 1, 'both concurrent calls must use the SAME deterministic idempotency key for this tenant')
}

async function testCustomerCollisionWithAnotherTenantFailsClosed() {
  install()
  await ensureStripeCustomerForTenant(TENANT_A, 'owner-a@example.com')
  // Simulate a corrupted/adversarial state where tenant B's billing record
  // somehow already points at tenant A's Customer id -- claimCustomerIndex
  // must refuse this, never silently reassign ownership. We exercise this
  // indirectly by manually claiming the same Customer id for tenant B via
  // the store's own primitive and confirming it is rejected.
  const recordA = await getBillingRecord(TENANT_A)
  let threw = null
  try { await claimCustomerIndex(recordA.stripeCustomerId, TENANT_B) } catch (err) { threw = err }
  assert(threw instanceof BillingIndexCollisionError, 'a different tenant must never be able to claim an already-bound Customer id')
}

async function testIdempotencyKeyIsDeterministicPerTenantNeverReusedAcrossTenants() {
  const { stripe } = install()
  await ensureStripeCustomerForTenant(TENANT_A, 'owner-a@example.com')
  await ensureStripeCustomerForTenant(TENANT_B, 'owner-b@example.com')
  const keys = stripe._createCalls.map(c => c.opts?.idempotencyKey)
  assert(new Set(keys).size === 2, 'different tenants must never share the same idempotency key')
  assert(keys.every(k => typeof k === 'string' && k.length > 0))
}

async function testCheckoutSessionModeIsExactlySetup() {
  const { stripe } = install()
  const { customerId } = await ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com')
  await createSetupCheckoutSession({ tenantId: TENANT_A, customerId, plan: 'growth' })
  const call = stripe._sessionCreateCalls[0]
  assert(call.mode === 'setup', 'the Checkout Session must be created in mode: setup, never subscription/payment')
}

async function testNoSubscriptionOrChargeParametersArePassed() {
  const { stripe } = install()
  const { customerId } = await ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com')
  await createSetupCheckoutSession({ tenantId: TENANT_A, customerId, plan: 'core' })
  const call = stripe._sessionCreateCalls[0]
  assert(call.line_items === undefined, 'setup-mode Checkout must never include line_items (that would imply a charge)')
  assert(call.subscription_data === undefined, 'setup-mode Checkout must never include subscription_data')
  assert(call.payment_intent_data === undefined, 'setup-mode Checkout must never include payment_intent_data (that would imply an immediate charge)')
}

async function testServerControlledSuccessAndCancelUrls() {
  const { stripe } = install()
  const { customerId } = await ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com')
  await createSetupCheckoutSession({ tenantId: TENANT_A, customerId, plan: 'growth' })
  const call = stripe._sessionCreateCalls[0]
  assert(call.success_url.startsWith('https://app.example.com/'), 'success_url must be built from the server-configured DASHBOARD_BASE_URL')
  assert(call.cancel_url.startsWith('https://app.example.com/'), 'cancel_url must be built from the server-configured DASHBOARD_BASE_URL')
}

async function testNoArbitraryRedirectInjection() {
  const { stripe } = install()
  const { customerId } = await ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com')
  // createSetupCheckoutSession()'s own signature accepts only
  // {tenantId, customerId, plan} -- there is no successUrl/cancelUrl
  // parameter at all for a caller to inject, even if a naive future caller
  // tried to pass one through from a request body.
  await createSetupCheckoutSession({ tenantId: TENANT_A, customerId, plan: 'growth', successUrl: 'https://evil.example.com/steal', cancelUrl: 'https://evil.example.com/steal' })
  const call = stripe._sessionCreateCalls[0]
  assert(call.success_url.startsWith('https://app.example.com/'), 'an injected successUrl field must be silently ignored -- only the server-built URL is ever used')
  assert(call.cancel_url.startsWith('https://app.example.com/'), 'an injected cancelUrl field must be silently ignored')
  assert(!JSON.stringify(call).includes('evil.example.com'), 'the attacker-supplied domain must never appear anywhere in the Checkout Session params')
}

async function testCustomerAssociationIsCorrect() {
  const { stripe } = install()
  const { customerId } = await ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com')
  await createSetupCheckoutSession({ tenantId: TENANT_A, customerId, plan: 'growth' })
  const call = stripe._sessionCreateCalls[0]
  assert(call.customer === customerId, 'the Checkout Session must be created against the tenant\'s own resolved Customer id')
}

async function testMissingBaseUrlFailsClosed() {
  install()
  delete process.env.DASHBOARD_BASE_URL
  delete process.env.VERCEL_URL
  const { customerId } = await ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com')
  let threw = null
  try { await createSetupCheckoutSession({ tenantId: TENANT_A, customerId, plan: 'growth' }) } catch (err) { threw = err }
  assert(threw instanceof BillingUrlNotConfiguredError, 'with no DASHBOARD_BASE_URL/VERCEL_URL configured, checkout creation must fail closed, never fall back to a client-supplied or guessed URL')
}

// ===========================================================================
// Phase B.11 pre-commit correction (Part 4) -- durable Customer-creation
// operation state, surviving beyond Stripe's own ~24h idempotency-key
// retention.
// ===========================================================================

async function testRetryWithinIdempotencyWindowReusesSameOperation() {
  const { stripe } = install()
  // Simulate a crash: manually seed a 'pending' operation (as if a prior
  // call had started one) without ever calling ensureStripeCustomerForTenant
  // to completion, then retry -- the retry must reuse the SAME operationId/
  // idempotency key, not mint a new one.
  const record = await createBillingRecord(TENANT_A, {
    customerCreationOperation: { operationId: 'preexisting-op-1', startedAt: new Date().toISOString(), state: 'pending' },
  })
  const { customerId } = await ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com')
  assert(typeof customerId === 'string')
  assert(stripe._createCalls[0].opts.idempotencyKey.endsWith(':preexisting-op-1'), 'a retry within the recovery window must reuse the EXACT pre-existing operationId, never mint a fresh one')
  assert(record.version === 1) // sanity: fixture setup
}

async function testStripeSuccessThenSimulatedCrashRemainsRecoverable() {
  const { stripe } = install()
  // First call succeeds at Stripe but "crashes" before this codebase ever
  // records stripeCustomerId -- simulated by manually reverting the
  // billing record's stripeCustomerId back to null after a real call
  // completes, while leaving the operation as 'completed' would normally
  // be -- instead we simulate the crash BEFORE completion is recorded by
  // directly constructing the pending-operation state and letting Stripe's
  // own idempotency map return the same object on retry.
  const first = await ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com')
  const opId = (await getBillingRecord(TENANT_A)).customerCreationOperation.operationId
  // Revert the record to look like the write-after-Stripe-success step
  // never completed (customerCreationOperation still 'pending', no
  // stripeCustomerId) -- the exact crash window this correction targets.
  const before = await getBillingRecord(TENANT_A)
  await updateBillingRecord(TENANT_A, {
    stripeCustomerId: null,
    customerCreationOperation: { operationId: opId, startedAt: before.customerCreationOperation.startedAt, state: 'pending' },
  }, { expectedVersion: before.version })

  const retry = await ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com')
  assert(retry.customerId === first.customerId, 'a retry after a simulated crash (within the window) must recover the SAME Customer Stripe already created, never a duplicate')
  const idempotencyKeys = new Set(stripe._createCalls.map(c => c.opts.idempotencyKey))
  assert(idempotencyKeys.size === 1, 'the retry must reuse the identical idempotency key')
}

async function testAmbiguousOperationPastRecoveryWindowFailsClosed() {
  install()
  // An operation that started 21 hours ago (past the 20h recovery window)
  // and never resolved -- must fail closed, never attempt a fresh Stripe
  // call that could create a duplicate Customer.
  const staleStartedAt = new Date(Date.now() - 21 * 60 * 60 * 1000).toISOString()
  await createBillingRecord(TENANT_A, {
    customerCreationOperation: { operationId: 'stale-op-1', startedAt: staleStartedAt, state: 'pending' },
  })
  let threw = null
  try { await ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com') } catch (err) { threw = err }
  assert(threw instanceof BillingSetupRecoveryRequiredError, 'a pending operation older than the recovery window must fail closed, never silently retry Stripe with a possibly-expired idempotency key')
  const record = await getBillingRecord(TENANT_A)
  assert(record.customerCreationOperation.state === 'ambiguous', 'the operation must be marked ambiguous so the SAME determination is made consistently on every subsequent call')
}

async function testAlreadyAmbiguousOperationStaysFailedClosedOnRetry() {
  install()
  await createBillingRecord(TENANT_A, {
    customerCreationOperation: { operationId: 'ambiguous-op-1', startedAt: new Date().toISOString(), state: 'ambiguous' },
  })
  let threw = null
  try { await ensureStripeCustomerForTenant(TENANT_A, 'owner@example.com') } catch (err) { threw = err }
  assert(threw instanceof BillingSetupRecoveryRequiredError, 'an already-ambiguous operation must never be silently retried')
}

async function testBrowserCannotChooseOperationIdOrIdempotencyKey() {
  // ensureStripeCustomerForTenant()'s signature accepts only (tenantId,
  // email) -- there is no operationId/idempotencyKey parameter at all for
  // any caller (including a future HTTP handler naively spreading
  // req.body) to influence.
  assert(ensureStripeCustomerForTenant.length <= 2, 'ensureStripeCustomerForTenant must accept no operation-identity parameter from any caller')
}

const tests = [
  ['first setup creates a Stripe Customer', testFirstSetupCreatesCustomer],
  ['a retry reuses the same Customer', testRetryReusesCustomer],
  ['concurrent initialization cannot bind duplicate Customers', testConcurrentInitializationCannotBindDuplicates],
  ['a Customer collision with another tenant fails closed', testCustomerCollisionWithAnotherTenantFailsClosed],
  ['the idempotency key is deterministic per tenant, never reused across tenants', testIdempotencyKeyIsDeterministicPerTenantNeverReusedAcrossTenants],
  ['the Checkout Session mode is exactly setup', testCheckoutSessionModeIsExactlySetup],
  ['no subscription/charge parameters are ever passed', testNoSubscriptionOrChargeParametersArePassed],
  ['success/cancel URLs are server-controlled', testServerControlledSuccessAndCancelUrls],
  ['no arbitrary redirect can be injected', testNoArbitraryRedirectInjection],
  ['the Customer association on the session is correct', testCustomerAssociationIsCorrect],
  ['a missing base URL fails closed rather than guessing', testMissingBaseUrlFailsClosed],
  ['a retry within the idempotency window reuses the same operation', testRetryWithinIdempotencyWindowReusesSameOperation],
  ['Stripe success + simulated local crash remains recoverable', testStripeSuccessThenSimulatedCrashRemainsRecoverable],
  ['an operation past the recovery window fails closed, never retries Stripe', testAmbiguousOperationPastRecoveryWindowFailsClosed],
  ['an already-ambiguous operation stays failed closed on retry', testAlreadyAmbiguousOperationStaysFailedClosedOnRetry],
  ['the browser cannot choose the operationId/idempotency key', testBrowserCannotChooseOperationIdOrIdempotencyKey],
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
