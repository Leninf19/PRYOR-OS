// Phase B.10 -- server-authoritative plan <-> Stripe price mapping. Reads
// directly from plans.js's existing `stripePriceId` field (currently null
// on every plan -- no Stripe Price has been created yet, per B.9/B.10's
// explicit "do not create Stripe prices yet"), so there is exactly ONE
// place a plan's Stripe price identity is ever declared -- reviewed source
// code, exactly like PLAN_IDS/planEntitlements.js, never a runtime-editable
// table or an environment variable for launch.
//
// Direction of trust, always: plan id (validated) -> Stripe price id.
// NEVER the reverse from an untrusted source -- a future checkout-creation
// endpoint accepts a plan id from the authenticated caller, validates it,
// and looks up ITS OWN approved price id here; it must never accept a
// Stripe price id directly from a client. resolvePlanIdForStripePriceId()
// below (price -> plan) exists only for a future WEBHOOK handler's own
// internal bookkeeping (translating a Stripe object's price back into a
// plan id for display/audit), never as an authorization decision by
// itself.
//
// Enterprise is deliberately excluded from SELF_SERVICE_PLAN_IDS -- no
// self-service Stripe Checkout exists or is planned for it (B.9 Part E):
// it is manual-sales-only, with any resulting Stripe subscription linked
// by a future super-admin support action, never automatically.

import { PLANS } from './plans.js'

export const SELF_SERVICE_PLAN_IDS = Object.freeze(['core', 'growth'])

export function isSelfServicePlan(planId) {
  return SELF_SERVICE_PLAN_IDS.includes(planId)
}

// Returns the approved Stripe price id for a self-service plan, or `null`
// if the plan isn't self-service-eligible (e.g. 'enterprise') OR if a real
// Stripe price hasn't been configured for it yet (plans.js still has
// stripePriceId: null for every plan as of B.10). A future checkout-
// creation endpoint MUST treat a null return as "fail closed" -- refuse to
// create a Checkout Session rather than ever falling back to a
// client-supplied or guessed price id.
export function resolveApprovedStripePriceId(planId) {
  if (!isSelfServicePlan(planId)) return null
  return PLANS[planId]?.stripePriceId ?? null
}

// Reverse lookup (price id -> plan id), built directly from PLANS so it can
// never drift from the forward mapping above. Returns null if the price id
// doesn't match any configured self-service plan.
export function resolvePlanIdForStripePriceId(stripePriceId) {
  if (typeof stripePriceId !== 'string' || !stripePriceId) return null
  for (const planId of SELF_SERVICE_PLAN_IDS) {
    if (PLANS[planId]?.stripePriceId === stripePriceId) return planId
  }
  return null
}
