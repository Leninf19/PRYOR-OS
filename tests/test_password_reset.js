// Regression tests for the password-reset flow -- Multi-Location
// Authentication & User Access System, Commit 3. Mirrors
// test_invitations.js's fixtures/fake-Redis pattern exactly; the one new
// wrinkle is forgot-password never returns the raw token directly (by
// design, no-enumeration), so tests recover it from the captured outgoing
// email body instead -- the same way a real integration test would have to.
//
// Run directly: node tests/test_password_reset.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { verifySession, signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { requireAuth } from '../dashboard/api/_lib/auth.js'
import settingsHandler from '../dashboard/api/settings/[action].js'
import sessionHandler from '../dashboard/api/session/[action].js'
import { _setRedisClientForTests as setUserStoreClient, _resetRedisClientForTests as resetUserStoreClient, getUserById } from '../dashboard/api/_lib/userStore.js'
import { _setRedisClientForTests as setTokenStoreClient, _resetRedisClientForTests as resetTokenStoreClient, hashToken } from '../dashboard/api/_lib/tokenStore.js'
import { getAccountByEmail } from '../dashboard/api/_lib/accountStore.js'
import { _setTransportForTests, _resetTransportForTests } from '../dashboard/api/_lib/emailSender.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

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

// Same shared string+hash fake as test_user_store.js/test_invitations.js.
function fakeRedis() {
  const data = {}
  function expired(e) { return e.expiresAtMs !== null && Date.now() >= e.expiresAtMs }
  return {
    get: async (key) => { const e = data[key]; return (!e || e.kind !== 'string' || expired(e)) ? null : e.value },
    set: async (key, value, opts) => { data[key] = { kind: 'string', value, expiresAtMs: opts?.ex ? Date.now() + opts.ex * 1000 : null }; return 'OK' },
    getdel: async (key) => { const e = data[key]; delete data[key]; return (!e || e.kind !== 'string' || expired(e)) ? null : e.value },
    del: async (key) => { const existed = key in data && !expired(data[key]); delete data[key]; return existed ? 1 : 0 },
    hget: async (key, field) => { const e = data[key]; return (!e || e.kind !== 'hash') ? null : (e.value[field] ?? null) },
    hset: async (key, fields) => { data[key] ??= { kind: 'hash', value: {}, expiresAtMs: null }; Object.assign(data[key].value, fields) },
    hgetall: async (key) => ({ ...(data[key]?.value ?? {}) }),
    hdel: async (key, field) => { const e = data[key]; if (!e || !(field in e.value)) return 0; delete e.value[field]; return 1 },
    _raw: data,
  }
}

function installFakeRedis() {
  const client = fakeRedis()
  setUserStoreClient(() => client)
  setTokenStoreClient(() => client)
  return client
}

// Captures the last email "sent" so a test can recover the reset URL a real
// user would only ever see in their inbox -- forgot-password never returns
// the token in the API response (no-enumeration).
function installCapturingEmailTransport() {
  const sent = []
  _setTransportForTests(() => ({
    sendMail: async (opts) => { sent.push(opts); return { messageId: 'test-message-id', response: '250 OK' } },
  }))
  return sent
}

function installFailingEmailTransport() {
  _setTransportForTests(() => ({ sendMail: async () => { throw new Error('simulated SMTP failure') } }))
}

function extractTokenFromEmailBody(sentEmail, paramName = 'token') {
  const match = sentEmail.text.match(new RegExp(`[?&]${paramName}=([^\\s&]+)`))
  assert(match, `could not find a ${paramName} in the captured email body: ${sentEmail.text}`)
  return decodeURIComponent(match[1])
}

async function bcryptHash() { return bcrypt.hash('correct-horse-battery-staple', 12) }

async function ownerToken() {
  return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', sessionVersion: 1 })
}
async function marketingToken() {
  return signSession({ userId: 'usr_marketing', email: 'marketing@example.com', role: 'marketing', locationIds: '*', sessionVersion: 1 })
}

