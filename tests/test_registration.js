// Multi-Tenant Phase 4Q.1 -- HTTP-level tests for the self-service
// registration/email-verification actions added to
// dashboard/api/session/[action].js: register, resend-verification,
// verify-email-status, verify-email. Exercises the real handler against a
// single shared in-memory fake Redis backing pendingRegistrationStore.js,
// tokenStore.js, and tenantConfigStore.js (register() reserves a tenant id
// via generateTenantId(), which reads tenantConfigStore.js), matching this
// project's established multi-store-fake pattern (test_invitations.js).
//
// Run directly: node tests/test_registration.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import handler from '../dashboard/api/session/[action].js'
import { _setRedisClientForTests as setPendingClient, _resetRedisClientForTests as resetPendingClient } from '../dashboard/api/_lib/pendingRegistrationStore.js'
import { _setRedisClientForTests as setTokenClient, _resetRedisClientForTests as resetTokenClient, hashToken } from '../dashboard/api/_lib/tokenStore.js'
import { _setRedisClientForTests as setTenantConfigClient, _resetRedisClientForTests as resetTenantConfigClient } from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setUserStoreClient, _resetRedisClientForTests as resetUserStoreClient } from '../dashboard/api/_lib/userStore.js'
import { _setTransportForTests, _resetTransportForTests } from '../dashboard/api/_lib/emailSender.js'
import { verifyPendingSignupToken, PENDING_SIGNUP_COOKIE } from '../dashboard/api/_lib/pendingSignupSession.js'

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
    resetPendingClient()
    resetTokenClient()
    resetTenantConfigClient()
    resetUserStoreClient()
    _resetTransportForTests()
    delete process.env.ACCOUNT_DIRECTORY_JSON
  }
}

// One in-memory store shared across pendingRegistrationStore.js (SET NX EX/
// GET/DEL, one key per email), tokenStore.js (SET EX/GET/GETDEL/DEL, one key
// per token hash), and tenantConfigStore.js (HGET/HGETALL/HSET on a single
// hash -- register()'s generateTenantId() only ever HGETs a candidate id
// that will never collide against an empty fake, so no EVAL support is
// needed here).
function fakeRedis() {
  const data = {}
  function expired(entry) { return entry.expiresAtMs !== null && Date.now() >= entry.expiresAtMs }
  return {
    get: async (key) => {
      const e = data[key]
      if (!e || e.kind !== 'string' || expired(e)) return null
      return e.value
    },
    set: async (key, value, opts = {}) => {
      const existing = data[key]
      const alive = existing && existing.kind === 'string' && !expired(existing)
      if (opts.nx && alive) return null
      data[key] = { kind: 'string', value, expiresAtMs: opts.ex ? Date.now() + opts.ex * 1000 : null }
      return 'OK'
    },
    getdel: async (key) => {
      const e = data[key]
      if (!e || e.kind !== 'string' || expired(e)) { delete data[key]; return null }
      delete data[key]
      return e.value
    },
    del: async (key) => {
      const existed = key in data
      delete data[key]
      return existed ? 1 : 0
    },
    hget: async (key, field) => {
      const e = data[key]
      if (!e || e.kind !== 'hash') return null
      return e.value[field] ?? null
    },
    hgetall: async (key) => (data[key]?.kind === 'hash' ? { ...data[key].value } : {}),
    hset: async (key, fields) => {
      data[key] ??= { kind: 'hash', value: {}, expiresAtMs: null }
      Object.assign(data[key].value, fields)
    },
    _raw: data,
  }
}

function installFakeRedis() {
  const client = fakeRedis()
  setPendingClient(() => client)
  setTokenClient(() => client)
  setTenantConfigClient(() => client)
  // "Prevent duplicate/shadow tenant creation" hardening: register() now
  // calls getAccountByEmailRequireRedisHealthy() (accountStore.js), which
  // fails closed (503, no reservation) if userStore.js's Redis identity
  // lookup cannot be verified -- this store must be wired too, or every
  // register() call in this file would look identical to a genuine outage.
  setUserStoreClient(() => client)
  return client
}

let sentEmails
function installWorkingEmailTransport() {
  sentEmails = []
  _setTransportForTests(() => ({
    sendMail: async (opts) => { sentEmails.push(opts); return { messageId: 'test-message-id', response: '250 OK' } },
  }))
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  res.getHeader = (name) => res.headers[name]
  return res
}

