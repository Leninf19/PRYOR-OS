/**
 * Persistence for Action Center task-tracking state (status, assignment,
 * due date, notes, and the outcome snapshot used to show whether a
 * completed action actually improved the metric it targeted) -- same
 * localStorage-today / swappable-later pattern as reviewWorkspaceService.js.
 *
 * Record shape: { status, assignedLocation, assignedDepartment, dueDate,
 *                 notes, history: [{ at, action }],
 *                 outcomeSnapshot: { count, pct, capturedAt } | null }
 */

const WS_KEY = 'action_workspace_v1'

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
    // localStorage unavailable -- state stays in-memory for this session
  }
}

export async function getAll() {
  return load()
}

export async function setRecord(id, patch, logAction) {
  const state = load()
  const prevRecord = state[id] ?? {}
  const history = prevRecord.history ?? []
  const nextRecord = {
    assignedLocation: null,
    assignedDepartment: null,
    dueDate: null,
    notes: '',
    outcomeSnapshot: null,
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
