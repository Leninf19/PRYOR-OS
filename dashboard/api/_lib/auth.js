// Node-only authorization orchestrator. This is the AUTHORITATIVE layer --
// dashboard/middleware.js performs a lightweight version of this same check
// at the Edge for defense-in-depth, but every API handler calls requireAuth
// independently and never trusts that middleware already ran (a route not
// covered by the middleware matcher, a misconfigured matcher, or a future
// change must not silently lose protection).
//
// What this checks, in order (mirrors the session-lifecycle design):
//   1. Cookie present and signature/expiry valid (via _lib/session.js).
//   2. The account still exists in the CURRENT account directory.
//   3. The account is not disabled.
//   4. The token's sessionVersion matches the account's CURRENT
//      sessionVersion -- a password change, role change, or removal bumps
//      this and immediately invalidates every outstanding token for that
//      account, even ones issued seconds ago.
//   5. The account's CURRENT role is in the caller's allowed-roles list --
//      decided from the freshly-read account record, never from the
//      possibly-stale role claim embedded in the cookie.

import { parseCookies } from '../google/_lib/cookies.js'
import { verifySession, SESSION_COOKIE } from './session.js'
import { getAccountById } from './accountStore.js'
import { roleHasPermission } from './permissions.js'

// Never include passwordHash (or anything else not needed by the caller) in
// data that might reach the frontend or a log line. The only caller is
// evaluateSession() below, so this lives here rather than in accountStore.js
// -- account lookup and account shaping are separate concerns.
function toSafeAccount(account) {
  if (!account) return null
  return {
    userId: account.userId,
    email: account.email,
    role: account.role,
    locationIds: account.locationIds,
    displayName: account.displayName ?? account.email,
  }
}

// Returns { account, reason } where account is null on failure and reason
// is one of 'unauthenticated' | 'session_expired' | 'forbidden' when it is.
// Does not touch `res` -- used by both requireAuth() (JSON API responses)
// and auth.js (an HTML/redirect endpoint that needs a different failure
// presentation).
export async function evaluateSession(req, allowedRoles) {
  const cookies = parseCookies(req)
  const claims = await verifySession(cookies[SESSION_COOKIE])
  if (!claims) return { account: null, reason: 'unauthenticated' }

  const account = await getAccountById(claims.userId)
  if (!account || account.disabled) return { account: null, reason: 'unauthenticated' }

  if (account.sessionVersion !== claims.sessionVersion) {
    return { account: null, reason: 'session_expired' }
  }

  if (allowedRoles && !allowedRoles.includes(account.role)) {
    return { account: null, reason: 'forbidden' }
  }

  return { account: toSafeAccount(account), reason: null }
}

// Maps an evaluateSession() failure `reason` to the correct HTTP status per
// the frozen API error contract: 401 for "no valid identity at all"
// (unauthenticated / session_expired), 403 for "valid identity, wrong
// capability" (forbidden -- includes an unrecognized/unknown role, which
// evaluateSession() already fails closed into 'forbidden' rather than
// granting access). Shared by any endpoint that calls evaluateSession()
// directly instead of requireAuth() -- today that's the HTML-responding
// Google OAuth endpoints (auth.js/callback.js), which need a different
// failure presentation than requireAuth()'s JSON body but must still use
// the same status-code decision.
export function statusForAuthFailure(reason) {
  return reason === 'forbidden' ? 403 : 401
}

// JSON-API form: writes the 401/403 response itself and returns null, or
// returns the current account record (safe subset) on success. Caller's
// only job is `if (!account) return`.
export async function requireAuth(req, res, allowedRoles) {
  const { account, reason } = await evaluateSession(req, allowedRoles)
  if (account) return account

  if (reason === 'forbidden') {
    res.status(403).json({ error: 'forbidden', message: 'You do not have permission to perform this action.' })
  } else if (reason === 'session_expired') {
    res.status(401).json({ error: 'session_expired', message: 'Your session is no longer valid. Please sign in again.' })
  } else {
    res.status(401).json({ error: 'unauthenticated', message: 'Sign in required.' })
  }
  return null
}

// --- Phase 2 Milestone 2: composable, location-aware authorization -------
// Everything below is additive and, as of this milestone, unused by any
// endpoint. requireAuth() above is unchanged. These build on top of it
// rather than replacing it -- most endpoints will eventually call
// requireScopedAuth() instead of requireAuth() directly, but none do yet.

// Pure, synchronous, trivially unit-testable: does this account's location
// grant reach a given location? '*' means company-wide (Owner/Marketing
// today); otherwise the id must appear in the account's explicit list.
//
// Fails closed on any malformed shape rather than throwing -- a missing
// account, a missing/null/non-array locationIds, or any other unexpected
// shape simply denies access instead of raising a TypeError. In practice
// accountStore.js only ever hands back accounts that already passed
// accounts.js's strict validator (locationIds is always '*' or a valid
// array of positive integers), so this defends against a hypothetical
// malformed caller, not a reachable production state. No normalization is
// performed -- a string locationId is still denied against a numeric grant
// unless that is explicitly designed later.
export function requireLocationAccess(account, locationId) {
  if (!account) return false
  const { locationIds } = account
  if (locationIds === '*') return true
  if (!Array.isArray(locationIds)) return false
  return locationIds.includes(locationId)
}

// Write-side specialization of requireLocationAccess -- the check is
// identical, but a distinct name keeps call sites self-documenting (reading
// a publish/reply path, "requireOwnership" states intent more clearly than
// a second call to "requireLocationAccess" would).
export function requireOwnership(account, resourceLocationId) {
  return requireLocationAccess(account, resourceLocationId)
}

// The composite most endpoints will eventually call: authenticate, check
// the role carries the required permission, then (if the request concerns
// a specific location) check the account's location grant covers it.
//
// `resolveLocationId(req, account)` returns the location id the request
// concerns, or null/undefined if the request isn't location-scoped (e.g. a
// company-wide view). It receives `account` so it can special-case a
// wildcard grant if resolving the id would otherwise require extra work.
//
// A location outside the account's grant returns 404, not 403 -- see the
// Phase 2 architecture's API error contract (§6): 403 would confirm the
// resource exists but is off-limits, disclosing its existence to an
// account that shouldn't even know to ask.
export async function requireScopedAuth(req, res, { permission, resolveLocationId }) {
  const account = await requireAuth(req, res, null)
  if (!account) return null

  if (!roleHasPermission(account.role, permission)) {
    res.status(403).json({ error: 'forbidden', message: 'You do not have permission to perform this action.' })
    return null
  }

  const locationId = await resolveLocationId(req, account)
  if (locationId != null && !requireLocationAccess(account, locationId)) {
    res.status(404).json({ error: 'not_found' })
    return null
  }

  return { account, locationId }
}
