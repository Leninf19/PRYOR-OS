// The cross-entity, company-wide audit trail (Phase 8, Milestone 8.6) --
// distinct from contactStore.js's own per-record `history` array (a
// lightweight "what changed on THIS record" view for the Contacts table's
// Last Updated/Updated By columns). This module is the compliance-facing,
// append-only event log: who changed what, when, old/new values, from
// which IP, and whether the action succeeded -- Settings -> Audit Log,
// Owner-only.
//
// Storage: a single Redis LIST (AUDIT_LOG_KEY), not a hash -- entries are
// immutable append-only events, never upserted-by-id like actionStore.js's
// or contactStore.js's hashes. LPUSH new entries (newest first), LTRIM to
// cap at the most recent MAX_ENTRIES so the list never grows unbounded;
// reads LRANGE the whole (capped) list and filter/paginate in memory --
// this app's scale (a small team, low event volume) doesn't need a
// secondary index yet.
//
// Node-only: @upstash/redis has no Edge-runtime constraint here, matching
// actionStore.js/contactStore.js.

import { randomUUID } from 'crypto'
import { Redis } from '@upstash/redis'
import { auditLogKeyV2 } from './tenantKeys.js'
import { resolveListReadKey, resolveListWriteKey, assertKnownTenantId } from './tenantDualRead.js'

const AUDIT_LOG_KEY = 'audit_log:v1'
const MAX_ENTRIES = 20000

// Multi-Tenant Phase 2: both exported functions below now take `tenantId`
// as their first argument. The security audit specifically flagged this
// store as the largest cross-tenant risk (a flat, unfiltered event log
// with no location or tenant boundary at all) -- this is the fix's
// foundation: for DEFAULT_TENANT_ID this resolves to exactly
// AUDIT_LOG_KEY, unchanged, but any other tenantId can NEVER read or write
// this log, full stop, enforced by tenantDualRead.js's centralized rule
// rather than by this file re-deriving it.

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class AuditLogUnavailableError extends Error {}

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

function parseEntry(value) {
  if (value == null) return null
  if (typeof value === 'object') return value // @upstash/redis may already deserialize JSON values
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// Same first-hop convention as session/[action].js's own clientIp() --
// duplicated rather than imported (that function is private/unexported
// there, and this project's established convention is to duplicate small
// helpers across such boundaries rather than introduce a new shared import
// path for a two-line function; see db.py/dataUtils.js's BRANDS).
export function clientIp(req) {
  const fwd = req?.headers?.['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim()
  return req?.socket?.remoteAddress || null
}

// Appends one immutable event. `entry` must already carry actor identity
// from the SERVER-VERIFIED account (requireAuth()'s result), never
// client-supplied -- this module does not re-derive or validate identity,
// the same division of labor actionStore.js/contactStore.js already use
// between the store and its API-layer caller.
//
// Never throws on a write failure in a way that would break the caller's
// own primary action (e.g. a contact upsert that already succeeded) --
// logs the failure and returns false instead, so a Redis hiccup on the
// audit side never masquerades as the primary write having failed. This is
// the one deliberate exception to this codebase's "never fail open on a
// write" convention: an audit entry is important, but it is not the
// source of truth for the change itself (contactStore.js's own history
// array already recorded that).
export async function appendAuditEntry(tenantId, entry) {
  assertKnownTenantId(tenantId, 'appendAuditEntry') // a missing tenantId is a caller bug, not a Redis outage -- throws synchronously either way
  const client = getClient()
  if (!client) {
    console.error('[auditLog] audit log is not configured -- entry not recorded:', entry.action)
    return false
  }
  const record = {
    id: randomUUID(),
    at: new Date().toISOString(),
    ...entry,
  }
  const writeKey = resolveListWriteKey({ v1Key: AUDIT_LOG_KEY, v2Key: auditLogKeyV2(tenantId), tenantId })
  try {
    await client.lpush(writeKey, JSON.stringify(record))
    await client.ltrim(writeKey, 0, MAX_ENTRIES - 1)
    return true
  } catch (err) {
    console.error(`[auditLog] failed to append entry: ${err.message}`)
    return false
  }
}

// Returns { entries, total } -- `total` is the count AFTER filtering (for
// pagination), `entries` is the requested page (newest first, since LPUSH
// prepends). Unlike appendAuditEntry, a read failure DOES throw
// (AuditLogUnavailableError) -- silently showing an empty audit log when
// the store is actually broken would hide a real problem from the one
// place (Owner-only) that's supposed to catch it.
export async function listAuditEntries(tenantId, { entity, actorId, from, to, result, limit = 50, offset = 0 } = {}) {
  assertKnownTenantId(tenantId, 'listAuditEntries')
  const client = getClient()
  if (!client) throw new AuditLogUnavailableError('audit log is not configured')

  let raw
  try {
    const key = await resolveListReadKey(client, { v1Key: AUDIT_LOG_KEY, v2Key: auditLogKeyV2(tenantId), tenantId })
    raw = key ? await client.lrange(key, 0, MAX_ENTRIES - 1) : []
  } catch (err) {
    throw new AuditLogUnavailableError(`audit log unreachable: ${err.message}`)
  }

  const fromMs = from ? new Date(from).getTime() : null
  const toMs = to ? new Date(to).getTime() : null

  const filtered = (raw ?? [])
    .map(parseEntry)
    .filter(Boolean)
    .filter(e => !entity || e.entity === entity)
    .filter(e => !actorId || e.actorId === actorId)
    .filter(e => !result || e.result === result)
    .filter(e => fromMs === null || new Date(e.at).getTime() >= fromMs)
    .filter(e => toMs === null || new Date(e.at).getTime() <= toMs)

  return {
    entries: filtered.slice(offset, offset + limit),
    total: filtered.length,
  }
}
