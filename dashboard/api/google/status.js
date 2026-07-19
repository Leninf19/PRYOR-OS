// Reports Google Business Profile connection status
// GET /api/google/status
// Returns { connected, state, accountName?, accountId?, scopes?, tokenExpiresIn? }

import { fetchWithRetry } from './_lib/http.js'
import { requireAuth } from '../_lib/auth.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'

async function exchangeRefreshToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  })
  const d = await r.json()
  return d
}

export default async function handler(req, res) {
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
    // (publish.js) are unaffected; they're the one thing that stayed on v4.
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

    const data    = await r.json()
    const account = (data.accounts || [])[0]

    return res.status(200).json({
      connected:      true,
      state:          'connected',
      accountName:    account?.accountName || 'Google Business Profile',
      accountId:      account?.name || null,
      accountCount:   (data.accounts || []).length,
      scopes:         (tokenData.scope || 'https://www.googleapis.com/auth/business.manage').split(' '),
      tokenExpiresIn: tokenData.expires_in || null,
    })
  } catch (err) {
    return res.status(200).json({ connected: false, state: 'error', error: err.message })
  }
}
