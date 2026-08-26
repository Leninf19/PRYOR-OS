// Regression tests for Commit 5 (frontend scoping) of the Multi-Location
// Authentication & User Access System. `restrictLocationsToAllowed` gets a
// real logic test (it's a pure function); everything else follows this
// repo's established source-text-assertion convention for frontend code
// (no React Testing Library/jsdom here) -- see test_account_context.js.
//
// Run directly: node tests/test_frontend_location_scoping.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { restrictLocationsToAllowed } from '../dashboard/src/utils/filterPersistence.js'

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

function src(relPath) {
  return readFileSync(path.join(SRC_DIR, relPath), 'utf-8')
}

// --- restrictLocationsToAllowed: real logic ---------------------------------

function testUnrestrictedAccountPassesThroughUnchanged() {
  const filters = { locations: ['Farmington', 'Chelsea'], start: '2026-01-01' }
  const result = restrictLocationsToAllowed(filters, null)
  assert(result === filters, 'a company-wide (null allowedNames) account must get the exact same object back, unmodified')
}

function testScopedAccountNarrowsToOnlyAllowedNames() {
  const filters = { locations: ['Casa Tequila Prime', 'Farmington'], start: '2026-01-01' }
  const result = restrictLocationsToAllowed(filters, ['Casa Tequila Prime'])
  assert(JSON.stringify(result.locations) === JSON.stringify(['Casa Tequila Prime']), `unauthorized location must be stripped, got ${JSON.stringify(result.locations)}`)
  assert(result.start === '2026-01-01', 'unrelated fields must be preserved')
}

function testScopedAccountWithNoStoredLocationsStaysEmpty() {
  const result = restrictLocationsToAllowed({ locations: [] }, ['Casa Tequila Prime'])
  assert(result.locations.length === 0, 'an empty locations array must stay empty (never widened)')
}

function testNeverExpandsBeyondWhatWasRequested() {
  // The intersection must never ADD a location the filter didn't already
  // request, even if it's in the allowed set -- this is a narrowing
  // operation, never a default-to-everything-allowed operation.
  const result = restrictLocationsToAllowed({ locations: [] }, ['Casa Tequila Prime', 'Farmington'])
  assert(result.locations.length === 0, 'must never expand an empty (== "All") selection into the allowed set')
}

// --- useIntelligence.js: company-wide queries disabled for scoped accounts -

