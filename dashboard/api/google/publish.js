// Posts a reply to a Google Business Profile review
// POST /api/google/publish  { reviewName?, locationName?, reviewerName?, replyText }
// Returns                   { success: true } or { error, message }
//
// Preferred path: pass `reviewName` (the Google API resource path, e.g.
// accounts/*/locations/*/reviews/*) directly -- set once a review has been
// linked via gbp_sync.py/gbp_import.py, this skips matching entirely.
// Fallback path: `locationName` + `reviewerName`, for older reviews the
// historical reconciliation hasn't linked yet -- fuzzy-matches by name
// (unavoidable without a persisted id for that review).

import { fetchWithRetry } from './_lib/http.js'

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
  const r = await fetchWithRetry(`https://mybusiness.googleapis.com/v4/${path}`, {
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
async function gbpGetAllPages(basePath, token, listKey, pageParam = 'pageSize', pageSize = 100) {
  let items = []
  let pageToken = null
  do {
    const sep = basePath.includes('?') ? '&' : '?'
    const path = `${basePath}${sep}${pageParam}=${pageSize}${pageToken ? `&pageToken=${pageToken}` : ''}`
    const data = await gbpGet(path, token)
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
  const replyRes = await fetchWithRetry(`https://mybusiness.googleapis.com/v4/${reviewName}/reply`, {
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

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
    const accounts = await gbpGetAllPages('accounts', token, 'accounts')
    if (!accounts.length) {
      return res.status(404).json({ error: 'location_mismatch', message: 'No GBP accounts found on this Google account.' })
    }

    let targetLocation = null
    for (const account of accounts) {
      const locations = await gbpGetAllPages(`${account.name}/locations`, token, 'locations').catch(() => [])
      targetLocation = locations.find(loc => locationMatches(loc.locationName, locationName))
      if (targetLocation) break
    }

    if (!targetLocation) {
      return res.status(404).json({
        error:   'location_mismatch',
        message: `Could not find "${locationName}" in your Google Business Profile. Make sure the location name matches exactly.`,
      })
    }

    const reviews = await gbpGetAllPages(`${targetLocation.name}/reviews`, token, 'reviews', 'pageSize', 50)
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
