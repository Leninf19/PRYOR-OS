// Regression tests for dashboard/src/pages/settings/RestaurantContacts.jsx
// (Phase 8, Milestone 8.4). No React component-render test framework exists
// in this repo -- these are plain-text/regex source-content assertions,
// the same style test_provider_health_ui.js/
// test_review_explorer_send_to_restaurant.js use.
//
// Run directly: node tests/test_restaurant_contacts_ui.js

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
  // Normalize CRLF so \n-anchored regexes match regardless of the
  // checkout's line-ending style (Windows checkouts with core.autocrlf=true).
  return readFileSync(path.join(SRC_DIR, relPath), 'utf-8').replace(/\r\n/g, '\n')
}

function testUsesLiveRestaurantContactsHookNotBakedMeta() {
  const content = read('pages/settings/RestaurantContacts.jsx')
  assert(/from '\.\.\/\.\.\/hooks\/useRestaurantContacts\.js'/.test(content), 'must read from the live Redis-backed hook')
  assert(/from '\.\.\/\.\.\/hooks\/useIntelligence\.js'/.test(content) && /useMeta/.test(content),
    'must still enumerate every location from meta.json, so unconfigured locations still get a row')
}

function testEveryLocationGetsARowRegardlessOfConfiguration() {
  const content = read('pages/settings/RestaurantContacts.jsx')
  assert(/meta\?\.locations \?\? \[\]/.test(content), 'must map over every location from meta.json, not just configured ones')
  assert(/active: contact\?\.active \?\? null/.test(content), 'an unconfigured location must be distinguishable (null) from an explicitly disabled one (false)')
}

