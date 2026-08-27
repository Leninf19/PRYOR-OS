// Regression tests for dashboard/api/_lib/taskRecurrence.js -- pure,
// deterministic recurrence expansion, no Redis/API dependency, same style
// test_priority_digest.js already uses for pure logic.
//
// Run directly: node tests/test_task_recurrence.js

import { expandOccurrences, expandAllOccurrences } from '../dashboard/api/_lib/taskRecurrence.js'

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

function task(overrides) {
  return {
    id: 'task_1', title: 'Test task', type: 'operations', locationIds: '*',
    startAt: '2026-08-05T09:00:00.000Z', endAt: '2026-08-05T10:00:00.000Z',
    allDay: false, priority: 'Medium', status: 'Scheduled', recurrence: null,
    ...overrides,
  }
}

function testNonRecurringWithinRangeProducesExactlyOneOccurrence() {
  const occs = expandOccurrences(task(), new Date('2026-08-01'), new Date('2026-08-31'))
  assert(occs.length === 1, `expected 1 occurrence, got ${occs.length}`)
  assert(occs[0].isRecurrenceInstance === false, 'a non-recurring task\'s occurrence must be flagged isRecurrenceInstance: false')
  assert(occs[0].occurrenceStart === '2026-08-05T09:00:00.000Z', 'occurrenceStart must equal startAt for a non-recurring task')
}

function testNonRecurringOutsideRangeProducesNoOccurrences() {
  const occs = expandOccurrences(task(), new Date('2026-09-01'), new Date('2026-09-30'))
  assert(occs.length === 0, 'a task entirely outside the range must produce no occurrences')
}

function testDailyRecurrenceExpandsEveryDay() {
  const occs = expandOccurrences(task({ recurrence: { freq: 'daily', interval: 1, until: null } }),
    new Date('2026-08-05T00:00:00.000Z'), new Date('2026-08-10T23:59:59.999Z'))
  assert(occs.length === 6, `expected 6 daily occurrences (5th-10th inclusive), got ${occs.length}`)
  assert(occs.every(o => o.isRecurrenceInstance === true), 'every daily occurrence must be flagged isRecurrenceInstance: true')
}

function testWeeklyRecurrenceExpandsEveryWeek() {
  const occs = expandOccurrences(task({ recurrence: { freq: 'weekly', interval: 1, until: null } }),
    new Date('2026-08-01'), new Date('2026-09-30'))
  // 2026-08-05 is a Wednesday; weekly for ~8 weeks -> ~8-9 occurrences.
  assert(occs.length >= 7 && occs.length <= 9, `expected ~8 weekly occurrences, got ${occs.length}`)
  const days = new Set(occs.map(o => new Date(o.occurrenceStart).getDay()))
  assert(days.size === 1, 'every weekly occurrence must fall on the same weekday as the original startAt')
}

function testMonthlyRecurrenceExpandsEveryMonth() {
  const occs = expandOccurrences(task({ recurrence: { freq: 'monthly', interval: 1, until: null } }),
    new Date('2026-08-01'), new Date('2027-01-31'))
  assert(occs.length === 6, `expected 6 monthly occurrences (Aug-Jan inclusive), got ${occs.length}`)
}

function testRecurrenceIntervalGreaterThanOne() {
  const occs = expandOccurrences(task({ recurrence: { freq: 'weekly', interval: 2, until: null } }),
    new Date('2026-08-01'), new Date('2026-09-30'))
  // Every OTHER week -> roughly half of the plain-weekly count.
  assert(occs.length >= 3 && occs.length <= 5, `expected ~4 bi-weekly occurrences, got ${occs.length}`)
}

function testUntilDateStopsExpansion() {
  const occs = expandOccurrences(task({ recurrence: { freq: 'daily', interval: 1, until: '2026-08-08' } }),
    new Date('2026-08-05'), new Date('2026-08-31'))
  assert(occs.every(o => new Date(o.occurrenceStart) <= new Date('2026-08-08T23:59:59.999Z')), 'no occurrence may fall after the until date')
  assert(occs.length <= 4, `expected at most 4 occurrences before/on the until date, got ${occs.length}`)
}

