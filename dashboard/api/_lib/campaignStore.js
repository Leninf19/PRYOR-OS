// Operations Calendar + Content Library milestone -- the durable store for
// Campaigns, the single shared entity Calendar (promotion/deadline tasks
// via `campaignId`) and Content (asset grouping) both reference. Neither
// side stores its own copy of campaign name/dates/locations -- see
// campaignAssetStore.js and taskStore.js's own `campaignId` field.
//
// Same Redis-hash-of-JSON pattern as actionStore.js/taskStore.js.

import { Redis } from '@upstash/redis'
import { randomUUID } from 'crypto'

const CAMPAIGN_KEY = 'content_campaigns:v1'

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

export async function getAllCampaigns() {
  const client = getClient()
  if (!client) throw new CampaignStoreUnavailableError('campaign store is not configured')
  let raw
  try {
    raw = await client.hgetall(CAMPAIGN_KEY)
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

export async function getCampaign(id) {
  const client = getClient()
  if (!client) throw new CampaignStoreUnavailableError('campaign store is not configured')
  let raw
  try {
    raw = await client.hget(CAMPAIGN_KEY, id)
  } catch (err) {
    throw new CampaignStoreUnavailableError(`campaign store unreachable: ${err.message}`)
  }
  return parseRecord(raw)
}

export async function createCampaign(fields, account) {
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

  try {
    await client.hset(CAMPAIGN_KEY, { [id]: JSON.stringify(record) })
  } catch (err) {
    throw new CampaignStoreUnavailableError(`campaign store unreachable: ${err.message}`)
  }
  return record
}

export async function updateCampaign(id, patch, account) {
  const client = getClient()
  if (!client) throw new CampaignStoreUnavailableError('campaign store is not configured')

  const existing = await getCampaign(id)
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

  try {
    await client.hset(CAMPAIGN_KEY, { [id]: JSON.stringify(next) })
  } catch (err) {
    throw new CampaignStoreUnavailableError(`campaign store unreachable: ${err.message}`)
  }
  return next
}

export async function deleteCampaign(id) {
  const client = getClient()
  if (!client) throw new CampaignStoreUnavailableError('campaign store is not configured')
  try {
    const removed = await client.hdel(CAMPAIGN_KEY, id)
    return removed > 0
  } catch (err) {
    throw new CampaignStoreUnavailableError(`campaign store unreachable: ${err.message}`)
  }
}
