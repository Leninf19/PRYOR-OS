// Review Media Feature -- Scale & No-Backfill Audit (Phase 10). Pure-logic
// tests for dashboard/src/utils/reviewMediaGallery.js -- the framework-free
// module ReviewMediaGallery.jsx builds on. This project has no
// React-rendering test harness (no jsdom/@testing-library dependency), so
// these tests cover every piece of logic that CAN be tested without
// rendering a component: URL safety re-validation, item filtering,
// thumbnail-layout/+N computation, and the swipe/arrow-key navigation
// decision functions. Behaviors that genuinely require a rendered DOM
// (actual Escape-key dialog removal, actual focus restoration, actual
// disabled-button rendering) are NOT claimed as tested here -- see the
// final report's own note on this gap.
//
// Run directly: node tests/test_review_media_gallery.js

import {
  isSafeHttpsUrl, usableItems, computeThumbnailLayout, countByType,
  computeSwipeTarget, computeArrowKeyTarget, MAX_VISIBLE_THUMBNAILS,
} from '../dashboard/src/utils/reviewMediaGallery.js'

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

// --- isSafeHttpsUrl ----------------------------------------------------------

function testHttpsUrlAccepted() {
  assert(isSafeHttpsUrl('https://lh3.googleusercontent.com/p1') === true)
}

function testHttpUrlRejected() {
  assert(isSafeHttpsUrl('http://lh3.googleusercontent.com/p1') === false)
}

function testJavascriptSchemeRejected() {
  assert(isSafeHttpsUrl('javascript:alert(1)') === false)
}

function testDataSchemeRejected() {
  assert(isSafeHttpsUrl('data:image/png;base64,AAAA') === false)
}

function testMalformedUrlRejected() {
  assert(isSafeHttpsUrl('not a url') === false)
}

function testNonStringRejected() {
  assert(isSafeHttpsUrl(null) === false)
  assert(isSafeHttpsUrl(undefined) === false)
  assert(isSafeHttpsUrl(42) === false)
}

// --- usableItems (no-media / one photo / broken thumbnail / unsafe URL) -----

function testNoMediaReview() {
  assert(usableItems(undefined).length === 0)
  assert(usableItems(null).length === 0)
  assert(usableItems([]).length === 0)
}

function testOnePhoto() {
  const out = usableItems([{ type: 'photo', thumbnailUrl: 'https://lh3.googleusercontent.com/p1', thumbnailLabel: 'Tacos' }])
  assert(out.length === 1)
  assert(out[0].type === 'photo')
  assert(out[0].thumbnailLabel === 'Tacos')
}

function testItemWithUnsafeThumbnailDropped() {
  const out = usableItems([{ type: 'photo', thumbnailUrl: 'javascript:alert(1)' }])
  assert(out.length === 0, 'an item with an unsafe thumbnail must be dropped entirely, never rendered as broken')
}

function testVideoTypeOnlyWithSafeVideoUrl() {
  const withUnsafeVideo = usableItems([{ type: 'video', thumbnailUrl: 'https://lh3.googleusercontent.com/t1', videoUrl: 'http://insecure.example.com/v1' }])
  assert(withUnsafeVideo[0].type === 'photo', 're-derives type from a SAFE videoUrl only -- never trusts the backend-claimed type verbatim')
  assert(withUnsafeVideo[0].videoUrl === null)

  const withSafeVideo = usableItems([{ type: 'video', thumbnailUrl: 'https://lh3.googleusercontent.com/t1', videoUrl: 'https://lh3.googleusercontent.com/v1' }])
  assert(withSafeVideo[0].type === 'video')
}

function testMalformedItemsIgnored() {
  const out = usableItems(['not-an-object', 42, null, {}])
  assert(out.length === 0)
}

// --- computeThumbnailLayout (five thumbnails / +N behavior) ------------------

function testFiveOrFewerItemsNoOverflow() {
  const items = usableItems(Array.from({ length: 5 }, (_, i) => ({ thumbnailUrl: `https://lh3.googleusercontent.com/p${i}` })))
  const { visible, overflowCount } = computeThumbnailLayout(items)
  assert(visible.length === 5)
  assert(overflowCount === 0)
}

function testMoreThanFiveItemsShowsOverflowCount() {
  const items = usableItems(Array.from({ length: 8 }, (_, i) => ({ thumbnailUrl: `https://lh3.googleusercontent.com/p${i}` })))
  const { visible, overflowCount } = computeThumbnailLayout(items)
  assert(visible.length === MAX_VISIBLE_THUMBNAILS)
  assert(overflowCount === 3, `expected +3 overflow, got ${overflowCount}`)
}

