// Single serverless function handling both Action Center workspace
// endpoints -- consolidated into one dynamic-route file for the same
// reason dashboard/api/session/[action].js is: staying under the Vercel
// Hobby plan's 12-serverless-function-per-deployment limit. Vercel/Node
// populates req.query.action from the URL segment, so the external routes
// are GET /api/actions/list and POST /api/actions/update.
//
// This is the collaborative-state tier, not the analytics pipeline: it
// reads/writes Redis via _lib/actionStore.js only. It never touches
// reviews.db, analytics_cache, or anything export_chunks.py/
// refresh_analytics.py produce.
//
// Same roles as the AI Action Center's own read access today (owner,
// marketing) -- this milestone does not introduce location-scoped
// authorization; see README "Location authorization strategy" for why
// location_manager accounts aren't safe to grant this yet.

import { requireAuth } from '../_lib/auth.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import { getAllActions, upsertAction, ActionStoreUnavailableError } from '../_lib/actionStore.js'

const ALLOWED_ROLES = ['owner', 'marketing']

// Mirrors ActionCenter.jsx's STATUSES exactly (dashboard/src/pages/ActionCenter.jsx).
// Intentionally duplicated rather than shared across the frontend/backend
// boundary -- same tradeoff db.py's BRANDS/dataUtils.js's BRANDS already make.
const VALID_STATUSES = new Set(['New', 'Assigned', 'In Progress', 'Completed', 'Monitoring', 'Dismissed'])

// Fields a caller may patch. id/createdBy/createdAt/updatedBy/updatedAt/history
// are server-authoritative and deliberately excluded -- a request containing
// any of them is rejected outright (accounts.js's "reject unknown fields
// outright" convention), not silently stripped.
const PATCHABLE_FIELDS = new Set([
  'status', 'assignedTo', 'assignedLocation', 'assignedDepartment',
  'dueDate', 'notes', 'outcomeSnapshot',
])

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Returns a sanitized patch, or null (caller responds 400) if the patch
// contains an unrecognized/forbidden key or a field with the wrong shape.
function validatePatch(patch) {
  if (!isPlainObject(patch)) return null
  for (const key of Object.keys(patch)) {
    if (!PATCHABLE_FIELDS.has(key)) return null
  }
  if ('status' in patch && !VALID_STATUSES.has(patch.status)) return null
  if ('dueDate' in patch && patch.dueDate !== null && typeof patch.dueDate !== 'string') return null
  if ('notes' in patch && typeof patch.notes !== 'string') return null
  if ('assignedTo' in patch && patch.assignedTo !== null && typeof patch.assignedTo !== 'string') return null
  if ('assignedLocation' in patch && patch.assignedLocation !== null && typeof patch.assignedLocation !== 'string') return null
  if ('assignedDepartment' in patch && patch.assignedDepartment !== null && typeof patch.assignedDepartment !== 'string') return null
  if ('logAction' in patch) return null // logAction is a sibling request field, never a patch field
  return patch
}

// GET /api/actions/list -- returns every task record, keyed by action id.
// No rate limit, matching dashboard/api/data.js's read endpoint precedent
// (auth is the only gate on a read).
async function list(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, ALLOWED_ROLES)
  if (!account) return

  try {
    const actions = await getAllActions()
    return res.status(200).json({ actions })
  } catch (err) {
    if (err instanceof ActionStoreUnavailableError) {
      console.error(`[actions/list] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The task workspace is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// POST /api/actions/update  { id, patch, logAction? }
// Returns { record } -- the full merged record after the write, so the
// caller's optimistic-update cache can reconcile with the server's version
// (server-stamped updatedAt/updatedBy/history) in one round trip.
async function update(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, ALLOWED_ROLES)
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `actions:update:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const { id, patch, logAction } = req.body ?? {}
  if (typeof id !== 'string' || !id.trim()) {
    return res.status(400).json({ error: 'invalid_request', message: 'id is required.' })
  }
  if (logAction !== undefined && typeof logAction !== 'string') {
    return res.status(400).json({ error: 'invalid_request', message: 'logAction must be a string when provided.' })
  }
  const sanitized = validatePatch(patch ?? {})
  if (sanitized === null) {
    return res.status(400).json({ error: 'invalid_request', message: 'patch contains an unrecognized or invalid field.' })
  }

  try {
    const record = await upsertAction(id, sanitized, account, logAction)
    return res.status(200).json({ record })
  } catch (err) {
    if (err instanceof ActionStoreUnavailableError) {
      console.error(`[actions/update] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The task workspace is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

export default async function handler(req, res) {
  switch (req.query?.action) {
    case 'list':   return list(req, res)
    case 'update': return update(req, res)
    default:       return res.status(404).json({ error: 'not_found' })
  }
}
