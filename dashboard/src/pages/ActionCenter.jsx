import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import ErrorState from '../components/ui/ErrorState.jsx'
import Tabs from '../components/ui/Tabs.jsx'
import { useActionCenter, useComplaintIntel } from '../hooks/useIntelligence.js'
import { useActionWorkspace } from '../hooks/useActionWorkspace.js'
import { getUniqueLocations } from '../utils/dataUtils.js'

const PRIORITY_VARIANT = { Critical: 'danger', High: 'danger', Medium: 'warning', Low: 'neutral' }
const TYPE_ICON = { operational: '🛠', marketing: '📣', recognition: '⭐' }
const IMPACT_COLOR = { High: 'var(--color-success)', Medium: 'var(--color-grade-c)', Low: 'var(--color-text-3)' }

const TABS = ['All', 'Critical', 'High', 'Medium', 'Low']

const DEPARTMENTS = [
  'Kitchen', 'Service', 'Bar', 'Management', 'Host', 'Carryout', 'Delivery',
  'Cleanliness', 'Bathrooms', 'Atmosphere', 'Parking', 'Pricing', 'Maintenance', 'Marketing',
]

const STATUSES = ['New', 'Assigned', 'In Progress', 'Completed', 'Monitoring', 'Dismissed']
const STATUS_VARIANT = {
  New: 'neutral', Assigned: 'info', 'In Progress': 'accent',
  Completed: 'success', Monitoring: 'warning', Dismissed: 'neutral',
}
const STATUS_PROGRESS = {
  New: 0, Assigned: 20, 'In Progress': 50, Monitoring: 80, Completed: 100, Dismissed: 0,
}

// Extracts the id of the complaint/praise category this action is about
// (e.g. "complaint_wait_time" -> "wait_time") so outcome tracking can look
// up the category's live mention count later.
function categoryIdFor(actionId) {
  const m = actionId.match(/^(?:complaint|marketing)_(.+)$/)
  return m ? m[1] : null
}

function fmtWhen(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString()
}

function OutcomeTracker({ actionId, entry, complaintIntel }) {
  const snapshot = entry?.outcomeSnapshot
  if (!snapshot) return null

  const catId = categoryIdFor(actionId)
  const live = catId
    ? (complaintIntel?.complaints ?? []).find(c => c.id === catId)
      ?? (complaintIntel?.praises ?? []).find(p => p.id === catId)
    : null
  if (!live) return null

  const delta = live.count - snapshot.count
  const improved = actionId.startsWith('complaint_') ? delta < 0 : delta > 0
  const isFlat = delta === 0

  return (
    <div className="mt-3 rounded-lg px-3 py-2.5"
         style={{ background: 'var(--color-surface-2)' }}>
      <p className="text-[9px] font-bold uppercase tracking-widest mb-1" style={{ color: 'var(--color-text-3)' }}>
        Outcome since marked {fmtWhen(snapshot.capturedAt)}
      </p>
      <p className="text-xs font-semibold" style={{ color: isFlat ? 'var(--color-text-2)' : improved ? 'var(--color-success)' : 'var(--color-danger)' }}>
        {isFlat ? 'No change' : `${delta > 0 ? '+' : ''}${delta} mentions`} ({snapshot.count} → {live.count})
      </p>
    </div>
  )
}

