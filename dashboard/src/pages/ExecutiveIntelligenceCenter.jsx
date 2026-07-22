import { Link, useOutletContext } from 'react-router-dom'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import ErrorState from '../components/ui/ErrorState.jsx'
import { usePriorityDigest } from '../hooks/usePriorityDigest.js'
import { useExecutiveBrief } from '../hooks/useExecutiveBrief.js'
import { mirroredPrevRange } from '../utils/dataUtils.js'
import { COMPLAINT_CATEGORIES, PRAISE_CATEGORIES } from '../utils/textAnalysis.js'

// Phase 3 Milestone 6: the executive "Start Here" front door. Every number
// on this page is read directly from data an existing export or an existing
// dataUtils.js function already computed (see usePriorityDigest.js /
// priorityDigest.js) -- this page adds no new scoring, no new AI call, and
// no new backend export. It exists to rank and surface the top signals
// already sitting in Operations Impact / Action Center / Predictive Alerts /
// Trend Alerts / What Changed, with a link back to each source page for
// full detail. It does not replace any of them.

const SEVERITY_STYLE = {
  critical: { border: 'var(--color-danger)',  badge: 'danger'  },
  high:     { border: 'var(--color-warning)', badge: 'warning' },
  warning:  { border: 'var(--color-warning)', badge: 'warning' },
}

function buildCategoryLabelMap() {
  const map = {}
  COMPLAINT_CATEGORIES.forEach(c => { map[c.id] = c.label })
  PRAISE_CATEGORIES.forEach(p => { map[p.id] = p.label })
  return map
}
const CATEGORY_LABELS = buildCategoryLabelMap()
function categoryLabel(id) {
  return CATEGORY_LABELS[id] ?? id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── Section 1: Today's Priorities ───────────────────────────────────────────

function PriorityRow({ item }) {
  const style = SEVERITY_STYLE[item.severity] ?? SEVERITY_STYLE.warning
  return (
    <div
      className="flex items-start gap-3 py-3 px-4 border-l-4"
      style={{ borderColor: style.border }}
    >
      <span
        className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5"
        style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}
      >
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

function TodaysPriorities({ items, isLoading, isError }) {
  return (
    <Card className="overflow-hidden">
      <div className="px-5 pt-4 pb-2">
        <h2 className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Today's Priorities</h2>
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

// ── Section 2: Recent Wins ──────────────────────────────────────────────────

function WinCard({ item }) {
  return (
    <Card className="p-4 border-l-4" style={{ borderColor: 'var(--color-success)' }}>
      <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>{item.title}</p>
      <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--color-text-2)' }}>{item.explanation}</p>
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--color-text-3)' }}>
          {item.sourceLabel}
        </span>
        <Link to={item.sourcePath} className="text-[11px] font-medium hover:underline" style={{ color: 'var(--color-accent)' }}>
          View details →
        </Link>
      </div>
    </Card>
  )
}

function RecentWins({ items, isLoading }) {
  return (
    <div>
      <h2 className="text-sm font-bold mb-2" style={{ color: 'var(--color-text-1)' }}>Recent Wins</h2>
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      ) : items.length === 0 ? (
        <Card className="p-5">
          <p className="text-xs italic" style={{ color: 'var(--color-text-3)' }}>
            No standout wins detected this period yet.
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {items.map(item => <WinCard key={item.id} item={item} />)}
        </div>
      )}
    </div>
  )
}

// ── Section 3: What Changed (condensed) ─────────────────────────────────────

