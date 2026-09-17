// Phase B.11 -- the smallest server-side billing service needed to collect
// a reusable payment method BEFORE any Subscription/charge/PRYOR trial
// exists. Two responsibilities, deliberately kept separate:
//
//   ensureStripeCustomerForTenant() -- creates (or reuses) exactly ONE
//   Stripe Customer per tenant, bound via B.10's reverse index.
//
//   createSetupCheckoutSession() -- creates a Checkout Session in
//   `mode: 'setup'` for that Customer. No line items, no price, no
//   subscription, no charge -- this mode exists purely to save a payment
//   method for later off-session use (B.12+).
//
// `tenantId` here is always the caller's own RESERVED tenant id
// (pendingRegistration.tenantIdReserved, minted at register() time,
// per tenantIdGenerator.js) -- a real tenant_config record does not exist
// yet at this point in the self-service funnel (see session/[action].js's
// createTenantForVerifiedRegistration() header for the full sequencing).
// billingStore.js never requires a tenant_config record to exist (it has
// no import of tenantConfigStore.js at all -- see its own header) -- the
// reserved tenantId string is a perfectly valid, stable join key from the
// moment it is minted, well before the tenant itself is materialized.

import { randomBytes } from 'crypto'
import { getStripeClient } from './stripeClient.js'
import {
  getBillingRecord, createBillingRecord, updateBillingRecord,
  claimCustomerIndex, BillingRecordAlreadyExistsError, BillingVersionConflictError,
} from './billingStore.js'

// Phase B.11 pre-commit correction (Part 4) -- Stripe's OWN idempotency-key
// retention is roughly 24 hours; using a stricter internal threshold here
// leaves a safety margin so this codebase never attempts a Stripe retry in
// the danger zone where Stripe's own dedup record might already be gone
// (which would risk creating a genuine duplicate Customer). 20 hours,
// deliberately shorter than Stripe's own window, not a guess.
const CUSTOMER_CREATION_RECOVERY_WINDOW_MS = 20 * 60 * 60 * 1000

function randomOperationId() {
  return randomBytes(16).toString('hex')
}

// Thrown when a Customer-creation operation could not be confirmed
// (Stripe success/failure genuinely unknown to this codebase) within the
// safe recovery window. Per this phase's own explicit "Option B is
// acceptable if substantially safer/smaller" guidance: this fails closed
// rather than risk creating a duplicate Stripe Customer by blindly
// retrying with a possibly-expired idempotency key. Recovery from this
// state requires a human (future B.9 Part S billing-support tooling,
// not built yet) to reconcile against Stripe directly -- never an
// automatic silent retry.
export class BillingSetupRecoveryRequiredError extends Error {}

function dashboardBaseUrl() {
  const base = process.env.DASHBOARD_BASE_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  if (!base) return null
  return base.replace(/\/$/, '')
}

// Thrown when DASHBOARD_BASE_URL/VERCEL_URL are both unset -- there is no
// safe application URL to send Stripe (success_url/cancel_url), so this
// fails closed rather than ever accepting a browser-supplied redirect
// destination (per this phase's explicit "never trust browser-supplied
// URLs" requirement).
export class BillingUrlNotConfiguredError extends Error {}

