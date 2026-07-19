// Rate limiting -- Node-only (used by API handlers, never by middleware).
//
// Backed by Upstash Redis (via @upstash/ratelimit), which is a real,
// durable counter shared across every serverless instance -- unlike an
// in-memory counter, which resets per cold start / per instance and gives
// close to no protection in a multi-instance serverless deployment.
//
// PRODUCTION vs DEV/TEST behavior are deliberately different:
//
//   Production (VERCEL_ENV === 'production'): missing/invalid Upstash
//   config, or Upstash itself failing, NEVER fails open. The caller gets a
//   safe, generic 503 -- not a silently-allowed request. This is the whole
//   point of this rewrite: a misconfigured or degraded rate limiter must
//   not become "no rate limiting" in the one environment that matters.
//
//   Anywhere else (unset VERCEL_ENV -- local scripts, the Node test
//   harness, `vercel dev` without VERCEL_ENV=production -- or explicit
//   'preview'/'development'): missing config fails OPEN so local
//   development and the test suite never need a real Upstash account. This
//   is unmistakably logged every time it happens, precisely so it's never
//   mistaken for real protection.
//
// A "startup check that fails before deployment" (as opposed to a
// per-request check) isn't something a stateless serverless function can
// do for itself -- there is no persistent process to run a boot-time
// assertion in. dashboard/scripts/check-prod-env.mjs provides an optional,
// explicit opt-in for wiring into Vercel's buildCommand if you want a bad
// deploy to fail the build instead of only degrading at request time; it
// is not wired in automatically (see that file's header for why).

import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

let limiterState = null
let warnedDevFallback = false

function isProductionEnv() {
  return process.env.VERCEL_ENV === 'production'
}

function hasUpstashConfig() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

// Test-only seam: lets tests simulate a real Upstash limiter's allow/deny/
// throw behavior without a real Upstash account or fragile REST-protocol
// mocking. Never used by production code paths -- production always goes
// through getLimiter() below, which only ever talks to real Upstash.
let testLimiterFactory = null
export function _setLimiterFactoryForTests(factory) { testLimiterFactory = factory }
export function _resetLimiterFactoryForTests() { testLimiterFactory = null; limiterState = null; warnedDevFallback = false }

function getLimiter(requestsPerWindow, windowSeconds) {
  if (testLimiterFactory) return testLimiterFactory(requestsPerWindow, windowSeconds)

  if (!limiterState) limiterState = { redis: new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN }), cache: new Map() }
  const key = `${requestsPerWindow}:${windowSeconds}`
  if (!limiterState.cache.has(key)) {
    limiterState.cache.set(key, new Ratelimit({
      redis: limiterState.redis,
      limiter: Ratelimit.slidingWindow(requestsPerWindow, `${windowSeconds} s`),
      prefix: 'lta-ratelimit',
    }))
  }
  return limiterState.cache.get(key)
}

// Defense in depth for the console.error/warn calls below: if the
// configured Upstash URL/token ever happened to appear inside an upstream
// error message (not expected from a well-behaved REST client, but not
// guaranteed either), this keeps it out of the logs regardless.
function sanitizeErrorMessage(message) {
  let out = String(message)
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (url) out = out.split(url).join('[redacted-url]')
  if (token) out = out.split(token).join('[redacted-token]')
  return out
}

// identifier: something stable per caller, e.g. `login:<ip>` or
// `publish:<userId>`. Returns { allowed, remaining, degraded, reason }.
// reason is one of undefined | 'not_configured' | 'upstash_error' -- both
// of the latter mean "the limiter itself is broken", not "limit exceeded",
// which enforceRateLimit() below turns into a 503, not a 429.
export async function checkRateLimit(identifier, { requestsPerWindow = 20, windowSeconds = 60 } = {}) {
  if (!hasUpstashConfig() && !testLimiterFactory) {
    if (isProductionEnv()) {
      console.error('[rateLimit] PRODUCTION MISCONFIGURATION: UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN are not set. Refusing to fail open in production -- sensitive endpoints will return 503 until this is configured.')
      return { allowed: false, remaining: null, degraded: true, reason: 'not_configured' }
    }
    if (!warnedDevFallback) {
      console.warn('[rateLimit] DEV/TEST FALLBACK -- Upstash not configured, rate limiting is DISABLED (failing open). ' +
        'This is NOT production protection and must never be relied on outside local development and tests.')
      warnedDevFallback = true
    }
    return { allowed: true, remaining: null, degraded: true, reason: 'dev_fallback' }
  }

  try {
    const rl = getLimiter(requestsPerWindow, windowSeconds)
    const { success, remaining } = await rl.limit(identifier)
    return { allowed: success, remaining, degraded: false }
  } catch (err) {
    const safeMessage = sanitizeErrorMessage(err.message)
    if (isProductionEnv()) {
      console.error(`[rateLimit] Upstash request failed in production -- failing CLOSED (not open): ${safeMessage}`)
      return { allowed: false, remaining: null, degraded: true, reason: 'upstash_error' }
    }
    console.warn(`[rateLimit] Upstash request failed (non-production) -- failing open: ${safeMessage}`)
    return { allowed: true, remaining: null, degraded: true, reason: 'upstash_error' }
  }
}

// Convenience helper for handlers: sends the appropriate error response and
// returns false if the request should be blocked, otherwise returns true so
// the handler can continue. A broken/unconfigured limiter in production
// (`not_configured` / `upstash_error`) is surfaced as a generic 503 --
// never naming Upstash, never including env var names or values, so an
// unauthenticated caller learns nothing about server configuration. An
// actual exceeded limit is a normal 429.
export async function enforceRateLimit(req, res, identifier, opts) {
  const result = await checkRateLimit(identifier, opts)
  if (result.allowed) return true

  if (result.reason === 'not_configured' || result.reason === 'upstash_error') {
    res.status(503).json({
      error: 'service_unavailable',
      message: 'This action is temporarily unavailable. Please try again shortly.',
    })
    return false
  }

  res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Please try again shortly.' })
  return false
}
