// Operations Calendar + Content Library milestone -- durable metadata store
// for Content Library assets. Binary content itself lives in Vercel Blob,
// PRIVATE access only (see api/content/[action].js) -- this store never
// holds file bytes, only the pointer (`blobPathname`) plus display/
// authorization metadata. Never store large binaries in Redis.
//
// Same Redis-hash-of-JSON pattern as actionStore.js/taskStore.js/
// campaignStore.js. At the asset volumes this app runs at (hundreds, not
// millions), hgetall + in-process filtering by campaignId/location/type is
// the same tradeoff actionStore.js's `list()` already makes -- simple,
// proven, no new database needed.

import { Redis } from '@upstash/redis'
import { randomUUID } from 'crypto'
import { contentAssetsKeyV2 } from './tenantKeys.js'
import { resolveHashReadKey, resolveHashWriteKey } from './tenantDualRead.js'

const ASSET_KEY = 'content_assets:v1'

// Multi-Tenant Phase 2: every exported function below (except
// generateAssetId, which touches no store) now takes `tenantId` as its
// first argument -- see tenantDualRead.js's header for the full read/write
// rule. For DEFAULT_TENANT_ID, this resolves to exactly ASSET_KEY,
// unchanged.

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class ContentAssetStoreUnavailableError extends Error {}

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

export function generateAssetId() {
  return `asset_${randomUUID()}`
}

export async function getAllAssets(tenantId) {
  const client = getClient()
  if (!client) throw new ContentAssetStoreUnavailableError('content asset store is not configured')
  let raw
  try {
    const key = await resolveHashReadKey(client, { v1Key: ASSET_KEY, v2Key: contentAssetsKeyV2(tenantId), tenantId })
    raw = key ? await client.hgetall(key) : {}
  } catch (err) {
    throw new ContentAssetStoreUnavailableError(`content asset store unreachable: ${err.message}`)
  }
  const out = {}
  for (const [id, value] of Object.entries(raw ?? {})) {
    const record = parseRecord(value)
    if (record) out[id] = record
  }
  return out
}

export async function getAsset(tenantId, id) {
  const client = getClient()
  if (!client) throw new ContentAssetStoreUnavailableError('content asset store is not configured')
  let raw
  try {
    const key = await resolveHashReadKey(client, { v1Key: ASSET_KEY, v2Key: contentAssetsKeyV2(tenantId), tenantId })
    raw = key ? await client.hget(key, id) : null
  } catch (err) {
    throw new ContentAssetStoreUnavailableError(`content asset store unreachable: ${err.message}`)
  }
  return parseRecord(raw)
}

// `fields` must already be validated by the caller (MIME/extension/size --
// see api/content/[action].js's validateUpload()). This store never
// re-derives or trusts a client-supplied blobPathname's authenticity beyond
// persisting it; the upload endpoint is the only writer.
export async function createAsset(tenantId, fields, account) {
  const client = getClient()
  if (!client) throw new ContentAssetStoreUnavailableError('content asset store is not configured')

  const id = generateAssetId()
  const now = new Date().toISOString()
  const record = {
    id,
    campaignId: fields.campaignId,
    type: fields.type,
    filename: fields.filename,
    mimeType: fields.mimeType,
    sizeBytes: fields.sizeBytes,
    blobPathname: fields.blobPathname,
    captionText: fields.captionText ?? null,
    uploadedBy: account.userId,
    uploadedAt: now,
  }

  const writeKey = resolveHashWriteKey({ v1Key: ASSET_KEY, v2Key: contentAssetsKeyV2(tenantId), tenantId })
  try {
    await client.hset(writeKey, { [id]: JSON.stringify(record) })
  } catch (err) {
    throw new ContentAssetStoreUnavailableError(`content asset store unreachable: ${err.message}`)
  }
  return record
}

export async function deleteAsset(tenantId, id) {
  const client = getClient()
  if (!client) throw new ContentAssetStoreUnavailableError('content asset store is not configured')
  const writeKey = resolveHashWriteKey({ v1Key: ASSET_KEY, v2Key: contentAssetsKeyV2(tenantId), tenantId })
  try {
    const removed = await client.hdel(writeKey, id)
    return removed > 0
  } catch (err) {
    throw new ContentAssetStoreUnavailableError(`content asset store unreachable: ${err.message}`)
  }
}

