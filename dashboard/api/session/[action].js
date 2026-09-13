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

import { setCookie, clearCookie, parseCookies } from '../google/_lib/cookies.js'
import { getAccountById, getAccountByEmail, getAccountByEmailRequireRedisHealthy, listAccounts } from '../_lib/accountStore.js'
import { verifyPassword, hashPassword, validatePasswordStrength } from '../_lib/password.js'
import { requireAuth } from '../_lib/auth.js'
import { signSession, SESSION_COOKIE } from '../_lib/session.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import { touchLastLogin, updateUser, upsertUser, UserStoreUnavailableError, UserCreationMode, lookupTenantIdForUserId } from '../_lib/userStore.js'
import { appendAuditEntry } from '../_lib/auditLog.js'
import { resolveTenantId, resolveBootstrapTenantId, TenantResolutionError, DEFAULT_TENANT_ID } from '../_lib/tenants.js'
import { generateTenantId } from '../_lib/tenantIdGenerator.js'
import { getTenantConfig, TenantConfigStoreUnavailableError, reconcileStuckProvisioningDispatch } from '../_lib/tenantConfigStore.js'
import { resolveTenantEntitlements } from '../_lib/entitlements.js'
import {
  createNewTenant, TenantCreationMode, TenantCreationModeRequiredError,
  IdentityAlreadyExistsError, TenantAlreadyExistsError,
} from '../_lib/tenantCreation.js'
import {
  consumeInviteToken, markInviteConsumedPending, clearInviteConsumedPending, peekInviteToken,
  createResetToken, consumeResetToken, markResetConsumedPending, clearResetConsumedPending, peekResetToken,
  createVerifyEmailToken, consumeVerifyEmailToken, peekVerifyEmailToken,
  markVerifyEmailConsumedPending, clearVerifyEmailConsumedPending, revokeVerifyEmailToken,
  TokenStoreUnavailableError,
} from '../_lib/tokenStore.js'
import { isValidDisplayName, buildResetUrl, buildVerifyUrl, generateUserId } from '../_lib/userManagement.js'
import { buildResetEmail, buildResetEmailSubject } from '../_lib/accountEmailTemplate.js'
import { buildVerifyEmail, buildVerifyEmailSubject } from '../_lib/registrationEmailTemplate.js'
import { sendReviewEmail, EmailSenderUnavailableError } from '../_lib/emailSender.js'
import {
  createPendingRegistration, getPendingRegistration, updatePendingRegistration, deletePendingRegistration,
  acquireTenantCreationLock, releaseTenantCreationLock, PendingRegistrationStoreUnavailableError,
} from '../_lib/pendingRegistrationStore.js'
import {
  signPendingSignupToken, verifyPendingSignupToken, PENDING_SIGNUP_COOKIE, PENDING_SIGNUP_TTL_SECONDS,
} from '../_lib/pendingSignupSession.js'
import { redeemAccessCode, AccessCodeInvalidError, AccessCodeRestrictedError, AccessCodeStoreUnavailableError } from '../_lib/accessCodeStore.js'
import { PLANS, isValidPlanId } from '../_lib/plans.js'
import { createCheckoutSession, PaymentNotConfiguredError } from '../_lib/paymentProvider.js'

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
// Phase B.2 -- Commercial Entitlement Foundation: the safe, UI-facing
// projection of resolveTenantEntitlements()'s full internal bundle.
// Deliberately excludes nothing sensitive (there is nothing sensitive in
// the resolver's output -- no tokens, no payment details, no other
// tenant's data) but is kept as its own function so tenantStatus()'s
// response shape doesn't silently change if entitlements.js's internal
// bundle shape ever grows a field this endpoint shouldn't surface yet.
function toSafeCommercialView(entitlements) {
  return {
    plan: entitlements.effectivePlan,
    commercialStatus: entitlements.commercialStatus,
    trialStatus: entitlements.trialStatus,
    limits: entitlements.limits,
    features: entitlements.features,
    reason: entitlements.reason,
  }
}

