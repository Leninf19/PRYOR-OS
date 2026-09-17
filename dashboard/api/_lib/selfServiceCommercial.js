// Phase B.11 pre-commit correction (Part 2) -- the canonical commercial
// state a normal (non-access-code) self-service customer gets written at
// TENANT CREATION time, once authoritative billing setup (a saved payment
// method, confirmed only by the verified Stripe webhook) exists.
//
// WHY THIS EXISTS: B.2 defines `commercial === null` as
// legacy/unmanaged -- fully UNRESTRICTED while COMMERCIAL_ENFORCEMENT_CUTOFF
// is disabled (its shipped, currently-null value). Materializing a brand
// new, real, paid-card-backed self-service tenant with `commercial: null`
// would therefore silently grant it unrestricted legacy behavior for the
// entire window between account creation and first successful initial
// sync -- exactly the hole B.8 already closed for access-code trials via
// the explicit `trial_pending_activation` status. This module reuses that
// SAME canonical shape for the self-service case, rather than inventing a
// second pending-activation concept -- see entitlementResolution.js's own
// header for why `trial_pending_activation` is recognized there
// independent of provenance (self-service vs. access-code), and
// commercialOperationPolicy.js's POLICY table for the exact allowed/denied
// operation classes this status enforces.
//
// PROVENANCE STAYS SEPARATE: this writes `planSource: 'self_service_trial'`
// (never 'access_code_trial') and NO `accessCodeGrant` at all -- the two
// pending-activation provenances are mutually exclusive by construction,
// each transitioning out via its own dedicated trialLifecycle.js function
// (maybeStartTrial() for this one, maybeStartAccessCodeTrial() for the
// other) -- see trialLifecycle.js's own header for how each function's
// precondition excludes the other's provenance.
//
// The trial EXPERIENCE is always Growth (plan: 'growth' here), regardless
// of which plan the customer selected as their POST-trial plan -- that
// separate decision lives entirely in the billing record's own
// `pendingPaidPlan` field (billingStore.js), never here. Mixing the two
// would let a customer's post-trial billing choice leak into what
// features they get DURING the trial, which was never the product intent
// (every self-service trial is the same Growth experience).

import { SELF_SERVICE_TRIAL_DAYS } from './trialLifecycle.js'
import { TRIAL_ELIGIBILITY_SOURCES } from './trialLifecycle.js'

// Returns { commercial, trialEligibility } -- both written atomically, in
// the SAME tenant_config write, by tenantCreation.js's createNewTenant()
// (never as a separate two-step patch, which would reopen exactly the
// commercial===null window this module exists to close). Pure -- no I/O,
// no Stripe, no Redis -- so it is trivially unit-testable and cannot
// itself introduce any store-availability failure mode.
export function buildSelfServicePendingActivationCommercial() {
  const now = new Date().toISOString()
  return {
    commercial: {
      commercialStatus: 'trial_pending_activation',
      plan: 'growth',
      planSource: 'self_service_trial',
      trial: null,
      limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
      accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null,
      createdAt: now, updatedAt: now,
    },
    trialEligibility: {
      eligible: true,
      markedAt: now,
      source: 'self_service_registration',
    },
  }
}

// Regression guard -- the trialEligibility source this module writes must
// always be one of trialLifecycle.js's own enumerated, reviewed values,
// never an ad hoc string invented here.
export function selfServiceTrialEligibilitySourceIsCanonical() {
  return TRIAL_ELIGIBILITY_SOURCES.includes('self_service_registration')
}

export { SELF_SERVICE_TRIAL_DAYS }
