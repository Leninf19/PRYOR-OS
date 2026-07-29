import { useMemo, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import ErrorState from '../components/ui/ErrorState.jsx'
import RatingTrendCard from '../components/ui/RatingTrendCard.jsx'
import LocationLeaderboard from '../components/ui/LocationLeaderboard.jsx'
import AIBriefingCard from '../components/ui/AIBriefingCard.jsx'
import ExecutiveScoreCard from '../components/ui/ExecutiveScoreCard.jsx'
import CompanyGoalsSection from '../components/ui/CompanyGoalsSection.jsx'
import KPIGrid from '../components/ui/KPIGrid.jsx'
import { useTodayDigest } from '../hooks/useTodayDigest.js'
import { useActivityFeed } from '../hooks/useActivityFeed.js'
import { useMonthlyTrend, useLocationStats, useExecutiveScores } from '../hooks/useIntelligence.js'

// M4 -- Today, the merged landing page (Overview, Executive Dashboard,
// Executive Intelligence Center, Activity Timeline, Alerts content). Every
// number here traces to an existing hook/pure function; see
// useTodayDigest.js for the composition. Alerts.jsx itself is NOT merged --
// it stays live at /alerts (Execution Master Plan v1.0 M4.4) and is linked
// from the Needs Attention section below.

// ── Needs Attention ──────────────────────────────────────────────────────────

const SEVERITY_STYLE = {
  critical: { border: 'var(--color-danger)',  badge: 'danger'  },
  high:     { border: 'var(--color-warning)', badge: 'warning' },
  warning:  { border: 'var(--color-warning)', badge: 'warning' },
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
            View details →
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

// ── Improving / Worsening / Reply Backlog ────────────────────────────────────

function MomentumCard({ title, items, positive, emptyText }) {
  const color = positive ? 'var(--color-success)' : 'var(--color-danger)'
  return (
    <Card className="p-4 h-full">
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
    </Card>
  )
}

function ReplyBacklogCard({ replyBacklog, isLoading }) {
  return (
    <Card className="p-4 h-full">
      <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--color-text-3)' }}>Reply Backlog</p>
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <>
          <p className="text-2xl font-black" style={{ color: replyBacklog.total > 0 ? 'var(--color-danger)' : 'var(--color-text-1)', fontWeight: 800 }}>
            {replyBacklog.total}
          </p>
          <p className="text-xs" style={{ color: 'var(--color-text-2)' }}>
            {replyBacklog.total === 1 ? 'review pending reply' : 'reviews pending reply'}
          </p>
          {replyBacklog.overdue > 0 && (
            <p className="text-xs mt-2 font-semibold" style={{ color: 'var(--color-warning)' }}>
              {replyBacklog.overdue} overdue &gt;{replyBacklog.overdueHours}h
            </p>
          )}
          <Link to="/reviews" className="text-[11px] font-medium hover:underline block mt-2" style={{ color: 'var(--color-accent)' }}>
            Open Reviews →
          </Link>
        </>
      )}
    </Card>
  )
}

// ── Executive Scores + Company Goals (from Executive Dashboard) ─────────────
// Reused verbatim from ExecutiveDashboard.jsx via the same hooks; see
// ExecutiveScoresSection below. Kept as a collapsible section rather than
// always-expanded, since 8 score cards + 5 goal cards is a lot of
// below-the-fold content for a landing page (Design Principle 7: density is
// a feature, not a compromise -- but a returning user shouldn't have to
// scroll past it every single day if they don't need it).

// ── Activity History (in-page drawer, not a route) ───────────────────────────
// Navigation Specification v1.0: "/today (single page; History available as
// an in-page tab/drawer, not a route)". Reuses useActivityFeed.js unchanged.

