// Regression tests for dashboard/src/utils/filterPersistence.js (Recovery
// Milestone: Global Filter Persistence). Pure-function tests -- no React,
// no router, no real browser. A minimal in-memory localStorage stand-in
// backs the save/load/clear tests (Node has no localStorage global).
//
// Run directly: node tests/test_filter_persistence.js

import {
  parseFiltersFromSearchParams, loadStoredFilters, saveStoredFilters, clearStoredFilters,
  withFreshDefaults, buildSearchParamsFromFilters, stripFilterParams, FILTERS_STORAGE_KEY,
} from '../dashboard/src/utils/filterPersistence.js'

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

// Minimal in-memory localStorage stand-in, installed on globalThis before
// any test that touches save/load/clear.
function installFakeLocalStorage() {
  const store = new Map()
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
  }
  return store
}

const DR = { start: '2026-08-15', end: '2026-08-22' } // stand-in getDefaultDateRange() result

// ── parseFiltersFromSearchParams ─────────────────────────────────────────

function testNoFilterParamsReturnsNull() {
  const sp = new URLSearchParams('foo=bar')
  assert(parseFiltersFromSearchParams(sp) === null, 'must return null when none of the 5 filter keys are present, so the caller falls through to localStorage')
}

function testFullUrlHydration() {
  const sp = new URLSearchParams('start=2026-08-15&end=2026-08-22&locations=Casa%20Tequila%20Prime&brands=Casa%20Tequila&stars=4,5')
  const f = parseFiltersFromSearchParams(sp)
  assert(f.start === '2026-08-15' && f.end === '2026-08-22')
  assert(JSON.stringify(f.locations) === JSON.stringify(['Casa Tequila Prime']))
  assert(JSON.stringify(f.brands) === JSON.stringify(['Casa Tequila']))
  assert(JSON.stringify(f.stars) === JSON.stringify([4, 5]))
}

function testMultipleLocationsRoundTrip() {
  const sp = new URLSearchParams('locations=' + encodeURIComponent('Casa Tequila Prime,Los Tres Amigos Livonia'))
  const f = parseFiltersFromSearchParams(sp)
  assert(JSON.stringify(f.locations) === JSON.stringify(['Casa Tequila Prime', 'Los Tres Amigos Livonia']))
}

function testMultipleBrandsRoundTrip() {
  const sp = new URLSearchParams('brands=' + encodeURIComponent('Casa Tequila,Los Tres Amigos'))
  const f = parseFiltersFromSearchParams(sp)
  assert(JSON.stringify(f.brands) === JSON.stringify(['Casa Tequila', 'Los Tres Amigos']))
}

function testMultipleStarsRoundTrip() {
  const sp = new URLSearchParams('stars=1,3,5')
  const f = parseFiltersFromSearchParams(sp)
  assert(JSON.stringify(f.stars) === JSON.stringify([1, 3, 5]))
}

function testCustomDateRangeRoundTrip() {
  const sp = new URLSearchParams('start=2026-01-01&end=2026-01-31')
  const f = parseFiltersFromSearchParams(sp)
  assert(f.start === '2026-01-01' && f.end === '2026-01-31')
}

function testLocationWithSpacesAndSpecialCharactersRoundTrips() {
  const original = "O'Brien's Casa Tequila & Grill"
  const sp = new URLSearchParams()
  sp.set('locations', original)
  const reparsed = new URLSearchParams(sp.toString())
  const f = parseFiltersFromSearchParams(reparsed)
  assert(f.locations[0] === original, `expected ${JSON.stringify(original)}, got ${JSON.stringify(f.locations[0])}`)
}

function testMalformedStarsIgnoredNotCrashed() {
  const sp = new URLSearchParams('stars=abc,99,-1,3')
  const f = parseFiltersFromSearchParams(sp)
  assert(JSON.stringify(f.stars) === JSON.stringify([3]), `only the one genuinely valid star value (3) should survive, got ${JSON.stringify(f.stars)}`)
}

function testMalformedDateFallsBackToNullNotCrash() {
  const sp = new URLSearchParams('start=not-a-date&end=2026-13-99&locations=X')
  const f = parseFiltersFromSearchParams(sp)
  assert(f.start === null, 'an invalid start must fail safely to null, not be trusted verbatim')
  assert(f.end === null, 'an invalid end (month 13) must fail safely to null')
  assert(JSON.stringify(f.locations) === JSON.stringify(['X']), 'a malformed date must not prevent an otherwise-valid sibling field from parsing')
}

function testEmptyStringParamTreatedAsAbsent() {
  const sp = new URLSearchParams('start=&locations=')
  const f = parseFiltersFromSearchParams(sp)
  assert(f.start === null)
  assert(JSON.stringify(f.locations) === JSON.stringify([]))
}

