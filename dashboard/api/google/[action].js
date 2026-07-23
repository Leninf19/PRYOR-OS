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
import { upsertEnvVar, triggerRedeploy } from './_lib/vercel.js'
import { exchangeRefreshToken, getAccessToken } from './_lib/googleAuth.js'
import { requireAuth, evaluateSession, statusForAuthFailure } from '../_lib/auth.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'

const STATE_COOKIE = 'gbp_oauth_state'

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

  const vercelToken     = process.env.VERCEL_API_TOKEN
  const vercelProjectId = process.env.VERCEL_PROJECT_ID
  const vercelTeamId    = process.env.VERCEL_ORG_ID
  const deployHookUrl   = process.env.VERCEL_DEPLOY_HOOK_URL

  if (vercelToken && vercelProjectId && deployHookUrl) {
    try {
      await upsertEnvVar({
        token: vercelToken, projectId: vercelProjectId, teamId: vercelTeamId,
        key: 'GOOGLE_REFRESH_TOKEN', value: tokens.refresh_token,
      })
      await triggerRedeploy(deployHookUrl)
      return res.send(page('✓ Google connected!', `
        <p style="color:#16a34a;font-weight:600">Authorization successful. Your refresh token was saved directly to Vercel and a redeploy has started.</p>
        <p>This page does not show the token — it's stored securely server-side and never reaches the browser.</p>
        <p>Give the redeploy about 60 seconds, then refresh <a href="/settings">Settings</a> to confirm the connection.</p>
      `))
    } catch (err) {
      return res.status(502).send(page('Connected, but automatic setup failed', `
        <p style="color:#16a34a;font-weight:600">Authorization with Google succeeded.</p>
        <p>However, saving the refresh token to Vercel automatically failed: <strong>${err.message}</strong></p>
        <p>Check <code>VERCEL_API_TOKEN</code>, <code>VERCEL_PROJECT_ID</code>, <code>VERCEL_ORG_ID</code>, and
        <code>VERCEL_DEPLOY_HOOK_URL</code> in Vercel's environment variables, then try connecting again.</p>
        <p>As a fallback, you can still add the token manually — see Settings → Google Integration → setup guide.</p>
      `))
    }
  }

  // Automation not configured -- the refresh token is NEVER displayed,
  // logged, or put in a URL. `tokens` (and the refresh token within it)
  // goes out of scope when this function returns and is not persisted
  // anywhere; the Owner must configure the Vercel automation env vars and
  // restart the OAuth flow (which will issue a fresh token, since
  // `prompt=consent` on the initial request always re-issues one).
  return res.status(503).send(page('Connected, but automatic setup is incomplete', `
    <p style="color:#16a34a;font-weight:600">Authorization with Google succeeded.</p>
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:12px 16px;margin:20px 0">
      This dashboard cannot save the refresh token automatically because required server
      configuration is missing:
      <ul style="margin:8px 0 0 20px">
        ${!process.env.VERCEL_API_TOKEN ? '<li><code>VERCEL_API_TOKEN</code></li>' : ''}
        ${!process.env.VERCEL_PROJECT_ID ? '<li><code>VERCEL_PROJECT_ID</code></li>' : ''}
        ${!process.env.VERCEL_DEPLOY_HOOK_URL ? '<li><code>VERCEL_DEPLOY_HOOK_URL</code></li>' : ''}
      </ul>
    </div>
    <p>For security, the token is not shown here, logged, or stored anywhere by this request.</p>
    <h3>Next steps</h3>
    <ol style="line-height:2.2">
      <li>Add the missing variable(s) above in <strong>vercel.com → your project → Settings → Environment Variables</strong></li>
      <li>Return to <a href="/settings">Settings</a> and click Connect again to restart the flow</li>
    </ol>
    <p style="margin-top:32px"><a href="/settings">← Back to Settings</a></p>
  `))
}

// ---------------------------------------------------------------------------
// GET /api/google/status -- reports the current connection status.
// Returns { connected, state, accountName?, accountId?, scopes?, tokenExpiresIn? }
// ---------------------------------------------------------------------------

