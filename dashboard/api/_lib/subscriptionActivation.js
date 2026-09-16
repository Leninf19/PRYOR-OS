// Phase B.12 -- Stripe Subscription Activation. The ONE place a tenant's
// first real Stripe Subscription is ever created. Deliberately SEPARATE
// from trialLifecycle.js's maybeStartTrial()/maybeStartAccessCodeTrial()
// (which remain the ONLY writers of tenant_config.commercial.trial) -- this
// module never writes tenant_config at all, and trialLifecycle.js never
// calls Stripe. That split is intentional: PRYOR's own trial canonicalization
// (a pure function of already-immutable inputs, CAS-protected, safely
// retryable) must never be entangled with an external, fallible, at-least-
// once-retried Stripe API call in the same transaction -- a Stripe timeout
// must never leave trialStartedAt/trialEndsAt in doubt, and a trial-CAS
// retry must never risk creating a second Subscription. See this repo's
// B.12 architecture report for the full reasoning.
//
// ensureSubscriptionActivation(tenantId, config) is idempotent and safe to
// call repeatedly (lazily, from tenantStatus()'s own read-time reconciliation
// -- see session/[action].js -- and/or from any future primary server-side
// trigger): a tenant that already has a Subscription is a fast, cheap no-op;
// a tenant that isn't yet eligible is a no-op; only a genuinely first-time,
// eligible tenant ever reaches the Stripe API.
//
// PRECONDITIONS (all read from a caller-supplied, already-loaded tenant_config
// `config` -- NEVER independently re-read here, mirroring maybeStartTrial()'s
// own discipline exactly):
//   - config.commercial.commercialStatus equals the canonical 'trial' value
//     (PRYOR's own trial has already started -- trialLifecycle.js's job,
//     never this module's)
//   - config.commercial.trial.status === 'active' with real
//     startedAt/endsAt strings
//   - config.initialSync.completedAt exists (implied by the trial already
//     being active, per trialLifecycle.js's own invariant, but checked again
//     here directly rather than assumed)
// Everything else (Stripe Customer, saved PaymentMethod, the customer's
// chosen post-trial plan) is read from the tenant's OWN already-durable
// billing:v1 record (billingStore.js) -- never from any request, never from
// the browser, never invented here.
import { randomBytes } from 'crypto'
import { getStripeClient } from './stripeClient.js'
import {
  getBillingRecord, updateBillingRecord, claimSubscriptionIndex,
  BillingVersionConflictError,
} from './billingStore.js'
import { resolveApprovedStripePriceId, isSelfServicePlan } from './stripePriceMap.js'

// Same conservative window as billingCustomer.js's Customer-creation
// operation (see that file's own header for the full "why 20h, why shorter
// than Stripe's own ~24h idempotency-key retention" rationale) -- reused
// verbatim, never loosened, per this phase's explicit "keep the ~20h
// recovery window" requirement.
const SUBSCRIPTION_ACTIVATION_RECOVERY_WINDOW_MS = 20 * 60 * 60 * 1000

function randomOperationId() {
  return randomBytes(16).toString('hex')
}

// Thrown when a Subscription-activation attempt could not be confirmed
// (Stripe success/failure genuinely unknown to this codebase) within the
// safe recovery window, or when an operation already sits in that terminal
// state from a prior attempt. Recovery requires a human (billing-support
// tooling, not built in B.12) to reconcile against Stripe directly --
// never an automatic silent retry past this point, which could risk
// creating a duplicate Subscription.
export class SubscriptionActivationRecoveryRequiredError extends Error {}

// Thrown when PRYOR's own canonical trial had ALREADY ENDED before a first
// Stripe Subscription was ever created for this tenant (the EXPIRED-TRIAL
// RULE). This is a DETERMINISTIC precondition failure -- this module knows
// with certainty no Subscription exists and the trial window is over --
// never a Stripe-result ambiguity, so it is raised WITHOUT ever calling the
// Stripe API at all. Recovery is a deliberate, separate billing decision
// (never automatic): this module will never itself create a Subscription
// with `trial_end: 'now'`, and will never restart or extend
// tenant_config.commercial.trial (it cannot -- this module never writes
// tenant_config at all).
export class TrialExpiredBeforeActivationError extends Error {}

