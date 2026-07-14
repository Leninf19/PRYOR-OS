import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts'
import Card from '../components/ui/Card.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import HealthRing from '../components/ui/HealthRing.jsx'
import Badge from '../components/ui/Badge.jsx'
import SentimentBreakdown from '../components/ui/SentimentBreakdown.jsx'
import RatingBreakdown from '../components/ui/RatingBreakdown.jsx'
import PeriodComparison from '../components/ui/PeriodComparison.jsx'
import CXIndexGrid from '../components/ui/CXIndexGrid.jsx'
import {
  useKPIs, useCompanySummary, useMonthlyTrend, useLocationStats,
  usePredictiveAlerts, useComplaintIntel, useActionItems, useCXIndex,
} from '../hooks/useIntelligence.js'

// ─── AI Summary ──────────────────────────────────────────────────────────────

function AISummaryCard({ summary, loading }) {
  return (
    <div className="ai-card p-6">
      <div className="flex items-center gap-2 mb-3">
        <span className="ai-label">✦ AI Executive Intelligence</span>
        <span className="text-[10px] ml-auto opacity-40">
          {summary?.generatedAt ? new Date(summary.generatedAt).toLocaleDateString() : ''}
        </span>
      </div>
      {loading ? (
        <div className="space-y-2 opacity-30">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </div>
      ) : summary?.text ? (
        <p className="text-sm leading-relaxed" style={{ color: 'var(--ai-card-text-2)' }}>{summary.text}</p>
      ) : (
        <p className="text-sm italic" style={{ color: 'var(--ai-card-text-2)', opacity: 0.5 }}>
          AI summary will appear here once ANTHROPIC_API_KEY is added to GitHub secrets.
        </p>
      )}
    </div>
  )
}

// ─── KPI row ─────────────────────────────────────────────────────────────────

function KPICard({ label, children, sub, link }) {
  const inner = (
    <div className="card p-4 flex flex-col gap-1.5 min-w-0 h-full">
      <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--color-text-3)' }}>
        {label}
      </p>
      {children}
      {sub && <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>{sub}</p>}
    </div>
  )
  if (link) return <Link to={link} className="block card-hover rounded-[14px]">{inner}</Link>
  return inner
}

function KPIGrid({ kpis, loading }) {
  const sent   = kpis?.period30dSentiment
  const health = kpis?.healthScore
  const delta  = kpis?.ratingDelta30d ?? 0

  if (loading) return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-24 rounded-[14px]" />)}
    </div>
  )

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      <KPICard label="Health Score">
        <HealthRing score={health?.score} grade={health?.grade} size={68} />
      </KPICard>

      <KPICard label="Avg Rating (30d)" sub={delta !== 0 ? `${delta >= 0 ? '+' : ''}${delta} vs prior period` : 'Stable'}>
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-black tracking-tight" style={{ color: 'var(--color-text-1)', fontWeight: 800 }}>
            {kpis?.avgRating30d?.toFixed(2) ?? '—'}
          </span>
          <span style={{ color: 'var(--color-text-2)' }}>★</span>
        </div>
        {delta !== 0 && (
          <span className={`text-xs font-semibold ${delta > 0 ? 'trend-up' : 'trend-down'}`}>
            {delta > 0 ? '↑' : '↓'} {Math.abs(delta)}
          </span>
        )}
      </KPICard>

      <KPICard label="Positive Sentiment" sub={sent ? `${sent.positiveN} of ${sent.n} reviews` : ''}>
        <span className="text-3xl font-black tracking-tight"
              style={{ color: (sent?.positive ?? 0) >= 75 ? 'var(--color-success)' : 'var(--color-text-1)', fontWeight: 800 }}>
          {sent ? `${sent.positive.toFixed(0)}%` : '—'}
        </span>
      </KPICard>

      <KPICard label="Reviews (30d)" sub={`${kpis?.totalReviews?.toLocaleString() ?? '—'} lifetime`}>
        <span className="text-3xl font-black tracking-tight" style={{ color: 'var(--color-text-1)', fontWeight: 800 }}>
          {sent?.n?.toLocaleString() ?? '—'}
        </span>
      </KPICard>

      <KPICard label="Needs Response" link="/actions"
               sub="unanswered ≤2★ reviews">
        <div className="flex items-baseline gap-1.5">
          <span className="text-3xl font-black tracking-tight"
                style={{ color: (kpis?.unansweredCount ?? 0) > 5 ? 'var(--color-danger)' : 'var(--color-text-1)', fontWeight: 800 }}>
            {kpis?.unansweredCount ?? '—'}
          </span>
          {(kpis?.unansweredCount ?? 0) > 0 && (
            <span className="badge badge-danger">urgent</span>
          )}
        </div>
      </KPICard>
    </div>
  )
}

