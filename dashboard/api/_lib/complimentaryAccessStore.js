// Complimentary Restaurant Access Codes -- a DISTINCT server-side commercial
// mechanism from accessCodeStore.js's own "PRYOR platform-admin access-code
// system." That system exists to gate/modify REGISTRATION (it mints a brand
// new tenant, via redeemAccessCodeAction()'s createTenantForVerifiedRegistration()
// call, from a pending-signup identity that has no tenant yet) -- its
// purpose is "how was this NEW tenant's commercial state initialized,"
// including a payment-required/discount/allowlisted-email sales-code
// concept this module has no business touching or reinterpreting.
//
// THIS module answers a different question: "let an EXISTING, already
// authenticated tenant Owner unlock complimentary commercial access for
// their ALREADY-CREATED tenant" -- redemption happens from within an
// authenticated session (session/[action].js's redeemComplimentaryCodeAction()),
// never from a pending-registration identity, and never creates a tenant.
// Reusing accessCodeStore.js's Redis hash/claim ledger for this would
// silently blur two mechanisms with different security purposes (see this
// project's own explicit instruction to keep them separate); this module
// instead mirrors its PROVEN SAFE PATTERNS -- sha256(rawCode) hashing, the
// single atomic Redis EVAL for claim+increment, a durable post-redemption
// claim ledger for partial-failure recovery -- as a parallel, independent
// implementation.
//
// STORAGE: one Redis hash, complimentary_access_codes:v1, field = codeHash
// (sha256(rawCode)), value = a JSON record. The raw code is generated here,
// returned to the caller (the local operator CLI -- scripts/complimentary-code.js)
// EXACTLY ONCE at creation, and never persisted or retrievable again in any
// form.
//
// FORMAT: "PRYOR-PILOT-{5 chars}-{5 chars}", drawn from the same
// visually-unambiguous 30-character alphabet accessCodeStore.js already
// uses (no 0/O, 1/I/L, U) -- 10 random characters from that alphabet is
// ~49 bits of entropy, matching accessCodeStore.js's own budget. The label
// a human types in at creation time (e.g. "Agave D'Oro Pilot") is stored
// separately as metadata (`label`) and carries NO security weight -- only
// the random suffix does.
//
// ATOMICITY: redemption is a single Redis EVAL (mirrors accessCodeStore.js's
// own REDEEM_SCRIPT precedent exactly) that re-checks status/expiry/
// redemption-count AND performs the increment AND writes the durable
// post-redemption claim, all in one atomic script execution -- closing the
// same "read count, check, write count+1" TOCTOU race accessCodeStore.js's
// own header documents, and making two concurrent redemption attempts for
// the same single-use code structurally unable to both succeed.

import { randomInt, createHash } from 'crypto'
import { Redis } from '@upstash/redis'
import { isSelfServicePlan } from './stripePriceMap.js'

const STORE_KEY = 'complimentary_access_codes:v1'
const HUMAN_SAFE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ' // no 0/O, 1/I/L, U
const SEGMENT_LENGTH = 5
const CODE_PREFIX = 'PRYOR-PILOT'

// Conservative, explicit ceilings -- structurally impossible for a
// mistyped/malformed operator command to grant an absurd amount of free
// access. Mirrors accessCodeStore.js's MAX_ACCESS_CODE_TRIAL_DAYS precedent
// exactly. These are creation-time sanity bounds only; the resolver
// (entitlementResolution.js) separately and independently clamps a
// complimentary grant's location/user ceilings to never exceed the
// selected plan's own real limits, regardless of what a code was created
// with.
export const MAX_COMPLIMENTARY_DURATION_DAYS = 90
export const MAX_COMPLIMENTARY_LOCATIONS = 20
export const MAX_COMPLIMENTARY_USERS = 50

export function isValidComplimentaryDurationDays(days) {
  return Number.isInteger(days) && days >= 1 && days <= MAX_COMPLIMENTARY_DURATION_DAYS
}
export function isValidComplimentaryMaxLocations(n) {
  return Number.isInteger(n) && n >= 1 && n <= MAX_COMPLIMENTARY_LOCATIONS
}
export function isValidComplimentaryMaxUsers(n) {
  return Number.isInteger(n) && n >= 1 && n <= MAX_COMPLIMENTARY_USERS
}

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class ComplimentaryAccessStoreUnavailableError extends Error {}

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

