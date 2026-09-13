// Phase B.2 -- Commercial Entitlement Foundation: plan/feature/limit tables.
//
// PLUMBING ONLY (Phase B.2's explicit scope). Nothing in this file is
// imported by any endpoint yet -- see entitlements.js's own header for the
// one function (resolveTenantEntitlements) that will eventually be the sole
// consumer wiring these tables into real enforcement, in a later,
// separately reviewed phase. No Google/AI/Content/data.js/invitation/
// billing endpoint reads anything here yet.
//
// This is a SEPARATE table from dashboard/api/_lib/plans.js (pure pricing/
// Stripe-linkage display metadata, still deliberately never imported by any
// authorization code, still the single source of truth for priceCents) --
// plans.js answers "what does a plan cost," this file answers "what does a
// plan grant/limit." Keeping them separate means a pricing change never
// risks an entitlement regression and vice versa.
//
// Every limit number below is a PROVISIONAL, product-approved starting
// point (Phase B.2 product-decision review) -- not derived from real usage
// data. Expect recalibration once real tenants exist on paid plans,
// especially aiAllowanceMonthly.usageUnits (see that field's own comment).

export const KB = 1024
export const MB = 1024 * KB
export const GB = 1024 * MB

export const PLAN_IDS = Object.freeze(['core', 'growth', 'enterprise'])

export function isValidPlanId(planId) {
  return PLAN_IDS.includes(planId)
}

// Phase A platform-safety hard ceilings (dashboard/api/content/[action].js's
// MAX_TENANT_STORAGE_BYTES = 2GB / MAX_TENANT_ASSET_COUNT = 2000) --
// duplicated here as a named, intentional constant rather than imported
// from that file: a shared library must never import an endpoint module,
// and content/[action].js does not export these values today. If Phase A's
// ceiling ever changes, THIS constant must be updated in the SAME reviewed
// commit. Nothing reads this yet (Phase B.2 is plumbing only) -- it exists
// now so a future phase has one canonical value to clamp Enterprise
// overrides against, per the explicit "never above internal hard safety
// ceilings without a reviewed override" requirement. AI has no analogous
// static ceiling to clamp against here -- Phase A's AI protection is a
// short rolling request-rate limit (orthogonal to a monthly usage-unit
// quota), not a single numeric ceiling.
export const PLATFORM_SAFETY_CEILING = Object.freeze({
  storageBytes: 2 * GB,
  assetCount: 2000,
})

// --- Feature flags -----------------------------------------------------------
const CORE_FEATURES = Object.freeze({
  reviews: true,
  reviewReplies: true,
  aiRewrite: true,
  basicDashboard: true,
  basicReviewTrends: true,
  badReviewAlerts: true,
  basicTasks: true,
  basicEmailDigest: true,
  advancedExecutiveBrief: false,
  advancedIntelligence: false,
  locationComparison: false,
  operationsImpact: false,
  marketingIntelligence: false,
  advancedAutomation: false,
  advancedReporting: false,
  // managerWorkflow is a FUTURE capability -- bad review -> assign/escalate
  // to a manager -> internal explanation/follow-up -> resolution/status ->
  // owner visibility -- with no existing endpoint today. Phase B.2 product
  // decision: model the flag now, but do NOT gate ordinary Tasks CRUD
  // behind it (basicTasks above stays available to every plan). Wiring
  // managerWorkflow to a real endpoint is later, separately reviewed work.
  managerWorkflow: false,
  priorityAlerts: false,
})

const GROWTH_FEATURES = Object.freeze({
  ...CORE_FEATURES,
  advancedExecutiveBrief: true,
  advancedIntelligence: true,
  locationComparison: true,
  operationsImpact: true,
  marketingIntelligence: true,
  advancedAutomation: true,
  advancedReporting: true,
  managerWorkflow: true,
  priorityAlerts: true,
})

// Every currently-defined feature key, for callers (tests, the resolver's
// own deny-all bundles) that need to iterate/build a features object
// without hardcoding the key list a second time.
export const FEATURE_KEYS = Object.freeze(Object.keys(GROWTH_FEATURES))

