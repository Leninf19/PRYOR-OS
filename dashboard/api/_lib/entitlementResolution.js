// Phase B.3 -- factored out of entitlements.js so a CAS-bound tenant_config
// writer (tenantConfigStore.js's recordLocationApproval()/
// applyEntitlementChange()) can resolve entitlements from an
// ALREADY-LOADED config object, without a second, independent
// getTenantConfig() read.
//
// WHY THIS FILE EXISTS -- THE EXACT RACE IT CLOSES: entitlements.js's
// public resolveTenantEntitlements(tenantId) does its OWN read
// (getTenantConfig(tenantId)) every time it's called. If a location-limit
// check inside recordLocationApproval()/applyEntitlementChange() called
// that public function, it would read tenant_config a SECOND time,
// independently of the `existing` snapshot those functions already loaded
// and whose configVersion their CAS write is bound to. Between those two
// reads, a concurrent plan change (or anything else touching configVersion)
// could land -- so the limit decision and the write's CAS guard would be
// checking two DIFFERENT snapshots. That is exactly a plan-change TOCTOU
// race: an approval could be evaluated against a stale (more permissive)
// plan and still commit under a DIFFERENT, already-changed version, or vice
// versa.
//
// The fix: this module is PURE (no I/O, no imports from tenantConfigStore.js
// or tenants.js -- deliberately, to avoid a circular import with
// tenantConfigStore.js, which itself now imports resolveTenantEntitlementsFromConfig
// from here) and exposes resolveTenantEntitlementsFromConfig(config), which
// computes the exact same result entitlements.js's async wrapper would,
// given an object the CALLER already has in hand. A CAS-bound writer calls
// this on the SAME `existing` object its write's `expectedVersion` comes
// from -- so the limit decision and the write are provably evaluated
// against one identical snapshot. If anything (a plan change, another
// location approval, anything else) touches configVersion between that
// read and the write, the atomic CAS at write time rejects the whole
// operation regardless of what this function concluded -- the limit
// decision only ever matters when nothing else changed underneath it.
//
// tenant_config.commercial SCHEMA and RESOLUTION ORDER: see
// entitlements.js's own header for the full, authoritative documentation
// (BOOTSTRAP handling and the genuine-store-outage/no-config-at-all cases
// live there, since both require an actual read this pure module never
// performs). This file implements steps 4-7 of that resolution order only
// -- the part that only depends on an already-loaded, non-null config.
//
// TWO DISTINCT "LIMIT IS NOT ENFORCED" VS "LIMIT IS ZERO" CONVENTIONS --
// NEVER CONFUSE THEM (repeated here since this is now the module that
// actually defines them):
//   - `null` = enforcement deliberately bypassed (permissive legacy bundle
//     only). A caller must treat a null limit as "do not check this at
//     all" -- never convert it into a large integer.
//   - `0`    = enforcement is ACTIVE and denies every quantity outright
//     (the fail-closed bundle). A caller must treat 0 as "deny," never
//     "unlimited."

import {
  isValidPlanId, PLAN_ENTITLEMENTS, TRIAL_ENTITLEMENTS, FEATURE_KEYS, clampToSafetyCeiling,
} from './planEntitlements.js'

// Writable commercial statuses -- the only values a real commercial-state
// WRITE (a future admin/Stripe-webhook action; none exist yet) may ever set
// on tenant_config.commercial.commercialStatus. 'past_due' is kept in this
// enum now, per Phase B.2's product decision, purely so a future Stripe
// billing integration never needs a schema migration to introduce it --
// nothing in this codebase can produce it yet (no billing signal exists),
// and no production admin endpoint is added in this phase solely to
// simulate it (tests construct it via direct store/fixture setup instead).
export const COMMERCIAL_STATUSES = Object.freeze(['trial', 'active', 'past_due', 'suspended', 'canceled'])

// Resolver-OUTPUT-ONLY sentinel statuses -- NEVER legal to write into
// tenant_config.commercial.commercialStatus; only ever produced by
// resolution itself to represent a resolution gap.
export const RESOLUTION_FAILURE_STATUSES = Object.freeze(['unknown', 'unconfigured'])

// Pseudo-plan id for the permissive "no real commercial state" bundle
// (bootstrap / grandfathered-by-cutoff / old-shape) -- deliberately NOT one
// of PLAN_IDS, so nothing downstream can ever confuse a legacy tenant with
// a real paid plan (in particular, never with 'enterprise').
export const LEGACY_UNMANAGED_PLAN = 'legacy_unmanaged'

