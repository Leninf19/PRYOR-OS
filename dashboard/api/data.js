// Authenticated read access to dashboard/private-data/ -- the JSON chunks
// export_chunks.py writes (reviews, analytics, AI intelligence, etc), moved
// out of dashboard/public/ specifically so they are no longer reachable by
// direct URL. GET /api/data?file=<same relative path the file used to have
// under public/data/>, e.g. /api/data?file=meta.json,
// /api/data?file=reviews/by-location/x.json.
//
// This was originally a dynamic catch-all route (api/data/[...path].js,
// matching /api/data/<path>). That was replaced after a production
// investigation confirmed a platform-level bug: when dashboard/middleware.js
// (Edge Middleware) calls next() to continue a request to a dynamic
// catch-all API route, Vercel only successfully re-routes to the function
// when exactly ONE path segment remains after /api/data/ -- two or more
// segments got a platform NOT_FOUND before the function was ever invoked,
// and even in the one-segment case that DID reach the function,
// req.query.path was consistently undefined (confirmed via temporary
// request-tracing instrumentation, since removed). Both symptoms trace to
// the same root cause: Edge Middleware + a dynamic catch-all route do not
// compose reliably through next() on this platform. A single static
// endpoint reading the target file from an ordinary query string parameter
// sidesteps dynamic-route matching entirely -- req.query.file is populated
// by plain query-string parsing, a completely different, unaffected code
// path.
//
// SAFETY MODEL (read this before changing the allowlist below):
//   A file-serving endpoint that accepts a caller-supplied relative path is
//   one bad check away from being a general file-download endpoint. This
//   handler does NOT trust path.join() plus a startsWith() check as its
//   only defense -- the primary defense is a positive allowlist of exact
//   filenames and directory+slug patterns matching exactly what
//   export_chunks.py actually produces. A request for anything not on this
//   list is rejected before the filesystem is ever touched, regardless of
//   how it's encoded. The resolve()+prefix check below is a second,
//   independent layer, not the only one.
//
// Vercel bundling note: this function does `fs.readFile` against a path
// built at request time, which Vercel's static dependency tracer cannot
// discover by analyzing the source -- dashboard/vercel.json's
// `functions["api/data.js"].includeFiles` glob is what actually gets
// dashboard/private-data/** included in this function's deployment bundle.
// Do not assume runtime fs access "just works" without that entry.

import { requireAuth, requireLocationAccess, isWildcardGrant } from './_lib/auth.js'
import { resolveTenantId } from './_lib/tenants.js'
import { readPrivateDataFile, UnknownTenantError } from './_lib/reviewDataPaths.js'

// Every static file export_chunks.py writes (see its main()/export_* calls).
const EXACT_ALLOWLIST = new Set([
  'meta.json',
  'action-items.json',
  'validation.json',
  'scraper-status.json',
  'gbp-sync.json',
  'provider-health.json',
  'analytics/kpis.json',
  'analytics/monthly-trend.json',
  'analytics/location-stats.json',
  'analytics/rankings-30d.json',
  'insights/all.json',
  'reports/weekly-summary.json',
  'intelligence/company-summary.json',
  'intelligence/complaint-intelligence.json',
  'intelligence/department-performance.json',
  'intelligence/cx-index.json',
  'intelligence/best-quotes.json',
  'intelligence/seasonal-trends.json',
  'intelligence/executive-scores.json',
  'intelligence/action-center.json',
  'intelligence/operations-impact.json',
  'intelligence/predictive-alerts.json',
  'intelligence/competitive-intelligence.json',
  'intelligence/response-drafts.json',
])

// Per-location dynamic files -- slug must be exactly what slugify() in
// export_chunks.py produces: lowercase, digits, hyphens only, no leading/
// trailing hyphen, one path segment (no nested slashes possible).
const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*'
const DYNAMIC_ALLOWLIST = [
  new RegExp(`^insights/${SLUG}\\.json$`),
  new RegExp(`^reviews/by-location/${SLUG}\\.json$`),
  new RegExp(`^intelligence/locations/${SLUG}\\.json$`),
]

