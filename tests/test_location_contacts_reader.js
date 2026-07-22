// Regression tests for dashboard/api/_lib/locationContacts.js -- the
// server-side-only reader for private-data/location-contacts.json. Uses the
// module's test-only seam (_setContactsForTests) rather than touching the
// real filesystem path, same pattern as actionStore.js's
// _setRedisClientForTests.
//
// Run directly: node tests/test_location_contacts_reader.js

import {
  getLocationContact,
  _setContactsForTests,
  _resetContactsForTests,
} from '../dashboard/api/_lib/locationContacts.js'

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
  }
}

async function testReturnsConfiguredContact() {
  _setContactsForTests({ '3': { email: 'manager@example.com', name: 'Jane' } })
  const contact = await getLocationContact(3)
  assert(contact.email === 'manager@example.com', 'expected the configured contact to be returned')
  assert(contact.name === 'Jane')
}

async function testReturnsNullForUnconfiguredLocation() {
  _setContactsForTests({ '3': { email: 'manager@example.com', name: null } })
  const contact = await getLocationContact(999)
  assert(contact === null, 'a location absent from the map must resolve to null, never a guessed value')
}

async function testCoercesNumericLocationIdToStringKey() {
  _setContactsForTests({ '42': { email: 'x@example.com', name: null } })
  const byNumber = await getLocationContact(42)
  const byString = await getLocationContact('42')
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
  const contact = await getLocationContact(1)
  assert(contact === null, 'a missing location-contacts.json must resolve to null, never throw')
}

async function main() {
  await run('returns the configured contact for a known locationId', testReturnsConfiguredContact)
  await run('returns null (never a guessed value) for an unconfigured locationId', testReturnsNullForUnconfiguredLocation)
  await run('numeric and string locationId both resolve correctly', testCoercesNumericLocationIdToStringKey)
  await run('a genuinely missing location-contacts.json falls back to null, not a throw', testMissingRealFileFallsBackGracefully)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