// "Make content safety ceiling race-safe" hardening (final pre-deploy
// review, item 2), REVISED per the follow-up review's own item 2 ("content
// upload lock must outlive the critical section"): a short-lived per-tenant
// mutex, the SAME atomic primitive (SET NX EX) pendingRegistrationStore.js's
// acquireTenantCreationLock() already uses for the analogous "read current
// state, decide, then write" race around tenant creation -- now with a
// RANDOM OWNERSHIP TOKEN (never a fixed '1') and a LEASE/HEARTBEAT model
// instead of one fixed TTL, so the lock cannot silently expire out from
// under a still-active critical section.
//
// WHY A LOCK, NOT AN ATOMIC COUNTER: the alternative (a separate Redis
// counter incremented atomically before the Blob write, decremented on
// rollback) introduces a SECOND source of truth for tenant usage that can
// drift from what getAllAssets() actually contains -- itself a durable
// correctness risk, and one that would need careful reconciliation on
// every asset delete, on a failed Blob write, and on process crashes
// between "reserve" and "write." A lock instead makes upload()'s EXISTING,
// already-correct read (getAllAssets) -> decide -> write sequence atomic AS
// A WHOLE, by construction -- no second data structure that could ever
// disagree with the real metadata.
//
// WHY A LEASE, NOT A SINGLE FIXED TTL: a fixed TTL is only safe if it is
// PROVABLY greater than the maximum possible execution time for this
// function -- a claim that can't be made with confidence across Vercel
// plans/configurations (Hobby vs Pro vs Fluid compute, whatever
// `maxDuration` a future change sets). A lease sidesteps needing that
// guarantee at all: the HOLDER actively renews it at a fraction of its own
// TTL while the critical section is still running (see
// content/[action].js's upload(), which renews on an interval and clears it
// in a `finally`), so the lock survives for exactly as long as the request
// is genuinely alive -- never merely "as long as a hardcoded number
// guessed correctly" -- and expires promptly (UPLOAD_LOCK_TTL_SECONDS
// after the LAST successful renewal) if the process genuinely crashes or
// hangs without ever calling clearInterval.
//
// OWNERSHIP TOKEN, not a fixed sentinel value: acquire() returns a fresh
// random token; renew() and release() both use an atomic Lua
// compare-then-act (GET, verify equality, THEN act) so a caller can only
// renew or release the SPECIFIC lease it was handed. This is what makes
// "an expired old request's lease was already reclaimed by someone else"
// safe: the old holder's token no longer matches whatever is currently
// stored (a different token, from a different acquire() call), so its
// stale release()/renew() calls are harmless no-ops -- structurally
// impossible for an old request to delete or extend a NEWER request's lock.
//
// FAIL-CLOSED: acquireContentUploadLock() throws ContentAssetStoreUnavailableError
// on a genuine store outage (never silently treated as "lock acquired");
// renewContentUploadLock() returns false on outage (the caller's own
// lockLost flag then refuses to proceed past that point, per "lock loss
// during the critical section must not silently allow the operation to
// proceed as if exclusivity still exists" -- see upload()'s own comment).
const UPLOAD_LOCK_TTL_SECONDS = 15
// Renews at roughly 1/3 of the TTL -- two consecutive renewal failures
// (e.g. a transient Redis blip) still leave a full TTL's worth of margin
// before the lease could actually expire.
export const UPLOAD_LOCK_RENEW_INTERVAL_MS = 5000

function uploadLockKey(tenantId) {
  return `content_upload_lock:v1:${tenantId}`
}

// Atomic compare-then-EXPIRE: only extends the TTL if the caller's token
// still matches what's currently stored -- a stale/superseded holder's
// renewal attempt is a harmless no-op, never able to extend a lease it no
// longer owns.
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`

// Atomic compare-then-DEL: only deletes if the caller's token still
// matches what's currently stored -- the exact primitive that makes "an
// expired old request must never delete a newer request's lock" true by
// construction (the classic distributed-lock correctness requirement).
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`

// Returns a fresh random ownership token on success, or null if another
// request already holds the lock. Throws ContentAssetStoreUnavailableError
// on a genuine store outage -- never silently returns a token for a lock
// that wasn't actually acquired.
export async function acquireContentUploadLock(tenantId) {
  const client = getClient()
  if (!client) throw new ContentAssetStoreUnavailableError('content asset store is not configured')
  const token = randomUUID()
  try {
    const result = await client.set(uploadLockKey(tenantId), token, { nx: true, ex: UPLOAD_LOCK_TTL_SECONDS })
    return result === 'OK' ? token : null
  } catch (err) {
    throw new ContentAssetStoreUnavailableError(`content asset store unreachable: ${err.message}`)
  }
}

// Extends the lease by UPLOAD_LOCK_TTL_SECONDS from now, ONLY if `token`
// still matches the current holder. Returns false (never throws) on
// either an outage or a lost lease -- the caller is responsible for
// treating a false return as "can no longer prove exclusivity" and
// refusing to proceed past that point (fail closed), not for retrying
// renewal itself.
export async function renewContentUploadLock(tenantId, token) {
  const client = getClient()
  if (!client) return false
  try {
    const result = await client.eval(RENEW_SCRIPT, [uploadLockKey(tenantId)], [token, String(UPLOAD_LOCK_TTL_SECONDS)])
    return result === 1 || result === true
  } catch (err) {
    console.error(`[contentAssetStore] failed to renew upload lock for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
    return false
  }
}

// Best-effort, but ownership-checked: deletes the lock ONLY if `token`
// still matches the current holder -- a call from a superseded/expired
// former holder (whose token no longer matches whatever is currently
// stored, if anything) is a harmless no-op, never capable of deleting a
// different, newer request's lease.
export async function releaseContentUploadLock(tenantId, token) {
  const client = getClient()
  if (!client) return // best-effort; an unconfigured store already failed loudly at acquire time
  try {
    await client.eval(RELEASE_SCRIPT, [uploadLockKey(tenantId)], [token])
  } catch (err) {
    console.error(`[contentAssetStore] failed to release upload lock for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
  }
}
