import { getSentiment } from '../../utils/dataUtils.js'
import Card from './Card.jsx'
import Skeleton from './Skeleton.jsx'

const ROWS = [
  { key: 'positiveN', pctKey: 'positive', label: 'Positive', icon: '✅', color: 'var(--color-success)', bg: 'var(--color-success-bg)' },
  { key: 'neutralN',  pctKey: 'neutral',  label: 'Neutral',  icon: '😐', color: 'var(--color-warning)', bg: 'var(--color-warning-bg)' },
  { key: 'badN',      pctKey: 'bad',      label: 'Negative', icon: '❌', color: 'var(--color-danger)',  bg: 'var(--color-danger-bg)'  },
]

// The exact "Total / Positive / Neutral / Negative" classification card from
// the spec — driven by AI sentiment (getSentiment reads ai_sentiment with a
// star-based fallback), so it reflects what reviews actually say, not just
// their star rating. Always fed `reviews` that already respect every active
// filter (date/brand/location/stars) — no filtering logic lives in here.
//
// Recovery Milestone (Reviews Analytics KPI): header relabeled from "Review
// Classification" to "Reviews Received" -- the exact count here is the same
// filtered-dataset total already shown as the plain "N reviews" badge in the
// global filter bar (App.jsx), just without a clear label tying the two
// together or breaking out how many of those N were positive/neutral/
// negative. No count/percentage math changed here; getSentiment() already
// used `reviews.length` (every review passed in) as the percentage
// denominator, not just the ones with a resolvable sentiment bucket -- the
// two optional additions below (periodLabel, showSummaryLine) are additive
// and default to their old no-op behavior, so every existing caller
// (Overview.jsx, LocationDetail.jsx, ExecutiveReports.jsx) is unaffected
// beyond this one label change.
export default function SentimentBreakdown({ reviews, loading, periodLabel, showSummaryLine = false }) {
  if (loading) {
    return (
      <Card className="p-5">
        <Skeleton className="h-24 w-full" />
      </Card>
    )
  }

  const sent = getSentiment(reviews ?? [])

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-1">
        <p className="text-label" style={{ color: 'var(--color-text-2)' }}>Reviews Received</p>
        <span className="text-2xl font-black" style={{ color: 'var(--color-text-1)', fontWeight: 800 }}>
          {sent.n.toLocaleString()}
        </span>
      </div>
      {periodLabel && (
        <p className="text-[11px] mb-3" style={{ color: 'var(--color-text-3)' }}>{periodLabel}</p>
      )}
      <div className="grid grid-cols-3 gap-3 mt-3">
        {ROWS.map(row => {
          const count = sent[row.key]
          const pct = sent[row.pctKey]
          return (
            <div key={row.key} className="rounded-xl p-3" style={{ background: row.bg }}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <span>{row.icon}</span>
                <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: row.color }}>
                  {row.label}
                </span>
              </div>
              <p className="text-2xl font-black" style={{ color: row.color, fontWeight: 800 }}>
                {count.toLocaleString()}
              </p>
              <p className="text-xs font-medium" style={{ color: row.color, opacity: 0.85 }}>
                {sent.n ? `${pct.toFixed(1)}% of reviews` : '0%'}
              </p>
            </div>
          )
        })}
      </div>
      {showSummaryLine && sent.n > 0 && (
        <p className="text-xs mt-3 pt-3 border-t" style={{ color: 'var(--color-text-2)', borderColor: 'var(--color-border)' }}>
          {sent.n.toLocaleString()} reviews received · {sent.positive.toFixed(1)}% positive · {sent.bad.toFixed(1)}% negative
        </p>
      )}
    </Card>
  )
}
