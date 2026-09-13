// Phase B.2 -- Commercial Entitlement Foundation: the ONE authoritative
// server-side resolver every future commercial decision must go through.
//
// PLUMBING ONLY (Phase B.2's explicit scope): nothing calls
// resolveTenantEntitlements() from any live endpoint yet -- no Google/AI/
// Content/data.js/invitation/billing enforcement is wired in this phase.
// This file exists so that when a LATER, separately reviewed phase DOES
// wire enforcement, every endpoint calls this ONE function -- never a
// scattered `if (plan === 'growth')` re-implemented per route file.
//
// tenant_config.commercial SCHEMA (new shape, additive -- see "OLD SHAPE"
// below for what already exists in the wild):
//   commercial: {
//     commercialStatus: 'trial'|'active'|'past_due'|'suspended'|'canceled',
//     plan: 'core'|'growth'|'enterprise',
//     planSource: 'access_code'|'self_service'|'admin'|'migration',
//     trial: { status: 'not_started'|'active'|'expired'|'converted',
//              startedAt, endsAt, consumedAt } | null,
//     limitsOverride: { maxLocations?, maxActiveUsers?, storageBytes?,
//              assetCount?, aiAllowanceMonthly?: {usageUnits},
//              hardSafetyOverrideApproved? } | null,   // Enterprise only
//     suspension: { suspendedAt, reason, actorId } | null,
//     cancellation: { canceledAt, retentionEndsAt, reason, actorId } | null,
//     overLimit: { locationsOverLimitSince, usersOverLimitSince } | null,
//     accessCodeHash, discountPercent, discountFixedCents, paymentRequired,
//     createdAt, updatedAt,
//   }
// The presence of `commercialStatus` is what distinguishes this NEW shape
// from the OLD one (`{plan, source, accessCodeHash, trialEndsAt}`, still
// possibly present on any tenant that redeemed an access code before this
// phase shipped) -- see isOldShapeCommercial()/isNewShapeCommercial() below.
// This file does not write this schema anywhere yet (no endpoint is wired);
// it only defines and resolves it. A future phase's admin/access-code/
// Stripe-webhook code is expected to construct this shape when it starts
// writing real commercial state.
//
// RESOLUTION ORDER (exact, matches Phase B.2 product-decision review):
//   1. BOOTSTRAP tenant (Los Tres Amigos) -> legacyUnmanagedBundle('bootstrap_legacy')
//      Never consults tenant_config for this decision at all -- identical
//      in spirit to tenants.js's own tenantOwnsLocationCatalog()/
//      tenantOwnsLocation(): Redis contents can never override this mode.
//   2. tenant_config store unreachable (genuine outage) ->
//      unresolvedBundle({commercialStatus:'unknown', reason:'resolution_failed'})
//      Fails CLOSED -- never treated as "must be legacy" or "must be paid."
//   3. No tenant_config record exists at all for a non-BOOTSTRAP tenant id ->
//      unresolvedBundle({commercialStatus:'unconfigured', reason:'no_tenant_config'})
//      A definitively-absent record is never legitimate for a real tenant
//      (createNewTenant() always writes one immediately) -- treated as a
//      confirmed misconfiguration, not "don't know."
//   4. config.commercial is null/missing:
//        - PHASE B.2 PRE-COMMIT CORRECTION: the cutoff starts DISABLED
//          (COMMERCIAL_ENFORCEMENT_CUTOFF === null) -- B.2 does not yet
//          guarantee every newly-created tenant receives the new commercial
//          shape, so a tenant created after an armed cutoff but before the
//          commercial writer exists could legitimately have commercial ===
//          null and be wrongly branded "broken." While disabled, EVERY
//          commercial === null tenant (old or new) resolves to
//          legacyUnmanagedBundle('commercial_enforcement_not_activated') --
//          i.e. today's real, unrestricted behavior for every tenant,
//          preserved exactly, with an honest `reason` recording that this
//          is a temporary state, not a permanent policy.
//        - Once a LATER phase (which guarantees new tenant creation always
//          writes valid commercial state) activates the cutoff by setting
//          COMMERCIAL_ENFORCEMENT_CUTOFF to a real ISO timestamp, as its
//          own deliberate, separately reviewed change:
//            - createdAt < cutoff  -> legacyUnmanagedBundle('grandfathered_pre_phase_b')
//            - createdAt >= cutoff -> unresolvedBundle({commercialStatus:'unconfigured',
//              reason:'commercial_unconfigured'}) -- CRITICAL RESOLVER
//              CORRECTION #1's actual fail-closed behavior, live only once
//              armed. This is exactly the "commercial == null must not
//              silently mean unlimited forever" correction -- see
//              COMMERCIAL_ENFORCEMENT_CUTOFF's own comment for why a cutoff
//              timestamp, not a persisted marker, is used once armed, and
//              why B.2 itself must not choose that activation date.
//        - The cutoff is NEVER Date-parsed while null -- see isBeforeCutoff()
//          below, only ever called from the already-non-null branch.
//   5. config.commercial is the OLD 4-field shape (no `commercialStatus` key
//      at all) -> CRITICAL RESOLVER CORRECTION #2: NEVER infer a paid/active
//      status from an old record's `trialEndsAt` (there is no billing
//      evidence to support that) -> legacyUnmanagedBundle('legacy_commercial_shape'),
//      distinctly tagged from grandfathered-by-cutoff for later, deliberate,
//      separately-reviewed migration.
//   6. config.commercial has `commercialStatus` but it (or `plan`) is not a
//      recognized value -> unresolvedBundle(..., reason:'malformed_commercial_state'
//      or 'unknown_plan'). Fails closed, never guesses.
//   7. Otherwise: a genuine, well-formed, new-shape commercial record ->
//      resolveNewShapeCommercial() -- real plan lookup, trial-expiry
//      computed live (never persisted by this function), Enterprise
//      limitsOverride applied and clamped to the Phase A safety ceiling,
//      and the commercial-status effect table (features/limits collapse to
//      false/0 for anything other than trial/active) applied.
//
// TWO DISTINCT "LIMIT IS NOT ENFORCED" VS "LIMIT IS ZERO" CONVENTIONS --
// NEVER CONFUSE THEM:
//   - `null`  = enforcement deliberately bypassed for this tenant (the
//               permissive legacy bundle only: bootstrap / grandfathered /
//               old-shape). A future enforcement phase must treat a null
//               limit as "do not check this at all," not "check against
//               null" (which would throw or behave unpredictably).
//   - `0`     = enforcement is ACTIVE and denies every quantity outright
//               (the fail-closed bundle: unknown / unconfigured / malformed
//               / any non-active-non-trialing status). A future enforcement
//               phase must treat a 0 limit as "deny," never "unlimited."
//
// FAIL-CLOSED POLICY: every failure path in this file returns a real,
// frozen object -- this function NEVER throws. A caller that cannot get a
// real, resolvable commercial state gets a bundle whose `features` are all
// false and whose `limits` are all 0 (never null, never a large number) --
// "no accidental unlimited access," per Phase B.2's explicit requirement.
// Read-only dashboard access is a SEPARATE concern this file does not
// govern at all (existing per-file/per-location authorization in data.js/
// auth.js is unaffected by anything in this file) -- only future paid/
// cost-generating write paths are expected to ever consult this resolver.

