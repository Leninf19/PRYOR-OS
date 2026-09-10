// Multi-Tenant Phase 4Q -- the tenant-INDEPENDENT identity record for a
// self-service registrant between "submitted the registration form" and
// "a real tenant_config + user record exist." There is no tenant to scope
// this to yet, so it cannot live in userStore.js (every function there
// requires a tenantId). One Redis hash, pending_registrations:v1, keyed by
// NORMALIZED EMAIL -- email is the only stable identity a registrant has
// before a userId/tenantId are committed anywhere else.
//
// LIFECYCLE (see session/[action].js's register()/verify-email()/
// redeem-access-code()/select-plan() for the full state machine):
//   pending_verification -> verified_awaiting_plan -> creating_tenant -> completed
// A record's natural end state is DELETION (promoted into real
// tenantConfigStore.js/userStore.js records) -- this store never
// accumulates completed registrations. An abandoned record (never
// verified, or verified but never followed through) self-expires via a
// 7-day Redis TTL on the whole record; nothing here needs a cron sweep.
//
// SECURITY: passwordHash is written ONCE, at registration, using the
// existing bcrypt-cost-12 hashPassword() (password.js) -- never
// re-collected or re-hashed later. This store never holds a plaintext
// password at any point.
//
// CONCURRENCY: createPendingRegistration() uses HSETNX (atomic
// "set only if the field doesn't already exist") so two near-simultaneous
// registration attempts for the SAME email can never silently overwrite
// each other's userId/tenantIdReserved -- exactly the failure mode a
// plain HGET-then-HSET pair would allow. See
// tests/test_registration_concurrency.js for the race proof.

import { Redis } from '@upstash/redis'

const STORE_KEY = 'pending_registrations:v1'
const RECORD_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days -- matches the design's stated abandonment window

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class PendingRegistrationStoreUnavailableError extends Error {}

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

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase()
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

// A record-level TTL on a HASH FIELD isn't a native Redis operation
// (EXPIRE only applies to whole keys) -- this store deliberately uses one
// key PER EMAIL (pending_registration:{email}), not a single shared hash,
// specifically so each record can carry its own independent TTL. This is
// a different shape from tenant_config:v1/users:v1's "one hash for
// everything" pattern -- justified here because, unlike those, records in
// THIS store are expected to be transient and self-expiring, never listed
// in bulk by any admin view.
function recordKey(email) {
  return `${STORE_KEY}:${normalizeEmail(email)}`
}

// Atomically creates a pending registration -- returns the CREATED record,
// or null if a pending registration for this email already exists (the
// caller decides how to respond; see register()'s own no-enumeration
// handling). Never overwrites an existing record.
export async function createPendingRegistration({ email, passwordHash, displayName, companyName, userId, tenantIdReserved }) {
  const client = getClient()
  if (!client) throw new PendingRegistrationStoreUnavailableError('pending registration store is not configured')
  const now = new Date().toISOString()
  const record = {
    userId, email: normalizeEmail(email), passwordHash, displayName, companyName,
    tenantIdReserved, emailVerified: false, verifiedAt: null, verifyTokenHash: null,
    status: 'pending_verification', createdAt: now, updatedAt: now,
  }
  let created
  try {
    // SET ... NX EX -- the REST client's set() supports { nx, ex } together
    // (confirmed against @upstash/redis's own SetCommandOptions type),
    // giving the same atomic "only if absent" guarantee HSETNX gives a
    // hash field, applied here to this store's one-key-per-email shape.
    // Returns the literal string 'OK' on success, or null if the key
    // already existed (the NX condition failed) -- never throws for that
    // case, so `created` distinguishes the two outcomes directly.
    const result = await client.set(recordKey(email), JSON.stringify(record), { nx: true, ex: RECORD_TTL_SECONDS })
    created = result === 'OK'
  } catch (err) {
    throw new PendingRegistrationStoreUnavailableError(`pending registration store unreachable: ${err.message}`)
  }
  return created ? record : null
}

export async function getPendingRegistration(email) {
  const client = getClient()
  if (!client) throw new PendingRegistrationStoreUnavailableError('pending registration store is not configured')
  try {
    return parseRecord(await client.get(recordKey(email)))
  } catch (err) {
    throw new PendingRegistrationStoreUnavailableError(`pending registration store unreachable: ${err.message}`)
  }
}

// Partial merge, same shape as userStore.js's updateUser()/
// tenantConfigStore.js's upsertTenantConfig() -- re-stamps the TTL on every
// write so an actively-progressing registration (verified, mid plan-
// selection) doesn't expire out from under a slow-but-legitimate user,
// while a genuinely abandoned one still ages out from its last real touch.
export async function updatePendingRegistration(email, patch) {
  const client = getClient()
  if (!client) throw new PendingRegistrationStoreUnavailableError('pending registration store is not configured')
  const existing = await getPendingRegistration(email)
  if (!existing) return null
  const next = { ...existing, ...patch, email: existing.email, updatedAt: new Date().toISOString() }
  try {
    await client.set(recordKey(email), JSON.stringify(next), { ex: RECORD_TTL_SECONDS })
  } catch (err) {
    throw new PendingRegistrationStoreUnavailableError(`pending registration store unreachable: ${err.message}`)
  }
  return next
}

const LOCK_TTL_SECONDS = 30

function lockKey(email) {
  return `pending_registration_lock:${normalizeEmail(email)}`
}

// A short-lived mutex (plain SET NX EX, same atomic primitive
// createPendingRegistration() already uses) guarding the tenant-creation
// transaction (session/[action].js's createTenantForVerifiedRegistration())
// -- prevents two concurrent redeem-access-code/select-plan submissions
// for the SAME pending registration from both proceeding past the
// re-check-identity/upsertTenantConfig/upsertUser sequence at once.
// Returns true if the lock was acquired, false if another request already
// holds it. 30 seconds is generous for the whole transaction (a handful
// of Redis round trips) while still self-clearing quickly if a request
// ever dies mid-transaction without releasing it.
export async function acquireTenantCreationLock(email) {
  const client = getClient()
  if (!client) throw new PendingRegistrationStoreUnavailableError('pending registration store is not configured')
  try {
    const result = await client.set(lockKey(email), '1', { nx: true, ex: LOCK_TTL_SECONDS })
    return result === 'OK'
  } catch (err) {
    throw new PendingRegistrationStoreUnavailableError(`pending registration store unreachable: ${err.message}`)
  }
}

export async function releaseTenantCreationLock(email) {
  const client = getClient()
  if (!client) return // best-effort; an unconfigured store already failed loudly earlier
  try {
    await client.del(lockKey(email))
  } catch (err) {
    console.error(`[pendingRegistrationStore] failed to release tenant-creation lock: ${err.message}`)
  }
}

// Called only once the real tenant_config + user record both exist --
// see session/[action].js's tenant-creation transaction. Deleting a
// record that no longer exists (already deleted, or never existed) is a
// harmless no-op.
export async function deletePendingRegistration(email) {
  const client = getClient()
  if (!client) throw new PendingRegistrationStoreUnavailableError('pending registration store is not configured')
  try {
    await client.del(recordKey(email))
  } catch (err) {
    throw new PendingRegistrationStoreUnavailableError(`pending registration store unreachable: ${err.message}`)
  }
}
