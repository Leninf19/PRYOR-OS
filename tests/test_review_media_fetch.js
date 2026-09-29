// Regression tests for dashboard/api/_lib/reviewMediaFetch.js -- the
// hardened, SSRF-safe outbound fetch the Review Media Download feature
// uses to proxy a review's own photo bytes from Google's CDN. Every
// outbound HTTP call is mocked via globalThis.fetch (same convention
// test_rewrite_policy.js already uses for its own Anthropic fetch calls) --
// this file never makes a real network call anywhere.
//
// Run directly: node tests/test_review_media_fetch.js

import {
  isAllowedMediaUrl, fetchMediaBytes, buildSafeMediaFilename,
  MediaFetchError, MAX_MEDIA_BYTES,
  _setMediaFetchTimeoutForTests, _resetMediaFetchTimeoutForTests,
} from '../dashboard/api/_lib/reviewMediaFetch.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
async function run(name, fn) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  } finally {
    _resetMediaFetchTimeoutForTests()
    globalThis.fetch = originalFetch
  }
}

const originalFetch = globalThis.fetch

function makeHeaders(obj = {}) {
  const map = new Map(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (name) => (map.has(name.toLowerCase()) ? map.get(name.toLowerCase()) : null) }
}

function makeStreamResponse({ status = 200, headers = {}, chunks = [] } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return { status, ok: status >= 200 && status < 300, headers: makeHeaders(headers), body: stream }
}

function makeRedirectResponse(location, status = 302) {
  return { status, ok: false, headers: makeHeaders({ location }), body: null }
}

function makeAbortError() {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

// A fetch mock that never resolves on its own -- only reacts to the
// AbortSignal, exactly like a real fetch() would under a genuine network
// hang. Proves fetchMediaBytes()'s own timeout actually cuts it off.
function installHangingFetch() {
  globalThis.fetch = (_url, { signal } = {}) => new Promise((_resolve, reject) => {
    if (signal?.aborted) return reject(makeAbortError())
    signal?.addEventListener('abort', () => reject(makeAbortError()))
  })
}

const VALID_PHOTO_URL = 'https://lh3.googleusercontent.com/p1'
const JPEG_BYTES = new TextEncoder().encode('fake-jpeg-bytes')

// --- isAllowedMediaUrl (SSRF host/scheme allowlist) --------------------------

function testAllowsRealGooglecdnUrl() {
  assert(isAllowedMediaUrl('https://lh3.googleusercontent.com/p1') === true)
  assert(isAllowedMediaUrl('https://lh4.googleusercontent.com/p1') === true)
}

function testRejectsHttp() {
  assert(isAllowedMediaUrl('http://lh3.googleusercontent.com/p1') === false)
}

function testRejectsFileScheme() {
  assert(isAllowedMediaUrl('file:///etc/passwd') === false)
}

function testRejectsJavascriptScheme() {
  assert(isAllowedMediaUrl('javascript:alert(1)') === false)
}

function testRejectsDataScheme() {
  assert(isAllowedMediaUrl('data:image/png;base64,AAAA') === false)
}

function testRejectsPrivateIpLiteral() {
  assert(isAllowedMediaUrl('https://169.254.169.254/latest/meta-data/') === false, 'a cloud metadata IP literal must never be treated as an allowed media host')
  assert(isAllowedMediaUrl('https://127.0.0.1/x') === false)
  assert(isAllowedMediaUrl('https://10.0.0.5/x') === false)
}

function testRejectsHostThatOnlyContainsTheSuffix() {
  // A host that merely CONTAINS "googleusercontent.com" without being a
  // genuine subdomain must be rejected -- only a hostname that ENDS WITH
  // ".googleusercontent.com" is allowed.
  assert(isAllowedMediaUrl('https://googleusercontent.com.evil.example/p1') === false)
  assert(isAllowedMediaUrl('https://evilgoogleusercontent.com/p1') === false)
}

function testRejectsCredentialBearingUrl() {
  assert(isAllowedMediaUrl('https://user:pass@lh3.googleusercontent.com/p1') === false)
}

function testRejectsMalformedUrl() {
  assert(isAllowedMediaUrl('not a url') === false)
  assert(isAllowedMediaUrl('') === false)
  assert(isAllowedMediaUrl(null) === false)
  assert(isAllowedMediaUrl(undefined) === false)
}

// --- fetchMediaBytes: SSRF rejection before any network call ----------------

async function testSsrfUrlNeverReachesFetch() {
  let fetchCalled = false
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('must not be called') }
  try {
    await fetchMediaBytes('https://internal.evil.example/steal')
    assert(false, 'must throw for a disallowed host')
  } catch (err) {
    assert(err instanceof MediaFetchError, `expected a MediaFetchError, got ${err}`)
    assert(err.code === 'invalid_media_source', `expected invalid_media_source, got ${err.code}`)
  }
  assert(fetchCalled === false, 'a disallowed URL must never trigger an outbound fetch at all')
}

