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
  isValidPlanId, PLAN_ENTITLEMENTS, TRIAL_ENTITLEMENTS, TRIAL_LIMITS, FEATURE_KEYS, clampToSafetyCeiling,
} from './planEntitlements.js'

// Writable commercial statuses -- the only values a real commercial-state
// WRITE (a future admin/Stripe-webhook action; none exist yet) may ever set
// on tenant_config.commercial.commercialStatus. 'past_due' is kept in this
// enum now, per Phase B.2's product decision, purely so a future Stripe
// billing integration never needs a schema migration to introduce it --
// nothing in this codebase can produce it yet (no billing signal exists),
// and no production admin endpoint is added in this phase solely to
// simulate it (tests construct it via direct store/fixture setup instead).
//
// 'trial_pending_activation' (Phase B.8 pre-commit correction) is the ONE
// exception to "no production writer exists yet": accessCodeCommercial.js's
// buildAccessCodeCommercialWrite() writes it immediately, at tenant-creation
// time, for an access-code trial grant -- see this file's own comment on
// PENDING_ACTIVATION_LIMITS below for why. It is the ONLY status this
// resolver ever transitions OUT OF via a dedicated activation function
// (trialLifecycle.js's maybeStartAccessCodeTrial()) rather than staying
// fixed until an external billing signal changes it.
//
// 'complimentary' / 'complimentary_pending_activation' (PRYOR Complimentary
// Restaurant Access Codes) -- a THIRD, independent provenance for the same
// pending-activation pattern, written by complimentaryAccessCommercial.js's
// buildComplimentaryAccessCommercialWrite() when an authenticated tenant
// Owner redeems a complimentary code (complimentaryAccessStore.js) against
// their ALREADY-EXISTING tenant. Deliberately NOT the same status value as
// 'trial'/'trial_pending_activation' -- a complimentary grant is neither a
// Stripe-backed trial nor the automatic self-service GBP trial, and the
// product must be able to tell all three apart (never fake
// commercialStatus: 'active' to "pass" existing billing checks, and never
// silently reuse 'trial' just because the entitlement shape happens to be
// similar). 'complimentary_pending_activation' transitions OUT via
// trialLifecycle.js's maybeStartComplimentaryAccess() exactly like its
// access-code-trial sibling; 'complimentary' itself transitions out only via
// its own live expiry computation (below) or a future genuine paid
// Subscription (trialLifecycle.js's activatePaidSubscriptionIfValid()).
export const COMMERCIAL_STATUSES = Object.freeze([
  'trial', 'active', 'past_due', 'suspended', 'canceled', 'trial_pending_activation',
  'complimentary', 'complimentary_pending_activation',
])

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

