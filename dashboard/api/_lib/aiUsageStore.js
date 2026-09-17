// Phase B.4 -- commercial AI usage metering. Server-side, Redis-backed
// tracking of AI usage per tenant per UTC calendar billing period, ADDITIVE
// to (never a replacement for) Phase A's per-user/per-tenant rolling rate
// limits (rateLimit.js) and per-request input-size caps (rewriteEngine.js's/
// executive-brief.js's own MAX_* constants) -- those remain the
// authoritative abuse backstop; this store exists purely to answer "has
// this tenant used up its plan's monthly AI allowance."
//
// Key shape: ai_usage:v1:{tenantId}:{YYYY-MM} (UTC calendar month -- see
// currentUsagePeriod()). One Redis hash per tenant per month, holding
// requestCount/inputTokens/outputTokens/usageUnits as plain integer fields.
//
// WHAT IS NEVER STORED HERE: review text, draft text, prompts, generated
// replies/briefings, or any other customer content -- only integer
// counters. This mirrors rewriteEngine.js's/executive-brief.js's existing
// logAiUsage() convention (character counts only, never content) one level
// further: even the character-count logging stays a log line, never
// persisted; this store persists only token counts and the derived
// weighted usageUnits (aiUsageUnits.js).
//
// WHY RAW inputTokens/outputTokens ARE KEPT ALONGSIDE usageUnits: usageUnits
// is a WEIGHTED, VERSIONED derived value (aiUsageUnits.js) -- if the weight
// table is ever recalibrated, historical usageUnits totals become
// incomparable to newly-recorded ones. Keeping the raw token totals means a
// future recalibration can be validated/backfilled against real historical
// data rather than starting blind.
//
// CONCURRENCY MODEL (see rewriteEngine.js's/executive-brief.js's own
// comments at their call sites for the full design rationale): the
// pre-Anthropic-call quota CHECK (getAiUsage) and the post-call RECORD
// (recordAiUsage) are two separate round trips, not one atomic
// check-and-reserve operation -- a tightly-bounded overshoot is possible if
// enough requests for the same tenant are genuinely in flight
// simultaneously at the moment the monthly allowance is about to be
// exhausted. This is a deliberate, documented choice (Option A: "accept a
// tightly-bounded commercial overshoot"), not an oversight:
//   1. Anthropic's own API gives no way to reserve output tokens up front --
//      only `max_tokens` (an UPPER BOUND on generation, not an amount
//      actually consumed) is known before the call completes, so a true
//      atomic reservation would have to reserve worst-case and true up
//      afterward regardless -- materially more machinery for the same
//      practical protection.
//   2. Phase A's existing per-user/per-tenant rolling rate limits already
//      bound how many requests for the same tenant can be in flight at
//      once in practice (e.g. 60 rewrite requests / 5 minutes per tenant),
//      so the realistic overshoot window is small and rate-limit-bounded,
//      not unbounded.
//   3. recordAiUsage() below is a SINGLE atomic Lua eval (HINCRBY x4 +
//      EXPIRE) -- so however many concurrent requests race through the
//      pre-check, every one of their actual token counts is still recorded
//      exactly once with no lost updates; only the PRE-check can be stale,
//      never the bookkeeping itself. The very next request after such a
//      burst always sees the fully-reconciled total and is correctly
//      blocked.
// tests/test_ai_usage_metering.js's concurrency test documents the maximum
// practical overshoot this implies for a burst of N simultaneous requests.

import { Redis } from '@upstash/redis'

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class AiUsageStoreUnavailableError extends Error {}

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

// UTC calendar month, e.g. "2026-09" -- deliberately UTC (never server-local
// time, which would vary by Vercel region/runtime) so a tenant's billing
// period boundary is the same instant everywhere this function runs.
export function currentUsagePeriod(date = new Date()) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

function usageKey(tenantId, period) {
  return `ai_usage:v1:${tenantId}:${period}`
}

const ZERO_USAGE = Object.freeze({ requestCount: 0, inputTokens: 0, outputTokens: 0, usageUnits: 0, estimatedRequestCount: 0 })

