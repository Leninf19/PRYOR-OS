// Regression tests for dashboard/src/pages/settings/GoogleBusinessProfile.jsx
// (Phase 8, Milestone 8.7, hardened in Milestone 8.11). No React
// component-render test framework exists in this repo -- these are
// plain-text/regex source-content assertions, matching
// test_restaurant_contacts_ui.js's style. This page previously had no
// dedicated frontend test file at all.
//
// Run directly: node tests/test_google_business_profile_ui.js

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

function testUsesTheRealOAuthStatusHooks() {
  const content = read('pages/settings/GoogleBusinessProfile.jsx')
  assert(/from '\.\.\/\.\.\/hooks\/useGoogleOAuthStatus\.js'/.test(content), 'must read status from the real React Query hook, not a bespoke fetch')
  assert(/useGoogleOAuthStatus/.test(content) && /useDisconnectGoogle/.test(content), 'must use both useGoogleOAuthStatus and useDisconnectGoogle')
}

function testFiveConnectionStatesAreAllMapped() {
  const content = read('pages/settings/GoogleBusinessProfile.jsx')
  for (const state of ['connected', 'token_expired', 'token_revoked', 'auth_failed', 'never_connected']) {
    assert(new RegExp(`${state}:`).test(content), `STATUS_META must map the "${state}" GoogleHealth state`)
  }
}

function testDisconnectUsesTypeTheWordConfirmDialog() {
  const content = read('pages/settings/GoogleBusinessProfile.jsx')
  assert(/from '\.\.\/\.\.\/components\/ui\/ConfirmDialog\.jsx'/.test(content), 'must use the shared ConfirmDialog, not window.confirm')
  assert(!/window\.confirm/.test(content), 'must never use a native browser confirm() dialog')
  assert(/confirmWord="DISCONNECT"/.test(content), 'disconnecting must require typing the word DISCONNECT (higher blast-radius than a click-to-arm delete)')
}

function testUsesSharedLoadingEmptyErrorStates() {
  const content = read('pages/settings/GoogleBusinessProfile.jsx')
  assert(/from '\.\.\/\.\.\/components\/ui\/Skeleton\.jsx'/.test(content), 'must use the shared Skeleton component for loading states')
  assert(/from '\.\.\/\.\.\/components\/ui\/EmptyState\.jsx'/.test(content), 'must use the shared EmptyState component')
  assert(/from '\.\.\/\.\.\/components\/ui\/ErrorState\.jsx'/.test(content), 'must use the shared ErrorState component')
}

// Milestone 8.11 hardening pass finding: the historical-import confirm-text
// input had no accessible name at all (no <label>, no aria-label) -- only a
// placeholder, which screen readers do not reliably announce as a label.
function testHistoricalImportConfirmInputHasAnAccessibleName() {
  const content = read('pages/settings/GoogleBusinessProfile.jsx')
  assert(/placeholder='Type "IMPORT" to enable'[\s\S]{0,80}aria-label=/.test(content),
    'the "Type IMPORT to enable" confirm input must carry an aria-label (Milestone 8.11 fix)')
}

function testRegisteredInSettingsSectionsVisibleToAllRoles() {
  const content = read('pages/settings/settingsSections.js')
  const sectionMatch = content.match(/\{\s*id:\s*'google',[\s\S]*?\n {2}\}/)
  assert(sectionMatch, 'a "google" entry must exist in the settings registry')
  assert(/requiredRoles:\s*null/.test(sectionMatch[0]), 'the read-only connection status banner is visible to every authenticated role')
}

const tests = [
  ['uses the real useGoogleOAuthStatus/useDisconnectGoogle hooks', testUsesTheRealOAuthStatusHooks],
  ['all five GoogleHealth connection states are mapped', testFiveConnectionStatesAreAllMapped],
  ['Disconnect requires typing the word DISCONNECT via the shared ConfirmDialog', testDisconnectUsesTypeTheWordConfirmDialog],
  ['uses the shared Skeleton/EmptyState/ErrorState components', testUsesSharedLoadingEmptyErrorStates],
  ['the historical-import confirm input has an accessible name (Milestone 8.11 fix)', testHistoricalImportConfirmInputHasAnAccessibleName],
  ['registered in settingsSections.js, visible to every role', testRegisteredInSettingsSectionsVisibleToAllRoles],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
