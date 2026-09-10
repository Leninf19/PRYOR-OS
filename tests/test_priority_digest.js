// Regression tests for dashboard/src/utils/priorityDigest.js (Phase 3
// Milestone 6, Executive Intelligence Center). Unlike Milestone 5's
// static-regex frontend tests, priorityDigest() is pure, deterministic
// logic with no React/DOM dependency, so it can be imported and exercised
// directly under plain Node (both package.json files declare "type":
// "module", confirmed working the same way test_data_endpoint.js already
// imports dashboard/api/data.js directly).
//
// Run directly: node tests/test_priority_digest.js

import { priorityDigest } from '../dashboard/src/utils/priorityDigest.js'

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

// ── Shared fixture ------------------------------------------------------
// Deliberately includes two subjects each flagged by two different sources
// ("Downtown" by both Operations Impact and Predictive Alerts; "Eastside"
// by both Operations Impact and Trend Alerts) so duplicate suppression is
// actually exercised, not just cap behavior.

const operationsImpact = {
  needsAttention:           { location: { name: 'Downtown' },  explanation: 'Downtown has the lowest health score.' },
  biggestComplaint:         { category: { name: 'Wait Time' }, explanation: 'Wait time complaints rose sharply.' },
  lowestPerforming:         { location: { name: 'Eastside' },  explanation: 'Eastside has the lowest average rating.' },
  fastestGrowingComplaint:  { category: { name: 'Cleanliness' }, explanation: 'Cleanliness complaints grew fastest.' },
  leastConsistent:          { location: { name: 'Westside' },  explanation: 'Westside has the highest rating variance.' },
  biggestCompliment:        { category: { name: 'Friendly Staff' }, explanation: 'Friendly staff mentioned most often.' },
  fastestGrowingCompliment: { category: { name: 'Food Quality' }, explanation: 'Food quality praise is growing fastest.' },
  highestPerforming:        { location: { name: 'Northside' }, explanation: 'Northside has the highest average rating.' },
  bestManaged:              { location: { name: 'Southside' }, explanation: 'Southside has the highest health score.' },
  mostConsistent:           { location: { name: 'Midtown' },   explanation: 'Midtown has the lowest rating variance.' },
}

const actionCenter = [
  { id: 'complaint_wait_time',   title: 'Address rising wait-time complaints', priority: 'Critical', reason: 'Wait time complaints up 40%.' },
  { id: 'complaint_cleanliness', title: 'Investigate cleanliness complaints',   priority: 'High',     reason: 'Cleanliness complaints trending up.' },
  { id: 'marketing_food_quality',title: 'Promote food quality praise',         priority: 'Medium',   reason: 'Food quality praise is strong.' },
  { id: 'recognition_staff',     title: 'Recognize top staff performer',       priority: 'Low',       reason: 'One staff member has 95% positive mentions.' },
]

const predictiveAlerts = [
  { severity: 'critical', title: 'Downtown', body: 'Downtown is trending toward 1-star reviews.' },
  { severity: 'warning',  title: 'Uptown', location: 'Uptown', body: 'Uptown review volume is dropping.' },
  { severity: 'positive', title: 'Northside', body: 'Northside review volume is way up.' },
]

const trendAlerts = [
  { name: 'Eastside',  delta: -0.3,  avgPrev: 4.2, avgCur: 3.9 },
  { name: 'Riverside', delta: -0.2,  avgPrev: 4.0, avgCur: 3.8 },
  { name: 'Northside', delta: 0.25,  avgPrev: 4.1, avgCur: 4.35 },
]

const momentum = [
  { name: 'Northside', curAvg: 4.4,  prevAvg: 4.1, delta: 0.3,  curN: 10, prevN: 10 },
  { name: 'Southside', curAvg: 4.35, prevAvg: 4.3, delta: 0.05, curN: 8,  prevN: 8 },
  { name: 'Eastside',  curAvg: 3.9,  prevAvg: 4.2, delta: -0.3, curN: 6,  prevN: 6 },
]

const categoryChanges = {
  complaints: { new: [{ id: 'wait_time', count: 12, prevCount: 1 }], resolved: [], changed: [] },
  praises:    { new: [{ id: 'food_quality', count: 8, prevCount: 0 }], resolved: [], changed: [] },
}

