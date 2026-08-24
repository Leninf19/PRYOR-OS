// Invitation and password-reset token lifecycle -- Multi-Location
// Authentication & User Access System, Commit 2/3. Redis-backed, following
// publishBridgeStore.js's "TTL as lifecycle" shape.
//
// SECURITY MODEL: a raw token is a 32-byte crypto.randomBytes() value,
// returned to the caller (and embedded in the invite/reset URL) exactly
// once. Only its SHA-256 hash is ever persisted -- Redis never holds a raw
// token, so a Redis dump/log/backup leak cannot be replayed as a live
// token. Every function here takes/returns the raw token at the API
// boundary and immediately hashes it before touching Redis.
//
// SINGLE-USE, ATOMICALLY: consumeToken() uses Upstash's GETDEL (fetch +
// delete in one round trip), not a separate GET then DEL -- two concurrent
// requests presenting the same raw token can never both receive the
// payload, closing the TOCTOU race a naive get-then-delete would have.
//
// NO UNRECOVERABLE PARTIAL FAILURE: consuming a token is real (the primary
// `invite:{hash}`/`reset:{hash}` key is gone the instant GETDEL returns
// non-null) -- but the write sequence AFTER that (hash password, upsert the
// user record, sign a session, write an audit entry) can still fail
// partway. To prevent "token burned, no usable account", every consume
// immediately re-persists the same payload into a short-lived
// `*-pending:{hash}` key (15-minute TTL) BEFORE the caller attempts any of
// those risky writes. If a retry (the client resubmitting the exact same
// still-locally-held raw token) arrives after the primary key is already
// gone, consumeToken() falls through to this pending record instead of
// reporting "invalid token" -- letting the caller safely retry the same
// idempotent write. See accept-invite/reset-password in session/[action].js
// for the full retry contract; markConsumedPending()/clearConsumedPending()
// are the two halves the caller is responsible for calling.

import { randomBytes, createHash } from 'crypto'
import { Redis } from '@upstash/redis'

const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days
const RESET_TTL_SECONDS = 60 * 60 // 1 hour
const PENDING_TTL_SECONDS = 15 * 60 // retry safety-net window

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class TokenStoreUnavailableError extends Error {}

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

