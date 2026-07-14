import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ResponsiveContainer, LineChart, Line, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import HealthRing from '../components/ui/HealthRing.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import SentimentBreakdown from '../components/ui/SentimentBreakdown.jsx'
import RatingBreakdown from '../components/ui/RatingBreakdown.jsx'
import PeriodComparison from '../components/ui/PeriodComparison.jsx'
import CXIndexGrid from '../components/ui/CXIndexGrid.jsx'
import ExplainableScore from '../components/ui/ExplainableScore.jsx'
import { useLocationStats, useLocationDetail, usePrefetchLocationDetails } from '../hooks/useIntelligence.js'
import { explainHealthScore } from '../utils/dataUtils.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

const STAR_COLORS = ['var(--color-star-1)','var(--color-star-2)','var(--color-star-3)','var(--color-star-4)','var(--color-star-5)']

// ─── Sub-components ───────────────────────────────────────────────────────────

function StarBreakdown({ breakdown }) {
  const max = Math.max(...(breakdown ?? []).map(d => d.count), 1)
  return (
    <div className="space-y-1.5">
      {[...(breakdown ?? [])].reverse().map(d => (
        <div key={d.star} className="flex items-center gap-2">
          <span className="text-[10px] font-medium w-5 text-right flex-shrink-0"
                style={{ color: 'var(--color-text-3)' }}>
            {d.star}★
          </span>
          <div className="flex-1 h-2 rounded-full overflow-hidden"
               style={{ background: 'var(--color-border)' }}>
            <div className="h-2 rounded-full transition-all"
                 style={{ width: `${(d.count / max) * 100}%`, background: STAR_COLORS[d.star - 1] }} />
          </div>
          <span className="text-[10px] w-5 flex-shrink-0"
                style={{ color: 'var(--color-text-3)' }}>
            {d.count}
          </span>
        </div>
      ))}
    </div>
  )
}

function TrendChart({ trend }) {
  if (!trend?.length) return <div className="skeleton h-32 w-full" />
  const last18 = trend.slice(-18)
  return (
    <ResponsiveContainer width="100%" height={100}>
      <LineChart data={last18}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis dataKey="ym" tick={{ fontSize: 9, fill: 'var(--color-text-3)' }}
               tickFormatter={v => v.slice(5)} interval="preserveStartEnd" />
        <YAxis domain={[1, 5]} tick={{ fontSize: 9, fill: 'var(--color-text-3)' }} width={24} />
        <Tooltip
          contentStyle={{ fontSize: 11, border: '1px solid var(--color-border)', borderRadius: 8, boxShadow: 'var(--shadow-md)' }}
          formatter={(v) => [v ? `${v}★` : '—', 'Avg']}
        />
        <Line type="monotone" dataKey="avg" stroke="var(--color-accent)"
              strokeWidth={2.5} dot={{ r: 2, fill: 'var(--color-accent)' }} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  )
}

function AISummaryCard({ detail }) {
  if (!detail?.aiSummary?.text) return null
  return (
    <div className="ai-card p-5">
      <p className="ai-label mb-2">✦ AI Location Summary</p>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--ai-card-text-2)' }}>
        {detail.aiSummary.text}
      </p>
    </div>
  )
}

const FORECAST_CONFIDENCE_VARIANT = { high: 'success', moderate: 'warning', low: 'neutral' }

function PredictionCard({ detail }) {
  const pred       = detail?.predictedRating
  const predConf   = detail?.predictedRatingConfidence
  const vol        = detail?.predictedVolume
  const alert      = detail?.trendAlert

  if (!pred && !vol) return null

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-label" style={{ color: 'var(--color-text-2)' }}>30-Day Forecast</p>
        {predConf && <Badge variant={FORECAST_CONFIDENCE_VARIANT[predConf.level] ?? 'neutral'}>{predConf.label}</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {pred && (
          <div>
            <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Projected Rating</p>
            <p className="text-2xl font-black mt-0.5"
               style={{ color: pred >= 4.0 ? 'var(--color-success)' : pred < 3.5 ? 'var(--color-danger)' : 'var(--color-text-1)', fontWeight: 800 }}>
              {pred}★
            </p>
          </div>
        )}
        {vol && (
          <div>
            <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Projected Reviews</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: 'var(--color-text-1)', fontWeight: 800 }}>
              ~{vol}
            </p>
          </div>
        )}
      </div>
      <p className="text-[9px] mt-2" style={{ color: 'var(--color-text-3)' }}>
        AI-generated forecast, not a guarantee{predConf ? ` · based on ${predConf.monthsOfData} month${predConf.monthsOfData === 1 ? '' : 's'} of history` : ''}.
      </p>
      {alert && (
        <div className="mt-3 flex items-start gap-2 p-3 rounded-lg"
             style={{ background: 'var(--color-danger-bg)', borderLeft: '3px solid var(--color-danger)' }}>
          <span>⚡</span>
          <p className="text-xs" style={{ color: 'var(--color-text-2)' }}>{alert.message}</p>
        </div>
      )}
    </Card>
  )
}

