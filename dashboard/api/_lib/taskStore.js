// Operations Calendar + Content Library milestone -- the durable store for
// freestanding, manager-authored tasks/events. Deliberately SEPARATE from
// actionStore.js: that store's `id` space is always a review/action-center
// id resolved through reviewLocationIndex.js, and a freestanding task (no
// underlying review, e.g. "set up the window banner") has no such id --
// forcing it through that path would make resolveLocationIdForReviewOrDeny()
// return its UNRESOLVABLE_LOCATION_SENTINEL and deny every scoped account,
// unconditionally. See the architecture audit's Section 1 finding. Every
// existing actionStore.js record is untouched by this file.
//
// Same proven pattern as actionStore.js: one Upstash Redis hash
// (TASK_KEY = 'tasks:v2'), one field per generated task id, value a JSON
// record. `v2` (not `v1`) deliberately -- this is a distinct key namespace
// from any prior task-shaped experiment, never a migration of one.
//
// Location authorization is carried DIRECTLY on the record (`locationIds`:
// '*' or number[]) rather than resolved through a review lookup -- the
// correct model for a task that may not reference a review at all. A
// review_assignment task additionally carries relatedReviewIds, cross-
// checked against reviewLocationIndex.js by the API layer (never trusted
// from the client) -- see api/tasks/[action].js.
//
// Server-authoritative fields (id/createdBy/createdAt/updatedBy/updatedAt/
// history) are computed ONLY in upsertTask()/createTask() below, from the
// caller's authenticated account and the server clock -- never from client
// input, matching actionStore.js's exact division of labor.

import { Redis } from '@upstash/redis'
import { randomUUID } from 'crypto'
import { tasksKeyV3 } from './tenantKeys.js'
import { resolveHashReadKey, resolveHashWriteKey } from './tenantDualRead.js'

const TASK_KEY = 'tasks:v2'

// Multi-Tenant Phase 2: every exported function below (except
// generateTaskId, which touches no store) now takes `tenantId` as its
// first argument -- see tenantDualRead.js's header for the full read/write
// rule. For DEFAULT_TENANT_ID, this resolves to exactly TASK_KEY,
// unchanged. (The tenant-scoped successor is tasks:v3, not tasks:v2 --
// see tenantKeys.js's own comment on tasksKeyV3.)

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class TaskStoreUnavailableError extends Error {}

function hasUpstashConfig() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

function getClient() {
  if (testClientFactory) return testClientFactory()
  if (!hasUpstashConfig()) return null
  if (!redisClient) {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
  return redisClient
}

function parseRecord(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function generateTaskId() {
  return `task_${randomUUID()}`
}

// Returns { [id]: record } -- never {} for a genuinely broken store; see
// actionStore.js's identical reasoning for why a read failure throws
// instead of degrading to "no tasks".
export async function getAllTasks(tenantId) {
  const client = getClient()
  if (!client) throw new TaskStoreUnavailableError('task store is not configured')

  let raw
  try {
    const key = await resolveHashReadKey(client, { v1Key: TASK_KEY, v2Key: tasksKeyV3(tenantId), tenantId })
    raw = key ? await client.hgetall(key) : {}
  } catch (err) {
    throw new TaskStoreUnavailableError(`task store unreachable: ${err.message}`)
  }

  const out = {}
  for (const [id, value] of Object.entries(raw ?? {})) {
    const record = parseRecord(value)
    if (record) out[id] = record
  }
  return out
}

export async function getTask(tenantId, id) {
  const client = getClient()
  if (!client) throw new TaskStoreUnavailableError('task store is not configured')
  let raw
  try {
    const key = await resolveHashReadKey(client, { v1Key: TASK_KEY, v2Key: tasksKeyV3(tenantId), tenantId })
    raw = key ? await client.hget(key, id) : null
  } catch (err) {
    throw new TaskStoreUnavailableError(`task store unreachable: ${err.message}`)
  }
  return parseRecord(raw)
}

// Creates a brand-new task with a fresh, stable, non-positional id
// (generateTaskId()). `fields` is the already-validated request body (the
// API layer is responsible for validating shape/enums before calling this,
// same division of labor actionStore.js's caller has for validatePatch()).
export async function createTask(tenantId, fields, account) {
  const client = getClient()
  if (!client) throw new TaskStoreUnavailableError('task store is not configured')

  const id = generateTaskId()
  const now = new Date().toISOString()
  const record = {
    id,
    title: fields.title,
    description: fields.description ?? '',
    type: fields.type,
    locationIds: fields.locationIds,
    assignee: fields.assignee ?? null,
    startAt: fields.startAt,
    endAt: fields.endAt ?? null,
    allDay: Boolean(fields.allDay),
    priority: fields.priority ?? 'Medium',
    status: fields.status ?? 'Scheduled',
    recurrence: fields.recurrence ?? null,
    notes: fields.notes ?? '',
    relatedReviewIds: Array.isArray(fields.relatedReviewIds) ? fields.relatedReviewIds : [],
    campaignId: fields.campaignId ?? null,
    sourceActionId: fields.sourceActionId ?? null,
    createdBy: account.userId,
    createdAt: now,
    updatedBy: account.userId,
    updatedAt: now,
    history: [{ at: now, by: account.displayName ?? account.email, action: 'Task created' }],
  }

  const writeKey = resolveHashWriteKey({ v1Key: TASK_KEY, v2Key: tasksKeyV3(tenantId), tenantId })
  try {
    await client.hset(writeKey, { [id]: JSON.stringify(record) })
  } catch (err) {
    throw new TaskStoreUnavailableError(`task store unreachable: ${err.message}`)
  }
  return record
}

// Partial merge + server-stamped updatedBy/updatedAt/history, mirroring
// actionStore.js's upsertAction() exactly. `patch` must already be
// validated/whitelisted by the caller. Returns null if `id` doesn't exist
// (an update must never silently create a task the caller didn't ask for).
export async function updateTask(tenantId, id, patch, account, logAction) {
  const client = getClient()
  if (!client) throw new TaskStoreUnavailableError('task store is not configured')

  const existing = await getTask(tenantId, id)
  if (!existing) return null

  const now = new Date().toISOString()
  const history = existing.history ?? []

  const next = {
    ...existing,
    ...patch,
    id,
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
    updatedBy: account.userId,
    updatedAt: now,
    history: logAction
      ? [...history, { at: now, by: account.displayName ?? account.email, action: logAction }]
      : history,
  }

  const writeKey = resolveHashWriteKey({ v1Key: TASK_KEY, v2Key: tasksKeyV3(tenantId), tenantId })
  try {
    await client.hset(writeKey, { [id]: JSON.stringify(next) })
  } catch (err) {
    throw new TaskStoreUnavailableError(`task store unreachable: ${err.message}`)
  }
  return next
}

export async function deleteTask(tenantId, id) {
  const client = getClient()
  if (!client) throw new TaskStoreUnavailableError('task store is not configured')
  const writeKey = resolveHashWriteKey({ v1Key: TASK_KEY, v2Key: tasksKeyV3(tenantId), tenantId })
  try {
    const removed = await client.hdel(TASK_KEY, id)
    return removed > 0
  } catch (err) {
    throw new TaskStoreUnavailableError(`task store unreachable: ${err.message}`)
  }
}
