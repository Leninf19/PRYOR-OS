// Handles Google OAuth callback — exchanges auth code for refresh token
// GET /api/google/callback?code=...

export default async function handler(req, res) {
  const { code, error } = req.query

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

  const tokens = await tokenRes.json()

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

  return res.send(page('✓ Google connected!', `
    <p style="color:#16a34a;font-weight:600">Authorization successful. One more step — add your refresh token to Vercel.</p>

    <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:12px 16px;margin:20px 0">
      ⚠️ Keep this token private — it gives access to your Google Business Profile.
    </div>

    <h3>Your Refresh Token</h3>
    <div style="background:#f5f5f4;border:1px solid #d6d3d1;border-radius:8px;padding:16px;word-break:break-all;font-family:monospace;font-size:13px;margin-bottom:24px">
      ${tokens.refresh_token}
    </div>

    <h3>Add it to Vercel (final step)</h3>
    <ol style="line-height:2.2">
      <li>Go to <strong>vercel.com → your project → Settings → Environment Variables</strong></li>
      <li>Add variable: Key = <code>GOOGLE_REFRESH_TOKEN</code> &nbsp;·&nbsp; Value = the token above</li>
      <li>Set scope to <strong>Production</strong> (and Preview if testing), then <strong>Save</strong></li>
      <li>Trigger a redeploy — go to Deployments → click the three dots → Redeploy</li>
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
