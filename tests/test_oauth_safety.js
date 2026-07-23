// Confirms the two OAuth-related fixes: (1) callback.js requires an Owner
// session before doing anything else (defense in depth alongside the
// pre-existing CSRF state check), and (2) the plaintext refresh-token HTML
// fallback is gone from the source entirely -- a static source check, since
// the whole point is that this string must never exist to be rendered.
//
// Run directly: node tests/test_oauth_safety.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import googleHandler from '../dashboard/api/google/[action].js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Both endpoints now live in the same consolidated dispatch file
// (Phase 8, Milestone 8.2) -- these wrappers keep every call site below
// exactly as it read before the merge, just routing through req.query.action.
function authHandler(req, res) { return googleHandler({ ...req, query: { ...req.query, action: 'auth' } }, res) }
function callbackHandler(req, res) { return googleHandler({ ...req, query: { ...req.query, action: 'callback' } }, res) }

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
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.send = (str) => { res.body = str; return res }
  res.redirect = (code) => { res.statusCode = code; return res }
  res.setHeader = () => res
  return res
}

function testCallbackSourceNeverEmbedsRefreshTokenInHtml() {
  const source = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', 'google', '[action].js'), 'utf-8')
  assert(!source.includes('${tokens.refresh_token}'), 'the callback case must never interpolate the refresh token into an HTML response')
  assert(!/refresh_token[^\n]*console\.log/.test(source), 'the callback case must never log the refresh token')
}

async function testCallbackRequiresOwnerSessionBeforeAnythingElse() {
  delete process.env.ACCOUNT_DIRECTORY_JSON
  const req = { method: 'GET', query: { code: 'fake-code', state: 'fake-state' }, headers: {} }
  const res = fakeRes()
  await callbackHandler(req, res)
  assert(res.statusCode === 401, `expected 401 (sign-in required) before any CSRF/token exchange logic runs, got ${res.statusCode}`)
  assert(res.body.includes('Sign in'), 'must present a sign-in prompt, not a Google-flow error')
}

async function testAuthEndpointRequiresOwnerSession() {
  delete process.env.ACCOUNT_DIRECTORY_JSON
  const req = { method: 'GET', query: {}, headers: {} }
  const res = fakeRes()
  await authHandler(req, res)
  assert(res.statusCode === 401, `expected 401 (sign-in required) before redirecting to Google, got ${res.statusCode}`)
}

async function testAuthEndpointRejectsNonGetMethods() {
  for (const method of ['POST', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']) {
    const req = { method, query: {}, headers: {} }
    const res = fakeRes()
    await authHandler(req, res)
    assert(res.statusCode === 405, `${method} to auth.js: expected 405, got ${res.statusCode}`)
  }
}

async function testCallbackRejectsNonGetMethods() {
  for (const method of ['POST', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']) {
    const req = { method, query: { code: 'x', state: 'y' }, headers: {} }
    const res = fakeRes()
    await callbackHandler(req, res)
    assert(res.statusCode === 405, `${method} to callback.js: expected 405, got ${res.statusCode}`)
  }
}

async function main() {
  run('callback.js source no longer embeds the refresh token in any HTML template or log call', testCallbackSourceNeverEmbedsRefreshTokenInHtml)
  await run('callback.js requires an Owner session before CSRF/token-exchange logic runs', testCallbackRequiresOwnerSessionBeforeAnythingElse)
  await run('auth.js requires an Owner session before redirecting to Google', testAuthEndpointRequiresOwnerSession)
  await run('auth.js rejects non-GET methods (POST/HEAD/OPTIONS/PUT/DELETE) with 405', testAuthEndpointRejectsNonGetMethods)
  await run('callback.js rejects non-GET methods (POST/HEAD/OPTIONS/PUT/DELETE) with 405', testCallbackRejectsNonGetMethods)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
