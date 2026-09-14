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
import { isValidPlanId } from './planEntitlements.js'

const STORE_KEY = 'access_codes:v1'
const HUMAN_SAFE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ' // no 0/O, 1/I/L, U
const SUFFIX_LENGTH = 10

// Phase B.8 (Part H) -- a conservative, explicit ceiling on a manually
// granted access-code trial. Chosen to comfortably cover any real sales
// arrangement (a quarter's worth of days) while making it structurally
// impossible for a malformed/mistyped code to grant a multi-year trial.
export const MAX_ACCESS_CODE_TRIAL_DAYS = 90

export function isValidTrialDays(trialDays) {
  return trialDays === null || (Number.isInteger(trialDays) && trialDays >= 0 && trialDays <= MAX_ACCESS_CODE_TRIAL_DAYS)
}

// Phase B.8 pre-commit correction (Part 4) -- discount metadata is now
// persisted into canonical commercial state for a FUTURE billing phase to
// eventually interpret; it must be structurally sane the moment it is
// created, even though no billing math is computed anywhere yet (this
// phase never calculates a subscription total and never lets a discount
// change entitlements -- see accessCodeCommercial.js). Whole-percentage
// semantics (Number.isInteger, not just Number.isFinite) match how this
// product already talks about discounts elsewhere (e.g. "20% off," never
// "20.5% off"); a future billing phase can loosen this if a real product
// requirement for fractional percentages ever appears, but nothing today
// asks for one.
export function isValidDiscountPercent(discountPercent) {
  return discountPercent === null || (Number.isInteger(discountPercent) && discountPercent >= 0 && discountPercent <= 100)
}

// Safe integer cents -- finite, non-negative, whole, and within
// Number.isSafeInteger's range (so it can never silently lose precision in
// a future arithmetic step). No arbitrary product-specific upper cap is
// invented here (per this phase's own explicit instruction not to invent
// business caps) -- a future billing phase may additionally cap this
// against a real invoice value once one exists.
export function isValidDiscountFixedCents(discountFixedCents) {
  return discountFixedCents === null || (Number.isInteger(discountFixedCents) && Number.isSafeInteger(discountFixedCents) && discountFixedCents >= 0)
}

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