// Reads the current live snapshot for a tenant's usage period. A period
// with no recorded usage yet returns zeros (not an error) -- but a genuine
// store outage throws AiUsageStoreUnavailableError rather than silently
// returning zeros, which would let an unverifiable usage state be treated
// as "definitely under quota." Callers (rewriteEngine.js, executive-brief.js)
// treat a thrown error here as fail-closed: no Anthropic call is made.
export async function getAiUsage(tenantId, period) {
  const client = getClient()
  if (!client) throw new AiUsageStoreUnavailableError('AI usage store is not configured')
  let raw
  try {
    raw = await client.hgetall(usageKey(tenantId, period))
  } catch (err) {
    throw new AiUsageStoreUnavailableError(`AI usage store unreachable: ${err.message}`)
  }
  if (!raw || Object.keys(raw).length === 0) return { ...ZERO_USAGE }
  return {
    requestCount: Number(raw.requestCount) || 0,
    inputTokens: Number(raw.inputTokens) || 0,
    outputTokens: Number(raw.outputTokens) || 0,
    usageUnits: Number(raw.usageUnits) || 0,
    // Phase B.4 final cost-metering correction: a count of how many of this
    // period's recorded requests had ANY field (input and/or output tokens)
    // fall back to aiUsageUnits.js's resolveTokenCounts() conservative
    // estimate rather than genuine provider-reported usage -- never a
    // second/independent counter that could drift from requestCount, purely
    // an informational subset of it. NOT required for enforcement (the
    // enforced field is always usageUnits); exists only so an operator can
    // later tell "this tenant's month included some estimated accounting"
    // apart from "every request had clean provider data," to prioritize
    // recalibration/investigation.
    estimatedRequestCount: Number(raw.estimatedRequestCount) || 0,
  }
}

// A period bucket outlives any single UTC calendar month by a wide margin
// (~100 days) so it self-expires without a cron job, while comfortably
// surviving any reasonable end-of-month reconciliation/support lookback.
const USAGE_RECORD_TTL_SECONDS = 100 * 24 * 60 * 60

// Atomic: requestCount/inputTokens/outputTokens/usageUnits are incremented
// together in one Lua eval, so a recorder can never partially apply (no
// lost updates) regardless of how many requests for the same tenant/period
// are recording concurrently -- this is what keeps the bookkeeping itself
// exact even though the separate pre-call CHECK (getAiUsage, above) can be
// stale under concurrency (see this file's header).
const INCR_USAGE_SCRIPT = `
redis.call('HINCRBY', KEYS[1], 'requestCount', 1)
redis.call('HINCRBY', KEYS[1], 'inputTokens', tonumber(ARGV[1]))
redis.call('HINCRBY', KEYS[1], 'outputTokens', tonumber(ARGV[2]))
redis.call('HINCRBY', KEYS[1], 'usageUnits', tonumber(ARGV[3]))
redis.call('HINCRBY', KEYS[1], 'estimatedRequestCount', tonumber(ARGV[5]))
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`

// Records ONE completed, successfully-billed Anthropic call. Never throws --
// by the time this is called, the customer already has (or is about to
// receive) the actual Anthropic response; a usage-store outage at this
// point must not fail an already-successful request over bookkeeping. A
// recording failure is logged loudly (so an operator can reconcile) and
// otherwise swallowed, mirroring this codebase's existing precedent for
// other best-effort, after-the-fact writes (auditLog.appendAuditEntry(),
// seatAllocationLock.js's releaseSeatAllocationLock()). Callers must NEVER
// call this for a call that did not actually complete against Anthropic
// (a network error / non-2xx from Anthropic records nothing -- see
// rewriteEngine.js's/executive-brief.js's call sites).
//
// `estimated` (optional, default false): true if EITHER inputTokens or
// outputTokens came from aiUsageUnits.js's resolveTokenCounts() conservative
// fallback rather than genuine provider-reported usage for this call --
// increments estimatedRequestCount alongside requestCount, in the SAME
// atomic script, so the two counters can never drift relative to each other.
export async function recordAiUsage(tenantId, period, { inputTokens, outputTokens, usageUnits, estimated = false }) {
  const client = getClient()
  if (!client) {
    console.error(`[aiUsageStore] cannot record AI usage for tenant ${JSON.stringify(tenantId)} period ${period} -- store is not configured`)
    return
  }
  try {
    await client.eval(INCR_USAGE_SCRIPT, [usageKey(tenantId, period)], [
      String(Math.max(0, Math.round(inputTokens) || 0)),
      String(Math.max(0, Math.round(outputTokens) || 0)),
      String(Math.max(0, Math.round(usageUnits) || 0)),
      String(USAGE_RECORD_TTL_SECONDS),
      estimated ? '1' : '0',
    ])
  } catch (err) {
    console.error(`[aiUsageStore] failed to record AI usage for tenant ${JSON.stringify(tenantId)} period ${period}: ${err.message}`)
  }
}
