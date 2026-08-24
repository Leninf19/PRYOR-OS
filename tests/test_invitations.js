// Regression tests for the invitation + password-creation flow -- Multi-
// Location Authentication & User Access System, Commit 2. Exercises the
// real endpoint handlers (settings/[action].js's invite-user/resend-invite/
// revoke-invite, session/[action].js's invite-status/accept-invite)
// end-to-end against a single shared in-memory fake Redis (both
// userStore.js and tokenStore.js point at the SAME fake instance, since one
// request genuinely touches both stores).
//
// Run directly: node tests/test_invitations.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { verifySession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { signSession } from '../dashboard/api/_lib/session.js'
import settingsHandler from '../dashboard/api/settings/[action].js'
import sessionHandler from '../dashboard/api/session/[action].js'
import { _setRedisClientForTests as setUserStoreClient, _resetRedisClientForTests as resetUserStoreClient, getUserById } from '../dashboard/api/_lib/userStore.js'
import { _setRedisClientForTests as setTokenStoreClient, _resetRedisClientForTests as resetTokenStoreClient } from '../dashboard/api/_lib/tokenStore.js'
import { _setTransportForTests, _resetTransportForTests } from '../dashboard/api/_lib/emailSender.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

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
    resetUserStoreClient()
    resetTokenStoreClient()
    _resetTransportForTests()
    delete process.env.ACCOUNT_DIRECTORY_JSON
  }
}

// A single in-memory Redis stand-in supporting both the string commands
// tokenStore.js uses (get/set/getdel/del, with real TTL expiry simulated by
// timestamp so an "expired token" test is genuine, not just a stubbed
// return value) and the hash commands userStore.js uses (hget/hset/
// hgetall/hdel) -- shared between both _setRedisClientForTests() calls so a
// single request that touches both stores sees one consistent data set.
function fakeRedis() {
  const data = {} // key -> { kind: 'string'|'hash', value, expiresAtMs: number|null }
  function expired(entry) { return entry.expiresAtMs !== null && Date.now() >= entry.expiresAtMs }
  return {
    get: async (key) => {
      const e = data[key]
      if (!e || e.kind !== 'string' || expired(e)) return null
      return e.value
    },
    set: async (key, value, opts) => {
      data[key] = { kind: 'string', value, expiresAtMs: opts?.ex ? Date.now() + opts.ex * 1000 : null }
      return 'OK'
    },
    getdel: async (key) => {
      const e = data[key]
      if (!e || e.kind !== 'string' || expired(e)) { delete data[key]; return null }
      delete data[key]
      return e.value
    },
    del: async (key) => {
      const existed = key in data && !expired(data[key])
      delete data[key]
      return existed ? 1 : 0
    },
    hget: async (key, field) => {
      const e = data[key]
      if (!e || e.kind !== 'hash') return null
      return e.value[field] ?? null
    },
    hset: async (key, fields) => {
      data[key] ??= { kind: 'hash', value: {}, expiresAtMs: null }
      Object.assign(data[key].value, fields)
    },
    hgetall: async (key) => ({ ...(data[key]?.value ?? {}) }),
    hdel: async (key, field) => {
      const e = data[key]
      if (!e || !(field in e.value)) return 0
      delete e.value[field]
      return 1
    },
    // Test-only helper: force a stored token's expiresAtMs into the past.
    _expireNow: (key) => { if (data[key]) data[key].expiresAtMs = Date.now() - 1000 },
    _raw: data,
  }
}

function installFakeRedis() {
  const client = fakeRedis()
  setUserStoreClient(() => client)
  setTokenStoreClient(() => client)
  return client
}

function installWorkingEmailTransport() {
  _setTransportForTests(() => ({ sendMail: async () => ({ messageId: 'test-message-id', response: '250 OK' }) }))
}

async function bcryptHash() {
  return bcrypt.hash('correct-horse-battery-staple', 12)
}

async function ownerToken() {
  return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', sessionVersion: 1 })
}
async function adminToken() {
  return signSession({ userId: 'usr_admin', email: 'admin@example.com', role: 'admin', locationIds: '*', sessionVersion: 1 })
}
async function marketingToken() {
  return signSession({ userId: 'usr_marketing', email: 'marketing@example.com', role: 'marketing', locationIds: '*', sessionVersion: 1 })
}

