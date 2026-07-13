import { useState } from 'react'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import { useLocationStats, useAllLocationDetails } from '../hooks/useIntelligence.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Aggregates the real per-location staff-mention data (name-detection over
// review text, computed by find_staff_names() in refresh_analytics.py) across
// every location's intelligence/locations/{slug}.json file into one network-wide
// leaderboard. Each entry is {name, count, sentiment: positive|negative|mixed, reviews}.
function extractStaff(locationDetails) {
  if (!locationDetails?.length) return []

  const byName = {}

  locationDetails.forEach(detail => {
    (detail.staffMentions ?? []).forEach(s => {
      const key = s.name?.toLowerCase?.()
      if (!key) return
      if (!byName[key]) {
        byName[key] = { name: s.name, mentions: 0, positive: 0, locations: [], examples: [], tags: new Set() }
      }
      const count = s.count ?? 0
      byName[key].mentions += count
      byName[key].positive += s.sentiment === 'positive' ? count : s.sentiment === 'mixed' ? Math.round(count / 2) : 0
      byName[key].locations.push(detail.name)
      if (s.reviews) {
        byName[key].examples.push(...s.reviews.map(r => ({ text: r.review_text, location_name: detail.name })))
      }
    })
  })

  return Object.values(byName)
    .sort((a, b) => b.mentions - a.mentions)
    .map(e => ({ ...e, tags: [...e.tags], positivePct: e.mentions > 0 ? Math.round((e.positive / e.mentions) * 100) : 0 }))
}

// ── Sub-components ────────────────────────────────────────────────────────────

