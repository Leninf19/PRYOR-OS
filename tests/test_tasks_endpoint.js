// Regression tests for dashboard/api/tasks/[action].js -- the consolidated
// Task/Calendar endpoint. Drives the real handler with a fake req/res
// (test_actions_endpoint.js's established pattern), controls the
// underlying Redis-backed store via taskStore.js's test-only client-
// factory seam, and reviewLocationIndex.js's test seam for
// review_assignment location cross-checks. No real Upstash account.
//
// This file's focus, per the Operations Calendar milestone's explicit
// testing requirements, is AUTHORIZATION -- location isolation, the
// canCreateTasks override, and direct-id tampering -- not a re-test of
// taskStore.js's own CRUD mechanics (see test_task_store.js for that).
//
// Run directly: node tests/test_tasks_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/tasks/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests, _resetRedisClientForTests } from '../dashboard/api/_lib/taskStore.js'
import { _setReviewLocationIndexForTests, _resetReviewLocationIndexForTests } from '../dashboard/api/_lib/reviewLocationIndex.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'

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
    _resetRedisClientForTests()
    _resetReviewLocationIndexForTests()
    _resetLimiterFactoryForTests()
    delete process.env.VERCEL_ENV
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

function fakeRedis(initial = {}) {
  const store = { ...initial }
  return {
    hgetall: async () => ({ ...store }),
    hget: async (_key, field) => store[field] ?? null,
    hset: async (_key, fields) => { Object.assign(store, fields) },
    hdel: async (_key, field) => { const had = field in store; delete store[field]; return had ? 1 : 0 },
    _store: store,
  }
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' },
      { userId: 'usr_admin', email: 'admin@example.com', passwordHash: hash, role: 'admin', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Admin' },
      { userId: 'usr_marketing_scoped', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: [3, 7], sessionVersion: 1, disabled: false, displayName: 'Scoped Marketing' },
      { userId: 'usr_lm_no', email: 'lm-no@example.com', passwordHash: hash, role: 'location_manager', locationIds: [7], sessionVersion: 1, disabled: false, canCreateTasks: false, displayName: 'LM No Create' },
      { userId: 'usr_lm_yes', email: 'lm-yes@example.com', passwordHash: hash, role: 'location_manager', locationIds: [7], sessionVersion: 1, disabled: false, canCreateTasks: true, displayName: 'LM Can Create' },
      { userId: 'usr_lm_other', email: 'lm-other@example.com', passwordHash: hash, role: 'location_manager', locationIds: [99], sessionVersion: 1, disabled: false, canCreateTasks: true, displayName: 'LM Other Location' },
      { userId: 'usr_viewer', email: 'viewer@example.com', passwordHash: hash, role: 'read_only', locationIds: [7], sessionVersion: 1, disabled: false, displayName: 'Viewer' },
    ],
  })
}

async function tokenFor(userId, role, locationIds) {
  return signSession({ userId, email: `${userId}@example.com`, role, locationIds, sessionVersion: 1 })
}
const ownerToken = () => tokenFor('usr_owner', 'owner', '*')
const adminToken = () => tokenFor('usr_admin', 'admin', '*')
const marketingToken = () => tokenFor('usr_marketing_scoped', 'marketing', [3, 7])
const lmNoToken = () => tokenFor('usr_lm_no', 'location_manager', [7])
const lmYesToken = () => tokenFor('usr_lm_yes', 'location_manager', [7])
const lmOtherToken = () => tokenFor('usr_lm_other', 'location_manager', [99])
const viewerToken = () => tokenFor('usr_viewer', 'read_only', [7])

