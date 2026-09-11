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
import { getAccountById, getAccountByEmail, listAccounts, getStaticAccountByEmail, getAccountByIdForTenant } from '../_lib/accountStore.js'
import { verifyPassword, hashPassword, validatePasswordStrength } from '../_lib/password.js'
import { requireAuth } from '../_lib/auth.js'
import { signSession, SESSION_COOKIE } from '../_lib/session.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import {
  touchLastLogin, updateUser, upsertUser, UserStoreUnavailableError, lookupTenantIdForUserId,
  getUserById, getUserByEmail, deriveUserStatus, lookupIdentityByEmail,
  _removeUserRecordForOneTimeMigration, _removeIdentityIndexEntriesForOneTimeMigration,
} from '../_lib/userStore.js'
import { appendAuditEntry } from '../_lib/auditLog.js'
import { resolveTenantId, resolveBootstrapTenantId, TenantResolutionError, DEFAULT_TENANT_ID } from '../_lib/tenants.js'
import { generateTenantId } from '../_lib/tenantIdGenerator.js'
import { getTenantConfig, upsertTenantConfig, TenantConfigStoreUnavailableError, reconcileStuckProvisioningDispatch } from '../_lib/tenantConfigStore.js'
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
  })
}

// TEMPORARY -- "Add ONE temporary authenticated self-audit action" tenant-
// mismatch investigation. GET /api/session/account-audit-self audits ONLY
// the CURRENTLY authenticated account's own record shape across the static
// and Redis-backed directories, to determine whether a tenant mismatch (an
// account resolving to an unintended tenant, e.g. a stray self-service
// signup) is a clean single-record defect or something messier (duplicate
// records, a membership/identity-index disagreement, a stale invite state).
// Accepts NO email/accountId parameter -- there is no cross-user lookup
// surface here at all, by construction; `account` below is exclusively the
// one requireAuth() just verified belongs to this request's own session.
// Returns only safe metadata computed via the SAME production account-store/
// user-store functions login and evaluateSession() already use -- never a
// raw record, never a password hash, session token, invite hash, OAuth
// token, or any credential material. Remove once this investigation
// concludes.
async function accountAuditSelf(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireAuth(req, res, null)
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `session:account-audit-self:${account.userId}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  const { email, userId } = account

  async function safeUserStoreLookup(fn) {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof UserStoreUnavailableError) return null
      throw err
    }
  }

  // Which concrete path is authoritative for THIS session -- re-derived via
  // the exact same precedence accountStore.js's getAccountById() itself
  // uses, so this can never silently disagree with what actually logged
  // this session in.
  const indexedTenantId = await safeUserStoreLookup(() => lookupTenantIdForUserId(userId))
  const indexedRecord = indexedTenantId ? await safeUserStoreLookup(() => getUserById(indexedTenantId, userId)) : null
  const bootstrapRecordById = indexedRecord ? null : await safeUserStoreLookup(() => getUserById(resolveBootstrapTenantId(), userId))
  // Independent existence check by EMAIL against the bootstrap hash too --
  // catches a second, different-userId Redis record for the same email the
  // identity index doesn't point at (e.g. an orphaned pre-migration record),
  // which a userId-only lookup above would never surface.
  const bootstrapRecordByEmail = await safeUserStoreLookup(() => getUserByEmail(resolveBootstrapTenantId(), email))

  const staticRecord = getStaticAccountByEmail(email)

  const winningRecord = indexedRecord ?? bootstrapRecordById ?? bootstrapRecordByEmail ?? staticRecord
  const authoritativeSource = (indexedRecord || bootstrapRecordById || bootstrapRecordByEmail) ? 'redis' : 'static'
  const runtimeLookupWinner = indexedRecord
    ? 'redis-identity-index'
    : (bootstrapRecordById || bootstrapRecordByEmail) ? 'redis-bootstrap-legacy' : 'static-account-directory'

  const distinctUserIds = new Set(
    [indexedRecord, bootstrapRecordById, bootstrapRecordByEmail, staticRecord]
      .filter(Boolean)
      .map(r => r.userId)
  )
  const redisAccountExists = Boolean(indexedRecord || bootstrapRecordById || bootstrapRecordByEmail)
  const staticAccountExists = Boolean(staticRecord)
  const duplicateAccountCount = distinctUserIds.size

  // Membership/identity-index consistency: does the global identity index's
  // own answer for this userId agree with the tenantId this session
  // actually carries? A real, correctly-written account always agrees;
  // disagreement is exactly the kind of migration artifact this
  // investigation is checking for.
  const separateMembershipExists = Boolean(indexedTenantId && indexedTenantId !== account.tenantId)
  const membershipTenantId = separateMembershipExists ? indexedTenantId : null

  const staleInviteExists = winningRecord ? ['invited', 'expired', 'revoked'].includes(deriveUserStatus(winningRecord)) : false

  const canonicalTenantId = DEFAULT_TENANT_ID
  const tenantMismatchConfirmed = account.tenantId !== canonicalTenantId

  // Per-source comparison (extension: "compare Advertising's two records").
  // The best available Redis record for comparison purposes -- same
  // precedence as winningRecord, just named for clarity here. A static
  // account record has no `tenantId` field of its own (accounts.js never
  // stores one -- resolveTenantId() derives DEFAULT_TENANT_ID for it via
  // the legacy membership path), so it's reported here as DEFAULT_TENANT_ID
  // explicitly, matching what it actually resolves to, never `undefined`.
  const redisRecordForComparison = indexedRecord ?? bootstrapRecordById ?? bootstrapRecordByEmail
  const redisRecord = redisRecordForComparison ? {
    accountId: redisRecordForComparison.userId,
    tenantId: redisRecordForComparison.tenantId ?? null,
    role: redisRecordForComparison.role,
    locationIds: redisRecordForComparison.locationIds,
    disabled: Boolean(redisRecordForComparison.disabled),
    sessionVersion: redisRecordForComparison.sessionVersion ?? null,
    createdAt: redisRecordForComparison.createdAt ?? null,
    updatedAt: redisRecordForComparison.updatedAt ?? null,
  } : null
  const staticRecordSafe = staticRecord ? {
    accountId: staticRecord.userId,
    tenantId: DEFAULT_TENANT_ID,
    role: staticRecord.role,
    locationIds: staticRecord.locationIds,
    disabled: Boolean(staticRecord.disabled),
    sessionVersion: staticRecord.sessionVersion ?? null,
  } : null

  const sameSourceComparison = {
    sameAccountId: Boolean(redisRecord && staticRecordSafe && redisRecord.accountId === staticRecordSafe.accountId),
    sameTenantId: Boolean(redisRecord && staticRecordSafe && redisRecord.tenantId === staticRecordSafe.tenantId),
    sameRole: Boolean(redisRecord && staticRecordSafe && redisRecord.role === staticRecordSafe.role),
    sameLocationIds: Boolean(redisRecord && staticRecordSafe && JSON.stringify(redisRecord.locationIds) === JSON.stringify(staticRecordSafe.locationIds)),
    sameDisabledState: Boolean(redisRecord && staticRecordSafe && redisRecord.disabled === staticRecordSafe.disabled),
    redisHasPasswordCredential: Boolean(redisRecordForComparison?.passwordHash),
    staticHasPasswordCredential: Boolean(staticRecord?.passwordHash),
  }

  return res.status(200).json({
    email,
    accountId: userId,
    tenantId: account.tenantId,
    role: account.role,
    locationIds: account.locationIds,
    disabled: Boolean(winningRecord?.disabled),
    sessionVersion: winningRecord?.sessionVersion ?? null,
    authoritativeSource,
    redisAccountExists,
    staticAccountExists,
    duplicateAccountCount,
    redisRecord,
    staticRecord: staticRecordSafe,
    ...sameSourceComparison,
    separateMembershipExists,
    membershipTenantId,
    staleInviteExists,
    runtimeLookupWinner,
    repairAssessment: {
      tenantMismatchConfirmed,
      canonicalTenantId,
      tenantIdOnlyRepairLikely: duplicateAccountCount === 1 && !separateMembershipExists && !staleInviteExists,
      additionalMembershipRepairRequired: separateMembershipExists,
    },
  })
}

// TEMPORARY, ONE-TIME, SINGLE-ACCOUNT REPAIR -- "Perform the narrowly-scoped
// production repair for advertising@l3amigos.com" investigation closure.
// POST /api/session/account-repair-advertising-tenant-once. Every targeting
// value below is a HARDCODED CONSTANT, not request input -- this endpoint
// accepts no email/tenantId/accountId parameter and cannot be pointed at any
// other account, regardless of who calls it or what they pass. It exists
// solely to flip ONE proven-stray Redis account record's tenantId field back
// to the real production tenant, after re-verifying every precondition
// server-side against a fresh read (never the caller's own session claims,
// which could be stale). A precondition mismatch -- including the second
// invocation ever, once the first succeeds -- returns 409 and writes
// nothing. Remove once this investigation concludes, alongside
// account-audit-self.
const REPAIR_TARGET_EMAIL = 'advertising@l3amigos.com'
const REPAIR_EXPECTED_ACCOUNT_ID = 'usr_7a7db167-e1a9-48e0-abb0-1fe62dfa1c7d'
const REPAIR_EXPECTED_CURRENT_TENANT_ID = 't_los-tres-amigos-pilot'
const REPAIR_EXPECTED_ROLE = 'owner'
const REPAIR_EXPECTED_LOCATION_IDS = '*'
const REPAIR_EXPECTED_DISABLED = false
const REPAIR_EXPECTED_SESSION_VERSION = 5
const REPAIR_NEW_SESSION_VERSION = 6

async function accountRepairAdvertisingTenantOnce(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireAuth(req, res, null)
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `session:account-repair-advertising-tenant-once:${account.userId}`, { requestsPerWindow: 5, windowSeconds: 60 })
  if (!allowed) return

  // Self-only, hardcoded target -- checked against BOTH email and accountId
  // independently (defense in depth for a one-time repair script, even
  // though the two are already 1:1 for any real account). Any caller other
  // than exactly this account gets 403, no matter what.
  if (account.email !== REPAIR_TARGET_EMAIL || account.userId !== REPAIR_EXPECTED_ACCOUNT_ID) {
    return res.status(403).json({ error: 'forbidden', message: 'This one-time repair action is scoped to a single account.' })
  }

  // Fresh, authoritative re-read -- looked up directly via the KNOWN
  // current (pilot) tenant's own store, never via the caller's own
  // (possibly stale) session claims, and never via a search.
  let current
  try {
    current = await getUserById(REPAIR_EXPECTED_CURRENT_TENANT_ID, REPAIR_EXPECTED_ACCOUNT_ID)
  } catch (err) {
    if (err instanceof UserStoreUnavailableError) {
      return res.status(503).json({ error: 'service_unavailable', message: 'Could not verify the account record. Please try again shortly.' })
    }
    throw err
  }

  const preconditionsMatch = Boolean(
    current &&
    current.email === REPAIR_TARGET_EMAIL &&
    current.userId === REPAIR_EXPECTED_ACCOUNT_ID &&
    current.tenantId === REPAIR_EXPECTED_CURRENT_TENANT_ID &&
    current.role === REPAIR_EXPECTED_ROLE &&
    JSON.stringify(current.locationIds) === JSON.stringify(REPAIR_EXPECTED_LOCATION_IDS) &&
    Boolean(current.disabled) === REPAIR_EXPECTED_DISABLED &&
    current.sessionVersion === REPAIR_EXPECTED_SESSION_VERSION
  )

  if (!preconditionsMatch) {
    // Existence/content-hiding on mismatch, matching this codebase's own
    // established error-contract discipline elsewhere -- never echoes back
    // what actually differs. Covers both "record not found" and "already
    // repaired" (a second invocation naturally lands here, since
    // current.tenantId no longer equals the expected pilot value).
    return res.status(409).json({ error: 'precondition_failed', message: 'The account record no longer matches the expected pre-repair state -- no change was made.' })
  }

  const updated = await updateUser(REPAIR_EXPECTED_CURRENT_TENANT_ID, REPAIR_EXPECTED_ACCOUNT_ID, {
    tenantId: DEFAULT_TENANT_ID,
    sessionVersion: REPAIR_NEW_SESSION_VERSION,
  })

  await appendAuditEntry(DEFAULT_TENANT_ID, {
    actorId: account.userId, actorEmail: account.email, ip: clientIp(req),
    action: 'account.tenant_repaired', entity: 'user', entityId: REPAIR_EXPECTED_ACCOUNT_ID,
    changes: [
      { field: 'tenantId', oldValue: REPAIR_EXPECTED_CURRENT_TENANT_ID, newValue: DEFAULT_TENANT_ID },
      { field: 'sessionVersion', oldValue: REPAIR_EXPECTED_SESSION_VERSION, newValue: REPAIR_NEW_SESSION_VERSION },
    ],
    result: 'success',
    message: 'One-time tenant-mismatch repair for advertising@l3amigos.com.',
  })

  return res.status(200).json({
    success: true,
    repaired: true,
    newTenantId: updated?.tenantId ?? DEFAULT_TENANT_ID,
    newSessionVersion: updated?.sessionVersion ?? REPAIR_NEW_SESSION_VERSION,
    message: 'Tenant repaired. Your session is now stale -- please log in again.',
  })
}

// TEMPORARY, ONE-TIME, SINGLE-ACCOUNT STORAGE MIGRATION -- "Implement the
// complete one-time Advertising storage migration" investigation closure.
// POST /api/session/account-migrate-advertising-storage-once. Follows
// account-repair-advertising-tenant-once above (which already fixed the
// account's own tenantId field): that repair left the record PHYSICALLY
// stored inside the pilot tenant's own Redis hash
// (usersKeyV2('t_los-tres-amigos-pilot')), invisible to every tenant-scoped
// admin lookup/listing for t_los-tres-amigos (getAccountByIdForTenant,
// listUsers) since neither consults the global identity index. This
// migrates the record itself: write an exact canonical copy into LTA's
// LEGACY storage (users:v1/users_email_index:v1), verify it by reading it
// back, then delete the stale pilot-tenant record and both now-obsolete
// global identity-index entries (LEGACY tenants never carry index entries
// at all -- see userStore.js's upsertUser -- so these are removed, never
// repointed). Every targeting value below is a HARDCODED CONSTANT; the
// endpoint accepts no request parameters and cannot be pointed at any other
// account or location. Safely re-invocable: a repeat call after a completed
// migration detects the already-migrated canonical shape and re-runs only
// the (naturally idempotent, hdel-based) cleanup step rather than
// re-writing or erroring -- this also covers resuming after a failure that
// happened between the canonical write and the source cleanup. There is no
// Redis MULTI/transaction primitive anywhere in this codebase's
// @upstash/redis usage, so this cannot be made atomic -- strict ordering is
// the safety mechanism instead: the canonical write and its read-back
// verification both complete BEFORE any source data is touched, and any
// failure before that point leaves the source completely untouched. Remove
// once this investigation concludes, alongside the audit/repair actions
// above.
const MIGRATE_TARGET_EMAIL = 'advertising@l3amigos.com'
const MIGRATE_EXPECTED_ACCOUNT_ID = 'usr_7a7db167-e1a9-48e0-abb0-1fe62dfa1c7d'
const MIGRATE_SOURCE_TENANT_ID = 't_los-tres-amigos-pilot'
const MIGRATE_EXPECTED_ROLE = 'owner'
const MIGRATE_EXPECTED_LOCATION_IDS = '*'
const MIGRATE_EXPECTED_DISABLED = false
const MIGRATE_EXPECTED_SESSION_VERSION = 6
const MIGRATE_NEW_SESSION_VERSION = 7

function migrateFieldsMatch(record, { tenantId, sessionVersion }) {
  return Boolean(
    record &&
    record.email === MIGRATE_TARGET_EMAIL &&
    record.userId === MIGRATE_EXPECTED_ACCOUNT_ID &&
    record.tenantId === tenantId &&
    record.role === MIGRATE_EXPECTED_ROLE &&
    JSON.stringify(record.locationIds) === JSON.stringify(MIGRATE_EXPECTED_LOCATION_IDS) &&
    Boolean(record.disabled) === MIGRATE_EXPECTED_DISABLED &&
    record.sessionVersion === sessionVersion
  )
}

async function accountMigrateAdvertisingStorageOnce(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireAuth(req, res, null)
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `session:account-migrate-advertising-storage-once:${account.userId}`, { requestsPerWindow: 5, windowSeconds: 60 })
  if (!allowed) return

  // Self-only, hardcoded target -- any caller other than exactly this
  // account gets 403, no matter what.
  if (account.email !== MIGRATE_TARGET_EMAIL || account.userId !== MIGRATE_EXPECTED_ACCOUNT_ID) {
    return res.status(403).json({ error: 'forbidden', message: 'This one-time migration action is scoped to a single account.' })
  }

  let canonicalById, canonicalByEmail
  try {
    canonicalById = await getUserById(DEFAULT_TENANT_ID, MIGRATE_EXPECTED_ACCOUNT_ID)
    canonicalByEmail = await getUserByEmail(DEFAULT_TENANT_ID, MIGRATE_TARGET_EMAIL)
  } catch (err) {
    if (err instanceof UserStoreUnavailableError) {
      return res.status(503).json({ error: 'service_unavailable', message: 'Could not verify the account records. Please try again shortly.' })
    }
    throw err
  }

  // Idempotent-resume / partial-state detection: the canonical record
  // already exists and is EXACTLY the fully-migrated shape (never a
  // partial/differing record) -- treat this as "migration already written,
  // only cleanup remains" rather than erroring or re-writing.
  const canonicalAlreadyComplete = Boolean(
    migrateFieldsMatch(canonicalById, { tenantId: DEFAULT_TENANT_ID, sessionVersion: MIGRATE_NEW_SESSION_VERSION }) &&
    canonicalByEmail?.userId === MIGRATE_EXPECTED_ACCOUNT_ID
  )

  if (canonicalById && !canonicalAlreadyComplete) {
    // A record exists at the target identity but does not match the exact
    // intended shape -- a genuine conflict, not a resumable migration.
    return res.status(409).json({ error: 'target_collision', message: 'A conflicting account record already exists at the destination -- no change was made.' })
  }
  if (canonicalByEmail && canonicalByEmail.userId !== MIGRATE_EXPECTED_ACCOUNT_ID) {
    return res.status(409).json({ error: 'target_collision', message: 'A conflicting account record already exists at the destination -- no change was made.' })
  }

  if (!canonicalAlreadyComplete) {
    // Clean-start path: re-verify every source precondition against a fresh
    // read, never the caller's own (possibly stale) session claims.
    let source
    try {
      source = await getUserById(MIGRATE_SOURCE_TENANT_ID, MIGRATE_EXPECTED_ACCOUNT_ID)
    } catch (err) {
      if (err instanceof UserStoreUnavailableError) {
        return res.status(503).json({ error: 'service_unavailable', message: 'Could not verify the source account record. Please try again shortly.' })
      }
      throw err
    }

    const sourceMatches = migrateFieldsMatch(source, { tenantId: DEFAULT_TENANT_ID, sessionVersion: MIGRATE_EXPECTED_SESSION_VERSION })
    if (!sourceMatches) {
      return res.status(409).json({ error: 'precondition_failed', message: 'The source account record no longer matches the expected pre-migration state -- no change was made.' })
    }

    let sourceByEmail, indexedTenantId, indexedByEmail
    try {
      sourceByEmail = await getUserByEmail(MIGRATE_SOURCE_TENANT_ID, MIGRATE_TARGET_EMAIL)
      indexedTenantId = await lookupTenantIdForUserId(MIGRATE_EXPECTED_ACCOUNT_ID)
      indexedByEmail = await lookupIdentityByEmail(MIGRATE_TARGET_EMAIL)
    } catch (err) {
      if (err instanceof UserStoreUnavailableError) {
        return res.status(503).json({ error: 'service_unavailable', message: 'Could not verify the source routing records. Please try again shortly.' })
      }
      throw err
    }

    const sourceIndexesMatch = Boolean(
      sourceByEmail?.userId === MIGRATE_EXPECTED_ACCOUNT_ID &&
      indexedTenantId === MIGRATE_SOURCE_TENANT_ID &&
      indexedByEmail?.tenantId === MIGRATE_SOURCE_TENANT_ID &&
      indexedByEmail?.userId === MIGRATE_EXPECTED_ACCOUNT_ID
    )
    if (!sourceIndexesMatch) {
      return res.status(409).json({ error: 'precondition_failed', message: 'The source routing records no longer match the expected pre-migration state -- no change was made.' })
    }

    // Construct the canonical record: an exact copy of the source except the
    // two fields this migration is explicitly authorized to change.
    const canonicalRecord = {
      ...source,
      tenantId: DEFAULT_TENANT_ID,
      sessionVersion: MIGRATE_NEW_SESSION_VERSION,
      updatedAt: new Date().toISOString(),
    }

    let written
    try {
      written = await upsertUser(DEFAULT_TENANT_ID, canonicalRecord)
    } catch (err) {
      if (err instanceof UserStoreUnavailableError) {
        return res.status(503).json({ error: 'service_unavailable', message: 'Could not write the canonical account record. The source record was not modified. Please try again shortly.' })
      }
      throw err
    }

    // Read back BOTH the id-keyed and email-keyed paths and strictly compare
    // every field against the intended canonical shape BEFORE touching the
    // source at all -- a failure here stops with the source fully intact.
    let verifyById, verifyByEmail
    try {
      verifyById = await getUserById(DEFAULT_TENANT_ID, MIGRATE_EXPECTED_ACCOUNT_ID)
      verifyByEmail = await getUserByEmail(DEFAULT_TENANT_ID, MIGRATE_TARGET_EMAIL)
    } catch (err) {
      if (err instanceof UserStoreUnavailableError) {
        return res.status(503).json({ error: 'service_unavailable', message: 'Canonical write succeeded but could not be verified. The source record was not modified -- please retry.' })
      }
      throw err
    }

    const readBackVerified = Boolean(
      written &&
      migrateFieldsMatch(verifyById, { tenantId: DEFAULT_TENANT_ID, sessionVersion: MIGRATE_NEW_SESSION_VERSION }) &&
      verifyByEmail?.userId === MIGRATE_EXPECTED_ACCOUNT_ID &&
      Boolean(verifyById.passwordHash) === Boolean(source.passwordHash)
    )
    if (!readBackVerified) {
      return res.status(500).json({
        error: 'verification_failed',
        message: 'The canonical record was written but failed read-back verification. The source record was NOT deleted. Please report this before retrying.',
      })
    }
  }

  // Only reached once a verified canonical record is confirmed to exist
  // (either just-written-and-verified above, or already complete from a
  // prior run) -- safe to remove the stale source data. Both deletes are
  // hdel-based and naturally idempotent (a no-op if already gone), so this
  // whole block is safe to repeat.
  try {
    await _removeUserRecordForOneTimeMigration(MIGRATE_SOURCE_TENANT_ID, MIGRATE_EXPECTED_ACCOUNT_ID, MIGRATE_TARGET_EMAIL)
    await _removeIdentityIndexEntriesForOneTimeMigration(MIGRATE_EXPECTED_ACCOUNT_ID, MIGRATE_TARGET_EMAIL)
  } catch (err) {
    if (err instanceof UserStoreUnavailableError) {
      return res.status(500).json({
        error: 'cleanup_failed',
        message: 'The canonical record is verified and in place, but the stale source records could not be removed. Safe to retry -- the canonical write is already complete, so only cleanup will be re-attempted.',
      })
    }
    throw err
  }

  // Final server-side resolution checks -- the same lookups production's
  // own login/admin code paths use, proving the migration is actually
  // effective rather than just "the writes didn't throw."
  const [finalByEmail, finalById, finalForTenant, finalSourceLookup] = await Promise.all([
    getAccountByEmail(MIGRATE_TARGET_EMAIL),
    getAccountById(MIGRATE_EXPECTED_ACCOUNT_ID),
    getAccountByIdForTenant(DEFAULT_TENANT_ID, MIGRATE_EXPECTED_ACCOUNT_ID),
    getUserById(MIGRATE_SOURCE_TENANT_ID, MIGRATE_EXPECTED_ACCOUNT_ID),
  ])
  const finalResolutionOk = Boolean(
    finalByEmail?.tenantId === DEFAULT_TENANT_ID &&
    finalById?.tenantId === DEFAULT_TENANT_ID &&
    finalForTenant?.userId === MIGRATE_EXPECTED_ACCOUNT_ID &&
    !finalSourceLookup
  )

  await appendAuditEntry(DEFAULT_TENANT_ID, {
    actorId: account.userId, actorEmail: account.email, ip: clientIp(req),
    action: 'account.storage_migrated', entity: 'user', entityId: MIGRATE_EXPECTED_ACCOUNT_ID,
    changes: [
      { field: 'storageLocation', oldValue: MIGRATE_SOURCE_TENANT_ID, newValue: DEFAULT_TENANT_ID },
      { field: 'sessionVersion', oldValue: MIGRATE_EXPECTED_SESSION_VERSION, newValue: MIGRATE_NEW_SESSION_VERSION },
    ],
    result: finalResolutionOk ? 'success' : 'partial',
    message: 'One-time Redis storage migration for advertising@l3amigos.com (pilot-tenant hash -> canonical LTA storage).',
  })

  return res.status(200).json({
    success: true,
    migrated: true,
    verified: finalResolutionOk,
    newTenantId: DEFAULT_TENANT_ID,
    newSessionVersion: MIGRATE_NEW_SESSION_VERSION,
    message: finalResolutionOk
      ? 'Account storage migrated to canonical LTA storage. Your session is now stale -- please log in again.'
      : 'Account storage migrated, but a final verification check did not fully pass -- please report this for review.',
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

  try {
    const realAccount = await getAccountByEmail(email)
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
//   3. THE explicit re-check: getAccountByEmail(email) AGAIN, even though
//      register() already checked this once. Registration can sit
//      unverified/unconverted for up to 7 days -- an operator invite or a
//      second registration could have created a REAL account for this
//      email in that window. If one now exists, this fails closed
//      (EmailNowOccupiedError) rather than creating a second, duplicate
//      identity under a brand-new tenant.
//   4. upsertTenantConfig() -- the SAME function every tenant (including
//      operator-bootstrapped ones) is created through. Skipped if a prior,
//      partially-failed attempt already created it (idempotent retry,
//      same pattern as Phase 4O/4P's own reconciliation logic) --
//      tenantIdReserved was generated at REGISTRATION time specifically so
//      a retry reuses the same id rather than orphaning a new one.
//   5. upsertUser() -- role: 'owner', locationIds: '*' (company-wide),
//      passwordHash carried over UNCHANGED from registration (the user
//      already set their own password; there is no invite-accept
//      password-setting step to replay here).
//   6. Delete the pending registration -- from this point on, the ONLY
//      record of this identity is the real tenant_config/user pair.
//   7. Release the lock (always, via finally).
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

    const nowOccupied = await getAccountByEmail(fresh.email)
    if (nowOccupied) {
      await updatePendingRegistration(email, { status: 'blocked_email_occupied' })
      throw new EmailNowOccupiedError('An account for this email already exists. Please sign in instead, or contact support.')
    }

    await updatePendingRegistration(email, { status: 'creating_tenant' })

    const tenantId = fresh.tenantIdReserved
    const existingTenantConfig = await getTenantConfig(tenantId)
    if (!existingTenantConfig) {
      await upsertTenantConfig(tenantId, { displayName: fresh.companyName, commercial })
    }

    const now = new Date().toISOString()
    const userRecord = await upsertUser(tenantId, {
      userId: fresh.userId, email: fresh.email, passwordHash: fresh.passwordHash,
      role: 'owner', locationIds: '*', tenantId, sessionVersion: 1, disabled: false,
      displayName: fresh.displayName, createdAt: now, updatedAt: now, lastLoginAt: null,
      invitedAt: null, invitedBy: null, lastInviteSentAt: null,
      inviteTokenHash: null, inviteExpiresAt: null, inviteRevokedAt: null,
      passwordSetAt: fresh.createdAt,
    })

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
    case 'account-audit-self': return accountAuditSelf(req, res)
    case 'account-repair-advertising-tenant-once': return accountRepairAdvertisingTenantOnce(req, res)
    case 'account-migrate-advertising-storage-once': return accountMigrateAdvertisingStorageOnce(req, res)
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