function EmployeeCard({ emp, rank }) {
  const [open, setOpen] = useState(false)
  const isHighPerformer = emp.positivePct >= 90
  return (
    <div className="card p-4 space-y-2 cursor-pointer" onClick={() => setOpen(o => !o)}>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm"
             style={{ background: isHighPerformer ? 'rgba(16,185,129,0.12)' : 'var(--color-surface-2)',
                      color: isHighPerformer ? 'var(--color-success)' : 'var(--color-text-2)' }}>
          {emp.name?.[0]?.toUpperCase() ?? '?'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>{emp.name}</p>
            {isHighPerformer && <Badge variant="success">Top Performer</Badge>}
            <span className="text-[10px] ml-auto font-semibold" style={{ color: 'var(--color-text-3)' }}>
              #{rank}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
            <span className="text-xs" style={{ color: 'var(--color-text-2)' }}>
              <strong style={{ color: 'var(--color-text-1)' }}>{emp.mentions}</strong> mention{emp.mentions !== 1 ? 's' : ''}
            </span>
            <span className="text-xs font-semibold" style={{ color: isHighPerformer ? 'var(--color-success)' : 'var(--color-text-2)' }}>
              {emp.positivePct}% positive
            </span>
          </div>
          {emp.tags.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
              {emp.tags.slice(0, 4).map(t => (
                <span key={t} className="text-[9px] px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(16,185,129,0.1)', color: 'var(--color-success)',
                               border: '1px solid rgba(16,185,129,0.2)' }}>
                  {t}
                </span>
              ))}
            </div>
          )}
          {emp.locations.length > 0 && (
            <p className="text-[10px] mt-1" style={{ color: 'var(--color-text-3)' }}>
              {[...new Set(emp.locations)].slice(0, 3).join(', ')}
            </p>
          )}
        </div>
        <svg className={`w-4 h-4 flex-shrink-0 mt-0.5 transition-transform ${open ? 'rotate-180' : ''}`}
             fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
             style={{ color: 'var(--color-text-3)' }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </div>

      {open && (
        <div className="border-t pt-3 space-y-3" style={{ borderColor: 'var(--color-border)' }}>
          {isHighPerformer && (
            <div className="rounded-lg px-3 py-2.5"
                 style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)' }}>
              <p className="text-[10px] uppercase tracking-widest font-bold mb-1"
                 style={{ color: 'var(--color-success)' }}>
                Recognition opportunity
              </p>
              <p className="text-xs" style={{ color: 'var(--color-text-1)' }}>
                {emp.name} is mentioned by name in reviews with {emp.positivePct}% positive sentiment.
                Consider recognizing them in your next manager meeting.
              </p>
            </div>
          )}
          {emp.examples.slice(0, 2).map((ex, i) => (
            <div key={i} className="p-3 rounded-lg text-xs leading-relaxed"
                 style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}>
              "{ex.text ?? ex.review_text ?? ex}"
              {ex.location_name && (
                <span className="ml-2 badge badge-neutral">{ex.location_name}</span>
              )}
            </div>
          ))}
          <p className="text-[9px]" style={{ color: 'var(--color-text-3)' }}>
            Based on customer reviews only. Sentiment reflects guest experience, not a performance evaluation.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function EmployeeIntelligence() {
  const { data: locationStats, isLoading: lStats }   = useLocationStats()
  const { data: locationDetails, isLoading: lDetails } = useAllLocationDetails(locationStats)

  if (lStats || lDetails) {
    return (
      <div className="space-y-3 max-w-[860px]">
        <Skeleton className="h-7 w-64" />
        {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
    )
  }

  const staff = extractStaff(locationDetails)

  return (
    <div className="space-y-6 max-w-[860px]">

      {/* Header */}
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Employee Intelligence</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Staff mentions detected in customer reviews — for recognition, not evaluation
        </p>
      </div>

      {/* Disclaimer */}
      <div className="rounded-xl p-4 border"
           style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)' }}>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)', lineHeight: 1.7 }}>
          <strong style={{ color: 'var(--color-text-1)' }}>Important:</strong> Staff mentions are extracted automatically
          from customer reviews. Positive mentions are recognition opportunities. Limited or negative data should be
          discussed privately with context — not used as formal performance metrics.
        </p>
      </div>

      {staff.length === 0 ? (
        <div className="space-y-4">
          <EmptyState
            icon="👥"
            title="No staff mentions detected yet"
            body="Employee Intelligence appears once the analytics pipeline detects employee names in customer reviews. This requires AI-powered name extraction to be enabled in the pipeline."
          />
          <div className="rounded-2xl p-5 border"
               style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] mb-3"
               style={{ color: 'var(--color-text-3)' }}>
              What this page will show
            </p>
            <ul className="space-y-2">
              {[
                'Employees mentioned by name in customer reviews',
                'Positive vs negative sentiment per employee',
                'Which locations each employee is mentioned at',
                'Example reviews for context',
                'Recognition opportunities for top performers',
              ].map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                        style={{ background: 'var(--color-accent)' }} />
                  <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>{item}</p>
                </li>
              ))}
            </ul>
            <p className="text-xs mt-4 pt-3 border-t" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-3)' }}>
              To enable: ensure the pipeline's AI analysis includes staff mention detection in location detail generation.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-baseline gap-3">
            <h2 className="text-title" style={{ color: 'var(--color-text-1)' }}>Staff Mentions</h2>
            <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
              {staff.length} employees identified · last 30 days
            </span>
          </div>

          {/* Top performer callout */}
          {staff[0]?.positivePct >= 90 && (
            <div className="rounded-2xl p-5 border"
                 style={{ background: 'var(--color-surface)', borderColor: 'var(--color-success)',
                          borderLeftWidth: 3 }}>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] mb-2"
                 style={{ color: 'var(--color-success)' }}>
                Recognition Spotlight
              </p>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-1)', lineHeight: 1.75 }}>
                <strong>{staff[0].name}</strong> is your most-praised employee this period —
                mentioned {staff[0].mentions} time{staff[0].mentions !== 1 ? 's' : ''} with{' '}
                {staff[0].positivePct}% positive sentiment.
                {staff[0].tags.length > 0 && ` Praised for: ${staff[0].tags.slice(0, 3).join(', ')}.`}
                {' '}Consider acknowledging this in your next team meeting.
              </p>
            </div>
          )}

          <div className="space-y-3">
            {staff.map((emp, i) => <EmployeeCard key={emp.name} emp={emp} rank={i + 1} />)}
          </div>
        </div>
      )}

    </div>
  )
}
