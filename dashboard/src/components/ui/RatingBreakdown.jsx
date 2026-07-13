import { getRatingBreakdown } from '../../utils/dataUtils.js'
import Card from './Card.jsx'
import Skeleton from './Skeleton.jsx'

const STAR_COLORS = ['var(--color-star-1)', 'var(--color-star-2)', 'var(--color-star-3)', 'var(--color-star-4)', 'var(--color-star-5)']

// ★5→★1 with count, %, trend arrow, and prior-period comparison — reused on
// Overview (company-wide) and LocationDetail (single location). `reviews`
// and `prevReviews` should already be scoped to whatever the caller wants
// (all locations, or one location) and respect the active filters.
export default function RatingBreakdown({ reviews, prevReviews = [], loading, title = 'Rating Breakdown' }) {
  if (loading) {
    return (
      <Card className="p-5">
        <Skeleton className="h-32 w-full" />
      </Card>
    )
  }

  const rows = getRatingBreakdown(reviews ?? [], prevReviews ?? [])
  const max = Math.max(...rows.map(r => r.count), 1)

  return (
    <Card className="p-5">
      <p className="text-label mb-3" style={{ color: 'var(--color-text-2)' }}>{title}</p>
      <div className="space-y-2">
        {rows.map(r => (
          <div key={r.star} className="flex items-center gap-2.5">
            <span className="text-xs font-semibold w-8 text-right flex-shrink-0" style={{ color: 'var(--color-text-2)' }}>
              {r.star}★
            </span>
            <div className="flex-1 h-2.5 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
              <div
                className="h-2.5 rounded-full transition-all"
                style={{ width: `${(r.count / max) * 100}%`, background: STAR_COLORS[r.star - 1] }}
              />
            </div>
            <span className="text-xs font-semibold w-9 text-right flex-shrink-0" style={{ color: 'var(--color-text-1)' }}>
              {r.count}
            </span>
            <span className="text-[10px] w-11 text-right flex-shrink-0" style={{ color: 'var(--color-text-3)' }}>
              {r.pct.toFixed(1)}%
            </span>
            <span
              className="text-xs font-semibold w-14 text-right flex-shrink-0"
              style={{ color: r.trend === 'up' ? 'var(--color-success)' : r.trend === 'down' ? 'var(--color-danger)' : 'var(--color-text-3)' }}
              title={r.trend ? `${r.prevPct.toFixed(1)}% prior period` : 'No prior-period data'}
            >
              {r.trend === 'up' ? `↑ ${r.delta.toFixed(1)}` : r.trend === 'down' ? `↓ ${Math.abs(r.delta).toFixed(1)}` : r.trend === 'stable' ? '→' : '—'}
            </span>
          </div>
        ))}
      </div>
    </Card>
  )
}