function isAllowed(relPath) {
  if (EXACT_ALLOWLIST.has(relPath)) return true
  return DYNAMIC_ALLOWLIST.some(re => re.test(relPath))
}

// --- Multi-Location Authentication & User Access System, Commit 4 --------
// Per-file location authorization for a scoped (locationIds !== '*')
// account. Three outcomes: 'meta' (meta.json itself -- read, then FILTERED
// after parsing, never blocked outright), 'per-location' (one of the 3
// DYNAMIC_ALLOWLIST patterns -- checked against the account's grant via the
// slug's resolved locationId), 'company-wide' (every other EXACT_ALLOWLIST
// file -- permanently blocked for a scoped account, per DATA_FILE_REGISTRY;
// see tests/test_authorization_matrix.js Section 7).
function categorizeRelPath(relPath) {
  if (relPath === 'meta.json') return 'meta'
  if (DYNAMIC_ALLOWLIST.some(re => re.test(relPath))) return 'per-location'
  return 'company-wide'
}

// slug is always the LAST path segment minus '.json' for all 3 dynamic
// patterns (insights/{slug}.json, reviews/by-location/{slug}.json,
// intelligence/locations/{slug}.json) -- no pattern nests a slug elsewhere.
function extractSlugFromRelPath(relPath) {
  const segments = relPath.split('/')
  const last = segments[segments.length - 1]
  return last.replace(/\.json$/, '')
}

// Multi-Tenant Phase 4D: keyed per tenantId -- before this fix this was a
// single, shared module-level cache, meaning a Tenant B caller could have
// been served Tenant A's meta.json locations from a warm cache Tenant A's
// own earlier request had already populated.
//
// Multi-Tenant Google Integration Architecture Fix: this cache previously
// had NO expiry at all -- once a warm instance read a tenant's meta.json
// once, it served that SAME locations list forever, for the lifetime of
// the instance, regardless of how many real approve-locations/provisioning/
// sync events happened afterward. Because Vercel keeps multiple warm
// instances alive concurrently and routes requests to whichever is free,
// two different requests for the SAME tenant (e.g. two different PRYOR
// users, or the same user reloading the page) could land on instances that
// cached this list at genuinely different points in that tenant's history
// -- one instance warmed before a location was approved/synced, another
// warmed after -- producing exactly the "same organization, different
// linked-location count depending on who's asking" symptom this fix
// addresses. A short TTL bounds how long such a split can persist without
// requiring per-write cache invalidation plumbing into every place that
// can change a tenant's location catalog.
const META_LOCATIONS_CACHE_TTL_MS = 60 * 1000
const metaLocationsCacheByTenant = new Map() // tenantId -> { locations, cachedAtMs }
let metaLocationsTestOverride = null

// Test-only seam, same pattern as reviewLocationIndex.js's own
// _setReviewLocationIndexForTests.
export function _setMetaLocationsForTests(locations) {
  metaLocationsTestOverride = locations
  metaLocationsCacheByTenant.clear()
}
export function _resetMetaLocationsForTests() {
  metaLocationsTestOverride = null
  metaLocationsCacheByTenant.clear()
}

