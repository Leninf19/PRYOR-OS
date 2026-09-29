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
  canDownloadItem, buildMediaDownloadUrl,
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

// --- usableItems sortOrder preservation (Review Media View/Download feature) --
// The download endpoint (dashboard/api/actions/[action].js's download-media
// action) indexes directly into the review's own server-side `media` array
// by position -- usableItems() must expose each surviving item's ORIGINAL
// array index (before filtering), never a re-numbered post-filter position,
// so the View/Download controls always reference the correct item even
// when an earlier item was dropped.

function testSortOrderMatchesOriginalArrayIndex() {
  const out = usableItems([
    { type: 'photo', thumbnailUrl: 'https://lh3.googleusercontent.com/p0' },
    { type: 'photo', thumbnailUrl: 'https://lh3.googleusercontent.com/p1' },
    { type: 'photo', thumbnailUrl: 'https://lh3.googleusercontent.com/p2' },
  ])
  assert(out.map(i => i.sortOrder).join(',') === '0,1,2', `expected sortOrder 0,1,2, got ${out.map(i => i.sortOrder).join(',')}`)
}

function testSortOrderSkipsDroppedItemsOriginalIndex() {
  // The middle item (original index 1) has an unsafe thumbnail and is
  // dropped -- the surviving items must keep THEIR OWN original indices
  // (0 and 2), never be renumbered to 0 and 1.
  const out = usableItems([
    { type: 'photo', thumbnailUrl: 'https://lh3.googleusercontent.com/p0' },
    { type: 'photo', thumbnailUrl: 'javascript:alert(1)' },
    { type: 'photo', thumbnailUrl: 'https://lh3.googleusercontent.com/p2' },
  ])
  assert(out.length === 2, `expected 2 surviving items, got ${out.length}`)
  assert(out[0].sortOrder === 0, `first surviving item must keep original index 0, got ${out[0].sortOrder}`)
  assert(out[1].sortOrder === 2, `second surviving item must keep original index 2 (not renumbered to 1), got ${out[1].sortOrder}`)
}

function testSortOrderIgnoresRawItemsOwnSortOrderField() {
  // Even if the raw item carries its own (possibly stale/wrong) sortOrder
  // field, usableItems() must derive sortOrder from the ARRAY POSITION it
  // was actually received at, never trust the raw field verbatim.
  const out = usableItems([
    { type: 'photo', thumbnailUrl: 'https://lh3.googleusercontent.com/p0', sortOrder: 99 },
  ])
  assert(out[0].sortOrder === 0, `must derive sortOrder from array position (0), not the raw item's own field (99), got ${out[0].sortOrder}`)
}

// --- canDownloadItem / buildMediaDownloadUrl (Review Media View/Download feature) --

function testCanDownloadItemTrueForPhoto() {
  assert(canDownloadItem({ type: 'photo' }) === true)
}

function testCanDownloadItemFalseForVideo() {
  assert(canDownloadItem({ type: 'video' }) === false, 'video items must never offer a Download control -- View/Open only')
}

function testCanDownloadItemFalseForMissingItem() {
  assert(canDownloadItem(null) === false)
  assert(canDownloadItem(undefined) === false)
}

function testBuildMediaDownloadUrlHappyPath() {
  const url = buildMediaDownloadUrl('abc123', 2)
  assert(url === '/api/actions/download-media?reviewId=abc123&index=2', `unexpected url: ${url}`)
}

function testBuildMediaDownloadUrlEncodesReviewId() {
  // A review id can be a review_url or a `${date}-${name}` fallback --
  // either can contain characters that must be percent-encoded in a query
  // string (e.g. '/', '&', spaces).
  const url = buildMediaDownloadUrl('https://google.com/review?id=1&x=2', 0)
  assert(url === `/api/actions/download-media?reviewId=${encodeURIComponent('https://google.com/review?id=1&x=2')}&index=0`, `unexpected url: ${url}`)
  assert(!url.includes('&x=2'), 'an unencoded "&" from the reviewId must never inject a second query param')
}

function testBuildMediaDownloadUrlRejectsMissingReviewId() {
  assert(buildMediaDownloadUrl('', 0) === null)
  assert(buildMediaDownloadUrl(null, 0) === null)
  assert(buildMediaDownloadUrl(undefined, 0) === null)
}

function testBuildMediaDownloadUrlRejectsInvalidIndex() {
  assert(buildMediaDownloadUrl('abc123', -1) === null, 'a negative index must never be sent')
  assert(buildMediaDownloadUrl('abc123', 1.5) === null, 'a non-integer index must never be sent')
  assert(buildMediaDownloadUrl('abc123', NaN) === null)
  assert(buildMediaDownloadUrl('abc123', null) === null)
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
    ['usableItems: sortOrder matches original array index', testSortOrderMatchesOriginalArrayIndex],
    ['usableItems: sortOrder skips dropped items\' original index (never renumbered)', testSortOrderSkipsDroppedItemsOriginalIndex],
    ['usableItems: sortOrder derived from array position, never the raw item\'s own field', testSortOrderIgnoresRawItemsOwnSortOrderField],
    ['canDownloadItem: true for a photo', testCanDownloadItemTrueForPhoto],
    ['canDownloadItem: false for a video (View/Open only)', testCanDownloadItemFalseForVideo],
    ['canDownloadItem: false for a missing item', testCanDownloadItemFalseForMissingItem],
    ['buildMediaDownloadUrl: happy path', testBuildMediaDownloadUrlHappyPath],
    ['buildMediaDownloadUrl: encodes the reviewId', testBuildMediaDownloadUrlEncodesReviewId],
    ['buildMediaDownloadUrl: rejects a missing reviewId', testBuildMediaDownloadUrlRejectsMissingReviewId],
    ['buildMediaDownloadUrl: rejects an invalid index', testBuildMediaDownloadUrlRejectsInvalidIndex],
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