import { getTenantConfig, TenantConfigStoreUnavailableError } from './tenantConfigStore.js'
import { locationCatalogModeFor, LocationCatalogMigrationMode } from './tenants.js'
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
// resolveTenantEntitlements() itself to represent a resolution gap.
export const RESOLUTION_FAILURE_STATUSES = Object.freeze(['unknown', 'unconfigured'])

// Pseudo-plan id for the permissive "no real commercial state" bundle
// (bootstrap / grandfathered-by-cutoff / old-shape) -- deliberately NOT one
// of PLAN_IDS, so nothing downstream can ever confuse a legacy tenant with
// a real paid plan (in particular, never with 'enterprise').
export const LEGACY_UNMANAGED_PLAN = 'legacy_unmanaged'

// CRITICAL RESOLVER CORRECTION #1 (Phase B.2 product-decision review): a
// tenant_config record created ON/AFTER this timestamp with commercial ===
// null is a genuine gap -- never a legacy tenant -- and must fail closed.
// A record created BEFORE this timestamp predates Phase B entirely and is
// treated as explicitly grandfathered.
//
// WHY A CUTOFF TIMESTAMP, NOT A PERSISTED MARKER: the preferred design (an
// explicit `grandfathered: true` field written once, deliberately, onto
// every pre-Phase-B tenant_config record) would require a production write
// to every existing tenant's record -- explicitly forbidden for this phase
// ("no production migration," "no LTA tenant_config creation"). Every
// tenant_config record's own `createdAt` is stamped unconditionally on that
// tenant's very first write and is never patchable afterward
// (tenantConfigStore.js's upsertTenantConfig: `createdAt: existing?.createdAt
// ?? now`) -- so it already gives an equivalent, zero-migration signal:
// "did this tenant's record exist before Phase B.2 shipped."
//
// *** STARTS DISABLED (null) -- DO NOT ARM IN PHASE B.2. *** Phase B.2
// pre-commit correction: B.2 does not yet guarantee every newly-created
// tenant receives the new commercial shape (no live writer exists yet), so
// activating a real cutoff now could brand a legitimately-in-flight new
// tenant (created after the cutoff, before the future commercial writer is
// wired) as "broken" for no fault of its own. `null` means "cutoff not yet
// activated" -- every commercial === null tenant, old or new, resolves
// permissively (see resolveTenantEntitlements's `commercial === null`
// branch) with reason 'commercial_enforcement_not_activated', matching
// today's real, unrestricted behavior exactly.
//
// ACTIVATION (a LATER, separately reviewed phase's job, once new-tenant
// creation is guaranteed to always write valid commercial state): set this
// to a real ISO timestamp, as a single, obvious, named, exported constant
// so that change is a one-line reviewable diff, not a hunt through the
// codebase. From that point on, a tenant_config record's own immutable
// `createdAt` (stamped once, on that tenant's very first write, never
// patchable afterward -- tenantConfigStore.js's upsertTenantConfig:
// `createdAt: existing?.createdAt ?? now`) becomes the zero-migration
// signal for "did this tenant predate the cutoff" -- avoiding the need to
// write an explicit grandfathered marker onto every existing tenant_config
// record (which would itself require a forbidden production migration).
// Phase B.2 does not choose this date -- that is explicitly a later
// phase's decision, made once the precondition above is actually true.
export const COMMERCIAL_ENFORCEMENT_CUTOFF = null

