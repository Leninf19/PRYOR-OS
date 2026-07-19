// Handles Google OAuth callback — verifies the CSRF state, exchanges the
// auth code for a refresh token, then writes it directly to Vercel (never
// displayed in the browser) and triggers a redeploy so it takes effect
// automatically. Falls back to the old manual-copy flow if the Vercel-side
// automation isn't configured yet, so a partial setup doesn't get stuck.
// GET /api/google/callback?code=...&state=...

import { parseCookies, clearCookie } from './_lib/cookies.js'
import { upsertEnvVar, triggerRedeploy } from './_lib/vercel.js'
import { evaluateSession } from '../_lib/auth.js'

const STATE_COOKIE = 'gbp_oauth_state'

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed')

  // Defense in depth: auth.js already required an Owner session before
  // redirecting here, but this endpoint is independently authoritative and
  // never assumes that check already ran (the CSRF state check below is a
  // separate concern -- it proves this callback belongs to a flow *this
  // browser* started, not that the caller is still an authorized Owner).
  const { account } = await evaluateSession(req, ['owner'])
  if (!account) {
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