async function seedStaticDirectory(overrides = {}) {
  const hash = await bcryptHash()
  const base = {
    usr_owner: { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' },
    usr_marketing: { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Marketing' },
    usr_disabled: { userId: 'usr_disabled', email: 'disabled@example.com', passwordHash: hash, role: 'read_only', locationIds: [7], sessionVersion: 1, disabled: true, displayName: 'Disabled' },
    usr_legacy_owner: { userId: 'usr_legacy_owner', email: 'legacy@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 3, disabled: false, displayName: 'Legacy Owner' },
  }
  for (const [k, patch] of Object.entries(overrides)) base[k] = { ...base[k], ...patch }
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: Object.values(base) })
  return base
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

async function forgotPassword(email) {
  const res = fakeRes()
  await sessionHandler(reqFor({ action: 'forgot-password', method: 'POST', body: { email } }), res)
  return res
}

async function resetPassword(body) {
  const res = fakeRes()
  await sessionHandler(reqFor({ action: 'reset-password', method: 'POST', body }), res)
  return res
}

// --- forgot-password ---------------------------------------------------

async function testForgotPasswordExistingAccountSendsResetLink() {
  await seedStaticDirectory()
  installFakeRedis()
  const sent = installCapturingEmailTransport()
  const res = await forgotPassword('owner@example.com')
  assert(res.statusCode === 200 && res.body.success === true, `expected generic success, got ${res.statusCode}`)
  assert(sent.length === 1, 'a real account must trigger exactly one reset email')
  assert(sent[0].to === 'owner@example.com', 'the email must go to the account holder')
}

async function testForgotPasswordUnknownEmailSameGenericResponse() {
  await seedStaticDirectory()
  installFakeRedis()
  const sent = installCapturingEmailTransport()
  const res = await forgotPassword('nobody-here@example.com')
  assert(res.statusCode === 200 && res.body.success === true, 'an unknown email must get the exact same success response')
  assert(sent.length === 0, 'no email should be sent for an account that does not exist')
}

async function testForgotPasswordDisabledAccountSameResponseNoEmail() {
  await seedStaticDirectory()
  installFakeRedis()
  const sent = installCapturingEmailTransport()
  const res = await forgotPassword('disabled@example.com')
  assert(res.statusCode === 200 && res.body.success === true, 'a disabled account must get the exact same generic response')
  assert(sent.length === 0, 'a disabled account must not receive a reset link')
}

async function testForgotPasswordEmailSendFailureStillGenericResponse() {
  await seedStaticDirectory()
  installFakeRedis()
  installFailingEmailTransport()
  const res = await forgotPassword('owner@example.com')
  assert(res.statusCode === 200 && res.body.success === true, 'an SMTP failure must never change the response shape (would leak account existence)')
}

// --- reset-password ------------------------------------------------------

async function requestResetAndExtractToken(email) {
  await seedStaticDirectory()
  const client = installFakeRedis()
  const sent = installCapturingEmailTransport()
  const fpRes = await forgotPassword(email)
  assert(fpRes.statusCode === 200, 'setup: forgot-password must succeed')
  const rawToken = extractTokenFromEmailBody(sent[0])
  return { client, rawToken }
}

async function testResetPasswordSucceedsAndBumpsSessionVersion() {
  const { rawToken } = await requestResetAndExtractToken('owner@example.com')
  const res = await resetPassword({ token: rawToken, password: 'a-strong-enough-password' })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode} (${JSON.stringify(res.body)})`)
  const cookie = res.headers['Set-Cookie']
  const newToken = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))[1]
  const claims = await verifySession(newToken)
  assert(claims.sessionVersion === 2, `sessionVersion must be bumped from 1 to 2, got ${claims.sessionVersion}`)
}

async function testOldSessionInvalidAfterReset() {
  const { rawToken } = await requestResetAndExtractToken('owner@example.com')
  const oldSessionToken = await signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', sessionVersion: 1 })

  const reqBefore = { headers: { cookie: `${SESSION_COOKIE}=${oldSessionToken}` } }
  const accountBefore = await requireAuth(reqBefore, fakeRes(), null)
  assert(accountBefore !== null, 'sanity: the old session must be valid before the reset')

  const resetRes = await resetPassword({ token: rawToken, password: 'a-strong-enough-password' })
  assert(resetRes.statusCode === 200, 'setup: reset must succeed')

  const reqAfter = { headers: { cookie: `${SESSION_COOKIE}=${oldSessionToken}` } }
  const res = fakeRes()
  const accountAfter = await requireAuth(reqAfter, res, null)
  assert(accountAfter === null && res.statusCode === 401, `the pre-reset session must be rejected afterward (session_expired), got ${res.statusCode}`)
}

async function testWeakPasswordRejectedWithoutBurningToken() {
  const { rawToken } = await requestResetAndExtractToken('owner@example.com')
  const weak = await resetPassword({ token: rawToken, password: 'short' })
  assert(weak.statusCode === 400, `expected 400, got ${weak.statusCode}`)
  const strong = await resetPassword({ token: rawToken, password: 'a-strong-enough-password' })
  assert(strong.statusCode === 200, `the token must still work after a rejected weak-password attempt, got ${strong.statusCode}`)
}

async function testGarbageTokenRejected() {
  await seedStaticDirectory()
  installFakeRedis()
  const res = await resetPassword({ token: 'not-a-real-token', password: 'a-strong-enough-password' })
  assert(res.statusCode === 400 && res.body.error === 'invalid_or_expired_token', `expected 400, got ${res.statusCode}`)
}

async function testTokenAlreadyConsumedCannotBeReused() {
  const { rawToken } = await requestResetAndExtractToken('owner@example.com')
  const first = await resetPassword({ token: rawToken, password: 'a-strong-enough-password' })
  assert(first.statusCode === 200, 'setup: first reset must succeed')
  const second = await resetPassword({ token: rawToken, password: 'a-different-strong-password' })
  assert(second.statusCode === 400, `a fully-completed token must not be reusable, got ${second.statusCode}`)
}

// --- token race / partial-failure recovery --------------------------------

async function testConcurrentResetPasswordOnlyOneSucceeds() {
  const { rawToken } = await requestResetAndExtractToken('owner@example.com')
  const [a, b] = await Promise.all([
    resetPassword({ token: rawToken, password: 'password-attempt-a-long-enough' }),
    resetPassword({ token: rawToken, password: 'password-attempt-b-long-enough' }),
  ])
  const successCount = [a, b].filter(r => r.statusCode === 200).length
  assert(successCount === 1, `exactly one concurrent reset-password call must succeed, got ${successCount}`)
}

async function testPartialFailureRecoveryDoesNotLoseTheAccount() {
  const { client, rawToken } = await requestResetAndExtractToken('owner@example.com')

  let hsetCalls = 0
  const realHset = client.hset.bind(client)
  client.hset = async (...args) => {
    hsetCalls++
    if (hsetCalls === 1) throw new Error('ECONNREFUSED simulated-mid-write-outage')
    return realHset(...args)
  }

  const first = await resetPassword({ token: rawToken, password: 'a-strong-enough-password' })
  assert(first.statusCode === 503, `expected the simulated outage to surface as 503, got ${first.statusCode}`)

  const retry = await resetPassword({ token: rawToken, password: 'a-strong-enough-password' })
  assert(retry.statusCode === 200, `retry with the same token must succeed once the transient failure clears, got ${retry.statusCode}`)
}

// --- static-account promotion --------------------------------------------

async function testResetPromotesAStaticOnlyAccountIntoRedis() {
  const { rawToken } = await requestResetAndExtractToken('legacy@example.com')
  const res = await resetPassword({ token: rawToken, password: 'a-strong-enough-password' })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode} (${JSON.stringify(res.body)})`)
  assert(res.body.account.role === 'owner', 'the promoted account must retain its original role')

  const resolved = await getAccountByEmail('legacy@example.com')
  assert(resolved.passwordSetAt !== undefined && resolved.passwordSetAt !== null, 'the promoted account must now be a full Redis record (has passwordSetAt)')
  assert(resolved.sessionVersion === 4, `sessionVersion must be bumped from the static directory's 3 to 4, got ${resolved.sessionVersion}`)
}

