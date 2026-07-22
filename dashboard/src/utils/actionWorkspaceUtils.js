// Shared overdue logic for Action Center task-workspace entries -- used by
// both ActionCenter.jsx's own Overdue filter and
// usePriorityDigest.js's "assigned to you and overdue" signal in the
// Executive Intelligence Center, so a task can never show as overdue in one
// place and not the other.

// A task counts as "open" (still owed work) unless it's been Completed or
// explicitly Dismissed.
export const OPEN_STATUSES = new Set(['New', 'Assigned', 'In Progress', 'Monitoring'])

export function todayISODate() {
  return new Date().toISOString().slice(0, 10)
}

export function isOverdue(entry) {
  if (!entry?.dueDate || !OPEN_STATUSES.has(entry.status ?? 'New')) return false
  return entry.dueDate < todayISODate()
}

// Restaurant bad-review email workflow (recovery-audit milestone) -- shared
// between ReviewExplorer.jsx (the send/status display) and ActionCenter.jsx
// (the email-thread card + manual replied/follow_up_required/resolved
// controls), so both surfaces agree on labels/colors and on which prior
// states are open/overdue-eligible.
export const EMAIL_STATUS_META = {
  not_sent:           { label: 'Not Sent',            variant: 'neutral' },
  sent:               { label: 'Sent',                variant: 'info' },
  replied:            { label: 'Replied',             variant: 'success' },
  follow_up_required: { label: 'Follow-Up Required',  variant: 'warning' },
  resolved:           { label: 'Resolved',             variant: 'success' },
  failed:             { label: 'Send Failed',          variant: 'danger' },
}

// A record in one of these states already has a real outgoing email in
// flight -- sending again requires the explicit resend confirmation.
export const DUPLICATE_EMAIL_STATUSES = new Set(['sent', 'replied', 'follow_up_required', 'resolved'])

// Prior states a manual replied/follow_up_required/resolved transition may
// start from -- mirrors dashboard/api/actions/[action].js's
// TRANSITIONABLE_EMAIL_STATUSES exactly (kept as a literal duplicate across
// the frontend/backend boundary, same tradeoff as this file's other
// constants).
export const EMAIL_STATUS_TRANSITIONABLE_FROM = new Set(['sent', 'replied', 'follow_up_required', 'resolved'])

// An email thread still needs attention unless it's been resolved --
// used by the Action Center card to decide whether to keep surfacing it,
// and (paired with a follow-up due date) by the Executive Intelligence
// Center's follow-up priority source.
export function isEmailFollowUpOverdue(entry) {
  if (!entry?.emailFollowUpDueAt) return false
  if (entry.emailStatus !== 'sent' && entry.emailStatus !== 'follow_up_required') return false
  return entry.emailFollowUpDueAt < todayISODate()
}
