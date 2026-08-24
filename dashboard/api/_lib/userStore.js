// The durable, dynamically-writable user directory -- Multi-Location
// Authentication & User Access System, Commit 1. This is the "hosted `users`
// table" accounts.js's own header comment anticipated ("promote this same
// shape into a users table once the hosted-database phase lands") -- except
// the smallest reliable persistent store already compatible with this
// project is Upstash Redis (already used for the publish bridge, Action
// Center, Restaurant Contacts, and the audit log), not a new database.
//
// Storage: two Redis hashes, following contactStore.js's established
// "one hash per directory" shape --
//   USERS_KEY       (users:v1)             field = userId,          value = JSON record
//   EMAIL_INDEX_KEY  (users_email_index:v1) field = normalizedEmail, value = userId
// The email index exists because login looks up by email, not userId, and a
// Redis hash has no secondary index -- this mirrors how contactStore.js is
// keyed by locationId (its own natural lookup key) while this store needs
// two.
//
// Record shape (superset of accounts.js's static-directory shape -- every
// field that shape has, plus the fields Phase 2 of this milestone requires):
//   userId, email, passwordHash (null until the invitee sets one),
//   role, locationIds ('*' or int[]), sessionVersion, disabled,
//   displayName, createdAt, updatedAt, lastLoginAt, invitedAt, passwordSetAt
// `status` ('invited' | 'active' | 'disabled') is deliberately NOT stored --
// it's derived (deriveUserStatus() below) from disabled/passwordSetAt so it
// can never drift from the fields that actually gate behavior.
//
// Edge runtime note: unlike bcryptjs/fs, @upstash/redis's client is a plain
// fetch-based REST client with no Node-only APIs, so -- unlike password.js --
// this file IS safe to import from dashboard/middleware.js (Edge). It is
// imported there indirectly via accountStore.js's dual-read.
//
// Failure model: every function here throws UserStoreUnavailableError on a
// missing/unreachable Redis, the same "never fail open on a write, never
// silently show a false empty result on a read" convention contactStore.js
// and auditLog.js use. accountStore.js (the auth-path caller) is
// deliberately the ONE place that catches this and degrades to
// static-directory-only, because ONLY the auth path has the requirement
// that a Redis outage must never take down the existing Owner accounts --
// every other caller (the Users & Access admin UI) should see a real
// failure, not a silently-incomplete user list.

import { Redis } from '@upstash/redis'
import { normalizeEmail, isValidLocationIds, ROLES } from './accounts.js'

const USERS_KEY = 'users:v1'
const EMAIL_INDEX_KEY = 'users_email_index:v1'

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class UserStoreUnavailableError extends Error {}

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

// 'invited' | 'active' | 'disabled' | 'revoked' | 'expired', derived so it
// can never drift from the fields that actually gate login/authorization --
// see the header comment. Order is deliberate: disabled always wins (an
// account explicitly turned off, regardless of how it got there); an
// account that has genuinely set a password is 'active' even if it still
// carries stale invite metadata; only then do the not-yet-accepted invite
// states (revoked/expired/invited) apply.
export function deriveUserStatus(record) {
  if (!record) return null
  if (record.disabled) return 'disabled'
  if (record.passwordSetAt) return 'active'
  if (record.inviteRevokedAt) return 'revoked'
  if (record.inviteExpiresAt && new Date(record.inviteExpiresAt).getTime() < Date.now()) return 'expired'
  return 'invited'
}

export async function getUserById(userId) {
  const client = getClient()
  if (!client) throw new UserStoreUnavailableError('user store is not configured')
  let raw
  try {
    raw = await client.hget(USERS_KEY, userId)
  } catch (err) {
    throw new UserStoreUnavailableError(`user store unreachable: ${err.message}`)
  }
  return parseRecord(raw)
}

