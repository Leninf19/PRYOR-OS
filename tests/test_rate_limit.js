// Regression tests for dashboard/api/_lib/rateLimit.js -- the production
// fail-closed / dev-test fail-open split. No real Upstash account is used
// anywhere in this file: the "service failure" and "denial" cases use the
// module's test-only limiter-factory seam (_setLimiterFactoryForTests),
// and the "missing configuration" cases simply leave the Upstash env vars
// unset.
//
// Run directly: node tests/test_rate_limit.js

import { checkRateLimit, enforceRateLimit, _setLimiterFactoryForTests, _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'

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
    _resetLimiterFactoryForTests()
    delete process.env.VERCEL_ENV
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}

function assertSafeBody(body) {
  const asString = JSON.stringify(body).toLowerCase()
  for (const forbidden of ['upstash', 'redis', 'secret', 'token=', 'session_signing', 'account_directory']) {
    assert(!asString.includes(forbidden), `response body must not mention "${forbidden}": ${JSON.stringify(body)}`)
  }
}

// ---- Production, missing Upstash config ----

async function testProductionMissingConfigFailsClosed() {
  process.env.VERCEL_ENV = 'production'
  const result = await checkRateLimit('test-key', { requestsPerWindow: 5, windowSeconds: 60 })
  assert(result.allowed === false, 'production with no Upstash config must NOT fail open')
  assert(result.reason === 'not_configured', result.reason)
}

async function testProductionMissingConfigReturns503WithSafeBody() {
  process.env.VERCEL_ENV = 'production'
  const res = fakeRes()
  const allowed = await enforceRateLimit({}, res, 'test-key')
  assert(allowed === false, 'enforceRateLimit must block the request')
  assert(res.statusCode === 503, `expected 503, got ${res.statusCode}`)
  assertSafeBody(res.body)
}

// ---- Dev/test fallback ----

async function testDevFallbackFailsOpen() {
  // VERCEL_ENV intentionally left unset, matching every local script/test run.
  const result = await checkRateLimit('test-key')
  assert(result.allowed === true, 'non-production with no Upstash config must fail OPEN (dev/test convenience)')
  assert(result.degraded === true, 'must be flagged as degraded, never presented as real protection')
  assert(result.reason === 'dev_fallback', result.reason)
}

async function testDevFallbackDoesNotRequireRealUpstashAccount() {
  // No UPSTASH_* env vars set anywhere in this test file -- if this test
  // passes at all, it proves the suite runs without a real Upstash account.
  const res = fakeRes()
  const allowed = await enforceRateLimit({}, res, 'test-key')
  assert(allowed === true, 'dev/test fallback must allow the request through')
}

// ---- Upstash service failure (simulated via the test-only factory seam) ----

async function testUpstashFailureInProductionFailsClosed() {
  process.env.VERCEL_ENV = 'production'
  _setLimiterFactoryForTests(() => ({ limit: async () => { throw new Error('ECONNREFUSED fake-upstash-outage') } }))
  const result = await checkRateLimit('test-key')
  assert(result.allowed === false, 'an Upstash outage in production must fail CLOSED')
  assert(result.reason === 'upstash_error', result.reason)
}

async function testUpstashFailureInProductionReturns503WithSafeBody() {
  process.env.VERCEL_ENV = 'production'
  _setLimiterFactoryForTests(() => ({ limit: async () => { throw new Error('ECONNREFUSED fake-upstash-outage with a secret-looking token=abc123') } }))
  const res = fakeRes()
  const allowed = await enforceRateLimit({}, res, 'test-key')
  assert(allowed === false, 'enforceRateLimit must block the request')
  assert(res.statusCode === 503, `expected 503, got ${res.statusCode}`)
  assertSafeBody(res.body)
  assert(!JSON.stringify(res.body).includes('ECONNREFUSED'), 'the raw upstream error message must never reach the client')
}

async function testUpstashFailureOutsideProductionFailsOpen() {
  _setLimiterFactoryForTests(() => ({ limit: async () => { throw new Error('fake outage') } }))
  const result = await checkRateLimit('test-key')
  assert(result.allowed === true, 'an Upstash outage outside production should still fail open (dev/test convenience)')
}

// ---- Limiter denial (a real, working limiter saying "no") ----

async function testLimiterDenialReturns429() {
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: false, remaining: 0 }) }))
  const res = fakeRes()
  const allowed = await enforceRateLimit({}, res, 'test-key')
  assert(allowed === false, 'a real denial must block the request')
  assert(res.statusCode === 429, `expected 429 for an actual exceeded limit, got ${res.statusCode}`)
  assertSafeBody(res.body)
}

async function testLimiterAllowReturnsTrue() {
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: true, remaining: 4 }) }))
  const res = fakeRes()
  const allowed = await enforceRateLimit({}, res, 'test-key')
  assert(allowed === true, 'a real allow must let the request through')
  assert(res.statusCode === null, 'no response should be written when the request is allowed')
}

async function main() {
  await run('production + missing Upstash config -> fails closed (not open)', testProductionMissingConfigFailsClosed)
  await run('production + missing Upstash config -> 503 with a safe, generic body', testProductionMissingConfigReturns503WithSafeBody)
  await run('dev/test fallback (no VERCEL_ENV, no Upstash config) -> fails open, clearly labeled', testDevFallbackFailsOpen)
  await run('dev/test fallback does not require a real Upstash account', testDevFallbackDoesNotRequireRealUpstashAccount)
  await run('Upstash service failure in production -> fails closed', testUpstashFailureInProductionFailsClosed)
  await run('Upstash service failure in production -> 503, safe body, no raw error leaked', testUpstashFailureInProductionReturns503WithSafeBody)
  await run('Upstash service failure outside production -> fails open', testUpstashFailureOutsideProductionFailsOpen)
  await run('a real limiter denial -> 429, safe body', testLimiterDenialReturns429)
  await run('a real limiter allow -> request proceeds, no response written', testLimiterAllowReturnsTrue)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
