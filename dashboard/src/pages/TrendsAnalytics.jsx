import { useState } from 'react'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, Cell } from 'recharts'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import ErrorState from '../components/ui/ErrorState.jsx'
import Tabs from '../components/ui/Tabs.jsx'
import { useMonthlyTrend, useRankings, useLocationStats, usePredictiveAlerts } from '../hooks/useIntelligence.js'

// ─── Rankings tab ─────────────────────────────────────────────────────────────

function RankingsTab() {
  const { data: rankings, isLoading, isError, refetch } = useRankings()

  if (isError) return <ErrorState body="Couldn't load rankings data." onRetry={refetch} />
  if (isLoading) return <div className="space-y-2">{[1,2,3,4,5].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
  if (!rankings?.length) return <EmptyState icon="📊" title="No ranking data yet" />

  const rated = rankings.filter(r => r.curAvgRating != null).sort((a, b) => (b.curAvgRating ?? 0) - (a.curAvgRating ?? 0))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Bar chart */}
        <Card className="p-5">
          <p className="text-label mb-4" style={{ color: 'var(--color-text-2)' }}>Avg Rating by Location (30d)</p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={rated} layout="vertical" margin={{ left: 0, right: 16 }}>
              <XAxis type="number" domain={[1, 5]} tick={{ fontSize: 10 }} tickCount={5} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={100}
                     tickFormatter={n => n.split(' ').slice(-1)[0]} />
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
              <Tooltip
                contentStyle={{ fontSize: 11, border: '1px solid var(--color-border)', borderRadius: 8 }}
                formatter={(v) => [`${v}★`, 'Avg rating']}
              />
              <Bar dataKey="curAvgRating" radius={[0, 4, 4, 0]}>
                {rated.map(r => (
                  <Cell key={r.name}
                        fill={(r.curAvgRating ?? 0) >= 4.5 ? 'var(--color-star-5)'
                              : (r.curAvgRating ?? 0) >= 4.0 ? 'var(--color-star-4)'
                              : (r.curAvgRating ?? 0) >= 3.5 ? 'var(--color-grade-c)'
                              : 'var(--color-star-1)'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>

        {/* Table */}
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table" style={{ minWidth: 480 }}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Location</th>
                  <th>30d Rating</th>
                  <th>vs Prior</th>
                  <th>Reviews</th>
                </tr>
              </thead>
              <tbody>
                {rated.map((r, i) => {
                  const delta = r.avgDelta
                  return (
                    <tr key={r.name}>
                      <td className="text-xs font-bold" style={{ color: 'var(--color-text-3)' }}>{i + 1}</td>
                      <td>
                        <p className="text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>{r.name}</p>
                      </td>
                      <td>
                        <span className="text-sm font-bold"
                              style={{ color: (r.curAvgRating ?? 0) >= 4 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                          {r.curAvgRating?.toFixed(2) ?? '—'}★
                        </span>
                      </td>
                      <td>
                        {delta != null ? (
                          <span className={`text-xs font-semibold ${delta > 0 ? 'trend-up' : delta < 0 ? 'trend-down' : 'trend-flat'}`}>
                            {delta > 0 ? '+' : ''}{delta.toFixed(2)}
                          </span>
                        ) : <span style={{ color: 'var(--color-text-3)' }}>—</span>}
                      </td>
                      <td className="text-xs" style={{ color: 'var(--color-text-3)' }}>{r.curN}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  )
}

// ─── Trend tab ────────────────────────────────────────────────────────────────

function TrendTab() {
  const { data: trend, isLoading, isError, refetch } = useMonthlyTrend()
  const last24 = (trend ?? []).slice(-24)

  if (isError) return <ErrorState body="Couldn't load monthly trend data." onRetry={refetch} />
  if (isLoading) return <Skeleton className="h-64 w-full" />

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center justify-between mb-4">
          <p className="text-label" style={{ color: 'var(--color-text-2)' }}>Company Rating Trend</p>
          <Badge variant="neutral">24 months</Badge>
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={last24}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="ym" tick={{ fontSize: 9, fill: 'var(--color-text-3)' }}
                   tickFormatter={v => v.slice(5)} interval={1} />
            <YAxis domain={[1, 5]} tick={{ fontSize: 9 }} width={28} />
            <Tooltip
              contentStyle={{ fontSize: 11, border: '1px solid var(--color-border)', borderRadius: 8 }}
              formatter={(v) => [v ? `${v}★` : '—', 'Avg rating']}
            />
            <Line type="monotone" dataKey="avg" stroke="var(--color-accent)" strokeWidth={2.5}
                  dot={{ r: 2, fill: 'var(--color-accent)' }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      {/* Review volume chart */}
      <Card className="p-5">
        <p className="text-label mb-4" style={{ color: 'var(--color-text-2)' }}>Review Volume</p>
        <ResponsiveContainer width="100%" height={100}>
          <BarChart data={last24}>
            <XAxis dataKey="ym" tick={{ fontSize: 9 }} tickFormatter={v => v.slice(5)} interval={2} />
            <Tooltip
              contentStyle={{ fontSize: 11, border: '1px solid var(--color-border)', borderRadius: 8 }}
              formatter={(v) => [v, 'Reviews']}
            />
            <Bar dataKey="count" fill="var(--color-accent-md)" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>
    </div>
  )
}

// ─── Predictions tab ──────────────────────────────────────────────────────────

function PredictionsTab() {
  const { data: stats,  isLoading: lStats,  isError: eStats,  refetch: rStats  } = useLocationStats()
  const { data: alerts, isLoading: lAlerts, isError: eAlerts, refetch: rAlerts } = usePredictiveAlerts()

  if (eStats || eAlerts) return <ErrorState body="Couldn't load predictions data." onRetry={() => { rStats(); rAlerts() }} />
  if (lStats || lAlerts) return <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-20 w-full" />)}</div>

  const withPred = (stats ?? []).filter(s => s.predictedRating != null).sort((a, b) => (a.predictedRating ?? 0) - (b.predictedRating ?? 0))

  return (
    <div className="space-y-4">

      {alerts?.length > 0 && (
        <div className="space-y-2">
          <p className="text-label" style={{ color: 'var(--color-text-2)' }}>Active Alerts</p>
          {alerts.map((a, i) => (
            <div key={i} className="flex items-start gap-3 p-4 rounded-xl"
                 style={{ background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger-border)' }}>
              <span className="text-xl">⚡</span>
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--color-danger)' }}>
                  {a.type === 'rating_drop_warning' ? 'Rating Drop Warning' : 'Declining Trend'}
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-2)' }}>{a.message}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {withPred.length > 0 ? (
        <>
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table" style={{ minWidth: 560 }}>
              <thead>
                <tr>
                  <th>Location</th>
                  <th>Current Rating</th>
                  <th>Projected (30d)</th>
                  <th>Direction</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {withPred.map(loc => {
                  const cur  = loc.periodSentiment?.avgRating
                  const pred = loc.predictedRating
                  const conf = loc.predictedRatingConfidence
                  const dir  = cur && pred ? pred - cur : 0
                  return (
                    <tr key={loc.name}>
                      <td>
                        <p className="text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>{loc.name}</p>
                        <p className="text-[10px]" style={{ color: 'var(--color-text-3)' }}>{loc.city}</p>
                      </td>
                      <td>
                        <span className="text-sm font-bold"
                              style={{ color: (cur ?? 0) >= 4 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                          {cur?.toFixed(2) ?? '—'}★
                        </span>
                      </td>
                      <td>
                        <span className="text-sm font-bold"
                              style={{ color: (pred ?? 0) >= 4 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                          {pred?.toFixed(2) ?? '—'}★
                        </span>
                      </td>
                      <td>
                        <span className={`text-xs font-semibold ${dir > 0.05 ? 'trend-up' : dir < -0.05 ? 'trend-down' : 'trend-flat'}`}>
                          {dir > 0.05 ? `↑ +${dir.toFixed(2)}` : dir < -0.05 ? `↓ ${dir.toFixed(2)}` : '→ Stable'}
                        </span>
                      </td>
                      <td>
                        {conf && <Badge variant={conf.level === 'high' ? 'success' : conf.level === 'moderate' ? 'warning' : 'neutral'}>{conf.label}</Badge>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
        <p className="text-[10px]" style={{ color: 'var(--color-text-3)' }}>
          AI-generated forecasts based on historical trend, not a guarantee of future performance.
        </p>
        </>
      ) : (
        <EmptyState icon="📈" title="Predictions not yet available"
                    body="Predictions require at least 3 months of review history per location. Run the pipeline to generate." />
      )}
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'trend',       label: 'Company Trend' },
  { id: 'rankings',   label: 'Rankings' },
  { id: 'predictions', label: 'Predictions' },
]

export default function TrendsAnalytics({ allReviews, filtered, prevFiltered }) {
  const [tab, setTab] = useState('trend')

  return (
    <div className="space-y-6 max-w-[1100px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Trends & Predictions</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Rating trends, location rankings, and 30-day forecasts
        </p>
      </div>

      {/* Tabs */}
      <Tabs tabs={TABS} value={tab} onChange={setTab} wrap={false} />

      {tab === 'trend'       && <TrendTab />}
      {tab === 'rankings'   && <RankingsTab />}
      {tab === 'predictions' && <PredictionsTab />}
    </div>
  )
}
