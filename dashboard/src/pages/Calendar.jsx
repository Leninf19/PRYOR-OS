import { useEffect, useMemo, useState } from 'react'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Tabs from '../components/ui/Tabs.jsx'
import Modal from '../components/ui/Modal.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import ErrorState from '../components/ui/ErrorState.jsx'
import { useAccount } from '../components/AuthGate.jsx'
import { useAccounts } from '../hooks/useAccounts.js'
import { useTasks } from '../hooks/useTasks.js'
import { useCampaigns } from '../hooks/useContentLibrary.js'
import { usePriorityDigest } from '../hooks/usePriorityDigest.js'
import { useMeta } from '../hooks/useIntelligence.js'
import { expandOccurrences, expandAllOccurrences } from '../utils/taskRecurrence.js'

// Operations Calendar + Content Library milestone -- replaces the old
// AI-bucket-heavy Actions page. Every task/event here comes from the new
// taskStore.js (api/tasks/[action].js), a store completely separate from
// the existing AI Action Center pipeline (actionStore.js/action-center.json,
// unchanged) -- AI recommendations surface below as read-only Suggestions,
// converted into real tasks only on explicit user action (Create Task).

const TASK_TYPE_META = {
  promotion:         { icon: '🎉', label: 'Promotion' },
  social_media:      { icon: '📱', label: 'Social Media' },
  review_assignment: { icon: '💬', label: 'Review Assignment' },
  operations:        { icon: '🛠',  label: 'Operations' },
  website:           { icon: '🌐', label: 'Website' },
  meeting:           { icon: '👥', label: 'Meeting' },
  holiday:           { icon: '🏖',  label: 'Holiday' },
  deadline:          { icon: '⏰', label: 'Deadline' },
  other:             { icon: '•',  label: 'Other' },
}
const TASK_TYPES = Object.keys(TASK_TYPE_META)
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']
const STATUSES = ['Scheduled', 'In Progress', 'Completed', 'Cancelled']
const PRIORITY_VARIANT = { Critical: 'danger', High: 'warning', Medium: 'info', Low: 'neutral' }
const STATUS_VARIANT = { Scheduled: 'neutral', 'In Progress': 'accent', Completed: 'success', Cancelled: 'neutral' }

function fmtDateTime(iso, allDay) {
  if (!iso) return '—'
  const d = new Date(iso)
  return allDay
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function locationLabel(locationIds, metaLocations) {
  if (locationIds === '*') return 'All locations'
  if (!Array.isArray(locationIds) || !metaLocations) return '—'
  const names = locationIds.map(id => metaLocations.find(l => l.locationId === id)?.name).filter(Boolean)
  if (names.length === 0) return `${locationIds.length} location(s)`
  if (names.length <= 2) return names.join(', ')
  return `${names[0]} +${names.length - 1} more`
}

function assigneeLabel(assignee, accounts) {
  if (!assignee) return 'Unassigned'
  if (assignee.role) return assignee.role.replace(/_/g, ' ')
  const acc = accounts?.find(a => a.userId === assignee.userId)
  return acc?.displayName ?? acc?.email ?? assignee.userId
}

function LocationChip({ children }) {
  return (
    <span className="text-[10px] font-medium px-2 py-0.5 rounded-full"
          style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}>
      {children}
    </span>
  )
}

// ── Task row (shared by Today / Agenda / All Tasks) ─────────────────────────

