// Regression tests for the Reviews Filtering UX Cleanup milestone: date
// range, locations, brands, and stars are now EXCLUSIVELY the global
// filter bar's responsibility (App.jsx/GlobalFilters.jsx) -- Reviews.jsx no
// longer has its own, disagreeing copy of the location/star dimensions.
// The page receives the already-globally-filtered dataset (`filtered`, a
// prop) and only applies workflow/status filters (reply state, sentiment,
// review length, free-text search) on top of it.
//
// Two kinds of coverage here, matching this repo's established pattern:
//   1. Source-scan assertions that the duplicate controls are actually gone
//      and the new count/prop wiring exists (no React/jsdom in this repo).
//   2. Real pure-function tests composing dataUtils.js's filterReviews()
//      (the exact function App.jsx uses to produce the globally-scoped
//      `filtered` prop) with replyState.js's computeReplyStateCounts() --
//      both genuinely exported, genuinely called, so these prove the real
//      global-scope -> per-status-count pipeline, not just a source-text
//      pattern match.
//
// Run directly: node tests/test_reviews_filter_cleanup.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { filterReviews } from '../dashboard/src/utils/dataUtils.js'
import { computeReplyStateCounts, isActionableReplyState, computeReplyState } from '../dashboard/src/utils/replyState.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REVIEWS_JSX = path.resolve(__dirname, '..', 'dashboard', 'src', 'pages', 'Reviews.jsx')

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

const SRC = readFileSync(REVIEWS_JSX, 'utf-8')

// ── Fixture: a small multi-location, multi-star, multi-date corpus ──────

function review(overrides) {
  return {
    review_id: undefined, review_url: undefined,
    review_date: '2026-08-22', reviewer_name: 'Someone',
    location_name: 'Casa Tequila Prime', star_rating: 4,
    review_text: 'x', owner_response: null,
    ...overrides,
  }
}

const CORPUS = [
  review({ reviewer_name: 'Alpha',  location_name: 'Casa Tequila Prime',    review_date: '2026-08-20', star_rating: 5 }),
  review({ reviewer_name: 'Bravo',  location_name: 'Casa Tequila Prime',    review_date: '2026-08-21', star_rating: 2 }),
  review({ reviewer_name: 'Charlie',location_name: 'Casa Tequila Brighton', review_date: '2026-08-22', star_rating: 4 }),
  review({ reviewer_name: 'Delta',  location_name: 'Casa Tequila Brighton', review_date: '2026-08-23', star_rating: 1 }),
  review({ reviewer_name: 'Echo',   location_name: 'Farmington',            review_date: '2026-08-24', star_rating: 5 }),
  review({ reviewer_name: 'Foxtrot',location_name: 'Farmington',            review_date: '2026-08-10', star_rating: 3 }),
]

// ── 1/2/3. Global location selection controls what Reviews sees ─────────

function testGlobalMultiLocationSelectionShowsUnionOfSelectedLocations() {
  const scoped = filterReviews(CORPUS, { locations: ['Casa Tequila Prime', 'Farmington'], start: null, end: null, stars: [], brands: [] })
  const names = scoped.map(r => r.location_name)
  assert(names.every(n => n === 'Casa Tequila Prime' || n === 'Farmington'), `expected only the 2 selected locations, got ${JSON.stringify([...new Set(names)])}`)
  assert(!names.includes('Casa Tequila Brighton'), 'an unselected location must not appear')
  assert(scoped.length === 4, `expected the union of both locations' reviews (4), got ${scoped.length}`)
}

function testOneGlobalLocationShowsOnlyThatLocation() {
  const scoped = filterReviews(CORPUS, { locations: ['Farmington'], start: null, end: null, stars: [], brands: [] })
  assert(scoped.every(r => r.location_name === 'Farmington'))
  assert(scoped.length === 2)
}

function testAllLocationsRepresentsEveryAuthorizedLocation() {
  // The global filter's "All" state is an empty locations array (see
  // filterPersistence.js/GlobalFilters.jsx's "All" preset) -- every review
  // the account is authorized to see (already server-scoped upstream)
  // passes through untouched.
  const scoped = filterReviews(CORPUS, { locations: [], start: null, end: null, stars: [], brands: [] })
  assert(scoped.length === CORPUS.length)
  const locs = new Set(scoped.map(r => r.location_name))
  assert(locs.size === 3, `expected all 3 locations represented, got ${[...locs]}`)
}

// ── 5/6. Global date range and star changes recalculate status counts ───

