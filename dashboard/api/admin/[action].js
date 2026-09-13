// Platform-super-admin-only actions -- POST/GET /api/admin?action=...
// This file merges THREE formerly-separate top-level routes that all
// shared the exact same isSuperAdmin(account) authorization gate:
// access-code management (Phase 4Q.1, originally this file),
// tenant-ops/[action].js (Phase 4H.1, read-only tenant status), and
// tenant-entitlements/[action].js (Phase 4I.3, cross-tenant location
// entitlement changes).
//
// WHY THIS MERGE, REVERSING THE EARLIER "keep separate" DECISION: this
// file's own prior header explicitly said "do NOT add this to
// tenant-entitlements/[action].js as a permanent home" and assumed a
// Vercel Pro upgrade (removing Hobby's 12-function ceiling) would land
// before this file was ever deployed. That upgrade never happened, this
// file WAS deployed anyway (main now has 13 top-level api/ routes), and
// Vercel Hobby's actual packaging now rejects the deployment outright
// ("No more than 12 Serverless Functions can be added ... on the Hobby
// plan"). PRYOR OS Vercel Serverless Function Count Reduction phase:
// given an explicit instruction NOT to upgrade the plan yet, and given
// all three routes already enforce the IDENTICAL isSuperAdmin gate (never
// a broader or narrower one -- verified against each original file before
// merging), merging them is safe and reduces the deployed function count
// by 2 with zero change to who can call what. Every action below is
// byte-for-byte the same handler logic as its original file; only the
// dispatch table changed.
//
// AUTHORIZATION: isSuperAdmin(account) (auth.js) for every action in this
// file -- today: only Los Tres Amigos's own Owner accounts. No new
// authorization system, no action here is gated any differently than it
// was in its original standalone file. The acting admin's OWN identity is
// always server-derived from their session (requireAuth), never from
// request input.
//
// Action namespace (each prefixed by its origin domain to avoid collision
// and stay self-documenting):
//   list-access-codes / create-access-code / revoke-access-code
//     -- access-code management (originally this file)
//   tenant-list
//     -- read-only tenant status list (originally tenant-ops/[action].js);
//        NEVER mutates tenant_config, NEVER calls provision_tenant.py/
//        initial_sync.py, NEVER dispatches a GitHub Actions workflow --
//        mutation happens exclusively through
//        .github/workflows/tenant-lifecycle.yml (human-operated,
//        confirmation-gated dispatch). This route exists only so an
//        operator can SEE current state before deciding what to dispatch
//        there.
//   tenant-entitlements-discover / tenant-entitlements-apply
//     -- cross-tenant approvedLocations changes after onboarding
//        (originally tenant-entitlements/[action].js) -- the ONLY
//        supported way to change an already-committed tenant's
//        approvedLocations. Re-discovers FRESH at mutation time (never
//        trusts the GET response as a session-like capability):
//        "discovery visibility does not itself grant entitlement" cuts
//        both ways -- an admin cannot grant an entitlement for a location
//        the credential can't currently see either.

import { requireAuth, isSuperAdmin } from '../_lib/auth.js'
import { resolveTenantId } from '../_lib/tenants.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import { appendAuditEntry, clientIp } from '../_lib/auditLog.js'
import {
  createAccessCode, listAccessCodes, revokeAccessCode, getAccessCodeByHash,
  AccessCodeStoreUnavailableError,
} from '../_lib/accessCodeStore.js'
import { isValidPlanId } from '../_lib/plans.js'
import { isValidTenantId } from '../_lib/tenants.js'
import {
  getTenantConfig, listTenantConfigs, applyEntitlementChange,
  EntitlementChangeNotEligibleError, UnknownLocationRemovalError, LocationAlreadyApprovedError, ConfigVersionConflictError,
  MaxLocationsExceededError,
  TenantConfigStoreUnavailableError,
} from '../_lib/tenantConfigStore.js'
import { getStoredCredential, CredentialStoreUnavailableError } from '../_lib/credentialStore.js'
import { getAccessToken } from '../google/_lib/googleAuth.js'
import { discoverGoogleLocationsForReconciliation } from '../_lib/googleLocationDiscovery.js'
import { reconcileAccountGrantsAfterLocationRemoval } from '../_lib/userStore.js'

