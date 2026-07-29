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

export function computeReplyState(r, wsEntry) {
  if (wsEntry?.status === 'pending_confirmation') return 'pending' // see comment above -- never set
  if (wsEntry?.status === 'failed') return 'failed'
  if (wsEntry?.status === 'published') return 'confirmed'
  if (r.owner_response) return 'externally_replied'
  if (wsEntry?.status === 'draft_ready' || wsEntry?.status === 'edited') return 'draft'
  return 'needs_reply'
}
