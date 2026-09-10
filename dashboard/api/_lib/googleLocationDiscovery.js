// Multi-Tenant Phase 4I.2/4I.3 -- shared Google Business Profile location
// discovery. Every top-level route in this codebase imports shared logic
// only from _lib/, never from another top-level route file (Vercel treats
// each dashboard/api/**/*.js as its own serverless function; importing
// across routes has no precedent here and this file preserves that
// discipline rather than becoming the first exception to it, especially
// since bundling behavior for a cross-route import cannot be verified
// without an actual deploy). Both google/[action].js's OAuth callback
// (Phase 4I.2's reconnect reconciliation) and
// tenant-entitlements/[action].js (Phase 4I.3's platform-admin entitlement
// mutation) import from here.
//
// Deliberately self-contained -- does NOT import gbpGetAllPages/gbpGet
// from google/[action].js (heavily used there by other logic, e.g.
// publish()'s fuzzy-match fallback, not relevant here); a small, focused
// pagination-following GET, mirroring gbpGetAllPages's exact "follow
// nextPageToken to completion" behavior for the two endpoints this
// actually needs (accounts.list, locations.list).

import { fetchWithRetry } from '../google/_lib/http.js'

const ACCOUNTS_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1'
const LOCATIONS_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1'
const LOCATIONS_READ_MASK = 'name,title,storefrontAddress,metadata'

async function gbpGetAllPages(baseUrl, token, listKey) {
  let items = []
  let pageToken = null
  do {
    const sep = baseUrl.includes('?') ? '&' : '?'
    const url = `${baseUrl}${sep}pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`
    const r = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      throw Object.assign(new Error(e.error?.message || `GBP API ${r.status}`), { status: r.status })
    }
    const data = await r.json()
    items = items.concat(data[listKey] || [])
    pageToken = data.nextPageToken || null
  } while (pageToken)
  return items
}

// The Business Information API's location.name may or may not include the
// parent account segment (its canonical form is just "locations/{id}").
// The stable, permanent googleLocationId this codebase keys everything on
// (tenantConfigStore.js's locationIdMap) is always the full
// "accounts/{acct}/locations/{id}" path.
function v4LocationPath(accountName, locationApiName) {
  const tail = (locationApiName || '').split('locations/').pop()
  return `${accountName}/locations/${tail}`
}

// Returns full {googleLocationId, title, address} objects for every
// location `token` can see, across every account and every page (full
// pagination -- a missed page could otherwise cause a false "location not
// visible" failure, incorrectly rejecting a valid reconnect or a valid
// platform-admin addition). Used to reconcile a freshly-exchanged OAuth
// candidate credential against a COMMITTED tenant's existing
// approvedLocations, and to let a platform admin see/verify what a
// tenant's own currently-connected credential exposes before adding
// anything to its entitlement.
export async function discoverGoogleLocationsForReconciliation(token) {
  const accounts = await gbpGetAllPages(`${ACCOUNTS_BASE}/accounts`, token, 'accounts')
  const locations = []
  for (const acct of accounts) {
    const rawLocations = await gbpGetAllPages(
      `${LOCATIONS_BASE}/${acct.name}/locations?readMask=${encodeURIComponent(LOCATIONS_READ_MASK)}`,
      token, 'locations'
    )
    for (const loc of rawLocations) {
      locations.push({
        googleLocationId: v4LocationPath(acct.name, loc.name || ''),
        title: loc.title || '',
        address: loc.storefrontAddress
          ? [loc.storefrontAddress.addressLines, loc.storefrontAddress.locality, loc.storefrontAddress.administrativeArea].flat().filter(Boolean).join(', ')
          : '',
      })
    }
  }
  return locations
}

// Reconciliation (google/[action].js's callback()) only ever needs the id
// set, not the richer per-location metadata.
export async function discoverGoogleLocationIdsForReconciliation(token) {
  const locations = await discoverGoogleLocationsForReconciliation(token)
  return new Set(locations.map(l => l.googleLocationId))
}
