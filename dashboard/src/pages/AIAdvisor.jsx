import Skeleton from '../components/ui/Skeleton.jsx'
import {
  useCompanySummary, useComplaintIntel, useCompetitorIntel,
  useActionItems, usePredictiveAlerts,
} from '../hooks/useIntelligence.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function fmtDate() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PriorityItem({ n, title, sub, severity }) {
  const dot = severity === 'urgent' ? 'var(--color-danger)'
    : severity === 'warning' ? 'var(--color-grade-c)'
    : severity === 'good' ? 'var(--color-success)'
    : 'var(--color-info)'
  return (
    <div className="flex items-start gap-3">
      <span className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold mt-0.5"
            style={{ background: dot, color: '#fff' }}>
        {n}
      </span>
      <div>
        <p className="text-sm font-semibold leading-snug" style={{ color: 'var(--color-text-1)' }}>{title}</p>
        {sub && <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--color-text-2)' }}>{sub}</p>}
      </div>
    </div>
  )
}

function Section({ title, accent, children }) {
  return (
    <div className="rounded-2xl border overflow-hidden"
         style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
      <div className="px-5 py-3 border-b flex items-center gap-2"
           style={{ borderColor: 'var(--color-border)', borderLeftColor: accent, borderLeftWidth: 3 }}>
        <p className="text-[10px] font-bold uppercase tracking-[0.18em]"
           style={{ color: accent ?? 'var(--color-text-3)' }}>
          {title}
        </p>
      </div>
      <div className="px-5 py-4 space-y-3">
        {children}
      </div>
    </div>
  )
}

function LocationSpotlight({ loc, type }) {
  if (!loc) return null
  const isStruggling = type === 'struggling'
  const color = isStruggling ? 'var(--color-danger)' : 'var(--color-success)'
  const delta = loc.ratingDelta ?? 0
  return (
    <div className="flex items-start gap-4 p-3 rounded-xl"
         style={{ background: 'var(--color-surface-2)' }}>
      <div className="flex-shrink-0">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center font-black text-sm"
             style={{ background: isStruggling ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)',
                      color }}>
          {isStruggling ? '↓' : '↑'}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>{loc.name}</p>
          <span className="text-xs font-semibold" style={{ color }}>
            {delta !== 0 ? `${delta > 0 ? '+' : ''}${delta.toFixed(2)}★ vs prior` : `${loc.avgRating?.toFixed(2)}★`}
          </span>
        </div>
        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
          Rank #{loc.rank} · {loc.reviewCount} reviews · {loc.grade} grade
        </p>
      </div>
    </div>
  )
}

