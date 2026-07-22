// Regression tests for the collaborative-assignment additions to
// dashboard/src/pages/ActionCenter.jsx (Action Center Accountability
// milestone): Assigned To picker, Mine/Overdue filters, workload summary,
// history attribution -- and that no second workflow page was created. No
// React component-render test framework exists in this repo -- these are
// plain text/regex source-content assertions, the same style
// test_executive_intelligence_center_ui.js uses.
//
// Run directly: node tests/test_action_center_collaboration.js

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

function testImportsAccountsAndCurrentAccount() {
  const content = read('pages/ActionCenter.jsx')
  assert(/from '\.\.\/hooks\/useAccounts\.js'/.test(content), 'must import the reusable accounts list hook')
  assert(/from '\.\.\/components\/AuthGate\.jsx'/.test(content), 'must import useAccount (current user) from AuthGate.jsx')
}

function testAssignedToPickerPopulatedFromAccounts() {
  const content = read('pages/ActionCenter.jsx')
  assert(/Assigned To/.test(content), 'must label the new field "Assigned To"')
  assert(/value={entry\?\.assignedTo \?\? ''}/.test(content), 'the picker must be controlled by entry.assignedTo')
  assert(/\(accounts \?\? \[\]\)\.map\(acc => <option key={acc\.userId} value={acc\.userId}>{acc\.displayName}<\/option>\)/.test(content),
    'the picker must be populated from the accounts list (userId/displayName), not a free-text field')
  assert(/<option value="">Unassigned<\/option>/.test(content), 'must offer an explicit Unassigned option')
}

function testMineAndOverdueFilters() {
  const content = read('pages/ActionCenter.jsx')
  assert(/const \[mineOnly, setMineOnly\] = useState\(false\)/.test(content), 'must add mineOnly filter state')
  assert(/const \[overdueOnly, setOverdueOnly\] = useState\(false\)/.test(content), 'must add overdueOnly filter state')
  assert(/if \(mineOnly && ws\[a\.id\]\?\.assignedTo !== account\?\.userId\) return false/.test(content),
    'Mine filter must compare assignedTo against the CURRENT authenticated account, not a hardcoded id')
  assert(/if \(overdueOnly && !isOverdue\(ws\[a\.id\]\)\) return false/.test(content), 'Overdue filter must use the shared isOverdue() check')
  assert(/from '\.\.\/utils\/actionWorkspaceUtils\.js'/.test(content),
    'isOverdue()/OPEN_STATUSES must be imported from the shared actionWorkspaceUtils.js, not redefined locally -- so Action Center\'s Overdue filter and the Executive Intelligence Center\'s overdue signal can never drift apart')
}

function testWorkloadSummaryComputedAndRendered() {
  const content = read('pages/ActionCenter.jsx')
  assert(/const workload = useMemo\(\(\) => \{/.test(content), 'workload summary must be memoized')
  assert(/OPEN_STATUSES\.has\(entry\.status \?\? 'New'\)/.test(content), 'workload must only count open (not Completed/Dismissed) items')
  assert(/<Badge key={w\.userId} variant={w\.overdue > 0 \? 'danger' : 'neutral'}>/.test(content),
    'workload summary must render via the existing Badge component, not a new bespoke component')
  assert(/displayNameFor\(accounts, w\.userId\)/.test(content), 'workload summary must resolve display names from the accounts list')
}

function testHistoryShowsWhoMadeTheChange() {
  const content = read('pages/ActionCenter.jsx')
  assert(/\{h\.by && <span style={{ color: 'var\(--color-text-3\)' }}>· {h\.by}<\/span>\}/.test(content),
    'history entries must render the server-attributed "by" field')
}

function testExistingBehaviorPreserved() {
  const content = read('pages/ActionCenter.jsx')
  // Every pre-existing field/control must still exist, unchanged in intent.
  for (const marker of [
    "const STATUSES = ['New', 'Assigned', 'In Progress', 'Completed', 'Monitoring', 'Dismissed']",
    'Internal Notes',
    'OutcomeTracker',
    "onBlur={() => entry?.notes && onUpdate(a.id, {}, 'Note updated')}",
    'Show ${a.supportingReviews.length} supporting review',
  ]) {
    assert(content.includes(marker), `existing behavior must be preserved: ${marker}`)
  }
}

function testNoSecondWorkflowPageWasCreated() {
  const appContent = readFileSync(path.join(SRC_DIR, 'App.jsx'), 'utf-8')
  const actionCenterRoutes = [...appContent.matchAll(/element={<ActionCenter\s*\/>}/g)]
  assert(actionCenterRoutes.length === 1, `expected exactly one ActionCenter route, found ${actionCenterRoutes.length}`)
  assert(!/pages\/(TaskManager|Workflow|Tasks|Accountability)/i.test(appContent),
    'no second task-management page must be lazily imported into App.jsx')
}

const tests = [
  ['imports the accounts list hook and the current-user hook', testImportsAccountsAndCurrentAccount],
  ['Assigned To picker is populated from the real accounts list', testAssignedToPickerPopulatedFromAccounts],
  ['Mine and Overdue filters are wired to the real account/date, not hardcoded', testMineAndOverdueFilters],
  ['workload summary is computed and rendered via the existing Badge component', testWorkloadSummaryComputedAndRendered],
  ['history entries show who made each change', testHistoryShowsWhoMadeTheChange],
  ['all pre-existing Action Center behavior is preserved', testExistingBehaviorPreserved],
  ['no second workflow/task-management page was created', testNoSecondWorkflowPageWasCreated],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