async function tenantStatus(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireAuth(req, res, null)
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `session:tenant-status:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const tenantId = resolveTenantId(account)
  // resolveTenantEntitlements() never throws (fails closed internally) --
  // safe to call unconditionally, ahead of every branch below, so every
  // tenantStatus() response shape (LTA/bootstrap, never-onboarded, and the
  // full record) exposes the exact same `commercial` shape rather than
  // three independently hand-built ones.
  const commercial = toSafeCommercialView(await resolveTenantEntitlements(tenantId))

  if (tenantId === DEFAULT_TENANT_ID) {
    return res.status(200).json({
      tenantId, status: 'active', displayName: 'Los Tres Amigos', logoUrl: null, brands: [],
      approvedLocations: null, provisioning: null, initialSync: null, entitlementChange: null,
      commercial,
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
      commercial,
    })
  }

  // Multi-Tenant Phase 4O: lazy reconciliation for the automatic
  // post-approval provisioning trigger -- opportunistic, not a new
  // polling/cron mechanism, since this exact endpoint is already the one
  // useTenantStatus() polls throughout onboarding. A no-op for every
  // tenant not currently sitting in an ambiguous, timed-out dispatch
  // state -- see tenantConfigStore.js's reconcileStuckProvisioningDispatch()
  // for the full no-op/timeout logic. Never throws (a store outage here
  // must not break an ordinary status read); if it fails, this read just
  // serves the config it already has.
  if (config.status === 'provisioning') {
    try {
      config = (await reconcileStuckProvisioningDispatch(tenantId)) ?? config
    } catch (err) {
      console.error(`[tenantStatus] reconciliation check failed for ${tenantId}: ${err.message}`)
    }
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
    commercial,
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
    }, {
      // "Prevent duplicate/shadow tenant creation" hardening: `current`
      // came from getAccountById() above, which may have resolved a
      // STATIC-directory-only account (e.g. Martin/Ruffy) never before
      // written to Redis -- this call can therefore be userStore.js's
      // first-ever CREATE for this exact tenantId+userId. `resolvedTenantId`
      // is `resolveTenantId(current)`, an identity ALREADY established as
      // legitimate for this tenant by the getAccountById() lookup above,
      // never attacker-influenced. `sourceIdentity: current` is REQUIRED
      // (final pre-deploy review hardening) -- userStore.js verifies the
      // record being written matches it exactly (userId, email, role,
      // locationIds, disabled) except the password/session bookkeeping
      // fields this action legitimately changes; creationMode alone is
      // never treated as sufficient permission.
      creationMode: UserCreationMode.MIGRATION,
      sourceIdentity: current,
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

// ===========================================================================
// Multi-Tenant Phase 4Q.1 -- self-service registration, email verification,
// and tenant creation via access code. No Stripe (selectPlan() below is a
// stub -- see paymentProvider.js). Every write below goes through the SAME
// trusted, already-reviewed functions the operator bootstrap script and
// the invite/accept-invite flow already use (upsertTenantConfig,
// upsertUser, generateUserId, signSession) -- this phase adds the
// PRE-tenant identity plumbing that gets a verified registrant TO that
// point, never a second way of writing tenant/user state.
// ===========================================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
function isValidEmailAddress(v) {
  return typeof v === 'string' && EMAIL_RE.test(v.trim())
}

class EmailNowOccupiedError extends Error {}
class TenantCreationInProgressError extends Error {}
class PendingRegistrationNotFoundError extends Error {}

const GENERIC_REGISTER_RESPONSE = {
  success: true,
  message: 'If that email is available, we\'ve sent a link to verify your address and continue.',
}

async function sendVerificationEmail(req, pending) {
  // Revokes whatever verification token this pending registration
  // currently has on file BEFORE issuing a new one -- so register()'s own
  // idempotent re-submission and resendVerification() both leave AT MOST
  // one live verification link outstanding at any time (see
  // tests/test_email_verification.js's "revoked after resend" case).
  if (pending.verifyTokenHash) {
    try {
      await revokeVerifyEmailToken(pending.verifyTokenHash)
    } catch (err) {
      console.error(`[session] failed to revoke prior verification token: ${err.message}`)
    }
  }
  const { rawToken, tokenHash, expiresAt } = await createVerifyEmailToken({ email: pending.email })
  await updatePendingRegistration(pending.email, { verifyTokenHash: tokenHash })
  const verifyUrl = buildVerifyUrl(req, rawToken)
  try {
    const subject = buildVerifyEmailSubject()
    const { html, text } = buildVerifyEmail({ displayName: pending.displayName, verifyUrl, expiresAt })
    await sendReviewEmail({ to: pending.email, cc: [], replyTo: undefined, subject, html, text })
  } catch (err) {
    // Never surfaced to the caller -- would leak "this email is real" the
    // same way forgotPassword()'s own send failure must not. The raw link
    // is never logged; only the fact that sending failed is.
    console.error(`[session] verification email failed to send: ${err.message}`)
  }
}

// POST /api/session/register
// { email, password, passwordConfirmation, displayName, companyName }
// Unauthenticated, like login/forgot-password. ALWAYS returns the exact
// same generic response -- whether the email already belongs to a real
// account (any tenant), already has a pending registration, or is
// genuinely new -- no enumeration, mirroring forgotPassword()'s own
// GENERIC_FORGOT_PASSWORD_RESPONSE convention exactly.
//
// Server-derived, never client-suppliable: userId (generateUserId()),
// tenantIdReserved (generateTenantId(), collision-checked against real
// tenant_config), passwordHash (hashed here, once). The client sends only
// the four form fields.
async function register(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const ipAllowed = await enforceRateLimit(req, res, `register:${clientIp(req)}`, { requestsPerWindow: 8, windowSeconds: 60 })
  if (!ipAllowed) return

  const { email: rawEmail, password, passwordConfirmation, displayName: rawDisplayName, companyName: rawCompanyName } = req.body ?? {}
  const email = typeof rawEmail === 'string' ? rawEmail.trim() : rawEmail
  if (!isValidEmailAddress(email)) {
    return res.status(400).json({ error: 'invalid_request', message: 'A valid email address is required.' })
  }
  const strength = validatePasswordStrength(password)
  if (!strength.valid) {
    return res.status(400).json({ error: 'invalid_request', message: strength.message })
  }
  if (password !== passwordConfirmation) {
    return res.status(400).json({ error: 'invalid_request', message: 'Passwords do not match.' })
  }
  if (!isValidDisplayName(rawDisplayName)) {
    return res.status(400).json({ error: 'invalid_request', message: 'Your name is required.' })
  }
  const companyName = typeof rawCompanyName === 'string' ? rawCompanyName.trim() : ''
  if (!companyName || companyName.length > 100) {
    return res.status(400).json({ error: 'invalid_request', message: 'Your company or restaurant group name is required.' })
  }

  // Per-email limit is intentionally tighter and independent of the
  // per-IP one -- stops repeated registration attempts against ONE
  // stranger's inbox regardless of how many different IPs are used.
  const emailAllowed = await enforceRateLimit(req, res, `register-email:${email.toLowerCase()}`, { requestsPerWindow: 3, windowSeconds: 60 * 60 })
  if (!emailAllowed) return

  // "Prevent duplicate/shadow tenant creation" hardening (Phase D/5): a
  // brand-new tenant reservation must never proceed on an UNVERIFIED
  // identity answer. getAccountByEmailRequireRedisHealthy() throws
  // UserStoreUnavailableError (caught below, 503) instead of degrading to
  // "no Redis account found" the way plain getAccountByEmail() correctly
  // does for LOGIN (see accountStore.js's own header on why that
  // distinction exists). This is not an enumeration leak: the 503 fires
  // identically for every registrant during a genuine Redis outage,
  // regardless of whether their specific email has an account.
  try {
    const realAccount = await getAccountByEmailRequireRedisHealthy(email)
    if (!realAccount) {
      let pending = await getPendingRegistration(email)
      if (!pending) {
        const userId = generateUserId()
        const tenantIdReserved = await generateTenantId(companyName)
        const passwordHash = await hashPassword(password)
        pending = await createPendingRegistration({
          email, passwordHash, displayName: rawDisplayName.trim(), companyName, userId, tenantIdReserved,
        })
        // A null return here means another concurrent register() call for
        // this exact email won the create race between our own check and
        // write -- re-read its record rather than treating this as an error.
        if (!pending) pending = await getPendingRegistration(email)
      }
      if (pending && pending.status === 'pending_verification') {
        await sendVerificationEmail(req, pending)
      }
    }
  } catch (err) {
    if (err instanceof UserStoreUnavailableError) {
      console.error(`[session/register] identity state could not be verified -- refusing to reserve a tenant: ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Registration is temporarily unavailable. Please try again shortly.' })
    }
    if (
      !(err instanceof TokenStoreUnavailableError) &&
      !(err instanceof PendingRegistrationStoreUnavailableError) &&
      !(err instanceof TenantConfigStoreUnavailableError) &&
      !(err instanceof EmailSenderUnavailableError)
    ) throw err
    console.error(`[session/register] ${err.message}`)
  }

  return res.status(200).json(GENERIC_REGISTER_RESPONSE)
}

