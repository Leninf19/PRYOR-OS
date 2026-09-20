// Google Reply Moderation State -- fixes the "Confirmed in PRYOR, missing on
// Google" discrepancy found in the read-only audit of this same feature
// (Casa Tequila Brighton / reviewer "Terry", local review id 35738).
//
// Root cause (see that audit): replyViaReviewName() discarded Google's
// updateReply response body entirely, and every downstream consumer
// (publishBridgeStore.js, gbp_reply_bridge_reconcile.py,
// gbp_reply_reconciliation_diagnostic.py, replyState.js) inferred "success"
// from either an HTTP-OK status or the mere presence of `reviewReply.comment`
// text -- never from Google's own reviewReplyState/policyViolation fields,
// which is the ONLY thing that actually says whether a reply is approved,
// pending moderation, or rejected. Per Google's current API reference
// (https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews),
// ReviewReply carries: comment, updateTime, reviewReplyState (PENDING |
// APPROVED | REJECTED | REVIEW_REPLY_STATE_UNSPECIFIED), and policyViolation
// (populated only when REJECTED).
//
// This module is the ONE place that normalizes those raw Google fields into
// this app's own truthful state model, shared by every caller that needs it
// (dashboard/api/google/[action].js's publish(), publishBridgeStore.js,
// replyState.js). gbp_reply_bridge_reconcile.py/
// gbp_reply_reconciliation_diagnostic.py (Python) keep their own small,
// deliberately parallel copy of the same normalization logic -- the same
// cross-language duplication convention already established for
// reviewRiskClassifier.js/ai_engine.py's risk categories, since Python and
// JS cannot share a module here.
//
// Design principle carried through every function below: an unknown,
// missing, or future/unrecognized value is NEVER interpreted as approval or
// rejection -- it always falls back to the weakest, most honest state
// available ("sent to Google, nothing conclusive yet" at write time, or
// "verification delayed" once a read-back was attempted but stayed
// inconclusive). This module never throws; it never lets a malformed or
// unexpected Google payload crash the publish flow.

// The complete state model (PART 2 of this fix). Ordered roughly from
// "least confirmed" to "most confirmed terminal" for readability only --
// callers must not assume ordering carries meaning.
export const ModerationState = Object.freeze({
  // Google accepted the PUT at the HTTP layer. No conclusive moderation
  // state has been retrieved yet. This is the correct, honest label for
  // what the OLD code called "Confirmed" -- never call this "Confirmed".
  SENT_TO_GOOGLE: 'sent_to_google',
  // Google explicitly returned reviewReplyState: PENDING.
  PENDING_APPROVAL: 'pending_google_approval',
  // Google explicitly returned reviewReplyState: APPROVED. This proves the
  // Business Profile API itself resolved the reply -- it does NOT prove the
  // reply has propagated to every public Google Maps/Search surface yet
  // (a separate, later event this app has no way to observe directly).
  APPROVED: 'approved_by_google',
  // Google explicitly returned reviewReplyState: REJECTED. Terminal --
  // never auto-retried/auto-republished (PART 4/8's explicit requirement).
  REJECTED: 'rejected_by_google',
  // The outcome is inconclusive: a timeout, an unavailable read-back, a
  // missing/unspecified/unrecognized reviewReplyState value, or a
  // reconciliation pass that hasn't found a conclusive state yet. Distinct
  // from SENT_TO_GOOGLE only in that a check was actually attempted and
  // still came back inconclusive (useful for UI/observability, not for any
  // different enforcement behavior -- both states equally forbid treating
  // the reply as approved).
  VERIFICATION_DELAYED: 'verification_delayed',
  // Unchanged, pre-existing meaning: a reply this app never itself
  // published, discovered via reviews.db's owner_response with no bridge
  // record backing it.
  EXTERNALLY_REPLIED: 'externally_replied',
})

// Google's own documented reviewReplyState enum. Anything else (a future
// value Google adds, a typo, null, undefined, non-string) normalizes to
// null -- "unresolved", never guessed.
const KNOWN_REVIEW_REPLY_STATES = new Set(['PENDING', 'APPROVED', 'REJECTED'])

export function normalizeReviewReplyState(raw) {
  if (typeof raw !== 'string') return null
  if (raw === 'REVIEW_REPLY_STATE_UNSPECIFIED') return null
  return KNOWN_REVIEW_REPLY_STATES.has(raw) ? raw : null
}

// Human-readable, manager-safe summaries for policy violation reason codes
// Google is known to use. This list is deliberately NOT exhaustive --
// Google's exact PolicyViolation schema/field name is not fully documented
// publicly as of this fix, so this function is written to tolerate several
// plausible shapes (a bare string enum, an array of string enums, or an
// object carrying the codes under one of a few plausible field names)
// without ever crashing or fabricating a reason it wasn't given.
const POLICY_REASON_SUMMARIES = Object.freeze({
  FAKE_ENGAGEMENT: 'flagged as fake engagement',
  ADVERTISING_AND_SOLICITATION: 'flagged as advertising or solicitation',
  MISINFORMATION: 'flagged as misinformation',
  HARASSMENT: 'flagged for harassment',
  OFF_TOPIC: 'flagged as off-topic',
  SPAM: 'flagged as spam',
  CONFLICT_OF_INTEREST: 'flagged for a conflict of interest',
  ILLEGAL: 'flagged as illegal content',
  EXPLICIT: 'flagged as explicit content',
})

