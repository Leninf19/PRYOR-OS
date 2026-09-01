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
import { fileURLToPath } from 'url'
import { isWildcardGrant } from './auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = path.resolve(__dirname, '..', '..', 'private-data', '_internal', 'review-location-index.json')

let cache = null
let testOverride = null

// Test-only seam -- lets tests inject a fixed index without touching the
// real filesystem path, same pattern settings/[action].js's
// _setLegacyBackfillDataForTests uses.
export function _setReviewLocationIndexForTests(index) {
  testOverride = index
  cache = null
}
export function _resetReviewLocationIndexForTests() {
  testOverride = null
  cache = null
}

async function loadIndex() {
  if (testOverride !== null) return testOverride
  if (cache !== null) return cache
  try {
    const raw = await readFile(INDEX_PATH, 'utf-8')
    cache = JSON.parse(raw)
  } catch (err) {
    // Missing/corrupted index fails CLOSED -- an empty index resolves
    // every review to "unknown location", which requireScopedAuth() then
    // denies (never treats null/undefined as "company-wide", only an
    // explicit null return from resolveLocationId means that -- see
    // resolveLocationIdForReview below, which returns a locationId or
    // throws NotFoundLocationError, never null, for a review lookup).
    console.error(`[reviewLocationIndex] could not load ${INDEX_PATH}: ${err.message}`)
    cache = {}
  }
  return cache
}

// Returns the numeric locationId for a given localReviewId (the same
// review_id || review_url || `${review_date}-${reviewer_name}` identity
// dashboard/src/utils/dataUtils.js's reviewId() computes client-side), or
// null if the review is unknown -- callers must treat null as "cannot
// authorize this request", never as "company-wide"/"skip the check".
export async function resolveLocationIdForReview(localReviewId) {
  if (typeof localReviewId !== 'string' || !localReviewId) return null
  const index = await loadIndex()
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
// already ran inside requireScopedAuth() before this is called).
export async function resolveLocationIdForReviewOrDeny(localReviewId, account) {
  const locationId = await resolveLocationIdForReview(localReviewId)
  if (locationId !== null) return locationId
  return isWildcardGrant(account) ? null : UNRESOLVABLE_LOCATION_SENTINEL
}
