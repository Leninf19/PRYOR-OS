// Phase B.8 -- Access Code + Commercial State Modernization. The ONE place
// a VALIDATED access-code redemption result (accessCodeStore.js's
// previewAccessCode()/redeemAccessCode() return shape) is converted into
// the SAME canonical tenant_config.commercial schema every other tenant
// uses -- never a parallel, second entitlement system.
//
// WHY THIS EXISTS: before this phase, redeemAccessCodeAction() hand-built
// an OLD 4-field shape ({ plan, source: 'access_code', accessCodeHash,
// trialEndsAt }) directly inline. entitlementResolution.js's own
// isOldShapeCommercial() check (CRITICAL RESOLVER CORRECTION #2) then
// treated that shape as legacy/unmanaged -- fully UNENFORCED, exactly like
// a pre-Phase-B grandfathered tenant. Every access-code-created tenant was
// therefore invisible to B.3-B.7's location/seat/AI/storage/suspension
// enforcement, regardless of the code's actual plan/trial/payment intent.
// This module is the fix: it produces the real, new-shape commercial
// object (or, for a trial grant, the deferred-start fields below), so an
// access-code tenant is indistinguishable from any other commercial tenant
// to the resolver from the moment it's written.
//
// TWO OUTCOMES, never both:
//   - Case 1 (direct, non-trial grant): `commercial` populated immediately
//     -- commercialStatus: 'active' from the moment tenant_config is
//     created.
//   - Case 2 (trial grant): `commercial` is populated immediately too, but
//     with the explicit `commercialStatus: 'trial_pending_activation'`
//     shape (entitlementResolution.js's own header explains why) -- NEVER
//     `commercial: null`. B.2/B.3 defines commercial === null as
//     legacy/unmanaged (fully unenforced) while COMMERCIAL_ENFORCEMENT_CUTOFF
//     is disabled -- an access-code trial grant sitting as `null` during
//     onboarding would silently BE an unrestricted legacy tenant (unlimited
//     AI, unlimited storage, every feature) until initial sync completes,
//     which could take arbitrarily long or never happen at all. This
//     phase's pre-commit correction closes that hole: 'trial_pending_activation'
//     is itself a genuine, resolver-recognized, restrictive commercial
//     status (bounded onboarding capacity: pendingActivationLimits() in
//     entitlementResolution.js) from the instant redemption succeeds.
//     `accessCodeGrant` still carries the code's own trialDays/plan/hash
//     through to the eventual real activation -- see trialLifecycle.js's
//     maybeStartAccessCodeTrial(), which REPLACES this pending commercial
//     object with the real, dated commercial.trial once
//     tenant_config.initialSync.completedAt exists -- NEVER Date.now() at
//     redemption time, so the trial clock cannot silently start ticking
//     while the tenant is still mid-onboarding.
//
// `accessCodeGrant` is DELIBERATELY NOT the same field as trialEligibility
// (trialLifecycle.js's own marker for the automatic, self-service GBP
// trial) -- an access-code trial is an explicit, human-authorized sales/
// admin grant, independent of that anti-abuse claim system
// (trialEligibilityStore.js's per-GBP-location claim ledger). Per this
// phase's own approved policy: an access-code trial never reserves or
// consumes a trial_claim:v1:{gbpLocation} record, and a self-service
// trial's eligibility marker is never touched by an access-code redemption
// either. The two systems are structurally independent, connected by TWO
// independent exclusion layers every tenant already has: maybeStartTrial()
// never fires for a tenant whose commercial is already non-null (true for
// BOTH access-code cases from the instant tenant_config is written -- no
// window at all now), and (extra, durable defense) never fires for a
// tenant with an accessCodeGrant on file regardless of what commercial
// happens to hold.

import { isValidPlanId } from './planEntitlements.js'
import {
  isValidTrialDays, MAX_ACCESS_CODE_TRIAL_DAYS, isValidDiscountPercent, isValidDiscountFixedCents,
} from './accessCodeStore.js'

// Phase B.8 (Part E) -- paymentRequired semantics. Stripe/billing does not
// exist yet, so a code whose issuer explicitly marked it paymentRequired:
// true must NEVER produce paid-active (or trial) access on redemption --
// that would silently give away product with no payment mechanism behind
// it. The smallest safe behavior (per this phase's own explicit menu of
// options) is outright rejection with a stable, honest error, rather than
// inventing a new 'pending_payment' commercial status B.7's own
// commercialOperationPolicy.js/REQUIRED STATUS MATRIX has no concept of.
// This is checked by the CALLER (session/[action].js's
// redeemAccessCodeAction()) via accessCodeStore.js's previewAccessCode()
// BEFORE the real, irreversible redeemAccessCode() consume -- a
// payment-required code must never be burned by a redemption attempt this
// module will refuse to convert into commercial state.
export class PaymentRequiredNotSupportedError extends Error {}

