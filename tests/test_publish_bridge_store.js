// Regression tests for dashboard/api/_lib/publishBridgeStore.js (Recovery
// Milestone 6B, Part 1/6) -- the durable, cross-browser bridge between a
// successful Confirm & Publish and the next GBP sync writing owner_response
// into reviews.db. No real Upstash account is used anywhere in this file:
// every test drives the module's test-only client-factory seam
// (_setRedisClientForTests), the same pattern test_action_store.js already
// established.
//
// Run directly: node tests/test_publish_bridge_store.js

import {
  writePublishBridge,
  getPublishBridges,
  deletePublishBridge,
  PublishBridgeUnavailableError,
  _setRedisClientForTests,
  _resetRedisClientForTests,
} from '../dashboard/api/_lib/publishBridgeStore.js'

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

// A tiny in-memory stand-in for the real Upstash key commands this module
// uses (set with {ex}, mget, del) -- values stored as JSON strings exactly
// as the real client would, so parseRecord()'s JSON.parse path is genuinely
// exercised. Records the `ex` (TTL) argument every set() call receives so
// tests can assert on it directly.
function fakeRedis(initial = {}) {
  const store = { ...initial }
  const setCalls = []
  return {
    set: async (key, value, opts) => { store[key] = value; setCalls.push({ key, value, opts }) },
    mget: async (...keys) => keys.map(k => store[k] ?? null),
    del: async (key) => { delete store[key] },
    _store: store,
    _setCalls: setCalls,
  }
}

async function testUnconfiguredStoreThrowsOnWrite() {
  let threw = false
  try {
    await writePublishBridge('r1', { responseText: 'Thanks!' })
  } catch (err) {
    threw = err instanceof PublishBridgeUnavailableError
  }
  assert(threw, 'writePublishBridge() must throw PublishBridgeUnavailableError when unconfigured, never silently no-op')
}

async function testUnconfiguredStoreThrowsOnRead() {
  let threw = false
  try {
    await getPublishBridges(['r1'])
  } catch (err) {
    threw = err instanceof PublishBridgeUnavailableError
  }
  assert(threw, 'getPublishBridges() must throw PublishBridgeUnavailableError when unconfigured')
}

async function testWriteThenReadRoundTrips() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await writePublishBridge('r1', {
    gbpReviewName: 'accounts/1/locations/2/reviews/abc', responseText: 'Thank you!',
    locationName: 'Casa Tequila Prime', reviewerName: 'Jane Doe', reviewDate: '2026-08-07',
  })
  const bridges = await getPublishBridges(['r1'])
  assert(bridges.r1, 'the written record must be readable back')
  assert(bridges.r1.responseText === 'Thank you!', 'responseText must round-trip exactly')
  assert(bridges.r1.gbpReviewName === 'accounts/1/locations/2/reviews/abc', 'gbpReviewName must round-trip exactly')
  assert(bridges.r1.status === 'pending_google_reconciliation', 'a freshly written record must default to pending_google_reconciliation')
  assert(bridges.r1.source === 'future_insights', 'source must always be future_insights -- callers cannot override it')
}

async function testWriteSetsATtl() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await writePublishBridge('r1', { responseText: 'Thanks!' })
  const call = client._setCalls[0]
  assert(call.opts && typeof call.opts.ex === 'number' && call.opts.ex > 0, 'every write must set a TTL -- a bridge record must never persist forever')
  assert(call.opts.ex >= 60 * 60 * 24, 'the TTL must be comfortably longer than the sync interval (at least 24h)')
}

async function testWriteNeverStoresUnrelatedFields() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await writePublishBridge('r1', {
    responseText: 'Thanks!', refreshToken: 'should-never-be-stored', accessToken: 'nope',
  })
  const bridges = await getPublishBridges(['r1'])
  assert(!('refreshToken' in bridges.r1), 'writePublishBridge must never persist arbitrary caller fields (e.g. a token)')
  assert(!('accessToken' in bridges.r1), 'writePublishBridge must never persist arbitrary caller fields (e.g. a token)')
}

