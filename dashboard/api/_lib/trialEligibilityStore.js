// Phase B.6 -- 7-day Growth trial anti-abuse. The authoritative record of
// which Google Business Profile LOCATION (never a restaurant name, address
// text, email, or tenant slug) has already consumed a normal self-service
// free trial. One GBP location may consume exactly one normal trial, ever.
//
// PRIMARY IDENTITY: the canonical Google resource name already stored
// verbatim as tenant_config.approvedLocations[].googleLocationId (e.g.
// "accounts/123/locations/456") -- this file never re-derives or reformats
// that string; callers must pass it through exactly as tenantConfigStore.js
// already persists it.
//
// CLAIM LIFECYCLE AND WHY THERE IS NO TTL (read before changing this):
// A claim is DURABLE -- once reserved, it never expires and is never
// silently reassigned. This is a deliberate choice over a TTL-based
// reservation:
//   - A TTL long enough to survive a legitimately slow retry (a transient
//     tenant_config store outage, a retried CAS after a concurrent write)
//     would be long enough that an attacker could not usefully race past
//     it either -- so a TTL buys no additional anti-abuse protection over a
//     durable reservation.
//   - A TTL short enough to "recover" a truly abandoned attempt quickly
//     would just as easily expire a legitimate slow retry, silently handing
//     the SAME GBP location's trial to a second tenant -- exactly the "no
//     second tenant receives a trial while another valid claim exists"
//     invariant this store must never violate.
//   - The actual "stuck forever" failure mode a TTL would exist to fix
//     (a tenant permanently unable to complete its own reservation) still
//     needs a human/support remediation path either way -- see Part C's
//     `claimType` schema space for a future `support_grant`/
//     `transfer_override`, deliberately NOT implemented as a customer-
//     facing endpoint in B.6.
//   - The SAME tenant can always retry indefinitely and safely: reserving
//     an already-self-owned claim is idempotent (returns the ORIGINAL
//     reservedAt/claimToken, never a new one), so a tenant whose
//     tenant_config CAS write failed after a successful reservation can
//     resume exactly where it left off, no matter how long it waits.
//
// OWNERSHIP: every mutating operation is checked against BOTH tenantId and
// a random claimToken (mirrors seatAllocationLock.js's/contentAssetStore.js's
// established ownership-token pattern) -- a caller presenting the wrong
// tenantId or a stale/wrong claimToken can never finalize or affect a claim
// it does not itself hold, and a claim can only ever transition
// reserved -> consumed for its OWN rightful tenant.
//
// FAIL-CLOSED: a genuine store outage throws TrialEligibilityStoreUnavailableError
// -- never silently treated as "no existing claim" (which would let a
// second tenant slip through during an outage) and never silently treated
// as "claim exists, deny" (which would wrongly block a legitimate first
// claimant). Callers must treat this as "cannot verify right now, do not
// start a trial this attempt" and simply try again later (the next
// tenantStatus() poll, in practice).

import { randomUUID } from 'crypto'
import { Redis } from '@upstash/redis'

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class TrialEligibilityStoreUnavailableError extends Error {}

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

function claimKey(gbpLocationKey) {
  return `trial_claim:v1:${gbpLocationKey}`
}

// Phase C (this phase): the only claimType a real reservation can carry.
// Reserved schema space for later, separately reviewed phases:
// 'support_grant' (an admin/support-issued override for a location that
// cannot get a normal trial, e.g. a genuine ownership transfer) and
// 'transfer_override' (an explicit, audited re-assignment of an existing
// claim to a new rightful tenant). Neither is implemented in B.6 -- there
// is no customer-facing release/reassign endpoint, and tenants cannot
// delete their own claim. A future admin process would write one of those
// claimTypes directly via a reviewed, audited admin action, never through
// the reservation path below.
export const TRIAL_CLAIM_TYPES = Object.freeze(['trial_consumed'])

// Atomic: creates a brand-new reservation if none exists; returns the
// EXISTING reservation unchanged if the SAME tenantId already holds it
// (idempotent retry, in either 'reserved' or 'consumed' state -- never
// overwrites reservedAt/claimToken/commercialIdentityKey on a same-tenant
// retry); denies (without mutating anything) if a DIFFERENT tenantId
// already holds any claim, reserved or consumed, for this GBP location.
const RESERVE_SCRIPT = `
local key = KEYS[1]
local tenantId = ARGV[1]
local claimToken = ARGV[2]
local now = ARGV[3]
local commercialIdentityKey = ARGV[4]
local claimType = ARGV[5]
local gbpLocationKey = ARGV[6]

local existingTenantId = redis.call('HGET', key, 'tenantId')
if not existingTenantId then
  redis.call('HSET', key,
    'gbpLocationKey', gbpLocationKey,
    'tenantId', tenantId,
    'claimToken', claimToken,
    'state', 'reserved',
    'reservedAt', now,
    'consumedAt', '',
    'commercialIdentityKey', commercialIdentityKey,
    'claimType', claimType)
  return {'reserved', claimToken, now}
end

if existingTenantId == tenantId then
  local storedToken = redis.call('HGET', key, 'claimToken')
  local storedState = redis.call('HGET', key, 'state')
  local storedReservedAt = redis.call('HGET', key, 'reservedAt')
  return {storedState, storedToken, storedReservedAt}
end

return {'denied', false, false}
`

