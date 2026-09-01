// Regression tests for dashboard/api/notifications/[action].js -- the
// consolidated Notification Center endpoint (GET list / POST mark-read /
// POST mark-all-read). Drives the real handler with a fake req/res, same
// pattern as test_actions_endpoint.js, with every underlying data source
// (review exports, Action Center, GBP credential, notification store)
// controlled via each module's own established test seam. No real Upstash
// account, no real filesystem.
//
// Run directly: node tests/test_notifications_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/notifications/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setPrivateDataForTests, _resetPrivateDataForTests } from '../dashboard/api/_lib/notificationEvents.js'
import { _setRedisClientForTests as setActionRedis, _resetRedisClientForTests as resetActionRedis } from '../dashboard/api/_lib/actionStore.js'
import { _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis } from '../dashboard/api/_lib/credentialStore.js'
import { _setRedisClientForTests as setNotifRedis, _resetRedisClientForTests as resetNotifRedis } from '../dashboard/api/_lib/notificationStore.js'
import { _setReviewLocationIndexForTests, _resetReviewLocationIndexForTests } from '../dashboard/api/_lib/reviewLocationIndex.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

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
    _resetReviewLocationIndexForTests()
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

async function invoke({ action, method = 'GET', token, body }) {
  const req = {
    method, query: { action }, body: body ?? {},
    headers: token ? { cookie: `lta_session=${token}` } : {},
    socket: {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' },
      { userId: 'usr_lm', email: 'lm@example.com', passwordHash: hash, role: 'location_manager', locationIds: [1], sessionVersion: 1, disabled: false, displayName: 'LM One' },
      { userId: 'usr_lm2', email: 'lm2@example.com', passwordHash: hash, role: 'location_manager', locationIds: [2], sessionVersion: 1, disabled: false, displayName: 'LM Two' },
    ],
  })
}

