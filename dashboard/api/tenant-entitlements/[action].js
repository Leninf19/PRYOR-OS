// Multi-Tenant Phase 4I.3 -- POST/GET /api/tenant-entitlements?action=... --
// the ONLY supported way to change an already-committed tenant's
// approvedLocations after onboarding. Platform-super-admin-only.
//
// WHY A SEPARATE ROUTE (not a new action on the existing, deliberately
// READ-ONLY tenant-ops/[action].js, and not the ordinary Owner-only
// google/[action].js's approveLocations()): tenant-ops/[action].js's own
// header states, and tests/test_tenant_ops_endpoint.js enforces, that it
// NEVER mutates -- mixing a mutation into it would silently weaken an
// already-tested invariant. approveLocations() is scoped to the
// AUTHENTICATED OWNER'S OWN tenant and is (by Phase 4I.1 design) only
// usable pre-commitment; it must never become the platform's cross-tenant
// entitlement-editing surface. This file is the 12th and FINAL serverless
// function this project can add under Vercel Hobby's per-deployment
// ceiling (see tenant-ops/[action].js's own header) -- there is no more
// room for a 13th; any future top-level route requires consolidating an
// existing one first.
//
// AUTHORIZATION: isSuperAdmin(account) (auth.js) -- the SAME narrow gate
// tenant-ops/[action].js uses (today: only Los Tres Amigos's own Owner
// accounts). The acting admin's OWN identity/tenant is always
// server-derived from their session (requireAuth), never from request
// input. The TARGET tenant, by contrast, is necessarily admin-SELECTED
// request input (a platform admin operates across many tenants by
// design) -- but it is never trusted blindly: every action below
// resolves it through getTenantConfig() (a real, existing tenant_config
// record) before anything else happens, so an attacker who somehow
// reached this far still could not target a tenant that doesn't exist,
// and every actual mutation is additionally bound to an exact
// configVersion (see applyEntitlementChangeAction() below). This is a
// deliberately different trust model from google/[action].js's
// verifiedTenantId (an ordinary Owner's OWN tenant, which must NEVER be
// overridable by request input) -- here, admin-selected cross-tenant
// targeting is the entire point of the endpoint.
//
// GET  ?action=discover&tenantId=t_x -- read-only: this tenant's current
//      approvedLocations (with each entry's `operational` flag) plus a
//      FRESH live discovery of what its own currently-connected Google
//      credential can see right now, so an admin can decide what to add.
// POST ?action=apply { tenantId, addGoogleLocationIds, removeLocationIds,
//      expectedConfigVersion } -- the mutation. Re-discovers FRESH at
//      mutation time (never trusts the GET response as a "session" the
//      way approveLocations() trusts locationDiscoveryStore.js's -- there
//      is no equivalent bearer-capability concept here, deliberately: an
//      admin's own authenticated identity plus a live re-check is the
//      whole authorization chain) and rejects the ENTIRE request if any
//      requested addition is not currently visible -- "discovery
//      visibility does not itself grant entitlement" cuts both ways: an
//      admin cannot grant it either, for a location the credential can't
//      even see right now.

import { requireAuth, isSuperAdmin } from '../_lib/auth.js'
import { isValidTenantId } from '../_lib/tenants.js'
import {
  getTenantConfig, applyEntitlementChange,
  EntitlementChangeNotEligibleError, UnknownLocationRemovalError, LocationAlreadyApprovedError, ConfigVersionConflictError,
  TenantConfigStoreUnavailableError,
} from '../_lib/tenantConfigStore.js'
import { getStoredCredential, CredentialStoreUnavailableError } from '../_lib/credentialStore.js'
import { getAccessToken } from '../google/_lib/googleAuth.js'
import { discoverGoogleLocationsForReconciliation } from '../_lib/googleLocationDiscovery.js'
import { reconcileAccountGrantsAfterLocationRemoval } from '../_lib/userStore.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import { appendAuditEntry, clientIp } from '../_lib/auditLog.js'

function actorFields(account, req) {
  return { actorId: account.userId, actorName: account.displayName ?? account.email, actorEmail: account.email, ip: clientIp(req) }
}

async function requireSuperAdmin(req, res) {
  const account = await requireAuth(req, res, null)
  if (!account) return null
  if (!isSuperAdmin(account)) {
    // Existence-hiding is not meaningful here (not a per-resource lookup a
    // caller could otherwise probe) -- a plain 403 matches tenant-ops/
    // [action].js's own owner-only-action convention exactly.
    res.status(403).json({ error: 'forbidden', message: 'You do not have permission to manage tenant entitlements.' })
    return null
  }
  return account
}

