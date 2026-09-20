// Regression tests for dashboard/src/utils/replyState.js's computeReplyState()/
// isAnsweredReplyState()/isActionableReplyState()/computeReplyStateCounts().
//
// Extended by the Google Reply Moderation State fix (audit: Casa Tequila
// Brighton / reviewer "Terry", local review id 35738 -- a reply that showed
// "Confirmed" in PRYOR while missing from the public Google listing). The
// core regression this file now proves: a publish-bridge record's mere
// EXISTENCE, and a browser localStorage 'published' status ALONE, must
// never again produce an approved/confirmed state -- only Google's own
// reviewReplyState (carried on the bridge record's moderationState field)
// can do that. A legacy bridge record (written before this fix, with no
// moderationState field at all) must resolve safely to SENT_TO_GOOGLE, never
// crash and never be silently treated as approved.
//
// Run directly: node tests/test_reply_state.js

import {
  computeReplyState, isAnsweredReplyState, isActionableReplyState, computeReplyStateCounts,
  resolveBridgeModerationState, ModerationState,
} from '../dashboard/src/utils/replyState.js'

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

// A LEGACY bridge record -- exactly the shape writePublishBridge() produced
// before the Google Reply Moderation State fix, with no moderationState
// field at all. Every test using this fixture is a backward-compatibility
// proof, not just a "bridge exists" proof.
const LEGACY_BRIDGE = { status: 'pending_google_reconciliation', responseText: 'Thanks!' }

function bridgeWith(moderationState, extra = {}) {
  return { status: 'pending_google_reconciliation', responseText: 'Thanks!', moderationState, ...extra }
}

// --- computeReplyState: base cases (unchanged behavior) --------------------

function testNoOwnerResponseNoBridgeNoWsIsNeedsReply() {
  assert(computeReplyState(R_UNANSWERED, undefined, undefined) === 'needs_reply')
}

function testOwnerResponseAloneIsExternallyReplied() {
  assert(computeReplyState(R_ANSWERED, undefined, undefined) === ModerationState.EXTERNALLY_REPLIED,
    'owner_response with no bridge means this app never recorded publishing it')
}

function testOwnerResponsePlusBridgeIsApproved() {
  assert(computeReplyState(R_ANSWERED, undefined, LEGACY_BRIDGE) === ModerationState.APPROVED,
    'owner_response + a live bridge means THIS app published it and Google is now serving it back -- Approved, not Externally Replied')
}

function testFailedWorkspaceWithNoAuthoritativeSignalIsFailed() {
  const wsEntry = { status: 'failed' }
  assert(computeReplyState(R_UNANSWERED, wsEntry, undefined) === 'failed')
}

function testDraftWorkspaceWithNoAuthoritativeSignalIsDraft() {
  const wsEntry = { status: 'draft_ready' }
  assert(computeReplyState(R_UNANSWERED, wsEntry, undefined) === 'draft')
}

// --- Root-cause regression: bridge existence/localStorage alone is NEVER
// approved/confirmed anymore ---------------------------------------------

function testLegacyBridgeAloneIsSentToGoogleNeverApproved() {
  const state = computeReplyState(R_UNANSWERED, undefined, LEGACY_BRIDGE)
  assert(state === ModerationState.SENT_TO_GOOGLE,
    `a legacy bridge record with no moderationState must resolve to SENT_TO_GOOGLE, never an approved/confirmed state -- got ${state}`)
}

function testWorkspacePublishedAloneIsSentToGoogleNeverApproved() {
  const wsEntry = { status: 'published' }
  const state = computeReplyState(R_UNANSWERED, wsEntry, undefined)
  assert(state === ModerationState.SENT_TO_GOOGLE,
    `localStorage 'published' alone must never establish canonical confirmation -- got ${state}`)
}

function testLegacyBridgeWinsOverStaleFailedWorkspace() {
  const wsEntry = { status: 'failed' }
  assert(computeReplyState(R_UNANSWERED, wsEntry, LEGACY_BRIDGE) === ModerationState.SENT_TO_GOOGLE,
    'a live bridge must still win over a stale failed workspace status, resolving to its own (legacy) state')
}

function testLegacyBridgeWinsOverStaleDraftWorkspace() {
  const wsEntry = { status: 'draft_ready' }
  assert(computeReplyState(R_UNANSWERED, wsEntry, LEGACY_BRIDGE) === ModerationState.SENT_TO_GOOGLE)
}

// --- New granular moderation states -----------------------------------------

function testBridgeWithPendingApprovalState() {
  assert(computeReplyState(R_UNANSWERED, undefined, bridgeWith(ModerationState.PENDING_APPROVAL)) === ModerationState.PENDING_APPROVAL)
}

