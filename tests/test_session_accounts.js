// Regression tests for the `accounts` action of
// dashboard/api/session/[action].js -- the reusable identity-directory
// endpoint (GET /api/session/accounts). No real network, no real Upstash.
//
// Run directly: node tests/test_session_accounts.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/session/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
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
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Zed Owner' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Ann Marketing' },
      { userId: 'usr_readonly', email: 'readonly@example.com', passwordHash: hash, role: 'read_only', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'RO Person' },
      { userId: 'usr_disabled', email: 'disabled@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: true, displayName: 'Disabled Person' },
    ],
  })
}

async function tokenFor(userId, email, role) {
  return signSession({ userId, email, role, locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
}

async function invoke(token, method = 'GET') {
  const req = { method, query: { action: 'accounts' }, body: {}, headers: token ? { cookie: `lta_session=${token}` } : {} }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function testUnauthenticatedReturns401() {
  await setDirectory()
  const res = await invoke(null)
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testAnyAuthenticatedRoleCanList() {
  await setDirectory()
  for (const [userId, email, role] of [
    ['usr_owner', 'owner@example.com', 'owner'],
    ['usr_marketing', 'marketing@example.com', 'marketing'],
    ['usr_readonly', 'readonly@example.com', 'read_only'],
  ]) {
    const res = await invoke(await tokenFor(userId, email, role))
    assert(res.statusCode === 200, `${role}: expected 200, got ${res.statusCode}`)
  }
}

async function testExcludesDisabledAccounts() {
  await setDirectory()
  const res = await invoke(await tokenFor('usr_owner', 'owner@example.com', 'owner'))
  const emails = res.body.accounts.map(a => a.email)
  assert(!emails.includes('disabled@example.com'), 'a disabled account must not appear in the assignable list')
  assert(res.body.accounts.length === 3, `expected 3 active accounts, got ${res.body.accounts.length}`)
}

async function testNeverLeaksPasswordHash() {
  await setDirectory()
  const res = await invoke(await tokenFor('usr_owner', 'owner@example.com', 'owner'))
  const asString = JSON.stringify(res.body)
  assert(!asString.toLowerCase().includes('passwordhash') && !asString.includes('$2b$'),
    `response must never include passwordHash: ${asString}`)
}

async function testReturnsExpectedSafeShape() {
  await setDirectory()
  const res = await invoke(await tokenFor('usr_owner', 'owner@example.com', 'owner'))
  const entry = res.body.accounts.find(a => a.email === 'marketing@example.com')
  assert(entry, 'marketing account is present')
  assert(entry.userId === 'usr_marketing', 'userId is present')
  assert(entry.role === 'marketing', 'role is present')
  assert(entry.displayName === 'Ann Marketing', 'displayName is present')
  assert(entry.locationIds === '*', 'locationIds is present')
}

async function testSortedByDisplayName() {
  await setDirectory()
  const res = await invoke(await tokenFor('usr_owner', 'owner@example.com', 'owner'))
  const names = res.body.accounts.map(a => a.displayName)
  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  assert(JSON.stringify(names) === JSON.stringify(sorted), `expected sorted by displayName, got ${JSON.stringify(names)}`)
}

async function testWrongMethodReturns405() {
  await setDirectory()
  const res = await invoke(await tokenFor('usr_owner', 'owner@example.com', 'owner'), 'POST')
  assert(res.statusCode === 405, `expected 405, got ${res.statusCode}`)
}

async function main() {
  await run('unauthenticated -> 401', testUnauthenticatedReturns401)
  await run('any authenticated role can list (owner, marketing, read_only)', testAnyAuthenticatedRoleCanList)
  await run('disabled accounts are excluded', testExcludesDisabledAccounts)
  await run('never leaks passwordHash', testNeverLeaksPasswordHash)
  await run('returns the expected safe account shape', testReturnsExpectedSafeShape)
  await run('accounts are sorted by displayName', testSortedByDisplayName)
  await run('wrong method -> 405', testWrongMethodReturns405)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
