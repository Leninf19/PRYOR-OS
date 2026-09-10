// Multi-Tenant Phase 4Q.1 -- end-to-end HTTP-level tests for the full
// self-service onboarding path: register -> verify-email -> redeem-access-
// code -> real tenant_config + user record, via session/[action].js's
// actual handlers (never re-implemented). Covers every explicit
// concurrency/idempotency/exclusion case from the approved design:
// identity-occupied-during-the-registration-window, two tenant-creation
// requests racing, an idempotent retry after a simulated partial failure,
// the LTA-exclusion guarantee, and an expired pending-signup session.
//
// One shared in-memory fake Redis backs pendingRegistrationStore.js,
// tokenStore.js, tenantConfigStore.js, userStore.js, and accessCodeStore.js
// (the last needs a real eval() -- REDEEM_SCRIPT is mirrored in JS exactly
// as in test_access_code_store.js, since a single-threaded JS mirror with
// no internal await is exactly as atomic as a real Redis EVAL for the
// purposes of a Promise.all race test).
//
// Run directly: node tests/test_tenant_creation_from_registration.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import handler from '../dashboard/api/session/[action].js'
import { _setRedisClientForTests as setPendingClient, _resetRedisClientForTests as resetPendingClient, getPendingRegistration } from '../dashboard/api/_lib/pendingRegistrationStore.js'
import { _setRedisClientForTests as setTokenClient, _resetRedisClientForTests as resetTokenClient } from '../dashboard/api/_lib/tokenStore.js'
import { _setRedisClientForTests as setTenantConfigClient, _resetRedisClientForTests as resetTenantConfigClient, getTenantConfig, upsertTenantConfig } from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setUserStoreClient, _resetRedisClientForTests as resetUserStoreClient, getUserByEmail } from '../dashboard/api/_lib/userStore.js'
import { _setRedisClientForTests as setAccessCodeClient, _resetRedisClientForTests as resetAccessCodeClient, createAccessCode } from '../dashboard/api/_lib/accessCodeStore.js'
import { _setTransportForTests, _resetTransportForTests } from '../dashboard/api/_lib/emailSender.js'
import { verifySession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { PENDING_SIGNUP_COOKIE, signPendingSignupToken } from '../dashboard/api/_lib/pendingSignupSession.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

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
    resetAccessCodeClient()
    _resetTransportForTests()
    delete process.env.ACCOUNT_DIRECTORY_JSON
  }
}

