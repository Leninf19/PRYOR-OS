import { computePeriodMetrics } from '../../utils/dataUtils.js'
import Card from './Card.jsx'
import Skeleton from './Skeleton.jsx'

const ROWS = [
  { key: 'reviews',       label: 'Reviews',        fmt: v => v.toLocaleString(),   lowerIsBetter: false },
  { key: 'avgRating',     label: 'Average Rating', fmt: v => v != null ? `${v.toFixed(2)}★` : '—', lowerIsBetter: false },
  { key: 'positivePct',   label: 'Positive %',     fmt: v => `${v.toFixed(1)}%`,    lowerIsBetter: false },
  { key: 'neutralPct',    label: 'Neutral %',      fmt: v => `${v.toFixed(1)}%`,    lowerIsBetter: null  },
  { key: 'negativePct',   label: 'Negative %',     fmt: v => `${v.toFixed(1)}%`,    lowerIsBetter: true  },
  { key: 'responseRate',  label: 'Response Rate',  fmt: v => v != null ? `${v.toFixed(1)}%` : '—', lowerIsBetter: false },
  { key: 'reviewsPerDay', label: 'Reviews / Day',  fmt: v => v.toFixed(2),          lowerIsBetter: false },
  { key: 'ownerReplies',  label: 'Owner Replies',  fmt: v => v.toLocaleString(),   lowerIsBetter: false },
  { key: 'unanswered',    label: 'Unanswered',     fmt: v => v.toLocaleString(),   lowerIsBetter: true  },
  { key: 'netSentiment',  label: 'Net Sentiment',  fmt: v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`, lowerIsBetter: false },
]

function TrendCell({ value, prev, pctChange, lowerIsBetter }) {
  if (value == null || prev == null || pctChange == null) {
    return <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>—</span>
  }
  const diff = value - prev
  const flat = Math.abs(pctChange) < 0.5
  const good = lowerIsBetter == null ? null : (lowerIsBetter ? diff < 0 : diff > 0)
  const color = flat || good == null
    ? 'var(--color-text-3)'
    : good ? 'var(--color-success)' : 'var(--color-danger)'
  const arrow = flat ? '→' : diff > 0 ? '↑' : '↓'
  return (
    <span className="text-xs font-semibold" style={{ color }}>
      {arrow} {Math.abs(pctChange).toFixed(1)}%
    </span>
  )
}

// The full "this period vs. prior period" comparison table from the spec —
// Reviews, Avg Rating, Positive/Neutral/Negative %, Response Rate, Reviews/Day,
// Owner Replies, Unanswered, Net Sentiment. "Response time" (reply latency)
// is intentionally omitted: the data source only captures whether/what the
// owner replied, not when, so that figure would have to be fabricated.
export default function PeriodComparison({ reviews, prevReviews, loading, periodLabel, prevPeriodLabel }) {
  if (loading) {
    return (
      <Card className="p-5">
        <Skeleton className="h-64 w-full" />
      </Card>
    )
  }

  const metrics = computePeriodMetrics(reviews ?? [], prevReviews ?? [])

  return (
    <Card className="p-5 overflow-x-auto">
      <div className="flex items-center justify-between mb-4">
        <p className="text-label" style={{ color: 'var(--color-text-2)' }}>Period Comparison</p>
        <p className="text-[10px]" style={{ color: 'var(--color-text-3)' }}>
          {periodLabel ?? 'This period'} vs. {prevPeriodLabel ?? 'prior period'}
        </p>
      </div>
      <table className="w-full text-sm" style={{ minWidth: 420 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
            <th className="text-left font-semibold py-2 text-xs" style={{ color: 'var(--color-text-3)' }}>Metric</th>
            <th className="text-right font-semibold py-2 text-xs" style={{ color: 'var(--color-text-3)' }}>Current</th>
            <th className="text-right font-semibold py-2 text-xs" style={{ color: 'var(--color-text-3)' }}>Prior</th>
            <th className="text-right font-semibold py-2 text-xs" style={{ color: 'var(--color-text-3)' }}>Trend</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map(row => {
            const m = metrics[row.key]
            return (
              <tr key={row.key} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <td className="py-2 text-xs font-medium" style={{ color: 'var(--color-text-1)' }}>{row.label}</td>
                <td className="py-2 text-right text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>
                  {m.value != null ? row.fmt(m.value) : '—'}
                </td>
                <td className="py-2 text-right text-sm" style={{ color: 'var(--color-text-3)' }}>
                  {m.prev != null ? row.fmt(m.prev) : '—'}
                </td>
                <td className="py-2 text-right">
                  <TrendCell value={m.value} prev={m.prev} pctChange={m.pctChange} lowerIsBetter={row.lowerIsBetter} />
                </td>
              </tr>
            )
          })}
          <tr>
            <td className="py-2 text-xs font-medium" style={{ color: 'var(--color-text-3)' }}>Response Time</td>
            <td colSpan={3} className="py-2 text-right text-xs italic" style={{ color: 'var(--color-text-3)' }}>
              Not tracked — reply timestamps aren't captured by the data source
            </td>
          </tr>
        </tbody>
      </table>
    </Card>
  )
}