async function invoke(action, body, extra = {}) {
  const req = {
    method: extra.method ?? 'POST', body, headers: { host: 'app.futuremark.studio', ...(extra.headers ?? {}) },
    query: { action, ...(extra.query ?? {}) }, socket: { remoteAddress: '127.0.0.1' },
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

const VALID_PASSWORD = 'correct-horse-battery-staple'
function registerBody(overrides = {}) {
  return {
    email: 'newowner@example.com', password: VALID_PASSWORD, passwordConfirmation: VALID_PASSWORD,
    displayName: 'New Owner', companyName: 'Sunset Grill Group', ...overrides,
  }
}

function extractVerifyTokenFromEmail() {
  assert(sentEmails.length >= 1, 'expected a verification email to have been sent')
  const { text, html } = sentEmails[sentEmails.length - 1]
  const match = (text || html || '').match(/token=([A-Za-z0-9%_-]+)/)
  assert(match, 'expected the email body to carry a verify-email link with a token')
  return decodeURIComponent(match[1])
}

async function testRegisterHappyPathCreatesPendingAndSendsVerificationEmail() {
  installFakeRedis()
  installWorkingEmailTransport()
  const res = await invoke('register', registerBody())
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.success === true, 'must return the generic success response')
  assert(sentEmails.length === 1, `expected exactly one verification email, got ${sentEmails.length}`)
  assert(sentEmails[0].to === 'newowner@example.com', 'email must go to the registrant')
}

async function testRegisterUnknownEmailAndExistingAccountGiveSameGenericResponse() {
  installFakeRedis()
  installWorkingEmailTransport()
  const freshRes = await invoke('register', registerBody({ email: 'fresh@example.com' }))

  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    // A syntactically real bcrypt hash is required -- accounts.js's
    // isValidAccount() rejects the whole directory (falling back to null,
    // i.e. "no accounts exist") if any record's passwordHash doesn't match
    // BCRYPT_HASH_RE, which would silently defeat this exact test.
    accounts: [{ userId: 'usr_existing', email: 'existing@example.com', passwordHash: '$2b$12$Y0I8ZmmUnNDBireCWez0M.AGkTN6bxJWhySMGh8LPi.5tu7ynlnsm', role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Existing' }],
  })
  sentEmails.length = 0
  const existingRes = await invoke('register', registerBody({ email: 'existing@example.com' }))

  assert(freshRes.statusCode === existingRes.statusCode, 'status code must not reveal which email already has an account')
  assert(JSON.stringify(freshRes.body) === JSON.stringify(existingRes.body), 'response body must be byte-identical regardless of whether the account already exists')
  assert(sentEmails.length === 0, 'no verification email must be sent for an email that already has a real account')
}

async function testRegisterValidationErrors() {
  installFakeRedis()
  installWorkingEmailTransport()
  const badEmail = await invoke('register', registerBody({ email: 'not-an-email' }))
  assert(badEmail.statusCode === 400, 'invalid email must 400')

  const weakPassword = await invoke('register', registerBody({ password: 'short', passwordConfirmation: 'short' }))
  assert(weakPassword.statusCode === 400, 'weak password must 400')

  const mismatched = await invoke('register', registerBody({ passwordConfirmation: 'something-else-entirely' }))
  assert(mismatched.statusCode === 400, 'mismatched confirmation must 400')

  const noName = await invoke('register', registerBody({ displayName: '' }))
  assert(noName.statusCode === 400, 'missing display name must 400')

  const noCompany = await invoke('register', registerBody({ companyName: '' }))
  assert(noCompany.statusCode === 400, 'missing company name must 400')

  assert(sentEmails.length === 0, 'no email must ever be sent for a validation failure')
}

async function testRegisterIdempotentResubmissionDoesNotResetTheReservedIdentity() {
  installFakeRedis()
  installWorkingEmailTransport()
  await invoke('register', registerBody())
  const firstToken = extractVerifyTokenFromEmail()

  sentEmails.length = 0
  const second = await invoke('register', registerBody({ displayName: 'A Different Name Entirely' }))
  assert(second.statusCode === 200)
  assert(sentEmails.length === 1, 'a resubmission for a still-pending email must resend a verification email')

  const secondToken = extractVerifyTokenFromEmail()
  assert(firstToken !== secondToken, 'resubmission must issue a fresh verification token')

  // The stale first token must now be dead -- resubmission revokes it,
  // exactly like resend-verification's own explicit "revoked after resend"
  // contract.
  const verifyOld = await invoke('verify-email', { token: firstToken })
  assert(verifyOld.statusCode === 400, 'the token from the first submission must no longer be usable')
}

async function testResendVerificationUnknownEmailGenericResponseNoEmailSent() {
  installFakeRedis()
  installWorkingEmailTransport()
  const res = await invoke('resend-verification', { email: 'never-registered@example.com' })
  assert(res.statusCode === 200)
  assert(res.body.success === true)
  assert(sentEmails.length === 0, 'no email must be sent for an email with no pending registration')
}

async function testResendVerificationForPendingRegistrationSendsFreshEmail() {
  installFakeRedis()
  installWorkingEmailTransport()
  await invoke('register', registerBody())
  const firstToken = extractVerifyTokenFromEmail()
  sentEmails.length = 0

  const res = await invoke('resend-verification', { email: registerBody().email })
  assert(res.statusCode === 200)
  assert(sentEmails.length === 1, 'resend must send exactly one fresh email')
  const secondToken = extractVerifyTokenFromEmail()
  assert(firstToken !== secondToken, 'resend must issue a new token, not reuse the old one')
}

async function testResendVerificationDoesNothingOnceAlreadyVerified() {
  installFakeRedis()
  installWorkingEmailTransport()
  await invoke('register', registerBody())
  const token = extractVerifyTokenFromEmail()
  await invoke('verify-email', { token })
  sentEmails.length = 0

  const res = await invoke('resend-verification', { email: registerBody().email })
  assert(res.statusCode === 200, 'must still return the generic response')
  assert(sentEmails.length === 0, 'must never re-send a verification email once the registration has moved past pending_verification')
}

async function testVerifyEmailStatusReflectsTokenValidity() {
  installFakeRedis()
  installWorkingEmailTransport()
  await invoke('register', registerBody())
  const token = extractVerifyTokenFromEmail()

  const valid = await invoke('verify-email-status', undefined, { method: 'GET', query: { token } })
  assert(valid.statusCode === 200 && valid.body.valid === true, 'a freshly-issued token must report valid')

  const invalid = await invoke('verify-email-status', undefined, { method: 'GET', query: { token: 'garbage-token-value' } })
  assert(invalid.statusCode === 200 && invalid.body.valid === false, 'an unknown token must report invalid, not error')
}

async function testVerifyEmailHappyPathSetsPendingSignupCookie() {
  installFakeRedis()
  installWorkingEmailTransport()
  await invoke('register', registerBody())
  const token = extractVerifyTokenFromEmail()

  const res = await invoke('verify-email', { token })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.email === registerBody().email)
  assert(res.body.companyName === registerBody().companyName)

  const setCookie = res.headers['Set-Cookie']
  assert(setCookie && setCookie.includes(PENDING_SIGNUP_COOKIE), 'must set the lta_pending_signup cookie')
  assert(setCookie.includes('HttpOnly'), 'pending-signup cookie must be HttpOnly')
  const cookieValue = decodeURIComponent(setCookie.split(`${PENDING_SIGNUP_COOKIE}=`)[1].split(';')[0])
  const claims = await verifyPendingSignupToken(cookieValue)
  assert(claims && claims.email === registerBody().email, 'issued pending-signup token must verify and carry the registrant email')

  // Single-use: replaying the same raw token must now fail.
  const replay = await invoke('verify-email', { token })
  assert(replay.statusCode === 400, 'the same verification token must not be usable twice')
}

