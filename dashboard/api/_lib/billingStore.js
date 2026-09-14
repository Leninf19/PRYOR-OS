// Phase B.10 -- Stripe SDK + Billing Store Foundation. This is the
// dedicated, server-only projection of a tenant's Stripe billing identity
// and subscription state -- deliberately SEPARATE from
// tenantConfigStore.js's `commercial` field (see the B.9 design report's
// Part D for the full tradeoff discussion). tenant_config.commercial stays
// the ONLY thing the entitlement resolver ever reads; this store exists so
// a future webhook handler (B.11+) has somewhere durable, CAS-protected,
// and idempotency-checked to land Stripe facts BEFORE projecting them
// forward into `commercial` -- it is never itself consulted by
// entitlementResolution.js/commercialOperationPolicy.js.
//
// Storage layout, all in the same Upstash Redis instance every other _lib
// store already uses:
//
//   billing:v1                          (hash, field = tenantId)
//     -- one record per tenant, the schema documented at BILLING_RECORD
//        FIELDS below.
//   billing_customer_index:v1:{stripeCustomerId}     -> tenantId (plain key, no TTL)
//   billing_subscription_index:v1:{stripeSubscriptionId} -> tenantId (plain key, no TTL)
//     -- the ONLY authoritative way a future webhook handler resolves
//        "which tenant does this Stripe object belong to." NEVER resolved
//        from a Stripe object's own metadata alone (metadata is
//        cross-check information only, per B.9 Part D) -- these indices
//        are written server-side, exactly once per real association, and
//        are immutable under normal operation (see claimCustomerIndex()/
//        claimSubscriptionIndex() below for the exact collision rules).
//   stripe_event:v1:{eventId}           (plain key, 90-day TTL)
//     -- the at-least-once-delivery-safe event ledger a future webhook
//        handler claims an eventId against before applying any projection
//        change, and marks processed/failed when done. A claim held past
//        its short processing lease (see claimStripeEvent()'s own header)
//        becomes reclaimable by a fresh attempt -- "only-once processing"
//        would silently drop a Stripe fact if a worker crashed mid-claim;
//        this design never does.
//
// NOTHING in this file ever writes tenant_config.commercial, and nothing in
// this file ever calls the Stripe API -- it is pure Redis storage
// plumbing, exactly like accessCodeStore.js is pure storage plumbing for
// access codes. A future webhook handler (B.11+) is the first caller that
// will read a real Stripe event, call functions here to record/claim it,
// and SEPARATELY call into trialLifecycle.js-style commercial-projection
// logic (not yet written) to update `commercial`. That two-step split is
// deliberate and unchanged by this phase.
//
// This file also deliberately does NOT duplicate plan entitlements,
// feature flags, or location/seat/AI/storage limits -- those remain
// entirely PRYOR's own (planEntitlements.js), never derived from or stored
// alongside anything here (per B.9 Part C's authority split).

import { Redis } from '@upstash/redis'
import { randomBytes } from 'crypto'

const BILLING_KEY = 'billing:v1'
const CUSTOMER_INDEX_PREFIX = 'billing_customer_index:v1'
const SUBSCRIPTION_INDEX_PREFIX = 'billing_subscription_index:v1'
const EVENT_KEY_PREFIX = 'stripe_event:v1'
// 90 days -- far longer than Stripe's own webhook redelivery window, but
// bounded rather than unbounded growth (per B.9 Part J). The billing
// record itself and the two reverse indices below carry NO TTL -- they
// must survive indefinitely, exactly like tenant_config.
const EVENT_TTL_SECONDS = 90 * 24 * 60 * 60

const TENANT_ID_PATTERN = /^t_[a-z0-9-]+$/

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class BillingStoreUnavailableError extends Error {}
export class BillingRecordNotFoundError extends Error {}
export class BillingRecordAlreadyExistsError extends Error {}
// Thrown by updateBillingRecord() when expectedVersion no longer matches
// the record's CURRENT version -- something else (a concurrent webhook
// delivery, a support action) wrote to this tenant's billing record first.
// Carries the CURRENT record (from the same atomic script read used for
// the comparison, never a second racy GET), mirroring
// tenantConfigStore.js's ConfigVersionConflictError exactly.
export class BillingVersionConflictError extends Error {
  constructor(message, currentRecord) {
    super(message)
    this.currentRecord = currentRecord ?? null
  }
}
// Thrown by claimCustomerIndex()/claimSubscriptionIndex() when the Stripe
// object id is already durably mapped to a DIFFERENT tenant -- this is the
// structural fail-closed guarantee behind B.9's "a Subscription must not
// be attachable to arbitrary tenantId" and "duplicate webhook events
// cannot create duplicate subscriptions" invariants.
export class BillingIndexCollisionError extends Error {}

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

