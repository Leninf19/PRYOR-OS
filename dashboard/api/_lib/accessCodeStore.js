// Multi-Tenant Phase 4Q -- internal PRYOR platform-admin access-code
// system. One Redis hash, access_codes:v1, field = codeHash
// (sha256(rawCode)), value = a JSON record. Mirrors tokenStore.js's own
// "never store the raw secret" discipline exactly: the raw code is
// generated here, returned to the caller (an isSuperAdmin request) EXACTLY
// ONCE at creation, and never persisted or retrievable again in any form.
//
// FORMAT: "{PREFIX}-{10 random human-safe characters}", e.g.
// "LTA-ENT-7K4M9Q2X8P". The random suffix is drawn from a 30-character
// alphabet with visually-ambiguous characters removed (no 0/O, 1/I/L, U)
// -- 10 characters from that alphabet is ~49 bits of entropy, far more
// than enough given this is also rate-limited (see session/[action].js's
// redeemAccessCode()) and every failed guess is indistinguishable from
// every other failure mode (see redeemAccessCode() below).
//
// ATOMICITY: redemption is a single Redis EVAL (mirrors
// tenantConfigStore.js's own CAS_UPSERT_SCRIPT precedent) that re-checks
// status and the redemption-count-vs-max-redemptions bound AND performs
// the increment, all in one atomic script execution -- closing the exact
// TOCTOU race a plain "read count, check, write count+1" pair would leave
// open. Email/domain restriction and expiry are cheap, non-racing checks
// (nothing concurrent can change a caller's own email, and expiry is
// wall-clock time, not another writer) -- expiry is defensively re-checked
// inside the same atomic script too, for belt-and-suspenders correctness,
// but email/domain restriction is checked once, in JS, before the script
// runs (see redeemAccessCode()).

import { randomInt, createHash } from 'crypto'
import { Redis } from '@upstash/redis'

const STORE_KEY = 'access_codes:v1'
const HUMAN_SAFE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ' // no 0/O, 1/I/L, U
const SUFFIX_LENGTH = 10

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class AccessCodeStoreUnavailableError extends Error {}

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

export function hashAccessCode(rawCode) {
  return createHash('sha256').update(rawCode.toUpperCase().trim(), 'utf8').digest('hex')
}

function randomSuffix() {
  let out = ''
  for (let i = 0; i < SUFFIX_LENGTH; i++) out += HUMAN_SAFE_ALPHABET[randomInt(HUMAN_SAFE_ALPHABET.length)]
  return out
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

const VALID_PLANS = new Set(['core', 'growth', 'enterprise'])

// Creates a new code. Returns { rawCode, record } -- rawCode is NEVER
// stored anywhere and must be shown to the calling admin exactly once by
// the caller (session/[action].js's admin action); this function itself
// never logs it.
export async function createAccessCode({
  prefix, plan, discountPercent = null, discountFixedCents = null, trialDays = null,
  paymentRequired = true, expiresAt = null, maxRedemptions = 1,
  allowedEmail = null, allowedEmailDomain = null, clientLabel = null, createdBy,
}) {
  const client = getClient()
  if (!client) throw new AccessCodeStoreUnavailableError('access code store is not configured')
  if (!VALID_PLANS.has(plan)) throw new TypeError(`createAccessCode: invalid plan ${JSON.stringify(plan)}`)
  if (discountPercent != null && discountFixedCents != null) {
    throw new TypeError('createAccessCode: discountPercent and discountFixedCents are mutually exclusive')
  }
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) {
    throw new TypeError('createAccessCode: maxRedemptions must be a positive integer')
  }
  if (!prefix || !/^[A-Z0-9-]{2,20}$/.test(prefix)) {
    throw new TypeError('createAccessCode: prefix must be 2-20 uppercase letters/digits/hyphens')
  }

  const rawCode = `${prefix}-${randomSuffix()}`
  const codeHash = hashAccessCode(rawCode)
  const now = new Date().toISOString()
  const record = {
    codeHash, prefix, plan, discountPercent, discountFixedCents, trialDays,
    paymentRequired, expiresAt, maxRedemptions, redemptionCount: 0,
    allowedEmail: allowedEmail ? allowedEmail.trim().toLowerCase() : null,
    allowedEmailDomain: allowedEmailDomain ? allowedEmailDomain.trim().toLowerCase() : null,
    clientLabel, createdBy, createdAt: now, revokedAt: null, status: 'active',
    redemptions: [],
  }
  try {
    await client.hset(STORE_KEY, { [codeHash]: JSON.stringify(record) })
  } catch (err) {
    throw new AccessCodeStoreUnavailableError(`access code store unreachable: ${err.message}`)
  }
  return { rawCode, record }
}

// Admin listing -- never includes the raw code (it was never stored) and
// never has to redact anything, since codeHash is already a one-way value
// safe to display (matches how this project already treats gbp_review_name/
// dedup_key elsewhere -- an opaque identifier is fine to show; only the
// SECRET behind it is withheld).
export async function listAccessCodes() {
  const client = getClient()
  if (!client) throw new AccessCodeStoreUnavailableError('access code store is not configured')
  let raw
  try {
    raw = await client.hgetall(STORE_KEY)
  } catch (err) {
    throw new AccessCodeStoreUnavailableError(`access code store unreachable: ${err.message}`)
  }
  const out = []
  for (const value of Object.values(raw ?? {})) {
    const record = parseRecord(value)
    if (record) out.push(record)
  }
  return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
}