// Phase B.8 pre-commit correction -- 'trial_pending_activation' limits.
// Numeric onboarding capacity (maxLocations/maxActiveUsers) reuses the SAME
// TRIAL_LIMITS values a normal trial would eventually get (Part 1's own
// "Numeric onboarding capacity may use the existing Trial safety limits"
// instruction) -- enough to connect Google, discover locations, and
// approve the tenant's first location. Every cost-relevant limit
// (storageBytes/assetCount/aiAllowanceMonthly) is zeroed: this state must
// never grant real product usage, only onboarding capability. NEVER
// unenforced (null) -- this is an ACTIVE restriction, not a bypassed one.
// Reused verbatim for 'complimentary_pending_activation' -- the onboarding
// capacity a complimentary grant needs before its own clock starts is
// identical in kind to the access-code-trial case; there is no reason for a
// second, parallel bounded-onboarding shape.
function pendingActivationLimits() {
  return Object.freeze({
    maxLocations: TRIAL_LIMITS.maxLocations, maxActiveUsers: TRIAL_LIMITS.maxActiveUsers,
    storageBytes: 0, assetCount: 0,
    aiAllowanceMonthly: Object.freeze({ usageUnits: 0 }),
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
    trialStartedAt: null,
    trialEndsAt: null,
    trialConsumedAt: null,
    complimentaryStartedAt: null,
    complimentaryEndsAt: null,
    complimentaryMaxLocations: null,
    complimentaryMaxUsers: null,
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
    trialStartedAt: null,
    trialEndsAt: null,
    trialConsumedAt: null,
    complimentaryStartedAt: null,
    complimentaryEndsAt: null,
    complimentaryMaxLocations: null,
    complimentaryMaxUsers: null,
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
  // Complimentary-access expiry mirrors trial expiry EXACTLY: computed
  // live, never stored, and collapses to the SAME 'suspended' effective
  // status (the safest existing non-paying/read-only state) via a distinct
  // `reason` string -- never writing/touching `commercial.suspension`,
  // which is reserved exclusively for the Stripe-unpaid-recovery pathway
  // (SUSPENSION_REASONS in trialLifecycle.js). This is the "safest existing
  // expired/read-only state, distinguishable by reason" this feature's own
  // design explicitly requires, reusing the established pattern rather than
  // inventing a fourth restrictive status.
  const complimentary = commercial.complimentary ?? null
  const complimentaryExpired = commercial.commercialStatus === 'complimentary' && complimentary?.endsAt != null && Date.parse(complimentary.endsAt) <= now
  const effectiveStatus = trialExpired ? 'suspended' : (complimentaryExpired ? 'suspended' : commercial.commercialStatus)
  const isTrialing = effectiveStatus === 'trial'
  const isActive = effectiveStatus === 'active'
  const isComplimentary = effectiveStatus === 'complimentary'
  // Phase B.7 correction: `past_due` is a TEMPORARY billing-grace state,
  // not a restriction state -- existing restaurant operations (reads,
  // tasks, review publishing, AI/Content subject to their normal plan
  // quota, normal Google sync) must continue exactly as if the plan were
  // active. B.2 originally zeroed past_due's limits/features (there was no
  // production writer of past_due yet, so it defaulted to the same
  // deny-all shape as suspended/canceled) -- B.7's own approved policy
  // requires the OPPOSITE: past_due gets the plan's REAL numeric limits
  // and REAL feature set here, and it is the SEPARATE, centralized
  // commercialOperationPolicy.js module (never this resolver) that blocks
  // specifically CAPACITY-EXPANDING mutations (new locations, new seats)
  // while past_due, regardless of whether the tenant is still numerically
  // under its plan's limit. suspended/canceled (and an expired trial,
  // which collapses to 'suspended' above) remain fully denied here --
  // unchanged from B.2/B.3/B.4/B.5's existing, already-tested behavior.
  const isPastDue = effectiveStatus === 'past_due'
  // Phase B.8 pre-commit correction -- see COMMERCIAL_STATUSES's own
  // comment and pendingActivationLimits()'s header. Deliberately checked
  // and handled BEFORE the writesAllowed ternary below: this status is
  // neither "full real access" (isActive/isTrialing/isPastDue/isComplimentary)
  // nor "deny-all" (suspended/canceled/zeroLimits) -- it is its own explicit,
  // THIRD shape (bounded onboarding capacity, zero cost-relevant capacity),
  // so it must never fall through either branch of that ternary.
  // 'complimentary_pending_activation' is the SAME shape, different
  // provenance -- see COMMERCIAL_STATUSES's own comment.
  const isPendingActivation = effectiveStatus === 'trial_pending_activation' || effectiveStatus === 'complimentary_pending_activation'

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
  } else if (isComplimentary && complimentary) {
    // Complimentary Restaurant Access Codes -- combines the PLAN's own
    // capability set (`base.features`, computed above from
    // PLAN_ENTITLEMENTS[commercial.plan]) with the GRANT's own,
    // independently-set location/user ceilings. Deliberately Math.min()'d
    // against the plan's own real limit, never trusted as a raw override --
    // a complimentary code is meant to grant a SMALLER slice of a plan
    // (e.g. Growth features, but only 1 location/3 users, per this
    // feature's own default invite profile), never a LARGER one than the
    // plan itself would normally allow. This is what makes "Growth features
    // but only 1 location and 3 users" true by construction, and makes an
    // operator's mistakenly-oversized grant harmless (it silently clamps
    // down to the plan's own ceiling instead of exceeding it).
    const grantMaxLocations = complimentary.maxLocations
    const grantMaxUsers = complimentary.maxUsers
    planLimits = {
      ...base.limits,
      maxLocations: Number.isInteger(grantMaxLocations) ? Math.min(base.limits.maxLocations, grantMaxLocations) : base.limits.maxLocations,
      maxActiveUsers: Number.isInteger(grantMaxUsers) ? Math.min(base.limits.maxActiveUsers, grantMaxUsers) : base.limits.maxActiveUsers,
    }
  }

  // Commercial-status effect table: 'active', 'trial', 'complimentary', AND
  // (Phase B.7) 'past_due' grant real features/limits. Only
  // 'suspended'/'canceled' (or a just-computed trial_expired/
  // complimentary_expired->suspended) collapse to deny-all -- WITHOUT
  // changing `plan`/`effectivePlan` (an owner should see "you're on Growth,
  // suspended," never "you have no plan"). 'trial_pending_activation' /
  // 'complimentary_pending_activation' (Phase B.8 / Complimentary Restaurant
  // Access Codes) are their own explicit third case, handled first.
  let limits, features, reason
  if (isPendingActivation) {
    limits = pendingActivationLimits()
    features = denyAllFeatures()
    reason = effectiveStatus === 'complimentary_pending_activation' ? 'complimentary_pending_activation' : 'trial_pending_activation'
  } else {
    const writesAllowed = isActive || isTrialing || isPastDue || isComplimentary
    limits = writesAllowed ? planLimits : zeroLimits()
    features = writesAllowed ? base.features : denyAllFeatures()
    if (trialExpired) reason = 'trial_expired'
    else if (complimentaryExpired) reason = 'complimentary_expired'
    else if (isActive) reason = 'active_plan'
    else if (isTrialing) reason = 'trial_active'
    else if (isPastDue) reason = 'past_due_grace'
    else if (isComplimentary) reason = 'complimentary_active'
    else reason = effectiveStatus // suspended / canceled
  }

  // Phase B.6: `trialStatus` must be TIME-AUTHORITATIVE, not a passthrough
  // of the raw stored value -- a trial past its trialEndsAt is EFFECTIVELY
  // expired the instant this function runs, regardless of whether any
  // background job has ever observed or persisted that fact. The raw
  // stored `trial.status` (e.g. 'trialing') is only surfaced as-is when
  // trialExpired is false; once expired, this always reports 'expired'
  // here, even though nothing on disk changed. This is deliberately
  // computed fresh on EVERY resolution (never cached), exactly like
  // trialExpired/effectiveStatus above.
  const effectiveTrialStatus = trialExpired ? 'expired' : (trial?.status ?? null)

  return Object.freeze({
    plan: commercial.plan,
    effectivePlan: isTrialing ? 'growth' : commercial.plan,
    commercialStatus: effectiveStatus,
    billingStatus: commercial.billingStatus ?? 'none',
    trialStatus: effectiveTrialStatus,
    // Raw trial timestamps, exposed so a caller (session/[action].js's safe
    // frontend view) never needs to reach into raw tenant_config.commercial
    // itself -- the resolver stays the one source of truth for anything
    // trial-shaped. Never client-writable; these are always whatever this
    // tenant's OWN commercial.trial object already holds.
    trialStartedAt: trial?.startedAt ?? null,
    trialEndsAt: trial?.endsAt ?? null,
    trialConsumedAt: trial?.consumedAt ?? null,
    // Same discipline as trialStartedAt/trialEndsAt above, for the
    // complimentary-access equivalent -- a caller never needs to reach into
    // raw tenant_config.commercial.complimentary itself. Null whenever no
    // complimentary grant is (or ever was) active for this tenant.
    complimentaryStartedAt: complimentary?.startedAt ?? null,
    complimentaryEndsAt: complimentary?.endsAt ?? null,
    complimentaryMaxLocations: complimentary?.maxLocations ?? null,
    complimentaryMaxUsers: complimentary?.maxUsers ?? null,
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
