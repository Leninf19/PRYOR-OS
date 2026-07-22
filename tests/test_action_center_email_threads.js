// Regression tests for the "Restaurant Email Threads" section added to
// ActionCenter.jsx (recovery-audit milestone, Phase 8). No React
// component-render test framework exists in this repo -- these are plain
// text/regex source-content assertions, the same style
// test_action_center_collaboration.js uses.
//
// Run directly: node tests/test_action_center_email_threads.js

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

function testImportsSharedEmailUtilsAndHook() {
  const content = read('pages/ActionCenter.jsx')
  assert(/EMAIL_STATUS_META, EMAIL_STATUS_TRANSITIONABLE_FROM, isEmailFollowUpOverdue/.test(content),
    'must reuse the SAME shared constants ReviewExplorer.jsx uses, not redefine them')
  assert(/from '\.\.\/hooks\/useReviewEmailWorkflow\.js'/.test(content), 'must use useUpdateEmailStatus()')
  assert(/reviewId/.test(content) && /from '\.\.\/utils\/dataUtils\.js'/.test(content), 'must reuse the shared reviewId() to cross-reference reviews')
}

function testEmailThreadsComputedFromWorkspaceNotFromActionCenterList() {
  const content = read('pages/ActionCenter.jsx')
  assert(/Object\.entries\(ws\)\s*\n\s*\.filter\(\(\[, entry\]\) => entry\?\.emailStatus\)/.test(content),
    'email threads must be derived from the ws workspace (entries with an emailStatus), not from the AI action-center list')
  assert(/allReviews\.find\(r => reviewId\(r\) === id\)/.test(content), 'each thread must cross-reference allReviews via the shared reviewId()')
}

function testCardShowsRequiredMetadata() {
  const content = read('pages/ActionCenter.jsx')
  const cardMatch = content.match(/function RestaurantEmailThreadCard[\s\S]*?\n}\n/)
  assert(cardMatch, 'could not locate RestaurantEmailThreadCard')
  const card = cardMatch[0]
  for (const label of ['Sent', 'Sent By', 'Recipient', 'Follow-Up Due']) {
    assert(card.includes(label), `card must display "${label}"`)
  }
  assert(/entry\.emailCcRecipients/.test(card), 'card must display CC recipients')
  assert(/statusMeta/.test(card), 'card must display the current email status')
}

function testManualStatusControlsRestrictedToTransitionableStates() {
  const content = read('pages/ActionCenter.jsx')
  const cardMatch = content.match(/function RestaurantEmailThreadCard[\s\S]*?\n}\n/)
  const card = cardMatch[0]
  assert(/EMAIL_STATUS_TRANSITIONABLE_FROM\.has\(entry\.emailStatus\)/.test(card), 'manual controls must only render when the prior state is transitionable')
  assert(/<option value="replied">Replied<\/option>/.test(card), 'must offer Replied')
  assert(/<option value="follow_up_required">Follow-Up Required<\/option>/.test(card), 'must offer Follow-Up Required')
  assert(/<option value="resolved">Resolved<\/option>/.test(card), 'must offer Resolved')
  assert(!/<option value="not_sent"/.test(card), 'must never offer not_sent as a manually-selectable option')
  assert(!/<option value="failed"/.test(card), 'must never offer failed as a manually-selectable option')
}

function testNotesFieldIsEditableForPastingReply() {
  const content = read('pages/ActionCenter.jsx')
  const cardMatch = content.match(/function RestaurantEmailThreadCard[\s\S]*?\n}\n/)
  const card = cardMatch[0]
  assert(/<textarea value=\{entry\.notes/.test(card), 'notes must be an editable textarea, not read-only display text')
  assert(/paste the restaurant's reply here/i.test(card), 'must label the field for pasting the restaurant\'s reply')
  assert(/onUpdate\(entryId, \{ notes: e\.target\.value \}\)/.test(card), 'must save via the existing generic update path (setRecord), not a new endpoint')
}

function testNoSeparateThreadedEmailUI() {
  const content = read('pages/ActionCenter.jsx')
  assert(!/ThreadedEmail|EmailThreadView|InboxView/.test(content), 'must not introduce a separate threaded-email UI component')
  const pageCount = (content.match(/export default function/g) || []).length
  assert(pageCount === 1, 'ActionCenter.jsx must still export exactly one page component')
}

function testHistoryAndOpenReviewLinkPresent() {
  const content = read('pages/ActionCenter.jsx')
  const cardMatch = content.match(/function RestaurantEmailThreadCard[\s\S]*?\n}\n/)
  const card = cardMatch[0]
  assert(/History \(\{entry\.history\.length\}\)/.test(card), 'must show the history log, same pattern as ActionCard')
  assert(/\/explorer\?reviewId=\$\{encodeURIComponent\(entryId\)\}/.test(card), 'must link back to the review in Review Explorer')
}

function testExistingActionCenterBehaviorPreserved() {
  const content = read('pages/ActionCenter.jsx')
  for (const marker of [
    'AI Action Center',
    "const [mineOnly, setMineOnly] = useState(false)",
    "const [overdueOnly, setOverdueOnly] = useState(false)",
    'Workload',
  ]) {
    assert(content.includes(marker), `existing Action Center behavior must be preserved: ${marker}`)
  }
}

const tests = [
  ['imports shared email utils and the update-status hook', testImportsSharedEmailUtilsAndHook],
  ['email threads are computed from the workspace, cross-referenced against allReviews', testEmailThreadsComputedFromWorkspaceNotFromActionCenterList],
  ['card shows sent/sent-by/recipient/follow-up/CC/status metadata', testCardShowsRequiredMetadata],
  ['manual status controls are restricted to transitionable prior states', testManualStatusControlsRestrictedToTransitionableStates],
  ['notes field is editable for pasting the restaurant\'s reply', testNotesFieldIsEditableForPastingReply],
  ['no separate threaded-email UI / no second page component', testNoSeparateThreadedEmailUI],
  ['history log and open-review link are present', testHistoryAndOpenReviewLinkPresent],
  ['all pre-existing Action Center behavior is preserved', testExistingActionCenterBehaviorPreserved],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
