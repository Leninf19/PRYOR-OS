// Regression tests for dashboard/src/pages/settings/AuditLog.jsx (Phase 8,
// Milestone 8.6, hardened in Milestone 8.11). No React component-render
// test framework exists in this repo -- these are plain-text/regex
// source-content assertions, matching test_restaurant_contacts_ui.js's style.
//
// Run directly: node tests/test_audit_log_ui.js

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

function testUsesSharedLoadingEmptyErrorStates() {
  const content = read('pages/settings/AuditLog.jsx')
  assert(/from '\.\.\/\.\.\/components\/ui\/Skeleton\.jsx'/.test(content), 'loading state must use the shared Skeleton component')
  assert(/from '\.\.\/\.\.\/components\/ui\/EmptyState\.jsx'/.test(content), 'empty state must use the shared EmptyState component')
  assert(/from '\.\.\/\.\.\/components\/ui\/ErrorState\.jsx'/.test(content), 'error state must use the shared ErrorState component')
}

// Milestone 8.11 hardening pass finding: this table had no mobile stacked-
// card fallback (unlike RestaurantContacts.jsx), unlike every other new
// Phase 8 table -- fixed to match the same hidden sm:block / sm:hidden
// pattern.
function testMobileResponsiveStackedCardFallback() {
  const content = read('pages/settings/AuditLog.jsx')
  assert(/hidden sm:block/.test(content) && /sm:hidden/.test(content),
    'must degrade to a stacked-card layout below the sm breakpoint, matching ReviewExplorer.jsx/RestaurantContacts.jsx\'s responsive pattern')
}

function testFiltersPresent() {
  const content = read('pages/settings/AuditLog.jsx')
  assert(/Filter by entity/.test(content), 'an entity filter must be present')
  assert(/Filter by result/.test(content), 'a result filter must be present')
}

function testRegisteredInSettingsSectionsOwnerOnly() {
  const content = read('pages/settings/settingsSections.js')
  const sectionMatch = content.match(/\{\s*id:\s*'audit-log',[\s\S]*?\n {2}\}/)
  assert(sectionMatch, 'an "audit-log" entry must exist in the settings registry')
  assert(/requiredRoles:\s*\['owner'\]/.test(sectionMatch[0]), 'the global audit trail must be Owner-only, matching the approved Phase 8 role matrix')
}

const tests = [
  ['uses the shared Skeleton/EmptyState/ErrorState components', testUsesSharedLoadingEmptyErrorStates],
  ['degrades to a stacked-card layout on mobile (Milestone 8.11 fix)', testMobileResponsiveStackedCardFallback],
  ['entity and result filters are present', testFiltersPresent],
  ['registered in settingsSections.js as Owner-only', testRegisteredInSettingsSectionsOwnerOnly],
]

for (const [name, fn] of tests) run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