// Defensive re-validation of the redemption result's own fields --
// createAccessCode() is the authoritative validation gate (Part G/H), but
// this function never trusts a stored record blindly either, since a
// pre-B.8 code could have been created before that validation existed.
export class InvalidAccessCodeGrantError extends Error {}

// Given accessCodeStore.js's redemption result shape ({ plan,
// discountPercent, discountFixedCents, trialDays, paymentRequired,
// codeHash }), returns { commercial, accessCodeGrant } -- exactly one of
// which is non-null. Throws PaymentRequiredNotSupportedError or
// InvalidAccessCodeGrantError rather than ever returning an unsafe/
// malformed write. Never reads or trusts anything from a request -- every
// field here already came from the server-validated, atomically-redeemed
// access code record, never client input.
export function buildAccessCodeCommercialWrite(redemption) {
  if (redemption.paymentRequired === true) {
    throw new PaymentRequiredNotSupportedError(
      'This access code requires payment, which is not yet supported. Please contact support.'
    )
  }
  if (!isValidPlanId(redemption.plan)) {
    throw new InvalidAccessCodeGrantError(`buildAccessCodeCommercialWrite: invalid plan ${JSON.stringify(redemption.plan)}`)
  }
  if (!isValidTrialDays(redemption.trialDays)) {
    throw new InvalidAccessCodeGrantError(
      `buildAccessCodeCommercialWrite: trialDays must be null or an integer between 0 and ${MAX_ACCESS_CODE_TRIAL_DAYS}, got ${JSON.stringify(redemption.trialDays)}`
    )
  }
  // discountPercent/discountFixedCents are normalized/stored-only (Part F)
  // -- never interpreted into billing totals (no billing system exists
  // yet) and never allowed to influence limits/features (resolveNewShapeCommercial()
  // never reads either field). Phase B.8 pre-commit correction (Part 4):
  // defensively RE-VALIDATED here too (never just normalized/trusted) --
  // createAccessCode() is the authoritative gate, but a pre-B.8 or
  // otherwise-corrupted stored record must still be rejected outright
  // rather than silently coerced into something that merely looks
  // plausible.
  if (!isValidDiscountPercent(redemption.discountPercent)) {
    throw new InvalidAccessCodeGrantError(`buildAccessCodeCommercialWrite: discountPercent must be null or a whole number between 0 and 100, got ${JSON.stringify(redemption.discountPercent)}`)
  }
  if (!isValidDiscountFixedCents(redemption.discountFixedCents)) {
    throw new InvalidAccessCodeGrantError(`buildAccessCodeCommercialWrite: discountFixedCents must be null or a non-negative safe integer, got ${JSON.stringify(redemption.discountFixedCents)}`)
  }
  if (redemption.discountPercent != null && redemption.discountFixedCents != null) {
    throw new InvalidAccessCodeGrantError('buildAccessCodeCommercialWrite: discountPercent and discountFixedCents cannot both be set')
  }
  const discountPercent = redemption.discountPercent ?? null
  const discountFixedCents = redemption.discountFixedCents ?? null

  const now = new Date().toISOString()

  if (redemption.trialDays && redemption.trialDays > 0) {
    // Case 2 -- trial grant. `commercial` is written immediately, in the
    // explicit, resolver-recognized 'trial_pending_activation' shape --
    // NEVER null (see this file's header for the legacy-fallthrough hole
    // that would otherwise open). The REAL, dated commercial.trial object
    // is written later, lazily, by maybeStartAccessCodeTrial() once this
    // tenant's first successful initial sync provides an authoritative
    // clock anchor; `accessCodeGrant` carries the code's own trialDays/
    // plan/hash through to that moment.
    return {
      commercial: {
        commercialStatus: 'trial_pending_activation',
        plan: redemption.plan,
        planSource: 'access_code_trial',
        trial: null,
        limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
        accessCodeHash: redemption.codeHash,
        discountPercent, discountFixedCents,
        paymentRequired: false,
        createdAt: now, updatedAt: now,
      },
      accessCodeGrant: {
        grantType: 'trial',
        trialDays: redemption.trialDays,
        plan: redemption.plan,
        planSource: 'access_code_trial',
        discountPercent, discountFixedCents,
        accessCodeHash: redemption.codeHash,
        grantedAt: now,
      },
    }
  }

  // Case 1 -- direct, non-trial grant. Real commercial state from the
  // moment tenant_config is created; no deferred activation needed since
  // there is no trial clock to anchor.
  return {
    commercial: {
      commercialStatus: 'active',
      plan: redemption.plan,
      planSource: 'access_code',
      trial: null,
      limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
      accessCodeHash: redemption.codeHash,
      discountPercent, discountFixedCents,
      paymentRequired: false,
      createdAt: now, updatedAt: now,
    },
    accessCodeGrant: null,
  }
}