async function testHttpUrlNeverReachesFetch() {
  let fetchCalled = false
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('must not be called') }
  try {
    await fetchMediaBytes('http://lh3.googleusercontent.com/p1')
    assert(false, 'must throw for a non-https URL')
  } catch (err) {
    assert(err.code === 'invalid_media_source')
  }
  assert(fetchCalled === false)
}

// --- fetchMediaBytes: redirect handling --------------------------------------

async function testFollowsAllowedRedirectToSuccess() {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    if (calls.length === 1) return makeRedirectResponse('https://lh4.googleusercontent.com/p1-final')
    return makeStreamResponse({ headers: { 'content-type': 'image/jpeg' }, chunks: [JPEG_BYTES] })
  }
  const result = await fetchMediaBytes(VALID_PHOTO_URL)
  assert(calls.length === 2, `expected exactly 2 fetch calls (1 redirect + 1 final), got ${calls.length}`)
  assert(result.contentType === 'image/jpeg')
  assert(Buffer.compare(result.buffer, Buffer.from(JPEG_BYTES)) === 0, 'buffer must match the final response bytes')
}

async function testRedirectToDisallowedHostRejectedAndNeverFetched() {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    return makeRedirectResponse('https://evil.example.com/steal')
  }
  try {
    await fetchMediaBytes(VALID_PHOTO_URL)
    assert(false, 'must throw when a redirect targets a disallowed host')
  } catch (err) {
    assert(err instanceof MediaFetchError)
    assert(err.code === 'invalid_media_source', `expected invalid_media_source, got ${err.code}`)
  }
  assert(calls.length === 1, `the disallowed redirect target must never itself be fetched -- expected exactly 1 fetch call, got ${calls.length}`)
}

async function testTooManyRedirectsRejected() {
  let hop = 0
  globalThis.fetch = async () => {
    hop += 1
    return makeRedirectResponse(`https://lh3.googleusercontent.com/hop-${hop}`)
  }
  try {
    await fetchMediaBytes(VALID_PHOTO_URL)
    assert(false, 'must throw once the redirect cap is exceeded')
  } catch (err) {
    assert(err.code === 'too_many_redirects', `expected too_many_redirects, got ${err.code}`)
  }
  assert(hop <= 5, `redirect-following must be bounded -- saw ${hop} hops`)
}

// --- fetchMediaBytes: Content-Type validation --------------------------------

async function testInvalidContentTypeRejected() {
  globalThis.fetch = async () => makeStreamResponse({ headers: { 'content-type': 'text/html' }, chunks: [] })
  try {
    await fetchMediaBytes(VALID_PHOTO_URL)
    assert(false, 'must throw for a disallowed content-type')
  } catch (err) {
    assert(err.code === 'invalid_content_type', `expected invalid_content_type, got ${err.code}`)
  }
}

async function testSvgContentTypeRejected() {
  // Not on the image allowlist -- SVG can embed script, so it must never
  // be treated as safely downloadable image content.
  globalThis.fetch = async () => makeStreamResponse({ headers: { 'content-type': 'image/svg+xml' }, chunks: [] })
  try {
    await fetchMediaBytes(VALID_PHOTO_URL)
    assert(false, 'must throw for image/svg+xml')
  } catch (err) {
    assert(err.code === 'invalid_content_type')
  }
}

