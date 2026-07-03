import { useState } from 'react'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import { useCompetitorIntel } from '../hooks/useIntelligence.js'

// ── Shared helpers ────────────────────────────────────────────────────────────

function Movement({ direction, change }) {
  if (!change) return null
  const isUp   = direction === 'up'
  const isDown = direction === 'down'
  const cls    = isUp ? 'trend-up' : isDown ? 'trend-down' : 'trend-flat'
  const arrow  = isUp ? '↑' : isDown ? '↓' : '→'
  return <span className={`text-xs font-semibold ${cls}`}>{arrow} {change}</span>
}

function SectionHeader({ title, sub }) {
  return (
    <div className="flex items-baseline gap-3">
      <h2 className="text-title" style={{ color: 'var(--color-text-1)' }}>{title}</h2>
      {sub && <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>{sub}</span>}
    </div>
  )
}

// ── Movement Indicator metric card ────────────────────────────────────────────

function MetricCard({ label, value, unit, metric }) {
  return (
    <Card className="p-4 space-y-1">
      <p className="text-[10px] font-bold tracking-widest uppercase" style={{ color: 'var(--color-text-3)' }}>
        {label}
      </p>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-black leading-none" style={{ color: 'var(--color-text-1)', fontWeight: 800 }}>
          {value ?? '—'}
        </span>
        {unit && <span className="text-sm" style={{ color: 'var(--color-text-2)' }}>{unit}</span>}
      </div>
      <Movement direction={metric?.direction} change={metric?.change} />
    </Card>
  )
}

// ── Alert card ────────────────────────────────────────────────────────────────

const SEVERITY_STYLES = {
  positive: { border: 'var(--color-success)', icon: '↑', badge: 'success' },
  warning:  { border: '#d97706',              icon: '!', badge: 'warning' },
  danger:   { border: 'var(--color-danger)',  icon: '!', badge: 'danger'  },
  info:     { border: 'var(--color-info)',    icon: 'i', badge: 'info'    },
}

function AlertCard({ alert }) {
  const s = SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.info
  return (
    <div className="flex items-start gap-3 p-4 rounded-xl border"
         style={{ borderColor: s.border, borderLeftWidth: 3 }}>
      <Badge variant={s.badge} className="flex-shrink-0 mt-0.5 font-bold w-5 h-5 flex items-center justify-center p-0">
        {s.icon}
      </Badge>
      <div className="min-w-0">
        <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>{alert.title}</p>
        {alert.body && (
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-2)' }}>{alert.body}</p>
        )}
      </div>
    </div>
  )
}

// ── Location ranking row ──────────────────────────────────────────────────────

const GRADE_COLORS = {
  A: 'var(--color-success)', B: 'var(--color-info)',
  C: '#d97706',              D: 'var(--color-warning)', F: 'var(--color-danger)',
}