export function hashComplimentaryCode(rawCode) {
  return createHash('sha256').update(rawCode.toUpperCase().trim(), 'utf8').digest('hex')
}

function randomSegment() {
  let out = ''
  for (let i = 0; i < SEGMENT_LENGTH; i++) out += HUMAN_SAFE_ALPHABET[randomInt(HUMAN_SAFE_ALPHABET.length)]
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

// Creates a new complimentary code. Returns { rawCode, record } -- rawCode
// is NEVER stored anywhere and must be shown to the calling operator
// exactly once (scripts/complimentary-code.js); this function itself never
// logs it.
export async function createComplimentaryCode({
  label = null, planId, durationDays, maxLocations, maxUsers, maxRedemptions = 1,
  redemptionDeadline = null, createdBy,
}) {
  const client = getClient()
  if (!client) throw new ComplimentaryAccessStoreUnavailableError('complimentary access code store is not configured')
  // Security review finding: Enterprise is deliberately EXCLUDED here, the
  // same way stripePriceMap.js's own SELF_SERVICE_PLAN_IDS excludes it from
  // every self-service Stripe path -- Enterprise is manual-sales-only, with
  // its own negotiated limitsOverride mechanism (entitlementResolution.js);
  // a lightweight operator CLI granting complimentary "Enterprise" access
  // would be exactly the "accidental Enterprise access" this feature's own
  // security review explicitly calls out to guard against. Only Core/Growth
  // may ever be granted complimentary.
  if (!isSelfServicePlan(planId)) {
    throw new TypeError(`createComplimentaryCode: invalid planId ${JSON.stringify(planId)} -- must be a self-service plan (core or growth); Enterprise is manual-sales-only and can never be granted complimentary`)
  }
  if (!isValidComplimentaryDurationDays(durationDays)) {
    throw new TypeError(`createComplimentaryCode: durationDays must be an integer between 1 and ${MAX_COMPLIMENTARY_DURATION_DAYS}, got ${JSON.stringify(durationDays)}`)
  }
  if (!isValidComplimentaryMaxLocations(maxLocations)) {
    throw new TypeError(`createComplimentaryCode: maxLocations must be an integer between 1 and ${MAX_COMPLIMENTARY_LOCATIONS}, got ${JSON.stringify(maxLocations)}`)
  }
  if (!isValidComplimentaryMaxUsers(maxUsers)) {
    throw new TypeError(`createComplimentaryCode: maxUsers must be an integer between 1 and ${MAX_COMPLIMENTARY_USERS}, got ${JSON.stringify(maxUsers)}`)
  }
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) {
    throw new TypeError('createComplimentaryCode: maxRedemptions must be a positive integer')
  }
  if (redemptionDeadline != null && Number.isNaN(Date.parse(redemptionDeadline))) {
    throw new TypeError('createComplimentaryCode: redemptionDeadline must be null or a valid ISO timestamp')
  }
  if (!createdBy) throw new TypeError('createComplimentaryCode: createdBy is required')

  const rawCode = `${CODE_PREFIX}-${randomSegment()}-${randomSegment()}`
  const codeHash = hashComplimentaryCode(rawCode)
  const now = new Date().toISOString()
  const record = {
    codeHash, label, planId, durationDays, maxLocations, maxUsers,
    maxRedemptions, redemptionCount: 0,
    redemptionDeadline, createdAt: now, createdBy, revokedAt: null, revokeReason: null,
    status: 'active', redemptions: [],
    // Convenience top-level fields, meaningful for the common single-use
    // case -- reflect the MOST RECENT redemption if maxRedemptions > 1.
    // The `redemptions` array remains the authoritative, complete history.
    redeemedAt: null, redeemedByUserId: null, tenantId: null,
  }
  try {
    await client.hset(STORE_KEY, { [codeHash]: JSON.stringify(record) })
  } catch (err) {
    throw new ComplimentaryAccessStoreUnavailableError(`complimentary access code store unreachable: ${err.message}`)
  }
  return { rawCode, record }
}