function testBridgeWithApprovedState() {
  assert(computeReplyState(R_UNANSWERED, undefined, bridgeWith(ModerationState.APPROVED)) === ModerationState.APPROVED)
}

function testBridgeWithRejectedState() {
  assert(computeReplyState(R_UNANSWERED, undefined, bridgeWith(ModerationState.REJECTED)) === ModerationState.REJECTED)
}

function testBridgeWithVerificationDelayedState() {
  assert(computeReplyState(R_UNANSWERED, undefined, bridgeWith(ModerationState.VERIFICATION_DELAYED)) === ModerationState.VERIFICATION_DELAYED)
}

function testBridgeWithUnknownFutureStateFallsBackToSentToGoogle() {
  const state = computeReplyState(R_UNANSWERED, undefined, bridgeWith('some_future_state_this_code_has_never_seen'))
  assert(state === ModerationState.SENT_TO_GOOGLE, `an unrecognized future moderationState must fall back safely -- got ${state}`)
}

function testResolveBridgeModerationStateDirectly() {
  assert(resolveBridgeModerationState(null) === null)
  assert(resolveBridgeModerationState(LEGACY_BRIDGE) === ModerationState.SENT_TO_GOOGLE)
  assert(resolveBridgeModerationState(bridgeWith(ModerationState.REJECTED)) === ModerationState.REJECTED)
  assert(resolveBridgeModerationState(bridgeWith('garbage')) === ModerationState.SENT_TO_GOOGLE)
}

// --- isAnsweredReplyState (Part 9) -- revised gating ------------------------

function testIsAnsweredViaOwnerResponse() {
  assert(isAnsweredReplyState(R_ANSWERED, undefined, undefined) === true)
}
function testIsAnsweredViaLegacyBridge() {
  assert(isAnsweredReplyState(R_UNANSWERED, undefined, LEGACY_BRIDGE) === true)
}
function testIsAnsweredViaPendingBridge() {
  assert(isAnsweredReplyState(R_UNANSWERED, undefined, bridgeWith(ModerationState.PENDING_APPROVAL)) === true,
    'a pending reply must still block auto-draft generation -- never invite a duplicate publish while in flight')
}
function testIsAnsweredViaApprovedBridge() {
  assert(isAnsweredReplyState(R_UNANSWERED, undefined, bridgeWith(ModerationState.APPROVED)) === true)
}
function testIsAnsweredViaVerificationDelayedBridge() {
  assert(isAnsweredReplyState(R_UNANSWERED, undefined, bridgeWith(ModerationState.VERIFICATION_DELAYED)) === true,
    'an inconclusive verification must still block a duplicate publish attempt')
}
function testIsNotAnsweredWhenRejected() {
  assert(isAnsweredReplyState(R_UNANSWERED, undefined, bridgeWith(ModerationState.REJECTED)) === false,
    'a REJECTED reply is genuinely unanswered -- Google will never make it public, so the review must re-open for a new reply')
}
function testIsAnsweredViaWorkspacePublished() {
  assert(isAnsweredReplyState(R_UNANSWERED, { status: 'published' }, undefined) === true)
}
function testIsNotAnsweredWhenOnlyDraftOrFailed() {
  assert(isAnsweredReplyState(R_UNANSWERED, { status: 'draft_ready' }, undefined) === false)
  assert(isAnsweredReplyState(R_UNANSWERED, { status: 'failed' }, undefined) === false)
  assert(isAnsweredReplyState(R_UNANSWERED, undefined, undefined) === false)
}

// --- isActionableReplyState --------------------------------------------------

function testResolvedStatesAreNotActionable() {
  assert(isActionableReplyState(ModerationState.APPROVED) === false)
  assert(isActionableReplyState(ModerationState.EXTERNALLY_REPLIED) === false)
  assert(isActionableReplyState(ModerationState.SENT_TO_GOOGLE) === false)
  assert(isActionableReplyState(ModerationState.PENDING_APPROVAL) === false)
  assert(isActionableReplyState(ModerationState.VERIFICATION_DELAYED) === false)
}
function testNeedsReplyDraftFailedAreActionable() {
  assert(isActionableReplyState('needs_reply') === true)
  assert(isActionableReplyState('draft') === true)
  assert(isActionableReplyState('failed') === true)
}
function testRejectedIsActionable() {
  assert(isActionableReplyState(ModerationState.REJECTED) === true,
    'a rejected reply genuinely needs a manager\'s attention -- it must show up in the working queue like needs_reply')
}

// --- computeReplyStateCounts -------------------------------------------------

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
  assert(counts[ModerationState.EXTERNALLY_REPLIED] === 1)
  assert(counts[ModerationState.APPROVED] === 0 && counts.failed === 0)
}

