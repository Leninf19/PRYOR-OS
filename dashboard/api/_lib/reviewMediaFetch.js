// SERVER-ONLY -- Review Media Download feature. The one place that ever
// makes an outbound network request to fetch a review's own photo bytes
// (Google's *.googleusercontent.com CDN) so dashboard/api/actions/[action].js's download-media action
// can proxy-download it, PHOTOS ONLY, without the browser ever needing to
// hit Google directly for the download (the existing lightbox already
// hits Google directly for VIEWING, unauthenticated, which is fine -- this
// module exists only for the authenticated, server-proxied DOWNLOAD path).
//
// Every requirement below is load-bearing, not a nicety -- this function
// receives a URL that originated from this tenant's OWN stored data
// (reviewMediaLookup.js), never from a request, but treats it exactly as
// untrusted anyway (defense in depth: a corrupted export, a future bug
// upstream, or a hand-edited private-data file must never turn this into
// an open proxy):
//   - https:// only, hostname must end with .googleusercontent.com.
//   - Redirects are followed manually (redirect: 'manual'), one hop at a
//     time, up to MAX_REDIRECTS -- every hop is re-validated against the
//     exact same host allowlist before being followed. fetch()'s own
//     automatic redirect-following is never used, specifically because it
//     would never re-check the target host.
//   - A single AbortController-backed timeout covers the ENTIRE operation
//     (every redirect hop plus the full body read) -- a slow upstream that
//     dribbles bytes forever cannot hang this function past TIMEOUT_MS.
//   - Content-Type is checked against an image allowlist BEFORE any byte
//     of the body is read.
//   - Content-Length (when present) is checked against the size cap before
//     reading; the body is then read in a streaming loop that counts real
//     bytes and aborts the instant the cap is crossed, so a host that
//     lies about (or omits) Content-Length still cannot exhaust memory.
//   - No credential of any kind (cookies, Authorization, session) is ever
//     attached to the outbound request -- fetch() is called with no
//     inherited headers from the inbound request at all.
//
// Never writes the fetched bytes to disk, Blob storage, or any persistent
// store -- the caller gets a Buffer back, in memory, for this one request
// only.

const ALLOWED_MEDIA_HOST_SUFFIX = '.googleusercontent.com'
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 3
const DEFAULT_TIMEOUT_MS = 5000
export const MAX_MEDIA_BYTES = 18 * 1024 * 1024 // ~18MB -- within the 15-20MB range this feature is scoped to.

// Test-only seam so a timeout test doesn't need to wait out the real
// production timeout -- same pattern as _setLimiterFactoryForTests()/
// _setReviewLocationIndexForTests() elsewhere in this codebase. Never
// consulted by production code paths beyond reading this one value.
let timeoutMsOverride = null
export function _setMediaFetchTimeoutForTests(ms) { timeoutMsOverride = ms }
export function _resetMediaFetchTimeoutForTests() { timeoutMsOverride = null }

export const ALLOWED_MEDIA_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

const EXT_BY_MEDIA_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
})

// A distinguishable failure the action handler maps to an HTTP response --
// `code` is a stable machine-readable string the frontend can branch on
// (e.g. falling back to "open in a new tab" instead of a download), `status`
// is the HTTP status to use (defaults to 502: "the upstream media source
// could not be retrieved", distinct from this endpoint's own 400s/404s).
export class MediaFetchError extends Error {
  constructor(message, { status = 502, code = 'media_unavailable' } = {}) {
    super(message)
    this.name = 'MediaFetchError'
    this.status = status
    this.code = code
  }
}

// Independent, server-side re-validation -- never trusts that
// media_sanitizer.py's own gate already ran correctly for whatever ended
// up in the stored export. Only a syntactically well-formed https:// URL
// whose hostname ends with .googleusercontent.com is ever considered safe
// to fetch. Rejects (among everything else) http://, file://, javascript:,
// data:, bare IP literals, and any host that merely CONTAINS
// "googleusercontent.com" without being a genuine subdomain of it (e.g.
// "googleusercontent.com.evil.example" fails this check, since its
// hostname does not END with ".googleusercontent.com").
export function isAllowedMediaUrl(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr) return false
  let parsed
  try {
    parsed = new URL(urlStr)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  if (!parsed.hostname.endsWith(ALLOWED_MEDIA_HOST_SUFFIX)) return false
  return true
}

