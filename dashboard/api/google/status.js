// Reports Google Business Profile connection status
// GET /api/google/status
// Returns { connected, state, accountName? }

async function getAccessToken() {
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
  return d.access_token || null
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

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
    const accessToken = await getAccessToken()
    if (!accessToken) {
      return res.status(200).json({ connected: false, state: 'invalid_credentials' })
    }

    const r = await fetch('https://mybusiness.googleapis.com/v4/accounts', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!r.ok) {
      return res.status(200).json({ connected: false, state: 'api_error', error: `GBP API ${r.status}` })
    }

    const data    = await r.json()
    const account = (data.accounts || [])[0]

    return res.status(200).json({
      connected:   true,
      state:       'connected',
      accountName: account?.accountName || 'Google Business Profile',
    })
  } catch (err) {
    return res.status(200).json({ connected: false, state: 'error', error: err.message })
  }
}
