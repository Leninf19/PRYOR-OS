// Regression tests for dashboard/api/actions/[action].js -- the
// consolidated Action Center workspace endpoint (GET list / POST update).
// Drives the real handler with a fake req/res, same pattern as
// test_data_endpoint.js, and controls the underlying Redis-backed store via
// actionStore.js's test-only client-factory seam (no real Upstash account).
//
// Run directly: node tests/test_actions_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/actions/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests, _resetRedisClientForTests } from '../dashboard/api/_lib/actionStore.js'
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
  }
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner Person' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Marketing Person' },
      { userId: 'usr_readonly', email: 'readonly@example.com', passwordHash: hash, role: 'read_only', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'RO Person' },
    ],
  })
}

async function ownerToken() {
  return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', sessionVersion: 1 })
}
async function readOnlyToken() {
  return signSession({ userId: 'usr_readonly', email: 'readonly@example.com', role: 'read_only', locationIds: '*', sessionVersion: 1 })
}

async function invoke({ action, method = 'GET', token, body }) {
  const req = {
    method,
    query: { action },
    body: body ?? {},
    headers: token ? { cookie: `lta_session=${token}` } : {},
    socket: {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function testUnknownActionReturns404() {
  await setDirectory()
  const res = await invoke({ action: 'nonsense', token: await ownerToken() })
  assert(res.statusCode === 404, `expected 404, got ${res.statusCode}`)
}

async function testListUnauthenticatedReturns401() {
  await setDirectory()
  const res = await invoke({ action: 'list' })
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testListReadOnlyForbidden() {
  await setDirectory()
  const res = await invoke({ action: 'list', token: await readOnlyToken() })
  assert(res.statusCode === 403, `read_only must not view the workspace yet, got ${res.statusCode}`)
}

async function testListWrongMethodReturns405() {
  await setDirectory()
  const res = await invoke({ action: 'list', method: 'POST', token: await ownerToken() })
  assert(res.statusCode === 405, `expected 405, got ${res.statusCode}`)
}

async function testListReturnsEmptyWhenNoRecords() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'list', token: await ownerToken() })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
  assert(Object.keys(res.body.actions).length === 0, 'no records yet -> empty object')
}

async function testListStoreUnavailableReturns503() {
  await setDirectory()
  // No test factory and no UPSTASH_* env vars -- store is unconfigured.
  const res = await invoke({ action: 'list', token: await ownerToken() })
  assert(res.statusCode === 503, `expected 503 when the store is unconfigured, got ${res.statusCode}`)
}

async function testUpdateUnauthenticatedReturns401() {
  await setDirectory()
  const res = await invoke({ action: 'update', method: 'POST', body: { id: 'a1', patch: { status: 'Assigned' } } })
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testUpdateReadOnlyForbidden() {
  await setDirectory()
  const res = await invoke({ action: 'update', method: 'POST', token: await readOnlyToken(), body: { id: 'a1', patch: { status: 'Assigned' } } })
  assert(res.statusCode === 403, `read_only must not write to the workspace, got ${res.statusCode}`)
}

async function testUpdateMissingIdReturns400() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'update', method: 'POST', token: await ownerToken(), body: { patch: { status: 'Assigned' } } })
  assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`)
}

async function testUpdateRejectsUnknownPatchField() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'update', method: 'POST', token: await ownerToken(), body: { id: 'a1', patch: { hacked: true } } })
  assert(res.statusCode === 400, `an unrecognized patch field must be rejected, got ${res.statusCode}`)
}

async function testUpdateRejectsClientSuppliedServerFields() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  for (const forbidden of ['createdBy', 'createdAt', 'updatedBy', 'updatedAt', 'history', 'id']) {
    const res = await invoke({ action: 'update', method: 'POST', token: await ownerToken(), body: { id: 'a1', patch: { [forbidden]: 'x' } } })
    assert(res.statusCode === 400, `patching server-owned field "${forbidden}" must be rejected, got ${res.statusCode}`)
  }
}

async function testUpdateRejectsInvalidStatus() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'update', method: 'POST', token: await ownerToken(), body: { id: 'a1', patch: { status: 'Not A Real Status' } } })
  assert(res.statusCode === 400, `an invalid status value must be rejected, got ${res.statusCode}`)
}

async function testUpdateHappyPathStampsServerFields() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({
    action: 'update', method: 'POST', token: await ownerToken(),
    body: { id: 'complaint_wait_time', patch: { status: 'Assigned', assignedTo: 'usr_marketing' }, logAction: 'Status -> Assigned' },
  })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
  const { record } = res.body
  assert(record.status === 'Assigned', 'status is applied')
  assert(record.assignedTo === 'usr_marketing', 'assignedTo is applied')
  assert(record.createdBy === 'usr_owner', 'createdBy is stamped from the authenticated caller')
  assert(record.updatedBy === 'usr_owner', 'updatedBy is stamped from the authenticated caller')
  assert(record.history.length === 1 && record.history[0].by === 'Owner Person', 'history attributes the change to the real display name')
}

async function testUpdateStoreUnavailableReturns503() {
  await setDirectory()
  const res = await invoke({ action: 'update', method: 'POST', token: await ownerToken(), body: { id: 'a1', patch: { status: 'Assigned' } } })
  assert(res.statusCode === 503, `expected 503 when the store is unconfigured, got ${res.statusCode}`)
}

async function testUpdateWrongMethodReturns405() {
  await setDirectory()
  const res = await invoke({ action: 'update', method: 'GET', token: await ownerToken() })
  assert(res.statusCode === 405, `expected 405, got ${res.statusCode}`)
}

async function testUpdateIsRateLimited() {
  await setDirectory()
  process.env.VERCEL_ENV = 'production'
  _setRedisClientForTests(() => fakeRedis())
  const { _setLimiterFactoryForTests } = await import('../dashboard/api/_lib/rateLimit.js')
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: false, remaining: 0 }) }))
  const res = await invoke({ action: 'update', method: 'POST', token: await ownerToken(), body: { id: 'a1', patch: { status: 'Assigned' } } })
  assert(res.statusCode === 429, `a denied rate limit must block the write with 429, got ${res.statusCode}`)
}

async function main() {
  await run('unknown action -> 404', testUnknownActionReturns404)
  await run('list: unauthenticated -> 401', testListUnauthenticatedReturns401)
  await run('list: read_only -> 403 (not yet a viewer role for this workspace)', testListReadOnlyForbidden)
  await run('list: wrong method -> 405', testListWrongMethodReturns405)
  await run('list: no records yet -> 200 with empty object', testListReturnsEmptyWhenNoRecords)
  await run('list: unconfigured store -> 503', testListStoreUnavailableReturns503)
  await run('update: unauthenticated -> 401', testUpdateUnauthenticatedReturns401)
  await run('update: read_only -> 403', testUpdateReadOnlyForbidden)
  await run('update: missing id -> 400', testUpdateMissingIdReturns400)
  await run('update: unrecognized patch field -> 400', testUpdateRejectsUnknownPatchField)
  await run('update: client-supplied server-owned fields -> 400', testUpdateRejectsClientSuppliedServerFields)
  await run('update: invalid status value -> 400', testUpdateRejectsInvalidStatus)
  await run('update: happy path stamps server-authoritative fields and real display name', testUpdateHappyPathStampsServerFields)
  await run('update: unconfigured store -> 503', testUpdateStoreUnavailableReturns503)
  await run('update: wrong method -> 405', testUpdateWrongMethodReturns405)
  await run('update: rate-limited caller -> 429', testUpdateIsRateLimited)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