// Returns meta.json's `locations` array (cached per warm instance, per
// tenant, for at most META_LOCATIONS_CACHE_TTL_MS -- see the cache's own
// header comment for why an unbounded cache was unsafe). Used both to
// resolve a requested slug's locationId (per-location files) and to filter
// the locations list itself (meta.json requests). Reads directly off disk,
// independent of isAllowed()/EXACT_ALLOWLIST -- meta.json is always
// allowlisted for every role, so this never bypasses anything the
// allowlist itself wouldn't already permit.
async function loadMetaLocations(tenantId) {
  if (metaLocationsTestOverride !== null) return metaLocationsTestOverride
  const cached = metaLocationsCacheByTenant.get(tenantId)
  if (cached && Date.now() - cached.cachedAtMs < META_LOCATIONS_CACHE_TTL_MS) return cached.locations
  let locations
  try {
    const raw = await readPrivateDataFile(tenantId, 'meta.json')
    locations = JSON.parse(raw).locations ?? []
  } catch (err) {
    console.error(`[api/data] could not load meta.json for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
    locations = []
  }
  metaLocationsCacheByTenant.set(tenantId, { locations, cachedAtMs: Date.now() })
  return locations
}

async function resolveLocationIdForSlug(tenantId, slug) {
  const locations = await loadMetaLocations(tenantId)
  const match = locations.find(l => l.slug === slug)
  return match ? match.locationId : null
}

// req.query.file is a single, already-decoded string (ordinary query-string
// parsing, not dynamic-route segment extraction). Still validated
// defensively here rather than trusted: split on '/' and reject anything
// where any segment isn't a plain [a-zA-Z0-9._-]+, which alone rules out
// '..', '.', empty segments, encoded slashes, backslashes, and null bytes --
// an allowlisted rejoined string can only ever describe one of the
// known-good shapes above, regardless of how the request tried to spell it.
function buildRequestedRelPath(fileParam) {
  if (typeof fileParam !== 'string' || fileParam.length === 0) return null
  const segments = fileParam.split('/')
  for (const seg of segments) {
    if (seg.length === 0) return null
    if (seg.includes('\0') || seg.includes('\\')) return null
    if (!/^[a-zA-Z0-9._-]+$/.test(seg)) return null
    if (seg === '.' || seg === '..') return null
  }
  return segments.join('/')
}

// TEMPORARY DIAGNOSTIC ("Add one temporary branch-level diagnostic to
// dashboard/api/data.js" investigation) -- restricted to a small, known
// target set so this never becomes an unbounded per-request log. Covers the
// 4 specific files this investigation is chasing plus one DYNAMIC_ALLOWLIST
// shape (reviews/by-location/<slug>.json) as a known-working control for
// correlation. Server-side console.error only (Vercel Runtime Logs), never
// returned in any HTTP response. Logs only tenantId/relPath/role/booleans/
// category/branch name -- never email, userId, cookies, session contents,
// authorization headers, tokens, credentials, env vars, or file contents.
// Remove once this investigation concludes.
const DIAG_TARGET_RELPATHS = new Set([
  'meta.json',
  'analytics/location-stats.json',
  'intelligence/action-center.json',
  'intelligence/complaint-intelligence.json',
])

function isDiagTarget(relPath) {
  return typeof relPath === 'string' && (
    DIAG_TARGET_RELPATHS.has(relPath) || /^reviews\/by-location\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(relPath)
  )
}

function logApiDataDiag(fields) {
  console.error(`[api-data-diag] ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')}`)
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  // Never let a cached authenticated payload leak to the CDN or a shared
  // browser cache -- this is per-account operational data now, not a
  // static asset.
  res.setHeader('Cache-Control', 'private, no-store')

  // Any authenticated role may reach this far -- Commit 4 removed the flat
  // owner/marketing role gate. The real decision below is per-file and
  // per-location, driven by categorizeRelPath()/account.locationIds.
  const account = await requireAuth(req, res, null)
  if (!account) return

  // Multi-Tenant Phase 4D/4F.1: tenantId is derived EXCLUSIVELY from the
  // authenticated, server-side account -- never from req.query/req.body/
  // any header. The file is then read through the server-controlled
  // resolver (reviewDataPaths.js's readPrivateDataFile(), which branches on
  // storage mode internally), never a path/key built from caller input. A
  // tenant with no registered/operational private-data storage fails
  // closed with 404 here, before any read is attempted -- it can never
  // fall through to another tenant's (e.g. Los Tres Amigos's) data.
  const tenantId = resolveTenantId(account)

  const relPath = buildRequestedRelPath(req.query.file)
  const diagTarget = isDiagTarget(relPath)
  const wildcard = isWildcardGrant(account)
  if (!relPath || !isAllowed(relPath)) {
    if (diagTarget) {
      logApiDataDiag({ tenantId, relPath, accountRole: account.role, isWildcardGrant: wildcard, allowed: false, category: 'n/a', branch: 'INVALID_OR_NOT_ALLOWLISTED' })
    }
    return res.status(404).json({ error: 'not_found' })
  }

  let requestedLocationId = null // only meaningful for the 'per-location' category
  const category = categorizeRelPath(relPath)
  if (!isWildcardGrant(account)) {
    if (category === 'company-wide') {
      if (diagTarget) {
        logApiDataDiag({ tenantId, relPath, accountRole: account.role, isWildcardGrant: wildcard, allowed: true, category, branch: 'COMPANY_WIDE_FORBIDDEN' })
      }
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to view company-wide data.' })
    }
    if (category === 'per-location') {
      const slug = extractSlugFromRelPath(relPath)
      requestedLocationId = await resolveLocationIdForSlug(tenantId, slug)
      if (requestedLocationId === null) {
        if (diagTarget) {
          logApiDataDiag({ tenantId, relPath, accountRole: account.role, isWildcardGrant: wildcard, allowed: true, category, branch: 'LOCATION_SLUG_NOT_RESOLVED' })
        }
        return res.status(404).json({ error: 'not_found' })
      }
      if (!requireLocationAccess(account, requestedLocationId)) {
        // Existence-hiding, matching the frozen §6 error contract every
        // other location-scope check in this codebase uses -- never 403
        // for an out-of-scope location.
        if (diagTarget) {
          logApiDataDiag({ tenantId, relPath, accountRole: account.role, isWildcardGrant: wildcard, allowed: true, category, branch: 'LOCATION_ACCESS_DENIED' })
        }
        return res.status(404).json({ error: 'not_found' })
      }
    }
    // category === 'meta' falls through -- read + filtered after parsing.
  }

  if (diagTarget) {
    logApiDataDiag({ tenantId, relPath, accountRole: account.role, isWildcardGrant: wildcard, allowed: true, category, branch: 'ENTERING_PRIVATE_DATA_READ' })
  }

  let raw
  try {
    raw = await readPrivateDataFile(tenantId, relPath)
  } catch (err) {
    if (err instanceof UnknownTenantError || err.code === 'ENOENT') {
      // Legitimate empty state for files that only exist once a given
      // pipeline stage has run at least once (e.g. gbp-sync.json before
      // the first API sync), a genuinely missing bundled/uploaded artifact,
      // or an unknown/unprovisioned tenant -- callers already treat 404 as
      // "not yet generated", not a hard error, and the response never
      // distinguishes the causes.
      return res.status(404).json({ error: 'not_found' })
    }
    console.error(`[api/data] failed to read ${relPath}: ${err.message}`)
    return res.status(500).json({ error: 'server_error', message: 'Could not read this data file.' })
  }

  // Parse-and-reserialize rather than pass the raw bytes through: catches a
  // truncated/corrupted export (e.g. a crash mid-write) and turns it into a
  // safe 500 instead of serving invalid JSON to the client with a 200 and a
  // JSON content-type as if it were valid.
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error(`[api/data] ${relPath} exists but is not valid JSON -- refusing to serve it.`)
    return res.status(500).json({ error: 'server_error', message: 'This data file is currently unavailable.' })
  }

  // meta.json for a scoped account: filter `locations` to only the
  // account's own grant, and never pass through `totalReviews` -- that
  // field is a company-wide aggregate (Phase 19's explicit "never leak
  // corporate totals to a scoped account" requirement) and this endpoint
  // has no cheap way to recompute a scoped total without reading every
  // location's own review file. The frontend must derive a scoped
  // account's review counts from the (already location-scoped) review
  // data it fetches, never from meta.totalReviews.
  if (!isWildcardGrant(account) && relPath === 'meta.json') {
    parsed = {
      ...parsed,
      locations: (parsed.locations ?? []).filter(l => requireLocationAccess(account, l.locationId)),
      totalReviews: null,
    }
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  return res.status(200).send(JSON.stringify(parsed))
}