function testComputeReplyStateCountsCoversGranularModerationStates() {
  const reviews = [
    { review_id: 'p1', owner_response: '' },
    { review_id: 'p2', owner_response: '' },
    { review_id: 'p3', owner_response: '' },
  ]
  const bridges = {
    p1: bridgeWith(ModerationState.PENDING_APPROVAL),
    p2: bridgeWith(ModerationState.REJECTED),
    p3: bridgeWith(ModerationState.VERIFICATION_DELAYED),
  }
  const counts = computeReplyStateCounts(reviews, {}, bridges)
  assert(counts[ModerationState.PENDING_APPROVAL] === 1)
  assert(counts[ModerationState.REJECTED] === 1)
  assert(counts[ModerationState.VERIFICATION_DELAYED] === 1)
}

function testComputeReplyStateCountsNeverLosesOrDuplicatesAReview() {
  const reviews = [
    { review_id: 'a', owner_response: '' },
    { review_id: 'b', owner_response: '' },
  ]
  const ws = { b: { status: 'failed' } }
  const counts = computeReplyStateCounts(reviews, ws, {})
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
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
  const reviews = [{ review_date: '2026-08-20', reviewer_name: 'Alpha', owner_response: '' }]
  const ws = { '2026-08-20-Alpha': { status: 'draft_ready' } }
  assert(computeReplyStateCounts(reviews, ws, {}).draft === 1)
}

function main() {
  run('no owner_response, no bridge, no workspace -> needs_reply', testNoOwnerResponseNoBridgeNoWsIsNeedsReply)
  run('owner_response alone -> externally_replied', testOwnerResponseAloneIsExternallyReplied)
  run('owner_response + bridge -> approved_by_google', testOwnerResponsePlusBridgeIsApproved)
  run('failed workspace with no authoritative signal -> failed', testFailedWorkspaceWithNoAuthoritativeSignalIsFailed)
  run('draft workspace with no authoritative signal -> draft', testDraftWorkspaceWithNoAuthoritativeSignalIsDraft)
  run('ROOT CAUSE: a legacy bridge record alone -> sent_to_google, never approved', testLegacyBridgeAloneIsSentToGoogleNeverApproved)
  run('ROOT CAUSE: localStorage published alone -> sent_to_google, never approved', testWorkspacePublishedAloneIsSentToGoogleNeverApproved)
  run('legacy bridge wins over a stale failed workspace, resolves to its own state', testLegacyBridgeWinsOverStaleFailedWorkspace)
  run('legacy bridge wins over a stale draft workspace, resolves to its own state', testLegacyBridgeWinsOverStaleDraftWorkspace)
  run('bridge with PENDING_APPROVAL moderationState', testBridgeWithPendingApprovalState)
  run('bridge with APPROVED moderationState', testBridgeWithApprovedState)
  run('bridge with REJECTED moderationState', testBridgeWithRejectedState)
  run('bridge with VERIFICATION_DELAYED moderationState', testBridgeWithVerificationDelayedState)
  run('bridge with an unrecognized future moderationState falls back to sent_to_google', testBridgeWithUnknownFutureStateFallsBackToSentToGoogle)
  run('resolveBridgeModerationState direct unit coverage', testResolveBridgeModerationStateDirectly)
  run('isAnsweredReplyState: true via owner_response', testIsAnsweredViaOwnerResponse)
  run('isAnsweredReplyState: true via legacy bridge', testIsAnsweredViaLegacyBridge)
  run('isAnsweredReplyState: true via pending bridge (no duplicate publish while in flight)', testIsAnsweredViaPendingBridge)
  run('isAnsweredReplyState: true via approved bridge', testIsAnsweredViaApprovedBridge)
  run('isAnsweredReplyState: true via verification-delayed bridge', testIsAnsweredViaVerificationDelayedBridge)
  run('isAnsweredReplyState: FALSE via rejected bridge (must re-open for a new reply)', testIsNotAnsweredWhenRejected)
  run('isAnsweredReplyState: true via workspace published', testIsAnsweredViaWorkspacePublished)
  run('isAnsweredReplyState: false for draft/failed/nothing', testIsNotAnsweredWhenOnlyDraftOrFailed)
  run('resolved/in-flight states are never actionable', testResolvedStatesAreNotActionable)
  run('needs_reply/draft/failed are actionable', testNeedsReplyDraftFailedAreActionable)
  run('rejected_by_google IS actionable (needs a new reply)', testRejectedIsActionable)
  run('computeReplyStateCounts: basic breakdown across needs_reply/draft/externally_replied', testComputeReplyStateCountsBasicBreakdown)
  run('computeReplyStateCounts: covers the granular moderation states', testComputeReplyStateCountsCoversGranularModerationStates)
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
