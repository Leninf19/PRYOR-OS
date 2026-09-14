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
import { resolveTenantEntitlementsFromConfig } from '../_lib/entitlementResolution.js'
import { requireCommercialOperation, commercialDenialResponse, CommercialOperationClass } from '../_lib/commercialOperationPolicy.js'
import { maybeStartTrial, maybeStartAccessCodeTrial } from '../_lib/trialLifecycle.js'
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
import {
  redeemAccessCode, previewAccessCode, getAccessCodeRedemptionClaim, clearAccessCodeRedemptionClaim,
  AccessCodeInvalidError, AccessCodeRestrictedError, AccessCodeStoreUnavailableError,
} from '../_lib/accessCodeStore.js'
import { buildAccessCodeCommercialWrite, PaymentRequiredNotSupportedError, InvalidAccessCodeGrantError } from '../_lib/accessCodeCommercial.js'
import { isValidPlanId, PLANS } from '../_lib/plans.js'
import { isSelfServicePlan } from '../_lib/stripePriceMap.js'
import { CURRENT_BILLING_TERMS_VERSION } from '../_lib/billingTerms.js'
import { buildSelfServicePendingActivationCommercial, SELF_SERVICE_TRIAL_DAYS } from '../_lib/selfServiceCommercial.js'
import {
  ensureStripeCustomerForTenant, createSetupCheckoutSession,
  BillingUrlNotConfiguredError, BillingSetupRecoveryRequiredError,
} from '../_lib/billingCustomer.js'
import {
  updateBillingRecord, getBillingRecord, getTenantIdForCustomer,
  claimStripeEvent, markStripeEventProcessed, markStripeEventFailed,
  BillingVersionConflictError, BillingStoreUnavailableError,
  isValidStripeCustomerId, isValidStripePaymentMethodId,
} from '../_lib/billingStore.js'
import { getStripeClient, StripeNotConfiguredError } from '../_lib/stripeClient.js'

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
// Phase B.6: presentational-only mapping of the resolver's raw `trialStatus`
// (null | 'active' | 'expired' | 'converted' -- entitlementResolution.js)
// onto the frontend-facing 'not_started' sentinel for "no trial exists yet
// or ever." This is a display translation, never a resolver contract
// change -- the resolver's own bundle keeps using null internally (every
// existing B.2-B.5 test that reads the raw bundle is unaffected).
// Deliberately exposes ONLY the fields a future UI needs -- never a claim
// token, the GBP trial-claim internal key, commercialIdentityKey, an
// access-code hash, or any other internal anti-fraud metadata.
function toSafeCommercialView(entitlements) {
  const trialStatus = entitlements.trialStatus ?? 'not_started'
  let trialSecondsRemaining = null
  if (trialStatus === 'active' && entitlements.trialEndsAt) {
    trialSecondsRemaining = Math.max(0, Math.round((Date.parse(entitlements.trialEndsAt) - Date.now()) / 1000))
  }
  return {
    plan: entitlements.effectivePlan,
    commercialStatus: entitlements.commercialStatus,
    trialStatus,
    trialStartedAt: entitlements.trialStartedAt ?? null,
    trialEndsAt: entitlements.trialEndsAt ?? null,
    trialSecondsRemaining,
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

  // Phase B.6 -- 7-day Growth trial: a lazy, read-time reaction, exactly
  // like the provisioning-reconciliation check just above. maybeStartTrial()
  // is a no-op unless this tenant is genuinely eligible (status === 'active'
  // for the first time, no commercial decision yet) and never throws for an
  // ordinary "not eligible"/"already decided" case. If it DOES start a
  // trial, `config` here is the freshly-written record -- recompute
  // `commercial` from THIS SAME object (the pure, no-I/O resolver, never a
  // second independent read) so this response reflects the trial
  // immediately rather than on the next poll.
  const configBeforeTrialCheck = config
  config = await maybeStartTrial(tenantId, config)
  // Phase B.8 -- the access-code trial's own lazy activation, mutually
  // exclusive with maybeStartTrial() above (a tenant has EITHER
  // trialEligibility OR accessCodeGrant set, never both -- see
  // trialLifecycle.js's own header). Chained the same way: a no-op unless
  // this specific tenant has a pending access-code trial grant.
  config = await maybeStartAccessCodeTrial(tenantId, config)
  const commercialForResponse = config === configBeforeTrialCheck ? commercial : toSafeCommercialView(resolveTenantEntitlementsFromConfig(config))

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
    commercial: commercialForResponse,
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
//
// Phase B.7 pre-commit correction (Part 2): commercial eligibility is now
// checked via a NON-DESTRUCTIVE peekInviteToken() BEFORE the real,
// irreversible consumeInviteToken() (GETDEL) -- a suspended/canceled/
// resolver-failure denial must never burn the invite's single use, since a
// legitimate reactivation later must be able to use the SAME link. The
// actual single-use/replay guarantee is unchanged: it still lives entirely
// in the one atomic consumeInviteToken() call below, reached only once
// commercial eligibility is confirmed -- two concurrent accepts still race
// on that same GETDEL exactly as before, so replay protection is not
// weakened by adding a read-only check ahead of it.
// Phase B.7 pre-commit correction (Part 2) helper -- given an invite
// token's payload (from either a fresh peekInviteToken() or a
// consumeInviteToken() resolution), returns null if commercial eligibility
// allows activation, or an already-audited { status, body } to send back
// if not. Shared by both branches of acceptInvite() below (fresh-token and
// retry-via-pending-record), so the SAME check runs regardless of which
// path resolved the payload.
async function resolveAcceptInviteDenial(payload, req) {
  const userId = payload.userId
  const indexedTenantIdForCheck = await lookupTenantIdForUserId(userId)
  const tenantIdForCheck = indexedTenantIdForCheck ?? resolveBootstrapTenantId()

  // Phase B.7 (Part F/B) -- OPERATIONAL_WRITE: accepting an invite does NOT
  // consume a NEW seat (the invitation was already counted as a seat at
  // issue time, per countActiveOrInvitedUsers()), so past_due allows it
  // (OPERATIONAL_WRITE's own policy shape) -- but a suspended/canceled
  // tenant must not gain a newly-USABLE session.
  const entitlements = await resolveTenantEntitlements(tenantIdForCheck)
  const opCheck = requireCommercialOperation(entitlements, CommercialOperationClass.OPERATIONAL_WRITE)
  if (opCheck.allowed) return null

  await appendAuditEntry(tenantIdForCheck, {
    actorId: userId, actorEmail: payload.email, ip: clientIp(req),
    action: 'invitation.accept_denied_commercial_status', entity: 'user', entityId: userId,
    result: 'denied', message: `Invitation acceptance was denied: commercialStatus is ${opCheck.commercialStatus ?? 'unresolvable'}. The invitation link remains valid for a future retry.`,
  })
  return commercialDenialResponse(opCheck)
}

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

  // Phase B.7 pre-commit correction (Part 2) -- a non-destructive
  // peekInviteToken() first, so a FRESH (not-yet-consumed) token's
  // commercial eligibility can be checked and, if denied, the token is
  // NEVER touched at all. peekInviteToken() only ever resolves the primary
  // key (tokenStore.js's own contract -- it deliberately never checks the
  // pending-retry fallback), so `peeked === null` here does not yet mean
  // "invalid" -- it may equally mean "already consumed by an earlier
  // attempt of THIS SAME accept, now recoverable via the pending safety-net
  // record" (see tokenStore.js's header for that contract). That case is
  // resolved below by calling the real consumeInviteToken() directly,
  // which DOES check the pending fallback -- a safe, non-destructive
  // resolution for a genuine retry (nothing is deleted when it resolves
  // via the pending record), so running the SAME commercial check after
  // that resolution is equally harmless: a denial there leaves the pending
  // record intact for a further retry.
  let peeked
  try {
    peeked = await peekInviteToken(token)
  } catch (err) {
    if (err instanceof TokenStoreUnavailableError) {
      console.error(`[session/accept-invite] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Account setup is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }

  let consumed
  if (peeked) {
    // Fresh token -- check eligibility BEFORE ever consuming it.
    const denial = await resolveAcceptInviteDenial(peeked.payload, req)
    if (denial) return res.status(denial.status).json(denial.body)

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
      // Lost a race against a concurrent accept between the peek above and
      // this consume -- never a commercial denial, the same generic
      // invalid/expired response as any other exhausted token.
      return res.status(400).json({ error: 'invalid_or_expired_token', message: 'This invitation link is invalid, expired, or has already been used.' })
    }
  } else {
    // No fresh primary key -- resolve via consumeInviteToken() itself,
    // which additionally checks the pending-retry fallback.
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
    // Resolved via the pending record (or, vanishingly unlikely, a fresh
    // key that appeared between the peek and this consume) -- check
    // eligibility now. A denial here does not burn anything further: the
    // pending record is untouched by a from-pending resolution, so it
    // remains available for yet another retry.
    const denial = await resolveAcceptInviteDenial(consumed.payload, req)
    if (denial) return res.status(denial.status).json(denial.body)
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
// and tenant creation via access code. selectPlan() below (Phase B.11)
// collects a saved payment method via Stripe Setup-mode Checkout -- no
// Subscription/charge/PRYOR trial starts here. Every write below goes
// through the SAME
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
async function createTenantForVerifiedRegistration(email, commercial, accessCodeGrant = null, trialEligibility = null) {
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
        commercial, accessCodeGrant, trialEligibility,
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
//
// Phase B.8 corrections:
//   1. (Part E) previewAccessCode() -- a non-destructive peek -- runs
//      FIRST. A paymentRequired: true code is rejected here, before the
//      real, irreversible redeemAccessCode() atomic consume ever runs, so
//      a code Stripe/billing cannot yet honor is never burned by a
//      rejected attempt.
//   2. (Part 2, final pre-commit correction) recovery is now keyed by the
//      DURABLE accessCodeStore.js redemption-claim ledger (one Redis key
//      per normalized email, written atomically inside REDEEM_SCRIPT
//      itself, with its own 30-day TTL) -- NOT the pending-registration
//      record's own `accessCodeRedemption` field, which this phase's
//      earlier draft relied on. That field's storage is only as durable as
//      the pending-registration record's own TTL, which is refreshed by
//      ordinary registration activity but is NOT a genuine durability
//      guarantee for an already-atomically-consumed access-code
//      redemption slot -- if THAT record expired before tenant creation
//      ever completed, the stored redemption result would be lost even
//      though the code itself stayed permanently burned. The claim ledger
//      is checked FIRST, before ever looking at the request body: if this
//      email has already redeemed a code (whether in this exact request's
//      earlier attempt, an earlier session, or even after re-registering
//      the same email from scratch), that frozen result is used and
//      redeemAccessCode() is never called again -- so a maxRedemptions: 1
//      code can never be exhausted by a legitimate customer's own retry,
//      no matter how long the underlying failure takes to recover from. A
//      DIFFERENT registrant's email is a structurally different ledger
//      key -- there is nothing to inherit or steal.
async function redeemAccessCodeAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const allowed = await enforceRateLimit(req, res, `redeem-access-code:${clientIp(req)}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  const pending = await requirePendingSignup(req, res)
  if (!pending) return

  const secondAllowed = await enforceRateLimit(req, res, `redeem-access-code-identity:${pending.userId}`, { requestsPerWindow: 10, windowSeconds: 60 * 10 })
  if (!secondAllowed) return

  let redemption
  try {
    redemption = await getAccessCodeRedemptionClaim(pending.email)
  } catch (err) {
    if (err instanceof AccessCodeStoreUnavailableError) {
      console.error(`[session/redeem-access-code] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'This is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }

  if (!redemption) {
    const { code } = req.body ?? {}
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'invalid_request', message: 'An access code is required.' })
    }
    const rawCode = code.trim()

    let preview
    try {
      preview = await previewAccessCode({ rawCode, email: pending.email })
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

    // Phase B.8 (Part E) -- checked on the PREVIEW, before any real
    // consume. See accessCodeCommercial.js's own header for why rejection,
    // not a fabricated 'pending_payment' status, is this phase's chosen
    // smallest-safe behavior. A rejected paymentRequired code never
    // reaches redeemAccessCode() at all, so redemptionCount is never
    // touched.
    if (preview.paymentRequired === true) {
      return res.status(400).json({ error: 'payment_not_yet_supported', message: 'This access code requires payment, which is not yet supported. Please contact support.' })
    }

    try {
      // redeemAccessCode() itself atomically writes the durable claim
      // (accessCodeStore.js's REDEEM_SCRIPT) in the SAME operation that
      // increments redemptionCount -- there is no window where one
      // happens without the other.
      redemption = await redeemAccessCode({
        rawCode, email: pending.email,
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
  }

  let commercial, accessCodeGrant
  try {
    ;({ commercial, accessCodeGrant } = buildAccessCodeCommercialWrite(redemption))
  } catch (err) {
    if (err instanceof PaymentRequiredNotSupportedError) {
      // Defensive only -- previewAccessCode() above already rejects
      // paymentRequired: true before ever reaching a real redemption, so
      // this should be unreachable for a fresh redemption. It remains
      // reachable only for a durable claim recovered from BEFORE this
      // phase's own correction (an old-shape/pre-fix claim) -- fail closed
      // with the same stable error, never fabricate access.
      return res.status(400).json({ error: 'payment_not_yet_supported', message: err.message })
    }
    if (err instanceof InvalidAccessCodeGrantError) {
      console.error(`[session/redeem-access-code] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'This access code could not be processed. Please contact support.' })
    }
    throw err
  }

  try {
    const { tenantId, userRecord } = await createTenantForVerifiedRegistration(pending.email, commercial, accessCodeGrant)
    // Best-effort -- see clearAccessCodeRedemptionClaim()'s own comment for
    // why a failure here has no security consequence (createNewTenant()'s
    // identity check already makes a genuine second tenant for this email
    // impossible regardless).
    await clearAccessCodeRedemptionClaim(pending.email)
    await appendAuditEntry(tenantId, {
      actorId: userRecord.userId, actorEmail: userRecord.email, ip: clientIp(req),
      action: 'tenant.created_via_access_code', entity: 'tenant', entityId: tenantId,
      result: 'success',
      message: accessCodeGrant
        ? `Tenant created via access-code trial grant (plan: ${accessCodeGrant.plan}, trialDays: ${accessCodeGrant.trialDays}, pending activation).`
        : `Tenant created via access code (plan: ${commercial.plan}).`,
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

// POST /api/session/select-plan  { plan, recurringBillingAccepted }
//
// Phase B.11 -- the first real Stripe payment-method-collection path. This
// action does NOT create a Subscription, does NOT charge anything, and
// does NOT start a PRYOR trial -- it only: (1) records the customer's
// server-validated intended post-trial plan, (2) records their explicit
// recurring-billing consent with a SERVER timestamp, (3) ensures exactly
// one Stripe Customer exists for this (still pre-tenant) registrant, and
// (4) returns a Setup-mode Checkout Session URL for the browser to redirect
// to. B.12 is what bridges a later, authoritative initialSync.completedAt
// into an actual Subscription.
//
// AUTHORIZATION (Part G): requirePendingSignup() is the entire
// authorization boundary here, exactly as it already is for
// redeemAccessCodeAction() -- there is no tenant, no user record, and no
// role to check yet at this point in the self-service funnel (see
// createTenantForVerifiedRegistration()'s own header for why tenant
// creation is deliberately deferred this late). The sole holder of a
// valid, unexpired lta_pending_signup cookie (issued ONLY by verifyEmail(),
// so its mere possession already proves email verification -- Part Q) is
// unconditionally the person who will become this tenant's first Owner the
// moment a real tenant is ever created; there is structurally no "tenant
// Admin" or any other role that could reach this action instead. tenantId
// is ALWAYS `pending.tenantIdReserved` (minted server-side at register()
// time) -- never accepted from the request body.
async function selectPlan(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const allowed = await enforceRateLimit(req, res, `select-plan:${clientIp(req)}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  const pending = await requirePendingSignup(req, res)
  if (!pending) return
  // Belt-and-suspenders beyond the cookie check above: a registration that
  // has already moved past plan-selection (tenant creation in progress,
  // completed, or blocked) must not be allowed to start a second, stale
  // billing-setup attempt.
  if (pending.status !== 'verified_awaiting_plan') {
    return res.status(409).json({ error: 'invalid_state', message: 'This registration is not ready for plan selection.' })
  }

  const { plan, recurringBillingAccepted } = req.body ?? {}
  // Enterprise (and any other non-canonical value) is rejected here --
  // never self-service, per Part C/E/R. isValidPlanId() alone would still
  // accept 'enterprise'; isSelfServicePlan() is the actual gate.
  if (!isValidPlanId(plan) || !isSelfServicePlan(plan)) {
    return res.status(400).json({ error: 'invalid_plan', message: 'Choose Core or Growth. Enterprise is available by contacting sales.' })
  }
  // The server NEVER trusts a client-supplied acceptedAt/termsVersion --
  // CURRENT_BILLING_TERMS_VERSION is stamped unconditionally below,
  // regardless of anything the request claims. The checkbox itself is
  // unchecked by default in the UI (Pricing.jsx) -- this boolean must be
  // explicitly true, never defaulted/assumed.
  if (recurringBillingAccepted !== true) {
    return res.status(400).json({ error: 'consent_required', message: 'Please confirm recurring billing to continue.' })
  }

  const tenantId = pending.tenantIdReserved

  let customerId
  try {
    ;({ customerId } = await ensureStripeCustomerForTenant(tenantId, pending.email))
  } catch (err) {
    if (err instanceof StripeNotConfiguredError) {
      console.error(`[session/select-plan] ${err.message}`)
      return res.status(503).json({ error: 'billing_not_configured', message: 'Plan checkout isn\'t available yet. Use an access code, or contact sales to get started.' })
    }
    if (err instanceof BillingSetupRecoveryRequiredError) {
      console.error(`[session/select-plan] ${err.message}`)
      return res.status(503).json({ error: 'billing_setup_recovery_required', message: 'We could not confirm your billing setup. Please contact support.' })
    }
    throw err
  }

  // Phase B.11 pre-commit correction (Part 5) -- the consent snapshot now
  // records WHAT commercial terms were actually accepted, not merely that
  // a checkbox was checked. Every field below except `recurringBillingAccepted`
  // itself is SERVER-DERIVED from the already-validated `plan` -- never
  // trusted from the request body (a client-supplied amount/currency/
  // interval/trialDays/termsVersion is silently ignored, matching
  // acceptedAt/termsVersion's existing discipline just above). Written in
  // the SAME atomic update as `pendingPaidPlan`, so the two can never
  // drift: selecting a DIFFERENT plan later always re-runs this exact
  // block again, producing a fresh consent snapshot for the NEW plan/price
  // -- there is no code path that updates `pendingPaidPlan` without also
  // rewriting `consent` to match.
  const consentedAt = new Date().toISOString()
  const planMetadata = PLANS[plan]
  const consent = {
    acceptedAt: consentedAt,
    termsVersion: CURRENT_BILLING_TERMS_VERSION,
    recurringBillingAccepted: true,
    acceptedPlanId: plan,
    acceptedAmountCents: planMetadata.priceCents,
    currency: 'usd',
    billingInterval: planMetadata.billingPeriod,
    trialDays: SELF_SERVICE_TRIAL_DAYS,
  }
  const existing = await getBillingRecord(tenantId)
  try {
    await updateBillingRecord(tenantId, { pendingPaidPlan: plan, consent }, { expectedVersion: existing.version })
  } catch (err) {
    if (err instanceof BillingVersionConflictError) {
      // A concurrent select-plan call for this same registrant already
      // updated the record -- harmless; the Checkout Session below is
      // still created against the correct, already-bound Customer.
    } else {
      throw err
    }
  }

  let session
  try {
    session = await createSetupCheckoutSession({ tenantId, customerId, plan })
  } catch (err) {
    if (err instanceof BillingUrlNotConfiguredError) {
      console.error(`[session/select-plan] ${err.message}`)
      return res.status(503).json({ error: 'billing_not_configured', message: 'Plan checkout isn\'t available yet. Please try again shortly.' })
    }
    console.error(`[session/select-plan] checkout session creation failed: ${err.message}`)
    return res.status(502).json({ error: 'checkout_creation_failed', message: 'Could not start checkout. Please try again.' })
  }

  // Phase B.11 pre-commit correction (Part 7) -- refresh the
  // pending-registration's own 7-day TTL at the exact moment Checkout is
  // initiated. updatePendingRegistration() already re-applies the full
  // RECORD_TTL_SECONDS window on every write (pendingRegistrationStore.js);
  // this otherwise-no-op patch means the registrant now has a FRESH 7 days
  // to complete Checkout (which Stripe itself caps at 24h) and return to
  // finalize -- comfortably covering the entire flow even if the customer
  // waited until day 6.9 after registration to start it. Best-effort: a
  // failure here is logged but never blocks the response, since the
  // customer's Checkout Session was already successfully created above.
  try {
    await updatePendingRegistration(pending.email, {})
  } catch (err) {
    console.error(`[session/select-plan] failed to refresh pending-registration TTL (non-fatal): ${err.message}`)
  }

  return res.status(200).json({ checkoutUrl: session.url })
}

// POST /api/session/finalize-registration
//
// Phase B.11 pre-commit correction (Part 1) -- closes the gap the original
// B.11 pass left open: authoritative Setup completion (the verified Stripe
// webhook recording defaultPaymentMethodId) never, by itself, materialized
// a real tenant/Owner/session. This is the ONE place that bridge happens.
//
// The browser's mere arrival at /pricing/setup-complete (Stripe's
// success_url) is NEVER treated as proof of anything -- this action reads
// billing readiness SERVER-SIDE, from this codebase's own already-verified
// state (billingRecord.defaultPaymentMethodId, set ONLY by
// stripeWebhookAction() after full signature + SetupIntent-status
// validation), never from a `session_id` query param or any other
// browser-supplied signal. If the webhook hasn't landed yet, this returns
// billing_not_ready (409) -- SetupComplete.jsx polls this endpoint with a
// short bounded retry, so a delayed webhook is a brief wait, not a dead
// end.
//
// Required invariants and how each is met:
//   - fake success URL cannot create a tenant: this action never reads
//     anything from the browser's URL/query string at all.
//   - no payment method confirmation => no finalization: the
//     billingRecord.defaultPaymentMethodId check above is the sole gate.
//   - webhook delayed => customer can safely wait/retry: billing_not_ready
//     is a stable, retryable response, never a terminal error.
//   - browser never returns => no corrupt partial tenant: nothing in this
//     action runs unless/until it is explicitly called; an unfinalized
//     registration simply remains pending (see Part 7's TTL discussion).
//   - duplicate calls => one tenant, one Owner: delegated entirely to
//     createTenantForVerifiedRegistration()'s existing per-email lock +
//     createNewTenant()'s idempotent-retry recognition (unchanged,
//     already proven by the access-code path) -- a concurrent second call
//     fails closed with creation_in_progress; a call after completion
//     fails closed with already_completed/not_found.
//   - same reserved tenantId preserved: createTenantForVerifiedRegistration()
//     always passes fresh.tenantIdReserved through unchanged.
//   - foreign pending signup cannot finalize another tenant: tenantId is
//     ALWAYS pending.tenantIdReserved, resolved exclusively from THIS
//     caller's own pending-signup cookie -- never accepted from the
//     request body.
//   - no client tenantId authority: this action's request body is never
//     read for anything at all.
async function finalizeRegistration(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const allowed = await enforceRateLimit(req, res, `finalize-registration:${clientIp(req)}`, { requestsPerWindow: 20, windowSeconds: 60 })
  if (!allowed) return

  const pending = await requirePendingSignup(req, res)
  if (!pending) return

  if (pending.status === 'completed') {
    return res.status(409).json({ error: 'already_completed', message: 'This registration has already been completed. Please sign in.' })
  }
  // 'creating_tenant' is allowed through (not rejected here) so a
  // concurrent/retried call safely reaches createTenantForVerifiedRegistration()'s
  // own lock, which is the actual, already-reviewed source of truth for
  // "is another attempt for this exact registration in progress" --
  // rejecting it here too would just duplicate that check with a less
  // precise error.
  if (pending.status !== 'verified_awaiting_plan' && pending.status !== 'creating_tenant') {
    return res.status(409).json({ error: 'invalid_state', message: 'This registration is not ready to finalize.' })
  }

  const tenantId = pending.tenantIdReserved
  let billingRecord
  try {
    billingRecord = await getBillingRecord(tenantId)
  } catch (err) {
    if (err instanceof BillingStoreUnavailableError) {
      console.error(`[session/finalize-registration] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'This is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
  if (!billingRecord?.defaultPaymentMethodId || !billingRecord?.pendingPaidPlan) {
    return res.status(409).json({ error: 'billing_not_ready', message: 'Your payment method has not been confirmed yet. Please try again in a moment.' })
  }

  const { commercial, trialEligibility } = buildSelfServicePendingActivationCommercial()

  try {
    const { tenantId: createdTenantId, userRecord } = await createTenantForVerifiedRegistration(pending.email, commercial, null, trialEligibility)
    await appendAuditEntry(createdTenantId, {
      actorId: userRecord.userId, actorEmail: userRecord.email, ip: clientIp(req),
      action: 'tenant.created_via_self_service_billing', entity: 'tenant', entityId: createdTenantId,
      result: 'success',
      message: `Tenant created via self-service signup (post-trial plan: ${billingRecord.pendingPaidPlan}).`,
    })
    return issueRealSessionAndRespond(res, userRecord, createdTenantId)
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
    throw err
  }
}

// POST /api/session/stripe-webhook
//
// Phase B.11 -- the smallest webhook surface strictly required for Setup
// completion (per Stripe's own documented save-and-reuse flow: handle
// checkout.session.completed, retrieve the SetupIntent it created, read
// its payment_method). Added as one more dispatch case on this ALREADY
// top-level-function-budgeted file rather than a new api/ route file --
// this project is deliberately kept at/under a 10-function headroom target
// below Vercel Hobby's 12-function ceiling (test_vercel_function_budget.js),
// and this file's handler() dispatches purely on req.query.action (never
// req.body) with zero shared pre-dispatch body access, so adding this case
// here costs nothing against that budget and introduces no risk to raw-body
// integrity for this or any other action in this file.
//
// RAW BODY, non-negotiable: Stripe signature verification requires the
// EXACT bytes as sent, never a re-parsed-then-re-stringified copy. Vercel's
// Node function request.body is a LAZILY-COMPUTED getter (per Vercel's own
// docs) -- as long as this function (and everything it calls) NEVER reads
// req.body, the underlying request stream is untouched and safe to consume
// manually via async iteration, which is exactly what collectRawBody() does,
// FIRST, before anything else. This is the standard, documented pattern for
// Stripe webhooks on this exact (request, response) Vercel Node function
// shape. NOTE: this reasoning has not been verified against a live deployed
// instance in this engagement (deployment is out of scope) -- a real
// Stripe-CLI-triggered test-mode webhook against a preview deployment
// should be run once B.11 is deployed, before B.12 depends on this path.
//
// AUTHORITY: this handler's ONLY effect is projecting a saved payment
// method (defaultPaymentMethodId) onto the ALREADY-existing billing
// record. It NEVER touches tenant_config.commercial, never starts/extends
// a PRYOR trial, and never creates a Subscription -- see this file's own
// assertions in tests/test_stripe_webhook.js.
async function collectRawBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function stripeWebhookAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  let rawBody
  try {
    rawBody = await collectRawBody(req)
  } catch (err) {
    console.error(`[session/stripe-webhook] failed to read raw request body: ${err.message}`)
    return res.status(400).json({ error: 'invalid_request' })
  }

  const signature = req.headers['stripe-signature']
  if (!signature || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).json({ error: 'invalid_request' })
  }

  let stripe
  try {
    stripe = getStripeClient()
  } catch (err) {
    if (err instanceof StripeNotConfiguredError) {
      console.error(`[session/stripe-webhook] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable' })
    }
    throw err
  }

  let event
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error(`[session/stripe-webhook] signature verification failed: ${err.message}`)
    return res.status(400).json({ error: 'invalid_signature' })
  }

  // Only checkout.session.completed, and only for a setup-mode session, is
  // handled in B.11 -- every other event type is acknowledged (200) but
  // otherwise ignored, per this phase's explicit "only implement the
  // event(s) strictly required" instruction.
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true })
  }
  const session = event.data.object
  if (session.mode !== 'setup') {
    return res.status(200).json({ received: true })
  }

  const stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null
  // Phase B.11 pre-commit correction (Part 6) -- structural validation
  // before this id is trusted for anything (index lookup included).
  if (!isValidStripeCustomerId(stripeCustomerId)) {
    console.error(`[session/stripe-webhook] checkout.session.completed carried a malformed customer id -- acknowledging without processing`)
    return res.status(200).json({ received: true })
  }
  // The reverse index is authoritative -- session.metadata.tenantId (set by
  // THIS codebase at Checkout Session creation) is cross-check information
  // only, never trusted alone, per B.10/B.11's own metadata discipline.
  const tenantId = stripeCustomerId ? await getTenantIdForCustomer(stripeCustomerId) : null
  if (!tenantId) {
    console.error(`[session/stripe-webhook] checkout.session.completed for an unrecognized Stripe customer -- acknowledging without processing`)
    return res.status(200).json({ received: true })
  }
  if (session.metadata?.tenantId && session.metadata.tenantId !== tenantId) {
    console.error(`[session/stripe-webhook] metadata/tenantId mismatch on event ${event.id} -- the reverse index is authoritative; metadata is treated as a security anomaly and ignored`)
  }

  let claim
  try {
    claim = await claimStripeEvent({
      eventId: event.id, eventType: event.type, stripeCreatedAt: event.created,
      providerObjectId: stripeCustomerId, tenantId,
    })
  } catch (err) {
    // Transient (billing store unreachable, etc.) -- nothing was claimed,
    // so there is no ledger state to protect. Retryable.
    console.error(`[session/stripe-webhook] failed to claim event ${event.id}: ${err.message}`)
    return res.status(503).json({ error: 'service_unavailable' })
  }
  if (!claim.claimed) {
    if (claim.reason === 'already_processed') {
      // The ONLY case that is genuinely, durably done -- reapplying would
      // be a no-op at best and a double-application risk at worst.
      return res.status(200).json({ received: true })
    }
    // claim.reason === 'lease_active' -- Phase B.11 final pre-commit
    // correction (webhook delivery semantics). Another worker currently
    // holds this event's processing lease. Returning 200 here would be a
    // FALSE acknowledgement: Worker A (the lease holder) could still crash
    // before finalizing, in which case Stripe would believe delivery
    // already succeeded (because Worker B answered 200) and would never
    // redeliver -- permanently stranding an event whose billing fact was
    // never actually applied. Returning a retryable non-2xx instead costs
    // nothing (Stripe redelivers on its own backoff schedule) and
    // preserves at-least-once delivery: by the time the redelivery lands,
    // Worker A has either finished (next claim sees 'already_processed' ->
    // 200) or its 120s lease has expired (next claim reclaims and actually
    // processes it). The ledger is NOT mutated here -- ownership stays with
    // whichever worker currently holds the lease.
    console.error(`[session/stripe-webhook] event ${event.id} is currently owned by another in-flight delivery -- returning retryable response rather than a false acknowledgement`)
    return res.status(503).json({ error: 'processing_in_progress' })
  }

  try {
    // Phase B.11 pre-commit correction (Part 6) -- harden Setup completion
    // validation. Every fact below is verified BEFORE anything is
    // persisted; Stripe's own documented Setup flow is followed
    // explicitly, never assumed. A DETERMINISTIC anomaly (one that would
    // observe the identical result on any redelivery of this same
    // immutable event) is terminal: marked processed, never failed, and
    // never results in a payment method being recorded. A fact that could
    // legitimately still be resolving (see setup_intent_status handling
    // below) is instead marked failed/retryable, never processed.
    const setupIntentId = typeof session.setup_intent === 'string' ? session.setup_intent : session.setup_intent?.id ?? null
    if (!setupIntentId) {
      console.error(`[session/stripe-webhook] checkout.session.completed for tenant ${tenantId} carried no setup_intent -- acknowledging, not processing`)
      await markStripeEventProcessed(event.id, claim.processingToken, 'no_setup_intent')
      return res.status(200).json({ received: true })
    }

    // Retrieval failure here (timeout, Stripe SDK connection error, Stripe
    // 429/5xx) throws and is caught by this try's own catch below, which
    // marks the event failed (token-checked, retryable) and returns a
    // retryable 5xx -- it is NOT a deterministic anomaly about the event
    // itself, so it must never be marked processed.
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId)
    if (!setupIntent) {
      console.error(`[session/stripe-webhook] SetupIntent ${setupIntentId} could not be retrieved for tenant ${tenantId} -- acknowledging, not processing`)
      await markStripeEventProcessed(event.id, claim.processingToken, 'setup_intent_not_found')
      return res.status(200).json({ received: true })
    }
    // Only a genuinely SUCCEEDED SetupIntent proves a payment method was
    // saved. Phase B.11 final pre-commit correction (Part 8): Stripe's own
    // documented Checkout Session contract states the session's `status`
    // can already be `complete` (which is what drives this event) while
    // "payment processing may still be in progress" -- this is NOT
    // guaranteed synchronous even for a card-only Setup-mode session, so a
    // non-succeeded status here is not necessarily a dead end. `canceled`
    // is the one status that is genuinely terminal (a canceled SetupIntent
    // cannot later become succeeded) and is treated as a deterministic
    // rejection. Every other non-succeeded status (processing,
    // requires_action, requires_payment_method, requires_confirmation) MAY
    // still resolve to succeeded, but this handler does not subscribe to
    // setup_intent.succeeded/updated, so it cannot observe that later
    // transition on its own -- instead it marks the event FAILED
    // (retryable, token-checked) so Stripe's own webhook retry schedule
    // redelivers the SAME checkout.session.completed event, at which point
    // the SetupIntent is re-fetched fresh and may by then have reached its
    // true terminal state. This never strands a legitimate signup behind a
    // permanently-processed "not succeeded yet" result.
    if (setupIntent.status === 'canceled') {
      console.error(`[session/stripe-webhook] SetupIntent ${setupIntentId} for tenant ${tenantId} is canceled -- terminal, acknowledging without processing`)
      await markStripeEventProcessed(event.id, claim.processingToken, 'setup_intent_canceled')
      return res.status(200).json({ received: true })
    }
    if (setupIntent.status !== 'succeeded') {
      console.error(`[session/stripe-webhook] SetupIntent ${setupIntentId} for tenant ${tenantId} has status ${JSON.stringify(setupIntent.status)}, not yet 'succeeded' -- marking failed/retryable, not processed`)
      await markStripeEventFailed(event.id, claim.processingToken, `setup_intent_status_${setupIntent.status}`)
      return res.status(503).json({ error: 'setup_not_yet_complete' })
    }
    const setupIntentCustomerId = typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer?.id ?? null
    if (setupIntentCustomerId !== stripeCustomerId) {
      console.error(`[session/stripe-webhook] SetupIntent ${setupIntentId}'s own customer does not match the Checkout Session's customer for tenant ${tenantId} -- treating as a security anomaly, acknowledging without processing`)
      await markStripeEventProcessed(event.id, claim.processingToken, 'setup_intent_customer_mismatch')
      return res.status(200).json({ received: true })
    }
    const paymentMethodId = typeof setupIntent.payment_method === 'string' ? setupIntent.payment_method : setupIntent.payment_method?.id ?? null
    if (!isValidStripePaymentMethodId(paymentMethodId) || paymentMethodId === null) {
      console.error(`[session/stripe-webhook] SetupIntent ${setupIntentId} for tenant ${tenantId} succeeded but carried no valid payment_method -- acknowledging, not processing`)
      await markStripeEventProcessed(event.id, claim.processingToken, 'setup_intent_missing_payment_method')
      return res.status(200).json({ received: true })
    }

    // Phase B.11 final pre-commit correction (Part 6) -- a missing billing
    // record here is a structural anomaly, not an expected race: the
    // reverse index that resolved `tenantId` above is only ever claimed
    // AFTER the billing record already exists (billingCustomer.js's
    // ensureStripeCustomerForTenant() creates the record, then the
    // Customer, then claims the index -- see that file's own header).
    // Silently acknowledging success here would falsely mark this event
    // processed while the payment method was never actually recorded
    // anywhere. Throwing routes this into the catch below: marked failed
    // (retryable) and a 5xx, never a false 200.
    const billingRecord = await getBillingRecord(tenantId)
    if (!billingRecord) {
      throw new Error(`no billing record exists for tenant ${JSON.stringify(tenantId)} despite a resolved customer index -- refusing to acknowledge a payment method that was never recorded`)
    }

    try {
      await updateBillingRecord(tenantId, { defaultPaymentMethodId: paymentMethodId }, { expectedVersion: billingRecord.version })
    } catch (err) {
      if (err instanceof BillingVersionConflictError) {
        // Phase B.11 final pre-commit correction (Part 5) -- re-read
        // instead of blindly retrying/failing. If the exact desired
        // projection is ALREADY present (e.g. a concurrent redelivery of
        // this SAME event, or a legitimate concurrent billing write that
        // happened to also carry this fact), the operation is idempotently
        // satisfied -- processed/200, not a false failure. If the current
        // record does NOT already reflect this payment method, some OTHER
        // concurrent legitimate mutation raced this write; that is a
        // genuine, retryable conflict, never a false success.
        if (err.currentRecord?.defaultPaymentMethodId === paymentMethodId) {
          await markStripeEventProcessed(event.id, claim.processingToken, 'setup_completed_already_applied')
          return res.status(200).json({ received: true })
        }
        throw err
      }
      throw err
    }

    await markStripeEventProcessed(event.id, claim.processingToken, 'setup_completed')
    return res.status(200).json({ received: true })
  } catch (err) {
    // Every path that reaches here (SetupIntent retrieval timeout/network
    // failure, Stripe 429/5xx, billing-store outage, an unresolved CAS
    // conflict, the missing-billing-record anomaly above, or any other
    // unexpected exception) is treated identically: a genuine transient or
    // unresolved failure to apply the projection, NEVER a false success.
    // markStripeEventFailed() is token-checked -- if this worker's lease
    // was itself already superseded (StaleProcessingTokenError), the
    // best-effort catch below simply lets a newer worker's own outcome
    // stand; either way Stripe still receives a retryable 5xx here so it
    // redelivers.
    try {
      await markStripeEventFailed(event.id, claim.processingToken, String(err.message ?? 'error').slice(0, 200))
    } catch { /* best-effort -- the outer 500 below still triggers a Stripe retry regardless */ }
    console.error(`[session/stripe-webhook] failed to apply setup completion for tenant ${tenantId}: ${err.message}`)
    return res.status(500).json({ error: 'processing_failed' })
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
    case 'finalize-registration':  return finalizeRegistration(req, res)
    case 'stripe-webhook':         return stripeWebhookAction(req, res)
    default:                 return res.status(404).json({ error: 'not_found' })
  }
}
