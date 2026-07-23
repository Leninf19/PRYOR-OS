// Regression tests for dashboard/src/utils/emailValidation.js (Phase 8,
// Milestone 8.4) -- pure, deterministic logic with no React/DOM dependency,
// so it can be imported and exercised directly under plain Node (same
// technique test_priority_digest.js/test_action_workspace_utils.js use).
//
// Run directly: node tests/test_email_validation.js

import { isValidEmailFormat, findDuplicatePrimaryEmail } from '../dashboard/src/utils/emailValidation.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
function run(name, fn) {
  try {
    fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  }
}

function testValidEmailsPass() {
  for (const email of ['a@b.com', 'manager@restaurant.co', 'first.last+tag@example.com', '  padded@example.com  ']) {
    assert(isValidEmailFormat(email), `expected "${email}" to be valid`)
  }
}

function testInvalidEmailsFail() {
  for (const email of ['not-an-email', 'missing-at.com', '@no-local.com', 'no-domain@', 'spaces in@email.com', '', null, undefined, 42]) {
    assert(!isValidEmailFormat(email), `expected ${JSON.stringify(email)} to be invalid`)
  }
}

function testFindDuplicatePrimaryEmailDetectsCaseInsensitiveMatch() {
  const contacts = {
    9: { locationId: 9, primaryEmail: 'Canton@Example.com' },
    2: { locationId: 2, primaryEmail: 'chelsea@example.com' },
  }
  const dupe = findDuplicatePrimaryEmail('canton@example.com', contacts, 5)
  assert(dupe?.locationId === 9, 'must find the duplicate regardless of case')
}

function testFindDuplicatePrimaryEmailExcludesOwnLocation() {
  const contacts = { 9: { locationId: 9, primaryEmail: 'canton@example.com' } }
  const dupe = findDuplicatePrimaryEmail('canton@example.com', contacts, 9)
  assert(dupe === null, 'editing a contact must never flag its own unchanged email as a duplicate of itself')
}

function testFindDuplicatePrimaryEmailReturnsNullWhenNoMatch() {
  const contacts = { 9: { locationId: 9, primaryEmail: 'canton@example.com' } }
  const dupe = findDuplicatePrimaryEmail('nobody-else@example.com', contacts, 2)
  assert(dupe === null, 'no match must return null')
}

function testFindDuplicatePrimaryEmailHandlesEmptyOrInvalidInput() {
  assert(findDuplicatePrimaryEmail('not-an-email', {}, 1) === null, 'an invalid email format is never checked for duplicates')
  assert(findDuplicatePrimaryEmail('', {}, 1) === null, 'an empty string returns null, not a crash')
  assert(findDuplicatePrimaryEmail('a@b.com', null, 1) === null, 'a null/undefined contacts map must not throw')
  assert(findDuplicatePrimaryEmail('a@b.com', undefined, 1) === null, 'a null/undefined contacts map must not throw')
}

function main() {
  run('valid email formats pass', testValidEmailsPass)
  run('invalid email formats fail', testInvalidEmailsFail)
  run('findDuplicatePrimaryEmail detects a case-insensitive match', testFindDuplicatePrimaryEmailDetectsCaseInsensitiveMatch)
  run('findDuplicatePrimaryEmail excludes the contact\'s own location', testFindDuplicatePrimaryEmailExcludesOwnLocation)
  run('findDuplicatePrimaryEmail returns null when there is no match', testFindDuplicatePrimaryEmailReturnsNullWhenNoMatch)
  run('findDuplicatePrimaryEmail handles empty/invalid input without throwing', testFindDuplicatePrimaryEmailHandlesEmptyOrInvalidInput)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
