// Regression tests for the Microsoft Graph email provider (emailSender.js's
// MAIL_PROVIDER=graph path) -- dashboard/api/_lib/graphMailSender.js plus
// the provider switch in dashboard/api/_lib/emailSender.js. No real network
// call anywhere in this file: every test overrides globalThis.fetch, the
// same pattern tests/test_google_oauth_auto_recovery.js already uses for
// Google's OAuth2 token exchange.
//
// Run directly: node tests/test_graph_mail_sender.js

import {
  sendGraphMail,
  hasGraphConfig,
  GraphMailError,
  _setFetchForTests,
  _resetGraphMailForTests,
} from '../dashboard/api/_lib/graphMailSender.js'
import {
  sendReviewEmail,
  getMailProvider,
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
    _resetGraphMailForTests()
    _resetTransportForTests()
    delete process.env.MAIL_PROVIDER
    delete process.env.MICROSOFT_TENANT_ID
    delete process.env.MICROSOFT_CLIENT_ID
    delete process.env.MICROSOFT_CLIENT_SECRET
    delete process.env.MAIL_FROM_ADDRESS
    delete process.env.MAIL_FROM_NAME
    delete process.env.SMTP_HOST
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASSWORD
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

function setFullGraphConfig() {
  process.env.MICROSOFT_TENANT_ID = 'tenant-123'
  process.env.MICROSOFT_CLIENT_ID = 'client-123'
  process.env.MICROSOFT_CLIENT_SECRET = 'super-secret-value'
  process.env.MAIL_FROM_ADDRESS = 'advertising@l3amigos.com'
}

function tokenOkResponse() {
  return { ok: true, status: 200, json: async () => ({ access_token: 'fake-access-token', expires_in: 3600 }) }
}

// A single fetch mock that answers both the token exchange and the
// sendMail call, recording what sendMail actually received.
function mockFetchCapturingSendMail(onCaptured) {
  return async (url, init) => {
    if (typeof url === 'string' && url.includes('login.microsoftonline.com')) {
      return tokenOkResponse()
    }
    if (typeof url === 'string' && url.includes('graph.microsoft.com')) {
      onCaptured(url, init)
      return { ok: true, status: 202, json: async () => { throw new Error('no body on 202') } }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
}

// --- Provider selection -------------------------------------------------

async function testProviderDefaultsToSmtpWhenUnset() {
  assert(getMailProvider() === 'smtp', 'MAIL_PROVIDER unset must default to smtp')
}

async function testProviderIsSmtpForUnrecognizedValue() {
  process.env.MAIL_PROVIDER = 'something-else'
  assert(getMailProvider() === 'smtp', 'an unrecognized MAIL_PROVIDER value must fail safe to smtp, not crash or silently pick graph')
}

async function testProviderIsGraphWhenExplicitlySet() {
  process.env.MAIL_PROVIDER = 'graph'
  assert(getMailProvider() === 'graph')
}

async function testSmtpBehaviorUnchangedWhenProviderExplicitlySmtp() {
  process.env.MAIL_PROVIDER = 'smtp'
  process.env.SMTP_HOST = 'smtp.office365.com'
  process.env.SMTP_USER = 'advertising@l3amigos.com'
  process.env.SMTP_PASSWORD = 'not-a-real-password'
  let captured = null
  _setTransportForTests(() => ({
    sendMail: async (msg) => { captured = msg; return { messageId: 'smtp-msg-1' } },
  }))
  const result = await sendReviewEmail(BASE_MESSAGE)
  assert(result.messageId === 'smtp-msg-1', 'MAIL_PROVIDER=smtp must still route through the SMTP transporter')
  assert(captured.to === BASE_MESSAGE.to)
}

async function testSmtpRemainsDefaultWhenProviderUnset() {
  // MAIL_PROVIDER intentionally left unset -- only SMTP is configured.
  process.env.SMTP_HOST = 'smtp.office365.com'
  process.env.SMTP_USER = 'advertising@l3amigos.com'
  process.env.SMTP_PASSWORD = 'not-a-real-password'
  let captured = null
  _setTransportForTests(() => ({
    sendMail: async (msg) => { captured = msg; return { messageId: 'smtp-msg-default' } },
  }))
  const result = await sendReviewEmail(BASE_MESSAGE)
  assert(result.messageId === 'smtp-msg-default', 'an unset MAIL_PROVIDER must not accidentally route through Graph')
  assert(captured !== null)
}

async function testGraphNotConfiguredThrowsUnavailableViaSendReviewEmail() {
  process.env.MAIL_PROVIDER = 'graph'
  // Deliberately no MICROSOFT_*/MAIL_FROM_ADDRESS vars set.
  let threw = false
  try {
    await sendReviewEmail(BASE_MESSAGE)
  } catch (err) {
    threw = err instanceof EmailSenderUnavailableError
  }
  assert(threw, 'sendReviewEmail() with MAIL_PROVIDER=graph but missing config must throw EmailSenderUnavailableError, same contract as the SMTP path')
}

// --- hasGraphConfig() -----------------------------------------------------

async function testHasGraphConfigFalseWhenIncomplete() {
  process.env.MICROSOFT_TENANT_ID = 'tenant-123'
  process.env.MICROSOFT_CLIENT_ID = 'client-123'
  // MICROSOFT_CLIENT_SECRET and MAIL_FROM_ADDRESS intentionally left unset.
  assert(hasGraphConfig() === false, 'hasGraphConfig must be false when any required var is missing')
}

async function testHasGraphConfigTrueWhenComplete() {
  setFullGraphConfig()
  assert(hasGraphConfig() === true)
}

// --- Token acquisition (mocked) -------------------------------------------

async function testTokenRequestUsesClientCredentialsGrantAndDefaultScope() {
  setFullGraphConfig()
  let tokenRequestBody = null
  let tokenUrl = null
  _setFetchForTests(async (url, init) => {
    if (url.includes('login.microsoftonline.com')) {
      tokenUrl = url
      tokenRequestBody = init.body
      return tokenOkResponse()
    }
    return { ok: true, status: 202, json: async () => { throw new Error('no body') } }
  })
  await sendGraphMail(BASE_MESSAGE)
  assert(tokenUrl.includes('/tenant-123/oauth2/v2.0/token'), `token URL must include the configured tenant, got ${tokenUrl}`)
  const params = new URLSearchParams(tokenRequestBody)
  assert(params.get('grant_type') === 'client_credentials', 'must use the client_credentials grant')
  assert(params.get('scope') === 'https://graph.microsoft.com/.default', 'must request the .default scope, not an explicit mail-send scope')
  assert(params.get('client_id') === 'client-123')
  assert(params.get('client_secret') === 'super-secret-value')
}

async function testTokenFailurePropagatesAsGraphMailError() {
  setFullGraphConfig()
  _setFetchForTests(async (url) => {
    if (url.includes('login.microsoftonline.com')) {
      return { ok: false, status: 401, json: async () => ({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }) }
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  let caught = null
  try {
    await sendGraphMail(BASE_MESSAGE)
  } catch (err) {
    caught = err
  }
  assert(caught instanceof GraphMailError, 'a token failure must surface as GraphMailError')
  assert(caught.status === 401)
  assert(caught.code === 'invalid_client')
  assert(/Invalid client secret provided/.test(caught.message), 'the sanitized Graph description should still be informative')
}

// --- sendMail success + field mapping --------------------------------------

async function testSendMailSuccessReturnsAcceptedResult() {
  setFullGraphConfig()
  _setFetchForTests(mockFetchCapturingSendMail(() => {}))
  const result = await sendGraphMail(BASE_MESSAGE)
  assert(result.messageId === null, 'Graph sendMail has no messageId to return (202 with no body)')
  assert(result.response === 'Accepted')
}

async function testCorrectSenderEndpointUsesMailFromAddress() {
  setFullGraphConfig()
  process.env.MAIL_FROM_ADDRESS = 'advertising@l3amigos.com'
  let capturedUrl = null
  _setFetchForTests(mockFetchCapturingSendMail((url) => { capturedUrl = url }))
  await sendGraphMail(BASE_MESSAGE)
  assert(capturedUrl === 'https://graph.microsoft.com/v1.0/users/advertising%40l3amigos.com/sendMail',
    `expected the sendMail endpoint to target MAIL_FROM_ADDRESS, got ${capturedUrl}`)
}

async function testToRecipientMapping() {
  setFullGraphConfig()
  let capturedBody = null
  _setFetchForTests(mockFetchCapturingSendMail((_url, init) => { capturedBody = JSON.parse(init.body) }))
  await sendGraphMail({ ...BASE_MESSAGE, to: 'restaurant@example.com' })
  assert(JSON.stringify(capturedBody.message.toRecipients) === JSON.stringify([{ emailAddress: { address: 'restaurant@example.com' } }]),
    `unexpected toRecipients: ${JSON.stringify(capturedBody.message.toRecipients)}`)
}

async function testCcRecipientMapping() {
  setFullGraphConfig()
  let capturedBody = null
  _setFetchForTests(mockFetchCapturingSendMail((_url, init) => { capturedBody = JSON.parse(init.body) }))
  await sendGraphMail(BASE_MESSAGE)
  assert(JSON.stringify(capturedBody.message.ccRecipients) === JSON.stringify([
    { emailAddress: { address: 'martin@example.com' } },
    { emailAddress: { address: 'ruffy@example.com' } },
  ]), `unexpected ccRecipients: ${JSON.stringify(capturedBody.message.ccRecipients)}`)
}

async function testMissingOptionalCcOmitted() {
  setFullGraphConfig()
  let capturedBody = null
  _setFetchForTests(mockFetchCapturingSendMail((_url, init) => { capturedBody = JSON.parse(init.body) }))
  await sendGraphMail({ ...BASE_MESSAGE, cc: [] })
  assert(!('ccRecipients' in capturedBody.message), 'an empty/absent cc must omit ccRecipients entirely, not send []')
}

async function testReplyToMapping() {
  setFullGraphConfig()
  let capturedBody = null
  _setFetchForTests(mockFetchCapturingSendMail((_url, init) => { capturedBody = JSON.parse(init.body) }))
  await sendGraphMail(BASE_MESSAGE)
  assert(JSON.stringify(capturedBody.message.replyTo) === JSON.stringify([{ emailAddress: { address: 'advertising@l3amigos.com' } }]),
    `unexpected replyTo: ${JSON.stringify(capturedBody.message.replyTo)}`)
}

async function testMissingOptionalReplyToOmitted() {
  setFullGraphConfig()
  let capturedBody = null
  _setFetchForTests(mockFetchCapturingSendMail((_url, init) => { capturedBody = JSON.parse(init.body) }))
  await sendGraphMail({ ...BASE_MESSAGE, replyTo: undefined })
  assert(!('replyTo' in capturedBody.message), 'an absent replyTo must omit the field entirely')
}

async function testSubjectAndHtmlBodyPassedThrough() {
  setFullGraphConfig()
  let capturedBody = null
  _setFetchForTests(mockFetchCapturingSendMail((_url, init) => { capturedBody = JSON.parse(init.body) }))
  await sendGraphMail(BASE_MESSAGE)
  assert(capturedBody.message.subject === BASE_MESSAGE.subject)
  assert(capturedBody.message.body.contentType === 'HTML')
  assert(capturedBody.message.body.content === BASE_MESSAGE.html)
  assert(capturedBody.saveToSentItems === true)
}

async function testFromDisplayNameUsesMailFromNameWhenSet() {
  setFullGraphConfig()
  process.env.MAIL_FROM_NAME = 'Future Insights'
  let capturedBody = null
  _setFetchForTests(mockFetchCapturingSendMail((_url, init) => { capturedBody = JSON.parse(init.body) }))
  await sendGraphMail(BASE_MESSAGE)
  assert(capturedBody.message.from.emailAddress.name === 'Future Insights')
  assert(capturedBody.message.from.emailAddress.address === 'advertising@l3amigos.com')
}

async function testAuthorizationHeaderCarriesBearerToken() {
  setFullGraphConfig()
  let capturedHeaders = null
  _setFetchForTests(mockFetchCapturingSendMail((_url, init) => { capturedHeaders = init.headers }))
  await sendGraphMail(BASE_MESSAGE)
  assert(capturedHeaders.Authorization === 'Bearer fake-access-token')
}

// --- sendMail failure + sanitized errors -----------------------------------

async function testSendMailFailurePropagatesAsGraphMailError() {
  setFullGraphConfig()
  _setFetchForTests(async (url) => {
    if (url.includes('login.microsoftonline.com')) return tokenOkResponse()
    if (url.includes('graph.microsoft.com')) {
      return {
        ok: false,
        status: 403,
        json: async () => ({ error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } }),
      }
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  let caught = null
  try {
    await sendGraphMail(BASE_MESSAGE)
  } catch (err) {
    caught = err
  }
  assert(caught instanceof GraphMailError, 'a sendMail failure must surface as GraphMailError')
  assert(caught.status === 403)
  assert(caught.code === 'ErrorAccessDenied')
  assert(/Access is denied/.test(caught.message))
}

async function testSendMailErrorNeverLeaksClientSecretOrToken() {
  setFullGraphConfig()
  _setFetchForTests(async (url) => {
    if (url.includes('login.microsoftonline.com')) return tokenOkResponse()
    if (url.includes('graph.microsoft.com')) {
      return {
        ok: false,
        status: 400,
        // Pathological but defensive: even if a Graph error message somehow
        // echoed the client secret, it must never reach the thrown error.
        json: async () => ({ error: { code: 'BadRequest', message: 'Invalid request from client super-secret-value.' } }),
      }
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  let caught = null
  try {
    await sendGraphMail(BASE_MESSAGE)
  } catch (err) {
    caught = err
  }
  assert(caught !== null)
  assert(!caught.message.includes('super-secret-value'), 'the configured client secret must never appear verbatim in a thrown error')
  assert(!caught.message.includes('fake-access-token'), 'an access token must never appear in a thrown error')
  assert(caught.message.includes('[redacted]'), 'the redaction marker should replace the secret, not just drop the whole message')
}

async function testEndToEndSendReviewEmailWithGraphProvider() {
  process.env.MAIL_PROVIDER = 'graph'
  setFullGraphConfig()
  let capturedBody = null
  _setFetchForTests(mockFetchCapturingSendMail((_url, init) => { capturedBody = JSON.parse(init.body) }))
  const result = await sendReviewEmail(BASE_MESSAGE)
  assert(result.response === 'Accepted')
  assert(capturedBody.message.toRecipients[0].emailAddress.address === BASE_MESSAGE.to)
}

async function main() {
  await run('MAIL_PROVIDER defaults to smtp when unset', testProviderDefaultsToSmtpWhenUnset)
  await run('an unrecognized MAIL_PROVIDER value fails safe to smtp', testProviderIsSmtpForUnrecognizedValue)
  await run('MAIL_PROVIDER=graph selects the graph provider', testProviderIsGraphWhenExplicitlySet)
  await run('SMTP behavior is unchanged when MAIL_PROVIDER=smtp explicitly', testSmtpBehaviorUnchangedWhenProviderExplicitlySmtp)
  await run('SMTP remains the default when MAIL_PROVIDER is unset', testSmtpRemainsDefaultWhenProviderUnset)
  await run('sendReviewEmail with MAIL_PROVIDER=graph but missing config throws EmailSenderUnavailableError', testGraphNotConfiguredThrowsUnavailableViaSendReviewEmail)
  await run('hasGraphConfig is false when any required var is missing', testHasGraphConfigFalseWhenIncomplete)
  await run('hasGraphConfig is true when all required vars are set', testHasGraphConfigTrueWhenComplete)
  await run('token request uses the client_credentials grant and the .default scope', testTokenRequestUsesClientCredentialsGrantAndDefaultScope)
  await run('a token acquisition failure propagates as GraphMailError', testTokenFailurePropagatesAsGraphMailError)
  await run('a successful sendMail returns an Accepted result with no messageId', testSendMailSuccessReturnsAcceptedResult)
  await run('the sendMail endpoint targets MAIL_FROM_ADDRESS', testCorrectSenderEndpointUsesMailFromAddress)
  await run('to recipients are mapped to Graph emailAddress objects', testToRecipientMapping)
  await run('cc recipients are mapped to Graph emailAddress objects', testCcRecipientMapping)
  await run('an empty/missing cc omits ccRecipients entirely', testMissingOptionalCcOmitted)
  await run('replyTo is mapped to a Graph emailAddress object', testReplyToMapping)
  await run('a missing replyTo omits the field entirely', testMissingOptionalReplyToOmitted)
  await run('subject and HTML body are passed through, saveToSentItems is true', testSubjectAndHtmlBodyPassedThrough)
  await run('MAIL_FROM_NAME sets the from display name when configured', testFromDisplayNameUsesMailFromNameWhenSet)
  await run('the sendMail request carries a Bearer token from the token exchange', testAuthorizationHeaderCarriesBearerToken)
  await run('a sendMail failure propagates as GraphMailError with status/code', testSendMailFailurePropagatesAsGraphMailError)
  await run('a sendMail error never leaks the client secret or access token', testSendMailErrorNeverLeaksClientSecretOrToken)
  await run('sendReviewEmail end-to-end with MAIL_PROVIDER=graph reaches Graph sendMail with mapped fields', testEndToEndSendReviewEmailWithGraphProvider)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
