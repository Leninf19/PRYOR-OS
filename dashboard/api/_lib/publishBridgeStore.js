// Recovery Milestone 6B, Part 1: the durable server-side bridge between "a
// Confirm & Publish reply reached Google" and "the next GBP sync writes
// owner_response into reviews.db". Proven necessary by Milestone 6A's
// production diagnostic: /api/google/publish's success path previously
// wrote nothing durable anywhere, so the only record of a successful
// publish was one browser's localStorage -- invisible to any other
// browser/device, and to the app itself after that storage was cleared.
//
// Backed by the SAME Upstash Redis instance actionStore.js/credentialStore.js/
// rateLimit.js already use -- no second datastore. One key per review
// (not a shared hash like actionStore.js) because each record needs its
// own TTL (see BRIDGE_TTL_SECONDS below), and Redis hash-field TTLs
// (HEXPIRE) aren't something to depend on here.
//
// Key is the app's own canonical per-review id (dashboard/src/utils/
// dataUtils.js's reviewId(r): review_id || review_url || `${date}-${name}`)
// -- the SAME id useReviewWorkspace already keys localStorage by. The
// frontend sends this value as `localReviewId` in the publish request body
// (it's the only thing that reliably identifies "which review" the way the
// rest of the app already does; a review's local id and its gbp_review_name
// are two different identities and both matter here -- see writePublishBridge).
//
// Node-only, same as actionStore.js.

import { Redis } from '@upstash/redis'

const KEY_PREFIX = 'publish_bridge:v1:'

// Recovery Milestone 6B, Part 6 (lifecycle/cleanup): the fast reconciliation
// job (gbp_reply_bridge_reconcile.py, run every 15 minutes alongside
// critical-alert-check.yml) actively deletes a record the moment Google
// confirms the reply and reviews.db is updated -- that is the NORMAL path
// out of existence for almost every record, usually within minutes.
//
// This TTL is the safety-net backstop for the abnormal path: the
// reconciliation job doesn't run, can't reach this specific review, or the
// review can never resolve for some other reason. 48 hours was chosen
// because it is comfortably longer than every sync interval in this
// system (the frequent fast reconciliation runs every 15 minutes; the
// full sync that would independently reconcile the same data runs every
// 6 hours and "GitHub may delay scheduled runs under load" per
// update-reviews.yml's own cron comment) -- 48h absorbs a full day of
// delayed/skipped runs with room to spare, without leaving a permanently
// stale bridge record around for a review that will never resolve (e.g.
// Google's own API becoming permanently unreachable for that one review).
// A record's mere expiry can NEVER turn an already-answered review back
// into Needs Reply -- see replyState.js's computeReplyState(): once
// owner_response exists, that alone is sufficient, with or without a
// bridge record.
const BRIDGE_TTL_SECONDS = 60 * 60 * 48

let redisClient = null
// Test-only seam, identical in spirit to actionStore.js's -- lets tests
// simulate Redis get/set/mget/del (including outages) without a real
// Upstash account. Never used by production code paths.
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class PublishBridgeUnavailableError extends Error {}

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

function keyFor(localReviewId) {
  return `${KEY_PREFIX}${localReviewId}`
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

// Called ONLY after Google has already confirmed the reply succeeded (see
// [action].js's publish() -- this must never be called before that).
// Stores exactly the fields Part 7's reconciliation and Part 3's reply-state
// priority need -- no OAuth tokens, no unrelated customer data. `responseText`
// is the actual restaurant reply (legitimately needed so the frontend can
// keep showing it before Google's own copy has synced back) -- callers
// (Part 12) are responsible for never logging it.
export async function writePublishBridge(localReviewId, {
  gbpReviewName, responseText, locationName, reviewerName, reviewDate,
}) {
  const client = getClient()
  if (!client) throw new PublishBridgeUnavailableError('publish bridge store is not configured')

  const record = {
    localReviewId,
    gbpReviewName: gbpReviewName ?? null,
    responseText,
    publishedAt: new Date().toISOString(),
    source: 'future_insights',
    status: 'pending_google_reconciliation',
    locationName: locationName ?? null,
    reviewerName: reviewerName ?? null,
    reviewDate: reviewDate ?? null,
  }

  try {
    await client.set(keyFor(localReviewId), JSON.stringify(record), { ex: BRIDGE_TTL_SECONDS })
  } catch (err) {
    throw new PublishBridgeUnavailableError(`publish bridge store unreachable: ${err.message}`)
  }
  return record
}

// Bulk lookup -- Part 5 explicitly requires this over one call per review.
// Returns { [localReviewId]: record } for only the ids that currently have
// a live bridge record; ids with none are simply absent from the result
// (not an error -- "no bridge" is the overwhelmingly common case).
export async function getPublishBridges(localReviewIds) {
  const client = getClient()
  if (!client) throw new PublishBridgeUnavailableError('publish bridge store is not configured')
  if (!localReviewIds.length) return {}

  let raws
  try {
    raws = await client.mget(...localReviewIds.map(keyFor))
  } catch (err) {
    throw new PublishBridgeUnavailableError(`publish bridge store unreachable: ${err.message}`)
  }
  const out = {}
  localReviewIds.forEach((id, i) => {
    const record = parseRecord(raws[i])
    if (record) out[id] = record
  })
  return out
}

// Used only by the reconciliation job's Node-side counterpart today this
// store has no such caller (reconciliation runs in Python, see
// gbp_reply_bridge_reconcile.py, and talks to Redis directly via the same
// REST API) -- kept here for symmetry/completeness and for any future
// Node-side caller (e.g. an explicit "undo"/support action), and because a
// store module that can write but never explicitly delete is an easy way to
// accidentally end up leaning on the TTL as the ONLY cleanup path. Never
// throws on a missing key (deleting something already gone is a no-op, not
// an error).
export async function deletePublishBridge(localReviewId) {
  const client = getClient()
  if (!client) throw new PublishBridgeUnavailableError('publish bridge store is not configured')
  try {
    await client.del(keyFor(localReviewId))
  } catch (err) {
    throw new PublishBridgeUnavailableError(`publish bridge store unreachable: ${err.message}`)
  }
}
