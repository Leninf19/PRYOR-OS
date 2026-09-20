import { reviewId } from './dataUtils.js'

// Google Reply Moderation State fix -- mirrors dashboard/api/_lib/
// replyModerationState.js's ModerationState/resolveBridgeModerationState
// exactly, by comment reference (kept in sync, not imported: a browser
// bundle cannot import a server-only _lib module -- see this file's own
// RISK_CATEGORIES copy further below for the SAME established
// frontend/backend duplication convention this project already uses).
//
// Root cause this fix addresses (full audit: Casa Tequila Brighton /
// reviewer "Terry", local review id 35738): this file used to collapse
// "a publish-bridge record merely exists" OR "the browser's own
// localStorage says published" into a single 'confirmed' state. Manually
// verified after the read-only diagnostic: Terry's reply did NOT fail and
// was never rejected -- PRYOR's PUT succeeded, Google's API stored the
// exact comment, and it later became publicly visible; the delay was
// ordinary Google moderation/propagation lag, not a defect. That is
// exactly why bridge existence alone, and localStorage alone, must never
// produce an approved/confirmed state -- and why a later comment match
// alone (REPLY_RECORDED) must never be silently upgraded to APPROVED
// either. Public Maps/Search visibility can lag behind API acceptance and
// retrieval, and this app has no mechanism to verify it directly.
export const ModerationState = Object.freeze({
  SENT_TO_GOOGLE:   'sent_to_google',
  REPLY_RECORDED:   'reply_recorded',
  PENDING_APPROVAL: 'pending_google_approval',
  APPROVED:         'approved_by_google',
  REJECTED:         'rejected_by_google',
})

const KNOWN_MODERATION_STATES = new Set(Object.values(ModerationState))

// Reads a publish-bridge record's OWN moderationState field instead of
// treating mere existence as confirmation. A record written before this fix
// (or carrying any unrecognized future value) has no usable moderationState
// and falls back to SENT_TO_GOOGLE -- the honest, weakest state, never an
// assumed approval. This is what makes a pre-existing bridge record safe to
// keep reading after this deploy with no migration.
export function resolveBridgeModerationState(bridgeEntry) {
  if (!bridgeEntry) return null
  if (typeof bridgeEntry.moderationState === 'string' && KNOWN_MODERATION_STATES.has(bridgeEntry.moderationState)) {
    return bridgeEntry.moderationState
  }
  return ModerationState.SENT_TO_GOOGLE
}

// Production-readiness durability fix: reads the review's OWN durable
// reviews.db columns (gbp_reply_moderation_state/gbp_reply_policy_violation,
// exported by export_chunks.py) -- unlike the bridge, this SURVIVES the
// short-lived Redis publish-bridge record expiring or being cleared, which
// is exactly how a PRYOR-published reply's REJECTED/PENDING/APPROVED
// outcome could otherwise silently disappear once its bridge record was
// gone. Returns null (no durable signal at all) rather than ever guessing
// -- a missing or unrecognized value here is NOT evidence of anything.
export function resolveDurableModerationState(r) {
  const state = r?.gbp_reply_moderation_state
  return typeof state === 'string' && KNOWN_MODERATION_STATES.has(state) ? state : null
}

