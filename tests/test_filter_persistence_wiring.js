// Regression tests for App.jsx/GlobalFilters.jsx's wiring to
// filterPersistence.js (Recovery Milestone: Global Filter Persistence). No
// React/browser test framework exists in this repo -- these are plain
// text/regex source-content assertions, same style as
// test_review_email_workflow_frontend.js.
//
// Run directly: node tests/test_filter_persistence_wiring.js

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

const app = () => read('App.jsx')
const globalFilters = () => read('components/GlobalFilters.jsx')

function testAppUsesSearchParamsNotOnlyLocalState() {
  assert(/useSearchParams/.test(app()), 'App.jsx must use React Router\'s useSearchParams for URL-driven filter state')
}

function testAppImportsFilterPersistenceHelpers() {
  const content = app()
  for (const fn of ['parseFiltersFromSearchParams', 'loadStoredFilters', 'saveStoredFilters', 'clearStoredFilters', 'withFreshDefaults', 'buildSearchParamsFromFilters', 'stripFilterParams']) {
    assert(content.includes(fn), `App.jsx must import/use ${fn} from filterPersistence.js`)
  }
}

function testFilterChangeGoesThroughSetSearchParamsNotBareSetFilters() {
  const content = app()
  assert(/function handleFilterChange/.test(content), 'a dedicated handleFilterChange must exist')
  // Within handleFilterChange, the write must go through setSearchParams (URL is the source of
  // truth), not a bare setFilters call that would bypass URL/localStorage sync entirely.
  const fnBody = content.match(/function handleFilterChange\([^)]*\)\s*\{([^}]*)\}/s)?.[1] ?? ''
  assert(/setSearchParams/.test(fnBody), 'handleFilterChange must call setSearchParams, not just update local state directly')
}

function testResetIsDistinctFromANormalFilterChange() {
  const content = app()
  assert(/function handleResetFilters/.test(content), 'a dedicated handleResetFilters must exist, distinct from handleFilterChange')
  const fnBody = content.match(/function handleResetFilters\([^)]*\)\s*\{([^}]*)\}/s)?.[1] ?? ''
  assert(/clearStoredFilters/.test(fnBody), 'reset must clear localStorage')
  assert(/stripFilterParams/.test(fnBody), 'reset must strip URL filter params (not rewrite them as explicit computed-default values)')
}

function testReplaceUsedForFilterUrlSyncNotPush() {
  // Filter edits must use { replace: true } so tweaking filters doesn't
  // spam browser history -- back/forward still works at the page-navigation
  // granularity (each page's own URL already carries its own filter
  // snapshot from the last time it was visited/edited).
  const content = app()
  const setSearchParamsLines = content.split('\n').filter(l => /\bsetSearchParams\(/.test(l))
  assert(setSearchParamsLines.length > 0, 'expected at least one setSearchParams call')
  assert(setSearchParamsLines.every(l => /replace:\s*true/.test(l)), `every setSearchParams call for filter sync must pass { replace: true }, found: ${JSON.stringify(setSearchParamsLines)}`)
}

function testGlobalFiltersAcceptsOnResetProp() {
  const content = globalFilters()
  assert(/onReset/.test(content), 'GlobalFilters.jsx must accept an onReset prop')
  assert(/onReset\?\.\(\)|onReset\(\)/.test(content), 'the Clear/reset control must actually call onReset when provided')
}

function testGlobalFiltersReceivesOnResetFromApp() {
  const content = app()
  assert(/<GlobalFilters[^/]*onReset=\{handleResetFilters\}/s.test(content), 'App.jsx must wire onReset={handleResetFilters} into <GlobalFilters>')
}

function testDefaultDateFieldsNeverReadFromUrlOrStorage() {
  // _defaultStart/_defaultEnd must never appear as keys this module reads
  // from a URL or a stored record -- they're always freshly computed
  // (withFreshDefaults), confirmed structurally: filterPersistence.js's
  // FILTER_PARAM_KEYS list (the only keys ever read from the URL) must not
  // include them.
  const fp = read('utils/filterPersistence.js')
  const keysMatch = fp.match(/FILTER_PARAM_KEYS\s*=\s*\[([^\]]*)\]/)
  assert(keysMatch, 'could not find FILTER_PARAM_KEYS definition')
  assert(!keysMatch[1].includes('_default'), 'FILTER_PARAM_KEYS must never include _defaultStart/_defaultEnd')
}

function main() {
  run('App.jsx uses useSearchParams (URL-driven, not local-state-only)', testAppUsesSearchParamsNotOnlyLocalState)
  run('App.jsx imports every filterPersistence.js helper it needs', testAppImportsFilterPersistenceHelpers)
  run('a filter change writes through setSearchParams, not a bare setFilters', testFilterChangeGoesThroughSetSearchParamsNotBareSetFilters)
  run('Reset is a distinct path that clears localStorage and strips URL params', testResetIsDistinctFromANormalFilterChange)
  run('filter-sync setSearchParams calls use replace, not push (no history spam)', testReplaceUsedForFilterUrlSyncNotPush)
  run('GlobalFilters.jsx accepts and calls an onReset prop', testGlobalFiltersAcceptsOnResetProp)
  run('App.jsx wires onReset={handleResetFilters} into GlobalFilters', testGlobalFiltersReceivesOnResetFromApp)
  run('_defaultStart/_defaultEnd are never part of the URL vocabulary', testDefaultDateFieldsNeverReadFromUrlOrStorage)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
