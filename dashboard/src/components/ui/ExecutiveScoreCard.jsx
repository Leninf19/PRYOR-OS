import { useState } from 'react'
import Card from './Card.jsx'

// Extracted unchanged from ExecutiveDashboard.jsx (M4) so Today.jsx can
// reuse the same 8 composite-score cards without a second implementation.
const SCORE_ICON = {
  health: '❤️', satisfaction: '😊', reputation: '⭐', marketing: '📣',
  risk: '⚠️', manager: '👔', growth: '📈', trend: '🔮',
}

function scoreColor(score, higherIsBetter) {
  if (score == null) return 'var(--color-text-3)'
  const effective = higherIsBetter ? score : 100 - score
  if (effective >= 80) return 'var(--color-star-5)'
  if (effective >= 65) return 'var(--color-star-4)'
  if (effective >= 50) return 'var(--color-grade-c)'
  return 'var(--color-star-1)'
}

export default function ExecutiveScoreCard({ s }) {
  const [open, setOpen] = useState(false)
  return (
    <Card className="p-5 cursor-pointer" onClick={() => setOpen(o => !o)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xl" aria-hidden="true">{SCORE_ICON[s.id] ?? '📊'}</span>
          <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>{s.label}</p>
        </div>
        {!s.higherIsBetter && (
          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{ background: 'var(--color-warning-bg)', color: 'var(--color-warning)' }}>
            Lower is better
          </span>
        )}
      </div>
      <p className="text-4xl font-black mt-3" style={{ color: scoreColor(s.score, s.higherIsBetter), fontWeight: 800 }}>
        {s.score ?? '—'}<span className="text-base font-normal" style={{ color: 'var(--color-text-3)' }}> / 100</span>
      </p>
      <button className="text-xs font-medium mt-2" style={{ color: 'var(--color-accent)' }}>
        {open ? 'Hide calculation' : 'How is this calculated?'}
      </button>
      {open && (
        <p className="text-xs leading-relaxed mt-2 pt-2 border-t" style={{ color: 'var(--color-text-2)', borderColor: 'var(--color-border)' }}>
          {s.explanation}
        </p>
      )}
    </Card>
  )
}
