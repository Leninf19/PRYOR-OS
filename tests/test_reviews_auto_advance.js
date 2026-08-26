// Regression tests for the Reviews auto-advance skip bug: after a
// successful Confirm & Publish, the UI opened one review further down the
// queue than the immediate next one (e.g. publishing A opened C instead of
// B). Root cause: the OLD selection/advance logic identified reviews by
// `${r.review_id || r.review_url || i}` -- for any review lacking BOTH a
// real review_id and review_url (the location+reviewer fuzzy-match fallback
// path), that identity fell back to `i`, the review's POSITION in the
// visible array at computation time. Once the published review was removed
// from the actionable queue on the next render, every remaining review's
// position shifted down by one, so the STALE positional key that used to
// point at "B" now matched whatever review had taken over that same index
// (C). The fix (dashboard/src/utils/dataUtils.js's computeNextReviewId(),
// used by Reviews.jsx) identifies both the current and the next review by
// the canonical, array-position-agnostic reviewId(r) this file already
// uses everywhere else, computed BEFORE the current review is marked
// complete/removed.
//
// computeNextReviewId is a pure function (no React, no DOM) so every
// ordering/edge-case guarantee below is a direct unit test, not a
// simulation glued together from source-text regexes.
//
// Run directly: node tests/test_reviews_auto_advance.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { computeNextReviewId, reviewId } from '../dashboard/src/utils/dataUtils.js'

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

// A review with neither review_id nor review_url -- forces reviewId()'s
// date+reviewer-name fallback, exactly the class of review that triggered
// the original bug (the fuzzy location+reviewer match path).
function fallbackReview(date, name) {
  return { review_date: date, reviewer_name: name, location_name: 'Casa Tequila Prime', star_rating: 4, review_text: 'x' }
}
function idReview(id) {
  return { review_id: id, review_date: '2026-08-01', reviewer_name: 'Someone', location_name: 'Casa Tequila Prime', star_rating: 4, review_text: 'x' }
}

// ── Required ordering semantics: A,B,C,D sequential publish ─────────────

function testSequentialPublishAdvancesOneAtATimeThroughFallbackIdentityReviews() {
  // All 4 use the fallback identity path (no review_id/review_url) --
  // exactly the scenario that broke before.
  let queue = [
    fallbackReview('2026-08-01', 'Alpha'),   // A
    fallbackReview('2026-08-02', 'Bravo'),   // B
    fallbackReview('2026-08-03', 'Charlie'), // C
    fallbackReview('2026-08-04', 'Delta'),   // D
  ]
  const [A, B, C, D] = queue
  let selected = reviewId(A)

  // Publish A -> B (never C)
  let next = computeNextReviewId(queue, selected)
  assert(next === reviewId(B), `expected B after publishing A, got ${next}`)
  queue = queue.filter(r => reviewId(r) !== selected) // A leaves the actionable queue
  selected = next

  // Publish B -> C
  next = computeNextReviewId(queue, selected)
  assert(next === reviewId(C), `expected C after publishing B, got ${next}`)
  queue = queue.filter(r => reviewId(r) !== selected)
  selected = next

  // Publish C -> D
  next = computeNextReviewId(queue, selected)
  assert(next === reviewId(D), `expected D after publishing C, got ${next}`)
  queue = queue.filter(r => reviewId(r) !== selected)
  selected = next

  // Publish D -> all caught up (no next, no previous -- queue is now empty)
  next = computeNextReviewId(queue, selected)
  assert(next === null, `expected null (all caught up) after publishing D, got ${next}`)
}

function testPublishingFromTheMiddleAdvancesToTheImmediateNextOnly() {
  const queue = [
    fallbackReview('2026-08-01', 'Alpha'),
    fallbackReview('2026-08-02', 'Bravo'),
    fallbackReview('2026-08-03', 'Charlie'),
    fallbackReview('2026-08-04', 'Delta'),
  ]
  const [A, , C, D] = queue
  const selected = reviewId(queue[1]) // current = B
  const next = computeNextReviewId(queue, selected)
  assert(next === reviewId(C), `publishing from the middle (B) must advance to C, got ${next}`)
  assert(next !== reviewId(D), 'must not skip past C to D')
  assert(next !== reviewId(A), 'must not go backwards to A')
}

// ── The exact root-cause reproduction: mixed identity queue, mutation
//    between computation and lookup must never cause a skip ─────────────

