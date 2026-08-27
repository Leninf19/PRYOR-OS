import Skeleton from './Skeleton.jsx'
import HealthRing from './HealthRing.jsx'
import Stat from './Stat.jsx'
import ExplainableScore from './ExplainableScore.jsx'
import { explainHealthScore } from '../../utils/dataUtils.js'

// Extracted unchanged from Overview.jsx (M4) so Today.jsx can reuse the same
// KPI row without a second implementation. Engineering Implementation Plan
// v1.0's Component Inventory explicitly requires this: "Child components
// (KPI cards, AI summary, priority list) reused unchanged" when Overview
// merges into Today.
//
// Shared chrome (card/label/link/sub) comes from ui/Stat.jsx; each card below
// passes its own bespoke value markup as children (health ring, colored
// thresholds, inline badges) since those aren't uniform enough for Stat's
// built-in value/unit/delta rendering.
//
// Today UX Simplification: `replyBacklog` ({ total, overdue, overdueHours })
// is optional so Overview.jsx (unchanged caller) keeps the old ≤2★-only
// kpis.unansweredCount reading. When passed (Today.jsx), it replaces that
// narrower number with the full reply queue -- the same data Today's old,
// separate Reply Backlog card already computed from useActionItems() --
// so there's one "need reply" number instead of two conflicting ones.
export default function KPIGrid({ kpis, loading, replyBacklog }) {
  const sent   = kpis?.period30dSentiment
  const health = kpis?.healthScore
  const delta  = kpis?.ratingDelta30d ?? 0

  if (loading) return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-24 rounded-[14px]" />)}
    </div>
  )

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      <Stat label="Health Score (30d)">
        <ExplainableScore label="Health Score" score={health?.score} explanation={explainHealthScore(health)}>
          <HealthRing score={health?.score} grade={health?.grade} size={68} />
        </ExplainableScore>
      </Stat>

      <Stat label="Avg Rating (30d)" sub={delta !== 0 ? `${delta >= 0 ? '+' : ''}${delta} vs prior period` : 'Stable'}>
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-black tracking-tight" style={{ color: 'var(--color-text-1)', fontWeight: 800 }}>
            {kpis?.avgRating30d?.toFixed(2) ?? '—'}
          </span>
          <span style={{ color: 'var(--color-text-2)' }}>★</span>
        </div>
        {delta !== 0 && (
          <span className={`text-xs font-semibold ${delta > 0 ? 'trend-up' : 'trend-down'}`}>
            {delta > 0 ? '↑' : '↓'} {Math.abs(delta)}
          </span>
        )}
      </Stat>

      <Stat label="Positive Sentiment (30d)" sub={sent ? `${sent.positiveN} of ${sent.n} reviews` : ''}>
        <span className="text-3xl font-black tracking-tight"
              style={{ color: (sent?.positive ?? 0) >= 75 ? 'var(--color-success)' : 'var(--color-text-1)', fontWeight: 800 }}>
          {sent ? `${sent.positive.toFixed(0)}%` : '—'}
        </span>
      </Stat>

      <Stat label="Reviews (30d)" sub={`${kpis?.totalReviews?.toLocaleString() ?? '—'} lifetime`}>
        <span className="text-3xl font-black tracking-tight" style={{ color: 'var(--color-text-1)', fontWeight: 800 }}>
          {sent?.n?.toLocaleString() ?? '—'}
        </span>
      </Stat>

      {replyBacklog ? (
        <Stat label="Needs Reply" link="/reviews"
              sub={replyBacklog.overdue > 0 ? `${replyBacklog.overdue} overdue >${replyBacklog.overdueHours}h` : 'all within response window'}>
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-black tracking-tight"
                  style={{ color: replyBacklog.total > 0 ? 'var(--color-danger)' : 'var(--color-text-1)', fontWeight: 800 }}>
              {replyBacklog.total}
            </span>
            {replyBacklog.overdue > 0 && (
              <span className="badge badge-danger">urgent</span>
            )}
          </div>
        </Stat>
      ) : (
        <Stat label="Needs Response" link="/actions"
              sub="unanswered ≤2★ reviews">
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-black tracking-tight"
                  style={{ color: (kpis?.unansweredCount ?? 0) > 5 ? 'var(--color-danger)' : 'var(--color-text-1)', fontWeight: 800 }}>
              {kpis?.unansweredCount ?? '—'}
            </span>
            {(kpis?.unansweredCount ?? 0) > 0 && (
              <span className="badge badge-danger">urgent</span>
            )}
          </div>
        </Stat>
      )}
    </div>
  )
}
