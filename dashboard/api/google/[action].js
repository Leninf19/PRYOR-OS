// Single serverless function handling every Google Business Profile
// endpoint -- consolidated from 7 separate files (auth.js, callback.js,
// status.js, test-connection.js, trigger-sync.js, trigger-import.js,
// publish.js) into one dynamic-route dispatch, for the same reason
// dashboard/api/actions/[action].js and dashboard/api/session/[action].js
// already use this pattern: staying under the Vercel Hobby plan's
// 12-serverless-function-per-deployment limit (Phase 8, Milestone 8.2).
//
// This is a MECHANICAL merge -- every handler's logic, auth gate, rate
// limit, and response shape is unchanged; only the refresh-token exchange
// (previously duplicated three times) is de-duplicated into
// google/_lib/googleAuth.js. External routes are byte-identical:
// GET  /api/google/auth
// GET  /api/google/callback   (the exact URI already registered as the
//                              OAuth redirect_uri in Google Cloud Console)
// GET  /api/google/status
// GET  /api/google/test-connection
// POST /api/google/trigger-sync
// POST /api/google/trigger-import
// POST /api/google/publish
// Vercel/Node populates req.query.action from the URL segment, exactly as
// it already does for actions/[action].js and session/[action].js.

import { randomBytes } from 'crypto'
import { setCookie, parseCookies, clearCookie } from './_lib/cookies.js'
import { fetchWithRetry } from './_lib/http.js'
import { exchangeRefreshToken, getAccessToken } from './_lib/googleAuth.js'
import { signOAuthState, verifyOAuthState } from './_lib/oauthState.js'
import { requireAuth, requireScopedAuth, requireLocationAccess, isWildcardGrant, evaluateSession, statusForAuthFailure } from '../_lib/auth.js'
import { Permission, roleHasPermission } from '../_lib/permissions.js'
import { resolveLocationIdForReview, resolveLocationIdForReviewOrDeny } from '../_lib/reviewLocationIndex.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import {
  getStoredCredential, setStoredCredentialIfVersion, recordSyncOutcome, recordOAuthRefresh,
  clearStoredCredential, GoogleHealth, CredentialStoreUnavailableError, CredentialVersionConflictError,
  isQuotaExceededError, extractQuotaProjectNumber,
} from '../_lib/credentialStore.js'
import {
  sealGoogleOAuthClientForPinnedGitHubRepo, OAuthClientSealerUnavailableError, OAuthClientNotConfiguredError,
} from '../_lib/googleOAuthClientSealer.js'
import { appendAuditEntry, clientIp } from '../_lib/auditLog.js'
import {
  writePublishBridge, getPublishBridges, PublishBridgeUnavailableError,
} from '../_lib/publishBridgeStore.js'
import { recordReplyFailure, clearReplyFailure } from '../_lib/notificationStore.js'
import { resolveTenantId, DEFAULT_TENANT_ID, isPlatformOwnerEmail } from '../_lib/tenants.js'
import { createDiscoverySession, getDiscoverySession } from '../_lib/locationDiscoveryStore.js'
import { recordLocationApproval, LocationApprovalNotEligibleError, getTenantConfig, LOCATION_APPROVAL_ELIGIBLE_STATUSES } from '../_lib/tenantConfigStore.js'
import { reconcileApprovedLocationsAgainstDiscovery, UnreconciledApprovedLocationError } from '../_lib/tenantLocationReconciliation.js'
import { discoverGoogleLocationIdsForReconciliation } from '../_lib/googleLocationDiscovery.js'

const STATE_COOKIE = 'gbp_oauth_state'

// Fields every status-shaped response echoes back from the stored
// credential, so the Settings page always has Last Authentication/Last
// Successful Sync/Last Failed Sync/Token Health available regardless of
// which branch produced the response.
function credentialMetaFields(credential) {
  return {
    connectedAccountName: credential?.connectedAccountName ?? null,
    connectedAt: credential?.connectedAt ?? null,
    lastOAuthRefreshAt: credential?.lastOAuthRefreshAt ?? null,
    lastSuccessfulSyncAt: credential?.lastSuccessfulSyncAt ?? null,
    lastFailedSyncAt: credential?.lastFailedSyncAt ?? null,
    lastFailureReason: credential?.lastFailureReason ?? null,
  }
}

function page(title, body) {
  return `<!DOCTYPE html><html><head>
    <meta charset="utf-8">
    <title>${title} — Pryor OS</title>
    <style>
      body{font-family:system-ui,sans-serif;max-width:600px;margin:60px auto;padding:0 20px;color:#1a1a1a;line-height:1.6}
      h2,h3{margin-top:1.5em}
      code{background:#e7e5e4;padding:2px 6px;border-radius:4px;font-size:0.875em}
      a{color:#d97706}
    </style>
  </head><body><h2>${title}</h2>${body}</body></html>`
}

// ---------------------------------------------------------------------------
// GET /api/google/auth -- initiates the OAuth flow.
// ---------------------------------------------------------------------------

