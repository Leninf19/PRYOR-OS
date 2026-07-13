import { useState } from 'react'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import {
  usePredictiveAlerts, useActionItems, useScraperStatusData,
  useCompetitorIntel,
} from '../hooks/useIntelligence.js'

// ── Alert assembly ────────────────────────────────────────────────────────────

function buildAlerts(predictive, actionItems, scraperRuns, competitorIntel) {
  const list = []

  // 1. Unanswered negative reviews (1–2★) — danger priority
  const unanswered = actionItems?.unanswered ?? []
  if (unanswered.length > 0) {
    // Group by location
    const byLoc = {}
    unanswered.forEach(r => {
      byLoc[r.location_name] = (byLoc[r.location_name] ?? 0) + 1
    })
    const topLoc = Object.entries(byLoc).sort((a, b) => b[1] - a[1])[0]
    list.push({
      id: 'unanswered-backlog',
      severity: 'danger',
      priority: 'Urgent',
      title: `${unanswered.length} negative reviews need a response`,
      location: topLoc ? `${topLoc[0]} (${topLoc[1]})` : 'Multiple locations',
      body: 'Unanswered 1–2★ reviews damage reputation and lower ranking signals.',
      action: 'Go to Response Center and respond to the oldest reviews first.',
      time: null,
    })
  }

  // 2. Declining locations from trend alerts
  const trendAlerts = actionItems?.trendAlerts ?? []
  trendAlerts.forEach(t => {
    if (t.delta < 0) {
      list.push({
        id: `decline-${t.name}`,
        severity: 'warning',
        priority: 'Warning',
        title: `${t.name} rating is declining`,
        location: t.name,
        body: `Average rating dropped from ${t.avgPrev.toFixed(2)}★ to ${t.avgCur.toFixed(2)}★ (${t.delta.toFixed(2)} vs prior 30 days).`,
        action: 'Review recent complaints at this location and identify root cause.',
        time: null,
      })
    } else if (t.delta > 0) {
      list.push({
        id: `rise-${t.name}`,
        severity: 'positive',
        priority: 'Good',
        title: `${t.name} rating is improving`,
        location: t.name,
        body: `Average rating improved from ${t.avgPrev.toFixed(2)}★ to ${t.avgCur.toFixed(2)}★ (+${t.delta.toFixed(2)} vs prior 30 days).`,
        action: 'Identify what is working and replicate across underperforming locations.',
        time: null,
      })
    }
  })

  // 3. Predictive alerts from pipeline
  const predArr = Array.isArray(predictive) ? predictive : (predictive?.alerts ?? [])
  predArr.forEach((a, i) => {
    list.push({
      id: `pred-${i}`,
      severity: a.severity === 'critical' ? 'danger' : a.severity === 'positive' ? 'positive' : 'warning',
      priority: a.severity === 'critical' ? 'Critical' : a.severity === 'positive' ? 'Opportunity' : 'Watch',
      title: a.title ?? a.name ?? 'Predictive signal detected',
      location: a.location ?? a.locationName ?? 'All locations',
      body: a.body ?? a.description ?? a.message ?? '',
      action: a.recommendation ?? a.action ?? 'Review the Trends & Predictions page for details.',
      time: a.detectedAt ?? a.generatedAt ?? null,
    })
  })

  // 4. Competitor movement alerts
  const competitorAlerts = competitorIntel?.alerts ?? []
  competitorAlerts.forEach((a, i) => {
    list.push({
      id: `comp-${i}`,
      severity: a.severity === 'positive' ? 'positive' : a.severity === 'danger' ? 'danger' : 'info',
      priority: 'Competitive',
      title: a.title,
      location: a.location ?? 'All locations',
      body: a.body ?? '',
      action: 'Review Competitor Intelligence for full context.',
      time: null,
    })
  })

  // 5. Scraper issues
  const recent = scraperRuns?.slice(0, 3) ?? []
  recent.forEach(run => {
    const failed = run.locations?.filter(l => l.status === 'error' || l.reviews_found === 0) ?? []
    if (failed.length > 0) {
      list.push({
        id: `scraper-${run.id}`,
        severity: 'info',
        priority: 'System',
        title: `${failed.length} location(s) had scraper issues`,
        location: failed.map(l => l.location_name).slice(0, 3).join(', '),
        body: `Most recent scrape had errors or zero reviews for: ${failed.map(l => l.location_name).join(', ')}.`,
        action: 'Check Scraper Status for details. Manually re-run if needed.',
        time: run.started_at ?? null,
      })
      return // one per run
    }
  })

  // Sort: danger → warning → info → positive
  const order = { danger: 0, warning: 1, info: 2, positive: 3 }
  list.sort((a, b) => (order[a.severity] ?? 2) - (order[b.severity] ?? 2))
  return list
}

// ── Sub-components ────────────────────────────────────────────────────────────

const SEV = {
  danger:   { border: 'var(--color-danger)',  badge: 'danger',  icon: '!' },
  warning:  { border: 'var(--color-grade-c)',              badge: 'warning', icon: '!' },
  info:     { border: 'var(--color-info)',    badge: 'info',    icon: 'i' },
  positive: { border: 'var(--color-success)', badge: 'success', icon: '↑' },
}

