// Regression tests for the restaurant bad-review email workflow's three
// new actions on dashboard/api/actions/[action].js: preview-review-email,
// send-review-email, update-email-status. Drives the real handler with a
// fake req/res (same pattern as test_actions_endpoint.js), controlling
// Redis/email/contact-directory state via each module's test-only seams --
// no real Upstash, mailbox account, or network call anywhere in this file.
//
// Run directly: node tests/test_send_review_email.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/actions/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests, _resetRedisClientForTests } from '../dashboard/api/_lib/actionStore.js'
import { _setContactsForTests, _resetContactsForTests } from '../dashboard/api/_lib/locationContacts.js'
import { _setTransportForTests, _resetTransportForTests } from '../dashboard/api/_lib/emailSender.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
import { _setReviewLocationIndexForTests, _resetReviewLocationIndexForTests } from '../dashboard/api/_lib/reviewLocationIndex.js'

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
    _resetContactsForTests()
    _resetTransportForTests()
    _resetLimiterFactoryForTests()
    _resetReviewLocationIndexForTests()
    delete process.env.VERCEL_ENV
    delete process.env.REVIEW_ESCALATION_CC_EMAILS
    delete process.env.REVIEW_REPLY_TO_EMAIL
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

function fakeMailer(behavior = { ok: true, messageId: 'msg-1' }) {
  return () => ({
    sendMail: async () => {
      if (behavior.ok) return { messageId: behavior.messageId }
      throw new Error(behavior.error || 'send failed')
    },
  })
}

// Also configures REVIEW_ESCALATION_CC_EMAILS by default -- CC is now
// mandatory (management visibility on every restaurant escalation is a
// business requirement, not optional), so every test exercising an actual
// send/preview needs it configured unless it's specifically testing the
// missing-CC failure path (which explicitly deletes it after calling this).
async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner Person' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Marketing Person' },
      { userId: 'usr_locmgr', email: 'locmgr@example.com', passwordHash: hash, role: 'location_manager', locationIds: [3], sessionVersion: 1, disabled: false, displayName: 'Loc Mgr' },
      { userId: 'usr_readonly', email: 'ro@example.com', passwordHash: hash, role: 'read_only', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'RO Person' },
    ],
  })
  process.env.REVIEW_ESCALATION_CC_EMAILS = 'martin@example.com,ruffy@example.com'
}

async function tokenFor(userId, email, role) {
  return signSession({ userId, email, role, locationIds: '*', sessionVersion: 1 })
}

async function invoke({ action, method = 'GET', token, body, query = {} }) {
  const req = {
    method,
    query: { action, ...query },
    body: body ?? {},
    headers: token ? { cookie: `lta_session=${token}` } : {},
    socket: {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

const REVIEW = {
  locationName: 'Los Tres Amigos Canton',
  city: 'Canton',
  starRating: 1,
  reviewerName: 'Jane Doe',
  reviewDate: '2026-07-01',
  reviewText: 'Terrible service.',
  reviewUrl: 'https://maps.google.com/?cid=1',
}

function sendBody(overrides = {}) {
  return { id: 'review-1', locationId: 3, review: REVIEW, ...overrides }
}

// --- Authentication -----------------------------------------------------

async function testSendUnauthenticatedRejected() {
  await setDirectory()
  const res = await invoke({ action: 'send-review-email', method: 'POST', body: sendBody() })
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testSendOwnerAllowed() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  _setTransportForTests(fakeMailer())
  const res = await invoke({ action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), body: sendBody() })
  assert(res.statusCode === 200, `owner: expected 200, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
}

async function testSendMarketingAllowed() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  _setTransportForTests(fakeMailer())
  const res = await invoke({ action: 'send-review-email', method: 'POST', token: await tokenFor('usr_marketing', 'marketing@example.com', 'marketing'), body: sendBody() })
  assert(res.statusCode === 200, `marketing: expected 200, got ${res.statusCode}`)
}

// REVIEWED UPDATE (Multi-Location Authentication & User Access System,
// Commit 4): location_manager is no longer flatly rejected -- it holds
// REPLY_ASSIGNED and this fixture's usr_locmgr is scoped to locationIds:[3],
// the same location sendBody() targets, so this is now a POSITIVE case.
// The rejection behavior itself is still real and tested below, just for a
// location OUTSIDE the account's grant (404, per the frozen error contract
// -- never 403 for an out-of-scope location).
async function testSendLocationManagerAllowedForOwnLocation() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  _setTransportForTests(fakeMailer())
  const res = await invoke({ action: 'send-review-email', method: 'POST', token: await tokenFor('usr_locmgr', 'locmgr@example.com', 'location_manager'), body: sendBody() })
  assert(res.statusCode === 200, `location_manager must be able to send for its own location (3), got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
}

async function testSendLocationManagerDeniedForForeignLocation() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  const res = await invoke({ action: 'send-review-email', method: 'POST', token: await tokenFor('usr_locmgr', 'locmgr@example.com', 'location_manager'), body: sendBody({ locationId: 99 }) })
  assert(res.statusCode === 404, `location_manager must be denied (404, not 403) for a location outside its grant, got ${res.statusCode}`)
}

async function testSendReadOnlyRejected() {
  await setDirectory()
  const res = await invoke({ action: 'send-review-email', method: 'POST', token: await tokenFor('usr_readonly', 'ro@example.com', 'read_only'), body: sendBody() })
  assert(res.statusCode === 403, `read_only must be rejected, got ${res.statusCode}`)
}

// --- Recipient security ---------------------------------------------------

async function testRecipientResolvedFromLocationIdNotClient() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'real-restaurant@example.com', name: 'Real Contact' } })
  let capturedTo = null
  _setTransportForTests(() => ({ sendMail: async (msg) => { capturedTo = msg.to; return { messageId: 'x' } } }))

  const res = await invoke({
    action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'),
    body: sendBody({ recipient: 'attacker@evil.com', to: 'attacker@evil.com' }),
  })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(capturedTo === 'real-restaurant@example.com', `recipient must be server-resolved from locationId, got ${capturedTo}`)
}

