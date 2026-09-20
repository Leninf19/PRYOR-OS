// Regression tests for dashboard/src/utils/replyState.js's computeReplyState()/
// isAnsweredReplyState()/isActionableReplyState()/computeReplyStateCounts().
//
// Extended twice by the Google Reply Moderation State effort:
//  1. The original fix (audit: Casa Tequila Brighton / reviewer "Terry",
//     local review id 35738 -- a reply that showed "Confirmed" in PRYOR
//     while missing from the public Google listing): a publish-bridge
//     record's mere EXISTENCE, and a browser localStorage 'published'
//     status ALONE, must never produce an approved/confirmed state -- only
//     Google's own reviewReplyState can.
//  2. The Production-readiness durability fix (after manually verifying
//     Terry's reply WAS publicly visible -- an ordinary moderation/
//     propagation delay, never a rejection): that same explicit state must
//     also SURVIVE the short-lived publish-bridge record disappearing
//     entirely (TTL expiry, an outage, anything) via a DURABLE reviews.db
//     snapshot (r.gbp_reply_moderation_state) -- and a PRYOR-published
//     reply's APPROVED provenance must not be lost either, so it never
//     misclassifies as an unattributed "Reply Recorded" once its bridge is
//     gone. VERIFICATION_DELAYED and EXTERNALLY_REPLIED were merged into
//     one honest state, REPLY_RECORDED, since this app has no reliable way
//     to tell them apart once a bridge is gone.
//
// Run directly: node tests/test_reply_state.js

