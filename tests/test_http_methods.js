// Confirms every one of the 13 routable dashboard/api/** handlers rejects
// unsupported HTTP methods (including HEAD/OPTIONS -- neither should ever
// fall through to auth/data logic) with 405, before touching auth or data.
// Handlers that require auth are exercised unauthenticated here on purpose:
// the method check must be the very first thing that runs, so a wrong
// method on a protected route still gets 405, not 401 (order matters for
// this specific check -- a 401 would still be "safe" but 405 confirms
// method validation genuinely happens first).
//
// Run directly: node tests/test_http_methods.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
delete process.env.ACCOUNT_DIRECTORY_JSON

import dataHandler from '../dashboard/api/data/[...path].js'
import executiveBriefHandler from '../dashboard/api/executive-brief.js'
import authHandler from '../dashboard/api/google/auth.js'
import callbackHandler from '../dashboard/api/google/callback.js'
import publishHandler from '../dashboard/api/google/publish.js'
import statusHandler from '../dashboard/api/google/status.js'
import testConnectionHandler from '../dashboard/api/google/test-connection.js'
import triggerImportHandler from '../dashboard/api/google/trigger-import.js'
import triggerSyncHandler from '../dashboard/api/google/trigger-sync.js'
import rewriteHandler from '../dashboard/api/rewrite.js'
import loginHandler from '../dashboard/api/session/login.js'
import logoutHandler from '../dashboard/api/session/logout.js'
import whoamiHandler from '../dashboard/api/session/whoami.js'

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

// [handler, allowedMethod, extraReqFields]
const ROUTES = [
  ['/api/data/*', dataHandler, 'GET', { query: { path: ['meta.json'] } }],
  ['/api/executive-brief', executiveBriefHandler, 'POST', {}],
  ['/api/google/auth', authHandler, 'GET', { query: {} }],
  ['/api/google/callback', callbackHandler, 'GET', { query: { code: 'x', state: 'y' } }],
  ['/api/google/publish', publishHandler, 'POST', {}],
  ['/api/google/status', statusHandler, 'GET', {}],
  ['/api/google/test-connection', testConnectionHandler, 'GET', {}],
  ['/api/google/trigger-import', triggerImportHandler, 'POST', {}],
  ['/api/google/trigger-sync', triggerSyncHandler, 'POST', {}],
  ['/api/rewrite', rewriteHandler, 'POST', {}],
  ['/api/session/login', loginHandler, 'POST', {}],
  ['/api/session/logout', logoutHandler, 'POST', {}],
  ['/api/session/whoami', whoamiHandler, 'GET', {}],
]

const ALL_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']

async function testEveryRouteRejectsWrongMethods() {
  for (const [routeName, handler, allowedMethod, extra] of ROUTES) {
    for (const method of ALL_METHODS) {
      if (method === allowedMethod) continue
      globalThis.fetch = async (url) => { throw new Error(`fetch must not be called for a rejected-method request: ${url}`) }
      const req = { method, body: {}, headers: {}, ...extra }
      const res = fakeRes()
      await handler(req, res)
      assert(res.statusCode === 405, `${routeName} with ${method}: expected 405, got ${res.statusCode}`)
    }
  }
}

async function main() {
  await run('every routable endpoint rejects every unsupported HTTP method (incl. HEAD/OPTIONS) with 405, before auth or data logic', testEveryRouteRejectsWrongMethods)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