async function seedStaticDirectory() {
  const hash = await bcryptHash()
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' },
      { userId: 'usr_admin', email: 'admin@example.com', passwordHash: hash, role: 'admin', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Admin' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Marketing' },
    ],
  })
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  res.getHeader = (name) => res.headers[name]
  return res
}

function reqFor({ action, method, token, body, query }) {
  const headers = token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}
  return { method, headers, body: body ?? {}, query: { action, ...(query ?? {}) } }
}

async function inviteUser({ token, body }) {
  const req = reqFor({ action: 'invite-user', method: 'POST', token, body })
  const res = fakeRes()
  await settingsHandler(req, res)
  return res
}

async function acceptInvite(body) {
  const req = reqFor({ action: 'accept-invite', method: 'POST', body })
  const res = fakeRes()
  await sessionHandler(req, res)
  return res
}

// --- invite-user ----------------------------------------------------------

async function testOwnerCanInviteLocationManager() {
  await seedStaticDirectory()
  installFakeRedis()
  installWorkingEmailTransport()
  const res = await inviteUser({
    token: await ownerToken(),
    body: { name: 'New Manager', email: 'newmgr@example.com', role: 'location_manager', locationIds: [7] },
  })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode} (${JSON.stringify(res.body)})`)
  assert(typeof res.body.inviteUrl === 'string' && res.body.inviteUrl.includes('/accept-invite?token='), 'response must include a usable invite link')
  assert(res.body.emailWarning === null, 'a working email transport must not produce an emailWarning')
  assert(!JSON.stringify(res.body).toLowerCase().includes('password'), 'the invite-user response must never mention a password')

  const record = await getUserById(res.body.userId)
  assert(record.passwordHash === null, 'a freshly invited user must have no password hash yet')
  assert(record.role === 'location_manager' && JSON.stringify(record.locationIds) === JSON.stringify([7]), 'role/locationIds must be stored exactly as requested')
}

async function testAdminCannotInviteOwner() {
  await seedStaticDirectory()
  installFakeRedis()
  const res = await inviteUser({
    token: await adminToken(),
    body: { name: 'Sneaky', email: 'sneaky@example.com', role: 'owner', locationIds: '*' },
  })
  assert(res.statusCode === 403, `expected 403 (Admin must not be able to mint a new Owner), got ${res.statusCode}`)
}

async function testOwnerCanInviteAdmin() {
  await seedStaticDirectory()
  installFakeRedis()
  installWorkingEmailTransport()
  const res = await inviteUser({
    token: await ownerToken(),
    body: { name: 'New Admin', email: 'newadmin@example.com', role: 'admin', locationIds: '*' },
  })
  assert(res.statusCode === 200, `Owner must be able to invite a new Admin, got ${res.statusCode}`)
}

async function testMarketingCannotInviteAnyone() {
  await seedStaticDirectory()
  installFakeRedis()
  const res = await inviteUser({
    token: await marketingToken(),
    body: { name: 'X', email: 'x@example.com', role: 'read_only', locationIds: [7] },
  })
  assert(res.statusCode === 403, `Marketing must not hold USERS_MANAGE, got ${res.statusCode}`)
}

async function testCannotInviteAnAlreadyExistingEmail() {
  await seedStaticDirectory()
  installFakeRedis()
  const res = await inviteUser({
    token: await ownerToken(),
    body: { name: 'Dup', email: 'owner@example.com', role: 'read_only', locationIds: [7] }, // already exists in the static directory
  })
  assert(res.statusCode === 409, `expected 409 account_exists, got ${res.statusCode}`)
}

async function testOwnerOrAdminRoleMustBeCompanyWide() {
  await seedStaticDirectory()
  installFakeRedis()
  const res = await inviteUser({
    token: await ownerToken(),
    body: { name: 'Scoped Owner', email: 'scopedowner@example.com', role: 'owner', locationIds: [7] },
  })
  assert(res.statusCode === 400, `Owner/Admin must be rejected with a scoped locationIds array, got ${res.statusCode}`)
}

// --- accept-invite ----------------------------------------------------------

async function inviteAndGetToken(overrides = {}) {
  await seedStaticDirectory()
  const client = installFakeRedis()
  installWorkingEmailTransport()
  const res = await inviteUser({
    token: await ownerToken(),
    body: { name: 'Invitee', email: 'invitee@example.com', role: 'location_manager', locationIds: [7], ...overrides },
  })
  assert(res.statusCode === 200, `setup: invite must succeed, got ${res.statusCode}`)
  const url = new URL(res.body.inviteUrl)
  const rawToken = url.searchParams.get('token')
  return { client, userId: res.body.userId, rawToken }
}

async function testAcceptInviteSucceedsAndLogsIn() {
  const { rawToken } = await inviteAndGetToken()
  const res = await acceptInvite({ token: rawToken, name: 'Real Name', password: 'a-strong-enough-password' })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode} (${JSON.stringify(res.body)})`)
  assert(res.body.account.role === 'location_manager', 'the returned account must reflect the invited role')
  const setCookieHeader = res.headers['Set-Cookie'] || res.headers['set-cookie']
  assert(typeof setCookieHeader === 'string' && setCookieHeader.includes(SESSION_COOKIE), 'accept-invite must auto-login by setting the session cookie')
  const token = setCookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))[1]
  const claims = await verifySession(token)
  assert(claims && claims.role === 'location_manager', 'the session cookie must carry the correct role')
}

