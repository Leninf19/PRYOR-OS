import { useState } from 'react'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import { useActionCenter } from '../hooks/useIntelligence.js'

const PRIORITY_VARIANT = { Critical: 'danger', High: 'danger', Medium: 'warning', Low: 'neutral' }
const TYPE_ICON = { operational: '🛠', marketing: '📣', recognition: '⭐' }
const IMPACT_COLOR = { High: 'var(--color-success)', Medium: 'var(--color-grade-c)', Low: 'var(--color-text-3)' }

const TABS = ['All', 'Critical', 'High', 'Medium', 'Low']

function ActionCard({ a }) {
  const [open, setOpen] = useState(false)
  const hasReviews = a.supportingReviews?.length > 0

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span aria-hidden="true">{TYPE_ICON[a.type] ?? '📋'}</span>
            <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>{a.title}</p>
            <Badge variant={PRIORITY_VARIANT[a.priority] ?? 'neutral'}>{a.priority}</Badge>
          </div>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)' }}>{a.reason}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Impact</p>
          <p className="text-sm font-semibold mt-0.5" style={{ color: IMPACT_COLOR[a.estimatedImpact] ?? 'var(--color-text-1)' }}>
            {a.estimatedImpact}
          </p>
        </div>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Confidence</p>
          <p className="text-sm font-semibold mt-0.5" style={{ color: 'var(--color-text-1)' }}>
            {a.confidence?.label} <span className="font-normal text-xs" style={{ color: 'var(--color-text-3)' }}>(n={a.confidence?.sampleSize})</span>
          </p>
        </div>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Difficulty</p>
          <p className="text-sm font-semibold mt-0.5" style={{ color: 'var(--color-text-1)' }}>{a.difficulty}</p>
        </div>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Target</p>
          <p className="text-sm font-semibold mt-0.5" style={{ color: 'var(--color-text-1)' }}>{a.suggestedCompletionTime}</p>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <Badge variant="neutral">{a.recommendedDepartment}</Badge>
      </div>

      {a.suggestedAction && (
        <div className="mt-3 rounded-lg px-3 py-2.5"
             style={{ background: 'var(--color-accent-lt)', border: '1px solid var(--color-accent-md)' }}>
          <p className="text-[10px] uppercase tracking-widest font-bold mb-1" style={{ color: 'var(--color-accent)' }}>
            Suggested Action
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-1)' }}>{a.suggestedAction}</p>
        </div>
      )}

      {hasReviews && (
        <div className="mt-3">
          <button onClick={() => setOpen(o => !o)}
                  className="text-xs font-medium" style={{ color: 'var(--color-accent)' }}>
            {open ? 'Hide supporting reviews' : `Show ${a.supportingReviews.length} supporting review${a.supportingReviews.length > 1 ? 's' : ''}`}
          </button>
          {open && (
            <div className="space-y-2 mt-2">
              {a.supportingReviews.map((r, i) => (
                <div key={i} className="p-3 rounded-lg text-xs" style={{ background: 'var(--color-surface-2)' }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold" style={{ color: 'var(--color-text-1)' }}>
                      {r.reviewer_name || 'Anonymous'} · {r.location_name}
                    </span>
                    <span style={{ color: 'var(--color-text-3)' }}>{r.review_date}</span>
                  </div>
                  <p style={{ color: 'var(--color-text-2)' }}>"{r.review_text}"</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

export default function ActionCenter() {
  const { data: actions, isLoading } = useActionCenter()
  const [tab, setTab] = useState('All')

  const visible = tab === 'All' ? actions : (actions ?? []).filter(a => a.priority === tab)

  return (
    <div className="space-y-6 max-w-[900px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>AI Action Center</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Ranked recommendations synthesized from complaints, praise, and staff mentions — not just a data dump
        </p>
      </div>

      <div className="flex gap-1 p-1 rounded-xl w-fit flex-wrap" style={{ background: 'var(--color-surface-2)' }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
                  className="px-3.5 py-2 text-xs font-medium rounded-lg transition-all"
                  style={tab === t
                    ? { background: 'var(--color-surface)', color: 'var(--color-text-1)', boxShadow: 'var(--shadow-sm)' }
                    : { color: 'var(--color-text-2)' }}>
            {t}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1,2,3,4].map(i => <Skeleton key={i} className="h-48 rounded-2xl" />)}</div>
      ) : !visible?.length ? (
        <EmptyState icon="✓" title="No recommendations in this filter"
                    body="Try a different priority tab, or run the analytics pipeline to refresh recommendations." />
      ) : (
        <div className="space-y-3">
          {visible.map(a => <ActionCard key={a.id} a={a} />)}
        </div>
      )}
    </div>
  )
}