// Operator listing -- never includes the raw code (it was never stored).
export async function listComplimentaryCodes() {
  const client = getClient()
  if (!client) throw new ComplimentaryAccessStoreUnavailableError('complimentary access code store is not configured')
  let raw
  try {
    raw = await client.hgetall(STORE_KEY)
  } catch (err) {
    throw new ComplimentaryAccessStoreUnavailableError(`complimentary access code store unreachable: ${err.message}`)
  }
  const out = []
  for (const value of Object.values(raw ?? {})) {
    const record = parseRecord(value)
    if (record) out.push(record)
  }
  return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
}

export async function getComplimentaryCodeByHash(codeHash) {
  const client = getClient()
  if (!client) throw new ComplimentaryAccessStoreUnavailableError('complimentary access code store is not configured')
  try {
    return parseRecord(await client.hget(STORE_KEY, codeHash))
  } catch (err) {
    throw new ComplimentaryAccessStoreUnavailableError(`complimentary access code store unreachable: ${err.message}`)
  }
}

// Revocation BEFORE redemption -- a plain write (not the atomic redemption
// script): there is nothing to race against a status flip TO revoked; the
// redemption script's own status check then fails closed permanently for
// every subsequent attempt, in flight or not yet started.
export async function revokeComplimentaryCode(codeHash, { reason = null } = {}) {
  const client = getClient()
  if (!client) throw new ComplimentaryAccessStoreUnavailableError('complimentary access code store is not configured')
  const existing = await getComplimentaryCodeByHash(codeHash)
  if (!existing) return null
  const next = { ...existing, status: 'revoked', revokedAt: new Date().toISOString(), revokeReason: reason }
  try {
    await client.hset(STORE_KEY, { [codeHash]: JSON.stringify(next) })
  } catch (err) {
    throw new ComplimentaryAccessStoreUnavailableError(`complimentary access code store unreachable: ${err.message}`)
  }
  return next
}

// The one atomic mutation. KEYS[1] = STORE_KEY, KEYS[2] = the durable
// post-redemption claim key (keyed by tenantId -- the tenant already
// exists by the time this runs, unlike accessCodeStore.js's own
// pre-tenant, email-keyed claim ledger). Writes the claim in the SAME
// operation that increments redemptionCount, so a redemption is never
// "counted but unrecoverable" -- see getComplimentaryRedemptionClaim()'s
// own header for why this matters (the subsequent tenant_config write is a
// separate, potentially-failing step this store has no visibility into).
const REDEEM_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return false end
local ok, code = pcall(cjson.decode, raw)
if not ok then return false end
if code.status ~= 'active' then return false end
if code.redemptionDeadline and code.redemptionDeadline ~= cjson.null and code.redemptionDeadline ~= '' and code.redemptionDeadline < ARGV[4] then
  return false
