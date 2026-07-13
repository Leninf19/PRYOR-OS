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
export default function SentimentBreakdown({ reviews, loading }) {
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
      <div className="flex items-center justify-between mb-4">
        <p className="text-label" style={{ color: 'var(--color-text-2)' }}>Review Classification</p>
        <span className="text-2xl font-black" style={{ color: 'var(--color-text-1)', fontWeight: 800 }}>
          {sent.n.toLocaleString()}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
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
                {sent.n ? count.toLocaleString() : '—'}
              </p>
              <p className="text-xs font-medium" style={{ color: row.color, opacity: 0.85 }}>
                {sent.n ? `${pct.toFixed(1)}%` : '—'}
              </p>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