// Starting the OAuth flow can overwrite the org's only stored Google
// refresh token -- previously reachable by anyone who hit this URL
// directly (a "confused deputy" risk: the browser's own session cookie
// survives the whole /api/google/auth -> Google -> /api/google/callback
// round trip since it's same-origin navigation the whole way, so gating
// here and re-checking in the callback case is both possible and necessary).
async function auth(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed')

  // ERROR_CONTRACT_EXCEPTION_1 (Phase 2 Milestone 6A): distinguish "no valid
  // identity" (401) from "authenticated, but not Owner" (403) per the
  // frozen API error contract -- this used to collapse both into 401 by
  // only checking `!account`. Owner remains the only allowed role; nothing
  // about the OAuth flow, redirect, or successful-Owner path below changes.
  const { account, reason } = await evaluateSession(req, ['owner'])
  if (!account) {
    const status = statusForAuthFailure(reason)
    if (status === 403) {
      return res.status(403).send(`
        <html><body style="font-family:system-ui;max-width:520px;margin:60px auto;padding:0 20px">
          <h2>Access denied</h2>
          <p>Connecting Google Business Profile requires an Owner account. Your account does not have that role.</p>
          <a href="/settings">← Back to Settings</a>
        </body></html>
      `)
    }
    return res.status(401).send(`
      <html><body style="font-family:system-ui;max-width:520px;margin:60px auto;padding:0 20px">
        <h2>Sign in required</h2>
        <p>Connecting Google Business Profile requires an Owner account. Please sign in first.</p>
        <a href="/login">← Sign in</a>
      </body></html>
    `)
  }

  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) {
    return res.status(503).send(`
      <html><body style="font-family:system-ui;max-width:520px;margin:60px auto;padding:0 20px">
        <h2>Setup incomplete</h2>
        <p>Add <code>GOOGLE_CLIENT_ID</code> to Vercel environment variables first, then try again.</p>
        <a href="/settings">← Back to Settings</a>
      </body></html>
    `)
  }

  const proto      = req.headers['x-forwarded-proto'] || 'https'
  const host       = req.headers['x-forwarded-host'] || req.headers.host
  const redirectUri = `${proto}://${host}/api/google/callback`

  // Multi-Tenant Phase 4A: tenantId comes ONLY from the account this
  // request's own session just authenticated above -- never from a query
  // string, request body, header, or any other request-supplied value.
  // This is the tenant the callback will later be required to prove it's
  // still acting for.
  const tenantId = resolveTenantId(account)

  // CSRF protection, hardened: a random nonce plus the initiating tenant
  // and user identity are signed together (google/_lib/oauthState.js) into
  // an integrity-protected, short-lived token -- not a plain random string
  // or base64 JSON blob. The SAME signed token is stored in an httpOnly
  // cookie AND sent as the OAuth `state` param; the callback case rejects
  // the flow if the two don't match on return (the original CSRF
  // mechanism, preserved) AND independently re-verifies the token's
  // signature/expiry AND cross-checks its tenantId/userId against whoever
  // is authenticated at callback time -- closing both the original
  // login-CSRF gap and the cross-tenant/cross-session state-substitution
  // gap a bare nonce could never have detected.
  const nonce = randomBytes(32).toString('hex')
  let state
  try {
    state = await signOAuthState({ nonce, tenantId, userId: account.userId }, { expiresInSeconds: 600 })
  } catch (err) {
    console.error(`[google/auth] could not sign OAuth state: ${err.message}`)
    return res.status(503).send(`
      <html><body style="font-family:system-ui;max-width:520px;margin:60px auto;padding:0 20px">
        <h2>Setup incomplete</h2>
        <p>Could not start the Google connection flow: the session signing key is not configured correctly.</p>
        <a href="/settings">← Back to Settings</a>
      </body></html>
    `)
  }
  setCookie(res, STATE_COOKIE, state, { maxAgeSeconds: 600 })

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/business.manage',
    access_type:   'offline',
    prompt:        'consent', // always re-issue refresh token
    state,
  })

  res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`)
}

// ---------------------------------------------------------------------------
// GET /api/google/callback -- finishes the OAuth flow, writes the token.
// ---------------------------------------------------------------------------

async function callback(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed')

  // Defense in depth: the auth case above already required an Owner session
  // before redirecting here, but this case is independently authoritative
  // and never assumes that check already ran (the CSRF state check below is
  // a separate concern -- it proves this callback belongs to a flow *this
  // browser* started, not that the caller is still an authorized Owner).
  const { account, reason } = await evaluateSession(req, ['owner'])
  if (!account) {
    const status = statusForAuthFailure(reason)
    if (status === 403) {
      return res.status(403).send(page('Access denied', `
        <p>Connecting Google Business Profile requires an Owner account. Your account does not have that role.</p>
        <p><a href="/settings">← Back to Settings</a></p>
      `))
    }
    return res.status(401).send(page('Sign in required', `
      <p>Connecting Google Business Profile requires an Owner account.</p>
      <p><a href="/login">← Sign in</a></p>
    `))
  }

  const { code, error, state } = req.query

  const cookies = parseCookies(req)
  const expectedState = cookies[STATE_COOKIE]
  clearCookie(res, STATE_COOKIE)

  // Original CSRF mechanism, preserved exactly: the state returned by
  // Google must byte-for-byte match the one this browser's own cookie
  // holds -- catches a missing cookie (expired, cleared, or never set,
  // e.g. a stale/forged link) and a state value that doesn't match
  // (another browser/session's flow) before anything else runs.
  if (!expectedState || !state || state !== expectedState) {
    return res.status(400).send(page('Session expired or invalid', `
      <p>This authorization link is no longer valid (it may be old, already used, or opened in a different browser session).</p>
      <p>Go back to <a href="/settings">Settings</a> and click Connect again.</p>
    `))
  }

  // Multi-Tenant Phase 4A, hardened state verification: the cookie-match
  // check above only proves "this browser holds the same string" -- it
  // does not by itself prove the string hasn't been tampered with, has
  // not expired, or still belongs to whoever is authenticated RIGHT NOW.
  // verifyOAuthState() independently re-checks the signature and
  // expiration (rejects a modified or expired token outright); the
  // tenantId/userId cross-check below then rejects a state that is
  // validly signed but was issued for a DIFFERENT tenant or a different
  // user's session than the one currently authenticated (e.g. the Owner
  // signed out and a different Owner signed in mid-flow, or -- once a
  // second tenant exists -- a state minted for Tenant A somehow being
  // replayed against a Tenant B session). Any failure here fails closed
  // with the exact same generic response as the CSRF check above, never
  // revealing which specific check failed.
  const decodedState = await verifyOAuthState(state)
  if (!decodedState || decodedState.userId !== account.userId || decodedState.tenantId !== resolveTenantId(account)) {
    return res.status(400).send(page('Session expired or invalid', `
      <p>This authorization link is no longer valid (it may be old, already used, or opened in a different browser session).</p>
      <p>Go back to <a href="/settings">Settings</a> and click Connect again.</p>
    `))
  }
  // The tenant this callback is authorized to write a credential for --
  // established from the verified OAuth transaction, never from any other
  // source. Equal to resolveTenantId(account) by construction (just
  // checked above), used explicitly below so the write is provably tied
  // to the verified transaction rather than a fresh, separate derivation.
  const verifiedTenantId = decodedState.tenantId

  if (error) {
    return res.status(400).send(page('Authorization denied', `
      <p>Google returned: <strong>${error}</strong></p>
      <p>Go back to <a href="/settings">Settings</a> and try connecting again.</p>
    `))
  }

  if (!code) {
    return res.status(400).send(page('No code received', `
      <p>The OAuth flow did not return an authorization code. Please try again.</p>
      <a href="/settings">← Back to Settings</a>
    `))
  }

  const clientId     = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    return res.status(503).send(page('Missing credentials', `
      <p>GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not set in Vercel environment variables.</p>
    `))
  }

  const proto       = req.headers['x-forwarded-proto'] || 'https'
  const host        = req.headers['x-forwarded-host'] || req.headers.host
  const redirectUri = `${proto}://${host}/api/google/callback`

  // Multi-Tenant Phase 4I.2 -- expectedCredentialVersion, captured now,
  // BEFORE the token exchange and every Google round trip below: this
  // tenant's current credentialVersion (0 if never connected). Passed to
  // setStoredCredentialIfVersion() at the end of this function, which
  // checks it and applies the write in ONE ATOMIC Redis operation --
  // credentialStore.js's own CAS discipline (mirroring
  // tenantConfigStore.js's configVersion), not a JS-level read-then-compare-
  // then-write. A read-then-compare-in-JS-then-write ALWAYS has a gap two
  // concurrent requests can both observe the same state inside, no matter
  // how small that gap is narrowed; only pushing the compare into the same
  // atomic operation as the write removes it entirely. Fail closed if we
  // can't even read current state -- proceeding blind would defeat the
  // whole point of capturing a version to check against.
  let expectedCredentialVersion
  try {
    const currentCredentialBeforeExchange = await getStoredCredential(verifiedTenantId)
    expectedCredentialVersion = currentCredentialBeforeExchange?.credentialVersion ?? 0
  } catch (err) {
    return res.status(503).send(page('Connection temporarily unavailable', `
      <p>Could not read this tenant's current Google connection state: <strong>${err instanceof CredentialStoreUnavailableError ? 'the credential store is temporarily unavailable' : err.message}</strong></p>
      <p>Please try again shortly.</p>
    `))
  }

  let tokens
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    })
    tokens = await tokenRes.json()
  } catch (err) {
    return res.status(502).send(page('Network error', `
      <p>Could not reach Google's token endpoint: ${err.message}</p>
      <p><a href="/settings">← Back to Settings</a></p>
    `))
  }

  if (tokens.error) {
    return res.status(400).send(page('Token exchange failed', `
      <p><strong>${tokens.error}:</strong> ${tokens.error_description || 'Unknown error'}</p>
      <p><a href="/settings">← Back to Settings</a></p>
    `))
  }

  if (!tokens.refresh_token) {
    return res.status(400).send(page('No refresh token', `
      <p>Google did not return a refresh token — this usually means the account was already authorized.</p>
      <ol>
        <li>Go to <a href="https://myaccount.google.com/permissions" target="_blank">Google Account Permissions</a></li>
        <li>Find your app and remove its access</li>
        <li>Return to <a href="/settings">Settings</a> and click Connect again</li>
      </ol>
    `))
  }

  // Phase 8, Milestone 8.7: the refresh token is written straight to the
  // live credential store (Redis, encrypted) -- no Vercel env var, no
  // redeploy, no ~60s propagation window. Fetch the connected account's
  // display name once, right now, using the access token this same
  // authorization_code exchange already returned (no extra refresh-token
  // round trip needed) so "Connected Google Account" is accurate from the
  // moment of connection.
  let connectedAccountName = null
  try {
    const r = await fetchWithRetry('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (r.ok) {
      const data = await r.json()
      connectedAccountName = (data.accounts || [])[0]?.accountName || null
    }
  } catch {
    // Non-fatal -- the connection still succeeds; the account name is
    // cosmetic and will populate on the next status check if this
    // best-effort fetch fails.
  }

  // Multi-Tenant Phase 4I.2 -- ENTITLEMENT RECONCILIATION. The candidate
  // credential (`tokens`) is held ONLY in this function's local variables
  // up to this point -- nothing above has persisted anything. "OAuth
  // succeeded" and "this credential is valid FOR THIS TENANT'S committed
  // entitlement" are different questions; only a PRE-COMMIT tenant (no
  // approvedLocations yet worth protecting) may skip straight to
  // persisting, exactly preserving today's onboarding connect/discover/
  // approve flow. A COMMITTED tenant (has already gone through
  // approve-locations at least once -- LOCATION_APPROVAL_ELIGIBLE_STATUSES
  // is tenantConfigStore.js's own canonical pre-commit/committed split, the
  // same one its location-approval write path is gated by) must prove the
  // NEW credential can still see every already-approved Google location
  // before it is ever allowed to replace the working one.
  let existingConfig
  try {
    existingConfig = await getTenantConfig(verifiedTenantId)
  } catch (err) {
    return res.status(503).send(page('Connection temporarily unavailable', `
      <p>Could not read this tenant's configuration: <strong>${err.message}</strong></p>
      <p>Your previous Google connection, if any, remains unchanged.</p>
      <p>Please try again shortly.</p>
    `))
  }
  const currentStatus = existingConfig?.status ?? 'onboarding'

  if (RECONNECT_BLOCKED_STATUSES.has(currentStatus)) {
    await appendAuditEntry(verifiedTenantId, {
      actorId: account.userId, actorName: account.displayName ?? account.email, actorEmail: account.email, ip: clientIp(req),
      entity: 'google_oauth', entityId: null, action: 'google.reconnect_blocked_lifecycle', changes: { status: currentStatus }, result: 'denied',
      message: `Reconnect refused: tenant status is ${JSON.stringify(currentStatus)}. Your previous Google connection remains unchanged.`,
    })
    return res.status(409).send(page('Reconnect temporarily unavailable', `
      <p>An Initial Sync is currently running for this tenant. Reconnecting Google is disabled until it finishes or fails.</p>
      <p style="color:#16a34a">Your previous Google connection remains active and unchanged.</p>
      <p>Please try again shortly. <a href="/settings/google">← Back to Settings</a></p>
    `))
  }

  const isCommittedTenant = !LOCATION_APPROVAL_ELIGIBLE_STATUSES.has(currentStatus)

  if (isCommittedTenant) {
    let discoveredGoogleLocationIds
    try {
      discoveredGoogleLocationIds = await discoverGoogleLocationIdsForReconciliation(tokens.access_token)
    } catch (err) {
      // Cannot verify -> treated identically to a failed reconciliation:
      // the candidate is discarded, the previous credential is untouched.
      return res.status(502).send(page('Could not verify Google locations', `
        <p>Could not verify this Google account's locations: <strong>${err.message}</strong></p>
        <p style="color:#16a34a">Your previous Google connection remains active and unchanged.</p>
        <p><a href="/settings/google">← Back to Settings</a></p>
      `))
    }
    try {
      reconcileApprovedLocationsAgainstDiscovery(existingConfig?.approvedLocations ?? [], discoveredGoogleLocationIds)
    } catch (err) {
      if (!(err instanceof UnreconciledApprovedLocationError)) throw err
      await appendAuditEntry(verifiedTenantId, {
        actorId: account.userId, actorName: account.displayName ?? account.email, actorEmail: account.email, ip: clientIp(req),
        entity: 'google_oauth', entityId: null, action: 'google.reconnect_rejected_incompatible', changes: { missingGoogleLocationIds: err.missingGoogleLocationIds }, result: 'denied',
        message: `Reconnect rejected: ${err.missingGoogleLocationIds.length} already-approved location(s) are not visible to this Google account. Your previous Google connection remains unchanged.`,
      })
      return res.status(409).send(page('This Google account is missing approved locations', `
        <p>This Google account does not have access to ${err.missingGoogleLocationIds.length} of this business's already-approved location(s).</p>
        <p style="color:#16a34a">Your previous Google connection remains active and unchanged.</p>
        <p>Reconnect using the Google account that manages every approved location, or contact support.</p>
        <p><a href="/settings/google">← Back to Settings</a></p>
      `))
    }
  }

  try {
    // Multi-Tenant Phase 4A/4C: verifiedTenantId came from the
    // just-validated OAuth state (never re-derived from anything else at
    // this point) and is the ONLY tenant this write can ever target.
    // setStoredCredentialIfVersion() resolves the physical key via the same
    // LEGACY/CUTOVER migration mode credentialStore.js's reads use --
    // gbp_credentials:v1 for the one tenant explicitly pinned to LEGACY
    // (Los Tres Amigos, to stay in sync with the Python background
    // pipeline), gbp_credentials:v2:{tenantId} for every other tenant.
    //
    // Multi-Tenant Phase 4I.2: this single call both CHECKS
    // expectedCredentialVersion and WRITES the candidate, atomically, in
    // one Redis EVAL -- no separate re-check step exists anymore because
    // none is needed; the atomicity IS the guarantee. On a version
    // conflict this throws CredentialVersionConflictError below instead of
    // writing anything, and this function does NOT retry -- a stale
    // candidate is discarded outright, never automatically re-attempted;
    // the user explicitly reconnects again if they still want to.
    await setStoredCredentialIfVersion(verifiedTenantId, { refreshToken: tokens.refresh_token, connectedAccountName }, expectedCredentialVersion)
  } catch (err) {
    if (err instanceof CredentialVersionConflictError) {
      await appendAuditEntry(verifiedTenantId, {
        actorId: account.userId, actorName: account.displayName ?? account.email, actorEmail: account.email, ip: clientIp(req),
        entity: 'google_oauth', entityId: null, action: 'google.reconnect_rejected_stale_version', changes: { expectedCredentialVersion }, result: 'denied',
        message: `Reconnect rejected: this tenant's Google connection changed while this request was being processed (expected credential version ${expectedCredentialVersion}). Nothing further was changed by this request.`,
      })
      return res.status(409).send(page('Connection changed', `
        <p>This tenant's Google connection was updated by another request while this one was being processed.</p>
        <p style="color:#16a34a">The most recent connection is the one now in effect; nothing further has been changed by this request.</p>
        <p><a href="/settings/google">← Back to Settings</a></p>
      `))
    }
    // The refresh token is NEVER displayed, logged, or put in a URL even
    // on this failure path -- `tokens` goes out of scope when this
    // function returns and is not persisted anywhere else.
    return res.status(503).send(page('Connected, but could not be saved', `
      <p style="color:#16a34a;font-weight:600">Authorization with Google succeeded.</p>
      <p>However, saving the connection failed: <strong>${err instanceof CredentialStoreUnavailableError ? 'the credential store is temporarily unavailable' : err.message}</strong></p>
      <p>For security, the token is not shown here, logged, or stored anywhere by this request.</p>
      <p>Return to <a href="/settings/google">Settings → Google Business Profile</a> and click Connect again to retry.</p>
    `))
  }

  await appendAuditEntry(verifiedTenantId, {
    actorId: account.userId, actorName: account.displayName ?? account.email, actorEmail: account.email, ip: clientIp(req),
    entity: 'google_oauth', entityId: null, action: 'google.reconnected', changes: null, result: 'success',
    message: connectedAccountName
      ? `Connected Google Business Profile account "${connectedAccountName}"${isCommittedTenant ? ' (reconciled against existing approved locations)' : ''}.`
      : 'Connected a Google Business Profile account.',
  })

  return res.send(page('✓ Google connected!', `
    <p style="color:#16a34a;font-weight:600">Authorization successful. Your connection is saved and active immediately -- no redeploy needed.</p>
    <p>This page does not show the token — it's encrypted and stored securely server-side, and never reaches the browser.</p>
    <p>Return to <a href="/settings/google">Settings → Google Business Profile</a> to confirm the connection.</p>
  `))
}

