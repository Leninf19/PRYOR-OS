// Phase B.5 -- commercial feature gating. The ONE centralized place a
// server-side call site decides whether a tenant's plan includes a premium
// product capability -- no endpoint may branch on `plan === 'growth'` (or
// any other entitlement field) inline; that is exactly the "scattered
// commercial logic" this module exists to prevent, mirroring the same
// discipline aiUsageUnits.js/planEntitlements.js already established for
// pricing/weighting.
//
// CRITICAL PRINCIPLE (restated from the phase's own spec): UI hiding is not
// authorization. Every caller of this module must derive its `entitlements`
// argument from a server-side resolveTenantEntitlements(tenantId) call
// (tenantId itself derived from the authenticated account, never from the
// request) -- never from a client-supplied plan/feature/commercialStatus
// value. This module itself performs no I/O and trusts nothing from the
// browser; it only inspects an already-resolved entitlement bundle.
//
// THREE DISTINCT OUTCOMES (never conflated):
//   1. allowed: true                        -- the resolved plan (or the
//      legacy/unmanaged bundle) genuinely includes this feature.
//   2. allowed: false, reason: 'not_included' -- entitlements resolved
//      SUCCESSFULLY to a real plan that simply does not include this
//      feature (e.g. Core). This is the only case a caller may report as
//      "feature_not_available" -- a stable, honest "you'd need to upgrade"
//      signal.
//   3. allowed: false, reason: 'resolver_failure' -- entitlements could NOT
//      be resolved at all (store outage, malformed/missing tenant_config).
//      This must NEVER be reported as "feature_not_available" -- that would
//      misrepresent an infrastructure problem as a product/upgrade
//      decision. Callers should surface a distinct service-unavailable
//      response instead. Fails closed either way (the feature is denied),
//      but the two denials are never the same lie to the customer.
//
// An unrecognized/malformed feature name (a typo, a stale flag) is treated
// identically to `false` -- fails closed, never silently allowed.

import { RESOLUTION_FAILURE_STATUSES } from './entitlementResolution.js'
import { resolveTenantEntitlements } from './entitlements.js'

// Pure. Given an ALREADY-RESOLVED entitlements bundle (from
// resolveTenantEntitlements()/resolveTenantEntitlementsFromConfig()) and a
// feature key, returns one of the three outcomes documented above.
export function requireFeature(entitlements, featureName) {
  if (!entitlements || typeof entitlements !== 'object') {
    return { allowed: false, reason: 'resolver_failure' }
  }
  if (RESOLUTION_FAILURE_STATUSES.includes(entitlements.commercialStatus)) {
    return { allowed: false, reason: 'resolver_failure' }
  }
  const features = entitlements.features ?? {}
  if (typeof featureName !== 'string' || features[featureName] !== true) {
    return { allowed: false, reason: 'not_included' }
  }
  return { allowed: true }
}

// Convenience wrapper for a call site that has not already resolved
// entitlements for some OTHER reason (e.g. an AI-quota check reusing the
// same bundle) -- resolves fresh, then delegates to requireFeature() above.
// Most B.5 call sites already hold a freshly-resolved `entitlements` object
// for another purpose (the AI quota check, a data-file read) and should
// call requireFeature() directly on that SAME object rather than calling
// this a second time, to avoid a redundant resolver round trip.
export async function requireTenantFeature(tenantId, featureName) {
  const entitlements = await resolveTenantEntitlements(tenantId)
  return { ...requireFeature(entitlements, featureName), entitlements }
}
