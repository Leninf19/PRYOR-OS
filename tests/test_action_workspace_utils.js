// Regression tests for dashboard/src/utils/actionWorkspaceUtils.js -- pure,
// deterministic logic with no React/DOM dependency, so it can be imported
// and exercised directly under plain Node (same technique
// test_priority_digest.js already uses).
//
// Run directly: node tests/test_action_workspace_utils.js

import {
  isOverdue,
  isEmailFollowUpOverdue,
  EMAIL_STATUS_META,
  DUPLICATE_EMAIL_STATUSES,
  EMAIL_STATUS_TRANSITIONABLE_FROM,
  todayISODate,
} from '../dashboard/src/utils/actionWorkspaceUtils.js'

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

const YESTERDAY = '2020-01-01' // always in the past regardless of when this runs
const FAR_FUTURE = '2099-01-01'

function testIsOverdueTrueForPastDueOpenTask() {
  assert(isOverdue({ status: 'Assigned', dueDate: YESTERDAY }) === true)
}

function testIsOverdueFalseForCompletedTask() {
  assert(isOverdue({ status: 'Completed', dueDate: YESTERDAY }) === false, 'a Completed task must never be overdue regardless of dueDate')
}

function testIsOverdueFalseForDismissedTask() {
  assert(isOverdue({ status: 'Dismissed', dueDate: YESTERDAY }) === false)
}

function testIsOverdueFalseWithNoDueDate() {
  assert(isOverdue({ status: 'Assigned', dueDate: null }) === false)
  assert(isOverdue({ status: 'Assigned' }) === false)
}

function testIsOverdueFalseForFutureDueDate() {
  assert(isOverdue({ status: 'Assigned', dueDate: FAR_FUTURE }) === false)
}

function testIsEmailFollowUpOverdueTrueForSentPastDue() {
  assert(isEmailFollowUpOverdue({ emailStatus: 'sent', emailFollowUpDueAt: YESTERDAY }) === true)
}

function testIsEmailFollowUpOverdueTrueForFollowUpRequiredPastDue() {
  assert(isEmailFollowUpOverdue({ emailStatus: 'follow_up_required', emailFollowUpDueAt: YESTERDAY }) === true)
}

function testIsEmailFollowUpOverdueFalseForResolved() {
  assert(isEmailFollowUpOverdue({ emailStatus: 'resolved', emailFollowUpDueAt: YESTERDAY }) === false, 'a resolved thread must never be overdue')
}

function testIsEmailFollowUpOverdueFalseForReplied() {
  assert(isEmailFollowUpOverdue({ emailStatus: 'replied', emailFollowUpDueAt: YESTERDAY }) === false)
}

function testIsEmailFollowUpOverdueFalseForFailed() {
  assert(isEmailFollowUpOverdue({ emailStatus: 'failed', emailFollowUpDueAt: YESTERDAY }) === false)
}

function testIsEmailFollowUpOverdueFalseWithNoFollowUpDate() {
  assert(isEmailFollowUpOverdue({ emailStatus: 'sent', emailFollowUpDueAt: null }) === false)
  assert(isEmailFollowUpOverdue({ emailStatus: 'sent' }) === false)
  assert(isEmailFollowUpOverdue(undefined) === false)
}

function testIsEmailFollowUpOverdueFalseForFutureDueDate() {
  assert(isEmailFollowUpOverdue({ emailStatus: 'sent', emailFollowUpDueAt: FAR_FUTURE }) === false)
}

function testEmailStatusMetaCoversFullEnum() {
  for (const status of ['not_sent', 'sent', 'replied', 'follow_up_required', 'resolved', 'failed']) {
    assert(EMAIL_STATUS_META[status], `EMAIL_STATUS_META must define "${status}"`)
    assert(typeof EMAIL_STATUS_META[status].label === 'string' && EMAIL_STATUS_META[status].label.length > 0)
    assert(typeof EMAIL_STATUS_META[status].variant === 'string')
  }
}

function testDuplicateAndTransitionableSetsExcludeNotSentAndFailedAppropriately() {
  assert(!DUPLICATE_EMAIL_STATUSES.has('not_sent'), 'not_sent must never be treated as a duplicate')
  assert(!DUPLICATE_EMAIL_STATUSES.has('failed'), 'a failed send must never be treated as a duplicate (it never reached the restaurant)')
  assert(DUPLICATE_EMAIL_STATUSES.has('sent'))

  assert(!EMAIL_STATUS_TRANSITIONABLE_FROM.has('not_sent'), 'a manual transition must never be reachable before any send')
  assert(!EMAIL_STATUS_TRANSITIONABLE_FROM.has('failed'), 'a manual transition must never be reachable from a failed send')
  assert(EMAIL_STATUS_TRANSITIONABLE_FROM.has('sent'))
  assert(EMAIL_STATUS_TRANSITIONABLE_FROM.has('replied'), 'replied -> resolved (a further manual transition) must remain reachable')
}

function testTodayISODateFormat() {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(todayISODate()), 'todayISODate must return YYYY-MM-DD')
}

const tests = [
  ['isOverdue: true for a past-due open task', testIsOverdueTrueForPastDueOpenTask],
  ['isOverdue: false for a Completed task regardless of due date', testIsOverdueFalseForCompletedTask],
  ['isOverdue: false for a Dismissed task', testIsOverdueFalseForDismissedTask],
  ['isOverdue: false with no due date', testIsOverdueFalseWithNoDueDate],
  ['isOverdue: false for a future due date', testIsOverdueFalseForFutureDueDate],
  ['isEmailFollowUpOverdue: true for sent + past due', testIsEmailFollowUpOverdueTrueForSentPastDue],
  ['isEmailFollowUpOverdue: true for follow_up_required + past due', testIsEmailFollowUpOverdueTrueForFollowUpRequiredPastDue],
  ['isEmailFollowUpOverdue: false for resolved', testIsEmailFollowUpOverdueFalseForResolved],
  ['isEmailFollowUpOverdue: false for replied', testIsEmailFollowUpOverdueFalseForReplied],
  ['isEmailFollowUpOverdue: false for failed', testIsEmailFollowUpOverdueFalseForFailed],
  ['isEmailFollowUpOverdue: false with no follow-up date', testIsEmailFollowUpOverdueFalseWithNoFollowUpDate],
  ['isEmailFollowUpOverdue: false for a future follow-up date', testIsEmailFollowUpOverdueFalseForFutureDueDate],
  ['EMAIL_STATUS_META covers the full enum with label+variant', testEmailStatusMetaCoversFullEnum],
  ['duplicate/transitionable sets correctly exclude not_sent/failed', testDuplicateAndTransitionableSetsExcludeNotSentAndFailedAppropriately],
  ['todayISODate returns YYYY-MM-DD', testTodayISODateFormat],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
