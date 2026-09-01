// Operations Calendar + Content Library milestone -- consolidated task
// endpoint (stays under Vercel's serverless-function ceiling, same reason
// actions/[action].js and session/[action].js are consolidated). External
// routes: GET /api/tasks/list, GET /api/tasks/get, POST /api/tasks/create,
// POST /api/tasks/update, POST /api/tasks/delete.
//
// This is a SEPARATE store/id-space from actionStore.js -- see
// taskStore.js's header for why a freestanding task cannot be forced
// through the review-id-keyed action-center store. Nothing here reads or
// writes actionStore.js; the existing AI Action Center data and endpoint
// are completely untouched.
//
// Location authorization is enforced on every path, server-side, using the
// task's OWN locationIds field (not a review lookup) except for
// relatedReviewIds cross-checks, which go through reviewLocationIndex.js --
// the same module actions/[action].js and google/[action].js already use,
// never trusting a client-supplied location for a review.

import { requireAuth, requireLocationAccess, canCreateTask } from '../_lib/auth.js'
import { Permission, roleHasPermission } from '../_lib/permissions.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import { appendAuditEntry, clientIp } from '../_lib/auditLog.js'
import {
  getAllTasks, getTask, createTask, updateTask, deleteTask, TaskStoreUnavailableError,
} from '../_lib/taskStore.js'
import { resolveLocationIdForReview } from '../_lib/reviewLocationIndex.js'
import { computeReviewAssignmentProgress } from '../_lib/reviewAssignmentProgress.js'
import { resolveTenantId } from '../_lib/tenants.js'

const TASK_TYPES = new Set([
  'promotion', 'social_media', 'review_assignment', 'operations',
  'website', 'meeting', 'holiday', 'deadline', 'other',
])
const PRIORITIES = new Set(['Critical', 'High', 'Medium', 'Low'])
const STATUSES = new Set(['Scheduled', 'In Progress', 'Completed', 'Cancelled'])
const RECURRENCE_FREQ = new Set(['daily', 'weekly', 'monthly'])
// A self-service update (no TASK_MANAGE, acting on your own assigned task)
// may only move a task into one of these two statuses -- 'Cancelled' and
// reopening a completed task back to 'Scheduled' are management actions.
const SELF_SERVICE_STATUSES = new Set(['In Progress', 'Completed'])
const SELF_SERVICE_FIELDS = new Set(['status', 'notes'])
const MANAGED_FIELDS = new Set([
  'title', 'description', 'type', 'locationIds', 'assignee', 'startAt', 'endAt',
  'allDay', 'priority', 'status', 'recurrence', 'notes', 'relatedReviewIds', 'campaignId',
])

