// Regression tests for dashboard/src/utils/replyState.js's computeReplyState()/
// isAnsweredReplyState() (Recovery Milestone 6B, Part 3/11). Proves the
// priority order a stale browser-local workspace status can never override
// Google's own owner_response or the durable publish bridge -- the exact
// production bug Milestone 6A's diagnostic found (a successfully-published
// reply reappearing as Needs Reply once its one-browser-only workspace
// record was unavailable).
//
// Run directly: node tests/test_reply_state.js

import { computeReplyState, isAnsweredReplyState, isActionableReplyState, computeReplyStateCounts } from '../dashboard/src/utils/replyState.js'

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

const R_ANSWERED = { owner_response: 'Thank you for the kind words!' }
const R_UNANSWERED = { owner_response: '' }
const BRIDGE = { status: 'pending_google_reconciliation', responseText: 'Thanks!' }

function testNoOwnerResponseNoBridgeNoWsIsNeedsReply() {
  assert(computeReplyState(R_UNANSWERED, undefined, undefined) === 'needs_reply')
}

function testOwnerResponseAloneIsExternallyReplied() {
  assert(computeReplyState(R_ANSWERED, undefined, undefined) === 'externally_replied',
    'owner_response with no bridge means this app never recorded publishing it')
}

function testOwnerResponsePlusBridgeIsConfirmed() {
  assert(computeReplyState(R_ANSWERED, undefined, BRIDGE) === 'confirmed',
    'owner_response + a live bridge means THIS app published it -- Confirmed, not Externally Replied')
}

function testBridgeAloneNoOwnerResponseYetIsConfirmed() {
  assert(computeReplyState(R_UNANSWERED, undefined, BRIDGE) === 'confirmed',
    'a durable bridge is sufficient on its own -- Google hasn\'t synced back yet, but the publish already succeeded')
}

function testOwnerResponsePlusStaleFailedWorkspaceIsConfirmed() {
  const wsEntry = { status: 'failed' }
  assert(computeReplyState(R_ANSWERED, wsEntry, undefined) === 'externally_replied',
    'owner_response must win over a stale failed workspace status even with no bridge')
}

function testOwnerResponsePlusStaleDraftWorkspaceIsConfirmed() {
  const wsEntry = { status: 'draft_ready' }
  assert(computeReplyState(R_ANSWERED, wsEntry, undefined) === 'externally_replied',
    'owner_response must win over a stale draft workspace status')
}

function testBridgePlusStaleDraftWorkspaceIsConfirmed() {
  const wsEntry = { status: 'draft_ready' }
  assert(computeReplyState(R_UNANSWERED, wsEntry, BRIDGE) === 'confirmed',
    'a live bridge must win over a stale draft workspace status')
}

function testBridgePlusStaleFailedWorkspaceIsConfirmed() {
  const wsEntry = { status: 'failed' }
  assert(computeReplyState(R_UNANSWERED, wsEntry, BRIDGE) === 'confirmed',
    'a live bridge must win over a stale failed workspace status -- this is the exact production bug scenario: ' +
    'this browser retried and got a stale failure recorded locally, but the review was already answered')
}

function testWorkspacePublishedFallbackStillWorksWithNoBridge() {
  const wsEntry = { status: 'published' }
  assert(computeReplyState(R_UNANSWERED, wsEntry, undefined) === 'confirmed',
    'same-browser wsEntry.status===published must still work as a fallback when no bridge is available (e.g. Redis degraded)')
}

function testFailedWorkspaceWithNoAuthoritativeSignalIsFailed() {
  const wsEntry = { status: 'failed' }
  assert(computeReplyState(R_UNANSWERED, wsEntry, undefined) === 'failed',
    'with no owner_response and no bridge, a genuinely failed publish must still show as failed')
}

function testDraftWorkspaceWithNoAuthoritativeSignalIsDraft() {
  const wsEntry = { status: 'draft_ready' }
  assert(computeReplyState(R_UNANSWERED, wsEntry, undefined) === 'draft')
}

// isAnsweredReplyState -- the AI-generation exclusion gate (Part 9)
function testIsAnsweredViaOwnerResponse() {
  assert(isAnsweredReplyState(R_ANSWERED, undefined, undefined) === true)
}
function testIsAnsweredViaBridge() {
  assert(isAnsweredReplyState(R_UNANSWERED, undefined, BRIDGE) === true)
}
function testIsAnsweredViaWorkspacePublished() {
  assert(isAnsweredReplyState(R_UNANSWERED, { status: 'published' }, undefined) === true)
}
function testIsNotAnsweredWhenOnlyDraftOrFailed() {
  assert(isAnsweredReplyState(R_UNANSWERED, { status: 'draft_ready' }, undefined) === false)
  assert(isAnsweredReplyState(R_UNANSWERED, { status: 'failed' }, undefined) === false)
  assert(isAnsweredReplyState(R_UNANSWERED, undefined, undefined) === false)
}

// isActionableReplyState -- confirms answered states never count as actionable
function testConfirmedAndExternallyRepliedAreNotActionable() {
  assert(isActionableReplyState('confirmed') === false)
  assert(isActionableReplyState('externally_replied') === false)
}
function testNeedsReplyDraftFailedAreActionable() {
  assert(isActionableReplyState('needs_reply') === true)
  assert(isActionableReplyState('draft') === true)
  assert(isActionableReplyState('failed') === true)
}