end
if code.redemptionCount >= code.maxRedemptions then return false end
code.redemptionCount = code.redemptionCount + 1
if not code.redemptions or code.redemptions == cjson.null then code.redemptions = {} end
table.insert(code.redemptions, { tenantId = ARGV[2], userId = ARGV[3], redeemedAt = ARGV[4] })
code.redeemedAt = ARGV[4]
code.redeemedByUserId = ARGV[3]
code.tenantId = ARGV[2]
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(code))
redis.call('SET', KEYS[2], ARGV[5], 'EX', ARGV[6])
return cjson.encode(code)
`

export class ComplimentaryCodeInvalidError extends Error {}

// Shared, non-destructive validation -- both previewComplimentaryCode() and
// redeemComplimentaryCode() run the EXACT same checks before either decides
// what to do next. Never mutates anything. Deliberately the SAME generic
// error for every failure mode (unknown/revoked/expired/exhausted/malformed)
// so a guessed code gets no signal beyond "wrong" -- mirrors
// accessCodeStore.js's own no-enumeration-adjacent discipline.
async function validateComplimentaryCodeForRedemption(codeHash) {
  const existing = await getComplimentaryCodeByHash(codeHash)
  if (!existing || existing.status !== 'active') {
    throw new ComplimentaryCodeInvalidError('This code is invalid or can no longer be used.')
  }
  if (existing.redemptionDeadline && Date.parse(existing.redemptionDeadline) < Date.now()) {
    throw new ComplimentaryCodeInvalidError('This code is invalid or can no longer be used.')
  }
  if (existing.redemptionCount >= existing.maxRedemptions) {
    throw new ComplimentaryCodeInvalidError('This code is invalid or can no longer be used.')
  }
  return existing
}

// Non-destructive preview -- never touches redemptionCount/redemptions.
export async function previewComplimentaryCode({ rawCode }) {
  const client = getClient()
  if (!client) throw new ComplimentaryAccessStoreUnavailableError('complimentary access code store is not configured')
  const codeHash = hashComplimentaryCode(rawCode)
  const existing = await validateComplimentaryCodeForRedemption(codeHash)
  return {
    planId: existing.planId, durationDays: existing.durationDays,
    maxLocations: existing.maxLocations, maxUsers: existing.maxUsers,
    codeHash,
  }
}

// Durable, post-redemption recovery claim -- keyed by tenantId (the stable
// identity that already exists by the time this module is ever called,
// unlike accessCodeStore.js's pre-tenant email-keyed claim). If the atomic
// REDEEM_SCRIPT succeeds but the CALLER's subsequent tenant_config write
// fails (a CAS conflict, a transient store outage), this claim lets a
// retried request resume the SAME grant result rather than either
// re-consuming a second redemption slot or leaving the tenant with a
// burned code and no grant. Cleared (best-effort) once the tenant_config
// write genuinely succeeds -- see clearComplimentaryRedemptionClaim().
const CLAIM_KEY_PREFIX = 'complimentary_access_claims:v1'
const CLAIM_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days, matching accessCodeStore.js's own claim TTL

function claimKey(tenantId) {
  return `${CLAIM_KEY_PREFIX}:${tenantId}`
}

export async function getComplimentaryRedemptionClaim(tenantId) {
  const client = getClient()
  if (!client) throw new ComplimentaryAccessStoreUnavailableError('complimentary access code store is not configured')
  let raw
  try {
    raw = await client.get(claimKey(tenantId))
  } catch (err) {
    throw new ComplimentaryAccessStoreUnavailableError(`complimentary access code store unreachable: ${err.message}`)
  }
  const pointer = parseRecord(raw)
  if (!pointer || typeof pointer.codeHash !== 'string') return null
  const record = await getComplimentaryCodeByHash(pointer.codeHash)
  if (!record) return null
  return {
    planId: record.planId, durationDays: record.durationDays,
    maxLocations: record.maxLocations, maxUsers: record.maxUsers,
    codeHash: pointer.codeHash,
  }
}

export async function clearComplimentaryRedemptionClaim(tenantId) {
  const client = getClient()
  if (!client) return
  try {
    await client.del(claimKey(tenantId))
  } catch (err) {
    console.error(`[complimentaryAccessStore] failed to clear redemption claim for a tenant (non-fatal): ${err.message}`)
  }
}

// tenantId/userId are ALWAYS server-derived by the caller
// (session/[action].js's redeemComplimentaryCodeAction(), from the
// authenticated Owner's own session) -- this function never accepts a
// tenantId/userId that didn't come from that verified identity. Returns
// the plan/duration/limit fields from the record AT THE MOMENT OF
// SUCCESSFUL REDEMPTION -- never from client input, since the client sends
// only the raw code string.
export async function redeemComplimentaryCode({ rawCode, tenantId, userId }) {
  const client = getClient()
  if (!client) throw new ComplimentaryAccessStoreUnavailableError('complimentary access code store is not configured')
  const codeHash = hashComplimentaryCode(rawCode)

  await validateComplimentaryCodeForRedemption(codeHash)

  const nowIso = new Date().toISOString()
  const claimPayload = JSON.stringify({ codeHash })
  let resultRaw
  try {
    resultRaw = await client.eval(
      REDEEM_SCRIPT,
      [STORE_KEY, claimKey(tenantId)],
      [codeHash, tenantId, userId, nowIso, claimPayload, String(CLAIM_TTL_SECONDS)]
    )
  } catch (err) {
    throw new ComplimentaryAccessStoreUnavailableError(`complimentary access code store unreachable: ${err.message}`)
  }
  if (!resultRaw) {
    // Lost the race (another request consumed the last slot, or it was
    // revoked/expired between the pre-check above and this atomic call) --
    // same generic message, so timing differences reveal nothing.
    throw new ComplimentaryCodeInvalidError('This code is invalid or can no longer be used.')
  }
  const finalRecord = parseRecord(resultRaw)
  return {
    planId: finalRecord.planId, durationDays: finalRecord.durationDays,
    maxLocations: finalRecord.maxLocations, maxUsers: finalRecord.maxUsers,
    codeHash,
  }
}