// Discovers this tenant's currently visible Google locations using its OWN
// stored credential. Returns { locations } on success, or { errorResponse }
// (already shaped for res.status(x).json(...)) if the tenant has no usable
// credential or Google itself failed -- callers just check which key is set.
async function discoverForTenant(tenantId) {
  let credential
  try {
    credential = await getStoredCredential(tenantId)
  } catch (err) {
    return { errorResponse: { status: 503, body: { error: 'not_connected', message: err instanceof CredentialStoreUnavailableError ? 'The credential store is temporarily unavailable.' : err.message } } }
  }
  if (!credential || !credential.refreshToken) {
    return { errorResponse: { status: 503, body: { error: 'not_connected', message: 'This tenant has no usable Google connection to discover locations from.' } } }
  }
  let token
  try {
    token = await getAccessToken(credential.refreshToken)
  } catch (err) {
    return { errorResponse: { status: 503, body: { error: 'not_connected', message: err.description || err.message || 'Could not obtain a Google access token for this tenant.' } } }
  }
  try {
    const locations = await discoverGoogleLocationsForReconciliation(token)
    return { locations }
  } catch (err) {
    return { errorResponse: { status: 502, body: { error: 'api_error', message: `Request to Google failed: ${err.message}` } } }
  }
}

async function discover(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireSuperAdmin(req, res)
  if (!account) return

  const tenantId = req.query?.tenantId
  if (typeof tenantId !== 'string' || !isValidTenantId(tenantId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'A valid tenantId query parameter is required.' })
  }

  const allowed = await enforceRateLimit(req, res, `tenant-entitlements:discover:${account.userId}`, { requestsPerWindow: 20, windowSeconds: 60 })
  if (!allowed) return

  let config
  try {
    config = await getTenantConfig(tenantId)
  } catch (err) {
    if (err instanceof TenantConfigStoreUnavailableError) {
      return res.status(503).json({ error: 'service_unavailable', message: 'The tenant configuration store is temporarily unavailable.' })
    }
    throw err
  }
  if (!config) return res.status(404).json({ error: 'not_found', message: 'No tenant config record exists for this tenant id.' })

  const { locations, errorResponse } = await discoverForTenant(tenantId)
  if (errorResponse) return res.status(errorResponse.status).json(errorResponse.body)

  return res.status(200).json({
    tenantId,
    status: config.status,
    configVersion: config.configVersion,
    approvedLocations: (config.approvedLocations ?? []).map(l => ({
      locationId: l.locationId, googleLocationId: l.googleLocationId, title: l.title, address: l.address,
      operational: l.operational !== false,
    })),
    entitlementChange: config.entitlementChange ?? null,
    discoveredLocations: locations,
  })
}

async function auditFailure(tenantId, account, req, action, message, changes = null) {
  await appendAuditEntry(tenantId, {
    ...actorFields(account, req), entity: 'tenant_entitlement', entityId: tenantId,
    action, changes, result: 'denied', message,
  })
}

