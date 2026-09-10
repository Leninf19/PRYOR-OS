// Regression tests for dashboard/api/_lib/notificationStore.js -- the
// Redis-backed reply-failure record store and per-user read/unread state.
// No real Upstash account used anywhere -- every test drives the module's
// test-only client-factory seam, the same pattern test_action_store.js/
// test_credential_store.js already established.
//
// Run directly: node tests/test_notification_store.js

import {
  recordReplyFailure, clearReplyFailure, listReplyFailures,
  getReadState, markRead, hasBeenSeeded, markSeeded, NotificationStoreUnavailableError,
  REPLY_FAILURE_TTL_SECONDS, READ_STATE_TTL_SECONDS,
  _setRedisClientForTests, _resetRedisClientForTests,
} from '../dashboard/api/_lib/notificationStore.js'
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
  } finally {
    _resetRedisClientForTests()
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
  }
}

// A tiny in-memory stand-in for the exact Redis commands this module uses
// (set/get/del/keys/mget for reply failures; hgetall/hset/expire for read
// state). Records every set()'s options object so tests can assert a real
// TTL was actually passed, not merely that a value was stored.
function fakeRedis() {
  const kv = new Map() // key -> { value, ex }
  const hashes = new Map() // key -> { fields, ttl }
  return {
    set: async (key, value, opts) => { kv.set(key, { value, ex: opts?.ex ?? null }) },
    get: async key => kv.get(key)?.value ?? null,
    del: async key => { kv.delete(key) },
    keys: async pattern => {
      const prefix = pattern.replace(/\*$/, '')
      return [...kv.keys()].filter(k => k.startsWith(prefix))
    },
    mget: async (...keys) => keys.map(k => kv.get(k)?.value ?? null),
    hgetall: async key => ({ ...(hashes.get(key)?.fields ?? {}) }),
    hset: async (key, fields) => {
      const existing = hashes.get(key) ?? { fields: {}, ttl: null }
      Object.assign(existing.fields, fields)
      hashes.set(key, existing)
    },
    expire: async (key, seconds) => {
      const existing = hashes.get(key)
      if (existing) existing.ttl = seconds
    },
    _kv: kv,
    _hashes: hashes,
  }
}

function installFakeClient() {
  const client = fakeRedis() // captured ONCE -- a fresh factory-per-call would silently reset state between operations
  _setRedisClientForTests(() => client)
  return client
}

// --- Reply failures ----------------------------------------------------------

async function testRecordThenListReturnsTheFailure() {
  installFakeClient()
  const ok = await recordReplyFailure(DEFAULT_TENANT_ID, 'review-1', { locationId: 3, locationName: 'Casa Tequila Prime', failReason: 'review_gone' })
  assert(ok === true)
  const failures = await listReplyFailures(DEFAULT_TENANT_ID)
  assert(failures.length === 1)
  assert(failures[0].reviewId === 'review-1')
  assert(failures[0].locationId === 3)
  assert(failures[0].failReason === 'review_gone')
  assert(typeof failures[0].failedAt === 'string' && failures[0].failedAt.length > 0)
}

async function testRecordSetsARealTtl() {
  const client = installFakeClient()
  await recordReplyFailure(DEFAULT_TENANT_ID, 'review-2', { locationId: 1 })
  const stored = [...client._kv.values()][0]
  assert(stored.ex === REPLY_FAILURE_TTL_SECONDS, `expected TTL ${REPLY_FAILURE_TTL_SECONDS}, got ${stored.ex}`)
}

async function testRepeatedFailureForSameReviewOverwritesNotDuplicates() {
  installFakeClient()
  await recordReplyFailure(DEFAULT_TENANT_ID, 'review-3', { locationId: 1, failReason: 'first attempt' })
  await recordReplyFailure(DEFAULT_TENANT_ID, 'review-3', { locationId: 1, failReason: 'second attempt' })
  const failures = await listReplyFailures(DEFAULT_TENANT_ID)
  assert(failures.length === 1, `a repeated failure for the same review must overwrite, never duplicate -- got ${failures.length}`)
  assert(failures[0].failReason === 'second attempt', 'the overwrite must reflect the latest failure')
}