// Acquires (or reuses) a durable Customer-creation OPERATION record on the
// billing record -- the server-generated identity that makes retries safe
// beyond Stripe's own idempotency-key retention window (see this file's
// header on CUSTOMER_CREATION_RECOVERY_WINDOW_MS). Returns { record,
// operation }. Throws BillingSetupRecoveryRequiredError if an existing
// operation is already 'ambiguous', or has aged past the recovery window
// (marking it 'ambiguous' as a side effect, so the SAME determination is
// made consistently on every subsequent call rather than re-derived from
// scratch each time).
async function acquireOrReuseCustomerCreationOperation(tenantId) {
  let record = await getBillingRecord(tenantId)
  let operation = record?.customerCreationOperation ?? null

  if (operation?.state === 'ambiguous') {
    throw new BillingSetupRecoveryRequiredError(
      `billing setup for tenant ${JSON.stringify(tenantId)} is in a recovery state -- manual support intervention required before retrying`
    )
  }

  if (operation?.state === 'pending') {
    const ageMs = Date.now() - Date.parse(operation.startedAt)
    if (ageMs <= CUSTOMER_CREATION_RECOVERY_WINDOW_MS) {
      // Still safely within the window -- reuse the SAME operationId (and
      // therefore the same Stripe idempotency key) rather than starting a
      // new one. If Stripe already succeeded on a prior attempt that
      // crashed before this codebase recorded the result, retrying with
      // the identical key returns the SAME Customer object -- no
      // duplicate is created.
      return { record, operation }
    }
    // Past the safe window with no confirmed outcome -- do NOT retry
    // Stripe with a possibly-expired idempotency key (Stripe's own dedup
    // record may already be gone, which could mint a genuine duplicate
    // Customer). Fail closed.
    try {
      record = await updateBillingRecord(tenantId, { customerCreationOperation: { ...operation, state: 'ambiguous' } }, { expectedVersion: record.version })
    } catch (err) {
      if (!(err instanceof BillingVersionConflictError)) throw err
      record = err.currentRecord
    }
    throw new BillingSetupRecoveryRequiredError(
      `billing setup for tenant ${JSON.stringify(tenantId)} could not be confirmed within the ${CUSTOMER_CREATION_RECOVERY_WINDOW_MS / 3600000}h recovery window -- manual support intervention required`
    )
  }

  // No operation exists yet (brand-new attempt) -- mint one. Never
  // accepted from any caller/request; always freshly server-generated
  // here.
  const freshOperation = { operationId: randomOperationId(), startedAt: new Date().toISOString(), state: 'pending' }
  if (!record) {
    try {
      record = await createBillingRecord(tenantId, { customerCreationOperation: freshOperation })
      operation = freshOperation
    } catch (err) {
      if (err instanceof BillingRecordAlreadyExistsError) {
        // Lost the race to a concurrent caller -- adopt THEIR operation
        // (never mint a second, different one, which would mean two
        // different idempotency keys racing Stripe).
        record = await getBillingRecord(tenantId)
        operation = record?.customerCreationOperation ?? null
      } else {
        throw err
      }
    }
  } else {
    try {
      record = await updateBillingRecord(tenantId, { customerCreationOperation: freshOperation }, { expectedVersion: record.version })
      operation = freshOperation
    } catch (err) {
      if (err instanceof BillingVersionConflictError) {
        record = err.currentRecord
        operation = record?.customerCreationOperation ?? null
      } else {
        throw err
      }
    }
  }
  if (!operation) {
    // Should not happen (the winner of the race always sets this field in
    // the same write) -- if it somehow does, refuse to proceed rather than
    // silently minting yet another competing operation.
    throw new BillingSetupRecoveryRequiredError(`billing setup for tenant ${JSON.stringify(tenantId)} could not acquire a Customer-creation operation`)
  }
  return { record, operation }
}