// ---------------------------------------------------------------------------
// GET /api/google/status -- reports the current connection status.
// Returns { connected, state, accountName?, accountId?, scopes?, tokenExpiresIn? }
// ---------------------------------------------------------------------------

// Phase 8, Milestone 8.7: `state` is now one of GoogleHealth's five values
// (connected/token_expired/token_revoked/auth_failed/never_connected) plus
// 'not_configured' for the one config-level gap (GOOGLE_CLIENT_ID/SECRET
// missing) that isn't a connection-health problem at all. Every response
// echoes back credentialMetaFields() so the Settings page always has
// Connected Account/Last Authentication/Last Successful Sync/Last Failed
// Sync/Token Health available, regardless of which branch produced it.
//
// This is also the "automatic recovery" mechanism in action: an
// invalid_grant here calls recordSyncOutcome() BEFORE responding, so the
// health this same response reports is already the corrected value -- the
// dashboard never shows a stale "Connected" after a token was just found
// to be revoked.
async function status(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const account = await requireAuth(req, res, ['owner'])
  if (!account) return

  // Multi-Tenant Phase 4A: every credential/health operation below is
  // scoped to THIS tenant only, derived from the authenticated session --
  // never from any request input.
  const tenantId = resolveTenantId(account)

  const allowed = await enforceRateLimit(req, res, `status:${account.userId}`, { requestsPerWindow: 15, windowSeconds: 60 })
  if (!allowed) return

  const hasId     = !!process.env.GOOGLE_CLIENT_ID
  const hasSecret = !!process.env.GOOGLE_CLIENT_SECRET
  if (!hasId || !hasSecret) {
    return res.status(200).json({ connected: false, state: 'not_configured' })
  }

  let credential
  try {
    credential = await getStoredCredential(tenantId)
  } catch (err) {
    if (err instanceof CredentialStoreUnavailableError) {
      return res.status(200).json({ connected: false, state: GoogleHealth.AUTH_FAILED, error: 'The credential store is temporarily unavailable.' })
    }
    throw err
  }

  if (!credential) {
    return res.status(200).json({ connected: false, state: GoogleHealth.NEVER_CONNECTED })
  }
  if (!credential.refreshToken) {
    // A stored credential exists but couldn't be decrypted (e.g.
    // CREDENTIAL_ENCRYPTION_KEY changed) -- credentialStore.js already
    // reflects this as health: auth_failed.
    return res.status(200).json({ connected: false, state: credential.health, error: 'The stored credential could not be read.', ...credentialMetaFields(credential) })
  }

  try {
    const tokenData = await exchangeRefreshToken(credential.refreshToken)
    if (!tokenData.access_token) {
      await recordSyncOutcome(tenantId, { success: false, reason: tokenData.error || 'unknown', errorDescription: tokenData.error_description })
      const updated = await getStoredCredential(tenantId)
      return res.status(200).json({
        connected: false, state: updated.health,
        error: tokenData.error_description || tokenData.error || 'Refresh token rejected',
        ...credentialMetaFields(updated),
      })
    }
    await recordOAuthRefresh(tenantId)

    // Account listing moved off the legacy v4 host in Google's 2022 API
    // split -- mybusiness.googleapis.com/v4/accounts now 404s. Reviews/reply
    // (the publish case) are unaffected; they're the one thing that stayed on v4.
    const r = await fetchWithRetry('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })

    if (!r.ok) {
      const body = await r.json().catch(() => ({}))
      const quotaExceeded = isQuotaExceededError(r.status, body)
      // A 429/RESOURCE_EXHAUSTED here happens AFTER exchangeRefreshToken()
      // already succeeded above -- it's a Google Cloud project-level
      // quota/access problem (production incident, project 786038057684),
      // not a broken OAuth connection, so it gets its own reason distinct
      // from a genuine 401/403 -- see healthForFailure()'s comment for why
      // 401/403 still both bucket into AUTH_FAILED today.
      const reason = quotaExceeded ? 'quota_exceeded'
        : r.status === 403 ? 'permission_denied'
        : r.status === 401 ? 'unauthorized'
        : 'api_error'
      await recordSyncOutcome(tenantId, { success: false, reason, errorDescription: body.error?.message })
      const updated = await getStoredCredential(tenantId)
      return res.status(200).json({
        // The Google account connection itself is intact for a quota
        // block (the refresh token and access-token exchange both just
        // worked) -- only a genuine auth/permission failure should report
        // connected:false.
        connected: quotaExceeded,
        state: updated.health,
        error: body.error?.message || `GBP API ${r.status}`,
        quotaProjectNumber: quotaExceeded ? extractQuotaProjectNumber(body.error?.message) : null,
        ...credentialMetaFields(updated),
      })
    }

    const data       = await r.json()
    const gbpAccount = (data.accounts || [])[0]
    await recordSyncOutcome(tenantId, { success: true })
    const updated = await getStoredCredential(tenantId)

    return res.status(200).json({
      connected:      true,
      state:          GoogleHealth.CONNECTED,
      accountName:    gbpAccount?.accountName || updated.connectedAccountName || 'Google Business Profile',
      accountId:      gbpAccount?.name || null,
      accountCount:   (data.accounts || []).length,
      scopes:         (tokenData.scope || 'https://www.googleapis.com/auth/business.manage').split(' '),
      tokenExpiresIn: tokenData.expires_in || null,
      ...credentialMetaFields(updated),
    })
  } catch (err) {
    return res.status(200).json({ connected: false, state: GoogleHealth.AUTH_FAILED, error: err.message, ...credentialMetaFields(credential) })
  }
}

// ---------------------------------------------------------------------------
// GET /api/google/test-connection -- walks the full connection chain.
// Returns { overallStatus: 'pass'|'fail', checks: [{ id, label, status, detail }] }
// ---------------------------------------------------------------------------

// Google split the old monolithic v4 "My Business API" into several
// purpose-built APIs in 2022. Only review read/reply stayed on the legacy
// v4 host -- account and location listing moved and now 404 on the old
// v4 paths, which is why these are three different hosts.
const GBP_BASE = 'https://mybusiness.googleapis.com/v4'
const ACCOUNTS_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1'
const LOCATIONS_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1'
const LOCATIONS_READ_MASK = 'name,title,storefrontAddress,metadata'

function check(id, label, status, detail) {
  return { id, label, status, detail }
}

// The Business Information API's location.name may or may not include the
// parent account segment (its canonical form is just "locations/{id}").
// The legacy v4 reviews/reply endpoints require the full
// "accounts/{acct}/locations/{id}" path, so this rebuilds it from whatever
// segment Google actually returned, regardless of which form.
function v4LocationPath(accountName, locationApiName) {
  const tail = (locationApiName || '').split('locations/').pop()
  return `${accountName}/locations/${tail}`
}

async function testConnection(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const account = await requireAuth(req, res, ['owner'])
  if (!account) return

  // Multi-Tenant Phase 4A: scoped to this tenant only.
  const tenantId = resolveTenantId(account)

  const allowed = await enforceRateLimit(req, res, `test-connection:${account.userId}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  const checks = []
  const clientId     = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET

  // 1. OAuth credentials configured
  if (!clientId || !clientSecret) {
    checks.push(check('credentials', 'OAuth credentials configured', 'fail',
      `Missing ${!clientId ? 'GOOGLE_CLIENT_ID' : 'GOOGLE_CLIENT_SECRET'} in Vercel environment variables.`))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }
  checks.push(check('credentials', 'OAuth credentials configured', 'pass',
    'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.'))

  let credential
  try {
    credential = await getStoredCredential(tenantId)
  } catch (err) {
    checks.push(check('refresh_token', 'Refresh token present', 'fail',
      err instanceof CredentialStoreUnavailableError ? 'The credential store is temporarily unavailable.' : err.message))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }
  if (!credential || !credential.refreshToken) {
    checks.push(check('refresh_token', 'Refresh token present', 'fail',
      'No Google account is connected yet. Connect a Google account from Settings first.'))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }
  checks.push(check('refresh_token', 'Refresh token present', 'pass', 'A Google account is connected.'))

  // 2. Refresh token exchange
  const tokenData = await exchangeRefreshToken(credential.refreshToken).catch(err => ({ __networkError: err }))
  if (tokenData.__networkError) {
    checks.push(check('token_exchange', 'Exchange refresh token for access token', 'fail',
      `Network error reaching Google's token endpoint: ${tokenData.__networkError.message}`))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }

  if (!tokenData.access_token) {
    await recordSyncOutcome(tenantId, { success: false, reason: tokenData.error || 'unknown', errorDescription: tokenData.error_description })
    checks.push(check('token_exchange', 'Exchange refresh token for access token', 'fail',
      tokenData.error_description || tokenData.error || 'Google rejected the refresh token. It may have been revoked -- reconnect from Settings.'))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }
  await recordOAuthRefresh(tenantId)
  checks.push(check('token_exchange', 'Exchange refresh token for access token', 'pass',
    `Access token obtained, expires in ${tokenData.expires_in || '?'}s. Scopes: ${tokenData.scope || 'unknown'}.`))

  const token = tokenData.access_token
  const auth  = { Authorization: `Bearer ${token}` }

  // 3. Account access
  let accounts
  try {
    const r = await fetchWithRetry(`${ACCOUNTS_BASE}/accounts`, { headers: auth })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      checks.push(check('accounts', 'List Google Business Profile accounts', 'fail',
        e.error?.message || `Google API returned status ${r.status}.`))
      return res.status(200).json({ overallStatus: 'fail', checks })
    }
    const data = await r.json()
    accounts = data.accounts || []
  } catch (err) {
    checks.push(check('accounts', 'List Google Business Profile accounts', 'fail', `Request failed: ${err.message}`))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }

  if (!accounts.length) {
    checks.push(check('accounts', 'List Google Business Profile accounts', 'fail',
      'The authorized Google account has zero Business Profile accounts. Reconnect with the account that manages your locations.'))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }
  checks.push(check('accounts', 'List Google Business Profile accounts', 'pass',
    `Found ${accounts.length} account(s): ${accounts.map(a => a.accountName).join(', ')}.`))

  // 4. Location access
  let locations = []
  try {
    for (const acct of accounts) {
      const r = await fetchWithRetry(
        `${LOCATIONS_BASE}/${acct.name}/locations?pageSize=100&readMask=${encodeURIComponent(LOCATIONS_READ_MASK)}`,
        { headers: auth }
      )
      if (r.ok) {
        const data = await r.json()
        locations = locations.concat((data.locations || []).map(loc => ({
          ...loc,
          name: v4LocationPath(acct.name, loc.name || ''),
          locationName: loc.title,
        })))
      }
    }
  } catch (err) {
    checks.push(check('locations', 'List locations', 'fail', `Request failed: ${err.message}`))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }

  if (!locations.length) {
    checks.push(check('locations', 'List locations', 'fail',
      'No locations found under this account. Verify the account has verified locations.'))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }
  checks.push(check('locations', 'List locations', 'pass', `Found ${locations.length} location(s).`))

  // 5. Review read access (probe the first location)
  let sampleReviews = []
  try {
    const r = await fetchWithRetry(`${GBP_BASE}/${locations[0].name}/reviews?pageSize=5`, { headers: auth })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      checks.push(check('reviews', 'Read reviews', 'fail',
        e.error?.message || `Google API returned status ${r.status} for "${locations[0].locationName}".`))
      return res.status(200).json({ overallStatus: 'fail', checks })
    }
    const data = await r.json()
    sampleReviews = data.reviews || []
  } catch (err) {
    checks.push(check('reviews', 'Read reviews', 'fail', `Request failed: ${err.message}`))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }
  checks.push(check('reviews', 'Read reviews', 'pass',
    `Read ${sampleReviews.length} sample review(s) from "${locations[0].locationName}".`))

  // 6. Reply permission probe -- GBP has no dry-run endpoint, so this checks
  // for the presence of an existing reply on the sample review (a real write
  // probe would be destructive); a definitive answer only comes from an
  // actual publish attempt, which this intentionally does not perform.
  checks.push(check('reply_permission', 'Reply permission', 'pass',
    'The authorized token has the business.manage scope, which grants reply permission. ' +
    '(Google has no read-only way to confirm this without attempting a real reply -- ' +
    'this check will only fail at actual publish time if permission was revoked.)'))

  checks.push(check('api_health', 'Google Business Profile API health', 'pass',
    'All API calls in this test completed without errors.'))

  await recordSyncOutcome(tenantId, { success: true })
  return res.status(200).json({ overallStatus: 'pass', checks })
}

