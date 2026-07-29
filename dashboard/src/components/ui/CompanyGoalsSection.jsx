import { useMemo } from 'react'
import Card from './Card.jsx'
import { useCompanyGoals } from '../../hooks/useCompanyGoals.js'
import { useReviewWorkspace } from '../../hooks/useReviewWorkspace.js'
import { computePeriodMetrics } from '../../utils/dataUtils.js'

// Extracted from ExecutiveDashboard.jsx (M4) so Today.jsx can reuse the same
// "Are We Meeting Our Goals?" tracker without a second implementation.
// Takes allReviews as a prop instead of reading useOutletContext() itself,
// since callers (ExecutiveDashboard.jsx, Today.jsx) already have it.

const GOAL_META = [
  { key: 'avgRating',              label: 'Average Rating',        unit: '★',  direction: 'atLeast', fmt: v => v?.toFixed(2) },
  { key: 'negativePct',             label: 'Negative Reviews',       unit: '%',  direction: 'atMost',  fmt: v => v?.toFixed(1) },
  { key: 'responseRate',            label: 'Response Rate',          unit: '%',  direction: 'atLeast', fmt: v => v?.toFixed(0) },
  { key: 'avgResponseHours',        label: 'Avg Response Time',           unit: 'h', direction: 'atMost', fmt: v => v?.toFixed(1) },
  { key: 'criticalResolutionHours', label: 'Avg Critical Resolution Time', unit: 'h', direction: 'atMost', fmt: v => v?.toFixed(1) },
]

function reviewId(r) {
  return r.review_id || r.review_url || `${r.review_date}-${r.reviewer_name}`
}

// Hours from the review's date (anchored to noon, since review_date has no
// time-of-day) to when the workspace recorded a publishedAt -- approximate
// by nature of the data, disclosed in the UI rather than presented as exact.
function hoursToRespond(review, ws) {
  const entry = ws[reviewId(review)]
  if (!entry?.publishedAt || !review.review_date) return null
  const start = new Date(`${review.review_date}T12:00:00`).getTime()
  const end = new Date(entry.publishedAt).getTime()
  return Math.max(0, (end - start) / 3_600_000)
}

function computeGoalCurrent(reviews, ws) {
  const metrics = computePeriodMetrics(reviews, [])
  const negative = reviews.filter(r => (r.star_rating ?? 5) <= 2)
  const critical = reviews.filter(r => (r.star_rating ?? 5) <= 1)

  const responseHours = negative.map(r => hoursToRespond(r, ws)).filter(h => h != null)
  const avgResponseHours = responseHours.length ? responseHours.reduce((s, h) => s + h, 0) / responseHours.length : null

  const criticalHours = critical.map(r => hoursToRespond(r, ws)).filter(h => h != null)
  const criticalResolutionHours = criticalHours.length
    ? criticalHours.reduce((s, h) => s + h, 0) / criticalHours.length
    : null

  return {
    avgRating: metrics.avgRating.value,
    negativePct: metrics.negativePct.value,
    responseRate: metrics.responseRate.value,
    avgResponseHours,
    criticalResolutionHours,
  }
}

// Worst 3 locations on this specific metric, for "locations preventing success".
function worstLocations(reviews, ws, key) {
  const byLoc = {}
  reviews.forEach(r => { (byLoc[r.location_name] ??= []).push(r) })
  const scored = Object.entries(byLoc)
    .map(([name, rows]) => ({ name, value: computeGoalCurrent(rows, ws)[key], n: rows.length }))
    .filter(l => l.value != null && l.n >= 3)
  const meta = GOAL_META.find(g => g.key === key)
  scored.sort((a, b) => meta.direction === 'atLeast' ? a.value - b.value : b.value - a.value)
  return scored.slice(0, 3)
}

function GoalCard({ meta, current, target, worst }) {
  const met = current == null ? null
    : meta.direction === 'atLeast' ? current >= target : current <= target
  const gap = current == null ? null : +(meta.direction === 'atLeast' ? target - current : current - target).toFixed(2)

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>{meta.label}</p>
        {met != null && (
          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{ background: met ? 'var(--color-success-bg)' : 'var(--color-danger-bg)',
                         color: met ? 'var(--color-success)' : 'var(--color-danger)' }}>
            {met ? 'On Track' : 'Behind'}
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-3 mt-2 flex-wrap">
        <span className="text-2xl font-black" style={{ color: 'var(--color-text-1)', fontWeight: 800 }}>
          {current == null ? '—' : meta.fmt(current)}{meta.unit}
        </span>
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
          target {meta.direction === 'atLeast' ? '≥' : '≤'} {meta.fmt(target)}{meta.unit}
        </span>
      </div>
      {gap != null && !met && (
        <p className="text-xs mt-1" style={{ color: 'var(--color-danger)' }}>
          {gap > 0 ? `${meta.fmt(Math.abs(gap))}${meta.unit} short of target` : 'At target'}
        </p>
      )}
      {worst?.length > 0 && !met && (
        <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <p className="text-[9px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--color-text-3)' }}>
            Locations preventing success
          </p>
          <p className="text-xs" style={{ color: 'var(--color-text-2)' }}>
            {worst.map(l => l.name).join(', ')}
          </p>
        </div>
      )}
      {current == null && (
        <p className="text-xs mt-1 italic" style={{ color: 'var(--color-text-3)' }}>
          Not enough data in the trailing 30 days yet.
        </p>
      )}
    </Card>
  )
}

export default function CompanyGoalsSection({ allReviews = [] }) {
  const { goals } = useCompanyGoals()
  const { data: ws } = useReviewWorkspace()

  const cur30 = useMemo(() => {
    const d30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
    return allReviews.filter(r => r.review_date && r.review_date >= d30)
  }, [allReviews])

  const current = useMemo(() => computeGoalCurrent(cur30, ws), [cur30, ws])

  if (!allReviews.length) return null

  return (
    <div className="space-y-3">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em]" style={{ color: 'var(--color-text-3)' }}>
          Are We Meeting Our Goals?
        </p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
          Trailing 30 days · targets editable in Settings · response-time goals are approximate (review dates don't carry a time of day)
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {GOAL_META.map(meta => (
          <GoalCard key={meta.key} meta={meta} current={current[meta.key]} target={goals[meta.key]}
                    worst={worstLocations(cur30, ws, meta.key)} />
        ))}
      </div>
    </div>
  )
}