async function testValidContentTypeWithCharsetAccepted() {
  globalThis.fetch = async () => makeStreamResponse({ headers: { 'content-type': 'image/jpeg; charset=binary' }, chunks: [JPEG_BYTES] })
  const result = await fetchMediaBytes(VALID_PHOTO_URL)
  assert(result.contentType === 'image/jpeg', `content-type parameters must be stripped, got ${result.contentType}`)
}

// --- fetchMediaBytes: size cap enforcement -----------------------------------

async function testOversizedDeclaredContentLengthRejected() {
  globalThis.fetch = async () => makeStreamResponse({
    headers: { 'content-type': 'image/jpeg', 'content-length': String(MAX_MEDIA_BYTES + 1) },
    chunks: [],
  })
  try {
    await fetchMediaBytes(VALID_PHOTO_URL)
    assert(false, 'must throw when declared Content-Length exceeds the cap')
  } catch (err) {
    assert(err.code === 'too_large', `expected too_large, got ${err.code}`)
  }
}

async function testOversizedStreamedBodyRejectedWithoutHonestContentLength() {
  // No content-length header at all -- a misbehaving/malicious host could
  // omit it entirely. The cap must still be enforced by counting real
  // bytes as they stream in.
  const oversizedChunk = new Uint8Array(MAX_MEDIA_BYTES + 1024)
  globalThis.fetch = async () => makeStreamResponse({
    headers: { 'content-type': 'image/jpeg' },
    chunks: [oversizedChunk],
  })
  try {
    await fetchMediaBytes(VALID_PHOTO_URL)
    assert(false, 'must throw when the streamed body exceeds the cap even with no Content-Length header')
  } catch (err) {
    assert(err.code === 'too_large', `expected too_large, got ${err.code}`)
  }
}

async function testWithinCapAccepted() {
  const smallChunk = new Uint8Array(1024)
  globalThis.fetch = async () => makeStreamResponse({
    headers: { 'content-type': 'image/png', 'content-length': '1024' },
    chunks: [smallChunk],
  })
  const result = await fetchMediaBytes(VALID_PHOTO_URL)
  assert(result.buffer.length === 1024)
  assert(result.contentType === 'image/png')
}

// --- fetchMediaBytes: non-2xx upstream status --------------------------------

async function testNonOkUpstreamStatusRejected() {
  globalThis.fetch = async () => ({ status: 404, ok: false, headers: makeHeaders({ 'content-type': 'text/plain' }), body: null })
  try {
    await fetchMediaBytes(VALID_PHOTO_URL)
    assert(false, 'must throw for a non-2xx upstream response')
  } catch (err) {
    assert(err.code === 'media_unavailable', `expected media_unavailable, got ${err.code}`)
  }
}

// --- fetchMediaBytes: timeout -------------------------------------------------

async function testTimeoutIsHandledCleanly() {
  _setMediaFetchTimeoutForTests(50)
  installHangingFetch()
  const start = Date.now()
  try {
    await fetchMediaBytes(VALID_PHOTO_URL)
    assert(false, 'must throw when the upstream never responds')
  } catch (err) {
    assert(err instanceof MediaFetchError, `expected a MediaFetchError, got ${err}`)
    assert(err.code === 'timeout', `expected timeout, got ${err.code}`)
    assert(err.status === 504, `expected 504, got ${err.status}`)
  }
  const elapsed = Date.now() - start
  assert(elapsed < 2000, `timeout must actually cut the request off promptly, took ${elapsed}ms`)
}

// --- buildSafeMediaFilename ---------------------------------------------------

function testBuildSafeMediaFilenamePicksExtensionFromContentType() {
  assert(buildSafeMediaFilename('abc123', 0, 'image/jpeg') === 'review-abc123-photo-0.jpg')
  assert(buildSafeMediaFilename('abc123', 2, 'image/png') === 'review-abc123-photo-2.png')
  assert(buildSafeMediaFilename('abc123', 0, 'image/webp') === 'review-abc123-photo-0.webp')
  assert(buildSafeMediaFilename('abc123', 0, 'image/gif') === 'review-abc123-photo-0.gif')
}

