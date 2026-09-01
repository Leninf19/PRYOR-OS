// Regression tests for dashboard/api/settings/[action].js's
// `contacts-send-test-email` action (Phase 8, Milestone 8.9). Drives the
// real handler with a fake req/res, controlling contactStore.js's Redis
// state, emailSender.js's transport, and auditLog.js's Redis state via each
// module's own test-only seam -- no real Upstash, mailbox, or network call.
//
// Run directly: node tests/test_settings_send_test_email.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/settings/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests, _resetRedisClientForTests, getContact } from '../dashboard/api/_lib/contactStore.js'
import { _setTransportForTests, _resetTransportForTests } from '../dashboard/api/_lib/emailSender.js'
import { _setRedisClientForTests as _setAuditRedisClientForTests, _resetRedisClientForTests as _resetAuditRedisClientForTests } from '../dashboard/api/_lib/auditLog.js'
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
    _resetTransportForTests()
    _resetAuditRedisClientForTests()
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
    hdel: async (_key, field) => { if (!(field in store)) return 0; delete store[field]; return 1 },
  }
}

function fakeAuditRedis() {
  const list = []
  return {
    lpush: async (_key, value) => { list.unshift(value); return list.length },
    ltrim: async () => 'OK',
    lrange: async () => [...list],
  }
}

function fakeMailer(behavior = { ok: true, response: '250 2.0.0 OK queued' }) {
  return () => ({
    sendMail: async () => {
      if (behavior.ok) return { messageId: 'msg-1', response: behavior.response }
      throw new Error(behavior.error || 'send failed')
    },
  })
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner Person' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Marketing Person' },
      { userId: 'usr_lm', email: 'lm@example.com', passwordHash: hash, role: 'location_manager', locationIds: [9], sessionVersion: 1, disabled: false, displayName: 'Canton Manager' },
    ],
  })
}

async function tokenFor(userId, email, role, locationIds) {
  return signSession({ userId, email, role, locationIds, sessionVersion: 1 })
}
const ownerToken = () => tokenFor('usr_owner', 'owner@example.com', 'owner', '*')
const managerToken = () => tokenFor('usr_lm', 'lm@example.com', 'location_manager', [9])

async function invoke({ token, body }) {
  const req = {
    method: 'POST',
    query: { action: 'contacts-send-test-email' },
    body: body ?? {},
    headers: token ? { cookie: `lta_session=${token}` } : {},
    socket: {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function testRejectsUnauthenticated() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ body: { locationId: 9 } })
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testRejectsLocationManager() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ token: await managerToken(), body: { locationId: 9 } })
  assert(res.statusCode === 403, `location_manager lacks CONTACTS_MANAGE, expected 403, got ${res.statusCode}`)
}

