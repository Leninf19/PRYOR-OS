// Guards against a Gmail-specific regression in the restaurant bad-review
// email workflow's SMTP migration (Microsoft 365/provider-neutral SMTP,
// not Gmail App Passwords). Scoped specifically to this workflow's own
// files -- NOT the whole repo -- because the pre-existing, unrelated
// internal alert scripts (notify.py, nightly_digest.py,
// critical_alert_check.py, weekly_report.py, health_check.py) legitimately
// still use a separate Gmail mailbox (GMAIL_USER/GMAIL_APP_PASSWORD) for a
// different purpose, and must not be flagged or touched by this guard.
//
// Run directly: node tests/test_no_gmail_in_review_email_workflow.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

// Every file that is part of the restaurant bad-review email workflow's
// SEND path (backend + frontend). Deliberately does not include
// tests/test_send_review_email.js's own header/inline "no real Gmail
// account" prose from BEFORE the migration -- those files are updated
// separately; this guard is about the workflow's shipped source, and the
// README section describing it.
const FILES_TO_CHECK = [
  'dashboard/api/_lib/emailSender.js',
  'dashboard/api/_lib/reviewEmailConfig.js',
  'dashboard/api/_lib/reviewEmailTemplate.js',
  'dashboard/api/_lib/locationContacts.js',
  'dashboard/api/actions/[action].js',
  'dashboard/src/services/reviewEmailService.js',
  'dashboard/src/hooks/useReviewEmailWorkflow.js',
  'dashboard/src/pages/ReviewExplorer.jsx',
  'dashboard/src/pages/ActionCenter.jsx',
]

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
  }
}

function testNoGmailReferenceInWorkflowSourceFiles() {
  const offenders = []
  for (const relPath of FILES_TO_CHECK) {
    const content = readFileSync(path.join(REPO_ROOT, relPath), 'utf-8')
    if (/gmail/i.test(content)) {
      const lines = content.split('\n')
      lines.forEach((line, i) => {
        if (/gmail/i.test(line)) offenders.push(`${relPath}:${i + 1}: ${line.trim()}`)
      })
    }
  }
  assert(offenders.length === 0, `found Gmail reference(s) in the restaurant email workflow's active source:\n${offenders.join('\n')}`)
}

function testNoGmailEnvVarNamesInWorkflowSourceFiles() {
  const offenders = []
  for (const relPath of FILES_TO_CHECK) {
    const content = readFileSync(path.join(REPO_ROOT, relPath), 'utf-8')
    if (/GMAIL_USER|GMAIL_APP_PASSWORD/.test(content)) offenders.push(relPath)
  }
  assert(offenders.length === 0, `GMAIL_USER/GMAIL_APP_PASSWORD must not appear in: ${offenders.join(', ')}`)
}

function testSmtpEnvVarNamesArePresentWhereExpected() {
  const emailSenderContent = readFileSync(path.join(REPO_ROOT, 'dashboard/api/_lib/emailSender.js'), 'utf-8')
  for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM_NAME']) {
    assert(emailSenderContent.includes(name), `emailSender.js must reference ${name}`)
  }
}

function testActionsEndpointRedactsSmtpNotGmailCredentials() {
  const content = readFileSync(path.join(REPO_ROOT, "dashboard/api/actions/[action].js"), 'utf-8')
  assert(content.includes('process.env.SMTP_PASSWORD'), 'sanitizeErrorMessage must redact SMTP_PASSWORD')
  assert(content.includes('process.env.SMTP_USER'), 'sanitizeErrorMessage must redact SMTP_USER')
  assert(!/GMAIL/.test(content), 'actions/[action].js must not reference any GMAIL_* variable')
}

function testReadmeDocumentsSmtpNotGmailForThisWorkflow() {
  const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8')
  const section = readme.split('## Restaurant Bad-Review Email Workflow')[1]?.split('\n## ')[0]
  assert(section, 'could not find the "Restaurant Bad-Review Email Workflow" README section')
  assert(!/GMAIL_USER|GMAIL_APP_PASSWORD/.test(section), 'the workflow\'s README section must not document GMAIL_USER/GMAIL_APP_PASSWORD -- it uses SMTP_* now')
  assert(section.includes('SMTP_HOST') && section.includes('SMTP_USER') && section.includes('SMTP_PASSWORD'),
    'the workflow\'s README section must document the SMTP_* variables')
}

const tests = [
  ['no "gmail" text reference anywhere in the workflow\'s active source files', testNoGmailReferenceInWorkflowSourceFiles],
  ['no GMAIL_USER/GMAIL_APP_PASSWORD variable name in the workflow\'s active source files', testNoGmailEnvVarNamesInWorkflowSourceFiles],
  ['emailSender.js references every expected SMTP_* variable', testSmtpEnvVarNamesArePresentWhereExpected],
  ['actions/[action].js redacts SMTP_PASSWORD/SMTP_USER, never GMAIL_*', testActionsEndpointRedactsSmtpNotGmailCredentials],
  ['README documents SMTP_* (not GMAIL_*) for this workflow', testReadmeDocumentsSmtpNotGmailForThisWorkflow],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