function assertValidTenantId(tenantId, fnName) {
  if (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new TypeError(`${fnName}: invalid tenantId ${JSON.stringify(tenantId)}`)
  }
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

// ===========================================================================
// Part F -- lightweight structural validation of provider identifiers.
// These prove nothing about authorization by themselves (per B.9's own
// explicit caveat) -- they only prevent malformed/corrupt local state from
// ever being persisted. Real authorization comes from claimCustomerIndex()/
// claimSubscriptionIndex()'s server-created, collision-checked associations
// and, eventually, from Stripe's own signature-verified webhook delivery.
// ===========================================================================

export function isValidStripeCustomerId(v) {
  return v === null || (typeof v === 'string' && /^cus_[A-Za-z0-9]+$/.test(v))
}
export function isValidStripeSubscriptionId(v) {
  return v === null || (typeof v === 'string' && /^sub_[A-Za-z0-9]+$/.test(v))
}
export function isValidStripePriceId(v) {
  return v === null || (typeof v === 'string' && /^price_[A-Za-z0-9]+$/.test(v))
}
export function isValidStripePaymentMethodId(v) {
  return v === null || (typeof v === 'string' && /^pm_[A-Za-z0-9]+$/.test(v))
}
// Event ids are never nullable -- a claim always names a real event.
export function isValidStripeEventId(v) {
  return typeof v === 'string' && /^evt_[A-Za-z0-9]+$/.test(v)
}

function isValidIsoTimestampOrNull(v) {
  return v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)))
}

// ===========================================================================
// Part G -- the provider (Stripe) subscription-status vocabulary, kept
// deliberately separate from entitlementResolution.js's own
// COMMERCIAL_STATUSES. This is the raw vocabulary Stripe itself uses;
// translating it into a PRYOR commercialStatus is billingStatusProjection.js's
// job (a pure, non-writing mapping helper), never this store's.
// ===========================================================================

export const PROVIDER_SUBSCRIPTION_STATUSES = Object.freeze([
  'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused',
])

export function isValidProviderSubscriptionStatus(v) {
  return v === null || PROVIDER_SUBSCRIPTION_STATUSES.includes(v)
}

// ===========================================================================
// Part M -- payment-consent record shape. Lives ON the billing record
// (rather than a separate store) because it is fundamentally tied to the
// same tenant's billing identity and benefits from the same CAS protection
// -- no new store needed for one small, rarely-written object. NEVER
// stores card data. NEVER marked accepted except by an explicit, real
// future consent action (no such action exists yet in B.10 -- this is
// schema/validation only).
// ===========================================================================

function isValidConsent(v) {
  if (v === null) return true
  return (
    v !== null && typeof v === 'object' && !Array.isArray(v) &&
    typeof v.acceptedAt === 'string' && !Number.isNaN(Date.parse(v.acceptedAt)) &&
    typeof v.termsVersion === 'string' && v.termsVersion.length > 0 &&
    v.recurringBillingAccepted === true &&
    Object.keys(v).every(k => ['acceptedAt', 'termsVersion', 'recurringBillingAccepted'].includes(k))
  )
}

// ===========================================================================
// Part Q -- the exact, exhaustive allowlist of fields a caller may ever set
// via createBillingRecord()/updateBillingRecord(). This is the structural
// guarantee that no future endpoint can smuggle arbitrary request-body
// fields into a billing record via `{...req.body}` -- both functions below
// throw on any key outside this list, and neither accepts a raw object
// spread from an HTTP request. Note `commercialStatus` is not, and can
// never be, a field here at all -- that value lives exclusively in
// tenant_config.commercial, a completely different store this file never
// touches.
// ===========================================================================
const MUTABLE_FIELDS = Object.freeze([
  'stripeCustomerId', 'stripeSubscriptionId', 'stripePriceId', 'subscriptionStatus',
  'currentPeriodStart', 'currentPeriodEnd', 'cancelAtPeriodEnd', 'defaultPaymentMethodId',
  'lastStripeObjectCreatedAt', 'lastStripeEventCreatedAt', 'consent',
])

