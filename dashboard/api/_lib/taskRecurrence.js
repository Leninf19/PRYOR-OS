// Operations Calendar + Content Library milestone -- pure recurrence
// expansion. One recurring MASTER record is stored (taskStore.js); this
// function expands it into virtual occurrences at read/render time. No
// Redis record is ever created per occurrence -- see the architecture
// plan's explicit "do not create hundreds of Redis records for recurring
// events" requirement.
//
// V1 recurrence shape: { freq: 'daily'|'weekly'|'monthly', interval,
// until }. `until: null` means "never ends" (bounded only by the
// MAX_OCCURRENCES safety cap and the caller's own rangeEnd). Per-occurrence
// overrides ("change only this Wednesday") are out of scope for V1, per the
// approved plan -- every occurrence of a recurring task is identical except
// for its own start/end.
//
// Edge/Node-agnostic (date-fns only) so this can be unit-tested directly
// under plain Node with no Redis/API dependency, same as priorityDigest.js.

import { addDays, addWeeks, addMonths, isBefore, isAfter } from 'date-fns'

const STEP_FN = { daily: addDays, weekly: addWeeks, monthly: addMonths }

// Hard ceiling on how many occurrences a single expansion call will ever
// produce, independent of the requested range -- protects against a
// pathological interval (e.g. daily with no `until`, expanded over a
// multi-year range) turning one calendar render into an unbounded loop.
const MAX_OCCURRENCES = 500

// Returns occurrence objects: the original task's fields spread, plus
// `occurrenceStart`/`occurrenceEnd` (ISO strings) and `isRecurrenceInstance`
// (false for a non-recurring task's own single occurrence). Never mutates
// `task`. `rangeStart`/`rangeEnd` are Date instances (inclusive).
export function expandOccurrences(task, rangeStart, rangeEnd) {
  if (!task?.startAt) return []
  const baseStart = new Date(task.startAt)
  if (Number.isNaN(baseStart.getTime())) return []
  const baseEnd = task.endAt ? new Date(task.endAt) : baseStart
  const durationMs = Math.max(0, baseEnd.getTime() - baseStart.getTime())

  const freq = task.recurrence?.freq
  if (!freq || freq === 'none') {
    if (isAfter(baseStart, rangeEnd) || isBefore(baseEnd, rangeStart)) return []
    return [{
      ...task,
      occurrenceStart: baseStart.toISOString(),
      occurrenceEnd: baseEnd.toISOString(),
      isRecurrenceInstance: false,
    }]
  }

  const stepFn = STEP_FN[freq]
  if (!stepFn) return []
  const interval = Number.isInteger(task.recurrence?.interval) && task.recurrence.interval > 0
    ? task.recurrence.interval : 1
  const untilDate = task.recurrence?.until ? new Date(task.recurrence.until) : null

  const occurrences = []
  let cursor = baseStart
  let count = 0
  while (!isAfter(cursor, rangeEnd) && count < MAX_OCCURRENCES) {
    if (untilDate && isAfter(cursor, untilDate)) break
    const occEnd = new Date(cursor.getTime() + durationMs)
    if (!isBefore(occEnd, rangeStart)) {
      occurrences.push({
        ...task,
        occurrenceStart: cursor.toISOString(),
        occurrenceEnd: occEnd.toISOString(),
        isRecurrenceInstance: true,
      })
    }
    cursor = stepFn(cursor, interval)
    count++
  }
  return occurrences
}

// Convenience: expand a whole task list against the same range, flattened
// and sorted chronologically -- what every calendar view (Month/Week/
// Agenda) and the Today tab actually want.
export function expandAllOccurrences(tasks, rangeStart, rangeEnd) {
  const out = []
  for (const task of tasks) {
    out.push(...expandOccurrences(task, rangeStart, rangeEnd))
  }
  return out.sort((a, b) => new Date(a.occurrenceStart) - new Date(b.occurrenceStart))
}
