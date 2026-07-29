import { useMemo, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import ErrorState from '../components/ui/ErrorState.jsx'
import Tabs from '../components/ui/Tabs.jsx'
import { useActionCenter, useComplaintIntel, useActionItems, useLocationStats } from '../hooks/useIntelligence.js'
import { useActionWorkspace } from '../hooks/useActionWorkspace.js'
import { useAccounts } from '../hooks/useAccounts.js'
import { useAccount } from '../components/AuthGate.jsx'
import { useUpdateEmailStatus } from '../hooks/useReviewEmailWorkflow.js'
import { getUniqueLocations, getLocationMomentum, getCategoryChanges, reviewId } from '../utils/dataUtils.js'
import {
  OPEN_STATUSES, isOverdue, todayISODate,
  EMAIL_STATUS_META, EMAIL_STATUS_TRANSITIONABLE_FROM, isEmailFollowUpOverdue,
} from '../utils/actionWorkspaceUtils.js'
import { computeReplyState } from '../utils/replyState.js'

// M6 -- Actions, genuinely separating the AI-recommendation tickets from the
// Restaurant Email Threads (Execution Master Plan v1.0 M6.1) and reorganizing
// the AI-ticket side into the 8 approved sections (M6.2): Today's Priorities,
// Waiting on Confirmation, Needs Reply, Marketing Opportunities, Trending
// Issues, Location Health, Completed Today, and AI Recommendations. Each
// section computes its own scoped subset from its own source -- no section's
// filter state can leak into another's (the exact risk M6.1 calls out:
// "an email thread accidentally renders as an AI ticket or vice versa").
// Restaurant Email Threads is not one of the 8 named sections -- it remains
// its own clearly separate 9th section, per M6.1's own framing of the split
// as two systems, not one list reorganized eight ways.

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

function displayNameFor(accounts, userId) {
  return accounts?.find(a => a.userId === userId)?.displayName ?? userId
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

// ── Section shell (collapsible, matches Today.jsx's drawer pattern) ─────────

let sectionIdCounter = 0
function CollapsibleSection({ title, count, defaultOpen = false, emptyText, isEmpty, isLoading, isError, errorText, children }) {
  const [open, setOpen] = useState(defaultOpen)
  const [id] = useState(() => `actions-section-${++sectionIdCounter}`)

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
        aria-expanded={open}
        aria-controls={id}
      >
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>{title}</h2>
          {count != null && (
            <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full"
                  style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}>
              {count}
            </span>
          )}
        </div>
        <svg className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`}
             fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
             style={{ color: 'var(--color-text-3)' }} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      {/* hidden (not unmounted) so aria-controls={id} always resolves to a real element */}
      <div id={id} hidden={!open} className="px-5 pb-5">
        {isError ? (
          <ErrorState body={errorText ?? "Couldn't load this section."} />
        ) : isLoading ? (
          <div className="space-y-2">{[1, 2].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : isEmpty ? (
          <p className="text-xs italic" style={{ color: 'var(--color-text-3)' }}>{emptyText}</p>
        ) : children}
      </div>
    </Card>
  )
}

// ── Restaurant Email Threads (own system, unchanged content/logic) ──────────

function RestaurantEmailThreadCard({ entryId, entry, review, accounts, onUpdateStatus, onUpdate }) {
  const statusMeta = EMAIL_STATUS_META[entry.emailStatus] ?? EMAIL_STATUS_META.not_sent
  const canTransition = EMAIL_STATUS_TRANSITIONABLE_FROM.has(entry.emailStatus)
  const followUpOverdue = isEmailFollowUpOverdue(entry)

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>
            {review?.location_name ?? 'Unknown location'}
          </p>
          <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>
            {review?.reviewer_name || 'Anonymous'} · {review?.star_rating ?? '?'}★ · {review?.review_date ?? ''}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
          <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
          {followUpOverdue && <Badge variant="danger">Follow-Up Overdue</Badge>}
        </div>
      </div>

      {review?.review_text && (
        <p className="text-xs italic leading-relaxed mb-3" style={{ color: 'var(--color-text-2)' }}>"{review.review_text}"</p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Sent</p>
          <p className="mt-0.5" style={{ color: 'var(--color-text-1)' }}>{fmtWhen(entry.emailSentAt) || '—'}</p>
        </div>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Sent By</p>
          <p className="mt-0.5" style={{ color: 'var(--color-text-1)' }}>{entry.emailSentBy ? displayNameFor(accounts, entry.emailSentBy) : '—'}</p>
        </div>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Recipient</p>
          <p className="mt-0.5 truncate" style={{ color: 'var(--color-text-1)' }}>{entry.emailRecipient ?? '—'}</p>
        </div>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Follow-Up Due</p>
          <p className="mt-0.5" style={{ color: 'var(--color-text-1)' }}>{entry.emailFollowUpDueAt ?? '—'}</p>
        </div>
      </div>

      {entry.emailCcRecipients?.length > 0 && (
        <p className="text-[10px] mt-2" style={{ color: 'var(--color-text-3)' }}>Cc: {entry.emailCcRecipients.join(', ')}</p>
      )}
      {entry.emailStatus === 'failed' && entry.emailLastError && (
        <p className="text-[10px] mt-2" style={{ color: 'var(--color-danger)' }}>{entry.emailLastError}</p>
      )}

      {canTransition && (
        <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <label className="text-[9px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>
            Email Status
          </label>
          <select value={entry.emailStatus} onChange={e => onUpdateStatus(entryId, e.target.value)}
                  className="text-xs px-2 py-1.5 rounded-lg focus:outline-none"
                  style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}>
            <option value="sent" disabled={entry.emailStatus !== 'sent'}>Sent (awaiting response)</option>
            <option value="replied">Replied</option>
            <option value="follow_up_required">Follow-Up Required</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
      )}

      <div className="flex items-center justify-between mt-3">
        {review && (
          <Link to={`/reviews?reviewId=${encodeURIComponent(entryId)}`}
                className="text-xs font-medium" style={{ color: 'var(--color-accent)' }}>
            Open review in Reviews →
          </Link>
        )}
      </div>

      <div className="mt-3">
        <label className="text-[9px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>
          Internal Notes (paste the restaurant's reply here)
        </label>
        <textarea value={entry.notes ?? ''} onChange={e => onUpdate(entryId, { notes: e.target.value })}
                  onBlur={() => entry.notes && onUpdate(entryId, {}, 'Note updated')}
                  placeholder="Paste the restaurant's email reply, or add progress notes…" rows={2}
                  className="w-full text-xs px-2.5 py-2 rounded-lg border resize-y focus:outline-none"
                  style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }} />
      </div>

      {entry.history?.length > 0 && (
        <details className="mt-3">
          <summary className="text-[10px] font-bold uppercase tracking-wider cursor-pointer" style={{ color: 'var(--color-text-3)' }}>
            History ({entry.history.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {[...entry.history].reverse().map((h, i) => (
              <li key={i} className="text-xs flex items-baseline gap-2">
                <span style={{ color: 'var(--color-text-3)' }}>{new Date(h.at).toLocaleString()}</span>
                <span style={{ color: 'var(--color-text-1)' }}>{h.action}</span>
                {h.by && <span style={{ color: 'var(--color-text-3)' }}>· {h.by}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  )
}

// ── AI-recommendation ticket card (unchanged content/logic) ─────────────────

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

function ActionCard({ a, entry, onUpdate, locations, complaintIntel, accounts, currentUserId }) {
  const [open, setOpen] = useState(false)
  const hasReviews = a.supportingReviews?.length > 0
  const status = entry?.status ?? 'New'
  const progress = STATUS_PROGRESS[status] ?? 0
  const overdue = isOverdue(entry)

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

  function handleAssignedToChange(userId) {
    const label = userId ? displayNameFor(accounts, userId) : 'Unassigned'
    onUpdate(a.id, { assignedTo: userId || null }, `Assigned to ${label}`)
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
            {overdue && <Badge variant="danger">Overdue</Badge>}
            {entry?.assignedTo === currentUserId && <Badge variant="info">Assigned to you</Badge>}
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
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4 pt-4 border-t" style={{ borderColor: 'var(--color-border)' }}>
        <div>
          <label className="text-[9px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>Status</label>
          <select value={status} onChange={e => handleStatusChange(e.target.value)}
                  className="w-full text-xs px-2 py-2 rounded-lg border focus:outline-none"
                  style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[9px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>Assigned To</label>
          <select value={entry?.assignedTo ?? ''} onChange={e => handleAssignedToChange(e.target.value)}
                  className="w-full text-xs px-2 py-2 rounded-lg border focus:outline-none"
                  style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}>
            <option value="">Unassigned</option>
            {(accounts ?? []).map(acc => <option key={acc.userId} value={acc.userId}>{acc.displayName}</option>)}
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
                {h.by && <span style={{ color: 'var(--color-text-3)' }}>· {h.by}</span>}
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

// ── Needs Reply (compact rows, links to Reviews) ─────────────────────────────

function NeedsReplyRow({ r }) {
  return (
    <Link to="/reviews" className="flex items-center justify-between gap-3 py-2 px-1 -mx-1 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">
      <span className="text-xs font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>
        {r.star_rating}★ {r.reviewer_name || 'Anonymous'}
        <span className="font-normal ml-1.5" style={{ color: 'var(--color-text-3)' }}>· {r.location_name}</span>
      </span>
      <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--color-text-3)' }}>{r.review_date}</span>
    </Link>
  )
}

// ── Waiting on Confirmation (reuses the M5 reply-state model) ───────────────

function WaitingOnConfirmationRow({ r }) {
  return (
    <Link to="/reviews" className="flex items-center justify-between gap-3 py-2 px-1 -mx-1 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">
      <span className="text-xs font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>
        {r.reviewer_name || 'Anonymous'}
        <span className="font-normal ml-1.5" style={{ color: 'var(--color-text-3)' }}>· {r.location_name}</span>
      </span>
      <Badge variant="warning">Pending sync</Badge>
    </Link>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Actions() {
  const { allReviews = [], filtered = [], prevFiltered = [] } = useOutletContext() ?? {}
  const { data: actions, isLoading, isError, refetch } = useActionCenter()
  const { data: complaintIntel } = useComplaintIntel()
  const { data: ws, setRecord } = useActionWorkspace()
  const { data: accounts } = useAccounts()
  const account = useAccount()
  const updateEmailStatusMutation = useUpdateEmailStatus()
  const { data: actionItems, isLoading: actionItemsLoading, isError: actionItemsError } = useActionItems()
  const { data: locationStats, isLoading: locationStatsLoading } = useLocationStats()

  const [tab, setTab] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [mineOnly, setMineOnly] = useState(false)
  const [overdueOnly, setOverdueOnly] = useState(false)

  const locations = getUniqueLocations(allReviews)
  const actionList = actions ?? []

  // ── Today's Priorities: Critical/High, still open ──
  const todaysPriorities = useMemo(() => {
    return actionList.filter(a => {
      const status = ws[a.id]?.status ?? 'New'
      return (a.priority === 'Critical' || a.priority === 'High') && OPEN_STATUSES.has(status)
    })
  }, [actionList, ws])

  // ── Waiting on Confirmation: reviews whose reply-state is 'pending' (the
  // M5 inert stub -- this section is therefore expected to always be empty
  // in production until the deferred backend confirmation phase ships). ──
  const waitingOnConfirmation = useMemo(() => {
    return (filtered ?? []).filter(r => computeReplyState(r, undefined) === 'pending')
  }, [filtered])

  // ── Needs Reply: the same canonical unanswered-reviews source GlobalFilters/
  // NotificationBell/Today's Reply Backlog already use. ──
  const needsReply = actionItems?.unanswered ?? []

  // ── Marketing Opportunities ──
  const marketingOpportunities = useMemo(() => actionList.filter(a => a.type === 'marketing'), [actionList])

  // ── Trending Issues: declining-momentum locations + new complaint themes
  // (same dataUtils.js functions priorityDigest.js/useActivityFeed.js already
  // use) -- a count-and-link summary, not a duplicate of What Changed. ──
  const trendingIssues = useMemo(() => {
    const momentum = getLocationMomentum(filtered ?? [], prevFiltered ?? [])
    const declining = momentum.filter(m => m.delta < 0)
    const changes = getCategoryChanges(filtered ?? [], prevFiltered ?? [])
    const newComplaintThemes = changes.complaints?.new ?? []
    const newPraiseThemes = changes.praises?.new ?? []
    return {
      count: declining.length + newComplaintThemes.length + newPraiseThemes.length,
      decliningLocations: declining.map(m => m.name),
      newComplaintThemes: newComplaintThemes.map(c => c.id),
      newPraiseThemes: newPraiseThemes.map(p => p.id),
    }
  }, [filtered, prevFiltered])

  // ── Location Health: locations below a healthy threshold (same score
  // field M4's ExecutiveScoreCard/LocationLeaderboard already render). ──
  const locationHealth = useMemo(() => {
    const list = (locationStats ?? []).filter(l => (l.healthScore?.score ?? 100) < 65)
    return { count: list.length, names: list.map(l => l.name) }
  }, [locationStats])

  // ── Completed Today: status transitioned to Completed today (via history). ──
  const completedToday = useMemo(() => {
    const today = todayISODate()
    return actionList.filter(a => {
      const entry = ws[a.id]
      if (entry?.status !== 'Completed') return false
      const completedEntry = [...(entry.history ?? [])].reverse().find(h => h.action?.startsWith('Status → Completed'))
      return completedEntry?.at?.slice(0, 10) === today
    })
  }, [actionList, ws])

  // ── AI Recommendations: the full filterable list, scoped only to this
  // section -- Priority/Status/Mine/Overdue apply here and nowhere else. ──
  const byPriority = tab === 'All' ? actionList : actionList.filter(a => a.priority === tab)
  const byStatus = statusFilter === 'All'
    ? byPriority
    : byPriority.filter(a => (ws[a.id]?.status ?? 'New') === statusFilter)
  const visible = byStatus.filter(a => {
    if (mineOnly && ws[a.id]?.assignedTo !== account?.userId) return false
    if (overdueOnly && !isOverdue(ws[a.id])) return false
    return true
  })

  // Open (not Completed/Dismissed) item count per assignee, across every
  // current recommendation regardless of the active tab/filter.
  const workload = useMemo(() => {
    const counts = {}
    for (const a of actionList) {
      const entry = ws[a.id]
      if (!entry?.assignedTo || !OPEN_STATUSES.has(entry.status ?? 'New')) continue
      counts[entry.assignedTo] ??= { open: 0, overdue: 0 }
      counts[entry.assignedTo].open += 1
      if (isOverdue(entry)) counts[entry.assignedTo].overdue += 1
    }
    return Object.entries(counts)
      .map(([userId, c]) => ({ userId, ...c }))
      .sort((x, y) => y.open - x.open)
  }, [actionList, ws])

  // ── Restaurant Email Threads: its own system, entirely separate keyspace
  // (emailStatus-bearing ws entries, keyed by reviewId, not a.id). ──
  const emailThreads = useMemo(() => {
    return Object.entries(ws)
      .filter(([, entry]) => entry?.emailStatus)
      .map(([id, entry]) => ({ id, entry, review: allReviews.find(r => reviewId(r) === id) ?? null }))
      .sort((x, y) => (y.entry.emailSentAt ?? '').localeCompare(x.entry.emailSentAt ?? ''))
  }, [ws, allReviews])

  function handleUpdateEmailStatus(id, emailStatus) {
    updateEmailStatusMutation.mutate({ id, emailStatus })
  }

  return (
    <div className="space-y-4 max-w-[900px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Actions</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          AI-ranked recommendations and restaurant follow-ups, organized by what needs you next
        </p>
      </div>

      {workload.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--color-text-3)' }}>Workload</span>
          {workload.map(w => (
            <Badge key={w.userId} variant={w.overdue > 0 ? 'danger' : 'neutral'}>
              {displayNameFor(accounts, w.userId)}: {w.open} open{w.overdue > 0 ? `, ${w.overdue} overdue` : ''}
            </Badge>
          ))}
        </div>
      )}

      {/* 1. Today's Priorities */}
      <CollapsibleSection title="Today's Priorities" count={todaysPriorities.length} defaultOpen
                           isLoading={isLoading} isError={isError} errorText="Couldn't load today's priorities."
                           isEmpty={todaysPriorities.length === 0} emptyText="Nothing urgent right now.">
        <div className="space-y-3">
          {todaysPriorities.map(a => (
            <ActionCard key={a.id} a={a} entry={ws[a.id]} onUpdate={setRecord}
                        locations={locations} complaintIntel={complaintIntel}
                        accounts={accounts} currentUserId={account?.userId} />
          ))}
        </div>
      </CollapsibleSection>

      {/* 2. Waiting on Confirmation */}
      <CollapsibleSection title="Waiting on Confirmation" count={waitingOnConfirmation.length}
                           isEmpty={waitingOnConfirmation.length === 0}
                           emptyText="Nothing awaiting reply-sync confirmation. This section will populate once Google-publish confirmation syncing ships (see Reviews' reply-state model).">
        <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
          {waitingOnConfirmation.map((r, i) => <WaitingOnConfirmationRow key={i} r={r} />)}
        </div>
      </CollapsibleSection>

      {/* 3. Needs Reply */}
      <CollapsibleSection title="Needs Reply" count={needsReply.length}
                           isLoading={actionItemsLoading} isError={actionItemsError} errorText="Couldn't load reviews needing a reply."
                           isEmpty={needsReply.length === 0} emptyText="All caught up — no unanswered negative reviews.">
        <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
          {needsReply.slice(0, 10).map((r, i) => <NeedsReplyRow key={i} r={r} />)}
        </div>
        {needsReply.length > 10 && (
          <Link to="/reviews" className="block text-center text-xs font-medium pt-2" style={{ color: 'var(--color-accent)' }}>
            View all {needsReply.length} in Reviews →
          </Link>
        )}
      </CollapsibleSection>

      {/* 4. Marketing Opportunities */}
      <CollapsibleSection title="Marketing Opportunities" count={marketingOpportunities.length}
                           isLoading={isLoading} isError={isError}
                           isEmpty={marketingOpportunities.length === 0} emptyText="No marketing opportunities identified this period.">
        <div className="space-y-3">
          {marketingOpportunities.map(a => (
            <ActionCard key={a.id} a={a} entry={ws[a.id]} onUpdate={setRecord}
                        locations={locations} complaintIntel={complaintIntel}
                        accounts={accounts} currentUserId={account?.userId} />
          ))}
        </div>
      </CollapsibleSection>

      {/* 5. Trending Issues */}
      <CollapsibleSection title="Trending Issues" count={trendingIssues.count}
                           isEmpty={trendingIssues.count === 0} emptyText="No emerging themes or declining locations this period.">
        <div className="space-y-1.5">
          {trendingIssues.decliningLocations.map(name => (
            <p key={`loc-${name}`} className="text-xs" style={{ color: 'var(--color-text-2)' }}>📉 {name} rating declining</p>
          ))}
          {trendingIssues.newComplaintThemes.map(id => (
            <p key={`complaint-${id}`} className="text-xs" style={{ color: 'var(--color-text-2)' }}>🔴 New complaint theme: {id.replace(/_/g, ' ')}</p>
          ))}
          {trendingIssues.newPraiseThemes.map(id => (
            <p key={`praise-${id}`} className="text-xs" style={{ color: 'var(--color-text-2)' }}>⭐ New praise theme: {id.replace(/_/g, ' ')}</p>
          ))}
        </div>
        <Link to="/what-changed" className="block text-xs font-medium pt-2" style={{ color: 'var(--color-accent)' }}>
          View full detail in What Changed →
        </Link>
      </CollapsibleSection>

      {/* 6. Location Health */}
      <CollapsibleSection title="Location Health" count={locationHealth.count}
                           isLoading={locationStatsLoading}
                           isEmpty={locationHealth.count === 0} emptyText="No locations currently below the health threshold.">
        <div className="space-y-1.5">
          {locationHealth.names.map(name => (
            <p key={name} className="text-xs" style={{ color: 'var(--color-text-2)' }}>⚠ {name}</p>
          ))}
        </div>
        <Link to="/locations" className="block text-xs font-medium pt-2" style={{ color: 'var(--color-accent)' }}>
          View all locations →
        </Link>
      </CollapsibleSection>

      {/* 7. Completed Today */}
      <CollapsibleSection title="Completed Today" count={completedToday.length}
                           isEmpty={completedToday.length === 0} emptyText="Nothing completed yet today.">
        <div className="space-y-2">
          {completedToday.map(a => (
            <div key={a.id} className="flex items-center gap-2 text-xs">
              <span aria-hidden="true">✅</span>
              <span style={{ color: 'var(--color-text-1)' }}>{a.title}</span>
            </div>
          ))}
        </div>
      </CollapsibleSection>

      {/* 8. AI Recommendations -- the full, filterable list. Scoped ONLY to
          this section: Priority/Status/Mine/Overdue affect nothing else. */}
      <Card className="overflow-hidden">
        <div className="px-5 pt-4">
          <h2 className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>AI Recommendations</h2>
        </div>
        <div className="px-5 pb-5 pt-3 space-y-3">
          <div className="flex flex-col gap-2">
            <Tabs tabs={TABS} value={tab} onChange={setTab} size="sm" />
            <Tabs tabs={['All', ...STATUSES]} value={statusFilter} onChange={setStatusFilter} size="sm" />
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setMineOnly(v => !v)}
                      className={`badge ${mineOnly ? 'badge-accent' : 'badge-neutral'}`}>
                Mine
              </button>
              <button type="button" onClick={() => setOverdueOnly(v => !v)}
                      className={`badge ${overdueOnly ? 'badge-danger' : 'badge-neutral'}`}>
                Overdue
              </button>
            </div>
          </div>

          {isError ? (
            <ErrorState body="Couldn't load the AI recommendations." onRetry={refetch} />
          ) : isLoading ? (
            <div className="space-y-3">{[1,2,3,4].map(i => <Skeleton key={i} className="h-48 rounded-2xl" />)}</div>
          ) : !visible?.length ? (
            <EmptyState icon="✓" title="No recommendations in this filter"
                        body="Try a different priority, status, or Mine/Overdue filter, or run the analytics pipeline to refresh recommendations." />
          ) : (
            <div className="space-y-3">
              {visible.map(a => (
                <ActionCard key={a.id} a={a} entry={ws[a.id]} onUpdate={setRecord}
                            locations={locations} complaintIntel={complaintIntel}
                            accounts={accounts} currentUserId={account?.userId} />
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* 9. Restaurant Email Threads -- its own separate system (M6.1). */}
      {emailThreads.length > 0 && (
        <div>
          <h2 className="text-sm font-bold mb-2" style={{ color: 'var(--color-text-1)' }}>Restaurant Email Threads</h2>
          <div className="space-y-3">
            {emailThreads.map(({ id, entry, review }) => (
              <RestaurantEmailThreadCard key={id} entryId={id} entry={entry} review={review}
                                          accounts={accounts} onUpdateStatus={handleUpdateEmailStatus} onUpdate={setRecord} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