// ── localStorage round trip ──────────────────────────────────────────────

function testSaveThenLoadRoundTrips() {
  installFakeLocalStorage()
  const filters = { start: '2026-08-15', end: '2026-08-22', locations: ['Casa Tequila Prime'], brands: [], stars: [4, 5] }
  saveStoredFilters(filters)
  const loaded = loadStoredFilters()
  assert(loaded.start === '2026-08-15' && loaded.end === '2026-08-22')
  assert(JSON.stringify(loaded.locations) === JSON.stringify(['Casa Tequila Prime']))
  assert(JSON.stringify(loaded.stars) === JSON.stringify([4, 5]))
}

function testSaveNeverPersistsInternalDefaultBookkeeping() {
  installFakeLocalStorage()
  saveStoredFilters({ start: '2026-08-15', end: '2026-08-22', locations: [], brands: [], stars: [], _defaultStart: 'SHOULD-NOT-PERSIST', _defaultEnd: 'SHOULD-NOT-PERSIST' })
  const raw = localStorage.getItem(FILTERS_STORAGE_KEY)
  assert(!raw.includes('SHOULD-NOT-PERSIST'), '_defaultStart/_defaultEnd must never be written to localStorage -- always recomputed fresh')
}

function testLoadWithNoStoredValueReturnsNull() {
  installFakeLocalStorage()
  assert(loadStoredFilters() === null)
}

function testLoadWithCorruptedJsonReturnsNullNotThrows() {
  const store = installFakeLocalStorage()
  store.set(FILTERS_STORAGE_KEY, 'not valid json{')
  let threw = false
  let result
  try { result = loadStoredFilters() } catch { threw = true }
  assert(!threw, 'corrupted localStorage content must never throw')
  assert(result === null)
}

function testLoadWithWrongShapeReturnsSafeDefaults() {
  const store = installFakeLocalStorage()
  store.set(FILTERS_STORAGE_KEY, JSON.stringify({ start: 12345, locations: 'not-an-array', stars: ['x', 99, 3] }))
  const loaded = loadStoredFilters()
  assert(loaded.start === null, 'a non-string start must fail safely to null')
  assert(JSON.stringify(loaded.locations) === JSON.stringify([]), 'a non-array locations must fail safely to []')
  assert(JSON.stringify(loaded.stars) === JSON.stringify([3]), 'only the genuinely valid star (3) should survive out of a mixed-garbage array')
}

function testClearRemovesTheStoredValue() {
  installFakeLocalStorage()
  saveStoredFilters({ start: '2026-08-15', end: '2026-08-22', locations: [], brands: [], stars: [] })
  clearStoredFilters()
  assert(loadStoredFilters() === null)
}

// ── withFreshDefaults ─────────────────────────────────────────────────────

function testWithFreshDefaultsFillsInMissingFields() {
  const f = withFreshDefaults({ locations: ['X'] }, DR)
  assert(f.start === DR.start && f.end === DR.end, 'a partial object with no start/end must fall back to the fresh computed default')
  assert(JSON.stringify(f.locations) === JSON.stringify(['X']))
  assert(JSON.stringify(f.brands) === JSON.stringify([]))
}

function testWithFreshDefaultsHandlesNullPartial() {
  const f = withFreshDefaults(null, DR)
  assert(f.start === DR.start && f.end === DR.end)
  assert(JSON.stringify(f.locations) === JSON.stringify([]))
}

function testWithFreshDefaultsAlwaysRecomputesDefaultBookkeeping() {
  const f = withFreshDefaults({ start: '2020-01-01', end: '2020-01-02' }, DR)
  assert(f._defaultStart === DR.start && f._defaultEnd === DR.end, '_defaultStart/_defaultEnd must always be the FRESH computed range, never inherited from the partial (URL/localStorage) source')
}

// ── buildSearchParamsFromFilters / stripFilterParams ─────────────────────

function testBuildSearchParamsOmitsEmptyFields() {
  const params = buildSearchParamsFromFilters({ start: '2026-08-15', end: '2026-08-22', locations: [], brands: [], stars: [] }, new URLSearchParams())
  assert(params.get('start') === '2026-08-15' && params.get('end') === '2026-08-22')
  assert(!params.has('locations') && !params.has('brands') && !params.has('stars'), 'empty array fields must not appear as params at all')
}