function TaskRow({ occ, accounts, metaLocations, onOpen, onQuickComplete }) {
  const meta = TASK_TYPE_META[occ.type] ?? TASK_TYPE_META.other
  const isDone = occ.status === 'Completed' || occ.status === 'Cancelled'
  return (
    <div className="flex items-start gap-3 py-3 px-4 border-b last:border-0 cursor-pointer hover:bg-[var(--color-surface-2)]"
         style={{ borderColor: 'var(--color-border)' }} onClick={() => onOpen(occ)}>
      <span className="text-base flex-shrink-0 w-6 text-center mt-0.5" aria-hidden="true">{meta.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)', textDecoration: isDone ? 'line-through' : 'none' }}>
            {occ.title}
          </p>
          <Badge variant={PRIORITY_VARIANT[occ.priority] ?? 'neutral'}>{occ.priority}</Badge>
          <Badge variant={STATUS_VARIANT[occ.status] ?? 'neutral'}>{occ.status}</Badge>
        </div>
        <div className="flex items-center gap-2 flex-wrap mt-1">
          <LocationChip>{locationLabel(occ.locationIds, metaLocations)}</LocationChip>
          <span className="text-[11px]" style={{ color: 'var(--color-text-3)' }}>{assigneeLabel(occ.assignee, accounts)}</span>
          <span className="text-[11px]" style={{ color: 'var(--color-text-3)' }}>{fmtDateTime(occ.occurrenceStart ?? occ.startAt, occ.allDay)}</span>
          {occ.reviewProgress && (
            <span className="text-[11px] font-medium" style={{ color: 'var(--color-accent)' }}>
              {occ.reviewProgress.completed} / {occ.reviewProgress.total} completed
            </span>
          )}
        </div>
      </div>
      {!isDone && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onQuickComplete(occ) }}
                className="text-[11px] font-semibold px-2.5 py-1 rounded-lg flex-shrink-0"
                style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)' }}>
          Complete
        </button>
      )}
    </div>
  )
}

// ── Task form (Add Task / Add Event / Create Task from a Suggestion) ───────