function testCompanyWideHooksAreDisabledForScopedAccounts() {
  const s = src('hooks/useIntelligence.js')
  assert(/export function isLocationScoped/.test(s), 'must export isLocationScoped for other modules to reuse')
  assert(/enabled: !isLocationScoped\(account\)/.test(s), 'useCompanyWideQuery must gate on isLocationScoped, not just let the request fail')
  const companyWideHooks = ['useKPIs', 'useMonthlyTrend', 'useLocationStats', 'useRankings', 'useComplaintIntel', 'useCompanySummary', 'usePredictiveAlerts', 'useResponseDrafts', 'useScraperStatusData', 'useCompetitorIntel', 'useWeeklyReportData', 'useActionItems', 'useDepartmentPerformance', 'useActionCenter', 'useOperationsImpact', 'useCXIndex', 'useBestQuotes', 'useSeasonalTrends', 'useExecutiveScores']
  for (const hook of companyWideHooks) {
    assert(new RegExp(`export function ${hook}\\(\\)\\s*\\{ return useCompanyWideQuery`).test(s), `${hook} must route through useCompanyWideQuery (enabled-gated), got a different implementation`)
  }
  // meta.json/per-location hooks must NOT be gated -- they work for every account.
  assert(/export function useMeta\(\)\s*\{ return useQuery/.test(s), 'useMeta must stay a plain (never-disabled) query')
}

function testGlobalPrefetchSkipsCompanyWideFilesForScopedAccounts() {
  const s = src('hooks/useIntelligence.js')
  assert(/const files = isLocationScoped\(account\)/.test(s), 'useGlobalPrefetch must branch on isLocationScoped before choosing which files to prefetch')
  assert(/\? \[\['meta', 'meta\.json'\]\]/.test(s), 'a scoped account must only prefetch meta.json, not the 13 company-wide files')
}

// --- Layout.jsx: SnapshotBar / sidebar footer scoped correctly -------------

function testSnapshotBarUsesScopedCountsForScopedAccounts() {
  const s = src('components/Layout.jsx')
  assert(/const scoped = isLocationScoped\(account\)/.test(s), 'SnapshotBar must compute scoped from the real account')
  assert(/locationsLabel/.test(s), 'must compute a locations label that can show a single location name, not always "N locations"')
  assert(/allReviews\.filter\(r => r\.star_rating != null && r\.star_rating <= 2/.test(s), 'a scoped account\'s "need reply" count must be derived from its own (already-scoped) review data, mirroring export_action_items()\'s definition')
  assert(!/Los Tres Amigos · 21 Locations/.test(s), 'the hardcoded "21 Locations" footer text must be gone -- it must be computed dynamically')
}

// --- LocationDetail.jsx: Phase 9, "especially important" -------------------

function testLocationDetailSkipsPickerForScopedAccounts() {
  const s = src('pages/LocationDetail.jsx')
  assert(/const scoped = isLocationScoped\(account\)/.test(s), 'LocationDetail must know whether the account is scoped')
  assert(/availableLocations\?\.length > 1/.test(s), 'the location-picker row must only render for a scoped account with MORE than one assigned location')
  assert(/const availableLocations = scoped \? \(meta\?\.locations \?\? \[\]\) : stats/.test(s), 'a scoped account must source its location list from the already-filtered meta.json, not the blocked company-wide location-stats.json')
}

// --- GlobalFilters.jsx: hide the Location picker with only one option ------

function testGlobalFiltersHidesLocationPickerWithOneOption() {
  const s = src('components/GlobalFilters.jsx')
  assert(/allLocations\.length > 1 && \(/.test(s), 'the Location filter block must be conditionally hidden when there is only one (or zero) location options')
}

// --- App.jsx: filter-persistence authorization override (Phase 10) --------

function testFilterPersistenceRestrictsLocationsOnBothResolutionPaths() {
  const s = src('App.jsx')
  assert(/restrictLocationsToAllowed\(withFreshDefaults\(fromUrl, dr\), allowedLocationNames\)/.test(s), 'the URL-sourced filter resolution path must restrict locations to the allowed set')
  assert(/restrictLocationsToAllowed\(withFreshDefaults\(stored, dr\), allowedLocationNames\)/.test(s), 'the localStorage-sourced filter resolution path must restrict locations to the allowed set')
  assert(/getUniqueLocations\(allReviews \?\? \[\]\)/.test(s), 'allowedLocationNames must be derived from the already-server-scoped allReviews, never trusted from elsewhere')
  assert(/useMemo\(\s*\n?\s*\(\) => \(scoped \? getUniqueLocations/.test(s), 'allowedLocationNames must be memoized -- an unmemoized array would re-run the resolution effect on every render')
}

// --- Reviews.jsx: rewrite calls carry localReviewId (needed for Commit 4's
// rewrite.js gate to be usable by a scoped account at all) -----------------

function testReviewsPageSendsLocalReviewIdOnEveryRewriteCall() {
  const s = src('pages/Reviews.jsx')
  // Extracts each callRewrite({...}) call's own argument object (up to its
  // matching close) rather than a flat whole-file count, so this can't be
  // fooled by an unrelated `id:`/`localReviewId:` occurrence elsewhere in
  // this large file matching a loose regex.
  // REVIEWED UPDATE: was 3 (auto-generate-on-open, manual Regenerate, and
  // the background prewarm worker). The prewarm call site was deliberately
  // removed -- it generated drafts for reviews the user never opened,
  // silently moving them from Needs Reply to Draft on page load. The
  // remaining 2 call sites are exactly the two lifecycle-approved triggers:
  // open an undrafted review, or click Regenerate.
  const calls = [...s.matchAll(/callRewrite\(\{([\s\S]*?)\n\s*\}\)/g)]
  assert(calls.length === 2, `expected exactly 2 callRewrite() call sites, found ${calls.length} -- update this test if the page's rewrite call sites changed`)
  calls.forEach((call, i) => {
    assert(/localReviewId:\s*(rid|id)\b/.test(call[1]), `callRewrite() call #${i + 1} is missing localReviewId -- a location-scoped account would be denied (404) using this call site`)
  })
}

run('restrictLocationsToAllowed: a company-wide account passes through unchanged', testUnrestrictedAccountPassesThroughUnchanged)
run('restrictLocationsToAllowed: a scoped account is narrowed to only its allowed locations', testScopedAccountNarrowsToOnlyAllowedNames)
run('restrictLocationsToAllowed: an empty locations array stays empty', testScopedAccountWithNoStoredLocationsStaysEmpty)
run('restrictLocationsToAllowed: never expands beyond what was requested', testNeverExpandsBeyondWhatWasRequested)
run('useIntelligence.js: every company-wide hook is enabled-gated by isLocationScoped', testCompanyWideHooksAreDisabledForScopedAccounts)
run('useIntelligence.js: useGlobalPrefetch skips company-wide files for scoped accounts', testGlobalPrefetchSkipsCompanyWideFilesForScopedAccounts)
run('Layout.jsx: SnapshotBar/sidebar footer use scoped counts, no hardcoded "21 Locations"', testSnapshotBarUsesScopedCountsForScopedAccounts)
run('LocationDetail.jsx: location picker skipped for a scoped account with one location', testLocationDetailSkipsPickerForScopedAccounts)
run('GlobalFilters.jsx: Location filter hidden when there is only one option', testGlobalFiltersHidesLocationPickerWithOneOption)
run('App.jsx: filter persistence restricts locations to the allowed set on both resolution paths', testFilterPersistenceRestrictsLocationsOnBothResolutionPaths)
run('Reviews.jsx: every /api/rewrite call site sends localReviewId', testReviewsPageSendsLocalReviewIdOnEveryRewriteCall)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