async function testCcCannotBeOverriddenByClient() {
  await setDirectory()
  process.env.REVIEW_ESCALATION_CC_EMAILS = 'martin@example.com,ruffy@example.com'
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  let capturedCc = null
  _setTransportForTests(() => ({ sendMail: async (msg) => { capturedCc = msg.cc; return { messageId: 'x' } } }))

  const res = await invoke({
    action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'),
    body: sendBody({ cc: ['attacker@evil.com'] }),
  })
  assert(res.statusCode === 200)
  assert(JSON.stringify(capturedCc) === JSON.stringify(['martin@example.com', 'ruffy@example.com']),
    `cc must always come from REVIEW_ESCALATION_CC_EMAILS, got ${JSON.stringify(capturedCc)}`)
}

async function testReplyToConfiguredFromEnv() {
  await setDirectory()
  process.env.REVIEW_REPLY_TO_EMAIL = 'custom-reply@example.com'
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  let capturedReplyTo = null
  _setTransportForTests(() => ({ sendMail: async (msg) => { capturedReplyTo = msg.replyTo; return { messageId: 'x' } } }))

  await invoke({
    action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'),
    body: sendBody({ replyTo: 'attacker@evil.com' }),
  })
  assert(capturedReplyTo === 'custom-reply@example.com', `Reply-To must come from server config, got ${capturedReplyTo}`)
}