// Only ever called from the branch that has already confirmed the cutoff
// is non-null -- this function never Date-parses a null cutoff.
function isBeforeCutoff(isoTimestamp, cutoff) {
  const cutoffMs = Date.parse(cutoff)
  const t = Date.parse(isoTimestamp)
  // An unparseable/missing createdAt is never treated as "definitely
  // legacy" -- falls through to the fail-closed path instead.
  if (!Number.isFinite(t)) return false
  return t < cutoffMs
}

// Test-only seam (mirrors this codebase's established _set.../_reset...
// convention -- tenants.js's _setLocationCatalogRegistryForTests,
// contentAssetStore.js's _setUploadLockRenewIntervalMsForTests, etc.): lets
// a test exercise the "cutoff IS activated" branch without waiting for a
// real, later phase to arm the production constant above. Production code
// never calls either function; the real constant is used whenever no
// override has been set.
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
// RESOLUTION_FAILURE_STATUSES, never a real writable status.
function unresolvedBundle({ commercialStatus, reason }) {
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
function legacyUnmanagedBundle(reason) {
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
  // function never writes anything back to tenant_config (Phase B.2 is
  // read-only plumbing). A trial past its endsAt with no conversion is
  // treated as suspended immediately, with NO additional grace period,
  // per Phase B.2's explicit trial-expiry policy. Persisting this
  // transition (so e.g. an admin listing shows it without re-resolving) is
  // deferred to a later phase.
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
    // Phase B.2 pre-commit correction: `hardSafetyOverrideApproved` is
    // destructured out and deliberately UNUSED here -- there is no
    // reviewed administrative safety-override mechanism yet, so this field
    // has NO EFFECT on resolver output in B.2. It is kept in the schema
    // only for future compatibility (see planEntitlements.js's
    // clampToSafetyCeiling for the matching comment). Every Enterprise
    // limitsOverride is unconditionally clamped to Phase A's platform
    // safety ceiling until a separately reviewed administrative control
    // exists to make this flag operative.
    const { hardSafetyOverrideApproved: _reservedForFutureReview, ...overrideLimits } = override
    planLimits = clampToSafetyCeiling({ ...base.limits, ...overrideLimits })
  }

  // Commercial-status effect table (Phase B.2 design): only 'active' and
  // 'trial' grant real features/limits. Every other status (past_due,
  // suspended, canceled, or a just-computed trial_expired->suspended)
  // collapses to deny-all -- WITHOUT changing `plan`/`effectivePlan` (an
  // owner should see "you're on Growth, suspended," never "you have no
  // plan"). No endpoint consults this yet (Phase B.2 is plumbing only).
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

// The ONE authoritative server-side entitlement resolver. Takes ONLY a
// tenantId -- deliberately no second parameter for a caller to inject a
// plan/limits/features override, so "no endpoint trusts browser-supplied
// plan/limits/features" is true by construction, not by caller discipline.
// Always re-derives from the server-side store; never caches across calls.
export async function resolveTenantEntitlements(tenantId) {
  // 1. BOOTSTRAP tenants (Los Tres Amigos) never consult tenant_config for
  //    this decision at all -- identical in spirit to tenants.js's own
  //    location-catalog checks. Redis contents can never override this,
  //    whether or not a record exists, whether or not Redis is reachable.
  if (locationCatalogModeFor(tenantId) === LocationCatalogMigrationMode.BOOTSTRAP) {
    return legacyUnmanagedBundle('bootstrap_legacy')
  }

  let config
  try {
    config = await getTenantConfig(tenantId)
  } catch (err) {
    console.error(`[entitlements] could not resolve tenant config for ${JSON.stringify(tenantId)}: ${err instanceof TenantConfigStoreUnavailableError ? err.message : err}`)
    return unresolvedBundle({ commercialStatus: 'unknown', reason: 'resolution_failed' })
  }

  if (config === null) {
    // A definitively-absent record for a non-BOOTSTRAP tenant id is never
    // legitimate (createNewTenant() always writes one immediately) --
    // treated as a confirmed misconfiguration, not "don't know."
    return unresolvedBundle({ commercialStatus: 'unconfigured', reason: 'no_tenant_config' })
  }

  const commercial = config.commercial ?? null

  if (commercial === null) {
    const cutoff = activeCutoff()
    // PHASE B.2 PRE-COMMIT CORRECTION: while the cutoff is not yet
    // activated (the real production default), EVERY commercial === null
    // tenant -- old or brand new -- resolves permissively. This is
    // deliberate: B.2 has no live writer yet, so a newly-created tenant
    // legitimately has no commercial state through no fault of its own.
    if (cutoff === null) {
      return legacyUnmanagedBundle('commercial_enforcement_not_activated')
    }
    // CRITICAL RESOLVER CORRECTION #1 (live only once the cutoff above is
    // eventually armed by a later, separately reviewed phase): distinguish
    // an explicitly grandfathered pre-cutoff tenant from a genuinely
    // broken/incomplete new one, using the tenant_config record's own
    // immutable createdAt. Never Date-parses a null cutoff -- `cutoff` is
    // already confirmed non-null on this line.
    if (isBeforeCutoff(config.createdAt, cutoff)) {
      return legacyUnmanagedBundle('grandfathered_pre_phase_b')
    }
    return unresolvedBundle({ commercialStatus: 'unconfigured', reason: 'commercial_unconfigured' })
  }

  if (isOldShapeCommercial(commercial)) {
    // CRITICAL RESOLVER CORRECTION #2: never infer a paid/active status
    // from an old-shape record's trialEndsAt -- there is no billing
    // evidence to support that inference. Treated like a grandfathered
    // legacy tenant, but distinctly tagged for later, deliberate migration.
    return legacyUnmanagedBundle('legacy_commercial_shape')
  }

  if (!isNewShapeCommercial(commercial)) {
    return unresolvedBundle({ commercialStatus: 'unconfigured', reason: 'malformed_commercial_state' })
  }

  return resolveNewShapeCommercial(commercial)
}
