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
import { _setRedisClientForTests as setTaskRedis, _resetRedisClientForTests as resetTaskRedis } from '../dashboard/api/_lib/taskStore.js'
import { _setRedisClientForTests as setCampaignRedis, _resetRedisClientForTests as resetCampaignRedis } from '../dashboard/api/_lib/campaignStore.js'

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
    resetTaskRedis()
    resetCampaignRedis()
  }
}

function fakeHashStore(initial = {}) {
  const store = { ...initial }
  return { hgetall: async () => ({ ...store }) }
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

// --- Operations Calendar + Content Library: task/promotion notifications ---

function taskRecord(overrides) {
  return {
    id: 'task_1', title: 'Fix the ice machine', type: 'operations', locationIds: [1],
    startAt: new Date().toISOString(), endAt: new Date().toISOString(), allDay: false,
    priority: 'Medium', status: 'Scheduled', recurrence: null, notes: '', relatedReviewIds: [],
    campaignId: null, sourceActionId: null, createdBy: 'usr_owner', createdAt: new Date().toISOString(),
    updatedBy: 'usr_owner', updatedAt: new Date().toISOString(), history: [],
    ...overrides,
  }
}

function isoAt(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString()
}

async function testTaskDueTodayProducesATaskDueNotification() {
  installFixture()
  noOtherSources()
  setTaskRedis(() => fakeHashStore({ t1: JSON.stringify(taskRecord({ id: 't1', endAt: isoAt(2) })) }))
  setCampaignRedis(() => fakeHashStore())
  const candidates = await getNotificationCandidates(OWNER)
  const due = candidates.filter(c => c.type === 'task_due')
  assert(due.length === 1, `a task due later today must produce exactly one task_due candidate, got ${due.length}`)
  assert(due[0].key === 'task_due:t1', 'the dedup key must be task_due:<taskId>')
}

async function testTaskOverdueProducesATaskOverdueNotificationNotBoth() {
  installFixture()
  noOtherSources()
  setTaskRedis(() => fakeHashStore({ t1: JSON.stringify(taskRecord({ id: 't1', endAt: isoAt(-48) })) }))
  setCampaignRedis(() => fakeHashStore())
  const candidates = await getNotificationCandidates(OWNER)
  const overdue = candidates.filter(c => c.type === 'task_overdue')
  const due = candidates.filter(c => c.type === 'task_due')
  assert(overdue.length === 1 && overdue[0].severity === 'critical', 'an overdue task must produce exactly one critical task_overdue candidate')
  assert(due.length === 0, 'an overdue task must never ALSO produce a task_due candidate for the same task')
}

async function testCompletedTaskNeverNotifies() {
  installFixture()
  noOtherSources()
  setTaskRedis(() => fakeHashStore({ t1: JSON.stringify(taskRecord({ id: 't1', endAt: isoAt(-48), status: 'Completed' })) }))
  setCampaignRedis(() => fakeHashStore())
  const candidates = await getNotificationCandidates(OWNER)
  assert(candidates.filter(c => c.type === 'task_due' || c.type === 'task_overdue').length === 0, 'a Completed task must stop notifying entirely, even if its due date has passed')
}

async function testCancelledTaskNeverNotifies() {
  installFixture()
  noOtherSources()
  setTaskRedis(() => fakeHashStore({ t1: JSON.stringify(taskRecord({ id: 't1', endAt: isoAt(2), status: 'Cancelled' })) }))
  setCampaignRedis(() => fakeHashStore())
  const candidates = await getNotificationCandidates(OWNER)
  assert(candidates.filter(c => c.type === 'task_due' || c.type === 'task_overdue').length === 0, 'a Cancelled task must never notify')
}

async function testFutureTaskDoesNotNotifyYet() {
  installFixture()
  noOtherSources()
  setTaskRedis(() => fakeHashStore({ t1: JSON.stringify(taskRecord({ id: 't1', endAt: isoAt(72) })) })) // 3 days out
  setCampaignRedis(() => fakeHashStore())
  const candidates = await getNotificationCandidates(OWNER)
  assert(candidates.filter(c => c.type === 'task_due' || c.type === 'task_overdue').length === 0, 'a task due several days from now must not notify yet')
}

async function testTaskNotificationsAreLocationScoped() {
  installFixture()
  noOtherSources()
  setTaskRedis(() => fakeHashStore({
    t1: JSON.stringify(taskRecord({ id: 't1', locationIds: [1], endAt: isoAt(2) })),
    t2: JSON.stringify(taskRecord({ id: 't2', locationIds: [3], endAt: isoAt(2) })),
  }))
  setCampaignRedis(() => fakeHashStore())
  const scoped = await getNotificationCandidates(LOCATION_MANAGER) // locationIds: [1]
  const scopedDue = scoped.filter(c => c.type === 'task_due')
  assert(scopedDue.length === 1 && scopedDue[0].key === 'task_due:t1', 'a scoped account must only see task_due for its own location')

  const owner = await getNotificationCandidates(OWNER)
  assert(owner.filter(c => c.type === 'task_due').length === 2, 'Owner must see task_due notifications across every location')
}

async function testCompanyWideTaskVisibleToScopedAccountToo() {
  installFixture()
  noOtherSources()
  setTaskRedis(() => fakeHashStore({ t1: JSON.stringify(taskRecord({ id: 't1', locationIds: '*', endAt: isoAt(2) })) }))
  setCampaignRedis(() => fakeHashStore())
  const scoped = await getNotificationCandidates(LOCATION_MANAGER)
  assert(scoped.filter(c => c.type === 'task_due').length === 1, 'a company-wide (\'*\') task must still notify a location-scoped account -- it was intentionally broadcast')
}

async function testPromotionStartingTomorrowNotifiesForApprovedCampaignOnly() {
  installFixture()
  noOtherSources()
  setTaskRedis(() => fakeHashStore())
  const tomorrow = new Date(Date.now() + 24 * 3_600_000).toISOString().slice(0, 10)
  setCampaignRedis(() => fakeHashStore({
    approved: JSON.stringify({ id: 'approved', name: 'Kids Eat Free', status: 'Approved', startDate: tomorrow, locationIds: [1], createdAt: new Date().toISOString() }),
    draft: JSON.stringify({ id: 'draft', name: 'Unlaunched Promo', status: 'Draft', startDate: tomorrow, locationIds: [1], createdAt: new Date().toISOString() }),
  }))
  const candidates = await getNotificationCandidates(OWNER)
  const starting = candidates.filter(c => c.type === 'promotion_starting')
  assert(starting.length === 1, `only the Approved campaign starting tomorrow should notify, got ${starting.length}`)
  assert(starting[0].key === 'promotion_starting:approved', 'the dedup key must be promotion_starting:<campaignId>')
}

async function testPromotionStartingIsLocationScoped() {
  installFixture()
  noOtherSources()
  setTaskRedis(() => fakeHashStore())
  const tomorrow = new Date(Date.now() + 24 * 3_600_000).toISOString().slice(0, 10)
  setCampaignRedis(() => fakeHashStore({
    mine: JSON.stringify({ id: 'mine', name: 'My Promo', status: 'Approved', startDate: tomorrow, locationIds: [1], createdAt: new Date().toISOString() }),
    other: JSON.stringify({ id: 'other', name: 'Other Promo', status: 'Approved', startDate: tomorrow, locationIds: [3], createdAt: new Date().toISOString() }),
  }))
  const scoped = await getNotificationCandidates(LOCATION_MANAGER) // locationIds: [1]
  const starting = scoped.filter(c => c.type === 'promotion_starting')
  assert(starting.length === 1 && starting[0].key === 'promotion_starting:mine', 'a scoped account must only see promotion_starting for its own authorized location')
}

async function testPromotionNotStartingTomorrowDoesNotNotify() {
  installFixture()
  noOtherSources()
  setTaskRedis(() => fakeHashStore())
  const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
  setCampaignRedis(() => fakeHashStore({
    c1: JSON.stringify({ id: 'c1', name: 'Next Week Promo', status: 'Approved', startDate: nextWeek, locationIds: [1], createdAt: new Date().toISOString() }),
  }))
  const candidates = await getNotificationCandidates(OWNER)
  assert(candidates.filter(c => c.type === 'promotion_starting').length === 0, 'a promotion starting next week must not notify yet -- only "starts tomorrow"')
}

async function testTaskAndPromotionNotificationsRespectReadUnreadViaSameStableKeyMechanism() {
  // Read/unread itself is layered on top by the API layer
  // (dashboard/api/notifications/[action].js), not this module -- this
  // test confirms the precondition that mechanism depends on: the SAME
  // underlying task always produces the SAME stable key across calls, so
  // marking it read persists correctly rather than drifting to a new key.
  installFixture()
  noOtherSources()
  setTaskRedis(() => fakeHashStore({ t1: JSON.stringify(taskRecord({ id: 't1', endAt: isoAt(2) })) }))
  setCampaignRedis(() => fakeHashStore())
  const first = await getNotificationCandidates(OWNER)
  const second = await getNotificationCandidates(OWNER)
  const firstDue = first.find(c => c.type === 'task_due')
  const secondDue = second.find(c => c.type === 'task_due')
  assert(firstDue.key === secondDue.key, 'the same task must produce the exact same stable key across repeated calls')
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
    ['a task due later today produces a task_due notification', testTaskDueTodayProducesATaskDueNotification],
    ['an overdue task produces task_overdue, never also task_due', testTaskOverdueProducesATaskOverdueNotificationNotBoth],
    ['a Completed task never notifies, even if overdue', testCompletedTaskNeverNotifies],
    ['a Cancelled task never notifies', testCancelledTaskNeverNotifies],
    ['a task due several days out does not notify yet', testFutureTaskDoesNotNotifyYet],
    ['task due/overdue notifications are location-scoped', testTaskNotificationsAreLocationScoped],
    ['a company-wide (\'*\') task still notifies a scoped account', testCompanyWideTaskVisibleToScopedAccountToo],
    ['a promotion starting tomorrow notifies only for an Approved campaign', testPromotionStartingTomorrowNotifiesForApprovedCampaignOnly],
    ['promotion_starting is location-scoped', testPromotionStartingIsLocationScoped],
    ['a promotion not starting tomorrow does not notify', testPromotionNotStartingTomorrowDoesNotNotify],
    ['the same task produces the same stable key across calls (read/unread precondition)', testTaskAndPromotionNotificationsRespectReadUnreadViaSameStableKeyMechanism],
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