async function invoke({ action, method = 'GET', token, body, query }) {
  const resolvedToken = await token
  const req = {
    method, query: { action, ...(query ?? {}) }, body: body ?? {},
    headers: resolvedToken ? { cookie: `lta_session=${resolvedToken}` } : {}, socket: {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

const REVIEW_TASK = () => ({
  title: 'Reply to Casa Tequila Prime reviews', type: 'review_assignment',
  locationIds: [7], startAt: '2026-08-27T09:00:00.000Z', priority: 'High',
  relatedReviewIds: ['r-loc7'],
})
const OPS_TASK = (locationIds = [7]) => ({
  title: 'Fix the ice machine', type: 'operations', locationIds, startAt: '2026-08-27T09:00:00.000Z',
})

// --- Owner / Admin / scoped Marketing --------------------------------------

async function testOwnerCanCreateCompanyWideTask() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'create', method: 'POST', token: ownerToken(), body: OPS_TASK('*') })
  assert(res.statusCode === 201, `owner creating a company-wide task expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testOwnerSeesAllLocationsInList() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await invoke({ action: 'create', method: 'POST', token: ownerToken(), body: OPS_TASK([7]) })
  await invoke({ action: 'create', method: 'POST', token: ownerToken(), body: OPS_TASK([99]) })
  const res = await invoke({ action: 'list', token: ownerToken() })
  assert(res.body.tasks.length === 2, `owner (locationIds: '*') must see every task regardless of location, got ${res.body.tasks.length}`)
}

async function testAdminHasSameOperationalScopeAsOwner() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'create', method: 'POST', token: adminToken(), body: OPS_TASK('*') })
  assert(res.statusCode === 201, `admin creating a company-wide task expected 201 (operationally similar to Owner for Calendar/Content), got ${res.statusCode}`)
}

async function testScopedMarketingCanCreateWithinItsOwnScope() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'create', method: 'POST', token: marketingToken(), body: OPS_TASK([3, 7]) })
  assert(res.statusCode === 201, `scoped marketing creating within [3,7] expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testScopedMarketingCannotCreateCompanyWide() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'create', method: 'POST', token: marketingToken(), body: OPS_TASK('*') })
  assert(res.statusCode === 403, `a scoped marketing account requesting locationIds: '*' must be rejected outright, got ${res.statusCode}`)
}

// --- Location Manager / canCreateTasks -------------------------------------

async function testCanCreateTasksFalsePreventsCreation() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'create', method: 'POST', token: lmNoToken(), body: OPS_TASK([7]) })
  assert(res.statusCode === 403, `canCreateTasks:false must prevent task creation even within the manager's own location, got ${res.statusCode}`)
}

async function testCanCreateTasksTrueAllowsCreationWithinOwnLocation() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'create', method: 'POST', token: lmYesToken(), body: OPS_TASK([7]) })
  assert(res.statusCode === 201, `canCreateTasks:true must allow creation within the manager's own [7], got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testCanCreateTasksTrueStillRejectsUnauthorizedLocation() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  // usr_lm_yes is scoped to [7] only -- requesting location 99 must fail
  // even though canCreateTasks is true.
  const res = await invoke({ action: 'create', method: 'POST', token: lmYesToken(), body: OPS_TASK([99]) })
  assert(res.statusCode === 403, `canCreateTasks:true must not grant access to a location outside the manager's own grant, got ${res.statusCode}`)
}

async function testUnauthorizedMultiLocationCreationIsRejectedOutrightNotTrimmed() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  // [7] is authorized, [99] is not -- the whole request must be rejected,
  // never silently narrowed to just [7].
  const res = await invoke({ action: 'create', method: 'POST', token: lmYesToken(), body: OPS_TASK([7, 99]) })
  assert(res.statusCode === 403, `a request mixing an authorized and unauthorized location must be rejected outright, got ${res.statusCode}`)
  const list = await invoke({ action: 'list', token: lmYesToken() })
  assert(list.body.tasks.length === 0, 'the rejected request must not have created a trimmed [7]-only task')
}

