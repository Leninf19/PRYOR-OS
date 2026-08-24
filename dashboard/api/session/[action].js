// Single serverless function handling all three session endpoints --
// consolidated from separate login.js/logout.js/whoami.js files to stay
// under the Vercel Hobby plan's 12-serverless-function-per-deployment
// limit (Phase 1's new auth endpoints pushed the project to 13). A
// dynamic route file ([action].js) is exactly one function regardless of
// how many `action` values it dispatches on, and Vercel/Node populates
// req.query.action from the URL segment, so the external routes are
// unchanged: POST /api/session/login, POST /api/session/logout,
// GET /api/session/whoami all still work exactly as before -- only the
// file layout changed, not the API.

import { setCookie, clearCookie } from '../google/_lib/cookies.js'
import { getAccountByEmail, listAccounts } from '../_lib/accountStore.js'
import { verifyPassword } from '../_lib/password.js'
import { requireAuth } from '../_lib/auth.js'
import { signSession, SESSION_COOKIE } from '../_lib/session.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import { touchLastLogin } from '../_lib/userStore.js'
import { appendAuditEntry } from '../_lib/auditLog.js'

const SESSION_TTL_SECONDS = 12 * 60 * 60 // 12h fixed session (Phase 1)

// A syntactically-valid bcrypt hash of a value nobody will ever type, used
// so "account not found" still pays the same bcrypt.compare() cost as
// "account found, wrong password" -- keeps response timing from being a
// side channel for account enumeration.
const DUMMY_HASH = '$2b$12$Y0I8ZmmUnNDBireCWez0M.AGkTN6bxJWhySMGh8LPi.5tu7ynlnsm'

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim()
  return req.socket?.remoteAddress || 'unknown'
}

// POST /api/session/login  { email, password }
// Returns { account: { userId, email, role, locationIds, displayName } } and
// sets the lta_session cookie, or a generic 401 on any failure.
//
// No account enumeration: an unknown email and a wrong password produce the
// exact same response (status, body, and error code) -- verifyPassword()
// still runs against a dummy hash when the account isn't found so the two
// cases take comparable time as well.
async function login(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const allowed = await enforceRateLimit(req, res, `login:${clientIp(req)}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  const { email: rawEmail, password } = req.body ?? {}
  // Trim only the email -- the password is never altered before
  // verification (leading/trailing whitespace in a password is
  // significant and must reach bcrypt.compare() exactly as typed).
  const email = typeof rawEmail === 'string' ? rawEmail.trim() : rawEmail
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).json({ error: 'invalid_request', message: 'Email and password are required.' })
  }

  const genericFailure = () => res.status(401).json({ error: 'invalid_credentials', message: 'Invalid email or password.' })

  const account = await getAccountByEmail(email)
  const hashToCheck = account?.passwordHash || DUMMY_HASH
  const passwordOk = await verifyPassword(password, hashToCheck)

  if (!account || account.disabled || !passwordOk) {
    // Audit-logged by outcome, never by which specific check failed (unknown
    // email vs. wrong password vs. disabled account) -- the caller-facing
    // response is already identical for all three (no-enumeration, above);
    // logging the distinction internally would just move the same
    // information into a second, easier-to-overlook surface. Never logs the
    // attempted password itself.
    await appendAuditEntry({
      actorId: account?.userId ?? null, actorEmail: email, ip: clientIp(req),
      action: 'user.login_failed', entity: 'user', entityId: account?.userId ?? null,
      result: 'failure', message: 'Sign-in attempt failed.',
    })
    return genericFailure()
  }

  let token
  try {
    token = await signSession({
      userId: account.userId,
      email: account.email,
      role: account.role,
      locationIds: account.locationIds,
      sessionVersion: account.sessionVersion,
    }, { expiresInSeconds: SESSION_TTL_SECONDS })
  } catch (err) {
    // Only reachable if SESSION_SIGNING_SECRET itself is missing/invalid --
    // signSession()'s error text includes setup instructions meant for an
    // administrator reading server logs, not a caller's response body.
    console.error(`[login] could not sign a session token: ${err.message}`)
    return res.status(503).json({ error: 'service_unavailable', message: 'Sign-in is temporarily unavailable. Please try again shortly.' })
  }

  setCookie(res, SESSION_COOKIE, token, { maxAgeSeconds: SESSION_TTL_SECONDS })

  // Best-effort, never blocking/failing the response: touchLastLogin() is a
  // no-op for static-directory-only accounts (no Redis record to update),
  // and swallows its own Redis errors -- a bookkeeping-field write must
  // never turn a successful login into a failed one.
  await touchLastLogin(account.userId)
  await appendAuditEntry({
    actorId: account.userId, actorEmail: account.email, ip: clientIp(req),
    action: 'user.login', entity: 'user', entityId: account.userId,
    result: 'success', message: 'Signed in.',
  })

  return res.status(200).json({
    account: {
      userId: account.userId,
      email: account.email,
      role: account.role,
      locationIds: account.locationIds,
      displayName: account.displayName ?? account.email,
    },
  })
}

// POST /api/session/logout -- clears the session cookie.
// No server-side revocation list in Phase 1 (sessionVersion already covers
// forced invalidation; the 12h expiry bounds a stolen-cookie window).
function logout(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  clearCookie(res, SESSION_COOKIE)
  return res.status(200).json({ success: true })
}

// GET /api/session/whoami -- used by the frontend AuthGate on load to
// decide login-screen vs. dashboard. Runs the exact same requireAuth() path
// as every other protected endpoint (no separate, weaker check).
// Returns 200 { account } if a valid session exists, 401 otherwise.
async function whoami(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireAuth(req, res, null) // null = any authenticated role
  if (!account) return
  return res.status(200).json({ account })
}

// GET /api/session/accounts -- the reusable identity-directory read: every
// non-disabled account, sanitized (no passwordHash). Lives on the identity
// layer, not on any one feature, deliberately -- Action Center's assignee
// picker is the first consumer, but workload reporting, notifications,
// settings/manager-administration, and audit-log attribution all need the
// same "who are the people in this system" list and should call this same
// endpoint rather than each growing their own account-listing logic.
// Any authenticated role may call it (same as whoami) -- it exposes no
// more than every account's own toSafeAccount() shape already reveals to
// its own owner.
async function accounts(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireAuth(req, res, null) // null = any authenticated role
  if (!account) return

  const safeAccounts = (await listAccounts())
    .filter(a => !a.disabled)
    .map(a => ({
      userId: a.userId,
      email: a.email,
      role: a.role,
      locationIds: a.locationIds,
      displayName: a.displayName ?? a.email,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))

  return res.status(200).json({ accounts: safeAccounts })
}

export default async function handler(req, res) {
  switch (req.query?.action) {
    case 'login':    return login(req, res)
    case 'logout':   return logout(req, res)
    case 'whoami':   return whoami(req, res)
    case 'accounts': return accounts(req, res)
    default:         return res.status(404).json({ error: 'not_found' })
  }
}
