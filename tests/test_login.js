// Regression tests for the login action of
// dashboard/api/session/[action].js -- no real network, no real Upstash
// (UPSTASH_REDIS_REST_URL/TOKEN deliberately left unset so
// enforceRateLimit() takes its documented fail-open path).
//
// Run directly: node tests/test_login.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/session/[action].js'
import { verifySession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'

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
  res.setHeader = (name, value) => { res.headers[name] = value }
  res.getHeader = (name) => res.headers[name]
  return res
}

async function setDirectory() {
  const hash = await bcrypt.hash('correct-horse-battery-staple', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' },
    ],
  })
}

async function invoke(body) {
  const req = { method: 'POST', body, headers: {}, query: { action: 'login' }, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function testSuccessfulLoginSetsCookie() {
  await setDirectory()
  const res = await invoke({ email: 'owner@example.com', password: 'correct-horse-battery-staple' })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.account.email === 'owner@example.com', 'returns account on success')
  assert(res.body.account.passwordHash === undefined, 'never returns passwordHash')
  const setCookie = res.headers['Set-Cookie']
  assert(setCookie && setCookie.includes(SESSION_COOKIE), 'sets the session cookie')
  assert(setCookie.includes('HttpOnly'), 'cookie is HttpOnly')
  assert(setCookie.includes('Secure'), 'cookie is Secure')

  const cookieValue = setCookie.split(`${SESSION_COOKIE}=`)[1].split(';')[0]
  const claims = await verifySession(decodeURIComponent(cookieValue))
  assert(claims && claims.userId === 'usr_owner', 'issued token verifies and carries the right userId')
}

async function testWrongPasswordGenericError() {
  await setDirectory()
  const res = await invoke({ email: 'owner@example.com', password: 'wrong-password' })
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
  assert(res.body.error === 'invalid_credentials', res.body.error)
}

async function testUnknownEmailSameGenericError() {
  await setDirectory()
  const res = await invoke({ email: 'nobody@example.com', password: 'anything' })
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
  assert(res.body.error === 'invalid_credentials', 'unknown email must produce the SAME error code as wrong password (no enumeration)')
  assert(res.body.message === 'Invalid email or password.', 'unknown email must produce the SAME message as wrong password')
}

async function testMissingFieldsReturns400() {
  await setDirectory()
  const res = await invoke({ email: 'owner@example.com' })
  assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`)
}

async function testBrokenAccountDirectoryFailsClosed() {
  process.env.ACCOUNT_DIRECTORY_JSON = 'not json'
  const res = await invoke({ email: 'owner@example.com', password: 'correct-horse-battery-staple' })
  assert(res.statusCode === 401, `expected 401 even with a broken directory, got ${res.statusCode}`)
  assert(res.body.error === 'invalid_credentials', 'broken directory must not leak a different error shape')
}

async function main() {
  await run('successful login sets an HttpOnly/Secure session cookie carrying the right claims', testSuccessfulLoginSetsCookie)
  await run('wrong password returns a generic 401', testWrongPasswordGenericError)
  await run('unknown email returns the exact same generic 401 (no account enumeration)', testUnknownEmailSameGenericError)
  await run('missing email/password returns 400', testMissingFieldsReturns400)
  await run('broken ACCOUNT_DIRECTORY_JSON fails closed with a generic 401, not a 500', testBrokenAccountDirectoryFailsClosed)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