async function testCanCreateTasksHasNoEffectOnOwnerOrMarketing() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  // Owner/marketing hold TASK_CREATE via the role table regardless of the
  // (irrelevant, unset) canCreateTasks flag on their own account records.
  const res = await invoke({ action: 'create', method: 'POST', token: ownerToken(), body: OPS_TASK([7]) })
  assert(res.statusCode === 201, 'owner must be able to create tasks independent of canCreateTasks')
}

async function testLocationManagerSeesOnlyOwnLocationTasks() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await invoke({ action: 'create', method: 'POST', token: ownerToken(), body: OPS_TASK([7]) })
  await invoke({ action: 'create', method: 'POST', token: ownerToken(), body: OPS_TASK([99]) })
  const res = await invoke({ action: 'list', token: lmYesToken() })
  assert(res.body.tasks.length === 1, `location_manager scoped to [7] must see exactly 1 task, got ${res.body.tasks.length}`)
  assert(res.body.tasks[0].locationIds.includes(7), 'the visible task must be the one for location 7')
}

async function testLocationManagerSeesCompanyWideTasksToo() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await invoke({ action: 'create', method: 'POST', token: ownerToken(), body: OPS_TASK('*') })
  const res = await invoke({ action: 'list', token: lmYesToken() })
  assert(res.body.tasks.length === 1, 'a scoped account must still see an intentionally company-wide (\'*\') task, e.g. a holiday closure')
}

async function testViewerCanListButCannotCreate() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const listRes = await invoke({ action: 'list', token: viewerToken() })
  assert(listRes.statusCode === 200, 'read_only must be able to list tasks (TASK_VIEW)')
  const createRes = await invoke({ action: 'create', method: 'POST', token: viewerToken(), body: OPS_TASK([7]) })
  assert(createRes.statusCode === 403, 'read_only must never be able to create a task')
}

// --- Direct-id tampering / unauthorized update/delete -----------------------

async function testUnauthorizedDirectTaskReadReturns404NotConfirming() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const created = await invoke({ action: 'create', method: 'POST', token: ownerToken(), body: OPS_TASK([99]) })
  const taskId = created.body.task.id
  const res = await invoke({ action: 'get', token: lmYesToken(), query: { id: taskId } })
  assert(res.statusCode === 404, `a location_manager (scoped to [7]) reading a [99]-only task by direct id must get 404, got ${res.statusCode}`)
  assert(res.body.error === 'not_found', 'must be the generic not_found shape, never confirming the task exists elsewhere')
}

async function testUnauthorizedUpdateReturns404() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const created = await invoke({ action: 'create', method: 'POST', token: ownerToken(), body: OPS_TASK([99]) })
  const taskId = created.body.task.id
  const res = await invoke({ action: 'update', method: 'POST', token: lmYesToken(), body: { id: taskId, patch: { status: 'Completed' } } })
  assert(res.statusCode === 404, `updating an out-of-scope task by direct id must get 404, got ${res.statusCode}`)
}

async function testUnauthorizedDeleteReturns403ForRoleWithoutTaskManage() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const created = await invoke({ action: 'create', method: 'POST', token: ownerToken(), body: OPS_TASK([99]) })
  const taskId = created.body.task.id
  // usr_lm_other is scoped to [99] (the same location the task belongs to)
  // but location_manager never holds TASK_MANAGE via the role table at
  // all -- the role gate rejects before location is ever considered.
  const res = await invoke({ action: 'delete', method: 'POST', token: lmOtherToken(), body: { id: taskId } })
  assert(res.statusCode === 403, `location_manager never holds TASK_MANAGE, so delete must be 403 regardless of location match, got ${res.statusCode}`)
}