// ---------------------------------------------------------------------------
// POST /api/google/trigger-sync -- dispatches the "Update Reviews" workflow.
// Returns { success: true } or { error, message }
// ---------------------------------------------------------------------------

const REPO_OWNER = 'LosTresAmigos1'
const REPO_NAME  = 'lta-review-dashboard'

async function triggerSync(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const account = await requireAuth(req, res, ['owner'])
  if (!account) return

  // Multi-Tenant Phase 4B: this dispatches update-reviews.yml against a
  // single, HARDCODED repo (REPO_OWNER/REPO_NAME above) that syncs and
  // exports ONE tenant's data (Los Tres Amigos's reviews.db) -- unlike the
  // Redis-backed stores and the Phase 4A credential store, this pipeline
  // has no per-tenant equivalent yet. Without this check, any future
  // tenant's Owner could dispatch a sync/export cycle that reads and
  // republishes Los Tres Amigos's own data (a "sync state" cross-tenant
  // leak per the Phase 4B audit), purely because they hold the Owner role
  // on their OWN unrelated tenant. Fail closed for every tenant except the
  // one this pipeline actually belongs to, until a real per-tenant sync
  // pipeline exists.
  if (resolveTenantId(account) !== DEFAULT_TENANT_ID) {
    return res.status(403).json({
      error:   'forbidden',
      message: 'This action is not available for your organization yet.',
    })
  }

  const allowed = await enforceRateLimit(req, res, `trigger-sync:${account.userId}`, { requestsPerWindow: 5, windowSeconds: 60 })
  if (!allowed) return

  const pat = process.env.GITHUB_SYNC_PAT
  if (!pat) {
    return res.status(503).json({
      error:   'not_configured',
      message: 'GITHUB_SYNC_PAT is not set in Vercel environment variables. Add a GitHub personal access token with "workflow" scope to enable manual sync triggers.',
    })
  }

  try {
    const r = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/update-reviews.yml/dispatches`,
      {
        method:  'POST',
        headers: {
          Authorization:          `Bearer ${pat}`,
          Accept:                 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type':         'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    )

    if (r.status === 204) {
      return res.status(200).json({ success: true })
    }

    const body = await r.json().catch(() => ({}))
    return res.status(502).json({
      error:   'github_error',
      message: body.message || `GitHub API returned status ${r.status}.`,
    })
  } catch (err) {
    return res.status(502).json({ error: 'network_error', message: err.message })
  }
}

// ---------------------------------------------------------------------------
// POST /api/google/trigger-import -- dispatches the "Historical Import" workflow.
// { apply?: boolean } -> { success: true } or { error, message }
// ---------------------------------------------------------------------------

// Applying a historical import mutates every review row -- this must
// require more than just an Owner-role session (which the frontend's old
// "type IMPORT" gate only enforced client-side). The server demands the
// same literal confirmation phrase, checked here, so bypassing the UI (a
// raw request to this endpoint) can't skip it.
const CONFIRM_PHRASE = 'IMPORT'

async function triggerImport(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const account = await requireAuth(req, res, ['owner'])
  if (!account) return

  // Multi-Tenant Phase 4B: same reasoning as triggerSync() above -- this
  // dispatches a historical-import run against the single, hardcoded
  // Los Tres Amigos repo/database. Fail closed for any other tenant.
  if (resolveTenantId(account) !== DEFAULT_TENANT_ID) {
    return res.status(403).json({
      error:   'forbidden',
      message: 'This action is not available for your organization yet.',
    })
  }

  const allowed = await enforceRateLimit(req, res, `trigger-import:${account.userId}`, { requestsPerWindow: 5, windowSeconds: 60 })
  if (!allowed) return

  const pat = process.env.GITHUB_SYNC_PAT
  if (!pat) {
    return res.status(503).json({
      error:   'not_configured',
      message: 'GITHUB_SYNC_PAT is not set in Vercel environment variables. Add a GitHub personal access token with "workflow" scope to enable this.',
    })
  }

  const apply = req.body?.apply === true

  if (apply && req.body?.confirm !== CONFIRM_PHRASE) {
    return res.status(400).json({
      error:   'confirmation_required',
      message: `Applying a historical import requires confirm: "${CONFIRM_PHRASE}" in the request body.`,
    })
  }

  try {
    const r = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/historical-import.yml/dispatches`,
      {
        method:  'POST',
        headers: {
          Authorization:          `Bearer ${pat}`,
          Accept:                 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type':         'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: { apply: apply ? 'true' : 'false' } }),
      }
    )

    if (r.status === 204) {
      return res.status(200).json({ success: true })
    }

    const body = await r.json().catch(() => ({}))
    return res.status(502).json({
      error:   'github_error',
      message: body.message || `GitHub API returned status ${r.status}.`,
    })
  } catch (err) {
    return res.status(502).json({ error: 'network_error', message: err.message })
  }
}

