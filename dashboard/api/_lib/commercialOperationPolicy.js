// Phase B.7 -- commercial status + suspension enforcement. The ONE
// centralized place a server-side call site decides whether a tenant's
// CURRENT commercial status (not its plan -- see below) permits a given
// CLASS of operation right now. No endpoint may branch on
// `commercialStatus === 'suspended'` inline; that is exactly the
// "scattered commercial logic" this module exists to prevent, mirroring
// the discipline featureAuthorization.js (Phase B.5) already established
// for feature flags and aiUsageUnits.js/planEntitlements.js established for
// pricing/weighting.
//
// WHY OPERATION **CLASSES**, NOT PLAN NAMES: this module never asks "is
// this tenant on Growth" -- B.5's featureAuthorization.js already owns
// plan/feature questions, and B.3/B.4 already own NUMERIC quota questions
// (maxLocations/maxActiveUsers/storageBytes/aiAllowanceMonthly, enforced by
// their own existing checks against `entitlements.limits`). This module
// answers a narrower, orthogonal question: "given this tenant's CURRENT
// commercialStatus (trial/active/past_due/suspended/canceled), is THIS KIND
// of action allowed AT ALL right now" -- independent of whether the tenant
// would otherwise be numerically under its plan's limit. A past_due Growth
// tenant with only 2 of its 5 allowed locations approved must still be
// denied a 3rd, even though 3 <= 5 -- that is precisely what CAPACITY_EXPANSION
// exists to block, on top of (never instead of) the existing numeric checks.
//
// CRITICAL PRINCIPLE (restated from B.5, still true here): UI hiding is not
// authorization; a client-supplied commercialStatus is never trusted. Every
// caller must derive `entitlements` from a server-side
// resolveTenantEntitlements(tenantId) (or, for a CAS-bound writer already
// holding a loaded config snapshot, resolveTenantEntitlementsFromConfig(config)
// on that SAME snapshot -- never a second independent read, exactly like
// B.3's location/seat limit checks) -- tenantId itself always derived from
// the authenticated account, never the request.
//
// OPERATION CLASSES and their approved B.7 policy (see the phase's own
// "REQUIRED STATUS MATRIX" for the source of truth this table implements):
//   READ_BASIC            -- historical/basic reads (reviews, tasks, account
//                             state). Always allowed for every real status;
//                             this module isn't even usually called for
//                             these (B.5's premium-data gating is the real
//                             restriction there), included for completeness
//                             and for the "safe on resolver failure" set.
//   SECURITY_MAINTENANCE  -- login-adjacent, password reset, disabling a
//                             user for security reasons, revoking an invite.
//                             Must remain usable during suspension/
//                             cancellation -- an Owner must never be
//                             trapped out of account-security controls
//                             because billing is suspended.
//   RESOURCE_REDUCTION    -- deleting/removing/disabling anything that only
//                             ever SHRINKS footprint or cost (delete a
//                             content asset, remove a location, disable a
//                             user). A financially restricted tenant must
//                             be able to reduce itself back toward a
//                             compliant state -- never blocked merely
//                             because expansion is forbidden.
//   OPERATIONAL_WRITE     -- ordinary day-to-day mutations that neither
//                             expand capacity nor call an external paid
//                             provider on their own (task create/update,
//                             campaign edits, role/location reassignment
//                             among EXISTING seats, accepting an invite that
//                             was already counted as a seat at issue time).
//   COST_GENERATING       -- an action whose primary purpose is to incur
//                             real external cost (sending a customer email,
//                             an AI call not already covered by its own
//                             B.4 quota mechanism). Given the same shape as
//                             OPERATIONAL_WRITE today (both denied once
//                             suspended/canceled) but kept as a distinct,
//                             separately-named class since a future phase
//                             may need to diverge them.
//   INTEGRATION_OPERATION -- Phase B.7 CORRECTION: using ONE class for both
//                             "connect a new Google integration" and
//                             "sync an already-connected tenant" produced
//                             CONTRADICTORY past_due behavior (the approved
//                             product policy is "existing Google review
//                             publishing/sync continues during billing
//                             grace" -- past_due must NOT deny an already-
//                             established integration's ordinary sync).
//                             INTEGRATION_OPERATION is now narrowly an
//                             action against an ALREADY-CONNECTED
//                             integration that does not itself create new
//                             external operational capability (syncing an
//                             already-linked tenant, importing under an
//                             already-established connection). Given the
//                             SAME policy shape as OPERATIONAL_WRITE/
//                             COST_GENERATING: past_due allowed, suspended/
//                             canceled denied.
//   INTEGRATION_EXPANSION -- the class INTEGRATION_OPERATION used to cover:
//                             establishing or replacing operational
//                             integration capability (new Google connect,
//                             a reconnect that creates/replaces the stored
//                             credential) or spending real provider quota
//                             exploring for MORE capacity (discovering GBP
//                             locations to potentially approve). Given the
//                             SAME policy shape as CAPACITY_EXPANSION: no
//                             legitimate reason to establish new integration
//                             capacity, or browse for more capacity to add,
//                             while expansion is frozen (past_due,
//                             suspended, canceled all deny).
//   CAPACITY_EXPANSION    -- anything that would consume MORE of a
//                             plan-limited resource (a new location, a new
//                             invited/enabled seat, an existing user's
//                             authority being expanded beyond what it
//                             already held -- see userManagement.js's
//                             classifyAuthorityChange() for the last of
//                             these, which decides expansion vs. reduction
//                             from the actual before/after state, never
//                             from the endpoint name alone). Denied outright
//                             during past_due (billing grace is NOT a
//                             license to grow), suspended, and canceled --
//                             on top of (never instead of) the existing B.3
//                             numeric maxLocations/maxActiveUsers checks.
//
// RESOLVER-FAILURE SEMANTICS: a resolver failure (RESOLUTION_FAILURE_STATUSES)
// is INFRASTRUCTURE FAILURE, never a commercial decision -- it must never be
// presented to the customer as "you need to upgrade." For "risk" classes
// (OPERATIONAL_WRITE/COST_GENERATING/INTEGRATION_OPERATION/INTEGRATION_EXPANSION/CAPACITY_EXPANSION)
// a resolver failure fails CLOSED (denied, surfaced as 503 by the caller) --
// an unverifiable commercial state must never be treated as "definitely
// fine to proceed" for anything that costs money or grows footprint. For
// "safe" classes (READ_BASIC/SECURITY_MAINTENANCE/RESOURCE_REDUCTION) a
// resolver failure does NOT deny -- blocking a password reset or a
// user-disable merely because the billing resolver is briefly unreachable
// would be actively unsafe (it could trap an Owner out of their own
// account-security controls) and serves no cost-protection purpose, since
// these actions never increase risk or spend. This exact allow/deny split
// on failure is the single most important nuance in this module -- get it
// backwards and either a customer gets trapped during an outage, or a
// suspended tenant's cost path silently opens during one.

