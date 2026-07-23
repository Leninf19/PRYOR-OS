// Regression tests for dashboard/api/_lib/contactStore.js -- the
// Redis-backed seam for Restaurant Contacts (Phase 8, Milestone 8.3).
// Mirrors test_action_store.js exactly: no real Upstash account anywhere,
// every test drives the module's test-only client-factory seam.
//
// Run directly: node tests/test_contact_store.js

import {
  getAllContacts,
  getContact,
  upsertContact,
  deleteContact,
  ContactStoreUnavailableError,
  _setRedisClientForTests,
  _resetRedisClientForTests,
} from '../dashboard/api/_lib/contactStore.js'

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
// uses (hgetall/hget/hset/hdel), storing values exactly as the real client
// would hand them back -- JSON strings, not pre-parsed objects, so
// parseRecord()'s JSON.parse path is genuinely exercised.
function fakeRedis(initial = {}) {
  const store = { ...initial }
  return {
    hgetall: async () => ({ ...store }),
    hget: async (_key, field) => store[field] ?? null,
    hset: async (_key, fields) => { Object.assign(store, fields) },
    hdel: async (_key, field) => {
      if (!(field in store)) return 0
      delete store[field]
      return 1
    },
    _store: store,
  }
}

const OWNER = { userId: 'usr_owner', email: 'owner@example.com', displayName: 'Owner Person' }

async function testUnconfiguredStoreThrowsOnRead() {
  let threw = false
  try {
    await getAllContacts()
  } catch (err) {
    threw = err instanceof ContactStoreUnavailableError
  }
  assert(threw, 'getAllContacts() must throw ContactStoreUnavailableError when unconfigured')
}

async function testUnconfiguredStoreThrowsOnWrite() {
  let threw = false
  try {
    await upsertContact(9, { primaryEmail: 'test@example.com' }, OWNER, 'Contact created')
  } catch (err) {
    threw = err instanceof ContactStoreUnavailableError
  }
  assert(threw, 'upsertContact() must throw ContactStoreUnavailableError when unconfigured, never silently no-op')
}

async function testEmptyStoreReturnsEmptyObject() {
  _setRedisClientForTests(() => fakeRedis())
  const all = await getAllContacts()
  assert(typeof all === 'object' && Object.keys(all).length === 0, 'an empty hash must yield {}')
}

async function testUpsertCreatesRecordWithServerStamps() {
  _setRedisClientForTests(() => fakeRedis())
  const record = await upsertContact(9, {
    locationName: 'Los Tres Amigos Canton', managerName: 'Lenin', primaryEmail: 'test@example.com', ccEmails: [],
  }, OWNER, 'Contact created')
  assert(record.locationId === 9, 'locationId is set on the record, coerced to a number')
  assert(record.primaryEmail === 'test@example.com', 'patch fields are applied')
  assert(record.managerName === 'Lenin', 'patch fields are applied')
  assert(record.createdBy === 'usr_owner', 'createdBy is stamped from the authenticated account')
  assert(record.updatedBy === 'usr_owner', 'updatedBy is stamped from the authenticated account')
  assert(typeof record.createdAt === 'string' && record.createdAt.length > 0, 'createdAt is server-generated')
  assert(record.createdAt === record.updatedAt, 'on first write, createdAt and updatedAt coincide')
  assert(record.history.length === 1, 'a logAction produces exactly one history entry')
  assert(record.history[0].by === 'Owner Person', 'history entry records who made the change')
  assert(record.history[0].action === 'Contact created', 'history entry records what changed')
  assert(typeof record.history[0].at === 'string', 'history entry records when the change happened')
}

async function testUpsertDefaultsActiveTrueForNewRecord() {
  _setRedisClientForTests(() => fakeRedis())
  const record = await upsertContact(9, { primaryEmail: 'test@example.com' }, OWNER, 'Contact created')
  assert(record.active === true, 'a newly created contact defaults to active: true')
  assert(Array.isArray(record.ccEmails) && record.ccEmails.length === 0, 'ccEmails defaults to an empty array when not provided')
}

async function testUpsertPreservesCreatedByAcrossUpdates() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await upsertContact(9, { primaryEmail: 'first@example.com' }, OWNER, 'Contact created')
  const SECOND_ACTOR = { userId: 'usr_martin', email: 'martin@example.com', displayName: 'Martin' }
  const record = await upsertContact(9, { primaryEmail: 'second@example.com' }, SECOND_ACTOR, 'Primary email updated')
  assert(record.createdBy === 'usr_owner', 'createdBy must never change on a later update')
  assert(record.updatedBy === 'usr_martin', 'updatedBy reflects the most recent actor')
  assert(record.primaryEmail === 'second@example.com', 'the patch overwrites the previous value')
  assert(record.history.length === 2, 'history accumulates across updates')
  assert(record.history[0].action === 'Contact created', 'earlier history entries are preserved in order')
  assert(record.history[1].by === 'Martin', 'the newest history entry records the newest actor')
}