// M5's reply-state model (Navigation/Design System/Execution Master Plan
// v1.0) -- a presentation-layer mapping over the existing workspace `status`
// + `owner_response` fields, extended by the Google Reply Moderation State
// fix to replace the old single, misleading 'confirmed' state with the
// granular states above:
//
//  - draft:                status is draft_ready or edited (an AI or edited
//                           draft exists, not yet sent) -- real field.
//  - sent_to_google:        Google accepted the reply at the HTTP layer, but
//                           no read-back has independently confirmed it yet
//                           -- this is what localStorage alone, or a bridge
//                           record with no/legacy moderationState, means.
//  - reply_recorded:        a later Google API read (bridge reconciliation
//                           or an ordinary full sync) independently
//                           confirmed the matching comment, with no
//                           explicit reviewReplyState -- Google has it on
//                           record; public visibility is not confirmed.
//  - pending_google_approval / approved_by_google / rejected_by_google:
//                           Google's own explicit reviewReplyState, from
//                           either the live bridge or the durable reviews.db
//                           snapshot (see replyModerationState.js).
//  - failed:                status === 'failed' -- real field, unchanged.
//  - pending:               INERT STUB, unchanged from before this fix --
//                           no code path in this app ever sets
//                           wsEntry.status to 'pending_confirmation'.
//
// `taken_care_of` (an existing, unrelated operational status -- "handled,
// no reply needed") is intentionally NOT one of these reply states; callers
// keep it on its own existing "Done" badge.
//
// M6: extracted from Reviews.jsx (where this was first built) into this
// shared module so Actions.jsx's "Waiting on Confirmation" section (which
// the Execution Master Plan v1.0 explicitly says needs this exact model)
// reuses it instead of duplicating the mapping.
export const REPLY_STATE_META = {
  needs_reply:                       { label: 'Needs Reply',             variant: 'danger'  },
  draft:                              { label: 'Draft',                   variant: 'accent'  },
  [ModerationState.SENT_TO_GOOGLE]:   { label: 'Sent to Google',          variant: 'accent'  },
  [ModerationState.REPLY_RECORDED]:   { label: 'Reply Recorded by Google', variant: 'info'    },
  [ModerationState.PENDING_APPROVAL]: { label: 'Pending Google Approval', variant: 'warning' },
  [ModerationState.APPROVED]:         { label: 'Approved by Google',      variant: 'success' },
  [ModerationState.REJECTED]:         { label: 'Rejected by Google',      variant: 'danger'  },
  failed:                             { label: 'Failed',                  variant: 'danger'  },
  pending:                            { label: 'Pending',                 variant: 'warning' },
}

// Short, manager-facing supporting text for each state (PART 5's explicit
// requirement: "include short supporting text explaining the state").
// A rejected review's reason comes from the bridge/durable record's own
// policyViolation.summary (never a raw API payload) when available.
export const MODERATION_STATE_DESCRIPTIONS = Object.freeze({
  [ModerationState.SENT_TO_GOOGLE]:   'Google accepted the request. It has not been independently confirmed yet.',
  [ModerationState.REPLY_RECORDED]:   'Google has received this reply. It may take time to appear publicly.',
  [ModerationState.PENDING_APPROVAL]: 'Google is still reviewing this reply before it can appear publicly.',
  [ModerationState.APPROVED]:         "Google has approved this reply. Public Maps/Search visibility can lag behind approval and isn't guaranteed immediately.",
  [ModerationState.REJECTED]:         'Google rejected this reply and it will not appear publicly. Write a new reply below.',
})

// Recovery Milestone 6B, Part 3 reply-state priority, revised by the
// Production-readiness durability fix. Priority order (strongest,
// deterministic server-side evidence first; browser-only continuity last
// and never overriding anything above it):
//   1. Explicit REJECTED/PENDING -- from the LIVE bridge (freshest) or the
//      DURABLE reviews.db snapshot (survives the bridge disappearing
//      entirely -- TTL expiry, an outage, anything). Either source is
//      trusted equally; whichever says REJECTED/PENDING wins, and neither
//      is ever downgraded by owner_response/comment presence.
//   2. Explicit APPROVED -- same two sources. This is what lets a
//      PRYOR-published reply keep being correctly attributed to PRYOR
//      (never misclassified once its bridge is gone) -- durable provenance,
//      not just "an owner_response happens to exist."
//   3. owner_response present with nothing above resolved -- Google's API
//      has a reply on record (REPLY_RECORDED); this app cannot reliably
//      tell a PRYOR-published reply whose bridge/durable history predates
//      this fix (the Terry case) apart from a genuinely independent reply,
//      so it does not pretend to -- both get this one honest label.
//   4. A live bridge with no resolved state yet (SENT_TO_GOOGLE or
//      REPLY_RECORDED already returned by resolveBridgeModerationState()).
//   5. Browser-only continuity (wsEntry) -- weakest signal, NEVER
//      overrides any of the above, even when they contradict it.
//
// `bridgeEntry` is optional (undefined for any caller not yet passing
// bridge data) so every existing call site keeps working unchanged.
export function computeReplyState(r, wsEntry, bridgeEntry) {
  const bridgeState = bridgeEntry ? resolveBridgeModerationState(bridgeEntry) : null
  const durableState = resolveDurableModerationState(r)

  if (bridgeState === ModerationState.REJECTED || durableState === ModerationState.REJECTED) return ModerationState.REJECTED
  if (bridgeState === ModerationState.PENDING_APPROVAL || durableState === ModerationState.PENDING_APPROVAL) return ModerationState.PENDING_APPROVAL
  if (bridgeState === ModerationState.APPROVED || durableState === ModerationState.APPROVED) return ModerationState.APPROVED
  if (r.owner_response) return ModerationState.REPLY_RECORDED
  if (bridgeState) return bridgeState
  if (wsEntry?.status === 'pending_confirmation') return 'pending' // see comment above -- never set
  if (wsEntry?.status === 'failed') return 'failed'
  if (wsEntry?.status === 'published') return ModerationState.SENT_TO_GOOGLE
  if (wsEntry?.status === 'draft_ready' || wsEntry?.status === 'edited') return 'draft'
  return 'needs_reply'
}

