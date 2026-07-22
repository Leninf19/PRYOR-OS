// Regression tests for dashboard/api/_lib/actionStore.js -- the Redis-backed
// seam for Action Center's collaborative task-tracking state. No real
// Upstash account is used anywhere in this file: every test drives the
// module's test-only client-factory seam (_setRedisClientForTests), the
// same pattern test_rate_limit.js already established for
// _setLimiterFactoryForTests.
//
// Run directly: node tests/test_action_store.js

import {
  getAllActions,
  upsertAction,
  ActionStoreUnavailableError,
  _setRedisClientForTests,
  _resetRedisClientForTests,
} from '../dashboard/api/_lib/actionStore.js'

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
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
  }
}

// A tiny in-memory stand-in for the real Upstash hash commands this module
// uses (hgetall/hget/hset), storing values exactly as the real client would
// hand them back -- JSON strings, not pre-parsed objects, so parseRecord()'s
// JSON.parse path is genuinely exercised.
function fakeRedis(initial = {}) {
  const store = { ...initial }
  return {
    hgetall: async () => ({ ...store }),
    hget: async (_key, field) => store[field] ?? null,
    hset: async (_key, fields) => { Object.assign(store, fields) },
    _store: store,
  }
}

const OWNER = { userId: 'usr_owner', email: 'owner@example.com', displayName: 'Owner Person' }

async function testUnconfiguredStoreThrowsOnRead() {
  // No UPSTASH_* env vars, no test factory -- getClient() returns null.
  let threw = false
  try {
    await getAllActions()
  } catch (err) {
    threw = err instanceof ActionStoreUnavailableError
  }
  assert(threw, 'getAllActions() must throw ActionStoreUnavailableError when unconfigured')
}

async function testUnconfiguredStoreThrowsOnWrite() {
  let threw = false
  try {
    await upsertAction('a1', { status: 'Assigned' }, OWNER, 'Status -> Assigned')
  } catch (err) {
    threw = err instanceof ActionStoreUnavailableError
  }
  assert(threw, 'upsertAction() must throw ActionStoreUnavailableError when unconfigured, never silently no-op')
}

async function testEmptyStoreReturnsEmptyObject() {
  _setRedisClientForTests(() => fakeRedis())
  const all = await getAllActions()
  assert(typeof all === 'object' && Object.keys(all).length === 0, 'an empty hash must yield {}')
}

async function testUpsertCreatesRecordWithServerStamps() {
  _setRedisClientForTests(() => fakeRedis())
  const record = await upsertAction('complaint_wait_time', { status: 'Assigned', assignedTo: 'usr_martin' }, OWNER, 'Status -> Assigned')
  assert(record.id === 'complaint_wait_time', 'id is set on the record')
  assert(record.status === 'Assigned', 'patch fields are applied')
  assert(record.assignedTo === 'usr_martin', 'patch fields are applied')
  assert(record.createdBy === 'usr_owner', 'createdBy is stamped from the authenticated account')
  assert(record.updatedBy === 'usr_owner', 'updatedBy is stamped from the authenticated account')
  assert(typeof record.createdAt === 'string' && record.createdAt.length > 0, 'createdAt is server-generated')
  assert(record.createdAt === record.updatedAt, 'on first write, createdAt and updatedAt coincide')
  assert(record.history.length === 1, 'a logAction produces exactly one history entry')
  assert(record.history[0].by === 'Owner Person', 'history entry records who made the change')
  assert(record.history[0].action === 'Status -> Assigned', 'history entry records what changed')
  assert(typeof record.history[0].at === 'string', 'history entry records when the change happened')
}

async function testUpsertPreservesCreatedByAcrossUpdates() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await upsertAction('a1', { status: 'Assigned' }, OWNER, 'Status -> Assigned')
  const SECOND_ACTOR = { userId: 'usr_martin', email: 'martin@example.com', displayName: 'Martin' }
  const record = await upsertAction('a1', { status: 'In Progress' }, SECOND_ACTOR, 'Status -> In Progress')
  assert(record.createdBy === 'usr_owner', 'createdBy must never change on a later update')
  assert(record.updatedBy === 'usr_martin', 'updatedBy reflects the most recent actor')
  assert(record.history.length === 2, 'history accumulates across updates')
  assert(record.history[0].action === 'Status -> Assigned', 'earlier history entries are preserved in order')
  assert(record.history[1].by === 'Martin', 'the newest history entry records the newest actor')
}

async function testUpsertWithoutLogActionDoesNotAppendHistory() {
  _setRedisClientForTests(() => fakeRedis())
  const record = await upsertAction('a1', { notes: 'draft in progress' }, OWNER, undefined)
  assert(record.history.length === 0, 'a write with no logAction must not add a history entry (high-frequency draft edits)')
  assert(record.notes === 'draft in progress', 'the patch is still applied')
}

