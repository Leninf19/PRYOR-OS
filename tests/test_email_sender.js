// Regression tests for dashboard/api/_lib/emailSender.js -- the direct
// Vercel-side email delivery seam for the restaurant bad-review email
// workflow. No real Gmail account or network call is used anywhere in this
// file: every test drives the module's test-only transport-factory seam
// (_setTransportForTests), same pattern as actionStore.js's
// _setRedisClientForTests.
//
// Run directly: node tests/test_email_sender.js

import {
  sendReviewEmail,
  EmailSenderUnavailableError,
  _setTransportForTests,
  _resetTransportForTests,
} from '../dashboard/api/_lib/emailSender.js'

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
    _resetTransportForTests()
    delete process.env.GMAIL_USER
    delete process.env.GMAIL_APP_PASSWORD
    delete process.env.REVIEW_FROM_NAME
  }
}

const BASE_MESSAGE = {
  to: 'restaurant@example.com',
  cc: ['martin@example.com', 'ruffy@example.com'],
  replyTo: 'advertising@l3amigos.com',
  subject: 'Response Requested — Test Location — 1-Star Customer Review',
  html: '<p>hello</p>',
  text: 'hello',
}

async function testUnconfiguredThrowsUnavailableError() {
  // No GMAIL_USER/GMAIL_APP_PASSWORD, no test factory.
  let threw = false
  try {
    await sendReviewEmail(BASE_MESSAGE)
  } catch (err) {
    threw = err instanceof EmailSenderUnavailableError
  }
  assert(threw, 'sendReviewEmail() must throw EmailSenderUnavailableError when unconfigured')
}

async function testSuccessfulSendReturnsMessageId() {
  let captured = null
  _setTransportForTests(() => ({
    sendMail: async (msg) => { captured = msg; return { messageId: 'msg-123' } },
  }))
  const result = await sendReviewEmail(BASE_MESSAGE)
  assert(result.messageId === 'msg-123', `expected messageId msg-123, got ${result.messageId}`)
  assert(captured.to === BASE_MESSAGE.to, 'to must be passed through')
  assert(JSON.stringify(captured.cc) === JSON.stringify(BASE_MESSAGE.cc), 'cc must be passed through')
  assert(captured.replyTo === BASE_MESSAGE.replyTo, 'replyTo must be passed through')
  assert(captured.subject === BASE_MESSAGE.subject, 'subject must be passed through')
}

async function testFromAddressUsesGmailUser() {
  process.env.GMAIL_USER = 'dashboard@example.com'
  process.env.GMAIL_APP_PASSWORD = 'not-a-real-password'
  let captured = null
  _setTransportForTests(() => ({
    sendMail: async (msg) => { captured = msg; return { messageId: 'x' } },
  }))
  await sendReviewEmail(BASE_MESSAGE)
  assert(captured.from.includes('dashboard@example.com'), `expected From to reference GMAIL_USER, got ${captured.from}`)
  assert(captured.from.includes('LTA Review Dashboard'), `expected the default display name when REVIEW_FROM_NAME is unset, got ${captured.from}`)
}

async function testFromAddressUsesConfiguredDisplayName() {
  process.env.GMAIL_USER = 'dashboard@example.com'
  process.env.GMAIL_APP_PASSWORD = 'not-a-real-password'
  process.env.REVIEW_FROM_NAME = 'Los Tres Amigos Marketing Team'
  let captured = null
  _setTransportForTests(() => ({
    sendMail: async (msg) => { captured = msg; return { messageId: 'x' } },
  }))
  await sendReviewEmail(BASE_MESSAGE)
  assert(captured.from === '"Los Tres Amigos Marketing Team" <dashboard@example.com>', `expected the configured display name, got ${captured.from}`)
}

async function testEmptyCcOmittedNotSentAsEmptyArray() {
  let captured = null
  _setTransportForTests(() => ({
    sendMail: async (msg) => { captured = msg; return { messageId: 'x' } },
  }))
  await sendReviewEmail({ ...BASE_MESSAGE, cc: [] })
  assert(captured.cc === undefined, 'an empty cc array must be omitted from the outgoing message, not sent as []')
}

async function testSendFailurePropagatesAsPlainErrorNotUnavailable() {
  _setTransportForTests(() => ({
    sendMail: async () => { throw new Error('550 5.1.1 recipient rejected') },
  }))
  let caught = null
  try {
    await sendReviewEmail(BASE_MESSAGE)
  } catch (err) {
    caught = err
  }
  assert(caught !== null, 'a real send failure must propagate, not be swallowed')
  assert(!(caught instanceof EmailSenderUnavailableError),
    'a genuine SMTP send failure must NOT be classified as EmailSenderUnavailableError -- callers distinguish "not configured" (503, no record written) from "attempted and failed" (record as failed)')
  assert(caught.message.includes('recipient rejected'), 'the real error message must be preserved for the caller to log/sanitize')
}

async function main() {
  await run('unconfigured (no Gmail credentials) throws EmailSenderUnavailableError', testUnconfiguredThrowsUnavailableError)
  await run('a successful send returns the provider messageId and passes fields through', testSuccessfulSendReturnsMessageId)
  await run('the From address is built from GMAIL_USER, with the default display name', testFromAddressUsesGmailUser)
  await run('the From display name uses REVIEW_FROM_NAME when configured', testFromAddressUsesConfiguredDisplayName)
  await run('an empty cc array is omitted, not sent as []', testEmptyCcOmittedNotSentAsEmptyArray)
  await run('a genuine SMTP send failure propagates as a plain Error, distinct from EmailSenderUnavailableError', testSendFailurePropagatesAsPlainErrorNotUnavailable)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