async function testWeakPasswordRejectedWithoutBurningToken() {
  const { rawToken } = await inviteAndGetToken()
  const weak = await acceptInvite({ token: rawToken, name: 'X', password: 'short' })
  assert(weak.statusCode === 400, `expected 400 for a too-short password, got ${weak.statusCode}`)

  const strong = await acceptInvite({ token: rawToken, name: 'X', password: 'a-strong-enough-password' })
  assert(strong.statusCode === 200, `the SAME token must still work after a rejected weak-password attempt, got ${strong.statusCode}`)
}

async function testGarbageTokenRejected() {
  await seedStaticDirectory()
  installFakeRedis()
  const res = await acceptInvite({ token: 'not-a-real-token-at-all', password: 'a-strong-enough-password' })
  assert(res.statusCode === 400 && res.body.error === 'invalid_or_expired_token', `expected 400 invalid_or_expired_token, got ${res.statusCode}`)
}

async function testExpiredTokenRejected() {
  const { client, rawToken } = await inviteAndGetToken()
  const { hashToken } = await import('../dashboard/api/_lib/tokenStore.js')
  client._expireNow(`invite:${hashToken(rawToken)}`)
  const res = await acceptInvite({ token: rawToken, password: 'a-strong-enough-password' })
  assert(res.statusCode === 400, `an expired token must be rejected, got ${res.statusCode}`)
}

async function testRevokedTokenRejected() {
  const { userId, rawToken } = await inviteAndGetToken()
  const revokeRes = await settingsHandler(
    reqFor({ action: 'revoke-invite', method: 'POST', token: await ownerToken(), body: { userId } }),
    fakeRes(),
  )
  const res = await acceptInvite({ token: rawToken, password: 'a-strong-enough-password' })
  assert(res.statusCode === 400, `a revoked token must be rejected, got ${res.statusCode}`)
}

// --- token concurrency / partial-failure recovery --------------------------

async function testConcurrentAcceptInviteOnlyOneSucceeds() {
  const { rawToken } = await inviteAndGetToken()
  const [a, b] = await Promise.all([
    acceptInvite({ token: rawToken, password: 'a-strong-enough-password-a' }),
    acceptInvite({ token: rawToken, password: 'a-strong-enough-password-b' }),
  ])
  const successCount = [a, b].filter(r => r.statusCode === 200).length
  assert(successCount === 1, `exactly one concurrent accept-invite call must succeed, got ${successCount}`)
}