import { RESOLUTION_FAILURE_STATUSES, COMMERCIAL_STATUSES, LEGACY_UNMANAGED_PLAN } from './entitlementResolution.js'

export const CommercialOperationClass = Object.freeze({
  READ_BASIC: 'READ_BASIC',
  SECURITY_MAINTENANCE: 'SECURITY_MAINTENANCE',
  RESOURCE_REDUCTION: 'RESOURCE_REDUCTION',
  OPERATIONAL_WRITE: 'OPERATIONAL_WRITE',
  COST_GENERATING: 'COST_GENERATING',
  // Phase B.7 correction: split from a single, too-coarse INTEGRATION_OPERATION.
  INTEGRATION_OPERATION: 'INTEGRATION_OPERATION', // an ALREADY-CONNECTED integration's ordinary use (sync/import) -- allowed past_due
  INTEGRATION_EXPANSION: 'INTEGRATION_EXPANSION', // establishes/replaces integration capability, or explores for more capacity -- denied past_due
  CAPACITY_EXPANSION: 'CAPACITY_EXPANSION',
})

// The single source of truth for the status matrix described above. `true`
// = allowed, `false` = denied. Every entry is a REAL, writable
// COMMERCIAL_STATUSES value (never a RESOLUTION_FAILURE_STATUSES sentinel --
// those are handled separately, before this table is even consulted).
//
// 'trial_pending_activation' (Phase B.8 pre-commit correction) -- an
// access-code trial grant awaiting its first successful initial sync (see
// entitlementResolution.js's own header). Allowed ONLY what onboarding
// itself genuinely needs to reach that activation event: safe reads,
// security/account maintenance, resource reduction (all universally always
// allowed anyway), establishing/exploring the Google integration
// (INTEGRATION_EXPANSION -- connect, discover-locations), and capacity
// expansion bounded by pendingActivationLimits()'s own numeric ceiling
// (CAPACITY_EXPANSION -- approving the tenant's first location; also
// permits inviting teammates up to maxActiveUsers, a deliberately accepted
// side effect since it costs nothing and is bounded). Everything that
// actually costs money or is normal product consumption (OPERATIONAL_WRITE,
// COST_GENERATING, INTEGRATION_OPERATION -- there is no established
// integration yet to "operate") is denied -- AI/storage additionally have
// zero numeric allowance via pendingActivationLimits(), so B.4's existing
// quota checks deny those independently of this table too (belt and
// suspenders, never a single point of failure).
//
// 'complimentary' / 'complimentary_pending_activation' (PRYOR Complimentary
// Restaurant Access Codes) -- given the IDENTICAL policy shape as their
// 'trial' / 'trial_pending_activation' counterparts, respectively.
// Complimentary access is, operationally, a fully-functional (within its
// own bounded numeric limits) product experience exactly like a trial --
// there is no reason for it to be denied any operation class a normal trial
// would be allowed, and the pending variant needs exactly the same bounded
// onboarding capacity (connect Google, approve the first location) for
// exactly the same reason.
const POLICY = Object.freeze({
  [CommercialOperationClass.READ_BASIC]:            Object.freeze({ trial: true, active: true, past_due: true,  suspended: true,  canceled: true,  trial_pending_activation: true,  complimentary: true,  complimentary_pending_activation: true  }),
  [CommercialOperationClass.SECURITY_MAINTENANCE]:  Object.freeze({ trial: true, active: true, past_due: true,  suspended: true,  canceled: true,  trial_pending_activation: true,  complimentary: true,  complimentary_pending_activation: true  }),
  [CommercialOperationClass.RESOURCE_REDUCTION]:    Object.freeze({ trial: true, active: true, past_due: true,  suspended: true,  canceled: true,  trial_pending_activation: true,  complimentary: true,  complimentary_pending_activation: true  }),
  [CommercialOperationClass.OPERATIONAL_WRITE]:     Object.freeze({ trial: true, active: true, past_due: true,  suspended: false, canceled: false, trial_pending_activation: false, complimentary: true,  complimentary_pending_activation: false }),
  [CommercialOperationClass.COST_GENERATING]:       Object.freeze({ trial: true, active: true, past_due: true,  suspended: false, canceled: false, trial_pending_activation: false, complimentary: true,  complimentary_pending_activation: false }),
  [CommercialOperationClass.INTEGRATION_OPERATION]: Object.freeze({ trial: true, active: true, past_due: true,  suspended: false, canceled: false, trial_pending_activation: false, complimentary: true,  complimentary_pending_activation: false }),
  [CommercialOperationClass.INTEGRATION_EXPANSION]: Object.freeze({ trial: true, active: true, past_due: false, suspended: false, canceled: false, trial_pending_activation: true,  complimentary: true,  complimentary_pending_activation: true  }),
  [CommercialOperationClass.CAPACITY_EXPANSION]:    Object.freeze({ trial: true, active: true, past_due: false, suspended: false, canceled: false, trial_pending_activation: true,  complimentary: true,  complimentary_pending_activation: true  }),
})