function validateBillingFields(fields) {
  if (!isValidStripeCustomerId(fields.stripeCustomerId)) {
    throw new TypeError(`invalid stripeCustomerId ${JSON.stringify(fields.stripeCustomerId)}`)
  }
  if (!isValidStripeSubscriptionId(fields.stripeSubscriptionId)) {
    throw new TypeError(`invalid stripeSubscriptionId ${JSON.stringify(fields.stripeSubscriptionId)}`)
  }
  if (!isValidStripePriceId(fields.stripePriceId)) {
    throw new TypeError(`invalid stripePriceId ${JSON.stringify(fields.stripePriceId)}`)
  }
  if (!isValidProviderSubscriptionStatus(fields.subscriptionStatus)) {
    throw new TypeError(`invalid subscriptionStatus ${JSON.stringify(fields.subscriptionStatus)}`)
  }
  if (!isValidIsoTimestampOrNull(fields.currentPeriodStart)) {
    throw new TypeError(`invalid currentPeriodStart ${JSON.stringify(fields.currentPeriodStart)}`)
  }
  if (!isValidIsoTimestampOrNull(fields.currentPeriodEnd)) {
    throw new TypeError(`invalid currentPeriodEnd ${JSON.stringify(fields.currentPeriodEnd)}`)
  }
  if (fields.cancelAtPeriodEnd !== null && typeof fields.cancelAtPeriodEnd !== 'boolean') {
    throw new TypeError(`invalid cancelAtPeriodEnd ${JSON.stringify(fields.cancelAtPeriodEnd)}`)
  }
  if (!isValidStripePaymentMethodId(fields.defaultPaymentMethodId)) {
    throw new TypeError(`invalid defaultPaymentMethodId ${JSON.stringify(fields.defaultPaymentMethodId)}`)
  }
  if (fields.lastStripeObjectCreatedAt !== null && typeof fields.lastStripeObjectCreatedAt !== 'number') {
    throw new TypeError(`invalid lastStripeObjectCreatedAt ${JSON.stringify(fields.lastStripeObjectCreatedAt)}`)
  }
  if (fields.lastStripeEventCreatedAt !== null && typeof fields.lastStripeEventCreatedAt !== 'number') {
    throw new TypeError(`invalid lastStripeEventCreatedAt ${JSON.stringify(fields.lastStripeEventCreatedAt)}`)
  }
  if (!isValidConsent(fields.consent)) {
    throw new TypeError(`invalid consent ${JSON.stringify(fields.consent)}`)
  }
}

function assertOnlyKnownFields(fields, fnName) {
  const unknown = Object.keys(fields).filter(k => !MUTABLE_FIELDS.includes(k))
  if (unknown.length > 0) {
    throw new TypeError(`${fnName}: unknown field(s) ${unknown.join(', ')} -- only ${MUTABLE_FIELDS.join(', ')} may be set`)
  }
}

const DEFAULT_FIELDS = Object.freeze({
  stripeCustomerId: null, stripeSubscriptionId: null, stripePriceId: null,
  subscriptionStatus: null,
  currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: null,
  defaultPaymentMethodId: null,
  lastStripeObjectCreatedAt: null, lastStripeEventCreatedAt: null,
  consent: null,
})

// ===========================================================================
// Part C/E -- billing record CRUD + CAS.
// ===========================================================================

export async function getBillingRecord(tenantId) {
  assertValidTenantId(tenantId, 'getBillingRecord')
  const client = getClient()
  if (!client) throw new BillingStoreUnavailableError('billing store is not configured')
  let raw
  try {
    raw = await client.hget(BILLING_KEY, tenantId)
  } catch (err) {
    throw new BillingStoreUnavailableError(`billing store unreachable: ${err.message}`)
  }
  return parseRecord(raw)
}

