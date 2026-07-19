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
import { loadAccountDirectory, findAccountById, toSafeAccount } from './accounts.js'

// Returns { account, reason } where account is null on failure and reason
// is one of 'unauthenticated' | 'session_expired' | 'forbidden' when it is.
// Does not touch `res` -- used by both requireAuth() (JSON API responses)
// and auth.js (an HTML/redirect endpoint that needs a different failure
// presentation).
export async function evaluateSession(req, allowedRoles) {
  const cookies = parseCookies(req)
  const claims = await verifySession(cookies[SESSION_COOKIE])
  if (!claims) return { account: null, reason: 'unauthenticated' }

  const accounts = loadAccountDirectory()
  if (!accounts) {
    console.error('[auth] ACCOUNT_DIRECTORY_JSON is missing or invalid -- rejecting all requests.')
    return { account: null, reason: 'unauthenticated' }
  }

  const account = findAccountById(accounts, claims.userId)
  if (!account || account.disabled) return { account: null, reason: 'unauthenticated' }

  if (account.sessionVersion !== claims.sessionVersion) {
    return { account: null, reason: 'session_expired' }
  }

  if (allowedRoles && !allowedRoles.includes(account.role)) {
    return { account: null, reason: 'forbidden' }
  }

  return { account: toSafeAccount(account), reason: null }
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
