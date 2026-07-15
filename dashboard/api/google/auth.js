// Initiates Google OAuth flow for GBP connection
// GET /api/google/auth → redirects to Google consent screen

import { randomBytes } from 'crypto'
import { setCookie } from './_lib/cookies.js'

const STATE_COOKIE = 'gbp_oauth_state'

export default function handler(req, res) {
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
  // as the OAuth `state` param -- callback.js rejects the flow if the two
  // don't match on return, closing the login-CSRF gap this endpoint had.
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