// Returns { start, end } epoch-seconds period boundaries from a Stripe
// Subscription object, tolerant of the object's own top-level
// current_period_start/end (this codebase's originally-assumed shape) OR
// (a documented later Stripe API evolution) the same fields living on the
// subscription's first Item instead. Never throws -- an absent/unexpected
// shape simply resolves to nulls, which billingStore.js's own
// isValidIsoTimestampOrNull-style validation already accepts.
export function resolveSubscriptionPeriod(subscription) {
  const topStart = subscription?.current_period_start
  const topEnd = subscription?.current_period_end
  if (typeof topStart === 'number' && typeof topEnd === 'number') {
    return { start: new Date(topStart * 1000).toISOString(), end: new Date(topEnd * 1000).toISOString() }
  }
  const item = subscription?.items?.data?.[0]
  const itemStart = item?.current_period_start
  const itemEnd = item?.current_period_end
  if (typeof itemStart === 'number' && typeof itemEnd === 'number') {
    return { start: new Date(itemStart * 1000).toISOString(), end: new Date(itemEnd * 1000).toISOString() }
  }
  return { start: null, end: null }
}

// Acquires (or reuses) a durable Subscription-activation OPERATION record --
// mirrors billingCustomer.js's acquireOrReuseCustomerCreationOperation()
// exactly, simplified by one fact that is always true by the time this is
// called: the billing record itself already exists (the caller's own
// precondition checks -- defaultPaymentMethodId/pendingPaidPlan/
// stripeCustomerId all present -- cannot pass otherwise), so there is no
// "record doesn't exist yet" branch to handle here.
async function acquireOrReuseSubscriptionActivationOperation(tenantId, billingRecord) {
  let record = billingRecord
  let operation = record.subscriptionActivation ?? null

  if (operation?.state === 'ambiguous') {
    throw new SubscriptionActivationRecoveryRequiredError(
      `subscription activation for tenant ${JSON.stringify(tenantId)} is in a recovery state -- manual support intervention required before retrying`
    )
  }
  if (operation?.state === 'expired_before_activation') {
    throw new TrialExpiredBeforeActivationError(
      `subscription activation for tenant ${JSON.stringify(tenantId)} was already marked expired-before-activation -- PRYOR's trial ended before any Subscription was created; this requires a deliberate billing decision, never an automatic retry`
    )
  }

  if (operation?.state === 'pending') {
    const ageMs = Date.now() - Date.parse(operation.startedAt)
    if (ageMs <= SUBSCRIPTION_ACTIVATION_RECOVERY_WINDOW_MS) {
      // Still safely within the window -- reuse the SAME operationId (and
      // therefore the same Stripe idempotency key) rather than starting a
      // new one.
      return { record, operation }
    }
    // Past the safe window with no confirmed outcome -- fail closed rather
    // than retry Stripe with a possibly-expired idempotency key.
    try {
      record = await updateBillingRecord(tenantId, { subscriptionActivation: { ...operation, state: 'ambiguous' } }, { expectedVersion: record.version })
    } catch (err) {
      if (!(err instanceof BillingVersionConflictError)) throw err
      record = err.currentRecord
    }
    throw new SubscriptionActivationRecoveryRequiredError(
      `subscription activation for tenant ${JSON.stringify(tenantId)} could not be confirmed within the ${SUBSCRIPTION_ACTIVATION_RECOVERY_WINDOW_MS / 3600000}h recovery window -- manual support intervention required`
    )
  }

  // No operation yet -- mint one. Never accepted from any caller/request;
  // always freshly server-generated here.
  const freshOperation = { operationId: randomOperationId(), startedAt: new Date().toISOString(), state: 'pending' }
  try {
    record = await updateBillingRecord(tenantId, { subscriptionActivation: freshOperation }, { expectedVersion: record.version })
    operation = freshOperation
  } catch (err) {
    if (err instanceof BillingVersionConflictError) {
      // Lost the race to a concurrent caller -- adopt THEIR operation
      // (never mint a second, different one, which would mean two
      // different idempotency keys racing Stripe).
      record = err.currentRecord
      operation = record?.subscriptionActivation ?? null
    } else {
      throw err
    }
  }
  if (!operation) {
    throw new SubscriptionActivationRecoveryRequiredError(`subscription activation for tenant ${JSON.stringify(tenantId)} could not acquire an operation record`)
  }
  return { record, operation }
}