// CRITICAL RESOLVER CORRECTION #1 (Phase B.2 product-decision review): a
// tenant_config record created ON/AFTER this timestamp with commercial ===
// null is a genuine gap -- never a legacy tenant -- and must fail closed. A
// record created BEFORE this timestamp predates Phase B entirely and is
// treated as explicitly grandfathered.
//
// *** STARTS DISABLED (null) -- DO NOT ARM IN PHASE B.3. *** B.3 still does
// not guarantee every newly-created tenant receives the new commercial
// shape (no live commercial writer exists yet -- that's a later phase), so
// activating a real cutoff now could brand a legitimately-in-flight new
// tenant as "broken" for no fault of its own. `null` means "cutoff not yet
// activated" -- every commercial === null tenant, old or new, resolves
// permissively with reason 'commercial_enforcement_not_activated', matching
// today's real, unrestricted behavior exactly.
//
// ACTIVATION is a LATER, separately reviewed phase's job, once new-tenant
// creation is guaranteed to always write valid commercial state: set this
// to a real ISO timestamp, as a single, obvious, named, exported constant.
export const COMMERCIAL_ENFORCEMENT_CUTOFF = null

// Only ever called from a branch that has already confirmed the cutoff is
// non-null -- this function never Date-parses a null cutoff.
function isBeforeCutoff(isoTimestamp, cutoff) {
  const cutoffMs = Date.parse(cutoff)
  const t = Date.parse(isoTimestamp)
  // An unparseable/missing createdAt is never treated as "definitely
  // legacy" -- falls through to the fail-closed path instead.
  if (!Number.isFinite(t)) return false
  return t < cutoffMs
}

// Test-only seam (mirrors this codebase's established _set.../_reset...
// convention). Production code never calls either function; the real
// constant is used whenever no override has been set.
let cutoffOverrideForTests
export function _setCommercialEnforcementCutoffForTests(value) { cutoffOverrideForTests = value }
export function _resetCommercialEnforcementCutoffForTests() { cutoffOverrideForTests = undefined }
function activeCutoff() {
  return cutoffOverrideForTests !== undefined ? cutoffOverrideForTests : COMMERCIAL_ENFORCEMENT_CUTOFF
}

function denyAllFeatures() {
  return Object.freeze(Object.fromEntries(FEATURE_KEYS.map(k => [k, false])))
}

function zeroLimits() {
  return Object.freeze({
    maxLocations: 0, maxActiveUsers: 0,
    storageBytes: 0, assetCount: 0,
    aiAllowanceMonthly: Object.freeze({ usageUnits: 0 }),
  })
}

function unenforcedLimits() {
  return Object.freeze({
    maxLocations: null, maxActiveUsers: null,
    storageBytes: null, assetCount: null,
    aiAllowanceMonthly: Object.freeze({ usageUnits: null }),
  })
}

// Fail-closed bundle -- limits are 0 (ACTIVELY denies every quantity
// check), never null. `commercialStatus` here is always one of
// RESOLUTION_FAILURE_STATUSES, never a real writable status. Exported so
// entitlements.js's async wrapper can use the identical bundle for its own
// outage/no-config-at-all cases (which this pure module never reaches
// itself, since it never performs a read).
export function unresolvedBundle({ commercialStatus, reason }) {
  return Object.freeze({
    plan: null,
    effectivePlan: null,
    commercialStatus,
    billingStatus: 'none',
    trialStatus: null,
    limits: zeroLimits(),
    features: denyAllFeatures(),
    effectiveAt: new Date().toISOString(),
    reason,
  })
}

// Permissive bundle -- limits are null (UNENFORCED for this tenant),
// features are the full current feature set, matching real-world
// unrestricted behavior for Los Tres Amigos and any pre-Phase-B tenant
// today. There is no real plan id here at all -- see LEGACY_UNMANAGED_PLAN.
// Exported so entitlements.js's async wrapper can use the identical bundle
// for its own BOOTSTRAP case (which needs no config read at all).
export function legacyUnmanagedBundle(reason) {
  return Object.freeze({
    plan: LEGACY_UNMANAGED_PLAN,
    effectivePlan: LEGACY_UNMANAGED_PLAN,
    commercialStatus: 'active',
    billingStatus: 'none',
    trialStatus: null,
    limits: unenforcedLimits(),
    features: PLAN_ENTITLEMENTS.growth.features,
    effectiveAt: new Date().toISOString(),
    reason,
  })
}

// Distinguishes the NEW commercial shape (has an explicit commercialStatus
// field) from the OLD 4-field shape (never has one) and from anything
// malformed (neither). Exported for direct unit testing.
export function isNewShapeCommercial(commercial) {
  return Boolean(commercial) && typeof commercial === 'object' && typeof commercial.commercialStatus === 'string'
}

export function isOldShapeCommercial(commercial) {
  return Boolean(commercial) && typeof commercial === 'object' &&
    !('commercialStatus' in commercial) && typeof commercial.plan === 'string'
}