import {
  computeReplyState, isAnsweredReplyState, isActionableReplyState, computeReplyStateCounts,
  resolveBridgeModerationState, resolveDurableModerationState, ModerationState,
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

const R_UNANSWERED = { owner_response: '' }
function answered(text = 'Thank you for the kind words!') { return { owner_response: text } }
function durable(state, extra = {}) { return { owner_response: '', gbp_reply_moderation_state: state, ...extra } }

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

function testOwnerResponseAloneWithNoProvenanceIsReplyRecorded() {
  // Terry-like legacy case AND a genuinely independent reply look
  // identical from data alone (owner_response present, no bridge, no
  // durable provenance marker) -- this app does not pretend to
  // distinguish them; both get the one honest "Google has this on record"
  // label, never a presumptuous "Externally Replied" claim about origin.
  const state = computeReplyState(answered(), undefined, undefined)
  assert(state === ModerationState.REPLY_RECORDED,
    `owner_response with no bridge/durable provenance must be reply_recorded, got ${state}`)
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

// --- New granular moderation states (live bridge) ---------------------------

function testBridgeWithPendingApprovalState() {
  assert(computeReplyState(R_UNANSWERED, undefined, bridgeWith(ModerationState.PENDING_APPROVAL)) === ModerationState.PENDING_APPROVAL)
}

function testBridgeWithApprovedState() {
  assert(computeReplyState(R_UNANSWERED, undefined, bridgeWith(ModerationState.APPROVED)) === ModerationState.APPROVED)
}

function testBridgeWithRejectedState() {
  assert(computeReplyState(R_UNANSWERED, undefined, bridgeWith(ModerationState.REJECTED)) === ModerationState.REJECTED)
}

function testBridgeWithReplyRecordedState() {
  assert(computeReplyState(R_UNANSWERED, undefined, bridgeWith(ModerationState.REPLY_RECORDED)) === ModerationState.REPLY_RECORDED)
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

// === Production-readiness durability fix: DURABLE reviews.db precedence ===
// Every test below simulates the bridge being COMPLETELY GONE
// (bridgeEntry === undefined) -- the durable r.gbp_reply_moderation_state
// field is the ONLY signal available, exactly like after a real TTL
// expiration or outage.

function testDurableRejectedSurvivesNoBridge() {
  const state = computeReplyState(durable(ModerationState.REJECTED), undefined, undefined)
  assert(state === ModerationState.REJECTED, `REJECTED must survive the bridge being gone -- got ${state}`)
}

function testDurablePendingSurvivesNoBridge() {
  const state = computeReplyState(durable(ModerationState.PENDING_APPROVAL), undefined, undefined)
  assert(state === ModerationState.PENDING_APPROVAL, `PENDING must survive the bridge being gone -- got ${state}`)
}

function testDurableApprovedProvenanceSurvivesNoBridgeEvenWithoutOwnerResponse() {
  // Belt-and-suspenders: even if owner_response somehow lags behind the
  // durable marker, the durable APPROVED signal alone must still resolve
  // correctly, never falling through to needs_reply.
  const state = computeReplyState(durable(ModerationState.APPROVED), undefined, undefined)
  assert(state === ModerationState.APPROVED, `durable APPROVED must resolve correctly -- got ${state}`)
}

function testDurableApprovedPlusOwnerResponseIsApprovedNeverReplyRecorded() {
  // THE core provenance-preservation case (Production-readiness question
  // #3): a PRYOR-published, now-approved reply, once its bridge is gone,
  // must keep resolving to APPROVED -- never fall back to the ambiguous
  // REPLY_RECORDED bucket just because owner_response happens to be
  // present with no live bridge.
  const r = { owner_response: 'Thanks for the kind words!', gbp_reply_moderation_state: ModerationState.APPROVED }
  const state = computeReplyState(r, undefined, undefined)
  assert(state === ModerationState.APPROVED, `PRYOR provenance must survive bridge deletion -- got ${state}, expected approved_by_google`)
}

function testDurableRejectedOverridesOwnerResponseNeverConfusedWithReplyRecorded() {
  const r = { owner_response: '', gbp_reply_moderation_state: ModerationState.REJECTED }
  assert(computeReplyState(r, undefined, undefined) === ModerationState.REJECTED)
}

function testDurableStateUnrecognizedValueIsIgnoredNeverGuessed() {
  const r = durable('some_future_value_never_seen_before')
  assert(computeReplyState(r, undefined, undefined) === 'needs_reply',
    'an unrecognized durable moderation value must never be guessed as any specific state')
}

function testResolveDurableModerationStateDirectly() {
  assert(resolveDurableModerationState({}) === null)
  assert(resolveDurableModerationState({ gbp_reply_moderation_state: null }) === null)
  assert(resolveDurableModerationState({ gbp_reply_moderation_state: 'garbage' }) === null)
  assert(resolveDurableModerationState({ gbp_reply_moderation_state: ModerationState.REJECTED }) === ModerationState.REJECTED)
}

function testLiveBridgeRejectedWinsOverStaleDurableApproved() {
  // Precedence check: if the LIVE bridge disagrees with an older durable
  // snapshot (e.g. a reply was durably APPROVED once, then somehow a later
  // bridge attempt was REJECTED), REJECTED/PENDING from either source
  // always wins over APPROVED -- never let a stale "approved" durable
  // value mask a live, more urgent rejection.
  const r = durable(ModerationState.APPROVED)
  const state = computeReplyState(r, undefined, bridgeWith(ModerationState.REJECTED))
  assert(state === ModerationState.REJECTED, `a live REJECTED must win over a stale durable APPROVED -- got ${state}`)
}

function testBrowserLocalStorageNeverOverridesDurableRejected() {
  // Explicit requirement: "Browser localStorage must never override
  // contradictory server evidence." A same-browser wsEntry saying
  // 'published' must never mask a durable REJECTED.
  const r = durable(ModerationState.REJECTED)
  const wsEntry = { status: 'published' }
  const state = computeReplyState(r, wsEntry, undefined)
  assert(state === ModerationState.REJECTED, `localStorage must never override a durable REJECTED -- got ${state}`)
}

function testBrowserLocalStorageNeverOverridesLiveBridgePending() {
  const wsEntry = { status: 'published' }
  const state = computeReplyState(R_UNANSWERED, wsEntry, bridgeWith(ModerationState.PENDING_APPROVAL))
  assert(state === ModerationState.PENDING_APPROVAL, `localStorage must never override a live PENDING bridge -- got ${state}`)
}

// --- isAnsweredReplyState (Part 9) -- revised gating ------------------------

function testIsAnsweredViaOwnerResponse() {
  assert(isAnsweredReplyState(answered(), undefined, undefined) === true)
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
function testIsAnsweredViaReplyRecordedBridge() {
  assert(isAnsweredReplyState(R_UNANSWERED, undefined, bridgeWith(ModerationState.REPLY_RECORDED)) === true,
    'a recorded-but-unresolved reply must still block a duplicate publish attempt')
}
function testIsNotAnsweredWhenRejected() {
  assert(isAnsweredReplyState(R_UNANSWERED, undefined, bridgeWith(ModerationState.REJECTED)) === false,
    'a REJECTED reply is genuinely unanswered -- Google will never make it public, so the review must re-open for a new reply')
}
function testIsNotAnsweredWhenDurablyRejectedEvenWithNoBridge() {
  // Durability: the bridge is GONE, but reviews.db durably remembers
  // REJECTED -- must still correctly re-open, not silently answered.
  assert(isAnsweredReplyState(durable(ModerationState.REJECTED), undefined, undefined) === false)
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
  assert(isActionableReplyState(ModerationState.REPLY_RECORDED) === false)
  assert(isActionableReplyState(ModerationState.SENT_TO_GOOGLE) === false)
  assert(isActionableReplyState(ModerationState.PENDING_APPROVAL) === false)
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
  assert(counts[ModerationState.REPLY_RECORDED] === 1)
  assert(counts[ModerationState.APPROVED] === 0 && counts.failed === 0)
}

function testComputeReplyStateCountsCoversGranularModerationStates() {
  const reviews = [
    { review_id: 'p1', owner_response: '' },
    { review_id: 'p2', owner_response: '' },
    { review_id: 'p3', owner_response: '' },
    { review_id: 'p4', owner_response: '', gbp_reply_moderation_state: ModerationState.REJECTED },
  ]
  const bridges = {
    p1: bridgeWith(ModerationState.PENDING_APPROVAL),
    p2: bridgeWith(ModerationState.REJECTED),
    p3: bridgeWith(ModerationState.REPLY_RECORDED),
  }
  const counts = computeReplyStateCounts(reviews, {}, bridges)
  assert(counts[ModerationState.PENDING_APPROVAL] === 1)
  assert(counts[ModerationState.REJECTED] === 2, 'must count both the live-bridge and the durable-only REJECTED review')
  assert(counts[ModerationState.REPLY_RECORDED] === 1)
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
  run('failed workspace with no authoritative signal -> failed', testFailedWorkspaceWithNoAuthoritativeSignalIsFailed)
  run('draft workspace with no authoritative signal -> draft', testDraftWorkspaceWithNoAuthoritativeSignalIsDraft)
  run('ROOT CAUSE: a legacy bridge record alone -> sent_to_google, never approved', testLegacyBridgeAloneIsSentToGoogleNeverApproved)
  run('ROOT CAUSE: localStorage published alone -> sent_to_google, never approved', testWorkspacePublishedAloneIsSentToGoogleNeverApproved)
  run('owner_response alone, no provenance -> reply_recorded (Terry-like/independent, indistinguishable)', testOwnerResponseAloneWithNoProvenanceIsReplyRecorded)
  run('legacy bridge wins over a stale failed workspace, resolves to its own state', testLegacyBridgeWinsOverStaleFailedWorkspace)
  run('legacy bridge wins over a stale draft workspace, resolves to its own state', testLegacyBridgeWinsOverStaleDraftWorkspace)
  run('bridge with PENDING_APPROVAL moderationState', testBridgeWithPendingApprovalState)
  run('bridge with APPROVED moderationState', testBridgeWithApprovedState)
  run('bridge with REJECTED moderationState', testBridgeWithRejectedState)
  run('bridge with REPLY_RECORDED moderationState', testBridgeWithReplyRecordedState)
  run('bridge with an unrecognized future moderationState falls back to sent_to_google', testBridgeWithUnknownFutureStateFallsBackToSentToGoogle)
  run('resolveBridgeModerationState direct unit coverage', testResolveBridgeModerationStateDirectly)

  run('DURABILITY: REJECTED survives the bridge being completely gone', testDurableRejectedSurvivesNoBridge)
  run('DURABILITY: PENDING survives the bridge being completely gone', testDurablePendingSurvivesNoBridge)
  run('DURABILITY: durable APPROVED resolves correctly with no bridge/owner_response', testDurableApprovedProvenanceSurvivesNoBridgeEvenWithoutOwnerResponse)
  run('DURABILITY: PRYOR provenance (durable APPROVED + owner_response) survives bridge deletion, never Reply Recorded', testDurableApprovedPlusOwnerResponseIsApprovedNeverReplyRecorded)
  run('DURABILITY: durable REJECTED is never confused with reply_recorded', testDurableRejectedOverridesOwnerResponseNeverConfusedWithReplyRecorded)
  run('DURABILITY: an unrecognized durable value is ignored, never guessed', testDurableStateUnrecognizedValueIsIgnoredNeverGuessed)
  run('resolveDurableModerationState direct unit coverage', testResolveDurableModerationStateDirectly)
  run('PRECEDENCE: a live REJECTED bridge wins over a stale durable APPROVED', testLiveBridgeRejectedWinsOverStaleDurableApproved)
  run('PRECEDENCE: localStorage never overrides a durable REJECTED', testBrowserLocalStorageNeverOverridesDurableRejected)
  run('PRECEDENCE: localStorage never overrides a live PENDING bridge', testBrowserLocalStorageNeverOverridesLiveBridgePending)

  run('isAnsweredReplyState: true via owner_response', testIsAnsweredViaOwnerResponse)
  run('isAnsweredReplyState: true via legacy bridge', testIsAnsweredViaLegacyBridge)
  run('isAnsweredReplyState: true via pending bridge (no duplicate publish while in flight)', testIsAnsweredViaPendingBridge)
  run('isAnsweredReplyState: true via approved bridge', testIsAnsweredViaApprovedBridge)
  run('isAnsweredReplyState: true via reply-recorded bridge', testIsAnsweredViaReplyRecordedBridge)
  run('isAnsweredReplyState: FALSE via rejected bridge (must re-open for a new reply)', testIsNotAnsweredWhenRejected)
  run('isAnsweredReplyState: FALSE via durable REJECTED even with no bridge', testIsNotAnsweredWhenDurablyRejectedEvenWithNoBridge)
  run('isAnsweredReplyState: true via workspace published', testIsAnsweredViaWorkspacePublished)
  run('isAnsweredReplyState: false for draft/failed/nothing', testIsNotAnsweredWhenOnlyDraftOrFailed)

  run('resolved/in-flight states are never actionable', testResolvedStatesAreNotActionable)
  run('needs_reply/draft/failed are actionable', testNeedsReplyDraftFailedAreActionable)
  run('rejected_by_google IS actionable (needs a new reply)', testRejectedIsActionable)

  run('computeReplyStateCounts: basic breakdown across needs_reply/draft/reply_recorded', testComputeReplyStateCountsBasicBreakdown)
  run('computeReplyStateCounts: covers the granular moderation states incl. durable-only REJECTED', testComputeReplyStateCountsCoversGranularModerationStates)
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