async function testVerifyEmailInvalidOrExpiredTokenReturns400() {
  installFakeRedis()
  installWorkingEmailTransport()
  const res = await invoke('verify-email', { token: 'this-token-was-never-issued' })
  assert(res.statusCode === 400)
  assert(res.body.error === 'invalid_or_expired_token')
}

async function testVerifyEmailMissingPendingRegistrationReturns404() {
  const client = installFakeRedis()
  installWorkingEmailTransport()
  await invoke('register', registerBody())
  const token = extractVerifyTokenFromEmail()
  // Simulate the pending record having vanished (e.g. TTL expiry) between
  // issuing the token and the registrant clicking the link -- the token
  // itself is still valid, but there is nothing left to update.
  delete client._raw[`pending_registrations:v1:${registerBody().email}`]

  const res = await invoke('verify-email', { token })
  assert(res.statusCode === 404, `expected 404, got ${res.statusCode}`)
}

const tests = [
  ['register happy path creates a pending registration and sends one verification email', testRegisterHappyPathCreatesPendingAndSendsVerificationEmail],
  ['register gives byte-identical generic responses for a new email and an existing account (no enumeration)', testRegisterUnknownEmailAndExistingAccountGiveSameGenericResponse],
  ['register validation errors (bad email, weak password, mismatch, missing name/company) all 400', testRegisterValidationErrors],
  ['a resubmission for a still-pending email resends a fresh token and revokes the old one', testRegisterIdempotentResubmissionDoesNotResetTheReservedIdentity],
  ['resend-verification for an unknown email returns the generic response and sends nothing', testResendVerificationUnknownEmailGenericResponseNoEmailSent],
  ['resend-verification for a pending registration sends a fresh verification email', testResendVerificationForPendingRegistrationSendsFreshEmail],
  ['resend-verification is a no-op once the registration is already verified', testResendVerificationDoesNothingOnceAlreadyVerified],
  ['verify-email-status reports valid/invalid without consuming the token', testVerifyEmailStatusReflectsTokenValidity],
  ['verify-email happy path sets the pending-signup cookie and is single-use', testVerifyEmailHappyPathSetsPendingSignupCookie],
  ['verify-email with an unissued token returns 400 invalid_or_expired_token', testVerifyEmailInvalidOrExpiredTokenReturns400],
  ['verify-email with a valid token but a vanished pending registration returns 404', testVerifyEmailMissingPendingRegistrationReturns404],
]

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
