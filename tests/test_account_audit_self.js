// Regression tests for GET /api/session/account-audit-self (dashboard/api/
// session/[action].js) -- the temporary, self-only account-record audit
// added for the tenant-mismatch investigation. No real Upstash account, no
// real filesystem access, no production data.
//
// Run directly: node tests/test_account_audit_self.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/session/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'

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
    resetUserRedis()
    delete process.env.ACCOUNT_DIRECTORY_JSON
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value; return res }
  return res
}

function fakeUserRedis() {
  const store = { 'users:v1': {}, 'users_email_index:v1': {} }
  return {
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hget: async (key, field) => store[key]?.[field] ?? null,
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
    _store: store,
  }
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

async function invoke(tokenOrPromise, extraQuery = {}) {
  const token = await tokenOrPromise
  const req = {
    method: 'GET',
    query: { action: 'account-audit-self', ...extraQuery },
    headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
    socket: {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function testUnauthenticatedRejected() {
  const res = await invoke(null)
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testCleanSingleRedisAccount() {
  const client = fakeUserRedis()
  setUserRedis(() => client)
  const hash = await passwordHash()
  const record = {
    userId: 'usr_clean', email: 'clean@example.com', passwordHash: hash, role: 'owner',
    locationIds: '*', sessionVersion: 3, disabled: false, tenantId: DEFAULT_TENANT_ID,
  }
  await client.hset('users:v1', { usr_clean: JSON.stringify(record) })
  const token = await signSession({ userId: 'usr_clean', email: 'clean@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 3 })

  const res = await invoke(token)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
  assert(res.body.email === 'clean@example.com', 'email must match the session account')
  assert(res.body.accountId === 'usr_clean', 'accountId must be the session userId')
  assert(res.body.redisAccountExists === true, 'redisAccountExists must be true')
  assert(res.body.staticAccountExists === false, 'staticAccountExists must be false -- no static entry for this email')
  assert(res.body.duplicateAccountCount === 1, `expected duplicateAccountCount 1, got ${res.body.duplicateAccountCount}`)
  assert(res.body.separateMembershipExists === false, 'a real, correctly-written account must never show a membership mismatch')
  assert(res.body.repairAssessment.tenantMismatchConfirmed === false, 'a real LTA tenant account must not be flagged as a mismatch')
  assert(res.body.repairAssessment.canonicalTenantId === DEFAULT_TENANT_ID, 'canonicalTenantId must be the real default tenant')
}

async function testTenantMismatchFlaggedForNonCanonicalTenant() {
  const client = fakeUserRedis()
  setUserRedis(() => client)
  const hash = await passwordHash()
  const pilotTenantId = 't_synthetic-pilot'
  const record = {
    userId: 'usr_pilot', email: 'pilot@example.com', passwordHash: hash, role: 'owner',
    locationIds: '*', sessionVersion: 1, disabled: false, tenantId: pilotTenantId,
  }
  await client.hset('users:v1', { usr_pilot: JSON.stringify(record) })
  const token = await signSession({ userId: 'usr_pilot', email: 'pilot@example.com', role: 'owner', locationIds: '*', tenantId: pilotTenantId, sessionVersion: 1 })

  const res = await invoke(token)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.tenantId === pilotTenantId, 'tenantId must reflect the actual (non-canonical) session tenant, never silently corrected')
  assert(res.body.repairAssessment.tenantMismatchConfirmed === true, 'a non-canonical tenant must be flagged as a mismatch')
  assert(res.body.repairAssessment.tenantIdOnlyRepairLikely === true, 'a clean single record with no duplicates/membership issues should suggest a tenantId-only repair')
}

async function testStaticOnlyAccountReportsCorrectSourceAndCounts() {
  const hash = await passwordHash()
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{ userId: 'usr_static_owner', email: 'staticowner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false }],
  })
  // No Redis client wired at all -- getUserById/getUserByEmail/lookupTenantIdForUserId
  // must all degrade to "not found" (UserStoreUnavailableError caught internally),
  // never throw, and the static directory must be the only source found.
  const token = await signSession({ userId: 'usr_static_owner', email: 'staticowner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })

  const res = await invoke(token)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
  assert(res.body.authoritativeSource === 'static', `expected authoritativeSource 'static', got ${res.body.authoritativeSource}`)
  assert(res.body.runtimeLookupWinner === 'static-account-directory', `expected static-account-directory, got ${res.body.runtimeLookupWinner}`)
  assert(res.body.redisAccountExists === false, 'no Redis store is configured -- redisAccountExists must be false')
  assert(res.body.staticAccountExists === true, 'staticAccountExists must be true')
  assert(res.body.duplicateAccountCount === 1, `expected duplicateAccountCount 1, got ${res.body.duplicateAccountCount}`)
}

async function testStaticAndRedisCollisionDetectedAsDuplicate() {
  const client = fakeUserRedis()
  setUserRedis(() => client)
  const hash = await passwordHash()
  // Same email, deliberately DIFFERENT userId in Redis vs. static -- the
  // exact shape a migration artifact/duplicate signup would produce.
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{ userId: 'usr_static_side', email: 'shared@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false }],
  })
  const redisRecord = {
    userId: 'usr_redis_side', email: 'shared@example.com', passwordHash: hash, role: 'owner',
    locationIds: '*', sessionVersion: 1, disabled: false, tenantId: DEFAULT_TENANT_ID,
  }
  await client.hset('users:v1', { usr_redis_side: JSON.stringify(redisRecord) })
  await client.hset('users_email_index:v1', { 'shared@example.com': 'usr_redis_side' })
  // The session itself resolves via Redis (dual-read precedence: Redis wins).
  const token = await signSession({ userId: 'usr_redis_side', email: 'shared@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })

  const res = await invoke(token)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
  assert(res.body.redisAccountExists === true, 'redisAccountExists must be true')
  assert(res.body.staticAccountExists === true, 'staticAccountExists must be true -- both sources genuinely have this email')
  assert(res.body.duplicateAccountCount === 2, `expected duplicateAccountCount 2 (two distinct userIds for the same email), got ${res.body.duplicateAccountCount}`)
  assert(res.body.repairAssessment.tenantIdOnlyRepairLikely === false, 'a genuine duplicate must never be assessed as a simple tenantId-only repair')
}

async function testExtraQueryParametersHaveNoEffect() {
  const client = fakeUserRedis()
  setUserRedis(() => client)
  const hash = await passwordHash()
  const record = {
    userId: 'usr_self_only', email: 'selfonly@example.com', passwordHash: hash, role: 'owner',
    locationIds: '*', sessionVersion: 1, disabled: false, tenantId: DEFAULT_TENANT_ID,
  }
  await client.hset('users:v1', { usr_self_only: JSON.stringify(record) })
  // A second, unrelated account -- if a cross-user selector existed, this is
  // what an attempt to read it would target.
  const otherRecord = {
    userId: 'usr_other', email: 'other@example.com', passwordHash: hash, role: 'owner',
    locationIds: '*', sessionVersion: 1, disabled: false, tenantId: DEFAULT_TENANT_ID,
  }
  await client.hset('users:v1', { usr_other: JSON.stringify(otherRecord) })
  const token = await signSession({ userId: 'usr_self_only', email: 'selfonly@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })

  const res = await invoke(token, { email: 'other@example.com', accountId: 'usr_other', userId: 'usr_other' })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.email === 'selfonly@example.com', 'an email query param must never redirect the audit to a different account')
  assert(res.body.accountId === 'usr_self_only', 'an accountId/userId query param must never redirect the audit to a different account')
}

async function testResponseContainsNoSecretFields() {
  const client = fakeUserRedis()
  setUserRedis(() => client)
  const hash = await passwordHash()
  const record = {
    userId: 'usr_safe', email: 'safe@example.com', passwordHash: hash, role: 'owner',
    locationIds: '*', sessionVersion: 1, disabled: false, tenantId: DEFAULT_TENANT_ID,
    inviteTokenHash: 'deadbeef', inviteExpiresAt: '2026-01-01T00:00:00Z',
  }
  await client.hset('users:v1', { usr_safe: JSON.stringify(record) })
  const token = await signSession({ userId: 'usr_safe', email: 'safe@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })

  const res = await invoke(token)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  const serialized = JSON.stringify(res.body).toLowerCase()
  for (const forbidden of ['passwordhash', hash.toLowerCase(), 'inviteTokenHash'.toLowerCase(), 'cookie', 'upstash', 'refresh_token', 'access_token']) {
    assert(!serialized.includes(forbidden), `response must never contain ${forbidden}: ${serialized}`)
  }
  const allowedKeys = new Set([
    'email', 'accountId', 'tenantId', 'role', 'locationIds', 'disabled', 'sessionVersion',
    'authoritativeSource', 'redisAccountExists', 'staticAccountExists', 'duplicateAccountCount',
    'separateMembershipExists', 'membershipTenantId', 'staleInviteExists', 'runtimeLookupWinner',
    'repairAssessment',
  ])
  for (const key of Object.keys(res.body)) {
    assert(allowedKeys.has(key), `response contains an unexpected top-level field: ${key}`)
  }
}

async function main() {
  await run('unauthenticated request is rejected', testUnauthenticatedRejected)
  await run('a clean single Redis account reports correct source/counts', testCleanSingleRedisAccount)
  await run('a non-canonical tenantId is flagged as a mismatch with a likely tenantId-only repair', testTenantMismatchFlaggedForNonCanonicalTenant)
  await run('a static-only account reports the correct source with no Redis store configured', testStaticOnlyAccountReportsCorrectSourceAndCounts)
  await run('a static+Redis same-email different-userId collision is detected as a genuine duplicate', testStaticAndRedisCollisionDetectedAsDuplicate)
  await run('extra query parameters (email/accountId/userId) never redirect the audit to another account', testExtraQueryParametersHaveNoEffect)
  await run('the response never contains a secret-shaped field', testResponseContainsNoSecretFields)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
