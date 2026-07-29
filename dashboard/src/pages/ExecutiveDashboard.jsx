import { useOutletContext } from 'react-router-dom'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import ErrorState from '../components/ui/ErrorState.jsx'
import ExecutiveScoreCard from '../components/ui/ExecutiveScoreCard.jsx'
import CompanyGoalsSection from '../components/ui/CompanyGoalsSection.jsx'
import { useExecutiveScores } from '../hooks/useIntelligence.js'

export default function ExecutiveDashboard() {
  const { allReviews = [] } = useOutletContext() ?? {}
  const { data: scores, isLoading, isError, refetch } = useExecutiveScores()

  return (
    <div className="space-y-8 max-w-[1200px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Executive Dashboard</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Eight composite scores summarizing company performance — every score explains exactly how it's calculated
        </p>
      </div>

      <CompanyGoalsSection allReviews={allReviews} />

      {isError ? (
        <ErrorState body="Couldn't load executive scores." onRetry={refetch} />
      ) : isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1,2,3,4,5,6,7,8].map(i => <Skeleton key={i} className="h-40 rounded-2xl" />)}
        </div>
      ) : !scores?.length ? (
        <EmptyState icon="📊" title="No executive scores yet"
                    body="Run the analytics pipeline to generate the Executive Dashboard." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {scores.map(s => <ExecutiveScoreCard key={s.id} s={s} />)}
        </div>
      )}
    </div>
  )
}
