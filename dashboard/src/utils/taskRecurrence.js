// Operations Calendar + Content Library milestone -- frontend copy of
// dashboard/api/_lib/taskRecurrence.js's pure expansion logic. Duplicated
// rather than imported (dashboard/api/_lib is a server-only boundary this
// codebase never imports across -- see reviewLocationIndex.js's reviewId()
// vs dataUtils.js's for the same established precedent); any change to the
// expansion rule must be mirrored in both, and test_task_recurrence_ui.js
// asserts the two stay in lockstep.

import { addDays, addWeeks, addMonths, isBefore, isAfter } from 'date-fns'

const STEP_FN = { daily: addDays, weekly: addWeeks, monthly: addMonths }
const MAX_OCCURRENCES = 500

export function expandOccurrences(task, rangeStart, rangeEnd) {
  if (!task?.startAt) return []
  const baseStart = new Date(task.startAt)
  if (Number.isNaN(baseStart.getTime())) return []
  const baseEnd = task.endAt ? new Date(task.endAt) : baseStart
  const durationMs = Math.max(0, baseEnd.getTime() - baseStart.getTime())

  const freq = task.recurrence?.freq
  if (!freq || freq === 'none') {
    if (isAfter(baseStart, rangeEnd) || isBefore(baseEnd, rangeStart)) return []
    return [{ ...task, occurrenceStart: baseStart.toISOString(), occurrenceEnd: baseEnd.toISOString(), isRecurrenceInstance: false }]
  }

  const stepFn = STEP_FN[freq]
  if (!stepFn) return []
  const interval = Number.isInteger(task.recurrence?.interval) && task.recurrence.interval > 0 ? task.recurrence.interval : 1
  const untilDate = task.recurrence?.until ? new Date(task.recurrence.until) : null

  const occurrences = []
  let cursor = baseStart
  let count = 0
  while (!isAfter(cursor, rangeEnd) && count < MAX_OCCURRENCES) {
    if (untilDate && isAfter(cursor, untilDate)) break
    const occEnd = new Date(cursor.getTime() + durationMs)
    if (!isBefore(occEnd, rangeStart)) {
      occurrences.push({ ...task, occurrenceStart: cursor.toISOString(), occurrenceEnd: occEnd.toISOString(), isRecurrenceInstance: true })
    }
    cursor = stepFn(cursor, interval)
    count++
  }
  return occurrences
}

export function expandAllOccurrences(tasks, rangeStart, rangeEnd) {
  const out = []
  for (const task of tasks) out.push(...expandOccurrences(task, rangeStart, rangeEnd))
  return out.sort((a, b) => new Date(a.occurrenceStart) - new Date(b.occurrenceStart))
}
