import { Link, useOutletContext } from 'react-router-dom'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import ErrorState from '../components/ui/ErrorState.jsx'
import AIBriefingCard from '../components/ui/AIBriefingCard.jsx'
import KPIGrid from '../components/ui/KPIGrid.jsx'
import SentimentBreakdown from '../components/ui/SentimentBreakdown.jsx'
import { useTodayDigest } from '../hooks/useTodayDigest.js'

// Today UX Simplification -- the page is redesigned around one question,
// "What do I need to know and act on today?" Everything below still traces
// to the exact same hooks/pure functions useTodayDigest.js already composed
// (see that file); no new metric, no new backend call, no new component.
// What changed is which of those existing pieces render on THIS page and how
// much space each gets:
//  - Kept, made primary: KPI row, Needs Attention, AI brief, What Changed,
//    selected-period Reviews Received/sentiment.
//  - Folded together: Reply Backlog's {total, overdue} numbers now live
//    inside the KPI row's "Needs Reply" card instead of a separate card
//    (KPIGrid's new optional `replyBacklog` prop).
//  - Moved off-page (long-term reporting, not a daily action list): the
//    12-month Rating Trend and Location Leaderboard already have a live,
//    more complete home at /trends ("Company Trend"/"Rankings" tabs) and
//    already-existing lists; Executive Performance (score cards + company
//    goals) moved to /reports' new "Performance" tab; Activity History moved
//    back to its own /activity route (ActivityTimeline.jsx, unchanged,
//    un-redirected). See the "More reports" links row at the bottom.

// ── Needs Attention ──────────────────────────────────────────────────────────

const SEVERITY_STYLE = {
  critical: { border: 'var(--color-danger)',  badge: 'danger'  },
  high:     { border: 'var(--color-warning)', badge: 'warning' },
  warning:  { border: 'var(--color-warning)', badge: 'warning' },
}

// Three concrete CTA labels instead of one generic "View details" (UX
// Simplification requirement) -- derived from the same sourcePath
// priorityDigest.js already assigns each candidate, so no new data is
// needed: a /reviews link is always a specific review, /actions is always
// an Action Center item, and every other source in this app's data model
// (Operations Impact, Predictive Alerts, Trend Alerts) is location-centric.
function ctaLabelFor(sourcePath) {
  if (sourcePath?.startsWith('/reviews')) return 'View Review'
  if (sourcePath === '/actions') return 'View Action'
  return 'View Location'
}

function PriorityRow({ item }) {
  const style = SEVERITY_STYLE[item.severity] ?? SEVERITY_STYLE.warning
  return (
    <div className="flex items-start gap-3 py-3 px-4 border-l-4" style={{ borderColor: style.border }}>
      <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5"
            style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}>
        {item.rank}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>{item.title}</p>
          <Badge variant={style.badge}>{item.severity}</Badge>
        </div>
        <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--color-text-2)' }}>{item.explanation}</p>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--color-text-3)' }}>
            {item.sourceLabel}
          </span>
          <Link to={item.sourcePath} className="text-[11px] font-medium hover:underline" style={{ color: 'var(--color-accent)' }}>
            {ctaLabelFor(item.sourcePath)} →
          </Link>
        </div>
      </div>
    </div>
  )
}

function NeedsAttention({ items, isLoading, isError }) {
  return (
    <Card className="overflow-hidden h-full">
      <div className="px-5 pt-4 pb-2 flex items-center justify-between">
        <h2 className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Needs Attention</h2>
        <Link to="/alerts" className="text-[11px] font-medium hover:underline" style={{ color: 'var(--color-accent)' }}>
          View all alerts →
        </Link>
      </div>
      {isError ? (
        <div className="px-5 pb-4"><ErrorState body="Couldn't load today's priorities." /></div>
      ) : isLoading ? (
        <div className="px-5 pb-4 space-y-2">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="px-5 pb-4">
          <EmptyState icon="✅" title="Nothing urgent right now" body="No location or issue currently needs immediate attention." />
        </div>
      ) : (
        <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
          {items.map(item => <PriorityRow key={item.id} item={item} />)}
        </div>
      )}
    </Card>
  )
}

