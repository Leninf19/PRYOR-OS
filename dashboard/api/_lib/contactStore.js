// The seam between the Restaurant Contacts settings page and however
// contact configuration is actually stored (Phase 8, Milestone 8.3) --
// same role as actionStore.js's seam over the Action Center workspace, and
// deliberately copies its shape: a single Upstash Redis hash
// (CONTACT_DIRECTORY_KEY), one field per location, keyed by the canonical
// numeric location_id (the same id every review already carries as
// locationId -- see export_chunks.py's review_to_dict()), value a JSON
// record. Callers never touch Redis directly.
//
// This replaces the old edit-reviews.db -> export_chunks.py ->
// commit -> deploy cycle for changing a restaurant contact -- see README
// "Restaurant Contacts Store" for the full boundary and the legacy
// locationContacts.js/location-contacts.json fallback path this store
// supersedes (Milestone 8.5).
//
// Server-authoritative fields (createdBy/createdAt/updatedBy/updatedAt/
// history) are computed ONLY in upsertContact() below, from the caller's
// authenticated account and the server clock -- never from client input.
// The API layer (dashboard/api/settings/[action].js) is responsible for
// stripping/rejecting any client-supplied value for those fields before
// calling upsertContact(), the same division of labor actionStore.js's own
// header comment describes for its own callers.
//
// Node-only: @upstash/redis has no Edge-runtime constraint here (unlike
// accountStore.js/accounts.js, this is never imported from
// dashboard/middleware.js).

import { Redis } from '@upstash/redis'
import { contactsKeyV2 } from './tenantKeys.js'
import { resolveHashReadKey, resolveHashWriteKey } from './tenantDualRead.js'

const CONTACT_DIRECTORY_KEY = 'restaurant_contacts:v1'

// Multi-Tenant Phase 2: every exported function below now takes `tenantId`
// as its first argument -- see tenantDualRead.js's header for the full
// read/write rule. For DEFAULT_TENANT_ID, this resolves to exactly
// CONTACT_DIRECTORY_KEY, unchanged.

let redisClient = null
// Test-only seam: lets tests simulate a real Upstash hash's get/set
// behavior (including outages) without a real Upstash account or fragile
// REST-protocol mocking -- same pattern as actionStore.js's
// _setRedisClientForTests.
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class ContactStoreUnavailableError extends Error {}

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

// Unlike rateLimit.js, this store never "fails open" -- there is no safe
// fake success for a write, and an empty contact list is a harmless,
// honest degraded-read result. Missing config or an unreachable Redis both
// surface as ContactStoreUnavailableError; the API layer maps that to a
// 503, always.
function parseRecord(value) {
  if (value == null) return null
  if (typeof value === 'object') return value // @upstash/redis may already deserialize JSON values
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// Returns { [locationId]: record }. An unconfigured/unreachable store
// throws rather than returning {} -- silently presenting "no contacts
// configured" when the store is actually broken would hide a real
// data-loss-shaped failure from every viewer at once.
export async function getAllContacts(tenantId) {
  const client = getClient()
  if (!client) throw new ContactStoreUnavailableError('contact store is not configured')

  let raw
  try {
    const key = await resolveHashReadKey(client, { v1Key: CONTACT_DIRECTORY_KEY, v2Key: contactsKeyV2(tenantId), tenantId })
    raw = key ? await client.hgetall(key) : {}
  } catch (err) {
    throw new ContactStoreUnavailableError(`contact store unreachable: ${err.message}`)
  }

  const out = {}
  for (const [locationId, value] of Object.entries(raw ?? {})) {
    const record = parseRecord(value)
    if (record) out[locationId] = record
  }
  return out
}

// Reads a single location's contact without fetching the whole directory --
// used by the restaurant-email workflow (via locationContacts.js,
// Milestone 8.5) and by the Manager-scoped single-location read.
export async function getContact(tenantId, locationId) {
  const client = getClient()
  if (!client) throw new ContactStoreUnavailableError('contact store is not configured')

  let raw
  try {
    const key = await resolveHashReadKey(client, { v1Key: CONTACT_DIRECTORY_KEY, v2Key: contactsKeyV2(tenantId), tenantId })
    raw = key ? await client.hget(key, String(locationId)) : null
  } catch (err) {
    throw new ContactStoreUnavailableError(`contact store unreachable: ${err.message}`)
  }
  return parseRecord(raw)
}

// Merges `patch` (already validated/whitelisted by the caller) into the
// record for `locationId`, stamping server-authoritative fields:
//   - createdBy/createdAt: set once, from the first write, never overwritten
//   - updatedBy/updatedAt: set on every write, from the CURRENT caller/clock
//   - history: append-only; a new { at, by, action } entry is added only
//     when `logAction` is passed -- mirrors actionStore.js's upsertAction()
//     exactly, including the field-spread order (patch is spread BEFORE
//     these fields, so a client-supplied value for any of them is always
//     overwritten here even if it slipped past the API layer's allowlist).
//
// `account` is the authenticated, server-verified account record (from
// requireAuth()) -- never a client-supplied identity.
export async function upsertContact(tenantId, locationId, patch, account, logAction) {
  const client = getClient()
  if (!client) throw new ContactStoreUnavailableError('contact store is not configured')

  const field = String(locationId)
  let existingRaw = null
  try {
    const readKey = await resolveHashReadKey(client, { v1Key: CONTACT_DIRECTORY_KEY, v2Key: contactsKeyV2(tenantId), tenantId })
    if (readKey) existingRaw = await client.hget(readKey, field)
  } catch (err) {
    throw new ContactStoreUnavailableError(`contact store unreachable: ${err.message}`)
  }
  const existing = parseRecord(existingRaw)
  const now = new Date().toISOString()
  const history = existing?.history ?? []
  const actorName = account.displayName ?? account.email

  const next = {
    locationName: null,
    managerName: null,
    primaryEmail: null,
    ccEmails: [],
    active: true,
    ...existing,
    ...patch,
    locationId: Number(locationId),
    createdBy: existing?.createdBy ?? account.userId,
    createdAt: existing?.createdAt ?? now,
    updatedBy: account.userId,
    updatedAt: now,
    history: logAction
      ? [...history, { at: now, by: actorName, action: logAction }]
      : history,
  }

  const writeKey = resolveHashWriteKey({ v1Key: CONTACT_DIRECTORY_KEY, v2Key: contactsKeyV2(tenantId), tenantId })
  try {
    await client.hset(writeKey, { [field]: JSON.stringify(next) })
  } catch (err) {
    throw new ContactStoreUnavailableError(`contact store unreachable: ${err.message}`)
  }
  return next
}

// Genuine removal (Delete Contact) -- distinct from the Disable/Enable
// toggle, which is just a normal upsertContact({ active: false/true }) so
// the record (and its history) survives. Returns true if a record existed
// and was removed, false if there was nothing to delete.
export async function deleteContact(tenantId, locationId) {
  const client = getClient()
  if (!client) throw new ContactStoreUnavailableError('contact store is not configured')

  const writeKey = resolveHashWriteKey({ v1Key: CONTACT_DIRECTORY_KEY, v2Key: contactsKeyV2(tenantId), tenantId })
  try {
    const removed = await client.hdel(writeKey, String(locationId))
    return removed > 0
  } catch (err) {
    throw new ContactStoreUnavailableError(`contact store unreachable: ${err.message}`)
  }
}
