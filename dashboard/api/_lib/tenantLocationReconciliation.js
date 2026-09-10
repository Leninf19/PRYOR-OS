// Multi-Tenant Phase 4I.1 -- the Node-side mirror of
// tenant_approved_locations_provider.py's reconciliation contract, for the
// Google credential CONNECT/RECONNECT path rather than the sync path.
//
// "Google authorization determines what a connected credential can
// technically see. PRYOR tenant entitlements (tenantConfigStore.js's
// approvedLocations) determine what PRYOR is actually allowed to operate
// on." A tenant Owner reconnecting Google (revoked credential, employee
// left, Google account changed, permissions moved) MUST be able to swap the
// stored credential -- but that swap must never silently expand OR silently
// degrade the tenant's already-approved/licensed location set. Two distinct
// failure modes this guards against:
//   1. The new credential exposes MORE locations than were ever approved --
//      those extra locations must never become approved merely because
//      they are now visible (approvedLocations is written ONLY by
//      recordLocationApproval(), never by a reconnect -- see
//      google/[action].js's OAuth callback, which calls only
//      setStoredCredential() and never touches tenantConfigStore.js at
//      all). No check is needed for this direction; it is already
//      structurally impossible.
//   2. The new credential CANNOT see one or more already-approved
//      locations (a narrower grant, wrong Google account, or a location
//      unlinked on Google's side). PRYOR must FAIL CLOSED here -- refuse to
//      treat the reconnect as satisfying the tenant's existing entitlement,
//      rather than silently letting the tenant's approvedLocations become
//      unreachable/stale with no signal. This is the check this module
//      provides.
//
// SCOPE: this is a pure, synchronous, dependency-free function plus one
// error class -- the lower-level invariant a FUTURE reconnect flow must
// call after running Google location discovery with the newly-connected
// credential and before treating that reconnect as fully satisfying the
// tenant's current approvedLocations. Per this phase's explicit scope, NO
// OAuth UI, discovery wiring, or live endpoint calls this yet -- it exists,
// tested, so that UI has a correct backend primitive to build on rather
// than inventing its own reconciliation logic later. See the Phase 4I.1
// report for why wiring this into the live OAuth callback is deferred
// rather than done in this phase.

export class UnreconciledApprovedLocationError extends Error {
  constructor(message, missingGoogleLocationIds) {
    super(message)
    this.missingGoogleLocationIds = missingGoogleLocationIds ?? []
  }
}

// `approvedLocations` -- the tenant's current tenantConfigStore.js array
// ({locationId, googleLocationId, title, address}[]). `discoveredGoogleLocationIds`
// -- an iterable of googleLocationId strings a FRESH Google discovery call
// (using the credential being validated) actually returned. Throws
// UnreconciledApprovedLocationError (fail closed) if any approved
// googleLocationId is absent from discovery; otherwise returns normally
// (the credential can see everything this tenant is already entitled to --
// it may ALSO see additional, unapproved locations, which this function
// deliberately ignores: extra visibility is not this function's concern,
// only missing visibility is).
export function reconcileApprovedLocationsAgainstDiscovery(approvedLocations, discoveredGoogleLocationIds) {
  const discovered = new Set(discoveredGoogleLocationIds ?? [])
  const missing = (Array.isArray(approvedLocations) ? approvedLocations : [])
    .map(loc => loc?.googleLocationId)
    .filter(id => typeof id === 'string' && id && !discovered.has(id))

  if (missing.length > 0) {
    throw new UnreconciledApprovedLocationError(
      `${missing.length} approved location(s) (${missing.join(', ')}) are not visible to this Google credential -- refusing to treat this connection as satisfying the tenant's existing approved locations`,
      missing
    )
  }
}