export function hashToken(rawToken) {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

function generateRawToken() {
  return randomBytes(32).toString('hex')
}

function primaryKey(kind, hash) { return `${kind}:${hash}` }
function pendingKey(kind, hash) { return `${kind}-pending:${hash}` }

function parseRecord(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// kind: 'invite' | 'reset'. Returns { rawToken, tokenHash, expiresAt }.
// `payload` is stored as-is (JSON) -- callers decide what it needs to carry
// (invite: userId/email/role/locationIds/invitedBy; reset: just userId).
async function createToken(kind, payload, ttlSeconds) {
  const client = getClient()
  if (!client) throw new TokenStoreUnavailableError('token store is not configured')
  const rawToken = generateRawToken()
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
  try {
    await client.set(primaryKey(kind, tokenHash), JSON.stringify({ ...payload, expiresAt }), { ex: ttlSeconds })
  } catch (err) {
    throw new TokenStoreUnavailableError(`token store unreachable: ${err.message}`)
  }
  return { rawToken, tokenHash, expiresAt }
}

export async function createInviteToken(payload) {
  return createToken('invite', payload, INVITE_TTL_SECONDS)
}

export async function createResetToken(payload) {
  return createToken('reset', payload, RESET_TTL_SECONDS)
}

// Atomic fetch+delete via GETDEL -- see the header comment. Returns
// { payload, tokenHash, fromPending } or null if the token is invalid,
// expired, or already fully consumed (no pending record either).
async function consumeToken(kind, rawToken) {
  const client = getClient()
  if (!client) throw new TokenStoreUnavailableError('token store is not configured')
  const tokenHash = hashToken(rawToken)

  let raw
  try {
    raw = await client.getdel(primaryKey(kind, tokenHash))
  } catch (err) {
    throw new TokenStoreUnavailableError(`token store unreachable: ${err.message}`)
  }
  const payload = parseRecord(raw)
  if (payload) return { payload, tokenHash, fromPending: false }

  // Not found via the primary key -- check the retry safety net before
  // declaring the token invalid. A present-but-expired pending record is
  // treated the same as absent (Redis TTL already handles expiry; this is
  // defensive in case a test or a clock skew leaves a stale value).
  let pendingRaw
  try {
    pendingRaw = await client.get(pendingKey(kind, tokenHash))
  } catch (err) {
    throw new TokenStoreUnavailableError(`token store unreachable: ${err.message}`)
  }
  const pendingPayload = parseRecord(pendingRaw)
  if (!pendingPayload) return null
  return { payload: pendingPayload, tokenHash, fromPending: true }
}

export async function consumeInviteToken(rawToken) { return consumeToken('invite', rawToken) }
export async function consumeResetToken(rawToken) { return consumeToken('reset', rawToken) }

// Non-destructive read -- lets the frontend preview "you've been invited"
// (name/role/locations) or validate a reset link before the user submits a
// password, without burning the token's single use. Never checks the
// pending-retry fallback (that's only relevant mid-consume, not for a
// pre-submission preview).
async function peekToken(kind, rawToken) {
  const client = getClient()
  if (!client) throw new TokenStoreUnavailableError('token store is not configured')
  const tokenHash = hashToken(rawToken)
  let raw
  try {
    raw = await client.get(primaryKey(kind, tokenHash))
  } catch (err) {
    throw new TokenStoreUnavailableError(`token store unreachable: ${err.message}`)
  }
  const payload = parseRecord(raw)
  return payload ? { payload, tokenHash } : null
}

export async function peekInviteToken(rawToken) { return peekToken('invite', rawToken) }
export async function peekResetToken(rawToken) { return peekToken('reset', rawToken) }

// Called immediately after a FRESH (non-pending) consume, before attempting
// the risky account-creation/password-set writes -- the retry safety net.
async function markConsumedPending(kind, tokenHash, payload) {
  const client = getClient()
  if (!client) throw new TokenStoreUnavailableError('token store is not configured')
  try {
    await client.set(pendingKey(kind, tokenHash), JSON.stringify(payload), { ex: PENDING_TTL_SECONDS })
  } catch (err) {
    // Deliberately NOT re-thrown: this is a best-effort safety net, not the
    // primary consume operation (which already succeeded via GETDEL). A
    // failure here just means a subsequent failed write won't be
    // retryable -- log it, but let the caller proceed to attempt the real
    // write anyway rather than aborting a request that could otherwise
    // succeed.
    console.error(`[tokenStore] failed to write ${kind} pending safety-net record: ${err.message}`)
  }
}

export async function markInviteConsumedPending(tokenHash, payload) { return markConsumedPending('invite', tokenHash, payload) }
export async function markResetConsumedPending(tokenHash, payload) { return markConsumedPending('reset', tokenHash, payload) }

// Called only after the full write sequence (password hash + user upsert +
// session + audit entry) has ALL succeeded -- clears the retry safety net
// so a stale raw token can't be replayed again after genuine completion.
async function clearConsumedPending(kind, tokenHash) {
  const client = getClient()
  if (!client) return // best-effort cleanup; an unconfigured store already failed loudly earlier in the same request
  try {
    await client.del(pendingKey(kind, tokenHash))
  } catch (err) {
    console.error(`[tokenStore] failed to clear ${kind} pending safety-net record: ${err.message}`)
  }
}

export async function clearInviteConsumedPending(tokenHash) { return clearConsumedPending('invite', tokenHash) }
export async function clearResetConsumedPending(tokenHash) { return clearConsumedPending('reset', tokenHash) }

// Explicit revocation (Owner/Admin "Revoke Invitation") -- deletes both the
// primary and pending keys for a specific token hash (recorded on the
// user's own record at invite-creation time, since the admin never has the
// raw token itself -- see userStore.js's inviteTokenHash field). Deleting a
// key that no longer exists (already consumed, or never existed) is a
// harmless no-op, not an error -- revoke is idempotent by design.
async function revokeToken(kind, tokenHash) {
  const client = getClient()
  if (!client) throw new TokenStoreUnavailableError('token store is not configured')
  try {
    await client.del(primaryKey(kind, tokenHash))
    await client.del(pendingKey(kind, tokenHash))
  } catch (err) {
    throw new TokenStoreUnavailableError(`token store unreachable: ${err.message}`)
  }
}

export async function revokeInviteToken(tokenHash) { return revokeToken('invite', tokenHash) }
export async function revokeResetToken(tokenHash) { return revokeToken('reset', tokenHash) }