// ---------------------------------------------------------------------------
// POST /api/google/publish -- posts a reply to a Google Business Profile review.
// { reviewName?, locationName?, reviewerName?, replyText } -> { success: true } or { error, message }
//
// Preferred path: pass `reviewName` (the Google API resource path, e.g.
// accounts/*/locations/*/reviews/*) directly -- set once a review has been
// linked via gbp_sync.py/gbp_import.py, this skips matching entirely.
// Fallback path: `locationName` + `reviewerName`, for older reviews the
// historical reconciliation hasn't linked yet -- fuzzy-matches by name
// (unavoidable without a persisted id for that review).
// ---------------------------------------------------------------------------

// Multi-Location Authentication & User Access System, Commit 4: Location
// Manager (and a location-scoped Marketing account) can now reach this
// endpoint -- the review->location resolution the earlier comment here
// called out as missing now exists (reviewLocationIndex.js, built from
// export_chunks.py's export_review_location_index()). Gated by permission
// (REPLY for owner/marketing's unrestricted access, REPLY_ASSIGNED for a
// scoped location_manager/marketing account), not a flat role array --
// see requireScopedAuth() below, which also enforces per-review location
// ownership via resolveLocationIdForReviewOrDeny().
const PUBLISH_PERMISSIONS = [Permission.REPLY, Permission.REPLY_ASSIGNED]

async function gbpGet(url, token) {
  const r = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) {
    const e = await r.json().catch(() => ({}))
    throw Object.assign(new Error(e.error?.message || `GBP API ${r.status}`), { status: r.status })
  }
  return r.json()
}

// Follows nextPageToken to completion -- the old version silently stopped
// at the first page (100 locations / 50 reviews), missing anything beyond it.
// baseUrl is a full URL (callers pass the correct host per endpoint, since
// accounts/locations/reviews no longer all live on the same one).
async function gbpGetAllPages(baseUrl, token, listKey, pageParam = 'pageSize', pageSize = 100) {
  let items = []
  let pageToken = null
  do {
    const sep = baseUrl.includes('?') ? '&' : '?'
    const url = `${baseUrl}${sep}${pageParam}=${pageSize}${pageToken ? `&pageToken=${pageToken}` : ''}`
    const data = await gbpGet(url, token)
    items = items.concat(data[listKey] || [])
    pageToken = data.nextPageToken || null
  } while (pageToken)
  return items
}

// Multi-Tenant Phase 4I.2 -- lifecycle statuses in which a Google credential
// reconnect is refused OUTRIGHT (not merely reconciled), because a live,
// in-flight process is actively using the CURRENT credential and this
// codebase has no per-write concurrency primitive over credentialStore.js's
// single physical key that could safely coexist with it. 'initial_sync' is
// the only such status -- initial_sync.py fetches and uses the tenant's
// Google credential throughout a single run; a mid-run swap could hand a
// running sync a credential for a DIFFERENT Google account than the one it
// validated at its own start, undermining its own reconciliation
// (ApprovedLocationsOnlyGBPProvider) guarantees. provision_tenant.py, by
// contrast, never calls the Google API at all, so 'provisioning'/
// 'provisioning_failed' carry no equivalent risk and are handled by the
// ordinary reconciliation path below instead of an outright block.
const RECONNECT_BLOCKED_STATUSES = new Set(['initial_sync'])

function normName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function locationMatches(gbpName, ourName) {
  const a = normName(gbpName)
  const b = normName(ourName)
  return a === b || a.includes(b) || b.includes(a)
}

async function replyViaReviewName(reviewName, replyText, token) {
  const replyRes = await fetchWithRetry(`${GBP_BASE}/${reviewName}/reply`, {
    method:  'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ comment: replyText }),
  })

  if (!replyRes.ok) {
    const e = await replyRes.json().catch(() => ({}))
    const msg = e.error?.message || `GBP replied with status ${replyRes.status}`
    if (replyRes.status === 403) throw Object.assign(new Error(msg), { status: 403, code: 'missing_permission' })
    if (replyRes.status === 404) throw Object.assign(new Error(msg), { status: 404, code: 'review_gone' })
    throw Object.assign(new Error(msg), { status: 502, code: 'api_error' })
  }
}

