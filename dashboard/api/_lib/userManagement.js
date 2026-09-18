// Shared validation/URL-building helpers for the invitation, password-set,
// and password-reset flows -- used by both settings/[action].js (Owner/
// Admin-only invite-user/resend-invite/revoke-invite) and
// session/[action].js (public accept-invite/invite-status/forgot-password/
// reset-password). Split out because both files need the exact same rules;
// duplicating them would risk the two drifting apart.

import { randomUUID } from 'crypto'
import { ROLES, isValidLocationIds } from './accounts.js'
import { listAccounts } from './accountStore.js'

export function generateUserId() {
  return `usr_${randomUUID()}`
}

export function isValidDisplayName(name) {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 100
}

// Owner/Admin are always company-wide by design (the milestone's own role
// definitions: "Owner: all locations", "Admin: all locations") -- a
// location-scoped Owner/Admin would be a confusing, unintended state, so
// this is validated here rather than left to the UI to enforce. Marketing/
// Location Manager/Viewer may be either '*' (company-wide) or an explicit
// location array -- same requireLocationAccess mechanism either way, only
// the ROLE_PERMISSIONS grant differs (see permissions.js).
//
// Multi-Tenant Phase 4K -- accounts.js's isValidLocationIds() now accepts
// an EMPTY array as a well-formed schema value (a location_manager left
// with zero authorized locations after a platform-admin entitlement
// removal -- see userStore.js's reconcileAccountGrantsAfterLocationRemoval()).
// This function deliberately keeps its OWN, STRICTER rule on top of that:
// a human manually assigning a location_manager/marketing/read_only
// account zero locations via this admin-facing endpoint is almost
// certainly a mistake and must still be rejected here. Only the SYSTEM's
// own reconciliation path (which writes via updateUser() directly,
// bypassing this function entirely) may legitimately produce `[]`.
export function validateRoleAndLocations(role, locationIds) {
  if (!ROLES.includes(role)) return { valid: false, message: 'Unrecognized role.' }
  // Deliberately omits { allowEmpty: true } -- this admin-facing manual
  // assignment endpoint keeps requiring a non-empty array (see
  // isValidLocationIds()'s own header comment for why).
  if (!isValidLocationIds(locationIds)) return { valid: false, message: 'locationIds must be "*" or a non-empty array of distinct positive integers.' }
  if ((role === 'owner' || role === 'admin') && locationIds !== '*') {
    return { valid: false, message: `${role === 'owner' ? 'Owner' : 'Admin'} accounts must have company-wide access ("*"), not a specific location list.` }
  }
  return { valid: true, message: null }
}

// Elevation-of-privilege guard: only an existing Owner may invite/assign the
// Owner role. Admin holds USERS_MANAGE (broad user-management ability) but
// must not be able to mint new Owner accounts -- this is the one place that
// distinction is enforced, since permissions.js's USERS_MANAGE grant itself
// doesn't distinguish "manage users" from "manage users up to and including
// Owner".
export function canAssignRole(actingAccountRole, targetRole) {
  if (targetRole === 'owner') return actingAccountRole === 'owner'
  return true
}

// "It must be impossible through the UI or API to disable the last active
// Owner, downgrade the last active Owner, or remove all ownership access
// accidentally." Uses accountStore.js's listAccounts(tenantId) -- the same
// merged, de-duplicated (Redis-wins) view used for GET /api/session/accounts
// and GET /api/settings/users-list -- so a static-directory identity later
// promoted into Redis (password reset) is never counted twice.
//
// Multi-Tenant Phase 4K -- tenantId is now REQUIRED (previously this called
// a global, un-scoped listAccounts()). "Last active Owner" is a PER-TENANT
// property: each tenant needs its own active Owner, independent of every
// other tenant's Owner count -- a Tenant A account being disabled must
// never be blocked (or wrongly allowed) based on Tenant B's Owner roster.
// Every call site MUST pass the ACTING admin's own resolved tenantId (never
// a value derived from the target account or from request input) so this
// check is evaluated within the same tenant boundary the mutation itself
// is confined to.
//
// Returns { safe: true } or { safe: false, message } rather than throwing,
// so callers can shape their own 409 response.
export async function assertNotLastActiveOwner(tenantId, targetUserId) {
  const all = await listAccounts(tenantId)
  const activeOwners = all.filter(a => a.role === 'owner' && !a.disabled)
  const targetIsTheOnlyOne = activeOwners.length === 1 && activeOwners[0].userId === targetUserId
  if (targetIsTheOnlyOne) {
    return { safe: false, message: 'This is the last active Owner account -- promote another account to Owner first.' }
  }
  return { safe: true, message: null }
}

