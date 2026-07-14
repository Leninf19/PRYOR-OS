import { useState } from 'react'
import Card from '../components/ui/Card.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import { useExecutiveScores } from '../hooks/useIntelligence.js'

const SCORE_ICON = {
  health: '❤️', satisfaction: '😊', reputation: '⭐', marketing: '📣',
  risk: '⚠️', manager: '👔', growth: '📈', trend: '🔮',
}

function scoreColor(score, higherIsBetter) {
  if (score == null) return 'var(--color-text-3)'
  const effective = higherIsBetter ? score : 100 - score
  if (effective >= 80) return 'var(--color-star-5)'
  if (effective >= 65) return 'var(--color-star-4)'
  if (effective >= 50) return 'var(--color-grade-c)'
  return 'var(--color-star-1)'
}

function ScoreCard({ s }) {
  const [open, setOpen] = useState(false)
  return (
    <Card className="p-5 cursor-pointer" onClick={() => setOpen(o => !o)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xl" aria-hidden="true">{SCORE_ICON[s.id] ?? '📊'}</span>
          <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>{s.label}</p>
        </div>
        {!s.higherIsBetter && (
          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{ background: 'var(--color-warning-bg)', color: 'var(--color-warning)' }}>
            Lower is better
          </span>
        )}
      </div>
      <p className="text-4xl font-black mt-3" style={{ color: scoreColor(s.score, s.higherIsBetter), fontWeight: 800 }}>
        {s.score ?? '—'}<span className="text-base font-normal" style={{ color: 'var(--color-text-3)' }}> / 100</span>
      </p>
      <button className="text-xs font-medium mt-2" style={{ color: 'var(--color-accent)' }}>
        {open ? 'Hide calculation' : 'How is this calculated?'}
      </button>
      {open && (
        <p className="text-xs leading-relaxed mt-2 pt-2 border-t" style={{ color: 'var(--color-text-2)', borderColor: 'var(--color-border)' }}>
          {s.explanation}
        </p>
      )}
    </Card>
  )
}

export default function ExecutiveDashboard() {
  const { data: scores, isLoading } = useExecutiveScores()

  return (
    <div className="space-y-6 max-w-[1200px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Executive Dashboard</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Eight composite scores summarizing company performance — every score explains exactly how it's calculated
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1,2,3,4,5,6,7,8].map(i => <Skeleton key={i} className="h-40 rounded-2xl" />)}
        </div>
      ) : !scores?.length ? (
        <EmptyState icon="📊" title="No executive scores yet"
                    body="Run the analytics pipeline to generate the Executive Dashboard." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {scores.map(s => <ScoreCard key={s.id} s={s} />)}
        </div>
      )}
    </div>
  )
}