// POST /api/session/resend-verification  { email }
// Same no-enumeration discipline: identical response whether or not a
// pending registration exists, is already verified, or was never created.
async function resendVerification(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const allowed = await enforceRateLimit(req, res, `resend-verification:${clientIp(req)}`, { requestsPerWindow: 3, windowSeconds: 60 * 60 })
  if (!allowed) return

  const { email: rawEmail } = req.body ?? {}
  const email = typeof rawEmail === 'string' ? rawEmail.trim() : rawEmail
  if (!isValidEmailAddress(email)) {
    return res.status(400).json({ error: 'invalid_request', message: 'A valid email address is required.' })
  }

  try {
    const pending = await getPendingRegistration(email)
    if (pending && pending.status === 'pending_verification') {
      await sendVerificationEmail(req, pending)
    }
  } catch (err) {
    if (!(err instanceof TokenStoreUnavailableError) && !(err instanceof PendingRegistrationStoreUnavailableError) && !(err instanceof EmailSenderUnavailableError)) throw err
    console.error(`[session/resend-verification] ${err.message}`)
  }

  return res.status(200).json(GENERIC_REGISTER_RESPONSE)
}

// GET /api/session/verify-email-status?token=  -- non-consuming peek,
// mirrors reset-status exactly (deliberately reveals only valid/invalid,
// nothing else).
async function verifyEmailStatus(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  const token = req.query?.token
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'invalid_request', message: 'A token is required.' })
  }
  try {
    const result = await peekVerifyEmailToken(token)
    return res.status(200).json({ valid: Boolean(result) })
  } catch (err) {
    if (err instanceof TokenStoreUnavailableError) {
      console.error(`[session/verify-email-status] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'This is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// POST /api/session/verify-email  { token }
// Same atomic-consume/partial-failure-recovery contract as accept-invite/
// reset-password (tokenStore.js's GETDEL + *-pending safety net). On
// success, issues the SEPARATE, short-lived lta_pending_signup token --
// never lta_session, never anything requireAuth()/evaluateSession() will
// accept -- and returns just enough for the frontend to render
// /get-started (email, companyName).
async function verifyEmail(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const allowed = await enforceRateLimit(req, res, `verify-email:${clientIp(req)}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  const { token } = req.body ?? {}
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'invalid_request', message: 'A valid verification link is required.' })
  }

  let consumed
  try {
    consumed = await consumeVerifyEmailToken(token)
  } catch (err) {
    if (err instanceof TokenStoreUnavailableError) {
      console.error(`[session/verify-email] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Verification is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
  if (!consumed) {
    return res.status(400).json({ error: 'invalid_or_expired_token', message: 'This verification link is invalid, expired, or has already been used.' })
  }
  const { payload, tokenHash, fromPending } = consumed
  const { email } = payload

  if (!fromPending) {
    await markVerifyEmailConsumedPending(tokenHash, payload)
  }

  try {
    const pending = await getPendingRegistration(email)
    if (!pending) {
      return res.status(404).json({ error: 'not_found', message: 'This registration is no longer available. Please register again.' })
    }
    const updated = await updatePendingRegistration(email, {
      emailVerified: true,
      verifiedAt: new Date().toISOString(),
      status: pending.status === 'pending_verification' ? 'verified_awaiting_plan' : pending.status,
      verifyTokenHash: null,
    })

    const pendingSignupToken = await signPendingSignupToken({ userId: updated.userId, email: updated.email })
    setCookie(res, PENDING_SIGNUP_COOKIE, pendingSignupToken, { maxAgeSeconds: PENDING_SIGNUP_TTL_SECONDS })

    await clearVerifyEmailConsumedPending(tokenHash)
    return res.status(200).json({ email: updated.email, companyName: updated.companyName })
  } catch (err) {
    if (err instanceof PendingRegistrationStoreUnavailableError) {
      console.error(`[session/verify-email] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Could not finish verifying your email. Please try this link again in a moment.' })
    }
    throw err
  }
}