// Creates a new code. Returns { rawCode, record } -- rawCode is NEVER
// stored anywhere and must be shown to the calling admin exactly once by
// the caller (session/[action].js's admin action); this function itself
// never logs it.
export async function createAccessCode({
  prefix, plan, discountPercent = null, discountFixedCents = null, trialDays = null,
  paymentRequired, expiresAt = null, maxRedemptions = 1,
  allowedEmail = null, allowedEmailDomain = null, clientLabel = null, createdBy,
}) {
  const client = getClient()
  if (!client) throw new AccessCodeStoreUnavailableError('access code store is not configured')
  // Phase B.8 pre-commit correction (Part 3) -- paymentRequired has NO
  // default. Before this phase, paymentRequired was completely inert
  // (never read at redemption at all), so an omitted field silently
  // defaulting to `true` had no practical consequence. After this phase,
  // paymentRequired: true means "this code can never be redeemed until
  // billing exists" -- a caller that omits the field entirely would
  // silently mint an unusable code with no indication anything is wrong.
  // Every real creation path (dashboard/src/pages/admin/AccessCodes.jsx's
  // own explicit checkbox, always sent -- confirmed by direct audit) MUST
  // now say so explicitly; there is no safe default to fall back to.
  if (typeof paymentRequired !== 'boolean') {
    throw new TypeError('createAccessCode: paymentRequired must be explicitly true or false -- there is no default, since an omitted value now has major commercial meaning (a code that can never be redeemed until billing exists)')
  }
  // Phase B.8 (Part G) -- validated against the SAME canonical plan
  // registry the entitlement resolver itself uses (planEntitlements.js),
  // never a locally-duplicated set that could silently drift from it.
  if (!isValidPlanId(plan)) throw new TypeError(`createAccessCode: invalid plan ${JSON.stringify(plan)}`)
  if (discountPercent != null && discountFixedCents != null) {
    throw new TypeError('createAccessCode: discountPercent and discountFixedCents are mutually exclusive')
  }
  // Phase B.8 pre-commit correction (Part 4) -- structurally sane discount
  // metadata at the one authoritative creation gate. Never trusted again
  // at redemption either (see buildAccessCodeCommercialWrite()'s own
  // defensive re-check), but this is where a malformed value must first be
  // rejected outright.
  if (!isValidDiscountPercent(discountPercent)) {
    throw new TypeError(`createAccessCode: discountPercent must be null or a whole number between 0 and 100, got ${JSON.stringify(discountPercent)}`)
  }
  if (!isValidDiscountFixedCents(discountFixedCents)) {
    throw new TypeError(`createAccessCode: discountFixedCents must be null or a non-negative safe integer, got ${JSON.stringify(discountFixedCents)}`)
  }
  // Phase B.8 (Part H) -- reject negative/NaN/fractional/oversized trial
  // grants at the one place a code's parameters are ever set. Never
  // trusted again at redemption either (see buildAccessCodeCommercialWrite()
  // in accessCodeCommercial.js), but this is the authoritative gate.
  if (!isValidTrialDays(trialDays)) {
    throw new TypeError(`createAccessCode: trialDays must be null or an integer between 0 and ${MAX_ACCESS_CODE_TRIAL_DAYS}, got ${JSON.stringify(trialDays)}`)
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
//
// Phase B.8 pre-commit correction (Part 2) -- this SAME atomic script ALSO
// writes the durable redemption-claim record (KEYS[2], ARGV[5] payload,
// ARGV[6] TTL) in the identical Redis operation that increments
// redemptionCount. This is what makes the claim genuinely durable: there
// is no window where a redemption is counted but no recoverable claim
// exists (or vice versa) -- both happen atomically, or neither does. See
// getAccessCodeRedemptionClaim()'s own header for why this claim outlives
// the pending-registration record's own (shorter, activity-refreshed) TTL.
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
redis.call('SET', KEYS[2], ARGV[5], 'EX', ARGV[6])
return cjson.encode(code)
`

export class AccessCodeInvalidError extends Error {}
export class AccessCodeRestrictedError extends Error {}

// Shared, non-destructive validation -- both previewAccessCode() and
// redeemAccessCode() run the EXACT same checks (status/expiry/redemption-
// count/email/domain) before either one decides what to do next. Never
// mutates anything; the atomic count/redemptions increment lives ONLY in
// redeemAccessCode()'s own REDEEM_SCRIPT call. Returns the validated
// `existing` record on success, or throws AccessCodeInvalidError/
// AccessCodeRestrictedError exactly as redeemAccessCode() always did.
async function validateAccessCodeForRedemption(codeHash, email) {
  const existing = await getAccessCodeByHash(codeHash)
  // Deliberately the SAME generic error for "no such code," "revoked," and
  // "expired"/"exhausted" (re-checked again inside the atomic script at
  // actual redemption time) -- never distinguishing WHY a guessed code
  // failed, so brute-forcing the random suffix gets no signal beyond
  // "wrong." See tokenStore.js's own no-enumeration-adjacent discipline for
  // the same reasoning applied to invite/reset tokens.
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
  return existing
}

// Phase B.8 (Part E) -- a NON-DESTRUCTIVE preview: runs every validation
// check a real redemption would, but never touches redemptionCount/
// redemptions. Lets the caller (session/[action].js's redeemAccessCodeAction())
// inspect paymentRequired and decide whether to proceed to the real,
// irreversible redeemAccessCode() call BEFORE ever consuming a redemption
// slot -- a payment-required code that gets rejected must never burn the
// code, exactly mirroring tokenStore.js's peek-before-consume discipline
// (see session/[action].js's acceptInvite()).
export async function previewAccessCode({ rawCode, email }) {
  const client = getClient()
  if (!client) throw new AccessCodeStoreUnavailableError('access code store is not configured')
  const codeHash = hashAccessCode(rawCode)
  const existing = await validateAccessCodeForRedemption(codeHash, email)
  return {
    plan: existing.plan,
    discountPercent: existing.discountPercent,
    discountFixedCents: existing.discountFixedCents,
    trialDays: existing.trialDays,
    paymentRequired: existing.paymentRequired,
    codeHash,
  }
}

// Phase B.8 pre-commit correction (Part 2) -- the durable redemption-claim
// ledger. A successful redemption is a REAL, atomically-consumed resource
// (a maxRedemptions slot that cannot be "returned"), so its recovery
// record must outlive the pending-registration record it was originally
// discovered alongside -- that record's TTL is refreshed by ordinary
// registration activity and is NOT a durability guarantee for a genuinely
// consumed access-code redemption. This ledger is a SEPARATE Redis key,
// one per normalized registrant email (the one stable identity a
// registrant has before a tenantId/userId are ever finalized -- same
// reasoning pendingRegistrationStore.js's own key already uses), written
// ATOMICALLY inside REDEEM_SCRIPT (never a separate, racy write after the
// fact) and read by session/[action].js's redeemAccessCodeAction() BEFORE
// ever attempting a fresh redemption -- so a legitimate retry (whether
// immediate, or after re-registering the same email once the ORIGINAL
// pending-registration record has since expired) always resumes from the
// SAME frozen result, never re-consumes a second slot. A DIFFERENT
// registrant's email is a DIFFERENT ledger key entirely -- there is
// structurally nothing to steal. Never stores the raw code (only the
// hash, alongside the already-validated plan/discount/trial/payment
// fields) and is cleared (best-effort) once tenant creation actually
// succeeds -- see clearAccessCodeRedemptionClaim().
const CLAIM_KEY_PREFIX = 'access_code_redemption_claims:v1'
// 30 days -- generous enough to cover a genuinely extended outage or a
// registrant who does not immediately retry, while still bounded (never
// "forever," which would let this ledger grow unbounded for truly
// abandoned registrations that never complete at all).
const CLAIM_TTL_SECONDS = 30 * 24 * 60 * 60

function normalizeEmailForClaim(email) {
  return (email || '').trim().toLowerCase()
}

function claimKey(email) {
  return `${CLAIM_KEY_PREFIX}:${normalizeEmailForClaim(email)}`
}

// Returns the durable claim ({ plan, discountPercent, discountFixedCents,
// trialDays, paymentRequired, codeHash }) if this email has ALREADY
// successfully redeemed a code, or null otherwise. The claim record itself
// stores only a minimal { codeHash } pointer (written atomically by
// REDEEM_SCRIPT); the full plan/discount/trial/payment fields are
// re-derived here from the access-code record itself -- those fields are
// immutable once a code is created (this store has no "edit code"
// function, only create/revoke, and revocation never changes them), so
// there is exactly ONE authoritative copy, never a second one that could
// drift from it. Never destructive -- callers clear the claim explicitly
// (clearAccessCodeRedemptionClaim()) only once tenant creation genuinely
// succeeds.
export async function getAccessCodeRedemptionClaim(email) {
  const client = getClient()
  if (!client) throw new AccessCodeStoreUnavailableError('access code store is not configured')
  let raw
  try {
    raw = await client.get(claimKey(email))
  } catch (err) {
    throw new AccessCodeStoreUnavailableError(`access code store unreachable: ${err.message}`)
  }
  const pointer = parseRecord(raw)
  if (!pointer || typeof pointer.codeHash !== 'string') return null
  const record = await getAccessCodeByHash(pointer.codeHash)
  if (!record) return null // should not happen (the code record is never deleted), but never fabricate a claim from nothing
  return {
    plan: record.plan,
    discountPercent: record.discountPercent,
    discountFixedCents: record.discountFixedCents,
    trialDays: record.trialDays,
    paymentRequired: record.paymentRequired,
    codeHash: pointer.codeHash,
  }
}

// Called only after the real tenant_config + user record both exist (see
// session/[action].js's redeemAccessCodeAction()) -- best-effort; a
// failure here has no security consequence (createNewTenant()'s own
// identity check already makes a genuine second tenant for this email
// impossible regardless of whether this claim is ever cleared), it is
// purely hygiene so a fully-completed registration does not leave a
// redemption-claim record lingering for its full 30-day TTL.
export async function clearAccessCodeRedemptionClaim(email) {
  const client = getClient()
  if (!client) return
  try {
    await client.del(claimKey(email))
  } catch (err) {
    console.error(`[accessCodeStore] failed to clear redemption claim for an email: ${err.message}`)
  }
}

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

  await validateAccessCodeForRedemption(codeHash, email)

  const nowIso = new Date().toISOString()
  const claimPayload = JSON.stringify({ codeHash })
  let resultRaw
  try {
    resultRaw = await client.eval(
      REDEEM_SCRIPT,
      [STORE_KEY, claimKey(email)],
      [codeHash, tenantId, userId, nowIso, claimPayload, String(CLAIM_TTL_SECONDS)]
    )
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
