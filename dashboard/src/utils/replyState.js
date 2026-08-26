import { reviewId } from './dataUtils.js'

// M5's reply-state model (Navigation/Design System/Execution Master Plan
// v1.0) -- a presentation-layer mapping over the existing workspace `status`
// + `owner_response` fields, NOT a new data source or a change to how those
// fields get set. Five states, four backed by real, already-existing data:
//
//  - draft:               status is draft_ready or edited (an AI or edited
//                          draft exists, not yet sent) -- real field.
//  - confirmed:            status === 'published' (this app recorded a
//                          successful publish). There is no independent
//                          backend confirmation signal beyond our own
//                          optimistic marking -- this IS the real field.
//  - failed:               status === 'failed' -- real field, unchanged.
//  - externally_replied:   owner_response is populated but this app's
//                          workspace never recorded publishing it -- a
//                          reply exists on Google that didn't come from
//                          here. Computed from two already-real fields.
//  - pending:              INERT STUB. No code path in this app ever sets
//                          status to 'pending_confirmation' -- the real
//                          backend signal for "published, awaiting Google
//                          sync confirmation" doesn't exist yet (Execution
//                          Master Plan v1.0's M5 risk note). This branch
//                          exists only so the 5-state badge model is
//                          complete in the UI now, without fabricating a
//                          confirmation this app can't actually verify.
//                          Never reachable in production today.
//
// `taken_care_of` (an existing 6th, unrelated operational status -- "handled,
// no reply needed") is intentionally NOT one of the 5 reply states; callers
// keep it on its own existing "Done" badge.
//
// M6: extracted from Reviews.jsx (where this was first built) into this
// shared module so Actions.jsx's "Waiting on Confirmation" section (which
// the Execution Master Plan v1.0 explicitly says needs this exact model)
// reuses it instead of duplicating the mapping.
export const REPLY_STATE_META = {
  needs_reply:         { label: 'Needs Reply',         variant: 'danger'  },
  draft:               { label: 'Draft',               variant: 'accent'  },
  confirmed:           { label: 'Confirmed',           variant: 'success' },
  failed:              { label: 'Failed',              variant: 'danger'  },
  externally_replied:  { label: 'Externally Replied',  variant: 'info'    },
  pending:             { label: 'Pending',             variant: 'warning' },
}

// Recovery Milestone 6B, Part 3: reply-state priority, updated after
// Milestone 6A's production diagnostic proved successfully-published
// replies were reappearing as Needs Reply -- the ONLY record of "this app
// published this" was wsEntry (browser localStorage), invisible to any
// other browser/device and to the app itself once cleared. Priority order
// now:
//   1. Google owner_response -- always authoritative. Combined with a live
//      bridge record, it's this app's own publish that's now confirmed
//      (state 'confirmed'); alone, it's a reply this app never recorded
//      making ('externally_replied') -- same distinction the previous
//      version drew from wsEntry alone, now drawn from the durable bridge
//      instead, so it survives a reload/new browser/new device.
//   2. The durable Redis bridge (see dashboard/api/_lib/publishBridgeStore.js)
//      -- proof Google already accepted the reply, even before the next
//      GBP sync writes owner_response locally. Cross-browser/cross-device,
//      unlike wsEntry.
//   3. wsEntry.status === 'published' -- kept as a same-browser fallback
//      for when the bridge itself couldn't be read (Redis unreachable,
//      pre-6B client) rather than removed outright.
//   4/5. failed / draft -- unchanged, but now correctly ONLY reachable when
//      neither of the two authoritative-or-durable signals above says
//      otherwise, so a stale 'failed' or 'draft' workspace entry can never
//      override an actual Google reply or a durable publish record (the
//      exact scenario Milestone 6B Part 11 requires tests for).
//
// `bridgeEntry` is optional (undefined for any caller not yet passing
// bridge data) so every existing call site keeps working unchanged until
// it's updated to pass one.
export function computeReplyState(r, wsEntry, bridgeEntry) {
  const hasBridge = Boolean(bridgeEntry)
  if (r.owner_response) return hasBridge ? 'confirmed' : 'externally_replied'
  if (hasBridge) return 'confirmed'
  if (wsEntry?.status === 'pending_confirmation') return 'pending' // see comment above -- never set
  if (wsEntry?.status === 'failed') return 'failed'
  if (wsEntry?.status === 'published') return 'confirmed'
  if (wsEntry?.status === 'draft_ready' || wsEntry?.status === 'edited') return 'draft'
  return 'needs_reply'
}

