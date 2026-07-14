/**
 * Persistence for per-review workspace state (status, draft edits, internal
 * notes, assignment, response history) -- currently backed by localStorage
 * since this app has no backend/auth yet. Every function here is async-shaped
 * (returns a Promise) even though today's implementation resolves
 * synchronously, so the hook that wraps this (useReviewWorkspace.js) can be
 * swapped to a real API/DB later by editing only this file -- no component
 * that calls useReviewWorkspace() needs to change.
 *
 * Record shape: { status, editedDraft, publishedAt, failReason,
 *                 notes, assignedTo, history: [{ at, action }] }
 */

const WS_KEY = 'review_workspace_v1'

function load() {
  try {
    return JSON.parse(localStorage.getItem(WS_KEY) || '{}')
  } catch {
    return {}
  }
}

function save(state) {
  try {
    localStorage.setItem(WS_KEY, JSON.stringify(state))
  } catch {
    // localStorage unavailable (private browsing quota, etc.) -- state stays in-memory for this session
  }
}

export async function getAll() {
  return load()
}

/**
 * Merges `patch` into the record for `id`. Pass `logAction` (a short
 * human-readable string) to also append a timestamped history entry --
 * omit it for high-frequency writes (e.g. per-keystroke draft edits) that
 * shouldn't spam the response-history log.
 */
export async function setRecord(id, patch, logAction) {
  const state = load()
  const prevRecord = state[id] ?? {}
  const history = prevRecord.history ?? []
  const nextRecord = {
    notes: '',
    assignedTo: null,
    ...prevRecord,
    ...patch,
    history: logAction
      ? [...history, { at: new Date().toISOString(), action: logAction }]
      : history,
  }
  const next = { ...state, [id]: nextRecord }
  save(next)
  return next
}