async function testMissingContactPreventsSending() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({}) // no location configured
  _setTransportForTests(fakeMailer())
  const res = await invoke({ action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), body: sendBody({ locationId: 999 }) })
  assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`)
  assert(res.body.error === 'no_contact_configured', `expected no_contact_configured, got ${res.body.error}`)
}

// --- Mandatory CC (management visibility) -----------------------------------
// REVIEW_ESCALATION_CC_EMAILS is mandatory, not best-effort -- an empty CC
// list must refuse to send/preview entirely (503), never send with no CC.

async function testSendFailsWhenCcNotConfigured() {
  await setDirectory()
  delete process.env.REVIEW_ESCALATION_CC_EMAILS
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  _setTransportForTests(fakeMailer())
  const res = await invoke({ action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), body: sendBody() })
  assert(res.statusCode === 503, `expected 503 when CC is unconfigured, got ${res.statusCode}`)
  assert(res.body.error === 'service_unavailable', `expected service_unavailable, got ${res.body.error}`)
  assert(res.body.message === 'Review escalation recipients are not configured.', `expected the exact required message, got "${res.body.message}"`)
}

async function testSendWithNoRecordWrittenWhenCcNotConfigured() {
  await setDirectory()
  delete process.env.REVIEW_ESCALATION_CC_EMAILS
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  _setTransportForTests(fakeMailer())
  await invoke({ action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), body: sendBody() })
  const stored = await client.hget('action_workspace:v1', 'review-1')
  assert(stored === null, 'no record should be written when CC is unconfigured -- nothing was attempted')
}

async function testPreviewFailsWhenCcNotConfigured() {
  await setDirectory()
  delete process.env.REVIEW_ESCALATION_CC_EMAILS
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  const res = await invoke({ action: 'preview-review-email', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), query: { id: 'review-1', locationId: '3' } })
  assert(res.statusCode === 503, `expected 503 when CC is unconfigured, got ${res.statusCode}`)
  assert(res.body.message === 'Review escalation recipients are not configured.', `expected the exact required message, got "${res.body.message}"`)
}

// --- Email safety -----------------------------------------------------------

async function testHeaderInjectionInSubjectRejectedStripped() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  let capturedSubject = null
  _setTransportForTests(() => ({ sendMail: async (msg) => { capturedSubject = msg.subject; return { messageId: 'x' } } }))

  await invoke({
    action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'),
    body: sendBody({ subject: 'Hello\r\nBcc: attacker@evil.com' }),
  })
  assert(!capturedSubject.includes('\r') && !capturedSubject.includes('\n'), `subject must have CR/LF stripped, got ${JSON.stringify(capturedSubject)}`)
}

async function testHtmlAndPlainTextBothGenerated() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  let captured = null
  _setTransportForTests(() => ({ sendMail: async (msg) => { captured = msg; return { messageId: 'x' } } }))

  await invoke({ action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), body: sendBody() })
  assert(typeof captured.html === 'string' && captured.html.includes('<'), 'an HTML body must be generated')
  assert(typeof captured.text === 'string' && !captured.text.includes('<html'), 'a plain-text fallback must be generated')
}

async function testInvalidReviewSnapshotRejected() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  const res = await invoke({
    action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'),
    body: sendBody({ review: { locationName: 'X', starRating: 7 } }), // out-of-range rating
  })
  assert(res.statusCode === 400, `expected 400 for an invalid star rating, got ${res.statusCode}`)
}

// --- Persistence ------------------------------------------------------------

async function testSuccessfulSendUpdatesRedisWithSentStatus() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  _setTransportForTests(fakeMailer({ ok: true, messageId: 'msg-42' }))

  const res = await invoke({ action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), body: sendBody() })
  assert(res.statusCode === 200)
  const { record } = res.body
  assert(record.emailStatus === 'sent', `expected emailStatus sent, got ${record.emailStatus}`)
  assert(record.emailMessageId === 'msg-42')
  assert(record.emailRecipient === 'restaurant@example.com')
  assert(record.sourceLocationId === 3)
  assert(record.sourceReviewId === 'review-1')
  assert(typeof record.emailSentAt === 'string' && record.emailSentAt.length > 0, 'emailSentAt must be a server timestamp')
  assert(record.emailSentBy === 'usr_owner')
  assert(record.history.length === 1, `expected exactly one history entry, got ${record.history.length}`)
  assert(record.history[0].by === 'Owner Person', 'history must attribute the real display name')
  assert(record.history[0].action === 'Review email sent to restaurant')
}

async function testFailedSendDoesNotClaimSent() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  _setTransportForTests(fakeMailer({ ok: false, error: '550 mailbox unavailable' }))

  const res = await invoke({ action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), body: sendBody() })
  assert(res.statusCode === 502, `expected 502 for a genuine send failure, got ${res.statusCode}`)
  assert(res.body.record.emailStatus === 'failed', `a failed send must record 'failed', never 'sent', got ${res.body.record.emailStatus}`)
  assert(res.body.record.emailLastError.includes('mailbox unavailable'), 'the real (sanitized) error must be recorded')
  assert(res.body.record.emailSentAt === undefined || res.body.record.emailSentAt === null, 'a failed send must never carry an emailSentAt')
}

async function testAuthenticationFailureIsSanitizedAndNeverMarksSent() {
  await setDirectory()
  process.env.SMTP_PASSWORD = 'super-secret-m365-password'
  process.env.SMTP_USER = 'advertising@l3amigos.com'
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  // Simulates a realistic Microsoft 365 SMTP AUTH failure whose raw error
  // text happens to echo back the configured credentials (defense in depth
  // -- real M365/nodemailer errors don't actually do this, but the
  // sanitizer must strip them if they ever did).
  _setTransportForTests(fakeMailer({
    ok: false,
    error: '535 5.7.139 Authentication unsuccessful for advertising@l3amigos.com, password super-secret-m365-password rejected',
  }))

  const res = await invoke({ action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), body: sendBody() })
  assert(res.statusCode === 502, `expected 502 for an authentication failure, got ${res.statusCode}`)
  assert(res.body.record.emailStatus === 'failed', `an authentication failure must record 'failed', never 'sent', got ${res.body.record.emailStatus}`)
  assert(res.body.record.emailStatus !== 'sent', 'must never mark sent after an authentication failure')
  assert(!JSON.stringify(res.body).includes('super-secret-m365-password'), 'the configured SMTP_PASSWORD must never appear anywhere in the response body')
  assert(!res.body.record.emailLastError.includes('advertising@l3amigos.com'), 'the configured SMTP_USER must be redacted from the stored diagnostic')
  assert(res.body.record.emailLastError.includes('[redacted]'), 'the redaction marker should appear in place of the stripped credentials')
  delete process.env.SMTP_PASSWORD
  delete process.env.SMTP_USER
}

async function testUnconfiguredEmailSubsystemReturns503NoRecordWritten() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  // No test transport factory and no SMTP_* env vars -- emailSender is unconfigured.
  const res = await invoke({ action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), body: sendBody() })
  assert(res.statusCode === 503, `expected 503, got ${res.statusCode}`)
  const stored = await client.hget('action_workspace:v1', 'review-1')
  assert(stored === null, 'no record should be written when the subsystem is simply unconfigured (nothing was attempted)')
}

// --- Duplicate behavior -------------------------------------------------------

async function testRepeatedSendWithoutConfirmResendReturns409() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  _setTransportForTests(fakeMailer())

  const token = await tokenFor('usr_owner', 'owner@example.com', 'owner')
  const first = await invoke({ action: 'send-review-email', method: 'POST', token, body: sendBody() })
  assert(first.statusCode === 200)

  const second = await invoke({ action: 'send-review-email', method: 'POST', token, body: sendBody() })
  assert(second.statusCode === 409, `expected 409 duplicate-send warning, got ${second.statusCode}`)
  assert(second.body.error === 'already_sent')
}

async function testResendWithConfirmResendCreatesOneAdditionalHistoryEntry() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  _setTransportForTests(fakeMailer())

  const token = await tokenFor('usr_owner', 'owner@example.com', 'owner')
  await invoke({ action: 'send-review-email', method: 'POST', token, body: sendBody() })
  const second = await invoke({ action: 'send-review-email', method: 'POST', token, body: sendBody({ confirmResend: true }) })
  assert(second.statusCode === 200, `resend with confirmResend must succeed, got ${second.statusCode}`)
  assert(second.body.record.history.length === 2, `expected exactly 2 history entries after one resend, got ${second.body.record.history.length}`)
  assert(second.body.record.history[1].action === 'Review email re-sent to restaurant')
}

async function testFailedSendIsNotTreatedAsDuplicateOnRetry() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })

  const token = await tokenFor('usr_owner', 'owner@example.com', 'owner')
  _setTransportForTests(fakeMailer({ ok: false, error: 'temporary failure' }))
  const first = await invoke({ action: 'send-review-email', method: 'POST', token, body: sendBody() })
  assert(first.statusCode === 502)

  _setTransportForTests(fakeMailer({ ok: true, messageId: 'msg-retry' }))
  const second = await invoke({ action: 'send-review-email', method: 'POST', token, body: sendBody() }) // no confirmResend
  assert(second.statusCode === 200, `a retry after a FAILED send must not be treated as a duplicate, got ${second.statusCode}`)
}

async function testRateLimitingEnforced() {
  await setDirectory()
  process.env.VERCEL_ENV = 'production'
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  _setTransportForTests(fakeMailer())
  const { _setLimiterFactoryForTests } = await import('../dashboard/api/_lib/rateLimit.js')
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: false, remaining: 0 }) }))

  const res = await invoke({ action: 'send-review-email', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), body: sendBody() })
  assert(res.statusCode === 429, `expected 429 when rate-limited, got ${res.statusCode}`)
}

// --- preview-review-email ---------------------------------------------------

async function testPreviewReturnsRecipientCcReplyTo() {
  await setDirectory()
  process.env.REVIEW_ESCALATION_CC_EMAILS = 'martin@example.com,ruffy@example.com'
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: 'Manager Name' } })

  const res = await invoke({ action: 'preview-review-email', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), query: { id: 'review-1', locationId: '3' } })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.recipient.email === 'restaurant@example.com')
  assert(res.body.recipient.name === 'Manager Name')
  assert(JSON.stringify(res.body.cc) === JSON.stringify(['martin@example.com', 'ruffy@example.com']))
  assert(res.body.replyTo === 'advertising@l3amigos.com')
  assert(res.body.existingRecord === null, 'no prior record should exist yet')
}

async function testPreviewReturnsNullRecipientWhenUnconfigured() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setContactsForTests({})
  const res = await invoke({ action: 'preview-review-email', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), query: { id: 'review-1', locationId: '999' } })
  assert(res.statusCode === 200)
  assert(res.body.recipient === null, 'recipient must be null (not a guessed value) when unconfigured')
}

// --- update-email-status -----------------------------------------------------

async function testUpdateEmailStatusRejectsSentAsAManualValue() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'update-email-status', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), body: { id: 'review-1', emailStatus: 'sent' } })
  assert(res.statusCode === 400, `'sent' must never be settable through this action, got ${res.statusCode}`)
}

async function testUpdateEmailStatusRejectsWhenNoPriorSend() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'update-email-status', method: 'POST', token: await tokenFor('usr_owner', 'owner@example.com', 'owner'), body: { id: 'never-sent', emailStatus: 'replied' } })
  assert(res.statusCode === 400, `an item with no outgoing email must reject a manual status transition, got ${res.statusCode}`)
}

async function testUpdateEmailStatusHappyPath() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  _setTransportForTests(fakeMailer())
  const token = await tokenFor('usr_owner', 'owner@example.com', 'owner')
  await invoke({ action: 'send-review-email', method: 'POST', token, body: sendBody() })

  const res = await invoke({ action: 'update-email-status', method: 'POST', token, body: { id: 'review-1', emailStatus: 'replied' } })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.record.emailStatus === 'replied')
  assert(res.body.record.history.length === 2, 'expected the send entry plus the replied entry')
  assert(res.body.record.history[1].action === 'Restaurant response recorded')
}

async function testUpdateEmailStatusRejectsAfterFailedSend() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  _setTransportForTests(fakeMailer({ ok: false, error: 'bounced' }))
  const token = await tokenFor('usr_owner', 'owner@example.com', 'owner')
  await invoke({ action: 'send-review-email', method: 'POST', token, body: sendBody() })

  const res = await invoke({ action: 'update-email-status', method: 'POST', token, body: { id: 'review-1', emailStatus: 'replied' } })
  assert(res.statusCode === 400, `a FAILED send must never be manually transitionable to replied, got ${res.statusCode}`)
}

// REVIEWED UPDATE (Multi-Location Authentication & User Access System,
// Commit 4): location_manager holds REPLY_ASSIGNED; this action resolves
// location from `id` (the review) via reviewLocationIndex.js, not an
// explicit locationId field -- test-inject the index so 'review-1' resolves
// to this account's own location (3, matching usr_locmgr's grant above).
async function testUpdateEmailStatusLocationManagerAllowedForOwnLocation() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  _setContactsForTests({ '3': { email: 'restaurant@example.com', name: null } })
  _setTransportForTests(fakeMailer())
  _setReviewLocationIndexForTests({ 'review-1': 3 })
  const ownerT = await tokenFor('usr_owner', 'owner@example.com', 'owner')
  await invoke({ action: 'send-review-email', method: 'POST', token: ownerT, body: sendBody() })

  const res = await invoke({ action: 'update-email-status', method: 'POST', token: await tokenFor('usr_locmgr', 'locmgr@example.com', 'location_manager'), body: { id: 'review-1', emailStatus: 'resolved' } })
  assert(res.statusCode === 200, `location_manager must be able to update the email status for its own location's review, got ${res.statusCode}`)
}