async function testClearReplyFailureRemovesIt() {
  installFakeClient()
  await recordReplyFailure(DEFAULT_TENANT_ID, 'review-4', { locationId: 1 })
  await clearReplyFailure(DEFAULT_TENANT_ID, 'review-4')
  const failures = await listReplyFailures(DEFAULT_TENANT_ID)
  assert(failures.length === 0)
}

async function testClearNonexistentFailureIsHarmless() {
  installFakeClient()
  const ok = await clearReplyFailure(DEFAULT_TENANT_ID, 'never-recorded')
  assert(ok === true)
}

async function testListReplyFailuresReturnsEmptyWhenUnconfigured() {
  const failures = await listReplyFailures(DEFAULT_TENANT_ID)
  assert(Array.isArray(failures) && failures.length === 0, 'an unconfigured store must degrade to an empty list, never throw')
}

async function testRecordReplyFailureNeverThrowsWhenUnconfigured() {
  const ok = await recordReplyFailure(DEFAULT_TENANT_ID, 'review-5', { locationId: 1 })
  assert(ok === false, 'an unconfigured store must return false, not throw -- google/[action].js relies on this to never affect its own response')
}

// --- Read state ----------------------------------------------------------

async function testMarkReadThenGetReadStateReflectsIt() {
  installFakeClient()
  await markRead(DEFAULT_TENANT_ID, 'usr_owner', ['critical_review:r1', 'low_star_review:r2'])
  const state = await getReadState(DEFAULT_TENANT_ID, 'usr_owner')
  assert(Boolean(state['critical_review:r1']))
  assert(Boolean(state['low_star_review:r2']))
}

async function testReadStateIsPerUser() {
  installFakeClient()
  await markRead(DEFAULT_TENANT_ID, 'usr_owner', ['critical_review:r1'])
  const ownerState = await getReadState(DEFAULT_TENANT_ID, 'usr_owner')
  const lmState = await getReadState(DEFAULT_TENANT_ID, 'usr_lm')
  assert(Boolean(ownerState['critical_review:r1']), 'Owner must see their own read marker')
  assert(!lmState['critical_review:r1'], 'a Location Manager must NOT inherit Owner\'s read state -- marking read for one user must never mark it read for another')
}

async function testMarkAllReadSetsAllGivenKeys() {
  installFakeClient()
  await markRead(DEFAULT_TENANT_ID, 'usr_owner', ['a', 'b', 'c'])
  const state = await getReadState(DEFAULT_TENANT_ID, 'usr_owner')
  assert(Object.keys(state).length === 3)
}

async function testMarkReadWithEmptyArrayIsANoOp() {
  installFakeClient()
  const ok = await markRead(DEFAULT_TENANT_ID, 'usr_owner', [])
  assert(ok === true)
  const state = await getReadState(DEFAULT_TENANT_ID, 'usr_owner')
  assert(Object.keys(state).length === 0)
}

async function testMarkReadSetsTheReadStateTtl() {
  const client = installFakeClient()
  await markRead(DEFAULT_TENANT_ID, 'usr_owner', ['a'])
  const hash = client._hashes.get('notif_read:v1:usr_owner')
  assert(hash.ttl === READ_STATE_TTL_SECONDS, `expected read-state TTL ${READ_STATE_TTL_SECONDS}, got ${hash.ttl}`)
}

async function testGetReadStateReturnsEmptyWhenUnconfigured() {
  const state = await getReadState(DEFAULT_TENANT_ID, 'usr_owner')
  assert(typeof state === 'object' && Object.keys(state).length === 0)
}

async function testMarkReadThrowsWhenUnconfigured() {
  let threw = false
  try {
    await markRead(DEFAULT_TENANT_ID, 'usr_owner', ['a'])
  } catch (err) {
    threw = err instanceof NotificationStoreUnavailableError
  }
  assert(threw, 'markRead must throw (not silently no-op) when the store is unconfigured -- a caller needs to know the write did not happen')
}

// --- First-open backlog seeding ---------------------------------------------

