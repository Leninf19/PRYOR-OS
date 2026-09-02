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
import { getAccountById, getAccountByEmail, listAccounts } from '../_lib/accountStore.js'
import { verifyPassword, hashPassword, validatePasswordStrength } from '../_lib/password.js'
import { requireAuth } from '../_lib/auth.js'
import { signSession, SESSION_COOKIE } from '../_lib/session.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import { touchLastLogin, updateUser, upsertUser, UserStoreUnavailableError, lookupTenantIdForUserId } from '../_lib/userStore.js'
import { appendAuditEntry } from '../_lib/auditLog.js'
import { resolveTenantId, resolveBootstrapTenantId, TenantResolutionError, DEFAULT_TENANT_ID } from '../_lib/tenants.js'
import { getTenantConfig, TenantConfigStoreUnavailableError } from '../_lib/tenantConfigStore.js'
import {
  consumeInviteToken, markInviteConsumedPending, clearInviteConsumedPending, peekInviteToken,
  createResetToken, consumeResetToken, markResetConsumedPending, clearResetConsumedPending, peekResetToken,
  TokenStoreUnavailableError,
} from '../_lib/tokenStore.js'
import { isValidDisplayName, buildResetUrl } from '../_lib/userManagement.js'
import { buildResetEmail, buildResetEmailSubject } from '../_lib/accountEmailTemplate.js'
import { sendReviewEmail, EmailSenderUnavailableError } from '../_lib/emailSender.js'

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
    //
    // resolveTenantId() now fails closed for a null account (Phase 3
    // hardening) -- there is no real account here to attribute this failed
    // attempt to in the unknown-email case, so this best-effort audit entry
    // (never a security decision -- it never gates access) files under the
    // bootstrap tenant instead of routing `null` through the strict
    // resolver. A real-but-disabled/wrong-password account still resolves
    // its own genuine tenant normally.
    await appendAuditEntry(account ? resolveTenantId(account) : resolveBootstrapTenantId(), {
      actorId: account?.userId ?? null, actorEmail: email, ip: clientIp(req),
      action: 'user.login_failed', entity: 'user', entityId: account?.userId ?? null,
      result: 'failure', message: 'Sign-in attempt failed.',
    })
    return genericFailure()
  }

  let token
  let tenantId
  try {
    tenantId = resolveTenantId(account)
    token = await signSession({
      userId: account.userId,
      email: account.email,
      role: account.role,
      locationIds: account.locationIds,
      tenantId,
      sessionVersion: account.sessionVersion,
    }, { expiresInSeconds: SESSION_TTL_SECONDS })
  } catch (err) {
    // Reachable if SESSION_SIGNING_SECRET itself is missing/invalid, OR
    // (Phase 3 hardening) if resolveTenantId() could not safely establish
    // this account's tenant (TenantResolutionError) -- both fail the same
    // way: a generic, no-detail 503, never the underlying error's own
    // message (which may name the offending field) in the response body.
    console.error(`[login] could not establish a session: ${err.message}`)
    return res.status(503).json({ error: 'service_unavailable', message: 'Sign-in is temporarily unavailable. Please try again shortly.' })
  }

  setCookie(res, SESSION_COOKIE, token, { maxAgeSeconds: SESSION_TTL_SECONDS })

  // Best-effort, never blocking/failing the response: touchLastLogin() is a
  // no-op for static-directory-only accounts (no Redis record to update),
  // and swallows its own Redis errors -- a bookkeeping-field write must
  // never turn a successful login into a failed one.
  await touchLastLogin(tenantId, account.userId)
  await appendAuditEntry(tenantId, {
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

// GET /api/session/tenant-status -- Multi-Tenant Phase 4J: the ONE thing
// the frontend needs to answer "what lifecycle state is MY OWN tenant in"
// (onboarding/locations_approved/provisioning/.../active/suspended) --
// nothing before this phase exposed tenant_config to the browser at all.
// Any authenticated role may call it (same as whoami) -- every tenant
// member, not just the Owner driving onboarding, needs to know why they
// can or cannot reach the normal dashboard yet. tenantId is ALWAYS
// resolveTenantId(account) -- server-derived from the session, never from
// request input, exactly like every other tenant-scoped read in this
// codebase.
//
// SANITIZATION, same allowlist discipline as tenant-ops/[action].js's
// sanitizeTenant(): never locationIdMap, never a raw tenant_config spread,
// never googleLocationId (not secret, but not needed by any UI this phase
// builds -- the numeric locationId is the only id the frontend has any use
// for). Never credential material of any kind (this endpoint doesn't even
// import credentialStore.js).
//
// LOS TRES AMIGOS (BOOTSTRAP mode, DEFAULT_TENANT_ID): has no tenant_config
// record at all -- it never goes through this onboarding state machine
// (see tenants.js's LocationCatalogMigrationMode) and must always report as
// operationally 'active', exactly preserving its current, unconstrained
// dashboard access. This is a hardcoded special case, not an inference
// from "no record found" (see the `config === null` branch below, which
// answers the OPPOSITE way for every other tenant) -- the two must never
// be conflated.
async function tenantStatus(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireAuth(req, res, null)
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `session:tenant-status:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const tenantId = resolveTenantId(account)

  if (tenantId === DEFAULT_TENANT_ID) {
    return res.status(200).json({
      tenantId, status: 'active', displayName: 'Los Tres Amigos', logoUrl: null, brands: [],
      approvedLocations: null, provisioning: null, initialSync: null, entitlementChange: null,
    })
  }

  let config
  try {
    config = await getTenantConfig(tenantId)
  } catch (err) {
    if (err instanceof TenantConfigStoreUnavailableError) {
      return res.status(503).json({ error: 'service_unavailable', message: 'Could not read tenant status. Please try again shortly.' })
    }
    throw err
  }

  if (!config) {
    // Never onboarded at all yet -- a brand-new tenant's very first
    // authenticated request must land cleanly on the onboarding flow,
    // never a 404/error.
    return res.status(200).json({
      tenantId, status: 'onboarding', displayName: tenantId, logoUrl: null, brands: [],
      approvedLocations: [], provisioning: null, initialSync: null, entitlementChange: null,
    })
  }

  return res.status(200).json({
    tenantId,
    status: config.status,
    displayName: config.displayName ?? tenantId,
    logoUrl: config.logoUrl ?? null,
    brands: Array.isArray(config.brands) ? config.brands : [],
    approvedLocations: (Array.isArray(config.approvedLocations) ? config.approvedLocations : []).map(l => ({
      locationId: l.locationId, title: l.title ?? '', address: l.address ?? '', operational: l.operational !== false,
    })),
    provisioning: config.provisioning ? { status: config.provisioning.status ?? 'none', lastError: config.provisioning.lastError ?? null } : null,
    initialSync: config.initialSync ? {
      status: config.initialSync.status ?? 'none', lastError: config.initialSync.lastError ?? null,
      reviewCount: config.initialSync.reviewCount ?? null, locationCount: config.initialSync.locationCount ?? null,
    } : null,
    entitlementChange: config.entitlementChange ? { status: config.entitlementChange.status ?? 'none', lastError: config.entitlementChange.lastError ?? null } : null,
  })
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

  const safeAccounts = (await listAccounts(resolveTenantId(account)))
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

// GET /api/session/invite-status?token=  -- unauthenticated, non-consuming.
// Lets the /accept-invite frontend page show "You've been invited..."
// before the user has typed anything, without burning the token's single
// use (see tokenStore.js's peekInviteToken). Never reveals more than the
// invitee themselves will already see once they open the link.
async function inviteStatus(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  const token = req.query?.token
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'invalid_request', message: 'A token is required.' })
  }
  try {
    const result = await peekInviteToken(token)
    if (!result) return res.status(200).json({ valid: false })
    const { email, role, locationIds } = result.payload
    return res.status(200).json({ valid: true, email, role, locationIds })
  } catch (err) {
    if (err instanceof TokenStoreUnavailableError) {
      console.error(`[session/invite-status] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'This is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// POST /api/session/accept-invite  { token, name?, password }
// Unauthenticated by design (the token itself is the credential at this
// point) -- validates the invitation, sets the invitee's own password
// (never seen by the Owner/Admin who invited them), activates the account,
// and auto-logs them in. See tokenStore.js's header comment for the full
// single-use + no-unrecoverable-partial-failure contract this relies on:
// consumeInviteToken() is atomic (GETDEL), and a failure AFTER consuming
// but before the account is fully set up is recoverable by the client
// resubmitting the identical token -- it will be found via the pending
// safety-net record rather than rejected as invalid.
async function acceptInvite(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const allowed = await enforceRateLimit(req, res, `accept-invite:${clientIp(req)}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  const { token, name, password } = req.body ?? {}
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'invalid_request', message: 'A valid invitation link is required.' })
  }
  const strength = validatePasswordStrength(password)
  if (!strength.valid) {
    return res.status(400).json({ error: 'invalid_request', message: strength.message })
  }

  let consumed
  try {
    consumed = await consumeInviteToken(token)
  } catch (err) {
    if (err instanceof TokenStoreUnavailableError) {
      console.error(`[session/accept-invite] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Account setup is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
  if (!consumed) {
    return res.status(400).json({ error: 'invalid_or_expired_token', message: 'This invitation link is invalid, expired, or has already been used.' })
  }
  const { payload, tokenHash, fromPending } = consumed
  const { userId } = payload

  if (!fromPending) {
    // Fresh consume -- write the retry safety net BEFORE attempting any of
    // the writes below, per tokenStore.js's contract.
    await markInviteConsumedPending(tokenHash, payload)
  }

  try {
    const passwordHash = await hashPassword(password)
    const now = new Date().toISOString()
    // No account is known yet at this point (only a bare userId from the
    // validated token payload) -- Multi-Tenant Phase 4K: resolve which
    // tenant actually owns this userId via the GLOBAL identity index
    // (userStore.js), exactly the pre-identity lookup it exists for. An
    // unindexed userId (every Los Tres Amigos account, by construction --
    // see userStore.js's getUserIdentityMigrationMode()) falls back to
    // the bootstrap tenant, identical to today's behavior.
    const indexedTenantId = await lookupTenantIdForUserId(userId)
    const targetTenantId = indexedTenantId ?? resolveBootstrapTenantId()
    const updated = await updateUser(targetTenantId, userId, {
      passwordHash, passwordSetAt: now,
      ...(isValidDisplayName(name) ? { displayName: name.trim() } : {}),
    })
    if (!updated) {
      // The user record itself is gone -- not a token problem (already
      // validated above), something else removed the account between
      // invite-creation and acceptance. Not retryable.
      return res.status(404).json({ error: 'not_found', message: 'This account no longer exists.' })
    }

    const tenantId = resolveTenantId(updated)
    const sessionToken = await signSession({
      userId: updated.userId, email: updated.email, role: updated.role,
      locationIds: updated.locationIds, tenantId, sessionVersion: updated.sessionVersion,
    }, { expiresInSeconds: SESSION_TTL_SECONDS })
    setCookie(res, SESSION_COOKIE, sessionToken, { maxAgeSeconds: SESSION_TTL_SECONDS })

    await clearInviteConsumedPending(tokenHash)
    await appendAuditEntry(tenantId, {
      actorId: userId, actorEmail: updated.email, ip: clientIp(req),
      action: 'invitation.accepted', entity: 'user', entityId: userId,
      result: 'success', message: 'Invitation accepted, account activated.',
    })

    return res.status(200).json({
      account: { userId: updated.userId, email: updated.email, role: updated.role, locationIds: updated.locationIds, displayName: updated.displayName ?? updated.email },
    })
  } catch (err) {
    if (err instanceof UserStoreUnavailableError) {
      // The pending safety-net record is untouched -- the client can
      // resubmit the identical token+password once the store recovers and
      // this will retry idempotently via the fromPending fallback above.
      console.error(`[session/accept-invite] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Could not finish setting up your account. Please try this link again in a moment.' })
    }
    if (err instanceof TenantResolutionError) {
      // Phase 3 hardening: the freshly-updated user record could not be
      // safely resolved to a tenant -- reject generically, never leak the
      // underlying reason (which field was invalid) in the response body.
      // The pending safety-net record is left untouched, same as above --
      // this is not retryable by the client without an operator fixing the
      // underlying account record.
      console.error(`[session/accept-invite] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Could not finish setting up your account. Please try this link again in a moment.' })
    }
    throw err
  }
}

// POST /api/session/forgot-password  { email }
// Unauthenticated by design, like login. ALWAYS returns the exact same
// response regardless of whether the email resolves to a real account, a
// disabled account, or nothing at all -- no enumeration, mirroring login()'s
// own genericFailure() convention. A disabled account deliberately does NOT
// receive a reset link (re-enabling access is an Owner/Admin decision, not
// something a locked-out account should be able to route around via
// forgot-password) -- but the response is identical either way.
const GENERIC_FORGOT_PASSWORD_RESPONSE = { success: true, message: 'If an account exists for this email, a password reset link has been sent.' }

async function forgotPassword(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const allowed = await enforceRateLimit(req, res, `forgot-password:${clientIp(req)}`, { requestsPerWindow: 5, windowSeconds: 60 })
  if (!allowed) return

  const { email: rawEmail } = req.body ?? {}
  const email = typeof rawEmail === 'string' ? rawEmail.trim() : rawEmail
  if (typeof email !== 'string' || !email) {
    return res.status(400).json({ error: 'invalid_request', message: 'An email address is required.' })
  }

  try {
    const account = await getAccountByEmail(email)
    if (account && !account.disabled) {
      const { rawToken, expiresAt } = await createResetToken({ userId: account.userId })
      const resetUrl = buildResetUrl(req, rawToken)
      try {
        const subject = buildResetEmailSubject()
        const { html, text } = buildResetEmail({ name: account.displayName, resetUrl, expiresAt })
        await sendReviewEmail({ to: account.email, cc: [], replyTo: undefined, subject, html, text })
      } catch (err) {
        // Never surface a send failure to the caller (would leak "this
        // email exists") -- log server-side only. There is no owner/admin-
        // facing "copy link" fallback for THIS flow the way invites have
        // one (the requester isn't authenticated), so a send failure here
        // genuinely means the user needs to ask an Owner/Admin for
        // generate-reset-link instead -- that's an operational gap, not a
        // security one.
        console.error(`[session/forgot-password] reset email failed: ${err.message}`)
      }
      await appendAuditEntry(resolveTenantId(account), {
        actorId: account.userId, actorEmail: account.email, ip: clientIp(req),
        action: 'password_reset.requested', entity: 'user', entityId: account.userId,
        result: 'success', message: 'Password reset requested.',
      })
    }
  } catch (err) {
    if (!(err instanceof TokenStoreUnavailableError) && !(err instanceof TenantResolutionError)) throw err
    // A TenantResolutionError here (Phase 3 hardening -- an account that
    // exists but could not be safely resolved to a tenant) gets the exact
    // same treatment as a token-store outage: logged server-side, never
    // surfaced. Still returns the generic response below -- a failure of
    // either kind must not turn into a different response shape that could
    // hint at account existence via a distinguishable failure mode.
    console.error(`[session/forgot-password] ${err.message}`)
  }

  return res.status(200).json(GENERIC_FORGOT_PASSWORD_RESPONSE)
}

// GET /api/session/reset-status?token=  -- unauthenticated, non-consuming.
// Deliberately reveals nothing beyond valid/invalid (unlike invite-status,
// which shows the invitee their own email/role -- a reset link's requester
// already knows their own email, and a reset link is more plausible to
// have been intercepted, so this stays conservative).
async function resetStatus(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  const token = req.query?.token
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'invalid_request', message: 'A token is required.' })
  }
  try {
    const result = await peekResetToken(token)
    return res.status(200).json({ valid: Boolean(result) })
  } catch (err) {
    if (err instanceof TokenStoreUnavailableError) {
      console.error(`[session/reset-status] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'This is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// POST /api/session/reset-password  { token, password }
// Same single-use/atomic-consume/partial-failure-recovery contract as
// accept-invite -- see tokenStore.js's header comment. Additionally
// bumps sessionVersion (invalidating every existing session for this
// account immediately, per the milestone's explicit security requirement)
// and -- the one behavior unique to reset vs. accept-invite -- transparently
// PROMOTES a static-ACCOUNT_DIRECTORY_JSON-only account into the Redis
// store on its first reset: accountStore.js's dual-read already means a
// Redis record for this identity becomes authoritative from this point on,
// so writing the new password into userStore.js (regardless of which store
// the account currently lives in) is the one code path needed for both
// "update an existing Redis user" and "migrate a legacy static Owner".
async function resetPassword(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const allowed = await enforceRateLimit(req, res, `reset-password:${clientIp(req)}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  const { token, password } = req.body ?? {}
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'invalid_request', message: 'A valid reset link is required.' })
  }
  const strength = validatePasswordStrength(password)
  if (!strength.valid) {
    return res.status(400).json({ error: 'invalid_request', message: strength.message })
  }

  let consumed
  try {
    consumed = await consumeResetToken(token)
  } catch (err) {
    if (err instanceof TokenStoreUnavailableError) {
      console.error(`[session/reset-password] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Password reset is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
  if (!consumed) {
    return res.status(400).json({ error: 'invalid_or_expired_token', message: 'This reset link is invalid, expired, or has already been used.' })
  }
  const { payload, tokenHash, fromPending } = consumed
  const { userId } = payload

  if (!fromPending) {
    await markResetConsumedPending(tokenHash, payload)
  }

  try {
    const current = await getAccountById(userId)
    if (!current || current.disabled) {
      // Deleted or disabled since the token was issued -- not retryable,
      // and the pending record is left to expire on its own (no account to
      // recover into).
      return res.status(404).json({ error: 'not_found', message: 'This account is no longer available.' })
    }

    // `current` (the account this reset token was issued for) is already
    // known here, so this resolves its real tenant -- never routes through
    // resolveBootstrapTenantId(), which is reserved for the genuinely
    // pre-account-lookup case (see acceptInvite() above).
    const resolvedTenantId = resolveTenantId(current)

    const passwordHash = await hashPassword(password)
    const now = new Date().toISOString()
    const updated = await upsertUser(resolvedTenantId, {
      // Base fields present on either a static or an already-Redis account;
      // Redis-specific bookkeeping fields default sensibly the first time a
      // static account is promoted (never known/never happened for it).
      createdAt: now, invitedAt: null, invitedBy: null, lastInviteSentAt: null,
      inviteTokenHash: null, inviteExpiresAt: null, inviteRevokedAt: null, lastLoginAt: null,
      ...current,
      passwordHash, passwordSetAt: now, updatedAt: now,
      sessionVersion: (Number.isInteger(current.sessionVersion) ? current.sessionVersion : 1) + 1,
    })

    const tenantId = resolveTenantId(updated)
    const sessionToken = await signSession({
      userId: updated.userId, email: updated.email, role: updated.role,
      locationIds: updated.locationIds, tenantId, sessionVersion: updated.sessionVersion,
    }, { expiresInSeconds: SESSION_TTL_SECONDS })
    setCookie(res, SESSION_COOKIE, sessionToken, { maxAgeSeconds: SESSION_TTL_SECONDS })

    await clearResetConsumedPending(tokenHash)
    await appendAuditEntry(tenantId, {
      actorId: userId, actorEmail: updated.email, ip: clientIp(req),
      action: 'password_reset.completed', entity: 'user', entityId: userId,
      result: 'success', message: 'Password reset completed; all prior sessions invalidated.',
    })

    return res.status(200).json({
      account: { userId: updated.userId, email: updated.email, role: updated.role, locationIds: updated.locationIds, displayName: updated.displayName ?? updated.email },
    })
  } catch (err) {
    if (err instanceof UserStoreUnavailableError) {
      console.error(`[session/reset-password] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Could not finish resetting your password. Please try this link again in a moment.' })
    }
    if (err instanceof TenantResolutionError) {
      // Phase 3 hardening: same generic, no-detail rejection as
      // accept-invite's equivalent catch -- see its comment.
      console.error(`[session/reset-password] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Could not finish resetting your password. Please try this link again in a moment.' })
    }
    throw err
  }
}

export default async function handler(req, res) {
  switch (req.query?.action) {
    case 'login':            return login(req, res)
    case 'logout':           return logout(req, res)
    case 'whoami':           return whoami(req, res)
    case 'tenant-status':    return tenantStatus(req, res)
    case 'accounts':         return accounts(req, res)
    case 'invite-status':    return inviteStatus(req, res)
    case 'accept-invite':    return acceptInvite(req, res)
    case 'forgot-password':  return forgotPassword(req, res)
    case 'reset-status':     return resetStatus(req, res)
    case 'reset-password':   return resetPassword(req, res)
    default:                 return res.status(404).json({ error: 'not_found' })
  }
}
