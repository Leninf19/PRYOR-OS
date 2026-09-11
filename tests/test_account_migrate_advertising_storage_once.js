// Regression tests for POST /api/session/account-migrate-advertising-storage-once
// (dashboard/api/session/[action].js) -- the temporary, one-time, single-
// account storage migration that follows account-repair-advertising-tenant-
// once. That earlier repair fixed the account's tenantId FIELD but left the
// record physically stored in the pilot tenant's own Redis hash; this
// action moves the record itself into LTA's canonical LEGACY storage
// (users:v1/users_email_index:v1), verifying via read-back before deleting
// anything. No real Upstash account, no real filesystem access, no
// production data.
//
// Run directly: node tests/test_account_migrate_advertising_storage_once.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/session/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis, getUserById } from '../dashboard/api/_lib/userStore.js'
import { _setRedisClientForTests as setAuditRedis, _resetRedisClientForTests as resetAuditRedis } from '../dashboard/api/_lib/auditLog.js'
import { usersKeyV2, usersEmailIndexKeyV2 } from '../dashboard/api/_lib/tenantKeys.js'

const IDENTITY_INDEX_BY_EMAIL_KEY = 'identity_index_by_email:v1'
const IDENTITY_INDEX_BY_USER_ID_KEY = 'identity_index_by_user_id:v1'
const USERS_V1_KEY = 'users:v1'
const EMAIL_INDEX_V1_KEY = 'users_email_index:v1'

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

