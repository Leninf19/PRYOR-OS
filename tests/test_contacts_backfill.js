// Regression tests for dashboard/api/settings/[action].js's
// contacts-backfill-from-legacy action (Phase 8, Milestone 8.5) -- the
// one-off, idempotent seed from the legacy location-contacts.json export
// into the live Redis contact store, for any location not already
// configured there. Drives the real handler with a fake req/res, same
// pattern as test_settings_contacts_endpoint.js.
//
// Run directly: node tests/test_contacts_backfill.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler, {
  _setLegacyBackfillDataForTests,
  _resetLegacyBackfillDataForTests,
} from '../dashboard/api/settings/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests, _resetRedisClientForTests, getContact } from '../dashboard/api/_lib/contactStore.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
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
    _resetLegacyBackfillDataForTests()
    _resetLimiterFactoryForTests()
    delete process.env.VERCEL_ENV
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

function fakeRedis(initial = {}) {
  const store = { ...initial }
  return {
    hgetall: async () => ({ ...store }),
    hget: async (_key, field) => store[field] ?? null,
    hset: async (_key, fields) => { Object.assign(store, fields) },
  }
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner Person' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Marketing Person' },
    ],
  })
}

const ownerToken = () => signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
const marketingToken = () => signSession({ userId: 'usr_marketing', email: 'marketing@example.com', role: 'marketing', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })

async function invoke(token) {
  const req = {
    method: 'POST',
    query: { action: 'contacts-backfill-from-legacy' },
    body: {},
    headers: token ? { cookie: `lta_session=${token}` } : {},
    socket: {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

const FIXTURE_LEGACY = {
  '9': { email: 'canton@example.com', name: 'Legacy Canton Manager' },
  '2': { email: 'chelsea@example.com', name: null },
  '5': { email: 'not-a-valid-email', name: 'Bad Row' },
}
const FIXTURE_META = {
  locations: [
    { locationId: 9, name: 'Los Tres Amigos Canton' },
    { locationId: 2, name: 'Los Tres Amigos Chelsea' },
    { locationId: 5, name: 'Some Other Location' },
  ],
}

async function testRejectsMarketing() {
  await setDirectory()
  const res = await invoke(await marketingToken())
  assert(res.statusCode === 403, `backfill must be Owner-only, expected 403 for marketing, got ${res.statusCode}`)
}

async function testSeedsFromFixtureIntoEmptyStore() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  _setLegacyBackfillDataForTests(FIXTURE_LEGACY, FIXTURE_META)
  const res = await invoke(await ownerToken())
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
  assert(res.body.seeded.length === 2, `expected 2 valid rows seeded, got ${JSON.stringify(res.body.seeded)}`)
  assert(res.body.seeded.includes(9) && res.body.seeded.includes(2), 'both valid locations must be seeded')
  assert(!res.body.seeded.includes(5), 'the malformed-email row must be skipped, not seeded')

  const canton = await getContact(DEFAULT_TENANT_ID, 9)
  assert(canton.primaryEmail === 'canton@example.com', 'seeded record must carry the legacy email')
  assert(canton.managerName === 'Legacy Canton Manager', 'seeded record must carry the legacy manager name')
  assert(canton.locationName === 'Los Tres Amigos Canton', 'seeded record must resolve the location name from meta.json')
  assert(canton.active === true, 'a backfilled contact must be active by default')
}

async function testNeverOverwritesAnExistingRedisRecord() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  _setLegacyBackfillDataForTests(FIXTURE_LEGACY, FIXTURE_META)

  // Location 9 already has a Redis-native record (e.g. edited through
  // Settings) -- the backfill must never clobber it with the stale legacy
  // value, even though the legacy file also has an entry for it.
  const owner = { userId: 'usr_owner', email: 'owner@example.com', displayName: 'Owner Person' }
  const { upsertContact } = await import('../dashboard/api/_lib/contactStore.js')
  await upsertContact(DEFAULT_TENANT_ID, 9, { primaryEmail: 'already-edited@example.com', locationName: 'Los Tres Amigos Canton' }, owner, 'Contact created')

  const res = await invoke(await ownerToken())
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.skipped.includes(9), 'location 9 must be reported as skipped, not re-seeded')
  assert(res.body.seeded.includes(2), 'location 2 (never configured) must still be seeded')

  const canton = await getContact(DEFAULT_TENANT_ID, 9)
  assert(canton.primaryEmail === 'already-edited@example.com', 'the existing Redis record must be completely untouched by the backfill')
}

async function testIdempotentAcrossRepeatedRuns() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  _setLegacyBackfillDataForTests(FIXTURE_LEGACY, FIXTURE_META)

  const first = await invoke(await ownerToken())
  assert(first.body.seeded.length === 2, 'first run seeds both valid locations')

  const second = await invoke(await ownerToken())
  assert(second.statusCode === 200, `second run must succeed, got ${second.statusCode}`)
  assert(second.body.seeded.length === 0, 'a second run must seed nothing new -- everything is already in Redis')
  assert(second.body.skipped.length === 2, 'a second run must report both locations as skipped')
}

async function testEmptyLegacyDataSeedsNothingWithoutError() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setLegacyBackfillDataForTests({}, { locations: [] })
  const res = await invoke(await ownerToken())
  assert(res.statusCode === 200, `expected 200 even with no legacy data, got ${res.statusCode}`)
  assert(res.body.seeded.length === 0 && res.body.skipped.length === 0, 'no legacy data means nothing seeded or skipped')
}

async function main() {
  await run('backfill rejects marketing (Owner-only)', testRejectsMarketing)
  await run('backfill seeds valid rows from the legacy fixture, skips malformed emails', testSeedsFromFixtureIntoEmptyStore)
  await run('backfill never overwrites an existing Redis record', testNeverOverwritesAnExistingRedisRecord)
  await run('backfill is idempotent across repeated runs', testIdempotentAcrossRepeatedRuns)
  await run('empty legacy data seeds nothing, without error', testEmptyLegacyDataSeedsNothingWithoutError)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
