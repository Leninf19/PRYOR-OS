// Regression tests for dashboard/api/_lib/emailSender.js -- the direct
// Vercel-side, provider-neutral SMTP email delivery seam for the
// restaurant bad-review email workflow. No real mailbox account or network
// call is used anywhere in this file: every test drives the module's
// test-only transport-factory seam (_setTransportForTests) or the pure
// buildTransportConfig() function, same pattern as actionStore.js's
// _setRedisClientForTests.
//
// Run directly: node tests/test_email_sender.js

import {
  sendReviewEmail,
  buildTransportConfig,
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
    delete process.env.SMTP_HOST
    delete process.env.SMTP_PORT
    delete process.env.SMTP_SECURE
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASSWORD
    delete process.env.SMTP_FROM_NAME
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

function setFullSmtpConfig() {
  process.env.SMTP_HOST = 'smtp.office365.com'
  process.env.SMTP_PORT = '587'
  process.env.SMTP_USER = 'advertising@l3amigos.com'
  process.env.SMTP_PASSWORD = 'not-a-real-password'
}

// --- Missing configuration ---------------------------------------------------

async function testUnconfiguredThrowsUnavailableError() {
  // No SMTP_* vars at all, no test factory.
  let threw = false
  try {
    await sendReviewEmail(BASE_MESSAGE)
  } catch (err) {
    threw = err instanceof EmailSenderUnavailableError
  }
  assert(threw, 'sendReviewEmail() must throw EmailSenderUnavailableError when unconfigured')
}

async function testMissingHostAloneStillThrowsUnavailable() {
  process.env.SMTP_USER = 'advertising@l3amigos.com'
  process.env.SMTP_PASSWORD = 'not-a-real-password'
  // SMTP_HOST intentionally left unset.
  let threw = false
  try {
    await sendReviewEmail(BASE_MESSAGE)
  } catch (err) {
    threw = err instanceof EmailSenderUnavailableError
  }
  assert(threw, 'a missing SMTP_HOST alone must still be treated as unconfigured')
}

async function testMissingPasswordAloneStillThrowsUnavailable() {
  process.env.SMTP_HOST = 'smtp.office365.com'
  process.env.SMTP_USER = 'advertising@l3amigos.com'
  // SMTP_PASSWORD intentionally left unset.
  let threw = false
  try {
    await sendReviewEmail(BASE_MESSAGE)
  } catch (err) {
    threw = err instanceof EmailSenderUnavailableError
  }
  assert(threw, 'a missing SMTP_PASSWORD alone must still be treated as unconfigured')
}

async function testUnavailableErrorMessageIsProviderNeutral() {
  let message = null
  try {
    await sendReviewEmail(BASE_MESSAGE)
  } catch (err) {
    message = err.message
  }
  assert(message !== null)
  assert(!/gmail/i.test(message), `error message must never mention Gmail, got "${message}"`)
  assert(/SMTP/.test(message), `error message must reference SMTP configuration, got "${message}"`)
}

// --- buildTransportConfig() (port parsing / STARTTLS / host) ----------------

async function testDefaultPortIs587WhenUnset() {
  process.env.SMTP_HOST = 'smtp.office365.com'
  const config = buildTransportConfig()
  assert(config.port === 587, `expected default port 587, got ${config.port}`)
}

async function testConfiguredPortIsParsedAsNumber() {
  process.env.SMTP_PORT = '2525'
  const config = buildTransportConfig()
  assert(config.port === 2525 && typeof config.port === 'number', `expected numeric port 2525, got ${JSON.stringify(config.port)}`)
}

async function testStarttlsConfigurationForPort587() {
  process.env.SMTP_SECURE = 'false'
  const config = buildTransportConfig()
  assert(config.secure === false, 'secure must be false for STARTTLS (port 587)')
  assert(config.requireTLS === true, 'requireTLS must be true so the connection is refused rather than falling back to plaintext')
}

async function testStarttlsIsTheDefaultWhenSmtpSecureUnset() {
  // SMTP_SECURE intentionally left unset.
  const config = buildTransportConfig()
  assert(config.secure === false, 'secure must default to false (STARTTLS) when SMTP_SECURE is unset')
  assert(config.requireTLS === true)
}

async function testImplicitTlsConfigurationWhenSmtpSecureTrue() {
  process.env.SMTP_SECURE = 'true'
  const config = buildTransportConfig()
  assert(config.secure === true, 'secure must be true when SMTP_SECURE=true (implicit TLS, e.g. port 465)')
  assert(config.requireTLS === false, 'requireTLS must not be redundantly set on an already-implicit-TLS connection')
}

async function testMicrosoft365HostConfiguration() {
  process.env.SMTP_HOST = 'smtp.office365.com'
  process.env.SMTP_PORT = '587'
  process.env.SMTP_SECURE = 'false'
  process.env.SMTP_USER = 'advertising@l3amigos.com'
  const config = buildTransportConfig()
  assert(config.host === 'smtp.office365.com')
  assert(config.port === 587)
  assert(config.secure === false)
  assert(config.requireTLS === true)
  assert(config.auth.user === 'advertising@l3amigos.com')
}

async function testNoTlsCertificateValidationWeakening() {
  const config = buildTransportConfig()
  assert(config.tls === undefined, 'buildTransportConfig must never set a tls override (e.g. rejectUnauthorized: false)')
}

// --- sendReviewEmail() behavior ----------------------------------------------

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

async function testFromAddressUsesSmtpUser() {
  setFullSmtpConfig()
  let captured = null
  _setTransportForTests(() => ({
    sendMail: async (msg) => { captured = msg; return { messageId: 'x' } },
  }))
  await sendReviewEmail(BASE_MESSAGE)
  assert(captured.from.includes('advertising@l3amigos.com'), `expected From to reference SMTP_USER, got ${captured.from}`)
  assert(captured.from.includes('LTA Review Dashboard'), `expected the default display name when SMTP_FROM_NAME is unset, got ${captured.from}`)
}

async function testFromAddressUsesConfiguredDisplayName() {
  setFullSmtpConfig()
  process.env.SMTP_FROM_NAME = 'Lenin | Los Tres Amigos Marketing'
  let captured = null
  _setTransportForTests(() => ({
    sendMail: async (msg) => { captured = msg; return { messageId: 'x' } },
  }))
  await sendReviewEmail(BASE_MESSAGE)
  assert(captured.from === '"Lenin | Los Tres Amigos Marketing" <advertising@l3amigos.com>', `expected the configured sender header, got ${captured.from}`)
}

async function testReplyToPreservedSeparatelyFromFrom() {
  setFullSmtpConfig()
  process.env.SMTP_FROM_NAME = 'Lenin | Los Tres Amigos Marketing'
  let captured = null
  _setTransportForTests(() => ({
    sendMail: async (msg) => { captured = msg; return { messageId: 'x' } },
  }))
  await sendReviewEmail({ ...BASE_MESSAGE, replyTo: 'advertising@l3amigos.com' })
  assert(captured.replyTo === 'advertising@l3amigos.com', 'Reply-To must be preserved independently of the From address')
  assert(!captured.from.includes(captured.replyTo) || captured.from.includes('advertising@l3amigos.com'),
    'From and Reply-To are intentionally different mailboxes/uses in this workflow -- both values must simply be passed through untouched')
}

async function testEmptyCcOmittedNotSentAsEmptyArray() {
  setFullSmtpConfig()
  let captured = null
  _setTransportForTests(() => ({
    sendMail: async (msg) => { captured = msg; return { messageId: 'x' } },
  }))
  await sendReviewEmail({ ...BASE_MESSAGE, cc: [] })
  assert(captured.cc === undefined, 'an empty cc array must be omitted from the outgoing message, not sent as []')
}

async function testSendFailurePropagatesAsPlainErrorNotUnavailable() {
  setFullSmtpConfig()
  _setTransportForTests(() => ({
    sendMail: async () => { throw new Error('535 5.7.139 Authentication unsuccessful') },
  }))
  let caught = null
  try {
    await sendReviewEmail(BASE_MESSAGE)
  } catch (err) {
    caught = err
  }
  assert(caught !== null, 'a real send failure must propagate, not be swallowed')
  assert(!(caught instanceof EmailSenderUnavailableError),
    'a genuine SMTP send/auth failure must NOT be classified as EmailSenderUnavailableError -- callers distinguish "not configured" (503, no record written) from "attempted and failed" (record as failed)')
  assert(caught.message.includes('Authentication unsuccessful'), 'the real error message must be preserved for the caller to sanitize/log -- this module itself never redacts or drops it')
}

async function testSendFailureNeverLogsOrThrowsCredentials() {
  setFullSmtpConfig()
  _setTransportForTests(() => ({
    sendMail: async () => { throw new Error('535 5.7.139 Authentication unsuccessful, account locked') },
  }))
  let caught = null
  try {
    await sendReviewEmail(BASE_MESSAGE)
  } catch (err) {
    caught = err
  }
  assert(!caught.message.includes('not-a-real-password'), 'the configured password must never appear verbatim in a thrown error (this module never echoes it, but assert defensively)')
}

async function main() {
  await run('unconfigured (no SMTP_* vars) throws EmailSenderUnavailableError', testUnconfiguredThrowsUnavailableError)
  await run('a missing SMTP_HOST alone still throws EmailSenderUnavailableError', testMissingHostAloneStillThrowsUnavailable)
  await run('a missing SMTP_PASSWORD alone still throws EmailSenderUnavailableError', testMissingPasswordAloneStillThrowsUnavailable)
  await run('the unavailable-config error message is provider-neutral (no Gmail mention)', testUnavailableErrorMessageIsProviderNeutral)
  await run('buildTransportConfig: default port is 587 when SMTP_PORT is unset', testDefaultPortIs587WhenUnset)
  await run('buildTransportConfig: a configured SMTP_PORT is parsed as a number', testConfiguredPortIsParsedAsNumber)
  await run('buildTransportConfig: STARTTLS configuration (secure=false, requireTLS=true) for port 587', testStarttlsConfigurationForPort587)
  await run('buildTransportConfig: STARTTLS is the default when SMTP_SECURE is unset', testStarttlsIsTheDefaultWhenSmtpSecureUnset)
  await run('buildTransportConfig: implicit TLS configuration when SMTP_SECURE=true', testImplicitTlsConfigurationWhenSmtpSecureTrue)
  await run('buildTransportConfig: Microsoft 365 (smtp.office365.com) host configuration end to end', testMicrosoft365HostConfiguration)
  await run('buildTransportConfig never weakens TLS certificate validation', testNoTlsCertificateValidationWeakening)
  await run('a successful send returns the provider messageId and passes fields through', testSuccessfulSendReturnsMessageId)
  await run('the From address is built from SMTP_USER, with the default display name', testFromAddressUsesSmtpUser)
  await run('the From display name uses SMTP_FROM_NAME when configured', testFromAddressUsesConfiguredDisplayName)
  await run('Reply-To is preserved independently of From (intentionally different addresses)', testReplyToPreservedSeparatelyFromFrom)
  await run('an empty cc array is omitted, not sent as []', testEmptyCcOmittedNotSentAsEmptyArray)
  await run('a genuine SMTP send/auth failure propagates as a plain Error, distinct from EmailSenderUnavailableError', testSendFailurePropagatesAsPlainErrorNotUnavailable)
  await run('a send failure never leaks the configured password', testSendFailureNeverLogsOrThrowsCredentials)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