function EmployeeRecognition({ staff }) {
  if (!staff?.length) return null
  const positive = staff.filter(s => s.sentiment !== 'negative')
  const negative = staff.filter(s => s.sentiment === 'negative')

  return (
    <Card className="p-5">
      <p className="text-label mb-4" style={{ color: 'var(--color-text-2)' }}>Staff Mentions</p>
      {positive.length > 0 && (
        <div className="mb-4">
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2"
             style={{ color: 'var(--color-success)' }}>
            Praised by Guests
          </p>
          <div className="flex flex-wrap gap-2">
            {positive.map(s => (
              <div key={s.name}
                   className="flex items-center gap-2 px-3 py-1.5 rounded-full"
                   style={{ background: 'var(--color-success-bg)', border: '1px solid var(--color-success-border)' }}
                   title={`${s.name}: ${s.count} mentions`}>
                <span className="text-xs font-semibold" style={{ color: 'var(--color-success)' }}>
                  {s.name}
                </span>
                <span className="badge badge-success">{s.count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {negative.length > 0 && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-2"
             style={{ color: 'var(--color-danger)' }}>
            Needs Attention
          </p>
          <div className="flex flex-wrap gap-2">
            {negative.map(s => (
              <div key={s.name}
                   className="flex items-center gap-2 px-3 py-1.5 rounded-full"
                   style={{ background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger-border)' }}>
                <span className="text-xs font-semibold" style={{ color: 'var(--color-danger)' }}>
                  {s.name}
                </span>
                <span className="badge badge-danger">{s.count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

function ComplaintList({ complaints, type }) {
  const items = (complaints ?? []).slice(0, 5)
  const label = type === 'complaint' ? 'Top Complaints' : 'Top Praise'
  const color = type === 'complaint' ? 'var(--color-danger)' : 'var(--color-success)'

  if (!items.length) return null

  return (
    <Card className="p-5">
      <p className="text-label mb-3" style={{ color: 'var(--color-text-2)' }}>{label}</p>
      <div className="space-y-1.5">
        {items.map(c => (
          <div key={c.id}
               className="flex items-center gap-3 px-3 py-2 rounded-lg"
               style={{ background: 'var(--color-surface-2)' }}>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>{c.name}</p>
              <p className="text-[10px]" style={{ color: 'var(--color-text-3)' }}>
                {c.count} mentions
              </p>
            </div>
            <Badge variant={c.trend === 'up' ? (type === 'complaint' ? 'danger' : 'success') : 'neutral'}>
              {c.trend === 'up' ? '↑' : c.trend === 'down' ? '↓' : '→'}
            </Badge>
          </div>
        ))}
      </div>
    </Card>
  )
}

// ─── Location picker ──────────────────────────────────────────────────────────

function LocationPicker({ stats, selected, onSelect }) {
  return (
    <div className="flex flex-wrap gap-2">
      {(stats ?? []).map(loc => (
        <button
          key={loc.name}
          onClick={() => onSelect(loc.name)}
          className="text-xs px-3 py-1.5 rounded-full border transition-all font-medium"
          style={selected === loc.name
            ? { background: 'var(--color-accent-lt)', color: 'var(--color-accent)', borderColor: 'var(--color-accent-md)' }
            : { background: 'var(--color-surface)', color: 'var(--color-text-2)', borderColor: 'var(--color-border)' }}
        >
          {loc.name}
        </button>
      ))}
    </div>
  )
}

// ─── Location dashboard ───────────────────────────────────────────────────────

function LocationDashboard({ loc, detail, loading, locationReviews = [], locationPrevReviews = [] }) {
  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  const health = detail?.healthScore ?? loc?.healthScore
  const sent   = loc?.periodSentiment
  const avg    = sent?.avgRating
  const n      = sent?.n ?? 0
  const breakdown = loc?.starBreakdown

  return (
    <div className="space-y-4">

      <AISummaryCard detail={detail} />

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="p-4 flex flex-col items-center text-center">
          <ExplainableScore label={`${loc?.name ?? 'Location'} Health Score`} score={health?.score} explanation={explainHealthScore(health)}>
            <HealthRing score={health?.score} grade={health?.grade} size={72} />
          </ExplainableScore>
          <p className="text-[10px] font-bold uppercase tracking-wider mt-2"
             style={{ color: 'var(--color-text-3)' }}>
            Health Score
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
            Avg Rating (30d)
          </p>
          <p className="text-3xl font-black mt-2 mb-1"
             style={{ color: (avg ?? 0) >= 4 ? 'var(--color-success)' : 'var(--color-text-1)', fontWeight: 800 }}>
            {avg?.toFixed(2) ?? '—'}★
          </p>
          {detail?.ratingDelta !== undefined && detail.ratingDelta !== 0 && (
            <span className={`text-xs font-semibold ${detail.ratingDelta > 0 ? 'trend-up' : 'trend-down'}`}>
              {detail.ratingDelta > 0 ? '+' : ''}{detail.ratingDelta} vs prior
            </span>
          )}
        </Card>

        <Card className="p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
            Positive Sentiment
          </p>
          <p className="text-3xl font-black mt-2 mb-1"
             style={{ color: (sent?.positive ?? 0) >= 75 ? 'var(--color-success)' : 'var(--color-text-1)', fontWeight: 800 }}>
            {sent ? `${sent.positive.toFixed(0)}%` : '—'}
          </p>
          <p className="text-[10px]" style={{ color: 'var(--color-text-3)' }}>
            {n} reviews this period
          </p>
        </Card>

        <PredictionCard detail={detail} />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-5">
          <p className="text-label mb-3" style={{ color: 'var(--color-text-2)' }}>Rating Trend</p>
          <TrendChart trend={detail?.monthlyTrend ?? loc?.spark} />
        </Card>
        <Card className="p-5">
          <p className="text-label mb-3" style={{ color: 'var(--color-text-2)' }}>Star Breakdown (30d)</p>
          <StarBreakdown breakdown={breakdown} />
        </Card>
      </div>

      {/* Live classification + rating breakdown for the selected date/star
          filters — unlike the cards above, which reflect the pipeline's
          fixed trailing-30-day snapshot for this location. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SentimentBreakdown reviews={locationReviews} />
        <RatingBreakdown reviews={locationReviews} prevReviews={locationPrevReviews} title="Rating Breakdown (selected period)" />
      </div>

      <PeriodComparison reviews={locationReviews} prevReviews={locationPrevReviews} />

      <CXIndexGrid dimensions={detail?.cxIndex} title="Customer Experience Index (30d)" />

      {/* Intelligence row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ComplaintList complaints={detail?.complaints} type="complaint" />
        <ComplaintList complaints={detail?.praises} type="praise" />
      </div>

      {/* Employee recognition */}
      {detail?.staffMentions?.length > 0 && (
        <EmployeeRecognition staff={detail.staffMentions} />
      )}

    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function LocationDetail({ allReviews = [], filtered = [], prevFiltered = [], filters = {} }) {
  const { data: stats, isLoading: lStats } = useLocationStats()
  usePrefetchLocationDetails(stats)
  const [selected, setSelected] = useState(null)

  const selectedLoc = useMemo(
    () => stats?.find(s => s.name === selected) ?? stats?.[0] ?? null,
    [stats, selected]
  )
  const slug = selectedLoc ? slugify(selectedLoc.name) : null
  const { data: detail, isLoading: lDetail } = useLocationDetail(slug)

  // Scope the globally-filtered review set (date/brand/stars, from the
  // filter bar above) down to just this location, for the live classification
  // /rating-breakdown/period-comparison cards -- everything else on this page
  // reads the pipeline's precomputed 30-day snapshot instead.
  const locationReviews     = useMemo(
    () => selectedLoc ? filtered.filter(r => r.location_name === selectedLoc.name) : [],
    [filtered, selectedLoc]
  )
  const locationPrevReviews = useMemo(
    () => selectedLoc ? prevFiltered.filter(r => r.location_name === selectedLoc.name) : [],
    [prevFiltered, selectedLoc]
  )

  // Auto-select first on load
  useMemo(() => {
    if (!selected && stats?.length) setSelected(stats[0].name)
  }, [stats, selected])

  return (
    <div className="space-y-6 max-w-[1100px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Location Intelligence</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Per-location health scores, predictions, staff recognition, and complaint analysis
        </p>
      </div>

      {lStats ? (
        <div className="skeleton h-10 w-full max-w-2xl" />
      ) : (
        <LocationPicker stats={stats} selected={selected ?? stats?.[0]?.name} onSelect={setSelected} />
      )}

      {selectedLoc && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <h3 className="text-title" style={{ color: 'var(--color-text-1)' }}>
              {selectedLoc.name}
            </h3>
            <Badge variant="neutral">{selectedLoc.city}</Badge>
            {selectedLoc.lifetimeRating && (
              <Badge variant={selectedLoc.lifetimeRating >= 4 ? 'success' : 'warning'}>
                {selectedLoc.lifetimeRating}★ lifetime
              </Badge>
            )}
          </div>
          <LocationDashboard
            loc={selectedLoc} detail={detail} loading={lDetail}
            locationReviews={locationReviews} locationPrevReviews={locationPrevReviews}
          />
        </div>
      )}
    </div>
  )
}