// Re-mounted (via the `key={initial?.__seed}` the caller passes) every time
// a genuinely different seed is opened -- Add Task, Add Event, editing an
// existing task, and Create Task from a suggestion each produce a fresh
// `__seed`, so this component's own `form` state always starts from the
// right values instead of stale state left over from whichever seed opened
// it last. `initial` can be null before the modal has ever been opened
// once (Calendar's own formSeed starts null) -- render nothing rather than
// dereference it.
function TaskFormModal({ open, onClose, initial, onSubmit, metaLocations, accounts, campaigns, saving, error }) {
  const [form, setForm] = useState(() => initial)
  if (!form) return null
  const set = (patch) => setForm(f => ({ ...f, ...patch }))

  function toggleLocation(id) {
    const current = Array.isArray(form.locationIds) ? form.locationIds : []
    set({ locationIds: current.includes(id) ? current.filter(x => x !== id) : [...current, id] })
  }

  function submit(e) {
    e.preventDefault()
    onSubmit(form)
  }

  return (
    <Modal open={open} onClose={onClose} title={initial?.id ? 'Edit Task' : 'New Task'} size="lg"
           footer={(
             <div className="flex justify-end gap-2">
               <button type="button" onClick={onClose} className="text-sm px-4 py-2 rounded-lg" style={{ color: 'var(--color-text-2)' }}>Cancel</button>
               <button type="submit" form="task-form" disabled={saving}
                       className="text-sm font-semibold px-4 py-2 rounded-lg text-white"
                       style={{ background: 'var(--color-accent)', opacity: saving ? 0.6 : 1 }}>
                 {saving ? 'Saving…' : 'Save Task'}
               </button>
             </div>
           )}>
      <form id="task-form" onSubmit={submit} className="space-y-4">
        {error && <div className="text-xs p-2 rounded-lg" style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}>{error}</div>}

        <div>
          <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Title</label>
          <input required value={form.title ?? ''} onChange={e => set({ title: e.target.value })}
                 className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }} />
        </div>

        <div>
          <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Description</label>
          <textarea value={form.description ?? ''} onChange={e => set({ description: e.target.value })} rows={2}
                    className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Type</label>
            <select value={form.type} onChange={e => set({ type: e.target.value })}
                    className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
              {TASK_TYPES.map(t => <option key={t} value={t}>{TASK_TYPE_META[t].label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Priority</label>
            <select value={form.priority ?? 'Medium'} onChange={e => set({ priority: e.target.value })}
                    className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
              {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Locations</label>
          <div className="flex flex-wrap gap-1.5">
            {(metaLocations ?? []).map(l => (
              <button key={l.locationId} type="button" onClick={() => toggleLocation(l.locationId)}
                      className="text-xs px-2.5 py-1 rounded-full border"
                      style={Array.isArray(form.locationIds) && form.locationIds.includes(l.locationId)
                        ? { background: 'var(--color-accent-lt)', color: 'var(--color-accent)', borderColor: 'var(--color-accent-md)' }
                        : { color: 'var(--color-text-2)', borderColor: 'var(--color-border)' }}>
                {l.name}
              </button>
            ))}
          </div>
          <p className="text-[10px] mt-1" style={{ color: 'var(--color-text-3)' }}>
            Server-authorized: you can only assign locations within your own access.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Start</label>
            <input required type={form.allDay ? 'date' : 'datetime-local'} value={form.startAt ?? ''}
                   onChange={e => set({ startAt: e.target.value })}
                   className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }} />
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Due / End</label>
            <input type={form.allDay ? 'date' : 'datetime-local'} value={form.endAt ?? ''}
                   onChange={e => set({ endAt: e.target.value })}
                   className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }} />
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-2)' }}>
          <input type="checkbox" checked={Boolean(form.allDay)} onChange={e => set({ allDay: e.target.checked })} />
          All-day
        </label>

        <div>
          <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Assignee</label>
          <select value={form.assignee?.userId ?? ''} onChange={e => set({ assignee: e.target.value ? { userId: e.target.value } : null })}
                  className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
            <option value="">Unassigned</option>
            {(accounts ?? []).map(a => <option key={a.userId} value={a.userId}>{a.displayName ?? a.email}</option>)}
          </select>
        </div>

        <div>
          <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Recurrence</label>
          <select value={form.recurrence?.freq ?? 'none'}
                  onChange={e => set({ recurrence: e.target.value === 'none' ? null : { freq: e.target.value, interval: 1, until: null } })}
                  className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
            <option value="none">Does not repeat</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
          {form.recurrence && (
            <div className="mt-2">
              <label className="text-[11px]" style={{ color: 'var(--color-text-3)' }}>Ends</label>
              <input type="date" value={form.recurrence.until ?? ''}
                     onChange={e => set({ recurrence: { ...form.recurrence, until: e.target.value || null } })}
                     className="w-full text-sm px-3 py-1.5 rounded-lg border mt-1" style={{ borderColor: 'var(--color-border)' }} />
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--color-text-3)' }}>Leave blank for "never".</p>
            </div>
          )}
        </div>

        {form.type === 'review_assignment' && (
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Review IDs (comma-separated)</label>
            <input value={(form.relatedReviewIds ?? []).join(', ')}
                   onChange={e => set({ relatedReviewIds: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                   className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }} />
            <p className="text-[10px] mt-1" style={{ color: 'var(--color-text-3)' }}>
              Every review is cross-checked server-side against your authorized locations.
            </p>
          </div>
        )}

        {(form.type === 'promotion' || form.type === 'social_media') && (
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Campaign (optional)</label>
            <select value={form.campaignId ?? ''} onChange={e => set({ campaignId: e.target.value || null })}
                    className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
              <option value="">None</option>
              {(campaigns ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        <div>
          <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--color-text-2)' }}>Internal notes</label>
          <textarea value={form.notes ?? ''} onChange={e => set({ notes: e.target.value })} rows={2}
                    className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--color-border)' }} />
        </div>
      </form>
    </Modal>
  )
}

function emptyTaskForm(overrides = {}) {
  return {
    __seed: Math.random(),
    title: '', description: '', type: 'operations', locationIds: [], assignee: null,
    startAt: '', endAt: '', allDay: false, priority: 'Medium', status: 'Scheduled',
    recurrence: null, notes: '', relatedReviewIds: [], campaignId: null, sourceActionId: null,
    ...overrides,
  }
}

// ── Task detail modal ───────────────────────────────────────────────────────

function TaskDetailModal({ task, onClose, onComplete, onDelete, accounts, metaLocations }) {
  if (!task) return null
  const meta = TASK_TYPE_META[task.type] ?? TASK_TYPE_META.other
  return (
    <Modal open={Boolean(task)} onClose={onClose} title={`${meta.icon} ${task.title}`} size="md">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge variant={PRIORITY_VARIANT[task.priority]}>{task.priority}</Badge>
          <Badge variant={STATUS_VARIANT[task.status]}>{task.status}</Badge>
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{meta.label}</span>
        </div>
        {task.description && <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>{task.description}</p>}
        <div className="text-xs space-y-1" style={{ color: 'var(--color-text-3)' }}>
          <p>Location: {locationLabel(task.locationIds, metaLocations)}</p>
          <p>Assignee: {assigneeLabel(task.assignee, accounts)}</p>
          <p>Due: {fmtDateTime(task.occurrenceStart ?? task.startAt, task.allDay)}</p>
        </div>
        {task.notes && (
          <div className="text-xs p-2 rounded-lg" style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}>
            {task.notes}
          </div>
        )}
        {task.reviewProgress && (
          <div className="text-sm font-medium" style={{ color: 'var(--color-accent)' }}>
            {task.reviewProgress.completed} / {task.reviewProgress.total} completed
          </div>
        )}
        <div className="flex flex-wrap gap-2 pt-2">
          {task.type === 'review_assignment' && task.relatedReviewIds?.length > 0 && (
            <Link to={`/reviews?reviewId=${encodeURIComponent(task.relatedReviewIds[0])}`}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg text-white" style={{ background: 'var(--color-accent)' }}>
              Start Reviews →
            </Link>
          )}
          {task.campaignId && (
            <Link to={`/content?campaignId=${encodeURIComponent(task.campaignId)}`}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg" style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}>
              View Campaign Assets →
            </Link>
          )}
          {task.status !== 'Completed' && task.status !== 'Cancelled' && (
            <button type="button" onClick={() => onComplete(task)}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg" style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)' }}>
              Mark Complete
            </button>
          )}
          <button type="button" onClick={() => onDelete(task)}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg" style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}>
            Delete
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── AI Suggestions (collapsed by default) ───────────────────────────────────

const SUGGESTION_TYPE_HINT = {
  'Operations Impact': 'operations', 'Action Center': 'operations',
  'Predictive Alerts': 'deadline', 'Trend Alerts': 'deadline',
  'My Overdue Tasks': 'deadline', 'Restaurant Follow-Up': 'review_assignment',
}

function AISuggestionsDrawer({ digest, isLoading, onCreateFromSuggestion }) {
  const [open, setOpen] = useState(false)
  const items = digest?.topPriorities ?? []
  return (
    <Card className="overflow-hidden">
      <button type="button" onClick={() => setOpen(o => !o)}
              className="w-full flex items-center justify-between px-5 py-4 text-left"
              aria-expanded={open} aria-controls="calendar-ai-suggestions">
        <h2 className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>
          ✦ AI Suggestions{items.length > 0 ? ` (${items.length})` : ''}
        </h2>
        <svg className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      {open && (
        <div id="calendar-ai-suggestions" className="px-5 pb-5">
          <p className="text-xs mb-3" style={{ color: 'var(--color-text-3)' }}>
            From the existing AI Action Center pipeline -- suggestions only. Nothing here becomes a real task until you confirm.
          </p>
          {isLoading ? (
            <div className="space-y-2">{[1, 2].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
          ) : items.length === 0 ? (
            <p className="text-xs italic" style={{ color: 'var(--color-text-3)' }}>No open AI suggestions right now.</p>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
              {items.map(item => (
                <div key={item.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: 'var(--color-text-1)' }}>{item.title}</p>
                    <p className="text-xs truncate" style={{ color: 'var(--color-text-3)' }}>{item.explanation}</p>
                  </div>
                  <button type="button" onClick={() => onCreateFromSuggestion(item)}
                          className="text-xs font-semibold px-3 py-1.5 rounded-lg flex-shrink-0"
                          style={{ background: 'var(--color-accent-lt)', color: 'var(--color-accent)' }}>
                    Create Task
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

// ── Month / Week / Agenda views ─────────────────────────────────────────────

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()) }

function MonthView({ occurrences, onOpen, cursor }) {
  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const gridStart = new Date(monthStart)
  gridStart.setDate(gridStart.getDate() - gridStart.getDay())
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart)
    d.setDate(d.getDate() + i)
    return d
  })
  const byDay = {}
  for (const occ of occurrences) {
    const key = startOfDay(new Date(occ.occurrenceStart)).toDateString()
    ;(byDay[key] ??= []).push(occ)
  }

  return (
    <div className="grid grid-cols-7 gap-1.5">
      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
        <div key={d} className="text-[10px] font-bold uppercase tracking-wider text-center py-1" style={{ color: 'var(--color-text-3)' }}>{d}</div>
      ))}
      {days.map((d, i) => {
        const inMonth = d.getMonth() === cursor.getMonth()
        const dayOccs = byDay[d.toDateString()] ?? []
        const isToday = d.toDateString() === new Date().toDateString()
        return (
          <div key={i} className="rounded-lg p-1.5 min-h-[84px]"
               style={{ background: inMonth ? 'var(--color-surface)' : 'var(--color-surface-2)', border: isToday ? '2px solid var(--color-accent)' : '1px solid var(--color-border)', opacity: inMonth ? 1 : 0.5 }}>
            <p className="text-[10px] font-semibold mb-1" style={{ color: 'var(--color-text-3)' }}>{d.getDate()}</p>
            <div className="space-y-0.5">
              {dayOccs.slice(0, 3).map((occ, j) => (
                <button key={j} type="button" onClick={() => onOpen(occ)}
                        className="w-full text-left text-[10px] px-1 py-0.5 rounded truncate block"
                        style={{ background: 'var(--color-accent-lt)', color: 'var(--color-accent)' }}>
                  {TASK_TYPE_META[occ.type]?.icon} {occ.title}
                </button>
              ))}
              {dayOccs.length > 3 && <p className="text-[9px]" style={{ color: 'var(--color-text-3)' }}>+{dayOccs.length - 3} more</p>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function WeekView({ occurrences, onOpen, cursor }) {
  const weekStart = new Date(cursor)
  weekStart.setDate(weekStart.getDate() - weekStart.getDay())
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return d })
  const byDay = {}
  for (const occ of occurrences) {
    const key = startOfDay(new Date(occ.occurrenceStart)).toDateString()
    ;(byDay[key] ??= []).push(occ)
  }
  return (
    <div className="grid grid-cols-7 gap-2">
      {days.map((d, i) => {
        const isToday = d.toDateString() === new Date().toDateString()
        return (
          <div key={i} className="rounded-xl p-2 min-h-[220px]" style={{ background: 'var(--color-surface)', border: isToday ? '2px solid var(--color-accent)' : '1px solid var(--color-border)' }}>
            <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--color-text-3)' }}>
              {d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' })}
            </p>
            <div className="space-y-1">
              {(byDay[d.toDateString()] ?? []).map((occ, j) => (
                <button key={j} type="button" onClick={() => onOpen(occ)}
                        className="w-full text-left text-[11px] px-1.5 py-1 rounded-lg truncate block"
                        style={{ background: 'var(--color-accent-lt)', color: 'var(--color-accent)' }}>
                  {TASK_TYPE_META[occ.type]?.icon} {occ.title}
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function AgendaView({ occurrences, onOpen, accounts, metaLocations, onQuickComplete }) {
  if (occurrences.length === 0) return <EmptyState icon="📅" title="Nothing scheduled" body="No tasks or events in this range." />
  const byDay = {}
  for (const occ of occurrences) {
    const key = startOfDay(new Date(occ.occurrenceStart)).toDateString()
    ;(byDay[key] ??= []).push(occ)
  }
  return (
    <div className="space-y-4">
      {Object.entries(byDay).map(([day, occs]) => (
        <div key={day}>
          <p className="text-xs font-bold mb-1.5" style={{ color: 'var(--color-text-2)' }}>
            {new Date(day).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          <Card className="overflow-hidden">
            {occs.map((occ, i) => (
              <TaskRow key={i} occ={occ} accounts={accounts} metaLocations={metaLocations} onOpen={onOpen} onQuickComplete={onQuickComplete} />
            ))}
          </Card>
        </div>
      ))}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function CalendarPage() {
  const { allReviews = [], filtered = [], prevFiltered = [] } = useOutletContext() ?? {}
  const account = useAccount()
  const [searchParams] = useSearchParams()
  const { data: meta } = useMeta()
  const { data: accounts } = useAccounts()
  const { campaigns } = useCampaigns()
  const { tasks, isLoading, isError, createTask, updateTask, deleteTask, isCreating, createError } = useTasks()
  const { data: digest, isLoading: digestLoading } = usePriorityDigest(filtered, prevFiltered, allReviews)

  const [tab, setTab] = useState('today')
  const [calView, setCalView] = useState('month')
  const [cursor, setCursor] = useState(new Date())
  const [formOpen, setFormOpen] = useState(false)
  const [formSeed, setFormSeed] = useState(null)
  const [detailTask, setDetailTask] = useState(null)
  const [filters, setFilters] = useState({ location: '', assignee: '', type: '', status: '', priority: '' })
  const [search, setSearch] = useState('')

  // Owner/Admin/Marketing always hold TASK_CREATE server-side; a location
  // manager needs canCreateTasks -- this client-side check only decides
  // whether to SHOW the button, never the actual authorization (the server
  // re-checks canCreateTask() on every POST /api/tasks/create).
  const canCreate = ['owner', 'admin', 'marketing'].includes(account?.role) || Boolean(account?.canCreateTasks)

  const rangeOccurrences = useMemo(() => {
    const rangeStart = calView === 'month'
      ? new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1)
      : new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 7)
    const rangeEnd = calView === 'month'
      ? new Date(cursor.getFullYear(), cursor.getMonth() + 2, 0)
      : new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 35)
    return expandAllOccurrences(tasks, rangeStart, rangeEnd)
  }, [tasks, cursor, calView])

  const todayOccurrences = useMemo(() => {
    const now = new Date()
    const dayStart = startOfDay(now)
    const dayEnd = new Date(dayStart.getTime() + 86_400_000 - 1)
    const dueTodayOrOverdue = expandAllOccurrences(tasks, new Date(0), dayEnd)
      .filter(o => o.status !== 'Completed' && o.status !== 'Cancelled')
    return dueTodayOrOverdue
  }, [tasks])

  function openCreateForm(seed) { setFormSeed(seed ?? emptyTaskForm()); setFormOpen(true) }
  function openEditForm(task) {
    setFormSeed(emptyTaskForm({ ...task, assignee: task.assignee }))
    setFormOpen(true)
  }

  async function handleSubmit(form) {
    const payload = {
      title: form.title, description: form.description, type: form.type,
      locationIds: form.locationIds.length ? form.locationIds : (account?.locationIds === '*' ? '*' : form.locationIds),
      assignee: form.assignee, startAt: new Date(form.startAt).toISOString(),
      endAt: form.endAt ? new Date(form.endAt).toISOString() : null,
      allDay: form.allDay, priority: form.priority, status: form.status ?? 'Scheduled',
      recurrence: form.recurrence, notes: form.notes,
      relatedReviewIds: form.relatedReviewIds, campaignId: form.campaignId, sourceActionId: form.sourceActionId,
    }
    try {
      if (form.id) await updateTask(form.id, payload)
      else await createTask(payload)
      setFormOpen(false)
    } catch {
      // createError/updateTask surface their own message via the mutation state
    }
  }

  function handleCreateFromSuggestion(item) {
    const type = SUGGESTION_TYPE_HINT[item.sourceLabel] ?? 'other'
    openCreateForm(emptyTaskForm({
      title: item.title, description: item.explanation,
      type, priority: item.severity === 'critical' ? 'Critical' : item.severity === 'high' ? 'High' : 'Medium',
      startAt: new Date().toISOString().slice(0, 16), sourceActionId: item.id,
    }))
  }

  async function handleComplete(task) {
    await updateTask(task.id, { status: 'Completed' }, 'Marked complete')
    setDetailTask(null)
  }
  async function handleDelete(task) {
    await deleteTask(task.id)
    setDetailTask(null)
  }

  const filteredAllTasks = useMemo(() => {
    return tasks.filter(t => {
      if (search && !t.title.toLowerCase().includes(search.toLowerCase())) return false
      if (filters.type && t.type !== filters.type) return false
      if (filters.status && t.status !== filters.status) return false
      if (filters.priority && t.priority !== filters.priority) return false
      if (filters.location) {
        const id = Number(filters.location)
        if (t.locationIds !== '*' && !(t.locationIds ?? []).includes(id)) return false
      }
      if (filters.assignee && t.assignee?.userId !== filters.assignee) return false
      return true
    }).map(t => ({ ...t, occurrenceStart: t.startAt }))
  }, [tasks, search, filters])

  // Deep link from the Notification Center (task_due/task_overdue ->
  // /calendar?taskId=...) -- opens the detail modal once the task list has
  // loaded, without ever fetching a single task by id client-side (the
  // task must already be in the account's own authorized `tasks` list).
  const deepLinkTaskId = searchParams.get('taskId')
  useEffect(() => {
    if (!deepLinkTaskId || isLoading) return
    const match = tasks.find(t => t.id === deepLinkTaskId)
    if (match) setDetailTask({ ...match, occurrenceStart: match.startAt })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkTaskId, isLoading, tasks.length])

  if (isError) return <ErrorState body="Couldn't load the calendar." />

  return (
    <div className="space-y-5 max-w-[1200px]">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Calendar</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>Tasks, promotions, and review assignments across your locations</p>
        </div>
        {canCreate && (
          <div className="flex gap-2">
            <button type="button" onClick={() => openCreateForm(emptyTaskForm({ type: 'operations' }))}
                    className="text-sm font-semibold px-4 py-2 rounded-lg text-white" style={{ background: 'var(--color-accent)' }}>
              + Add Task
            </button>
            <button type="button" onClick={() => openCreateForm(emptyTaskForm({ type: 'meeting', allDay: false }))}
                    className="text-sm font-semibold px-4 py-2 rounded-lg" style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}>
              + Add Event
            </button>
          </div>
        )}
      </div>

      <Tabs tabs={[{ id: 'today', label: 'Today' }, { id: 'calendar', label: 'Calendar' }, { id: 'all', label: 'All Tasks' }]} value={tab} onChange={setTab} />

      {tab === 'today' && (
        <>
          <Card className="overflow-hidden">
            {isLoading ? (
              <div className="p-4 space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
            ) : todayOccurrences.length === 0 ? (
              <div className="p-4"><EmptyState icon="✅" title="Nothing due today" body="No overdue or due-today tasks, promotions, or review assignments." /></div>
            ) : (
              todayOccurrences.map((occ, i) => (
                <TaskRow key={i} occ={occ} accounts={accounts} metaLocations={meta?.locations} onOpen={setDetailTask} onQuickComplete={handleComplete} />
              ))
            )}
          </Card>
          <AISuggestionsDrawer digest={digest} isLoading={digestLoading} onCreateFromSuggestion={handleCreateFromSuggestion} />
        </>
      )}

      {tab === 'calendar' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <Tabs tabs={[{ id: 'month', label: 'Month' }, { id: 'week', label: 'Week' }, { id: 'agenda', label: 'Agenda' }]} value={calView} onChange={setCalView} size="sm" />
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setCursor(new Date())} className="text-xs font-medium px-2 py-1 rounded-lg" style={{ color: 'var(--color-accent)' }}>Today</button>
              <span className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>
                {cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
              </span>
            </div>
          </div>
          {isLoading ? <Skeleton className="h-96 w-full" /> : calView === 'month' ? (
            <MonthView occurrences={rangeOccurrences} onOpen={setDetailTask} cursor={cursor} />
          ) : calView === 'week' ? (
            <WeekView occurrences={rangeOccurrences} onOpen={setDetailTask} cursor={cursor} />
          ) : (
            <AgendaView occurrences={rangeOccurrences} onOpen={setDetailTask} accounts={accounts} metaLocations={meta?.locations} onQuickComplete={handleComplete} />
          )}
        </div>
      )}

      {tab === 'all' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 items-center">
            <input placeholder="Search tasks…" value={search} onChange={e => setSearch(e.target.value)}
                   className="text-sm px-3 py-1.5 rounded-lg border" style={{ borderColor: 'var(--color-border)' }} />
            <select value={filters.location} onChange={e => setFilters(f => ({ ...f, location: e.target.value }))}
                    className="text-xs px-2 py-1.5 rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
              <option value="">All locations</option>
              {(meta?.locations ?? []).map(l => <option key={l.locationId} value={l.locationId}>{l.name}</option>)}
            </select>
            <select value={filters.type} onChange={e => setFilters(f => ({ ...f, type: e.target.value }))}
                    className="text-xs px-2 py-1.5 rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
              <option value="">All types</option>
              {TASK_TYPES.map(t => <option key={t} value={t}>{TASK_TYPE_META[t].label}</option>)}
            </select>
            <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
                    className="text-xs px-2 py-1.5 rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
              <option value="">All statuses</option>
              {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={filters.priority} onChange={e => setFilters(f => ({ ...f, priority: e.target.value }))}
                    className="text-xs px-2 py-1.5 rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
              <option value="">All priorities</option>
              {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <Card className="overflow-hidden">
            {filteredAllTasks.length === 0 ? (
              <div className="p-4"><EmptyState icon="🔍" title="No tasks match" body="Try widening your filters." /></div>
            ) : (
              filteredAllTasks.map(t => (
                <TaskRow key={t.id} occ={t} accounts={accounts} metaLocations={meta?.locations} onOpen={openEditForm} onQuickComplete={handleComplete} />
              ))
            )}
          </Card>
        </div>
      )}

      {/* key={formSeed?.__seed}: forces a full remount (fresh internal
          `form` state) every time a genuinely different seed is opened --
          Add Task, Add Event, edit, and Create Task from a suggestion each
          carry their own unique __seed, so the form never shows stale
          values left over from whichever seed opened it previously. */}
      <TaskFormModal key={formSeed?.__seed ?? 'empty'} open={formOpen} onClose={() => setFormOpen(false)} initial={formSeed} onSubmit={handleSubmit}
                     metaLocations={meta?.locations} accounts={accounts} campaigns={campaigns} saving={isCreating} error={createError} />
      <TaskDetailModal task={detailTask} onClose={() => setDetailTask(null)} onComplete={handleComplete} onDelete={handleDelete}
                        accounts={accounts} metaLocations={meta?.locations} />
    </div>
  )
}