// computeReplyStateCounts -- Filtering UX Cleanup: per-status counts for
// Reviews.jsx's pill row, computed over whatever "in scope" set the caller
// passes in (Reviews.jsx passes the globally-filtered dataset).
function testComputeReplyStateCountsBasicBreakdown() {
  const reviews = [
    { review_id: 'r1', owner_response: '' },
    { review_id: 'r2', owner_response: '' },
    { review_id: 'r3', owner_response: 'Thanks!' },
  ]
  const ws = { r2: { status: 'draft_ready' } }
  const counts = computeReplyStateCounts(reviews, ws, {})
  assert(counts.needs_reply === 1)
  assert(counts.draft === 1)
  assert(counts.externally_replied === 1)
  assert(counts.confirmed === 0 && counts.failed === 0)
}

function testComputeReplyStateCountsNeverLosesOrDuplicatesAReview() {
  const reviews = [
    { review_id: 'a', owner_response: '' },
    { review_id: 'b', owner_response: '', },
  ]
  const ws = { b: { status: 'failed' } }
  const counts = computeReplyStateCounts(reviews, ws, {})
  const total = counts.needs_reply + counts.draft + counts.confirmed + counts.failed + counts.externally_replied
  assert(total === reviews.length, `every review must be counted exactly once, expected ${reviews.length} got ${total}`)
}

function testComputeReplyStateCountsHandlesMissingWsAndBridgesGracefully() {
  const reviews = [{ review_id: 'a', owner_response: '' }]
  assert(computeReplyStateCounts(reviews, undefined, undefined).needs_reply === 1, 'must not throw when ws/bridges are undefined')
}

function testComputeReplyStateCountsOnEmptyInputReturnsAllZeros() {
  const counts = computeReplyStateCounts([], {}, {})
  assert(Object.values(counts).every(n => n === 0))
}

function testComputeReplyStateCountsUsesCanonicalReviewIdForLookup() {
  // A review with no review_id/review_url must still resolve its ws/bridge
  // entry via the same date+reviewer-name fallback reviewId() uses
  // elsewhere -- not silently miss its workspace state.
  const reviews = [{ review_date: '2026-08-20', reviewer_name: 'Alpha', owner_response: '' }]
  const ws = { '2026-08-20-Alpha': { status: 'draft_ready' } }
  assert(computeReplyStateCounts(reviews, ws, {}).draft === 1)
}

function main() {
  run('no owner_response, no bridge, no workspace -> needs_reply', testNoOwnerResponseNoBridgeNoWsIsNeedsReply)
  run('owner_response alone -> externally_replied', testOwnerResponseAloneIsExternallyReplied)
  run('owner_response + bridge -> confirmed (this app published it)', testOwnerResponsePlusBridgeIsConfirmed)
  run('bridge alone, no owner_response yet -> confirmed', testBridgeAloneNoOwnerResponseYetIsConfirmed)
  run('owner_response + stale failed workspace -> completed, not failed', testOwnerResponsePlusStaleFailedWorkspaceIsConfirmed)
  run('owner_response + stale draft workspace -> completed, not draft', testOwnerResponsePlusStaleDraftWorkspaceIsConfirmed)
  run('bridge + stale draft workspace -> completed, not draft', testBridgePlusStaleDraftWorkspaceIsConfirmed)
  run('bridge + stale failed workspace -> completed, not failed (the production bug scenario)', testBridgePlusStaleFailedWorkspaceIsConfirmed)
  run('workspace published fallback still works with no bridge available', testWorkspacePublishedFallbackStillWorksWithNoBridge)
  run('failed workspace with no authoritative signal -> failed', testFailedWorkspaceWithNoAuthoritativeSignalIsFailed)
  run('draft workspace with no authoritative signal -> draft', testDraftWorkspaceWithNoAuthoritativeSignalIsDraft)
  run('isAnsweredReplyState: true via owner_response', testIsAnsweredViaOwnerResponse)
  run('isAnsweredReplyState: true via bridge', testIsAnsweredViaBridge)
  run('isAnsweredReplyState: true via workspace published', testIsAnsweredViaWorkspacePublished)
  run('isAnsweredReplyState: false for draft/failed/nothing', testIsNotAnsweredWhenOnlyDraftOrFailed)
  run('confirmed/externally_replied are never actionable', testConfirmedAndExternallyRepliedAreNotActionable)
  run('needs_reply/draft/failed are actionable', testNeedsReplyDraftFailedAreActionable)
  run('computeReplyStateCounts: basic breakdown across needs_reply/draft/externally_replied', testComputeReplyStateCountsBasicBreakdown)
  run('computeReplyStateCounts: never loses or duplicates a review', testComputeReplyStateCountsNeverLosesOrDuplicatesAReview)
  run('computeReplyStateCounts: handles missing ws/bridges gracefully', testComputeReplyStateCountsHandlesMissingWsAndBridgesGracefully)
  run('computeReplyStateCounts: empty input returns all zeros', testComputeReplyStateCountsOnEmptyInputReturnsAllZeros)
  run('computeReplyStateCounts: uses the canonical reviewId() fallback for lookup', testComputeReplyStateCountsUsesCanonicalReviewIdForLookup)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