function resolveNewShapeCommercial(commercial) {
  if (!COMMERCIAL_STATUSES.includes(commercial.commercialStatus)) {
    return unresolvedBundle({ commercialStatus: 'unconfigured', reason: 'malformed_commercial_state' })
  }
  if (!isValidPlanId(commercial.plan)) {
    return unresolvedBundle({ commercialStatus: 'unconfigured', reason: 'unknown_plan' })
  }

  // Trial expiry is COMPUTED here, live, on every resolution -- this
  // function never writes anything back to tenant_config. A trial past its
  // endsAt with no conversion is treated as suspended immediately, with NO
  // additional grace period, per Phase B.2's explicit trial-expiry policy.
  const now = Date.now()
  const trial = commercial.trial ?? null
  const trialExpired = commercial.commercialStatus === 'trial' && trial?.endsAt != null && Date.parse(trial.endsAt) <= now
  const effectiveStatus = trialExpired ? 'suspended' : commercial.commercialStatus
  const isTrialing = effectiveStatus === 'trial'
  const isActive = effectiveStatus === 'active'

  const base = isTrialing ? TRIAL_ENTITLEMENTS : PLAN_ENTITLEMENTS[commercial.plan]

  let planLimits = base.limits
  if (commercial.plan === 'enterprise' && !isTrialing) {
    const override = (commercial.limitsOverride && typeof commercial.limitsOverride === 'object') ? commercial.limitsOverride : {}
    // Phase B.2 pre-commit correction, still in force in B.3:
    // `hardSafetyOverrideApproved` is destructured out and deliberately
    // UNUSED -- there is no reviewed administrative safety-override
    // mechanism yet, so this field has NO EFFECT on resolver output. Every
    // Enterprise limitsOverride is unconditionally clamped to Phase A's
    // platform safety ceiling.
    const { hardSafetyOverrideApproved: _reservedForFutureReview, ...overrideLimits } = override
    planLimits = clampToSafetyCeiling({ ...base.limits, ...overrideLimits })
  }

  // Commercial-status effect table: only 'active' and 'trial' grant real
  // features/limits. Every other status (past_due, suspended, canceled, or
  // a just-computed trial_expired->suspended) collapses to deny-all --
  // WITHOUT changing `plan`/`effectivePlan` (an owner should see "you're on
  // Growth, suspended," never "you have no plan").
  const writesAllowed = isActive || isTrialing
  const limits = writesAllowed ? planLimits : zeroLimits()
  const features = writesAllowed ? base.features : denyAllFeatures()

  let reason
  if (trialExpired) reason = 'trial_expired'
  else if (isActive) reason = 'active_plan'
  else if (isTrialing) reason = 'trial_active'
  else reason = effectiveStatus // past_due / suspended / canceled

  return Object.freeze({
    plan: commercial.plan,
    effectivePlan: isTrialing ? 'growth' : commercial.plan,
    commercialStatus: effectiveStatus,
    billingStatus: commercial.billingStatus ?? 'none',
    trialStatus: trial?.status ?? null,
    limits,
    features,
    effectiveAt: new Date().toISOString(),
    reason,
  })
}

// PURE. Resolves entitlements from an ALREADY-LOADED, non-null
// tenant_config record -- no I/O, no additional read. This is steps 4-7 of
// entitlements.js's documented resolution order (the BOOTSTRAP short-circuit
// and the genuine-store-outage/no-config-at-all cases require an actual
// read and live only in entitlements.js's async resolveTenantEntitlements()).
//
// CAS-BOUND CALLERS (tenantConfigStore.js's recordLocationApproval()/
// applyEntitlementChange()) MUST call this on the EXACT SAME `existing`
// object their write's `expectedVersion` is derived from -- see this
// module's header comment for the race this closes.
export function resolveTenantEntitlementsFromConfig(config) {
  const commercial = config.commercial ?? null

  if (commercial === null) {
    const cutoff = activeCutoff()
    // While the cutoff is not yet activated (the real, shipped default),
    // EVERY commercial === null tenant -- old or brand new -- resolves
    // permissively (see COMMERCIAL_ENFORCEMENT_CUTOFF's own comment).
    if (cutoff === null) {
      return legacyUnmanagedBundle('commercial_enforcement_not_activated')
    }
    // CRITICAL RESOLVER CORRECTION #1 (live only once the cutoff above is
    // eventually armed by a later, separately reviewed phase). Never
    // Date-parses a null cutoff -- `cutoff` is already confirmed non-null.
    if (isBeforeCutoff(config.createdAt, cutoff)) {
      return legacyUnmanagedBundle('grandfathered_pre_phase_b')
    }
    return unresolvedBundle({ commercialStatus: 'unconfigured', reason: 'commercial_unconfigured' })
  }

  if (isOldShapeCommercial(commercial)) {
    // CRITICAL RESOLVER CORRECTION #2: never infer a paid/active status
    // from an old-shape record's trialEndsAt.
    return legacyUnmanagedBundle('legacy_commercial_shape')
  }

  if (!isNewShapeCommercial(commercial)) {
    return unresolvedBundle({ commercialStatus: 'unconfigured', reason: 'malformed_commercial_state' })
  }

  return resolveNewShapeCommercial(commercial)
}