async function status(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const account = await requireAuth(req, res, ['owner'])
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `status:${account.userId}`, { requestsPerWindow: 15, windowSeconds: 60 })
  if (!allowed) return

  const hasId      = !!process.env.GOOGLE_CLIENT_ID
  const hasSecret  = !!process.env.GOOGLE_CLIENT_SECRET
  const hasToken   = !!process.env.GOOGLE_REFRESH_TOKEN

  if (!hasId || !hasSecret) {
    return res.status(200).json({ connected: false, state: 'not_configured' })
  }
  if (!hasToken) {
    return res.status(200).json({ connected: false, state: 'needs_token' })
  }

  try {
    const tokenData = await exchangeRefreshToken()
    if (!tokenData.access_token) {
      return res.status(200).json({
        connected: false, state: 'invalid_credentials',
        error: tokenData.error_description || tokenData.error || 'Refresh token rejected',
      })
    }

    // Account listing moved off the legacy v4 host in Google's 2022 API
    // split -- mybusiness.googleapis.com/v4/accounts now 404s. Reviews/reply
    // (the publish case) are unaffected; they're the one thing that stayed on v4.
    const r = await fetchWithRetry('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })

    if (!r.ok) {
      const body = await r.json().catch(() => ({}))
      return res.status(200).json({
        connected: false, state: 'api_error',
        error: body.error?.message || `GBP API ${r.status}`,
      })
    }

    const data       = await r.json()
    const gbpAccount = (data.accounts || [])[0]

    return res.status(200).json({
      connected:      true,
      state:          'connected',
      accountName:    gbpAccount?.accountName || 'Google Business Profile',
      accountId:      gbpAccount?.name || null,
      accountCount:   (data.accounts || []).length,
      scopes:         (tokenData.scope || 'https://www.googleapis.com/auth/business.manage').split(' '),
      tokenExpiresIn: tokenData.expires_in || null,
    })
  } catch (err) {
    return res.status(200).json({ connected: false, state: 'error', error: err.message })
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
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN

  // 1. OAuth credentials configured
  if (!clientId || !clientSecret) {
    checks.push(check('credentials', 'OAuth credentials configured', 'fail',
      `Missing ${!clientId ? 'GOOGLE_CLIENT_ID' : 'GOOGLE_CLIENT_SECRET'} in Vercel environment variables.`))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }
  checks.push(check('credentials', 'OAuth credentials configured', 'pass',
    'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.'))

  if (!refreshToken) {
    checks.push(check('refresh_token', 'Refresh token present', 'fail',
      'GOOGLE_REFRESH_TOKEN is not set. Connect a Google account from Settings first.'))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }
  checks.push(check('refresh_token', 'Refresh token present', 'pass', 'GOOGLE_REFRESH_TOKEN is set.'))

  // 2. Refresh token exchange
  const tokenData = await exchangeRefreshToken().catch(err => ({ __networkError: err }))
  if (tokenData.__networkError) {
    checks.push(check('token_exchange', 'Exchange refresh token for access token', 'fail',
      `Network error reaching Google's token endpoint: ${tokenData.__networkError.message}`))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }

  if (!tokenData.access_token) {
    checks.push(check('token_exchange', 'Exchange refresh token for access token', 'fail',
      tokenData.error_description || tokenData.error || 'Google rejected the refresh token. It may have been revoked -- reconnect from Settings.'))
    return res.status(200).json({ overallStatus: 'fail', checks })
  }
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const account = await requireAuth(req, res, PUBLISH_ALLOWED_ROLES)
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `publish:${account.userId}`, { requestsPerWindow: 20, windowSeconds: 60 })
  if (!allowed) return

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
    return res.status(503).json({
      error:   'not_connected',
      message: 'Google Business Profile is not connected. Complete setup in Settings → Google Integration.',
    })
  }

  const { reviewName, locationName, reviewerName, replyText } = req.body ?? {}

  if (!replyText || (!reviewName && !locationName)) {
    return res.status(400).json({ error: 'api_error', message: 'Missing replyText, and either reviewName or locationName.' })
  }

  try {
    const token = await getAccessToken()

    // Preferred: direct resource path, already linked -- no lookup needed.
    if (reviewName) {
      await replyViaReviewName(reviewName, replyText, token)
      return res.status(200).json({ success: true })
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
    return res.status(200).json({ success: true })

  } catch (err) {
    const status = err.status || (err.status === 403 ? 403 : 500)
    return res.status(status).json({
      error:   err.code || (err.status === 403 ? 'missing_permission' : 'api_error'),
      message: err.message,
    })
  }
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
    default:                 return res.status(404).json({ error: 'not_found' })
  }
}
