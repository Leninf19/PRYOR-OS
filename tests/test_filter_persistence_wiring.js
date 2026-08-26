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

// ── Global Filter Expiration / Rolling Date Default ─────────────────────

function testAppUsesResolveDateRangeWithExpiration() {
  const content = app()
  assert(content.includes('resolveDateRangeWithExpiration'), 'App.jsx must import and use resolveDateRangeWithExpiration -- a bare withFreshDefaults(fromUrl, dr) can no longer be the whole story once custom dates expire')
  const importMatch = content.match(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/utils\/filterPersistence\.js['"]/s)
  assert(importMatch && /\bresolveDateRangeWithExpiration\b/.test(importMatch[1]), 'resolveDateRangeWithExpiration must be imported from filterPersistence.js, not reimplemented inline in App.jsx')
}

function testExpiredCustomRangeTriggersAUrlRewrite() {
  const content = app()
  assert(/dateResult\.expired/.test(content), 'App.jsx must branch on the expired flag resolveDateRangeWithExpiration returns')
  // The expired branch must call setSearchParams to strip/replace the now-
  // stale start/end sitting in the address bar -- not merely update local
  // state while leaving the stale query string in place forever.
  const expiredBlock = content.match(/if \(dateResult\.expired\) \{([\s\S]*?)\n\s*\}/)
  assert(expiredBlock, 'could not find the "if (dateResult.expired)" block')
  assert(/setSearchParams/.test(expiredBlock[1]), 'an expired custom range must trigger a setSearchParams call to clean the stale URL params')
}

function testSaveStoredFiltersIsCalledWithDateExpiresAt() {
  const content = app()
  const saveCalls = [...content.matchAll(/saveStoredFilters\(\{([\s\S]*?)\}\)/g)]
  assert(saveCalls.length > 0, 'expected at least one saveStoredFilters({...}) call site')
  assert(saveCalls.every(m => /dateExpiresAt:\s*dateResult\.dateExpiresAt/.test(m[1])), 'every saveStoredFilters call in App.jsx must pass dateResult.dateExpiresAt, so the persisted record always carries the correct expiration')
}

function testALiveTabSelfCorrectsViaASingleScheduledTimeoutNotAPollingLoop() {
  const content = app()
  assert(/setTimeout\(/.test(content), 'App.jsx must schedule a timeout to the known expiration so an open tab can self-correct once the hour passes')
  assert(!/setInterval\(/.test(content), 'this must be a single scheduled timeout to a known instant, never a recurring setInterval/polling loop')
  assert(/clearTimeout\(/.test(content), 'the scheduled timeout must be cleaned up (cleared) -- e.g. in a useEffect cleanup function -- not left dangling')
  assert(/_dateExpiresAt/.test(content), 'the scheduling effect must key off the resolved _dateExpiresAt bookkeeping field')
}

function testDateExpirationNeverAppliesToLocationsBrandsStars() {
  const fp = read('utils/filterPersistence.js')
  const fnMatch = fp.match(/export function resolveDateRangeWithExpiration\([^)]*\)\s*\{([\s\S]*?)\n\}/)
  assert(fnMatch, 'could not locate resolveDateRangeWithExpiration')
  assert(!/locations|brands|stars/.test(fnMatch[1]), 'resolveDateRangeWithExpiration must only ever compute start/end/dateExpiresAt -- location/brand/star persistence must stay entirely outside its concern')
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
  run('App.jsx imports and uses resolveDateRangeWithExpiration', testAppUsesResolveDateRangeWithExpiration)
  run('an expired custom range triggers a URL rewrite to clean the stale params', testExpiredCustomRangeTriggersAUrlRewrite)
  run('every saveStoredFilters call persists the resolved dateExpiresAt', testSaveStoredFiltersIsCalledWithDateExpiresAt)
  run('a live tab self-corrects via a single scheduled+cleaned-up timeout, never a polling loop', testALiveTabSelfCorrectsViaASingleScheduledTimeoutNotAPollingLoop)
  run('resolveDateRangeWithExpiration never touches location/brand/star persistence', testDateExpirationNeverAppliesToLocationsBrandsStars)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
