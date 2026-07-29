// Regression tests for the "Restaurant Email Threads" section, originally
// added to ActionCenter.jsx (recovery-audit milestone, Phase 8) and carried
// forward verbatim into Actions.jsx (M6), which is now the live route --
// ActionCenter.jsx remains on disk only as an unrouted rollback artifact.
// No React component-render test framework exists in this repo -- these are
// plain text/regex source-content assertions, the same style
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
  // Normalize CRLF so the \n-anchored regexes below match regardless of the
  // checkout's line-ending style (e.g. Windows checkouts with core.autocrlf=true).
  return readFileSync(path.join(SRC_DIR, relPath), 'utf-8').replace(/\r\n/g, '\n')
}

function testImportsSharedEmailUtilsAndHook() {
  const content = read('pages/Actions.jsx')
  assert(/EMAIL_STATUS_META, EMAIL_STATUS_TRANSITIONABLE_FROM, isEmailFollowUpOverdue/.test(content),
    'must reuse the SAME shared constants ReviewExplorer.jsx uses, not redefine them')
  assert(/from '\.\.\/hooks\/useReviewEmailWorkflow\.js'/.test(content), 'must use useUpdateEmailStatus()')
  assert(/reviewId/.test(content) && /from '\.\.\/utils\/dataUtils\.js'/.test(content), 'must reuse the shared reviewId() to cross-reference reviews')
}

function testEmailThreadsComputedFromWorkspaceNotFromActionCenterList() {
  const content = read('pages/Actions.jsx')
  assert(/Object\.entries\(ws\)\s*\n\s*\.filter\(\(\[, entry\]\) => entry\?\.emailStatus\)/.test(content),
    'email threads must be derived from the ws workspace (entries with an emailStatus), not from the AI action-center list')
  assert(/allReviews\.find\(r => reviewId\(r\) === id\)/.test(content), 'each thread must cross-reference allReviews via the shared reviewId()')
}

function testCardShowsRequiredMetadata() {
  const content = read('pages/Actions.jsx')
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
  const content = read('pages/Actions.jsx')
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
  const content = read('pages/Actions.jsx')
  const cardMatch = content.match(/function RestaurantEmailThreadCard[\s\S]*?\n}\n/)
  const card = cardMatch[0]
  assert(/<textarea value=\{entry\.notes/.test(card), 'notes must be an editable textarea, not read-only display text')
  assert(/paste the restaurant's reply here/i.test(card), 'must label the field for pasting the restaurant\'s reply')
  assert(/onUpdate\(entryId, \{ notes: e\.target\.value \}\)/.test(card), 'must save via the existing generic update path (setRecord), not a new endpoint')
}

function testNoSeparateThreadedEmailUI() {
  const content = read('pages/Actions.jsx')
  assert(!/ThreadedEmail|EmailThreadView|InboxView/.test(content), 'must not introduce a separate threaded-email UI component')
  const pageCount = (content.match(/export default function/g) || []).length
  assert(pageCount === 1, 'Actions.jsx must still export exactly one page component')
}

function testHistoryAndOpenReviewLinkPresent() {
  const content = read('pages/Actions.jsx')
  const cardMatch = content.match(/function RestaurantEmailThreadCard[\s\S]*?\n}\n/)
  const card = cardMatch[0]
  assert(/History \(\{entry\.history\.length\}\)/.test(card), 'must show the history log, same pattern as ActionCard')
  // M6 fixed this link from the stale /explorer?reviewId= (Review Explorer,
  // retired before M3) to the canonical /reviews?reviewId= route.
  assert(/<Link to=\{`\/reviews\?reviewId=\$\{encodeURIComponent\(entryId\)\}`\}/.test(card),
    'must link back to the review via the canonical /reviews route, not the stale /explorer path')
}

function testExistingActionCenterBehaviorPreserved() {
  // M6 intentionally changed the page's own title/structure (8 collapsible
  // sections replace the flat "AI Action Center" list) -- that's the
  // approved milestone, not a regression. What must still hold is the
  // underlying workflow behavior this test file cares about: Mine/Overdue
  // filters and the workload summary are still present and still real.
  const content = read('pages/Actions.jsx')
  for (const marker of [
    "const [mineOnly, setMineOnly] = useState(false)",
    "const [overdueOnly, setOverdueOnly] = useState(false)",
    'Workload',
  ]) {
    assert(content.includes(marker), `existing Action Center behavior must be preserved: ${marker}`)
  }
}

function testRollbackArtifactStillHasEmailThreadsFeature() {
  // ActionCenter.jsx is kept on disk, unrouted, for rollback -- confirm it
  // hasn't been gutted, so re-adding its route would still work.
  const content = read('pages/ActionCenter.jsx')
  assert(/function RestaurantEmailThreadCard/.test(content), 'rollback artifact must still define RestaurantEmailThreadCard')
  assert(/Object\.entries\(ws\)\s*\n\s*\.filter\(\(\[, entry\]\) => entry\?\.emailStatus\)/.test(content),
    'rollback artifact must still compute email threads from the workspace')
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
  ['rollback artifact (ActionCenter.jsx) still has the email threads feature intact', testRollbackArtifactStillHasEmailThreadsFeature],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
