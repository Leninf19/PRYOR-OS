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