function ActionCard({ a, entry, onUpdate, locations, complaintIntel }) {
  const [open, setOpen] = useState(false)
  const hasReviews = a.supportingReviews?.length > 0
  const status = entry?.status ?? 'New'
  const progress = STATUS_PROGRESS[status] ?? 0

  function handleStatusChange(next) {
    const patch = { status: next }
    if ((next === 'Completed' || next === 'Monitoring') && !entry?.outcomeSnapshot) {
      const catId = categoryIdFor(a.id)
      const live = catId
        ? (complaintIntel?.complaints ?? []).find(c => c.id === catId)
          ?? (complaintIntel?.praises ?? []).find(p => p.id === catId)
        : null
      if (live) patch.outcomeSnapshot = { count: live.count, pct: live.pct, capturedAt: new Date().toISOString() }
    }
    onUpdate(a.id, patch, `Status → ${next}`)
  }

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span aria-hidden="true">{TYPE_ICON[a.type] ?? '📋'}</span>
            <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>{a.title}</p>
            <Badge variant={PRIORITY_VARIANT[a.priority] ?? 'neutral'}>{a.priority}</Badge>
            <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>
          </div>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)' }}>{a.reason}</p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mt-3 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
        <div className="h-1.5 rounded-full transition-all"
             style={{ width: `${progress}%`, background: status === 'Completed' ? 'var(--color-success)' : 'var(--color-accent)' }} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Impact</p>
          <p className="text-sm font-semibold mt-0.5" style={{ color: IMPACT_COLOR[a.estimatedImpact] ?? 'var(--color-text-1)' }}>
            {a.estimatedImpact}
          </p>
        </div>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Confidence</p>
          <p className="text-sm font-semibold mt-0.5" style={{ color: 'var(--color-text-1)' }}>
            {a.confidence?.label} <span className="font-normal text-xs" style={{ color: 'var(--color-text-3)' }}>(n={a.confidence?.sampleSize})</span>
          </p>
        </div>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Difficulty</p>
          <p className="text-sm font-semibold mt-0.5" style={{ color: 'var(--color-text-1)' }}>{a.difficulty}</p>
        </div>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Target</p>
          <p className="text-sm font-semibold mt-0.5" style={{ color: 'var(--color-text-1)' }}>{a.suggestedCompletionTime}</p>
        </div>
      </div>

      {a.suggestedAction && (
        <div className="mt-3 rounded-lg px-3 py-2.5"
             style={{ background: 'var(--color-accent-lt)', border: '1px solid var(--color-accent-md)' }}>
          <p className="text-[10px] uppercase tracking-widest font-bold mb-1" style={{ color: 'var(--color-accent)' }}>
            Suggested Action
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-1)' }}>{a.suggestedAction}</p>
        </div>
      )}

      <OutcomeTracker actionId={a.id} entry={entry} complaintIntel={complaintIntel} />

      {/* Task management */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
        <div>
          <label className="text-[9px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>Status</label>
          <select value={status} onChange={e => handleStatusChange(e.target.value)}
                  className="w-full text-xs px-2 py-2 rounded-lg border focus:outline-none"
                  style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[9px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>Location</label>
          <select value={entry?.assignedLocation ?? ''} onChange={e => onUpdate(a.id, { assignedLocation: e.target.value || null }, e.target.value ? `Assigned to ${e.target.value}` : undefined)}
                  className="w-full text-xs px-2 py-2 rounded-lg border focus:outline-none"
                  style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}>
            <option value="">Network-wide</option>
            {locations.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[9px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>Department</label>
          <select value={entry?.assignedDepartment ?? a.recommendedDepartment ?? ''}
                  onChange={e => onUpdate(a.id, { assignedDepartment: e.target.value || null })}
                  className="w-full text-xs px-2 py-2 rounded-lg border focus:outline-none"
                  style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}>
            {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[9px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>Due Date</label>
          <input type="date" value={entry?.dueDate ?? ''}
                 onChange={e => onUpdate(a.id, { dueDate: e.target.value || null })}
                 className="w-full text-xs px-2 py-2 rounded-lg border focus:outline-none"
                 style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }} />
        </div>
      </div>

      <div className="mt-3">
        <label className="text-[9px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>Internal Notes</label>
        <textarea value={entry?.notes ?? ''} onChange={e => onUpdate(a.id, { notes: e.target.value })}
                  onBlur={() => entry?.notes && onUpdate(a.id, {}, 'Note updated')}
                  placeholder="Progress notes, blockers, who's working this…" rows={2}
                  className="w-full text-xs px-2.5 py-2 rounded-lg border resize-y focus:outline-none"
                  style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }} />
      </div>

      {entry?.history?.length > 0 && (
        <details className="mt-3">
          <summary className="text-[10px] font-bold uppercase tracking-wider cursor-pointer" style={{ color: 'var(--color-text-3)' }}>
            History ({entry.history.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {[...entry.history].reverse().map((h, i) => (
              <li key={i} className="text-xs flex items-baseline gap-2">
                <span style={{ color: 'var(--color-text-3)' }}>{new Date(h.at).toLocaleString()}</span>
                <span style={{ color: 'var(--color-text-1)' }}>{h.action}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {hasReviews && (
        <div className="mt-3">
          <button onClick={() => setOpen(o => !o)}
                  className="text-xs font-medium" style={{ color: 'var(--color-accent)' }}>
            {open ? 'Hide supporting reviews' : `Show ${a.supportingReviews.length} supporting review${a.supportingReviews.length > 1 ? 's' : ''}`}
          </button>
          {open && (
            <div className="space-y-2 mt-2">
              {a.supportingReviews.map((r, i) => (
                <div key={i} className="p-3 rounded-lg text-xs" style={{ background: 'var(--color-surface-2)' }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold" style={{ color: 'var(--color-text-1)' }}>
                      {r.reviewer_name || 'Anonymous'} · {r.location_name}
                    </span>
                    <span style={{ color: 'var(--color-text-3)' }}>{r.review_date}</span>
                  </div>
                  <p style={{ color: 'var(--color-text-2)' }}>"{r.review_text}"</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

export default function ActionCenter() {
  const { data: actions, isLoading, isError, refetch } = useActionCenter()
  const { data: complaintIntel } = useComplaintIntel()
  const { data: ws, setRecord } = useActionWorkspace()
  const { allReviews = [] } = useOutletContext() ?? {}
  const [tab, setTab] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')

  const locations = getUniqueLocations(allReviews)

  const byPriority = tab === 'All' ? (actions ?? []) : (actions ?? []).filter(a => a.priority === tab)
  const visible = statusFilter === 'All'
    ? byPriority
    : byPriority.filter(a => (ws[a.id]?.status ?? 'New') === statusFilter)

  return (
    <div className="space-y-6 max-w-[900px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>AI Action Center</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Ranked recommendations synthesized from complaints, praise, and staff mentions — assign, track, and see what worked
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Tabs tabs={TABS} value={tab} onChange={setTab} size="sm" />
        <Tabs tabs={['All', ...STATUSES]} value={statusFilter} onChange={setStatusFilter} size="sm" />
      </div>

      {isError ? (
        <ErrorState body="Couldn't load the action center recommendations." onRetry={refetch} />
      ) : isLoading ? (
        <div className="space-y-3">{[1,2,3,4].map(i => <Skeleton key={i} className="h-48 rounded-2xl" />)}</div>
      ) : !visible?.length ? (
        <EmptyState icon="✓" title="No recommendations in this filter"
                    body="Try a different priority or status filter, or run the analytics pipeline to refresh recommendations." />
      ) : (
        <div className="space-y-3">
          {visible.map(a => (
            <ActionCard key={a.id} a={a} entry={ws[a.id]} onUpdate={setRecord}
                        locations={locations} complaintIntel={complaintIntel} />
          ))}
        </div>
      )}
    </div>
  )
}
