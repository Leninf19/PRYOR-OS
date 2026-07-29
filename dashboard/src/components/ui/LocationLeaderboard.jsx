import Skeleton from './Skeleton.jsx'
import Badge from './Badge.jsx'
import ExplainableScore from './ExplainableScore.jsx'
import { explainHealthScore } from '../../utils/dataUtils.js'

// Extracted unchanged from Overview.jsx (M4) so Today.jsx can reuse the same
// location-ranking list without a second implementation (Design System
// Specification v1.0 Principle 3 -- one canonical location for every fact).
export default function LocationLeaderboard({ stats, loading }) {
  if (loading) return <div className="space-y-2">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-9 w-full" />)}</div>

  const ranked = (stats ?? [])
    .filter(s => s.periodSentiment?.avgRating != null)
    .sort((a, b) => (b.periodSentiment.avgRating ?? 0) - (a.periodSentiment.avgRating ?? 0))

  return (
    <div className="space-y-0.5">
      {ranked.slice(0, 10).map((loc, i) => {
        const avg    = loc.periodSentiment.avgRating ?? 0
        const health = loc.healthScore
        const barPct = `${((avg - 1) / 4) * 100}%`
        const barColor = avg >= 4.5 ? 'var(--color-star-5)' : avg >= 4.0 ? 'var(--color-star-4)' : avg >= 3.5 ? 'var(--color-grade-c)' : 'var(--color-star-1)'

        return (
          <div key={loc.name}
               className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-[var(--color-surface-2)] dark:bg-[var(--color-surface-2)] dark:hover:bg-[var(--color-surface-2)] transition-colors cursor-default">
            <span className="text-[10px] font-bold w-5 text-right flex-shrink-0"
                  style={{ color: 'var(--color-text-3)' }}>
              {i + 1}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>
                {loc.name}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <div className="flex-1 h-1 rounded-full" style={{ background: 'var(--color-border)' }}>
                  <div className="h-1 rounded-full" style={{ width: barPct, background: barColor }} />
                </div>
                <span className="text-[10px] font-bold flex-shrink-0" style={{ color: barColor }}>
                  {avg.toFixed(2)}★
                </span>
              </div>
            </div>
            {health?.grade && (
              <ExplainableScore label={`${loc.name} Health Score`} score={health.score} explanation={explainHealthScore(health)}>
                <Badge
                  variant={health.grade === 'A' ? 'success' : health.grade === 'B' ? 'info' : health.grade === 'C' ? 'warning' : 'danger'}
                  className="flex-shrink-0"
                >
                  {health.grade}
                </Badge>
              </ExplainableScore>
            )}
          </div>
        )
      })}
    </div>
  )
}
