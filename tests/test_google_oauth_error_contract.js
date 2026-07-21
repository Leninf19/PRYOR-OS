// Phase 2 Milestone 6A: API error-contract normalization for the Google
// OAuth endpoints, closing ERROR_CONTRACT_EXCEPTION_1 (tracked in
// tests/test_authorization_matrix.js). Before this milestone,
// dashboard/api/google/auth.js and callback.js called evaluateSession()
// directly and only checked `if (!account)`, so an authenticated-but-
// wrong-role caller got 401 (indistinguishable from no session at all)
// instead of the 403 the frozen API error contract requires and every
// requireAuth()-based endpoint already produces for the same situation.
//
// This file focuses narrowly on the auth/role GATE at the top of each
// handler -- it does not re-test the OAuth flow itself (CSRF state
// handling, token exchange, Vercel env automation), which are already
// covered by tests/test_oauth_safety.js and are explicitly unchanged by
// this milestone. No real credentials, tokens, or Google network calls are
// used anywhere in this file.
//
// Run directly: node tests/test_google_oauth_error_contract.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import authHandler from '../dashboard/api/google/auth.js'
import callbackHandler from '../dashboard/api/google/callback.js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { statusForAuthFailure } from '../dashboard/api/_lib/auth.js'

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
  res.send = (str) => { res.body = str; return res }
  res.redirect = (code) => { res.statusCode = code; return res }
  res.setHeader = (name, value) => { res.headers[name] = value; return res }
  res.getHeader = (name) => res.headers[name]
  return res
}

async function setDirectory(overrides = {}) {
  const hash = await bcrypt.hash('correct-horse-battery-staple', 12)
  const base = {
    owner:            { userId: 'usr_owner',    email: 'owner@example.com',    passwordHash: hash, role: 'owner',            locationIds: '*', sessionVersion: 1, disabled: false },
    marketing:        { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing',       locationIds: '*', sessionVersion: 1, disabled: false },
    location_manager: { userId: 'usr_lm',        email: 'lm@example.com',      passwordHash: hash, role: 'location_manager', locationIds: [3], sessionVersion: 1, disabled: false },
    read_only:        { userId: 'usr_ro',        email: 'ro@example.com',      passwordHash: hash, role: 'read_only',        locationIds: [3], sessionVersion: 1, disabled: false },
    disabled_owner:   { userId: 'usr_disabled',  email: 'disabled@example.com', passwordHash: hash, role: 'owner',            locationIds: '*', sessionVersion: 1, disabled: true },
  }
  for (const [key, patch] of Object.entries(overrides)) base[key] = { ...base[key], ...patch }
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: Object.values(base) })
  return base
}

async function tokenFor(account, overrides = {}) {
  return signSession({
    userId: account.userId, email: account.email, role: account.role,
    locationIds: account.locationIds, sessionVersion: account.sessionVersion,
    ...overrides,
  })
}

function reqWithCookie(token, extra = {}) {
  return { method: 'GET', headers: token ? { cookie: `lta_session=${token}` } : {}, query: {}, ...extra }
}

// ---------------------------------------------------------------------------
// /api/google/auth
// ---------------------------------------------------------------------------

async function testAuthUnauthenticatedReturns401() {
  await setDirectory()
  const res = fakeRes()
  await authHandler(reqWithCookie(null), res)
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
  assert(res.body.includes('Sign in required'), 'body must still read "Sign in required" for a true identity failure')
}

