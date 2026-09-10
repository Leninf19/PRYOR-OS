// Multi-Tenant Phase 4Q.1 -- unit tests for pendingRegistrationStore.js:
// atomic create-if-absent (the "two registrations racing for the same
// email" case), update/delete, and the tenant-creation lock primitive
// (the "two tenant-creation requests racing" case).
//
// Run directly: node tests/test_pending_registration_store.js

import {
  createPendingRegistration, getPendingRegistration, updatePendingRegistration, deletePendingRegistration,
  acquireTenantCreationLock, releaseTenantCreationLock,
  _setRedisClientForTests, _resetRedisClientForTests,
} from '../dashboard/api/_lib/pendingRegistrationStore.js'

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
    _resetRedisClientForTests()
  }
}

// Faithful-enough fake of Upstash's REST SET (NX/EX) + GET/DEL -- the
// SAME atomic primitive both createPendingRegistration() and the
// tenant-creation lock rely on.
function fakeKeyValueRedis() {
  const store = {}
  function isExpired(entry) {
    return entry && entry.expiresAtMs !== null && Date.now() > entry.expiresAtMs
  }
  return {
    async set(key, value, opts = {}) {
      const existing = store[key]
      const alive = existing && !isExpired(existing)
      if (opts.nx && alive) return null
      store[key] = { value, expiresAtMs: opts.ex ? Date.now() + opts.ex * 1000 : null }
      return 'OK'
    },
    async get(key) {
      const entry = store[key]
      if (!entry || isExpired(entry)) { delete store[key]; return null }
      return entry.value
    },
    async del(key) { delete store[key] },
  }
}

function wire() {
  const client = fakeKeyValueRedis()
  _setRedisClientForTests(() => client)
  return client
}

async function testCreateThenGet() {
  wire()
  const created = await createPendingRegistration({
    email: 'Owner@Example.com', passwordHash: 'hash', displayName: 'Jane Owner',
    companyName: 'Sunset Grill Group', userId: 'usr_1', tenantIdReserved: 't_sunset-grill-abc123',
  })
  assert(created.email === 'owner@example.com', 'email must be normalized to lowercase')
  assert(created.status === 'pending_verification')
  const fetched = await getPendingRegistration('OWNER@EXAMPLE.COM')
  assert(fetched.userId === 'usr_1', 'lookup must be case-insensitive on email')
}

async function testConcurrentCreateForSameEmailOnlyOneWins() {
  wire()
  const attempt = i => createPendingRegistration({
    email: 'race@example.com', passwordHash: `hash${i}`, displayName: `User ${i}`,
    companyName: 'Race Co', userId: `usr_${i}`, tenantIdReserved: `t_race-co-${i}`,
  })
  const [a, b] = await Promise.all([attempt(1), attempt(2)])
  const winners = [a, b].filter(Boolean)
  assert(winners.length === 1, `expected exactly one create to win, got ${winners.length}`)
  const final = await getPendingRegistration('race@example.com')
  assert(final.userId === winners[0].userId, 'the persisted record must belong to the actual winner, not be silently overwritten by the loser')
}

async function testUpdateMergesAndDeleteRemoves() {
  wire()
  await createPendingRegistration({
    email: 'x@example.com', passwordHash: 'h', displayName: 'X', companyName: 'X Co', userId: 'usr_x', tenantIdReserved: 't_x-co-1',
  })
  const updated = await updatePendingRegistration('x@example.com', { status: 'verified_awaiting_plan', emailVerified: true })
  assert(updated.status === 'verified_awaiting_plan')
  assert(updated.emailVerified === true)
  assert(updated.userId === 'usr_x', 'unrelated fields must survive a partial update')
  await deletePendingRegistration('x@example.com')
  assert((await getPendingRegistration('x@example.com')) === null, 'record must be gone after delete')
}

async function testTenantCreationLockMutualExclusion() {
  wire()
  const first = await acquireTenantCreationLock('lock@example.com')
  const second = await acquireTenantCreationLock('lock@example.com')
  assert(first === true, 'the first acquire must succeed')
  assert(second === false, 'a concurrent second acquire for the SAME email must fail while the lock is held')
  await releaseTenantCreationLock('lock@example.com')
  const third = await acquireTenantCreationLock('lock@example.com')
  assert(third === true, 'after release, a new acquire must succeed again')
}

async function testTenantCreationLockIsPerEmail() {
  wire()
  const a = await acquireTenantCreationLock('a@example.com')
  const b = await acquireTenantCreationLock('b@example.com')
  assert(a === true && b === true, 'locks for different emails must never contend with each other')
}

const tests = [
  ['create then get (email normalized)', testCreateThenGet],
  ['two concurrent creates for the same email -- exactly one wins', testConcurrentCreateForSameEmailOnlyOneWins],
  ['update merges fields, delete removes the record', testUpdateMergesAndDeleteRemoves],
  ['tenant-creation lock provides mutual exclusion per email', testTenantCreationLockMutualExclusion],
  ['tenant-creation lock is scoped per email, not global', testTenantCreationLockIsPerEmail],
]

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
