// Phase B.3 -- Seat limit enforcement (Part B). A per-tenant mutex around
// the "read current seat count -> resolve entitlements -> decide -> create
// invite OR enable existing account" sequence in settings/[action].js's
// invite-user/enable-user actions, using the SAME atomic SET NX EX +
// ownership-token-checked-release primitive dashboard/api/_lib/
// contentAssetStore.js's content-upload lock already established: a random
// ownership token (never a fixed sentinel), an atomic Lua compare-then-DEL
// release, so a stale/superseded holder's release call is a harmless no-op,
// structurally incapable of deleting a different, newer request's lock.
//
// NO HEARTBEAT/LEASE RENEWAL, UNLIKE THE CONTENT-UPLOAD LOCK -- and this is
// a deliberate, justified difference, not an oversight: that lock wraps a
// potentially multi-second Vercel Blob PUT (real network I/O to a third
// party, whose latency this codebase does not control), which genuinely
// could approach or exceed a short fixed TTL under real conditions -- that
// is exactly why it needed a renewed lease instead of a flat TTL. Every
// operation THIS lock wraps -- listUsers() (one Redis HGETALL),
// resolveTenantEntitlements() (one Redis HGET, then pure JS), and one or
// two small Redis writes (createInviteToken()'s SET + upsertUser()'s HSET,
// or a single upsertUser() for enable) -- is a small, FIXED number of fast
// Redis round trips with NO external network call (no Google, no
// Anthropic, no large payload) anywhere in between. Realistic end-to-end
// execution time is well under a second even under load. A flat,
// conservative TTL is therefore safe here in a way it provably was not for
// the content-upload lock: SEAT_LOCK_TTL_SECONDS = 10 below leaves roughly
// an order of magnitude of safety margin for serverless cold starts and
// Redis latency spikes, while still self-healing quickly (within 10s, not
// minutes) if a request genuinely crashes mid-critical-section without
// ever reaching its own release call.
//
// FAIL-CLOSED: acquireSeatAllocationLock() throws
// SeatAllocationLockUnavailableError on a genuine store outage -- never
// silently returns a token for a lock that wasn't actually acquired. An
// unverifiable seat count must never be treated as safe to allocate
// against (see settings/[action].js's own catch of this error -> 503,
// never a silent "proceed without a lock").
//
// FORWARD-LOOKING CONTRACT for a future commercial-status/plan-change
// phase (not built yet -- this codebase has NO endpoint today that can
// change an existing tenant's commercial.plan/limitsOverride at all): any
// future write that could SHRINK a tenant's maxActiveUsers (a downgrade, a
// suspension that zeroes limits, etc.) SHOULD acquire this SAME per-tenant
// lock before committing, exactly like recordLocationApproval()/
// applyEntitlementChange() bind their location-limit decision to the same
// config snapshot their own CAS write uses. Without that future
// cooperation, a downgrade committing in the exact instant between this
// lock's holder re-resolving entitlements and its own write is a genuine,
// currently-undefended race -- but no code path in this repository can
// exercise it today, since nothing yet mutates an existing tenant's plan.
// This lock DOES fully close every race between concurrent seat operations
// themselves (two invites, an invite racing an enable, two enables) for
// the same tenant, which is what Phase B.3 requires.
//
// This same forward-looking contract has a SEPARATE, ALREADY-STRUCTURAL
// counterpart for locations, not seats: tenantConfigStore.js's
// recordLocationApproval()/applyEntitlementChange() are the only functions
// permitted to change an already-committed tenant's approvedLocations, and
// applyEntitlementChange() already REQUIRES a CAS `expectedVersion` (not
// optional, unlike every other write in that file) bound to the exact
// tenant_config snapshot its own maxLocations check reads from -- see that
// file's header and entitlementResolution.js's header. Any future
// commercial-plan write that could LOWER a tenant's maxLocations (a
// downgrade, a suspension, etc.) must go through that same CAS-bound path
// (or an equivalent atomic mechanism) rather than a bare
// upsertTenantConfig() patch -- this is a distinct mechanism from the seat
// lock above (tenant_config's optimistic CAS vs. this file's pessimistic
// per-tenant mutex) -- the two enforce completely different resources
// (locations vs. seats), and neither substitutes for the other.

import { randomUUID } from 'crypto'
import { Redis } from '@upstash/redis'

const SEAT_LOCK_TTL_SECONDS = 10

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class SeatAllocationLockUnavailableError extends Error {}

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

function seatLockKey(tenantId) {
  return `seat_allocation_lock:v1:${tenantId}`
}

// Atomic compare-then-DEL: only deletes if the caller's token still
// matches what's currently stored -- the primitive that makes "a stale/
// expired former holder can never delete a newer holder's lock" true by
// construction, identical in shape to contentAssetStore.js's own
// RELEASE_SCRIPT.
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`

// Returns a fresh random ownership token on success, or null if another
// request already holds this tenant's seat-allocation lock. Throws
// SeatAllocationLockUnavailableError on a genuine store outage -- never
// silently returns a token for a lock that wasn't actually acquired.
export async function acquireSeatAllocationLock(tenantId) {
  const client = getClient()
  if (!client) throw new SeatAllocationLockUnavailableError('seat allocation lock store is not configured')
  const token = randomUUID()
  try {
    const result = await client.set(seatLockKey(tenantId), token, { nx: true, ex: SEAT_LOCK_TTL_SECONDS })
    return result === 'OK' ? token : null
  } catch (err) {
    throw new SeatAllocationLockUnavailableError(`seat allocation lock store unreachable: ${err.message}`)
  }
}

// Best-effort, but ownership-checked: deletes the lock ONLY if `token`
// still matches the current holder. Never throws -- a release failure is
// logged and otherwise ignored, since the TTL above is the backstop that
// guarantees this lock is never held forever regardless.
export async function releaseSeatAllocationLock(tenantId, token) {
  const client = getClient()
  if (!client) return
  try {
    await client.eval(RELEASE_SCRIPT, [seatLockKey(tenantId)], [token])
  } catch (err) {
    console.error(`[seatAllocationLock] failed to release seat allocation lock for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
  }
}
