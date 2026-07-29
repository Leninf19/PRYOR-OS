import { Link } from 'react-router-dom'
import Card from '../components/ui/Card.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import Badge from '../components/ui/Badge.jsx'
import SentimentBreakdown from '../components/ui/SentimentBreakdown.jsx'
import RatingBreakdown from '../components/ui/RatingBreakdown.jsx'
import PeriodComparison from '../components/ui/PeriodComparison.jsx'
import CXIndexGrid from '../components/ui/CXIndexGrid.jsx'
import RatingTrendCard from '../components/ui/RatingTrendCard.jsx'
import LocationLeaderboard from '../components/ui/LocationLeaderboard.jsx'
import AIBriefingCard from '../components/ui/AIBriefingCard.jsx'
import KPIGrid from '../components/ui/KPIGrid.jsx'
import {
  useKPIs, useCompanySummary, useMonthlyTrend, useLocationStats,
  usePredictiveAlerts, useComplaintIntel, useActionItems, useCXIndex,
} from '../hooks/useIntelligence.js'
import { useExecutiveBrief } from '../hooks/useExecutiveBrief.js'
import { mirroredPrevRange } from '../utils/dataUtils.js'

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

export default function Overview({ filtered = [], prevFiltered = [], filters = {} }) {
  const { data: kpis,    isLoading: lKpis    } = useKPIs()
  const { data: summary, isLoading: lSummary  } = useCompanySummary()
  const { data: trend,   isLoading: lTrend    } = useMonthlyTrend()
  const { data: stats,   isLoading: lStats    } = useLocationStats()
  const { data: alerts                          } = usePredictiveAlerts()
  const { data: intel,   isLoading: lIntel    } = useComplaintIntel()
  const { data: actions, isLoading: lActions  } = useActionItems()
  const { data: cxIndex, isLoading: lCX       } = useCXIndex()

  const periodLabel = filters?.start && filters?.end ? `${filters.start} — ${filters.end}` : null
  const prevPeriodLabel = mirroredPrevRange(filters)
  const brief = useExecutiveBrief(filtered, prevFiltered, periodLabel, prevPeriodLabel)

  return (
    <div className="space-y-6 max-w-[1400px]">

      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Command Center</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Real-time reputation intelligence · Los Tres Amigos · 21 Locations
        </p>
      </div>

      <AIBriefingCard label="AI Executive Intelligence" brief={brief} summary={summary} loading={lSummary} periodLabel={periodLabel} />

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
        <RatingTrendCard trend={trend} loading={lTrend} />
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