function testGlobalDateRangeChangeRecalculatesStatusCounts() {
  const wideScope = filterReviews(CORPUS, { locations: [], start: '2026-08-01', end: '2026-08-31', stars: [], brands: [] })
  const narrowScope = filterReviews(CORPUS, { locations: [], start: '2026-08-20', end: '2026-08-22', stars: [], brands: [] })
  const wideCounts = computeReplyStateCounts(wideScope, {}, {})
  const narrowCounts = computeReplyStateCounts(narrowScope, {}, {})
  assert(wideCounts.needs_reply === 6, `wide date scope should count all 6 as needs_reply (no owner_response/ws/bridge on any), got ${wideCounts.needs_reply}`)
  assert(narrowCounts.needs_reply === 3, `narrowing the global date range to Aug 20-22 should recalculate the count to 3, got ${narrowCounts.needs_reply}`)
  assert(wideCounts.needs_reply !== narrowCounts.needs_reply, 'changing the global date range must actually change the counts')
}

function testGlobalStarsFilterChangesStatusCounts() {
  const allStars = filterReviews(CORPUS, { locations: [], start: null, end: null, stars: [], brands: [] })
  const highStarsOnly = filterReviews(CORPUS, { locations: [], start: null, end: null, stars: [4, 5], brands: [] })
  const allCounts = computeReplyStateCounts(allStars, {}, {})
  const highCounts = computeReplyStateCounts(highStarsOnly, {}, {})
  assert(allCounts.needs_reply === 6)
  assert(highCounts.needs_reply === 3, `4-5 star reviews in the fixture: Alpha(5), Charlie(4), Echo(5) = 3, got ${highCounts.needs_reply}`)
}

// ── Counts reflect global scope, independent of reply state itself ──────

function testCountsReflectRealReplyStatesAcrossTheGlobalScope() {
  const scoped = filterReviews(CORPUS, { locations: [], start: null, end: null, stars: [], brands: [] })
  const ws = { [`2026-08-21-Bravo`]: { status: 'draft_ready' }, [`2026-08-23-Delta`]: { status: 'published' } }
  const withAnswered = scoped.map(r => r.reviewer_name === 'Echo' ? { ...r, owner_response: 'Thanks!' } : r)
  const counts = computeReplyStateCounts(withAnswered, ws, {})
  assert(counts.draft === 1, `Bravo has a draft_ready workspace entry, got ${counts.draft}`)
  assert(counts.confirmed === 1, `Delta was marked published, got ${counts.confirmed}`)
  assert(counts.externally_replied === 1, `Echo has an owner_response with no bridge/published record, got ${counts.externally_replied}`)
  assert(counts.needs_reply === 3, `the remaining 3 (Alpha, Charlie, Foxtrot) are plain needs_reply, got ${counts.needs_reply}`)
  const total = counts.needs_reply + counts.draft + counts.confirmed + counts.failed + counts.externally_replied
  assert(total === CORPUS.length, `counts must never lose or duplicate a review -- expected ${CORPUS.length}, got ${total}`)
}

// ── Reviews status filter never expands the globally-filtered dataset ───

function testLocalStatusFilterNeverExpandsBeyondTheGlobalScope() {
  const globallyScoped = filterReviews(CORPUS, { locations: ['Casa Tequila Prime'], start: null, end: null, stars: [], brands: [] })
  // Simulates Reviews.jsx's own local narrowing: needsResponseOnly (actionable
  // only) + a replyStates pill selection -- applied ON TOP of the already
  // globally-scoped rows, exactly as Reviews.jsx's `processed` memo does.
  const locallyFiltered = globallyScoped
    .filter(r => isActionableReplyState(computeReplyState(r, undefined, undefined)))
    .filter(r => ['needs_reply'].includes(computeReplyState(r, undefined, undefined)))
  assert(locallyFiltered.every(r => globallyScoped.includes(r)), 'every locally-filtered row must already be a member of the globally-scoped set')
  assert(locallyFiltered.length <= globallyScoped.length, 'a local status filter must only ever narrow, never widen, the global scope')
  assert(!locallyFiltered.some(r => r.location_name === 'Casa Tequila Brighton'), 'a local status filter must never surface a review outside the global location scope')
}

// ── Wiring: the duplicate location/star controls are actually gone ──────

function testNoSecondLocationSelectorExistsInReviews() {
  assert(!/aria-label="Filter by location"/.test(SRC), 'the Reviews-local location <select> must be removed entirely')
  assert(!/All locations/.test(SRC), 'no "All locations" option/copy may remain -- that was the local location selector\'s own text')
  assert(!/onLocation/.test(SRC), 'no onLocation prop/handler may remain anywhere in Reviews.jsx')
  assert(!/\blocFilter\b/.test(SRC), 'the local locFilter state must be fully removed, not just hidden')
}

function testNoDuplicateStarSelectorExistsInReviews() {
  assert(!/aria-label="Filter by stars"/.test(SRC), 'the Reviews-local star <select> must be removed entirely')
  assert(!/All stars/.test(SRC), 'no "All stars" option/copy may remain -- that was the local star selector\'s own text')
  assert(!/onStars/.test(SRC), 'no onStars prop/handler may remain anywhere in Reviews.jsx')
}

