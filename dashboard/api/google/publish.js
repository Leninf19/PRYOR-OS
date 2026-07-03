// Posts a reply to a Google Business Profile review
// POST /api/google/publish  { locationName, reviewerName, replyText }
// Returns                   { success: true } or { error, message }

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
  if (!d.access_token) throw new Error(d.error_description || 'Could not get access token')
  return d.access_token
}

async function gbpGet(path, token) {
  const r = await fetch(`https://mybusiness.googleapis.com/v4/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) {
    const e = await r.json().catch(() => ({}))
    throw Object.assign(new Error(e.error?.message || `GBP API ${r.status}`), { status: r.status })
  }
  return r.json()
}

function normName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function locationMatches(gbpName, ourName) {
  const a = normName(gbpName)
  const b = normName(ourName)
  return a === b || a.includes(b) || b.includes(a)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
    return res.status(503).json({
      error:   'not_connected',
      message: 'Google Business Profile is not connected. Complete setup in Settings → Google Integration.',
    })
  }

  const { locationName, reviewerName, replyText } = req.body ?? {}

  if (!locationName || !replyText) {
    return res.status(400).json({ error: 'api_error', message: 'Missing locationName or replyText.' })
  }

  try {
    const token = await getAccessToken()

    // 1. List accounts
    const { accounts = [] } = await gbpGet('accounts', token)
    if (!accounts.length) {
      return res.status(404).json({ error: 'location_mismatch', message: 'No GBP accounts found on this Google account.' })
    }

    // 2. Find matching location across all accounts
    let targetLocation = null
    for (const account of accounts) {
      const { locations = [] } = await gbpGet(`${account.name}/locations?pageSize=100`, token).catch(() => ({ locations: [] }))
      targetLocation = locations.find(loc => locationMatches(loc.locationName, locationName))
      if (targetLocation) break
    }

    if (!targetLocation) {
      return res.status(404).json({
        error:   'location_mismatch',
        message: `Could not find "${locationName}" in your Google Business Profile. Make sure the location name matches exactly.`,
      })
    }

    // 3. List recent reviews for that location
    const { reviews = [] } = await gbpGet(`${targetLocation.name}/reviews?pageSize=50`, token)

    if (!reviews.length) {
      return res.status(404).json({ error: 'review_gone', message: 'No reviews found for this location on Google.' })
    }

    // 4. Find matching review by reviewer display name
    const review = reviews.find(rv =>
      normName(rv.reviewer?.displayName) === normName(reviewerName)
    )

    if (!review) {
      return res.status(404).json({
        error:   'review_gone',
        message: `Could not find a review from "${reviewerName}" in the 50 most recent reviews for this location. It may have been removed or is older than what the API returns.`,
      })
    }

    // 5. Post reply
    const replyRes = await fetch(`https://mybusiness.googleapis.com/v4/${review.name}/reply`, {
      method:  'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ comment: replyText }),
    })

    if (!replyRes.ok) {
      const e = await replyRes.json().catch(() => ({}))
      const msg = e.error?.message || `GBP replied with status ${replyRes.status}`
      if (replyRes.status === 403) {
        return res.status(403).json({ error: 'missing_permission', message: msg })
      }
      if (replyRes.status === 404) {
        return res.status(404).json({ error: 'review_gone', message: msg })
      }
      return res.status(502).json({ error: 'api_error', message: msg })
    }

    return res.status(200).json({ success: true })

  } catch (err) {
    const status = err.status === 403 ? 403 : 500
    return res.status(status).json({
      error:   err.status === 403 ? 'missing_permission' : 'api_error',
      message: err.message,
    })
  }
}