async function apply(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireSuperAdmin(req, res)
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `tenant-entitlements:apply:${account.userId}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  const { tenantId, addGoogleLocationIds, removeLocationIds, expectedConfigVersion } = req.body ?? {}
  if (typeof tenantId !== 'string' || !isValidTenantId(tenantId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'A valid tenantId is required.' })
  }
  const addIds = Array.isArray(addGoogleLocationIds) ? addGoogleLocationIds : []
  const removeIds = Array.isArray(removeLocationIds) ? removeLocationIds : []
  if (!addIds.every(id => typeof id === 'string' && id) || !removeIds.every(id => Number.isInteger(id) && id > 0)) {
    return res.status(400).json({ error: 'invalid_request', message: 'addGoogleLocationIds must be strings and removeLocationIds must be positive integers.' })
  }
  if (addIds.length === 0 && removeIds.length === 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'At least one addition or removal is required.' })
  }
  if (!Number.isInteger(expectedConfigVersion) || expectedConfigVersion < 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'expectedConfigVersion is required.' })
  }

  let existing
  try {
    existing = await getTenantConfig(tenantId)
  } catch (err) {
    if (err instanceof TenantConfigStoreUnavailableError) {
      return res.status(503).json({ error: 'service_unavailable', message: 'The tenant configuration store is temporarily unavailable.' })
    }
    throw err
  }
  if (!existing) return res.status(404).json({ error: 'not_found', message: 'No tenant config record exists for this tenant id.' })

  // Multi-Tenant Phase 4I.3: "discovery visibility does not itself grant
  // entitlement" -- verified HERE, fresh, at mutation time, against the
  // tenant's OWN currently-connected credential, never trusted from a
  // prior GET /discover response (which could be stale by the time this
  // request lands). ANY requested addition not currently visible fails
  // the WHOLE request closed -- no partial mutation.
  let addGoogleLocations = []
  if (addIds.length > 0) {
    const { locations, errorResponse } = await discoverForTenant(tenantId)
    if (errorResponse) {
      await auditFailure(tenantId, account, req, 'entitlement.change_rejected_discovery_failed', 'Could not verify requested additions: discovery failed.', { addGoogleLocationIds: addIds })
      return res.status(errorResponse.status).json(errorResponse.body)
    }
    const byId = new Map(locations.map(l => [l.googleLocationId, l]))
    const unverified = addIds.filter(id => !byId.has(id))
    if (unverified.length > 0) {
      await auditFailure(tenantId, account, req, 'entitlement.change_rejected_unverified_location', `${unverified.length} requested addition(s) are not currently visible to this tenant's Google credential.`, { unverifiedGoogleLocationIds: unverified })
      return res.status(400).json({ error: 'unverified_location', message: 'One or more requested locations are not currently visible to this tenant\'s connected Google credential.', unverifiedGoogleLocationIds: unverified })
    }
    addGoogleLocations = addIds.map(id => byId.get(id))
  }

  const oldApprovedLocations = existing.approvedLocations ?? []

  let result
  try {
    result = await applyEntitlementChange(tenantId, { addGoogleLocations, removeLocationIds: removeIds }, expectedConfigVersion)
  } catch (err) {
    if (err instanceof EntitlementChangeNotEligibleError) {
      await auditFailure(tenantId, account, req, 'entitlement.change_rejected_not_eligible', `Rejected: tenant status is ${JSON.stringify(err.currentStatus)}.`, { currentStatus: err.currentStatus })
      return res.status(409).json({ error: 'not_eligible', message: err.message, currentStatus: err.currentStatus })
    }
    if (err instanceof UnknownLocationRemovalError) {
      await auditFailure(tenantId, account, req, 'entitlement.change_rejected_unknown_location', err.message, { unknownLocationIds: err.unknownLocationIds })
      return res.status(400).json({ error: 'unknown_location', message: err.message, unknownLocationIds: err.unknownLocationIds })
    }
    if (err instanceof LocationAlreadyApprovedError) {
      await auditFailure(tenantId, account, req, 'entitlement.change_rejected_already_approved', err.message, { googleLocationIds: err.googleLocationIds })
      return res.status(400).json({ error: 'already_approved', message: err.message, googleLocationIds: err.googleLocationIds })
    }
    if (err instanceof ConfigVersionConflictError) {
      await auditFailure(tenantId, account, req, 'entitlement.change_rejected_stale_version', `Rejected: expected configVersion ${expectedConfigVersion}, tenant config has moved on.`, { expectedConfigVersion })
      return res.status(409).json({ error: 'stale_config_version', message: 'This tenant\'s configuration has changed since it was last read. Reload and try again.' })
    }
    if (err instanceof TenantConfigStoreUnavailableError) {
      return res.status(503).json({ error: 'service_unavailable', message: 'The tenant configuration store is temporarily unavailable.' })
    }
    throw err
  }

  // Multi-Tenant Phase 4I.3, item 6: best-effort account-grant hygiene --
  // failure here must never undo the already-committed entitlement change
  // (tenantOwnsLocation() already enforces the new boundary regardless);
  // it is reported alongside the success entry, not treated as a reason
  // to fail the request.
  let accountReconciliation = { narrowed: [], emptied: [] }
  if (removeIds.length > 0) {
    try {
      accountReconciliation = await reconcileAccountGrantsAfterLocationRemoval(tenantId, removeIds)
    } catch (err) {
      console.error(`[tenant-entitlements] account-grant reconciliation failed for ${tenantId}: ${err.message}`)
    }
  }

  await appendAuditEntry(tenantId, {
    ...actorFields(account, req), entity: 'tenant_entitlement', entityId: tenantId,
    action: 'entitlement.changed',
    changes: {
      oldApprovedGoogleLocationIds: oldApprovedLocations.map(l => l.googleLocationId),
      newApprovedGoogleLocationIds: result.config.approvedLocations.map(l => l.googleLocationId),
      addedLocationIds: result.addedLocationIds,
      removedLocationIds: result.removedLocationIds,
      configVersionBefore: expectedConfigVersion,
      configVersionAfter: result.config.configVersion,
      accountsNarrowed: accountReconciliation.narrowed,
      accountsEmptied: accountReconciliation.emptied,
    },
    result: 'success',
    message: `Entitlement change applied: +${result.addedLocationIds.length} / -${result.removedLocationIds.length} location(s).`,
  })

  return res.status(200).json({
    success: true,
    tenantId,
    configVersion: result.config.configVersion,
    addedLocationIds: result.addedLocationIds,
    removedLocationIds: result.removedLocationIds,
    entitlementChange: result.config.entitlementChange,
    accountReconciliation,
  })
}

export default async function handler(req, res) {
  switch (req.query?.action) {
    case 'discover': return discover(req, res)
    case 'apply':     return apply(req, res)
    default:          return res.status(404).json({ error: 'not_found' })
  }
}