function fullDigest() {
  return priorityDigest({ operationsImpact, actionCenter, predictiveAlerts, trendAlerts, momentum, categoryChanges })
}

// ── Tests ----------------------------------------------------------------

function testHardCapOfFivePriorities() {
  const { topPriorities } = fullDigest()
  assert(topPriorities.length === 5, `expected exactly 5 priorities, got ${topPriorities.length}`)
}

function testDeterministicOrdering() {
  const { topPriorities } = fullDigest()
  const titles = topPriorities.map(p => p.title)
  assert(titles[0] === 'Downtown', `expected rank 1 to be Downtown, got ${titles[0]}`)
  assert(titles[1] === 'Wait Time', `expected rank 2 to be Wait Time, got ${titles[1]}`)
  assert(titles[2] === 'Eastside', `expected rank 3 to be Eastside, got ${titles[2]}`)
  assert(titles[3] === 'Address rising wait-time complaints', `expected rank 4 to be the Action Center item, got ${titles[3]}`)
  assert(titles[4] === 'Cleanliness', `expected rank 5 to be Cleanliness, got ${titles[4]}`)
  assert(topPriorities.every((p, i) => p.rank === i + 1), 'ranks must be sequential starting at 1')

  // Running it again with the exact same input must produce the exact same
  // order -- no randomness, no reliance on unstable object key iteration.
  const second = fullDigest().topPriorities.map(p => p.id)
  const first = topPriorities.map(p => p.id)
  assert(JSON.stringify(first) === JSON.stringify(second), 'priorityDigest() must be deterministic across repeated calls with the same input')
}

function testDuplicateSuppression() {
  const { topPriorities } = fullDigest()
  // "Downtown" was flagged by both Operations Impact (needsAttention) and
  // Predictive Alerts (critical). Only the Operations Impact one (ranked
  // first by source-order tiebreak) may survive.
  const downtownEntries = topPriorities.filter(p => p.title === 'Downtown')
  assert(downtownEntries.length === 1, `expected exactly 1 Downtown entry after dedup, got ${downtownEntries.length}`)
  assert(downtownEntries[0].sourceLabel === 'Operations Impact', `expected the surviving Downtown entry to be from Operations Impact, got ${downtownEntries[0].sourceLabel}`)

  // "Eastside" was flagged by both Operations Impact (lowestPerforming) and
  // Trend Alerts (decline) -- same rule.
  const eastsideEntries = topPriorities.filter(p => p.title === 'Eastside')
  assert(eastsideEntries.length === 1, `expected exactly 1 Eastside entry after dedup, got ${eastsideEntries.length}`)
  assert(eastsideEntries[0].sourceLabel === 'Operations Impact', `expected the surviving Eastside entry to be from Operations Impact, got ${eastsideEntries[0].sourceLabel}`)
}

function testSourceAttribution() {
  const { topPriorities } = fullDigest()
  const validSources = new Set(['Operations Impact', 'Action Center', 'Predictive Alerts', 'Trend Alerts'])
  // Operations Calendar + Content Library milestone: Action Center content
  // (AI Suggestions) now lives inside Calendar, not the deprecated
  // /actions-legacy page -- see priorityDigest.js's own
  // collectActionCenterPriorityCandidates() comment. '/action-center' is a
  // legacy route alias (App.jsx redirects it to /calendar) that this test
  // previously expected verbatim; the digest now emits the canonical,
  // direct path.
  const validPaths = new Set(['/operations-impact', '/calendar', '/alerts'])
  topPriorities.forEach(p => {
    assert(validSources.has(p.sourceLabel), `unexpected sourceLabel "${p.sourceLabel}" on "${p.title}"`)
    assert(validPaths.has(p.sourcePath), `unexpected sourcePath "${p.sourcePath}" on "${p.title}"`)
    assert(typeof p.explanation === 'string' && p.explanation.length > 0, `every priority item must carry a non-empty explanation ("${p.title}" did not)`)
  })
}