// message is the exact text each original standalone file returned for
// its own 403 -- preserved per-caller (not unified into one generic
// string) purely for least-surprise continuity; nothing tests it by exact
// string today, but there's no reason to change behavior no one asked to
// change.
async function requireSuperAdmin(req, res, message = 'You do not have permission to perform this action.') {
  const account = await requireAuth(req, res, null)
  if (!account) return null
  if (!isSuperAdmin(account)) {
    res.status(403).json({ error: 'forbidden', message })
    return null
  }
  return account
}

// --- Access-code management (originally this file) -----------------------

// Never returns the raw code (it was never stored) -- listing is always
// safe to show in full, including redemptions[] (tenantId/userId/
// redeemedAt only, never a token/code).
async function listAccessCodesAction(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireSuperAdmin(req, res)
  if (!account) return
  try {
    const codes = await listAccessCodes()
    return res.status(200).json({ codes })
  } catch (err) {
    if (err instanceof AccessCodeStoreUnavailableError) {
      console.error(`[admin/list-access-codes] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'This is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// POST { prefix, plan, discountPercent?, discountFixedCents?, trialDays?,
//        paymentRequired?, expiresAt?, maxRedemptions?, allowedEmail?,
//        allowedEmailDomain?, clientLabel? }
async function createAccessCodeAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireSuperAdmin(req, res)
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `admin-create-access-code:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const {
    prefix, plan, discountPercent = null, discountFixedCents = null, trialDays = null,
    paymentRequired = true, expiresAt = null, maxRedemptions = 1,
    allowedEmail = null, allowedEmailDomain = null, clientLabel = null,
  } = req.body ?? {}

  if (!isValidPlanId(plan)) {
    return res.status(400).json({ error: 'invalid_request', message: 'A valid plan is required.' })
  }
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9-]{2,20}$/.test(prefix)) {
    return res.status(400).json({ error: 'invalid_request', message: 'Prefix must be 2-20 letters, digits, or hyphens.' })
  }
  if (discountPercent != null && discountFixedCents != null) {
    return res.status(400).json({ error: 'invalid_request', message: 'Choose either a percentage or a fixed discount, not both.' })
  }
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1 || maxRedemptions > 100000) {
    return res.status(400).json({ error: 'invalid_request', message: 'Max redemptions must be a positive integer.' })
  }
  if (expiresAt != null && Number.isNaN(new Date(expiresAt).getTime())) {
    return res.status(400).json({ error: 'invalid_request', message: 'Expiration must be a valid date.' })
  }

  try {
    const { rawCode, record } = await createAccessCode({
      prefix: prefix.toUpperCase(), plan, discountPercent, discountFixedCents, trialDays,
      paymentRequired: Boolean(paymentRequired), expiresAt, maxRedemptions,
      allowedEmail, allowedEmailDomain, clientLabel, createdBy: account.userId,
    })

    await appendAuditEntry(resolveTenantId(account), {
      actorId: account.userId, actorEmail: account.email, ip: clientIp(req),
      action: 'access_code.created', entity: 'access_code', entityId: record.codeHash,
      result: 'success',
      message: `Created access code (plan: ${plan}, maxRedemptions: ${maxRedemptions}${clientLabel ? `, client: ${clientLabel}` : ''}).`,
    })

    // rawCode is returned to the admin's OWN response exactly once -- it
    // is never included in the audit entry above, never logged elsewhere.
    return res.status(200).json({ rawCode, code: record })
  } catch (err) {
    if (err instanceof AccessCodeStoreUnavailableError) {
      console.error(`[admin/create-access-code] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'This is temporarily unavailable. Please try again shortly.' })
    }
    if (err instanceof TypeError) {
      return res.status(400).json({ error: 'invalid_request', message: err.message })
    }
    throw err
  }
}

// POST { codeHash }
async function revokeAccessCodeAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireSuperAdmin(req, res)
  if (!account) return

  const { codeHash } = req.body ?? {}
  if (typeof codeHash !== 'string' || !codeHash) {
    return res.status(400).json({ error: 'invalid_request', message: 'codeHash is required.' })
  }

  try {
    const existing = await getAccessCodeByHash(codeHash)
    if (!existing) {
      return res.status(404).json({ error: 'not_found', message: 'No such access code.' })
    }
    const updated = await revokeAccessCode(codeHash)
    await appendAuditEntry(resolveTenantId(account), {
      actorId: account.userId, actorEmail: account.email, ip: clientIp(req),
      action: 'access_code.revoked', entity: 'access_code', entityId: codeHash,
      result: 'success', message: `Revoked access code (plan: ${existing.plan}).`,
    })
    return res.status(200).json({ code: updated })
  } catch (err) {
    if (err instanceof AccessCodeStoreUnavailableError) {
      console.error(`[admin/revoke-access-code] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'This is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// --- Read-only tenant status (originally tenant-ops/[action].js) ---------

// SANITIZATION: the response is an explicit allowlist of fields, never a
// spread of the raw tenant_config record or a raw credential object --
// approvedLocations (Google resource ids/addresses), locationIdMap,
// reviewDbBlobKey/privateDataPrefix, and any refreshToken are all
// deliberately excluded. getStoredCredential()'s return value is reduced
// to a single boolean (hasGoogleCredential) before it ever reaches this
// response -- the decrypted token itself is discarded immediately, never
// serialized.
//
// MIRRORS the real, authoritative precondition sets initial_sync.py's
// _ELIGIBLE_STATUSES / provision_tenant.py's _PROVISIONABLE_STATUSES
// enforce server-side. Informational ONLY: this page never performs the
// operation itself, so a drift here is a UX bug, never a security bug --
// the Python scripts re-validate every precondition themselves regardless
// of what this page displays.
const PROVISIONING_ELIGIBLE_STATUSES = new Set(['locations_approved', 'provisioning', 'provisioning_failed', 'provisioned', 'active'])
const INITIAL_SYNC_ELIGIBLE_STATUSES = new Set(['provisioned', 'initial_sync_failed'])

async function resolveHasGoogleCredential(tenantId) {
  try {
    const credential = await getStoredCredential(tenantId)
    return Boolean(credential && credential.refreshToken)
  } catch (err) {
    if (err instanceof CredentialStoreUnavailableError) return null
    throw err
  }
}

function sanitizeTenant(config, hasGoogleCredential) {
  const provisioning = config.provisioning ?? {}
  const initialSync = config.initialSync ?? {}
  const entitlementChange = config.entitlementChange ?? {}
  return {
    tenantId: config.tenantId,
    displayName: config.displayName ?? config.tenantId,
    status: config.status,
    storageMode: config.storageMode,
    approvedLocationCount: Array.isArray(config.approvedLocations) ? config.approvedLocations.length : 0,
    provisioning: {
      status: provisioning.status ?? 'none',
      lastAttemptAt: provisioning.lastAttemptAt ?? null,
      artifactGeneration: provisioning.artifactGeneration ?? null,
    },
    initialSync: {
      status: initialSync.status ?? 'none',
      startedAt: initialSync.startedAt ?? null,
      completedAt: initialSync.completedAt ?? null,
      failedAt: initialSync.failedAt ?? null,
      reviewCount: initialSync.reviewCount ?? null,
      locationCount: initialSync.locationCount ?? null,
      // lastError is already a sanitized, operator-safe string by
      // construction -- see initial_sync.py's _safe_error()/
      // provision_tenant.py's own str(e) usage, neither of which ever
      // embeds a credential, token, or raw review text. Never a stack
      // trace: both scripts catch at their own top level and store only
      // "{ExceptionClassName}: {message}".
      lastError: initialSync.lastError ?? provisioning.lastError ?? null,
    },
    // Read-only visibility into whether a platform-admin entitlement
    // change (tenant-entitlements-apply below) is still awaiting its
    // data-plane follow-up. Never a mutation surface -- this action
    // remains exactly as read-only as before this merge;
    // addedLocationIds/removedLocationIds are numeric ids/counts only,
    // not raw Google resource identifiers.
    entitlementChange: {
      status: entitlementChange.status ?? 'none',
      requestedAt: entitlementChange.requestedAt ?? null,
      completedAt: entitlementChange.completedAt ?? null,
      failedAt: entitlementChange.failedAt ?? null,
      pendingAdditionCount: Array.isArray(entitlementChange.addedLocationIds) ? entitlementChange.addedLocationIds.length : 0,
      lastError: entitlementChange.lastError ?? null,
    },
    hasGoogleCredential,
    eligibility: {
      canProvision: PROVISIONING_ELIGIBLE_STATUSES.has(config.status) && config.storageMode === 'BLOB',
      canInitialSync: INITIAL_SYNC_ELIGIBLE_STATUSES.has(config.status) && config.storageMode === 'BLOB',
    },
  }
}

async function tenantListAction(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireSuperAdmin(req, res, 'You do not have permission to view tenant operations.')
  if (!account) return

  // Never cached -- an operator watching this page while a GitHub Actions
  // run is in flight must see fresh state on every poll, never a stale
  // shared/CDN-cached snapshot.
  res.setHeader('Cache-Control', 'private, no-store')

  let configs
  try {
    configs = await listTenantConfigs()
  } catch (err) {
    if (err instanceof TenantConfigStoreUnavailableError) {
      return res.status(503).json({ error: 'service_unavailable', message: 'The tenant configuration store is temporarily unavailable.' })
    }
    throw err
  }

  const tenants = await Promise.all(configs.map(async config => {
    const hasGoogleCredential = await resolveHasGoogleCredential(config.tenantId)
    return sanitizeTenant(config, hasGoogleCredential)
  }))
  tenants.sort((a, b) => a.tenantId.localeCompare(b.tenantId))

  return res.status(200).json({ tenants })
}

// --- Cross-tenant entitlement changes (originally tenant-entitlements/[action].js) --

function actorFields(account, req) {
  return { actorId: account.userId, actorName: account.displayName ?? account.email, actorEmail: account.email, ip: clientIp(req) }
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

async function tenantEntitlementsDiscoverAction(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireSuperAdmin(req, res, 'You do not have permission to manage tenant entitlements.')
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

async function auditEntitlementFailure(tenantId, account, req, action, message, changes = null) {
  await appendAuditEntry(tenantId, {
    ...actorFields(account, req), entity: 'tenant_entitlement', entityId: tenantId,
    action, changes, result: 'denied', message,
  })
}

async function tenantEntitlementsApplyAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireSuperAdmin(req, res, 'You do not have permission to manage tenant entitlements.')
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

  // "discovery visibility does not itself grant entitlement" -- verified
  // HERE, fresh, at mutation time, against the tenant's OWN
  // currently-connected credential, never trusted from a prior
  // tenant-entitlements-discover response (which could be stale by the
  // time this request lands). ANY requested addition not currently
  // visible fails the WHOLE request closed -- no partial mutation.
  let addGoogleLocations = []
  if (addIds.length > 0) {
    const { locations, errorResponse } = await discoverForTenant(tenantId)
    if (errorResponse) {
      await auditEntitlementFailure(tenantId, account, req, 'entitlement.change_rejected_discovery_failed', 'Could not verify requested additions: discovery failed.', { addGoogleLocationIds: addIds })
      return res.status(errorResponse.status).json(errorResponse.body)
    }
    const byId = new Map(locations.map(l => [l.googleLocationId, l]))
    const unverified = addIds.filter(id => !byId.has(id))
    if (unverified.length > 0) {
      await auditEntitlementFailure(tenantId, account, req, 'entitlement.change_rejected_unverified_location', `${unverified.length} requested addition(s) are not currently visible to this tenant's Google credential.`, { unverifiedGoogleLocationIds: unverified })
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
      await auditEntitlementFailure(tenantId, account, req, 'entitlement.change_rejected_not_eligible', `Rejected: tenant status is ${JSON.stringify(err.currentStatus)}.`, { currentStatus: err.currentStatus })
      return res.status(409).json({ error: 'not_eligible', message: err.message, currentStatus: err.currentStatus })
    }
    if (err instanceof UnknownLocationRemovalError) {
      await auditEntitlementFailure(tenantId, account, req, 'entitlement.change_rejected_unknown_location', err.message, { unknownLocationIds: err.unknownLocationIds })
      return res.status(400).json({ error: 'unknown_location', message: err.message, unknownLocationIds: err.unknownLocationIds })
    }
    if (err instanceof LocationAlreadyApprovedError) {
      await auditEntitlementFailure(tenantId, account, req, 'entitlement.change_rejected_already_approved', err.message, { googleLocationIds: err.googleLocationIds })
      return res.status(400).json({ error: 'already_approved', message: err.message, googleLocationIds: err.googleLocationIds })
    }
    if (err instanceof ConfigVersionConflictError) {
      await auditEntitlementFailure(tenantId, account, req, 'entitlement.change_rejected_stale_version', `Rejected: expected configVersion ${expectedConfigVersion}, tenant config has moved on.`, { expectedConfigVersion })
      return res.status(409).json({ error: 'stale_config_version', message: 'This tenant\'s configuration has changed since it was last read. Reload and try again.' })
    }
    if (err instanceof MaxLocationsExceededError) {
      // Phase B.3 -- location-limit enforcement (Part A).
      await auditEntitlementFailure(tenantId, account, req, 'entitlement.change_rejected_limit_reached', err.message, { current: err.current, limit: err.limit, requested: err.requested })
      return res.status(409).json({ error: 'location_limit_reached', current: err.current, limit: err.limit, requested: err.requested })
    }
    if (err instanceof TenantConfigStoreUnavailableError) {
      return res.status(503).json({ error: 'service_unavailable', message: 'The tenant configuration store is temporarily unavailable.' })
    }
    throw err
  }

  // Best-effort account-grant hygiene -- failure here must never undo the
  // already-committed entitlement change (tenantOwnsLocation() already
  // enforces the new boundary regardless); it is reported alongside the
  // success entry, not treated as a reason to fail the request.
  let accountReconciliation = { narrowed: [], emptied: [] }
  if (removeIds.length > 0) {
    try {
      accountReconciliation = await reconcileAccountGrantsAfterLocationRemoval(tenantId, removeIds)
    } catch (err) {
      console.error(`[admin/tenant-entitlements-apply] account-grant reconciliation failed for ${tenantId}: ${err.message}`)
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
    case 'list-access-codes':           return listAccessCodesAction(req, res)
    case 'create-access-code':          return createAccessCodeAction(req, res)
    case 'revoke-access-code':          return revokeAccessCodeAction(req, res)
    case 'tenant-list':                 return tenantListAction(req, res)
    case 'tenant-entitlements-discover': return tenantEntitlementsDiscoverAction(req, res)
    case 'tenant-entitlements-apply':    return tenantEntitlementsApplyAction(req, res)
    default:                            return res.status(404).json({ error: 'not_found' })
  }
}