async function testUpsertWithoutLogActionDoesNotAppendHistory() {
  _setRedisClientForTests(() => fakeRedis())
  const record = await upsertContact(9, { managerName: 'draft edit' }, OWNER, undefined)
  assert(record.history.length === 0, 'a write with no logAction must not add a history entry')
  assert(record.managerName === 'draft edit', 'the patch is still applied')
}

async function testClientSuppliedServerFieldsAreOverwritten() {
  _setRedisClientForTests(() => fakeRedis())
  // Simulates the API layer forwarding a patch that still contains
  // server-owned keys -- upsertContact() itself is the last line of defense
  // even though dashboard/api/settings/[action].js is expected to strip these.
  const record = await upsertContact(9, {
    primaryEmail: 'test@example.com',
    locationId: 999,
    createdBy: 'usr_attacker', createdAt: '1999-01-01T00:00:00.000Z',
    updatedBy: 'usr_attacker', updatedAt: '1999-01-01T00:00:00.000Z',
    history: [{ at: '1999-01-01T00:00:00.000Z', by: 'usr_attacker', action: 'forged' }],
  }, OWNER, 'Contact created')
  assert(record.locationId === 9, 'a client-supplied locationId must never override the real key')
  assert(record.createdBy === 'usr_owner', 'a client-supplied createdBy must not survive')
  assert(record.updatedBy === 'usr_owner', 'a client-supplied updatedBy must not survive')
  assert(record.createdAt !== '1999-01-01T00:00:00.000Z', 'a client-supplied createdAt must not survive')
  assert(record.updatedAt !== '1999-01-01T00:00:00.000Z', 'a client-supplied updatedAt must not survive')
  assert(record.history.length === 1 && record.history[0].action === 'Contact created',
    'a client-supplied history array must not survive; only the server-appended entry remains')
}

async function testGetAllContactsReturnsMultipleRecords() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await upsertContact(9, { primaryEmail: 'canton@example.com' }, OWNER, 'Contact created')
  await upsertContact(2, { primaryEmail: 'chelsea@example.com' }, OWNER, 'Contact created')
  const all = await getAllContacts()
  assert(Object.keys(all).length === 2, 'both records are returned')
  assert(all['9'].primaryEmail === 'canton@example.com' && all['2'].primaryEmail === 'chelsea@example.com',
    'each record keeps its own fields, keyed by locationId')
}

async function testReadFailureThrowsUnavailable() {
  _setRedisClientForTests(() => ({
    hgetall: async () => { throw new Error('ECONNREFUSED fake-upstash-outage') },
  }))
  let threw = false
  try {
    await getAllContacts()
  } catch (err) {
    threw = err instanceof ContactStoreUnavailableError
  }
  assert(threw, 'a Redis read failure must surface as ContactStoreUnavailableError, never as an empty/default result')
}

async function testWriteFailureThrowsUnavailable() {
  _setRedisClientForTests(() => ({
    hget: async () => null,
    hset: async () => { throw new Error('ECONNREFUSED fake-upstash-outage') },
  }))
  let threw = false
  try {
    await upsertContact(9, { primaryEmail: 'test@example.com' }, OWNER, 'Contact created')
  } catch (err) {
    threw = err instanceof ContactStoreUnavailableError
  }
  assert(threw, 'a Redis write failure must surface as ContactStoreUnavailableError, never a silently-dropped write')
}

async function testGetContactReturnsSingleRecordWithoutFetchingAll() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await upsertContact(9, { primaryEmail: 'canton@example.com' }, OWNER, 'Contact created')
  await upsertContact(2, { primaryEmail: 'chelsea@example.com' }, OWNER, 'Contact created')
  const record = await getContact(9)
  assert(record.primaryEmail === 'canton@example.com', 'getContact must return the requested record')
  assert(record.locationId === 9, 'getContact must return the correct locationId')
}

async function testGetContactReturnsNullForUnknownLocation() {
  _setRedisClientForTests(() => fakeRedis())
  const record = await getContact(999)
  assert(record === null, 'getContact must return null for a locationId with no record, not throw')
}

