import { useState } from 'react'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import { useComplaintIntel } from '../hooks/useIntelligence.js'

const SEV_LABEL = { 3: 'Critical', 2: 'Moderate', 1: 'Low' }
const SEV_BADGE = { 3: 'danger',   2: 'warning',  1: 'info' }

function TrendBadge({ trend }) {
  if (trend === 'up')   return <Badge variant="danger">↑ Rising</Badge>
  if (trend === 'down') return <Badge variant="success">↓ Falling</Badge>
  return <Badge variant="neutral">→ Stable</Badge>
}

function CategoryCard({ cat, type }) {
  const [open, setOpen] = useState(false)
  const isComplaint = type === 'complaint'

  return (
    <div
      className={`card p-4 transition-shadow cursor-pointer ${isComplaint ? `sev-${cat.severity}` : ''}`}
      onClick={() => setOpen(o => !o)}
      role="button"
      aria-expanded={open}
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setOpen(o => !o) }}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>{cat.name}</p>
            {isComplaint && (
              <Badge variant={SEV_BADGE[cat.severity]}>{SEV_LABEL[cat.severity]}</Badge>
            )}
            <TrendBadge trend={cat.trend} />
          </div>

          <div className="flex items-center gap-4 mt-1.5 flex-wrap">
            <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>
              <span className="font-bold" style={{ color: 'var(--color-text-1)' }}>{cat.count}</span> mentions
            </span>
            <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>
              {cat.pct}% of reviews
            </span>
            {cat.delta !== 0 && (
              <span className={`text-xs font-medium ${cat.delta > 0 ? (isComplaint ? 'trend-down' : 'trend-up') : (isComplaint ? 'trend-up' : 'trend-down')}`}>
                {cat.delta > 0 ? `+${cat.delta}` : cat.delta} vs prior period
              </span>
            )}
          </div>

          {/* Mini bar */}
          <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
            <div
              className="h-1.5 rounded-full transition-all"
              style={{
                width: `${Math.min(100, cat.pct * 3)}%`,
                background: isComplaint
                  ? (cat.severity === 3 ? 'var(--color-danger)' : cat.severity === 2 ? 'var(--color-grade-c)' : 'var(--color-info)')
                  : 'var(--color-success)',
              }}
            />
          </div>
        </div>

        <svg
          className="w-4 h-4 flex-shrink-0 transition-transform"
          style={{ color: 'var(--color-text-3)', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </div>

      {/* Expanded detail */}
      {open && (cat.examples?.length > 0 || cat.topLocations?.length > 0 || cat.suggestedAction) && (
        <div className="mt-4 space-y-4 border-t pt-3" style={{ borderColor: 'var(--color-border)' }}>

          {isComplaint && cat.suggestedAction && (
            <div className="rounded-lg px-3 py-2.5"
                 style={{ background: 'var(--color-accent-lt)', border: '1px solid var(--color-accent-md)' }}>
              <p className="text-[10px] uppercase tracking-widest font-bold mb-1" style={{ color: 'var(--color-accent)' }}>
                Suggested Action
              </p>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-1)' }}>{cat.suggestedAction}</p>
            </div>
          )}

          {cat.topLocations?.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--color-text-3)' }}>
                Most Affected Locations
              </p>
              <div className="flex flex-wrap gap-1.5">
                {cat.topLocations.map(l => (
                  <span key={l.name} className="badge badge-neutral">
                    {l.name} · {l.count}
                  </span>
                ))}
              </div>
            </div>
          )}

          {cat.examples?.length > 0 && (
          <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
            Example Reviews
          </p>
          {cat.examples.map((ex, i) => (
            <div key={i} className="p-3 rounded-lg" style={{ background: 'var(--color-surface-2)' }}>
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>
                  {ex.reviewer_name || 'Anonymous'}
                </p>
                <div className="flex items-center gap-2">
                  {ex.location_name && (
                    <span className="badge badge-neutral">{ex.location_name}</span>
                  )}
                  {ex.star_rating && (
                    <span className={`text-xs font-bold star-${ex.star_rating}`}>
                      {'★'.repeat(ex.star_rating)}
                    </span>
                  )}
                </div>
              </div>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
                "{ex.review_text}"
              </p>
              {ex.review_date && (
                <p className="text-[10px] mt-1" style={{ color: 'var(--color-text-3)' }}>{ex.review_date}</p>
              )}
            </div>
          ))}
          </div>
          )}
        </div>
      )}
    </div>
  )
}

