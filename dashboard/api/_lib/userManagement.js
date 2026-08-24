// Shared validation/URL-building helpers for the invitation, password-set,
// and password-reset flows -- used by both settings/[action].js (Owner/
// Admin-only invite-user/resend-invite/revoke-invite) and
// session/[action].js (public accept-invite/invite-status/forgot-password/
// reset-password). Split out because both files need the exact same rules;
// duplicating them would risk the two drifting apart.

import { randomUUID } from 'crypto'
import { ROLES, isValidLocationIds } from './accounts.js'

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
export function validateRoleAndLocations(role, locationIds) {
  if (!ROLES.includes(role)) return { valid: false, message: 'Unrecognized role.' }
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