function actorFields(account, req) {
  return { actorId: account.userId, actorName: account.displayName ?? account.email, actorEmail: account.email, ip: clientIp(req) }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// '*' or a non-empty array of distinct positive integers -- the exact same
// rule accounts.js's isValidLocationIds() enforces for account records,
// duplicated here rather than imported since api/_lib/accounts.js is
// Edge-compatible and deliberately has no reason to know about tasks.
function isValidLocationIdsShape(locationIds) {
  if (locationIds === '*') return true
  if (!Array.isArray(locationIds) || locationIds.length === 0) return false
  const seen = new Set()
  for (const id of locationIds) {
    if (!Number.isInteger(id) || id <= 0) return false
    if (seen.has(id)) return false
    seen.add(id)
  }
  return true
}

// Generalized location-grant check for a TASK (which itself may be scoped
// to multiple locations or company-wide), not a single location id --
// requireLocationAccess() in auth.js only compares a grant against one id.
// A '*' task is only "owned" by an unscoped account; an array-scoped task
// requires the account's grant to cover EVERY location the task touches.
function accountCoversTaskLocations(account, taskLocationIds) {
  if (taskLocationIds === '*') return account.locationIds === '*'
  if (account.locationIds === '*') return true
  if (!Array.isArray(account.locationIds)) return false
  return taskLocationIds.every(id => account.locationIds.includes(id))
}

// Reject-outright (never silently trim) check for a WRITE request's
// requested locationIds against the account's own grant -- the architecture
// plan's explicit "locationIds: [authorized, unauthorized] must be
// REJECTED" requirement. Requesting '*' is only valid for an unscoped
// account; a scoped account requesting '*' is rejected here too, not
// silently narrowed to their own locations.
function isRequestedLocationsAuthorized(account, requestedLocationIds) {
  if (requestedLocationIds === '*') return account.locationIds === '*'
  if (account.locationIds === '*') return true
  return requestedLocationIds.every(id => account.locationIds.includes(id))
}

function validateAssignee(assignee) {
  if (assignee === null || assignee === undefined) return true
  if (!isPlainObject(assignee)) return false
  const keys = Object.keys(assignee)
  if (keys.length !== 1) return false
  if (keys[0] === 'userId') return typeof assignee.userId === 'string' && assignee.userId.length > 0
  if (keys[0] === 'role') return typeof assignee.role === 'string' && assignee.role.length > 0
  return false
}

function validateRecurrence(recurrence) {
  if (recurrence === null || recurrence === undefined) return true
  if (!isPlainObject(recurrence)) return false
  if (!RECURRENCE_FREQ.has(recurrence.freq)) return false
  if ('interval' in recurrence && !(Number.isInteger(recurrence.interval) && recurrence.interval > 0)) return false
  if ('until' in recurrence && recurrence.until !== null) {
    if (typeof recurrence.until !== 'string' || Number.isNaN(new Date(recurrence.until).getTime())) return false
  }
  return true
}

function isIsoDateString(v) {
  return typeof v === 'string' && !Number.isNaN(new Date(v).getTime())
}

// Full validation for a CREATE request. Returns { valid, message } or
// { valid: true, fields } with the sanitized/whitelisted field set.
function validateCreateFields(body) {
  if (!isPlainObject(body)) return { valid: false, message: 'Request body must be an object.' }
  const { title, description, type, locationIds, assignee, startAt, endAt, allDay,
    priority, status, recurrence, notes, relatedReviewIds, campaignId, sourceActionId } = body

  if (typeof title !== 'string' || !title.trim() || title.length > 200) {
    return { valid: false, message: 'title is required (max 200 characters).' }
  }
  if (description !== undefined && (typeof description !== 'string' || description.length > 5000)) {
    return { valid: false, message: 'description must be a string under 5000 characters.' }
  }
  if (!TASK_TYPES.has(type)) {
    return { valid: false, message: `type must be one of: ${[...TASK_TYPES].join(', ')}.` }
  }
  if (!isValidLocationIdsShape(locationIds)) {
    return { valid: false, message: "locationIds must be '*' or a non-empty array of distinct positive integers." }
  }
  if (!validateAssignee(assignee)) {
    return { valid: false, message: 'assignee must be null, { userId }, or { role }.' }
  }
  if (!isIsoDateString(startAt)) {
    return { valid: false, message: 'startAt must be a valid date/datetime string.' }
  }
  if (endAt !== undefined && endAt !== null && !isIsoDateString(endAt)) {
    return { valid: false, message: 'endAt must be a valid date/datetime string or null.' }
  }
  if (priority !== undefined && !PRIORITIES.has(priority)) {
    return { valid: false, message: `priority must be one of: ${[...PRIORITIES].join(', ')}.` }
  }
  if (status !== undefined && !STATUSES.has(status)) {
    return { valid: false, message: `status must be one of: ${[...STATUSES].join(', ')}.` }
  }
  if (!validateRecurrence(recurrence)) {
    return { valid: false, message: 'recurrence must be null or { freq, interval?, until? }.' }
  }
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 5000)) {
    return { valid: false, message: 'notes must be a string under 5000 characters.' }
  }
  if (relatedReviewIds !== undefined) {
    if (!Array.isArray(relatedReviewIds) || relatedReviewIds.some(id => typeof id !== 'string' || !id)) {
      return { valid: false, message: 'relatedReviewIds must be an array of strings.' }
    }
    if (relatedReviewIds.length > 200) {
      return { valid: false, message: 'relatedReviewIds is limited to 200 reviews per task.' }
    }
  }
  if (campaignId !== undefined && campaignId !== null && typeof campaignId !== 'string') {
    return { valid: false, message: 'campaignId must be a string or null.' }
  }
  if (sourceActionId !== undefined && sourceActionId !== null && typeof sourceActionId !== 'string') {
    return { valid: false, message: 'sourceActionId must be a string or null.' }
  }
  if (type === 'review_assignment' && (!relatedReviewIds || relatedReviewIds.length === 0)) {
    return { valid: false, message: 'A review_assignment task must include at least one relatedReviewIds entry.' }
  }

  return {
    valid: true,
    fields: {
      title: title.trim(), description, type, locationIds, assignee: assignee ?? null,
      startAt, endAt: endAt ?? null, allDay: Boolean(allDay), priority, status, recurrence,
      notes, relatedReviewIds, campaignId: campaignId ?? null, sourceActionId: sourceActionId ?? null,
    },
  }
}

