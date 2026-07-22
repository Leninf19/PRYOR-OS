// The seam between Action Center's task-tracking endpoints and however
// accountability state is actually stored -- same role as accountStore.js's
// seam over the account directory. Today: a single Upstash Redis hash
// (ACTION_WORKSPACE_KEY), one field per action-item id, value a JSON
// record. Callers never touch Redis directly.
//
// This is deliberately isolated from the review-sync pipeline: it holds
// collaborative workspace state (who's assigned, due dates, status,
// notes, history), not analytics. reviews.db/analytics_cache/export_chunks.py
// are untouched by this milestone -- see README "Action Accountability
// Store" for the full boundary.
//
// Server-authoritative fields (createdBy/createdAt/updatedBy/updatedAt/
// history) are computed ONLY in upsertAction() below, from the caller's
// authenticated account and the server clock -- never from client input.
// The API layer (dashboard/api/actions/[action].js) is responsible for
// stripping/rejecting any client-supplied value for those fields before
// calling upsertAction(); this module does not re-validate the patch shape,
// the same division of labor accounts.js (validation) / accountStore.js
// (lookup) already uses.
//
// Node-only: @upstash/redis has no Edge-runtime constraint here (unlike
// accountStore.js/accounts.js, this is never imported from
// dashboard/middleware.js).

import { Redis } from '@upstash/redis'

const ACTION_WORKSPACE_KEY = 'action_workspace:v1'

let redisClient = null
// Test-only seam: lets tests simulate a real Upstash hash's get/set
// behavior (including outages) without a real Upstash account or fragile
// REST-protocol mocking -- same pattern as rateLimit.js's
// _setLimiterFactoryForTests. Never used by production code paths.
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class ActionStoreUnavailableError extends Error {}

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

// Unlike rateLimit.js, this store never "fails open" outside production --
// there is no safe fake success for a write, and an empty task list is a
// harmless, honest degraded-read result in any environment. Missing config
// or an unreachable Redis both surface as ActionStoreUnavailableError; the
// API layer maps that to a 503, in every environment, always.
function parseRecord(value) {
  if (value == null) return null
  if (typeof value === 'object') return value // @upstash/redis may already deserialize JSON values
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// Returns { [id]: record }. An unconfigured/unreachable store throws
// rather than returning {} -- silently presenting "no tasks" when the
// store is actually broken would hide real data-loss-shaped failures from
// every viewer at once.
export async function getAllActions() {
  const client = getClient()
  if (!client) throw new ActionStoreUnavailableError('action store is not configured')

  let raw
  try {
    raw = await client.hgetall(ACTION_WORKSPACE_KEY)
  } catch (err) {
    throw new ActionStoreUnavailableError(`action store unreachable: ${err.message}`)
  }

  const out = {}
  for (const [id, value] of Object.entries(raw ?? {})) {
    const record = parseRecord(value)
    if (record) out[id] = record
  }
  return out
}

// Reads a single record without fetching the whole hash -- used by callers
// that only need to check one id's current state (e.g. duplicate-send
// checks before sending a review email) rather than the full workspace.
export async function getAction(id) {
  const client = getClient()
  if (!client) throw new ActionStoreUnavailableError('action store is not configured')

  let raw
  try {
    raw = await client.hget(ACTION_WORKSPACE_KEY, id)
  } catch (err) {
    throw new ActionStoreUnavailableError(`action store unreachable: ${err.message}`)
  }
  return parseRecord(raw)
}

// Merges `patch` (already validated/whitelisted by the caller) into the
// record for `id`, stamping server-authoritative fields:
//   - createdBy/createdAt: set once, from the first write, never overwritten
//   - updatedBy/updatedAt: set on every write, from the CURRENT caller/clock
//   - history: append-only; a new { at, by, action } entry is added only
//     when `logAction` is passed (mirrors the existing high-frequency-write
//     convenience the localStorage version already had for draft edits)
//
// `account` is the authenticated, server-verified account record (from
// requireAuth()) -- never a client-supplied identity.
export async function upsertAction(id, patch, account, logAction) {
  const client = getClient()
  if (!client) throw new ActionStoreUnavailableError('action store is not configured')

  let existingRaw
  try {
    existingRaw = await client.hget(ACTION_WORKSPACE_KEY, id)
  } catch (err) {
    throw new ActionStoreUnavailableError(`action store unreachable: ${err.message}`)
  }
  const existing = parseRecord(existingRaw)
  const now = new Date().toISOString()
  const history = existing?.history ?? []
  const actorName = account.displayName ?? account.email

  const next = {
    status: 'New',
    assignedTo: null,
    assignedLocation: null,
    assignedDepartment: null,
    dueDate: null,
    notes: '',
    outcomeSnapshot: null,
    ...existing,
    ...patch,
    id,
    createdBy: existing?.createdBy ?? account.userId,
    createdAt: existing?.createdAt ?? now,
    updatedBy: account.userId,
    updatedAt: now,
    history: logAction
      ? [...history, { at: now, by: actorName, action: logAction }]
      : history,
  }

  try {
    await client.hset(ACTION_WORKSPACE_KEY, { [id]: JSON.stringify(next) })
  } catch (err) {
    throw new ActionStoreUnavailableError(`action store unreachable: ${err.message}`)
  }
  return next
}
