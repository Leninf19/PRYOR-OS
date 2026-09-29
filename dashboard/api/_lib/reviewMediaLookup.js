// SERVER-ONLY -- Review Media View/Download feature. Resolves a review's
// own sanitized `media` array (export_chunks.py's review_to_dict(), the
// same shape ReviewMediaGallery.jsx already renders from r.media) from
// this tenant's own private-data export, given only the review's stable
// id (dataUtils.js's reviewId() identity space) and the CALLER'S OWN
// server-derived tenantId -- never a client-supplied one, never a
// client-supplied URL. This is the ONE place dashboard/api/actions/[action].js's download-media action
// gets a media item's real thumbnailUrl/videoUrl from, so the download
// endpoint can resolve the URL itself instead of ever trusting one from
// the request.
//
// Follows the exact same fs-read/cache/lookup shape reviewAssignmentProgress.js
// already established (loadMeta -> resolve slug for a locationId ->
// reviews/by-location/{slug}.json -> find the one review by reviewId()) --
// deliberately duplicated here rather than importing that module's private
// loadMeta/loadReviewsForLocation helpers (they are not exported, and this
// is a distinct concern -- media lookup, not task-assignment progress).
// Same small, explicit-duplication tradeoff dataUtils.js's BRANDS/db.py's
// BRANDS and actions/[action].js's VALID_STATUSES already make in this
// codebase.
//
// tenantId is REQUIRED on every call, always derived by the caller via
// resolveTenantId(account) from an already-authenticated account -- never
// from req.query/req.body. A review id that does not resolve within THIS
// tenant's own review-location index (a foreign tenant's review, or one
// that plain doesn't exist) returns null here, which is exactly what
// happens for a cross-tenant lookup attempt: resolveLocationIdForReview()
// only ever reads THIS tenant's own index (reviewLocationIndex.js), so a
// Tenant B review id is simply unresolvable for a Tenant A tenantId, full
// stop -- there is no path here that can ever read another tenant's file.

import { resolveLocationIdForReview } from './reviewLocationIndex.js'
import { readPrivateDataFile } from './reviewDataPaths.js'

const metaCacheByTenant = new Map()
let testOverrides = null

// Test-only seam, same pattern as reviewAssignmentProgress.js's own
// _setReviewAssignmentTestData. reviewsByLocationId is keyed by the
// NUMERIC locationId (matching reviewAssignmentProgress.js's own
// convention), not by slug.
export function _setReviewMediaLookupTestData({ meta, reviewsByLocationId } = {}) {
  testOverrides = { meta, reviewsByLocationId }
  metaCacheByTenant.clear()
}
export function _resetReviewMediaLookupTestData() {
  testOverrides = null
  metaCacheByTenant.clear()
}

async function loadMeta(tenantId) {
  if (testOverrides) return testOverrides.meta
  if (metaCacheByTenant.has(tenantId)) return metaCacheByTenant.get(tenantId)
  let meta
  try {
    const raw = await readPrivateDataFile(tenantId, 'meta.json')
    meta = JSON.parse(raw)
  } catch (err) {
    console.error(`[reviewMediaLookup] could not load meta.json for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
    meta = { locations: [] }
  }
  metaCacheByTenant.set(tenantId, meta)
  return meta
}

async function loadReviewsForLocation(tenantId, locationId, slug) {
  if (testOverrides) return testOverrides.reviewsByLocationId?.[locationId] ?? []
  try {
    const raw = await readPrivateDataFile(tenantId, `reviews/by-location/${slug}.json`)
    return JSON.parse(raw)
  } catch {
    return []
  }
}

// The exact same stable-id fallback chain dataUtils.js's reviewId() (client)
// and reviewAssignmentProgress.js's own local reviewId() (server) both use.
function reviewId(r) {
  return r.review_id || r.review_url || `${r.review_date}-${r.reviewer_name}`
}

// Returns { locationId, media } for the first review matching reviewIdParam
// within THIS tenant's own data, or null if it cannot be found (unknown
// review id, a review whose location has no resolvable slug, or a review
// id belonging to a different tenant entirely). `media` is always an array
// (never undefined/null) -- a review with no media exposes an empty array,
// exactly like export_chunks.py's own review_to_dict() never omits the key.
export async function findReviewMedia(reviewIdParam, tenantId) {
  const locationId = await resolveLocationIdForReview(reviewIdParam, tenantId)
  if (locationId == null) return null

  const meta = await loadMeta(tenantId)
  const loc = (meta.locations ?? []).find(l => l.locationId === locationId)
  if (!loc?.slug) return null

  const reviews = await loadReviewsForLocation(tenantId, locationId, loc.slug)
  const review = Array.isArray(reviews) ? reviews.find(r => reviewId(r) === reviewIdParam) : undefined
  if (!review) return null

  return {
    locationId,
    media: Array.isArray(review.media) ? review.media : [],
  }
}
