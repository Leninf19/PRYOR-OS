// Regression tests for dashboard/src/utils/dataUtils.js's sentiment/filter
// functions (Recovery Milestone: Reviews Analytics KPI). These were
// previously untested despite backing every "Reviews Received" /
// Positive-Neutral-Negative card in the app (Overview.jsx, LocationDetail.jsx,
// ExecutiveReports.jsx, and now Today.jsx).
//
// Run directly: node tests/test_data_utils.js

import { sentimentBucket, getSentiment, filterReviews } from '../dashboard/src/utils/dataUtils.js'

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

// ── sentimentBucket ──────────────────────────────────────────────────────

function testAiSentimentTakesPriorityOverStars() {
  // AI says negative even though the star rating alone would say positive --
  // ai_sentiment must win, exactly as sentimentBucket() is documented to do.
  assert(sentimentBucket({ ai_sentiment: 'negative', star_rating: 5 }) === 'negative')
}

function testStarFallbackWhenNoAiSentiment() {
  assert(sentimentBucket({ star_rating: 5 }) === 'positive')
  assert(sentimentBucket({ star_rating: 4 }) === 'positive')
  assert(sentimentBucket({ star_rating: 3 }) === 'neutral')
  assert(sentimentBucket({ star_rating: 2 }) === 'negative')
  assert(sentimentBucket({ star_rating: 1 }) === 'negative')
}

function testInvalidAiSentimentValueFallsBackToStars() {
  // A garbage/legacy ai_sentiment value (not one of the 3 canonical strings)
  // must not be trusted -- falls back to the star rating exactly like a
  // missing value would.
  assert(sentimentBucket({ ai_sentiment: 'mixed', star_rating: 5 }) === 'positive')
}

function testNullWhenNeitherAiSentimentNorStarRating() {
  assert(sentimentBucket({}) === null)
  assert(sentimentBucket({ star_rating: null }) === null)
}

// ── getSentiment ─────────────────────────────────────────────────────────

function testEmptyArrayIsSafeZero() {
  const sent = getSentiment([])
  assert(sent.n === 0)
  assert(sent.positiveN === 0 && sent.neutralN === 0 && sent.badN === 0)
  assert(sent.positive === 0 && sent.neutral === 0 && sent.bad === 0, 'percentages must be 0, never NaN, for an empty dataset')
}

function testCountsAndPercentagesReconcileWithTotal() {
  const reviews = [
    { star_rating: 5 }, { star_rating: 5 }, { star_rating: 4 }, // 3 positive
    { star_rating: 3 },                                          // 1 neutral
    { star_rating: 1 }, { star_rating: 2 },                       // 2 negative
  ]
  const sent = getSentiment(reviews)
  assert(sent.n === 6)
  assert(sent.positiveN === 3 && sent.neutralN === 1 && sent.badN === 2)
  assert(sent.positiveN + sent.neutralN + sent.badN === sent.n, 'no unclassified reviews in this set -- counts must sum exactly to the total')
  assert(Math.abs(sent.positive - 50) < 0.001, `expected 50%, got ${sent.positive}`)
  assert(Math.abs(sent.neutral - (100 / 6)) < 0.001)
  assert(Math.abs(sent.bad - (200 / 6)) < 0.001)
}

function testPercentageDenominatorIsAllFilteredReviewsNotJustClassified() {
  // One review with neither ai_sentiment nor star_rating -- sentimentBucket()
  // returns null for it, so it's excluded from the 3 buckets, but `n` (and
  // therefore every percentage's denominator) must still count it -- Phase 4's
  // explicit "prefer all filtered reviews" denominator choice, matching what
  // the shared getSentiment() implementation has always done.
  const reviews = [
    { star_rating: 5 }, { star_rating: 5 }, // 2 positive
    {},                                      // 1 unclassifiable (no ai_sentiment, no star_rating)
  ]
  const sent = getSentiment(reviews)
  assert(sent.n === 3, 'the unclassifiable review must still count toward the total')
  assert(sent.positiveN === 2)
  assert(sent.positiveN + sent.neutralN + sent.badN === 2, 'the unclassifiable review must NOT be silently forced into any bucket')
  assert(Math.abs(sent.positive - (200 / 3)) < 0.001, 'percentage denominator must be all reviews (3), not just classified ones (2)')
}