async function testPartialFailureRecoveryDoesNotDoubleCreateOrLoseTheAccount() {
  const { client, rawToken, userId } = await inviteAndGetToken()

  // Force the FIRST hset after the token is consumed (i.e. the user-record
  // update inside updateUser()) to throw once, simulating a Redis hiccup
  // AFTER the token's GETDEL already succeeded -- exactly the partial-
  // failure window tokenStore.js's pending-record safety net exists for.
  let hsetCalls = 0
  const realHset = client.hset.bind(client)
  client.hset = async (...args) => {
    hsetCalls++
    if (hsetCalls === 1) throw new Error('ECONNREFUSED simulated-mid-write-outage')
    return realHset(...args)
  }

  const first = await acceptInvite({ token: rawToken, name: 'Retry Name', password: 'a-strong-enough-password' })
  assert(first.statusCode === 503, `expected the simulated outage to surface as 503, got ${first.statusCode}`)

  // Retry with the SAME raw token -- must be found via the pending
  // safety-net record (the primary key is already gone) and complete
  // exactly once, not create a second account and not fail forever.
  const retry = await acceptInvite({ token: rawToken, name: 'Retry Name', password: 'a-strong-enough-password' })
  assert(retry.statusCode === 200, `retry with the same token must succeed once the transient failure clears, got ${retry.statusCode} (${JSON.stringify(retry.body)})`)
  assert(retry.body.account.userId === userId, 'the retry must complete the SAME account, not create a new one')

  const record = await getUserById(userId)
  assert(record.passwordSetAt !== null, 'the account must end up genuinely activated')
}

// --- resend / revoke ---------------------------------------------------------

async function testResendInviteIssuesAWorkingNewTokenAndInvalidatesTheOld() {
  const { userId, rawToken: oldToken } = await inviteAndGetToken()
  const resendRes = await settingsHandler(
    reqFor({ action: 'resend-invite', method: 'POST', token: await ownerToken(), body: { userId } }),
    fakeRes(),
  )
  assert(resendRes.statusCode === 200, `resend must succeed, got ${resendRes.statusCode}`)
  const newUrl = new URL(resendRes.body.inviteUrl)
  const newToken = newUrl.searchParams.get('token')
  assert(newToken !== oldToken, 'resend must issue a genuinely different token')

  const oldAttempt = await acceptInvite({ token: oldToken, password: 'a-strong-enough-password' })
  assert(oldAttempt.statusCode === 400, `the OLD token must no longer work after resend, got ${oldAttempt.statusCode}`)

  const newAttempt = await acceptInvite({ token: newToken, password: 'a-strong-enough-password' })
  assert(newAttempt.statusCode === 200, `the NEW token must work, got ${newAttempt.statusCode}`)
}

async function testResendInviteRejectsAlreadyActiveAccount() {
  const { userId, rawToken } = await inviteAndGetToken()
  const accept = await acceptInvite({ token: rawToken, password: 'a-strong-enough-password' })
  assert(accept.statusCode === 200, 'setup: account must activate')

  const resendRes = await settingsHandler(
    reqFor({ action: 'resend-invite', method: 'POST', token: await ownerToken(), body: { userId } }),
    fakeRes(),
  )
  assert(resendRes.statusCode === 409, `resending to an already-active account must be rejected, got ${resendRes.statusCode}`)
}

async function testRevokeInviteIsIdempotent() {
  const { userId } = await inviteAndGetToken()
  const first = await settingsHandler(
    reqFor({ action: 'revoke-invite', method: 'POST', token: await ownerToken(), body: { userId } }),
    fakeRes(),
  )
  assert(first.statusCode === 200, `first revoke must succeed, got ${first.statusCode}`)
  const second = await settingsHandler(
    reqFor({ action: 'revoke-invite', method: 'POST', token: await ownerToken(), body: { userId } }),
    fakeRes(),
  )
  assert(second.statusCode === 200, `revoking an already-revoked invite must be a harmless no-op, got ${second.statusCode}`)
}

// --- invite-status (non-consuming preview) ---------------------------------

async function testInviteStatusDoesNotConsumeTheToken() {
  const { rawToken } = await inviteAndGetToken()
  const previewReq = { method: 'GET', headers: {}, query: { action: 'invite-status', token: rawToken } }
  const previewRes = fakeRes()
  await sessionHandler(previewReq, previewRes)
  assert(previewRes.statusCode === 200 && previewRes.body.valid === true, `preview must report the token as valid, got ${JSON.stringify(previewRes.body)}`)

  // The token must still work afterward -- peeking must never burn it.
  const accept = await acceptInvite({ token: rawToken, password: 'a-strong-enough-password' })
  assert(accept.statusCode === 200, `the token must still be usable after a status preview, got ${accept.statusCode}`)
}

// --- audit-log privacy (structural) -----------------------------------------