// Creates (or reuses) the ONE Stripe Customer for this tenant.
//
// IDEMPOTENCY / CONCURRENCY (B.11 Part I, hardened by Part 4's pre-commit
// correction): two simultaneous calls for the SAME tenantId must never
// create two Stripe Customers, and a crash more than ~24h before a retry
// must never either. Layers:
//   1. A durable, server-generated Customer-creation OPERATION record
//      (acquireOrReuseCustomerCreationOperation() above) -- the identity
//      that survives a process crash and outlives Stripe's own
//      idempotency-key retention. The Stripe idempotency key is DERIVED
//      from this operation's id, not from the tenantId alone, and is
//      reused verbatim across retries within the recovery window.
//   2. Stripe's own idempotency-key deduplication -- concurrent/retried
//      calls with the identical key are guaranteed by Stripe to return
//      the SAME Customer object, never create a second one, PROVIDED the
//      retry happens within Stripe's own retention window (which the
//      operation's own recovery window is deliberately shorter than).
//   3. B.10's claimCustomerIndex()/createBillingRecord()/
//      updateBillingRecord() CAS primitives close the remaining local
//      race for RECORDING the result: a losing concurrent caller adopts
//      the winner's already-recorded outcome rather than erroring.
// The operation identity (never a secret) is sent to Stripe as metadata
// purely as cross-check/debugging information -- never authoritative.
export async function ensureStripeCustomerForTenant(tenantId, email) {
  let record = await getBillingRecord(tenantId)
  if (record?.stripeCustomerId) {
    return { customerId: record.stripeCustomerId, record, created: false }
  }

  const { operation } = await acquireOrReuseCustomerCreationOperation(tenantId)

  const stripe = getStripeClient()
  const idempotencyKey = `billing_customer_create:v1:${tenantId}:${operation.operationId}`
  const customer = await stripe.customers.create(
    {
      email,
      // Non-secret cross-check information only (per B.10/B.11's own
      // metadata discipline) -- the reverse index below remains the
      // authoritative tenant mapping, never this metadata alone.
      metadata: { tenantId, operationId: operation.operationId },
    },
    { idempotencyKey },
  )

  // Idempotent for the SAME tenantId (this one); would throw
  // BillingIndexCollisionError for a genuine cross-tenant collision, which
  // should be structurally impossible here since `tenantId` is always this
  // caller's own reserved id.
  await claimCustomerIndex(customer.id, tenantId)

  const beforeWrite = await getBillingRecord(tenantId)
  try {
    record = await updateBillingRecord(tenantId, {
      stripeCustomerId: customer.id,
      customerCreationOperation: { ...operation, state: 'completed' },
    }, { expectedVersion: beforeWrite.version })
  } catch (err) {
    if (err instanceof BillingVersionConflictError) {
      // Someone else already recorded the SAME Customer id (Stripe's
      // idempotency key guarantees it's the same object either way).
      record = err.currentRecord
    } else {
      throw err
    }
  }
  return { customerId: customer.id, record, created: true }
}

// Creates a Checkout Session in `mode: 'setup'` -- saves a reusable
// payment method for later off-session charging (B.12+). No line items,
// no price, no subscription, no invoice, no charge of any kind.
//
// Per B.11 Part O's documented choice: repeated calls (e.g. the customer
// reloading the page and clicking "Start Trial" again) are allowed to
// create SEPARATE Checkout Session objects rather than trying to locate
// and reuse a still-open prior one. This is safe and deliberate -- Sessions
// are cheap, short-lived (Stripe's own default ~24h expiration), each is
// independently completable against the SAME already-deduplicated
// Customer, and an abandoned one simply expires with zero side effects.
// Reusing an "active" session would add meaningful complexity (tracking/
// validating a prior session's live status) for no real safety benefit,
// since Customer-level idempotency (ensureStripeCustomerForTenant) is what
// actually matters -- multiple Setup Sessions for one Customer are
// harmless by construction.
//
// success_url/cancel_url are built ONLY from the server-configured
// DASHBOARD_BASE_URL/VERCEL_URL -- the request body/query string is never
// consulted for any part of either URL.
//
// Phase B.11 pre-commit correction (Part 9) -- reconfirmed against
// Stripe's own API reference (SetupIntent object docs): no
// `setup_intent_data.usage` override is set here, and none is needed --
// Stripe's documented default is `usage: 'off_session'` ("If not
// provided, this value defaults to off_session"), which is exactly the
// intended future usage (B.12 charges this payment method later, without
// the customer present). Omitting the override is therefore a deliberate,
// verified choice, not an oversight.
export async function createSetupCheckoutSession({ tenantId, customerId, plan }) {
  const base = dashboardBaseUrl()
  if (!base) {
    throw new BillingUrlNotConfiguredError('DASHBOARD_BASE_URL is not configured -- cannot build a safe Checkout redirect URL.')
  }
  const stripe = getStripeClient()
  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    customer: customerId,
    payment_method_types: ['card'],
    success_url: `${base}/pricing/setup-complete?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/pricing?setup=cancelled`,
    metadata: { tenantId, plan },
  })
  return session
}