function testBuildSafeMediaFilenameSanitizesUnsafeCharacters() {
  const name = buildSafeMediaFilename('../../etc/passwd"; rm -rf /', 0, 'image/jpeg')
  assert(!name.includes('/'), `filename must never contain a path separator: ${name}`)
  assert(!name.includes('"'), `filename must never contain a quote character (Content-Disposition injection): ${name}`)
  assert(!name.includes(' '), `filename must never contain a raw space in this sanitized form: ${name}`)
  assert(/^review-[a-zA-Z0-9_-]+-photo-0\.jpg$/.test(name), `unexpected filename shape: ${name}`)
}

function testBuildSafeMediaFilenameFallsBackWhenIdIsEmpty() {
  const name = buildSafeMediaFilename('', 0, 'image/jpeg')
  assert(name === 'review-review-photo-0.jpg', `expected a safe fallback id, got ${name}`)
}

async function main() {
  await run('isAllowedMediaUrl: accepts a real *.googleusercontent.com https URL', testAllowsRealGooglecdnUrl)
  await run('isAllowedMediaUrl: rejects http://', testRejectsHttp)
  await run('isAllowedMediaUrl: rejects file://', testRejectsFileScheme)
  await run('isAllowedMediaUrl: rejects javascript:', testRejectsJavascriptScheme)
  await run('isAllowedMediaUrl: rejects data:', testRejectsDataScheme)
  await run('isAllowedMediaUrl: rejects a private/internal IP literal', testRejectsPrivateIpLiteral)
  await run('isAllowedMediaUrl: rejects a host that merely contains the suffix', testRejectsHostThatOnlyContainsTheSuffix)
  await run('isAllowedMediaUrl: rejects a credential-bearing URL', testRejectsCredentialBearingUrl)
  await run('isAllowedMediaUrl: rejects a malformed/non-string URL', testRejectsMalformedUrl)

  await run('fetchMediaBytes: a disallowed host is rejected before any fetch() call', testSsrfUrlNeverReachesFetch)
  await run('fetchMediaBytes: a non-https URL is rejected before any fetch() call', testHttpUrlNeverReachesFetch)

  await run('fetchMediaBytes: follows an allowed redirect through to success', testFollowsAllowedRedirectToSuccess)
  await run('fetchMediaBytes: a redirect to a disallowed host is rejected and never fetched', testRedirectToDisallowedHostRejectedAndNeverFetched)
  await run('fetchMediaBytes: too many redirects is rejected (bounded)', testTooManyRedirectsRejected)

  await run('fetchMediaBytes: an invalid content-type is rejected', testInvalidContentTypeRejected)
  await run('fetchMediaBytes: image/svg+xml is rejected (not on the allowlist)', testSvgContentTypeRejected)
  await run('fetchMediaBytes: a valid content-type with parameters is accepted', testValidContentTypeWithCharsetAccepted)

  await run('fetchMediaBytes: an oversized declared Content-Length is rejected', testOversizedDeclaredContentLengthRejected)
  await run('fetchMediaBytes: an oversized streamed body is rejected without an honest Content-Length', testOversizedStreamedBodyRejectedWithoutHonestContentLength)
  await run('fetchMediaBytes: a response within the cap is accepted', testWithinCapAccepted)

  await run('fetchMediaBytes: a non-2xx upstream status is rejected', testNonOkUpstreamStatusRejected)

  await run('fetchMediaBytes: a request timeout is handled cleanly, does not hang', testTimeoutIsHandledCleanly)

  await run('buildSafeMediaFilename: picks the extension from the validated content-type', testBuildSafeMediaFilenamePicksExtensionFromContentType)
  await run('buildSafeMediaFilename: sanitizes unsafe characters out of the reviewId', testBuildSafeMediaFilenameSanitizesUnsafeCharacters)
  await run('buildSafeMediaFilename: falls back to a safe id when the reviewId is empty', testBuildSafeMediaFilenameFallsBackWhenIdIsEmpty)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
