// Phase B.10 -- a PURE mapping helper (no I/O, no Redis, no Stripe API,
// takes no tenant/config object) that translates a Stripe subscription
// status into the PRYOR commercialStatus it *would* project onto, per the
// mapping locked in the B.9 design report (Part K). This module NEVER
// writes tenant_config.commercial or the billing store -- it exists only
// so the mapping itself is reviewed, testable code before any future
// webhook handler (B.11+) actually calls upsertTenantConfig() with its
// result.
//
// Phase B.10 pre-commit correction: the original design here returned
// `trialing -> 'trial'` as an ordinary mapped value, identical in shape to
// every other status's authoritative mapping. That was too easy for a
// future caller to misuse -- a careless B.11/B.12 implementation could
// read `commercialStatus: 'trial'` at face value and use it to CREATE a
// PRYOR trial (or worse, overwrite an existing one) directly from Stripe,
// which the locked trial architecture explicitly forbids: PRYOR's trial
// clock is anchored ONLY to initialSync.completedAt
// (trialLifecycle.js's maybeStartAccessCodeTrial()/maybeStartTrial()), and
// a Stripe 'trialing' status must be confirmatory only, never creative.
//
// The fix: 'trialing' now maps to `commercialStatus: null` (`shouldWrite:
// false`) -- structurally IDENTICAL, from a naive "if (shouldWrite) write
// it" caller's point of view, to the two statuses that already prove
// nothing definitive ('incomplete'/'incomplete_expired'). A SEPARATE
// `confirmation` field (null for every other status) carries the
// 'provider_trialing' signal for a future, deliberately-written B.11/B.12
// reconciliation step: if PRYOR already has an authoritative
// commercialStatus: 'trial' with its own trialStartedAt/trialEndsAt, a
// 'provider_trialing' confirmation may later be accepted as "Stripe
// mirrors what PRYOR already independently decided." If PRYOR does NOT
// already have a valid authoritative trial, that same confirmation must be
// treated as a mismatch/reconciliation condition -- NOT implemented here
// (B.10 is storage/mapping primitives only).
//
// Because this function takes no tenant state as input and returns no
// trial-timestamp fields at all, it remains structurally incapable of
// creating, restarting, or extending a trial by itself, regardless of
// what a future caller does with `confirmation`.
//
// Do NOT mirror Stripe's status vocabulary 1:1 -- see the table below for
// the deliberate, non-1:1 mapping and the rationale for each entry.

import { COMMERCIAL_STATUSES } from './entitlementResolution.js'
import { PROVIDER_SUBSCRIPTION_STATUSES } from './billingStore.js'

// commercialStatus: null = "no projection write should happen for this
// status" (the subscription proves nothing definitive yet, nothing
// changed, or -- 'trialing' specifically -- it must never be applied
// without a separate, deliberate reconciliation step). confirmation: a
// non-null value here is informational-only context for a future caller;
// it is never itself a commercialStatus and never implies shouldWrite.
const PROJECTION_MAP = Object.freeze({
  // First invoice unconfirmed (e.g. failed 3DS) -- proves nothing yet.
  // Leave whatever commercial state the tenant already has untouched.
  incomplete: { commercialStatus: null, confirmation: null },
  // The checkout/subscription attempt died before ever succeeding --
  // nothing about the tenant's real commercial state changed.
  incomplete_expired: { commercialStatus: null, confirmation: null },
  // Only reachable if a subscription is ever created with a Stripe-native
  // trial (e.g. a manual/Enterprise case). NEVER an authoritative
  // commercialStatus by itself -- see the header correction above.
  trialing: { commercialStatus: null, confirmation: 'provider_trialing' },
  // Stripe confirms the current invoice is paid and the subscription is
  // live.
  active: { commercialStatus: 'active', confirmation: null },
  // A Smart Retry cycle is in progress -- existing operations continue,
  // no capacity expansion (unchanged B.7 policy row).
  past_due: { commercialStatus: 'past_due', confirmation: null },
  // Subscription fully and finally ended -- the one 1:1 mapping.
  canceled: { commercialStatus: 'canceled', confirmation: null },
  // Stripe's retry schedule is exhausted without collecting payment --
  // PRYOR has no distinct "billing exhausted" concept, so this becomes
  // suspended, same as every other restrictive status.
  unpaid: { commercialStatus: 'suspended', confirmation: null },
  // A support/customer-initiated pause with no PRYOR equivalent concept --
  // treated identically to suspended until unpaused.
  paused: { commercialStatus: 'suspended', confirmation: null },
})

// Returns { commercialStatus, shouldWrite, confirmation }. `shouldWrite` is
// false for every status that must never independently mutate
// tenant_config.commercial: the two that prove nothing definitive
// ('incomplete'/'incomplete_expired') AND 'trialing' (confirmatory only --
// see header). `commercialStatus` is null in all three of those cases, so
// a caller can never accidentally write a real value it didn't mean to.
// `confirmation` is non-null ONLY for 'trialing' ('provider_trialing') --
// a future caller must explicitly read and interpret it; there is no way
// to stumble into trial-creation behavior by only checking `shouldWrite`/
// `commercialStatus`, which is the whole point of this shape. Throws
// TypeError for any input outside billingStore.js's own
// PROVIDER_SUBSCRIPTION_STATUSES enum -- never silently falls through to a
// guessed default.
export function projectProviderStatusToCommercialStatus(providerStatus) {
  if (!PROVIDER_SUBSCRIPTION_STATUSES.includes(providerStatus)) {
    throw new TypeError(`projectProviderStatusToCommercialStatus: invalid provider status ${JSON.stringify(providerStatus)}`)
  }
  const { commercialStatus, confirmation } = PROJECTION_MAP[providerStatus]
  return { commercialStatus, shouldWrite: commercialStatus !== null, confirmation }
}

// Regression guard -- every non-null commercialStatus this module can ever
// return must be a real, resolver-recognized status. Kept as an explicit,
// importable check so a test can assert it directly rather than only
// exercising it incidentally.
export function everyMappedStatusIsCanonical() {
  return Object.values(PROJECTION_MAP).every(({ commercialStatus }) => commercialStatus === null || COMMERCIAL_STATUSES.includes(commercialStatus))
}
