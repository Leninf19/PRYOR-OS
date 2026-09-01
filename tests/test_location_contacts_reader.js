// Regression tests for dashboard/api/_lib/locationContacts.js -- the
// server-side-only resolver for a single location's restaurant contact.
// Phase 8, Milestone 8.4/8.5: now Redis-first (contactStore.js), with the
// legacy private-data/location-contacts.json as a fallback only if Redis is
// unreachable/unconfigured. Uses each store's own test-only seam
// (_setContactsForTests for the legacy file, contactStore.js's
// _setRedisClientForTests for Redis) rather than touching real
// infrastructure.
//
// Run directly: node tests/test_location_contacts_reader.js

import {
  getLocationContact,
  _setContactsForTests,
  _resetContactsForTests,
} from '../dashboard/api/_lib/locationContacts.js'
import {
  _setRedisClientForTests,
  _resetRedisClientForTests,
} from '../dashboard/api/_lib/contactStore.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

function fakeRedis(initial = {}) {
  const store = { ...initial }
  // hgetall included (always empty) so tenantDualRead.js's "is the v2 key
  // populated" check succeeds and correctly falls through to hget against
  // the v1 key -- a real Upstash client always supports both commands;
  // this fake previously only modeled hget, which happened to work before
  // Multi-Tenant Phase 2 added a dual-read check ahead of every read.
  return {
    hget: async (_key, field) => store[field] ?? null,
    hgetall: async () => ({}),
  }
}

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
    _resetContactsForTests()
    _resetRedisClientForTests()
  }
}

async function testReturnsConfiguredContact() {
  _setContactsForTests({ '3': { email: 'manager@example.com', name: 'Jane' } })
  const contact = await getLocationContact(DEFAULT_TENANT_ID, 3)
  assert(contact.email === 'manager@example.com', 'expected the configured contact to be returned')
  assert(contact.name === 'Jane')
}

async function testReturnsNullForUnconfiguredLocation() {
  _setContactsForTests({ '3': { email: 'manager@example.com', name: null } })
  const contact = await getLocationContact(DEFAULT_TENANT_ID, 999)
  assert(contact === null, 'a location absent from the map must resolve to null, never a guessed value')
}

async function testCoercesNumericLocationIdToStringKey() {
  _setContactsForTests({ '42': { email: 'x@example.com', name: null } })
  const byNumber = await getLocationContact(DEFAULT_TENANT_ID, 42)
  const byString = await getLocationContact(DEFAULT_TENANT_ID, '42')
  assert(byNumber?.email === 'x@example.com', 'a numeric locationId must match the string-keyed map')
  assert(byString?.email === 'x@example.com', 'a string locationId must also match')
}

async function testMissingRealFileFallsBackGracefully() {
  // No test seam applied -- exercises the real fs.readFile path against
  // whatever's actually on disk. In this checkout, no pipeline run has ever
  // produced dashboard/private-data/location-contacts.json (no real
  // contact emails exist yet -- see set_location_contacts.py --status),
  // so this proves the "file doesn't exist" path resolves to null rather
  // than throwing, exactly like an unconfigured location would.
  const contact = await getLocationContact(DEFAULT_TENANT_ID, 1)
  assert(contact === null, 'a missing location-contacts.json must resolve to null, never throw')
}

async function testRedisContactTakesPriorityOverLegacyFile() {
  _setContactsForTests({ '9': { email: 'legacy@example.com', name: 'Legacy Name' } })
  _setRedisClientForTests(() => fakeRedis({ 9: JSON.stringify({ locationId: 9, primaryEmail: 'redis@example.com', managerName: 'Redis Name', active: true }) }))
  const contact = await getLocationContact(DEFAULT_TENANT_ID, 9)
  assert(contact.email === 'redis@example.com', 'a Redis-configured contact must win over the legacy file')
  assert(contact.name === 'Redis Name')
}

async function testRedisUnavailableFallsBackToLegacyFile() {
  _setContactsForTests({ '9': { email: 'legacy@example.com', name: 'Legacy Name' } })
  _setRedisClientForTests(() => ({ hget: async () => { throw new Error('ECONNREFUSED fake-upstash-outage') } }))
  const contact = await getLocationContact(DEFAULT_TENANT_ID, 9)
  assert(contact.email === 'legacy@example.com', 'a Redis outage must fall back to the legacy file, not fail the whole lookup')
}

async function testRedisContactExplicitlyDisabledNeverFallsBackToLegacy() {
  // A contact that exists in Redis but is explicitly disabled must resolve
  // to null -- never silently fall back to a stale legacy entry, which
  // would resurrect an intentionally-disabled contact.
  _setContactsForTests({ '9': { email: 'legacy@example.com', name: 'Legacy Name' } })
  _setRedisClientForTests(() => fakeRedis({ 9: JSON.stringify({ locationId: 9, primaryEmail: 'redis@example.com', active: false }) }))
  const contact = await getLocationContact(DEFAULT_TENANT_ID, 9)
  assert(contact === null, 'an explicitly disabled Redis contact must resolve to null, never the legacy fallback')
}

async function main() {
  await run('returns the configured contact for a known locationId', testReturnsConfiguredContact)
  await run('returns null (never a guessed value) for an unconfigured locationId', testReturnsNullForUnconfiguredLocation)
  await run('numeric and string locationId both resolve correctly', testCoercesNumericLocationIdToStringKey)
  await run('a genuinely missing location-contacts.json falls back to null, not a throw', testMissingRealFileFallsBackGracefully)
  await run('a Redis-configured contact takes priority over the legacy file', testRedisContactTakesPriorityOverLegacyFile)
  await run('a Redis outage falls back to the legacy file', testRedisUnavailableFallsBackToLegacyFile)
  await run('an explicitly disabled Redis contact resolves to null, never the legacy fallback', testRedisContactExplicitlyDisabledNeverFallsBackToLegacy)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
