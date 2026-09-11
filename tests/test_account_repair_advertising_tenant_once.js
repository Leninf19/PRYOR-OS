// Regression tests for POST /api/session/account-repair-advertising-tenant-once
// (dashboard/api/session/[action].js) -- the temporary, one-time, single-
// account repair added to close the tenant-mismatch investigation. No real
// Upstash account, no real filesystem access, no production data.
//
// Run directly: node tests/test_account_repair_advertising_tenant_once.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/session/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis, getUserById } from '../dashboard/api/_lib/userStore.js'
import { _setRedisClientForTests as setAuditRedis, _resetRedisClientForTests as resetAuditRedis } from '../dashboard/api/_lib/auditLog.js'
import { usersKeyV2 } from '../dashboard/api/_lib/tenantKeys.js'

// t_los-tres-amigos-pilot is NOT the LEGACY-mode default tenant, so
// getUserById() resolves it to the V2 per-tenant hash (users:v2:<tenantId>),
// never the flat legacy users:v1 -- matching real production exactly
// (confirmed live: runtimeLookupWinner=redis-identity-index). The global
// identity index must be seeded too, so requireAuth()'s own account
// resolution (accountStore.js's getAccountById(), used by every request)
// finds the SAME record via the SAME indexed path production uses, rather
// than accidentally falling through to the unrelated legacy bootstrap hash.
const IDENTITY_INDEX_BY_EMAIL_KEY = 'identity_index_by_email:v1'
const IDENTITY_INDEX_BY_USER_ID_KEY = 'identity_index_by_user_id:v1'

const TARGET_EMAIL = 'advertising@l3amigos.com'
const TARGET_ACCOUNT_ID = 'usr_7a7db167-e1a9-48e0-abb0-1fe62dfa1c7d'
const PILOT_TENANT_ID = 't_los-tres-amigos-pilot'

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
    resetAuditRedis()
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
  const store = {}
  return {
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hget: async (key, field) => store[key]?.[field] ?? null,
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
    _store: store,
  }
}