function ActionItem({ n, text }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold mt-0.5"
            style={{ background: 'var(--color-accent)', color: '#fff' }}>
        {n}
      </span>
      <p className="text-sm leading-snug" style={{ color: 'var(--color-text-1)' }}>{text}</p>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-5 max-w-[780px]">
      <div className="space-y-2">
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-4 w-56" />
      </div>
      {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AIAdvisor() {
  const { data: summary,    isLoading: lS } = useCompanySummary()
  const { data: complaint,  isLoading: lC } = useComplaintIntel()
  const { data: competitor, isLoading: lR } = useCompetitorIntel()
  const { data: actions,    isLoading: lA } = useActionItems()
  const { data: predictive, isLoading: lP } = usePredictiveAlerts()

  const isLoading = lS || lC || lR || lA || lP

  if (isLoading) return <LoadingSkeleton />

  // ── Derive intelligence ───────────────────────────────────────────────────

  const rankings     = competitor?.locationRankings ?? []
  const unanswered   = actions?.unanswered ?? []
  const trendAlerts  = actions?.trendAlerts ?? []
  const praises      = complaint?.praises ?? []
  const complaints   = complaint?.complaints ?? []
  const briefing     = competitor?.weeklyBriefing ?? {}
  const predAlerts   = Array.isArray(predictive) ? predictive : (predictive?.alerts ?? [])

  // Worst performer by ratingDelta (most negative)
  const struggling = rankings.reduce((worst, loc) => {
    if ((loc.ratingDelta ?? 0) < (worst?.ratingDelta ?? 0)) return loc
    return worst
  }, null)

  // Best performer by ratingDelta (most positive)
  const improving = rankings.reduce((best, loc) => {
    if ((loc.ratingDelta ?? 0) > (best?.ratingDelta ?? 0)) return loc
    return best
  }, null)

  // Response backlog by location
  const byLoc = {}
  unanswered.forEach(r => { byLoc[r.location_name] = (byLoc[r.location_name] ?? 0) + 1 })
  const highestBacklogLoc = Object.entries(byLoc).sort((a, b) => b[1] - a[1])[0]

  // Top praised item for marketing
  const topPraise   = praises[0]?.name ?? null
  const topPraise2  = praises[1]?.name ?? null
  const topComplaint = complaints[0]?.name ?? null

  // Build today's priorities
  const priorities = []

  if (unanswered.length > 0) {
    priorities.push({
      severity: 'urgent',
      title: `${unanswered.length} negative review${unanswered.length > 1 ? 's' : ''} need a response`,
      sub: highestBacklogLoc ? `${highestBacklogLoc[0]} has the largest backlog (${highestBacklogLoc[1]})` : null,
    })
  }

  if (struggling && (struggling.ratingDelta ?? 0) < -0.1) {
    priorities.push({
      severity: 'warning',
      title: `${struggling.name} is declining`,
      sub: `Rating dropped ${struggling.ratingDelta?.toFixed(2)}★ vs prior period — investigate service issues`,
    })
  }

  if (topComplaint) {
    priorities.push({
      severity: 'warning',
      title: `"${topComplaint}" is your top complaint`,
      sub: `${complaints[0]?.count ?? ''} mentions${complaints[0]?.pct ? ` · ${complaints[0].pct}% of reviews` : ''}`,
    })
  }

  if (topPraise) {
    priorities.push({
      severity: 'good',
      title: `Customers are praising "${topPraise}"`,
      sub: topPraise2
        ? `Also frequently praised: "${topPraise2}" — strong campaign potential`
        : 'Consider featuring this in social and marketing content',
    })
  }

  if (improving && (improving.ratingDelta ?? 0) > 0.1) {
    priorities.push({
      severity: 'good',
      title: `${improving.name} is your most improved location`,
      sub: `Rating up ${improving.ratingDelta?.toFixed(2)}★ — identify what's working and share across teams`,
    })
  }

  // Recommended actions
  const actions_list = []
  if (unanswered.length > 0) {
    actions_list.push('Respond to all unanswered 1–2★ reviews — prioritize the oldest ones first')
  }
  if (struggling && (struggling.ratingDelta ?? 0) < -0.1) {
    actions_list.push(`Review recent complaints at ${struggling.name} and schedule a manager check-in`)
  }
  if (topComplaint) {
    actions_list.push(`Address "${topComplaint}" — this is the #1 recurring issue across your network`)
  }
  if (topPraise) {
    actions_list.push(`Launch a marketing campaign around "${topPraise}" — customers consistently mention it`)
  }
  if (improving && (improving.ratingDelta ?? 0) > 0.1) {
    actions_list.push(`Document what's improving at ${improving.name} and apply it to lower-ranked locations`)
  }
  if (briefing.marketingOpportunity) {
    actions_list.push(briefing.marketingOpportunity)
  }

  const aiSummaryText = summary?.summary ?? summary?.narrative ?? summary?.text ?? null

  return (
    <div className="space-y-6 max-w-[780px]">

      {/* ── Morning brief header ─────────────────────────────────────────────── */}
      <div className="rounded-2xl p-6 border"
           style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)',
                    boxShadow: 'var(--shadow-md)' }}>
        <div className="flex items-center gap-2 mb-4">
          <div className="w-1.5 h-6 rounded-full" style={{ background: 'var(--color-accent)' }} />
          <p className="text-[10px] font-bold tracking-[0.18em] uppercase"
             style={{ color: 'var(--color-accent)' }}>
            AI Advisor
          </p>
        </div>
        <h1 className="text-heading mb-0.5" style={{ color: 'var(--color-text-1)' }}>
          {greeting()}.
        </h1>
        <p className="text-sm mb-4" style={{ color: 'var(--color-text-3)' }}>{fmtDate()}</p>
        {priorities.length > 0 ? (
          <p className="text-[15px] leading-relaxed" style={{ color: 'var(--color-text-2)', lineHeight: 1.8 }}>
            Future Insights found <strong style={{ color: 'var(--color-text-1)' }}>{priorities.length} priorities</strong> for
            your team today. Here is what to focus on.
          </p>
        ) : (
          <p className="text-[15px] leading-relaxed" style={{ color: 'var(--color-text-2)', lineHeight: 1.8 }}>
            All locations appear stable. Run the analytics pipeline to get AI-powered priorities.
          </p>
        )}
      </div>

      {/* ── Today's priorities ────────────────────────────────────────────────── */}
      {priorities.length > 0 && (
        <Section title="Today's Priorities" accent="var(--color-accent)">
          {priorities.map((p, i) => (
            <PriorityItem key={i} n={i + 1} title={p.title} sub={p.sub} severity={p.severity} />
          ))}
        </Section>
      )}

      {/* ── Location spotlight ────────────────────────────────────────────────── */}
      {(struggling || improving) && (
        <Section title="Location Spotlight" accent="var(--color-info)">
          {struggling && (struggling.ratingDelta ?? 0) < -0.05 && (
            <div>
              <p className="text-[10px] uppercase tracking-widest font-bold mb-2"
                 style={{ color: 'var(--color-text-3)' }}>
                Needs attention
              </p>
              <LocationSpotlight loc={struggling} type="struggling" />
            </div>
          )}
          {improving && (improving.ratingDelta ?? 0) > 0.05 && (
            <div>
              <p className="text-[10px] uppercase tracking-widest font-bold mb-2"
                 style={{ color: 'var(--color-text-3)' }}>
                Most improved
              </p>
              <LocationSpotlight loc={improving} type="improving" />
            </div>
          )}
        </Section>
      )}

      {/* ── What to promote ──────────────────────────────────────────────────── */}
      {praises.length > 0 && (
        <Section title="What to Promote" accent="var(--color-success)">
          <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-2)', lineHeight: 1.75 }}>
            Your customers are consistently praising{' '}
            {praises.slice(0, 3).map((p, i, arr) => (
              <span key={i}>
                <strong style={{ color: 'var(--color-text-1)' }}>{p.name}</strong>
                {i < arr.length - 1 ? ', ' : ''}
              </span>
            ))}.{' '}
            {praises[0]?.count ? `"${praises[0].name}" was mentioned ${praises[0].count} times in the last 30 days. ` : ''}
            These are your strongest marketing hooks right now.
          </p>
          {briefing.marketingOpportunity && (
            <p className="text-sm leading-relaxed mt-2" style={{ color: 'var(--color-text-1)', lineHeight: 1.75 }}>
              {briefing.marketingOpportunity}
            </p>
          )}
        </Section>
      )}

      {/* ── AI company summary ────────────────────────────────────────────────── */}
      {aiSummaryText && (
        <Section title="Network Summary" accent="var(--color-text-3)">
          <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-1)', lineHeight: 1.8 }}>
            {aiSummaryText}
          </p>
        </Section>
      )}

      {/* ── Recommended actions ───────────────────────────────────────────────── */}
      {actions_list.length > 0 && (
        <Section title="Recommended Actions" accent="var(--color-accent)">
          {actions_list.map((a, i) => <ActionItem key={i} n={i + 1} text={a} />)}
          <p className="text-[10px] pt-1" style={{ color: 'var(--color-text-3)' }}>
            Priorities are based on current ratings, review volume, sentiment, and response rate — not guaranteed outcomes.
          </p>
        </Section>
      )}

    </div>
  )
}
