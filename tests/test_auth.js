// Regression tests for the Phase 1 auth foundation: dashboard/api/_lib/
// session.js, accounts.js, and auth.js. No real network calls, no real
// account directory -- everything runs against env vars set inline below.
//
// Run directly: node tests/test_auth.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import { signSession, verifySession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { loadAccountDirectory, findAccountById, findAccountByEmail } from '../dashboard/api/_lib/accounts.js'
import { requireAuth } from '../dashboard/api/_lib/auth.js'

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

async function buildDirectory() {
  const hash = await bcrypt.hash('correct-horse-battery-staple', 12)
  return {
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 3, disabled: false, displayName: 'Marketing' },
      { userId: 'usr_disabled', email: 'disabled@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: true, displayName: 'Disabled' },
    ],
  }
}

function fakeReqRes(cookieValue) {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  const req = { headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : {} }
  return { req, res }
}

async function testSignAndVerifyRoundTrip() {
  const token = await signSession({ userId: 'usr_1', email: 'a@b.com', role: 'owner', locationIds: '*', sessionVersion: 1 })
  const claims = await verifySession(token)
  assert(claims.userId === 'usr_1', 'userId round-trips')
  assert(claims.role === 'owner', 'role round-trips')
  assert(claims.sessionVersion === 1, 'sessionVersion round-trips')
}

async function testExpiredTokenRejected() {
  const token = await signSession({ userId: 'usr_1', email: 'a@b.com', role: 'owner', locationIds: '*', sessionVersion: 1 }, { expiresInSeconds: -10 })
  const claims = await verifySession(token)
  assert(claims === null, 'expired token must be rejected')
}

async function testTamperedSignatureRejected() {
  const token = await signSession({ userId: 'usr_1', email: 'a@b.com', role: 'owner', locationIds: '*', sessionVersion: 1 })
  const tampered = token.slice(0, -4) + 'abcd'
  const claims = await verifySession(tampered)
  assert(claims === null, 'tampered signature must be rejected')
}

async function testMalformedTokenRejected() {
  assert(await verifySession('not-a-jwt') === null, 'malformed token rejected')
  assert(await verifySession('') === null, 'empty token rejected')
  assert(await verifySession(undefined) === null, 'undefined token rejected')
}

async function testAccountDirectoryValidAndInvalid() {
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify(await buildDirectory())
  const accounts = loadAccountDirectory()
  assert(accounts && accounts.length === 3, 'valid directory parses')
  assert(findAccountByEmail(accounts, 'OWNER@EXAMPLE.COM')?.userId === 'usr_owner', 'email lookup is case-insensitive')

  process.env.ACCOUNT_DIRECTORY_JSON = '{not valid json'
  assert(loadAccountDirectory() === null, 'malformed JSON fails closed (null), not throws')

  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: [{ userId: 'x' }] })
  assert(loadAccountDirectory() === null, 'incomplete account record fails closed')

  delete process.env.ACCOUNT_DIRECTORY_JSON
  assert(loadAccountDirectory() === null, 'missing env var fails closed')
}

async function validBaseAccount() {
  return {
    userId: 'usr_test', email: 'test@example.com',
    passwordHash: await bcrypt.hash('x', 12),
    role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false,
  }
}

async function testDuplicateEmailCaseInsensitiveRejected() {
  const a = await validBaseAccount()
  const b = { ...await validBaseAccount(), userId: 'usr_test2', email: 'TEST@EXAMPLE.com' }
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: [a, b] })
  assert(loadAccountDirectory() === null, 'case-insensitively-duplicate emails must be rejected')
}

async function testDuplicateUserIdRejected() {
  const a = await validBaseAccount()
  const b = { ...await validBaseAccount(), email: 'different@example.com' } // same userId as a
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: [a, b] })
  assert(loadAccountDirectory() === null, 'duplicate userId must be rejected')
}