// Seeds the account PHYSICALLY at usersKeyV2(PILOT_TENANT_ID) -- exactly
// where the earlier tenant-field repair left it -- with its own tenantId
// FIELD already pointing at the canonical tenant (the repair already ran),
// sessionVersion 6, and the global identity index still stale (pointing at
// the pilot tenant), matching the exact real-world state this migration
// action is designed to run against.
async function seedSource(client, overrides = {}) {
  const hash = await passwordHash()
  const record = {
    userId: TARGET_ACCOUNT_ID, email: TARGET_EMAIL, passwordHash: hash, role: 'owner',
    locationIds: '*', sessionVersion: 6, disabled: false, tenantId: DEFAULT_TENANT_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
  await client.hset(usersKeyV2(PILOT_TENANT_ID), { [TARGET_ACCOUNT_ID]: JSON.stringify(record) })
  await client.hset(usersEmailIndexKeyV2(PILOT_TENANT_ID), { [TARGET_EMAIL]: TARGET_ACCOUNT_ID })
  await client.hset(IDENTITY_INDEX_BY_EMAIL_KEY, { [TARGET_EMAIL]: JSON.stringify({ tenantId: PILOT_TENANT_ID, userId: TARGET_ACCOUNT_ID }) })
  await client.hset(IDENTITY_INDEX_BY_USER_ID_KEY, { [TARGET_ACCOUNT_ID]: PILOT_TENANT_ID })
  return record
}

// Seeds a record directly into LTA's canonical LEGACY storage (users:v1 /
// users_email_index:v1) -- used both for collision tests and for simulating
// an already-migrated (or partially-migrated) canonical record.
async function seedCanonical(client, overrides = {}) {
  const hash = await passwordHash()
  const record = {
    userId: TARGET_ACCOUNT_ID, email: TARGET_EMAIL, passwordHash: hash, role: 'owner',
    locationIds: '*', sessionVersion: 7, disabled: false, tenantId: DEFAULT_TENANT_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
  await client.hset(USERS_V1_KEY, { [record.userId]: JSON.stringify(record) })
  await client.hset(EMAIL_INDEX_V1_KEY, { [record.email]: record.userId })
  return record
}

function callerToken(overrides = {}) {
  return signSession({
    userId: TARGET_ACCOUNT_ID, email: TARGET_EMAIL, role: 'owner', locationIds: '*',
    tenantId: DEFAULT_TENANT_ID, sessionVersion: 6,
    ...overrides,
  })
}

async function invoke(tokenOrPromise) {
  const token = await tokenOrPromise
  const req = {
    method: 'POST',
    query: { action: 'account-migrate-advertising-storage-once' },
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
  await seedSource(client)
  const otherHash = await passwordHash()
  await client.hset(USERS_V1_KEY, { usr_other: JSON.stringify({
    userId: 'usr_other', email: 'someone-else@example.com', passwordHash: otherHash, role: 'owner',
    locationIds: '*', sessionVersion: 1, disabled: false, tenantId: DEFAULT_TENANT_ID,
  }) })
  const token = await signSession({ userId: 'usr_other', email: 'someone-else@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })

  const res = await invoke(token)
  assert(res.statusCode === 403, `expected 403, got ${res.statusCode}`)
  const stillAtPilotStorage = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(stillAtPilotStorage, 'Advertising record must remain at its pilot physical storage when a different account calls this')
}

async function testSourceTenantFieldMismatchRejected() {
  const client = wireStores()
  // The record's own tenantId FIELD has not yet been field-repaired to the
  // canonical tenant (i.e. the earlier repair action never ran) -- this
  // migration must refuse to move a record that isn't in the expected
  // pre-migration state.
  await seedSource(client, { tenantId: PILOT_TENANT_ID })
  const token = await callerToken({ tenantId: PILOT_TENANT_ID })

  const res = await invoke(token)
  assert(res.statusCode === 409, `expected 409, got ${res.statusCode}`)
  const record = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(record.tenantId === PILOT_TENANT_ID, 'a precondition mismatch must never write anything')
  const canonical = await getUserById(DEFAULT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(!canonical, 'no canonical record must be created on a rejected call')
}

async function testSessionVersionMismatchRejected() {
  const client = wireStores()
  await seedSource(client, { sessionVersion: 9 }) // drifted from the expected 6
  const token = await callerToken({ sessionVersion: 9 })

  const res = await invoke(token)
  assert(res.statusCode === 409, `expected 409, got ${res.statusCode}`)
  const record = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(record.sessionVersion === 9, 'a sessionVersion mismatch must never write anything')
  const canonical = await getUserById(DEFAULT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(!canonical, 'no canonical record must be created on a rejected call')
}

async function testTargetUserIdCollisionRejected() {
  const client = wireStores()
  await seedSource(client)
  // A genuinely different, non-matching record already occupies the target
  // userId in canonical storage (wrong role -- not an exact idempotent copy).
  await seedCanonical(client, { role: 'admin', sessionVersion: 3 })
  const token = await callerToken()

  const res = await invoke(token)
  assert(res.statusCode === 409, `expected 409, got ${res.statusCode}`)
  assert(res.body.error === 'target_collision', `expected target_collision, got ${res.body.error}`)
  const stillAtPilotStorage = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(stillAtPilotStorage, 'source must be untouched on a target collision')
}

async function testTargetEmailCollisionRejected() {
  const client = wireStores()
  await seedSource(client)
  // The canonical email index already points at a DIFFERENT, real userId --
  // simulates an unrelated account somehow already using this email.
  const otherHash = await passwordHash()
  await client.hset(USERS_V1_KEY, { usr_someone_else: JSON.stringify({
    userId: 'usr_someone_else', email: 'other-owner@example.com', passwordHash: otherHash, role: 'owner',
    locationIds: '*', sessionVersion: 1, disabled: false, tenantId: DEFAULT_TENANT_ID,
  }) })
  await client.hset(EMAIL_INDEX_V1_KEY, { [TARGET_EMAIL]: 'usr_someone_else' })
  const token = await callerToken()

  const res = await invoke(token)
  assert(res.statusCode === 409, `expected 409, got ${res.statusCode}`)
  assert(res.body.error === 'target_collision', `expected target_collision, got ${res.body.error}`)
  const stillAtPilotStorage = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(stillAtPilotStorage, 'source must be untouched on a target collision')
}

async function testCanonicalWriteFailureLeavesSourceIntact() {
  const client = wireStores()
  const before = await seedSource(client)
  // Force the canonical write itself to fail -- proves the source is never
  // touched (in particular, never deleted) unless the canonical write
  // actually succeeds.
  const realHset = client.hset
  client.hset = async (key, fields) => {
    if (key === USERS_V1_KEY) throw new Error('simulated redis outage during canonical write')
    return realHset(key, fields)
  }
  const token = await callerToken()

  const res = await invoke(token)
  assert(res.statusCode === 503, `expected 503, got ${res.statusCode}`)
  const record = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(record, 'source record must still exist after a failed canonical write')
  assert(record.sessionVersion === before.sessionVersion, 'source record must be byte-for-byte unmodified after a failed canonical write')
  const canonical = await getUserById(DEFAULT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(!canonical, 'no canonical record must exist after a failed canonical write')
}

async function testReadBackVerificationFailureLeavesSourceIntact() {
  const client = wireStores()
  await seedSource(client)
  // The write itself "succeeds" but the read-back comes back corrupted
  // (simulating a torn/inconsistent read) -- the handler must refuse to
  // delete the source in that case.
  const realHget = client.hget
  client.hget = async (key, field) => {
    const raw = await realHget(key, field)
    if (key === USERS_V1_KEY && field === TARGET_ACCOUNT_ID && raw) {
      const parsed = JSON.parse(raw)
      return JSON.stringify({ ...parsed, role: 'read_only' }) // corrupted on read-back
    }
    return raw
  }
  const token = await callerToken()

  const res = await invoke(token)
  assert(res.statusCode === 500, `expected 500, got ${res.statusCode}`)
  assert(res.body.error === 'verification_failed', `expected verification_failed, got ${res.body.error}`)
  const stillAtPilotStorage = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(stillAtPilotStorage, 'source must never be deleted when read-back verification fails')
}

async function testSuccessfulMigrationPreservesFieldsAndMovesStorage() {
  const client = wireStores()
  const before = await seedSource(client)
  const token = await callerToken()

  const res = await invoke(token)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
  assert(res.body.success === true, 'response must report success')
  assert(res.body.newTenantId === DEFAULT_TENANT_ID, 'response must report the canonical tenantId')
  assert(res.body.newSessionVersion === 7, 'response must report sessionVersion 7')
  assert(res.body.verified === true, 'response must report the final resolution checks passed')
  assert(!('passwordHash' in res.body), 'response must never include passwordHash')

  const canonical = await getUserById(DEFAULT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(canonical, 'canonical record must now exist in LEGACY storage')
  assert(canonical.tenantId === DEFAULT_TENANT_ID, 'canonical tenantId must be the default tenant')
  assert(canonical.sessionVersion === 7, 'canonical sessionVersion must be 7')
  assert(canonical.role === before.role, 'role must be unchanged')
  assert(JSON.stringify(canonical.locationIds) === JSON.stringify(before.locationIds), 'locationIds must be unchanged')
  assert(canonical.disabled === before.disabled, 'disabled must be unchanged')
  assert(canonical.passwordHash === before.passwordHash, 'passwordHash must be preserved exactly')
  assert(canonical.email === before.email, 'email must be unchanged')
  assert(canonical.userId === before.userId, 'userId must be unchanged')
  assert(canonical.createdAt === before.createdAt, 'createdAt must be unchanged')

  const sourceAfter = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(!sourceAfter, 'the stale pilot-tenant record must be removed after a successful migration')

  const indexedByUserId = await client.hget(IDENTITY_INDEX_BY_USER_ID_KEY, TARGET_ACCOUNT_ID)
  const indexedByEmail = await client.hget(IDENTITY_INDEX_BY_EMAIL_KEY, TARGET_EMAIL)
  assert(!indexedByUserId, 'the stale global identity-index (by userId) entry must be removed')
  assert(!indexedByEmail, 'the stale global identity-index (by email) entry must be removed')

  const { getAccountByIdForTenant } = await import('../dashboard/api/_lib/accountStore.js')
  const viaTenantScopedLookup = await getAccountByIdForTenant(DEFAULT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(viaTenantScopedLookup?.userId === TARGET_ACCOUNT_ID, 'the canonical tenant-scoped admin lookup (getAccountByIdForTenant) must now resolve the account')
}

async function testRepeatedInvocationAfterSuccessIsIdempotent() {
  const client = wireStores()
  await seedSource(client)
  const first = await invoke(await callerToken())
  assert(first.statusCode === 200, `first call: expected 200, got ${first.statusCode}`)

  // A second call, this time with a session reflecting the ALREADY-migrated
  // account (sessionVersion 7, canonical tenant) -- exactly what a real
  // browser would carry after refreshing following a successful first run.
  const secondToken = await callerToken({ sessionVersion: 7 })
  const canonicalWritesBefore = JSON.stringify(client._store[USERS_V1_KEY])

  const second = await invoke(secondToken)
  assert(second.statusCode === 200, `second call: expected idempotent 200, got ${second.statusCode}, body=${JSON.stringify(second.body)}`)
  assert(second.body.success === true, 'a repeated call after a completed migration must still report success (idempotent), not error')

  const canonicalWritesAfter = JSON.stringify(client._store[USERS_V1_KEY])
  assert(canonicalWritesBefore === canonicalWritesAfter, 'a repeated call must not re-write the canonical record')

  const sourceAfter = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(!sourceAfter, 'the source must remain deleted after a repeated call')
}

async function testPartialStateIsDetectedAndOnlyCleanupRuns() {
  const client = wireStores()
  // Simulates a completed write+verify from a PRIOR run whose cleanup step
  // never finished: canonical record fully present and correct, but the
  // stale source record and identity-index entries are still sitting there.
  await seedSource(client)
  await seedCanonical(client)
  // The identity index still points at the pilot tenant (cleanup never
  // finished), so a real session at this point still resolves via the
  // still-present pilot record -- sessionVersion 6, not 7.
  const token = await callerToken()

  const canonicalBefore = JSON.stringify(client._store[USERS_V1_KEY])
  const res = await invoke(token)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
  const canonicalAfter = JSON.stringify(client._store[USERS_V1_KEY])
  assert(canonicalBefore === canonicalAfter, 'detecting a completed canonical write must never re-write it')

  const sourceAfter = await getUserById(PILOT_TENANT_ID, TARGET_ACCOUNT_ID)
  assert(!sourceAfter, 'partial-state detection must still complete the outstanding cleanup (source removal)')
  const indexedByUserId = await client.hget(IDENTITY_INDEX_BY_USER_ID_KEY, TARGET_ACCOUNT_ID)
  assert(!indexedByUserId, 'partial-state detection must still complete the outstanding cleanup (identity index removal)')
}

async function main() {
  await run('unauthenticated request is rejected', testUnauthenticatedRejected)
  await run('a caller who is not advertising@l3amigos.com is rejected, source untouched', testWrongEmailRejected)
  await run('a source record not yet field-repaired to the canonical tenant is rejected', testSourceTenantFieldMismatchRejected)
  await run('a source record with an unexpected sessionVersion is rejected', testSessionVersionMismatchRejected)
  await run('a conflicting record at the target userId is rejected (target_collision)', testTargetUserIdCollisionRejected)
  await run('a conflicting record at the target email is rejected (target_collision)', testTargetEmailCollisionRejected)
  await run('a failed canonical write leaves the source completely intact', testCanonicalWriteFailureLeavesSourceIntact)
  await run('a failed read-back verification leaves the source completely intact (never deletes first)', testReadBackVerificationFailureLeavesSourceIntact)
  await run('a successful migration preserves every field and moves physical storage', testSuccessfulMigrationPreservesFieldsAndMovesStorage)
  await run('a repeated invocation after a completed migration is safely idempotent', testRepeatedInvocationAfterSuccessIsIdempotent)
  await run('a partial prior state (canonical written, cleanup incomplete) is detected and only cleanup runs', testPartialStateIsDetectedAndOnlyCleanupRuns)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
