// Regression tests for dashboard/api/_lib/taskStore.js -- the Redis-backed
// store for freestanding Calendar tasks. Same fakeRedis()/test-seam pattern
// test_action_store.js established; no real Upstash account is used.
//
// Run directly: node tests/test_task_store.js

import {
  getAllTasks, getTask, createTask, updateTask, deleteTask, generateTaskId,
  TaskStoreUnavailableError, _setRedisClientForTests, _resetRedisClientForTests,
} from '../dashboard/api/_lib/taskStore.js'

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
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
  }
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

const OWNER = { userId: 'usr_owner', email: 'owner@example.com', displayName: 'Owner Person' }
const MARIA = { userId: 'usr_maria', email: 'maria@example.com', displayName: 'Maria' }

const BASE_FIELDS = {
  title: 'Reply to Casa Tequila Prime reviews', description: 'Weekly review cleanup',
  type: 'review_assignment', locationIds: [3], assignee: { userId: 'usr_maria' },
  startAt: '2026-08-27T09:00:00.000Z', endAt: '2026-08-27T17:00:00.000Z', allDay: false,
  priority: 'High', status: 'Scheduled', recurrence: null, notes: '',
  relatedReviewIds: ['r1', 'r2'], campaignId: null, sourceActionId: 'opsimpact-needsAttention',
}

async function testUnconfiguredStoreThrowsOnReadAndWrite() {
  let threwRead = false, threwWrite = false
  try { await getAllTasks() } catch (err) { threwRead = err instanceof TaskStoreUnavailableError }
  try { await createTask(BASE_FIELDS, OWNER) } catch (err) { threwWrite = err instanceof TaskStoreUnavailableError }
  assert(threwRead, 'getAllTasks must throw when unconfigured')
  assert(threwWrite, 'createTask must throw when unconfigured, never silently no-op')
}

async function testCreateTaskGeneratesAStableNonPositionalId() {
  _setRedisClientForTests(() => fakeRedis())
  const a = await createTask(BASE_FIELDS, OWNER)
  const b = await createTask(BASE_FIELDS, OWNER)
  assert(typeof a.id === 'string' && a.id.startsWith('task_'), 'generated id must be a string with the task_ prefix')
  assert(a.id !== b.id, 'two created tasks must never collide on id, even with identical fields')
  assert(generateTaskId() !== generateTaskId(), 'generateTaskId() must never repeat')
}

async function testCreateTaskStampsServerAuthoritativeFields() {
  _setRedisClientForTests(() => fakeRedis())
  const record = await createTask(BASE_FIELDS, OWNER)
  assert(record.createdBy === 'usr_owner', 'createdBy stamped from the authenticated account')
  assert(record.updatedBy === 'usr_owner', 'updatedBy stamped from the authenticated account')
  assert(record.createdAt === record.updatedAt, 'on creation, createdAt and updatedAt coincide')
  assert(record.history.length === 1 && record.history[0].action === 'Task created', 'creation appends exactly one history entry')
  assert(record.sourceActionId === 'opsimpact-needsAttention', 'sourceActionId is preserved from the AI suggestion it was converted from')
  assert(record.assignee.userId === 'usr_maria', 'assignee is preserved')
  assert(record.relatedReviewIds.length === 2, 'relatedReviewIds is preserved')
}

async function testCreateTaskDefaultsMissingOptionalFields() {
  _setRedisClientForTests(() => fakeRedis())
  const record = await createTask({ title: 'Minimal task', type: 'other', locationIds: '*', startAt: '2026-08-27T09:00:00.000Z' }, OWNER)
  assert(record.status === 'Scheduled', 'status defaults to Scheduled')
  assert(record.priority === 'Medium', 'priority defaults to Medium')
  assert(record.assignee === null, 'assignee defaults to null')
  assert(Array.isArray(record.relatedReviewIds) && record.relatedReviewIds.length === 0, 'relatedReviewIds defaults to an empty array')
  assert(record.sourceActionId === null, 'sourceActionId defaults to null')
}

async function testUpdateTaskMergesAndStampsUpdatedFields() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const created = await createTask(BASE_FIELDS, OWNER)
  const updated = await updateTask(created.id, { status: 'Completed' }, MARIA, 'Marked complete')
  assert(updated.status === 'Completed', 'patch is applied')
  assert(updated.createdBy === 'usr_owner', 'createdBy never changes on update')
  assert(updated.updatedBy === 'usr_maria', 'updatedBy reflects the most recent actor')
  assert(updated.history.length === 2, 'history accumulates')
  assert(updated.history[1].action === 'Marked complete' && updated.history[1].by === 'Maria', 'the new history entry records actor and action')
}