// Creates the tenant's ONE billing record. Fails if one already exists --
// callers that want "create if absent, else return existing" must call
// getBillingRecord() first themselves; this function never silently
// overwrites.
export async function createBillingRecord(tenantId, fields = {}) {
  assertValidTenantId(tenantId, 'createBillingRecord')
  const client = getClient()
  if (!client) throw new BillingStoreUnavailableError('billing store is not configured')
  assertOnlyKnownFields(fields, 'createBillingRecord')
  const merged = { ...DEFAULT_FIELDS, ...fields }
  validateBillingFields(merged)

  const existing = await getBillingRecord(tenantId)
  if (existing) {
    throw new BillingRecordAlreadyExistsError(`createBillingRecord: a billing record already exists for tenant ${JSON.stringify(tenantId)}`)
  }
  const now = new Date().toISOString()
  const next = {
    version: 1,
    tenantId,
    provider: 'stripe',
    ...merged,
    billingCreatedAt: now,
    billingUpdatedAt: now,
  }
  try {
    await client.hset(BILLING_KEY, { [tenantId]: JSON.stringify(next) })
  } catch (err) {
    throw new BillingStoreUnavailableError(`billing store unreachable: ${err.message}`)
  }
  return next
}

const CAS_SCRIPT = `
-- SCRIPT: BILLING_CAS
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local currentVersion = '0'
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and decoded and decoded.version then
    currentVersion = tostring(decoded.version)
  end
end
if currentVersion ~= ARGV[2] then
  return raw or false
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return true
`

// CAS (compare-and-swap) update -- expectedVersion is REQUIRED (unlike
// tenantConfigStore.js's upsertTenantConfig(), which allows an
// optional/plain-write path for short single-step callers). Billing
// projection writes are explicitly required (B.9/B.10) to always use
// optimistic concurrency, with no last-write-wins escape hatch, since two
// concurrent Stripe webhook deliveries racing a plain write is exactly the
// lost-update scenario this store must never allow.
export async function updateBillingRecord(tenantId, patch, { expectedVersion } = {}) {
  assertValidTenantId(tenantId, 'updateBillingRecord')
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new TypeError('updateBillingRecord: expectedVersion is required and must be a positive integer')
  }
  const client = getClient()
  if (!client) throw new BillingStoreUnavailableError('billing store is not configured')
  assertOnlyKnownFields(patch, 'updateBillingRecord')

  const existing = await getBillingRecord(tenantId)
  if (!existing) {
    throw new BillingRecordNotFoundError(`updateBillingRecord: no billing record exists for tenant ${JSON.stringify(tenantId)}`)
  }
  const merged = { ...DEFAULT_FIELDS, ...existing, ...patch }
  validateBillingFields(merged)

  const now = new Date().toISOString()
  const next = {
    ...merged,
    tenantId,
    provider: 'stripe',
    version: existing.version + 1,
    billingCreatedAt: existing.billingCreatedAt,
    billingUpdatedAt: now,
  }
  let evalResult
  try {
    evalResult = await client.eval(CAS_SCRIPT, [BILLING_KEY], [tenantId, String(expectedVersion), JSON.stringify(next)])
  } catch (err) {
    throw new BillingStoreUnavailableError(`billing store unreachable: ${err.message}`)
  }
  if (evalResult !== true && evalResult !== 1) {
    const current = evalResult ? parseRecord(evalResult) : existing
    throw new BillingVersionConflictError(
      `updateBillingRecord: version conflict for tenant ${JSON.stringify(tenantId)} -- expected ${expectedVersion}, found ${current?.version ?? 'unknown'}`,
      current,
    )
  }
  return next
}

// ===========================================================================
// Part D -- reverse indices. Atomic claim: idempotent for the SAME
// tenantId (a retried/duplicated claim of an association that already
// exists is a harmless no-op success), rejected (BillingIndexCollisionError)
// for a DIFFERENT tenantId (someone/something is trying to reassign a
// Stripe object that already durably belongs to another tenant). No TTL,
// ever -- these mappings must survive indefinitely.
// ===========================================================================