// Recovery Milestone 6B, Part 9, revised by the Production-readiness
// durability fix: true once a review is answered by a signal strong enough
// that generating another AI draft / showing the compose workspace would
// risk a duplicate publish attempt. An explicit REJECTED outcome (live
// bridge OR the durable reviews.db snapshot -- checked the same way
// computeReplyState() does) is the one deliberate exception -- Google will
// never make that reply public, so the review is NOT actually answered and
// must re-open for a genuinely new reply (PART 4/8's "never automatically
// republish" requirement is about not retrying the SAME rejected text
// automatically; a manager writing and submitting a new one through the
// normal compose flow is exactly the intended recovery path). Every other
// state still counts as "answered" here to prevent inviting a duplicate
// publish while the outcome is in flight, recorded-but-unresolved, or
// approved.
export function isAnsweredReplyState(r, wsEntry, bridgeEntry) {
  const bridgeState = bridgeEntry ? resolveBridgeModerationState(bridgeEntry) : null
  const durableState = resolveDurableModerationState(r)
  if (bridgeState === ModerationState.REJECTED || durableState === ModerationState.REJECTED) return false
  if (r.owner_response) return true
  if (bridgeEntry) return true
  return wsEntry?.status === 'published'
}

// Recovery Milestone 4 (Review Reply Inbox + AI Response Quality), revised
// by the Google Reply Moderation State fix: the Reviews inbox's default
// queue. "Actionable" = still needs a manager's attention -- unanswered
// (needs_reply), has a prepared-but-not-yet-sent draft (draft), previously
// failed to publish and needs a retry (failed), or was REJECTED by Google's
// moderation and genuinely needs a brand-new reply. Every other resolved/
// in-flight state belongs in history/search, not the default working queue.
const ACTIONABLE_STATES = new Set(['needs_reply', 'draft', 'failed', ModerationState.REJECTED])
export function isActionableReplyState(state) {
  return ACTIONABLE_STATES.has(state)
}

// Filtering UX Cleanup: per-state counts for Reviews.jsx's status pill row,
// extended by the Google Reply Moderation State fix to the full granular
// state set. Takes `reviews` as whatever the caller considers "in scope" --
// Reviews.jsx passes the GLOBALLY-filtered dataset (App.jsx's date/
// location/brand/star filters already applied), never its own
// further-narrowed local view, so these counts answer "how many of each
// state exist in the current global scope," independent of which status
// pill(s) happen to be selected right now. Extracted as a pure function (no
// React) so it's directly unit-testable, mirroring dataUtils.js's
// computeNextReviewId().
export function computeReplyStateCounts(reviews, ws, bridges) {
  const counts = {
    needs_reply: 0, draft: 0, failed: 0,
    [ModerationState.SENT_TO_GOOGLE]: 0, [ModerationState.REPLY_RECORDED]: 0,
    [ModerationState.PENDING_APPROVAL]: 0, [ModerationState.APPROVED]: 0, [ModerationState.REJECTED]: 0,
  }
  reviews.forEach(r => {
    const id = reviewId(r)
    const state = computeReplyState(r, ws?.[id], bridges?.[id])
    if (state in counts) counts[state]++
  })
  return counts
}