async function testAuthInvalidSessionReturns401() {
  await setDirectory()
  const res = fakeRes()
  await authHandler(reqWithCookie('not-a-real-jwt'), res)
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testAuthDisabledAccountReturns401() {
  const fixtures = await setDirectory()
  const token = await tokenFor(fixtures.disabled_owner)
  const res = fakeRes()
  await authHandler(reqWithCookie(token), res)
  assert(res.statusCode === 401, `a disabled account must still be treated as no identity at all (401), got ${res.statusCode}`)
}

async function testAuthSessionVersionMismatchReturns401() {
  const fixtures = await setDirectory()
  const token = await tokenFor({ ...fixtures.owner, sessionVersion: 999 })
  const res = fakeRes()
  await authHandler(reqWithCookie(token), res)
  assert(res.statusCode === 401, `a stale sessionVersion must be a 401 identity failure, got ${res.statusCode}`)
}

async function testAuthMarketingReturns403() {
  const fixtures = await setDirectory()
  const token = await tokenFor(fixtures.marketing)
  const res = fakeRes()
  await authHandler(reqWithCookie(token), res)
  assert(res.statusCode === 403, `authenticated Marketing (wrong role) must now get 403, got ${res.statusCode}`)
  assert(res.body.includes('Access denied'), 'body must present the new wrong-role message, not "Sign in required"')
  assert(!res.body.includes('Sign in required'), 'a 403 response must not tell an already-authenticated caller to "sign in"')
}

async function testAuthLocationManagerReturns403() {
  const fixtures = await setDirectory()
  const token = await tokenFor(fixtures.location_manager)
  const res = fakeRes()
  await authHandler(reqWithCookie(token), res)
  assert(res.statusCode === 403, `authenticated Location Manager (wrong role) must get 403, got ${res.statusCode}`)
}

async function testAuthReadOnlyReturns403() {
  const fixtures = await setDirectory()
  const token = await tokenFor(fixtures.read_only)
  const res = fakeRes()
  await authHandler(reqWithCookie(token), res)
  assert(res.statusCode === 403, `authenticated Read Only (wrong role) must get 403, got ${res.statusCode}`)
}

async function testAuthOwnerReachesExistingSuccessPath() {
  const fixtures = await setDirectory()
  const token = await tokenFor(fixtures.owner)
  const prevClientId = process.env.GOOGLE_CLIENT_ID
  process.env.GOOGLE_CLIENT_ID = 'fake-client-id-for-test'
  try {
    const res = fakeRes()
    await authHandler(reqWithCookie(token), res)
    assert(res.statusCode === 302, `a valid Owner must reach the unchanged redirect-to-Google path (302), got ${res.statusCode}`)
  } finally {
    process.env.GOOGLE_CLIENT_ID = prevClientId
  }
}

async function testAuthResponseShapeIsHtmlForBoth401And403() {
  const fixtures = await setDirectory()
  const unauthedRes = fakeRes()
  await authHandler(reqWithCookie(null), unauthedRes)
  assert(typeof unauthedRes.body === 'string' && unauthedRes.body.includes('<html>'), '401 response must remain HTML')

  const marketingToken = await tokenFor(fixtures.marketing)
  const forbiddenRes = fakeRes()
  await authHandler(reqWithCookie(marketingToken), forbiddenRes)
  assert(typeof forbiddenRes.body === 'string' && forbiddenRes.body.includes('<html>'), '403 response must also be HTML, matching this endpoint\'s existing response type')
}

// ---------------------------------------------------------------------------
// /api/google/callback
// ---------------------------------------------------------------------------

function callbackReq(token) {
  return reqWithCookie(token, { query: { code: 'fake-code', state: 'fake-state' } })
}

async function testCallbackUnauthenticatedReturns401() {
  await setDirectory()
  const res = fakeRes()
  await callbackHandler(callbackReq(null), res)
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
  assert(res.body.includes('Sign in'), 'body must present a sign-in prompt for a true identity failure')
}

async function testCallbackInvalidSessionReturns401() {
  await setDirectory()
  const res = fakeRes()
  await callbackHandler(callbackReq('not-a-real-jwt'), res)
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testCallbackDisabledAccountReturns401() {
  const fixtures = await setDirectory()
  const token = await tokenFor(fixtures.disabled_owner)
  const res = fakeRes()
  await callbackHandler(callbackReq(token), res)
  assert(res.statusCode === 401, `a disabled account must still be a 401 identity failure, got ${res.statusCode}`)
}

async function testCallbackSessionVersionMismatchReturns401() {
  const fixtures = await setDirectory()
  const token = await tokenFor({ ...fixtures.owner, sessionVersion: 999 })
  const res = fakeRes()
  await callbackHandler(callbackReq(token), res)
  assert(res.statusCode === 401, `a stale sessionVersion must be a 401 identity failure, got ${res.statusCode}`)
}

async function testCallbackMarketingReturns403() {
  const fixtures = await setDirectory()
  const token = await tokenFor(fixtures.marketing)
  const res = fakeRes()
  await callbackHandler(callbackReq(token), res)
  assert(res.statusCode === 403, `authenticated Marketing (wrong role) must now get 403, got ${res.statusCode}`)
  assert(res.body.includes('Access denied'), 'body must present the new wrong-role message')
}

async function testCallbackLocationManagerReturns403() {
  const fixtures = await setDirectory()
  const token = await tokenFor(fixtures.location_manager)
  const res = fakeRes()
  await callbackHandler(callbackReq(token), res)
  assert(res.statusCode === 403, `authenticated Location Manager (wrong role) must get 403, got ${res.statusCode}`)
}

async function testCallbackReadOnlyReturns403() {
  const fixtures = await setDirectory()
  const token = await tokenFor(fixtures.read_only)
  const res = fakeRes()
  await callbackHandler(callbackReq(token), res)
  assert(res.statusCode === 403, `authenticated Read Only (wrong role) must get 403, got ${res.statusCode}`)
}

async function testCallbackOwnerReachesExistingSuccessPath() {
  // "Reaches the existing successful path" for the AUTH GATE this milestone
  // touches means: the Owner gate no longer blocks with 401/403. The next
  // check down the line (independent CSRF state validation, unchanged by
  // this milestone) is deliberately left to fail here -- no state cookie is
  // set -- so this test exercises only the gate this milestone changed,
  // without needing to mock Google's token endpoint (already covered, and
  // explicitly out of scope for this milestone, in test_oauth_safety.js /
  // the full OAuth flow tests).
  const fixtures = await setDirectory()
  const token = await tokenFor(fixtures.owner)
  const res = fakeRes()
  await callbackHandler(callbackReq(token), res)
  assert(res.statusCode !== 401 && res.statusCode !== 403, `a valid Owner must pass the auth/role gate (got ${res.statusCode}, which must not be 401 or 403)`)
  assert(res.statusCode === 400, `expected to reach the unchanged CSRF-state check next (400, no state cookie set), got ${res.statusCode}`)
}

async function testCallbackResponseShapeIsHtmlForBoth401And403() {
  const fixtures = await setDirectory()
  const unauthedRes = fakeRes()
  await callbackHandler(callbackReq(null), unauthedRes)
  assert(typeof unauthedRes.body === 'string' && unauthedRes.body.includes('<html'), '401 response must remain HTML')

  const marketingToken = await tokenFor(fixtures.marketing)
  const forbiddenRes = fakeRes()
  await callbackHandler(callbackReq(marketingToken), forbiddenRes)
  assert(typeof forbiddenRes.body === 'string' && forbiddenRes.body.includes('<html'), '403 response must also be HTML, matching this endpoint\'s existing response type')
}

// ---------------------------------------------------------------------------
// Shared helper: fail-closed behavior
// ---------------------------------------------------------------------------

async function testStatusForAuthFailureFailsClosedForUnknownReasons() {
  assert(statusForAuthFailure('forbidden') === 403, 'the only reason that maps to 403 is the literal string "forbidden"')
  for (const reason of ['unauthenticated', 'session_expired', undefined, null, '', 'some_unrecognized_future_reason', 'FORBIDDEN', 'Forbidden']) {
    assert(statusForAuthFailure(reason) === 401, `unknown/malformed reason ${JSON.stringify(reason)} must fail closed to 401, not be mistaken for an authorized-but-wrong-role case`)
  }
}

async function testNoOtherEndpointBehaviorChanged() {
  // Static confirmation that this milestone touched only what it claims to:
  // both files still import evaluateSession, both still gate on ['owner']
  // only (Marketing was never made eligible), and neither references any
  // location-scoping helper.
  const { readFileSync } = await import('fs')
  const { fileURLToPath } = await import('url')
  const path = await import('path')
  const dashboardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard')
  const authSrc = readFileSync(path.join(dashboardDir, 'api', 'google', 'auth.js'), 'utf-8')
  const callbackSrc = readFileSync(path.join(dashboardDir, 'api', 'google', 'callback.js'), 'utf-8')
  for (const [name, src] of [['auth.js', authSrc], ['callback.js', callbackSrc]]) {
    assert(/evaluateSession\(req, \['owner'\]\)/.test(src), `${name} must still gate on ['owner'] only -- Marketing must not become eligible`)
    assert(!/requireLocationAccess|requireOwnership|requireScopedAuth/.test(src), `${name} must not reference any location-scoping helper`)
  }
}

async function main() {
  await run('/api/google/auth: unauthenticated -> 401', testAuthUnauthenticatedReturns401)
  await run('/api/google/auth: invalid session -> 401', testAuthInvalidSessionReturns401)
  await run('/api/google/auth: disabled account -> 401', testAuthDisabledAccountReturns401)
  await run('/api/google/auth: sessionVersion mismatch -> 401', testAuthSessionVersionMismatchReturns401)
  await run('/api/google/auth: valid Marketing account -> 403', testAuthMarketingReturns403)
  await run('/api/google/auth: valid Location Manager account -> 403', testAuthLocationManagerReturns403)
  await run('/api/google/auth: valid Read Only account -> 403', testAuthReadOnlyReturns403)
  await run('/api/google/auth: valid Owner account reaches the existing successful (redirect) path', testAuthOwnerReachesExistingSuccessPath)
  await run('/api/google/auth: 401 and 403 responses are both HTML (response shape preserved)', testAuthResponseShapeIsHtmlForBoth401And403)

  await run('/api/google/callback: unauthenticated -> 401', testCallbackUnauthenticatedReturns401)
  await run('/api/google/callback: invalid session -> 401', testCallbackInvalidSessionReturns401)
  await run('/api/google/callback: disabled account -> 401', testCallbackDisabledAccountReturns401)
  await run('/api/google/callback: sessionVersion mismatch -> 401', testCallbackSessionVersionMismatchReturns401)
  await run('/api/google/callback: valid Marketing account -> 403', testCallbackMarketingReturns403)
  await run('/api/google/callback: valid Location Manager account -> 403', testCallbackLocationManagerReturns403)
  await run('/api/google/callback: valid Read Only account -> 403', testCallbackReadOnlyReturns403)
  await run('/api/google/callback: valid Owner account reaches the existing successful path (unchanged CSRF check next)', testCallbackOwnerReachesExistingSuccessPath)
  await run('/api/google/callback: 401 and 403 responses are both HTML (response shape preserved)', testCallbackResponseShapeIsHtmlForBoth401And403)

  await run('statusForAuthFailure() fails closed to 401 for any reason other than literally "forbidden"', testStatusForAuthFailureFailsClosedForUnknownReasons)
  await run('both endpoints still gate on Owner only, with no location-scoping helper referenced', testNoOtherEndpointBehaviorChanged)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
