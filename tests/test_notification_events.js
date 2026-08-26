// Regression tests for dashboard/api/_lib/notificationEvents.js --
// getNotificationCandidates(), the pure business logic that turns already-
// existing data (exported reviews, Action Center assignments, GBP health,
// reply-failure records) into notification candidates. Every source is
// mocked via each module's own established test seam -- no real
// filesystem, no real Upstash account.
//
// Run directly: node tests/test_notification_events.js

import {
  getNotificationCandidates, _setPrivateDataForTests, _resetPrivateDataForTests,
  REVIEW_NOTIFICATION_RETENTION_DAYS, _reviewIdForTests,
} from '../dashboard/api/_lib/notificationEvents.js'
import { reviewId } from '../dashboard/src/utils/dataUtils.js'
import { _setRedisClientForTests as setActionRedis, _resetRedisClientForTests as resetActionRedis } from '../dashboard/api/_lib/actionStore.js'
import { _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis } from '../dashboard/api/_lib/credentialStore.js'
import { _setRedisClientForTests as setNotifRedis, _resetRedisClientForTests as resetNotifRedis } from '../dashboard/api/_lib/notificationStore.js'

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
    _resetPrivateDataForTests()
    resetActionRedis()
    resetCredentialRedis()
    resetNotifRedis()
  }
}

const OWNER = { userId: 'usr_owner', role: 'owner', locationIds: '*' }
const LOCATION_MANAGER = { userId: 'usr_lm', role: 'location_manager', locationIds: [1] }
const MULTI_LOCATION_MANAGER = { userId: 'usr_lm2', role: 'location_manager', locationIds: [1, 2] }