function testCountByType() {
  const items = usableItems([
    { type: 'photo', thumbnailUrl: 'https://lh3.googleusercontent.com/p1' },
    { type: 'video', thumbnailUrl: 'https://lh3.googleusercontent.com/t2', videoUrl: 'https://lh3.googleusercontent.com/v2' },
  ])
  const { photoCount, videoCount } = countByType(items)
  assert(photoCount === 1 && videoCount === 1)
}

// --- computeArrowKeyTarget (keyboard navigation) -----------------------------

function testArrowRightAdvances() {
  assert(computeArrowKeyTarget('ArrowRight', 0, 3) === 1)
}

function testArrowLeftRetreats() {
  assert(computeArrowKeyTarget('ArrowLeft', 1, 3) === 0)
}

function testArrowLeftAtStartDoesNothing() {
  assert(computeArrowKeyTarget('ArrowLeft', 0, 3) === null, 'must clamp, never wrap, at the first item')
}

function testArrowRightAtEndDoesNothing() {
  assert(computeArrowKeyTarget('ArrowRight', 2, 3) === null, 'must clamp, never wrap, at the last item')
}

function testOtherKeysIgnored() {
  assert(computeArrowKeyTarget('Enter', 1, 3) === null)
}

// --- computeSwipeTarget (mobile/swipe behavior) ------------------------------

function testSwipeLeftPastDistanceThresholdAdvances() {
  assert(computeSwipeTarget(0, 3, -80, 0) === 1)
}

function testSwipeRightPastDistanceThresholdRetreats() {
  assert(computeSwipeTarget(1, 3, 80, 0) === 0)
}

function testSwipePastVelocityThresholdAdvancesEvenWithSmallOffset() {
  assert(computeSwipeTarget(0, 3, -5, -500) === 1)
}

function testSwipeBelowThresholdDoesNothing() {
  assert(computeSwipeTarget(0, 3, -10, -50) === null)
}

function testSwipeAtBoundaryClamped() {
  assert(computeSwipeTarget(0, 3, 200, 0) === null, 'swiping right at the first item must not go negative')
  assert(computeSwipeTarget(2, 3, -200, 0) === null, 'swiping left at the last item must not overflow')
}

async function main() {
  const tests = [
    ['https:// URL accepted', testHttpsUrlAccepted],
    ['http:// URL rejected', testHttpUrlRejected],
    ['javascript: scheme rejected', testJavascriptSchemeRejected],
    ['data: scheme rejected', testDataSchemeRejected],
    ['malformed URL rejected', testMalformedUrlRejected],
    ['non-string input rejected', testNonStringRejected],
    ['no-media review -> empty gallery', testNoMediaReview],
    ['one photo', testOnePhoto],
    ['item with unsafe thumbnail dropped (never rendered broken)', testItemWithUnsafeThumbnailDropped],
    ['video type only with a safe videoUrl', testVideoTypeOnlyWithSafeVideoUrl],
    ['malformed items ignored', testMalformedItemsIgnored],
    ['five or fewer items -> no overflow', testFiveOrFewerItemsNoOverflow],
    ['more than five items -> +N overflow count', testMoreThanFiveItemsShowsOverflowCount],
    ['countByType splits photos/videos', testCountByType],
    ['ArrowRight advances', testArrowRightAdvances],
    ['ArrowLeft retreats', testArrowLeftRetreats],
    ['ArrowLeft at the start does nothing (no wrap)', testArrowLeftAtStartDoesNothing],
    ['ArrowRight at the end does nothing (no wrap)', testArrowRightAtEndDoesNothing],
    ['other keys ignored', testOtherKeysIgnored],
    ['swipe left past distance threshold advances', testSwipeLeftPastDistanceThresholdAdvances],
    ['swipe right past distance threshold retreats', testSwipeRightPastDistanceThresholdRetreats],
    ['swipe past velocity threshold advances even with small offset', testSwipePastVelocityThresholdAdvancesEvenWithSmallOffset],
    ['swipe below both thresholds does nothing', testSwipeBelowThresholdDoesNothing],
    ['swipe at either boundary is clamped', testSwipeAtBoundaryClamped],
  ]
  for (const [name, fn] of tests) run(name, fn)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exitCode = 0
  } else {
    console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
    process.exitCode = 1
  }
}

main()
