// Regression tests for the "Send to Restaurant" UI added to
// ReviewExplorer.jsx (recovery-audit milestone, Phase 7). No React
// component-render test framework exists in this repo -- these are plain
// text/regex source-content assertions, the same style
// test_action_center_collaboration.js uses.
//
// Run directly: node tests/test_review_explorer_send_to_restaurant.js

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
  return readFileSync(path.join(SRC_DIR, relPath), 'utf-8')
}

function testImportsRequiredHooks() {
  const content = read('pages/ReviewExplorer.jsx')
  assert(/from '\.\.\/hooks\/useIntelligence\.js'/.test(content) && /useMeta/.test(content), 'must reuse useMeta() for the hasContact signal')
  assert(/from '\.\.\/hooks\/useActionWorkspace\.js'/.test(content), 'must reuse the SAME Action Center workspace hook, not a separate store')
  assert(/from '\.\.\/hooks\/useReviewEmailWorkflow\.js'/.test(content), 'must use the dedicated review-email hooks')
  assert(/from '\.\.\/components\/AuthGate\.jsx'/.test(content), 'must use useAccount() for the current user, not a prop')
}

function testGatedByNegativeRatingAndRole() {
  const content = read('pages/ReviewExplorer.jsx')
  assert(/const isNegative = \(r\.star_rating \?\? 5\) <= 2/.test(content),
    'must gate on the same <=2 "negative" threshold used elsewhere in this codebase (export_action_items.py)')
  assert(/const canSend = account\?\.role === 'owner' \|\| account\?\.role === 'marketing'/.test(content),
    'must restrict the button to owner/marketing, matching the backend ALLOWED_ROLES')
  assert(/if \(!isNegative \|\| !canSend\) return null/.test(content), 'the whole section must render nothing outside those conditions')
}

function testMissingContactDisablesSendAndShowsMessage() {
  const content = read('pages/ReviewExplorer.jsx')
  assert(/Restaurant email not configured/.test(content), 'must show the exact required message when unconfigured')
  assert(/!hasContact \?/.test(content), 'must branch on hasContact before ever showing a Send button')
}

function testRecipientAndCcAreReadOnlyDisplay() {
  const content = read('pages/ReviewExplorer.jsx')
  // The confirmation panel must render recipient/cc as plain text, never as
  // an editable <input>/<textarea> a user could redirect the email to.
  const sectionMatch = content.match(/function SendToRestaurantSection[\s\S]*?\n}\n/)
  assert(sectionMatch, 'could not locate SendToRestaurantSection')
  const section = sectionMatch[0]
  assert(/To: <\/span>/.test(section) || /To: /.test(section), 'recipient must be displayed')
  assert(!/<input[^>]*value=\{preview\?\.recipient/.test(section), 'recipient must never be rendered as an editable input')
  assert(!/<input[^>]*value=\{preview\?\.cc/.test(section), 'cc must never be rendered as an editable input')
}

function testEditableFieldsPresent() {
  const content = read('pages/ReviewExplorer.jsx')
  assert(/Subject<\/label>/.test(content), 'subject must be editable')
  assert(/Internal Note \(optional\)<\/label>/.test(content), 'an optional internal note field must be present')
  assert(/Follow-Up Due Date \(optional\)<\/label>/.test(content), 'an optional follow-up due date field must be present')
}

function testDuplicateSendWarningAndConfirmFlow() {
  const content = read('pages/ReviewExplorer.jsx')
  assert(/DUPLICATE_EMAIL_STATUSES/.test(content), 'must check the duplicate email-status set')
  assert(/needsConfirmClick/.test(content), 'must require an explicit second click to confirm a resend')
  assert(/confirmResend: confirmArmed \|\| isDuplicate/.test(content), 'the actual send call must pass confirmResend once armed or already known to be a duplicate')
  assert(/already has an email sent to the restaurant/.test(content), 'a duplicate-send warning message must be shown')
}

function testStatesRendered() {
  const content = read('pages/ReviewExplorer.jsx')
  assert(/Loading recipient/.test(content), 'a loading state must be shown while the preview is in flight')
  assert(/Sending…/.test(content), 'a sending/loading state must be shown on the Send button itself')
  assert(/showToast\('Review email sent to the restaurant'\)/.test(content), 'a success toast must be shown after a successful send')
  assert(/sendMutation\.isError/.test(content), 'a truthful error state must be rendered on failure')
  assert(/EMAIL_STATUS_META/.test(content) && /<Badge variant=\{statusMeta\.variant\}>\{statusMeta\.label\}<\/Badge>/.test(content),
    'a sent/status badge must always be visible')
}

function testEmailStatusMetaCoversFullEnum() {
  const content = read('pages/ReviewExplorer.jsx')
  for (const status of ['not_sent', 'sent', 'replied', 'follow_up_required', 'resolved', 'failed']) {
    assert(content.includes(`${status}:`), `EMAIL_STATUS_META must cover "${status}"`)
  }
}

function testReusesExistingDesignSystemComponentsOnly() {
  const content = read('pages/ReviewExplorer.jsx')
  const sectionMatch = content.match(/function SendToRestaurantSection[\s\S]*?\n}\n/)
  const section = sectionMatch[0]
  assert(/<Button /.test(section) && /<Badge /.test(section), 'must reuse the existing Button/Badge components')
  assert(!/import.*Modal/.test(content), 'must not introduce a new Modal component')
}

const tests = [
  ['imports the required hooks (useMeta, useActionWorkspace, useReviewEmailWorkflow, useAccount)', testImportsRequiredHooks],
  ['gated by negative rating (<=2) and owner/marketing role', testGatedByNegativeRatingAndRole],
  ['a location with no configured contact disables Send and shows the exact message', testMissingContactDisablesSendAndShowsMessage],
  ['recipient/CC are read-only display, never editable inputs', testRecipientAndCcAreReadOnlyDisplay],
  ['subject/internal note/follow-up date are editable', testEditableFieldsPresent],
  ['duplicate-send warning requires an explicit confirm click before resending', testDuplicateSendWarningAndConfirmFlow],
  ['loading/sending/success/error states are all rendered', testStatesRendered],
  ['EMAIL_STATUS_META covers the full emailStatus enum', testEmailStatusMetaCoversFullEnum],
  ['reuses existing Card/Button/Badge components, no new design system', testReusesExistingDesignSystemComponentsOnly],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
