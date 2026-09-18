// Google Sign-In (PRYOR login identity) -- end-to-end HTTP-level tests for
// session/[action].js's google-login-start/google-login-callback/
// google-signup-status/google-signup-complete, exercised through the real
// handler (never a unit call to an unexported helper), plus direct
// googleIdentityStore.js/deriveUserStatus() checks where a store-level
// invariant has no HTTP-visible surface of its own.
//
// The CENTRAL thing every test here protects: Google Sign-In (identity
// only, openid/email/profile) and Google Business Profile (GBP, a
// completely separate OAuth client/scope/credential store) must never be
// confused, merged, or allowed to leak into one another -- see
// testCriticalSeparationBetweenLoginIdentityAndGbpManager() for the
// explicit two-Google-account scenario this feature's own spec calls out.
//
// No real Google network call anywhere in this file --
// exchangeGoogleAuthCode()/verifyGoogleIdToken() are substituted via
// googleAuthClient.js's own test seam.
//
// Run directly: node tests/test_google_social_auth.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.GOOGLE_AUTH_CLIENT_ID = 'fake-login-client-id'
process.env.GOOGLE_AUTH_CLIENT_SECRET = 'fake-login-client-secret'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'

import handler from '../dashboard/api/session/[action].js'
import { _setRedisClientForTests as setPendingClient, _resetRedisClientForTests as resetPendingClient, getPendingRegistration } from '../dashboard/api/_lib/pendingRegistrationStore.js'
import { _setRedisClientForTests as setTokenClient, _resetRedisClientForTests as resetTokenClient } from '../dashboard/api/_lib/tokenStore.js'
import { _setRedisClientForTests as setTenantConfigClient, _resetRedisClientForTests as resetTenantConfigClient } from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setUserStoreClient, _resetRedisClientForTests as resetUserStoreClient, getUserByEmail, getUserById, deriveUserStatus } from '../dashboard/api/_lib/userStore.js'
import { _setRedisClientForTests as setAccessCodeClient, _resetRedisClientForTests as resetAccessCodeClient, createAccessCode } from '../dashboard/api/_lib/accessCodeStore.js'
import { _setRedisClientForTests as setGoogleIdentityClient, _resetRedisClientForTests as resetGoogleIdentityClient, getIdentityBySubject } from '../dashboard/api/_lib/googleIdentityStore.js'
import { _setRedisClientForTests as setCredentialClient, _resetRedisClientForTests as resetCredentialClient, setStoredCredential, getStoredCredential } from '../dashboard/api/_lib/credentialStore.js'
import { _setGoogleAuthClientForTests, _resetGoogleAuthClientForTests } from '../dashboard/api/_lib/googleAuthClient.js'
import { _setTransportForTests, _resetTransportForTests } from '../dashboard/api/_lib/emailSender.js'
import { verifySession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { createInviteToken } from '../dashboard/api/_lib/tokenStore.js'
import { _setLimiterFactoryForTests, _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
async function run(name, fn) {
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: true, remaining: 999, reset: Date.now() + 60000 }) }))
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
    resetAccessCodeClient()
    resetGoogleIdentityClient()
    resetCredentialClient()
    _resetGoogleAuthClientForTests()
    _resetTransportForTests()
    _resetLimiterFactoryForTests()
    delete process.env.ACCOUNT_DIRECTORY_JSON
  }
}

// Same event-loop-turn-per-op fake Redis as
// test_tenant_creation_from_registration.js's own (copied deliberately --
// see that file's header for why every op must cross a real tick rather
// than resolving synchronously).
function tick(fn) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try { resolve(fn()) } catch (err) { reject(err) }
    })
  })
}

function fakeRedis() {
  const data = {}
  function expired(entry) { return entry.expiresAtMs !== null && Date.now() >= entry.expiresAtMs }
  return {
    get: (key) => tick(() => {
      const e = data[key]
      if (!e || e.kind !== 'string' || expired(e)) return null
      return e.value
    }),
    set: (key, value, opts = {}) => tick(() => {
      const existing = data[key]
      const alive = existing && existing.kind === 'string' && !expired(existing)
      if (opts.nx && alive) return null
      data[key] = { kind: 'string', value, expiresAtMs: opts.ex ? Date.now() + opts.ex * 1000 : null }
      return 'OK'
    }),
    getdel: (key) => tick(() => {
      const e = data[key]
      if (!e || e.kind !== 'string' || expired(e)) { delete data[key]; return null }
      delete data[key]
      return e.value
    }),
    del: (key) => tick(() => {
      const existed = key in data
      delete data[key]
      return existed ? 1 : 0
    }),
    hget: (key, field) => tick(() => {
      const e = data[key]
      if (!e || e.kind !== 'hash') return null
      return e.value[field] ?? null
    }),
    hgetall: (key) => tick(() => (data[key]?.kind === 'hash' ? { ...data[key].value } : {})),
    hset: (key, fields) => tick(() => {
      data[key] ??= { kind: 'hash', value: {}, expiresAtMs: null }
      Object.assign(data[key].value, fields)
    }),
    hdel: (key, field) => tick(() => {
      const e = data[key]
      if (!e || !(field in e.value)) return 0
      delete e.value[field]
      return 1
    }),
    eval: (_script, keys, args) => tick(() => {
      const key = keys[0]
      const claimKey = keys[1]
      const [codeHash, tenantId, userId, nowIso, claimPayload, claimTtlSecondsStr] = args
      const entry = data[key]
      const raw = entry?.kind === 'hash' ? entry.value[codeHash] : null
      if (!raw) return false
      let code
      try { code = JSON.parse(raw) } catch { return false }
      if (code.status !== 'active') return false
      if (code.expiresAt && code.expiresAt < nowIso) return false
      if (code.redemptionCount >= code.maxRedemptions) return false
      code.redemptionCount += 1
      code.redemptions = code.redemptions || []
      code.redemptions.push({ tenantId, userId, redeemedAt: nowIso })
      entry.value[codeHash] = JSON.stringify(code)
      if (claimKey && claimPayload !== undefined) {
        data[claimKey] = { kind: 'string', value: claimPayload, expiresAtMs: Date.now() + Number(claimTtlSecondsStr) * 1000 }
      }
      return JSON.stringify(code)
    }),
    _raw: data,
  }
}

