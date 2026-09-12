// "Require approved location for Google reply" hardening (Phase A2 of the
// revenue-abuse containment audit) -- closes gbp-publish-unapproved-location:
// a wildcard-grant account (owner/admin/marketing) could previously publish
// a reply to ANY Google location the tenant's stored OAuth credential could
// reach, because resolveLocationIdForReviewOrDeny() (reviewLocationIndex.js)
// returns null (skip the location check) for a wildcard account whenever the
// review isn't in this tenant's own review-location index -- correct for
// "which of MY OWN reviews can I reply to" but silent on "is this location
// even one of mine at all". This module answers that second question
// directly against the tenant's own current Google-location catalog, NEVER
// trusting that Google's OAuth grant reaching a location is itself
// authorization to reply there.
//
// Two tenant shapes, two sources of truth -- see tenants.js's
// LocationCatalogMigrationMode for the full explanation of why these are
// genuinely different tenants, not two code paths for the same concept:
//   - REDIS_ONLY (self-service) tenants: tenantConfigStore.js's
//     approvedLocations is the live, already-authoritative catalog -- the
//     exact same one tenantOwnsLocation() consults for numeric-locationId
//     authorization. Read fresh from Redis on every check; a Redis outage or
//     a missing config both fail CLOSED (never "approved").
//   - The BOOTSTRAP tenant (Los Tres Amigos) predates this catalog by
//     design and has no tenant_config record at all (see
//     tenant_approved_locations_provider.py's own header: "LTA has no
//     separate 'approval' concept; every discovered location is already its
//     established roster"). Its canonical, already-existing "which Google
//     locations are genuinely linked" answer is the SAME
//     `locations.gbp_location_name IS NOT NULL` fact export_chunks.py's
//     export_gbp_sync_status() already reduces to a boolean (`linked`) for
//     gbp-sync.json -- this module reads a SIBLING, `_internal`-only export
//     (never added to data.js's public allowlist, mirroring
//     reviewLocationIndex.js's own security note) carrying the raw Google
//     resource name so it can be matched exactly against a reviewName.

import { readPrivateDataFile, UnknownTenantError } from './reviewDataPaths.js'
import { getTenantConfig, TenantConfigStoreUnavailableError } from './tenantConfigStore.js'
import { locationCatalogModeFor, LocationCatalogMigrationMode } from './tenants.js'

// Strict Google review resource-name shape: accounts/{id}/locations/{id}/reviews/{id}.
// Rejects anything else outright -- including path traversal attempts, extra
// segments, or a bare locationName -- before it is ever interpolated into a
// live Google API URL. `locationResource` is the exact prefix recorded in a
// tenant's approvedLocations[].googleLocationId / the BOOTSTRAP link map.
const REVIEW_RESOURCE_NAME_PATTERN = /^accounts\/([^/]+)\/locations\/([^/]+)\/reviews\/([^/]+)$/

export function parseGoogleReviewResourceName(reviewName) {
  if (typeof reviewName !== 'string') return null
  const match = REVIEW_RESOURCE_NAME_PATTERN.exec(reviewName)
  if (!match) return null
  const [, accountId, locationId] = match
  return { locationResource: `accounts/${accountId}/locations/${locationId}`, full: reviewName }
}

// --- BOOTSTRAP-tenant linked-location index --------------------------------
// Cached in-module after first read per warm serverless instance, exactly
// like reviewLocationIndex.js's own loadIndex() -- regenerated only by the
// export pipeline, so re-reading on every request would be pure waste.
const bootstrapLinkMapCache = new Map()
let testOverride = null

export function _setGbpLocationLinkMapForTests(map) {
  testOverride = map
  bootstrapLinkMapCache.clear()
}
export function _resetGbpLocationLinkMapForTests() {
  testOverride = null
  bootstrapLinkMapCache.clear()
}

async function loadBootstrapLinkMap(tenantId) {
  if (testOverride !== null) return testOverride
  if (bootstrapLinkMapCache.has(tenantId)) return bootstrapLinkMapCache.get(tenantId)
  let map
  try {
    const raw = await readPrivateDataFile(tenantId, '_internal/gbp-location-link-map.json')
    map = JSON.parse(raw)
  } catch (err) {
    // Missing/corrupted/not-yet-exported index fails CLOSED -- an empty map
    // authorizes nothing, exactly the "cannot authoritatively map this
    // location, refuse" behavior this hardening pass requires. Never thrown
    // further: an export lag must degrade to "deny", not to a 500.
    if (!(err instanceof UnknownTenantError) && err.code !== 'ENOENT') {
      console.error(`[gbpLocationAuthorization] could not load the BOOTSTRAP linked-location map for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
    }
    map = {}
  }
  bootstrapLinkMapCache.set(tenantId, map)
  return map
}

// The one function google/[action].js's publish() calls. Returns true only
// when `locationResource` (an "accounts/*/locations/*" prefix, never a full
// review path) is a location this tenant's OWN, current catalog actually
// contains -- never inferred from whether the tenant's Google credential can
// merely reach it. Fails closed (false) on any read/store error.
export async function isApprovedGoogleLocationForTenant(tenantId, locationResource) {
  if (typeof locationResource !== 'string' || !locationResource) return false

  if (locationCatalogModeFor(tenantId) === LocationCatalogMigrationMode.BOOTSTRAP) {
    const map = await loadBootstrapLinkMap(tenantId)
    return Object.prototype.hasOwnProperty.call(map, locationResource)
  }

  let config
  try {
    config = await getTenantConfig(tenantId)
  } catch (err) {
    if (!(err instanceof TenantConfigStoreUnavailableError)) throw err
    console.error(`[gbpLocationAuthorization] tenant_config store unavailable while authorizing a Google reply for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
    return false
  }
  if (!config) return false
  return (config.approvedLocations ?? []).some(
    loc => loc.googleLocationId === locationResource && loc.operational !== false
  )
}
