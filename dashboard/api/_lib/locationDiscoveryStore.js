// Multi-Tenant Phase 4E Revision -- short-lived, trusted discovery-session
// records. The self-service activation transaction is:
//   authenticated Owner -> server derives tenantId from session
//   -> tenant's own Google OAuth credential -> discover GBP locations
//   using that credential -> Owner reviews/selects locations -> server
//   validates the selected locations came from THAT TENANT'S discovery
//   result -> write approved locations to the tenant's own config/catalog
//   -> mark that tenant's location catalog active.
// The record created here is what makes the validation step possible: it
// binds a Google-location-discovery result to the tenant and user that
// produced it, so approveLocations() (google/[action].js) can check "did
// PRYOR itself just discover these exact location ids for this exact
// tenant" instead of trusting whatever list the browser sends back. A
// client must never be able to submit arbitrary Google location ids and
// thereby claim them -- this store is what closes that gap.
//
// Mirrors tokenStore.js's raw-token + SHA-256-hashed-key + Redis TTL
// pattern exactly (same security model: a 32-byte crypto.randomBytes()
// value is generated, returned to the caller once, and only its SHA-256
// hash is ever used as the Redis key -- a raw dump of Redis contents never
// reveals a usable session id on its own).
//
// Deliberately NOT single-use/consumed-on-read: re-viewing a discovery
// result before approving (e.g. the Owner navigating back and forth) must
// not burn it. What actually matters for this record's security
// guarantees is tenant-binding and expiration (see getDiscoverySession()'s
// contract below), not consumption semantics -- there is no meaningful
// harm in reading the SAME tenant's own still-valid discovery result
// twice, unlike an invite/reset token, which grants an irreversible
// account mutation on first use.

import { randomBytes, createHash } from 'crypto'
import { Redis } from '@upstash/redis'

const DISCOVERY_SESSION_TTL_SECONDS = 600 // 10 minutes: long enough for an Owner to review a location list, short enough to bound replay/staleness risk

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class LocationDiscoveryStoreUnavailableError extends Error {}

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

function hashSessionId(rawId) {
  return createHash('sha256').update(rawId, 'utf8').digest('hex')
}

function keyFor(hash) {
  return `location_discovery_session:v1:${hash}`
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

// discoveredLocations: [{ googleLocationId, title, address }] -- exactly
// what discoverLocations() (google/[action].js) just fetched from Google,
// before any human review. tenantId/userId MUST be server-derived by the
// caller from the authenticated session (resolveTenantId(account),
// account.userId) -- never accepted from request input; this function
// does not and cannot verify that on its own.
export async function createDiscoverySession({ tenantId, userId, discoveredLocations }) {
  if (typeof tenantId !== 'string' || !tenantId) throw new TypeError('createDiscoverySession: tenantId is required')
  if (typeof userId !== 'string' || !userId) throw new TypeError('createDiscoverySession: userId is required')
  if (!Array.isArray(discoveredLocations)) throw new TypeError('createDiscoverySession: discoveredLocations must be an array')
  const client = getClient()
  if (!client) throw new LocationDiscoveryStoreUnavailableError('location discovery store is not configured')

  const rawId = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + DISCOVERY_SESSION_TTL_SECONDS * 1000).toISOString()
  const record = { tenantId, userId, discoveredLocations, createdAt: new Date().toISOString(), expiresAt }
  try {
    await client.set(keyFor(hashSessionId(rawId)), JSON.stringify(record), { ex: DISCOVERY_SESSION_TTL_SECONDS })
  } catch (err) {
    throw new LocationDiscoveryStoreUnavailableError(`location discovery store unreachable: ${err.message}`)
  }
  return { discoverySessionId: rawId, expiresAt, discoveredLocations }
}

// Returns the record, or null if it doesn't exist, has expired, or is
// malformed -- never throws for a bad/expired/unknown id, matching this
// codebase's "fail closed, never crash" convention on lookup paths. The
// `expiresAt` check here is deliberately independent of Redis's own `ex`
// TTL (belt-and-suspenders, and what makes the expiration behavior
// reliably testable against a fake Redis mock that doesn't implement TTL
// eviction).
//
// SECURITY CONTRACT: this function only proves "a discovery session with
// this id was recently created by someone, for some tenant." Callers
// (approveLocations()) MUST independently compare `record.tenantId`
// against the CURRENTLY AUTHENTICATED, server-derived tenantId before
// trusting anything else in the record -- this is what makes a Tenant A
// discovery session unusable under a Tenant B session even if the raw id
// were somehow guessed or leaked.
export async function getDiscoverySession(rawId) {
  if (typeof rawId !== 'string' || !rawId) return null
  const client = getClient()
  if (!client) return null
  let raw
  try {
    raw = await client.get(keyFor(hashSessionId(rawId)))
  } catch (err) {
    console.error(`[locationDiscoveryStore] could not read discovery session: ${err.message}`)
    return null
  }
  const record = parseRecord(raw)
  if (!record) return null
  if (!record.expiresAt || new Date(record.expiresAt).getTime() < Date.now()) return null
  return record
}