async function testInvalidRoleRejected() {
  const a = { ...await validBaseAccount(), role: 'superadmin' }
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: [a] })
  assert(loadAccountDirectory() === null, 'an unrecognized role must be rejected')
}

async function testInvalidLocationIdTypesRejected() {
  const cases = [
    { ...await validBaseAccount(), locationIds: ['not-a-number'] },
    { ...await validBaseAccount(), locationIds: [1.5] },
    { ...await validBaseAccount(), locationIds: [-3] },
    { ...await validBaseAccount(), locationIds: [0] },
    { ...await validBaseAccount(), locationIds: [3, 3] }, // duplicate entry
    { ...await validBaseAccount(), locationIds: [] }, // empty array
    { ...await validBaseAccount(), locationIds: 'all' }, // string other than '*'
  ]
  for (const account of cases) {
    process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: [account] })
    assert(loadAccountDirectory() === null, `locationIds ${JSON.stringify(account.locationIds)} must be rejected`)
  }
  // A valid array of positive integers must still work.
  const valid = { ...await validBaseAccount(), locationIds: [3, 7, 12] }
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: [valid] })
  assert(loadAccountDirectory() !== null, 'a valid array of distinct positive integer locationIds must be accepted')
}

async function testEmptyOrMalformedPasswordHashRejected() {
  const cases = [
    { ...await validBaseAccount(), passwordHash: '' },
    { ...await validBaseAccount(), passwordHash: 'plaintext-password-by-mistake' },
    { ...await validBaseAccount(), passwordHash: 'md5:5f4dcc3b5aa765d61d8327deb882cf99' },
    { ...await validBaseAccount(), passwordHash: null },
  ]
  for (const account of cases) {
    process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: [account] })
    assert(loadAccountDirectory() === null, `passwordHash ${JSON.stringify(account.passwordHash)} must be rejected as not a real bcrypt hash`)
  }
}

async function testInvalidSessionVersionRejected() {
  const cases = [0, -1, 1.5, '1', null]
  for (const sessionVersion of cases) {
    const account = { ...await validBaseAccount(), sessionVersion }
    process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: [account] })
    assert(loadAccountDirectory() === null, `sessionVersion ${JSON.stringify(sessionVersion)} must be rejected`)
  }
}

async function testUnknownAccountFieldRejected() {
  const account = { ...await validBaseAccount(), password: 'oops-plaintext-left-in-by-mistake' }
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: [account] })
  assert(loadAccountDirectory() === null, 'an unrecognized extra field on an account (e.g. a stray plaintext password) must fail the whole directory closed')
}

async function testUnknownTopLevelKeyRejected() {
  const account = await validBaseAccount()
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: [account], notes: 'unexpected' })
  assert(loadAccountDirectory() === null, 'an unrecognized top-level key must be rejected')
}

async function testMissingRequiredFieldsRejected() {
  const full = await validBaseAccount()
  for (const field of ['userId', 'email', 'passwordHash', 'role', 'locationIds', 'sessionVersion', 'disabled']) {
    const partial = { ...full }
    delete partial[field]
    process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: [partial] })
    assert(loadAccountDirectory() === null, `missing required field "${field}" must be rejected`)
  }
}

async function testRequireAuthUnauthenticated() {
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify(await buildDirectory())
  const { req, res } = fakeReqRes(null)
  const account = await requireAuth(req, res, ['owner'])
  assert(account === null, 'no cookie -> null account')
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
  assert(res.body.error === 'unauthenticated', res.body.error)
}

async function testRequireAuthOwnerSucceeds() {
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify(await buildDirectory())
  const token = await signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', sessionVersion: 1 })
  const { req, res } = fakeReqRes(token)
  const account = await requireAuth(req, res, ['owner'])
  assert(account !== null, 'owner session must be accepted')
  assert(account.role === 'owner', 'returned account has current role')
  assert(account.passwordHash === undefined, 'passwordHash must never be in the returned account')
}

