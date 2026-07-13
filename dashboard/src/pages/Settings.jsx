import { useState, useEffect } from 'react'
import Badge from '../components/ui/Badge.jsx'
import ThemeToggle from '../components/ui/ThemeToggle.jsx'

// ── Google Business Profile integration section ───────────────────────────────

const GBP_STEPS = [
  {
    n: 1,
    title: 'Submit API access request to Google',
    body: 'The Google Business Profile API is not publicly open — access must be approved by Google manually. Visit the GBP API prerequisites page and submit an "Application for Basic API Access." Use the business email that manages your GBP account. Approval typically takes 1–5 business days.',
    tag: 'Do this first',
    link: { label: 'Open prerequisites & request form ↗', href: 'https://developers.google.com/my-business/content/prereqs' },
  },
  {
    n: 2,
    title: 'Create a Google Cloud project',
    body: 'Go to console.cloud.google.com and create a new project (or use an existing one). Note the Project ID — you\'ll need it in the next steps.',
    tag: 'After approval',
  },
  {
    n: 3,
    title: 'Enable the required APIs',
    body: 'In your Cloud project → APIs & Services → Library, enable: "Google My Business API" (for reading and replying to reviews) and "My Business Account Management API" (to list all your locations).',
    tag: 'After approval',
  },
  {
    n: 4,
    title: 'Create OAuth 2.0 credentials',
    body: 'Go to Credentials → Create credentials → OAuth 2.0 Client ID. Set application type to "Web Application." Under "Authorized redirect URIs" add: https://[your-domain]/api/google/callback (replace [your-domain] with your Vercel production URL). This gives you a Client ID and Client Secret.',
    tag: 'After approval',
  },
  {
    n: 5,
    title: 'Add credentials to Vercel environment variables',
    body: 'In your Vercel project → Settings → Environment Variables, add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN. Once set, Future Insights authenticates with Google automatically without re-authorization each time.',
    tag: 'Final step',
  },
]

const PLANNED_GBP = [
  'One-click "Publish to Google" from every review card',
  'Real-time sync — reviews appear in Future Insights within minutes',
  'Auto-detect reviews already responded to on Google',
  'Full status tracking: Approved → Published → Confirmed on Google',
  'Failure alerts with exact reason (permission missing, review removed, etc.)',
]

function useGoogleStatus() {
  const [status, setStatus] = useState({ loading: true })
  useEffect(() => {
    fetch('/api/google/status')
      .then(r => r.json())
      .then(d => setStatus({ loading: false, ...d }))
      .catch(() => setStatus({ loading: false, connected: false, state: 'error' }))
  }, [])
  return status
}

