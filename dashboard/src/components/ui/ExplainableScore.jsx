import { useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Makes any score clickable to reveal how it was calculated -- generalizes
 * the expand pattern first built for ExecutiveDashboard's ScoreCard so it
 * can wrap a CX Index tile, a health ring, a location grade badge, or a
 * department card without caring about the trigger's layout (renders a
 * centered modal via portal instead of inline expansion).
 *
 * <ExplainableScore label="Speed" score={72} prevScore={65} explanation="..."
 *                    confidence={{label:'High', sampleSize: 42}}>
 *   <YourScoreVisual />
 * </ExplainableScore>
 */
export default function ExplainableScore({
  label, score, unit = '', prevScore, delta, trend, explanation,
  confidence, reviewCount, children,
}) {
  const [open, setOpen] = useState(false)

  const computedDelta = delta ?? (score != null && prevScore != null ? +(score - prevScore).toFixed(2) : null)
  const computedTrend = trend ?? (computedDelta > 0 ? 'up' : computedDelta < 0 ? 'down' : 'stable')

  return (
    <>
      <div
        onClick={() => setOpen(true)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true) } }}
        role="button"
        tabIndex={0}
        aria-label={`Explain ${label}`}
        className="cursor-pointer"
      >
        {children}
      </div>

      {open && createPortal(
        <>
          <div
            className="fixed inset-0 z-[60]"
            style={{ background: 'rgba(26,23,20,0.45)', backdropFilter: 'blur(4px)' }}
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            className="fixed z-[60] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-sm mx-4 rounded-2xl p-5"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-xl)' }}
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-start justify-between gap-3 mb-3">
              <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>{label}</p>
              <button onClick={() => setOpen(false)} aria-label="Close"
                      className="p-1 rounded-lg hover:bg-stone-100 dark:hover:bg-[var(--color-surface-2)]"
                      style={{ color: 'var(--color-text-2)' }}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>

            {score != null && (
              <p className="text-3xl font-black mb-1" style={{ color: 'var(--color-text-1)', fontWeight: 800 }}>
                {score}{unit}
              </p>
            )}

            {computedDelta != null && computedTrend !== 'stable' && (
              <p className="text-xs font-semibold mb-3"
                 style={{ color: computedTrend === 'up' ? 'var(--color-success)' : 'var(--color-danger)' }}>
                {computedTrend === 'up' ? '↑' : '↓'} {Math.abs(computedDelta)}{unit} vs. prior period ({prevScore}{unit})
              </p>
            )}

            {explanation && (
              <div className="mb-3">
                <p className="text-[9px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--color-text-3)' }}>
                  How this is calculated
                </p>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)' }}>{explanation}</p>
              </div>
            )}

            <div className="flex items-center gap-4 flex-wrap">
              {confidence && (
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Confidence</p>
                  <p className="text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>
                    {confidence.label}{confidence.sampleSize != null && ` (n=${confidence.sampleSize})`}
                  </p>
                </div>
              )}
              {reviewCount != null && (
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>Reviews</p>
                  <p className="text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>{reviewCount}</p>
                </div>
              )}
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  )
}
