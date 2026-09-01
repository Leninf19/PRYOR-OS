// Notification Center Audit & Fix -- the Redis-backed persistence layer for
// the two things this feature genuinely needs to STORE (everything else --
// critical/low-star reviews, assigned actions, GBP health -- is derived live
// from data that already exists elsewhere; see notificationEvents.js):
//
//   1. Reply-failure events (a publish attempt that failed and needs a
//      retry) -- one JSON key per review, keyed by the SAME canonical
//      reviewId() formula this file re-derives (see its own comment below
//      for why it isn't imported from dataUtils.js). Written additively by
//      google/[action].js's publish() on failure/success; never written by
//      this feature's own read paths.
//   2. Per-user read/unread state -- one Redis HASH per user, field =
//      the notification's stable event key, value = the ISO timestamp it
//      was marked read. Durable (survives refresh/browser/device, unlike
//      localStorage) and genuinely per-user (Owner reading a notification
//      never marks it read for anyone else).
//
// Same client/test-seam pattern as every other Redis-backed store in this
// codebase (actionStore.js, auditLog.js, publishBridgeStore.js): a plain
// @upstash/redis client, lazily constructed, swappable in tests via
// _setRedisClientForTests.

import { Redis } from '@upstash/redis'
import { notifReplyFailureKeyV2, notifReadStateKeyV2, notifSeededKeyV2 } from './tenantKeys.js'
import {
  resolveIndividualStringReadKey, resolveIndividualHashReadKey, resolveIndividualWriteKey,
  isLegacyAuthoritative, assertKnownTenantId,
} from './tenantDualRead.js'

const REPLY_FAILURE_PREFIX = 'notif_reply_failed:v1:'
const READ_STATE_PREFIX = 'notif_read:v1:'
const SEEDED_PREFIX = 'notif_seeded:v1:'

// Multi-Tenant Phase 2: every exported function below now takes `tenantId`
// as its first argument. Unlike the hash-shaped stores, each record here
// is its OWN individually-keyed Redis key (a string or a per-user hash),
// not one shared hash for the whole store -- so dual-read/write resolution
// happens per call, via resolveIndividualStringReadKey/
// resolveIndividualHashReadKey/resolveIndividualWriteKey, using the v1
// prefix + userId/reviewId exactly as today for DEFAULT_TENANT_ID.

// Retention (see the milestone report for the full reasoning): 30 days.
// Review-based notifications (critical/low-star) are bounded by a date
// filter applied when the candidate list is built (notificationEvents.js),
// not by anything stored here. Reply-failure records get an actual Redis
// TTL, below. Read-state hashes get their OWN, slightly longer TTL (35
// days, refreshed on every write) purely so an active user's read markers
// don't expire out from under still-visible 30-day-old notifications --
// the 5-day margin is not a second retention policy, just slack against
// the "read state must outlive what it marks" ordering requirement.
const REPLY_FAILURE_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days
const READ_STATE_TTL_SECONDS = 60 * 60 * 24 * 35 // 35 days

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class NotificationStoreUnavailableError extends Error {}

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
  if (typeof value === 'object') return value // @upstash/redis may already deserialize JSON values
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// --- Reply-failure events ---------------------------------------------------
//
// Best-effort by design (matches google/[action].js's own existing
// tolerance for publishBridgeStore/auditLog write failures): a notification
// record failing to write must never turn an already-completed Google
// publish, or an already-reported publish failure, into a harder error for
// the caller. Every function here returns a boolean success flag rather
// than throwing, so the endpoint's caller can log-and-continue.