async function testBulkReadReturnsOnlyIdsWithARecord() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await writePublishBridge('r1', { responseText: 'A' })
  const bridges = await getPublishBridges(['r1', 'r2', 'r3'])
  assert(Object.keys(bridges).length === 1, 'ids with no bridge record must simply be absent, not an error')
  assert(bridges.r1 && !bridges.r2 && !bridges.r3, 'only r1 should be present')
}

async function testBulkReadIsOneRoundTripForManyIds() {
  const client = fakeRedis()
  let mgetCalls = 0
  const wrapped = { ...client, mget: async (...keys) => { mgetCalls++; return client.mget(...keys) } }
  _setRedisClientForTests(() => wrapped)
  await getPublishBridges(['r1', 'r2', 'r3', 'r4', 'r5'])
  assert(mgetCalls === 1, `expected exactly one bulk mget call for 5 ids, got ${mgetCalls} -- must never be one call per review`)
}

async function testEmptyIdListReturnsEmptyObjectWithoutARedisCall() {
  const client = fakeRedis()
  let mgetCalls = 0
  const wrapped = { ...client, mget: async (...keys) => { mgetCalls++; return client.mget(...keys) } }
  _setRedisClientForTests(() => wrapped)
  const bridges = await getPublishBridges([])
  assert(Object.keys(bridges).length === 0, 'an empty id list must return {}')
  assert(mgetCalls === 0, 'an empty id list must never make a Redis call at all')
}

async function testDeleteRemovesTheRecord() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await writePublishBridge('r1', { responseText: 'Thanks!' })
  await deletePublishBridge('r1')
  const bridges = await getPublishBridges(['r1'])
  assert(!bridges.r1, 'after deletePublishBridge, the record must no longer be readable')
}

async function testDeletingAMissingKeyIsANoOp() {
  _setRedisClientForTests(() => fakeRedis())
  let threw = false
  try {
    await deletePublishBridge('never-written')
  } catch {
    threw = true
  }
  assert(!threw, 'deleting a key that was never written must not throw')
}

async function testMalformedStoredValueIsSkippedNotThrown() {
  _setRedisClientForTests(() => fakeRedis({ 'publish_bridge:v1:r1': 'not valid json{' }))
  const bridges = await getPublishBridges(['r1'])
  assert(Object.keys(bridges).length === 0, 'a corrupted stored record is skipped rather than crashing the whole read')
}

async function testReadFailureThrowsUnavailable() {
  _setRedisClientForTests(() => ({ mget: async () => { throw new Error('Upstash timeout') } }))
  let threw = false
  try {
    await getPublishBridges(['r1'])
  } catch {
    threw = true
  }
  assert(threw, 'a Redis read failure must surface as an error, never silently return {}')
}

async function main() {
  await run('unconfigured store throws on write (never silently no-ops)', testUnconfiguredStoreThrowsOnWrite)
  await run('unconfigured store throws on read', testUnconfiguredStoreThrowsOnRead)
  await run('write then bulk-read round-trips the record exactly', testWriteThenReadRoundTrips)
  await run('every write sets a TTL of at least 24h', testWriteSetsATtl)
  await run('write never persists unrelated/sensitive fields the caller passes', testWriteNeverStoresUnrelatedFields)
  await run('bulk read returns only ids that actually have a record', testBulkReadReturnsOnlyIdsWithARecord)
  await run('bulk read is exactly one Redis round trip regardless of id count', testBulkReadIsOneRoundTripForManyIds)
  await run('an empty id list short-circuits without a Redis call', testEmptyIdListReturnsEmptyObjectWithoutARedisCall)
  await run('delete removes the record', testDeleteRemovesTheRecord)
  await run('deleting an already-missing key is a no-op, not an error', testDeletingAMissingKeyIsANoOp)
  await run('a corrupted stored record is skipped, not thrown', testMalformedStoredValueIsSkippedNotThrown)
  await run('a Redis read failure surfaces as PublishBridgeUnavailableError-shaped error', testReadFailureThrowsUnavailable)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