function testConfigureContactAppearsExactlyWhenUnconfigured() {
  const content = read('pages/settings/RestaurantContacts.jsx')
  assert(/row\.active === null \? \(/.test(content), 'must branch on active === null (never simply "no email") to decide whether to show Configure Contact')
  assert(/Configure Contact/.test(content), 'must offer Configure Contact for an unconfigured location')
  assert(/⚠ Not Configured/.test(content), 'must show the required warning badge for an unconfigured location')
}

function testConfiguredRowsShowEditDisableDeleteActions() {
  const content = read('pages/settings/RestaurantContacts.jsx')
  assert(/>Edit</.test(content), 'a configured contact must offer Edit')
  assert(/row\.active \? 'Disable' : 'Enable'/.test(content), 'a configured contact must offer Disable/Enable, toggling by current state')
  assert(/>Delete</.test(content), 'a configured contact must offer Delete')
}

function testSendTestEmailActionWiredToTheSharedHook() {
  const content = read('pages/settings/RestaurantContacts.jsx')
  assert(/from '\.\.\/\.\.\/hooks\/useEmailSystemStatus\.js'/.test(content), 'must import useSendTestEmail from the shared Email System hook, not a local fetch()')
  assert(/useSendTestEmail/.test(content), 'must call useSendTestEmail()')
  assert(/>Send Test Email</.test(content), 'a configured contact must offer Send Test Email (Milestone 8.9)')
  assert(/sendTestEmailMutation\.mutateAsync\(row\.locationId\)/.test(content), 'must send the test email for the row\'s own locationId, never a hardcoded or client-editable id')
}

function testDeleteUsesConfirmDialogNotBrowserConfirm() {
  const content = read('pages/settings/RestaurantContacts.jsx')
  assert(/from '\.\.\/\.\.\/components\/ui\/ConfirmDialog\.jsx'/.test(content), 'must use the shared ConfirmDialog, not window.confirm')
  assert(!/window\.confirm/.test(content), 'must never use a native browser confirm() dialog')
  assert(/danger/.test(content), 'the delete confirmation must be styled as a destructive action')
}

function testSearchFilterSortAndPaginationPresent() {
  const content = read('pages/settings/RestaurantContacts.jsx')
  assert(/Search location, manager, or email/.test(content), 'a search input must be present')
  assert(/statusFilter/.test(content), 'a status filter must be present')
  assert(/function Th\(/.test(content) && /aria-sort=/.test(content), 'must use a real ARIA-sortable header, matching ReviewExplorer.jsx\'s Th pattern')
  assert(/PAGE_SIZE/.test(content), 'must paginate, matching ReviewExplorer.jsx\'s pattern')
}

function testUsesSharedEmptyLoadingErrorStates() {
  const content = read('pages/settings/RestaurantContacts.jsx')
  assert(/from '\.\.\/\.\.\/components\/ui\/Skeleton\.jsx'/.test(content), 'loading state must use the shared Skeleton component')
  assert(/from '\.\.\/\.\.\/components\/ui\/EmptyState\.jsx'/.test(content), 'empty state must use the shared EmptyState component')
  assert(/from '\.\.\/\.\.\/components\/ui\/ErrorState\.jsx'/.test(content), 'error state must use the shared ErrorState component')
}

function testMobileResponsiveStackedCardFallback() {
  const content = read('pages/settings/RestaurantContacts.jsx')
  assert(/hidden sm:block/.test(content) && /sm:hidden/.test(content),
    'must degrade to a stacked-card layout below the sm breakpoint, matching ReviewExplorer.jsx\'s responsive pattern')
}

// Milestone 8.11 hardening pass finding: ContactEditorModal.jsx's Manager
// Name / Primary Email <label>s had no htmlFor/id association -- a screen
// reader tabbing into the input announced no accessible name at all (visual
// proximity to a sibling <div> is not a programmatic association). Fixed by
// pairing each label's htmlFor with its input's id.
function testContactEditorModalLabelsAreProgrammaticallyAssociated() {
  const content = read('pages/settings/ContactEditorModal.jsx')
  assert(/htmlFor="contact-manager-name"/.test(content) && /id="contact-manager-name"/.test(content),
    'Manager Name label must be linked to its input via matching htmlFor/id')
  assert(/htmlFor="contact-primary-email"/.test(content) && /id="contact-primary-email"/.test(content),
    'Primary Email label must be linked to its input via matching htmlFor/id')
  assert(/aria-invalid=\{Boolean\(primaryEmailError\)\}/.test(content), 'the primary email input must expose its validity state via aria-invalid')
}

function testRegisteredInSettingsSectionsWithCorrectRoles() {
  const content = read('pages/settings/settingsSections.js')
  const sectionMatch = content.match(/\{\s*id:\s*'contacts',[\s\S]*?\n {2}\}/)
  assert(sectionMatch, 'a "contacts" entry must exist in the settings registry')
  const section = sectionMatch[0]
  assert(/requiredRoles:\s*\['owner', 'marketing', 'location_manager'\]/.test(section),
    'Restaurant Contacts must be visible to owner/marketing/location_manager, matching the approved Phase 8 role matrix (read_only excluded)')
}

const tests = [
  ['uses the live useRestaurantContacts hook, still enumerates every location from meta.json', testUsesLiveRestaurantContactsHookNotBakedMeta],
  ['every location gets a row regardless of configuration state', testEveryLocationGetsARowRegardlessOfConfiguration],
  ['Configure Contact appears exactly when a location is unconfigured', testConfigureContactAppearsExactlyWhenUnconfigured],
  ['configured rows show Edit/Disable-Enable/Delete actions', testConfiguredRowsShowEditDisableDeleteActions],
  ['Send Test Email is wired to the shared useSendTestEmail hook, scoped to the row\'s own location', testSendTestEmailActionWiredToTheSharedHook],
  ['delete uses the shared ConfirmDialog, never window.confirm', testDeleteUsesConfirmDialogNotBrowserConfirm],
  ['search, status filter, sortable headers, and pagination are all present', testSearchFilterSortAndPaginationPresent],
  ['uses the shared Skeleton/EmptyState/ErrorState components', testUsesSharedEmptyLoadingErrorStates],
  ['degrades to a stacked-card layout on mobile', testMobileResponsiveStackedCardFallback],
  ['ContactEditorModal\'s labels are programmatically associated with their inputs (Milestone 8.11 fix)', testContactEditorModalLabelsAreProgrammaticallyAssociated],
  ['registered in settingsSections.js with the correct role visibility', testRegisteredInSettingsSectionsWithCorrectRoles],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