export async function recordReplyFailure(tenantId, reviewId, data) {
  assertKnownTenantId(tenantId, 'recordReplyFailure')
  const client = getClient()
  if (!client) return false
  const writeKey = resolveIndividualWriteKey({
    v1Key: `${REPLY_FAILURE_PREFIX}${reviewId}`, v2Key: notifReplyFailureKeyV2(tenantId, reviewId), tenantId,
  })
  try {
    await client.set(
      writeKey,
      JSON.stringify({ reviewId, ...data, failedAt: new Date().toISOString() }),
      { ex: REPLY_FAILURE_TTL_SECONDS }
    )
    return true
  } catch (err) {
    console.error(`[notificationStore] recordReplyFailure failed for ${reviewId}: ${err.message}`)
    return false
  }
}

// Called on a SUBSEQUENT successful publish for the same review -- clears
// the failure notification so a resolved issue doesn't keep nagging.
export async function clearReplyFailure(tenantId, reviewId) {
  assertKnownTenantId(tenantId, 'clearReplyFailure')
  const client = getClient()
  if (!client) return false
  const writeKey = resolveIndividualWriteKey({
    v1Key: `${REPLY_FAILURE_PREFIX}${reviewId}`, v2Key: notifReplyFailureKeyV2(tenantId, reviewId), tenantId,
  })
  try {
    await client.del(writeKey)
    return true
  } catch (err) {
    console.error(`[notificationStore] clearReplyFailure failed for ${reviewId}: ${err.message}`)
    return false
  }
}

// Bounded KEYS scan -- the exact same accepted, reasoned pattern
// gbp_reply_bridge_reconcile.py's list_bridge_keys() and
// publishBridgeStore.js already use for their own small, TTL-bounded
// keyspaces: reply failures are rare BY DESIGN (only genuinely actionable
// publish failures ever get recorded here, never routine traffic), so this
// keyspace can never grow large enough for a KEYS scan to be the
// anti-pattern it usually is. Returns [] (never throws) when the store is
// unavailable -- a degraded notification feed is acceptable; a broken page
// is not.
// Note: unlike every other function in this file, this one scans an
// entire prefix rather than resolving one specific key, so the generic
// per-key resolver functions don't apply cleanly here. It uses
// isLegacyAuthoritative() -- the SAME migration-mode source of truth every
// other resolver in this file delegates to -- to pick the prefix, so this
// scan can never disagree with where recordReplyFailure()/clearReplyFailure()
// actually wrote: exactly today's v1 prefix for DEFAULT_TENANT_ID (its
// LEGACY mode, unchanged behavior), or this tenant's own v2 prefix
// otherwise (CUTOVER mode). A tenant can still never see another tenant's
// keys, which is the isolation guarantee that actually matters here.
export async function listReplyFailures(tenantId) {
  assertKnownTenantId(tenantId, 'listReplyFailures')
  const client = getClient()
  if (!client) return []
  const prefix = isLegacyAuthoritative(tenantId)
    ? REPLY_FAILURE_PREFIX
    : `notif_reply_failed:v2:${tenantId}:` // matches notifReplyFailureKeyV2's own format, minus the reviewId segment
  let keys
  try {
    keys = await client.keys(`${prefix}*`)
  } catch (err) {
    console.error(`[notificationStore] listReplyFailures keys() failed: ${err.message}`)
    return []
  }
  if (!keys.length) return []
  let values
  try {
    values = await client.mget(...keys)
  } catch (err) {
    console.error(`[notificationStore] listReplyFailures mget() failed: ${err.message}`)
    return []
  }
  return values.map(parseRecord).filter(Boolean)
}

// --- Per-user read state -----------------------------------------------------

export async function getReadState(tenantId, userId) {
  assertKnownTenantId(tenantId, 'getReadState')
  const client = getClient()
  if (!client) return {}
  try {
    const key = await resolveIndividualHashReadKey(client, {
      v1Key: `${READ_STATE_PREFIX}${userId}`, v2Key: notifReadStateKeyV2(tenantId, userId), tenantId,
    })
    if (!key) return {}
    return (await client.hgetall(key)) ?? {}
  } catch (err) {
    console.error(`[notificationStore] getReadState failed for ${userId}: ${err.message}`)
    return {}
  }
}

