// Phase B.10/B.12 -- server-authoritative plan <-> Stripe price mapping.
//
// Phase B.12: price identity now comes from SERVER-SIDE ENVIRONMENT
// CONFIGURATION (STRIPE_CORE_PRICE_ID/STRIPE_GROWTH_PRICE_ID), not from
// plans.js's static `stripePriceId` field (which stays null -- plans.js is
// deliberately non-runtime presentation metadata per its own header, never
// a place real per-environment Stripe identifiers belong: a Preview
// deployment and Production must be able to point at different -- e.g.
// test-mode vs. live-mode -- Stripe Prices without a code change). This
// mirrors every other real secret/identifier in this codebase
// (STRIPE_SECRET_KEY, GOOGLE_CLIENT_ID, UPSTASH_REDIS_REST_URL, ...): a
// plain SCREAMING_SNAKE_CASE env var, read directly via process.env at the
// point of use, never a checked-in real value.
//
// Direction of trust, always: plan id (validated) -> Stripe price id.
// NEVER the reverse from an untrusted source -- ensureSubscriptionActivation()
// (subscriptionActivation.js) accepts a plan id only from the server's own
// already-durable billingRecord.pendingPaidPlan (itself only ever written by
// selectPlan()'s own validated `plan` -- never a raw request field), and
// looks up ITS OWN approved price id here; it must never accept a Stripe
// price id directly from a client. resolvePlanIdForStripePriceId() below
// (price -> plan) exists only for a future webhook/support handler's own
// internal bookkeeping (translating a Stripe object's price back into a
// plan id for display/audit), never as an authorization decision by
// itself.
//
// Enterprise is deliberately excluded from SELF_SERVICE_PLAN_IDS -- no
// self-service Stripe Checkout/Subscription exists or is planned for it
// (B.9 Part E): it is manual-sales-only, with any resulting Stripe
// subscription linked by a future super-admin support action, never
// automatically.
//
// FAIL CLOSED: a missing or malformed env var resolves to `null`, exactly
// like an unconfigured plan did in B.10/B.11 -- every caller (selectPlan(),
// ensureSubscriptionActivation()) already treats `null` as "refuse, do not
// fabricate/guess a price id," so this is a pure swap of the underlying
// source of truth, not a new caller-visible contract.

// NOTE: this is a deliberate LOCAL copy of billingStore.js's own
// isValidStripePriceId() shape check, not an import from it -- billingStore.js
// itself imports SELF_SERVICE_PLAN_IDS from THIS file (see its own header),
// so importing back from billingStore.js here would create a real circular
// module dependency. Both copies must stay in sync (`/^price_[A-Za-z0-9]+$/`)
// if Stripe's own id format ever changes.
function looksLikeStripePriceId(v) {
  return typeof v === 'string' && /^price_[A-Za-z0-9]+$/.test(v)
}

export const SELF_SERVICE_PLAN_IDS = Object.freeze(['core', 'growth'])

// The ONE place a self-service plan's Stripe price env-var NAME is ever
// declared. Never Enterprise -- SELF_SERVICE_PLAN_IDS above is the actual
// gate (isSelfServicePlan()), this table simply has no entry for it.
const PRICE_ENV_VAR_BY_PLAN_ID = Object.freeze({
  core: 'STRIPE_CORE_PRICE_ID',
  growth: 'STRIPE_GROWTH_PRICE_ID',
})

export function isSelfServicePlan(planId) {
  return SELF_SERVICE_PLAN_IDS.includes(planId)
}

// Returns the approved Stripe price id for a self-service plan, or `null`
// if the plan isn't self-service-eligible (e.g. 'enterprise'), the
// corresponding env var isn't set, or its value doesn't even look like a
// real Stripe price id (isValidStripePriceId() -- structural validation
// only, same discipline billingStore.js already applies to every provider
// identifier it persists). Every caller MUST treat a null return as "fail
// closed" -- refuse to proceed rather than ever falling back to a
// client-supplied, guessed, or hardcoded price id.
export function resolveApprovedStripePriceId(planId) {
  if (!isSelfServicePlan(planId)) return null
  const envVarName = PRICE_ENV_VAR_BY_PLAN_ID[planId]
  const value = process.env[envVarName]
  if (typeof value !== 'string' || !value) return null
  return looksLikeStripePriceId(value) ? value : null
}

// Reverse lookup (price id -> plan id), built directly from the SAME
// env-var-backed forward mapping above so it can never drift from it.
// Returns null if the price id doesn't match any configured self-service
// plan's currently-resolved price.
export function resolvePlanIdForStripePriceId(stripePriceId) {
  if (typeof stripePriceId !== 'string' || !stripePriceId) return null
  for (const planId of SELF_SERVICE_PLAN_IDS) {
    if (resolveApprovedStripePriceId(planId) === stripePriceId) return planId
  }
  return null
}