function testNoIndexSkippingAfterQueueMutationEvenWithFallbackIdentityReviews() {
  const A = fallbackReview('2026-08-01', 'Alpha')
  const B = fallbackReview('2026-08-02', 'Bravo')
  const C = fallbackReview('2026-08-03', 'Charlie')
  const preRemoval = [A, B, C]

  // Computed BEFORE A is removed (matches Reviews.jsx's own call timing).
  const nextId = computeNextReviewId(preRemoval, reviewId(A))
  assert(nextId === reviewId(B))

  // A is now removed -- B's index shifts from 1 to 0, exactly the
  // shift that used to corrupt an index-based selection.
  const postRemoval = [B, C]
  const found = postRemoval.find(r => reviewId(r) === nextId)
  assert(found === B, 'the previously-computed nextReviewId must still resolve to B after the array shifts, never to C')
}

// ── Filters preserved: computeNextReviewId only ever sees the CALLER's
//    already-filtered queue -- it never reaches outside it ──────────────

function testNeverAdvancesToAReviewOutsideTheAlreadyFilteredQueue() {
  // Simulates a location-filtered view: only 2 of 4 total reviews are
  // actually "visible" to computeNextReviewId at all.
  const inFilter = [fallbackReview('2026-08-01', 'Alpha'), fallbackReview('2026-08-02', 'Bravo')]
  const outOfFilter = [fallbackReview('2026-08-03', 'Charlie'), fallbackReview('2026-08-04', 'Delta')]
  const next = computeNextReviewId(inFilter, reviewId(inFilter[0]))
  assert(next === reviewId(inFilter[1]))
  assert(!outOfFilter.some(r => reviewId(r) === next), 'must never select a review the active filters have already excluded')
}

// ── Edge cases ────────────────────────────────────────────────────────────

function testSingleItemQueuePublishResultsInAllCaughtUp() {
  const only = fallbackReview('2026-08-01', 'Alpha')
  assert(computeNextReviewId([only], reviewId(only)) === null)
}

function testEmptyQueueReturnsNull() {
  assert(computeNextReviewId([], 'anything') === null)
}

function testSelectedKeyNotInQueueReturnsNull() {
  const queue = [fallbackReview('2026-08-01', 'Alpha')]
  assert(computeNextReviewId(queue, 'not-in-queue') === null)
}

function testMixedIdentityQueueRealIdsAndFallbackIdsInterleaved() {
  const queue = [idReview('r1'), fallbackReview('2026-08-02', 'Bravo'), idReview('r3')]
  assert(computeNextReviewId(queue, 'r1') === reviewId(queue[1]))
  assert(computeNextReviewId(queue, reviewId(queue[1])) === 'r3')
}

function testFirstItemFallsBackToPreviousWhenItWasTheOnlyOtherItem() {
  // Publishing the LAST item when exactly one other item remains before
  // it -- falls back to the previous item (existing, documented UX
  // choice; "all caught up" is reserved for a genuinely empty remainder).
  const queue = [fallbackReview('2026-08-01', 'Alpha'), fallbackReview('2026-08-02', 'Bravo')]
  const next = computeNextReviewId(queue, reviewId(queue[1]))
  assert(next === reviewId(queue[0]))
}

// ── Wiring: Reviews.jsx actually uses the extracted, tested function --
//    no index-based fallback identity survives anywhere in the file ──────