// Marks every key in `eventKeys` read for `userId`, all in one round trip.
// Resets the hash's TTL on every write (see READ_STATE_TTL_SECONDS's own
// comment) rather than setting it once at creation, so an actively-reading
// user's state never quietly expires mid-use.
export async function markRead(tenantId, userId, eventKeys) {
  assertKnownTenantId(tenantId, 'markRead')
  if (!eventKeys.length) return true
  const client = getClient()
  if (!client) throw new NotificationStoreUnavailableError('notification store is not configured')
  const now = new Date().toISOString()
  const fields = Object.fromEntries(eventKeys.map(k => [k, now]))
  const key = resolveIndividualWriteKey({
    v1Key: `${READ_STATE_PREFIX}${userId}`, v2Key: notifReadStateKeyV2(tenantId, userId), tenantId,
  })
  try {
    await client.hset(key, fields)
    await client.expire(key, READ_STATE_TTL_SECONDS)
    return true
  } catch (err) {
    throw new NotificationStoreUnavailableError(`notification store unreachable: ${err.message}`)
  }
}

// --- First-open backlog seeding ---------------------------------------------
//
// Rollout-backlog fix: without this, a user's FIRST-EVER visit to the
// Notification Center would see every currently-in-scope notification
// (up to REVIEW_NOTIFICATION_RETENTION_DAYS worth of pre-existing,
// already-known-about unanswered low-star/critical reviews) reported as
// unread all at once, purely because their read-state hash starts empty --
// a backlog dump, not a stream of new events, and the opposite of "focus on
// genuinely actionable events rather than creating noise."
//
// `notif_seeded:v1:<userId>` is a permanent (no TTL) marker set the first
// time dashboard/api/notifications/[action].js's list() runs for a given
// user, regardless of how many candidates existed at that moment. Once set,
// it never needs to be checked again for that user -- every notification
// that becomes true AFTER their first visit is a genuinely new key that was
// never in their read-state, so it correctly reports as unread on a later
// request. No TTL: re-seeding an existing user after an accidental
// expiry would silently reproduce the exact backlog-dump this exists to
// prevent, so this is deliberately NOT time-bounded the way reply-failure
// records or read-state hashes are.
export async function hasBeenSeeded(tenantId, userId) {
  assertKnownTenantId(tenantId, 'hasBeenSeeded')
  const client = getClient()
  // Fails toward "already seeded" (skip seeding, fall through to normal
  // unread computation) rather than "not seeded" -- an outage must never
  // cause a real notification to be silently swallowed behind a bogus
  // one-time seeding pass. Worst case during an outage: a first-time user
  // sees today's backlog as unread once, which is the ORIGINAL (safe)
  // behavior this feature had before this fix, never a new failure mode.
  if (!client) return true
  try {
    const key = await resolveIndividualStringReadKey(client, {
      v1Key: `${SEEDED_PREFIX}${userId}`, v2Key: notifSeededKeyV2(tenantId, userId), tenantId,
    })
    if (!key) return false
    return Boolean(await client.get(key))
  } catch (err) {
    console.error(`[notificationStore] hasBeenSeeded failed for ${userId}: ${err.message}`)
    return true
  }
}

export async function markSeeded(tenantId, userId) {
  assertKnownTenantId(tenantId, 'markSeeded')
  const client = getClient()
  if (!client) return false
  const key = resolveIndividualWriteKey({
    v1Key: `${SEEDED_PREFIX}${userId}`, v2Key: notifSeededKeyV2(tenantId, userId), tenantId,
  })
  try {
    await client.set(key, '1')
    return true
  } catch (err) {
    console.error(`[notificationStore] markSeeded failed for ${userId}: ${err.message}`)
    return false
  }
}

export { REPLY_FAILURE_PREFIX, READ_STATE_PREFIX, SEEDED_PREFIX, REPLY_FAILURE_TTL_SECONDS, READ_STATE_TTL_SECONDS }