async function testRequireAuthWrongRoleForbidden() {
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify(await buildDirectory())
  const token = await signSession({ userId: 'usr_marketing', email: 'marketing@example.com', role: 'marketing', locationIds: '*', sessionVersion: 3 })
  const { req, res } = fakeReqRes(token)
  const account = await requireAuth(req, res, ['owner'])
  assert(account === null, 'marketing must be rejected from an owner-only route')
  assert(res.statusCode === 403, `expected 403, got ${res.statusCode}`)
}

async function testStaleSessionVersionRejected() {
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify(await buildDirectory())
  // Token signed with an old sessionVersion (account's current is 3) --
  // simulates a password/role change happening after the token was issued.
  const token = await signSession({ userId: 'usr_marketing', email: 'marketing@example.com', role: 'marketing', locationIds: '*', sessionVersion: 1 })
  const { req, res } = fakeReqRes(token)
  const account = await requireAuth(req, res, null)
  assert(account === null, 'stale sessionVersion must be rejected even with a validly-signed token')
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
  assert(res.body.error === 'session_expired', res.body.error)
}

async function testDisabledAccountRejected() {
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify(await buildDirectory())
  const token = await signSession({ userId: 'usr_disabled', email: 'disabled@example.com', role: 'owner', locationIds: '*', sessionVersion: 1 })
  const { req, res } = fakeReqRes(token)
  const account = await requireAuth(req, res, ['owner'])
  assert(account === null, 'disabled account must be rejected even with a valid, current-version token')
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testRemovedAccountRejected() {
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify(await buildDirectory())
  const token = await signSession({ userId: 'usr_ghost', email: 'ghost@example.com', role: 'owner', locationIds: '*', sessionVersion: 1 })
  const { req, res } = fakeReqRes(token)
  const account = await requireAuth(req, res, ['owner'])
  assert(account === null, 'a userId no longer in the directory must be rejected')
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function main() {
  await run('sign/verify round trip preserves claims', testSignAndVerifyRoundTrip)
  await run('expired token is rejected', testExpiredTokenRejected)
  await run('tampered signature is rejected', testTamperedSignatureRejected)
  await run('malformed/empty/undefined tokens are rejected', testMalformedTokenRejected)
  await run('account directory: valid parses, invalid fails closed', testAccountDirectoryValidAndInvalid)
  await run('requireAuth: no cookie -> 401 unauthenticated', testRequireAuthUnauthenticated)
  await run('requireAuth: valid owner session succeeds, never returns passwordHash', testRequireAuthOwnerSucceeds)
  await run('requireAuth: wrong role -> 403 forbidden', testRequireAuthWrongRoleForbidden)
  await run('requireAuth: stale sessionVersion -> 401 session_expired', testStaleSessionVersionRejected)
  await run('requireAuth: disabled account -> 401', testDisabledAccountRejected)
  await run('requireAuth: removed account -> 401', testRemovedAccountRejected)
  await run('duplicate emails (case-insensitive) -> whole directory rejected', testDuplicateEmailCaseInsensitiveRejected)
  await run('duplicate userIds -> whole directory rejected', testDuplicateUserIdRejected)
  await run('an unrecognized role -> rejected', testInvalidRoleRejected)
  await run('invalid locationIds shapes (non-integer, negative, zero, duplicate, empty, wrong type) -> rejected; valid array accepted', testInvalidLocationIdTypesRejected)
  await run('empty/malformed (non-bcrypt) password hashes -> rejected', testEmptyOrMalformedPasswordHashRejected)
  await run('invalid sessionVersion values (0, negative, float, string, null) -> rejected', testInvalidSessionVersionRejected)
  await run('an unrecognized extra account field (e.g. stray plaintext password) -> rejected', testUnknownAccountFieldRejected)
  await run('an unrecognized top-level directory key -> rejected', testUnknownTopLevelKeyRejected)
  await run('each individually-missing required field -> rejected', testMissingRequiredFieldsRejected)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