async function testHasBeenSeededFalseForANewUser() {
  installFakeClient()
  assert((await hasBeenSeeded(DEFAULT_TENANT_ID, 'usr_new')) === false)
}

async function testMarkSeededThenHasBeenSeededReturnsTrue() {
  installFakeClient()
  await markSeeded(DEFAULT_TENANT_ID, 'usr_owner')
  assert((await hasBeenSeeded(DEFAULT_TENANT_ID, 'usr_owner')) === true)
}

async function testSeededStatusIsPerUser() {
  installFakeClient()
  await markSeeded(DEFAULT_TENANT_ID, 'usr_owner')
  assert((await hasBeenSeeded(DEFAULT_TENANT_ID, 'usr_owner')) === true)
  assert((await hasBeenSeeded(DEFAULT_TENANT_ID, 'usr_lm')) === false, 'seeding one user must never mark a different user as seeded')
}

async function testHasBeenSeededFailsSafeToTrueWhenUnconfigured() {
  // Deliberately NOT installing a fake client -- getClient() returns null.
  // Must fail toward "already seeded" (skip the one-time seeding pass)
  // rather than "not seeded", so an outage can never cause a real
  // notification to be silently swallowed behind a bogus seeding pass.
  assert((await hasBeenSeeded(DEFAULT_TENANT_ID, 'usr_owner')) === true)
}

async function testMarkSeededReturnsFalseWhenUnconfiguredNeverThrows() {
  const ok = await markSeeded(DEFAULT_TENANT_ID, 'usr_owner')
  assert(ok === false)
}

function main() {
  const tests = [
    ['recordReplyFailure then listReplyFailures returns the failure', testRecordThenListReturnsTheFailure],
    ['recordReplyFailure sets a real TTL (30 days)', testRecordSetsARealTtl],
    ['a repeated failure for the same review overwrites, never duplicates', testRepeatedFailureForSameReviewOverwritesNotDuplicates],
    ['clearReplyFailure removes a recorded failure', testClearReplyFailureRemovesIt],
    ['clearing a never-recorded failure is harmless', testClearNonexistentFailureIsHarmless],
    ['listReplyFailures degrades to [] when unconfigured, never throws', testListReplyFailuresReturnsEmptyWhenUnconfigured],
    ['recordReplyFailure returns false (never throws) when unconfigured', testRecordReplyFailureNeverThrowsWhenUnconfigured],
    ['markRead then getReadState reflects the marked keys', testMarkReadThenGetReadStateReflectsIt],
    ['read state is per-user -- one user\'s read marker never leaks to another', testReadStateIsPerUser],
    ['markRead (mark-all-read use) sets every given key', testMarkAllReadSetsAllGivenKeys],
    ['markRead with an empty array is a harmless no-op', testMarkReadWithEmptyArrayIsANoOp],
    ['markRead sets the read-state hash\'s TTL (35 days)', testMarkReadSetsTheReadStateTtl],
    ['getReadState degrades to {} when unconfigured, never throws', testGetReadStateReturnsEmptyWhenUnconfigured],
    ['markRead throws NotificationStoreUnavailableError when unconfigured', testMarkReadThrowsWhenUnconfigured],
    ['hasBeenSeeded is false for a brand-new user', testHasBeenSeededFalseForANewUser],
    ['markSeeded then hasBeenSeeded returns true', testMarkSeededThenHasBeenSeededReturnsTrue],
    ['seeded status is per-user', testSeededStatusIsPerUser],
    ['hasBeenSeeded fails safe to true (skip seeding) when unconfigured', testHasBeenSeededFailsSafeToTrueWhenUnconfigured],
    ['markSeeded returns false (never throws) when unconfigured', testMarkSeededReturnsFalseWhenUnconfiguredNeverThrows],
  ]
  return (async () => {
    for (const [name, fn] of tests) await run(name, fn)
    console.log()
    if (results.every(Boolean)) {
      console.log(`ALL ${results.length} TESTS PASSED`)
      process.exit(0)
    }
    console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
    process.exit(1)
  })()
}

main()