function installFakeRedis() {
  const client = fakeRedis()
  setPendingClient(() => client)
  setTokenClient(() => client)
  setTenantConfigClient(() => client)
  setUserStoreClient(() => client)
  setAccessCodeClient(() => client)
  setGoogleIdentityClient(() => client)
  setCredentialClient(() => client)
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
  res.redirect = (code, url) => { res.statusCode = code; res.headers['Location'] = url; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  res.getHeader = (name) => res.headers[name]
  return res
}

async function invokePost(action, body, { cookie } = {}) {
  const req = {
    method: 'POST', body, headers: { host: 'app.futuremark.studio', ...(cookie ? { cookie } : {}) },
    query: { action }, socket: { remoteAddress: '127.0.0.1' },
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function invokeGet(action, query = {}, { cookie } = {}) {
  const req = {
    method: 'GET', headers: { host: 'app.futuremark.studio', ...(cookie ? { cookie } : {}) },
    query: { action, ...query }, socket: { remoteAddress: '127.0.0.1' },
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

function cookieFromRes(res, name) {
  const setCookie = res.headers['Set-Cookie']
  if (!setCookie) return null
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const c of list) {
    if (c.startsWith(`${name}=`)) return `${name}=${c.split(`${name}=`)[1].split(';')[0]}`
  }
  return null
}

function combineCookies(...cookieStrings) {
  return cookieStrings.filter(Boolean).join('; ')
}

// Installs a fake Google identity for the NEXT exchange/verify call pair --
// mirrors real usage (exchangeGoogleAuthCode() returns tokens, then
// verifyGoogleIdToken() returns the verified claims from the id_token
// inside them), without a real network call or a real signed JWT.
function installFakeGoogleIdentity({ sub, email, email_verified = true, name = 'Test User' }) {
  _setGoogleAuthClientForTests({
    exchangeGoogleAuthCode: async () => ({ id_token: 'fake-id-token', access_token: 'fake-access-token' }),
    verifyGoogleIdToken: async () => ({ sub, email, email_verified, name }),
  })
}

function installFailingGoogleExchange(message = 'boom') {
  _setGoogleAuthClientForTests({
    exchangeGoogleAuthCode: async () => { throw new Error(message) },
    verifyGoogleIdToken: async () => { throw new Error('should not be called') },
  })
}

// Drives google-login-start -> google-login-callback for a single Google
// identity, returning the callback's own res (a redirect). `startCookie`
// lets a caller carry an existing lta_session cookie through start (the
// account-linking case) or an accept-invite page's own no-session state
// (the default).
async function startAndCallback({ sub, email, email_verified = true, name = 'Test User', returnTo, inviteToken, startCookie = null, oauthError = null }) {
  const startQuery = {}
  if (returnTo) startQuery.returnTo = returnTo
  if (inviteToken) startQuery.inviteToken = inviteToken
  const startRes = await invokeGet('google-login-start', startQuery, { cookie: startCookie })
  const flowCookie = cookieFromRes(startRes, 'lta_google_login_state')

  if (!flowCookie) return { startRes, callbackRes: null }

  installFakeGoogleIdentity({ sub, email, email_verified, name })

  const authorizeUrl = startRes.headers.Location
  const state = new URL(authorizeUrl).searchParams.get('state')

  const callbackQuery = oauthError ? { error: oauthError } : { code: 'fake-auth-code', state }
  const callbackCookie = combineCookies(flowCookie, startCookie)
  const callbackRes = await invokeGet('google-login-callback', callbackQuery, { cookie: callbackCookie })
  return { startRes, callbackRes, flowCookie }
}

const TENANT_A = 't_google-auth-a'

async function makeAccessCode(overrides = {}) {
  const { rawCode } = await createAccessCode({ prefix: 'LTA-TST', plan: 'core', paymentRequired: false, createdBy: 'usr_admin', ...overrides })
  return rawCode
}

// ===========================================================================
// 1. New Google signup -> /complete-signup -> real tenant + user
// ===========================================================================

async function testNewGoogleSignupCreatesRealTenantAfterCompleteSignup() {
  installFakeRedis()
  installWorkingEmailTransport()

  const { callbackRes } = await startAndCallback({ sub: 'google-sub-newuser-1', email: 'newowner@example.com' })
  assert(callbackRes.statusCode === 302, `sanity: expected a redirect, got ${callbackRes.statusCode}`)
  assert(callbackRes.headers.Location === '/complete-signup', `expected redirect to /complete-signup, got ${callbackRes.headers.Location}`)
  const signupPendingCookie = cookieFromRes(callbackRes, 'lta_google_signup_pending')
  assert(signupPendingCookie, 'expected the lta_google_signup_pending cookie to be set')

  const statusRes = await invokeGet('google-signup-status', {}, { cookie: signupPendingCookie })
  assert(statusRes.statusCode === 200 && statusRes.body.email === 'newowner@example.com', 'google-signup-status must reflect the verified Google identity')

  const completeRes = await invokePost('google-signup-complete', { companyName: 'Sunset Grill Group' }, { cookie: signupPendingCookie })
  assert(completeRes.statusCode === 200, `expected 200, got ${completeRes.statusCode} ${JSON.stringify(completeRes.body)}`)
  const pendingSignupCookie = cookieFromRes(completeRes, 'lta_pending_signup')
  assert(pendingSignupCookie, 'expected the standard lta_pending_signup cookie to be set, same as email verification')

  const pending = await getPendingRegistration('newowner@example.com')
  assert(pending.status === 'verified_awaiting_plan', `expected verified_awaiting_plan, got ${pending.status}`)
  assert(pending.passwordHash === null, 'a Google-only signup must never have a password hash')
  assert(pending.googleIdentity?.providerSubject === 'google-sub-newuser-1', 'the pending registration must carry the verified Google identity through')

  // Complete tenant creation via the existing access-code path -- proves
  // createTenantForVerifiedRegistration()'s new googleIdentity param links
  // the identity once the real tenant/user exist.
  const rawCode = await makeAccessCode()
  const redeemRes = await invokePost('redeem-access-code', { code: rawCode }, { cookie: pendingSignupCookie })
  assert(redeemRes.statusCode === 200, `expected 200, got ${redeemRes.statusCode} ${JSON.stringify(redeemRes.body)}`)
  const sessionCookie = cookieFromRes(redeemRes, SESSION_COOKIE)
  assert(sessionCookie, 'expected a real lta_session cookie after tenant creation')

  const claims = await verifySession(sessionCookie.split('=')[1])
  const tenantId = claims.tenantId
  const userRecord = await getUserById(tenantId, claims.userId)
  assert(userRecord.passwordHash === null, 'the real user record must still have no password')
  assert(userRecord.googleIdentity?.providerSubject === 'google-sub-newuser-1', 'the real user record must have the Google identity linked')
  assert(deriveUserStatus(userRecord) === 'active', 'a Google-linked user must be reported active, never merely invited')

  const identity = await getIdentityBySubject('google-sub-newuser-1')
  assert(identity && identity.tenantId === tenantId && identity.userId === claims.userId, 'the global identity index must resolve to this exact tenant/user')
}

// ===========================================================================
// 2. Returning Google login
// ===========================================================================

async function testReturningLoginForAnAlreadyLinkedIdentity() {
  installFakeRedis()
  installWorkingEmailTransport()

  // Seed a real tenant/user with a linked Google identity by running the
  // full signup chain once.
  const { callbackRes: seedCb } = await startAndCallback({ sub: 'google-sub-returning-1', email: 'returning@example.com' })
  const seedPendingCookie = cookieFromRes(seedCb, 'lta_google_signup_pending')
  const completeRes = await invokePost('google-signup-complete', { companyName: 'Returning Co' }, { cookie: seedPendingCookie })
  const pendingSignupCookie = cookieFromRes(completeRes, 'lta_pending_signup')
  const rawCode = await makeAccessCode()
  const redeemRes = await invokePost('redeem-access-code', { code: rawCode }, { cookie: pendingSignupCookie })
  const firstSessionCookie = cookieFromRes(redeemRes, SESSION_COOKIE)
  const firstClaims = await verifySession(firstSessionCookie.split('=')[1])

  // Now sign in again with the SAME Google identity -- no invite, no
  // pending registration involved this time.
  const { callbackRes } = await startAndCallback({ sub: 'google-sub-returning-1', email: 'returning@example.com' })
  assert(callbackRes.statusCode === 302 && callbackRes.headers.Location === '/', `expected a redirect to /, got ${callbackRes.statusCode} ${callbackRes.headers.Location}`)
  const secondSessionCookie = cookieFromRes(callbackRes, SESSION_COOKIE)
  assert(secondSessionCookie, 'expected a real session cookie on returning login')
  const secondClaims = await verifySession(secondSessionCookie.split('=')[1])
  assert(secondClaims.userId === firstClaims.userId && secondClaims.tenantId === firstClaims.tenantId, 'returning login must resolve to the SAME PRYOR user, not create a new one')
}

// ===========================================================================
// 3. OAuth cancellation / invalid / expired state / bad code / bad token
// ===========================================================================

async function testOAuthCancellationRedirectsWithFriendlyCode() {
  installFakeRedis()
  const { callbackRes } = await startAndCallback({ sub: 'x', email: 'x@example.com', oauthError: 'access_denied' })
  assert(callbackRes.statusCode === 302, 'expected a redirect')
  assert(callbackRes.headers.Location.includes('googleAuthError=canceled'), `expected googleAuthError=canceled, got ${callbackRes.headers.Location}`)
}

async function testInvalidStateIsRejected() {
  installFakeRedis()
  const startRes = await invokeGet('google-login-start', {})
  const flowCookie = cookieFromRes(startRes, 'lta_google_login_state')
  installFakeGoogleIdentity({ sub: 'x', email: 'x@example.com' })
  const callbackRes = await invokeGet('google-login-callback', { code: 'fake-code', state: 'totally-wrong-nonce' }, { cookie: flowCookie })
  assert(callbackRes.headers.Location.includes('googleAuthError=state_invalid'), `expected state_invalid, got ${callbackRes.headers.Location}`)
}

async function testMissingFlowStateCookieFallsBackToLogin() {
  installFakeRedis()
  installFakeGoogleIdentity({ sub: 'x', email: 'x@example.com' })
  // No prior google-login-start call at all -- simulates an expired/never-
  // set flow-state cookie (also covers "expired state").
  const callbackRes = await invokeGet('google-login-callback', { code: 'fake-code', state: 'anything' })
  assert(callbackRes.headers.Location.startsWith('/login'), `expected fallback to /login, got ${callbackRes.headers.Location}`)
  assert(callbackRes.headers.Location.includes('googleAuthError=state_invalid'))
}

async function testInvalidAuthorizationCodeExchangeFailure() {
  installFakeRedis()
  const startRes = await invokeGet('google-login-start', {})
  const flowCookie = cookieFromRes(startRes, 'lta_google_login_state')
  const state = new URL(startRes.headers.Location).searchParams.get('state')
  installFailingGoogleExchange('invalid_grant')
  const callbackRes = await invokeGet('google-login-callback', { code: 'bad-code', state }, { cookie: flowCookie })
  assert(callbackRes.headers.Location.includes('googleAuthError=exchange_failed'), `expected exchange_failed, got ${callbackRes.headers.Location}`)
  // The raw provider error must never appear in the redirect target.
  assert(!callbackRes.headers.Location.includes('invalid_grant'), 'must never leak the raw provider error code to the browser')
}

async function testWrongIssuerOrAudienceIsTreatedAsExchangeFailure() {
  installFakeRedis()
  const startRes = await invokeGet('google-login-start', {})
  const flowCookie = cookieFromRes(startRes, 'lta_google_login_state')
  const state = new URL(startRes.headers.Location).searchParams.get('state')
  _setGoogleAuthClientForTests({
    exchangeGoogleAuthCode: async () => ({ id_token: 'fake-id-token' }),
    verifyGoogleIdToken: async () => { throw new Error('JWTClaimValidationFailed: unexpected "aud" claim value') },
  })
  const callbackRes = await invokeGet('google-login-callback', { code: 'fake-code', state }, { cookie: flowCookie })
  assert(callbackRes.headers.Location.includes('googleAuthError=exchange_failed'), `expected exchange_failed for a bad audience, got ${callbackRes.headers.Location}`)
}

async function testMissingEmailIsRejected() {
  installFakeRedis()
  const { callbackRes } = await startAndCallback({ sub: 'x', email: null })
  assert(callbackRes.headers.Location.includes('googleAuthError=email_unverified'), `expected email_unverified, got ${callbackRes.headers.Location}`)
}

async function testUnverifiedEmailIsRejected() {
  installFakeRedis()
  const { callbackRes } = await startAndCallback({ sub: 'x', email: 'unverified@example.com', email_verified: false })
  assert(callbackRes.headers.Location.includes('googleAuthError=email_unverified'), `expected email_unverified, got ${callbackRes.headers.Location}`)
  const identity = await getIdentityBySubject('x')
  assert(!identity, 'an unverified email must never result in a linked identity')
}

// ===========================================================================
// 4. providerSubject uniqueness / duplicate email / safe linking / conflicts
// ===========================================================================

async function testDuplicateProviderSubjectCannotBelongToTwoUsers() {
  installFakeRedis()
  installWorkingEmailTransport()

  // User 1 signs up and links google-sub-shared.
  const { callbackRes: cb1 } = await startAndCallback({ sub: 'google-sub-shared', email: 'user1@example.com' })
  const pendingCookie1 = cookieFromRes(cb1, 'lta_google_signup_pending')
  const complete1 = await invokePost('google-signup-complete', { companyName: 'Co One' }, { cookie: pendingCookie1 })
  const signupCookie1 = cookieFromRes(complete1, 'lta_pending_signup')
  const code1 = await makeAccessCode()
  const redeem1 = await invokePost('redeem-access-code', { code: code1 }, { cookie: signupCookie1 })
  const session1 = cookieFromRes(redeem1, SESSION_COOKIE)
  const claims1 = await verifySession(session1.split('=')[1])

  // User 2, a DIFFERENT email, somehow presents the SAME providerSubject
  // (structurally shouldn't happen with a real Google account, but proves
  // the store-level invariant holds regardless): must never silently
  // attach to a second user.
  const { callbackRes: cb2 } = await startAndCallback({ sub: 'google-sub-shared', email: 'user2@example.com' })
  // Case B (returning login) resolves FIRST since the subject is already
  // indexed -- it must log in as USER 1's account (the subject's true
  // owner), never create or attach to a second identity for user2's email.
  const session2 = cookieFromRes(cb2, SESSION_COOKIE)
  assert(session2, 'expected a session (the existing identity owner), not a new-signup redirect')
  const claims2 = await verifySession(session2.split('=')[1])
  assert(claims2.userId === claims1.userId, 'the shared providerSubject must resolve to its ORIGINAL owner, never a second user')
  assert(claims2.email === 'user1@example.com', 'the resulting session must be user1\'s real account, never mislabeled with user2\'s email')
}

async function testExistingPasswordAccountBlocksAutoMergeOnEmailMatch() {
  installFakeRedis()
  installWorkingEmailTransport()

  // A real, password-based tenant/owner already exists (via the ordinary
  // register/verify-email/redeem-access-code chain), then Google login is
  // attempted for the SAME email, unauthenticated.
  await invokePost('register', {
    email: 'owner@restaurant.com', password: 'correct-horse-battery-staple', passwordConfirmation: 'correct-horse-battery-staple',
    displayName: 'Owner', companyName: 'Restaurant Co',
  })
  const { text } = sentEmails[sentEmails.length - 1]
  const verifyToken = decodeURIComponent(text.match(/token=([A-Za-z0-9%_-]+)/)[1])
  const verifyRes = await invokePost('verify-email', { token: verifyToken })
  const pendingSignupCookie = cookieFromRes(verifyRes, 'lta_pending_signup')
  const code = await makeAccessCode()
  await invokePost('redeem-access-code', { code }, { cookie: pendingSignupCookie })

  const { callbackRes } = await startAndCallback({ sub: 'google-sub-collides', email: 'owner@restaurant.com' })
  assert(callbackRes.headers.Location.startsWith('/login'), `expected a redirect to /login, got ${callbackRes.headers.Location}`)
  assert(callbackRes.headers.Location.includes('googleAuthError=existing_account'), `expected existing_account, got ${callbackRes.headers.Location}`)
  assert(!cookieFromRes(callbackRes, SESSION_COOKIE), 'must never issue a session -- no auto-merge on email equality alone')

  const identity = await getIdentityBySubject('google-sub-collides')
  assert(!identity, 'the Google identity must never be linked without the owner proving ownership first')

  // The original password login must still work, completely unaffected.
  const loginRes = await invokePost('login', { email: 'owner@restaurant.com', password: 'correct-horse-battery-staple' })
  assert(loginRes.statusCode === 200, 'the existing password login must be completely unaffected by the attempted Google collision')
}

async function testSafeAccountLinkingFromAnAuthenticatedSession() {
  installFakeRedis()
  installWorkingEmailTransport()

  await invokePost('register', {
    email: 'linker@restaurant.com', password: 'correct-horse-battery-staple', passwordConfirmation: 'correct-horse-battery-staple',
    displayName: 'Linker', companyName: 'Linker Co',
  })
  const { text } = sentEmails[sentEmails.length - 1]
  const verifyToken = decodeURIComponent(text.match(/token=([A-Za-z0-9%_-]+)/)[1])
  const verifyRes = await invokePost('verify-email', { token: verifyToken })
  const pendingSignupCookie = cookieFromRes(verifyRes, 'lta_pending_signup')
  const code = await makeAccessCode()
  const redeemRes = await invokePost('redeem-access-code', { code }, { cookie: pendingSignupCookie })
  const sessionCookie = cookieFromRes(redeemRes, SESSION_COOKIE)
  const claims = await verifySession(sessionCookie.split('=')[1])

  // Owner proves ownership (an authenticated session) THEN links Google --
  // this is the confirmation-before-linking Part 7 requires.
  const { callbackRes } = await startAndCallback({ sub: 'google-sub-link-proof', email: 'linker@restaurant.com', startCookie: sessionCookie })
  assert(callbackRes.statusCode === 302 && callbackRes.headers.Location === '/', `expected a plain redirect to /, got ${callbackRes.statusCode} ${callbackRes.headers.Location}`)

  const userRecord = await getUserById(claims.tenantId, claims.userId)
  assert(userRecord.googleIdentity?.providerSubject === 'google-sub-link-proof', 'the Google identity must now be linked to this exact user')
  assert(userRecord.passwordHash, 'linking Google must never clear the existing password hash')

  // Password login still works, unaffected by the link.
  const loginRes = await invokePost('login', { email: 'linker@restaurant.com', password: 'correct-horse-battery-staple' })
  assert(loginRes.statusCode === 200, 'password login must still work after linking Google')

  // And Google login now works too, resolving to the SAME account.
  const { callbackRes: returningCb } = await startAndCallback({ sub: 'google-sub-link-proof', email: 'linker@restaurant.com' })
  const returningSession = cookieFromRes(returningCb, SESSION_COOKIE)
  const returningClaims = await verifySession(returningSession.split('=')[1])
  assert(returningClaims.userId === claims.userId, 'Google login must now resolve to the SAME linked account')
}

async function testConflictingIdentityDuringLinkingFailsClosed() {
  installFakeRedis()
  installWorkingEmailTransport()

  // Identity already belongs to user1 (via full signup).
  const { callbackRes: cb1 } = await startAndCallback({ sub: 'google-sub-taken', email: 'first@example.com' })
  const pendingCookie1 = cookieFromRes(cb1, 'lta_google_signup_pending')
  const complete1 = await invokePost('google-signup-complete', { companyName: 'First Co' }, { cookie: pendingCookie1 })
  const signupCookie1 = cookieFromRes(complete1, 'lta_pending_signup')
  const code1 = await makeAccessCode()
  await invokePost('redeem-access-code', { code: code1 }, { cookie: signupCookie1 })

  // A second, DIFFERENT authenticated user tries to link the SAME already-
  // taken providerSubject to their OWN account.
  await invokePost('register', {
    email: 'second@example.com', password: 'correct-horse-battery-staple', passwordConfirmation: 'correct-horse-battery-staple',
    displayName: 'Second', companyName: 'Second Co',
  })
  const { text } = sentEmails[sentEmails.length - 1]
  const verifyToken = decodeURIComponent(text.match(/token=([A-Za-z0-9%_-]+)/)[1])
  const verifyRes = await invokePost('verify-email', { token: verifyToken })
  const pendingSignupCookie2 = cookieFromRes(verifyRes, 'lta_pending_signup')
  const code2 = await makeAccessCode()
  const redeem2 = await invokePost('redeem-access-code', { code: code2 }, { cookie: pendingSignupCookie2 })
  const session2 = cookieFromRes(redeem2, SESSION_COOKIE)
  const claims2 = await verifySession(session2.split('=')[1])

  const { callbackRes } = await startAndCallback({ sub: 'google-sub-taken', email: 'second@example.com', startCookie: session2 })
  assert(callbackRes.headers.Location.includes('googleAuthError=identity_conflict'), `expected identity_conflict, got ${callbackRes.headers.Location}`)

  const identity = await getIdentityBySubject('google-sub-taken')
  const userRecord2 = await getUserById(claims2.tenantId, claims2.userId)
  assert(!userRecord2.googleIdentity, 'the second user must never gain the already-taken identity')
  assert(identity.userId !== claims2.userId, 'the original owner\'s identity link must be completely untouched by the failed attempt')
}

// ===========================================================================
// 5. Invite + Google
// ===========================================================================

async function testInviteContinuationWithMatchingGoogleEmail() {
  installFakeRedis()

  const inviteeUserId = 'usr_invitee_google'
  // Seed the invited user record directly (mirrors settings/[action].js's
  // own invite-user write shape closely enough for this test's purpose).
  const client = fakeRedis()
  setUserStoreClient(() => client)
  setTenantConfigClient(() => client)
  setGoogleIdentityClient(() => client)
  const { upsertTenantConfig } = await import('../dashboard/api/_lib/tenantConfigStore.js')
  await upsertTenantConfig(TENANT_A, {}, { allowCreate: true, creationSource: 'migration' })
  const { upsertUser, UserCreationMode } = await import('../dashboard/api/_lib/userStore.js')
  await upsertUser(TENANT_A, {
    userId: inviteeUserId, email: 'manager@restaurant.com', passwordHash: null, role: 'location_manager', locationIds: '*',
    sessionVersion: 1, disabled: false, invitedAt: new Date().toISOString(), tenantId: TENANT_A,
  }, { creationMode: UserCreationMode.EXISTING_TENANT_INVITE })

  const { rawToken } = await createInviteToken({ userId: inviteeUserId, email: 'manager@restaurant.com', role: 'location_manager', locationIds: '*', invitedBy: 'usr_owner' })

  const { callbackRes } = await startAndCallback({ sub: 'google-sub-invitee', email: 'manager@restaurant.com', inviteToken: rawToken })
  assert(callbackRes.statusCode === 302 && callbackRes.headers.Location === '/', `expected a redirect to /, got ${callbackRes.statusCode} ${callbackRes.headers.Location}`)
  const sessionCookie = cookieFromRes(callbackRes, SESSION_COOKIE)
  assert(sessionCookie, 'expected a real session after accepting the invite via Google')
  const claims = await verifySession(sessionCookie.split('=')[1])
  assert(claims.userId === inviteeUserId && claims.tenantId === TENANT_A, 'must resolve to the exact invited user/tenant')

  const userRecord = await getUserById(TENANT_A, inviteeUserId)
  assert(userRecord.googleIdentity?.providerSubject === 'google-sub-invitee', 'the invited user must now have Google linked')
  assert(userRecord.role === 'location_manager' && userRecord.locationIds === '*', 'role/location grants from the invite must be preserved, never widened')
}

async function testInviteCannotBeHijackedByAnUnrelatedGoogleAccount() {
  installFakeRedis()

  const inviteeUserId = 'usr_invitee_hijack'
  const client = fakeRedis()
  setUserStoreClient(() => client)
  setTenantConfigClient(() => client)
  setGoogleIdentityClient(() => client)
  const { upsertTenantConfig } = await import('../dashboard/api/_lib/tenantConfigStore.js')
  await upsertTenantConfig(TENANT_A, {}, { allowCreate: true, creationSource: 'migration' })
  const { upsertUser, UserCreationMode } = await import('../dashboard/api/_lib/userStore.js')
  await upsertUser(TENANT_A, {
    userId: inviteeUserId, email: 'realmanager@restaurant.com', passwordHash: null, role: 'location_manager', locationIds: '*',
    sessionVersion: 1, disabled: false, tenantId: TENANT_A,
  }, { creationMode: UserCreationMode.EXISTING_TENANT_INVITE })

  const { rawToken } = await createInviteToken({ userId: inviteeUserId, email: 'realmanager@restaurant.com', role: 'location_manager', locationIds: '*', invitedBy: 'usr_owner' })

  // An UNRELATED Google account tries to consume this invite.
  const { callbackRes } = await startAndCallback({ sub: 'google-sub-attacker', email: 'attacker@gmail.com', inviteToken: rawToken })
  assert(callbackRes.headers.Location.includes('googleAuthError=invite_identity_mismatch'), `expected invite_identity_mismatch, got ${callbackRes.headers.Location}`)
  assert(!cookieFromRes(callbackRes, SESSION_COOKIE), 'must never issue a session for the mismatched attempt')

  // The invite must still be usable by the RIGHT identity afterward -- it
  // was never consumed by the failed attempt.
  const { callbackRes: legitCb } = await startAndCallback({ sub: 'google-sub-real-manager', email: 'realmanager@restaurant.com', inviteToken: rawToken })
  const sessionCookie = cookieFromRes(legitCb, SESSION_COOKIE)
  assert(sessionCookie, 'the legitimate invitee must still be able to accept the SAME invite after the hijack attempt failed')
}

// ===========================================================================
// 6. Tenant isolation
// ===========================================================================

async function testGoogleIdentityIsIsolatedPerTenant() {
  installFakeRedis()
  installWorkingEmailTransport()

  const { callbackRes: cbA } = await startAndCallback({ sub: 'google-sub-tenant-a', email: 'ownerA@example.com' })
  const pendingCookieA = cookieFromRes(cbA, 'lta_google_signup_pending')
  const completeA = await invokePost('google-signup-complete', { companyName: 'Tenant A Co' }, { cookie: pendingCookieA })
  const signupCookieA = cookieFromRes(completeA, 'lta_pending_signup')
  const codeA = await makeAccessCode()
  const redeemA = await invokePost('redeem-access-code', { code: codeA }, { cookie: signupCookieA })
  const claimsA = await verifySession(cookieFromRes(redeemA, SESSION_COOKIE).split('=')[1])

  const { callbackRes: cbB } = await startAndCallback({ sub: 'google-sub-tenant-b', email: 'ownerB@example.com' })
  const pendingCookieB = cookieFromRes(cbB, 'lta_google_signup_pending')
  const completeB = await invokePost('google-signup-complete', { companyName: 'Tenant B Co' }, { cookie: pendingCookieB })
  const signupCookieB = cookieFromRes(completeB, 'lta_pending_signup')
  const codeB = await makeAccessCode()
  const redeemB = await invokePost('redeem-access-code', { code: codeB }, { cookie: signupCookieB })
  const claimsB = await verifySession(cookieFromRes(redeemB, SESSION_COOKIE).split('=')[1])

  assert(claimsA.tenantId !== claimsB.tenantId, 'sanity: two independent Google signups must land in two independent tenants')
  const identityA = await getIdentityBySubject('google-sub-tenant-a')
  const identityB = await getIdentityBySubject('google-sub-tenant-b')
  assert(identityA.tenantId === claimsA.tenantId && identityB.tenantId === claimsB.tenantId, 'each identity must resolve only to its OWN tenant')

  // Tenant A's user record must not exist in tenant B's user store and
  // vice versa.
  assert(!(await getUserById(claimsB.tenantId, claimsA.userId)), 'tenant A\'s user must not be readable under tenant B')
  assert(!(await getUserById(claimsA.tenantId, claimsB.userId)), 'tenant B\'s user must not be readable under tenant A')
}

// ===========================================================================
// 7. Session issuance/restoration, logout
// ===========================================================================

async function testSessionRestorationAndLogout() {
  installFakeRedis()
  installWorkingEmailTransport()

  const { callbackRes: cb } = await startAndCallback({ sub: 'google-sub-session-test', email: 'sessiontest@example.com' })
  const pendingCookie = cookieFromRes(cb, 'lta_google_signup_pending')
  const complete = await invokePost('google-signup-complete', { companyName: 'Session Co' }, { cookie: pendingCookie })
  const signupCookie = cookieFromRes(complete, 'lta_pending_signup')
  const code = await makeAccessCode()
  const redeem = await invokePost('redeem-access-code', { code }, { cookie: signupCookie })
  const sessionCookie = cookieFromRes(redeem, SESSION_COOKIE)

  const whoamiRes = await invokePost('whoami', {}, { cookie: sessionCookie })
  // whoami is GET in this API, but invokePost still exercises the wrong-
  // method guard correctly -- use invokeGet for the real call.
  const whoamiGet = await invokeGet('whoami', {}, { cookie: sessionCookie })
  assert(whoamiGet.statusCode === 200, `expected whoami to succeed with the Google-issued session, got ${whoamiGet.statusCode}`)

  const logoutRes = await invokePost('logout', {}, { cookie: sessionCookie })
  assert(logoutRes.statusCode === 200, 'logout must succeed')
  const clearedCookie = cookieFromRes(logoutRes, SESSION_COOKIE)
  // clearCookie() sets Max-Age=0 / an empty value -- either way, the
  // ORIGINAL session token string must no longer be present verbatim.
  assert(!logoutRes.headers['Set-Cookie']?.toString().includes(sessionCookie.split('=')[1]), 'logout must actually clear the session cookie value')
  void whoamiRes; void clearedCookie
}

// ===========================================================================
// 8. Critical separation -- PRYOR login identity vs. GBP manager (Part 14)
// ===========================================================================

async function testCriticalSeparationBetweenLoginIdentityAndGbpManager() {
  installFakeRedis()
  installWorkingEmailTransport()

  // 1-3: user@gmail.com signs up to PRYOR via Google -- becomes the login
  // identity. No GBP credential exists yet, no GBP scope was ever
  // requested (structurally true: googleAuthClient.js's SCOPE is
  // 'openid email profile' only, asserted separately in
  // test_google_login_scope_isolation below).
  const { callbackRes: cb } = await startAndCallback({ sub: 'account-a-sub', email: 'user@gmail.com' })
  const pendingCookie = cookieFromRes(cb, 'lta_google_signup_pending')
  const complete = await invokePost('google-signup-complete', { companyName: 'Restaurant Group' }, { cookie: pendingCookie })
  const signupCookie = cookieFromRes(complete, 'lta_pending_signup')
  const code = await makeAccessCode()
  const redeem = await invokePost('redeem-access-code', { code }, { cookie: signupCookie })
  const sessionCookie = cookieFromRes(redeem, SESSION_COOKIE)
  const claims = await verifySession(sessionCookie.split('=')[1])
  const tenantId = claims.tenantId

  assert((await getStoredCredential(tenantId)) === null, '3. no GBP credential must exist yet')

  // 5-9: the Owner authorizes GBP with account B
  // (restaurantmanager@gmail.com) -- simulated directly at the store layer
  // (the real OAuth exchange is google/[action].js's own, already-tested
  // concern; what matters HERE is that this action never touches login
  // identity in any way).
  await setStoredCredential(tenantId, { refreshToken: 'fake-refresh-token-account-b', connectedAccountName: 'restaurantmanager@gmail.com' })

  // 10-11: account A still owns the PRYOR login identity; account B owns
  // only the GBP connection.
  const userRecordAfterGbp = await getUserById(tenantId, claims.userId)
  assert(userRecordAfterGbp.googleIdentity?.providerSubject === 'account-a-sub', '10. Account A must still own the PRYOR login identity')
  assert(userRecordAfterGbp.email === 'user@gmail.com', 'the login identity\'s own email must be unchanged')
  const stored = await getStoredCredential(tenantId)
  assert(stored.connectedAccountName === 'restaurantmanager@gmail.com', '9/11. the GBP connection is Account B\'s, tracked independently of login identity')

  // 12-13: Account A never gains GBP scopes (there is no such field on a
  // user record at all -- GBP credentials live ONLY in credentialStore.js,
  // keyed by tenantId, never by userId/providerSubject); Account B never
  // becomes a PRYOR login provider (googleIdentityStore.js has no entry
  // for account B's subject at all).
  assert(!('gbpCredential' in userRecordAfterGbp) && !('refreshToken' in userRecordAfterGbp), '12. the user record must never carry any GBP credential material')
  assert((await getIdentityBySubject('restaurantmanager-account-b-sub')) === null, '13. Account B must never appear in the login-identity index')

  // 14: disconnecting GBP does not log the user out -- session validity
  // (whoami/requireAuth) is proven completely independent of
  // credentialStore.js's state by simulating a disconnected/invalidated
  // credential (an empty refreshToken, mirroring google/[action].js's own
  // disconnect() write shape closely enough for this purpose) and
  // confirming the session is still accepted.
  await setStoredCredential(tenantId, { refreshToken: '', connectedAccountName: null })
  const whoamiAfterDisconnect = await invokeGet('whoami', {}, { cookie: sessionCookie })
  assert(whoamiAfterDisconnect.statusCode === 200, '14. disconnecting GBP must never invalidate the login session')

  // 15: reconnecting GBP does not change login identity.
  await setStoredCredential(tenantId, { refreshToken: 'fake-refresh-token-account-b-again', connectedAccountName: 'restaurantmanager@gmail.com' })
  const userRecordAfterReconnect = await getUserById(tenantId, claims.userId)
  assert(userRecordAfterReconnect.googleIdentity?.providerSubject === 'account-a-sub', '15. reconnecting GBP must never change the login identity')

  // 16: linking/unlinking the login provider does not delete GBP
  // credentials -- unlinkGoogleIdentity() never touches credentialStore.js
  // at all (see googleIdentityStore.js's own header).
  const { unlinkGoogleIdentity } = await import('../dashboard/api/_lib/googleIdentityStore.js')
  await unlinkGoogleIdentity(tenantId, claims.userId)
  const credentialAfterUnlink = await getStoredCredential(tenantId)
  assert(credentialAfterUnlink !== null, '16. unlinking the login provider must never delete the tenant\'s GBP credential')
}

function testGoogleLoginScopeIsolationFromGbp() {
  // Structural, source-level assertion: the login client's OWN scope
  // constant must never mention GBP's scope, and must never read GBP's
  // env vars -- see googleAuthClient.js's own header for why this is a
  // structural guarantee, not just a runtime behavior.
  const content = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', '_lib', 'googleAuthClient.js'), 'utf-8')
  assert(/SCOPE = 'openid email profile'/.test(content), 'the login client\'s own SCOPE constant must request exactly the identity scopes')
  // The header comment may reference "business.manage" in prose (explaining
  // WHY the two systems are kept separate) -- what must never exist is an
  // actual GBP env-var reference or a scope assignment naming it.
  assert(!/process\.env\.GOOGLE_CLIENT_ID|process\.env\.GOOGLE_CLIENT_SECRET/.test(content), 'the login client must never read the GBP OAuth client env vars')
  assert(!/scope:\s*['"`][^'"`]*business\.manage/.test(content), 'the login client must never assign the GBP scope to any scope parameter')
}

// ===========================================================================
// 9. Pending-registration resume (real Preview bug fix)
// ===========================================================================

// The exact reported bug: a Google identity that completed
// google-signup-complete() and reached /get-started, but never chose a
// commercial path, logging out and returning with the SAME Google account
// must resume /get-started directly -- never /complete-signup again, never
// a second pending registration, never re-asking for name/company.
async function testReturningGoogleAfterGetStartedResumesWithoutAskingAgain() {
  installFakeRedis()
  installWorkingEmailTransport()

  const { callbackRes: firstCb } = await startAndCallback({ sub: 'google-sub-resume-1', email: 'resume1@example.com' })
  const signupPendingCookie = cookieFromRes(firstCb, 'lta_google_signup_pending')
  const completeRes = await invokePost('google-signup-complete', { companyName: 'Resume Test Co', displayName: 'Resume Owner' }, { cookie: signupPendingCookie })
  assert(completeRes.statusCode === 200, `sanity: expected 200, got ${completeRes.statusCode} ${JSON.stringify(completeRes.body)}`)
  const originalPending = await getPendingRegistration('resume1@example.com')
  assert(originalPending.status === 'verified_awaiting_plan', 'sanity: expected the pending registration to reach verified_awaiting_plan')

  // "Logout" here means simply not carrying any session/cookie forward --
  // no real session was ever issued for a pending registration in the
  // first place (Part 4), so there is nothing to clear.

  // Returning: SAME providerSubject, no invite, no existing real account.
  const { callbackRes: secondCb } = await startAndCallback({ sub: 'google-sub-resume-1', email: 'resume1@example.com' })
  assert(secondCb.statusCode === 302, `expected a redirect, got ${secondCb.statusCode}`)
  assert(secondCb.headers.Location === '/get-started', `expected a direct resume to /get-started, got ${secondCb.headers.Location}`)
  assert(!cookieFromRes(secondCb, 'lta_google_signup_pending'), 'must never re-enter the /complete-signup flow for an already-completed pending registration')
  const resumedPendingSignupCookie = cookieFromRes(secondCb, 'lta_pending_signup')
  assert(resumedPendingSignupCookie, 'expected a real lta_pending_signup cookie so /get-started can load normally')
  assert(!cookieFromRes(secondCb, SESSION_COOKIE), 'must never issue a real tenant session merely to resume pending onboarding')

  // The resumed cookie must actually work against get-started-status.
  const statusRes = await invokeGet('get-started-status', {}, { cookie: resumedPendingSignupCookie })
  assert(statusRes.statusCode === 200 && statusRes.body.companyName === 'Resume Test Co', 'the resumed session must reach the SAME pending registration')

  // No duplicate registration was created; name/company are unchanged.
  const afterPending = await getPendingRegistration('resume1@example.com')
  assert(afterPending.userId === originalPending.userId, 'must resolve to the exact SAME pending registration, never a new one')
  assert(afterPending.companyName === 'Resume Test Co' && afterPending.displayName === 'Resume Owner', 'name/company must remain exactly as originally submitted, never reset or asked again')
}

async function testReturningBeforeCompleteSignupResumesCompleteSignupAgain() {
  installFakeRedis()
  installWorkingEmailTransport()

  const { callbackRes: firstCb } = await startAndCallback({ sub: 'google-sub-resume-2', email: 'resume2@example.com' })
  assert(firstCb.headers.Location === '/complete-signup', 'sanity: first callback must land on /complete-signup')
  // Deliberately never call google-signup-complete -- nothing is persisted
  // to Redis yet (Case E's whole point).
  assert(!(await getPendingRegistration('resume2@example.com')), 'sanity: no pending registration should exist yet')

  const { callbackRes: secondCb } = await startAndCallback({ sub: 'google-sub-resume-2', email: 'resume2@example.com' })
  assert(secondCb.headers.Location === '/complete-signup', `expected /complete-signup again (nothing to resume yet), got ${secondCb.headers.Location}`)
  assert(cookieFromRes(secondCb, 'lta_google_signup_pending'), 'expected a fresh lta_google_signup_pending cookie')
  assert(!(await getPendingRegistration('resume2@example.com')), 'still no pending registration -- Case E never writes to Redis by itself')
}

async function testExpiredPendingRegistrationStartsFresh() {
  installFakeRedis()
  installWorkingEmailTransport()

  const { callbackRes: firstCb } = await startAndCallback({ sub: 'google-sub-resume-3', email: 'resume3@example.com' })
  const signupPendingCookie = cookieFromRes(firstCb, 'lta_google_signup_pending')
  await invokePost('google-signup-complete', { companyName: 'Expiring Co' }, { cookie: signupPendingCookie })
  assert(await getPendingRegistration('resume3@example.com'), 'sanity: pending registration must exist before expiry')

  // Simulates the record's own 7-day Redis TTL elapsing -- the resulting
  // state (getPendingRegistration returns null) is identical either way.
  const { deletePendingRegistration } = await import('../dashboard/api/_lib/pendingRegistrationStore.js')
  await deletePendingRegistration('resume3@example.com')

  const { callbackRes: secondCb } = await startAndCallback({ sub: 'google-sub-resume-3', email: 'resume3@example.com' })
  assert(secondCb.statusCode === 302 && secondCb.headers.Location === '/complete-signup', `expired registration must start a genuinely fresh signup, got ${secondCb.statusCode} ${secondCb.headers.Location}`)
  assert(!secondCb.headers.Location.includes('googleAuthError'), 'an expired pending registration must never surface as a technical error -- just a normal fresh signup')
}

// Covers both "a different providerSubject cannot resume someone else's
// pending signup" and "the same email with a different providerSubject
// does not hijack a pending registration" -- the same underlying
// invariant viewed from either identity's side.
async function testDifferentProviderSubjectCannotHijackAnotherPendingRegistration() {
  installFakeRedis()
  installWorkingEmailTransport()

  const { callbackRes: ownerCb } = await startAndCallback({ sub: 'google-sub-owner-real', email: 'shared-email@example.com' })
  const signupPendingCookie = cookieFromRes(ownerCb, 'lta_google_signup_pending')
  await invokePost('google-signup-complete', { companyName: 'Owner Co' }, { cookie: signupPendingCookie })
  const beforeAttack = await getPendingRegistration('shared-email@example.com')
  assert(beforeAttack.googleIdentity?.providerSubject === 'google-sub-owner-real', 'sanity: the pending registration belongs to the real owner\'s identity')

  // A DIFFERENT Google account presents the SAME email (contrived, but
  // proves the store-level invariant holds regardless of how it happens).
  const { callbackRes: attackerCb } = await startAndCallback({ sub: 'google-sub-attacker', email: 'shared-email@example.com' })
  assert(attackerCb.headers.Location.startsWith('/login'), `expected a redirect to /login, got ${attackerCb.headers.Location}`)
  assert(attackerCb.headers.Location.includes('googleAuthError=existing_account'), `expected existing_account, got ${attackerCb.headers.Location}`)
  assert(!cookieFromRes(attackerCb, 'lta_pending_signup'), 'the mismatched identity must never receive a pending-signup cookie')
  assert(!cookieFromRes(attackerCb, SESSION_COOKIE), 'the mismatched identity must never receive a real session')

  // The real owner's own pending registration must be completely
  // untouched by the failed attempt.
  const afterAttack = await getPendingRegistration('shared-email@example.com')
  assert(afterAttack.googleIdentity?.providerSubject === 'google-sub-owner-real', 'the original owner\'s pending registration must remain untouched')
  assert(afterAttack.companyName === 'Owner Co', 'the original data must be unchanged')
}

async function testPermanentUserTakesPrecedenceOverStalePendingState() {
  installFakeRedis()
  installWorkingEmailTransport()

  // Complete the full chain through real tenant creation.
  const { callbackRes: cb } = await startAndCallback({ sub: 'google-sub-permanent', email: 'permanent@example.com' })
  const signupPendingCookie = cookieFromRes(cb, 'lta_google_signup_pending')
  const completeRes = await invokePost('google-signup-complete', { companyName: 'Permanent Co' }, { cookie: signupPendingCookie })
  const pendingSignupCookie = cookieFromRes(completeRes, 'lta_pending_signup')
  const rawCode = await makeAccessCode()
  const redeemRes = await invokePost('redeem-access-code', { code: rawCode }, { cookie: pendingSignupCookie })
  const sessionCookie = cookieFromRes(redeemRes, SESSION_COOKIE)
  const claims = await verifySession(sessionCookie.split('=')[1])
  assert(!(await getPendingRegistration('permanent@example.com')), 'sanity: the pending registration must be deleted once the real tenant exists')

  // Defensively re-insert a stale pending registration under the SAME
  // email (should never happen in the real flow, since it's deleted in
  // the same transaction -- this proves the ORDERING is correct even if
  // it somehow did).
  const { createPendingRegistration } = await import('../dashboard/api/_lib/pendingRegistrationStore.js')
  await createPendingRegistration({
    email: 'permanent@example.com', passwordHash: null, displayName: 'Stale', companyName: 'Stale Co',
    userId: 'usr_stale_leftover', tenantIdReserved: 't_stale-leftover-abcdef',
  })

  const { callbackRes: returningCb } = await startAndCallback({ sub: 'google-sub-permanent', email: 'permanent@example.com' })
  const returningSessionCookie = cookieFromRes(returningCb, SESSION_COOKIE)
  assert(returningSessionCookie, 'the PERMANENT user must be resolved, issuing a real session')
  const returningClaims = await verifySession(returningSessionCookie.split('=')[1])
  assert(returningClaims.userId === claims.userId && returningClaims.tenantId === claims.tenantId, 'must resolve to the real, permanent account -- never the stale pending leftover')
  // issueRealSessionAndRedirect() actively CLEARS lta_pending_signup (a
  // real Set-Cookie header with an empty/expired value) -- cookieFromRes()
  // would still match that header by name, so the real assertion is that
  // the cookie's VALUE is empty, never a genuine active pending-signup
  // token.
  const clearedPendingCookie = cookieFromRes(returningCb, 'lta_pending_signup')
  assert(!clearedPendingCookie || clearedPendingCookie === 'lta_pending_signup=', 'must never issue an ACTIVE pending-signup cookie once a permanent account exists')
}

const tests = [
  ['new Google signup creates a real tenant after complete-signup', testNewGoogleSignupCreatesRealTenantAfterCompleteSignup],
  ['returning login for an already-linked identity', testReturningLoginForAnAlreadyLinkedIdentity],
  ['OAuth cancellation redirects with a friendly code', testOAuthCancellationRedirectsWithFriendlyCode],
  ['invalid state is rejected', testInvalidStateIsRejected],
  ['missing/expired flow-state cookie falls back to /login', testMissingFlowStateCookieFallsBackToLogin],
  ['invalid authorization code -> exchange_failed, never leaks the raw error', testInvalidAuthorizationCodeExchangeFailure],
  ['wrong issuer/audience is treated as exchange failure', testWrongIssuerOrAudienceIsTreatedAsExchangeFailure],
  ['missing email is rejected', testMissingEmailIsRejected],
  ['unverified email is rejected', testUnverifiedEmailIsRejected],
  ['duplicate providerSubject cannot belong to two users', testDuplicateProviderSubjectCannotBelongToTwoUsers],
  ['existing password account blocks auto-merge on email match', testExistingPasswordAccountBlocksAutoMergeOnEmailMatch],
  ['safe account linking from an authenticated session', testSafeAccountLinkingFromAnAuthenticatedSession],
  ['conflicting identity during linking fails closed', testConflictingIdentityDuringLinkingFailsClosed],
  ['invite continuation with a matching Google email', testInviteContinuationWithMatchingGoogleEmail],
  ['invite cannot be hijacked by an unrelated Google account', testInviteCannotBeHijackedByAnUnrelatedGoogleAccount],
  ['Google identity is isolated per tenant', testGoogleIdentityIsIsolatedPerTenant],
  ['session restoration (whoami) and logout work after Google login', testSessionRestorationAndLogout],
  ['CRITICAL: login identity and GBP manager are fully separated', testCriticalSeparationBetweenLoginIdentityAndGbpManager],
  ['Google login scope is isolated from GBP', testGoogleLoginScopeIsolationFromGbp],
  ['returning Google after /get-started resumes without asking again', testReturningGoogleAfterGetStartedResumesWithoutAskingAgain],
  ['returning before complete-signup resumes complete-signup again', testReturningBeforeCompleteSignupResumesCompleteSignupAgain],
  ['expired pending registration starts fresh', testExpiredPendingRegistrationStartsFresh],
  ['different providerSubject cannot hijack another pending registration', testDifferentProviderSubjectCannotHijackAnotherPendingRegistration],
  ['permanent user takes precedence over stale pending state', testPermanentUserTakesPrecedenceOverStalePendingState],
]

for (const [name, fn] of tests) {
  await run(name, fn)
}

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} tests passed`)
process.exit(passed === results.length ? 0 : 1)