const INDEX_CLAIM_SCRIPT = `
-- SCRIPT: INDEX_CLAIM
local existing = redis.call('GET', KEYS[1])
if existing then
  if existing == ARGV[1] then return 1 else return 0 end
end
redis.call('SET', KEYS[1], ARGV[1])
return 1
`

async function claimIndex(prefix, providerId, tenantId, fnName) {
  assertValidTenantId(tenantId, fnName)
  const client = getClient()
  if (!client) throw new BillingStoreUnavailableError('billing store is not configured')
  const key = `${prefix}:${providerId}`
  let result
  try {
    result = await client.eval(INDEX_CLAIM_SCRIPT, [key], [tenantId])
  } catch (err) {
    throw new BillingStoreUnavailableError(`billing store unreachable: ${err.message}`)
  }
  if (result !== 1 && result !== true) {
    throw new BillingIndexCollisionError(`${fnName}: ${providerId} is already mapped to a different tenant`)
  }
}

async function getTenantIdForIndex(prefix, providerId) {
  const client = getClient()
  if (!client) throw new BillingStoreUnavailableError('billing store is not configured')
  try {
    return (await client.get(`${prefix}:${providerId}`)) ?? null
  } catch (err) {
    throw new BillingStoreUnavailableError(`billing store unreachable: ${err.message}`)
  }
}

export async function claimCustomerIndex(stripeCustomerId, tenantId) {
  if (!isValidStripeCustomerId(stripeCustomerId) || stripeCustomerId === null) {
    throw new TypeError(`claimCustomerIndex: invalid stripeCustomerId ${JSON.stringify(stripeCustomerId)}`)
  }
  return claimIndex(CUSTOMER_INDEX_PREFIX, stripeCustomerId, tenantId, 'claimCustomerIndex')
}

export async function getTenantIdForCustomer(stripeCustomerId) {
  return getTenantIdForIndex(CUSTOMER_INDEX_PREFIX, stripeCustomerId)
}

export async function claimSubscriptionIndex(stripeSubscriptionId, tenantId) {
  if (!isValidStripeSubscriptionId(stripeSubscriptionId) || stripeSubscriptionId === null) {
    throw new TypeError(`claimSubscriptionIndex: invalid stripeSubscriptionId ${JSON.stringify(stripeSubscriptionId)}`)
  }
  return claimIndex(SUBSCRIPTION_INDEX_PREFIX, stripeSubscriptionId, tenantId, 'claimSubscriptionIndex')
}

export async function getTenantIdForSubscription(stripeSubscriptionId) {
  return getTenantIdForIndex(SUBSCRIPTION_INDEX_PREFIX, stripeSubscriptionId)
}

// ===========================================================================
// Part J -- Stripe webhook event ledger. Phase B.10 pre-commit correction:
// the original design here treated "claim" as one-shot ("first claim wins,
// every later claim is a permanent no-op"), which is unsafe under Stripe's
// own at-least-once delivery guarantee -- if a worker crashed AFTER
// claiming an event but BEFORE actually applying its billing projection,
// every future retry of that same event would be silently rejected as a
// duplicate, and Stripe's authoritative fact would never be applied. The
// fix: at-least-once DELIVERY handling (a claim can be reclaimed after a
// bounded processing lease expires, or after an explicit failure) combined
// with idempotent APPLICATION (a `processed` event can never be reclaimed
// or reprocessed) -- "only-once processing attempt" is replaced by
// "at-least-once attempts, exactly-once successful application."
//
// State machine (`status` field): claimed -> processed (terminal, never
// reclaimable) OR claimed -> failed (retryable: a fresh claimStripeEvent()
// call takes ownership again) OR claimed -> claimed (a stale, abandoned
// lease is taken over by a new attempt, never by mutating the OLD
// worker's own claim). No webhook processing exists yet in B.10 -- these
// are storage primitives only, for a future handler to call.
//
// Ownership: every successful claim (new, reclaimed-after-failure, or
// reclaimed-after-stale-lease) is issued a fresh, random `processingToken`.
// markStripeEventProcessed()/markStripeEventFailed() require that EXACT
// token -- a worker whose lease has since expired (and been taken over by
// someone else) holds a now-stale token that can never mark the NEWER
// claim as processed or failed, mirroring the token-checked-ownership
// discipline tokenStore.js's GETDEL/pendingRegistrationStore.js locks
// already use elsewhere in this codebase.
//
// Lease duration: 120 seconds. Chosen deliberately short relative to the
// 90-day dedup TTL (a completely different, much longer-lived concern --
// see the header note on EVENT_TTL_SECONDS) but comfortably longer than
// any realistic serverless webhook handler execution time (Vercel's
// Hobby-tier function timeout is 10s; Pro/Enterprise can configure up to
// 60-300s, but a webhook handler doing a handful of Redis round trips has
// no legitimate reason to run anywhere near that long). 120 seconds gives
// a wide safety margin over normal execution time while still recovering
// quickly (well within Stripe's own multi-day retry window) if a worker
// genuinely crashes mid-processing.
//
// *** B.11 IMPLEMENTATION CONTRACT *** -- a future webhook handler's
// per-event work (claim -> apply projection -> mark processed/failed) MUST
// complete comfortably inside this 120-second window. If B.11 ever
// introduces per-event processing that can legitimately approach or exceed
// it, that work must implement token-checked lease renewal/heartbeat
// (re-extending leaseExpiresAtMs while presenting the SAME processingToken,
// using the same ownership check markStripeEvent() already enforces)
// BEFORE relying on a longer duration -- never silently let a slow handler
// run unprotected under a lease shorter than its own real execution time,
// which would let a second worker reclaim and double-process a still-live
// attempt.
const EVENT_LEASE_SECONDS = 120

