// Regression tests for POST/GET /api/google/cron-critical-alert-check --
// the Vercel-Cron-invoked, non-session-authenticated dispatch of
// critical-alert-check.yml added by the scheduling-reliability revision
// (2026-09-27 audit: GitHub's native `schedule:` trigger for that workflow
// was measured firing at only ~7% of its nominal 15-minute cadence).
//
// No real network call anywhere in this file: every test overrides
// globalThis.fetch (the same pattern test_google_oauth_auto_recovery.js and
// test_graph_mail_sender.js already use) and uses emailSender.js's own
// _setTransportForTests() seam for the platform-failure-alert path.
//
// Run directly: node tests/test_cron_critical_alert_dispatch.js

import handler from '../dashboard/api/google/[action].js'
import { _setTransportForTests, _resetTransportForTests } from '../dashboard/api/_lib/emailSender.js'

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
    delete globalThis.fetch
    delete process.env.CRON_SECRET
    delete process.env.GITHUB_SYNC_PAT
    delete process.env.SMTP_HOST
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASSWORD
    _resetTransportForTests()
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}

function fakeReq({ method = 'GET', authHeader } = {}) {
  return {
    method,
    query: { action: 'cron-critical-alert-check' },
    headers: authHeader ? { authorization: authHeader } : {},
  }
}

// Captures whatever sendReviewEmail() actually sends, without a real SMTP
// connection -- also requires hasSmtpConfig() to read true, which needs
// real-looking (but fake) SMTP_* env vars set alongside the test transport.
function armFakeSmtpTransport() {
  process.env.SMTP_HOST = 'smtp.test.invalid'
  process.env.SMTP_USER = 'test@test.invalid'
  process.env.SMTP_PASSWORD = 'test-password'
  const sent = []
  _setTransportForTests(() => ({
    sendMail: async (opts) => { sent.push(opts); return { response: '250 OK', messageId: 'test-id' } },
  }))
  return sent
}

async function test_wrong_method_rejected_before_any_secret_check() {
  const res = fakeRes()
  await handler(fakeReq({ method: 'DELETE' }), res)
  assert(res.statusCode === 405, `expected 405, got ${res.statusCode}`)
}

async function test_missing_cron_secret_env_refuses_to_dispatch() {
  let fetchCalled = false
  globalThis.fetch = async () => { fetchCalled = true; return { status: 204 } }
  const res = fakeRes()
  await handler(fakeReq({ method: 'GET', authHeader: 'Bearer whatever' }), res)
  assert(res.statusCode === 503, `expected 503, got ${res.statusCode}`)
  assert(!fetchCalled, 'must never dispatch when CRON_SECRET itself is not configured')
}

async function test_wrong_bearer_token_rejected() {
  process.env.CRON_SECRET = 'the-real-secret'
  let fetchCalled = false
  globalThis.fetch = async () => { fetchCalled = true; return { status: 204 } }
  const res = fakeRes()
  await handler(fakeReq({ method: 'GET', authHeader: 'Bearer wrong-guess' }), res)
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
  assert(!fetchCalled, 'must never dispatch on a wrong/missing bearer token')
}

async function test_missing_github_sync_pat_refuses_to_dispatch() {
  process.env.CRON_SECRET = 'the-real-secret'
  let fetchCalled = false
  globalThis.fetch = async () => { fetchCalled = true; return { status: 204 } }
  const res = fakeRes()
  await handler(fakeReq({ method: 'GET', authHeader: 'Bearer the-real-secret' }), res)
  assert(res.statusCode === 503, `expected 503, got ${res.statusCode}`)
  assert(!fetchCalled, 'must never dispatch when GITHUB_SYNC_PAT is not configured')
}

async function test_authorized_dispatch_hits_the_correct_github_endpoint() {
  process.env.CRON_SECRET = 'the-real-secret'
  process.env.GITHUB_SYNC_PAT = 'ghp_fake_token'
  let capturedUrl = null
  let capturedAuth = null
  globalThis.fetch = async (url, opts) => {
    capturedUrl = url
    capturedAuth = opts.headers.Authorization
    return { status: 204 }
  }
  const res = fakeRes()
  await handler(fakeReq({ method: 'GET', authHeader: 'Bearer the-real-secret' }), res)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body?.success === true, `expected success:true, got ${JSON.stringify(res.body)}`)
  assert(
    capturedUrl === 'https://api.github.com/repos/Leninf19/PRYOR-OS/actions/workflows/critical-alert-check.yml/dispatches',
    `dispatched the wrong workflow/repo: ${capturedUrl}`
  )
  assert(capturedAuth === 'Bearer ghp_fake_token', 'must authenticate the GitHub dispatch with GITHUB_SYNC_PAT, never CRON_SECRET')
}

