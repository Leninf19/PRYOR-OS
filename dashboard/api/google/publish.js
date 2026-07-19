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
import { requireAuth } from '../_lib/auth.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'

// Location Manager is part of the permission model but is NOT included
// below yet: this endpoint's fallback path only has a client-supplied
// locationName string to go on, with no server-side way to resolve it to
// the review's actual location_id (see README "Location authorization
// strategy" gap). Enabling Location Manager here requires that resolution
// to exist first -- do not add 'location_manager' to this list until then.
const ALLOWED_ROLES = ['owner', 'marketing']

// Google split the old monolithic v4 "My Business API" into several
// purpose-built APIs in 2022. Only review read/reply stayed on the legacy
// v4 host -- account and location listing moved and 404 on the old v4
// paths, which is why these are three different hosts.
const GBP_BASE = 'https://mybusiness.googleapis.com/v4'
const ACCOUNTS_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1'
const LOCATIONS_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1'
const LOCATIONS_READ_MASK = 'name,title,storefrontAddress,metadata'

// The Business Information API's location.name may or may not include the
// parent account segment (its canonical form is just "locations/{id}").
// The legacy v4 reviews/reply endpoints require the full
// "accounts/{acct}/locations/{id}" path, so this rebuilds it from whatever
// segment Google actually returned, regardless of which form.
function v4LocationPath(accountName, locationApiName) {
  const tail = (locationApiName || '').split('locations/').pop()
  return `${accountName}/locations/${tail}`
}

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const account = await requireAuth(req, res, ALLOWED_ROLES)
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
    for (const account of accounts) {
      const rawLocations = await gbpGetAllPages(
        `${LOCATIONS_BASE}/${account.name}/locations?readMask=${encodeURIComponent(LOCATIONS_READ_MASK)}`,
        token, 'locations'
      ).catch(() => [])
      const locations = rawLocations.map(loc => ({
        ...loc,
        name: v4LocationPath(account.name, loc.name),
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