async function testGetContactThrowsWhenUnconfigured() {
  let threw = false
  try {
    await getContact(9)
  } catch (err) {
    threw = err instanceof ContactStoreUnavailableError
  }
  assert(threw, 'getContact must throw ContactStoreUnavailableError when unconfigured, same as getAllContacts')
}

async function testMalformedStoredValueIsSkippedNotThrown() {
  _setRedisClientForTests(() => fakeRedis({ 9: 'not valid json {{{' }))
  const all = await getAllContacts()
  assert(Object.keys(all).length === 0, 'a corrupted stored record is skipped rather than crashing the whole read')
}

async function testDeleteContactRemovesRecordAndReturnsTrue() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await upsertContact(9, { primaryEmail: 'canton@example.com' }, OWNER, 'Contact created')
  const removed = await deleteContact(9)
  assert(removed === true, 'deleteContact must return true when a record existed')
  const record = await getContact(9)
  assert(record === null, 'the record must actually be gone after delete, not just marked inactive')
}

async function testDeleteContactReturnsFalseForUnknownLocation() {
  _setRedisClientForTests(() => fakeRedis())
  const removed = await deleteContact(999)
  assert(removed === false, 'deleteContact must return false, not throw, when there was nothing to delete')
}

async function testDeleteContactThrowsWhenUnconfigured() {
  let threw = false
  try {
    await deleteContact(9)
  } catch (err) {
    threw = err instanceof ContactStoreUnavailableError
  }
  assert(threw, 'deleteContact must throw ContactStoreUnavailableError when unconfigured')
}

async function testDisableIsUpsertNotDelete() {
  // Disable/Enable Contact must be a normal upsertContact({ active: false })
  // -- the record (and its history) survives, unlike Delete Contact.
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await upsertContact(9, { primaryEmail: 'canton@example.com' }, OWNER, 'Contact created')
  const disabled = await upsertContact(9, { active: false }, OWNER, 'Contact disabled')
  assert(disabled.active === false, 'active flips to false')
  assert(disabled.primaryEmail === 'canton@example.com', 'other fields survive a disable')
  assert(disabled.history.length === 2, 'disabling is recorded in history, not a silent removal')
  const enabled = await upsertContact(9, { active: true }, OWNER, 'Contact enabled')
  assert(enabled.active === true, 're-enabling flips active back to true')
  assert(enabled.history.length === 3, 're-enabling is also recorded in history')
}

async function main() {
  await run('unconfigured store throws on read (never silently empty)', testUnconfiguredStoreThrowsOnRead)
  await run('unconfigured store throws on write (never silently no-ops)', testUnconfiguredStoreThrowsOnWrite)
  await run('an empty hash returns {}', testEmptyStoreReturnsEmptyObject)
  await run('upsert creates a record with server-stamped createdBy/createdAt/updatedBy/updatedAt/history', testUpsertCreatesRecordWithServerStamps)
  await run('a newly created contact defaults active: true and ccEmails: []', testUpsertDefaultsActiveTrueForNewRecord)
  await run('createdBy/createdAt are preserved across later updates; updatedBy/history accumulate', testUpsertPreservesCreatedByAcrossUpdates)
  await run('a write with no logAction does not append a history entry', testUpsertWithoutLogActionDoesNotAppendHistory)
  await run('client-supplied server-authoritative fields (locationId, createdBy/At, updatedBy/At, history) are never trusted', testClientSuppliedServerFieldsAreOverwritten)
  await run('getAllContacts returns every stored record independently, keyed by locationId', testGetAllContactsReturnsMultipleRecords)
  await run('getContact returns a single record without needing to fetch the whole hash', testGetContactReturnsSingleRecordWithoutFetchingAll)
  await run('getContact returns null for an unknown locationId', testGetContactReturnsNullForUnknownLocation)
  await run('getContact throws ContactStoreUnavailableError when unconfigured', testGetContactThrowsWhenUnconfigured)
  await run('a Redis read failure surfaces as ContactStoreUnavailableError', testReadFailureThrowsUnavailable)
  await run('a Redis write failure surfaces as ContactStoreUnavailableError', testWriteFailureThrowsUnavailable)
  await run('a corrupted stored record is skipped, not thrown', testMalformedStoredValueIsSkippedNotThrown)
  await run('deleteContact removes the record and returns true', testDeleteContactRemovesRecordAndReturnsTrue)
  await run('deleteContact returns false (not throw) for an unknown locationId', testDeleteContactReturnsFalseForUnknownLocation)
  await run('deleteContact throws ContactStoreUnavailableError when unconfigured', testDeleteContactThrowsWhenUnconfigured)
  await run('Disable/Enable Contact is a normal upsert (record + history survive), never a delete', testDisableIsUpsertNotDelete)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