// Review Response Quality -- mirrors dashboard/api/_lib/
// reviewRiskClassifier.js's RISK_CATEGORIES exactly, categorized (not just
// a flat boolean) so this inbox can show WHICH kind of concern was
// detected (Urgent / Health & Safety / Needs Manager Review -- see
// CATEGORY_UI_LABELS below). This is the THIRD independent copy of this
// keyword check (ai_engine.py's _SERIOUS_KEYWORDS/_SERIOUS_RE and
// rewriteEngine.js's/reviewRiskClassifier.js's server copy are the other
// two), kept in sync by comment reference -- a browser-bundled file cannot
// import a server-only `_lib` module, and this project's established
// pattern for that boundary is a clearly cross-referenced, kept-in-sync
// duplicate, never a cross-boundary import (see reviewRiskClassifier.js's
// own header for the fuller reasoning). Used only for THIS inbox's own
// "Needs Management Review" warning gate -- never used to generate or
// alter response text, and never the actual publish-time enforcement
// boundary (google/[action].js's publish() re-classifies independently,
// server-side, from the SAME category list, and is the real safety gate).
const RISK_CATEGORIES = {
  food_poisoning: [
    'sick', 'ill', 'illness', 'vomit', 'vomiting', 'threw up', 'food poisoning',
    'diarrhea', 'nausea', 'nauseous', 'stomach ache', 'upset stomach', 'cramping',
  ],
  allergic_reaction: [
    'allergic', 'allergy', 'allergies', 'anaphylaxis', 'anaphylactic', 'epipen',
    'epi-pen', 'throat closing', 'throat swelling', 'swelling', 'hives',
    'difficulty breathing', 'trouble breathing', "can't breathe", 'cant breathe',
    'passed out', 'unconscious', 'lost consciousness',
  ],
  injury: [
    'injury', 'injured', 'cut myself', 'burned', 'burn', 'choke', 'choked',
    'choking', 'broken tooth', 'chipped tooth', 'fell', 'fall', 'accident',
    'bleeding', 'stitches', 'hospital', 'hospitalized', 'doctor', 'er visit',
    'emergency room',
  ],
  foreign_object: [
    'glass', 'metal', 'plastic', 'staple', 'wire', 'bug', 'insect', 'cockroach',
    'roach', 'fly in my', 'hair in my food', 'foreign object', 'band-aid', 'bandaid',
  ],
  unsafe_food: [
    'raw chicken', 'undercooked', 'undercooked chicken', 'spoiled', 'rotten',
    'expired', 'mold', 'moldy', 'rancid', 'smelled off', 'tasted off',
  ],
  sanitation: [
    'rat', 'rats', 'mouse', 'mice', 'rodent', 'rodents', 'pest', 'pests',
    'health department', 'health code', 'health violation', 'dirty kitchen',
    'unsanitary', 'filthy', 'shut down',
  ],
  threat_violence: [
    'threatened', 'threatening', 'assault', 'assaulted', 'violent', 'violence',
    'weapon', 'gun', 'knife pulled',
  ],
  discrimination_harassment: [
    'discrimination', 'discriminated', 'racist', 'racism', 'harassment',
    'harassed', 'hostile', 'homophobic', 'sexist',
  ],
  legal_threat: [
    'lawsuit', 'lawyer', 'attorney', 'sue', 'sued', 'legal action', 'police',
    'subpoena', 'file a complaint',
  ],
  fraud_payment: [
    'stole', 'stolen', 'theft', 'fraud', 'fraudulent', 'overcharged', 'scam', 'scammed',
  ],
}

export const CATEGORY_UI_LABELS = {
  food_poisoning: 'Health & Safety',
  allergic_reaction: 'Health & Safety',
  injury: 'Health & Safety',
  foreign_object: 'Health & Safety',
  unsafe_food: 'Health & Safety',
  sanitation: 'Health & Safety',
  threat_violence: 'Needs Manager Review',
  discrimination_harassment: 'Needs Manager Review',
  legal_threat: 'Needs Manager Review',
  fraud_payment: 'Needs Manager Review',
}

function buildWordBoundaryRegex(keywords) {
  const escaped = keywords.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp('\\b(' + escaped.join('|') + ')\\b', 'i')
}

const CATEGORY_PATTERNS = Object.fromEntries(
  Object.entries(RISK_CATEGORIES).map(([category, keywords]) => [category, buildWordBoundaryRegex(keywords)])
)

// Returns { isHighRisk, categories } for a review object (reads
// `r.review_text`, same field isSeriousReview() below always read).
export function classifyReviewRiskClient(r) {
  const text = r?.review_text || ''
  if (!text.trim()) return { isHighRisk: false, categories: [] }
  const categories = Object.entries(CATEGORY_PATTERNS)
    .filter(([, re]) => re.test(text))
    .map(([category]) => category)
  return { isHighRisk: categories.length > 0, categories }
}

export function isSeriousReview(r) {
  return classifyReviewRiskClient(r).isHighRisk
}
