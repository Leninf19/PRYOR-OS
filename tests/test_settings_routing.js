// Regression tests for dashboard/src/App.jsx's Settings routing (Phase 8,
// Milestone 8.1) -- the app has no DOM-rendering test harness, so this
// follows the same source-content-assertion convention every other
// frontend "UI test" in this suite uses (e.g.
// test_review_explorer_send_to_restaurant.js): read the file, assert the
// expected structure is present via targeted regex, never render it.
//
// Run directly: node tests/test_settings_routing.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_PATH = path.join(__dirname, '..', 'dashboard', 'src', 'App.jsx')

function read(relPath) {
  // Normalize CRLF so \n-anchored regexes match regardless of the
  // checkout's line-ending style (Windows checkouts with core.autocrlf=true).
  return readFileSync(relPath, 'utf-8').replace(/\r\n/g, '\n')
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

function testSettingsLayoutIsLazyImported() {
  const content = read(APP_PATH)
  assert(/const SettingsLayout\s*=\s*lazy\(\(\) => import\('\.\/pages\/settings\/SettingsLayout\.jsx'\)\)/.test(content),
    'App.jsx must lazy-import SettingsLayout from ./pages/settings/SettingsLayout.jsx')
}

function testSettingsSectionsRegistryIsImported() {
  const content = read(APP_PATH)
  assert(content.includes("import { settingsSections } from './pages/settings/settingsSections.js'"),
    'App.jsx must import the settingsSections registry')
}

function testSettingsRouteIsNestedWithGeneratedChildren() {
  const content = read(APP_PATH)
  const routeMatch = content.match(/<Route path="settings" element={<SettingsLayout \/>}>[\s\S]*?<\/Route>/)
  assert(routeMatch, 'App.jsx must have a nested <Route path="settings" element={<SettingsLayout />}>...</Route> block')
  const block = routeMatch[0]
  assert(block.includes('settingsSections.map'), 'the settings route\'s children must be generated from settingsSections, not hardcoded per-section')
  assert(block.includes("s.path === ''") && block.includes('index element='),
    'the generated children must render the path: \'\' entry as an index route')
}

function testNoStaleReferenceToOldFlatSettingsPage() {
  const content = read(APP_PATH)
  assert(!content.includes("import('./pages/Settings.jsx')"),
    'App.jsx must not still import the old flat Settings.jsx -- its content was relocated to pages/settings/*')
  assert(!/<Route path="settings" element={<Settings \/>} \/>/.test(content),
    'the old single flat settings Route must be replaced by the nested block')
}

function testSettingsStillInNoFilterPaths() {
  const content = read(APP_PATH)
  assert(content.includes("'/settings'"), "'/settings' must remain in NO_FILTER_PATHS so no sub-page shows the global review filter bar")
}

function main() {
  run('SettingsLayout is lazy-imported from its new path', testSettingsLayoutIsLazyImported)
  run('settingsSections registry is imported', testSettingsSectionsRegistryIsImported)
  run('the settings route is nested and generates children from the registry', testSettingsRouteIsNestedWithGeneratedChildren)
  run('no stale reference to the old flat Settings.jsx remains', testNoStaleReferenceToOldFlatSettingsPage)
  run("'/settings' remains in NO_FILTER_PATHS", testSettingsStillInNoFilterPaths)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