// --- generate-reset-link (Owner/Admin fallback) ---------------------------

async function testGenerateResetLinkForActiveAccount() {
  await seedStaticDirectory()
  installFakeRedis()
  installCapturingEmailTransport()
  const res = await settingsHandler(
    reqFor({ action: 'generate-reset-link', method: 'POST', token: await ownerToken(), body: { userId: 'usr_owner' } }),
    fakeRes(),
  )
  // usr_owner is a STATIC-only account with no Redis record and no
  // passwordSetAt (getUserById only looks in Redis) -- generate-reset-link
  // is scoped to already-Redis-activated accounts, so this correctly 404s
  // rather than silently doing nothing useful. Verified explicitly here so
  // the boundary is documented, not just implied.
  assert(res.statusCode === 404, `a static-only (not-yet-promoted) account is not reachable via getUserById, expected 404, got ${res.statusCode}`)
}

async function testGenerateResetLinkRejectsNotYetActivatedInvite() {
  await seedStaticDirectory()
  installFakeRedis()
  installCapturingEmailTransport()
  const inviteRes = await settingsHandler(
    reqFor({ action: 'invite-user', method: 'POST', token: await ownerToken(), body: { name: 'X', email: 'x@example.com', role: 'read_only', locationIds: [7] } }),
    fakeRes(),
  )
  assert(inviteRes.statusCode === 200, 'setup: invite must succeed')
  const res = await settingsHandler(
    reqFor({ action: 'generate-reset-link', method: 'POST', token: await ownerToken(), body: { userId: inviteRes.body.userId } }),
    fakeRes(),
  )
  assert(res.statusCode === 409, `an un-activated invite must be rejected (use resend-invite instead), got ${res.statusCode}`)
}