// Recovery Milestone 6B, Part 9: true once a review is answered by ANY of
// the three durable-or-authoritative signals (Google's own owner_response,
// the Redis publish bridge, or a same-browser 'published' workspace
// record) -- never by a draft/edited/failed workspace status alone. Used
// to gate AI draft generation (on-demand, prewarm, and -- where technically
// reachable -- batch) so a review that's already answered by any of these
// paths never consumes Anthropic credits preparing another response.
export function isAnsweredReplyState(r, wsEntry, bridgeEntry) {
  return Boolean(r.owner_response) || Boolean(bridgeEntry) || wsEntry?.status === 'published'
}

// Recovery Milestone 4 (Review Reply Inbox + AI Response Quality): the
// Reviews inbox's default queue. "Actionable" = still needs a manager's
// attention -- unanswered (needs_reply), has a prepared-but-not-yet-sent
// draft (draft), or previously failed to publish and needs a retry
// (failed). confirmed/externally_replied are already resolved and belong
// in history/search, not the default working queue.
const ACTIONABLE_STATES = new Set(['needs_reply', 'draft', 'failed'])
export function isActionableReplyState(state) {
  return ACTIONABLE_STATES.has(state)
}

// Filtering UX Cleanup: per-state counts (Needs Reply/Draft/Confirmed/
// Failed/Externally Replied) for Reviews.jsx's status pill row. Takes
// `reviews` as whatever the caller considers "in scope" -- Reviews.jsx
// passes the GLOBALLY-filtered dataset (App.jsx's date/location/brand/star
// filters already applied), never its own further-narrowed local view, so
// these counts answer "how many of each status exist in the current global
// scope," independent of which status pill(s) happen to be selected right
// now. Extracted as a pure function (no React) so it's directly
// unit-testable, mirroring dataUtils.js's computeNextReviewId().
export function computeReplyStateCounts(reviews, ws, bridges) {
  const counts = { needs_reply: 0, draft: 0, confirmed: 0, failed: 0, externally_replied: 0 }
  reviews.forEach(r => {
    const id = reviewId(r)
    const state = computeReplyState(r, ws?.[id], bridges?.[id])
    if (state in counts) counts[state]++
  })
  return counts
}

// Mirrors ai_engine.py's _SERIOUS_KEYWORDS/_SERIOUS_RE and
// dashboard/api/rewrite.js's SERIOUS_KEYWORDS/SERIOUS_RE exactly -- the
// THIRD independent copy of this word-boundary keyword check, kept in sync
// by comment reference the same way the other two already were before this
// milestone. Used only for the Reviews inbox's own "Needs Management
// Review" warning gate (Phase 14) -- never used to generate or alter
// response text, and never a substitute for the deterministic guard those
// two modules already apply to whatever draft text actually gets used.
const SERIOUS_KEYWORDS = [
  'sick', 'ill', 'vomit', 'vomiting', 'food poisoning', 'diarrhea',
  'hospital', 'hospitalized', 'doctor', 'health department', 'health code',
  'cockroach', 'roach', 'rat', 'rats', 'mouse', 'mice', 'rodent', 'rodents',
  'insect', 'insects', 'pest', 'pests',
  'injury', 'injured', 'unsafe', 'accident',
  'discrimination', 'discriminated', 'racist', 'racism', 'harassment', 'harassed',
  'hostile', 'threatening', 'threatened',
  'lawsuit', 'lawyer', 'attorney', 'sue', 'sued', 'legal action',
  'police', 'assault', 'assaulted', 'stole', 'stolen', 'theft',
  'never coming back', 'health violation', 'shut down',
]
const SERIOUS_RE = new RegExp(
  '\\b(' + SERIOUS_KEYWORDS.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
  'i'
)

export function isSeriousReview(r) {
  return SERIOUS_RE.test(r?.review_text || '')
}