async function test_github_dispatch_failure_sends_platform_alert_and_returns_502() {
  process.env.CRON_SECRET = 'the-real-secret'
  process.env.GITHUB_SYNC_PAT = 'ghp_fake_token'
  globalThis.fetch = async () => ({ status: 422, json: async () => ({ message: 'simulated GitHub rejection' }) })
  const sent = armFakeSmtpTransport()

  const res = fakeRes()
  await handler(fakeReq({ method: 'GET', authHeader: 'Bearer the-real-secret' }), res)

  assert(res.statusCode === 502, `expected 502, got ${res.statusCode}`)
  assert(sent.length === 1, `expected exactly one platform-alert email attempt, got ${sent.length}`)
  assert(sent[0].to === 'lenin@futuremark.studio', `platform alert went to the wrong address: ${sent[0].to}`)
  assert(sent[0].to !== 'advertising@l3amigos.com', 'must never send this platform-operational alert to LTA business address')
  assert(sent[0].subject.includes('critical-alert-check'), 'subject should identify which pipeline failed')
}

async function test_network_error_during_dispatch_sends_platform_alert_and_returns_502() {
  process.env.CRON_SECRET = 'the-real-secret'
  process.env.GITHUB_SYNC_PAT = 'ghp_fake_token'
  globalThis.fetch = async () => { throw new Error('simulated network failure') }
  const sent = armFakeSmtpTransport()

  const res = fakeRes()
  await handler(fakeReq({ method: 'GET', authHeader: 'Bearer the-real-secret' }), res)

  assert(res.statusCode === 502, `expected 502, got ${res.statusCode}`)
  assert(sent.length === 1, `expected exactly one platform-alert email attempt, got ${sent.length}`)
  assert(sent[0].to === 'lenin@futuremark.studio', `platform alert went to the wrong address: ${sent[0].to}`)
}

async function test_alert_failure_itself_never_crashes_the_response() {
  // If SMTP is ALSO unavailable when the dispatch fails, the endpoint must
  // still respond 502 (not throw/crash) -- a broken alert channel must
  // never mask or replace the original dispatch-failure response.
  process.env.CRON_SECRET = 'the-real-secret'
  process.env.GITHUB_SYNC_PAT = 'ghp_fake_token'
  globalThis.fetch = async () => { throw new Error('simulated network failure') }
  // Deliberately NOT arming SMTP -- hasSmtpConfig() will read false.

  const res = fakeRes()
  await handler(fakeReq({ method: 'GET', authHeader: 'Bearer the-real-secret' }), res)
  assert(res.statusCode === 502, `expected 502 even when the alert channel itself is unavailable, got ${res.statusCode}`)
}

async function main() {
  await run('wrong HTTP method is rejected before any secret check', test_wrong_method_rejected_before_any_secret_check)
  await run('missing CRON_SECRET configuration refuses to dispatch', test_missing_cron_secret_env_refuses_to_dispatch)
  await run('a wrong bearer token is rejected, never dispatches', test_wrong_bearer_token_rejected)
  await run('missing GITHUB_SYNC_PAT refuses to dispatch', test_missing_github_sync_pat_refuses_to_dispatch)
  await run('an authorized request dispatches critical-alert-check.yml on the correct repo with the sync PAT', test_authorized_dispatch_hits_the_correct_github_endpoint)
  await run('a GitHub dispatch failure sends a platform alert to lenin@futuremark.studio and returns 502', test_github_dispatch_failure_sends_platform_alert_and_returns_502)
  await run('a network error during dispatch sends a platform alert and returns 502', test_network_error_during_dispatch_sends_platform_alert_and_returns_502)
  await run('an unavailable alert channel never crashes the dispatch-failure response', test_alert_failure_itself_never_crashes_the_response)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
