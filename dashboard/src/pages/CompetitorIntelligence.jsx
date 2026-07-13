import { useState } from 'react'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import { useCompetitorIntel } from '../hooks/useIntelligence.js'

// ── Utilities ─────────────────────────────────────────────────────────────────

function clamp(str, n = 60) {
  if (!str) return null
  return str.length > n ? str.slice(0, n).trimEnd() + '…' : str
}

function pctLabel(rank, total) {
  const pct = (rank / total) * 100
  if (pct <= 5)  return 'Top 5%'
  if (pct <= 10) return 'Top 10%'
  if (pct <= 17) return 'Top 17%'
  if (pct <= 25) return 'Top 25%'
  if (pct <= 33) return 'Top 33%'
  if (pct <= 50) return 'Top 50%'
  return `Rank ${rank}`
}

// ── Shared primitives ─────────────────────────────────────────────────────────

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

function EvidencePill({ labels }) {
  if (!labels?.length) return null
  return (
    <div className="flex items-center gap-1.5 flex-wrap mt-3 pt-3 border-t"
         style={{ borderColor: 'var(--color-border)' }}>
      <span className="text-[9px] uppercase tracking-widest font-bold flex-shrink-0"
            style={{ color: 'var(--color-text-3)' }}>
        Based on:
      </span>
      {labels.map(l => (
        <span key={l} className="text-[9px] px-1.5 py-0.5 rounded"
              style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-3)',
                       border: '1px solid var(--color-border)' }}>
          {l}
        </span>
      ))}
    </div>
  )
}

// ── Metric card ───────────────────────────────────────────────────────────────

