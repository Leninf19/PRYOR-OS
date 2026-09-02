// Multi-Tenant Phase 4J -- source-content regression tests for the
// read-only "Approved Locations" panel added to
// dashboard/src/pages/settings/GoogleBusinessProfile.jsx. Same regex/
// source-content convention as test_google_business_profile_ui.js (no
// React render framework in this repo).
//
// Run directly: node tests/test_approved_locations_panel_ui.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.resolve(__dirname, '..', 'dashboard', 'src')

function read(relPath) {
  return readFileSync(path.join(SRC_DIR, relPath), 'utf-8')
}

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

const content = read('pages/settings/GoogleBusinessProfile.jsx')

function testPanelExistsAndIsWired() {
  assert(/function ApprovedLocationsPanel/.test(content), 'must define ApprovedLocationsPanel')
  assert(/<ApprovedLocationsPanel \/>/.test(content), 'ApprovedLocationsPanel must actually be rendered')
}

function testRendersNullForLtaAndBeforeLoad() {
  assert(/if \(!tenantStatus \|\| tenantStatus\.approvedLocations === null\) return null/.test(content),
    'must render nothing for LTA (approvedLocations: null) and before tenant status has loaded -- preserving LTA\'s current appearance exactly')
}

function testContainsContactSupportMessagingNoMutationControl() {
  assert(/Contact support to add or remove locations/.test(content), 'must tell the Owner how to request a change')
  // No mutation affordance of any kind -- no checkbox, no button that
  // posts anything, no reference to the platform-admin endpoint.
  const panelBody = content.slice(content.indexOf('function ApprovedLocationsPanel'), content.indexOf('function ApprovedLocationsPanel') + 2500)
  assert(!/<input/.test(panelBody), 'the approved-locations panel must contain no input controls -- read-only display only')
  assert(!/onClick=\{.*fetch/is.test(panelBody), 'the approved-locations panel must never wire a button to a mutating fetch call')
  // Checks for an actual call/fetch path, not documentation prose that
  // merely NAMES the platform-admin endpoint while explaining why this
  // Owner-facing page never calls it.
  assert(!/['"`]\/api\/tenant-entitlements/.test(content), 'this Owner-facing page must never actually call the platform-admin-only entitlement mutation endpoint')
}

function testShowsOperationalPendingBadge() {
  assert(/!loc\.operational && <Badge/.test(content), 'a location still pending its data-plane follow-up (operational: false) must be visibly distinguished from a fully active one')
}

run('the panel exists and is wired into the page', testPanelExistsAndIsWired)
run('renders null for LTA and before tenant status loads', testRendersNullForLtaAndBeforeLoad)
run('contains contact-support messaging and no mutation control', testContainsContactSupportMessagingNoMutationControl)
run('shows a pending badge for non-operational locations', testShowsOperationalPendingBadge)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