// Never exposes a raw Google payload -- returns only a small, sanitized
// { reasonCodes, summary } shape (or null) safe to render directly in the
// UI. reasonCodes are kept (they're just short enum names, not sensitive)
// so a future support/debugging view can show them, but `summary` is the
// thing the UI should actually display.
export function normalizePolicyViolation(raw) {
  if (raw == null) return null
  let codes = []
  if (typeof raw === 'string') {
    codes = [raw]
  } else if (Array.isArray(raw)) {
    codes = raw.filter(c => typeof c === 'string')
  } else if (typeof raw === 'object') {
    const candidate = raw.policyViolationReasons ?? raw.reasons ?? raw.reasonCodes ?? raw.reason ?? raw.policyViolationReason
    if (typeof candidate === 'string') codes = [candidate]
    else if (Array.isArray(candidate)) codes = candidate.filter(c => typeof c === 'string')
  }
  codes = codes.filter(Boolean)
  if (!codes.length) {
    return { reasonCodes: [], summary: 'Rejected by Google for a policy reason it did not specify.' }
  }
  const summaries = codes.map(c => POLICY_REASON_SUMMARIES[c] ? `Rejected by Google -- ${POLICY_REASON_SUMMARIES[c]}.` : 'Rejected by Google for an unrecognized policy reason.')
  return { reasonCodes: codes, summary: summaries[0] }
}

// Comparison-only normalization -- NEVER used to alter what was actually
// submitted/stored/displayed as the public reply text, only to decide
// whether Google's echoed-back comment is "the same reply" for
// corroboration purposes (PART 4's "normalize reply text consistently
// before matching, without changing the saved public reply").
export function normalizeReplyTextForComparison(text) {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function replyTextMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null
  return normalizeReplyTextForComparison(a) === normalizeReplyTextForComparison(b)
}

// Safely parses whatever Google's updateReply PUT returned as its response
// body -- an empty body, malformed JSON, or a body missing/renaming fields
// must never throw and must never be mistaken for a conclusive state.
// `rawBody` may be a string (already-read text) or a parsed object.
export function parseGoogleReplyResponse(rawBody) {
  let body = rawBody
  if (typeof body === 'string') {
    if (!body.trim()) return { comment: null, updateTime: null, reviewReplyState: null, policyViolation: null }
    try {
      body = JSON.parse(body)
    } catch {
      return { comment: null, updateTime: null, reviewReplyState: null, policyViolation: null }
    }
  }
  if (!body || typeof body !== 'object') {
    return { comment: null, updateTime: null, reviewReplyState: null, policyViolation: null }
  }
  return {
    comment: typeof body.comment === 'string' ? body.comment : null,
    updateTime: typeof body.updateTime === 'string' ? body.updateTime : null,
    reviewReplyState: normalizeReviewReplyState(body.reviewReplyState),
    policyViolation: normalizePolicyViolation(body.policyViolation),
  }
}

// Turns a normalized Google reviewReplyState into this app's ModerationState.
// Returns null when the state is unresolved -- callers decide the correct
// fallback for their own context (SENT_TO_GOOGLE right after a fresh PUT,
// VERIFICATION_DELAYED after a reconciliation check that came back
// inconclusive) rather than this shared function guessing one.
export function classifyModerationOutcome(reviewReplyState) {
  const normalized = normalizeReviewReplyState(reviewReplyState)
  if (normalized === 'APPROVED') return ModerationState.APPROVED
  if (normalized === 'REJECTED') return ModerationState.REJECTED
  if (normalized === 'PENDING') return ModerationState.PENDING_APPROVAL
  return null
}

// The ONE function that decides what a publish-bridge record's *effective*
// moderation state is right now -- used by replyState.js (frontend) and by
// anything else that reads a bridge record. Legacy records written before
// this fix have no `moderationState` field at all; those MUST resolve to
// SENT_TO_GOOGLE (the honest description of what the old code actually
// verified), never to APPROVED/CONFIRMED -- this is what makes old records
// safe/backward-compatible (PART 4's explicit requirement).
export function resolveBridgeModerationState(bridgeRecord) {
  if (!bridgeRecord || typeof bridgeRecord !== 'object') return null
  const known = new Set(Object.values(ModerationState))
  if (typeof bridgeRecord.moderationState === 'string' && known.has(bridgeRecord.moderationState)) {
    return bridgeRecord.moderationState
  }
  // Missing field (legacy record) OR an unrecognized future value -- both
  // fall back to the weakest honest state, never guessed as approved.
  return ModerationState.SENT_TO_GOOGLE
}

// Safe, UI-ready label/description pairs for every state -- kept here
// (not duplicated in replyState.js) so the frontend and any future surface
// describe these states identically.
export const MODERATION_STATE_UI = Object.freeze({
  [ModerationState.SENT_TO_GOOGLE]: {
    label: 'Sent to Google',
    description: 'Google accepted the reply. Approval has not been confirmed yet.',
  },
  [ModerationState.PENDING_APPROVAL]: {
    label: 'Pending Google approval',
    description: 'Google is still reviewing this reply before it can appear publicly.',
  },
  [ModerationState.APPROVED]: {
    label: 'Approved by Google',
    description: 'Google has approved this reply. It may take additional time to appear on every public surface.',
  },
  [ModerationState.REJECTED]: {
    label: 'Rejected by Google',
    description: 'Google rejected this reply and it will not appear publicly. A new reply is needed.',
  },
  [ModerationState.VERIFICATION_DELAYED]: {
    label: 'Verification delayed',
    description: "We couldn't confirm this reply's status with Google yet. It will keep checking automatically.",
  },
  [ModerationState.EXTERNALLY_REPLIED]: {
    label: 'Externally replied',
    description: 'Google shows a reply for this review that was not published through PRYOR.',
  },
})
