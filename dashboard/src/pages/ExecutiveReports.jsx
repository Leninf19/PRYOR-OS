import { useState } from 'react'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import {
  useWeeklyReportData, useKPIs, useCompanySummary,
  useComplaintIntel, useCompetitorIntel,
} from '../hooks/useIntelligence.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n, decimals = 2) {
  if (n == null) return '—'
  return typeof n === 'number' ? n.toFixed(decimals) : n
}

function exportTxt(title, lines) {
  const text = [`Future Insights — ${title}`, `Generated: ${new Date().toLocaleString()}`, '', ...lines].join('\n')
  const blob = new Blob([text], { type: 'text/plain' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = `${title.toLowerCase().replace(/\s+/g, '-')}.txt`; a.click()
  URL.revokeObjectURL(url)
}

// ── Building blocks ───────────────────────────────────────────────────────────

function ReportSection({ title, children }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em]"
         style={{ color: 'var(--color-text-3)' }}>
        {title}
      </p>
      {children}
    </div>
  )
}

function MetricRow({ label, value, sub, trend }) {
  return (
    <div className="flex items-center justify-between py-2 border-b last:border-0"
         style={{ borderColor: 'var(--color-border)' }}>
      <span className="text-sm" style={{ color: 'var(--color-text-2)' }}>{label}</span>
      <div className="text-right">
        <span className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>{value}</span>
        {sub && <span className="text-[10px] ml-2" style={{ color: 'var(--color-text-3)' }}>{sub}</span>}
        {trend > 0 && <span className="text-[10px] ml-2 trend-up">↑</span>}
        {trend < 0 && <span className="text-[10px] ml-2 trend-down">↓</span>}
      </div>
    </div>
  )
}

function BulletList({ items, color }) {
  if (!items?.length) return <p className="text-sm" style={{ color: 'var(--color-text-3)' }}>—</p>
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2">
          <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                style={{ background: color ?? 'var(--color-accent)' }} />
          <p className="text-sm leading-snug" style={{ color: 'var(--color-text-1)' }}>{item}</p>
        </li>
      ))}
    </ul>
  )
}

function ExportButton({ onClick }) {
  return (
    <button onClick={onClick}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-opacity hover:opacity-75"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-2)',
                     background: 'var(--color-surface-2)' }}>
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
      </svg>
      Export
    </button>
  )
}