// Every relatedReviewIds entry must resolve to a real location AND that
// location must be one of the account's authorized locations AND one of
// the task's own declared locationIds -- defense in depth: a caller cannot
// assign a review from a location they can't reach, and cannot silently
// widen a task's location scope by attaching an out-of-scope review to it.
async function validateReviewAssignmentLocations(relatedReviewIds, account, taskLocationIds) {
  for (const id of relatedReviewIds ?? []) {
    const locationId = await resolveLocationIdForReview(id, resolveTenantId(account))
    if (locationId === null) return { valid: false, message: `Review "${id}" could not be resolved to a known location.` }
    if (!requireLocationAccess(account, locationId)) {
      return { valid: false, message: `Review "${id}" belongs to a location outside your authorization.` }
    }
    if (taskLocationIds !== '*' && !taskLocationIds.includes(locationId)) {
      return { valid: false, message: `Review "${id}"'s location must be included in the task's locationIds.` }
    }
  }
  return { valid: true }
}

// --- list ---------------------------------------------------------------
// GET /api/tasks/list -- every role holds TASK_VIEW (see permissions.js).
// A scoped account receives company-wide ('*') tasks (intentionally
// broadcast, e.g. a holiday closure) PLUS tasks intersecting their own
// locationIds -- never a location outside their grant, and never "fetch
// everything then filter in React": the filtering below happens before the
// response is ever serialized.
async function list(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return
  if (!roleHasPermission(account.role, Permission.TASK_VIEW)) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to view tasks.' })
  }

  try {
    const all = await getAllTasks(resolveTenantId(account))
    const visible = []
    for (const task of Object.values(all)) {
      if (task.locationIds === '*' || accountCoversTaskLocations(account, task.locationIds) ||
          (Array.isArray(account.locationIds) && Array.isArray(task.locationIds) && task.locationIds.some(id => account.locationIds.includes(id)))) {
        visible.push(task)
      }
    }

    const withProgress = await Promise.all(visible.map(async task => {
      if (task.type !== 'review_assignment') return task
      const progress = await computeReviewAssignmentProgress(task.relatedReviewIds, resolveTenantId(account))
      return progress ? { ...task, reviewProgress: progress } : task
    }))

    return res.status(200).json({ tasks: withProgress })
  } catch (err) {
    if (err instanceof TaskStoreUnavailableError) {
      console.error(`[tasks/list] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The task calendar is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// --- get ------------------------------------------------------------------
// GET /api/tasks/get?id=... -- a direct-id lookup outside the account's
// authorized locations returns 404, never 403 (the project's established
// non-disclosure convention -- see reviewLocationIndex.js/auth.js).
async function get(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return
  if (!roleHasPermission(account.role, Permission.TASK_VIEW)) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to view tasks.' })
  }

  const { id } = req.query ?? {}
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'invalid_request', message: 'id is required.' })

  try {
    const task = await getTask(resolveTenantId(account), id)
    if (!task) return res.status(404).json({ error: 'not_found' })
    const authorized = task.locationIds === '*' || accountCoversTaskLocations(account, task.locationIds) ||
      (Array.isArray(account.locationIds) && Array.isArray(task.locationIds) && task.locationIds.some(lid => account.locationIds.includes(lid)))
    if (!authorized) return res.status(404).json({ error: 'not_found' })

    let result = task
    if (task.type === 'review_assignment') {
      const progress = await computeReviewAssignmentProgress(task.relatedReviewIds, resolveTenantId(account))
      if (progress) result = { ...task, reviewProgress: progress }
    }
    return res.status(200).json({ task: result })
  } catch (err) {
    if (err instanceof TaskStoreUnavailableError) {
      console.error(`[tasks/get] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The task calendar is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// --- create -----------------------------------------------------------------
// POST /api/tasks/create -- gated by canCreateTask() (TASK_CREATE role grant
// OR the account-level canCreateTasks override for a location_manager).
// A location_manager (even with canCreateTasks=true) can NEVER create a
// company-wide ('*') task or one touching a location outside their grant --
// isRequestedLocationsAuthorized() rejects both outright.
async function create(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return
  if (!canCreateTask(account)) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to create tasks.' })
  }

  const allowed = await enforceRateLimit(req, res, `tasks:create:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const validation = validateCreateFields(req.body)
  if (!validation.valid) return res.status(400).json({ error: 'invalid_request', message: validation.message })
  const { fields } = validation

  if (!isRequestedLocationsAuthorized(account, fields.locationIds)) {
    return res.status(403).json({ error: 'forbidden', message: 'You are not authorized to create a task for one or more of the requested locations.' })
  }

  if (fields.type === 'review_assignment') {
    const reviewCheck = await validateReviewAssignmentLocations(fields.relatedReviewIds, account, fields.locationIds)
    if (!reviewCheck.valid) return res.status(400).json({ error: 'invalid_request', message: reviewCheck.message })
  }

  // Location managers create only within their own authorized locations by
  // construction (checked above); "company-wide task creation" additionally
  // requires the unrestricted TASK_CREATE grant (owner/admin/marketing), not
  // just canCreateTasks -- already enforced since a scoped account can never
  // pass isRequestedLocationsAuthorized() for locationIds: '*'.

  try {
    const record = await createTask(resolveTenantId(account), fields, account)
    await appendAuditEntry(resolveTenantId(account), {
      ...actorFields(account, req), entity: 'task', entityId: record.id,
      action: 'task.created', result: 'success',
      message: `Created task "${record.title}" (${record.type}).`,
    })
    return res.status(201).json({ task: record })
  } catch (err) {
    if (err instanceof TaskStoreUnavailableError) {
      console.error(`[tasks/create] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The task calendar is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// --- update -----------------------------------------------------------------
// POST /api/tasks/update { id, patch, logAction? }
// Two authorization paths:
//   1. Full management (TASK_MANAGE + location coverage over the task's
//      OWN locationIds) -- may patch any MANAGED_FIELDS.
//   2. Self-service (no TASK_MANAGE): only if the task is assigned to this
//      exact user, OR this is a location_manager/read_only-adjacent account
//      whose locationIds intersects the task's -- and even then, ONLY
//      status (into 'In Progress'/'Completed') and notes may change. Every
//      other field is rejected outright, not silently ignored.
async function update(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return
  if (!roleHasPermission(account.role, Permission.TASK_VIEW)) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to update tasks.' })
  }

  const allowed = await enforceRateLimit(req, res, `tasks:update:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const { id, patch, logAction } = req.body ?? {}
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'invalid_request', message: 'id is required.' })
  if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'patch must be a non-empty object.' })
  }
  if (logAction !== undefined && typeof logAction !== 'string') {
    return res.status(400).json({ error: 'invalid_request', message: 'logAction must be a string when provided.' })
  }

  try {
    const existing = await getTask(resolveTenantId(account), id)
    // Direct-id tampering: an unauthorized target returns 404, matching
    // the get()/reviewLocationIndex.js convention -- never 403 (which
    // would confirm a task exists at an id the caller has no access to).
    if (!existing) return res.status(404).json({ error: 'not_found' })
    const inScope = existing.locationIds === '*'
      ? accountCoversTaskLocations(account, existing.locationIds)
      : (Array.isArray(account.locationIds) ? existing.locationIds.some(lid => account.locationIds.includes(lid)) : account.locationIds === '*')
    if (!inScope) return res.status(404).json({ error: 'not_found' })

    const hasManage = roleHasPermission(account.role, Permission.TASK_MANAGE) && accountCoversTaskLocations(account, existing.locationIds)
    const isAssignedToMe = existing.assignee?.userId === account.userId
    const selfServiceEligible = isAssignedToMe ||
      (Array.isArray(account.locationIds) && Array.isArray(existing.locationIds) && existing.locationIds.some(lid => account.locationIds.includes(lid)))

    if (!hasManage) {
      if (!selfServiceEligible) {
        return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to update this task.' })
      }
      const keys = Object.keys(patch)
      if (!keys.every(k => SELF_SERVICE_FIELDS.has(k))) {
        return res.status(403).json({ error: 'forbidden', message: 'You may only update status and notes on a task assigned to you.' })
      }
      if ('status' in patch && !SELF_SERVICE_STATUSES.has(patch.status)) {
        return res.status(403).json({ error: 'forbidden', message: 'You may only mark a task In Progress or Completed.' })
      }
    } else {
      const keys = Object.keys(patch)
      if (!keys.every(k => MANAGED_FIELDS.has(k))) {
        return res.status(400).json({ error: 'invalid_request', message: 'patch contains an unrecognized field.' })
      }
      if ('type' in patch && !TASK_TYPES.has(patch.type)) return res.status(400).json({ error: 'invalid_request', message: 'invalid type.' })
      if ('priority' in patch && !PRIORITIES.has(patch.priority)) return res.status(400).json({ error: 'invalid_request', message: 'invalid priority.' })
      if ('status' in patch && !STATUSES.has(patch.status)) return res.status(400).json({ error: 'invalid_request', message: 'invalid status.' })
      if ('recurrence' in patch && !validateRecurrence(patch.recurrence)) return res.status(400).json({ error: 'invalid_request', message: 'invalid recurrence.' })
      if ('assignee' in patch && !validateAssignee(patch.assignee)) return res.status(400).json({ error: 'invalid_request', message: 'invalid assignee.' })
      if ('locationIds' in patch) {
        if (!isValidLocationIdsShape(patch.locationIds)) return res.status(400).json({ error: 'invalid_request', message: 'invalid locationIds.' })
        if (!isRequestedLocationsAuthorized(account, patch.locationIds)) {
          return res.status(403).json({ error: 'forbidden', message: 'You are not authorized to move this task to one or more of the requested locations.' })
        }
      }
    }

    const record = await updateTask(resolveTenantId(account), id, patch, account, logAction)
    if ('status' in patch && patch.status === 'Completed') {
      await appendAuditEntry(resolveTenantId(account), {
        ...actorFields(account, req), entity: 'task', entityId: id,
        action: 'task.completed', result: 'success', message: `Marked task "${record.title}" completed.`,
      })
    } else if ('assignee' in patch) {
      await appendAuditEntry(resolveTenantId(account), {
        ...actorFields(account, req), entity: 'task', entityId: id,
        action: 'task.reassigned', result: 'success', message: `Reassigned task "${record.title}".`,
      })
    }
    return res.status(200).json({ task: record })
  } catch (err) {
    if (err instanceof TaskStoreUnavailableError) {
      console.error(`[tasks/update] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The task calendar is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// --- delete -------------------------------------------------------------
// POST /api/tasks/delete { id } -- TASK_MANAGE + location coverage only.
async function del(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return
  if (!roleHasPermission(account.role, Permission.TASK_MANAGE)) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to delete tasks.' })
  }

  const allowed = await enforceRateLimit(req, res, `tasks:delete:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const { id } = req.body ?? {}
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'invalid_request', message: 'id is required.' })

  try {
    const existing = await getTask(resolveTenantId(account), id)
    if (!existing) return res.status(404).json({ error: 'not_found' })
    if (!accountCoversTaskLocations(account, existing.locationIds)) return res.status(404).json({ error: 'not_found' })

    await deleteTask(resolveTenantId(account), id)
    await appendAuditEntry(resolveTenantId(account), {
      ...actorFields(account, req), entity: 'task', entityId: id,
      action: 'task.deleted', result: 'success', message: `Deleted task "${existing.title}".`,
    })
    return res.status(200).json({ success: true })
  } catch (err) {
    if (err instanceof TaskStoreUnavailableError) {
      console.error(`[tasks/delete] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The task calendar is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

export default async function handler(req, res) {
  switch (req.query?.action) {
    case 'list':   return list(req, res)
    case 'get':    return get(req, res)
    case 'create': return create(req, res)
    case 'update': return update(req, res)
    case 'delete': return del(req, res)
    default:       return res.status(404).json({ error: 'not_found' })
  }
}