function MetricCard({ label, value, unit, metric }) {
  return (
    <Card className="p-4 space-y-1">
      <p className="text-[10px] font-bold tracking-widest uppercase" style={{ color: 'var(--color-text-3)' }}>
        {label}
      </p>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-black leading-none"
              style={{ color: 'var(--color-text-1)', fontWeight: 800 }}>
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
  warning:  { border: 'var(--color-grade-c)',              icon: '!', badge: 'warning' },
  danger:   { border: 'var(--color-danger)',  icon: '!', badge: 'danger'  },
  info:     { border: 'var(--color-info)',    icon: 'i', badge: 'info'    },
}

function AlertCard({ alert }) {
  const s = SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.info
  return (
    <div className="flex items-start gap-3 p-4 rounded-xl border"
         style={{ borderColor: s.border, borderLeftWidth: 3 }}>
      <Badge variant={s.badge}
             className="flex-shrink-0 mt-0.5 font-bold w-5 h-5 flex items-center justify-center p-0">
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

// ── Rank row ──────────────────────────────────────────────────────────────────

const GRADE_COLORS = {
  A: 'var(--color-success)', B: 'var(--color-info)',
  C: 'var(--color-grade-c)',              D: 'var(--color-warning)', F: 'var(--color-danger)',
}

function RankRow({ loc, isTop, isSelected }) {
  const rc    = loc.rankChange || 0
  const delta = loc.ratingDelta || 0
  return (
    <div className={`flex items-center gap-3 py-2.5 border-b last:border-0 rounded-lg transition-colors ${isSelected ? '-mx-2 px-2' : ''}`}
         style={{
           borderColor: 'var(--color-border)',
           background: isSelected ? 'var(--color-surface-2)' : undefined,
         }}>
      <div className="w-7 text-center flex-shrink-0">
        <span className="text-sm font-black"
              style={{ color: isTop ? 'var(--color-accent)' : 'var(--color-text-2)', fontWeight: 800 }}>
          #{loc.rank}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <p className="text-sm font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>
            {loc.name}
          </p>
          {isSelected && (
            <span className="text-[9px] px-1.5 py-0.5 rounded font-bold flex-shrink-0"
                  style={{ background: 'var(--color-accent)', color: '#fff' }}>
              selected
            </span>
          )}
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
      <div className="w-6 text-center flex-shrink-0">
        {loc.grade && (
          <span className="text-sm font-black"
                style={{ color: GRADE_COLORS[loc.grade] ?? 'var(--color-text-2)', fontWeight: 800 }}>
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
        {!isLast && (
          <div className="w-px flex-1 mt-1 mb-1"
               style={{ background: 'var(--color-border)', minHeight: 20 }} />
        )}
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

// ── Change card ───────────────────────────────────────────────────────────────

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

// ── Briefing card ─────────────────────────────────────────────────────────────

function BriefingCard({ label, text, accent }) {
  return (
    <div className="card p-4 space-y-2">
      <div className="flex items-center gap-2">
        <div className="w-1 h-4 rounded-full flex-shrink-0"
             style={{ background: accent ?? 'var(--color-accent)' }} />
        <p className="text-[10px] font-bold tracking-widest uppercase"
           style={{ color: 'var(--color-text-3)' }}>
          {label}
        </p>
      </div>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-1)', lineHeight: 1.65 }}>
        {text || '—'}
      </p>
    </div>
  )
}

// ── Insight card ──────────────────────────────────────────────────────────────

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

// ── Market Position Card (NEW) ────────────────────────────────────────────────

function MarketPositionCard({ selectedLoc, rankings, briefing }) {
  const total    = rankings.length
  const rank     = selectedLoc.rank
  const label    = pctLabel(rank, total)
  const isLeader = rank === 1

  // Closest competitor — the location one rank above (threat) or below (opportunity)
  const above = rank > 1 ? rankings.find(l => l.rank === rank - 1) : null
  const below = rankings.find(l => l.rank === rank + 1)
  const threat     = above
  const threatDiff = threat ? Math.abs(threat.avgRating - selectedLoc.avgRating).toFixed(2) : null

  const opportunity = clamp(briefing.operationalPriority, 55)
  const advantage   = clamp(briefing.biggestWin, 55)
  const score       = selectedLoc.healthScore

  const scoreColor = score == null
    ? 'var(--color-text-2)'
    : score >= 80 ? 'var(--color-success)'
    : score >= 60 ? 'var(--color-accent)'
    : 'var(--color-danger)'

  return (
    <div className="rounded-2xl border overflow-hidden"
         style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)',
                  boxShadow: 'var(--shadow-md)' }}>

      {/* Header strip */}
      <div className="px-6 pt-5 pb-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
        <p className="text-[10px] font-bold tracking-[0.18em] uppercase mb-3"
           style={{ color: 'var(--color-text-3)' }}>
          Market Position
        </p>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-xl font-black leading-tight" style={{ color: 'var(--color-text-1)' }}>
              {selectedLoc.name}
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
              Internal Network · {total} locations analyzed
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <p className="text-3xl font-black leading-none"
               style={{ color: 'var(--color-accent)', fontWeight: 800 }}>
              #{rank}
              <span className="text-base font-semibold ml-1" style={{ color: 'var(--color-text-3)' }}>
                of {total}
              </span>
            </p>
            <span className="px-3 py-1.5 rounded-full text-xs font-bold"
                  style={{
                    background: isLeader ? 'rgba(16,185,129,0.1)' : 'var(--color-surface-2)',
                    color: isLeader ? 'var(--color-success)' : 'var(--color-text-2)',
                    border: `1px solid ${isLeader ? 'rgba(16,185,129,0.25)' : 'var(--color-border)'}`,
                  }}>
              {label}
            </span>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4">
        {[
          {
            label: 'Current Rating',
            primary: `${selectedLoc.avgRating?.toFixed(2)}★`,
            sub: selectedLoc.ratingDelta
              ? `${(selectedLoc.ratingDelta ?? 0) > 0 ? '+' : ''}${selectedLoc.ratingDelta?.toFixed(2)} vs prior`
              : null,
            subClass: (selectedLoc.ratingDelta ?? 0) > 0 ? 'trend-up' : 'trend-down',
          },
          {
            label: above ? 'Closest Threat' : 'Next Competitor',
            primary: threat?.name ?? (below?.name ?? '—'),
            sub: threat
              ? `${threatDiff}★ ahead of you`
              : below
              ? `${Math.abs(below.avgRating - selectedLoc.avgRating).toFixed(2)}★ behind you`
              : null,
          },
          {
            label: 'Top Opportunity',
            primary: opportunity ?? '—',
            small: true,
          },
          {
            label: 'Competitive Score',
            primary: score != null ? `${score}` : (selectedLoc.grade ?? '—'),
            sub: score != null ? '/100' : null,
            color: scoreColor,
          },
        ].map((cell, i) => (
          <div key={i} className="p-4 space-y-1"
               style={{ borderRight: i < 3 ? '1px solid var(--color-border)' : undefined,
                        borderTop: '1px solid var(--color-border)' }}>
            <p className="text-[9px] uppercase tracking-widest font-bold"
               style={{ color: 'var(--color-text-3)' }}>
              {cell.label}
            </p>
            <p className={`font-black leading-snug ${cell.small ? 'text-sm' : 'text-lg'}`}
               style={{ color: cell.color ?? 'var(--color-text-1)', fontWeight: 800 }}>
              {cell.primary}
            </p>
            {cell.sub && (
              <p className={`text-xs font-semibold ${cell.subClass ?? ''}`}
                 style={!cell.subClass ? { color: 'var(--color-text-3)' } : undefined}>
                {cell.sub}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Advantage strip — only when AI briefing is available */}
      {advantage && (
        <div className="px-6 py-3 border-t flex items-center gap-3 flex-wrap"
             style={{ borderColor: 'var(--color-border)', background: 'rgba(16,185,129,0.03)' }}>
          <span className="text-[9px] uppercase tracking-widest font-bold flex-shrink-0"
                style={{ color: 'var(--color-success)' }}>
            Biggest Advantage
          </span>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
            {advantage}
          </p>
        </div>
      )}
    </div>
  )
}

// ── What Would It Take to Become #1? (NEW) ───────────────────────────────────

function BecomeNumber1({ selectedLoc, rankings, metrics, briefing }) {
  const leader   = rankings[0]
  if (!leader || !selectedLoc) return null

  const isLeader    = selectedLoc.rank === 1
  const ratingGap   = leader.avgRating - selectedLoc.avgRating
  const responseRate = metrics.responseRate?.value ?? 0
  const positiveRate = selectedLoc.positiveRate ?? 0

  const difficulty = ratingGap > 0.3
    ? { label: 'Significant effort needed', bg: 'rgba(239,68,68,0.08)', color: 'var(--color-danger)', border: 'rgba(239,68,68,0.2)' }
    : ratingGap > 0.1
    ? { label: 'Achievable with focus',     bg: 'rgba(217,119,6,0.08)',  color: 'var(--color-grade-c)',             border: 'rgba(217,119,6,0.2)' }
    : { label: 'Within reach',              bg: 'rgba(16,185,129,0.08)', color: 'var(--color-success)', border: 'rgba(16,185,129,0.2)' }

  const actions = []
  if (!isLeader) {
    if (ratingGap > 0.01) {
      actions.push(
        `Raise average rating from ${selectedLoc.avgRating?.toFixed(2)}★ to at least ${leader.avgRating.toFixed(2)}★ — a ${ratingGap.toFixed(2)}★ gap`
      )
    }
    if (responseRate < 85) {
      actions.push(
        `Increase review response rate from ${responseRate.toFixed(0)}% to 90%+ — respond to all reviews within 24–48 hours`
      )
    }
    if (positiveRate < 85) {
      actions.push(
        `Improve positive sentiment rate (currently ${positiveRate.toFixed(0)}%) by addressing recurring complaint themes`
      )
    }
    if ((selectedLoc.ratingDelta ?? 0) < 0) {
      actions.push('Reverse the current downward rating trend before pursuing rank advancement')
    }
    actions.push('Consistently encourage satisfied guests to leave reviews — volume amplifies rating gains')
    if (briefing.marketingOpportunity) {
      actions.push(briefing.marketingOpportunity)
    } else {
      actions.push('Highlight top-praised menu items and service attributes in social and local marketing campaigns')
    }
  } else {
    actions.push('Maintain current response rate — consistency is the primary defense of a #1 position')
    if (below(rankings, 1)) {
      const gap2 = (selectedLoc.avgRating - below(rankings, 1).avgRating).toFixed(2)
      actions.push(`Monitor #2 closely — you lead by only ${gap2}★, a gap that can close within weeks of a review surge`)
    }
    if (responseRate < 95) {
      actions.push(`Increase response rate from ${responseRate.toFixed(0)}% to 95%+ to widen your operational advantage`)
    }
    actions.push('Continue driving new review volume — sustained momentum makes the lead harder to overtake')
    if (briefing.marketingOpportunity) {
      actions.push(briefing.marketingOpportunity)
    }
  }

  return (
    <section className="space-y-3">
      <SectionHeader
        title={isLeader ? 'Holding the #1 Position' : 'What Would It Take to Become #1?'}
        sub={isLeader ? 'maintaining your competitive lead' : `${ratingGap.toFixed(2)}★ gap to close`}
      />

      <div className="rounded-2xl border overflow-hidden"
           style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>

        {/* Scenario bar */}
        <div className="flex items-center gap-6 px-6 py-4 flex-wrap border-b"
             style={{ background: isLeader ? 'rgba(16,185,129,0.04)' : 'var(--color-surface-2)',
                      borderColor: 'var(--color-border)' }}>
          <div className="space-y-0.5">
            <p className="text-[9px] uppercase tracking-widest font-bold"
               style={{ color: 'var(--color-text-3)' }}>
              Current
            </p>
            <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>
              #{selectedLoc.rank} · {selectedLoc.avgRating?.toFixed(2)}★
            </p>
          </div>
          {!isLeader && (
            <>
              <div className="text-xl font-bold" style={{ color: 'var(--color-text-3)' }}>→</div>
              <div className="space-y-0.5">
                <p className="text-[9px] uppercase tracking-widest font-bold"
                   style={{ color: 'var(--color-text-3)' }}>
                  Target
                </p>
                <p className="text-sm font-bold" style={{ color: 'var(--color-accent)' }}>
                  #1 · {leader.avgRating.toFixed(2)}★+
                </p>
              </div>
              <div className="ml-auto">
                <span className="text-[10px] px-2.5 py-1 rounded-full font-semibold"
                      style={{ background: difficulty.bg, color: difficulty.color,
                               border: `1px solid ${difficulty.border}` }}>
                  {difficulty.label}
                </span>
              </div>
            </>
          )}
          {isLeader && (
            <span className="ml-auto text-[10px] px-2.5 py-1 rounded-full font-semibold"
                  style={{ background: 'rgba(16,185,129,0.1)', color: 'var(--color-success)',
                           border: '1px solid rgba(16,185,129,0.2)' }}>
              #1 Position Held
            </span>
          )}
        </div>

        {/* Narrative */}
        <div className="px-6 py-5">
          {!isLeader ? (
            <p className="text-sm leading-relaxed mb-5"
               style={{ color: 'var(--color-text-1)', lineHeight: 1.8 }}>
              Future Insights estimates that if <strong>{selectedLoc.name}</strong> improves
              its average rating from {selectedLoc.avgRating?.toFixed(2)}★ to at least{' '}
              {leader.avgRating.toFixed(2)}★
              {responseRate < 85 && `, raises its review response rate above 85%`}
              {positiveRate < 85 && `, and reduces negative sentiment in reviews`}, it could
              realistically achieve the top position within this competitive set.{' '}
              <span style={{ color: 'var(--color-text-3)' }}>
                These are estimates based on current data — not guaranteed outcomes.
              </span>
            </p>
          ) : (
            <p className="text-sm leading-relaxed mb-5"
               style={{ color: 'var(--color-text-1)', lineHeight: 1.8 }}>
              <strong>{selectedLoc.name}</strong> currently holds the top position with a{' '}
              {selectedLoc.avgRating?.toFixed(2)}★ average rating. The priority now is
              maintaining this lead through consistent operations, active review engagement,
              and monitoring competitors for sudden rating surges.{' '}
              <span style={{ color: 'var(--color-text-3)' }}>
                Estimates based on current data — not guaranteed outcomes.
              </span>
            </p>
          )}

          <p className="text-[10px] uppercase tracking-widest font-bold mb-3"
             style={{ color: 'var(--color-text-3)' }}>
            {isLeader ? 'Recommended actions to maintain #1' : 'Recommended actions'}
          </p>
          <ul className="space-y-2.5">
            {actions.map((action, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold mt-0.5"
                      style={{ background: 'var(--color-accent)', color: '#fff' }}>
                  {i + 1}
                </span>
                <p className="text-sm leading-snug" style={{ color: 'var(--color-text-1)' }}>
                  {action}
                </p>
              </li>
            ))}
          </ul>

          <EvidencePill labels={[
            'Google ratings', 'Review volume', 'Positive rate',
            'Response rate', 'Rank comparison',
          ]} />
        </div>
      </div>
    </section>
  )
}

// rank helper used inside BecomeNumber1
function below(rankings, rank) {
  return rankings.find(l => l.rank === rank + 1) ?? null
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-6 max-w-[900px]">
      <div className="space-y-2">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="flex items-center gap-3">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-9 w-64 rounded-lg" />
      </div>
      <Skeleton className="h-[168px] w-full rounded-2xl" />
      <Skeleton className="h-28 w-full rounded-2xl" />
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
      </div>
      <Skeleton className="h-[240px] w-full rounded-2xl" />
      <Skeleton className="h-48 w-full rounded-2xl" />
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CompetitorIntelligence() {
  const { data: intel, isLoading } = useCompetitorIntel()
  const [showAll, setShowAll] = useState(false)
  const [selectedLocName, setSelectedLocName] = useState(null)

  if (isLoading) return <LoadingSkeleton />

  if (!intel) {
    return (
      <div className="max-w-[900px]">
        <EmptyState
          icon="◎"
          title="No competitive intelligence yet"
          body="Run the analytics pipeline to generate your first report. Competitive rankings, AI briefings, movement indicators, and location analysis will all appear here automatically after the next pipeline run."
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

  // Selected location (defaults to rank #1)
  const selectedLoc = rankings.find(l => l.name === selectedLocName) ?? rankings[0] ?? null

  const briefingCards = [
    { label: 'Biggest Win',           text: briefing.biggestWin,           accent: 'var(--color-success)' },
    { label: 'Biggest Threat',        text: briefing.biggestThreat,        accent: 'var(--color-danger)'  },
    { label: 'Most Improved',         text: briefing.mostImproved,         accent: 'var(--color-success)' },
    { label: 'Largest Decline',       text: briefing.largestDecline,       accent: 'var(--color-warning)' },
    { label: 'Marketing Opportunity', text: briefing.marketingOpportunity, accent: 'var(--color-accent)'  },
    { label: 'Operational Priority',  text: briefing.operationalPriority,  accent: 'var(--color-accent)'  },
    { label: 'Projected Trend',       text: briefing.projectedTrend,       accent: 'var(--color-info)'    },
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

      {/* ── Location selector ────────────────────────────────────────────────── */}
      {rankings.length > 1 && (
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-[10px] font-bold uppercase tracking-widest flex-shrink-0"
                 style={{ color: 'var(--color-text-3)' }}>
            Analyzing
          </label>
          <select
            value={selectedLocName ?? rankings[0]?.name ?? ''}
            onChange={e => setSelectedLocName(e.target.value)}
            className="text-sm font-semibold rounded-lg px-3 py-2 border max-w-xs"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--color-border)',
              color: 'var(--color-text-1)',
            }}
          >
            {rankings.map(loc => (
              <option key={loc.name} value={loc.name}>
                #{loc.rank} — {loc.name} ({loc.avgRating?.toFixed(2)}★)
              </option>
            ))}
          </select>
          <span className="text-[10px]" style={{ color: 'var(--color-text-3)' }}>
            Internal Network · {rankings.length} locations
          </span>
        </div>
      )}

      {/* ── Market Position Card ─────────────────────────────────────────────── */}
      {selectedLoc && (
        <MarketPositionCard
          selectedLoc={selectedLoc}
          rankings={rankings}
          briefing={briefing}
        />
      )}

      {/* ── THIS WEEK'S COMPETITIVE CHANGES ─────────────────────────────────── */}
      {briefing.executiveSummary ? (
        <div className="rounded-2xl p-6 border"
             style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)',
                      boxShadow: 'var(--shadow-md)' }}>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1.5 h-6 rounded-full" style={{ background: 'var(--color-accent)' }} />
            <p className="text-[10px] font-bold tracking-[0.18em] uppercase"
               style={{ color: 'var(--color-accent)' }}>
              This Week's Competitive Changes
            </p>
          </div>
          <p className="text-[15px] leading-relaxed"
             style={{ color: 'var(--color-text-1)', lineHeight: 1.8 }}>
            {briefing.executiveSummary}
          </p>
          <EvidencePill labels={[
            'Google ratings', 'Review volume', 'Recent sentiment',
            'Complaint categories', 'Praise categories', 'Response rate',
          ]} />
          {briefing.generatedAt && (
            <p className="text-[10px] mt-3" style={{ color: 'var(--color-text-3)' }}>
              AI-generated · {new Date(briefing.generatedAt).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-2xl p-6 border"
             style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)',
                      borderStyle: 'dashed' }}>
          <p className="text-[10px] font-bold tracking-[0.18em] uppercase mb-2"
             style={{ color: 'var(--color-text-3)' }}>
            This Week's Competitive Changes
          </p>
          <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
            AI executive briefing will appear here once the ANTHROPIC_API_KEY is configured
            and the pipeline runs.
          </p>
        </div>
      )}

      {/* ── MOVEMENT INDICATORS ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionHeader title="Movement Indicators" sub="vs prior 30-day period" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <MetricCard label="Avg Rating"    value={metrics.avgRating?.value?.toFixed(2)}    unit="★" metric={metrics.avgRating}    />
          <MetricCard label="Reviews"       value={metrics.reviewCount?.value}                        metric={metrics.reviewCount}   />
          <MetricCard label="5-Star"        value={metrics.fiveStarCount?.value}                      metric={metrics.fiveStarCount} />
          <MetricCard label="Positive Rate" value={metrics.positiveRate?.value?.toFixed(1)} unit="%" metric={metrics.positiveRate}  />
          <MetricCard label="Response Rate" value={metrics.responseRate?.value?.toFixed(0)} unit="%" metric={metrics.responseRate}  />
          <MetricCard label="Unanswered"    value={metrics.unanswered?.value}                         metric={metrics.unanswered}    />
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

      {/* ── LOCATION PERFORMANCE RANKINGS ───────────────────────────────────── */}
      {rankings.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title="Location Performance Rankings"
            sub="30-day avg rating · ↑↓ = rank change vs prior period"
          />
          <Card>
            <div className="flex items-center gap-3 px-4 py-2 border-b"
                 style={{ borderColor: 'var(--color-border)' }}>
              <div className="w-7" />
              <div className="flex-1 text-[10px] font-bold uppercase tracking-wider"
                   style={{ color: 'var(--color-text-3)' }}>Location</div>
              <div className="w-20 text-right text-[10px] font-bold uppercase tracking-wider"
                   style={{ color: 'var(--color-text-3)' }}>Rating</div>
              <div className="w-6 text-center text-[10px] font-bold uppercase tracking-wider"
                   style={{ color: 'var(--color-text-3)' }}>Gr</div>
            </div>
            <div className="px-4">
              {displayed.map((loc, i) => (
                <RankRow
                  key={loc.name}
                  loc={loc}
                  isTop={i === 0}
                  isSelected={loc.name === selectedLoc?.name}
                />
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

      {/* ── WHAT WOULD IT TAKE TO BECOME #1? ────────────────────────────────── */}
      {selectedLoc && rankings.length > 1 && (
        <BecomeNumber1
          selectedLoc={selectedLoc}
          rankings={rankings}
          metrics={metrics}
          briefing={briefing}
        />
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
      {briefing.recommendation ? (
        <section>
          <div className="rounded-2xl overflow-hidden border"
               style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>

            {/* Title bar */}
            <div className="px-6 py-4 border-b flex items-center gap-3"
                 style={{ borderColor: 'var(--color-accent)', borderLeftWidth: 3,
                          background: 'rgba(217,119,6,0.03)', borderBottomColor: 'var(--color-border)' }}>
              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: 'var(--color-accent)' }} />
              <p className="text-[10px] font-bold tracking-[0.18em] uppercase"
                 style={{ color: 'var(--color-accent)' }}>
                AI Consultant Recommendation
              </p>
              <Badge variant="accent" className="ml-auto">Priority</Badge>
            </div>

            {/* Body */}
            <div className="px-6 py-5">
              <p className="text-[15px] leading-relaxed"
                 style={{ color: 'var(--color-text-1)', lineHeight: 1.85 }}>
                {briefing.recommendation}
              </p>
              <EvidencePill labels={[
                'Google ratings', 'Review volume', 'Recent sentiment',
                'Complaint categories', 'Praise categories',
                'Response rate', 'Competitor comparison',
              ]} />
            </div>
          </div>
        </section>
      ) : briefing.executiveSummary ? null : (
        /* Only show this placeholder when there's no AI content at all */
        <section>
          <div className="rounded-2xl p-6 border"
               style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)',
                        borderStyle: 'dashed' }}>
            <p className="text-[10px] font-bold tracking-[0.18em] uppercase mb-2"
               style={{ color: 'var(--color-text-3)' }}>
              AI Consultant Recommendation
            </p>
            <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
              Personalized recommendations will appear here once the AI pipeline is configured.
            </p>
          </div>
        </section>
      )}

    </div>
  )
}