// --- Limits --------------------------------------------------------------
// aiAllowanceMonthly.usageUnits is a VERSIONED, WEIGHTED unit -- deliberately
// NOT a raw token count and NEVER to be marketed as one (Phase B.2 product
// correction). A future usage-metering store (not built in this phase) is
// expected to record {model, inputTokens, outputTokens, requestCount} per
// call and convert that into usageUnits via a per-model weighting table, so
// a Haiku call and a Sonnet call are never treated as economically
// identical. The numbers below are provisional launch-calibration
// approximations of that eventual unit, not a contractual token count.
export const CORE_LIMITS = Object.freeze({
  maxLocations: 1,
  maxActiveUsers: 3,
  storageBytes: 500 * MB,
  assetCount: 500,
  aiAllowanceMonthly: Object.freeze({ usageUnits: 1_000_000 }),
})

export const GROWTH_LIMITS = Object.freeze({
  maxLocations: 5,
  maxActiveUsers: 10,
  storageBytes: 1 * GB,
  assetCount: 1200,
  aiAllowanceMonthly: Object.freeze({ usageUnits: 4_000_000 }),
})

// Enterprise's own baseline -- used only if a tenant's commercial.limitsOverride
// is missing a specific field. Itself still finite, still no different in
// KIND from Growth's numbers: real Enterprise values ALWAYS come from that
// specific tenant's own limitsOverride (see entitlements.js). "Enterprise"
// is never a code path that means unlimited by itself.
export const ENTERPRISE_BASELINE_LIMITS = Object.freeze({ ...GROWTH_LIMITS })

export const TRIAL_LIMITS = Object.freeze({
  maxLocations: 1,
  maxActiveUsers: 3,
  storageBytes: 250 * MB,
  assetCount: 250,
  aiAllowanceMonthly: Object.freeze({ usageUnits: 500_000 }),
})

// --- Plan table ------------------------------------------------------------
export const PLAN_ENTITLEMENTS = Object.freeze({
  core: Object.freeze({ limits: CORE_LIMITS, features: CORE_FEATURES }),
  growth: Object.freeze({ limits: GROWTH_LIMITS, features: GROWTH_FEATURES }),
  enterprise: Object.freeze({ limits: ENTERPRISE_BASELINE_LIMITS, features: GROWTH_FEATURES }),
})

// Trial is not a "plan" -- commercial.plan on a trialing tenant is still
// 'growth' (the plan the trial previews); this is a distinct entitlement
// BUNDLE the resolver substitutes in whenever commercialStatus === 'trial'
// and the trial has not expired. Kept separate from PLAN_ENTITLEMENTS so
// nothing can accidentally look it up via a plan id that doesn't exist.
export const TRIAL_ENTITLEMENTS = Object.freeze({ limits: TRIAL_LIMITS, features: GROWTH_FEATURES })

// Clamps a (possibly Enterprise-overridden) limits object so storageBytes/
// assetCount can never exceed Phase A's hard platform-safety ceiling.
//
// Phase B.2 pre-commit correction: this ALWAYS clamps, unconditionally --
// there is no reviewed administrative safety-override mechanism yet.
// `commercial.limitsOverride.hardSafetyOverrideApproved` is a RESERVED
// field, kept in the schema only for future compatibility; it must have NO
// EFFECT on this function's output in B.2 (entitlements.js's caller
// destructures it out before ever reaching here, but this function itself
// takes no such option either, so it cannot be wired to bypass the clamp
// by accident). Platform-safety override behavior requires a separately
// reviewed administrative control and is not active. Pure function --
// never reads or writes anything, never called by any live enforcement
// path yet.
export function clampToSafetyCeiling(limits) {
  return {
    ...limits,
    storageBytes: Math.min(limits.storageBytes, PLATFORM_SAFETY_CEILING.storageBytes),
    assetCount: Math.min(limits.assetCount, PLATFORM_SAFETY_CEILING.assetCount),
  }
}
