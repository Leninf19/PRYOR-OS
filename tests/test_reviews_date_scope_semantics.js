// Google Integration + Reviews End-to-End Validation, Part C -- regression
// coverage for the actual date-range/all-time semantics behind the
// "15,975 reviews / 605 need reply" (header, all-time) vs. "0 reviews /
// Needs Reply (0)" (Reviews page, current date range) family of numbers.
// Exercises the real, framework-free utility functions the UI is built
// on -- dataUtils.js's getDefaultDateRange()/filterReviews() and
// replyState.js's computeReplyStateCounts()/isActionableReplyState() --
// never a re-implementation.
//
// Run directly: node tests/test_reviews_date_scope_semantics.js

import { filterReviews, getDefaultDateRange } from '../dashboard/src/utils/dataUtils.js'
import { computeReplyState, computeReplyStateCounts, isActionableReplyState } from '../dashboard/src/utils/replyState.js'

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

function iso(daysAgo) {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
}

// A fixture mirroring the real reported shape: a large all-time backlog
// (unanswered reviews), none of them dated within the last 7 days -- the
// exact condition that produces "605 need reply" (header) alongside
// "Needs Reply (0)" (Reviews page, default range).
function buildFixture() {
  const reviews = []
  // 3 old, unanswered reviews (part of the all-time backlog), well outside
  // any 7-day default window.
  for (let i = 0; i < 3; i++) {
    reviews.push({
      review_id: `old-unanswered-${i}`, review_url: `https://g.co/old-${i}`,
      location_name: 'Location One', star_rating: 2, review_date: iso(60 + i), owner_response: '',
    })
  }
  // 2 old, ALREADY-answered reviews (not part of any backlog).
  for (let i = 0; i < 2; i++) {
    reviews.push({
      review_id: `old-answered-${i}`, review_url: `https://g.co/old-answered-${i}`,
      location_name: 'Location One', star_rating: 5, review_date: iso(90 + i), owner_response: 'Thank you!',
    })
  }
  // 1 recent, unanswered review -- inside the default 7-day window, so it
  // SHOULD show up in both the all-time backlog and the current-range one.
  reviews.push({
    review_id: 'recent-unanswered', review_url: 'https://g.co/recent',
    location_name: 'Location Two', star_rating: 1, review_date: iso(1), owner_response: '',
  })
  return reviews
}

// ===========================================================================
// #1: the default date range is a rolling 7-day window, not "all time" --
// the exact mechanism behind the reported 0-vs-15,975 gap.
// ===========================================================================

function testDefaultDateRangeIsARolling7DayWindowNotAllTime() {
  const reviews = buildFixture()
  const range = getDefaultDateRange(reviews)
  const spanDays = Math.round((new Date(range.end) - new Date(range.start)) / 86_400_000)
  assert(spanDays === 7, `expected exactly a 7-day span, got ${spanDays} (start=${range.start}, end=${range.end})`)
  assert(range.start > iso(60), 'the default range must NOT reach back far enough to include a 60-day-old review')
}

// ===========================================================================
// #2 + #3: all-time totals vs. current-date-range totals must genuinely
// differ for the same fixture, and the "needs reply" counts under each
// scope must be independently correct (never silently equal by coincidence).
// ===========================================================================

function testAllTimeTotalsDifferFromCurrentRangeTotals() {
  const reviews = buildFixture()
  const range = getDefaultDateRange(reviews)
  const currentRange = filterReviews(reviews, { start: range.start, end: range.end })

  assert(reviews.length === 6, 'sanity: the all-time fixture has 6 reviews')
  assert(currentRange.length === 1, `the current (default 7-day) range must contain only the one recent review, got ${currentRange.length}`)
  assert(reviews.length !== currentRange.length, 'all-time and current-range totals must genuinely differ for this fixture -- this IS the real, legitimate mechanism behind the reported gap, not a bug')
}

function testAllTimeNeedsReplyBacklogVsCurrentRangeNeedsReply() {
  const reviews = buildFixture()
  const range = getDefaultDateRange(reviews)
  const currentRange = filterReviews(reviews, { start: range.start, end: range.end })

  const allTimeCounts = computeReplyStateCounts(reviews, {}, {})
  const currentRangeCounts = computeReplyStateCounts(currentRange, {}, {})

  assert(allTimeCounts.needs_reply === 4, `expected 4 all-time unanswered reviews (3 old + 1 recent), got ${allTimeCounts.needs_reply}`)
  assert(currentRangeCounts.needs_reply === 1, `expected only the 1 recent unanswered review in the current range, got ${currentRangeCounts.needs_reply}`)
  assert(allTimeCounts.needs_reply > currentRangeCounts.needs_reply, 'the all-time backlog must be strictly larger than the current-range count for this fixture -- proving the two are legitimately different scopes, not a data bug')
}