function testRecentWinsSelectionAndCap() {
  const { recentWins } = fullDigest()
  assert(recentWins.length === 3, `expected exactly 3 recent wins (hard cap), got ${recentWins.length}`)
  assert(recentWins[0].title === 'Friendly Staff', `expected rank 1 win to be Friendly Staff, got ${recentWins[0].title}`)
  assert(recentWins[1].title === 'Food Quality', `expected rank 2 win to be Food Quality, got ${recentWins[1].title}`)
  assert(recentWins[2].title === 'Northside', `expected rank 3 win to be Northside, got ${recentWins[2].title}`)
  assert(recentWins.every(w => w.sourceLabel), 'every recent win must carry a sourceLabel')
}

function testRecentWinsDuplicateSuppression() {
  // A smaller, dedicated fixture where the cap would NOT otherwise be hit
  // before a genuine duplicate subject ("Northside") is encountered --
  // isolates dedup behavior for wins from the cap behavior above.
  const { recentWins } = priorityDigest({
    operationsImpact: { highestPerforming: { location: { name: 'Northside' }, explanation: 'Northside has the highest average rating.' } },
    momentum: [{ name: 'Northside', curAvg: 4.4, prevAvg: 4.1, delta: 0.3, curN: 10, prevN: 10 }],
    trendAlerts: [{ name: 'Southside', delta: 0.2, avgPrev: 4.0, avgCur: 4.2 }],
  })
  assert(recentWins.length === 2, `expected 2 wins (Northside deduped, Southside kept), got ${recentWins.length}`)
  assert(recentWins[0].title === 'Northside' && recentWins[0].sourceLabel === 'Operations Impact',
    'the Operations Impact Northside entry must win over the duplicate momentum-based one')
  assert(recentWins[1].title === 'Southside rating is improving', `expected the second win to reference Southside, got ${recentWins[1].title}`)
}

function testEmptyInputsProduceEmptyDigestNotAnError() {
  const digest = priorityDigest({})
  assert(Array.isArray(digest.topPriorities) && digest.topPriorities.length === 0, 'topPriorities must be an empty array, not fabricated data')
  assert(Array.isArray(digest.recentWins) && digest.recentWins.length === 0, 'recentWins must be an empty array, not fabricated data')
  assert(digest.biggestMover === null, 'biggestMover must be null with no momentum data')
  assert(digest.emergingTrend === null, 'emergingTrend must be null with no category-change data')
  assert(digest.nextActionsFocus === null, 'nextActionsFocus must be null with no action-center data')
}

function testBiggestMoverPicksLargestMagnitudeRegardlessOfDirection() {
  const { biggestMover } = fullDigest()
  // Eastside (-0.3) and Northside (+0.3) tie in magnitude; Northside comes
  // first in the fixture array, and the sort is stable, so it must win.
  assert(biggestMover.name === 'Northside', `expected biggestMover to be Northside, got ${biggestMover.name}`)
  assert(biggestMover.direction === 'up', `expected direction "up", got ${biggestMover.direction}`)
}

function testEmergingTrendPicksHighestCount() {
  const { emergingTrend } = fullDigest()
  assert(emergingTrend.id === 'wait_time', `expected the higher-count new complaint theme, got ${emergingTrend.id}`)
  assert(emergingTrend.kind === 'complaint', `expected kind "complaint", got ${emergingTrend.kind}`)
}

function testNextActionsFocusSortsByPriorityAndCapsAtThree() {
  const { nextActionsFocus } = fullDigest()
  assert(nextActionsFocus.total === 4, `expected total to reflect all 4 action-center items, got ${nextActionsFocus.total}`)
  assert(nextActionsFocus.items.length === 3, `expected the condensed list capped at 3, got ${nextActionsFocus.items.length}`)
  assert(nextActionsFocus.items[0].priority === 'Critical', 'first item must be the Critical one')
  assert(nextActionsFocus.items[3] === undefined, 'must never include a 4th item')
}

// ── Action Center Accountability milestone: assigned-overdue source -------
// Isolated fixtures (not folded into fullDigest()'s shared fixture) so the
// existing rank/order assertions above stay byte-for-byte unaffected.

