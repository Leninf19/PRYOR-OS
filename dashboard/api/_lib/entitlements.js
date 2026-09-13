// Phase B.2 -- Commercial Entitlement Foundation: the ONE authoritative
// server-side resolver every future commercial decision must go through.
//
// PHASE B.3 STRUCTURE CHANGE: the pure resolution logic (everything that
// only depends on an already-loaded tenant_config record) now lives in
// entitlementResolution.js, imported and re-exported here unchanged. This
// file adds the one impure step -- actually reading tenant_config (and the
// BOOTSTRAP short-circuit, which needs no read at all) -- on top of it.
// The split exists so tenantConfigStore.js's CAS-bound writers
// (recordLocationApproval()/applyEntitlementChange()) can call the pure
// function directly on the SAME config snapshot their CAS write is bound
// to, instead of this file's resolveTenantEntitlements(tenantId) performing
// a SECOND, independent read (see entitlementResolution.js's header for the
// exact plan-change TOCTOU race that would reopen).
//
// tenant_config.commercial SCHEMA and full RESOLUTION ORDER: see
// entitlementResolution.js's header for the authoritative documentation of
// the schema shape and steps 4-7 (commercial null/old-shape/malformed/
// well-formed). This file documents only the two additional steps below.
//
// RESOLUTION ORDER (this file's own two steps, run BEFORE
// entitlementResolution.js's steps 4-7):
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
//   4-7. Otherwise, delegated entirely to
//      entitlementResolution.js's resolveTenantEntitlementsFromConfig(config).
//
// FAIL-CLOSED POLICY: every failure path returns a real, frozen object --
// this function NEVER throws. A caller that cannot get a real, resolvable
// commercial state gets a bundle whose `features` are all false and whose
// `limits` are all 0 (never null, never a large number) -- "no accidental
// unlimited access." Read-only dashboard access is a SEPARATE concern this
// file does not govern at all (existing per-file/per-location authorization
// in data.js/auth.js is unaffected by anything in this file) -- only
// paid/cost-generating write paths are expected to ever consult this
// resolver (Phase B.3: location and seat additions; see
// tenantConfigStore.js's recordLocationApproval()/applyEntitlementChange()
// and settings/[action].js's invite-user/enable-user).

import { getTenantConfig, TenantConfigStoreUnavailableError } from './tenantConfigStore.js'
import { locationCatalogModeFor, LocationCatalogMigrationMode } from './tenants.js'
import {
  resolveTenantEntitlementsFromConfig, legacyUnmanagedBundle, unresolvedBundle,
} from './entitlementResolution.js'

// Re-exported unchanged so every existing importer of this file (in
// particular tests/test_entitlements.js, already committed in Phase B.2)
// keeps working without modification -- the public surface of this module
// is unchanged by the Phase B.3 internal restructuring.
export {
  COMMERCIAL_STATUSES, RESOLUTION_FAILURE_STATUSES, LEGACY_UNMANAGED_PLAN,
  COMMERCIAL_ENFORCEMENT_CUTOFF, _setCommercialEnforcementCutoffForTests, _resetCommercialEnforcementCutoffForTests,
  isNewShapeCommercial, isOldShapeCommercial, resolveTenantEntitlementsFromConfig,
} from './entitlementResolution.js'

// The ONE authoritative server-side entitlement resolver for callers that
// only have a tenantId in hand (every non-CAS-bound caller -- e.g.
// settings/[action].js's tenantStatus()). Deliberately no second parameter
// for a caller to inject a plan/limits/features override, so "no endpoint
// trusts browser-supplied plan/limits/features" is true by construction,
// not by caller discipline. Always re-derives from the server-side store;
// never caches across calls.
//
// CAS-BOUND CALLERS MUST NOT USE THIS FUNCTION -- see
// entitlementResolution.js's header. Use resolveTenantEntitlementsFromConfig(existing)
// directly on the config snapshot you already loaded instead.
export async function resolveTenantEntitlements(tenantId) {
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
    return unresolvedBundle({ commercialStatus: 'unconfigured', reason: 'no_tenant_config' })
  }

  return resolveTenantEntitlementsFromConfig(config)
}