async function testGenerateResetLinkForbiddenWithoutUsersManage() {
  await seedStaticDirectory()
  installFakeRedis()
  const res = await settingsHandler(
    reqFor({ action: 'generate-reset-link', method: 'POST', token: await marketingToken(), body: { userId: 'usr_owner' } }),
    fakeRes(),
  )
  assert(res.statusCode === 403, `Marketing must not hold USERS_MANAGE, got ${res.statusCode}`)
}

// --- audit-log privacy (structural, scoped to this commit's functions) ----

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
    ['settings/[action].js', settingsSrc, 'generateResetLinkAction'],
    ['session/[action].js', sessionSrc, 'forgotPassword'],
    ['session/[action].js', sessionSrc, 'resetPassword'],
  ]
  for (const [fileName, src, fnName] of functionsToCheck) {
    const fnSrc = extractFunctionSource(src, fnName)
    // Multi-Tenant Phase 2 prefixed every real call with a leading
    // `resolveTenantId(account), ` argument before the object literal --
    // [^,]* tolerates that (or any other single tenantId expression with no
    // comma of its own) ahead of the required comma + object literal.
    const calls = fnSrc.match(/appendAuditEntry\([^,]*,\s*\{[\s\S]*?\}\)/g) ?? []
    assert(calls.length > 0, `${fileName}#${fnName} must contain at least one appendAuditEntry call to check`)
    for (const call of calls) {
      assert(!/\brawToken\b/.test(call), `${fileName}#${fnName}: references rawToken -- ${call}`)
      assert(!/\btokenHash\b/.test(call), `${fileName}#${fnName}: references tokenHash -- ${call}`)
      assert(!/\bpasswordHash\b/.test(call), `${fileName}#${fnName}: references passwordHash -- ${call}`)
      assert(!/[,{]\s*password\s*[,:]/.test(call), `${fileName}#${fnName}: references a raw password field -- ${call}`)
    }
  }
}

async function main() {
  await run('forgot-password: existing account sends a reset link (generic response)', testForgotPasswordExistingAccountSendsResetLink)
  await run('forgot-password: unknown email gets the exact same generic response, no email sent', testForgotPasswordUnknownEmailSameGenericResponse)
  await run('forgot-password: disabled account gets the same response, no email sent', testForgotPasswordDisabledAccountSameResponseNoEmail)
  await run('forgot-password: an SMTP failure never changes the response shape', testForgotPasswordEmailSendFailureStillGenericResponse)

  await run('reset-password succeeds and bumps sessionVersion', testResetPasswordSucceedsAndBumpsSessionVersion)
  await run('a session issued before the reset is invalid immediately afterward', testOldSessionInvalidAfterReset)
  await run('a too-short password is rejected WITHOUT consuming the token', testWeakPasswordRejectedWithoutBurningToken)
  await run('a garbage/unknown token is rejected', testGarbageTokenRejected)
  await run('a token cannot be reused after a completed reset', testTokenAlreadyConsumedCannotBeReused)

  await run('TOKEN RACE: two concurrent reset-password calls with the same token -- exactly one succeeds', testConcurrentResetPasswordOnlyOneSucceeds)
  await run('PARTIAL-FAILURE RECOVERY: a mid-write outage after token consume is retryable', testPartialFailureRecoveryDoesNotLoseTheAccount)

  await run('reset-password transparently promotes a static-directory-only account into Redis', testResetPromotesAStaticOnlyAccountIntoRedis)

  await run('generate-reset-link: a static-only (not yet promoted) account is not reachable (404)', testGenerateResetLinkForActiveAccount)
  await run('generate-reset-link: rejects a not-yet-activated invite (409)', testGenerateResetLinkRejectsNotYetActivatedInvite)
  await run('generate-reset-link: forbidden without USERS_MANAGE', testGenerateResetLinkForbiddenWithoutUsersManage)

  await run('audit-log entries in the reset flow never carry a raw token, token hash, or password', testAuditEntriesNeverCarryTokenOrPassword)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