function SectionHeader({ title, count, sub }) {
  return (
    <div className="flex items-baseline gap-3">
      <h2 className="text-title" style={{ color: 'var(--color-text-1)' }}>{title}</h2>
      {count != null && (
        <span className="text-sm font-medium" style={{ color: 'var(--color-text-3)' }}>
          {count} categories identified
        </span>
      )}
      {sub && <span className="text-xs ml-auto" style={{ color: 'var(--color-text-3)' }}>{sub}</span>}
    </div>
  )
}

export default function ComplaintIntelligence() {
  const { data: intel, isLoading } = useComplaintIntel()
  const [tab, setTab] = useState('complaints')

  const complaints = intel?.complaints ?? []
  const praises    = intel?.praises    ?? []

  return (
    <div className="space-y-6 max-w-[900px]">

      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Complaint Intelligence</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Operational issue classification across all 21 locations · last 30 days vs prior period
        </p>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 p-1 rounded-xl w-fit" style={{ background: 'var(--color-surface-2)' }}>
        {[
          { id: 'complaints', label: `Complaints (${complaints.length})` },
          { id: 'praises',    label: `Praise (${praises.length})` },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="px-4 py-2 text-sm font-medium rounded-lg transition-all"
            style={tab === t.id
              ? { background: 'var(--color-surface)', color: 'var(--color-text-1)', boxShadow: 'var(--shadow-sm)' }
              : { color: 'var(--color-text-2)' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Summary row */}
      {!isLoading && tab === 'complaints' && complaints.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Critical Issues',  value: complaints.filter(c => c.severity === 3).length, variant: 'danger' },
            { label: 'Moderate Issues',  value: complaints.filter(c => c.severity === 2).length, variant: 'warning' },
            { label: 'Rising Trends',    value: complaints.filter(c => c.trend === 'up').length,   variant: 'danger' },
            { label: 'Falling Trends',   value: complaints.filter(c => c.trend === 'down').length, variant: 'success' },
          ].map(s => (
            <Card key={s.label} className="p-3 text-center">
              <p className="text-2xl font-black" style={{ fontWeight: 800, color: 'var(--color-text-1)' }}>
                {s.value}
              </p>
              <p className="text-[10px] font-semibold uppercase tracking-wider mt-0.5"
                 style={{ color: 'var(--color-text-3)' }}>
                {s.label}
              </p>
            </Card>
          ))}
        </div>
      )}

      {/* Category cards */}
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : tab === 'complaints' ? (
        complaints.length === 0
          ? <EmptyState icon="✓" title="No complaint patterns detected" body="Either no negative reviews in the period, or try running the pipeline to refresh intelligence." />
          : <div className="space-y-3">
              <SectionHeader title="Complaint Categories" count={complaints.length} sub="sorted by severity" />
              {complaints.map(c => <CategoryCard key={c.id} cat={c} type="complaint" />)}
            </div>
      ) : (
        praises.length === 0
          ? <EmptyState icon="✦" title="No praise patterns detected yet" body="Run the pipeline to generate complaint and praise intelligence." />
          : <div className="space-y-3">
              <SectionHeader title="Praise Categories" count={praises.length} sub="sorted by frequency" />
              {praises.map(p => <CategoryCard key={p.id} cat={p} type="praise" />)}
            </div>
      )}
    </div>
  )
}