function testNoIndexBasedFallbackIdentityRemainsInReviewsJsx() {
  // Excludes `//` comment lines -- the root-cause explanation above the new
  // nextReviewId memo deliberately quotes the OLD buggy pattern in prose;
  // this test asserts the pattern is gone from actual CODE, not from the
  // file's own postmortem of itself.
  // .split(/\r?\n/) + stripping trailing \r before the //-strip regex --
  // this file has CRLF line endings, and JS's `.` excludes \r (not just
  // \n), so a plain /\/\/.*$/ against a \r-terminated line never matches
  // at all (the trailing \r blocks `.*` from ever reaching the true
  // end-of-string `$` requires).
  const codeOnly = readFileSync(REVIEWS_JSX, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n')
  assert(!/review_id \|\| .*\.review_url \|\| i\b/.test(codeOnly), 'no selection/advance code path may fall back to an array-position index as a review identity')
  assert(!/review_id \|\| .*\.review_url \|\| nextIdx\b/.test(codeOnly), 'the old index-based "next" identity must be gone')
}

function testReviewsJsxUsesTheExtractedComputeNextReviewId() {
  const src = readFileSync(REVIEWS_JSX, 'utf-8')
  assert(src.includes('computeNextReviewId'), 'Reviews.jsx must use the shared, unit-tested computeNextReviewId rather than reimplementing the algorithm inline')
  assert(/import\s*\{[^}]*computeNextReviewId[^}]*\}\s*from\s*['"]\.\.\/utils\/dataUtils\.js['"]/s.test(src), 'computeNextReviewId must be imported from dataUtils.js')
}

function testNextReviewIdIsComputedBeforeAnyPublishMutation() {
  const src = readFileSync(REVIEWS_JSX, 'utf-8')
  // nextReviewId must be a value computed at the PAGE level (memoized off
  // the current visible/selectedKey) and threaded down as a plain prop --
  // never recomputed reactively inside the success handler after the
  // mutating array has already changed shape.
  assert(/const nextReviewId = useMemo\(/.test(src), 'nextReviewId must be memoized at the page level, computed ahead of any publish action')
  assert(/onPublishSuccess\?\.\(nextReviewId\)/.test(src), 'every onPublishSuccess call must pass the pre-computed nextReviewId, never recompute it after success')
  const onPublishSuccessCalls = [...src.matchAll(/onPublishSuccess\?\.\([^)]*\)/g)]
  assert(onPublishSuccessCalls.length === 3, `expected exactly 3 onPublishSuccess call sites in ResponseWorkspace (Confirm & Publish, Mark Published, Already Done), found ${onPublishSuccessCalls.length}`)
  assert(onPublishSuccessCalls.every(m => m[0] === 'onPublishSuccess?.(nextReviewId)'), `every onPublishSuccess call must be onPublishSuccess?.(nextReviewId), found: ${onPublishSuccessCalls.map(m => m[0])}`)
}

function testAdvanceToNextIsAPureSelectionSetterNotAReDerivation() {
  const src = readFileSync(REVIEWS_JSX, 'utf-8')
  const fnMatch = src.match(/const advanceToNext = useCallback\(\(targetReviewId\) => \{([\s\S]*?)\n\s*\}, \[\]\)/)
  assert(fnMatch, 'advanceToNext must be a simple useCallback(targetReviewId => ..., []) -- no dependency on visible/selectedKey, since it no longer re-derives anything')
  assert(/setSelectedKey\(targetReviewId \?\? null\)/.test(fnMatch[1]), 'advanceToNext must directly select the given id, never recompute an index')
}

function testSelectionAndRowIdentityUseCanonicalReviewId() {
  const src = readFileSync(REVIEWS_JSX, 'utf-8')
  assert(/visible\.find\(r => reviewId\(r\) === selectedKey\)/.test(src), 'the `selected` lookup must use canonical reviewId(r), not a positional fallback')
  assert(/const key = reviewId\(r\)/.test(src), 'row rendering must key/select by canonical reviewId(r), not a positional fallback')
}

function testNextReviewIdIsThreadedThroughToResponseWorkspace() {
  const src = readFileSync(REVIEWS_JSX, 'utf-8')
  const propOccurrences = [...src.matchAll(/nextReviewId=\{nextReviewId\}/g)].length
  assert(propOccurrences >= 2, `expected nextReviewId to be threaded through both the desktop-persistent and mobile-overlay render sites, found ${propOccurrences}`)
  assert(/function ResponseWorkspace\(\{[^}]*nextReviewId[^}]*\}\)/.test(src), 'ResponseWorkspace must accept a nextReviewId prop')
}

function main() {
  run('sequential publish A->B->C->D->all caught up, using fallback-identity reviews', testSequentialPublishAdvancesOneAtATimeThroughFallbackIdentityReviews)
  run('publishing from the middle (B) advances to the immediate next (C) only', testPublishingFromTheMiddleAdvancesToTheImmediateNextOnly)
  run('no index-skipping after queue mutation, even with fallback-identity reviews', testNoIndexSkippingAfterQueueMutationEvenWithFallbackIdentityReviews)
  run('never advances to a review outside the already-filtered queue', testNeverAdvancesToAReviewOutsideTheAlreadyFilteredQueue)
  run('a single-item queue publish results in all-caught-up (null)', testSingleItemQueuePublishResultsInAllCaughtUp)
  run('an empty queue returns null', testEmptyQueueReturnsNull)
  run('a selectedKey not present in the queue returns null', testSelectedKeyNotInQueueReturnsNull)
  run('a mixed queue of real ids and fallback ids resolves correctly either way', testMixedIdentityQueueRealIdsAndFallbackIdsInterleaved)
  run('publishing the last-of-two falls back to the previous remaining item', testFirstItemFallsBackToPreviousWhenItWasTheOnlyOtherItem)
  run('no index-based fallback identity remains anywhere in Reviews.jsx', testNoIndexBasedFallbackIdentityRemainsInReviewsJsx)
  run('Reviews.jsx uses the shared, unit-tested computeNextReviewId', testReviewsJsxUsesTheExtractedComputeNextReviewId)
  run('nextReviewId is computed ahead of time and passed through unmodified on success', testNextReviewIdIsComputedBeforeAnyPublishMutation)
  run('advanceToNext is a pure selection setter, never a re-derivation', testAdvanceToNextIsAPureSelectionSetterNotAReDerivation)
  run('selection and row identity use the canonical reviewId(r)', testSelectionAndRowIdentityUseCanonicalReviewId)
  run('nextReviewId is threaded through to ResponseWorkspace at both render sites', testNextReviewIdIsThreadedThroughToResponseWorkspace)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