// Phase B.7 pre-commit correction (Part 3) -- classifies a proposed
// role/location/capability change as an ACCESS EXPANSION, a REDUCTION, or
// UNCHANGED, based on the ACTUAL before/after state -- never on the
// endpoint name alone. A single settings action (update-user-role-locations,
// update-user-can-create-tasks) can be used to either expand or reduce an
// existing user's authority; commercialOperationPolicy.js's CAPACITY_EXPANSION
// class must only be consulted when this function says 'expansion' --
// RESOURCE_REDUCTION (always allowed, even suspended/canceled/resolver-down)
// otherwise.
//
// Role authority rank: owner and admin are the top tier (admin holds every
// grant owner does except SETTINGS_ADMIN -- see permissions.js -- so for
// THIS purpose, "can this role manage other users/locations at the tenant's
// full scope" -- they rank together). marketing and location_manager are a
// middle tier: both may be scoped to specific locations or company-wide,
// and neither can manage users/entitlements the other cannot; a lateral
// move between them changes WHICH operational permissions are granted
// within the same scope, never the tenant-wide authority ceiling, so it is
// treated as neutral here (a deliberate, documented judgment call -- the
// concrete examples given for this phase are only owner<->manager).
// read_only is the bottom tier. Promotion (rank increases) is an expansion;
// demotion (rank decreases) is a reduction; a lateral move within the same
// rank is neutral.
const ROLE_AUTHORITY_RANK = Object.freeze({ owner: 3, admin: 3, marketing: 2, location_manager: 2, read_only: 1 })

function locationSetExpands(oldLocationIds, newLocationIds) {
  if (oldLocationIds === newLocationIds) return false
  if (newLocationIds === '*') return oldLocationIds !== '*' // '*' is the broadest possible scope
  if (oldLocationIds === '*') return false // narrowing FROM '*' is never an expansion
  // Both are explicit arrays: expands iff the new set contains any location
  // the old set did not already grant -- a partial swap (some added, some
  // removed) still counts as an expansion, since at least one previously
  // unauthorized location becomes newly authorized.
  const oldSet = new Set(oldLocationIds)
  return newLocationIds.some(id => !oldSet.has(id))
}

function locationSetReduces(oldLocationIds, newLocationIds) {
  if (oldLocationIds === newLocationIds) return false
  if (oldLocationIds === '*') return newLocationIds !== '*'
  if (newLocationIds === '*') return false
  const newSet = new Set(newLocationIds)
  return oldLocationIds.some(id => !newSet.has(id))
}

// `before`/`after`: { role?, locationIds?, canCreateTasks? } -- only the
// fields actually present in BOTH are compared; a field omitted from
// `after` means "not part of this mutation," never "cleared."
export function classifyAuthorityChange(before, after) {
  let expands = false
  let reduces = false

  if (after.role !== undefined && before.role !== undefined && after.role !== before.role) {
    const oldRank = ROLE_AUTHORITY_RANK[before.role] ?? 0
    const newRank = ROLE_AUTHORITY_RANK[after.role] ?? 0
    if (newRank > oldRank) expands = true
    else if (newRank < oldRank) reduces = true
  }

  if (after.locationIds !== undefined && before.locationIds !== undefined) {
    if (locationSetExpands(before.locationIds, after.locationIds)) expands = true
    if (locationSetReduces(before.locationIds, after.locationIds)) reduces = true
  }

  if (after.canCreateTasks !== undefined && before.canCreateTasks !== undefined && after.canCreateTasks !== before.canCreateTasks) {
    if (after.canCreateTasks === true) expands = true
    else reduces = true
  }

  // A mutation with ANY expansion component is classified as an expansion
  // outright, even if it also reduces something else in the same call --
  // never let a bundled reduction mask an authority increase.
  if (expands) return 'expansion'
  if (reduces) return 'reduction'
  return 'unchanged'
}

function buildOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  return `${proto}://${host}`
}

export function buildInviteUrl(req, rawToken) {
  return `${buildOrigin(req)}/accept-invite?token=${encodeURIComponent(rawToken)}`
}

export function buildResetUrl(req, rawToken) {
  return `${buildOrigin(req)}/reset-password?token=${encodeURIComponent(rawToken)}`
}

// Phase 4Q -- self-service registration's email-verification link.
export function buildVerifyUrl(req, rawToken) {
  return `${buildOrigin(req)}/verify-email?token=${encodeURIComponent(rawToken)}`
}

// Google Sign-In (PRYOR login identity) -- the ONE place the login OAuth
// client's redirect_uri is computed, exactly the same request-host-derived
// way every other link in this file is built (never DASHBOARD_BASE_URL --
// see this file's own established convention). This is the exact value
// that must be registered as an Authorized Redirect URI for the SEPARATE
// "PRYOR Identity" Google Cloud OAuth client (never the existing GBP
// client's redirect_uri, which points at /api/google/callback instead).
export function buildGoogleLoginCallbackUrl(req) {
  return `${buildOrigin(req)}/api/session/google-login-callback`
}
