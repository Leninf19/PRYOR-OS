// Cross-language consistency check -- Multi-Tenant Phase 4F. Node's
// tenantConfigStore.js and Python's tenant_config_store.py both read and
// write the literal same tenant_config:v1 Upstash Redis hash; there must
// be exactly ONE record shape, never two independently-evolving copies
// that can silently drift apart.
//
// There is no live shared Redis available to two separate test runners in
// different languages, so this file implements the fallback the review
// explicitly allows: both languages' test suites validate their own
// default-producing function against the SAME committed JSON fixture
// (tests/fixtures/tenant_config_shape.json) -- see
// test_tenant_config_cross_language_consistency.py for the Python half.
//
// Run directly: node tests/test_tenant_config_cross_language_consistency.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  upsertTenantConfig,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(path.resolve(__dirname, 'fixtures', 'tenant_config_shape.json'), 'utf-8'))

const TEST_TENANT_ID = 't_synthetic-cross-language-tenant'

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
    resetConfigRedis()
  }
}

function fakeHashRedis() {
  const store = {}
  return {
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
  }
}

async function freshDefaultRecord(patch = {}) {
  setConfigRedis(() => fakeHashRedis())
  return upsertTenantConfig(TEST_TENANT_ID, patch)
}

async function testNodeDefaultRecordHasExactlyTheFixturesTopLevelFields() {
  const record = await freshDefaultRecord()
  const actualFields = new Set(Object.keys(record).filter(k => k !== 'createdAt' && k !== 'updatedAt'))
  const expectedFields = new Set(fixture.topLevelFields.filter(k => k !== 'createdAt' && k !== 'updatedAt'))
  assert(actualFields.size === expectedFields.size && [...expectedFields].every(f => actualFields.has(f)),
    `tenantConfigStore.js's default record fields have drifted from the shared fixture -- got [${[...actualFields].sort()}], expected [${[...expectedFields].sort()}]`)
}

async function testNodeDefaultProvisioningSubObjectMatchesFixture() {
  const record = await freshDefaultRecord()
  const actual = new Set(Object.keys(record.provisioning))
  const expected = new Set(fixture.provisioningFields)
  assert(actual.size === expected.size && [...expected].every(f => actual.has(f)),
    'the provisioning sub-object\'s fields have drifted from the shared fixture')
}

async function testNodeDefaultValuesMatchFixture() {
  const record = await freshDefaultRecord()
  for (const [field, expectedValue] of Object.entries(fixture.defaultValues)) {
    assert(JSON.stringify(record[field]) === JSON.stringify(expectedValue),
      `default value for ${field} has drifted from the shared fixture: got ${JSON.stringify(record[field])}, expected ${JSON.stringify(expectedValue)}`)
  }
}

async function testNodeAcceptsEveryFixtureListedStatusRejectsUnlisted() {
  for (const status of fixture.validStatuses) {
    const record = await freshDefaultRecord({ status })
    assert(record.status === status, `status ${status} must be accepted`)
  }
  let threw = false
  try {
    await freshDefaultRecord({ status: 'not-in-the-fixture-at-all' })
  } catch {
    threw = true
  }
  assert(threw, 'a status not listed in the shared fixture must be rejected')
}

async function main() {
  await run('Node default record has exactly the fixture\'s top-level fields', testNodeDefaultRecordHasExactlyTheFixturesTopLevelFields)
  await run('Node default provisioning sub-object matches fixture', testNodeDefaultProvisioningSubObjectMatchesFixture)
  await run('Node default values match fixture', testNodeDefaultValuesMatchFixture)
  await run('Node accepts every fixture-listed status, rejects unlisted', testNodeAcceptsEveryFixtureListedStatusRejectsUnlisted)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exitCode = 0
    return
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exitCode = 1
}

main()