function testAssignedOverdueItemIsAlwaysCriticalAndAttributedCorrectly() {
  const { topPriorities } = priorityDigest({
    assignedOverdueItems: [{ id: 'complaint_wait_time', title: 'Address rising wait-time complaints', dueDate: '2026-01-01' }],
  })
  assert(topPriorities.length === 1, `expected exactly 1 priority, got ${topPriorities.length}`)
  const item = topPriorities[0]
  assert(item.severity === 'critical', `an overdue task assigned to you must always be critical, got ${item.severity}`)
  assert(item.sourceLabel === 'My Overdue Tasks', `expected sourceLabel "My Overdue Tasks", got ${item.sourceLabel}`)
  // '/calendar', not the legacy '/action-center' alias -- see testSourceAttribution's comment above.
  assert(item.sourcePath === '/calendar', `expected sourcePath "/calendar", got ${item.sourcePath}`)
  assert(item.title.includes('Address rising wait-time complaints'), `title must reference the underlying task, got "${item.title}"`)
  assert(item.explanation.includes('2026-01-01'), `explanation must reference the due date, got "${item.explanation}"`)
}

function testAssignedOverdueItemsOutrankLowerSeveritySources() {
  // A High-severity Action Center item and a critical assigned-overdue item
  // together -- the overdue one must rank first.
  const { topPriorities } = priorityDigest({
    actionCenter: [{ id: 'complaint_cleanliness', title: 'Investigate cleanliness complaints', priority: 'High', reason: 'Cleanliness complaints trending up.' }],
    assignedOverdueItems: [{ id: 'complaint_wait_time', title: 'Address rising wait-time complaints', dueDate: '2026-01-01' }],
  })
  assert(topPriorities[0].sourceLabel === 'My Overdue Tasks', `expected the overdue item to rank first, got ${topPriorities[0].sourceLabel}`)
  assert(topPriorities[1].sourceLabel === 'Action Center', `expected the High Action Center item second, got ${topPriorities[1].sourceLabel}`)
}

// ── Recovery-audit milestone: restaurant follow-up source -----------------

function testEmailFollowUpItemProducesHighSeverityCandidateLinkingToReview() {
  const { topPriorities } = priorityDigest({
    emailFollowUpItems: [{ id: 'review-1', reviewId: 'review-1', locationName: 'Casa Tequila Brighton', emailFollowUpDueAt: '2026-01-01' }],
  })
  assert(topPriorities.length === 1, `expected exactly 1 priority, got ${topPriorities.length}`)
  const item = topPriorities[0]
  assert(item.severity === 'high', `an overdue restaurant follow-up must be high severity, got ${item.severity}`)
  assert(item.sourceLabel === 'Restaurant Follow-Up', `expected sourceLabel "Restaurant Follow-Up", got ${item.sourceLabel}`)
  // '/reviews', not the legacy '/explorer' alias -- App.jsx's Review
  // Explorer page is now mounted directly at /reviews; /explorer only
  // exists as a redirect (RedirectPreservingSearch) to it.
  assert(item.sourcePath === '/reviews?reviewId=review-1', `expected a Review Explorer deep link, got ${item.sourcePath}`)
  assert(item.title.includes('Casa Tequila Brighton'), `title must reference the location, got "${item.title}"`)
  assert(item.explanation.includes('2026-01-01'), `explanation must reference the follow-up due date, got "${item.explanation}"`)
}

function testEmailFollowUpItemWithoutReviewIdLinksToActionCenter() {
  const { topPriorities } = priorityDigest({
    emailFollowUpItems: [{ id: 'review-2', reviewId: null, locationName: 'Unknown Spot', emailFollowUpDueAt: null }],
  })
  // '/actions' is a legacy route alias (App.jsx redirects it to /calendar,
  // same destination as '/action-center') -- this is what
  // collectEmailFollowUpCandidates() currently emits for its no-reviewId
  // fallback. Note: this is the one candidate builder in priorityDigest.js
  // that was NOT updated to the direct '/calendar' path the way
  // collectActionCenterPriorityCandidates()/collectAssignedOverdueCandidates()
  // were -- functionally identical (both aliases redirect to the same
  // page), but worth a follow-up consistency pass; not changed here since
  // it is working, valid behavior, not a defect.
  assert(topPriorities[0].sourcePath === '/actions', 'without a reviewId, must fall back to linking to Action Center')
}

