import Card from '../components/ui/Card.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import ErrorState from '../components/ui/ErrorState.jsx'
import { useOperationsImpact } from '../hooks/useIntelligence.js'

const CARDS = [
  { key: 'biggestComplaint',         label: 'Biggest Complaint',          icon: '⚠️', tone: 'danger'  },
  { key: 'fastestGrowingComplaint',  label: 'Fastest-Growing Complaint',  icon: '📈', tone: 'danger'  },
  { key: 'biggestCompliment',        label: 'Biggest Compliment',        icon: '💬', tone: 'success' },
  { key: 'fastestGrowingCompliment', label: 'Fastest-Growing Compliment', icon: '🚀', tone: 'success' },
  { key: 'highestPerforming',        label: 'Highest-Performing Location', icon: '🏆', tone: 'success' },
  { key: 'lowestPerforming',         label: 'Lowest-Performing Location', icon: '📉', tone: 'danger'  },
  { key: 'mostConsistent',           label: 'Most Consistent Location',  icon: '⚖️', tone: 'neutral' },
  { key: 'leastConsistent',          label: 'Least Consistent Location', icon: '🎢', tone: 'warning' },
  { key: 'bestManaged',              label: 'Best-Managed Location',     icon: '👔', tone: 'success' },
  { key: 'needsAttention',           label: 'Needs Immediate Attention', icon: '🚨', tone: 'danger'  },
]

const TONE_COLOR = {
  success: 'var(--color-success)', danger: 'var(--color-danger)',
  warning: 'var(--color-grade-c)', neutral: 'var(--color-text-2)',
}

function headline(key, entry) {
  if (!entry) return '—'
  if (entry.category) return entry.category.name
  if (entry.location) return entry.location.name
  return '—'
}

function ImpactCard({ def, entry }) {
  const color = TONE_COLOR[def.tone]
  return (
    <Card className="p-5 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-lg" aria-hidden="true">{def.icon}</span>
        <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
          {def.label}
        </p>
      </div>
      <p className="text-lg font-bold" style={{ color }}>
        {headline(def.key, entry)}
      </p>
      {entry?.explanation && (
        <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)' }}>{entry.explanation}</p>
      )}
      {!entry && (
        <p className="text-xs italic" style={{ color: 'var(--color-text-3)' }}>Not enough data this period</p>
      )}
    </Card>
  )
}

export default function OperationsImpact() {
  const { data: impact, isLoading, isError, refetch } = useOperationsImpact()

  return (
    <div className="space-y-6 max-w-[1100px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Operations Impact Center</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Company-wide operational superlatives, in plain English · last 30 days vs. prior period
        </p>
      </div>

      {isError ? (
        <ErrorState body="Couldn't load operations impact data." onRetry={refetch} />
      ) : isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1,2,3,4,5,6].map(i => <Skeleton key={i} className="h-36 rounded-2xl" />)}
        </div>
      ) : !impact ? (
        <EmptyState icon="📊" title="No operations data yet"
                    body="Run the analytics pipeline to generate the Operations Impact Center." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {CARDS.map(def => <ImpactCard key={def.key} def={def} entry={impact[def.key]} />)}
        </div>
      )}
    </div>
  )
}