const META = {
  locations: [
    { locationId: 1, name: 'Casa Tequila Prime', slug: 'casa-tequila-prime' },
    { locationId: 2, name: 'Casa Tequila Brighton', slug: 'casa-tequila-brighton' },
    { locationId: 3, name: 'Farmington', slug: 'farmington' },
  ],
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

function review(overrides) {
  return {
    review_date: isoDaysAgo(1), reviewer_name: 'Someone', location_name: 'Casa Tequila Prime',
    star_rating: 4, review_text: 'A review', owner_response: null, ai_priority: null,
    review_id: undefined, review_url: undefined,
    ...overrides,
  }
}

function installFixture({ ctp = [], brighton = [], farmington = [] } = {}) {
  _setPrivateDataForTests({
    'meta.json': META,
    'reviews/by-location/casa-tequila-prime.json': ctp,
    'reviews/by-location/casa-tequila-brighton.json': brighton,
    'reviews/by-location/farmington.json': farmington,
  })
}

function noOtherSources() {
  setActionRedis(() => ({ hgetall: async () => ({}) }))
  setCredentialRedis(() => ({ get: async () => null }))
  setNotifRedis(() => ({ keys: async () => [] }))
}

// --- Critical / low-star reviews --------------------------------------------

async function testCriticalReviewProducesACriticalNotification() {
  installFixture({ ctp: [review({ ai_priority: 'critical', star_rating: 1, review_text: 'Someone got sick' })] })
  noOtherSources()
  const candidates = await getNotificationCandidates(OWNER)
  const critical = candidates.filter(c => c.type === 'critical_review')
  assert(critical.length === 1)
  assert(critical[0].severity === 'critical')
  assert(critical[0].location === 'Casa Tequila Prime')
}

async function testOneAndTwoStarReviewsProduceLowStarNotifications() {
  installFixture({ ctp: [review({ star_rating: 1 }), review({ star_rating: 2, reviewer_name: 'Other' })] })
  noOtherSources()
  const candidates = await getNotificationCandidates(OWNER)
  const lowStar = candidates.filter(c => c.type === 'low_star_review')
  assert(lowStar.length === 2)
}

async function testThreeStarAndAboveProduceNoReviewNotification() {
  installFixture({ ctp: [review({ star_rating: 3 }), review({ star_rating: 5, reviewer_name: 'Other' })] })
  noOtherSources()
  const candidates = await getNotificationCandidates(OWNER)
  assert(candidates.filter(c => c.type === 'low_star_review' || c.type === 'critical_review').length === 0, 'a positive/neutral review must never generate a notification')
}

async function testAlreadyAnsweredReviewNeverNotifies() {
  installFixture({ ctp: [review({ ai_priority: 'critical', owner_response: 'Thanks for the feedback' })] })
  noOtherSources()
  const candidates = await getNotificationCandidates(OWNER)
  assert(candidates.filter(c => c.type === 'critical_review').length === 0, 'an already-answered review must never be notification-worthy')
}

async function testCriticalAndLowStarNeverDoubleNotifyTheSameReview() {
  installFixture({ ctp: [review({ ai_priority: 'critical', star_rating: 1 })] })
  noOtherSources()
  const candidates = await getNotificationCandidates(OWNER)
  const matchingThisReview = candidates.filter(c => c.type === 'critical_review' || c.type === 'low_star_review')
  assert(matchingThisReview.length === 1, `a review that is BOTH critical and 1-star must produce exactly one notification, got ${matchingThisReview.length}`)
  assert(matchingThisReview[0].type === 'critical_review', 'critical must take priority over low-star for the same review')
}

async function testReviewOlderThanRetentionWindowIsExcluded() {
  installFixture({ ctp: [review({ ai_priority: 'critical', review_date: isoDaysAgo(REVIEW_NOTIFICATION_RETENTION_DAYS + 5) })] })
  noOtherSources()
  const candidates = await getNotificationCandidates(OWNER)
  assert(candidates.filter(c => c.type === 'critical_review').length === 0, `a review older than the ${REVIEW_NOTIFICATION_RETENTION_DAYS}-day retention window must not notify`)
}

// --- Stable identity / dedup -------------------------------------------------

async function testRepeatedCallsProduceTheExactSameStableKey() {
  installFixture({ ctp: [review({ ai_priority: 'critical', reviewer_name: 'Alpha', review_date: '2026-08-01' })] })
  noOtherSources()
  const first = await getNotificationCandidates(OWNER)
  const second = await getNotificationCandidates(OWNER)
  assert(first[0].key === second[0].key, 'the SAME underlying condition must produce the SAME stable key across repeated calls (simulating repeated critical-alert-check.yml runs) -- this is what prevents duplicate notifications')
  assert(first[0].key.startsWith('critical_review:'), `expected a critical_review: key, got ${first[0].key}`)
}

async function testStableKeyUsesTheCanonicalReviewIdFormula() {
  const r = review({ ai_priority: 'critical', reviewer_name: 'Alpha', review_date: '2026-08-01' })
  installFixture({ ctp: [r] })
  noOtherSources()
  const [candidate] = await getNotificationCandidates(OWNER)
  assert(candidate.key === `critical_review:${reviewId(r)}`, 'the notification key must use the exact same canonical reviewId() formula dataUtils.js exposes to the frontend, so a notification\'s deep link always matches Reviews.jsx\'s own selection logic')
  assert(_reviewIdForTests(r) === reviewId(r), 'notificationEvents.js\'s internal duplicate of the formula must stay byte-identical to dataUtils.js\'s canonical version')
}

// --- Location authorization --------------------------------------------------

async function testOwnerSeesNotificationsAcrossAllLocations() {
  installFixture({
    ctp: [review({ ai_priority: 'critical', location_name: 'Casa Tequila Prime' })],
    farmington: [review({ star_rating: 1, location_name: 'Farmington', reviewer_name: 'Other' })],
  })
  noOtherSources()
  const candidates = await getNotificationCandidates(OWNER)
  const locations = new Set(candidates.map(c => c.location))
  assert(locations.has('Casa Tequila Prime') && locations.has('Farmington'), 'Owner must see notifications across every location')
}

async function testSingleLocationManagerOnlySeesAssignedLocation() {
  installFixture({
    ctp: [review({ ai_priority: 'critical', location_name: 'Casa Tequila Prime' })],
    farmington: [review({ star_rating: 1, location_name: 'Farmington', reviewer_name: 'Other' })],
  })
  noOtherSources()
  const candidates = await getNotificationCandidates(LOCATION_MANAGER)
  const reviewCandidates = candidates.filter(c => c.type === 'critical_review' || c.type === 'low_star_review')
  assert(reviewCandidates.length === 1, `a single-location manager must only ever see their own location's notifications, got ${reviewCandidates.length}`)
  assert(reviewCandidates[0].location === 'Casa Tequila Prime')
}

async function testMultiLocationManagerSeesOnlyAllowedLocations() {
  installFixture({
    ctp: [review({ ai_priority: 'critical', location_name: 'Casa Tequila Prime' })],
    brighton: [review({ star_rating: 1, location_name: 'Casa Tequila Brighton', reviewer_name: 'B' })],
    farmington: [review({ star_rating: 2, location_name: 'Farmington', reviewer_name: 'C' })],
  })
  noOtherSources()
  const candidates = await getNotificationCandidates(MULTI_LOCATION_MANAGER)
  const locations = new Set(candidates.filter(c => c.location).map(c => c.location))
  assert(locations.has('Casa Tequila Prime') && locations.has('Casa Tequila Brighton'), 'a multi-location manager must see every assigned location')
  assert(!locations.has('Farmington'), 'a multi-location manager must never see an unassigned location\'s notifications')
}

// --- Reply failures -----------------------------------------------------------

async function testReplyFailureLocationScoped() {
  installFixture()
  setActionRedis(() => ({ hgetall: async () => ({}) }))
  setCredentialRedis(() => ({ get: async () => null }))
  setNotifRedis(() => ({
    keys: async () => ['notif_reply_failed:v1:r1', 'notif_reply_failed:v1:r2'],
    mget: async () => [
      JSON.stringify({ reviewId: 'r1', locationId: 1, locationName: 'Casa Tequila Prime', failReason: 'review_gone', failedAt: new Date().toISOString() }),
      JSON.stringify({ reviewId: 'r2', locationId: 3, locationName: 'Farmington', failReason: 'api_error', failedAt: new Date().toISOString() }),
    ],
  }))
  const scoped = await getNotificationCandidates(LOCATION_MANAGER) // locationIds: [1]
  const failures = scoped.filter(c => c.type === 'reply_failed')
  assert(failures.length === 1, `a scoped account must only see reply failures for its own location, got ${failures.length}`)
  assert(failures[0].key === 'reply_failed:r1')

  const owner = await getNotificationCandidates(OWNER)
  assert(owner.filter(c => c.type === 'reply_failed').length === 2, 'Owner must see reply failures across every location')
}

// --- Assigned actions -----------------------------------------------------------

async function testAssignedActionOnlyShownToItsOwnAssignee() {
  installFixture()
  setCredentialRedis(() => ({ get: async () => null }))
  setNotifRedis(() => ({ keys: async () => [] }))
  setActionRedis(() => ({
    hgetall: async () => ({
      a1: JSON.stringify({ id: 'a1', assignedTo: 'usr_lm', status: 'New', title: 'Follow up with guest' }),
      a2: JSON.stringify({ id: 'a2', assignedTo: 'usr_owner', status: 'New', title: 'Different task' }),
    }),
  }))
  const lm = await getNotificationCandidates(LOCATION_MANAGER)
  assert(lm.filter(c => c.type === 'assigned_action').length === 1, 'a user must only see actions assigned to THEM')
  assert(lm.find(c => c.type === 'assigned_action').key === 'assigned_action:a1')
}

async function testTerminalStatusActionsAreExcluded() {
  installFixture()
  setCredentialRedis(() => ({ get: async () => null }))
  setNotifRedis(() => ({ keys: async () => [] }))
  setActionRedis(() => ({
    hgetall: async () => ({
      a1: JSON.stringify({ id: 'a1', assignedTo: 'usr_lm', status: 'Completed' }),
      a2: JSON.stringify({ id: 'a2', assignedTo: 'usr_lm', status: 'Dismissed' }),
      a3: JSON.stringify({ id: 'a3', assignedTo: 'usr_lm', status: 'In Progress' }),
    }),
  }))
  const candidates = await getNotificationCandidates(LOCATION_MANAGER)
  const assigned = candidates.filter(c => c.type === 'assigned_action')
  assert(assigned.length === 1 && assigned[0].key === 'assigned_action:a3', 'Completed/Dismissed actions must never notify -- only still-open ones')
}

// --- GBP disconnected ---------------------------------------------------------

async function testGbpDisconnectedShownOnlyToOwner() {
  installFixture()
  setActionRedis(() => ({ hgetall: async () => ({}) }))
  setNotifRedis(() => ({ keys: async () => [] }))
  setCredentialRedis(() => ({ get: async () => JSON.stringify({ health: 'token_revoked' }) }))

  const ownerCandidates = await getNotificationCandidates(OWNER)
  assert(ownerCandidates.some(c => c.type === 'gbp_disconnected'), 'Owner must see a GBP-disconnected notification')

  const lmCandidates = await getNotificationCandidates(LOCATION_MANAGER)
  assert(!lmCandidates.some(c => c.type === 'gbp_disconnected'), 'a Location Manager must never see gbp_disconnected -- they cannot act on it (SETTINGS_ADMIN is Owner-only)')
}

async function testGbpConnectedOrNeverConnectedNeverNotifies() {
  installFixture()
  setActionRedis(() => ({ hgetall: async () => ({}) }))
  setNotifRedis(() => ({ keys: async () => [] }))
  for (const health of ['connected', 'never_connected']) {
    setCredentialRedis(() => ({ get: async () => JSON.stringify({ health }) }))
    const candidates = await getNotificationCandidates(OWNER)
    assert(!candidates.some(c => c.type === 'gbp_disconnected'), `health=${health} must never notify`)
  }
}

// --- Sorting / cap ---------------------------------------------------------

async function testCandidatesAreSortedCriticalFirst() {
  installFixture({ ctp: [
    review({ star_rating: 2, reviewer_name: 'Warn' }),
    review({ ai_priority: 'critical', reviewer_name: 'Crit' }),
  ] })
  noOtherSources()
  const candidates = await getNotificationCandidates(OWNER)
  assert(candidates[0].severity === 'critical', 'critical-severity notifications must sort first')
}

function main() {
  const tests = [
    ['a critical review produces a critical_review notification', testCriticalReviewProducesACriticalNotification],
    ['1-star and 2-star reviews produce low_star_review notifications', testOneAndTwoStarReviewsProduceLowStarNotifications],
    ['3-star and above never produce a review notification', testThreeStarAndAboveProduceNoReviewNotification],
    ['an already-answered review never notifies', testAlreadyAnsweredReviewNeverNotifies],
    ['critical + low-star on the same review never double-notifies', testCriticalAndLowStarNeverDoubleNotifyTheSameReview],
    ['a review older than the retention window is excluded', testReviewOlderThanRetentionWindowIsExcluded],
    ['repeated calls produce the exact same stable key (no duplicate-run duplication)', testRepeatedCallsProduceTheExactSameStableKey],
    ['the stable key uses the canonical reviewId() formula, kept in sync with dataUtils.js', testStableKeyUsesTheCanonicalReviewIdFormula],
    ['Owner sees notifications across all locations', testOwnerSeesNotificationsAcrossAllLocations],
    ['a single-location manager only sees their assigned location', testSingleLocationManagerOnlySeesAssignedLocation],
    ['a multi-location manager sees only their allowed locations', testMultiLocationManagerSeesOnlyAllowedLocations],
    ['reply-failure notifications are location-scoped', testReplyFailureLocationScoped],
    ['an assigned action is shown only to its own assignee', testAssignedActionOnlyShownToItsOwnAssignee],
    ['terminal-status (Completed/Dismissed) actions are excluded', testTerminalStatusActionsAreExcluded],
    ['gbp_disconnected is shown only to Owner', testGbpDisconnectedShownOnlyToOwner],
    ['gbp connected/never_connected never notifies', testGbpConnectedOrNeverConnectedNeverNotifies],
    ['candidates sort critical-severity first', testCandidatesAreSortedCriticalFirst],
  ]
  return (async () => {
    for (const [name, fn] of tests) await run(name, fn)
    console.log()
    if (results.every(Boolean)) {
      console.log(`ALL ${results.length} TESTS PASSED`)
      process.exit(0)
    }
    console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
    process.exit(1)
  })()
}

main()