// ===========================================================================
// The specific misleading-empty-state condition this phase fixed: a
// fixture where the CURRENT range has ZERO actionable reviews but the
// all-time set genuinely does -- the Reviews page must be able to tell
// these apart (this is exactly Reviews.jsx's
// hasActionableReviewsOutsideCurrentRange computation, mirrored here as a
// pure-logic proof against the same underlying functions it calls).
// ===========================================================================

function testZeroInCurrentRangeCanCoexistWithARealAllTimeBacklog() {
  const reviews = buildFixture().filter(r => r.review_id !== 'recent-unanswered') // remove the one review that would appear in BOTH scopes
  const range = getDefaultDateRange(reviews)
  const currentRange = filterReviews(reviews, { start: range.start, end: range.end })
  const currentRangeCounts = computeReplyStateCounts(currentRange, {}, {})
  const hasAnyActionableAllTime = reviews.some(r => isActionableReplyState(computeReplyState(r, undefined, undefined)))

  assert(currentRangeCounts.needs_reply === 0, 'the current range must show zero -- there is genuinely nothing dated within the last 7 days')
  assert(hasAnyActionableAllTime === true, 'the all-time set must still show a real backlog exists -- "0 in range" must never be read as "nothing to do" when this is true')
}

function testGenuinelyAllCaughtUpHasNoAllTimeBacklogEither() {
  // Every review answered, none actionable at any scope -- the ONE case
  // where "You're all caught up" is actually true.
  const reviews = [
    { review_id: 'r1', review_url: 'https://g.co/r1', location_name: 'Location One', star_rating: 5, review_date: iso(30), owner_response: 'Thanks!' },
    { review_id: 'r2', review_url: 'https://g.co/r2', location_name: 'Location One', star_rating: 4, review_date: iso(1), owner_response: 'Thanks!' },
  ]
  const hasAnyActionableAllTime = reviews.some(r => isActionableReplyState(computeReplyState(r, undefined, undefined)))
  assert(hasAnyActionableAllTime === false, 'a genuinely fully-answered review set must report no all-time backlog at all')
}

// ===========================================================================
// Location-scoped vs. wildcard semantics: filterReviews()'s own location
// filter (the same mechanism GlobalFilters.jsx drives) must scope
// consistently regardless of the date range applied alongside it.
// ===========================================================================

function testLocationFilterAndDateFilterComposeIndependently() {
  const reviews = buildFixture()
  const range = getDefaultDateRange(reviews)
  const scopedToLocationTwo = filterReviews(reviews, { start: range.start, end: range.end, locations: ['Location Two'] })
  const scopedToLocationOne = filterReviews(reviews, { start: range.start, end: range.end, locations: ['Location One'] })
  assert(scopedToLocationTwo.length === 1 && scopedToLocationTwo[0].review_id === 'recent-unanswered')
  assert(scopedToLocationOne.length === 0, "Location One's only reviews are all outside the current default range")

  const wildcard = filterReviews(reviews, { start: range.start, end: range.end })
  assert(wildcard.length === 1, 'an unscoped (wildcard) view over the same date range must see the union of every location')
}

const tests = [
  ['the default date range is a rolling 7-day window, not all-time', testDefaultDateRangeIsARolling7DayWindowNotAllTime],
  ['all-time totals genuinely differ from current-date-range totals for a realistic fixture', testAllTimeTotalsDifferFromCurrentRangeTotals],
  ['the all-time needs-reply backlog can be strictly larger than the current-range needs-reply count', testAllTimeNeedsReplyBacklogVsCurrentRangeNeedsReply],
  ['zero actionable reviews in the current range can coexist with a real all-time backlog', testZeroInCurrentRangeCanCoexistWithARealAllTimeBacklog],
  ['a genuinely fully-answered review set has no all-time backlog either (the one true "all caught up" case)', testGenuinelyAllCaughtUpHasNoAllTimeBacklogEither],
  ['location filtering and date filtering compose independently, for both scoped and wildcard views', testLocationFilterAndDateFilterComposeIndependently],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
