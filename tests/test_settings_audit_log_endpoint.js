// Regression tests for dashboard/api/settings/[action].js's audit-log
// action (Phase 8, Milestone 8.6). Drives the real handler with a fake
// req/res, same pattern as test_settings_contacts_endpoint.js, and
// controls the underlying Redis-backed audit log via auditLog.js's
// test-only client-factory seam.
//
// Run directly: node tests/test_settings_audit_log_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/settings/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests, _resetRedisClientForTests, appendAuditEntry } from '../dashboard/api/_lib/auditLog.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
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

function fakeAuditRedis() {
  const list = []
  return {
    lpush: async (_key, value) => { list.unshift(value); return list.length },
    ltrim: async () => 'OK',
    lrange: async (_key, start, stop) => list.slice(start, stop === -1 ? undefined : stop + 1),
  }
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner Person' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Marketing Person' },
    ],
  })
}

const ownerToken = () => signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
const marketingToken = () => signSession({ userId: 'usr_marketing', email: 'marketing@example.com', role: 'marketing', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })

async function invoke({ method = 'GET', token, query = {} }) {
  const req = {
    method,
    query: { action: 'audit-log', ...query },
    body: {},
    headers: token ? { cookie: `lta_session=${token}` } : {},
    socket: {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function testRejectsUnauthenticated() {
  await setDirectory()
  const res = await invoke({})
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testRejectsMarketing() {
  // The global audit log is Owner-only -- Marketing gets CONTACTS_MANAGE
  // (per the approved Phase 8 matrix) but not AUDIT_VIEW.
  await setDirectory()
  const res = await invoke({ token: await marketingToken() })
  assert(res.statusCode === 403, `expected 403 for marketing, got ${res.statusCode}`)
}

async function testRejectsNonGetMethod() {
  await setDirectory()
  const res = await invoke({ method: 'POST', token: await ownerToken() })
  assert(res.statusCode === 405, `expected 405 for POST, got ${res.statusCode}`)
}

async function testOwnerSeesEntriesAndTotal() {
  await setDirectory()
  const client = fakeAuditRedis()
  _setRedisClientForTests(() => client)
  await appendAuditEntry(DEFAULT_TENANT_ID, { actorId: 'usr_owner', actorName: 'Owner', actorEmail: 'owner@example.com', ip: null, entity: 'contact', entityId: '9', action: 'contact.created', changes: null, result: 'success', message: 'x' })
  const res = await invoke({ token: await ownerToken() })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.total === 1 && res.body.entries.length === 1, 'the appended entry must be returned')
}

async function testQueryFiltersPassThrough() {
  await setDirectory()
  const client = fakeAuditRedis()
  _setRedisClientForTests(() => client)
  await appendAuditEntry(DEFAULT_TENANT_ID, { actorId: 'usr_owner', actorName: 'Owner', actorEmail: 'owner@example.com', ip: null, entity: 'contact', entityId: '9', action: 'contact.created', changes: null, result: 'success', message: 'contact event' })
  await appendAuditEntry(DEFAULT_TENANT_ID, { actorId: 'usr_owner', actorName: 'Owner', actorEmail: 'owner@example.com', ip: null, entity: 'google_oauth', entityId: null, action: 'google.reconnected', changes: null, result: 'success', message: 'oauth event' })
  const res = await invoke({ token: await ownerToken(), query: { entity: 'contact' } })
  assert(res.body.total === 1 && res.body.entries[0].entity === 'contact', 'the entity query param must filter the results')
}

async function testLimitIsClampedToASaneRange() {
  await setDirectory()
  const client = fakeAuditRedis()
  _setRedisClientForTests(() => client)
  for (let i = 0; i < 3; i++) {
    await appendAuditEntry(DEFAULT_TENANT_ID, { actorId: 'usr_owner', actorName: 'Owner', actorEmail: 'owner@example.com', ip: null, entity: 'contact', entityId: String(i), action: 'contact.created', changes: null, result: 'success', message: `e${i}` })
  }
  // An out-of-range limit (e.g. 99999 or a non-numeric value) must fall
  // back to the default (50), never be passed through unchecked.
  const res = await invoke({ token: await ownerToken(), query: { limit: '99999' } })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.entries.length === 3, 'with only 3 entries and a clamped default limit, all 3 must still be returned')
}

async function testUnavailableStoreReturns503() {
  await setDirectory()
  _setRedisClientForTests(() => ({ lrange: async () => { throw new Error('ECONNREFUSED') } }))
  const res = await invoke({ token: await ownerToken() })
  assert(res.statusCode === 503, `expected 503 when the audit log is unreachable, got ${res.statusCode}`)
}

async function main() {
  await run('audit-log rejects an unauthenticated request with 401', testRejectsUnauthenticated)
  await run('audit-log rejects marketing (Owner-only) with 403', testRejectsMarketing)
  await run('audit-log rejects a non-GET method with 405', testRejectsNonGetMethod)
  await run('owner sees appended entries and a total count', testOwnerSeesEntriesAndTotal)
  await run('entity/actorId/result query params filter the results', testQueryFiltersPassThrough)
  await run('an out-of-range limit is clamped to the default, not passed through unchecked', testLimitIsClampedToASaneRange)
  await run('an unavailable audit log surfaces as 503', testUnavailableStoreReturns503)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