// ── What Changed (Improving + Worsening, merged into one compact card) ──────
// UX Simplification: previously two separate Card components side by side
// (plus a third for Reply Backlog, now folded into the KPI row above). Same
// data (digest.recentWins/recentLosses, already capped at 3 each), one card.

function ChangeColumn({ title, items, positive, emptyText }) {
  const color = positive ? 'var(--color-success)' : 'var(--color-danger)'
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--color-text-3)' }}>{title}</p>
      {items.length === 0 ? (
        <p className="text-xs italic" style={{ color: 'var(--color-text-3)' }}>{emptyText}</p>
      ) : (
        <div className="space-y-2.5">
          {items.map(item => (
            <div key={item.id}>
              <p className="text-sm font-semibold" style={{ color }}>{item.title}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-2)' }}>{item.explanation}</p>
              <Link to={item.sourcePath} className="text-[11px] font-medium hover:underline" style={{ color: 'var(--color-accent)' }}>
                View details →
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function WhatChangedCard({ wins, losses }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>What Changed</h2>
        <Link to="/what-changed" className="text-[11px] font-medium hover:underline" style={{ color: 'var(--color-accent)' }}>
          Full breakdown →
        </Link>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <ChangeColumn title="Improving" items={wins} positive emptyText="No standout wins detected this period yet." />
        <ChangeColumn title="Worsening" items={losses} positive={false} emptyText="Nothing declining this period." />
      </div>
    </Card>
  )
}

// ── More reports (quick links to where long-term reporting now lives) ──────
// UX Simplification: Rating Trend, Location Leaderboard, Executive
// Performance, and Activity History all moved off Today -- this is the
// wayfinding back to them, at the cost of one compact row instead of four
// full sections.

const MORE_REPORTS = [
  { to: '/trends',   label: 'Rating Trend & Rankings' },
  { to: '/locations', label: 'All Locations' },
  { to: '/reports',   label: 'Executive Performance' },
  { to: '/activity',  label: 'Activity History' },
]

function MoreReportsRow() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-1">
      <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
        More reports
      </span>
      {MORE_REPORTS.map(r => (
        <Link key={r.to} to={r.to} className="text-xs font-medium hover:underline" style={{ color: 'var(--color-accent)' }}>
          {r.label} →
        </Link>
      ))}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Today() {
  const { allReviews = [], filtered = [], prevFiltered = [], filters = {} } = useOutletContext() ?? {}

  const {
    periodLabel, digest, digestLoading, digestError,
    brief, summary, summaryLoading,
    kpis, kpisLoading,
    replyBacklog, replyBacklogLoading,
  } = useTodayDigest(filtered, prevFiltered, allReviews, filters)

  if (!filtered.length && !prevFiltered.length) {
    return <EmptyState icon="🔍" title="No data for this period" body="Try widening the selected date range." />
  }

  return (
    <div className="space-y-5 max-w-[1200px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Today</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          What needs you right now
        </p>
      </div>

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-2 px-1" style={{ color: 'var(--color-text-3)' }}>
          Fixed snapshot from the last analytics run · trailing 30 days · does not change with the filters below
        </p>
        <KPIGrid kpis={kpis} loading={kpisLoading || replyBacklogLoading} replyBacklog={replyBacklog} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <NeedsAttention items={digest.topPriorities} isLoading={digestLoading} isError={digestError} />
        </div>
        <AIBriefingCard label="AI Daily Brief" brief={brief} summary={summary} loading={summaryLoading}
                        periodLabel={periodLabel} topPriorities={digest.topPriorities} />
      </div>

      <WhatChangedCard wins={digest.recentWins} losses={digest.recentLosses} />

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider mb-2 px-1" style={{ color: 'var(--color-text-3)' }}>
          Selected period · updates with the filters above
        </p>
        <SentimentBreakdown reviews={filtered} periodLabel={periodLabel} showSummaryLine />
      </div>

      <MoreReportsRow />
    </div>
  )
}