// Only necessary bookkeeping fields are ever stored -- never the raw
// Stripe webhook payload. `result` is a short caller-supplied note (e.g. an
// error message on failure), never the full event body.
function assertValidEventLedgerInputs(eventId, eventType, stripeCreatedAt) {
  if (!isValidStripeEventId(eventId)) {
    throw new TypeError(`invalid eventId ${JSON.stringify(eventId)}`)
  }
  if (typeof eventType !== 'string' || !eventType) {
    throw new TypeError('eventType must be a non-empty string')
  }
  if (!Number.isFinite(stripeCreatedAt)) {
    throw new TypeError('stripeCreatedAt must be a Stripe epoch-seconds number')
  }
}

function randomProcessingToken() {
  return randomBytes(16).toString('hex')
}

// -- SCRIPT: EVENT_CLAIM --
// Atomically: brand-new event -> claimed (attemptCount 1). Existing +
// status 'processed' -> refused (already_processed). Existing + status
// 'claimed' + lease still active -> refused (lease_active, another worker
// owns it right now). Existing + (status 'failed', OR status 'claimed'
// with an EXPIRED lease) -> reclaimed: new processingToken, new lease,
// attemptCount incremented. All timestamps stored as epoch milliseconds
// (not ISO strings, unlike the rest of this codebase's convention) since
// Lua has no reliable ISO-date parsing and the lease comparison must be a
// plain numeric comparison done atomically inside the script itself.
const EVENT_CLAIM_SCRIPT = `
-- SCRIPT: EVENT_CLAIM
local raw = redis.call('GET', KEYS[1])
local nowMs = tonumber(ARGV[1])
local leaseMs = tonumber(ARGV[2])
local newToken = ARGV[3]
local freshRecordJson = ARGV[4]
local ttlSeconds = tonumber(ARGV[5])

if raw then
  local ok, rec = pcall(cjson.decode, raw)
  if ok and rec then
    if rec.status == 'processed' then
      return cjson.encode({claimed = false, reason = 'already_processed', record = rec})
    end
    local leaseExpiresAtMs = tonumber(rec.leaseExpiresAtMs) or 0
    if rec.status == 'claimed' and leaseExpiresAtMs > nowMs then
      return cjson.encode({claimed = false, reason = 'lease_active', record = rec})
    end
    -- Either explicitly 'failed' (always retryable) or 'claimed' with an
    -- expired lease (an abandoned/crashed attempt) -- take over.
    rec.status = 'claimed'
    rec.processingToken = newToken
    rec.claimedAtMs = nowMs
    rec.leaseExpiresAtMs = nowMs + leaseMs
    rec.attemptCount = (rec.attemptCount or 0) + 1
    local nextJson = cjson.encode(rec)
    redis.call('SET', KEYS[1], nextJson, 'EX', ttlSeconds)
    return cjson.encode({claimed = true, reason = 'reclaimed', record = nextJson})
  end
end

redis.call('SET', KEYS[1], freshRecordJson, 'EX', ttlSeconds)
return cjson.encode({claimed = true, reason = 'new', record = freshRecordJson})
`

