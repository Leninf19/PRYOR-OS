import { useMemo } from 'react'
import { useOutletContext, Link } from 'react-router-dom'
import Card from '../components/ui/Card.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import { useActivityFeed } from '../hooks/useActivityFeed.js'

function dayBucket(iso) {
  const d = new Date(iso)
  const now = new Date()
  const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function EventRow({ e }) {
  const inner = (
    <div className="flex items-start gap-3 py-2.5">
      <span className="text-base flex-shrink-0 w-6 text-center" aria-hidden="true">{e.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium" style={{ color: 'var(--color-text-1)' }}>{e.title}</p>
        {e.sub && <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--color-text-3)' }}>{e.sub}</p>}
      </div>
      {e.at && (
        <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--color-text-3)' }}>{fmtTime(e.at)}</span>
      )}
    </div>
  )
  if (!e.path) return inner
  return <Link to={e.path} className="block -mx-2 px-2 rounded-lg hover:bg-stone-50 dark:hover:bg-[var(--color-surface-2)] transition-colors">{inner}</Link>
}

export default function ActivityTimeline() {
  const { allReviews = [], filtered = [], prevFiltered = [], filters = {} } = useOutletContext() ?? {}
  const periodLabel = filters?.start && filters?.end ? `${filters.start} — ${filters.end}` : null
  const { timed, signals } = useActivityFeed(allReviews, filtered, prevFiltered, periodLabel)

  const grouped = useMemo(() => {
    const out = []
    let lastBucket = null
    timed.forEach(e => {
      const bucket = dayBucket(e.at)
      if (bucket !== lastBucket) {
        out.push({ bucket, items: [] })
        lastBucket = bucket
      }
      out[out.length - 1].items.push(e)
    })
    return out
  }, [timed])

  return (
    <div className="space-y-6 max-w-[900px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Activity Timeline</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Everything that's happened recently — new reviews, responses, notes, and reports — so you can trust the data is current
        </p>
      </div>

      {signals.length > 0 && (
        <Card className="p-5">
          <p className="text-[10px] font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--color-text-3)' }}>
            This Period's Signals{periodLabel ? ` · ${periodLabel}` : ''}
          </p>
          <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
            {signals.map((e, i) => <EventRow key={i} e={e} />)}
          </div>
        </Card>
      )}

      <div>
        <p className="text-[10px] font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--color-text-3)' }}>
          Recent Activity
        </p>
        {grouped.length === 0 ? (
          <EmptyState icon="🕓" title="No recent activity yet"
                      body="Activity from responding to reviews, updating actions, and pipeline runs will show up here." />
        ) : (
          <div className="space-y-4">
            {grouped.map(g => (
              <Card key={g.bucket} className="p-5">
                <p className="text-xs font-bold mb-1" style={{ color: 'var(--color-text-2)' }}>{g.bucket}</p>
                <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
                  {g.items.map(e => <EventRow key={e.id} e={e} />)}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
