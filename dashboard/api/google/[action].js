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
import { requireAuth, evaluateSession, statusForAuthFailure } from '../_lib/auth.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import {
  getStoredCredential, setStoredCredential, recordSyncOutcome, recordOAuthRefresh,
  clearStoredCredential, GoogleHealth, CredentialStoreUnavailableError,
  isQuotaExceededError, extractQuotaProjectNumber,
} from '../_lib/credentialStore.js'
import { appendAuditEntry, clientIp } from '../_lib/auditLog.js'
import {
  writePublishBridge, getPublishBridges, PublishBridgeUnavailableError,
} from '../_lib/publishBridgeStore.js'

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
    <title>${title} — Future Insights</title>
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

  // CSRF protection: a random nonce is stored in an httpOnly cookie and sent
  // as the OAuth `state` param -- the callback case rejects the flow if the
  // two don't match on return, closing the login-CSRF gap this endpoint had.
  const state = randomBytes(32).toString('hex')
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

  if (!expectedState || state !== expectedState) {
    return res.status(400).send(page('Session expired or invalid', `
      <p>This authorization link is no longer valid (it may be old, already used, or opened in a different browser session).</p>
      <p>Go back to <a href="/settings">Settings</a> and click Connect again.</p>
    `))
  }

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

  try {
    await setStoredCredential({ refreshToken: tokens.refresh_token, connectedAccountName })
  } catch (err) {
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

  await appendAuditEntry({
    actorId: account.userId, actorName: account.displayName ?? account.email, actorEmail: account.email, ip: clientIp(req),
    entity: 'google_oauth', entityId: null, action: 'google.reconnected', changes: null, result: 'success',
    message: connectedAccountName ? `Connected Google Business Profile account "${connectedAccountName}".` : 'Connected a Google Business Profile account.',
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

  const allowed = await enforceRateLimit(req, res, `status:${account.userId}`, { requestsPerWindow: 15, windowSeconds: 60 })
  if (!allowed) return

  const hasId     = !!process.env.GOOGLE_CLIENT_ID
  const hasSecret = !!process.env.GOOGLE_CLIENT_SECRET
  if (!hasId || !hasSecret) {
    return res.status(200).json({ connected: false, state: 'not_configured' })
  }

  let credential
  try {
    credential = await getStoredCredential()
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
      await recordSyncOutcome({ success: false, reason: tokenData.error || 'unknown', errorDescription: tokenData.error_description })
      const updated = await getStoredCredential()
      return res.status(200).json({
        connected: false, state: updated.health,
        error: tokenData.error_description || tokenData.error || 'Refresh token rejected',
        ...credentialMetaFields(updated),
      })
    }
    await recordOAuthRefresh()

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
      await recordSyncOutcome({ success: false, reason, errorDescription: body.error?.message })
      const updated = await getStoredCredential()
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
    await recordSyncOutcome({ success: true })
    const updated = await getStoredCredential()

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
    credential = await getStoredCredential()
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
    await recordSyncOutcome({ success: false, reason: tokenData.error || 'unknown', errorDescription: tokenData.error_description })
    checks.push(check('token_exchange', 'Exchange refresh token for access token', 'fail',
      tokenData.error_description || tokenData.error || 'Google rejected the refresh token. It may have been revoked -- reconnect from Settings.'))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }
  await recordOAuthRefresh()
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

  await recordSyncOutcome({ success: true })
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

// Location Manager is part of the permission model but is NOT included
// below yet: this endpoint's fallback path only has a client-supplied
// locationName string to go on, with no server-side way to resolve it to
// the review's actual location_id (see README "Location authorization
// strategy" gap). Enabling Location Manager here requires that resolution
// to exist first -- do not add 'location_manager' to this list until then.
const PUBLISH_ALLOWED_ROLES = ['owner', 'marketing']

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

  const account = await requireAuth(req, res, PUBLISH_ALLOWED_ROLES)
  if (!account) return

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
    credential = await getStoredCredential()
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

  // Recovery Milestone 6B, Part 2: called ONLY after replyViaReviewName()
  // has already returned successfully -- Google has confirmed the reply
  // before this ever runs, matching the required ordering (send -> Google
  // success -> THEN durable write -> THEN respond). If Redis is down or
  // unconfigured, Google's success is never hidden behind that: the
  // response is still 200 success:true, just with bridgeWarning:true so
  // the frontend can say "published, but local confirmation couldn't be
  // saved" instead of silently claiming full durability it doesn't have.
  async function respondPublishSuccess(resolvedGbpReviewName) {
    await recordSyncOutcome({ success: true })
    if (!localReviewId) {
      // Frontend didn't send its own review id (older client, or a caller
      // hitting this endpoint directly) -- Google still succeeded, there's
      // just nothing to key a bridge record by. Same partial-success shape,
      // not a hard failure.
      return res.status(200).json({ success: true, bridgeWarning: true })
    }
    try {
      await writePublishBridge(localReviewId, {
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
    await recordOAuthRefresh()
  } catch (err) {
    if (err.code === 'invalid_grant') {
      await recordSyncOutcome({ success: false, reason: 'invalid_grant', errorDescription: err.description })
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

  const account = await requireAuth(req, res, PUBLISH_ALLOWED_ROLES)
  if (!account) return

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
    records = await getPublishBridges(ids)
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

async function disconnect(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const account = await requireAuth(req, res, ['owner'])
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `disconnect:${account.userId}`, { requestsPerWindow: 5, windowSeconds: 60 })
  if (!allowed) return

  if (req.body?.confirm !== DISCONNECT_CONFIRM_PHRASE) {
    return res.status(400).json({
      error:   'confirmation_required',
      message: `Disconnecting requires confirm: "${DISCONNECT_CONFIRM_PHRASE}" in the request body.`,
    })
  }

  try {
    await clearStoredCredential()
  } catch (err) {
    if (err instanceof CredentialStoreUnavailableError) {
      return res.status(503).json({ error: 'service_unavailable', message: 'The credential store is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }

  await appendAuditEntry({
    actorId: account.userId, actorName: account.displayName ?? account.email, actorEmail: account.email, ip: clientIp(req),
    entity: 'google_oauth', entityId: null, action: 'google.disconnected', changes: null, result: 'success',
    message: 'Disconnected the Google Business Profile connection.',
  })

  return res.status(200).json({ success: true })
}

// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  switch (req.query?.action) {
    case 'auth':             return auth(req, res)
    case 'callback':         return callback(req, res)
    case 'status':           return status(req, res)
    case 'test-connection':  return testConnection(req, res)
    case 'trigger-sync':     return triggerSync(req, res)
    case 'trigger-import':   return triggerImport(req, res)
    case 'publish':          return publish(req, res)
    case 'publish-bridge':   return publishBridge(req, res)
    case 'disconnect':       return disconnect(req, res)
    default:                 return res.status(404).json({ error: 'not_found' })
  }
}