function dayBucket(iso) {
  const d = new Date(iso)
  const now = new Date()
  const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function EventRow({ e }) {
  const inner = (
    <div className="flex items-start gap-3 py-2.5">
      <span className="text-base flex-shrink-0 w-6 text-center" aria-hidden="true">{e.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium" style={{ color: 'var(--color-text-1)' }}>{e.title}</p>
        {e.sub && <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--color-text-3)' }}>{e.sub}</p>}
      </div>
      {e.at && <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--color-text-3)' }}>{fmtTime(e.at)}</span>}
    </div>
  )
  if (!e.path) return inner
  return <Link to={e.path} className="block -mx-2 px-2 rounded-lg hover:bg-[var(--color-surface-2)] transition-colors">{inner}</Link>
}

function ActivityHistoryDrawer({ allReviews, filtered, prevFiltered, periodLabel }) {
  const [open, setOpen] = useState(false)
  const { timed, signals } = useActivityFeed(allReviews, filtered, prevFiltered, periodLabel)

  const grouped = useMemo(() => {
    const out = []
    let lastBucket = null
    timed.forEach(e => {
      const bucket = dayBucket(e.at)
      if (bucket !== lastBucket) { out.push({ bucket, items: [] }); lastBucket = bucket }
      out[out.length - 1].items.push(e)
    })
    return out
  }, [timed])

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
        aria-expanded={open}
        aria-controls="today-activity-history"
      >
        <h2 className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Activity History</h2>
        <svg className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`}
             fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
             style={{ color: 'var(--color-text-3)' }} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      {open && (
        <div id="today-activity-history" className="px-5 pb-5 space-y-4">
          {signals.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--color-text-3)' }}>
                This Period's Signals{periodLabel ? ` · ${periodLabel}` : ''}
              </p>
              <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
                {signals.map((e, i) => <EventRow key={i} e={e} />)}
              </div>
            </div>
          )}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--color-text-3)' }}>Recent Activity</p>
            {grouped.length === 0 ? (
              <EmptyState icon="🕓" title="No recent activity yet"
                          body="Activity from responding to reviews, updating actions, and pipeline runs will show up here." />
            ) : (
              <div className="space-y-3">
                {grouped.map(g => (
                  <div key={g.bucket}>
                    <p className="text-xs font-bold mb-1" style={{ color: 'var(--color-text-2)' }}>{g.bucket}</p>
                    <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
                      {g.items.map(e => <EventRow key={e.id} e={e} />)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

// ── Executive Performance (in-page drawer, from Executive Dashboard) ─────────
// Reuses ExecutiveScoreCard/CompanyGoalsSection unchanged (see
// ExecutiveDashboard.jsx, which now shares these same components). Kept
// collapsed by default -- 8 score cards + 5 goal cards is a lot of
// below-the-fold content for a page returning users open daily.

function ExecutivePerformanceDrawer({ allReviews }) {
  const [open, setOpen] = useState(false)
  const { data: scores, isLoading, isError, refetch } = useExecutiveScores()

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
        aria-expanded={open}
        aria-controls="today-executive-performance"
      >
        <h2 className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Executive Performance</h2>
        <svg className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`}
             fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
             style={{ color: 'var(--color-text-3)' }} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      {open && (
        <div id="today-executive-performance" className="px-5 pb-5 space-y-6">
          <CompanyGoalsSection allReviews={allReviews} />
          {isError ? (
            <ErrorState body="Couldn't load executive scores." onRetry={refetch} />
          ) : isLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[1,2,3,4,5,6,7,8].map(i => <Skeleton key={i} className="h-40 rounded-2xl" />)}
            </div>
          ) : !scores?.length ? (
            <EmptyState icon="📊" title="No executive scores yet"
                        body="Run the analytics pipeline to generate the Executive Dashboard." />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {scores.map(s => <ExecutiveScoreCard key={s.id} s={s} />)}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function Today() {
  const { allReviews = [], filtered = [], prevFiltered = [], filters = {} } = useOutletContext() ?? {}
  const { data: trend,  isLoading: trendLoading } = useMonthlyTrend()
  const { data: stats,  isLoading: statsLoading } = useLocationStats()

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
    <div className="space-y-6 max-w-[1200px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Today</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          What needs you right now · {periodLabel ?? 'Selected period'}
        </p>
      </div>

      <KPIGrid kpis={kpis} loading={kpisLoading} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <NeedsAttention items={digest.topPriorities} isLoading={digestLoading} isError={digestError} />
        </div>
        <AIBriefingCard label="AI Executive Summary" brief={brief} summary={summary} loading={summaryLoading} periodLabel={periodLabel} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MomentumCard title="Improving" items={digest.recentWins} positive
                      emptyText="No standout wins detected this period yet." />
        <MomentumCard title="Worsening" items={digest.recentLosses} positive={false}
                      emptyText="Nothing declining this period." />
        <ReplyBacklogCard replyBacklog={replyBacklog} isLoading={replyBacklogLoading} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <RatingTrendCard trend={trend} loading={trendLoading} />
        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-label" style={{ color: 'var(--color-text-2)' }}>Location Leaderboard</h3>
            <Link to="/locations" className="text-xs font-medium" style={{ color: 'var(--color-accent)' }}>
              All locations →
            </Link>
          </div>
          <LocationLeaderboard stats={stats} loading={statsLoading} />
        </Card>
      </div>

      <ExecutivePerformanceDrawer allReviews={allReviews} />

      <ActivityHistoryDrawer allReviews={allReviews} filtered={filtered} prevFiltered={prevFiltered} periodLabel={periodLabel} />
    </div>
  )
}