async function tokenFor(userId, email, role, locationIds) {
  return signSession({ userId, email, role, locationIds, tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
}
const ownerToken = () => tokenFor('usr_owner', 'owner@example.com', 'owner', '*')
const lmToken = () => tokenFor('usr_lm', 'lm@example.com', 'location_manager', [1])
const lm2Token = () => tokenFor('usr_lm2', 'lm2@example.com', 'location_manager', [2])

const META = {
  locations: [
    { locationId: 1, name: 'Casa Tequila Prime', slug: 'casa-tequila-prime' },
    { locationId: 2, name: 'Farmington', slug: 'farmington' },
  ],
}

function review(overrides) {
  return {
    review_date: new Date().toISOString().slice(0, 10), reviewer_name: 'Someone',
    location_name: 'Casa Tequila Prime', star_rating: 1, review_text: 'text',
    owner_response: null, ai_priority: null, ...overrides,
  }
}

function installFixture({ ctp = [], farmington = [] } = {}) {
  _setPrivateDataForTests({
    'meta.json': META,
    'reviews/by-location/casa-tequila-prime.json': ctp,
    'reviews/by-location/farmington.json': farmington,
  })
  setActionRedis(() => ({ hgetall: async () => ({}) }))
  setCredentialRedis(() => ({ get: async () => null }))
}

// preSeedUserIds: users this fake store treats as already past their
// first-ever visit (see notificationStore.js's hasBeenSeeded/markSeeded) --
// defaults to every fixture user, so existing tests exercise the NORMAL
// unread-computation path unchanged. Tests of the rollout-backlog seeding
// behavior itself pass [] to start from a genuinely fresh user.
function installNotifStore(preSeedUserIds = ['usr_owner', 'usr_lm', 'usr_lm2']) {
  const hashes = new Map()
  const strings = new Map() // backs the notif_seeded:v1:<userId> marker
  for (const userId of preSeedUserIds) strings.set(`notif_seeded:v1:${userId}`, '1')
  const client = {
    keys: async () => [],
    hgetall: async key => ({ ...(hashes.get(key) ?? {}) }),
    hset: async (key, fields) => { hashes.set(key, { ...(hashes.get(key) ?? {}), ...fields }) },
    expire: async () => {},
    get: async key => strings.get(key) ?? null,
    set: async (key, value) => { strings.set(key, value) },
  }
  setNotifRedis(() => client)
  return client
}

// --- Authentication -----------------------------------------------------

async function testListRequiresAuthentication() {
  await setDirectory(); installFixture(); installNotifStore()
  const res = await invoke({ action: 'list' })
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testMarkReadRequiresAuthentication() {
  await setDirectory(); installFixture(); installNotifStore()
  const res = await invoke({ action: 'mark-read', method: 'POST', body: { key: 'critical_review:x' } })
  assert(res.statusCode === 401)
}

async function testUnknownActionReturns404() {
  await setDirectory()
  const res = await invoke({ action: 'nonsense', token: await ownerToken() })
  assert(res.statusCode === 404)
}

// --- list --------------------------------------------------------------

async function testListReturnsNotificationsAndUnreadCount() {
  await setDirectory()
  installFixture({ ctp: [review({ ai_priority: 'critical' })] })
  installNotifStore()
  const res = await invoke({ action: 'list', token: await ownerToken() })
  assert(res.statusCode === 200, JSON.stringify(res.body))
  assert(res.body.notifications.length === 1)
  assert(res.body.unreadCount === 1)
  assert(res.body.notifications[0].read === false)
}

async function testListForScopedAccountOnlyIncludesOwnLocation() {
  await setDirectory()
  installFixture({
    ctp: [review({ ai_priority: 'critical', location_name: 'Casa Tequila Prime' })],
    farmington: [review({ star_rating: 1, location_name: 'Farmington', reviewer_name: 'Other' })],
  })
  installNotifStore()
  const res = await invoke({ action: 'list', token: await lmToken() })
  assert(res.statusCode === 200)
  assert(res.body.notifications.length === 1, `LM (location 1) must only see their own location's notification, got ${res.body.notifications.length}`)
  assert(res.body.notifications[0].location === 'Casa Tequila Prime')
}

async function testEmptyNotificationsReturnsZeroUnread() {
  await setDirectory(); installFixture(); installNotifStore()
  const res = await invoke({ action: 'list', token: await ownerToken() })
  assert(res.statusCode === 200)
  assert(res.body.notifications.length === 0)
  assert(res.body.unreadCount === 0)
}

// --- Rollout-backlog seeding (first-ever visit) ---------------------------

async function testFirstEverVisitSeedsBacklogAsReadNotUnread() {
  await setDirectory()
  installFixture({ ctp: [
    review({ ai_priority: 'critical', reviewer_name: 'Alpha' }),
    review({ star_rating: 2, reviewer_name: 'Bravo' }),
  ] })
  installNotifStore([]) // usr_owner has never visited before
  const res = await invoke({ action: 'list', token: await ownerToken() })
  assert(res.statusCode === 200)
  assert(res.body.notifications.length === 2, 'nothing is hidden -- the backlog is still returned in full')
  assert(res.body.unreadCount === 0, 'a first-ever visit must never report pre-existing backlog as unread')
  assert(res.body.notifications.every(n => n.read === true), 'every backlog item must come back marked read on the seeding response')
}

async function testSecondVisitAfterSeedingUsesNormalUnreadComputation() {
  await setDirectory()
  installFixture({ ctp: [review({ ai_priority: 'critical', reviewer_name: 'Alpha' })] })
  installNotifStore([]) // fresh user
  const first = await invoke({ action: 'list', token: await ownerToken() })
  assert(first.body.unreadCount === 0, 'sanity: first visit seeded as read')

  // A SECOND request against the exact same (still-unread-by-the-user)
  // backlog must not flip back to unread -- the seeding write must have
  // actually persisted.
  const second = await invoke({ action: 'list', token: await ownerToken() })
  assert(second.body.unreadCount === 0, 'the seeded backlog must stay read on a subsequent visit, not just the seeding response itself')
  assert(second.body.notifications[0].read === true)
}

async function testANewNotificationAfterSeedingCorrectlyShowsAsUnread() {
  await setDirectory()
  installFixture({ ctp: [review({ ai_priority: 'critical', reviewer_name: 'Alpha' })] })
  installNotifStore([]) // fresh user
  await invoke({ action: 'list', token: await ownerToken() }) // seeds Alpha's review as read

  // A genuinely NEW review appears after the user's first visit -- this
  // must show as unread, proving seeding only ever covers what existed at
  // the moment of the first visit, never anything that happens afterward.
  installFixture({ ctp: [
    review({ ai_priority: 'critical', reviewer_name: 'Alpha' }),
    review({ star_rating: 1, reviewer_name: 'Charlie' }),
  ] })
  const res = await invoke({ action: 'list', token: await ownerToken() })
  assert(res.body.unreadCount === 1, `only the genuinely new notification (Charlie) should be unread, got ${res.body.unreadCount}`)
  const unreadOnes = res.body.notifications.filter(n => !n.read)
  assert(unreadOnes.length === 1 && unreadOnes[0].title.includes('1-star'), `the unread item must be the newly-appeared 1-star review, got ${JSON.stringify(unreadOnes)}`)
}

async function testSeededUserIsNeverReSeededOnAFutureEmptyToNonEmptyTransition() {
  await setDirectory()
  installFixture() // zero candidates on this user's first-ever visit
  installNotifStore([])
  const first = await invoke({ action: 'list', token: await ownerToken() })
  assert(first.body.unreadCount === 0)

  // A notification appears later -- must NOT be silently seeded-as-read
  // just because the user's first visit happened to have zero candidates.
  installFixture({ ctp: [review({ ai_priority: 'critical' })] })
  const second = await invoke({ action: 'list', token: await ownerToken() })
  assert(second.body.unreadCount === 1, 'a user who was seeded with zero candidates must still see a genuinely later notification as unread, not silently re-seeded')
}

async function testDifferentUsersAreSeededIndependently() {
  await setDirectory()
  installFixture({
    ctp: [review({ ai_priority: 'critical', location_name: 'Casa Tequila Prime' })],
  })
  installNotifStore([]) // neither usr_owner nor usr_lm has visited before
  const ownerFirst = await invoke({ action: 'list', token: await ownerToken() })
  assert(ownerFirst.body.unreadCount === 0, 'Owner\'s own first visit is seeded')

  const lmFirst = await invoke({ action: 'list', token: await lmToken() })
  assert(lmFirst.body.unreadCount === 0, 'LM\'s independent first visit is ALSO seeded on their own first visit -- not already "used up" by Owner\'s visit')
}

// --- mark-read -----------------------------------------------------------

async function testMarkReadThenListShowsItRead() {
  await setDirectory()
  const r = review({ ai_priority: 'critical' })
  installFixture({ ctp: [r] })
  installNotifStore()
  const first = await invoke({ action: 'list', token: await ownerToken() })
  const key = first.body.notifications[0].key

  const markRes = await invoke({ action: 'mark-read', method: 'POST', token: await ownerToken(), body: { key } })
  assert(markRes.statusCode === 200, JSON.stringify(markRes.body))

  const second = await invoke({ action: 'list', token: await ownerToken() })
  assert(second.body.notifications[0].read === true)
  assert(second.body.unreadCount === 0)
}

async function testMarkReadMissingKeyReturns400() {
  await setDirectory(); installFixture(); installNotifStore()
  const res = await invoke({ action: 'mark-read', method: 'POST', token: await ownerToken(), body: {} })
  assert(res.statusCode === 400)
}

async function testMarkReadForAnotherLocationsReviewIsRejected() {
  await setDirectory()
  installFixture({ farmington: [review({ ai_priority: 'critical', location_name: 'Farmington' })] })
  installNotifStore()
  _setReviewLocationIndexForTests({ 'review-in-farmington': 2 })

  // LM (location 1) tries to mark read a notification key for a review in
  // location 2 (Farmington) -- direct API tampering, never legitimately
  // shown to them in their own list.
  const res = await invoke({
    action: 'mark-read', method: 'POST', token: await lmToken(),
    body: { key: 'critical_review:review-in-farmington' },
  })
  assert(res.statusCode === 404, `unauthorized-location mark-read must fail (404), got ${res.statusCode}`)
}

async function testMarkReadForAssignedActionRequiresBeingTheAssignee() {
  await setDirectory(); installFixture()
  const notifClient = installNotifStore()
  setActionRedis(() => ({
    hgetall: async () => ({ a1: JSON.stringify({ id: 'a1', assignedTo: 'usr_owner', status: 'New' }) }),
  }))
  // LM tries to mark read an action assigned to Owner, not to them.
  const res = await invoke({ action: 'mark-read', method: 'POST', token: await lmToken(), body: { key: 'assigned_action:a1' } })
  assert(res.statusCode === 404)
  assert(Object.keys(await notifClient.hgetall('notif_read:v1:usr_lm')).length === 0, 'a rejected mark-read must never write any read-state')
}

async function testMarkReadForGbpDisconnectedRequiresOwner() {
  await setDirectory(); installFixture(); installNotifStore()
  const res = await invoke({ action: 'mark-read', method: 'POST', token: await lmToken(), body: { key: 'gbp_disconnected' } })
  assert(res.statusCode === 404, 'a non-Owner must never be able to mark gbp_disconnected read')
}

// --- mark-all-read ---------------------------------------------------------

async function testMarkAllReadClearsUnreadCount() {
  await setDirectory()
  installFixture({ ctp: [review({ ai_priority: 'critical' }), review({ star_rating: 2, reviewer_name: 'Other' })] })
  installNotifStore()
  const before = await invoke({ action: 'list', token: await ownerToken() })
  assert(before.body.unreadCount === 2)

  const markAll = await invoke({ action: 'mark-all-read', method: 'POST', token: await ownerToken() })
  assert(markAll.statusCode === 200)
  assert(markAll.body.count === 2)

  const after = await invoke({ action: 'list', token: await ownerToken() })
  assert(after.body.unreadCount === 0)
}

async function testMarkAllReadForScopedAccountNeverExceedsTheirOwnScope() {
  await setDirectory()
  installFixture({
    ctp: [review({ ai_priority: 'critical', location_name: 'Casa Tequila Prime' })],
    farmington: [review({ star_rating: 1, location_name: 'Farmington', reviewer_name: 'Other' })],
  })
  installNotifStore()
  const markAll = await invoke({ action: 'mark-all-read', method: 'POST', token: await lmToken() })
  assert(markAll.body.count === 1, `a scoped account's mark-all-read must only ever cover their own authorized notifications, got ${markAll.body.count}`)

  // Owner (company-wide) must still see the Farmington notification as unread --
  // marking "all" for the LM must never have touched Owner's or a different
  // location's notification.
  const ownerList = await invoke({ action: 'list', token: await ownerToken() })
  assert(ownerList.body.unreadCount === 2, 'Owner\'s own unread count must be unaffected by a different (scoped) user\'s mark-all-read')
}

// --- Read state is per-user -----------------------------------------------

async function testReadStateIsPerUserAcrossTwoScopedAccounts() {
  await setDirectory()
  // Both LM accounts are scoped to different locations but let's verify
  // read state doesn't leak even for the SAME notification key when two
  // different users could both plausibly see it (Owner + LM sharing a
  // location's notification).
  installFixture({ ctp: [review({ ai_priority: 'critical', location_name: 'Casa Tequila Prime' })] })
  installNotifStore()

  const ownerList1 = await invoke({ action: 'list', token: await ownerToken() })
  const key = ownerList1.body.notifications[0].key
  await invoke({ action: 'mark-read', method: 'POST', token: await ownerToken(), body: { key } })

  const lmList = await invoke({ action: 'list', token: await lmToken() })
  assert(lmList.body.notifications[0].read === false, 'Owner reading a notification must never mark it read for a Location Manager who can also see it')
}

function main() {
  const tests = [
    ['list requires authentication', testListRequiresAuthentication],
    ['mark-read requires authentication', testMarkReadRequiresAuthentication],
    ['unknown action returns 404', testUnknownActionReturns404],
    ['list returns notifications and unreadCount', testListReturnsNotificationsAndUnreadCount],
    ['list for a scoped account only includes their own location', testListForScopedAccountOnlyIncludesOwnLocation],
    ['zero notifications returns unreadCount 0', testEmptyNotificationsReturnsZeroUnread],
    ['a first-ever visit seeds the existing backlog as read, not unread', testFirstEverVisitSeedsBacklogAsReadNotUnread],
    ['a second visit after seeding keeps using normal unread computation', testSecondVisitAfterSeedingUsesNormalUnreadComputation],
    ['a genuinely new notification after seeding correctly shows as unread', testANewNotificationAfterSeedingCorrectlyShowsAsUnread],
    ['a user seeded with zero candidates is never re-seeded later', testSeededUserIsNeverReSeededOnAFutureEmptyToNonEmptyTransition],
    ['different users are seeded independently on their own first visit', testDifferentUsersAreSeededIndependently],
    ['mark-read then list shows it read', testMarkReadThenListShowsItRead],
    ['mark-read with a missing key returns 400', testMarkReadMissingKeyReturns400],
    ['mark-read for another location\'s review is rejected (404), tampering blocked', testMarkReadForAnotherLocationsReviewIsRejected],
    ['mark-read for an assigned_action requires being the assignee', testMarkReadForAssignedActionRequiresBeingTheAssignee],
    ['mark-read for gbp_disconnected requires Owner', testMarkReadForGbpDisconnectedRequiresOwner],
    ['mark-all-read clears the unread count', testMarkAllReadClearsUnreadCount],
    ['mark-all-read for a scoped account never exceeds their own scope', testMarkAllReadForScopedAccountNeverExceedsTheirOwnScope],
    ['read state is per-user, even for a notification two users can both see', testReadStateIsPerUserAcrossTwoScopedAccounts],
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