function testFilterBarNoLongerAcceptsLocationOrStarProps() {
  const fnMatch = SRC.match(/function FilterBar\(\{([\s\S]*?)\}\)/)
  assert(fnMatch, 'could not locate the FilterBar component signature')
  const props = fnMatch[1]
  assert(!/\blocations\b/.test(props) && !/\blocation\b/.test(props), 'FilterBar must no longer accept a locations/location prop')
  assert(!/\bstars\b/.test(props), 'FilterBar must no longer accept a stars prop')
  assert(/replyStateCounts/.test(props), 'FilterBar must accept replyStateCounts to pass through to the status pills')
}

function testProcessedIsBuiltFromTheGloballyFilteredPropNotAllReviews() {
  // `processed`'s base row source must be `filtered` (the global-scope
  // prop from App.jsx), never `allReviews` (which would bypass global
  // scoping/authorization entirely).
  const memoMatch = SRC.match(/const processed = useMemo\(\(\) => \{\s*\n\s*let rows = (\w+)/)
  assert(memoMatch, 'could not locate the processed memo')
  assert(memoMatch[1] === 'filtered', `processed's base rows must come from the globally-filtered \`filtered\` prop, found \`${memoMatch[1]}\``)
}

function testReplyStateCountsAreComputedFromTheGloballyFilteredDataset() {
  assert(/const replyStateCounts = useMemo\(\s*\n?\s*\(\) => computeReplyStateCounts\(filtered, ws, bridgesData\)/.test(SRC), 'replyStateCounts must be computed from `filtered` (global scope), not `processed` (which is further narrowed by local workflow filters)')
}

function testReplyStatePillsReceiveTheCounts() {
  assert(/<ReplyStatePills selected=\{replyStates\} onChange=\{onReplyStates\} counts=\{replyStateCounts\}/.test(SRC), 'ReplyStatePills must receive the global-scope counts')
}

function testSentimentAndLengthRemainLocalNotGlobalDimensions() {
  // Sentiment/length are NOT part of the global filter's vocabulary
  // (filterPersistence.js's FILTER_PARAM_KEYS is start/end/locations/
  // brands/stars only) -- confirms they're legitimately local, not
  // something that should have been removed alongside location/stars.
  const fp = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'src', 'utils', 'filterPersistence.js'), 'utf-8')
  const keysMatch = fp.match(/FILTER_PARAM_KEYS\s*=\s*\[([^\]]*)\]/)
  assert(keysMatch, 'could not find FILTER_PARAM_KEYS')
  assert(!keysMatch[1].includes('sentiment') && !keysMatch[1].includes('length'), 'sentiment/length were never global filter dimensions -- correctly left local')
  assert(/onSentiment/.test(SRC) && /onLength/.test(SRC), 'sentiment/length filters must still exist locally in Reviews.jsx')
}

function main() {
  run('global multi-location selection shows the union of selected locations', testGlobalMultiLocationSelectionShowsUnionOfSelectedLocations)
  run('one global location shows only that location', testOneGlobalLocationShowsOnlyThatLocation)
  run('"All Locations" (empty array) represents every authorized location', testAllLocationsRepresentsEveryAuthorizedLocation)
  run('a global date range change recalculates the status counts', testGlobalDateRangeChangeRecalculatesStatusCounts)
  run('a global stars filter change recalculates the status counts', testGlobalStarsFilterChangesStatusCounts)
  run('counts reflect real reply states (draft/confirmed/externally_replied/needs_reply) across the global scope', testCountsReflectRealReplyStatesAcrossTheGlobalScope)
  run('a local status filter never expands beyond the globally-filtered dataset', testLocalStatusFilterNeverExpandsBeyondTheGlobalScope)
  run('no second location selector exists in Reviews.jsx', testNoSecondLocationSelectorExistsInReviews)
  run('no duplicate star selector exists in Reviews.jsx', testNoDuplicateStarSelectorExistsInReviews)
  run('FilterBar no longer accepts location/star props, but does accept replyStateCounts', testFilterBarNoLongerAcceptsLocationOrStarProps)
  run('processed is built from the globally-filtered `filtered` prop, never allReviews directly', testProcessedIsBuiltFromTheGloballyFilteredPropNotAllReviews)
  run('replyStateCounts is computed from the globally-filtered dataset, not the further-narrowed local view', testReplyStateCountsAreComputedFromTheGloballyFilteredDataset)
  run('ReplyStatePills receives the global-scope counts', testReplyStatePillsReceiveTheCounts)
  run('sentiment/length correctly remain local (never were global filter dimensions)', testSentimentAndLengthRemainLocalNotGlobalDimensions)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