// Every operation resolves via setImmediate rather than synchronously --
// a real Redis REST call always crosses a genuine event-loop/network
// boundary, and a fake that resolves same-tick lets one "concurrent"
// request's entire ~20-step chain (rate limit, access-code redemption,
// lock, re-checks, upserts, deletes) run to full completion before its
// supposed racer advances past its very first await, since nothing forces
// the two Promise.all'd chains to interleave. Routing every op through one
// real event-loop turn makes both chains advance in lockstep, one Redis
// call at a time, which is what actually exercises the mutual-exclusion
// logic under test (see testTwoTenantCreationRequestsRacingExactlyOneWins)
// rather than accidentally serializing the two requests end-to-end.
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
    // Faithfully mirrors accessCodeStore.js's REDEEM_SCRIPT -- the
    // check-and-increment body still runs as one synchronous unit inside a
    // single event-loop turn, exactly like a real Redis EVAL executes a
    // script atomically relative to every other command.
    eval: (_script, keys, args) => tick(() => {
      const key = keys[0]
      const [codeHash, tenantId, userId, nowIso] = args
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

async function invoke(action, body, { cookie } = {}) {
  const req = {
    method: 'POST', body, headers: { host: 'app.futuremark.studio', ...(cookie ? { cookie } : {}) },
    query: { action }, socket: { remoteAddress: '127.0.0.1' },
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

const VALID_PASSWORD = 'correct-horse-battery-staple'
function registerBody(overrides = {}) {
  return {
    email: 'newowner@example.com', password: VALID_PASSWORD, passwordConfirmation: VALID_PASSWORD,
    displayName: 'New Owner', companyName: 'Sunset Grill Group', ...overrides,
  }
}

function extractVerifyToken() {
  const { text } = sentEmails[sentEmails.length - 1]
  return decodeURIComponent(text.match(/token=([A-Za-z0-9%_-]+)/)[1])
}

// Runs register -> verify-email and returns the lta_pending_signup cookie
// plus the pending registration record (with its reserved tenantId).
async function registerAndVerify(overrides = {}) {
  const body = registerBody(overrides)
  await invoke('register', body)
  const token = extractVerifyToken()
  const verifyRes = await invoke('verify-email', { token })
  const cookie = cookieFromRes(verifyRes, PENDING_SIGNUP_COOKIE)
  const pending = await getPendingRegistration(body.email)
  return { body, cookie, pending }
}

async function makeAccessCode(overrides = {}) {
  const { rawCode } = await createAccessCode({ prefix: 'LTA-TST', plan: 'core', createdBy: 'usr_admin', ...overrides })
  return rawCode
}

async function testFullHappyPathCreatesTenantMatchingBootstrapShape() {
  installFakeRedis()
  installWorkingEmailTransport()
  const { body, cookie, pending } = await registerAndVerify()
  const rawCode = await makeAccessCode()

  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.account.email === body.email)
  assert(res.body.account.role === 'owner', 'a self-service tenant owner must get role: owner')
  assert(res.body.account.locationIds === '*', 'a self-service tenant owner must get company-wide locationIds')
  assert(res.body.account.passwordHash === undefined, 'the response must never carry a password hash')

  const sessionCookie = cookieFromRes(res, SESSION_COOKIE)
  assert(sessionCookie, 'a real lta_session cookie must be issued')
  const claims = await verifySession(decodeURIComponent(sessionCookie.split('=')[1]))
  assert(claims && claims.tenantId === pending.tenantIdReserved, 'the issued session must carry the reserved tenant id')

  const tenantConfig = await getTenantConfig(pending.tenantIdReserved)
  assert(tenantConfig && tenantConfig.displayName === body.companyName)
  assert(tenantConfig.commercial.plan === 'core' && tenantConfig.commercial.source === 'access_code')

  const userRecord = await getUserByEmail(pending.tenantIdReserved, body.email)
  assert(userRecord && userRecord.role === 'owner' && userRecord.locationIds === '*' && userRecord.disabled === false && userRecord.sessionVersion === 1)

  assert((await getPendingRegistration(body.email)) === null, 'the pending registration must be deleted once the real tenant/user exist')

  const clearedPendingSignup = res.headers['Set-Cookie']
  const list = Array.isArray(clearedPendingSignup) ? clearedPendingSignup : [clearedPendingSignup]
  assert(list.some(c => c.startsWith(`${PENDING_SIGNUP_COOKIE}=`) && c.includes('Max-Age=0')), 'the pending-signup cookie must be cleared once a real session exists')
}

async function testEmailOccupiedDuringWindowFailsClosed() {
  installFakeRedis()
  installWorkingEmailTransport()
  const { body, cookie, pending } = await registerAndVerify()
  const rawCode = await makeAccessCode()

  // Simulate an operator invite/another registration creating a REAL
  // account for this exact email during the (up to 7-day) window between
  // registration and tenant creation.
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{ userId: 'usr_real', email: body.email, passwordHash: '$2b$12$Y0I8ZmmUnNDBireCWez0M.AGkTN6bxJWhySMGh8LPi.5tu7ynlnsm', role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Real Owner' }],
  })

  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 409, `expected 409, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.error === 'email_occupied')

  const stillPending = await getPendingRegistration(body.email)
  assert(stillPending && stillPending.status === 'blocked_email_occupied', 'the pending record must be marked blocked, never silently deleted or reused')

  assert((await getTenantConfig(pending.tenantIdReserved)) === null, 'no tenant_config may be created for the reserved id once the email is occupied')
}

async function testTwoTenantCreationRequestsRacingExactlyOneWins() {
  installFakeRedis()
  installWorkingEmailTransport()
  const { cookie } = await registerAndVerify()
  // maxRedemptions generous so the access-code redemption itself is never
  // the bottleneck being tested here -- only the tenant-creation lock is.
  const rawCode = await makeAccessCode({ maxRedemptions: 5 })

  const [a, b] = await Promise.all([
    invoke('redeem-access-code', { code: rawCode }, { cookie }),
    invoke('redeem-access-code', { code: rawCode }, { cookie }),
  ])
  const statuses = [a.statusCode, b.statusCode].sort()
  assert(statuses[0] === 200 && statuses[1] === 409, `expected exactly one 200 and one 409, got ${statuses.join(',')}`)
  const loser = a.statusCode === 409 ? a : b
  assert(loser.body.error === 'creation_in_progress', `loser must fail closed with creation_in_progress, got ${JSON.stringify(loser.body)}`)
}

async function testIdempotentRetryReusesReservedTenantIdAfterPartialFailure() {
  installFakeRedis()
  installWorkingEmailTransport()
  const { body, cookie, pending } = await registerAndVerify()

  // Simulate a prior attempt that successfully wrote tenant_config but died
  // before upsertUser/deletePendingRegistration -- exactly what
  // createTenantForVerifiedRegistration()'s ORDER comment describes as the
  // safe-to-retry partial-failure state.
  await upsertTenantConfig(pending.tenantIdReserved, { displayName: body.companyName, commercial: { plan: 'core', source: 'access_code' } })
  const configAfterSimulatedPartialFailure = await getTenantConfig(pending.tenantIdReserved)
  assert(configAfterSimulatedPartialFailure.configVersion === 1)

  const rawCode = await makeAccessCode()
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200, `retry must still succeed, got ${res.statusCode}: ${JSON.stringify(res.body)}`)

  const finalConfig = await getTenantConfig(pending.tenantIdReserved)
  assert(finalConfig.configVersion === 1, 'the retry must NOT re-write tenant_config (existingTenantConfig short-circuit) -- configVersion must stay at its pre-retry value')

  const userRecord = await getUserByEmail(pending.tenantIdReserved, body.email)
  assert(userRecord && userRecord.role === 'owner', 'the retry must still complete the user-creation step that the simulated prior attempt never reached')
  assert((await getPendingRegistration(body.email)) === null)
}

async function testGeneratedTenantIdNeverCollidesWithLosTresAmigos() {
  installFakeRedis()
  installWorkingEmailTransport()
  // A company name that would slugify to exactly the LTA tenant id's own
  // slug -- generateTenantId()'s randomTenantSuffix() always appends a
  // 6-character suffix, so the candidate can never equal DEFAULT_TENANT_ID
  // itself; this proves that holds even in the adversarial-looking case.
  const { body, cookie, pending } = await registerAndVerify({ email: 'imitator@example.com', companyName: 'Los Tres Amigos' })
  assert(pending.tenantIdReserved !== DEFAULT_TENANT_ID, `a self-service tenant id must never equal the real LTA tenant id, got ${pending.tenantIdReserved}`)
  assert(pending.tenantIdReserved.startsWith('t_los-tres-amigos-'), 'the human-recognizable slug prefix is still expected, just never bare')
  assert((await getTenantConfig(DEFAULT_TENANT_ID)) === null, 'this path must never create/touch the real LTA tenant_config record')

  const rawCode = await makeAccessCode()
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie })
  assert(res.statusCode === 200, `expected the imitator-named registration to still complete normally, got ${res.statusCode}`)
  assert(res.body.account.email === body.email)
  assert((await getTenantConfig(DEFAULT_TENANT_ID)) === null, 'completing tenant creation must still never touch the real LTA tenant_config record')
}

async function testExpiredPendingSignupSessionRejected() {
  installFakeRedis()
  installWorkingEmailTransport()
  const { pending } = await registerAndVerify()

  // Craft an already-expired token using the real signing function itself
  // (never a hand-rolled JWT) by temporarily rewinding Date.now() two hours
  // -- signPendingSignupToken()'s own 1-hour TTL then places its
  // expiration comfortably in the real past.
  const realDateNow = Date.now
  Date.now = () => realDateNow() - 2 * 60 * 60 * 1000
  let expiredToken
  try {
    expiredToken = await signPendingSignupToken({ userId: pending.userId, email: pending.email })
  } finally {
    Date.now = realDateNow
  }

  const rawCode = await makeAccessCode()
  const res = await invoke('redeem-access-code', { code: rawCode }, { cookie: `${PENDING_SIGNUP_COOKIE}=${encodeURIComponent(expiredToken)}` })
  assert(res.statusCode === 401, `expected 401 for an expired pending-signup token, got ${res.statusCode}`)

  assert((await getTenantConfig(pending.tenantIdReserved)) === null, 'an expired pending-signup session must never be able to trigger tenant creation')
}

const tests = [
  ['full register -> verify -> redeem flow creates a tenant/user matching the operator-bootstrap shape', testFullHappyPathCreatesTenantMatchingBootstrapShape],
  ['an email that becomes occupied during the registration window fails closed, never duplicating an identity', testEmailOccupiedDuringWindowFailsClosed],
  ['two concurrent tenant-creation requests for the same pending registration -- exactly one wins', testTwoTenantCreationRequestsRacingExactlyOneWins],
  ['a retry after a simulated partial failure reuses the reserved tenant id and does not double-write', testIdempotentRetryReusesReservedTenantIdAfterPartialFailure],
  ['a generated tenant id can never collide with the real Los Tres Amigos tenant id', testGeneratedTenantIdNeverCollidesWithLosTresAmigos],
  ['an expired pending-signup session is rejected with 401 and can never create a tenant', testExpiredPendingSignupSessionRejected],
]

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
