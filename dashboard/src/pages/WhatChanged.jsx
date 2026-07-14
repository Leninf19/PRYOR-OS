import { useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import PeriodComparison from '../components/ui/PeriodComparison.jsx'
import RatingBreakdown from '../components/ui/RatingBreakdown.jsx'
import { computePeriodMetrics, getCategoryChanges, getLocationMomentum } from '../utils/dataUtils.js'
import { COMPLAINT_CATEGORIES, PRAISE_CATEGORIES } from '../utils/textAnalysis.js'
import { useExecutiveBrief } from '../hooks/useExecutiveBrief.js'

function humanize(id) {
  return id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function buildLabelMap() {
  const map = {}
  COMPLAINT_CATEGORIES.forEach(c => { map[c.id] = c.label })
  PRAISE_CATEGORIES.forEach(p => { map[p.id] = p.label })
  return map
}
const LABELS = buildLabelMap()
function labelFor(id) { return LABELS[id] ?? humanize(id) }

function mirroredPrevRange(filters) {
  if (!filters?.start || !filters?.end) return null
  const startMs = new Date(filters.start).getTime()
  const endMs   = new Date(filters.end).getTime()
  const lenMs   = endMs - startMs
  const prevStart = new Date(startMs - lenMs - 1).toISOString().slice(0, 10)
  const prevEnd   = new Date(startMs - 1).toISOString().slice(0, 10)
  return `${prevStart} — ${prevEnd}`
}

function CategoryPill({ item, variant }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg" style={{ background: 'var(--color-surface-2)' }}>
      <span className="text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>{labelFor(item.id)}</span>
      <Badge variant={variant}>{item.prevCount} → {item.count}</Badge>
    </div>
  )
}

function LocationPill({ loc }) {
  const up = loc.delta > 0
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg" style={{ background: 'var(--color-surface-2)' }}>
      <span className="text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>{loc.name}</span>
      <Badge variant={up ? 'success' : 'danger'}>
        {loc.prevAvg}★ → {loc.curAvg}★ ({up ? '+' : ''}{loc.delta})
      </Badge>
    </div>
  )
}

function ChangeSection({ title, items, variant, emptyText }) {
  if (!items?.length) {
    return (
      <div>
        <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--color-text-3)' }}>{title}</p>
        <p className="text-xs italic" style={{ color: 'var(--color-text-3)' }}>{emptyText}</p>
      </div>
    )
  }
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--color-text-3)' }}>{title}</p>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          item.name
            ? <LocationPill key={i} loc={item} />
            : <CategoryPill key={i} item={item} variant={variant} />
        ))}
      </div>
    </div>
  )
}

export default function WhatChanged() {
  const { filtered = [], prevFiltered = [], filters = {} } = useOutletContext() ?? {}

  const periodLabel = filters?.start && filters?.end ? `${filters.start} — ${filters.end}` : null
  const prevPeriodLabel = mirroredPrevRange(filters)
  const brief = useExecutiveBrief(filtered, prevFiltered, periodLabel, prevPeriodLabel)

  const categoryChanges = useMemo(() => getCategoryChanges(filtered, prevFiltered), [filtered, prevFiltered])
  const momentum = useMemo(() => getLocationMomentum(filtered, prevFiltered), [filtered, prevFiltered])
  const metrics = useMemo(() => computePeriodMetrics(filtered, prevFiltered), [filtered, prevFiltered])

  const gaining = momentum.filter(l => l.delta >= 0.15).slice(0, 5)
  const losing  = momentum.filter(l => l.delta <= -0.15).slice(-5).reverse()

  if (!filtered.length && !prevFiltered.length) {
    return <EmptyState icon="🔍" title="No data for this comparison" body="Try widening the selected date range." />
  }

  return (
    <div className="space-y-6 max-w-[1100px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>What Changed?</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          {periodLabel ?? 'Selected period'} compared with {prevPeriodLabel ?? 'the prior period'}
        </p>
      </div>

      {/* Executive summary leads, same live Copilot as AI Advisor */}
      <div className="ai-card p-6">
        <p className="ai-label mb-3">✦ Executive Summary</p>
        {brief.loading ? (
          <div className="space-y-2 opacity-50">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
          </div>
        ) : brief.text ? (
          <p className="text-sm leading-relaxed" style={{ color: 'var(--ai-card-text-2)' }}>{brief.text}</p>
        ) : (
          <p className="text-sm italic" style={{ color: 'var(--ai-card-text-2)', opacity: 0.6 }}>
            {brief.error
              ? 'Live summary unavailable right now — the breakdown below still reflects the selected periods.'
              : 'Generating summary…'}
          </p>
        )}
      </div>

      {/* Locations gaining / losing momentum */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-5">
          <ChangeSection title="Locations Gaining Momentum" items={gaining} emptyText="No location improved by 0.15★ or more this period." />
        </Card>
        <Card className="p-5">
          <ChangeSection title="Locations Losing Momentum" items={losing} emptyText="No location declined by 0.15★ or more this period." />
        </Card>
      </div>

      {/* New / resolved complaints and compliments */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-5 space-y-4">
          <ChangeSection title="New Complaints" items={categoryChanges.complaints.new} variant="danger"
                         emptyText="No newly-emerging complaint themes this period." />
          <ChangeSection title="Resolved Complaints" items={categoryChanges.complaints.resolved} variant="success"
                         emptyText="No previously-recurring complaints dropped off this period." />
        </Card>
        <Card className="p-5 space-y-4">
          <ChangeSection title="New Compliments" items={categoryChanges.praises.new} variant="success"
                         emptyText="No newly-emerging compliment themes this period." />
          <ChangeSection title="Faded Compliments" items={categoryChanges.praises.resolved} variant="neutral"
                         emptyText="No previously-common compliments dropped off this period." />
        </Card>
      </div>

      {/* Supporting breakdown */}
      <RatingBreakdown reviews={filtered} prevReviews={prevFiltered} title="Rating Breakdown" />
      <PeriodComparison reviews={filtered} prevReviews={prevFiltered} periodLabel={periodLabel} prevPeriodLabel={prevPeriodLabel} />
    </div>
  )
}
