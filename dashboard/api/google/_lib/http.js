// Shared fetch-with-backoff for Google API calls from the JS side (mirrors
// google_api.py's retry/backoff pattern used by the Python sync scripts).
// Kept short (few retries, capped wait) since these run inside a
// user-triggered Vercel serverless function with a real execution time
// limit, not a background batch job.

export async function fetchWithRetry(url, options = {}, { maxRetries = 3, baseDelayMs = 400, maxDelayMs = 3000 } = {}) {
  let lastRes
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(url, options)
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