function WhatChangedStrip({ biggestMover, emergingTrend, nextActionsFocus }) {
  const moverUp = biggestMover && biggestMover.direction === 'up'
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Card className="p-4">
        <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--color-text-3)' }}>Biggest Mover</p>
        {biggestMover ? (
          <>
            <p className="text-sm font-bold" style={{ color: moverUp ? 'var(--color-success)' : 'var(--color-danger)' }}>
              {biggestMover.name}
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-2)' }}>
              {biggestMover.prevAvg}★ → {biggestMover.curAvg}★ ({moverUp ? '+' : ''}{biggestMover.delta})
            </p>
          </>
        ) : (
          <p className="text-xs italic" style={{ color: 'var(--color-text-3)' }}>Not enough data this period</p>
        )}
        <Link to="/what-changed" className="text-[11px] font-medium hover:underline block mt-2" style={{ color: 'var(--color-accent)' }}>
          View details →
        </Link>
      </Card>

      <Card className="p-4">
        <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--color-text-3)' }}>Emerging Trend</p>
        {emergingTrend ? (
          <>
            <p className="text-sm font-bold" style={{ color: emergingTrend.kind === 'praise' ? 'var(--color-success)' : 'var(--color-danger)' }}>
              {categoryLabel(emergingTrend.id)}
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-2)' }}>
              {emergingTrend.kind === 'praise' ? 'New compliment theme' : 'New complaint theme'} · {emergingTrend.count} mentions
            </p>
          </>
        ) : (
          <p className="text-xs italic" style={{ color: 'var(--color-text-3)' }}>No new theme emerged this period</p>
        )}
        <Link to="/what-changed" className="text-[11px] font-medium hover:underline block mt-2" style={{ color: 'var(--color-accent)' }}>
          View details →
        </Link>
      </Card>

      <Card className="p-4">
        <p className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--color-text-3)' }}>This Week's Focus</p>
        {nextActionsFocus ? (
          <>
            <ul className="space-y-1">
              {nextActionsFocus.items.map(a => (
                <li key={a.id} className="text-xs truncate" style={{ color: 'var(--color-text-1)' }}>
                  · {a.title}
                </li>
              ))}
            </ul>
            <Link to="/action-center" className="text-[11px] font-medium hover:underline block mt-2" style={{ color: 'var(--color-accent)' }}>
              View all {nextActionsFocus.total} →
            </Link>
          </>
        ) : (
          <>
            <p className="text-xs italic" style={{ color: 'var(--color-text-3)' }}>No open recommendations right now</p>
            <Link to="/action-center" className="text-[11px] font-medium hover:underline block mt-2" style={{ color: 'var(--color-accent)' }}>
              View details →
            </Link>
          </>
        )}
      </Card>
    </div>
  )
}

// ── Section 4: AI Executive Summary ─────────────────────────────────────────
// Identical pattern to What Changed.jsx's own AI card -- same hook, same
// classes, no new AI call.

function AIExecutiveSummary({ brief, periodLabel }) {
  return (
    <div className="ai-card p-6">
      <p className="ai-label mb-3">✦ AI Executive Summary</p>
      {brief.loading ? (
        <div className="space-y-2 opacity-50">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </div>
      ) : brief.text ? (
        <>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--ai-card-text-2)' }}>{brief.text}</p>
          {periodLabel && (
            <p className="text-[10px] mt-2 opacity-50">Generated live for {periodLabel}</p>
          )}
        </>
      ) : (
        <p className="text-sm italic" style={{ color: 'var(--ai-card-text-2)', opacity: 0.6 }}>
          {brief.error
            ? 'Live summary unavailable right now — the priorities above still reflect the selected period.'
            : 'Generating summary…'}
        </p>
      )}
    </div>
  )
}

// ── Section 5: Quick Links ──────────────────────────────────────────────────

const QUICK_LINKS = [
  { path: '/action-center',        label: 'Action Center' },
  { path: '/operations-impact',    label: 'Operations Impact' },
  { path: '/what-changed',         label: 'What Changed' },
  { path: '/intelligence',         label: 'Complaint Intelligence' },
  { path: '/executive-dashboard',  label: 'Executive Dashboard' },
]

function QuickLinks() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-2">
      <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
        Explore further
      </span>
      {QUICK_LINKS.map(l => (
        <Link key={l.path} to={l.path} className="text-xs font-medium hover:underline" style={{ color: 'var(--color-accent)' }}>
          {l.label}
        </Link>
      ))}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ExecutiveIntelligenceCenter() {
  const { allReviews = [], filtered = [], prevFiltered = [], filters = {} } = useOutletContext() ?? {}

  const periodLabel = filters?.start && filters?.end ? `${filters.start} — ${filters.end}` : null
  const prevPeriodLabel = mirroredPrevRange(filters)
  const brief = useExecutiveBrief(filtered, prevFiltered, periodLabel, prevPeriodLabel)
  const { data: digest, isLoading, isError } = usePriorityDigest(filtered, prevFiltered, allReviews)

  if (!filtered.length && !prevFiltered.length) {
    return <EmptyState icon="🔍" title="No data for this period" body="Try widening the selected date range." />
  }

  return (
    <div className="space-y-6 max-w-[1100px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Executive Intelligence Center</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Start here — what happened, why, and what to do today · {periodLabel ?? 'Selected period'}
        </p>
      </div>

      <TodaysPriorities items={digest.topPriorities} isLoading={isLoading} isError={isError} />

      <RecentWins items={digest.recentWins} isLoading={isLoading} />

      <div>
        <h2 className="text-sm font-bold mb-2" style={{ color: 'var(--color-text-1)' }}>What Changed</h2>
        <WhatChangedStrip
          biggestMover={digest.biggestMover}
          emergingTrend={digest.emergingTrend}
          nextActionsFocus={digest.nextActionsFocus}
        />
      </div>

      <AIExecutiveSummary brief={brief} periodLabel={periodLabel} />

      <QuickLinks />
    </div>
  )
}