// Scoped to exactly the functions this commit added (not a whole-file scan,
// which is too fragile against unrelated pre-existing appendAuditEntry
// calls elsewhere in these large consolidated-route files) -- extracts each
// named function's source by matching from its declaration to the next
// top-level function declaration, then checks every appendAuditEntry call
// within it never references a raw token, token hash, or password.
function extractFunctionSource(src, functionName) {
  const start = src.indexOf(`async function ${functionName}(`)
  assert(start !== -1, `could not find function ${functionName} in source`)
  const nextFnMatch = src.slice(start + 1).search(/\nasync function \w+\(|\nexport default async function/)
  return nextFnMatch === -1 ? src.slice(start) : src.slice(start, start + 1 + nextFnMatch)
}

async function testAuditEntriesNeverCarryTokenOrPassword() {
  const settingsSrc = readFileSync(path.join(REPO_ROOT, 'dashboard', 'api', 'settings', '[action].js'), 'utf-8')
  const sessionSrc = readFileSync(path.join(REPO_ROOT, 'dashboard', 'api', 'session', '[action].js'), 'utf-8')

  const functionsToCheck = [
    ['settings/[action].js', settingsSrc, 'inviteUserAction'],
    ['settings/[action].js', settingsSrc, 'resendInviteAction'],
    ['settings/[action].js', settingsSrc, 'revokeInviteAction'],
    ['session/[action].js', sessionSrc, 'acceptInvite'],
  ]

  for (const [fileName, src, fnName] of functionsToCheck) {
    const fnSrc = extractFunctionSource(src, fnName)
    const calls = fnSrc.match(/appendAuditEntry\(\{[\s\S]*?\}\)/g) ?? []
    assert(calls.length > 0, `${fileName}#${fnName} must contain at least one appendAuditEntry call to check`)
    for (const call of calls) {
      assert(!/\brawToken\b/.test(call), `${fileName}#${fnName}: an appendAuditEntry call references rawToken -- ${call}`)
      assert(!/\btokenHash\b/.test(call), `${fileName}#${fnName}: an appendAuditEntry call references tokenHash -- ${call}`)
      assert(!/\bpasswordHash\b/.test(call), `${fileName}#${fnName}: an appendAuditEntry call references passwordHash -- ${call}`)
      assert(!/[,{]\s*password\s*[,:]/.test(call), `${fileName}#${fnName}: an appendAuditEntry call references a raw password field -- ${call}`)
    }
  }
}

async function main() {
  await run('Owner can invite a Location Manager; invite link works; no password field ever appears', testOwnerCanInviteLocationManager)
  await run('Admin cannot invite a new Owner (elevation-of-privilege guard)', testAdminCannotInviteOwner)
  await run('Owner can invite a new Admin', testOwnerCanInviteAdmin)
  await run('Marketing cannot invite anyone (lacks USERS_MANAGE)', testMarketingCannotInviteAnyone)
  await run('cannot invite an email that already resolves to an existing account', testCannotInviteAnAlreadyExistingEmail)
  await run('Owner/Admin role must be company-wide ("*"), scoped locationIds rejected', testOwnerOrAdminRoleMustBeCompanyWide)

  await run('accept-invite succeeds, activates the account, and auto-logs in', testAcceptInviteSucceedsAndLogsIn)
  await run('a too-short password is rejected WITHOUT consuming the token (can retry)', testWeakPasswordRejectedWithoutBurningToken)
  await run('a garbage/unknown token is rejected', testGarbageTokenRejected)
  await run('an expired token is rejected', testExpiredTokenRejected)
  await run('a revoked token is rejected', testRevokedTokenRejected)

  await run('TOKEN RACE: two concurrent accept-invite calls with the same token -- exactly one succeeds', testConcurrentAcceptInviteOnlyOneSucceeds)
  await run('PARTIAL-FAILURE RECOVERY: a mid-write outage after token consume is retryable and never double-creates or loses the account', testPartialFailureRecoveryDoesNotDoubleCreateOrLoseTheAccount)

  await run('resend-invite issues a working new token and invalidates the old one', testResendInviteIssuesAWorkingNewTokenAndInvalidatesTheOld)
  await run('resend-invite rejects an already-active account', testResendInviteRejectsAlreadyActiveAccount)
  await run('revoke-invite is idempotent', testRevokeInviteIsIdempotent)

  await run('invite-status is a non-consuming preview (the token still works afterward)', testInviteStatusDoesNotConsumeTheToken)
  await run('audit-log entries in the invite flow never carry a raw token, token hash, or password', testAuditEntriesNeverCarryTokenOrPassword)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
