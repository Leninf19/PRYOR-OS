import Skeleton from './Skeleton.jsx'

// Extracted unchanged from Overview.jsx (M4) so Today.jsx can reuse the same
// live-brief + pipeline-summary-fallback behavior under its own label,
// without losing the fallback path Overview.jsx already relied on.
// Prefers the live, filter-reactive briefing (regenerates as the date/brand/
// location filters change); falls back to the last pipeline-generated
// summary if the live endpoint errors or no API key is configured -- same
// graceful-degradation pattern used on "What Changed?".
// Today UX Simplification: `topPriorities` is optional (Today.jsx passes its
// digest's already-computed, already-capped top items; Overview.jsx doesn't
// pass it and is unaffected) -- a quick-glance echo of titles only, no
// explanation/CTA, so it doesn't duplicate the full actionable Needs
// Attention cards sitting right next to this card.
export default function AIBriefingCard({ label, brief, summary, loading, periodLabel, topPriorities }) {
  const aiSummaryText = summary?.summary ?? summary?.narrative ?? summary?.text ?? null

  return (
    <div className="ai-card p-6">
      <div className="flex items-center gap-2 mb-3">
        <span className="ai-label">✦ {label}</span>
        <span className="text-[10px] ml-auto opacity-40">
          {summary?.generatedAt ? new Date(summary.generatedAt).toLocaleDateString() : ''}
        </span>
      </div>
      {brief.loading || loading ? (
        <div className="space-y-2 opacity-30">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </div>
      ) : brief.text ? (
        <>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--ai-card-text-2)' }}>{brief.text}</p>
          {periodLabel && (
            <p className="text-[10px] mt-2 opacity-50">Generated live for {periodLabel}</p>
          )}
        </>
      ) : aiSummaryText ? (
        <>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--ai-card-text-2)' }}>{aiSummaryText}</p>
          <p className="text-[10px] mt-2 opacity-50">
            {brief.error
              ? 'Live briefing unavailable — showing the last pipeline-generated summary instead.'
              : 'From the last analytics pipeline run (trailing 30 days).'}
          </p>
        </>
      ) : (
        <p className="text-sm italic" style={{ color: 'var(--ai-card-text-2)', opacity: 0.5 }}>
          AI summary will appear here once ANTHROPIC_API_KEY is added to GitHub secrets.
        </p>
      )}
      {topPriorities?.length > 0 && (
        <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--ai-card-border)' }}>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5 opacity-60">Top priorities</p>
          <ul className="space-y-1">
            {topPriorities.slice(0, 3).map(p => (
              <li key={p.id} className="text-xs leading-snug" style={{ color: 'var(--ai-card-text-2)' }}>
                · {p.title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
