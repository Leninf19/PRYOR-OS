// Authenticated read access to dashboard/private-data/ -- the JSON chunks
// export_chunks.py writes (reviews, analytics, AI intelligence, etc), moved
// out of dashboard/public/ specifically so they are no longer reachable by
// direct URL. GET /api/data/<same relative path the file used to have under
// public/data/>, e.g. /api/data/meta.json, /api/data/reviews/by-location/x.json.
//
// SAFETY MODEL (read this before changing the allowlist below):
//   A catch-all file-serving route is one bad path check away from being a
//   general file-download endpoint. This handler does NOT trust path.join()
//   plus a startsWith() check as its only defense -- the primary defense is
//   a positive allowlist of exact filenames and directory+slug patterns
//   matching exactly what export_chunks.py actually produces. A request for
//   anything not on this list is rejected before the filesystem is ever
//   touched, regardless of how it's encoded. The resolve()+prefix check
//   below is a second, independent layer, not the only one.
//
// Vercel bundling note: this function does `fs.readFile` against a path
// built at request time, which Vercel's static dependency tracer cannot
// discover by analyzing the source -- dashboard/vercel.json's
// `functions["api/data/**"].includeFiles` glob is what actually gets
// dashboard/private-data/** included in this function's deployment bundle.
// Do not assume runtime fs access "just works" without that entry.

import { readFile } from 'fs/promises'
import { existsSync, readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { requireAuth } from '../_lib/auth.js'

const ALLOWED_ROLES = ['owner', 'marketing']

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PRIVATE_ROOT = path.resolve(__dirname, '..', '..', 'private-data')

// TEMPORARY DIAGNOSTIC (Phase 1 /api/data/* routing investigation --
// remove once root cause is confirmed). No file contents, no secrets --
// filenames and paths only.
function logDiagnostics(relPath, resolvedTarget) {
  console.log('[data-diag] __dirname=', __dirname)
  console.log('[data-diag] process.cwd()=', process.cwd())
  console.log('[data-diag] process.env.VERCEL=', process.env.VERCEL)
  console.log('[data-diag] PRIVATE_ROOT=', PRIVATE_ROOT)
  console.log('[data-diag] PRIVATE_ROOT exists=', existsSync(PRIVATE_ROOT))
  if (existsSync(PRIVATE_ROOT)) {
    try {
      console.log('[data-diag] PRIVATE_ROOT readdir=', readdirSync(PRIVATE_ROOT))
    } catch (err) {
      console.log('[data-diag] PRIVATE_ROOT readdir failed:', err.message)
    }
  }
  console.log('[data-diag] requested relPath=', relPath)
  console.log('[data-diag] resolvedTarget=', resolvedTarget)
  console.log('[data-diag] resolvedTarget exists=', resolvedTarget ? existsSync(resolvedTarget) : 'n/a')
}

// Every static file export_chunks.py writes (see its main()/export_* calls).
const EXACT_ALLOWLIST = new Set([
  'meta.json',
  'action-items.json',
  'validation.json',
  'scraper-status.json',
  'gbp-sync.json',
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

// req.query.path is an array of already-decoded segments (Vercel's own
// catch-all routing splits and decodes before handler code ever runs).
// Still validated defensively here rather than trusted: reject anything
// that isn't a plain [a-z0-9._-]+ segment, which alone rules out '..',
// '.', empty segments, encoded slashes, backslashes, and null bytes -- an
// allowlisted rejoined string can only ever describe one of the known-good
// shapes above, regardless of how the request tried to spell it.
function buildRequestedRelPath(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return null
  for (const seg of segments) {
    if (typeof seg !== 'string' || seg.length === 0) return null
    if (seg.includes('\0') || seg.includes('\\') || seg.includes('/')) return null
    if (!/^[a-zA-Z0-9._-]+$/.test(seg)) return null
    if (seg === '.' || seg === '..') return null
  }
  return segments.join('/')
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  // Never let a cached authenticated payload leak to the CDN or a shared
  // browser cache -- this is per-account operational data now, not a
  // static asset.
  res.setHeader('Cache-Control', 'private, no-store')

  const account = await requireAuth(req, res, ALLOWED_ROLES)
  if (!account) return

  console.log('[data-diag] raw req.query.path=', JSON.stringify(req.query.path))
  console.log('[data-diag] full req.query=', JSON.stringify(req.query))
  console.log('[data-diag] req.url=', req.url)

  const relPath = buildRequestedRelPath(req.query.path)
  const resolvedForDiag = relPath ? path.resolve(PRIVATE_ROOT, relPath) : null
  logDiagnostics(relPath, resolvedForDiag)

  if (!relPath || !isAllowed(relPath)) {
    return res.status(404).json({ error: 'not_found' })
  }

  const resolved = path.resolve(PRIVATE_ROOT, relPath)
  // Defense in depth, not the primary check -- the allowlist above already
  // guarantees this, but a future edit to the allowlist regexes shouldn't
  // be able to silently escape PRIVATE_ROOT without this also catching it.
  if (resolved !== PRIVATE_ROOT && !resolved.startsWith(PRIVATE_ROOT + path.sep)) {
    return res.status(404).json({ error: 'not_found' })
  }

  let raw
  try {
    raw = await readFile(resolved, 'utf-8')
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Legitimate empty state for files that only exist once a given
      // pipeline stage has run at least once (e.g. gbp-sync.json before
      // the first API sync), OR a genuinely missing bundled artifact
      // (export_chunks.py never generated it, or a vercel.json
      // includeFiles misconfiguration left it out of the deployment) --
      // callers already treat 404 as "not yet generated", not a hard
      // error, and the response never distinguishes the two causes.
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

  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  return res.status(200).send(JSON.stringify(parsed))
}