// Shared by get-started/pricing/access-code pages: resolves the caller's
// pending registration from the lta_pending_signup cookie ONLY -- never
// from a request body/query value. Returns null (caller responds 401) if
// the cookie is missing, expired, or its registration no longer exists.
async function requirePendingSignup(req, res) {
  const cookies = parseCookies(req)
  const claims = await verifyPendingSignupToken(cookies[PENDING_SIGNUP_COOKIE])
  if (!claims) {
    res.status(401).json({ error: 'unauthenticated', message: 'Please verify your email to continue.' })
    return null
  }
  let pending
  try {
    pending = await getPendingRegistration(claims.email)
  } catch (err) {
    if (err instanceof PendingRegistrationStoreUnavailableError) {
      console.error(`[session] ${err.message}`)
      res.status(503).json({ error: 'service_unavailable', message: 'This is temporarily unavailable. Please try again shortly.' })
      return null
    }
    throw err
  }
  if (!pending || pending.userId !== claims.userId) {
    res.status(404).json({ error: 'not_found', message: 'This registration is no longer available. Please register again.' })
    return null
  }
  return pending
}

// GET /api/session/get-started-status
async function getStartedStatus(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  const pending = await requirePendingSignup(req, res)
  if (!pending) return
  return res.status(200).json({
    email: pending.email, companyName: pending.companyName, displayName: pending.displayName,
    status: pending.status,
  })
}

