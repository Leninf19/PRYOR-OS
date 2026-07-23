import ThemeToggle from '../../components/ui/ThemeToggle.jsx'
import Badge from '../../components/ui/Badge.jsx'
import { useCompanyGoals } from '../../hooks/useCompanyGoals.js'

// Appearance + Company Goals + AI Rewrite, moved verbatim out of the old
// flat Settings.jsx (Phase 8, Milestone 8.1) -- a pure reorganization, zero
// behavior change. This is the Settings section registry's default/index
// entry (path: '').

function AIRewriteSection() {
  return (
    <div className="rounded-2xl border overflow-hidden"
         style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
      <div className="px-6 py-5 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>AI Rewrite</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
            Tone rewriting in the Customer Experience Center · requires Anthropic API key in Vercel
          </p>
        </div>
        <Badge variant="warning">Setup needed</Badge>
      </div>
      <div className="px-6 pb-5 pt-4 border-t space-y-3" style={{ borderColor: 'var(--color-border)' }}>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)', lineHeight: 1.75 }}>
          The tone rewrite buttons in the Customer Experience Center call a serverless function at{' '}
          <code className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
            /api/rewrite
          </code>.
          The function reads your Anthropic API key from Vercel environment variables — it is NOT
          the same as the GitHub secret. You need to add it separately to Vercel.
        </p>
        <div className="rounded-xl p-4 space-y-2"
             style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
          {[
            'Go to vercel.com → your project → Settings → Environment Variables',
            'Add variable: ANTHROPIC_API_KEY = your-key',
            'Set scope: Production (and Preview if testing)',
            'Save and redeploy — the key takes effect on next deploy',
          ].map((s, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <span className="text-[10px] font-bold flex-shrink-0 mt-0.5"
                    style={{ color: 'var(--color-text-3)' }}>
                {i + 1}.
              </span>
              <p className="text-xs" style={{ color: 'var(--color-text-2)' }}>{s}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const GOAL_FIELDS = [
  { key: 'avgRating',               label: 'Average Rating',                    unit: '★',      direction: '≥', step: 0.1 },
  { key: 'negativePct',              label: 'Negative Reviews (1–2★)',           unit: '%',      direction: '≤', step: 1   },
  { key: 'responseRate',             label: 'Response Rate',                     unit: '%',      direction: '≥', step: 1   },
  { key: 'avgResponseHours',         label: 'Average Response Time',             unit: 'hours',  direction: '≤', step: 1   },
  { key: 'criticalResolutionHours',  label: 'Critical Reviews Resolved Within',  unit: 'hours',  direction: '≤', step: 1   },
]

function GoalsSection() {
  const { goals, setGoals } = useCompanyGoals()

  return (
    <div className="rounded-2xl border overflow-hidden"
         style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
      <div className="px-6 py-5">
        <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Company Goals</p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
          Targets shown as progress on the Executive Dashboard — answers "are we meeting our goals?"
        </p>
      </div>
      <div className="px-6 pb-6 space-y-3 border-t pt-4" style={{ borderColor: 'var(--color-border)' }}>
        {GOAL_FIELDS.map(f => (
          <div key={f.key} className="flex items-center justify-between gap-4">
            <label className="text-xs" style={{ color: 'var(--color-text-2)' }}>
              {f.label} <span style={{ color: 'var(--color-text-3)' }}>({f.direction})</span>
            </label>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <input
                type="number"
                step={f.step}
                value={goals[f.key]}
                onChange={e => setGoals({ [f.key]: e.target.value === '' ? '' : Number(e.target.value) })}
                className="w-20 text-sm text-right px-2 py-1.5 rounded-lg border focus:outline-none"
                style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
              />
              <span className="text-xs w-10" style={{ color: 'var(--color-text-3)' }}>{f.unit}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const PLANNED = [
  { title: 'Notification Preferences', desc: 'Choose which alerts to receive and how often.' },
  { title: 'Alert Thresholds',         desc: 'Set the rating drop or backlog size that triggers an alert.' },
  { title: 'Scraper Schedule',         desc: 'Configure how often locations are scraped.' },
  { title: 'Team Members',             desc: 'Add managers and control access per location.' },
  { title: 'Export Settings',          desc: 'Default format and delivery for executive reports.' },
]

export default function General() {
  return (
    <div className="space-y-10">

      <section className="space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em]"
           style={{ color: 'var(--color-text-3)' }}>
          Appearance
        </p>
        <div className="rounded-2xl border p-5 flex items-center justify-between gap-4 flex-wrap"
             style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
          <div>
            <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Theme</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
              Auto follows your system's light/dark setting and updates automatically if it changes.
            </p>
          </div>
          <ThemeToggle />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em]"
           style={{ color: 'var(--color-text-3)' }}>
          Company Goals
        </p>
        <GoalsSection />
      </section>

      <section className="space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em]"
           style={{ color: 'var(--color-text-3)' }}>
          AI Features
        </p>
        <AIRewriteSection />
      </section>

      <section className="space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em]"
           style={{ color: 'var(--color-text-3)' }}>
          Coming Soon
        </p>
        <div className="rounded-2xl border overflow-hidden"
             style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
          {PLANNED.map((item, i) => (
            <div key={i} className="px-5 py-4 border-b last:border-0 flex items-start gap-3"
                 style={{ borderColor: 'var(--color-border)' }}>
              <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                    style={{ background: 'var(--color-border)' }} />
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--color-text-2)' }}>{item.title}</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

    </div>
  )
}