function testNoDuplicateCountingWhenSameReviewObjectAppearsOnce() {
  const a = { star_rating: 5 }
  const sent = getSentiment([a])
  assert(sent.n === 1 && sent.positiveN === 1)
}

// ── filterReviews (the shared date/location/brand filter powering the
//    "Reviews Received" total everywhere, including the new Today.jsx card) ──

function makeReview(overrides) {
  return { location_name: 'Casa Tequila Prime', review_date: '2026-08-15', star_rating: 5, ...overrides }
}

function testDateRangeInclusiveBothEnds() {
  const reviews = [
    makeReview({ review_date: '2026-08-14' }), // before range
    makeReview({ review_date: '2026-08-15' }), // start boundary
    makeReview({ review_date: '2026-08-20' }), // inside
    makeReview({ review_date: '2026-08-22' }), // end boundary
    makeReview({ review_date: '2026-08-23' }), // after range
  ]
  const result = filterReviews(reviews, { start: '2026-08-15', end: '2026-08-22' })
  assert(result.length === 3, `expected 3 reviews in range, got ${result.length}`)
  assert(result.every(r => r.review_date >= '2026-08-15' && r.review_date <= '2026-08-22'))
}

function testSingleDayRange() {
  const reviews = [makeReview({ review_date: '2026-08-15' }), makeReview({ review_date: '2026-08-16' })]
  const result = filterReviews(reviews, { start: '2026-08-15', end: '2026-08-15' })
  assert(result.length === 1)
}

function testEmptyPeriodReturnsEmptyArrayNotError() {
  const reviews = [makeReview({ review_date: '2026-08-15' })]
  const result = filterReviews(reviews, { start: '2026-09-01', end: '2026-09-30' })
  assert(Array.isArray(result) && result.length === 0)
}

function testNoStartEndMeansAllTime() {
  const reviews = [makeReview({ review_date: '2020-01-01' }), makeReview({ review_date: '2026-08-15' })]
  const result = filterReviews(reviews, {})
  assert(result.length === 2, 'omitting start/end must not exclude any review by date')
}

function testLocationFilterScoping() {
  const reviews = [
    makeReview({ location_name: 'Casa Tequila Prime' }),
    makeReview({ location_name: 'Los Tres Amigos Livonia' }),
  ]
  const result = filterReviews(reviews, { locations: ['Casa Tequila Prime'] })
  assert(result.length === 1 && result[0].location_name === 'Casa Tequila Prime')
}

function testAllLocationsMeansNoLocationFilterApplied() {
  const reviews = [
    makeReview({ location_name: 'Casa Tequila Prime' }),
    makeReview({ location_name: 'Los Tres Amigos Livonia' }),
  ]
  const result = filterReviews(reviews, { locations: [] })
  assert(result.length === 2, 'an empty locations array (All Locations) must not filter anything out')
}

function testBrandFilterScoping() {
  const reviews = [
    makeReview({ location_name: 'Casa Tequila Prime' }),
    makeReview({ location_name: 'Los Tres Amigos Livonia' }),
    makeReview({ location_name: 'Mi Lindo San Blas Detroit' }),
  ]
  const result = filterReviews(reviews, { brands: ['Casa Tequila'] })
  assert(result.every(r => r.location_name.startsWith('Casa Tequila')), 'only Casa Tequila locations should remain')
  assert(result.length === 1)
}

// ── Sentiment breakdown reconciles with the filtered total, across
//    All-Locations and a single-location selection, for the same date range ──

