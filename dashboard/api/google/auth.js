// Initiates Google OAuth flow for GBP connection
// GET /api/google/auth → redirects to Google consent screen

import { randomBytes } from 'crypto'
import { setCookie } from './_lib/cookies.js'
import { evaluateSession } from '../_lib/auth.js'

const STATE_COOKIE = 'gbp_oauth_state'

// Starting the OAuth flow can overwrite the org's only stored Google
// refresh token -- previously reachable by anyone who hit this URL
// directly (a "confused deputy" risk: the browser's own session cookie
// survives the whole /api/google/auth -> Google -> /api/google/callback
// round trip since it's same-origin navigation the whole way, so gating
// here and re-checking in callback.js is both possible and necessary).
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed')

  const { account } = await evaluateSession(req, ['owner'])
  if (!account) {
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