function ReportShell({ title, badge, children, onExport, isLoading }) {
  return (
    <div className="rounded-2xl border overflow-hidden"
         style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
      <div className="px-6 py-4 border-b flex items-center justify-between"
           style={{ borderColor: 'var(--color-border)' }}>
        <div className="flex items-center gap-2">
          <h2 className="text-title" style={{ color: 'var(--color-text-1)' }}>{title}</h2>
          {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
        </div>
        {onExport && !isLoading && <ExportButton onClick={onExport} />}
      </div>
      <div className="px-6 py-5 space-y-6">
        {isLoading
          ? [...Array(3)].map((_, i) => <Skeleton key={i} className="h-12" />)
          : children}
      </div>
    </div>
  )
}

// ── Report panels ─────────────────────────────────────────────────────────────

function WeeklyPanel({ weekly, kpis }) {
  if (!weekly) {
    return (
      <EmptyState icon="📋" title="Weekly report not yet generated"
                  body="Run the analytics pipeline to generate your first weekly report." />
    )
  }

  const topLocs = Object.entries(weekly.byLocation ?? {})
    .sort((a, b) => b[1] - a[1]).slice(0, 5)

  const wins  = []
  const risks = []

  Object.entries(weekly.avgNow ?? {}).forEach(([name, now]) => {
    const prev = weekly.avgPrev?.[name]
    if (prev == null) return
    const delta = now - prev
    if (delta >= 0.15) wins.push(`${name} improved ${delta.toFixed(2)}★ vs prior 30 days`)
    if (delta <= -0.15) risks.push(`${name} declined ${Math.abs(delta).toFixed(2)}★ vs prior 30 days`)
  })

  function handleExport() {
    const lines = [
      `Period: ${weekly.weekStr}`,
      `New reviews this week: ${weekly.totalNew}`,
      `Unanswered 1–2★: ${weekly.unanswered}`,
      '',
      'WINS:',
      ...wins.map(w => `• ${w}`),
      '',
      'RISKS:',
      ...risks.map(r => `• ${r}`),
      '',
      'NEW REVIEWS BY LOCATION:',
      ...topLocs.map(([n, c]) => `• ${n}: ${c}`),
    ]
    exportTxt('Weekly Report', lines)
  }

  return (
    <ReportShell title="Weekly Report" badge={{ variant: 'accent', label: weekly.weekStr }} onExport={handleExport}>
      <div className="grid sm:grid-cols-3 gap-3">
        {[
          { label: 'New Reviews',    value: weekly.totalNew?.toString() ?? '—' },
          { label: 'Unanswered',     value: weekly.unanswered?.toString() ?? '—' },
          { label: 'Locations Active', value: Object.keys(weekly.byLocation ?? {}).length.toString() },
        ].map(m => (
          <div key={m.label} className="p-3 rounded-xl text-center"
               style={{ background: 'var(--color-surface-2)' }}>
            <p className="text-2xl font-black" style={{ color: 'var(--color-text-1)', fontWeight: 800 }}>{m.value}</p>
            <p className="text-[10px] uppercase tracking-widest mt-0.5" style={{ color: 'var(--color-text-3)' }}>{m.label}</p>
          </div>
        ))}
      </div>

      {wins.length > 0 && (
        <ReportSection title="Wins this week">
          <BulletList items={wins} color="var(--color-success)" />
        </ReportSection>
      )}

      {risks.length > 0 && (
        <ReportSection title="Risks this week">
          <BulletList items={risks} color="var(--color-danger)" />
        </ReportSection>
      )}

      {topLocs.length > 0 && (
        <ReportSection title="New reviews by location">
          <div style={{ background: 'var(--color-surface-2)', borderRadius: 12, overflow: 'hidden', padding: '0 12px' }}>
            {topLocs.map(([name, count]) => (
              <MetricRow key={name} label={name} value={`${count} new`} />
            ))}
          </div>
        </ReportSection>
      )}

      {weekly.complaints?.length > 0 && (
        <ReportSection title="Top complaint words this week">
          <div className="flex flex-wrap gap-2">
            {weekly.complaints.map(([w, n]) => (
              <span key={w} className="text-xs px-2.5 py-1 rounded-full font-medium"
                    style={{ background: 'rgba(239,68,68,0.08)', color: 'var(--color-danger)',
                             border: '1px solid rgba(239,68,68,0.15)' }}>
                {w} <span className="opacity-60">×{n}</span>
              </span>
            ))}
          </div>
        </ReportSection>
      )}
    </ReportShell>
  )
}

function ComplaintPanel({ complaint }) {
  if (!complaint) {
    return <EmptyState icon="📊" title="Complaint data not yet generated"
                       body="Run the analytics pipeline to see complaint trend analysis." />
  }

  const top5  = complaint.complaints?.slice(0, 5) ?? []
  const top5p = complaint.praises?.slice(0, 5) ?? []

  function handleExport() {
    const lines = [
      'TOP COMPLAINTS:',
      ...top5.map(c => `• ${c.name}: ${c.count} mentions (${c.pct}%) — ${c.trend}`),
      '',
      'TOP PRAISE:',
      ...top5p.map(p => `• ${p.name}: ${p.count} mentions (${p.pct}%)`),
    ]
    exportTxt('Complaint Trend Report', lines)
  }

  return (
    <ReportShell title="Complaint Trend Report" onExport={handleExport}>
      <ReportSection title="Top complaints (last 30 days)">
        <div style={{ borderRadius: 12, overflow: 'hidden', background: 'var(--color-surface-2)', padding: '0 12px' }}>
          {top5.map(c => (
            <MetricRow key={c.name} label={c.name}
                       value={`${c.count} mentions · ${c.pct}%`}
                       sub={c.trend === 'up' ? '↑ rising' : c.trend === 'down' ? '↓ falling' : '→ stable'}
                       trend={c.trend === 'up' ? -1 : c.trend === 'down' ? 1 : 0} />
          ))}
        </div>
      </ReportSection>
      <ReportSection title="Top praise (last 30 days)">
        <div style={{ borderRadius: 12, overflow: 'hidden', background: 'var(--color-surface-2)', padding: '0 12px' }}>
          {top5p.map(p => (
            <MetricRow key={p.name} label={p.name}
                       value={`${p.count} mentions · ${p.pct}%`}
                       trend={p.trend === 'up' ? 1 : 0} />
          ))}
        </div>
      </ReportSection>
    </ReportShell>
  )
}

function CompetitorPanel({ competitor }) {
  if (!competitor) {
    return <EmptyState icon="◎" title="Competitive report not yet generated"
                       body="Run the analytics pipeline to generate your competitor report." />
  }

  const b       = competitor.weeklyBriefing ?? {}
  const top3    = (competitor.locationRankings ?? []).slice(0, 5)
  const metrics = competitor.metrics ?? {}

  function handleExport() {
    const lines = [
      `Period: ${competitor.period}`,
      `Avg rating: ${metrics.avgRating?.value?.toFixed(2)}★`,
      `Response rate: ${metrics.responseRate?.value?.toFixed(0)}%`,
      '',
      'RANKINGS:',
      ...top3.map(l => `#${l.rank} ${l.name} — ${l.avgRating?.toFixed(2)}★ (${l.grade})`),
      '',
      b.recommendation ? `AI RECOMMENDATION:\n${b.recommendation}` : '',
    ]
    exportTxt('Competitor Report', lines)
  }

  return (
    <ReportShell title="Competitor Report"
                 badge={{ variant: 'neutral', label: competitor.period ?? 'last 30 days' }}
                 onExport={handleExport}>
      {b.executiveSummary && (
        <ReportSection title="Executive summary">
          <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-1)', lineHeight: 1.8 }}>
            {b.executiveSummary}
          </p>
        </ReportSection>
      )}

      <ReportSection title="Top 5 locations by rating">
        <div style={{ borderRadius: 12, overflow: 'hidden', background: 'var(--color-surface-2)', padding: '0 12px' }}>
          {top3.map(l => (
            <MetricRow key={l.name} label={`#${l.rank} ${l.name}`}
                       value={`${l.avgRating?.toFixed(2)}★`}
                       sub={`${l.reviewCount} reviews · Grade ${l.grade}`}
                       trend={l.ratingDelta > 0 ? 1 : l.ratingDelta < 0 ? -1 : 0} />
          ))}
        </div>
      </ReportSection>

      {b.biggestWin && (
        <div className="grid sm:grid-cols-2 gap-3">
          {b.biggestWin    && <div className="card p-3"><p className="text-[9px] uppercase tracking-widest font-bold mb-1" style={{ color: 'var(--color-success)' }}>Biggest Win</p><p className="text-sm" style={{ color: 'var(--color-text-1)' }}>{b.biggestWin}</p></div>}
          {b.biggestThreat && <div className="card p-3"><p className="text-[9px] uppercase tracking-widest font-bold mb-1" style={{ color: 'var(--color-danger)' }}>Biggest Threat</p><p className="text-sm" style={{ color: 'var(--color-text-1)' }}>{b.biggestThreat}</p></div>}
        </div>
      )}

      {b.recommendation && (
        <ReportSection title="AI recommendation">
          <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-1)', lineHeight: 1.8 }}>
            {b.recommendation}
          </p>
        </ReportSection>
      )}
    </ReportShell>
  )
}