async function publish(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed', message: 'Method not allowed' })

  // requireScopedAuth resolves the review's location BEFORE any further
  // validation, so an unauthorized caller never learns whether their
  // payload was otherwise well-formed.
  //
  // SECURITY: authorization is resolved against `reviewName` when present,
  // NOT `localReviewId` -- reviewName is the EXACT identifier
  // replyViaReviewName() below actually writes to, so checking against it
  // closes a TOCTOU gap a naive localReviewId-only check would have (a
  // scoped caller could otherwise pass a legitimate localReviewId for
  // their own location alongside a locationName/reviewerName pair that
  // fuzzy-matches a DIFFERENT location's review -- the authorization check
  // and the actual write would then be checking two different reviews).
  // resolveLocationIdForReviewOrDeny returns null (skip the location
  // check) only for a company-wide (locationIds === '*') caller -- a
  // location-scoped caller with no resolvable identifier is denied (404),
  // never silently treated as company-wide.
  const scope = await requireScopedAuth(req, res, {
    permission: PUBLISH_PERMISSIONS,
    resolveLocationId: async (req, account) => resolveLocationIdForReviewOrDeny(req.body?.reviewName || req.body?.localReviewId, account),
  })
  if (!scope) return
  const { account } = scope

  // Multi-Tenant Phase 4A: authorization (requireScopedAuth above) has
  // already run, so this is the tenant whose OWN credential must be used
  // for the rest of this request -- a Tenant B request can never reach
  // this point carrying Tenant A's location/review ids in the first place
  // (requireScopedAuth's location-tenant-ownership check denies that
  // earlier), and even if it somehow did, this would still only ever load
  // Tenant B's own (likely nonexistent) credential, never Tenant A's.
  const tenantId = resolveTenantId(account)

  const allowed = await enforceRateLimit(req, res, `publish:${account.userId}`, { requestsPerWindow: 20, windowSeconds: 60 })
  if (!allowed) return

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({
      error:   'not_connected',
      message: 'Google Business Profile is not connected. Complete setup in Settings → Google Business Profile.',
    })
  }

  let credential
  try {
    credential = await getStoredCredential(tenantId)
  } catch {
    return res.status(503).json({ error: 'not_connected', message: 'Google Business Profile connection is temporarily unavailable. Please try again shortly.' })
  }
  if (!credential || !credential.refreshToken) {
    return res.status(503).json({
      error:   'not_connected',
      message: 'Google Business Profile is not connected. Complete setup in Settings → Google Business Profile.',
    })
  }

  const { reviewName, locationName, reviewerName, replyText, localReviewId, reviewDate } = req.body ?? {}

  if (!replyText || (!reviewName && !locationName)) {
    return res.status(400).json({ error: 'api_error', message: 'Missing replyText, and either reviewName or locationName.' })
  }

  // A location-scoped account (location_manager, or a location-scoped
  // Marketing account) may not use the fuzzy locationName/reviewerName
  // fallback path -- the authorization check above verified `reviewName`'s
  // own resolved location, not whatever a name-match might land on. This
  // is what actually closes the TOCTOU gap described above, not just the
  // resolveLocationId call: without this, a scoped account could still
  // pass an unrelated (but self-owned) reviewName merely to satisfy the
  // authorization check while replying via the untrusted fallback path.
  if (account.locationIds !== '*' && !reviewName) {
    return res.status(400).json({
      error: 'review_name_required',
      message: 'This account can only reply using the linked review. Ask an Owner or Admin if this review needs the legacy name-matching fallback.',
    })
  }

  // Recovery Milestone 6B, Part 2: called ONLY after replyViaReviewName()
  // has already returned successfully -- Google has confirmed the reply
  // before this ever runs, matching the required ordering (send -> Google
  // success -> THEN durable write -> THEN respond). If Redis is down or
  // unconfigured, Google's success is never hidden behind that: the
  // response is still 200 success:true, just with bridgeWarning:true so
  // the frontend can say "published, but local confirmation couldn't be
  // saved" instead of silently claiming full durability it doesn't have.
  async function respondPublishSuccess(resolvedGbpReviewName) {
    await recordSyncOutcome(tenantId, { success: true })
    // Notification Center Audit & Fix: a subsequent successful publish
    // resolves any previously-recorded "reply failed" notification for
    // this review -- best-effort, never allowed to affect the actual
    // publish response (matches the bridge-write tolerance immediately
    // below, and the publish bridge's own success path is entirely
    // unaffected by this).
    if (localReviewId) await clearReplyFailure(tenantId, localReviewId)
    if (!localReviewId) {
      // Frontend didn't send its own review id (older client, or a caller
      // hitting this endpoint directly) -- Google still succeeded, there's
      // just nothing to key a bridge record by. Same partial-success shape,
      // not a hard failure.
      return res.status(200).json({ success: true, bridgeWarning: true })
    }
    try {
      await writePublishBridge(tenantId, localReviewId, {
        gbpReviewName: resolvedGbpReviewName ?? null,
        responseText: replyText,
        locationName: locationName ?? null,
        reviewerName: reviewerName ?? null,
        reviewDate: reviewDate ?? null,
      })
      return res.status(200).json({ success: true })
    } catch (err) {
      // PublishBridgeUnavailableError (not configured / Redis unreachable)
      // or any other write failure -- Google already has the reply, so this
      // is never reported as a publish failure.
      console.error(`[publish] bridge write failed after a successful Google publish (localReviewId=${localReviewId}): ${err instanceof PublishBridgeUnavailableError ? err.message : 'unexpected error'}`)
      return res.status(200).json({ success: true, bridgeWarning: true })
    }
  }

  // Token acquisition is checked/recorded separately from the reply
  // attempt itself: an invalid_grant here is a CONNECTION health problem
  // (feeds the "automatic recovery" status flip), while a failure further
  // down (403/404 from the reply call) is specific to this one review and
  // must never be mistaken for the whole connection being broken.
  let token
  try {
    token = await getAccessToken(credential.refreshToken)
    await recordOAuthRefresh(tenantId)
  } catch (err) {
    if (err.code === 'invalid_grant') {
      await recordSyncOutcome(tenantId, { success: false, reason: 'invalid_grant', errorDescription: err.description })
    }
    return res.status(503).json({
      error:   'not_connected',
      message: 'Google Business Profile needs to be reconnected. See Settings → Google Business Profile.',
    })
  }

  try {
    // Preferred: direct resource path, already linked -- no lookup needed.
    if (reviewName) {
      await replyViaReviewName(reviewName, replyText, token)
      return respondPublishSuccess(reviewName)
    }

    // Fallback: fuzzy-match by location name, then by reviewer display name.
    const accounts = await gbpGetAllPages(`${ACCOUNTS_BASE}/accounts`, token, 'accounts')
    if (!accounts.length) {
      return res.status(404).json({ error: 'location_mismatch', message: 'No GBP accounts found on this Google account.' })
    }

    let targetLocation = null
    for (const acct of accounts) {
      const rawLocations = await gbpGetAllPages(
        `${LOCATIONS_BASE}/${acct.name}/locations?readMask=${encodeURIComponent(LOCATIONS_READ_MASK)}`,
        token, 'locations'
      ).catch(() => [])
      const locations = rawLocations.map(loc => ({
        ...loc,
        name: v4LocationPath(acct.name, loc.name),
        locationName: loc.title,
      }))
      targetLocation = locations.find(loc => locationMatches(loc.locationName, locationName))
      if (targetLocation) break
    }

    if (!targetLocation) {
      return res.status(404).json({
        error:   'location_mismatch',
        message: `Could not find "${locationName}" in your Google Business Profile. Make sure the location name matches exactly.`,
      })
    }

    const reviews = await gbpGetAllPages(`${GBP_BASE}/${targetLocation.name}/reviews`, token, 'reviews', 'pageSize', 50)
    if (!reviews.length) {
      return res.status(404).json({ error: 'review_gone', message: 'No reviews found for this location on Google.' })
    }

    const review = reviews.find(rv => normName(rv.reviewer?.displayName) === normName(reviewerName))
    if (!review) {
      return res.status(404).json({
        error:   'review_gone',
        message: `Could not find a review from "${reviewerName}" for this location. It may have been removed.`,
      })
    }

    await replyViaReviewName(review.name, replyText, token)
    return respondPublishSuccess(review.name)

  } catch (err) {
    // err.status/err.code come from replyViaReviewName's own thrown errors
    // (403/missing_permission, 404/review_gone, or 502/api_error) -- the
    // `|| 500`/`|| 'api_error'` fallbacks only matter for a genuinely
    // unexpected exception this function never itself throws deliberately.
    const status = err.status || 500
    // Notification Center Audit & Fix: records a "reply failed" event so it
    // surfaces in the Notification Center rather than existing only in
    // this response and whatever the caller's own UI does with it. Never
    // allowed to change the actual error response -- if localReviewId is
    // missing (an older client, or a direct caller with no id to key by),
    // or the notification write itself fails, the original error response
    // below is returned exactly as it always was.
    if (localReviewId) {
      const failedLocationId = await resolveLocationIdForReview(localReviewId, tenantId).catch(() => null)
      await recordReplyFailure(tenantId, localReviewId, {
        locationId: failedLocationId,
        locationName: locationName ?? null,
        reviewerName: reviewerName ?? null,
        failReason: err.message || 'Google did not accept the reply.',
      })
    }
    return res.status(status).json({
      error:   err.code || 'api_error',
      message: err.message,
    })
  }
}

// ---------------------------------------------------------------------------
// POST /api/google/publish-bridge -- Recovery Milestone 6B, Part 5: bulk
// read of durable publish-bridge records for the reviews currently loaded
// on the page. { ids: string[] } -> { [id]: { status, responseText,
// publishedAt, gbpReviewName } }. Only ids that currently have a live
// bridge record appear in the result; everything else is simply absent
// (the overwhelmingly common case -- no error).
//
// A bulk POST (not one GET per review) is deliberate -- Part 5 explicitly
// calls out avoiding N+1 API calls. Returns only the fields the frontend's
// reply-state model actually needs, not the full stored record (no
// location/reviewer/date leak beyond what's already visible in the review
// list itself).
// ---------------------------------------------------------------------------

const PUBLISH_BRIDGE_MAX_IDS = 200