async function testSelfServiceUpdateAllowsStatusAndNotesOnlyOnOwnAssignedTask() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const created = await invoke({
    action: 'create', method: 'POST', token: ownerToken(),
    body: { ...OPS_TASK([7]), assignee: { userId: 'usr_lm_yes' } },
  })
  const taskId = created.body.task.id

  const okStatus = await invoke({ action: 'update', method: 'POST', token: lmYesToken(), body: { id: taskId, patch: { status: 'Completed' } } })
  assert(okStatus.statusCode === 200, `self-service status update on own assigned task expected 200, got ${okStatus.statusCode}: ${JSON.stringify(okStatus.body)}`)

  const rejectedReassign = await invoke({ action: 'update', method: 'POST', token: lmYesToken(), body: { id: taskId, patch: { assignee: { userId: 'usr_lm_other' } } } })
  assert(rejectedReassign.statusCode === 403, `self-service (no TASK_MANAGE) must not be able to reassign, got ${rejectedReassign.statusCode}`)
}

async function testLocationManagerCannotDeleteEvenOwnAssignedTask() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const created = await invoke({
    action: 'create', method: 'POST', token: ownerToken(),
    body: { ...OPS_TASK([7]), assignee: { userId: 'usr_lm_yes' } },
  })
  const res = await invoke({ action: 'delete', method: 'POST', token: lmYesToken(), body: { id: created.body.task.id } })
  assert(res.statusCode === 403, `location_manager never holds TASK_MANAGE -- delete must be 403, got ${res.statusCode}`)
}

// --- Cross-location review assignment ---------------------------------------

async function testReviewAssignmentTaskRejectsAReviewOutsideTheCallersLocations() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setReviewLocationIndexForTests({ 'r-loc99': 99 }) // NOT in usr_lm_yes's [7] grant
  const res = await invoke({
    action: 'create', method: 'POST', token: lmYesToken(),
    body: { ...REVIEW_TASK(), locationIds: [7], relatedReviewIds: ['r-loc99'] },
  })
  assert(res.statusCode === 400, `a review resolving to an unauthorized location must be rejected, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testReviewAssignmentTaskAcceptsAReviewWithinTheCallersLocations() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setReviewLocationIndexForTests({ 'r-loc7': 7 })
  const res = await invoke({
    action: 'create', method: 'POST', token: lmYesToken(),
    body: { ...REVIEW_TASK(), locationIds: [7], relatedReviewIds: ['r-loc7'] },
  })
  assert(res.statusCode === 201, `a review within the caller's own [7] grant must be accepted, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testReviewAssignmentTaskRejectsAnUnresolvableReviewId() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setReviewLocationIndexForTests({}) // r-unknown resolves to nothing
  const res = await invoke({
    action: 'create', method: 'POST', token: ownerToken(),
    body: { ...REVIEW_TASK(), locationIds: [7], relatedReviewIds: ['r-unknown'] },
  })
  assert(res.statusCode === 400, `an unresolvable review id must be rejected even for an unscoped owner, got ${res.statusCode}`)
}

async function testReviewAssignmentTaskRejectsAReviewOutsideTheTasksOwnLocationIds() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  // The caller (owner) IS authorized for location 99, but the task itself
  // declares locationIds: [7] -- the review must match the TASK's own
  // declared scope too, not just the caller's broader grant.
  _setReviewLocationIndexForTests({ 'r-loc99': 99 })
  const res = await invoke({
    action: 'create', method: 'POST', token: ownerToken(),
    body: { ...REVIEW_TASK(), locationIds: [7], relatedReviewIds: ['r-loc99'] },
  })
  assert(res.statusCode === 400, `a review whose location isn't in the task's own locationIds must be rejected, got ${res.statusCode}`)
}

async function testReviewAssignmentRequiresAtLeastOneReview() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'create', method: 'POST', token: ownerToken(), body: { ...REVIEW_TASK(), relatedReviewIds: [] } })
  assert(res.statusCode === 400, `a review_assignment task with no relatedReviewIds must be rejected, got ${res.statusCode}`)
}

// --- Assignment / due dates / completion / notes-history --------------------