function RankRow({ loc, isTop }) {
  const rc    = loc.rankChange || 0
  const delta = loc.ratingDelta || 0
  return (
    <div className="flex items-center gap-3 py-2.5 border-b last:border-0"
         style={{ borderColor: 'var(--color-border)' }}>
      {/* Rank number */}
      <div className="w-7 text-center flex-shrink-0">
        <span className="text-sm font-black"
              style={{ color: isTop ? 'var(--color-accent)' : 'var(--color-text-2)', fontWeight: 800 }}>
          #{loc.rank}
        </span>
      </div>

      {/* Name + rank change */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <p className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>
            {loc.name}
          </p>
          {loc.prevRank && Math.abs(rc) >= 1 && (
            <span className={`text-[10px] font-bold ${rc > 0 ? 'trend-up' : 'trend-down'}`}>
              {rc > 0 ? '↑' : '↓'}{Math.abs(rc)}
            </span>
          )}
        </div>
        <p className="text-[10px]" style={{ color: 'var(--color-text-3)' }}>
          {loc.reviewCount} reviews · {loc.positiveRate?.toFixed(0)}% positive
        </p>
      </div>

      {/* Rating + delta */}
      <div className="text-right flex-shrink-0 w-20">
        <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>
          {loc.avgRating?.toFixed(2)}★
        </p>
        {delta !== 0 && (
          <p className={`text-[10px] font-semibold ${delta > 0 ? 'trend-up' : 'trend-down'}`}>
            {delta > 0 ? '+' : ''}{delta.toFixed(2)}
          </p>
        )}
      </div>

      {/* Health grade */}
      <div className="w-6 text-center flex-shrink-0">
        {loc.grade && (
          <span className="text-sm font-black" style={{ color: GRADE_COLORS[loc.grade] ?? 'var(--color-text-2)', fontWeight: 800 }}>
            {loc.grade}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Timeline event ────────────────────────────────────────────────────────────

const TIMELINE_DOT = {
  positive: 'var(--color-success)',
  warning:  'var(--color-warning)',
  neutral:  'var(--color-text-3)',
}

function TimelineEvent({ event, isLast }) {
  const dot = TIMELINE_DOT[event.type] ?? 'var(--color-text-3)'
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center flex-shrink-0 w-3">
        <div className="w-3 h-3 rounded-full flex-shrink-0 mt-0.5"
             style={{ background: dot, boxShadow: `0 0 0 3px ${dot}22` }} />
        {!isLast && <div className="w-px flex-1 mt-1 mb-1" style={{ background: 'var(--color-border)', minHeight: 20 }} />}
      </div>
      <div className={`min-w-0 ${isLast ? 'pb-0' : 'pb-5'}`}>
        <p className="text-[10px] font-medium mb-0.5" style={{ color: 'var(--color-text-3)' }}>
          {event.date}
        </p>
        <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>
          {event.title}
        </p>
        {event.body && (
          <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
            {event.body}
          </p>
        )}
      </div>
    </div>
  )
}

// ── Change detection card ─────────────────────────────────────────────────────

function ChangeCard({ change }) {
  const isUp   = change.direction === 'up'
  const isDown = change.direction === 'down'
  return (
    <div className="card p-4 space-y-1">
      <div className="flex items-start gap-2">
        <span className={`text-base font-bold flex-shrink-0 ${isUp ? 'trend-up' : isDown ? 'trend-down' : 'trend-flat'}`}>
          {isUp ? '↑' : isDown ? '↓' : '→'}
        </span>
        <p className="text-sm font-semibold leading-snug" style={{ color: 'var(--color-text-1)' }}>
          {change.title}
        </p>
      </div>
      {change.body && (
        <p className="text-xs pl-6" style={{ color: 'var(--color-text-2)' }}>{change.body}</p>
      )}
      {change.location && (
        <p className="text-[10px] pl-6" style={{ color: 'var(--color-text-3)' }}>{change.location}</p>
      )}
    </div>
  )
}

// ── Executive briefing card ───────────────────────────────────────────────────

function BriefingCard({ label, text, accent }) {
  return (
    <div className="card p-4 space-y-2">
      <div className="flex items-center gap-2">
        <div className="w-1 h-4 rounded-full flex-shrink-0"
             style={{ background: accent ?? 'var(--color-accent)' }} />
        <p className="text-[10px] font-bold tracking-widest uppercase" style={{ color: 'var(--color-text-3)' }}>
          {label}
        </p>
      </div>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-1)', lineHeight: 1.65 }}>
        {text || '—'}
      </p>
    </div>
  )
}

// ── Predictive insight card ───────────────────────────────────────────────────

function InsightCard({ insight }) {
  return (
    <div className="card p-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant={insight.type === 'positive' ? 'success' : 'warning'}>
          {insight.type === 'positive' ? '↑ Positive' : '↓ Watch'}
        </Badge>
        <Badge variant="neutral">{insight.confidence} confidence</Badge>
        <span className="text-[10px] ml-auto" style={{ color: 'var(--color-text-3)' }}>
          {insight.timeframe}
        </span>
      </div>
      <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>
        {insight.title}
      </p>
      <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
        {insight.body}
      </p>
      {insight.location && (
        <p className="text-[10px] font-medium" style={{ color: 'var(--color-text-3)' }}>
          {insight.location}
        </p>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CompetitorIntelligence() {
  const { data: intel, isLoading } = useCompetitorIntel()
  const [showAll, setShowAll] = useState(false)

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-[900px]">
        {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
      </div>
    )
  }

  if (!intel) {
    return (
      <div className="max-w-[900px]">
        <EmptyState
          icon="◎"
          title="Competitive intelligence not yet generated"
          body="Run the analytics pipeline to generate your first competitive intelligence report. It will appear here automatically after the next pipeline run."
        />
      </div>
    )
  }

  const metrics    = intel.metrics            ?? {}
  const briefing   = intel.weeklyBriefing     ?? {}
  const alerts     = intel.alerts             ?? []
  const rankings   = intel.locationRankings   ?? []
  const changes    = intel.changeDetection    ?? []
  const timeline   = intel.trendTimeline      ?? []
  const insights   = intel.predictiveInsights ?? []
  const period     = intel.period             ?? 'last 30 days'
  const displayed  = showAll ? rankings : rankings.slice(0, 10)

  const briefingCards = [
    { label: 'Biggest Win',            text: briefing.biggestWin,           accent: 'var(--color-success)' },
    { label: 'Biggest Threat',         text: briefing.biggestThreat,        accent: 'var(--color-danger)' },
    { label: 'Most Improved',          text: briefing.mostImproved,         accent: 'var(--color-success)' },
    { label: 'Largest Decline',        text: briefing.largestDecline,       accent: 'var(--color-warning)' },
    { label: 'Marketing Opportunity',  text: briefing.marketingOpportunity, accent: 'var(--color-accent)' },
    { label: 'Operational Priority',   text: briefing.operationalPriority,  accent: 'var(--color-accent)' },
    { label: 'Projected Trend',        text: briefing.projectedTrend,       accent: 'var(--color-info)' },
  ]

  return (
    <div className="space-y-8 max-w-[900px]">

      {/* ── Page header ─────────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>
            Competitive Intelligence
          </h1>
          <Badge variant="accent">AI</Badge>
        </div>
        <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
          AI-powered performance briefing · {period}
        </p>
      </div>

      {/* ── THIS WEEK'S COMPETITIVE CHANGES ─────────────────────────────────── */}
      {briefing.executiveSummary ? (
        <div className="rounded-2xl p-6 border"
             style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', boxShadow: 'var(--shadow-md)' }}>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1.5 h-6 rounded-full" style={{ background: 'var(--color-accent)' }} />
            <p className="text-[10px] font-bold tracking-[0.18em] uppercase" style={{ color: 'var(--color-accent)' }}>
              This Week's Competitive Changes
            </p>
          </div>
          <p className="text-[15px] leading-relaxed" style={{ color: 'var(--color-text-1)', lineHeight: 1.8 }}>
            {briefing.executiveSummary}
          </p>
          {briefing.generatedAt && (
            <p className="text-[10px] mt-4 pt-4 border-t" style={{ color: 'var(--color-text-3)', borderColor: 'var(--color-border)' }}>
              AI-generated · {new Date(briefing.generatedAt).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-2xl p-6 border" style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', borderStyle: 'dashed' }}>
          <p className="text-[10px] font-bold tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--color-text-3)' }}>
            This Week's Competitive Changes
          </p>
          <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
            AI executive briefing will appear here once the ANTHROPIC_API_KEY is configured and the pipeline runs.
          </p>
        </div>
      )}

      {/* ── MOVEMENT INDICATORS ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionHeader title="Movement Indicators" sub="vs prior 30-day period" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <MetricCard label="Avg Rating"    value={metrics.avgRating?.value?.toFixed(2)}     unit="★" metric={metrics.avgRating} />
          <MetricCard label="Reviews"       value={metrics.reviewCount?.value}                        metric={metrics.reviewCount} />
          <MetricCard label="5-Star"        value={metrics.fiveStarCount?.value}                      metric={metrics.fiveStarCount} />
          <MetricCard label="Positive Rate" value={metrics.positiveRate?.value?.toFixed(1)}  unit="%" metric={metrics.positiveRate} />
          <MetricCard label="Response Rate" value={metrics.responseRate?.value?.toFixed(0)}  unit="%" metric={metrics.responseRate} />
          <MetricCard label="Unanswered"    value={metrics.unanswered?.value}                         metric={metrics.unanswered} />
        </div>
      </section>

      {/* ── AI ALERTS ───────────────────────────────────────────────────────── */}
      {alerts.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title="AI Alerts" sub={`${alerts.length} events detected`} />
          <div className="space-y-2">
            {alerts.map(a => <AlertCard key={a.id} alert={a} />)}
          </div>
        </section>
      )}

      {/* ── COMPETITIVE RANKING ─────────────────────────────────────────────── */}
      {rankings.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title="Location Performance Rankings" sub="30-day avg rating · ↑↓ = rank change vs prior period" />
          <Card>
            {/* Column headers */}
            <div className="flex items-center gap-3 px-4 py-2 border-b"
                 style={{ borderColor: 'var(--color-border)' }}>
              <div className="w-7" />
              <div className="flex-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
                Location
              </div>
              <div className="w-20 text-right text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
                Rating
              </div>
              <div className="w-6 text-center text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
                Gr
              </div>
            </div>

            <div className="px-4">
              {displayed.map((loc, i) => (
                <RankRow key={loc.name} loc={loc} isTop={i === 0} />
              ))}
            </div>

            {rankings.length > 10 && (
              <div className="px-4 py-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
                <button
                  onClick={() => setShowAll(s => !s)}
                  className="text-xs font-semibold transition-colors"
                  style={{ color: 'var(--color-accent)' }}
                >
                  {showAll ? 'Show top 10 only' : `Show all ${rankings.length} locations`}
                </button>
              </div>
            )}
          </Card>
        </section>
      )}

      {/* ── AI CHANGE DETECTION ─────────────────────────────────────────────── */}
      {changes.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title="AI Change Detection" sub="notable shifts detected this period" />
          <div className="grid sm:grid-cols-2 gap-3">
            {changes.map(c => <ChangeCard key={c.id} change={c} />)}
          </div>
        </section>
      )}

      {/* ── TREND TIMELINE ──────────────────────────────────────────────────── */}
      {timeline.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title="Intelligence Timeline" sub="significant events" />
          <Card className="p-5 pt-4">
            {timeline.map((event, i) => (
              <TimelineEvent
                key={`${event.date}-${i}`}
                event={event}
                isLast={i === timeline.length - 1}
              />
            ))}
          </Card>
        </section>
      )}

      {/* ── WEEKLY EXECUTIVE BRIEFING ────────────────────────────────────────── */}
      {briefing.biggestWin && (
        <section className="space-y-3">
          <SectionHeader title="Weekly Executive Briefing" />
          <div className="grid sm:grid-cols-2 gap-3">
            {briefingCards.map(card => (
              <BriefingCard key={card.label} label={card.label} text={card.text} accent={card.accent} />
            ))}
          </div>
        </section>
      )}

      {/* ── PREDICTIVE INSIGHTS ─────────────────────────────────────────────── */}
      {insights.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title="Predictive Insights" sub="based on observed trends — estimates only" />
          <div className="space-y-3">
            {insights.map((insight, i) => <InsightCard key={i} insight={insight} />)}
          </div>
        </section>
      )}

      {/* ── AI CONSULTANT RECOMMENDATION ────────────────────────────────────── */}
      {briefing.recommendation && (
        <section>
          <div className="rounded-2xl p-6 border"
               style={{ background: 'var(--color-surface)', borderColor: 'var(--color-accent)', borderLeftWidth: 3 }}>
            <p className="text-[10px] font-bold tracking-[0.18em] uppercase mb-3"
               style={{ color: 'var(--color-accent)' }}>
              AI Consultant Recommendation
            </p>
            <p className="text-[15px] leading-relaxed" style={{ color: 'var(--color-text-1)', lineHeight: 1.8 }}>
              {briefing.recommendation}
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