async function publishBridge(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed', message: 'Method not allowed' })

  // A bulk read across many ids doesn't map to requireScopedAuth's
  // single-resolveLocationId shape -- gate on permission only here
  // (roleHasPermission below), then filter each returned record by the
  // caller's own location grant before it reaches the response.
  const account = await requireAuth(req, res, null)
  if (!account) return
  if (!PUBLISH_PERMISSIONS.some(p => roleHasPermission(account.role, p))) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to perform this action.' })
  }

  const allowed = await enforceRateLimit(req, res, `publish-bridge:${account.userId}`, { requestsPerWindow: 60, windowSeconds: 60 })
  if (!allowed) return

  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(id => typeof id === 'string' && id) : null
  if (!ids) {
    return res.status(400).json({ error: 'api_error', message: 'Missing ids (array of strings).' })
  }
  if (ids.length > PUBLISH_BRIDGE_MAX_IDS) {
    return res.status(400).json({ error: 'api_error', message: `Too many ids (max ${PUBLISH_BRIDGE_MAX_IDS} per request).` })
  }
  if (!ids.length) return res.status(200).json({ bridges: {} })

  let records
  try {
    records = await getPublishBridges(resolveTenantId(account), ids)
  } catch (err) {
    if (err instanceof PublishBridgeUnavailableError) {
      // Degrade gracefully -- the frontend's own localStorage fallback
      // (Part 3's tier 3) still covers same-browser publishes even if the
      // bridge itself can't be read right now. Not a hard failure.
      return res.status(200).json({ bridges: {}, degraded: true })
    }
    throw err
  }

  const bridges = {}
  for (const [id, record] of Object.entries(records)) {
    // Location-scoped caller: only include a bridge record for a review
    // this account actually has access to -- resolved the same way
    // publish() authorizes a single review (localReviewId, since that's
    // what these bridge records are keyed by). A record for an
    // unresolvable/foreign review is simply omitted, matching this
    // endpoint's existing "absent means no bridge record" contract rather
    // than surfacing a 403/404 for one id among many.
    // Multi-Tenant Phase 4B: isWildcardGrant(), not a bare
    // `locationIds === '*'` check -- a wildcard grant only means "skip
    // the per-record location filter" when the account's own tenant
    // actually owns a location catalog (see auth.js's isWildcardGrant()/
    // tenants.js's tenantOwnsLocationCatalog()). A non-onboarded tenant
    // holding '*' must still have every record filtered (and therefore
    // excluded, since it owns no locations at all), never treated as
    // "sees everything."
    if (!isWildcardGrant(account)) {
      const locationId = await resolveLocationIdForReview(id, resolveTenantId(account))
      if (locationId === null || !requireLocationAccess(account, locationId)) continue
    }
    bridges[id] = {
      status: record.status,
      responseText: record.responseText,
      publishedAt: record.publishedAt,
      gbpReviewName: record.gbpReviewName ?? null,
    }
  }
  return res.status(200).json({ bridges })
}

// ---------------------------------------------------------------------------
// POST /api/google/disconnect (Phase 8, Milestone 8.7) -- { confirm: "DISCONNECT" }
// Owner-only. Genuinely removes the stored credential (not a soft-disable) --
// a fresh Connect afterward is indistinguishable from a first-time
// connection. Requires the same literal server-enforced confirmation
// phrase pattern trigger-import.js already uses, so a raw request can't
// bypass the UI's type-the-word confirmation.
// ---------------------------------------------------------------------------

const DISCONNECT_CONFIRM_PHRASE = 'DISCONNECT'

// ---------------------------------------------------------------------------
// POST /api/google/seal-google-oauth-client-for-github -- TEMPORARY,
// Phase 4N one-time synchronization mechanism ONLY. Gated to platform
// owners only, same model as Phase 4M's
// seal-encryption-key-for-github. Seals THIS environment's live
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (independently) for a
// HARDCODED, repository-pinned GitHub Actions public key
// (googleOAuthClientSealer.js) -- accepts NO body fields at all (a
// request body of any kind is rejected), so there is no way for a
// caller to influence which key either secret is sealed for. Returns
// ONLY the two sealed ciphertexts + the pinned key_id -- never either
// plaintext value, never a caller-suppliable value reflected back.
// Remove this action (and googleOAuthClientSealer.js) once the
// GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET synchronization is verified
// complete.
// ---------------------------------------------------------------------------
async function sealGoogleOAuthClientForGithub(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const account = await requireAuth(req, res, ['owner'])
  if (!account) return
  if (!isPlatformOwnerEmail(account.email)) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const allowed = await enforceRateLimit(req, res, `seal-google-oauth-client-for-github:${account.userId}`, { requestsPerWindow: 3, windowSeconds: 60 })
  if (!allowed) return

  // Deliberately requires an EMPTY body -- any field at all is rejected,
  // so there is no request-controlled input of any kind into the seal
  // operation (see googleOAuthClientSealer.js's header comment for why a
  // caller-suppliable public key would be a secret-export oracle).
  const body = req.body
  const hasAnyField = body != null && typeof body === 'object' && Object.keys(body).length > 0
  if (hasAnyField) {
    return res.status(400).json({ error: 'invalid_request', message: 'This endpoint accepts no request body.' })
  }

  let result
  try {
    result = await sealGoogleOAuthClientForPinnedGitHubRepo()
  } catch (err) {
    await appendAuditEntry(resolveTenantId(account), {
      actorId: account.userId, actorEmail: account.email,
      action: 'seal_google_oauth_client_for_github', result: 'failure',
    })
    if (err instanceof OAuthClientNotConfiguredError) {
      return res.status(503).json({ error: 'not_configured' })
    }
    if (err instanceof OAuthClientSealerUnavailableError) {
      return res.status(500).json({ error: 'sealing_failed' })
    }
    throw err
  }

  await appendAuditEntry(resolveTenantId(account), {
    actorId: account.userId, actorEmail: account.email,
    action: 'seal_google_oauth_client_for_github', result: 'success',
  })

  // Deliberately returns ONLY these three fields -- never either
  // plaintext value, never anything echoing a request input (there is
  // none to echo).
  return res.status(200).json({
    googleClientIdSealedBase64: result.googleClientIdSealedBase64,
    googleClientSecretSealedBase64: result.googleClientSecretSealedBase64,
    keyId: result.keyId,
  })
}

