import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import { useDepartmentPerformance } from '../hooks/useIntelligence.js'

const DEPT_ICON = {
  Kitchen: '🍳', Service: '🍽', Bar: '🍹', Management: '👔', Host: '🚪',
  Carryout: '📦', Delivery: '🛵', Cleanliness: '🧹', Bathrooms: '🚻',
  Atmosphere: '✨', Parking: '🚗', Pricing: '💰', Maintenance: '🔧',
}

function scoreColor(score) {
  if (score == null) return 'var(--color-text-3)'
  if (score >= 80) return 'var(--color-star-5)'
  if (score >= 65) return 'var(--color-star-4)'
  if (score >= 50) return 'var(--color-grade-c)'
  return 'var(--color-star-1)'
}

function DepartmentCard({ d }) {
  return (
    <Card className="p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xl" aria-hidden="true">{DEPT_ICON[d.department] ?? '📋'}</span>
          <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>{d.department}</p>
        </div>
        <Badge variant={d.trend === 'up' ? 'success' : d.trend === 'down' ? 'danger' : 'neutral'}>
          {d.trend === 'up' ? '↑' : d.trend === 'down' ? '↓' : '→'}
          {d.delta != null ? ` ${Math.abs(d.delta)}` : ''}
        </Badge>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-black" style={{ color: scoreColor(d.score), fontWeight: 800 }}>
          {d.score != null ? d.score : '—'}
        </span>
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>/ 100</span>
      </div>

      <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--color-text-2)' }}>
        <span style={{ color: 'var(--color-success)' }}>▲ {d.positiveMentions}</span>
        <span style={{ color: 'var(--color-danger)' }}>▼ {d.negativeMentions}</span>
      </div>

      {d.recurringIssue && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
            Recurring Issue
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-1)' }}>{d.recurringIssue}</p>
        </div>
      )}

      {d.topStrength && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
            Top Strength
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-1)' }}>{d.topStrength}</p>
        </div>
      )}

      {d.recommendations?.length > 0 && (
        <div className="pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--color-accent)' }}>
            AI Recommendations
          </p>
          <ul className="space-y-1.5">
            {d.recommendations.map((r, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="w-1 h-1 rounded-full mt-1.5 flex-shrink-0" style={{ background: 'var(--color-accent)' }} />
                <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)' }}>{r}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

export default function DepartmentPerformance() {
  const { data: departments, isLoading } = useDepartmentPerformance()

  return (
    <div className="space-y-6 max-w-[1100px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Department Performance</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Complaint and praise categories grouped by operational department · last 30 days vs. prior period
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1,2,3,4,5,6].map(i => <Skeleton key={i} className="h-56 rounded-2xl" />)}
        </div>
      ) : !departments?.length ? (
        <EmptyState icon="📋" title="No department signal yet"
                    body="Run the analytics pipeline to generate department performance data." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {departments.map(d => <DepartmentCard key={d.department} d={d} />)}
        </div>
      )}
    </div>
  )
}
