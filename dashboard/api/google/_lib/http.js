// Shared fetch-with-backoff for Google API calls from the JS side (mirrors
// google_api.py's retry/backoff pattern used by the Python sync scripts).
// Kept short (few retries, capped wait) since these run inside a
// user-triggered Vercel serverless function with a real execution time
// limit, not a background batch job.

// "Google fallback budget must count actual HTTP attempts" hardening (Phase
// A final pre-deploy review): thrown by fetchWithRetry() when an `onAttempt`
// callback (see below) reports its budget exhausted -- BEFORE the real
// fetch() for that attempt is ever issued. This is what makes a caller's
// budget count REAL outbound requests (initial attempt AND every retry),
// never just logical calls -- a naive per-logical-call counter could let
// each of N logical calls silently cost up to `maxRetries` real requests
// under sustained 429/5xx, multiplying the configured ceiling by 3x.
export class FetchBudgetExceededError extends Error {}

// `retryOn429` (default true, unchanged for every existing caller): set
// false for an interactive, user-triggered caller that must never spend an
// unbounded amount of wall-clock time/requests waiting out Google's own
// rate limiting -- a 429 is returned to the caller immediately instead.
// `onAttempt`, if provided, is called before EVERY real fetch() attempt
// (the first one and each retry) and must return a boolean: false means
// "no budget left for this attempt," which throws FetchBudgetExceededError
// immediately, without ever calling fetch(). A caller with a genuine budget
// (google/[action].js's publish() fallback) passes a closure that checks
// and decrements a shared counter, so the total real HTTP attempts across
// an entire multi-call operation (accounts.list + N x locations.list +
// reviews.list, each themselves possibly retried) can never exceed the
// configured ceiling -- never `ceiling x maxRetries`.
export async function fetchWithRetry(url, options = {}, { maxRetries = 3, baseDelayMs = 400, maxDelayMs = 3000, retryOn429 = true, onAttempt = null } = {}) {
  let lastRes
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (onAttempt && !onAttempt()) {
      throw new FetchBudgetExceededError('fetchWithRetry: request budget exhausted -- refusing to issue this attempt')
    }
    const res = await fetch(url, options)
    if (res.status === 429 && !retryOn429) return res
    if (res.status !== 429 && res.status < 500) return res
    lastRes = res
    if (attempt < maxRetries - 1) {
      const retryAfter = res.headers.get('Retry-After')
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : baseDelayMs * 2 ** attempt
      await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, maxDelayMs)))
    }
  }
  return lastRes
}