async function testUpdateTaskReturnsNullForUnknownId() {
  _setRedisClientForTests(() => fakeRedis())
  const result = await updateTask('does-not-exist', { status: 'Completed' }, OWNER, 'x')
  assert(result === null, 'updating an unknown id must return null, never create a task the caller did not ask for')
}

async function testUpdateWithoutLogActionDoesNotAppendHistory() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const created = await createTask(BASE_FIELDS, OWNER)
  const updated = await updateTask(created.id, { notes: 'checked in' }, OWNER, undefined)
  assert(updated.history.length === 1, 'a plain notes edit with no logAction must not add a second history entry')
  assert(updated.notes === 'checked in', 'the patch is still applied')
}

async function testDeleteTaskRemovesRecordAndReturnsBoolean() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const created = await createTask(BASE_FIELDS, OWNER)
  const deletedFirst = await deleteTask(created.id)
  const deletedSecond = await deleteTask(created.id)
  assert(deletedFirst === true, 'deleting an existing task returns true')
  assert(deletedSecond === false, 'deleting an already-deleted task returns false, not throw')
  assert(await getTask(created.id) === null, 'the task is genuinely gone after deletion')
}

async function testGetAllTasksReturnsEveryRecordIndependently() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  const a = await createTask({ ...BASE_FIELDS, title: 'Task A' }, OWNER)
  const b = await createTask({ ...BASE_FIELDS, title: 'Task B', locationIds: '*' }, OWNER)
  const all = await getAllTasks()
  assert(Object.keys(all).length === 2, 'both records are returned')
  assert(all[a.id].title === 'Task A' && all[b.id].title === 'Task B', 'each record keeps its own fields')
}

async function testReadAndWriteFailuresSurfaceAsUnavailable() {
  _setRedisClientForTests(() => ({ hgetall: async () => { throw new Error('ECONNREFUSED') } }))
  let threwRead = false
  try { await getAllTasks() } catch (err) { threwRead = err instanceof TaskStoreUnavailableError }
  assert(threwRead, 'a Redis read failure must surface as TaskStoreUnavailableError')

  _setRedisClientForTests(() => ({ hget: async () => null, hset: async () => { throw new Error('ECONNREFUSED') } }))
  let threwWrite = false
  try { await createTask(BASE_FIELDS, OWNER) } catch (err) { threwWrite = err instanceof TaskStoreUnavailableError }
  assert(threwWrite, 'a Redis write failure must surface as TaskStoreUnavailableError')
}

async function testMalformedStoredValueIsSkippedNotThrown() {
  _setRedisClientForTests(() => fakeRedis({ task_bad: 'not valid json {{{' }))
  const all = await getAllTasks()
  assert(Object.keys(all).length === 0, 'a corrupted stored record is skipped rather than crashing the whole read')
}

const tests = [
  ['unconfigured store throws on read and write (never silently empty/no-op)', testUnconfiguredStoreThrowsOnReadAndWrite],
  ['createTask generates a stable, non-positional, collision-free id', testCreateTaskGeneratesAStableNonPositionalId],
  ['createTask stamps server-authoritative fields and preserves sourceActionId/assignee/relatedReviewIds', testCreateTaskStampsServerAuthoritativeFields],
  ['createTask defaults missing optional fields sensibly', testCreateTaskDefaultsMissingOptionalFields],
  ['updateTask merges a patch and stamps updatedBy/updatedAt/history', testUpdateTaskMergesAndStampsUpdatedFields],
  ['updateTask returns null for an unknown id, never creates one', testUpdateTaskReturnsNullForUnknownId],
  ['updateTask without logAction does not append a history entry', testUpdateWithoutLogActionDoesNotAppendHistory],
  ['deleteTask removes the record and returns a boolean', testDeleteTaskRemovesRecordAndReturnsBoolean],
  ['getAllTasks returns every stored record independently', testGetAllTasksReturnsEveryRecordIndependently],
  ['Redis read/write failures surface as TaskStoreUnavailableError', testReadAndWriteFailuresSurfaceAsUnavailable],
  ['a corrupted stored record is skipped, not thrown', testMalformedStoredValueIsSkippedNotThrown],
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
