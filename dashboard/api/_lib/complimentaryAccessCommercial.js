// Complimentary Restaurant Access Codes -- the ONE place a VALIDATED
// complimentary-code redemption result (complimentaryAccessStore.js's
// previewComplimentaryCode()/redeemComplimentaryCode() return shape) is
// converted into the SAME canonical tenant_config.commercial schema every
// other tenant uses, plus the permanent, auditable `complimentaryGrant`
// record -- never a parallel, second entitlement system.
//
// TWO OUTCOMES, never both -- mirrors accessCodeCommercial.js's own
// trial_pending_activation precedent structurally, but with a DELIBERATELY
// DIFFERENT anchor rule for the immediate case (pre-push correction: the
// original implementation anchored Case 1 to the tenant's HISTORICAL
// initialSync.completedAt, which could silently backdate -- or even
// immediately expire -- a freshly-redeemed grant for a tenant that synced
// long ago; e.g. a tenant that finished onboarding in June redeeming a
// 30-day code in September must get a fresh 30 days from September, never
// a period that expired in July):
//   - Case 1 (initialSync ALREADY completed BEFORE this redemption):
//     `commercial` is written immediately as commercialStatus:
//     'complimentary', with startedAt anchored to THIS REDEMPTION'S OWN
//     server timestamp (`now`, captured once below) -- NEVER the historical
//     initialSync.completedAt, and never anything client-supplied. The
//     tenant's setup already finished, so there is no reason to defer the
//     clock; but the clock must start at the moment complimentary access
//     was actually granted, not at some earlier, unrelated event.
//   - Case 2 (initialSync not yet completed): `commercial` is written
//     immediately in the explicit, resolver-recognized
//     'complimentary_pending_activation' shape -- NEVER left null and never
//     left at whatever pre-redemption status the tenant already had.
//     `complimentaryGrant.grantedAt` durably preserves the redemption
//     timestamp separately from activation. `complimentaryGrant` carries
//     the code's own planId/durationDays/maxLocations/maxUsers/codeHash
//     through to eventual lazy activation -- see trialLifecycle.js's
//     maybeStartComplimentaryAccess(), which REPLACES this pending
//     commercial object with the real, dated commercial.complimentary
//     object once tenant_config.initialSync.completedAt FIRST exists --
//     preserving the principle that setup/data-sync time never consumes any
//     part of the complimentary period.
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
// returns { commercial, complimentaryGrant } -- `commercial` and
// `complimentaryGrant` are both always non-null (the grant record is always
// written, whether activation is immediate or deferred, so it can serve as
// the permanent audit/anti-stacking record either way). `initialSyncCompletedAt`
// is consulted ONLY to decide WHICH case applies (already-synced vs. not
// yet) -- it is never used as the activation anchor itself; that anchor is
// always this function's own server-generated `now` in Case 1, or the
// tenant's FUTURE (not-yet-known) initialSync.completedAt, resolved later by
// maybeStartComplimentaryAccess(), in Case 2. Never reads or trusts anything
// from a request -- every field here already came from the server-validated,
// atomically-redeemed complimentary code record plus the caller's own
// already-authenticated tenantId/userId.
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
    // Case 1 -- initial sync already completed BEFORE this redemption.
    // Pre-push correction: startedAt is THIS REDEMPTION'S OWN server
    // timestamp (`now`, already captured above) -- deliberately NOT
    // initialSyncCompletedAt. Anchoring to the historical sync timestamp
    // would let a long-since-onboarded tenant's grant start (and
    // potentially already end) in the past the instant it's redeemed; the
    // owner must always receive the FULL, fresh durationDays counted from
    // the moment they actually redeem the code.
    const startedAt = now
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
