// Regression tests for dashboard/src/pages/settings/EmailSystem.jsx and its
// supporting hook/service (Phase 8, Milestone 8.9). No React component-render
// test framework exists in this repo -- these are plain-text/regex
// source-content assertions, matching test_restaurant_contacts_ui.js's style.
//
// Run directly: node tests/test_email_system_ui.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.resolve(__dirname, '..', 'dashboard', 'src')

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

function read(relPath) {
  return readFileSync(path.join(SRC_DIR, relPath), 'utf-8').replace(/\r\n/g, '\n')
}

function testEmailSystemPageUsesSharedStatusHookAndStates() {
  const content = read('pages/settings/EmailSystem.jsx')
  assert(/from '\.\.\/\.\.\/hooks\/useEmailSystemStatus\.js'/.test(content), 'must read status from the shared hook, not a local fetch()')
  assert(/useEmailSystemStatus/.test(content), 'must call useEmailSystemStatus()')
  assert(/from '\.\.\/\.\.\/components\/ui\/Skeleton\.jsx'/.test(content), 'loading state must use the shared Skeleton component')
  assert(/from '\.\.\/\.\.\/components\/ui\/ErrorState\.jsx'/.test(content), 'error state must use the shared ErrorState component')
}

function testReportsTruthfulDirectDeliveryNotAFakeQueue() {
  const content = read('pages/settings/EmailSystem.jsx')
  assert(/queueMessage/.test(content), 'must render the server-reported queueMessage rather than inventing its own queue copy')
  assert(!/pending queue:\s*\d/i.test(content), 'must never render a fabricated numeric pending-queue count')
}

function testRegisteredInSettingsSectionsWithCorrectRoles() {
  const content = read('pages/settings/settingsSections.js')
  const sectionMatch = content.match(/\{\s*id:\s*'email',[\s\S]*?\n {2}\}/)
  assert(sectionMatch, 'an "email" entry must exist in the settings registry')
  const section = sectionMatch[0]
  assert(/requiredRoles:\s*\['owner', 'marketing'\]/.test(section),
    'Email System must be visible to owner/marketing only, matching EMAIL_VIEW\'s grant in the approved Phase 8 role matrix')
  assert(/EmailSystem\.jsx/.test(section), 'must lazily import EmailSystem.jsx')
}

function testServiceHitsTheCorrectEndpoints() {
  const content = read('services/emailSystemService.js')
  assert(/\/api\/settings\/email-status/.test(content), 'getStatus must call /api/settings/email-status')
  assert(/\/api\/settings\/contacts-send-test-email/.test(content), 'sendTestEmail must call /api/settings/contacts-send-test-email')
}

function testHookInvalidatesBothStatusAndContactsOnSend() {
  const content = read('hooks/useEmailSystemStatus.js')
  assert(/email-system-status/.test(content), 'must key the status query as email-system-status')
  assert(/restaurant-contacts/.test(content), 'sending a test email must also invalidate restaurant-contacts (the contact\'s own history changed server-side)')
}

const tests = [
  ['EmailSystem.jsx uses the shared status hook and shared loading/error states', testEmailSystemPageUsesSharedStatusHookAndStates],
  ['reports a truthful direct-delivery message, never a fabricated queue count', testReportsTruthfulDirectDeliveryNotAFakeQueue],
  ['registered in settingsSections.js with owner/marketing-only visibility', testRegisteredInSettingsSectionsWithCorrectRoles],
  ['emailSystemService.js calls the correct backend endpoints', testServiceHitsTheCorrectEndpoints],
  ['useSendTestEmail invalidates both the status and restaurant-contacts query keys', testHookInvalidatesBothStatusAndContactsOnSend],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