// Claims an eventId for processing. Returns { claimed, reason,
// processingToken, record }: `processingToken` is present ONLY when
// `claimed` is true -- the caller MUST hold onto it and pass it to
// markStripeEventProcessed()/markStripeEventFailed() when done.
// `reason` is one of 'new' | 'reclaimed' | 'already_processed' |
// 'lease_active'. A caller sees `claimed: false` for the last two -- it
// must not process the event (either it was already durably applied, or
// another worker currently holds an active lease on it).
export async function claimStripeEvent({ eventId, eventType, stripeCreatedAt, providerObjectId = null, tenantId = null }) {
  assertValidEventLedgerInputs(eventId, eventType, stripeCreatedAt)
  const client = getClient()
  if (!client) throw new BillingStoreUnavailableError('billing store is not configured')
  const key = `${EVENT_KEY_PREFIX}:${eventId}`
  const nowMs = Date.now()
  const newToken = randomProcessingToken()
  const freshRecord = {
    eventId, eventType, stripeCreatedAt, providerObjectId, tenantId,
    status: 'claimed', processingToken: newToken,
    claimedAtMs: nowMs, leaseExpiresAtMs: nowMs + EVENT_LEASE_SECONDS * 1000,
    processedAtMs: null, failedAtMs: null,
    attemptCount: 1, result: null,
  }
  let raw
  try {
    raw = await client.eval(
      EVENT_CLAIM_SCRIPT,
      [key],
      [String(nowMs), String(EVENT_LEASE_SECONDS * 1000), newToken, JSON.stringify(freshRecord), String(EVENT_TTL_SECONDS)],
    )
  } catch (err) {
    throw new BillingStoreUnavailableError(`billing store unreachable: ${err.message}`)
  }
  const outcome = parseRecord(raw)
  const record = typeof outcome.record === 'string' ? parseRecord(outcome.record) : outcome.record
  const claimed = outcome.claimed === true
  // A caller that did NOT win this claim (already_processed / lease_active)
  // must never see the CURRENT owner's real processingToken via the
  // returned record either -- otherwise a losing caller could steal it and
  // falsely mark another worker's active claim processed/failed.
  if (!claimed && record && typeof record === 'object') record.processingToken = null
  return {
    claimed,
    reason: outcome.reason,
    processingToken: claimed ? record.processingToken : null,
    record,
  }
}

export async function getStripeEventRecord(eventId) {
  if (!isValidStripeEventId(eventId)) {
    throw new TypeError(`getStripeEventRecord: invalid eventId ${JSON.stringify(eventId)}`)
  }
  const client = getClient()
  if (!client) throw new BillingStoreUnavailableError('billing store is not configured')
  try {
    return parseRecord(await client.get(`${EVENT_KEY_PREFIX}:${eventId}`))
  } catch (err) {
    throw new BillingStoreUnavailableError(`billing store unreachable: ${err.message}`)
  }
}

// Thrown by markStripeEventProcessed()/markStripeEventFailed() when the
// supplied processingToken no longer matches the ledger record's CURRENT
// token -- either the lease already expired and a different worker took
// over (this worker's attempt is stale), or the eventId is unrecognized.
// A stale-token caller must NEVER be able to mark a newer claim as
// processed or failed -- this is the exact ownership guarantee the lease
// design exists to provide.
export class StaleProcessingTokenError extends Error {}

