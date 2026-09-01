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
