// Regression tests for dashboard/api/settings/[action].js's `email-status`
// action (Phase 8, Milestone 8.9). Drives the real handler with a fake
// req/res, controlling SMTP config via env vars (emailSender.js's
// hasSmtpConfig() reads them directly, no test seam needed for that part)
// and the audit trail via auditLog.js's test-only client-factory seam.
//
// Run directly: node tests/test_settings_email_status_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/settings/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests, _resetRedisClientForTests } from '../dashboard/api/_lib/auditLog.js'
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
    delete process.env.SMTP_HOST
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASSWORD
    delete process.env.SMTP_PORT
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

function fakeAuditRedis(entries = []) {
  const list = [...entries]
  return {
    lpush: async (_key, value) => { list.unshift(value); return list.length },
    ltrim: async () => 'OK',
    lrange: async () => [...list],
  }
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner Person' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Marketing Person' },
      { userId: 'usr_lm', email: 'lm@example.com', passwordHash: hash, role: 'location_manager', locationIds: [9], sessionVersion: 1, disabled: false, displayName: 'Canton Manager' },
      { userId: 'usr_readonly', email: 'readonly@example.com', passwordHash: hash, role: 'read_only', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'RO Person' },
    ],
  })
}

async function tokenFor(userId, email, role, locationIds) {
  return signSession({ userId, email, role, locationIds, sessionVersion: 1 })
}
const ownerToken = () => tokenFor('usr_owner', 'owner@example.com', 'owner', '*')
const marketingToken = () => tokenFor('usr_marketing', 'marketing@example.com', 'marketing', '*')
const managerToken = () => tokenFor('usr_lm', 'lm@example.com', 'location_manager', [9])
const readOnlyToken = () => tokenFor('usr_readonly', 'readonly@example.com', 'read_only', '*')

async function invoke({ token }) {
  const req = {
    method: 'GET',
    query: { action: 'email-status' },
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

async function testRejectsManagerAndReadOnly() {
  await setDirectory()
  const mgrRes = await invoke({ token: await managerToken() })
  assert(mgrRes.statusCode === 403, `location_manager must not have EMAIL_VIEW, expected 403, got ${mgrRes.statusCode}`)
  const roRes = await invoke({ token: await readOnlyToken() })
  assert(roRes.statusCode === 403, `read_only must not have EMAIL_VIEW, expected 403, got ${roRes.statusCode}`)
}

async function testOwnerAndMarketingAllowed() {
  await setDirectory()
  _setRedisClientForTests(() => fakeAuditRedis())
  const ownerRes = await invoke({ token: await ownerToken() })
  assert(ownerRes.statusCode === 200, `owner: expected 200, got ${ownerRes.statusCode}`)
  const mktRes = await invoke({ token: await marketingToken() })
  assert(mktRes.statusCode === 200, `marketing: expected 200, got ${mktRes.statusCode}`)
}

async function testReportsConfiguredWhenSmtpEnvVarsSet() {
  await setDirectory()
  _setRedisClientForTests(() => fakeAuditRedis())
  process.env.SMTP_HOST = 'smtp.office365.com'
  process.env.SMTP_USER = 'advertising@l3amigos.com'
  process.env.SMTP_PASSWORD = 'super-secret'
  const res = await invoke({ token: await ownerToken() })
  assert(res.statusCode === 200)
  assert(res.body.configured === true, 'expected configured: true when all three SMTP env vars are set')
  assert(res.body.authenticated === true, 'authenticated mirrors configured (no live probe on a status read)')
  assert(res.body.host === 'smtp.office365.com')
  assert(!JSON.stringify(res.body).includes('super-secret'), 'the raw SMTP_PASSWORD must never appear in the response')
}

async function testReportsNotConfiguredWhenSmtpEnvVarsMissing() {
  await setDirectory()
  _setRedisClientForTests(() => fakeAuditRedis())
  const res = await invoke({ token: await ownerToken() })
  assert(res.statusCode === 200)
  assert(res.body.configured === false, 'expected configured: false when SMTP env vars are unset')
  assert(res.body.authenticated === false)
}

async function testReportsDirectDeliveryQueueModelNotAFakeQueue() {
  await setDirectory()
  _setRedisClientForTests(() => fakeAuditRedis())
  const res = await invoke({ token: await ownerToken() })
  assert(res.body.queueModel === 'direct-synchronous', `expected the direct-delivery model to be reported truthfully, got ${res.body.queueModel}`)
  assert(typeof res.body.queueMessage === 'string' && res.body.queueMessage.toLowerCase().includes('no queue'), 'queueMessage must explicitly say there is no queue')
}

async function testDerivesLastSuccessAndLastFailureFromAuditLog() {
  await setDirectory()
  const now = new Date().toISOString()
  // Audit entries are read newest-first (LPUSH semantics) -- seed the fake
  // list already in that order.
  _setRedisClientForTests(() => fakeAuditRedis([
    JSON.stringify({ id: '2', at: now, entity: 'email', entityId: '9', action: 'email.test_sent', result: 'success', message: 'Test email sent to canton@example.com for Canton.' }),
    JSON.stringify({ id: '1', at: now, entity: 'email', entityId: '9', action: 'email.test_failed', result: 'failure', message: 'Test email to canton@example.com for Canton failed: 535 auth error' }),
  ]))
  const res = await invoke({ token: await ownerToken() })
  assert(res.statusCode === 200)
  assert(res.body.lastSuccessAt === now, 'lastSuccessAt must be derived from the newest success entry')
  assert(res.body.lastFailureAt === now, 'lastFailureAt must be derived from the newest failure entry')
  assert(res.body.lastFailureMessage.includes('535 auth error'), 'lastFailureMessage must carry the recorded (sanitized) message')
  assert(Array.isArray(res.body.recentErrors) && res.body.recentErrors.length === 1, 'recentErrors must include the failure entry')
}

async function testAuditLogUnavailableDegradesGracefullyInsteadOf503() {
  await setDirectory()
  _setRedisClientForTests(() => ({ lrange: async () => { throw new Error('ECONNREFUSED') } }))
  const res = await invoke({ token: await ownerToken() })
  assert(res.statusCode === 200, `an unavailable audit log must not break the whole status endpoint, expected 200, got ${res.statusCode}`)
  assert(res.body.auditDegraded === true, 'auditDegraded must be true when the audit log could not be read')
  assert(res.body.lastSuccessAt === null && res.body.lastFailureAt === null, 'last-sent/last-failure must be null (not guessed) when degraded')
}

async function main() {
  await run('GET /email-status rejects an unauthenticated request with 401', testRejectsUnauthenticated)
  await run('GET /email-status rejects location_manager and read_only with 403', testRejectsManagerAndReadOnly)
  await run('GET /email-status allows owner and marketing', testOwnerAndMarketingAllowed)
  await run('reports configured:true and never leaks the raw SMTP_PASSWORD', testReportsConfiguredWhenSmtpEnvVarsSet)
  await run('reports configured:false when SMTP env vars are missing', testReportsNotConfiguredWhenSmtpEnvVarsMissing)
  await run('reports a truthful direct-delivery queue model, never a fabricated queue metric', testReportsDirectDeliveryQueueModelNotAFakeQueue)
  await run('derives lastSuccessAt/lastFailureAt/recentErrors from the audit log', testDerivesLastSuccessAndLastFailureFromAuditLog)
  await run('an unavailable audit log degrades gracefully instead of 503ing the whole endpoint', testAuditLogUnavailableDegradesGracefullyInsteadOf503)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