// ─── Trend sparkline ─────────────────────────────────────────────────────────

function TrendCard({ trend, loading }) {
  const last12 = useMemo(() => (trend ?? []).slice(-12), [trend])

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-label" style={{ color: 'var(--color-text-2)' }}>Rating Trend</h3>
        <Badge variant="neutral">12 months</Badge>
      </div>
      {loading ? <Skeleton className="h-32 w-full" /> : (
        <>
          <ResponsiveContainer width="100%" height={80}>
            <LineChart data={last12}>
              <Line type="monotone" dataKey="avg" stroke="var(--color-accent)"
                    strokeWidth={2.5} dot={false} />
              <Tooltip
                contentStyle={{ fontSize: 11, border: '1px solid var(--color-border)', borderRadius: 8, boxShadow: 'var(--shadow-md)' }}
                formatter={(v) => [v ? `${v}★` : '—', 'Avg']}
                labelFormatter={(l) => l}
              />
            </LineChart>
          </ResponsiveContainer>
          <div className="mt-3 grid grid-cols-4 gap-1.5">
            {last12.slice(-4).map(m => (
              <div key={m.ym} className="text-center py-1.5 rounded-lg"
                   style={{ background: 'var(--color-surface-2)' }}>
                <p className="text-[9px] font-medium" style={{ color: 'var(--color-text-3)' }}>
                  {m.ym.slice(5)}
                </p>
                <p className="text-sm font-bold mt-0.5" style={{ color: 'var(--color-text-1)' }}>
                  {m.avg ?? '—'}
                </p>
                <p className="text-[9px]" style={{ color: 'var(--color-text-3)' }}>
                  {m.count}
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  )
}

// ─── Priority queue ───────────────────────────────────────────────────────────

function PriorityQueue({ items, loading }) {
  const urgent = items?.unanswered?.slice(0, 4) ?? []

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-label" style={{ color: 'var(--color-text-2)' }}>Needs Response</h3>
        {urgent.length > 0 && <Badge variant="danger">{items?.unanswered?.length} pending</Badge>}
      </div>
      {loading ? (
        <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : urgent.length === 0 ? (
        <div className="py-8 text-center">
          <div className="text-3xl mb-2">✓</div>
          <p className="text-sm font-semibold" style={{ color: 'var(--color-success)' }}>All caught up</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>No unanswered negative reviews</p>
        </div>
      ) : (
        <div className="space-y-2">
          {urgent.map((r, i) => (
            <div key={i} className="p-3 rounded-xl"
                 style={{ background: 'var(--color-danger-bg)', borderLeft: '3px solid var(--color-danger-border)' }}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>
                    {r.reviewer_name || 'Anonymous'}
                    <span className="font-normal ml-1.5" style={{ color: 'var(--color-text-3)' }}>
                      · {r.location_name}
                    </span>
                  </p>
                  {r.review_text && (
                    <p className="text-xs mt-0.5 line-clamp-1" style={{ color: 'var(--color-text-2)' }}>
                      {r.review_text}
                    </p>
                  )}
                </div>
                <span className="badge badge-danger flex-shrink-0">{'★'.repeat(r.star_rating ?? 1)}</span>
              </div>
            </div>
          ))}
          <Link to="/actions" className="block text-center text-xs font-medium pt-1"
                style={{ color: 'var(--color-accent)' }}>
            Open Response Center →
          </Link>
        </div>
      )}
    </Card>
  )
}

// ─── Complaint snapshot ───────────────────────────────────────────────────────

function ComplaintSnapshot({ intel, loading }) {
  const complaints = intel?.complaints?.slice(0, 5) ?? []

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-label" style={{ color: 'var(--color-text-2)' }}>Top Complaints</h3>
        <Badge variant="neutral">30 days</Badge>
      </div>
      {loading ? (
        <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : !complaints.length ? (
        <p className="text-sm" style={{ color: 'var(--color-text-3)' }}>No complaint patterns identified</p>
      ) : (
        <div className="space-y-1.5">
          {complaints.map(c => (
            <div key={c.id}
                 className={`flex items-center gap-3 px-3 py-2 rounded-lg sev-${c.severity}`}
                 style={{ background: 'var(--color-surface-2)' }}>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>{c.name}</p>
                <p className="text-[10px]" style={{ color: 'var(--color-text-3)' }}>
                  {c.count} mentions · {c.pct}%
                </p>
              </div>
              <Badge variant={c.trend === 'up' ? 'danger' : c.trend === 'down' ? 'success' : 'neutral'}>
                {c.trend === 'up' ? '↑' : c.trend === 'down' ? '↓' : '→'}
              </Badge>
            </div>
          ))}
          <Link to="/intelligence" className="block text-center text-xs font-medium pt-1"
                style={{ color: 'var(--color-accent)' }}>
            Full complaint analysis →
          </Link>
        </div>
      )}
    </Card>
  )
}

// ─── Location leaderboard ─────────────────────────────────────────────────────

function LocationLeaderboard({ stats, loading }) {
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
               className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-stone-50 dark:bg-[var(--color-surface-2)] dark:hover:bg-[var(--color-surface-2)] transition-colors cursor-default">
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
              <Badge
                variant={health.grade === 'A' ? 'success' : health.grade === 'B' ? 'info' : health.grade === 'C' ? 'warning' : 'danger'}
                className="flex-shrink-0"
              >
                {health.grade}
              </Badge>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Predictive alerts ────────────────────────────────────────────────────────

function AlertBanner({ alerts }) {
  if (!alerts?.length) return null
  return (
    <div className="space-y-2">
      {alerts.slice(0, 2).map((a, i) => (
        <div key={i} className="flex items-start gap-3 p-4 rounded-xl border"
             style={{ background: 'var(--color-danger-bg)', borderColor: 'var(--color-danger-border)' }}>
          <span className="text-lg flex-shrink-0">⚡</span>
          <div>
            <p className="text-xs font-bold" style={{ color: 'var(--color-danger)' }}>Predictive Alert</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-2)' }}>{a.message}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Overview({ filtered = [], prevFiltered = [] }) {
  const { data: kpis,    isLoading: lKpis    } = useKPIs()
  const { data: summary, isLoading: lSummary  } = useCompanySummary()
  const { data: trend,   isLoading: lTrend    } = useMonthlyTrend()
  const { data: stats,   isLoading: lStats    } = useLocationStats()
  const { data: alerts                          } = usePredictiveAlerts()
  const { data: intel,   isLoading: lIntel    } = useComplaintIntel()
  const { data: actions, isLoading: lActions  } = useActionItems()
  const { data: cxIndex, isLoading: lCX       } = useCXIndex()

  return (
    <div className="space-y-6 max-w-[1400px]">

      <div>
        <h2 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Command Center</h2>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Real-time reputation intelligence · Los Tres Amigos · 21 Locations
        </p>
      </div>

      <AISummaryCard summary={summary} loading={lSummary} />

      <AlertBanner alerts={alerts} />

      <KPIGrid kpis={kpis} loading={lKpis} />

      <CXIndexGrid dimensions={cxIndex} loading={lCX} />

      {/* Review classification + rating breakdown — driven live by the global
          filter bar (date/brand/location/stars), unlike the KPI row above
          which reflects the pipeline's fixed trailing-30-day snapshot. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <SentimentBreakdown reviews={filtered} />
        <RatingBreakdown reviews={filtered} prevReviews={prevFiltered} title="Rating Breakdown (selected period)" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <TrendCard trend={trend} loading={lTrend} />
        <PriorityQueue items={actions} loading={lActions} />
        <ComplaintSnapshot intel={intel} loading={lIntel} />
      </div>

      <PeriodComparison reviews={filtered} prevReviews={prevFiltered} />

      <Card className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-label" style={{ color: 'var(--color-text-2)' }}>Location Performance</h3>
          <Link to="/locations" className="text-xs font-medium" style={{ color: 'var(--color-accent)' }}>
            All locations →
          </Link>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10">
          <LocationLeaderboard stats={stats?.slice(0, Math.ceil((stats?.length ?? 0) / 2))} loading={lStats} />
          <LocationLeaderboard stats={stats?.slice(Math.ceil((stats?.length ?? 0) / 2))} loading={lStats} />
        </div>
      </Card>

    </div>
  )
}
