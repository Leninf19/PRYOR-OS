// Regression tests for dashboard/api/_lib/campaignStore.js -- the shared
// Campaign entity Calendar and Content both reference. Same fakeRedis()
// test-seam pattern as test_task_store.js/test_action_store.js.
//
// Run directly: node tests/test_campaign_store.js

import {
  getAllCampaigns, getCampaign, createCampaign, updateCampaign, deleteCampaign, generateCampaignId,
  CampaignStoreUnavailableError, _setRedisClientForTests, _resetRedisClientForTests,
} from '../dashboard/api/_lib/campaignStore.js'

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

function fakeRedis(initial = {}) {
  const store = { ...initial }
  return {
    hgetall: async () => ({ ...store }),
    hget: async (_key, field) => store[field] ?? null,
    hset: async (_key, fields) => { Object.assign(store, fields) },
    hdel: async (_key, field) => { const had = field in store; delete store[field]; return had ? 1 : 0 },
  }
}

const OWNER = { userId: 'usr_owner', email: 'owner@example.com', displayName: 'Owner' }
const CAMPAIGN_FIELDS = { name: 'Kids Eat Free — Wednesdays', description: 'Weekly kids promo', startDate: '2026-09-01', endDate: '2026-12-31', locationIds: [1, 2, 3], tags: ['kids', 'weekly'] }

async function testCreateCampaignAlwaysStartsDraftRegardlessOfInput() {
  _setRedisClientForTests(() => fakeRedis())
  const record = await createCampaign({ ...CAMPAIGN_FIELDS, status: 'Approved' }, OWNER)
  assert(record.status === 'Draft', 'a newly created campaign must always start Draft, ignoring any client-supplied status')
}

async function testCreateCampaignGeneratesStableUniqueIds() {
  _setRedisClientForTests(() => fakeRedis())
  const a = await createCampaign(CAMPAIGN_FIELDS, OWNER)
  const b = await createCampaign(CAMPAIGN_FIELDS, OWNER)
  assert(a.id.startsWith('campaign_') && a.id !== b.id, 'each campaign gets a unique, stable id')
  assert(generateCampaignId() !== generateCampaignId(), 'generateCampaignId never repeats')
}

async function testUpdateCampaignTransitionsStatus() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const created = await createCampaign(CAMPAIGN_FIELDS, OWNER)
  const approved = await updateCampaign(created.id, { status: 'Approved' }, OWNER)
  assert(approved.status === 'Approved', 'status transitions to Approved')
  const archived = await updateCampaign(created.id, { status: 'Archived' }, OWNER)
  assert(archived.status === 'Archived', 'status transitions to Archived')
}

async function testUpdateCampaignPreservesCreatedByAndStampsUpdatedBy() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const created = await createCampaign(CAMPAIGN_FIELDS, OWNER)
  const MARKETING = { userId: 'usr_marketing', email: 'marketing@example.com', displayName: 'Marketing' }
  const updated = await updateCampaign(created.id, { status: 'Approved' }, MARKETING)
  assert(updated.createdBy === 'usr_owner', 'createdBy never changes')
  assert(updated.updatedBy === 'usr_marketing', 'updatedBy reflects the latest actor')
}

async function testUpdateCampaignReturnsNullForUnknownId() {
  _setRedisClientForTests(() => fakeRedis())
  assert(await updateCampaign('does-not-exist', { status: 'Approved' }, OWNER) === null, 'updating an unknown campaign returns null')
}

async function testDeleteCampaignRemovesRecord() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const created = await createCampaign(CAMPAIGN_FIELDS, OWNER)
  assert(await deleteCampaign(created.id) === true, 'deleting an existing campaign returns true')
  assert(await getCampaign(created.id) === null, 'the campaign is genuinely gone')
}

async function testUnconfiguredStoreThrows() {
  let threwRead = false, threwWrite = false
  try { await getAllCampaigns() } catch (err) { threwRead = err instanceof CampaignStoreUnavailableError }
  try { await createCampaign(CAMPAIGN_FIELDS, OWNER) } catch (err) { threwWrite = err instanceof CampaignStoreUnavailableError }
  assert(threwRead && threwWrite, 'an unconfigured store must throw on read and write, never silently degrade')
}

const tests = [
  ['a new campaign always starts Draft, regardless of client-supplied status', testCreateCampaignAlwaysStartsDraftRegardlessOfInput],
  ['createCampaign generates stable, unique ids', testCreateCampaignGeneratesStableUniqueIds],
  ['updateCampaign transitions Draft -> Approved -> Archived', testUpdateCampaignTransitionsStatus],
  ['updateCampaign preserves createdBy and stamps the latest updatedBy', testUpdateCampaignPreservesCreatedByAndStampsUpdatedBy],
  ['updateCampaign returns null for an unknown id', testUpdateCampaignReturnsNullForUnknownId],
  ['deleteCampaign removes the record', testDeleteCampaignRemovesRecord],
  ['an unconfigured store throws, never silently degrades', testUnconfiguredStoreThrows],
]

async function main() {
  for (const [name, fn] of tests) await run(name, fn)
  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