// The result shapes for the common, expected non-error outcomes -- callers
// (tenantStatus()'s reconciliation, any future primary trigger) branch on
// `outcome` rather than on exceptions for anything that is a normal,
// frequently-observed state (not yet eligible, already done).
//   'not_ready'      -- a precondition isn't met yet; `reason` explains
//                        which one. Never an error -- this is the expected
//                        state for the vast majority of calls (tenant not
//                        even in a trial yet, no saved payment method,
//                        price not configured, etc.).
//   'already_active' -- a Subscription already exists for this tenant;
//                        pure no-op, proves the idempotency guarantee.
//   'created'         -- a new Subscription was created by THIS call.
export async function ensureSubscriptionActivation(tenantId, config) {
  if (!config) return { outcome: 'not_ready', reason: 'no_tenant_config' }
  if (config.commercial?.commercialStatus !== 'trial') return { outcome: 'not_ready', reason: 'no_active_pryor_trial' }
  const trial = config.commercial.trial
  if (!trial || trial.status !== 'active' || typeof trial.startedAt !== 'string' || typeof trial.endsAt !== 'string') {
    return { outcome: 'not_ready', reason: 'trial_shape_invalid' }
  }
  const initialSyncCompletedAt = config.initialSync?.completedAt
  if (typeof initialSyncCompletedAt !== 'string' || !initialSyncCompletedAt) {
    return { outcome: 'not_ready', reason: 'no_initial_sync' }
  }

  let record = await getBillingRecord(tenantId)
  if (!record) return { outcome: 'not_ready', reason: 'no_billing_record' }
  // Idempotency guarantee, checked FIRST, before anything else: a tenant
  // that already has a Subscription is a pure no-op, regardless of what
  // else is true about its billing record. This is what makes it safe for
  // tenantStatus()'s own reconciliation call to invoke this on every poll,
  // and for any future primary trigger to invoke it more than once.
  if (record.stripeSubscriptionId) return { outcome: 'already_active', stripeSubscriptionId: record.stripeSubscriptionId }

  // A prior attempt already reached a terminal recovery/expired state --
  // fail closed identically to a fresh check, without re-deriving anything.
  if (record.subscriptionActivation?.state === 'ambiguous') {
    throw new SubscriptionActivationRecoveryRequiredError(
      `subscription activation for tenant ${JSON.stringify(tenantId)} is in a recovery state -- manual support intervention required before retrying`
    )
  }
  if (record.subscriptionActivation?.state === 'expired_before_activation') {
    throw new TrialExpiredBeforeActivationError(
      `subscription activation for tenant ${JSON.stringify(tenantId)} was already marked expired-before-activation -- PRYOR's trial ended before any Subscription was created`
    )
  }

  // EXPLICIT millisecond-vs-second protection: Date.parse()/Date.now() are
  // both milliseconds; Stripe's `trial_end` is documented as epoch SECONDS.
  // This is the ONE conversion point -- every value derived from it below
  // uses this same `trialEndEpochSeconds`, never a re-derived or
  // independently-rounded copy.
  const trialEndsAtMs = Date.parse(trial.endsAt)
  if (Number.isNaN(trialEndsAtMs)) return { outcome: 'not_ready', reason: 'trial_endsAt_invalid' }

  // EXPIRED-TRIAL RULE -- checked UNCONDITIONALLY here, before any
  // Stripe-readiness precondition (payment method/plan/customer/price):
  // PRYOR's own canonical trial has already ended and no Subscription was
  // ever created for this tenant. This must fail closed / require recovery
  // regardless of whether billing setup even LOOKS complete -- it is never
  // acceptable to wait for a missing payment method to be filled in and
  // THEN discover the trial had already expired, silently masking this as
  // an ordinary "not ready yet" state. Fail closed / recovery required --
  // NEVER trial_end: 'now', NEVER restart/extend the trial (this module
  // cannot even do the latter -- it never writes tenant_config), and NEVER
  // a Stripe API call of any kind for this attempt.
  if (trialEndsAtMs <= Date.now()) {
    try {
      record = await updateBillingRecord(tenantId, {
        subscriptionActivation: { operationId: randomOperationId(), startedAt: new Date().toISOString(), state: 'expired_before_activation' },
      }, { expectedVersion: record.version })
    } catch (err) {
      if (!(err instanceof BillingVersionConflictError)) throw err
    }
    throw new TrialExpiredBeforeActivationError(
      `tenant ${JSON.stringify(tenantId)}'s PRYOR trial ended at ${trial.endsAt}, before any Stripe subscription was ever created -- refusing to create one now (never trial_end='now', never a trial restart/extension); this requires a deliberate, separate billing recovery decision`
    )
  }
  const trialEndEpochSeconds = Math.floor(trialEndsAtMs / 1000)

  if (!record.defaultPaymentMethodId) return { outcome: 'not_ready', reason: 'no_payment_method' }
  if (!record.pendingPaidPlan || !isSelfServicePlan(record.pendingPaidPlan)) return { outcome: 'not_ready', reason: 'no_pending_plan' }
  if (!record.stripeCustomerId) return { outcome: 'not_ready', reason: 'no_stripe_customer' }

  const priceId = resolveApprovedStripePriceId(record.pendingPaidPlan)
  if (!priceId) return { outcome: 'not_ready', reason: 'price_not_configured' }

  const acquired = await acquireOrReuseSubscriptionActivationOperation(tenantId, record)
  record = acquired.record
  const operation = acquired.operation

  const stripe = getStripeClient()
  // Deterministic, server-generated idempotency key -- derived from the
  // durable operationId, never from Date.now() or any per-call random
  // value, and reused verbatim across retries within the recovery window
  // (see acquireOrReuseSubscriptionActivationOperation() above).
  const idempotencyKey = `subscription_create:v1:${tenantId}:${operation.operationId}`

  const subscription = await stripe.subscriptions.create(
    {
      customer: record.stripeCustomerId,
      items: [{ price: priceId }],
      default_payment_method: record.defaultPaymentMethodId,
      // Exact absolute trial_end -- NEVER trial_period_days. Stripe's own
      // trial clock is confirmatory only; PRYOR's trialEndsAt is the sole
      // authority (see this file's header).
      trial_end: trialEndEpochSeconds,
      // Non-secret cross-check information only (same discipline as every
      // other Stripe object this codebase creates) -- never authoritative;
      // claimSubscriptionIndex() below is the real, server-enforced binding.
      metadata: { tenantId, plan: record.pendingPaidPlan },
    },
    { idempotencyKey },
  )

  // Idempotent for the SAME tenantId; would throw BillingIndexCollisionError
  // for a genuine cross-tenant collision, which should be structurally
  // impossible here since `tenantId` is always this caller's own resolved
  // id and Stripe subscription ids are never guessed/reused.
  await claimSubscriptionIndex(subscription.id, tenantId)

  const period = resolveSubscriptionPeriod(subscription)
  const beforeWrite = await getBillingRecord(tenantId)
  try {
    record = await updateBillingRecord(tenantId, {
      stripeSubscriptionId: subscription.id,
      stripePriceId: priceId,
      subscriptionStatus: subscription.status,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
      cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      subscriptionActivation: { ...operation, state: 'completed' },
    }, { expectedVersion: beforeWrite.version })
  } catch (err) {
    if (err instanceof BillingVersionConflictError) {
      // Someone else already recorded the SAME Subscription (Stripe's
      // idempotency key guarantees it's the same object either way).
      record = err.currentRecord
    } else {
      throw err
    }
  }

  return { outcome: 'created', stripeSubscriptionId: subscription.id, record }
}