export async function getAccessCodeByHash(codeHash) {
  const client = getClient()
  if (!client) throw new AccessCodeStoreUnavailableError('access code store is not configured')
  try {
    return parseRecord(await client.hget(STORE_KEY, codeHash))
  } catch (err) {
    throw new AccessCodeStoreUnavailableError(`access code store unreachable: ${err.message}`)
  }
}

// Revocation is a plain write (not the atomic redemption script) -- there
// is nothing to race against a status flip TO revoked; the redemption
// script's own status check then fails closed permanently and immediately
// for every subsequent redemption attempt, in flight or not yet started.
export async function revokeAccessCode(codeHash) {
  const client = getClient()
  if (!client) throw new AccessCodeStoreUnavailableError('access code store is not configured')
  const existing = await getAccessCodeByHash(codeHash)
  if (!existing) return null
  const next = { ...existing, status: 'revoked', revokedAt: new Date().toISOString() }
  try {
    await client.hset(STORE_KEY, { [codeHash]: JSON.stringify(next) })
  } catch (err) {
    throw new AccessCodeStoreUnavailableError(`access code store unreachable: ${err.message}`)
  }
  return next
}

// The one atomic mutation. See the file header for why this specific
// split (email/domain checked in JS before calling this; status/expiry/
// count re-checked INSIDE the atomic script) is safe.
const REDEEM_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return false end
local ok, code = pcall(cjson.decode, raw)
if not ok then return false end
if code.status ~= 'active' then return false end
if code.expiresAt and code.expiresAt ~= cjson.null and code.expiresAt ~= '' and code.expiresAt < ARGV[4] then
  return false
end
if code.redemptionCount >= code.maxRedemptions then return false end
code.redemptionCount = code.redemptionCount + 1
if not code.redemptions or code.redemptions == cjson.null then code.redemptions = {} end
table.insert(code.redemptions, { tenantId = ARGV[2], userId = ARGV[3], redeemedAt = ARGV[4] })
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(code))
return cjson.encode(code)
`

export class AccessCodeInvalidError extends Error {}
export class AccessCodeRestrictedError extends Error {}

// email/tenantId/userId are ALL server-derived by the caller
// (session/[action].js's redeemAccessCode()) -- this function never
// accepts a tenantId or userId that didn't come from the caller's own
// verified pending-registration identity. Returns the plan/discount/
// trial fields from the record AT THE MOMENT OF SUCCESSFUL REDEMPTION --
// never from a value the client supplied, so there is no payload for a
// client to tamper with (the client sends only the raw code string).
export async function redeemAccessCode({ rawCode, email, tenantId, userId }) {
  const client = getClient()
  if (!client) throw new AccessCodeStoreUnavailableError('access code store is not configured')
  const codeHash = hashAccessCode(rawCode)

  const existing = await getAccessCodeByHash(codeHash)
  // Deliberately the SAME generic error for "no such code," "revoked," and
  // "expired"/"exhausted" (re-checked again below) -- never distinguishing
  // WHY a guessed code failed, so brute-forcing the random suffix gets no
  // signal beyond "wrong." See tokenStore.js's own no-enumeration-adjacent
  // discipline for the same reasoning applied to invite/reset tokens.
  if (!existing || existing.status !== 'active') {
    throw new AccessCodeInvalidError('This code is invalid or can no longer be used.')
  }
  if (existing.expiresAt && new Date(existing.expiresAt).getTime() < Date.now()) {
    throw new AccessCodeInvalidError('This code is invalid or can no longer be used.')
  }
  if (existing.redemptionCount >= existing.maxRedemptions) {
    throw new AccessCodeInvalidError('This code is invalid or can no longer be used.')
  }
  // Email/domain restriction gets its OWN, clearer message -- this is a
  // legitimate-user-facing condition (a client-specific code shared with
  // the wrong address), not a guessing-attack signal, so there is no
  // enumeration cost to being specific here.
  const normalizedEmail = email.trim().toLowerCase()
  if (existing.allowedEmail && existing.allowedEmail !== normalizedEmail) {
    throw new AccessCodeRestrictedError('This code is restricted to a specific email address.')
  }
  if (existing.allowedEmailDomain) {
    const domain = normalizedEmail.split('@')[1] || ''
    if (domain !== existing.allowedEmailDomain) {
      throw new AccessCodeRestrictedError('This code is restricted to a specific organization.')
    }
  }

  const nowIso = new Date().toISOString()
  let resultRaw
  try {
    resultRaw = await client.eval(REDEEM_SCRIPT, [STORE_KEY], [codeHash, tenantId, userId, nowIso])
  } catch (err) {
    throw new AccessCodeStoreUnavailableError(`access code store unreachable: ${err.message}`)
  }
  if (!resultRaw) {
    // Lost the race (another request consumed the last slot, or it was
    // revoked/expired between the pre-check above and this atomic call) --
    // same generic message, not a different one, so timing differences
    // reveal nothing either.
    throw new AccessCodeInvalidError('This code is invalid or can no longer be used.')
  }
  const finalRecord = parseRecord(resultRaw)
  return {
    plan: finalRecord.plan,
    discountPercent: finalRecord.discountPercent,
    discountFixedCents: finalRecord.discountFixedCents,
    trialDays: finalRecord.trialDays,
    paymentRequired: finalRecord.paymentRequired,
    codeHash,
  }
}
