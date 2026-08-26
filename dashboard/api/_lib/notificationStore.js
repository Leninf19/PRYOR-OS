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

const REPLY_FAILURE_PREFIX = 'notif_reply_failed:v1:'
const READ_STATE_PREFIX = 'notif_read:v1:'
const SEEDED_PREFIX = 'notif_seeded:v1:'

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

export async function recordReplyFailure(reviewId, data) {
  const client = getClient()
  if (!client) return false
  try {
    await client.set(
      `${REPLY_FAILURE_PREFIX}${reviewId}`,
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
export async function clearReplyFailure(reviewId) {
  const client = getClient()
  if (!client) return false
  try {
    await client.del(`${REPLY_FAILURE_PREFIX}${reviewId}`)
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
export async function listReplyFailures() {
  const client = getClient()
  if (!client) return []
  let keys
  try {
    keys = await client.keys(`${REPLY_FAILURE_PREFIX}*`)
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

export async function getReadState(userId) {
  const client = getClient()
  if (!client) return {}
  try {
    return (await client.hgetall(`${READ_STATE_PREFIX}${userId}`)) ?? {}
  } catch (err) {
    console.error(`[notificationStore] getReadState failed for ${userId}: ${err.message}`)
    return {}
  }
}

// Marks every key in `eventKeys` read for `userId`, all in one round trip.
// Resets the hash's TTL on every write (see READ_STATE_TTL_SECONDS's own
// comment) rather than setting it once at creation, so an actively-reading
// user's state never quietly expires mid-use.
export async function markRead(userId, eventKeys) {
  if (!eventKeys.length) return true
  const client = getClient()
  if (!client) throw new NotificationStoreUnavailableError('notification store is not configured')
  const now = new Date().toISOString()
  const fields = Object.fromEntries(eventKeys.map(k => [k, now]))
  try {
    const key = `${READ_STATE_PREFIX}${userId}`
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
export async function hasBeenSeeded(userId) {
  const client = getClient()
  // Fails toward "already seeded" (skip seeding, fall through to normal
  // unread computation) rather than "not seeded" -- an outage must never
  // cause a real notification to be silently swallowed behind a bogus
  // one-time seeding pass. Worst case during an outage: a first-time user
  // sees today's backlog as unread once, which is the ORIGINAL (safe)
  // behavior this feature had before this fix, never a new failure mode.
  if (!client) return true
  try {
    return Boolean(await client.get(`${SEEDED_PREFIX}${userId}`))
  } catch (err) {
    console.error(`[notificationStore] hasBeenSeeded failed for ${userId}: ${err.message}`)
    return true
  }
}

export async function markSeeded(userId) {
  const client = getClient()
  if (!client) return false
  try {
    await client.set(`${SEEDED_PREFIX}${userId}`, '1')
    return true
  } catch (err) {
    console.error(`[notificationStore] markSeeded failed for ${userId}: ${err.message}`)
    return false
  }
}

export { REPLY_FAILURE_PREFIX, READ_STATE_PREFIX, SEEDED_PREFIX, REPLY_FAILURE_TTL_SECONDS, READ_STATE_TTL_SECONDS }
