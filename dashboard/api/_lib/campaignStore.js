// Operations Calendar + Content Library milestone -- the durable store for
// Campaigns, the single shared entity Calendar (promotion/deadline tasks
// via `campaignId`) and Content (asset grouping) both reference. Neither
// side stores its own copy of campaign name/dates/locations -- see
// campaignAssetStore.js and taskStore.js's own `campaignId` field.
//
// Same Redis-hash-of-JSON pattern as actionStore.js/taskStore.js.

import { Redis } from '@upstash/redis'
import { randomUUID } from 'crypto'
import { campaignsKeyV2 } from './tenantKeys.js'
import { resolveHashReadKey, resolveHashWriteKey } from './tenantDualRead.js'

const CAMPAIGN_KEY = 'content_campaigns:v1'

// Multi-Tenant Phase 2: every exported function below (except
// generateCampaignId, which touches no store) now takes `tenantId` as its
// first argument -- see tenantDualRead.js's header for the full read/write
// rule. For DEFAULT_TENANT_ID, this resolves to exactly CAMPAIGN_KEY,
// unchanged.

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class CampaignStoreUnavailableError extends Error {}

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

export function generateCampaignId() {
  return `campaign_${randomUUID()}`
}

export async function getAllCampaigns(tenantId) {
  const client = getClient()
  if (!client) throw new CampaignStoreUnavailableError('campaign store is not configured')
  let raw
  try {
    const key = await resolveHashReadKey(client, { v1Key: CAMPAIGN_KEY, v2Key: campaignsKeyV2(tenantId), tenantId })
    raw = key ? await client.hgetall(key) : {}
  } catch (err) {
    throw new CampaignStoreUnavailableError(`campaign store unreachable: ${err.message}`)
  }
  const out = {}
  for (const [id, value] of Object.entries(raw ?? {})) {
    const record = parseRecord(value)
    if (record) out[id] = record
  }
  return out
}

export async function getCampaign(tenantId, id) {
  const client = getClient()
  if (!client) throw new CampaignStoreUnavailableError('campaign store is not configured')
  let raw
  try {
    const key = await resolveHashReadKey(client, { v1Key: CAMPAIGN_KEY, v2Key: campaignsKeyV2(tenantId), tenantId })
    raw = key ? await client.hget(key, id) : null
  } catch (err) {
    throw new CampaignStoreUnavailableError(`campaign store unreachable: ${err.message}`)
  }
  return parseRecord(raw)
}

export async function createCampaign(tenantId, fields, account) {
  const client = getClient()
  if (!client) throw new CampaignStoreUnavailableError('campaign store is not configured')

  const id = generateCampaignId()
  const now = new Date().toISOString()
  const record = {
    id,
    name: fields.name,
    description: fields.description ?? '',
    startDate: fields.startDate ?? null,
    endDate: fields.endDate ?? null,
    locationIds: fields.locationIds,
    status: 'Draft',
    tags: Array.isArray(fields.tags) ? fields.tags : [],
    createdBy: account.userId,
    createdAt: now,
    updatedBy: account.userId,
    updatedAt: now,
  }

  const writeKey = resolveHashWriteKey({ v1Key: CAMPAIGN_KEY, v2Key: campaignsKeyV2(tenantId), tenantId })
  try {
    await client.hset(writeKey, { [id]: JSON.stringify(record) })
  } catch (err) {
    throw new CampaignStoreUnavailableError(`campaign store unreachable: ${err.message}`)
  }
  return record
}

export async function updateCampaign(tenantId, id, patch, account) {
  const client = getClient()
  if (!client) throw new CampaignStoreUnavailableError('campaign store is not configured')

  const existing = await getCampaign(tenantId, id)
  if (!existing) return null

  const next = {
    ...existing,
    ...patch,
    id,
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
    updatedBy: account.userId,
    updatedAt: new Date().toISOString(),
  }

  const writeKey = resolveHashWriteKey({ v1Key: CAMPAIGN_KEY, v2Key: campaignsKeyV2(tenantId), tenantId })
  try {
    await client.hset(writeKey, { [id]: JSON.stringify(next) })
  } catch (err) {
    throw new CampaignStoreUnavailableError(`campaign store unreachable: ${err.message}`)
  }
  return next
}

export async function deleteCampaign(tenantId, id) {
  const client = getClient()
  if (!client) throw new CampaignStoreUnavailableError('campaign store is not configured')
  const writeKey = resolveHashWriteKey({ v1Key: CAMPAIGN_KEY, v2Key: campaignsKeyV2(tenantId), tenantId })
  try {
    const removed = await client.hdel(writeKey, id)
    return removed > 0
  } catch (err) {
    throw new CampaignStoreUnavailableError(`campaign store unreachable: ${err.message}`)
  }
}
