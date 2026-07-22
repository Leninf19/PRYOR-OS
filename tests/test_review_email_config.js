// Regression tests for dashboard/api/_lib/reviewEmailConfig.js -- the CC/
// Reply-To configuration for the restaurant bad-review email workflow.
//
// Run directly: node tests/test_review_email_config.js

import { getEscalationCcEmails, getReplyToEmail } from '../dashboard/api/_lib/reviewEmailConfig.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
function run(name, fn) {
  try {
    fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  } finally {
    delete process.env.REVIEW_ESCALATION_CC_EMAILS
    delete process.env.REVIEW_REPLY_TO_EMAIL
  }
}

function testCcEmailsParsedFromCommaSeparatedList() {
  process.env.REVIEW_ESCALATION_CC_EMAILS = 'martin@example.com, ruffy@example.com'
  const cc = getEscalationCcEmails()
  assert(cc.length === 2, `expected 2 CC emails, got ${cc.length}`)
  assert(cc.includes('martin@example.com') && cc.includes('ruffy@example.com'), 'both configured emails must be present')
}

function testCcEmailsEmptyWhenUnset() {
  const cc = getEscalationCcEmails()
  assert(Array.isArray(cc) && cc.length === 0, 'unset REVIEW_ESCALATION_CC_EMAILS must yield an empty array, never throw')
}

function testCcEmailsDropsMalformedEntriesButKeepsValidOnes() {
  process.env.REVIEW_ESCALATION_CC_EMAILS = 'martin@example.com, not-an-email, ruffy@example.com'
  const cc = getEscalationCcEmails()
  assert(cc.length === 2, `a malformed entry must be dropped, not crash the whole list -- got ${JSON.stringify(cc)}`)
  assert(!cc.includes('not-an-email'), 'the malformed entry itself must never appear')
}

function testCcEmailsHandlesWhitespaceAndEmptyEntries() {
  process.env.REVIEW_ESCALATION_CC_EMAILS = ' martin@example.com ,, ruffy@example.com ,'
  const cc = getEscalationCcEmails()
  assert(cc.length === 2, `expected exactly 2 emails after trimming/dropping empties, got ${JSON.stringify(cc)}`)
}

function testReplyToDefaultsToMarketingInboxWhenUnset() {
  const replyTo = getReplyToEmail()
  assert(replyTo === 'advertising@l3amigos.com', `expected the default marketing inbox, got ${replyTo}`)
}

function testReplyToUsesConfiguredValueWhenValid() {
  process.env.REVIEW_REPLY_TO_EMAIL = 'custom-inbox@example.com'
  assert(getReplyToEmail() === 'custom-inbox@example.com', 'a valid configured Reply-To must be used verbatim')
}

function testReplyToFallsBackToDefaultWhenMalformed() {
  process.env.REVIEW_REPLY_TO_EMAIL = 'not-an-email'
  assert(getReplyToEmail() === 'advertising@l3amigos.com', 'a malformed REVIEW_REPLY_TO_EMAIL must fall back to the default, never propagate a broken address')
}

function testConfigIsNeverClientInfluenced() {
  // Sanity/documentation check: these functions take zero arguments -- there
  // is no code path by which a request body/query string could reach them.
  assert(getEscalationCcEmails.length === 0, 'getEscalationCcEmails must take no arguments (env-only)')
  assert(getReplyToEmail.length === 0, 'getReplyToEmail must take no arguments (env-only)')
}

function main() {
  run('CC emails parsed from a comma-separated list', testCcEmailsParsedFromCommaSeparatedList)
  run('CC emails empty (not throw) when unset', testCcEmailsEmptyWhenUnset)
  run('CC emails: a malformed entry is dropped, valid ones survive', testCcEmailsDropsMalformedEntriesButKeepsValidOnes)
  run('CC emails: whitespace/empty entries are handled', testCcEmailsHandlesWhitespaceAndEmptyEntries)
  run('Reply-To defaults to the marketing inbox when unset', testReplyToDefaultsToMarketingInboxWhenUnset)
  run('Reply-To uses the configured value when valid', testReplyToUsesConfiguredValueWhenValid)
  run('Reply-To falls back to default when configured value is malformed', testReplyToFallsBackToDefaultWhenMalformed)
  run('config functions take no arguments -- structurally never client-influenced', testConfigIsNeverClientInfluenced)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
