/**
 * Persistence for Action Center task-tracking state (status, assignment,
 * due date, notes, history, and the outcome snapshot used to show whether a
 * completed action actually improved the metric it targeted).
 *
 * This was localStorage-only (per-browser, no real collaboration) until the
 * Action Center Accountability milestone -- this file is exactly the seam
 * its own original header comment called out as swappable, now swapped to
 * dashboard/api/actions/[action].js. useActionWorkspace.js (the only caller)
 * did not need to change its public shape for this: getAll()/setRecord()
 * keep the same signatures, still async, still the only place in the app
 * that touches persistence for this data.
 *
 * Record shape (server-authoritative fields now stamped by
 * dashboard/api/_lib/actionStore.js, never computed here): { id, status,
 * assignedTo, assignedLocation, assignedDepartment, dueDate, notes,
 * outcomeSnapshot, history: [{ at, by, action }], createdBy, createdAt,
 * updatedBy, updatedAt }.
 */

import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

async function handleAuthFailure(res, action) {
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error(`Session expired ${action}`)
  }
}

export async function getAll() {
  const res = await fetch('/api/actions/list')
  await handleAuthFailure(res, 'fetching the action workspace')
  if (!res.ok) throw new Error(`Failed to fetch action workspace: ${res.status}`)
  const { actions } = await res.json()
  return actions ?? {}
}

// Sends the raw patch straight through -- defaulting/merging
// (assignedLocation/dueDate/notes defaults, createdBy/At, updatedBy/At,
// history append) all happen server-side in actionStore.js now, not here.
export async function setRecord(id, patch, logAction) {
  const res = await fetch('/api/actions/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, patch, logAction }),
  })
  await handleAuthFailure(res, `updating action ${id}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `Failed to update action ${id}: ${res.status}`)
  }
  const { record } = await res.json()
  return record
}
