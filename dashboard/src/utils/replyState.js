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
// localStorage says published" into a single 'confirmed' state -- which is
// exactly what let PRYOR show "Confirmed" for a reply Google had actually
// left pending or rejected in moderation. Bridge existence alone, and
// localStorage alone, must NEVER produce an approved/confirmed state again.
export const ModerationState = Object.freeze({
  SENT_TO_GOOGLE:       'sent_to_google',
  PENDING_APPROVAL:     'pending_google_approval',
  APPROVED:             'approved_by_google',
  REJECTED:             'rejected_by_google',
  VERIFICATION_DELAYED: 'verification_delayed',
  EXTERNALLY_REPLIED:   'externally_replied',
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

// M5's reply-state model (Navigation/Design System/Execution Master Plan
// v1.0) -- a presentation-layer mapping over the existing workspace `status`
// + `owner_response` fields, extended by the Google Reply Moderation State
// fix to replace the old single, misleading 'confirmed' state with the
// granular states above:
//
//  - draft:                status is draft_ready or edited (an AI or edited
//                           draft exists, not yet sent) -- real field.
//  - sent_to_google:        Google accepted the reply at the HTTP layer, but
//                           no conclusive moderation state is known yet --
//                           this is what localStorage alone, or a bridge
//                           record with no/legacy moderationState, means.
//  - pending_google_approval / approved_by_google / rejected_by_google:
//                           Google's own reviewReplyState, read from the
//                           publish-bridge record (see replyModerationState.js).
//  - verification_delayed: a check was attempted but stayed inconclusive
//                           (timeout, unreadable state, delayed reconciliation).
//  - failed:                status === 'failed' -- real field, unchanged.
//  - externally_replied:    owner_response is populated but this app's
//                           workspace/bridge never recorded publishing it --
//                           a reply exists on Google that didn't come from
//                           here. Computed from already-real fields.
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
  needs_reply:                            { label: 'Needs Reply',             variant: 'danger'  },
  draft:                                   { label: 'Draft',                   variant: 'accent'  },
  [ModerationState.SENT_TO_GOOGLE]:        { label: 'Sent to Google',          variant: 'accent'  },
  [ModerationState.PENDING_APPROVAL]:      { label: 'Pending Google Approval', variant: 'warning' },
  [ModerationState.APPROVED]:              { label: 'Approved by Google',      variant: 'success' },
  [ModerationState.REJECTED]:              { label: 'Rejected by Google',      variant: 'danger'  },
  [ModerationState.VERIFICATION_DELAYED]:  { label: 'Verification Delayed',    variant: 'warning' },
  failed:                                  { label: 'Failed',                  variant: 'danger'  },
  [ModerationState.EXTERNALLY_REPLIED]:    { label: 'Externally Replied',      variant: 'info'    },
  pending:                                 { label: 'Pending',                 variant: 'warning' },
}

// Short, manager-facing supporting text for each state (PART 5's explicit
// requirement: "include short supporting text explaining the state").
// A rejected review's reason comes from the bridge record's own
// policyViolation.summary (never a raw API payload) when available.
export const MODERATION_STATE_DESCRIPTIONS = Object.freeze({
  [ModerationState.SENT_TO_GOOGLE]:       'Google accepted the reply. Approval has not been confirmed yet.',
  [ModerationState.PENDING_APPROVAL]:     'Google is still reviewing this reply before it can appear publicly.',
  [ModerationState.APPROVED]:             'Google has approved this reply. It may take additional time to appear on every public surface.',
  [ModerationState.REJECTED]:             'Google rejected this reply and it will not appear publicly. Write a new reply below.',
  [ModerationState.VERIFICATION_DELAYED]: "We couldn't confirm this reply's status with Google yet. It will keep checking automatically.",
})

// Recovery Milestone 6B, Part 3 reply-state priority, revised by the Google
// Reply Moderation State fix. Priority order:
//   1. Google owner_response -- always authoritative (an independent sync
//      actually saw Google serving this comment back). Combined with a
//      live bridge record, this app's own publish produced it -- treated
//      as APPROVED (the strongest signal this system has, though still not
//      literal proof of every public surface having propagated it); alone,
//      it's a reply this app never recorded making (EXTERNALLY_REPLIED).
//   2. The durable Redis bridge (see dashboard/api/_lib/publishBridgeStore.js)
//      -- its OWN moderationState field is now what's actually inspected
//      (resolveBridgeModerationState() above), never just its existence.
//      This is the literal fix for the "Confirmed but missing on Google"
//      defect: a bridge record can now resolve to SENT_TO_GOOGLE, PENDING,
//      APPROVED, REJECTED, or VERIFICATION_DELAYED, never a blanket
//      'confirmed'.
//   3. wsEntry.status === 'published' -- kept as a same-browser fallback
//      for when the bridge itself couldn't be read (Redis unreachable,
//      pre-fix client), but PART 5's explicit requirement: localStorage
//      alone may support temporary UI continuity, never canonical
//      confirmation -- so this resolves to SENT_TO_GOOGLE, never APPROVED.
//   4/5. failed / draft -- unchanged, only reachable when neither signal
//      above says otherwise.
//
// `bridgeEntry` is optional (undefined for any caller not yet passing
// bridge data) so every existing call site keeps working unchanged.
export function computeReplyState(r, wsEntry, bridgeEntry) {
  const hasBridge = Boolean(bridgeEntry)
  if (r.owner_response) return hasBridge ? ModerationState.APPROVED : ModerationState.EXTERNALLY_REPLIED
  if (hasBridge) return resolveBridgeModerationState(bridgeEntry)
  if (wsEntry?.status === 'pending_confirmation') return 'pending' // see comment above -- never set
  if (wsEntry?.status === 'failed') return 'failed'
  if (wsEntry?.status === 'published') return ModerationState.SENT_TO_GOOGLE
  if (wsEntry?.status === 'draft_ready' || wsEntry?.status === 'edited') return 'draft'
  return 'needs_reply'
}

// Recovery Milestone 6B, Part 9, revised by the Google Reply Moderation
// State fix: true once a review is answered by a signal strong enough that
// generating another AI draft / showing the compose workspace would risk a
// duplicate publish attempt. A REJECTED bridge is the one deliberate
// exception -- Google will never make that reply public, so the review is
// NOT actually answered and must re-open for a genuinely new reply (PART 4/
// 8's "never automatically republish" requirement is about not retrying the
// SAME rejected text automatically; a manager writing and submitting a new
// one through the normal compose flow is exactly the intended recovery
// path). SENT_TO_GOOGLE/PENDING_APPROVAL/APPROVED/VERIFICATION_DELAYED all
// still count as "answered" here to prevent inviting a duplicate publish
// while the outcome is in flight or unresolved.
export function isAnsweredReplyState(r, wsEntry, bridgeEntry) {
  if (r.owner_response) return true
  if (bridgeEntry) return resolveBridgeModerationState(bridgeEntry) !== ModerationState.REJECTED
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
    [ModerationState.SENT_TO_GOOGLE]: 0, [ModerationState.PENDING_APPROVAL]: 0,
    [ModerationState.APPROVED]: 0, [ModerationState.REJECTED]: 0,
    [ModerationState.VERIFICATION_DELAYED]: 0, [ModerationState.EXTERNALLY_REPLIED]: 0,
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