export async function getUserByEmail(email) {
  const client = getClient()
  if (!client) throw new UserStoreUnavailableError('user store is not configured')
  const normalized = normalizeEmail(email)
  let userId
  try {
    userId = await client.hget(EMAIL_INDEX_KEY, normalized)
  } catch (err) {
    throw new UserStoreUnavailableError(`user store unreachable: ${err.message}`)
  }
  if (!userId) return null
  return getUserById(userId)
}

// Returns every user record (no filtering) -- callers (the Users & Access
// admin action, assertNotLastActiveOwner) are responsible for any
// filtering/sanitization they need.
export async function listUsers() {
  const client = getClient()
  if (!client) throw new UserStoreUnavailableError('user store is not configured')
  let raw
  try {
    raw = await client.hgetall(USERS_KEY)
  } catch (err) {
    throw new UserStoreUnavailableError(`user store unreachable: ${err.message}`)
  }
  const out = []
  for (const value of Object.values(raw ?? {})) {
    const record = parseRecord(value)
    if (record) out.push(record)
  }
  return out
}

function isValidRoleIncludingAdmin(role) {
  return ROLES.includes(role) // 'admin' is added to accounts.js's ROLES in this same commit
}

// Creates or fully replaces a user record. Both the primary hash and the
// email index are written -- if the email changed (not currently exposed by
// any endpoint, but defended here so this function is safe if that changes
// later), the OLD email's index entry is left stale unless `previousEmail`
// is passed, since a hash has no atomic "rename key" -- callers that ever
// change email must pass the prior value explicitly.
//
// Minimal shape validation only (role is a known role, locationIds is
// well-formed if present) -- the caller (invitation-accept, user-management
// actions) is responsible for its own request-body validation; this is a
// second, defensive layer, matching contactStore.js's division of labor.
export async function upsertUser(record, { previousEmail } = {}) {
  const client = getClient()
  if (!client) throw new UserStoreUnavailableError('user store is not configured')
  if (!record || typeof record.userId !== 'string' || !record.userId) {
    throw new Error('upsertUser: record.userId is required')
  }
  if (!isValidRoleIncludingAdmin(record.role)) {
    throw new Error(`upsertUser: invalid role "${record.role}"`)
  }
  if (!isValidLocationIds(record.locationIds)) {
    throw new Error('upsertUser: invalid locationIds')
  }

  const normalized = normalizeEmail(record.email)
  const toWrite = { ...record, email: normalized }

  try {
    await client.hset(USERS_KEY, { [record.userId]: JSON.stringify(toWrite) })
    await client.hset(EMAIL_INDEX_KEY, { [normalized]: record.userId })
    if (previousEmail && normalizeEmail(previousEmail) !== normalized) {
      await client.hdel(EMAIL_INDEX_KEY, normalizeEmail(previousEmail))
    }
  } catch (err) {
    throw new UserStoreUnavailableError(`user store unreachable: ${err.message}`)
  }
  return toWrite
}

// Partial merge + updatedAt stamp -- the shape every write endpoint (role
// change, location change, disable/enable, password set) actually wants,
// rather than requiring every caller to read-modify-write the full record
// itself. Returns the updated record, or null if userId doesn't exist.
export async function updateUser(userId, patch) {
  const existing = await getUserById(userId)
  if (!existing) return null
  const next = {
    ...existing,
    ...patch,
    userId, // never overwritable via patch
    updatedAt: new Date().toISOString(),
  }
  return upsertUser(next, { previousEmail: patch.email ? existing.email : undefined })
}

// Best-effort, non-blocking timestamp touch -- called from the login
// endpoint. Deliberately swallows its own errors (returns false rather than
// throwing) so a Redis hiccup on this one bookkeeping field never breaks an
// otherwise-successful login, mirroring auditLog.js's appendAuditEntry()
// same "this matters but is not the source of truth for the action itself"
// reasoning.
export async function touchLastLogin(userId) {
  try {
    await updateUser(userId, { lastLoginAt: new Date().toISOString() })
    return true
  } catch (err) {
    console.error(`[userStore] failed to record lastLoginAt for ${userId}: ${err.message}`)
    return false
  }
}