async function testUpdateEmailStatusLocationManagerDeniedForForeignLocation() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  _setReviewLocationIndexForTests({ 'review-1': 99 }) // not in usr_locmgr's [3] grant
  const res = await invoke({ action: 'update-email-status', method: 'POST', token: await tokenFor('usr_locmgr', 'locmgr@example.com', 'location_manager'), body: { id: 'review-1', emailStatus: 'resolved' } })
  assert(res.statusCode === 404, `location_manager must be denied (404, not 403) for a review outside its grant, got ${res.statusCode}`)
}

async function main() {
  await run('send-review-email: unauthenticated -> 401', testSendUnauthenticatedRejected)
  await run('send-review-email: owner allowed', testSendOwnerAllowed)
  await run('send-review-email: marketing allowed', testSendMarketingAllowed)
  await run('send-review-email: location_manager allowed for its own location', testSendLocationManagerAllowedForOwnLocation)
  await run('send-review-email: location_manager denied (404) for a foreign location', testSendLocationManagerDeniedForForeignLocation)
  await run('send-review-email: read_only rejected -> 403', testSendReadOnlyRejected)
  await run('recipient is always resolved server-side from locationId, never the client', testRecipientResolvedFromLocationIdNotClient)
  await run('CC cannot be overridden by the client -- always REVIEW_ESCALATION_CC_EMAILS', testCcCannotBeOverriddenByClient)
  await run('Reply-To is always the server-configured value, never client-supplied', testReplyToConfiguredFromEnv)
  await run('a location with no configured contact prevents sending', testMissingContactPreventsSending)
  await run('send-review-email: fails with 503 when REVIEW_ESCALATION_CC_EMAILS is unconfigured', testSendFailsWhenCcNotConfigured)
  await run('send-review-email: no record is written when CC is unconfigured', testSendWithNoRecordWrittenWhenCcNotConfigured)
  await run('preview-review-email: fails with 503 when REVIEW_ESCALATION_CC_EMAILS is unconfigured', testPreviewFailsWhenCcNotConfigured)
  await run('CR/LF in an edited subject is stripped (header-injection defense)', testHeaderInjectionInSubjectRejectedStripped)
  await run('both HTML and plain-text bodies are generated', testHtmlAndPlainTextBothGenerated)
  await run('an invalid review snapshot (bad star rating) is rejected', testInvalidReviewSnapshotRejected)
  await run('a successful send writes a truthful sent record with one history entry', testSuccessfulSendUpdatesRedisWithSentStatus)
  await run('a failed send never claims sent, records failed + the real error', testFailedSendDoesNotClaimSent)
  await run('an authentication failure is sanitized (SMTP_USER/PASSWORD redacted) and never marks sent', testAuthenticationFailureIsSanitizedAndNeverMarksSent)
  await run('an unconfigured email subsystem -> 503, no record written at all', testUnconfiguredEmailSubsystemReturns503NoRecordWritten)
  await run('a repeated send without confirmResend -> 409 duplicate warning', testRepeatedSendWithoutConfirmResendReturns409)
  await run('a resend with confirmResend succeeds and adds exactly one more history entry', testResendWithConfirmResendCreatesOneAdditionalHistoryEntry)
  await run('a retry after a FAILED send is not blocked as a duplicate', testFailedSendIsNotTreatedAsDuplicateOnRetry)
  await run('send-review-email is rate-limited', testRateLimitingEnforced)
  await run('preview-review-email returns recipient/cc/replyTo', testPreviewReturnsRecipientCcReplyTo)
  await run('preview-review-email returns a null recipient (never guessed) when unconfigured', testPreviewReturnsNullRecipientWhenUnconfigured)
  await run('update-email-status rejects "sent" as a manually-settable value', testUpdateEmailStatusRejectsSentAsAManualValue)
  await run('update-email-status rejects an item with no prior send', testUpdateEmailStatusRejectsWhenNoPriorSend)
  await run('update-email-status happy path (replied)', testUpdateEmailStatusHappyPath)
  await run('update-email-status rejects a transition after a FAILED send', testUpdateEmailStatusRejectsAfterFailedSend)
  await run('update-email-status: location_manager allowed for its own location\'s review', testUpdateEmailStatusLocationManagerAllowedForOwnLocation)
  await run('update-email-status: location_manager denied (404) for a foreign location\'s review', testUpdateEmailStatusLocationManagerDeniedForForeignLocation)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
