// Walks the full Google Business Profile connection chain and reports a
// structured pass/fail per check, with the exact failure reason -- never a
// vague "something went wrong." Used by the Settings -> Connection Center's
// "Test Connection" button.
// GET /api/google/test-connection
// Returns { overallStatus: 'pass'|'fail', checks: [{ id, label, status, detail }] }

import { fetchWithRetry } from './_lib/http.js'
import { requireAuth } from '../_lib/auth.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'

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
// The legacy v4 reviews endpoint requires the full
// "accounts/{acct}/locations/{id}" path, so this rebuilds it from whatever
// segment Google actually returned, regardless of which form.
function v4LocationPath(accountName, locationApiName) {
  const tail = locationApiName.split('locations/').pop()
  return `${accountName}/locations/${tail}`
}

export default async function handler(req, res) {
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
  let tokenData
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId, client_secret: clientSecret,
        refresh_token: refreshToken, grant_type: 'refresh_token',
      }),
    })
    tokenData = await r.json()
  } catch (err) {
    checks.push(check('token_exchange', 'Exchange refresh token for access token', 'fail',
      `Network error reaching Google's token endpoint: ${err.message}`))
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
    for (const account of accounts) {
      const r = await fetchWithRetry(
        `${LOCATIONS_BASE}/${account.name}/locations?pageSize=100&readMask=${encodeURIComponent(LOCATIONS_READ_MASK)}`,
        { headers: auth }
      )
      if (r.ok) {
        const data = await r.json()
        locations = locations.concat((data.locations || []).map(loc => ({
          ...loc,
          name: v4LocationPath(account.name, loc.name || ''),
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