function NetworkSummaryPanel({ summary }) {
  const text = summary?.summary ?? summary?.narrative ?? summary?.text ?? null
  if (!text) return (
    <EmptyState icon="🏢" title="Network summary not yet available"
                body="Run the analytics pipeline with AI enabled to generate the network summary." />
  )
  function handleExport() {
    exportTxt('Network Summary', [text, '', `Generated at: ${summary?.generatedAt ?? 'unknown'}`])
  }
  return (
    <ReportShell title="Network Summary" badge={{ variant: 'accent', label: 'AI' }} onExport={handleExport}>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-1)', lineHeight: 1.85 }}>{text}</p>
    </ReportShell>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'weekly',    label: 'Weekly'      },
  { id: 'complaint', label: 'Complaints'  },
  { id: 'competitor',label: 'Competitive' },
  { id: 'network',   label: 'Network AI'  },
]

export default function ExecutiveReports() {
  const { data: weekly,     isLoading: lW } = useWeeklyReportData()
  const { data: kpis,       isLoading: lK } = useKPIs()
  const { data: summary,    isLoading: lS } = useCompanySummary()
  const { data: complaint,  isLoading: lC } = useComplaintIntel()
  const { data: competitor, isLoading: lR } = useCompetitorIntel()
  const [tab, setTab] = useState('weekly')

  const loading = { weekly: lW, complaint: lC, competitor: lR, network: lS }

  return (
    <div className="space-y-6 max-w-[900px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Executive Reports</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Performance summaries and intelligence reports for management
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-xl w-fit flex-wrap" style={{ background: 'var(--color-surface-2)' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
                  className="px-4 py-2 text-sm font-medium rounded-lg transition-all"
                  style={tab === t.id
                    ? { background: 'var(--color-surface)', color: 'var(--color-text-1)', boxShadow: 'var(--shadow-sm)' }
                    : { color: 'var(--color-text-2)' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Panels */}
      {loading[tab] ? (
        <div className="space-y-4">
          <Skeleton className="h-12 rounded-2xl" />
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-16" />)}
        </div>
      ) : (
        <>
          {tab === 'weekly'     && <WeeklyPanel     weekly={weekly}       kpis={kpis} />}
          {tab === 'complaint'  && <ComplaintPanel  complaint={complaint} />}
          {tab === 'competitor' && <CompetitorPanel competitor={competitor} />}
          {tab === 'network'    && <NetworkSummaryPanel summary={summary} />}
        </>
      )}
    </div>
  )
}