async function testAssignmentDueDateAndCompletionRoundTrip() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const created = await invoke({
    action: 'create', method: 'POST', token: ownerToken(),
    body: { ...OPS_TASK([7]), assignee: { userId: 'usr_lm_yes' }, endAt: '2026-08-28T17:00:00.000Z' },
  })
  assert(created.body.task.assignee.userId === 'usr_lm_yes', 'assignee is stored')
  assert(created.body.task.endAt === '2026-08-28T17:00:00.000Z', 'due date (endAt) is stored')

  const completed = await invoke({
    action: 'update', method: 'POST', token: ownerToken(),
    body: { id: created.body.task.id, patch: { status: 'Completed' }, logAction: 'Marked complete' },
  })
  assert(completed.body.task.status === 'Completed', 'status transitions to Completed')
  assert(completed.body.task.history.some(h => h.action === 'Marked complete'), 'history records the completion')
}

const tests = [
  ['owner can create a company-wide task', testOwnerCanCreateCompanyWideTask],
  ['owner sees tasks across every location', testOwnerSeesAllLocationsInList],
  ['admin has the same operational scope as owner for tasks', testAdminHasSameOperationalScopeAsOwner],
  ['scoped marketing can create within its own authorized locations', testScopedMarketingCanCreateWithinItsOwnScope],
  ['scoped marketing cannot create a company-wide task', testScopedMarketingCannotCreateCompanyWide],
  ['canCreateTasks:false prevents a location manager from creating tasks', testCanCreateTasksFalsePreventsCreation],
  ['canCreateTasks:true allows creation within the manager\'s own location', testCanCreateTasksTrueAllowsCreationWithinOwnLocation],
  ['canCreateTasks:true still rejects a location outside the manager\'s grant', testCanCreateTasksTrueStillRejectsUnauthorizedLocation],
  ['an unauthorized multi-location creation request is rejected outright, never trimmed', testUnauthorizedMultiLocationCreationIsRejectedOutrightNotTrimmed],
  ['canCreateTasks has no effect on owner/marketing (already unconditionally granted)', testCanCreateTasksHasNoEffectOnOwnerOrMarketing],
  ['a location manager sees only tasks for their own location', testLocationManagerSeesOnlyOwnLocationTasks],
  ['a location manager also sees intentionally company-wide (\'*\') tasks', testLocationManagerSeesCompanyWideTasksToo],
  ['a viewer (read_only) can list but never create', testViewerCanListButCannotCreate],
  ['an unauthorized direct task read returns 404, never confirming existence', testUnauthorizedDirectTaskReadReturns404NotConfirming],
  ['an unauthorized direct task update returns 404', testUnauthorizedUpdateReturns404],
  ['an unauthorized direct task delete is rejected (403, no TASK_MANAGE)', testUnauthorizedDeleteReturns403ForRoleWithoutTaskManage],
  ['self-service update allows status/notes only on one\'s own assigned task, never reassignment', testSelfServiceUpdateAllowsStatusAndNotesOnlyOnOwnAssignedTask],
  ['a location manager can never delete a task, even one assigned to them', testLocationManagerCannotDeleteEvenOwnAssignedTask],
  ['a review assignment rejects a review outside the caller\'s authorized locations', testReviewAssignmentTaskRejectsAReviewOutsideTheCallersLocations],
  ['a review assignment accepts a review within the caller\'s authorized locations', testReviewAssignmentTaskAcceptsAReviewWithinTheCallersLocations],
  ['a review assignment rejects an unresolvable review id, even for an owner', testReviewAssignmentTaskRejectsAnUnresolvableReviewId],
  ['a review assignment rejects a review outside the task\'s own declared locationIds', testReviewAssignmentTaskRejectsAReviewOutsideTheTasksOwnLocationIds],
  ['a review_assignment task requires at least one relatedReviewIds entry', testReviewAssignmentRequiresAtLeastOneReview],
  ['assignment, due date, and completion round-trip correctly with history', testAssignmentDueDateAndCompletionRoundTrip],
]

async function main() {
  for (const [name, fn] of tests) await run(name, fn)
  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