// The tenant-creation transaction -- the ONE path both redeemAccessCode()
// and selectPlan() (once Phase 4Q.2 wires real payment) funnel into.
// `commercial` is plain descriptive metadata (see tenantConfigStore.js's
// `commercial` field) -- never consulted by any authorization check.
//
// ORDER, and why:
//   1. Acquire a short-lived per-email lock (pendingRegistrationStore.js)
//      -- closes the "two tenant-creation requests racing" case: the
//      loser fails closed with TenantCreationInProgressError rather than
//      both proceeding.
//   2. Re-read the pending registration FRESH, now that the lock is held
//      -- a request that was queued behind the lock must never act on a
//      stale in-memory copy from before it waited.
//   3. createNewTenant() (tenantCreation.js) -- the ONE centralized
//      tenant-creation primitive every mode (self-service here; future
//      admin/migration tooling elsewhere) goes through. It performs its
//      OWN re-check of getAccountByEmailRequireRedisHealthy(email), even
//      though register() already checked once -- registration can sit
//      unverified/unconverted for up to 7 days, and an operator invite or
//      a second registration could have created a REAL account for this
//      email in that window. If one now exists, createNewTenant() throws
//      IdentityAlreadyExistsError, translated here to the same
//      EmailNowOccupiedError this endpoint has always thrown. It is also
//      the one place FAIL-CLOSED on a Redis identity-verification failure
//      (UserStoreUnavailableError propagates, never silently treated as
//      "no account exists").
//      `reservedTenantId: fresh.tenantIdReserved` is exactly the id
//      register() minted via generateTenantId() at REGISTRATION time --
//      passing it through (self-service mode never mints its own id when
//      one is given) is what makes a retry after a partial failure
//      idempotent: createNewTenant() finds its own prior tenant_config
//      write already there (same reasoning as Phase 4O/4P's own
//      reconciliation logic) and completes only the still-outstanding
//      owner-user write, rather than orphaning a fresh tenant every retry.
//      passwordHash/passwordSetAt are carried over UNCHANGED from
//      registration (the user already set their own password; there is no
//      invite-accept password-setting step to replay here).
//   4. Delete the pending registration -- from this point on, the ONLY
//      record of this identity is the real tenant_config/user pair.
//   5. Release the lock (always, via finally).
async function createTenantForVerifiedRegistration(email, commercial) {
  const lockAcquired = await acquireTenantCreationLock(email)
  if (!lockAcquired) {
    throw new TenantCreationInProgressError('Your workspace is already being created. Please wait a moment and try again.')
  }
  try {
    const fresh = await getPendingRegistration(email)
    if (!fresh) {
      throw new PendingRegistrationNotFoundError('This registration is no longer available.')
    }
    if (fresh.status === 'completed') {
      throw new TenantCreationInProgressError('This registration has already been completed. Please sign in.')
    }
    if (fresh.status !== 'verified_awaiting_plan') {
      throw new PendingRegistrationNotFoundError('This registration is not ready for tenant creation.')
    }

    await updatePendingRegistration(email, { status: 'creating_tenant' })

    // "Prevent duplicate/shadow tenant creation" hardening: the identity
    // occupied-check, the tenant-already-exists idempotent-retry handling,
    // the fail-closed Redis-identity verification, and the actual
    // tenant_config+owner-user writes all now live in ONE reviewed,
    // centralized primitive (tenantCreation.js's createNewTenant()) --
    // this function no longer performs any of those steps by hand.
    // `reservedTenantId: fresh.tenantIdReserved` is exactly the id
    // register() minted via generateTenantId() at registration time;
    // passing it through (rather than letting createNewTenant() mint a
    // NEW one) is what preserves this exact retry contract: a second
    // attempt (this same function, called again after a partial failure)
    // reuses that one id instead of orphaning a fresh one every time.
    let tenantId, userRecord
    try {
      ;({ tenantId, userRecord } = await createNewTenant({
        mode: TenantCreationMode.SELF_SERVICE,
        reservedTenantId: fresh.tenantIdReserved,
        companyName: fresh.companyName,
        ownerEmail: fresh.email, ownerUserId: fresh.userId, ownerPasswordHash: fresh.passwordHash,
        ownerDisplayName: fresh.displayName, ownerPasswordSetAt: fresh.createdAt,
        commercial,
      }))
    } catch (err) {
      if (err instanceof IdentityAlreadyExistsError) {
        await updatePendingRegistration(email, { status: 'blocked_email_occupied' })
        throw new EmailNowOccupiedError('An account for this email already exists. Please sign in instead, or contact support.')
      }
      throw err
    }

    await deletePendingRegistration(email)

    return { tenantId, userRecord }
  } finally {
    await releaseTenantCreationLock(email)
  }
}

