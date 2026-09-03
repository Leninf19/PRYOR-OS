// TEMPORARY -- Phase 4M encryption-key-identity incident diagnosis ONLY.
// Delete this file (and its two call sites in google/[action].js, and
// credentialStore.js's computeEncryptionKeyChallengeHmac export, and
// encryption_key_challenge_probe.py on the GitHub Actions side) once the
// incident is resolved.
//
// A minimal, disposable Redis relay for a two-sided HMAC challenge-response
// proving whether GitHub Actions' and Vercel production's
// CREDENTIAL_ENCRYPTION_KEY match, without either side ever exchanging or
// printing the raw key or a derived key. GitHub Actions writes
// {nonce, hmacGh} to a short-TTL "challenge" key; consumeChallenge() reads
// AND deletes it atomically (single-use -- a replayed requestId always
// finds nothing), and writeResult() records ONLY a boolean match outcome
// to a companion "result" key for GitHub Actions to read back -- never
// the nonce, never either HMAC value, on this side of the relay.
//
// Same lazy-Redis-client pattern as every other _lib store in this
// project (auditLog.js, contactStore.js, etc.).
import { Redis } from '@upstash/redis'

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class EncryptionKeyChallengeStoreUnavailableError extends Error {}

function getClient() {
  if (testClientFactory) return testClientFactory()
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return null
  if (!redisClient) {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
  return redisClient
}

// GitHub Actions generates this (secrets.token_hex(16)) -- 32 lowercase
// hex characters. Never accepted from any other shape.
const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/i

function challengeKey(requestId) { return `credential_key_challenge:${requestId}` }
function resultKey(requestId) { return `credential_key_challenge_result:${requestId}` }

function parseRecord(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// Single-use: reads AND deletes the challenge record in ONE atomic Redis
// GETDEL, never a separate get-then-del pair -- so two requests racing on
// the same requestId can never both see it, and a replayed requestId
// (the challenge already consumed by an earlier call) always finds
// nothing, the same replay-safety discipline the invitation-token store
// (tokenStore.js's consumeInviteToken) already uses in this project.
export async function consumeChallenge(requestId) {
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) return null
  const client = getClient()
  if (!client) throw new EncryptionKeyChallengeStoreUnavailableError('challenge store is not configured')

  let raw
  try {
    raw = await client.getdel(challengeKey(requestId))
  } catch (err) {
    throw new EncryptionKeyChallengeStoreUnavailableError(`challenge store unreachable: ${err.message}`)
  }
  const record = parseRecord(raw)
  if (!record || typeof record.nonce !== 'string' || typeof record.hmacGh !== 'string') return null
  return record
}

// Writes ONLY a boolean -- never the nonce, never either HMAC value --
// with a short TTL so an unread result self-expires.
export async function writeResult(requestId, match) {
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new TypeError('writeResult: invalid requestId')
  }
  const client = getClient()
  if (!client) throw new EncryptionKeyChallengeStoreUnavailableError('challenge store is not configured')
  try {
    await client.set(resultKey(requestId), JSON.stringify({ match: Boolean(match) }), { ex: 300 })
  } catch (err) {
    throw new EncryptionKeyChallengeStoreUnavailableError(`challenge store unreachable: ${err.message}`)
  }
}