function testNoUntilDateIsBoundedBySafetyCapNotInfiniteLoop() {
  const start = Date.now()
  const occs = expandOccurrences(task({ recurrence: { freq: 'daily', interval: 1, until: null } }),
    new Date('2000-01-01'), new Date('2100-01-01'))
  const elapsedMs = Date.now() - start
  assert(occs.length <= 500, `expected the MAX_OCCURRENCES safety cap (<=500) to bound an unbounded recurrence, got ${occs.length}`)
  assert(elapsedMs < 5000, 'expansion must not hang even over a 100-year unbounded range')
}

function testTimezoneDateBoundaryOccurrenceAtRangeEdgeIsIncluded() {
  // An occurrence whose window straddles the range boundary must still be
  // included -- the check is "does not end before rangeStart / does not
  // start after rangeEnd", not an exact-midnight equality check.
  const t = task({ startAt: '2026-08-05T23:30:00.000Z', endAt: '2026-08-06T00:30:00.000Z' })
  const occs = expandOccurrences(t, new Date('2026-08-05T00:00:00.000Z'), new Date('2026-08-05T23:59:59.999Z'))
  assert(occs.length === 1, 'an occurrence straddling midnight at the range edge must still be included')
}

function testMalformedTaskFailsSafeToEmpty() {
  assert(expandOccurrences({}, new Date(), new Date()).length === 0, 'a task with no startAt must produce zero occurrences, not throw')
  assert(expandOccurrences(task({ startAt: 'not-a-date' }), new Date(), new Date()).length === 0, 'an unparseable startAt must produce zero occurrences, not throw')
  assert(expandOccurrences(task({ recurrence: { freq: 'yearly' } }), new Date('2026-01-01'), new Date('2026-12-31')).length === 0, 'an unsupported recurrence freq must produce zero occurrences, not throw')
}

function testExpandAllOccurrencesFlattensAndSortsChronologically() {
  const a = task({ id: 'a', startAt: '2026-08-10T09:00:00.000Z', endAt: '2026-08-10T09:30:00.000Z' })
  const b = task({ id: 'b', startAt: '2026-08-05T09:00:00.000Z', endAt: '2026-08-05T09:30:00.000Z' })
  const occs = expandAllOccurrences([a, b], new Date('2026-08-01'), new Date('2026-08-31'))
  assert(occs.length === 2, 'both tasks\' single occurrences must be present')
  assert(occs[0].id === 'b' && occs[1].id === 'a', 'occurrences must be sorted chronologically regardless of input order')
}

run('non-recurring task within range produces exactly one occurrence', testNonRecurringWithinRangeProducesExactlyOneOccurrence)
run('non-recurring task outside range produces no occurrences', testNonRecurringOutsideRangeProducesNoOccurrences)
run('daily recurrence expands every day in range', testDailyRecurrenceExpandsEveryDay)
run('weekly recurrence expands every week, same weekday', testWeeklyRecurrenceExpandsEveryWeek)
run('monthly recurrence expands every month', testMonthlyRecurrenceExpandsEveryMonth)
run('recurrence interval > 1 skips occurrences accordingly', testRecurrenceIntervalGreaterThanOne)
run('an until date stops expansion at that date', testUntilDateStopsExpansion)
run('no until date is bounded by the MAX_OCCURRENCES safety cap, not an infinite loop', testNoUntilDateIsBoundedBySafetyCapNotInfiniteLoop)
run('an occurrence straddling a range boundary (timezone/date-boundary behavior) is still included', testTimezoneDateBoundaryOccurrenceAtRangeEdgeIsIncluded)
run('a malformed task/recurrence fails safe to zero occurrences, never throws', testMalformedTaskFailsSafeToEmpty)
run('expandAllOccurrences flattens multiple tasks and sorts chronologically', testExpandAllOccurrencesFlattensAndSortsChronologically)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