async function disconnect(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const account = await requireAuth(req, res, ['owner'])
  if (!account) return

  // Multi-Tenant Phase 4A/4C: disconnect affects ONLY this tenant's own
  // credential, resolved via the same LEGACY/CUTOVER migration mode as
  // every other credential read/write. For the LEGACY-pinned default
  // tenant (Los Tres Amigos) that IS gbp_credentials:v1 -- intentionally,
  // since v1 is that tenant's authoritative key -- and for every other
  // (CUTOVER) tenant it is that tenant's own v2 key, never another
  // tenant's and never the other migration mode's key.
  const tenantId = resolveTenantId(account)

  const allowed = await enforceRateLimit(req, res, `disconnect:${account.userId}`, { requestsPerWindow: 5, windowSeconds: 60 })
  if (!allowed) return

  if (req.body?.confirm !== DISCONNECT_CONFIRM_PHRASE) {
    return res.status(400).json({
      error:   'confirmation_required',
      message: `Disconnecting requires confirm: "${DISCONNECT_CONFIRM_PHRASE}" in the request body.`,
    })
  }

  try {
    await clearStoredCredential(tenantId)
  } catch (err) {
    if (err instanceof CredentialStoreUnavailableError) {
      return res.status(503).json({ error: 'service_unavailable', message: 'The credential store is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }

  await appendAuditEntry(tenantId, {
    actorId: account.userId, actorName: account.displayName ?? account.email, actorEmail: account.email, ip: clientIp(req),
    entity: 'google_oauth', entityId: null, action: 'google.disconnected', changes: null, result: 'success',
    message: 'Disconnected the Google Business Profile connection.',
  })

  return res.status(200).json({ success: true })
}

// ---------------------------------------------------------------------------
// POST /api/google/discover-locations -- Multi-Tenant Phase 4E, step 1 of
// the self-service activation transaction:
//   Connect Google -> DISCOVER LOCATIONS -> Approve Locations -> Ready.
// Owner-only, tenantId derived exclusively from the authenticated session
// (never request input). Lists this tenant's own real GBP locations using
// this tenant's own stored credential (Phase 4A's per-tenant credential
// store), then records exactly what was discovered in a short-lived,
// tenant-and-user-bound locationDiscoveryStore.js record. This is what
// lets approveLocations() below verify a later approval request only ever
// approves locations PRYOR itself just discovered for THIS tenant -- a
// client must never be able to submit an arbitrary Google location id and
// thereby claim it.
//
// POST, not GET, DELIBERATELY (final review decision): this call has real
// side effects -- it creates a new short-lived Redis record on every
// invocation and spends a real call against Google's (quota-limited) API --
// neither of which belongs behind a method HTTP treats as safe/cacheable/
// prefetchable. Every other "do work" action in this file (trigger-sync,
// trigger-import, publish, disconnect, approve-locations) is already POST
// for the same reason; the handful of GETs (status, test-connection) are
// pure reads that create no state. This was changed deliberately for this
// reason, not merely for stylistic consistency.
// ---------------------------------------------------------------------------

async function discoverLocations(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed', message: 'Method not allowed' })

  const account = await requireAuth(req, res, ['owner'])
  if (!account) return
  const tenantId = resolveTenantId(account)

  const allowed = await enforceRateLimit(req, res, `discover-locations:${account.userId}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  let credential
  try {
    credential = await getStoredCredential(tenantId)
  } catch {
    return res.status(503).json({ error: 'not_connected', message: 'Google Business Profile connection is temporarily unavailable. Please try again shortly.' })
  }
  if (!credential || !credential.refreshToken) {
    return res.status(503).json({
      error:   'not_connected',
      message: 'Google Business Profile is not connected. Complete setup in Settings → Google Business Profile.',
    })
  }

  let token
  try {
    token = await getAccessToken(credential.refreshToken)
  } catch (err) {
    return res.status(503).json({ error: 'not_connected', message: err.description || err.message || 'Could not obtain a Google access token.' })
  }
  const auth = { Authorization: `Bearer ${token}` }

  let accounts
  try {
    const r = await fetchWithRetry(`${ACCOUNTS_BASE}/accounts`, { headers: auth })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      return res.status(502).json({ error: 'api_error', message: e.error?.message || `Google API returned status ${r.status}.` })
    }
    accounts = (await r.json()).accounts || []
  } catch (err) {
    return res.status(502).json({ error: 'api_error', message: `Request to Google failed: ${err.message}` })
  }

  let discoveredLocations = []
  try {
    for (const acct of accounts) {
      const r = await fetchWithRetry(
        `${LOCATIONS_BASE}/${acct.name}/locations?pageSize=100&readMask=${encodeURIComponent(LOCATIONS_READ_MASK)}`,
        { headers: auth }
      )
      if (!r.ok) continue
      const data = await r.json()
      discoveredLocations = discoveredLocations.concat((data.locations || []).map(loc => ({
        googleLocationId: v4LocationPath(acct.name, loc.name || ''),
        title: loc.title || '',
        address: loc.storefrontAddress
          ? [loc.storefrontAddress.addressLines, loc.storefrontAddress.locality, loc.storefrontAddress.administrativeArea].flat().filter(Boolean).join(', ')
          : '',
      })))
    }
  } catch (err) {
    return res.status(502).json({ error: 'api_error', message: `Request to Google failed: ${err.message}` })
  }

  if (!discoveredLocations.length) {
    return res.status(200).json({ discoverySessionId: null, expiresAt: null, locations: [] })
  }

  let session
  try {
    session = await createDiscoverySession({ tenantId, userId: account.userId, discoveredLocations })
  } catch {
    return res.status(503).json({ error: 'service_unavailable', message: 'Could not start a discovery session. Please try again shortly.' })
  }

  return res.status(200).json({
    discoverySessionId: session.discoverySessionId,
    expiresAt: session.expiresAt,
    locations: discoveredLocations,
  })
}

// ---------------------------------------------------------------------------
// POST /api/google/approve-locations -- step 2: { discoverySessionId,
// selectedGoogleLocationIds }. Owner-only. Validates the selection against
// the trusted discovery record created by discoverLocations() above --
// never trusting a location list the browser sends back on its own -- then
// writes the approved locations (each stamped with a tenant-local numeric
// locationId, the same id space requireLocationAccess()/tenantOwnsLocation()
// authorize against) to this tenant's own config record
// (tenantConfigStore.js) and marks its location catalog active. That write
// is exactly what tenants.js's tenantOwnsLocationCatalog()/tenantOwnsLocation()
// read back (via primeLocationCatalogState(), starting with this tenant's
// very next authenticated request) -- no source-code change or deploy
// required.
//
// USER BINDING (final review decision): locationDiscoveryStore.js records
// which Owner ran the discovery. This is ENFORCED, not just recorded --
// only that same Owner may approve it. A discovery session is a bearer
// capability over a real, quota-limited Google API call and directly
// controls what a tenant's catalog gets activated with; if two Owners of
// the same tenant were ever mid-onboarding at once, one silently approving
// the other's unreviewed discovery result would be a surprising, hard-to-
// audit outcome for a security-sensitive, one-time transaction. There is
// no product requirement for cross-Owner handoff today, so the safer,
// narrower default (this exact Owner, on this exact discovery) is chosen;
// a future product need to let a DIFFERENT Owner approve could add an
// explicit "hand off this discovery" step rather than silently allow it.
// ---------------------------------------------------------------------------

async function approveLocations(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed', message: 'Method not allowed' })

  const account = await requireAuth(req, res, ['owner'])
  if (!account) return
  // SERVER-DERIVED ONLY -- a forged tenantId anywhere in the request
  // (query, body, or a header) is never consulted for this or anything
  // below; this is the one value that decides whose catalog gets activated.
  const tenantId = resolveTenantId(account)

  const allowed = await enforceRateLimit(req, res, `approve-locations:${account.userId}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  const { discoverySessionId, selectedGoogleLocationIds } = req.body ?? {}
  if (typeof discoverySessionId !== 'string' || !discoverySessionId) {
    return res.status(400).json({ error: 'api_error', message: 'discoverySessionId is required.' })
  }
  if (!Array.isArray(selectedGoogleLocationIds) || selectedGoogleLocationIds.length === 0 ||
      !selectedGoogleLocationIds.every(id => typeof id === 'string' && id)) {
    return res.status(400).json({ error: 'api_error', message: 'selectedGoogleLocationIds must be a non-empty array of location ids.' })
  }

  const session = await getDiscoverySession(discoverySessionId)
  // A missing/expired session, a session belonging to a DIFFERENT tenant,
  // and a session belonging to a different USER within the SAME tenant are
  // all deliberately indistinguishable here (404 in every case) -- this is
  // exactly what stops a Tenant A discovery session from being replayed
  // under a Tenant B session (or vice versa), and what enforces the user
  // binding above: a 403 would confirm "that session id is real, just not
  // yours," which this response must never reveal. Same API-error-contract
  // reasoning auth.js's requireScopedAuth() already uses for cross-tenant
  // location lookups.
  if (!session || session.tenantId !== tenantId || session.userId !== account.userId) {
    return res.status(404).json({ error: 'not_found', message: 'This discovery session was not found or has expired. Please discover locations again.' })
  }

  const discoveredIds = new Set(session.discoveredLocations.map(l => l.googleLocationId))
  const unapproved = selectedGoogleLocationIds.filter(id => !discoveredIds.has(id))
  if (unapproved.length > 0) {
    return res.status(400).json({
      error:   'location_not_discovered',
      message: 'One or more selected locations were not part of this tenant\'s own discovery result.',
    })
  }

  // Numeric locationId assignment is NOT done here -- tenantConfigStore.js's
  // recordLocationApproval() reconciles against this tenant's own
  // persistent googleLocationId -> localLocationId map (locationIdMap) and
  // monotonic nextLocationId counter, so a location keeps the same stable
  // id across re-approvals regardless of array order or which other
  // locations are selected alongside it in this call. This endpoint only
  // ever passes the CURRENT selection's raw Google fields.
  const selectedLocations = session.discoveredLocations
    .filter(l => selectedGoogleLocationIds.includes(l.googleLocationId))
    .map(l => ({ googleLocationId: l.googleLocationId, title: l.title, address: l.address }))

  let config
  try {
    config = await recordLocationApproval(tenantId, selectedLocations)
  } catch (err) {
    if (err instanceof LocationApprovalNotEligibleError) {
      // Multi-Tenant Phase 4I.1: this tenant already has a committed
      // entitlement (provisioning has started or completed) -- self-service
      // re-approval is refused, fail closed, rather than silently replacing
      // the tenant's approved/licensed location set. Logged as a denied
      // privileged operation, same audit trail as a successful approval,
      // so an unexpected wave of these is visible to whoever reviews
      // tenant_audit_log -- never a token, credential, or raw Google
      // response body, only the status/tenantId/actor already safe to log.
      await appendAuditEntry(tenantId, {
        actorId: account.userId, actorName: account.displayName ?? account.email, actorEmail: account.email, ip: clientIp(req),
        entity: 'tenant_location_catalog', entityId: tenantId, action: 'location_catalog.approval_denied_not_eligible', changes: null, result: 'denied',
        message: `Self-service location re-approval was denied: tenant status is ${JSON.stringify(err.currentStatus)}.`,
      })
      return res.status(409).json({
        error: 'not_eligible',
        message: 'This tenant\'s location catalog is already committed and can no longer be changed from Settings. Contact support to change approved locations.',
      })
    }
    return res.status(503).json({ error: 'service_unavailable', message: 'Could not activate the location catalog. Please try again shortly.' })
  }

  await appendAuditEntry(tenantId, {
    actorId: account.userId, actorName: account.displayName ?? account.email, actorEmail: account.email, ip: clientIp(req),
    entity: 'tenant_location_catalog', entityId: tenantId, action: 'location_catalog.activated', changes: null, result: 'success',
    message: `Activated the location catalog with ${config.approvedLocations.length} approved location(s).`,
  })

  return res.status(200).json({ success: true, tenantId, activatedLocationCount: config.approvedLocations.length, status: config.status })
}

// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  switch (req.query?.action) {
    case 'auth':               return auth(req, res)
    case 'callback':           return callback(req, res)
    case 'status':             return status(req, res)
    case 'test-connection':    return testConnection(req, res)
    case 'trigger-sync':       return triggerSync(req, res)
    case 'trigger-import':     return triggerImport(req, res)
    case 'publish':            return publish(req, res)
    case 'publish-bridge':     return publishBridge(req, res)
    case 'disconnect':         return disconnect(req, res)
    case 'seal-google-oauth-client-for-github': return sealGoogleOAuthClientForGithub(req, res)
    case 'discover-locations': return discoverLocations(req, res)
    case 'approve-locations':  return approveLocations(req, res)
    default:                   return res.status(404).json({ error: 'not_found' })
  }
}