// -- SCRIPT: EVENT_MARK --
const EVENT_MARK_SCRIPT = `
-- SCRIPT: EVENT_MARK
local raw = redis.call('GET', KEYS[1])
if not raw then
  return cjson.encode({ok = false, reason = 'not_found'})
end
local ok, rec = pcall(cjson.decode, raw)
if not ok or not rec then
  return cjson.encode({ok = false, reason = 'not_found'})
end
if rec.processingToken ~= ARGV[1] then
  return cjson.encode({ok = false, reason = 'stale_token'})
end
local nowMs = tonumber(ARGV[2])
local finalStatus = ARGV[3]
local resultNote = ARGV[4]
rec.status = finalStatus
if finalStatus == 'processed' then
  rec.processedAtMs = nowMs
else
  rec.failedAtMs = nowMs
end
rec.result = resultNote
rec.processingToken = cjson.null
local ttlSeconds = tonumber(ARGV[5])
local nextJson = cjson.encode(rec)
redis.call('SET', KEYS[1], nextJson, 'EX', ttlSeconds)
return cjson.encode({ok = true, record = nextJson})
`

async function markStripeEvent(eventId, processingToken, finalStatus, result) {
  if (!isValidStripeEventId(eventId)) {
    throw new TypeError(`invalid eventId ${JSON.stringify(eventId)}`)
  }
  if (typeof processingToken !== 'string' || !processingToken) {
    throw new TypeError('processingToken is required')
  }
  const client = getClient()
  if (!client) throw new BillingStoreUnavailableError('billing store is not configured')
  const key = `${EVENT_KEY_PREFIX}:${eventId}`
  let raw
  try {
    raw = await client.eval(
      EVENT_MARK_SCRIPT,
      [key],
      [processingToken, String(Date.now()), finalStatus, result == null ? '' : String(result), String(EVENT_TTL_SECONDS)],
    )
  } catch (err) {
    throw new BillingStoreUnavailableError(`billing store unreachable: ${err.message}`)
  }
  const outcome = parseRecord(raw)
  if (outcome.reason === 'not_found') {
    throw new BillingRecordNotFoundError(`no claimed event found for ${JSON.stringify(eventId)}`)
  }
  if (!outcome.ok) {
    throw new StaleProcessingTokenError(
      `processingToken no longer matches the current claim for ${JSON.stringify(eventId)} -- this worker's lease has been superseded`
    )
  }
  const record = typeof outcome.record === 'string' ? parseRecord(outcome.record) : outcome.record
  // Lua has no native null to pass through an ARGV string -- '' is used as
  // the "no result note supplied" sentinel on the wire, normalized back to
  // a real null here so record.result matches the documented schema.
  if (record.result === '') record.result = null
  return record
}

// Marks a claimed event as durably, successfully applied -- terminal.
// Future delivery of the SAME event will forever be refused by
// claimStripeEvent() (reason: 'already_processed'); the commercial
// mutation this event caused must never be reapplied.
export async function markStripeEventProcessed(eventId, processingToken, result = null) {
  return markStripeEvent(eventId, processingToken, 'processed', result)
}

// Marks a claimed event as failed -- immediately retryable (no lease
// wait): the very next claimStripeEvent() call for this eventId will
// reclaim it with a fresh token and an incremented attemptCount.
export async function markStripeEventFailed(eventId, processingToken, result = null) {
  return markStripeEvent(eventId, processingToken, 'failed', result)
}

// ===========================================================================
// Part K -- stale-event / object-version model. A PURE helper (no I/O) a
// future webhook handler calls BEFORE applying any projection change --
// never trusts webhook receive order, only the object's own identity/
// timestamp relative to what is already durably applied. Returns true when
// the candidate event/object snapshot must NOT be applied (stale): either
// it is older than the billing record's own last-applied event, or it
// describes a DIFFERENT subscription than the tenant's current one (a
// reviewed reactivation/transition, not modeled here, is required to
// replace it -- see B.9 Part N).
// ===========================================================================

export function isStaleBillingEvent({ candidateStripeCreatedAt, candidateSubscriptionId = null }, currentRecord) {
  if (!currentRecord) return false // nothing applied yet -- cannot be stale
  if (
    currentRecord.lastStripeEventCreatedAt != null &&
    typeof candidateStripeCreatedAt === 'number' &&
    candidateStripeCreatedAt < currentRecord.lastStripeEventCreatedAt
  ) {
    return true
  }
  if (
    currentRecord.stripeSubscriptionId != null &&
    candidateSubscriptionId != null &&
    candidateSubscriptionId !== currentRecord.stripeSubscriptionId
  ) {
    return true
  }
  return false
}