function testSentimentReconcilesWithFilteredTotalAcrossAllLocations() {
  const reviews = [
    makeReview({ location_name: 'Casa Tequila Prime', review_date: '2026-08-16', star_rating: 5 }),
    makeReview({ location_name: 'Los Tres Amigos Livonia', review_date: '2026-08-17', star_rating: 1 }),
    makeReview({ location_name: 'Mi Lindo San Blas Detroit', review_date: '2026-08-18', star_rating: 3 }),
    makeReview({ location_name: 'Casa Tequila Prime', review_date: '2026-09-01', star_rating: 5 }), // outside date range
  ]
  const filtered = filterReviews(reviews, { start: '2026-08-15', end: '2026-08-22', locations: [] })
  assert(filtered.length === 3, 'All Locations for this date range must include all 3 in-range reviews across every location')
  const sent = getSentiment(filtered)
  assert(sent.n === 3)
  assert(sent.positiveN + sent.neutralN + sent.badN === sent.n, 'Positive + Neutral + Negative must reconcile exactly with Reviews Received when nothing is unclassified')
  assert(sent.positiveN === 1 && sent.neutralN === 1 && sent.badN === 1)
}

function testSentimentReconcilesForASingleSelectedLocation() {
  const reviews = [
    makeReview({ location_name: 'Casa Tequila Prime', review_date: '2026-08-16', star_rating: 5 }),
    makeReview({ location_name: 'Casa Tequila Prime', review_date: '2026-08-17', star_rating: 2 }),
    makeReview({ location_name: 'Los Tres Amigos Livonia', review_date: '2026-08-17', star_rating: 5 }), // different location
  ]
  const filtered = filterReviews(reviews, { start: '2026-08-15', end: '2026-08-22', locations: ['Casa Tequila Prime'] })
  assert(filtered.length === 2)
  const sent = getSentiment(filtered)
  assert(sent.n === 2 && sent.positiveN === 1 && sent.badN === 1)
}

function testZeroReviewsInPeriodProducesSafeZeroSentiment() {
  const reviews = [makeReview({ review_date: '2020-01-01' })]
  const filtered = filterReviews(reviews, { start: '2026-08-15', end: '2026-08-22' })
  assert(filtered.length === 0)
  const sent = getSentiment(filtered)
  assert(sent.n === 0 && sent.positive === 0 && sent.neutral === 0 && sent.bad === 0)
}

function main() {
  run('ai_sentiment takes priority over the star-rating fallback', testAiSentimentTakesPriorityOverStars)
  run('star-rating fallback buckets correctly at every rating', testStarFallbackWhenNoAiSentiment)
  run('an invalid ai_sentiment value falls back to the star rating, not trusted verbatim', testInvalidAiSentimentValueFallsBackToStars)
  run('null when neither ai_sentiment nor star_rating exist (unclassified)', testNullWhenNeitherAiSentimentNorStarRating)
  run('an empty review array is a safe zero, never NaN/divide-by-zero', testEmptyArrayIsSafeZero)
  run('counts and percentages reconcile exactly with the total', testCountsAndPercentagesReconcileWithTotal)
  run('percentage denominator is all filtered reviews, not just classified ones', testPercentageDenominatorIsAllFilteredReviewsNotJustClassified)
  run('no duplicate counting for a single review object', testNoDuplicateCountingWhenSameReviewObjectAppearsOnce)
  run('date range filtering is inclusive on both the start and end boundary', testDateRangeInclusiveBothEnds)
  run('a single-day range works correctly', testSingleDayRange)
  run('an empty/non-matching period returns [] rather than throwing', testEmptyPeriodReturnsEmptyArrayNotError)
  run('omitting start/end filters nothing out by date (All time)', testNoStartEndMeansAllTime)
  run('location filter correctly scopes to the selected location', testLocationFilterScoping)
  run('an empty locations array (All Locations) filters nothing out', testAllLocationsMeansNoLocationFilterApplied)
  run('brand filter correctly scopes to every location under that brand', testBrandFilterScoping)
  run('sentiment counts reconcile with the filtered total across All Locations', testSentimentReconcilesWithFilteredTotalAcrossAllLocations)
  run('sentiment counts reconcile with the filtered total for a single selected location', testSentimentReconcilesForASingleSelectedLocation)
  run('zero reviews in the selected period produces safe zero sentiment values', testZeroReviewsInPeriodProducesSafeZeroSentiment)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