async function testClientSuppliedServerFieldsAreOverwritten() {
  _setRedisClientForTests(() => fakeRedis())
  // Simulates the API layer forwarding a patch that still contains
  // server-owned keys -- upsertAction() itself is the last line of defense
  // even though dashboard/api/actions/[action].js is expected to strip these.
  const record = await upsertAction('a1', {
    status: 'Assigned',
    createdBy: 'usr_attacker', createdAt: '1999-01-01T00:00:00.000Z',
    updatedBy: 'usr_attacker', updatedAt: '1999-01-01T00:00:00.000Z',
    history: [{ at: '1999-01-01T00:00:00.000Z', by: 'usr_attacker', action: 'forged' }],
  }, OWNER, 'Status -> Assigned')
  assert(record.createdBy === 'usr_owner', 'a client-supplied createdBy must not survive')
  assert(record.updatedBy === 'usr_owner', 'a client-supplied updatedBy must not survive')
  assert(record.createdAt !== '1999-01-01T00:00:00.000Z', 'a client-supplied createdAt must not survive')
  assert(record.updatedAt !== '1999-01-01T00:00:00.000Z', 'a client-supplied updatedAt must not survive')
  assert(record.history.length === 1 && record.history[0].action === 'Status -> Assigned',
    'a client-supplied history array must not survive; only the server-appended entry remains')
}

async function testGetAllActionsReturnsMultipleRecords() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await upsertAction('a1', { status: 'Assigned' }, OWNER, 'Status -> Assigned')
  await upsertAction('a2', { status: 'Completed' }, OWNER, 'Status -> Completed')
  const all = await getAllActions()
  assert(Object.keys(all).length === 2, 'both records are returned')
  assert(all.a1.status === 'Assigned' && all.a2.status === 'Completed', 'each record keeps its own fields')
}

async function testReadFailureThrowsUnavailable() {
  _setRedisClientForTests(() => ({
    hgetall: async () => { throw new Error('ECONNREFUSED fake-upstash-outage') },
  }))
  let threw = false
  try {
    await getAllActions()
  } catch (err) {
    threw = err instanceof ActionStoreUnavailableError
  }
  assert(threw, 'a Redis read failure must surface as ActionStoreUnavailableError, never as an empty/default result')
}

async function testWriteFailureThrowsUnavailable() {
  _setRedisClientForTests(() => ({
    hget: async () => null,
    hset: async () => { throw new Error('ECONNREFUSED fake-upstash-outage') },
  }))
  let threw = false
  try {
    await upsertAction('a1', { status: 'Assigned' }, OWNER, 'Status -> Assigned')
  } catch (err) {
    threw = err instanceof ActionStoreUnavailableError
  }
  assert(threw, 'a Redis write failure must surface as ActionStoreUnavailableError, never a silently-dropped write')
}

async function testMalformedStoredValueIsSkippedNotThrown() {
  _setRedisClientForTests(() => fakeRedis({ a1: 'not valid json {{{' }))
  const all = await getAllActions()
  assert(Object.keys(all).length === 0, 'a corrupted stored record is skipped rather than crashing the whole read')
}

async function main() {
  await run('unconfigured store throws on read (never silently empty)', testUnconfiguredStoreThrowsOnRead)
  await run('unconfigured store throws on write (never silently no-ops)', testUnconfiguredStoreThrowsOnWrite)
  await run('an empty hash returns {}', testEmptyStoreReturnsEmptyObject)
  await run('upsert creates a record with server-stamped createdBy/createdAt/updatedBy/updatedAt/history', testUpsertCreatesRecordWithServerStamps)
  await run('createdBy/createdAt are preserved across later updates; updatedBy/history accumulate', testUpsertPreservesCreatedByAcrossUpdates)
  await run('a write with no logAction does not append a history entry', testUpsertWithoutLogActionDoesNotAppendHistory)
  await run('client-supplied server-authoritative fields (createdBy/At, updatedBy/At, history) are never trusted', testClientSuppliedServerFieldsAreOverwritten)
  await run('getAllActions returns every stored record independently', testGetAllActionsReturnsMultipleRecords)
  await run('a Redis read failure surfaces as ActionStoreUnavailableError', testReadFailureThrowsUnavailable)
  await run('a Redis write failure surfaces as ActionStoreUnavailableError', testWriteFailureThrowsUnavailable)
  await run('a corrupted stored record is skipped, not thrown', testMalformedStoredValueIsSkippedNotThrown)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