function testBuildSearchParamsPreservesUnrelatedParams() {
  const existing = new URLSearchParams('filter=all&reviewId=abc123')
  const params = buildSearchParamsFromFilters({ start: '2026-08-15', end: '2026-08-22', locations: [], brands: [], stars: [] }, existing)
  assert(params.get('filter') === 'all', 'an unrelated existing param (e.g. Reviews.jsx\'s ?filter=all) must be preserved')
  assert(params.get('reviewId') === 'abc123', 'an unrelated existing param (e.g. a ?reviewId= deep link) must be preserved')
}

function testBuildSearchParamsNeverAccumulatesDuplicates() {
  let params = new URLSearchParams('start=2026-01-01&end=2026-01-02')
  params = buildSearchParamsFromFilters({ start: '2026-08-15', end: '2026-08-22', locations: ['A'], brands: [], stars: [] }, params)
  params = buildSearchParamsFromFilters({ start: '2026-09-01', end: '2026-09-02', locations: ['B'], brands: [], stars: [] }, params)
  assert(params.getAll('start').length === 1, `expected exactly one start param, got ${params.getAll('start').length}`)
  assert(params.get('start') === '2026-09-01', 'the most recent value must win, not the first')
  assert(params.getAll('locations').length === 1)
}

function testStripFilterParamsRemovesAllFiveButKeepsUnrelated() {
  const existing = new URLSearchParams('start=2026-08-15&end=2026-08-22&locations=X&brands=Y&stars=4,5&filter=all')
  const stripped = stripFilterParams(existing)
  assert(!stripped.has('start') && !stripped.has('end') && !stripped.has('locations') && !stripped.has('brands') && !stripped.has('stars'))
  assert(stripped.get('filter') === 'all', 'an unrelated param must survive a filter reset')
}

function testStripFilterParamsNeverWritesDefaultDatesBack() {
  // Confirms Reset's actual mechanism (strip, don't rewrite) -- distinct
  // from buildSearchParamsFromFilters, which WOULD write concrete dates.
  const existing = new URLSearchParams('start=2026-08-15&end=2026-08-22')
  const stripped = stripFilterParams(existing)
  assert(stripped.toString() === '', `Reset must leave a genuinely empty filter query string, got "${stripped.toString()}"`)
}

function main() {
  run('no filter params in the URL returns null (falls through to localStorage)', testNoFilterParamsReturnsNull)
  run('a fully-specified URL hydrates every field correctly', testFullUrlHydration)
  run('multiple locations round-trip through the URL', testMultipleLocationsRoundTrip)
  run('multiple brands round-trip through the URL', testMultipleBrandsRoundTrip)
  run('multiple star values round-trip through the URL', testMultipleStarsRoundTrip)
  run('a custom date range round-trips through the URL', testCustomDateRangeRoundTrip)
  run('a location with spaces and special characters round-trips correctly', testLocationWithSpacesAndSpecialCharactersRoundTrips)
  run('malformed star values are dropped, not crashed on', testMalformedStarsIgnoredNotCrashed)
  run('a malformed date fails safely to null without blocking sibling fields', testMalformedDateFallsBackToNullNotCrash)
  run('an empty-string param is treated as absent', testEmptyStringParamTreatedAsAbsent)
  run('save then load round-trips exactly', testSaveThenLoadRoundTrips)
  run('save never persists _defaultStart/_defaultEnd bookkeeping', testSaveNeverPersistsInternalDefaultBookkeeping)
  run('load with nothing stored returns null', testLoadWithNoStoredValueReturnsNull)
  run('load with corrupted JSON returns null, never throws', testLoadWithCorruptedJsonReturnsNullNotThrows)
  run('load with the wrong shape fails safely field-by-field', testLoadWithWrongShapeReturnsSafeDefaults)
  run('clear removes the stored value', testClearRemovesTheStoredValue)
  run('withFreshDefaults fills in missing fields from the computed default', testWithFreshDefaultsFillsInMissingFields)
  run('withFreshDefaults handles a null partial (no URL, no localStorage)', testWithFreshDefaultsHandlesNullPartial)
  run('withFreshDefaults always recomputes _defaultStart/_defaultEnd fresh', testWithFreshDefaultsAlwaysRecomputesDefaultBookkeeping)
  run('building params omits empty array fields entirely', testBuildSearchParamsOmitsEmptyFields)
  run('building params preserves unrelated existing params', testBuildSearchParamsPreservesUnrelatedParams)
  run('building params never accumulates duplicate keys across repeated calls', testBuildSearchParamsNeverAccumulatesDuplicates)
  run('stripFilterParams removes all 5 filter keys but keeps unrelated ones', testStripFilterParamsRemovesAllFiveButKeepsUnrelated)
  run('stripFilterParams never writes default dates back (genuine reset)', testStripFilterParamsNeverWritesDefaultDatesBack)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