function fakeAuditRedis() {
  const lists = {}
  return {
    lpush: async (key, value) => { lists[key] = [value, ...(lists[key] ?? [])] },
    ltrim: async () => {},
    lrange: async (key, start, stop) => (lists[key] ?? []).slice(start, stop === -1 ? undefined : stop + 1),
  }
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

// Builds the EXACT clean, precondition-matching record this action expects,
// with any fields overridden for a specific test. Always physically stored
// at usersKeyV2(PILOT_TENANT_ID) -- that is where the handler's own fixed
// lookup (getUserById(REPAIR_EXPECTED_CURRENT_TENANT_ID, ...)) always reads
// from, regardless of what the record's own tenantId FIELD currently says
// (a test simulating "field already drifted" still needs to be found at
// its real physical location to be a meaningful precondition check). The
// global identity index is always seeded pointing at PILOT_TENANT_ID too,
// matching real production -- repairing the record's field never moves it
// or touches the index (see the repair handler's own header comment).
async function seedRecord(client, overrides = {}) {
  const hash = await passwordHash()
  const record = {
    userId: TARGET_ACCOUNT_ID, email: TARGET_EMAIL, passwordHash: hash, role: 'owner',
    locationIds: '*', sessionVersion: 5, disabled: false, tenantId: PILOT_TENANT_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
  await client.hset(usersKeyV2(PILOT_TENANT_ID), { [TARGET_ACCOUNT_ID]: JSON.stringify(record) })
  await client.hset(IDENTITY_INDEX_BY_EMAIL_KEY, { [TARGET_EMAIL]: JSON.stringify({ tenantId: PILOT_TENANT_ID, userId: TARGET_ACCOUNT_ID }) })
  await client.hset(IDENTITY_INDEX_BY_USER_ID_KEY, { [TARGET_ACCOUNT_ID]: PILOT_TENANT_ID })
  return record
}

function callerToken(overrides = {}) {
  return signSession({
    userId: TARGET_ACCOUNT_ID, email: TARGET_EMAIL, role: 'owner', locationIds: '*',
    tenantId: PILOT_TENANT_ID, sessionVersion: 5,
    ...overrides,
  })
}

async function invoke(tokenOrPromise) {
  const token = await tokenOrPromise
  const req = {
    method: 'POST',
    query: { action: 'account-repair-advertising-tenant-once' },
    headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
    socket: {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

function wireStores() {
  const userClient = fakeUserRedis()
  setUserRedis(() => userClient)
  setAuditRedis(() => fakeAuditRedis())
  return userClient
}

async function testUnauthenticatedRejected() {
  wireStores()
  const res = await invoke(null)
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testWrongEmailRejected() {
  const client = wireStores()
  await seedRecord(client)
  // A DIFFERENT account entirely (not Advertising) tries to call this.
  const otherHash = await passwordHash()
  await client.hset('users:v1', { usr_other: JSON.stringify({
    userId: 'usr_other', email: 'someone-else@example.com', passwordHash: otherHash, role: 'owner',
    locationIds: '*', sessionVersion: 1, disabled: false, tenantId: DEFAULT_TENANT_ID,
  }) })
  const token = await signSession({ userId: 'usr_other', email: 'someone-else@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })

  const res = await invoke(token)
  assert(res.statusCode === 403, `expected 403, got ${res.statusCode}`)
  const stillPilot = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(stillPilot.tenantId === PILOT_TENANT_ID, 'Advertising record must be untouched when a different account calls this')
}

async function testWrongAccountIdRejected() {
  const client = wireStores()
  await seedRecord(client)
  // Same email claimed, but a session carrying a DIFFERENT userId -- the
  // exact shape a forged/stale claim would take. requireAuth() itself
  // re-resolves the account by userId, so this session simply won't
  // resolve to a real account with that userId at all -- covered here to
  // prove the endpoint's own defense-in-depth check would also catch it if
  // it somehow did.
  const token = await signSession({ userId: 'usr_does_not_exist', email: TARGET_EMAIL, role: 'owner', locationIds: '*', tenantId: PILOT_TENANT_ID, sessionVersion: 5 })

  const res = await invoke(token)
  assert(res.statusCode === 401, `a session for a userId with no real account must fail authentication (401), got ${res.statusCode}`)
}

async function testWrongCurrentTenantRejected() {
  const client = wireStores()
  // The record's own tenantId FIELD already reads t_los-tres-amigos (as if
  // already repaired, or never actually mismatched) -- still physically
  // seeded at the pilot tenant's own storage location, which is where the
  // handler's fixed lookup always reads from regardless of the field value.
  await seedRecord(client, { tenantId: DEFAULT_TENANT_ID })
  const token = await callerToken({ tenantId: DEFAULT_TENANT_ID })

  const res = await invoke(token)
  assert(res.statusCode === 409, `expected 409, got ${res.statusCode}`)
  const record = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(record.sessionVersion === 5, 'a precondition mismatch must never write anything')
  assert(record.tenantId === DEFAULT_TENANT_ID, 'the record must be completely untouched by a rejected call')
}

async function testWrongSessionVersionRejected() {
  const client = wireStores()
  await seedRecord(client, { sessionVersion: 7 }) // drifted from the expected 5
  const token = await callerToken({ sessionVersion: 7 })

  const res = await invoke(token)
  assert(res.statusCode === 409, `expected 409, got ${res.statusCode}`)
  const record = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(record.tenantId === PILOT_TENANT_ID, 'a sessionVersion mismatch must never write anything')
  assert(record.sessionVersion === 7, 'sessionVersion must be untouched on a precondition failure')
}

async function testSuccessfulRepairChangesOnlyTenantIdAndSessionVersion() {
  const client = wireStores()
  const before = await seedRecord(client)
  const token = await callerToken()

  const res = await invoke(token)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
  assert(res.body.success === true, 'response must report success')
  assert(res.body.newTenantId === DEFAULT_TENANT_ID, 'response must report the new canonical tenantId')
  assert(res.body.newSessionVersion === 6, 'response must report the new sessionVersion')
  // The response itself must never echo back the full record.
  assert(!('passwordHash' in res.body), 'response must never include passwordHash')

  const after = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(after.tenantId === DEFAULT_TENANT_ID, `expected tenantId to change to ${DEFAULT_TENANT_ID}, got ${after.tenantId}`)
  assert(after.sessionVersion === 6, `expected sessionVersion 6, got ${after.sessionVersion}`)
  assert(after.role === before.role, 'role must be unchanged')
  assert(JSON.stringify(after.locationIds) === JSON.stringify(before.locationIds), 'locationIds must be unchanged')
  assert(after.disabled === before.disabled, 'disabled must be unchanged')
  assert(after.passwordHash === before.passwordHash, 'passwordHash must be unchanged')
  assert(after.email === before.email, 'email must be unchanged')
  assert(after.userId === before.userId, 'userId (accountId) must be unchanged')
  assert(after.createdAt === before.createdAt, 'createdAt must be unchanged')
}

async function testSecondInvocationIsRejected() {
  const client = wireStores()
  await seedRecord(client)
  const token = await callerToken()

  const first = await invoke(token)
  assert(first.statusCode === 200, `first call: expected 200, got ${first.statusCode}`)

  // Second call reuses the SAME (now-stale) session claims, exactly as a
  // real accidental double-click would -- the account's real sessionVersion
  // is now 6, but the token still claims 5, so this fails at
  // authentication before ever reaching the repair's own precondition
  // check. Either way, nothing must be written a second time.
  const second = await invoke(token)
  assert(second.statusCode === 401 || second.statusCode === 409, `second call: expected 401 (stale session) or 409 (precondition already moved on), got ${second.statusCode}`)

  const record = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(record.sessionVersion === 6, 'a second invocation must never bump sessionVersion again')
  assert(record.tenantId === DEFAULT_TENANT_ID, 'the repaired tenantId must remain exactly as the first call left it')
}

async function main() {
  await run('unauthenticated request is rejected', testUnauthenticatedRejected)
  await run('a caller who is not advertising@l3amigos.com is rejected, record untouched', testWrongEmailRejected)
  await run('a session for a non-existent accountId is rejected', testWrongAccountIdRejected)
  await run('a record already off the expected pilot tenant is rejected, nothing written', testWrongCurrentTenantRejected)
  await run('a record with an unexpected sessionVersion is rejected, nothing written', testWrongSessionVersionRejected)
  await run('a successful repair changes only tenantId and sessionVersion', testSuccessfulRepairChangesOnlyTenantIdAndSessionVersion)
  await run('a second invocation (even with the same stale session) is rejected and no-ops', testSecondInvocationIsRejected)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
