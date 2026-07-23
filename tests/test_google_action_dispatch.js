// Regression tests for dashboard/api/google/[action].js's dispatch table
// itself (Phase 8, Milestone 8.2) -- independent of any individual action's
// business logic, which is already covered by test_oauth_safety.js,
// test_google_oauth_error_contract.js, test_publish_reply.js,
// test_endpoint_auth.js, test_http_methods.js, and
// test_authorization_matrix.js.
//
// Run directly: node tests/test_google_action_dispatch.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
delete process.env.ACCOUNT_DIRECTORY_JSON

import handler from '../dashboard/api/google/[action].js'

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
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.send = (str) => { res.body = str; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

const KNOWN_ACTIONS = ['auth', 'callback', 'status', 'test-connection', 'trigger-sync', 'trigger-import', 'publish']

async function testUnknownActionReturns404() {
  for (const action of ['', 'nonexistent', 'Auth', 'AUTH', 'delete-everything']) {
    const req = { method: 'GET', query: { action }, headers: {}, body: {} }
    const res = fakeRes()
    await handler(req, res)
    assert(res.statusCode === 404, `action=${JSON.stringify(action)}: expected 404, got ${res.statusCode}`)
    assert(res.body?.error === 'not_found', `action=${JSON.stringify(action)}: expected {error: 'not_found'}, got ${JSON.stringify(res.body)}`)
  }
}

async function testMissingActionReturns404() {
  const req = { method: 'GET', query: {}, headers: {}, body: {} }
  const res = fakeRes()
  await handler(req, res)
  assert(res.statusCode === 404, `no action at all: expected 404, got ${res.statusCode}`)
}

async function testEveryKnownActionIsRoutable() {
  // Every known action must reach ITS OWN handler (never fall through to
  // the 404 default) -- confirmed by observing a status code that is NOT
  // 404, since every real case's first line is a method check (405 for a
  // deliberately wrong method here) rather than the dispatcher's fallback.
  for (const action of KNOWN_ACTIONS) {
    const req = { method: 'DELETE', query: { action }, headers: {}, body: {} } // DELETE is never a supported method for any of these
    const res = fakeRes()
    await handler(req, res)
    assert(res.statusCode === 405, `action=${action}: a DELETE request must reach the case's own method check (405), not the dispatcher's 404 default -- got ${res.statusCode}`)
  }
}

async function main() {
  await run('an unrecognized action value returns 404 {error: "not_found"}', testUnknownActionReturns404)
  await run('no action at all (missing query.action) returns 404', testMissingActionReturns404)
  await run('every known action is actually routed to its own case (never falls through to 404)', testEveryKnownActionIsRoutable)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