// Atomic, ownership-checked: transitions reserved -> consumed ONLY if the
// caller presents the exact tenantId AND claimToken this claim was reserved
// with. A wrong tenantId, a wrong/stale claimToken, or a nonexistent claim
// all deny without mutating anything -- a stale holder can never finalize
// (or otherwise affect) a claim it does not currently, rightfully hold.
// Finalizing an already-consumed claim (by its own rightful tenant/token)
// is a harmless idempotent success, never an error.
const FINALIZE_SCRIPT = `
local key = KEYS[1]
local tenantId = ARGV[1]
local claimToken = ARGV[2]
local now = ARGV[3]

local storedTenantId = redis.call('HGET', key, 'tenantId')
local storedToken = redis.call('HGET', key, 'claimToken')
if not storedTenantId or storedTenantId ~= tenantId or storedToken ~= claimToken then
  return {'denied', false}
end

local state = redis.call('HGET', key, 'state')
if state == 'consumed' then
  return {'consumed', true}
end

redis.call('HSET', key, 'state', 'consumed', 'consumedAt', now)
return {'consumed', true}
`

// Reserves (or, for the SAME tenant, idempotently re-fetches) a trial claim
// for one GBP location. Returns:
//   { ok: true, state: 'reserved'|'consumed', claimToken, reservedAt }
//     -- claimToken/reservedAt are ALWAYS the claim's original values, even
//        on a same-tenant retry; the caller must anchor trialStartedAt to
//        `reservedAt`, never to the current time, so repeated retries can
//        never extend a trial's real 7-day window.
//   { ok: false, reason: 'claimed_by_another_tenant' }
//     -- this GBP location's trial already belongs to a different tenant.
// Throws TrialEligibilityStoreUnavailableError on a genuine store outage --
// callers must treat that as "cannot verify right now," never as either
// "no claim exists" or "claim denied."
export async function reserveTrialClaim(gbpLocationKey, tenantId, { commercialIdentityKey = null, claimType = 'trial_consumed' } = {}) {
  if (typeof gbpLocationKey !== 'string' || !gbpLocationKey) {
    throw new TypeError('reserveTrialClaim: gbpLocationKey is required')
  }
  if (typeof tenantId !== 'string' || !tenantId) {
    throw new TypeError('reserveTrialClaim: tenantId is required')
  }
  if (!TRIAL_CLAIM_TYPES.includes(claimType)) {
    throw new TypeError(`reserveTrialClaim: unrecognized claimType ${JSON.stringify(claimType)}`)
  }
  const client = getClient()
  if (!client) throw new TrialEligibilityStoreUnavailableError('trial eligibility store is not configured')
  const claimToken = randomUUID()
  const now = new Date().toISOString()
  let result
  try {
    result = await client.eval(
      RESERVE_SCRIPT,
      [claimKey(gbpLocationKey)],
      [tenantId, claimToken, now, commercialIdentityKey ?? '', claimType, gbpLocationKey],
    )
  } catch (err) {
    throw new TrialEligibilityStoreUnavailableError(`trial eligibility store unreachable: ${err.message}`)
  }
  const [state, tokenOrFalse, reservedAtOrFalse] = result
  if (state === 'denied') return { ok: false, reason: 'claimed_by_another_tenant' }
  return { ok: true, state, claimToken: tokenOrFalse, reservedAt: reservedAtOrFalse }
}

// Ownership-token-checked transition to 'consumed'. Returns
// { ok: true, state: 'consumed' } on success (including an idempotent
// re-finalize of an already-consumed claim this same tenant/token holds),
// or { ok: false, reason: 'invalid_claim' } if the tenantId/claimToken pair
// does not match the claim's current rightful holder (or no claim exists at
// all). Throws TrialEligibilityStoreUnavailableError on a genuine outage.
export async function finalizeTrialClaim(gbpLocationKey, tenantId, claimToken) {
  if (typeof gbpLocationKey !== 'string' || !gbpLocationKey) {
    throw new TypeError('finalizeTrialClaim: gbpLocationKey is required')
  }
  const client = getClient()
  if (!client) throw new TrialEligibilityStoreUnavailableError('trial eligibility store is not configured')
  const now = new Date().toISOString()
  let result
  try {
    result = await client.eval(FINALIZE_SCRIPT, [claimKey(gbpLocationKey)], [tenantId, claimToken, now])
  } catch (err) {
    throw new TrialEligibilityStoreUnavailableError(`trial eligibility store unreachable: ${err.message}`)
  }
  const [state] = result
  if (state === 'denied') return { ok: false, reason: 'invalid_claim' }
  return { ok: true, state }
}

// Read-only lookup, for tests/diagnostics -- never used to make an
// allow/deny decision on its own (reserveTrialClaim() is atomic and must
// always be the actual decision point).
export async function getTrialClaim(gbpLocationKey) {
  const client = getClient()
  if (!client) throw new TrialEligibilityStoreUnavailableError('trial eligibility store is not configured')
  let raw
  try {
    raw = await client.hgetall(claimKey(gbpLocationKey))
  } catch (err) {
    throw new TrialEligibilityStoreUnavailableError(`trial eligibility store unreachable: ${err.message}`)
  }
  if (!raw || Object.keys(raw).length === 0) return null
  return {
    gbpLocationKey: raw.gbpLocationKey,
    tenantId: raw.tenantId,
    claimToken: raw.claimToken,
    state: raw.state,
    reservedAt: raw.reservedAt || null,
    consumedAt: raw.consumedAt || null,
    commercialIdentityKey: raw.commercialIdentityKey || null,
    claimType: raw.claimType || null,
  }
}