async function consumeResponse(response) {
  if (!response.ok) {
    throw new MediaFetchError(`upstream media host responded ${response.status}`, { code: 'media_unavailable' })
  }

  const rawContentType = response.headers.get('content-type') || ''
  const contentType = rawContentType.split(';')[0].trim().toLowerCase()
  if (!ALLOWED_MEDIA_MIME_TYPES.has(contentType)) {
    throw new MediaFetchError(`disallowed content-type: ${rawContentType}`, { code: 'invalid_content_type' })
  }

  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_BYTES) {
    throw new MediaFetchError('declared content-length exceeds the size cap', { code: 'too_large' })
  }

  // Streaming size enforcement -- counts real bytes as they arrive rather
  // than trusting Content-Length, since a misbehaving/malicious host could
  // omit it or lie about it. Reading through response.body's own reader
  // (rather than response.arrayBuffer()/buffer()) is what lets this abort
  // mid-transfer instead of buffering an unbounded response first.
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_MEDIA_BYTES) {
        try { await reader.cancel() } catch { /* best-effort */ }
        throw new MediaFetchError('response exceeded the size cap while streaming', { code: 'too_large' })
      }
      chunks.push(value)
    }
    return { buffer: Buffer.concat(chunks.map(c => Buffer.from(c))), contentType }
  }

  // Defensive fallback for a Response-like object with no streaming body
  // (never true for Node's real global fetch, kept only so this never
  // crashes against an unexpected shape) -- still enforces the cap.
  const buf = Buffer.from(await response.arrayBuffer())
  if (buf.length > MAX_MEDIA_BYTES) {
    throw new MediaFetchError('response exceeded the size cap', { code: 'too_large' })
  }
  return { buffer: buf, contentType }
}

async function followAndFetch(startUrl, signal) {
  let currentUrl = startUrl
  let redirectsFollowed = 0
  while (true) {
    if (!isAllowedMediaUrl(currentUrl)) {
      throw new MediaFetchError(`disallowed media host: ${currentUrl}`, { code: 'invalid_media_source' })
    }
    // No headers forwarded from the inbound request -- this is a fresh
    // outbound request with no cookies, no Authorization, no PRYOR
    // credential of any kind. Google's public CDN needs none.
    const response = await fetch(currentUrl, { redirect: 'manual', signal })
    if (REDIRECT_STATUSES.has(response.status)) {
      redirectsFollowed += 1
      if (redirectsFollowed > MAX_REDIRECTS) {
        throw new MediaFetchError('too many redirects', { code: 'too_many_redirects' })
      }
      const location = response.headers.get('location')
      if (!location) {
        throw new MediaFetchError('redirect response had no Location header', { code: 'media_unavailable' })
      }
      // Resolved against the CURRENT url (redirects may be relative) --
      // the resulting absolute URL is re-validated against the host
      // allowlist at the top of the next loop iteration, before it is
      // ever fetched.
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }
    return consumeResponse(response)
  }
}

// The one entry point dashboard/api/actions/[action].js's download-media action calls. Returns
// { buffer, contentType } on success, or throws MediaFetchError (always --
// any unexpected error, including a real AbortError from the timeout, is
// normalized into one) so the caller has one exception shape to handle.
export async function fetchMediaBytes(startUrl) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMsOverride ?? DEFAULT_TIMEOUT_MS)
  try {
    return await followAndFetch(startUrl, controller.signal)
  } catch (err) {
    if (err instanceof MediaFetchError) throw err
    if (err?.name === 'AbortError') {
      throw new MediaFetchError('media fetch timed out', { status: 504, code: 'timeout' })
    }
    throw new MediaFetchError(`media fetch failed: ${err?.message ?? err}`, { code: 'media_unavailable' })
  } finally {
    clearTimeout(timeout)
  }
}

// Derives a safe download filename from server-controlled/validated inputs
// only: the review's own stable id (already validated as a non-empty
// string by the caller), the 0-based media index (already validated as a
// non-negative integer by the caller), and the extension inferred from the
// VALIDATED (allowlisted) response content-type -- never from anything
// Google's response headers/body could otherwise influence beyond that one
// already-checked value. Every character outside a safe set is stripped,
// so this can never produce a filename that escapes its quoted
// Content-Disposition value or injects a header.
export function buildSafeMediaFilename(reviewIdParam, index, contentType) {
  const ext = EXT_BY_MEDIA_MIME[contentType] ?? 'bin'
  const safeId = String(reviewIdParam).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'review'
  const safeIndex = Number.isInteger(index) && index >= 0 ? index : 0
  return `review-${safeId}-photo-${safeIndex}.${ext}`
}
