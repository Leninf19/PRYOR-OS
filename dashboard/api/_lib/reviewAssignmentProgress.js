// Operations Calendar + Content Library milestone -- best-effort, READ-ONLY
// completion tracking for review_assignment tasks ("3 / 8 completed").
// Deliberately does not touch Reviews' publish/draft/reply-state logic at
// all: it reads the same private per-location review export files
// dashboard/api/data.js already serves (reviews/by-location/{slug}.json)
// and checks each assigned review's own `owner_response` field -- the same
// signal SentimentBreakdown/getSentiment() and the rest of this app already
// treat as "this review has been replied to". No new write path, no new
// Reviews dependency, nothing that could destabilize the reply/publish
// pipeline -- exactly the "as much as can be done safely" scope the
// architecture plan calls for.
//
// Same fs.readFile-at-request-time pattern reviewLocationIndex.js/data.js
// already use, cached in-module per warm serverless instance.

import { readFile } from 'fs/promises'
import path from 'path'
import { resolveLocationIdForReview } from './reviewLocationIndex.js'
import { resolvePrivateDataRoot } from './reviewDataPaths.js'

// Multi-Tenant Phase 4D: metaCache is now keyed per tenantId -- before this
// fix it was a single, shared module-level value, meaning a Tenant B
// caller could have been served Tenant A's meta.json/review chunks from a
// warm cache Tenant A's own request had already populated.
const metaCacheByTenant = new Map()
let testOverrides = null

export function _setReviewAssignmentTestData({ meta, reviewsByLocationId } = {}) {
  testOverrides = { meta, reviewsByLocationId }
  metaCacheByTenant.clear()
}
export function _resetReviewAssignmentTestData() {
  testOverrides = null
  metaCacheByTenant.clear()
}

async function loadMeta(tenantId) {
  if (testOverrides) return testOverrides.meta
  if (metaCacheByTenant.has(tenantId)) return metaCacheByTenant.get(tenantId)
  let meta
  try {
    const root = resolvePrivateDataRoot(tenantId)
    const raw = await readFile(path.join(root, 'meta.json'), 'utf-8')
    meta = JSON.parse(raw)
  } catch (err) {
    console.error(`[reviewAssignmentProgress] could not load meta.json for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
    meta = { locations: [] }
  }
  metaCacheByTenant.set(tenantId, meta)
  return meta
}

async function loadReviewsForLocation(tenantId, locationId, slug) {
  if (testOverrides) return testOverrides.reviewsByLocationId?.[locationId] ?? []
  try {
    const root = resolvePrivateDataRoot(tenantId)
    const raw = await readFile(path.join(root, 'reviews', 'by-location', `${slug}.json`), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

function reviewId(r) {
  return r.review_id || r.review_url || `${r.review_date}-${r.reviewer_name}`
}

// Returns { total, completed } for a task's relatedReviewIds, or null if
// the task has none (not a review_assignment task, or one with no reviews
// attached yet). `completed` counts reviews with a non-empty owner_response.
// Fails toward "unknown" (null) rather than a misleading 0/0 if the
// underlying data can't be read -- a caller should render "—" not "0 of 0".
// tenantId is REQUIRED -- there is no default, and it determines which
// tenant's own meta.json/review chunks this lookup can possibly see.
export async function computeReviewAssignmentProgress(relatedReviewIds, tenantId) {
  if (!Array.isArray(relatedReviewIds) || relatedReviewIds.length === 0) return null

  const meta = await loadMeta(tenantId)
  const slugByLocationId = {}
  for (const loc of meta.locations ?? []) slugByLocationId[loc.locationId] = loc.slug

  const reviewsByLocationId = {}
  let completed = 0
  for (const id of relatedReviewIds) {
    const locationId = await resolveLocationIdForReview(id, tenantId)
    if (locationId == null) continue
    if (!(locationId in reviewsByLocationId)) {
      const slug = slugByLocationId[locationId]
      reviewsByLocationId[locationId] = slug ? await loadReviewsForLocation(tenantId, locationId, slug) : []
    }
    const review = reviewsByLocationId[locationId].find(r => reviewId(r) === id)
    if (review && String(review.owner_response ?? '').trim()) completed++
  }

  return { total: relatedReviewIds.length, completed }
}