function GBPSection() {
  const [stepsOpen, setStepsOpen] = useState(false)
  const status = useGoogleStatus()

  const badge = status.loading
    ? { label: '…', variant: 'neutral' }
    : status.connected
      ? { label: 'Connected', variant: 'success' }
      : status.state === 'needs_token'
        ? { label: 'Ready to Connect', variant: 'info' }
        : status.state === 'invalid_credentials'
          ? { label: 'Auth Error', variant: 'danger' }
          : { label: 'Not Connected', variant: 'neutral' }

  return (
    <div className="space-y-4">

      {/* Status card */}
      <div className="rounded-2xl border overflow-hidden"
           style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
        <div className="px-6 py-5 flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                 style={{ background: 'rgba(217,119,6,0.07)' }}>
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>
                Google Business Profile
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
                {status.connected
                  ? `Connected as ${status.accountName || 'Google Business Profile'}`
                  : 'Read and reply to reviews via the official GBP API'}
              </p>
            </div>
          </div>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>

        <div className="px-6 py-4 border-t" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-2)' }}>
          {status.connected ? (
            <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)', lineHeight: 1.75 }}>
              One-click publishing is active for all 21 locations. To disconnect, remove
              <code className="mx-1 text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
                GOOGLE_REFRESH_TOKEN
              </code>
              from Vercel environment variables.
            </p>
          ) : (
            <>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)', lineHeight: 1.75 }}>
                Once connected, one Google account covers all 21 locations. Future Insights can publish
                responses directly to Google, sync new reviews automatically, and track publish status
                for every response your team sends.
              </p>
              <div className="mt-3 flex items-center gap-3 flex-wrap">
                {status.state === 'needs_token' && (
                  <a href="/api/google/auth"
                     className="text-xs font-semibold px-3.5 py-2 rounded-lg border transition-colors"
                     style={{ background: 'var(--color-accent)', borderColor: 'var(--color-accent)', color: 'white' }}>
                    Connect Google Account →
                  </a>
                )}
                <button
                  onClick={() => setStepsOpen(s => !s)}
                  className="text-xs font-semibold px-3.5 py-2 rounded-lg border transition-colors"
                  style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }}>
                  {stepsOpen ? 'Hide setup guide' : 'View setup guide (5 steps)'}
                </button>
                {status.state !== 'needs_token' && (
                  <span className="text-[10px]" style={{ color: 'var(--color-text-3)' }}>
                    Requires Google API approval · 1–5 business days
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Setup steps */}
      {stepsOpen && (
        <div className="rounded-2xl border overflow-hidden"
             style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
          <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em]"
               style={{ color: 'var(--color-text-3)' }}>
              Setup Guide · 5 Steps
            </p>
          </div>

          <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
            {GBP_STEPS.map(step => (
              <div key={step.n} className="px-6 py-4 flex gap-4">
                <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 text-[11px] font-bold"
                     style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)', border: '1px solid var(--color-border)' }}>
                  {step.n}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1.5">
                    <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>
                      {step.title}
                    </p>
                    <span className="text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide"
                          style={{ background: 'rgba(217,119,6,0.07)', color: 'var(--color-grade-c)', border: '1px solid rgba(217,119,6,0.15)' }}>
                      {step.tag}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)', lineHeight: 1.75 }}>
                    {step.body}
                  </p>
                  {step.link && (
                    <a href={step.link.href} target="_blank" rel="noopener noreferrer"
                       className="inline-block mt-2 text-xs font-medium underline"
                       style={{ color: 'var(--color-accent)' }}>
                      {step.link.label}
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Technical reference */}
          <div className="px-6 py-4 border-t" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-2)' }}>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] mb-3"
               style={{ color: 'var(--color-text-3)' }}>
              Technical Reference
            </p>
            <div className="space-y-2">
              {[
                { label: 'API base URL',     value: 'https://mybusiness.googleapis.com/v4' },
                { label: 'OAuth scope',      value: 'https://www.googleapis.com/auth/business.manage' },
                { label: 'Reply endpoint',   value: 'PUT .../reviews/{reviewId}/reply' },
                { label: 'Rate limit',       value: '300 requests/minute (after approval)' },
                { label: 'Location coverage', value: 'All 21 locations under one Google account token' },
              ].map(row => (
                <div key={row.label} className="flex items-start gap-3">
                  <span className="text-[10px] w-28 flex-shrink-0 font-medium mt-0.5"
                        style={{ color: 'var(--color-text-3)' }}>
                    {row.label}
                  </span>
                  <code className="text-[10px] px-1.5 py-0.5 rounded font-mono break-all leading-relaxed"
                        style={{ background: 'var(--color-surface)', color: 'var(--color-text-2)', border: '1px solid var(--color-border)' }}>
                    {row.value}
                  </code>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* What this unlocks */}
      <div className="rounded-2xl border p-5"
           style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
        <p className="text-[10px] font-bold uppercase tracking-[0.15em] mb-3"
           style={{ color: 'var(--color-text-3)' }}>
          What connecting unlocks
        </p>
        <ul className="space-y-2">
          {PLANNED_GBP.map((item, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                    style={{ background: 'var(--color-accent)' }} />
              <p className="text-xs" style={{ color: 'var(--color-text-2)' }}>{item}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

// ── AI Rewrite section ────────────────────────────────────────────────────────

function AIRewriteSection() {
  return (
    <div className="rounded-2xl border overflow-hidden"
         style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
      <div className="px-6 py-5 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>AI Rewrite</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
            Tone rewriting in the Review Workspace · requires Anthropic API key in Vercel
          </p>
        </div>
        <Badge variant="warning">Setup needed</Badge>
      </div>
      <div className="px-6 pb-5 pt-4 border-t space-y-3" style={{ borderColor: 'var(--color-border)' }}>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)', lineHeight: 1.75 }}>
          The tone rewrite buttons in the Review Workspace call a serverless function at{' '}
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

// ── Planned settings ──────────────────────────────────────────────────────────

const PLANNED = [
  { title: 'Notification Preferences', desc: 'Choose which alerts to receive and how often.' },
  { title: 'Alert Thresholds',         desc: 'Set the rating drop or backlog size that triggers an alert.' },
  { title: 'Scraper Schedule',         desc: 'Configure how often locations are scraped.' },
  { title: 'Team Members',             desc: 'Add managers and control access per location.' },
  { title: 'Export Settings',          desc: 'Default format and delivery for executive reports.' },
]

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Settings() {
  return (
    <div className="space-y-10 max-w-[720px]">

      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Settings</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Integrations and configuration for Future Insights
        </p>
      </div>

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
          Google Integration
        </p>
        <GBPSection />
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