async function testRejectsWhenNoContactConfigured() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setTransportForTests(fakeMailer())
  const res = await invoke({ token: await ownerToken(), body: { locationId: 9 } })
  assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`)
  assert(res.body.error === 'no_contact_configured', `expected no_contact_configured, got ${res.body.error}`)
}

async function testSuccessfulSendReturnsSmtpResponse() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await client.hset('restaurant_contacts:v1', {
    9: JSON.stringify({ locationId: 9, locationName: 'Canton', primaryEmail: 'canton@example.com', ccEmails: [], active: true, history: [] }),
  })
  _setTransportForTests(fakeMailer({ ok: true, response: '250 2.0.0 OK queued as abc123' }))
  const res = await invoke({ token: await ownerToken(), body: { locationId: 9 } })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
  assert(res.body.sentTo === 'canton@example.com')
  assert(res.body.response === '250 2.0.0 OK queued as abc123')
}

async function testSuccessfulSendRecordsContactHistory() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await client.hset('restaurant_contacts:v1', {
    9: JSON.stringify({ locationId: 9, locationName: 'Canton', primaryEmail: 'canton@example.com', ccEmails: [], active: true, history: [] }),
  })
  _setTransportForTests(fakeMailer())
  await invoke({ token: await ownerToken(), body: { locationId: 9 } })
  const record = await getContact(DEFAULT_TENANT_ID, 9)
  assert(record.history.length === 1, `expected one history entry, got ${record.history.length}`)
  assert(record.history[0].action === 'Test email sent')
}

async function testSuccessfulSendAppendsAuditEntry() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await client.hset('restaurant_contacts:v1', {
    9: JSON.stringify({ locationId: 9, locationName: 'Canton', primaryEmail: 'canton@example.com', ccEmails: [], active: true, history: [] }),
  })
  const auditClient = fakeAuditRedis()
  _setAuditRedisClientForTests(() => auditClient)
  _setTransportForTests(fakeMailer())
  await invoke({ token: await ownerToken(), body: { locationId: 9 } })
  const raw = await auditClient.lrange()
  assert(raw.length === 1, `expected exactly one audit entry, got ${raw.length}`)
  const entry = JSON.parse(raw[0])
  assert(entry.entity === 'email' && entry.action === 'email.test_sent' && entry.result === 'success', `unexpected audit entry: ${raw[0]}`)
}

async function testFailedSendReturns502AndRecordsFailure() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await client.hset('restaurant_contacts:v1', {
    9: JSON.stringify({ locationId: 9, locationName: 'Canton', primaryEmail: 'canton@example.com', ccEmails: [], active: true, history: [] }),
  })
  const auditClient = fakeAuditRedis()
  _setAuditRedisClientForTests(() => auditClient)
  _setTransportForTests(fakeMailer({ ok: false, error: '535 5.7.139 Authentication unsuccessful' }))
  const res = await invoke({ token: await ownerToken(), body: { locationId: 9 } })
  assert(res.statusCode === 502, `expected 502, got ${res.statusCode}`)
  assert(res.body.error === 'send_failed')
  assert(res.body.detail.includes('Authentication unsuccessful'))
  const record = await getContact(DEFAULT_TENANT_ID, 9)
  assert(record.history[0].action === 'Test email failed')
  const raw = await auditClient.lrange()
  const entry = JSON.parse(raw[0])
  assert(entry.result === 'failure' && entry.action === 'email.test_failed')
}

async function testAuthFailureRedactsSmtpCredentials() {
  await setDirectory()
  process.env.SMTP_PASSWORD = 'super-secret-m365-password'
  process.env.SMTP_USER = 'advertising@l3amigos.com'
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await client.hset('restaurant_contacts:v1', {
    9: JSON.stringify({ locationId: 9, locationName: 'Canton', primaryEmail: 'canton@example.com', ccEmails: [], active: true, history: [] }),
  })
  _setTransportForTests(fakeMailer({ ok: false, error: '535 auth failed for advertising@l3amigos.com, password super-secret-m365-password rejected' }))
  const res = await invoke({ token: await ownerToken(), body: { locationId: 9 } })
  assert(!JSON.stringify(res.body).includes('super-secret-m365-password'), 'SMTP_PASSWORD must never appear in the response')
  assert(!res.body.detail.includes('advertising@l3amigos.com'), 'SMTP_USER must be redacted from the response detail')
  delete process.env.SMTP_PASSWORD
  delete process.env.SMTP_USER
}

async function testUnconfiguredEmailSubsystemReturns503() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await client.hset('restaurant_contacts:v1', {
    9: JSON.stringify({ locationId: 9, locationName: 'Canton', primaryEmail: 'canton@example.com', ccEmails: [], active: true, history: [] }),
  })
  // No test transport factory and no SMTP_* env vars -- emailSender is unconfigured.
  const res = await invoke({ token: await ownerToken(), body: { locationId: 9 } })
  assert(res.statusCode === 503, `expected 503, got ${res.statusCode}`)
}

async function testOutOfScopeManagerLocationReturns404() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setTransportForTests(fakeMailer())
  const res = await invoke({ token: await managerToken(), body: { locationId: 2 } })
  // location_manager lacks CONTACTS_MANAGE outright, so this 403s at the
  // permission gate before ever reaching location scope -- matches every
  // other contacts-* write action's documented ordering.
  assert(res.statusCode === 403, `expected 403 (no CONTACTS_MANAGE permission at all), got ${res.statusCode}`)
}

// Phase 8, Milestone 8.10 (cross-cutting RBAC verification): a scoped
// account that DOES hold CONTACTS_MANAGE (hypothetical -- every real
// owner/marketing account today is company-wide) must 404, never 403, for
// a location outside its grant -- closing the same gap
// test_settings_contacts_endpoint.js's own scoped-marketing test closes for
// contacts-upsert, but for this endpoint's own requireScopedAuth call.
async function testScopedMarketingAccountGets404ForAnotherLocation() {
  await setDirectory()
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{
      userId: 'usr_scoped_mkt', email: 'scopedmkt@example.com', passwordHash: await bcrypt.hash('x', 12),
      role: 'marketing', locationIds: [9], sessionVersion: 1, disabled: false, displayName: 'Scoped Marketing',
    }],
  })
  _setRedisClientForTests(() => fakeRedis())
  _setTransportForTests(fakeMailer())
  const token = await tokenFor('usr_scoped_mkt', 'scopedmkt@example.com', 'marketing', [9])
  const res = await invoke({ token, body: { locationId: 2 } })
  assert(res.statusCode === 404, `a scoped account WITH CONTACTS_MANAGE must 404 (never 403) for a location outside its grant, got ${res.statusCode}`)
}

async function main() {
  await run('contacts-send-test-email: unauthenticated -> 401', testRejectsUnauthenticated)
  await run('contacts-send-test-email: location_manager rejected -> 403', testRejectsLocationManager)
  await run('contacts-send-test-email: no contact configured -> 400', testRejectsWhenNoContactConfigured)
  await run('a successful send returns the sanitized SMTP response', testSuccessfulSendReturnsSmtpResponse)
  await run('a successful send records one entry in the contact\'s own history', testSuccessfulSendRecordsContactHistory)
  await run('a successful send appends exactly one audit log entry', testSuccessfulSendAppendsAuditEntry)
  await run('a failed send returns 502 and records failure in both history and audit log', testFailedSendReturns502AndRecordsFailure)
  await run('an authentication failure never leaks SMTP_USER/SMTP_PASSWORD', testAuthFailureRedactsSmtpCredentials)
  await run('an unconfigured email subsystem returns 503', testUnconfiguredEmailSubsystemReturns503)
  await run('location_manager is rejected regardless of location scope (no CONTACTS_MANAGE)', testOutOfScopeManagerLocationReturns404)
  await run('a scoped account WITH CONTACTS_MANAGE 404s (not 403) for a location outside its grant', testScopedMarketingAccountGets404ForAnotherLocation)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