async function issueRealSessionAndRespond(res, userRecord, tenantId) {
  const sessionToken = await signSession({
    userId: userRecord.userId, email: userRecord.email, role: userRecord.role,
    locationIds: userRecord.locationIds, tenantId, sessionVersion: userRecord.sessionVersion,
  }, { expiresInSeconds: SESSION_TTL_SECONDS })
  setCookie(res, SESSION_COOKIE, sessionToken, { maxAgeSeconds: SESSION_TTL_SECONDS })
  clearCookie(res, PENDING_SIGNUP_COOKIE)
  return res.status(200).json({
    account: {
      userId: userRecord.userId, email: userRecord.email, role: userRecord.role,
      locationIds: userRecord.locationIds, displayName: userRecord.displayName ?? userRecord.email,
    },
  })
}

// POST /api/session/redeem-access-code  { code }
// Identity comes ONLY from the lta_pending_signup cookie -- the client
// sends the raw code string and nothing else. tenantId/userId used for
// redemption bookkeeping are the SAME server-derived values used for
// tenant creation, never request input.
async function redeemAccessCodeAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const allowed = await enforceRateLimit(req, res, `redeem-access-code:${clientIp(req)}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  const pending = await requirePendingSignup(req, res)
  if (!pending) return

  const secondAllowed = await enforceRateLimit(req, res, `redeem-access-code-identity:${pending.userId}`, { requestsPerWindow: 10, windowSeconds: 60 * 10 })
  if (!secondAllowed) return

  const { code } = req.body ?? {}
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'invalid_request', message: 'An access code is required.' })
  }

  let redemption
  try {
    redemption = await redeemAccessCode({
      rawCode: code.trim(), email: pending.email,
      tenantId: pending.tenantIdReserved, userId: pending.userId,
    })
  } catch (err) {
    if (err instanceof AccessCodeInvalidError || err instanceof AccessCodeRestrictedError) {
      return res.status(400).json({ error: 'invalid_access_code', message: err.message })
    }
    if (err instanceof AccessCodeStoreUnavailableError) {
      console.error(`[session/redeem-access-code] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'This is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }

  try {
    const { tenantId, userRecord } = await createTenantForVerifiedRegistration(pending.email, {
      plan: redemption.plan,
      source: 'access_code',
      accessCodeHash: redemption.codeHash,
      trialEndsAt: redemption.trialDays ? new Date(Date.now() + redemption.trialDays * 24 * 60 * 60 * 1000).toISOString() : null,
    })
    await appendAuditEntry(tenantId, {
      actorId: userRecord.userId, actorEmail: userRecord.email, ip: clientIp(req),
      action: 'tenant.created_via_access_code', entity: 'tenant', entityId: tenantId,
      result: 'success', message: `Tenant created via access code (plan: ${redemption.plan}).`,
    })
    return issueRealSessionAndRespond(res, userRecord, tenantId)
  } catch (err) {
    if (err instanceof EmailNowOccupiedError) {
      return res.status(409).json({ error: 'email_occupied', message: err.message })
    }
    if (err instanceof TenantCreationInProgressError) {
      return res.status(409).json({ error: 'creation_in_progress', message: err.message })
    }
    if (err instanceof PendingRegistrationNotFoundError) {
      return res.status(404).json({ error: 'not_found', message: err.message })
    }
    if (err instanceof PendingRegistrationStoreUnavailableError || err instanceof TenantConfigStoreUnavailableError || err instanceof UserStoreUnavailableError) {
      console.error(`[session/redeem-access-code] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Could not finish setting up your workspace. Please try again in a moment.' })
    }
    throw err
  }
}

// POST /api/session/select-plan  { plan }
// Phase 4Q.1: ALWAYS the stubbed "not available" response -- see
// paymentProvider.js. No tenant is ever created by this action today.
// Phase 4Q.2 (separately reviewed) replaces the inside of the try block
// with a real Stripe checkout redirect; the surrounding shape (validate
// plan, resolve pending signup, never create a tenant without confirmed
// payment) does not change.
async function selectPlan(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const allowed = await enforceRateLimit(req, res, `select-plan:${clientIp(req)}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  const pending = await requirePendingSignup(req, res)
  if (!pending) return

  const { plan } = req.body ?? {}
  if (!isValidPlanId(plan)) {
    return res.status(400).json({ error: 'invalid_request', message: 'Choose a valid plan.' })
  }

  try {
    await createCheckoutSession(PLANS[plan], pending.email)
    // Unreachable today (createCheckoutSession always throws) -- kept so
    // Phase 4Q.2 only has to change paymentProvider.js's implementation,
    // not this action's shape.
    return res.status(200).json({ error: 'not_implemented' })
  } catch (err) {
    if (err instanceof PaymentNotConfiguredError) {
      return res.status(503).json({
        error: 'checkout_not_available',
        message: 'Plan checkout isn\'t available yet. Use an access code, or contact sales to get started.',
      })
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
    case 'register':               return register(req, res)
    case 'resend-verification':    return resendVerification(req, res)
    case 'verify-email-status':    return verifyEmailStatus(req, res)
    case 'verify-email':           return verifyEmail(req, res)
    case 'get-started-status':     return getStartedStatus(req, res)
    case 'redeem-access-code':     return redeemAccessCodeAction(req, res)
    case 'select-plan':            return selectPlan(req, res)
    default:                 return res.status(404).json({ error: 'not_found' })
  }
}