// Classes safe to ALLOW outright on a genuine resolver failure -- see this
// file's header for the full reasoning. Never expanded casually: adding a
// class here is a claim that the class can NEVER cost money or grow
// footprint, in any endpoint that will ever use it.
const SAFE_ON_RESOLVER_FAILURE = Object.freeze(new Set([
  CommercialOperationClass.READ_BASIC,
  CommercialOperationClass.SECURITY_MAINTENANCE,
  CommercialOperationClass.RESOURCE_REDUCTION,
]))

// Pure. Given an ALREADY-RESOLVED entitlements bundle (from
// resolveTenantEntitlements()/resolveTenantEntitlementsFromConfig()) and an
// operation class, returns one of:
//   { allowed: true }
//   { allowed: false, denialKind: 'commercial_status', commercialStatus, reason }
//     -- a real, current commercial status genuinely forbids this operation
//        class right now. `reason` is the resolver's own already-vetted,
//        safe reason string (e.g. 'trial_expired', 'past_due_grace',
//        'canceled') -- never raw internal state.
//   { allowed: false, denialKind: 'resolver_failure' }
//     -- entitlements could not be resolved at all; this is an
//        infrastructure failure, never a commercial decision, and callers
//        must NEVER report this as "commercial_access_restricted."
// Legacy/unmanaged tenants (LTA BOOTSTRAP, grandfathered pre-cutoff,
// old-shape commercial, or cutoff-disabled -- anything resolving to
// LEGACY_UNMANAGED_PLAN) are ALWAYS allowed, for every operation class,
// preserving current unrestricted operational behavior exactly.
export function requireCommercialOperation(entitlements, operationClass) {
  if (!Object.prototype.hasOwnProperty.call(POLICY, operationClass)) {
    throw new TypeError(`requireCommercialOperation: unrecognized operation class ${JSON.stringify(operationClass)}`)
  }
  if (!entitlements || typeof entitlements !== 'object') {
    return resolverFailureOutcome(operationClass)
  }
  // Legacy/unmanaged is checked by PLAN, not status -- legacyUnmanagedBundle()
  // always reports commercialStatus: 'active' (a real, valid status), but
  // `plan` is the dedicated, never-a-real-plan-id sentinel
  // (LEGACY_UNMANAGED_PLAN) specifically so nothing downstream ever confuses
  // a legacy tenant with a real paid one -- see entitlementResolution.js's
  // own header for why this is the correct signal to check here.
  if (entitlements.plan === LEGACY_UNMANAGED_PLAN) {
    return { allowed: true }
  }
  if (RESOLUTION_FAILURE_STATUSES.includes(entitlements.commercialStatus)) {
    return resolverFailureOutcome(operationClass)
  }
  if (!COMMERCIAL_STATUSES.includes(entitlements.commercialStatus)) {
    // Defensive: the resolver's own closed output set should never produce
    // anything outside COMMERCIAL_STATUSES/RESOLUTION_FAILURE_STATUSES, but
    // an unrecognized status is treated exactly like a resolver failure --
    // never silently allowed.
    return resolverFailureOutcome(operationClass)
  }
  const allowed = POLICY[operationClass][entitlements.commercialStatus] === true
  if (allowed) return { allowed: true }
  return {
    allowed: false,
    denialKind: 'commercial_status',
    commercialStatus: entitlements.commercialStatus,
    reason: entitlements.reason,
  }
}

function resolverFailureOutcome(operationClass) {
  if (SAFE_ON_RESOLVER_FAILURE.has(operationClass)) return { allowed: true }
  return { allowed: false, denialKind: 'resolver_failure' }
}

// Shared response shaping for a denied requireCommercialOperation() check --
// every call site uses this SAME shape rather than hand-rolling its own,
// so the exact error contract (safe enums only, resolver failure never
// disguised as an upgrade prompt) can never drift between endpoints.
// Callers do: `const check = requireCommercialOperation(...); if
// (!check.allowed) { const { status, body } = commercialDenialResponse(check);
// return res.status(status).json(body) }`.
export function commercialDenialResponse(check) {
  if (check.denialKind === 'resolver_failure') {
    return { status: 503, body: { error: 'service_unavailable' } }
  }
  return {
    status: 403,
    body: { error: 'commercial_access_restricted', commercialStatus: check.commercialStatus, reason: check.reason },
  }
}