function testEmailFollowUpOutranksLowerSeveritySourcesButNotOverdueTasks() {
  const { topPriorities } = priorityDigest({
    trendAlerts: [{ name: 'Eastside', delta: -0.2, avgPrev: 4.0, avgCur: 3.8 }], // warning
    assignedOverdueItems: [{ id: 'a1', title: 'My overdue task', dueDate: '2026-01-01' }], // critical
    emailFollowUpItems: [{ id: 'review-1', reviewId: 'review-1', locationName: 'Casa Tequila Brighton', emailFollowUpDueAt: '2026-01-01' }], // high
  })
  assert(topPriorities[0].sourceLabel === 'My Overdue Tasks', `critical must rank first, got ${topPriorities[0].sourceLabel}`)
  assert(topPriorities[1].sourceLabel === 'Restaurant Follow-Up', `high must rank second (above warning), got ${topPriorities[1].sourceLabel}`)
  assert(topPriorities[2].sourceLabel === 'Trend Alerts', `warning must rank last, got ${topPriorities[2].sourceLabel}`)
}

function testNoEmailFollowUpItemsProducesNoExtraCandidates() {
  const { topPriorities } = fullDigest()
  assert(!topPriorities.some(p => p.sourceLabel === 'Restaurant Follow-Up'), 'no "Restaurant Follow-Up" entries should appear when emailFollowUpItems is omitted')
  const digest = priorityDigest({ emailFollowUpItems: [] })
  assert(digest.topPriorities.length === 0, 'an empty emailFollowUpItems array must produce zero priorities, not throw')
}

function testNoAssignedOverdueItemsProducesNoExtraCandidates() {
  // Regression: an empty/absent assignedOverdueItems must not add anything
  // or throw -- most users, most of the time, have nothing overdue.
  const { topPriorities } = fullDigest()
  assert(!topPriorities.some(p => p.sourceLabel === 'My Overdue Tasks'), 'no "My Overdue Tasks" entries should appear when assignedOverdueItems is omitted')
  const digest = priorityDigest({ assignedOverdueItems: [] })
  assert(digest.topPriorities.length === 0, 'an empty assignedOverdueItems array must produce zero priorities, not throw')
}

const tests = [
  ['hard cap of 5 for Today\'s Priorities', testHardCapOfFivePriorities],
  ['deterministic ordering (severity, then source, then original order)', testDeterministicOrdering],
  ['duplicate suppression across sources by subject', testDuplicateSuppression],
  ['every priority item carries valid source attribution', testSourceAttribution],
  ['recent wins selection and hard cap of 3', testRecentWinsSelectionAndCap],
  ['recent wins duplicate suppression (isolated from cap)', testRecentWinsDuplicateSuppression],
  ['empty inputs produce an empty digest, never fabricated data', testEmptyInputsProduceEmptyDigestNotAnError],
  ['biggest mover picks the largest-magnitude change', testBiggestMoverPicksLargestMagnitudeRegardlessOfDirection],
  ['emerging trend picks the highest-count new category', testEmergingTrendPicksHighestCount],
  ['next actions focus sorts by priority and caps at 3', testNextActionsFocusSortsByPriorityAndCapsAtThree],
  ['an overdue task assigned to you is always critical and correctly attributed', testAssignedOverdueItemIsAlwaysCriticalAndAttributedCorrectly],
  ['assigned-overdue items outrank lower-severity sources', testAssignedOverdueItemsOutrankLowerSeveritySources],
  ['no assigned-overdue items produces no extra candidates (regression)', testNoAssignedOverdueItemsProducesNoExtraCandidates],
  ['an overdue restaurant follow-up is high severity and links to the review', testEmailFollowUpItemProducesHighSeverityCandidateLinkingToReview],
  ['an email follow-up item with no reviewId links to Action Center instead', testEmailFollowUpItemWithoutReviewIdLinksToActionCenter],
  ['email follow-up (high) outranks warning but not a critical overdue task', testEmailFollowUpOutranksLowerSeveritySourcesButNotOverdueTasks],
  ['no email-follow-up items produces no extra candidates (regression)', testNoEmailFollowUpItemsProducesNoExtraCandidates],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