function AlertRow({ alert }) {
  const [open, setOpen] = useState(false)
  const s = SEV[alert.severity] ?? SEV.info
  return (
    <div className="rounded-xl border overflow-hidden transition-shadow"
         style={{ borderColor: 'var(--color-border)', borderLeftColor: s.border, borderLeftWidth: 3,
                  background: 'var(--color-surface)', boxShadow: open ? 'var(--shadow-md)' : undefined }}>
      <button
        className="w-full flex items-start gap-4 p-4 text-left"
        onClick={() => setOpen(o => !o)}
      >
        <Badge variant={s.badge} className="flex-shrink-0 mt-0.5 font-bold w-5 h-5 flex items-center justify-center p-0">
          {s.icon}
        </Badge>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[9px] font-bold uppercase tracking-widest"
                  style={{ color: s.border }}>
              {alert.priority}
            </span>
            {alert.location && (
              <span className="badge badge-neutral text-[9px]">{alert.location}</span>
            )}
            {alert.time && (
              <span className="text-[9px] ml-auto" style={{ color: 'var(--color-text-3)' }}>
                {new Date(alert.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            )}
          </div>
          <p className="text-sm font-semibold mt-0.5" style={{ color: 'var(--color-text-1)' }}>
            {alert.title}
          </p>
        </div>
        <svg className={`w-4 h-4 flex-shrink-0 mt-0.5 transition-transform ${open ? 'rotate-180' : ''}`}
             fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
             style={{ color: 'var(--color-text-3)' }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-0 space-y-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
          {alert.body && (
            <div className="pt-3">
              <p className="text-[10px] uppercase tracking-widest font-bold mb-1"
                 style={{ color: 'var(--color-text-3)' }}>Why it matters</p>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
                {alert.body}
              </p>
            </div>
          )}
          {alert.action && (
            <div className="rounded-lg px-3 py-2.5"
                 style={{ background: 'var(--color-surface-2)', borderLeft: `3px solid ${s.border}` }}>
              <p className="text-[10px] uppercase tracking-widest font-bold mb-1"
                 style={{ color: 'var(--color-text-3)' }}>Recommended action</p>
              <p className="text-sm" style={{ color: 'var(--color-text-1)' }}>{alert.action}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-[60px] rounded-xl" />)}
    </div>
  )
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'all',         label: 'All'         },
  { id: 'danger',      label: 'Urgent'      },
  { id: 'warning',     label: 'Warnings'    },
  { id: 'competitive', label: 'Competitive' },
  { id: 'positive',    label: 'Positive'    },
]

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Alerts() {
  const { data: predictive, isLoading: loadP }  = usePredictiveAlerts()
  const { data: actionItems, isLoading: loadA }  = useActionItems()
  const { data: scraperRuns, isLoading: loadS }  = useScraperStatusData()
  const { data: competitorIntel, isLoading: loadC } = useCompetitorIntel()
  const [tab, setTab] = useState('all')

  const isLoading = loadP || loadA || loadS || loadC

  const alerts = isLoading
    ? []
    : buildAlerts(predictive, actionItems, scraperRuns, competitorIntel)

  const filtered = tab === 'all'
    ? alerts
    : tab === 'competitive'
    ? alerts.filter(a => a.id.startsWith('comp-'))
    : alerts.filter(a => a.severity === tab)

  const counts = {
    all:         alerts.length,
    danger:      alerts.filter(a => a.severity === 'danger').length,
    warning:     alerts.filter(a => a.severity === 'warning').length,
    competitive: alerts.filter(a => a.id.startsWith('comp-')).length,
    positive:    alerts.filter(a => a.severity === 'positive').length,
  }

  return (
    <div className="space-y-6 max-w-[860px]">

      {/* Header */}
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Alerts</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Priority notifications from across all 21 locations
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl w-fit flex-wrap" style={{ background: 'var(--color-surface-2)' }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg transition-all whitespace-nowrap"
            style={tab === t.id
              ? { background: 'var(--color-surface)', color: 'var(--color-text-1)', boxShadow: 'var(--shadow-sm)' }
              : { color: 'var(--color-text-2)' }}
          >
            {t.label}
            {!isLoading && counts[t.id] > 0 && (
              <span className="ml-1.5 text-[9px] font-bold px-1 py-0.5 rounded"
                    style={{ background: 'var(--color-surface)', color: 'var(--color-accent)' }}>
                {counts[t.id]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <LoadingSkeleton />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="✓"
          title={tab === 'all' ? 'No active alerts' : `No ${tab} alerts`}
          body={tab === 'all'
            ? 'All locations are performing within normal ranges. Alerts will appear here when ratings drop, reviews need attention, or competitive shifts are detected.'
            : 'Nothing to show in this category right now.'}
        />
      ) : (
        <div className="space-y-3">
          {filtered.map(a => <AlertRow key={a.id} alert={a} />)}
        </div>
      )}

    </div>
  )
}
