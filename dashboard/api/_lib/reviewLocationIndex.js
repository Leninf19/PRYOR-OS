// SERVER-ONLY review -> canonical numeric locationId resolution -- Multi-
// Location Authentication & User Access System, Commit 4. Reads the private
// index export_chunks.py's export_review_location_index() writes to
// dashboard/private-data/_internal/review-location-index.json, following
// the exact same fs.readFile-at-request-time pattern dashboard/api/data.js
// itself uses (see that file's own "Vercel bundling note").
//
// THIS FILE MUST NEVER BE IMPORTED BY dashboard/api/data.js, and this
// file's target path must never be added to data.js's EXACT_ALLOWLIST or
// DYNAMIC_ALLOWLIST -- it exists specifically so a per-review authorization
// decision can be made server-side without the frontend (or a request body)
// ever being trusted to say which location a review belongs to. Guarded by
// tests/test_authorization_matrix.js's dedicated assertion.
//
// Callers: dashboard/api/google/[action].js (publish, publish-bridge),
// dashboard/api/actions/[action].js (all review-scoped actions),
// dashboard/api/rewrite.js -- each passes resolveLocationIdForReview as the
// resolveLocationId callback to requireScopedAuth() (dashboard/api/_lib/
// auth.js). Every caller must ALSO have this file's target path in its own
// dashboard/vercel.json `includeFiles` entry, or the file won't exist in
// that function's deployment bundle -- see vercel.json.
//
// Cached in-module after first read per warm serverless instance (this
// file is regenerated only by the export pipeline, i.e. at most every few
// minutes -- re-reading it on every single request would be pure waste on
// a warm Lambda). A cold start or a fresh deploy always re-reads.

import { readFile } from 'fs/promises'
import path from 'path'
import { isWildcardGrant } from './auth.js'
import { resolveTenantId } from './tenants.js'
import { resolvePrivateDataRoot } from './reviewDataPaths.js'

// Multi-Tenant Phase 4D: the index path and its cache are now PER TENANT --
// before this fix, both were single, shared, module-level values, meaning
// every caller (regardless of which tenant was actually authenticated)
// resolved review->location lookups against Los Tres Amigos's own index
// file, and a Tenant B lookup would have been served from a cache
// populated by Tenant A's data. Keyed by tenantId so one tenant's
// authorization decisions can never be computed from another tenant's
// index.
const cacheByTenant = new Map()
let testOverride = null

function indexPathFor(tenantId) {
  return path.join(resolvePrivateDataRoot(tenantId), '_internal', 'review-location-index.json')
}

// Test-only seam -- lets tests inject a fixed index without touching the
// real filesystem path, same pattern settings/[action].js's
// _setLegacyBackfillDataForTests uses.
export function _setReviewLocationIndexForTests(index) {
  testOverride = index
  cacheByTenant.clear()
}
export function _resetReviewLocationIndexForTests() {
  testOverride = null
  cacheByTenant.clear()
}

async function loadIndex(tenantId) {
  if (testOverride !== null) return testOverride
  if (cacheByTenant.has(tenantId)) return cacheByTenant.get(tenantId)
  let index
  try {
    const indexPath = indexPathFor(tenantId)
    const raw = await readFile(indexPath, 'utf-8')
    index = JSON.parse(raw)
  } catch (err) {
    // Missing/corrupted index (including an UnknownTenantError from an
    // unregistered tenant) fails CLOSED -- an empty index resolves every
    // review to "unknown location", which requireScopedAuth() then denies
    // (never treats null/undefined as "company-wide", only an explicit
    // null return from resolveLocationId means that -- see
    // resolveLocationIdForReview below, which returns a locationId or
    // throws NotFoundLocationError, never null, for a review lookup).
    console.error(`[reviewLocationIndex] could not load the review-location index for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
    index = {}
  }
  cacheByTenant.set(tenantId, index)
  return index
}

// Returns the numeric locationId for a given localReviewId (the same
// review_id || review_url || `${review_date}-${reviewer_name}` identity
// dashboard/src/utils/dataUtils.js's reviewId() computes client-side), or
// null if the review is unknown -- callers must treat null as "cannot
// authorize this request", never as "company-wide"/"skip the check".
// tenantId is REQUIRED -- there is no default, and it determines which
// tenant's own index this lookup can possibly see.
export async function resolveLocationIdForReview(localReviewId, tenantId) {
  if (typeof localReviewId !== 'string' || !localReviewId) return null
  const index = await loadIndex(tenantId)
  const locationId = index[localReviewId]
  return typeof locationId === 'number' ? locationId : null
}

// A locationId no real location will ever have (locations.id is a positive
// autoincrement integer) -- used as an explicit "resolution failed, deny a
// scoped account" signal, distinct from requireScopedAuth()'s own
// `resolveLocationId` contract where a `null` return means "not location-
// scoped, always allow". That contract is exactly right for genuinely
// company-wide endpoints, but wrong here: a request this module can't
// resolve to a real location must still be DENIED for a location-scoped
// caller (never silently treated as company-wide), while a company-wide
// caller (locationIds === '*') must still be able to use the existing
// no-localReviewId fallback path unchanged. See
// resolveLocationIdForReviewOrDeny() below, the callback every Commit 4
// endpoint actually passes to requireScopedAuth().
const UNRESOLVABLE_LOCATION_SENTINEL = -1

// The resolveLocationId callback for requireScopedAuth() used by
// google/[action].js (publish, publish-bridge), actions/[action].js, and
// rewrite.js. `account` is the already-authenticated caller (requireAuth()
// already ran inside requireScopedAuth() before this is called) --
// tenantId is derived EXCLUSIVELY from this server-side account via
// resolveTenantId(), never from any request input, so a caller can never
// smuggle a different tenant's id through the request to redirect this
// lookup at another tenant's index.
export async function resolveLocationIdForReviewOrDeny(localReviewId, account) {
  const tenantId = resolveTenantId(account)
  const locationId = await resolveLocationIdForReview(localReviewId, tenantId)
  if (locationId !== null) return locationId
  return isWildcardGrant(account) ? null : UNRESOLVABLE_LOCATION_SENTINEL
}
