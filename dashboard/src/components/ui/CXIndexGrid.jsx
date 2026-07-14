import Card from './Card.jsx'
import Skeleton from './Skeleton.jsx'

const DIM_ICON = {
  'Food Quality': '🍽', 'Service': '🙋', 'Atmosphere': '✨', 'Cleanliness': '🧹',
  'Value': '💰', 'Drinks': '🍹', 'Speed': '⏱', 'Accuracy': '🎯', 'Friendliness': '😊',
  'Overall Experience': '⭐',
}

function scoreColor(score) {
  if (score == null) return 'var(--color-text-3)'
  if (score >= 80) return 'var(--color-star-5)'
  if (score >= 65) return 'var(--color-star-4)'
  if (score >= 50) return 'var(--color-grade-c)'
  return 'var(--color-star-1)'
}

// Ten Customer Experience dimension scores + an Overall composite, derived
// from the same category signals as complaint intelligence (see
// build_cx_index() in refresh_analytics.py) -- not a separate AI scoring pass.
export default function CXIndexGrid({ dimensions, loading, title = 'Customer Experience Index' }) {
  if (loading) {
    return (
      <Card className="p-5">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
          {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-20 rounded-xl" />)}
        </div>
      </Card>
    )
  }
  if (!dimensions?.length) return null

  const overall = dimensions.find(d => d.dimension === 'Overall Experience')
  const rest = dimensions.filter(d => d.dimension !== 'Overall Experience')

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <p className="text-label" style={{ color: 'var(--color-text-2)' }}>{title}</p>
        {overall && (
          <span className="text-2xl font-black" style={{ color: scoreColor(overall.score), fontWeight: 800 }}>
            {overall.score ?? '—'} <span className="text-xs font-normal" style={{ color: 'var(--color-text-3)' }}>overall</span>
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
        {rest.map(d => (
          <div key={d.dimension} className="rounded-xl p-3 text-center" style={{ background: 'var(--color-surface-2)' }}
               title={d.explanation}>
            <p className="text-lg" aria-hidden="true">{DIM_ICON[d.dimension] ?? '📋'}</p>
            <p className="text-xl font-black mt-0.5" style={{ color: scoreColor(d.score), fontWeight: 800 }}>
              {d.score ?? '—'}
            </p>
            <p className="text-[9px] font-semibold uppercase tracking-wide mt-0.5" style={{ color: 'var(--color-text-3)' }}>
              {d.dimension}
            </p>
            {d.trend !== 'stable' && d.delta != null && (
              <p className="text-[9px] font-semibold mt-0.5"
                 style={{ color: d.trend === 'up' ? 'var(--color-success)' : 'var(--color-danger)' }}>
                {d.trend === 'up' ? '↑' : '↓'} {Math.abs(d.delta)}
              </p>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}
