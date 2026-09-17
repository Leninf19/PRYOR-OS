// Complimentary Restaurant Access Codes -- the ONE place a VALIDATED
// complimentary-code redemption result (complimentaryAccessStore.js's
// previewComplimentaryCode()/redeemComplimentaryCode() return shape) is
// converted into the SAME canonical tenant_config.commercial schema every
// other tenant uses, plus the permanent, auditable `complimentaryGrant`
// record -- never a parallel, second entitlement system.
//
// TWO OUTCOMES, never both -- mirrors accessCodeCommercial.js's own
// trial_pending_activation precedent exactly, for the exact same reason
// (an onboarding tenant must never resolve as unrestricted legacy/unmanaged
// while `commercial` is in any kind of "not yet started" limbo):
//   - Case 1 (initialSync already completed at redemption time):
//     `commercial` is written immediately as commercialStatus:
//     'complimentary', anchored to the tenant's own ALREADY-DURABLE
//     initialSync.completedAt -- never Date.now(). This is the rare/
//     defensive path (see this repo's own redemption ordering: redemption
//     normally happens BEFORE GBP connection, per the product flow), but is
//     handled correctly either way.
//   - Case 2 (initialSync not yet completed): `commercial` is written
//     immediately in the explicit, resolver-recognized
//     'complimentary_pending_activation' shape -- NEVER left null and never
//     left at whatever pre-redemption status the tenant already had.
//     `complimentaryGrant` carries the code's own planId/durationDays/
//     maxLocations/maxUsers/codeHash through to eventual lazy activation --
//     see trialLifecycle.js's maybeStartComplimentaryAccess(), which
//     REPLACES this pending commercial object with the real, dated
//     commercial.complimentary object once tenant_config.initialSync.completedAt
//     exists.
//
// `complimentaryGrant` is written ONCE, at redemption time, and is NEVER
// cleared or deleted afterward -- not at activation, not at expiration, not
// even once a real paid Stripe subscription later supersedes it (see
// trialLifecycle.js's activatePaidSubscriptionIfValid()). It is the
// permanent, auditable record of "this tenant redeemed a complimentary
// code" and the durable anti-stacking signal maybeStartTrial() and this
// tenant's own future complimentary-redemption attempts both consult.

import { isSelfServicePlan } from './stripePriceMap.js'
import {
  isValidComplimentaryDurationDays, isValidComplimentaryMaxLocations, isValidComplimentaryMaxUsers,
} from './complimentaryAccessStore.js'

// Defensive re-validation of the redemption result's own fields --
// createComplimentaryCode() is the authoritative validation gate, but this
// function never trusts a stored record blindly either.
export class InvalidComplimentaryGrantError extends Error {}

// Given complimentaryAccessStore.js's redemption result shape ({ planId,
// durationDays, maxLocations, maxUsers, codeHash }), the tenant's own
// current tenant_config `initialSync` field, and the redeeming user's id,
// returns { commercial, complimentaryGrant } -- `commercial` is always
// non-null; `complimentaryGrant` is always non-null too (unlike
// accessCodeCommercial.js's mutually-exclusive shape, since complimentary
// access ALWAYS anchors to initialSync.completedAt for its actual clock --
// even the "already active" case needs the grant's own maxLocations/
// maxUsers/durationDays available for later reference/audit). Never reads
// or trusts anything from a request -- every field here already came from
// the server-validated, atomically-redeemed complimentary code record plus
// the caller's own already-authenticated tenantId/userId.
export function buildComplimentaryAccessCommercialWrite(redemption, { initialSyncCompletedAt = null, redeemedByUserId }) {
  // Defense in depth -- createComplimentaryCode() is the authoritative gate
  // excluding Enterprise, but this function never trusts a stored record
  // blindly either (see this file's own class-level comment).
  if (!isSelfServicePlan(redemption.planId)) {
    throw new InvalidComplimentaryGrantError(`buildComplimentaryAccessCommercialWrite: invalid planId ${JSON.stringify(redemption.planId)} -- must be a self-service plan (core or growth)`)
  }
  if (!isValidComplimentaryDurationDays(redemption.durationDays)) {
    throw new InvalidComplimentaryGrantError(`buildComplimentaryAccessCommercialWrite: invalid durationDays ${JSON.stringify(redemption.durationDays)}`)
  }
  if (!isValidComplimentaryMaxLocations(redemption.maxLocations)) {
    throw new InvalidComplimentaryGrantError(`buildComplimentaryAccessCommercialWrite: invalid maxLocations ${JSON.stringify(redemption.maxLocations)}`)
  }
  if (!isValidComplimentaryMaxUsers(redemption.maxUsers)) {
    throw new InvalidComplimentaryGrantError(`buildComplimentaryAccessCommercialWrite: invalid maxUsers ${JSON.stringify(redemption.maxUsers)}`)
  }

  const now = new Date().toISOString()
  const complimentaryGrant = {
    grantType: 'complimentary',
    planId: redemption.planId,
    durationDays: redemption.durationDays,
    maxLocations: redemption.maxLocations,
    maxUsers: redemption.maxUsers,
    codeHash: redemption.codeHash,
    grantedAt: now,
    redeemedByUserId,
  }

  if (typeof initialSyncCompletedAt === 'string' && initialSyncCompletedAt) {
    // Case 1 -- initial sync already completed. Anchor to the tenant's own
    // already-durable timestamp, never Date.now().
    const startedAt = initialSyncCompletedAt
    const endsAt = new Date(Date.parse(startedAt) + redemption.durationDays * 24 * 60 * 60 * 1000).toISOString()
    return {
      commercial: {
        commercialStatus: 'complimentary',
        plan: redemption.planId,
        planSource: 'complimentary_access',
        trial: null,
        complimentary: {
          status: 'active', startedAt, endsAt, consumedAt: startedAt,
          maxLocations: redemption.maxLocations, maxUsers: redemption.maxUsers, codeHash: redemption.codeHash,
        },
        limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
        accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: false,
        createdAt: now, updatedAt: now,
      },
      complimentaryGrant,
    }
  }

  // Case 2 -- pending. No real clock exists yet; trialLifecycle.js's
  // maybeStartComplimentaryAccess() writes the real, dated `complimentary`
  // object later, once initialSync.completedAt exists.
  return {
    commercial: {
      commercialStatus: 'complimentary_pending_activation',
      plan: redemption.planId,
      planSource: 'complimentary_access',
      trial: null,
      complimentary: null,
      limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
      accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: false,
      createdAt: now, updatedAt: now,
    },
    complimentaryGrant,
  }
}
