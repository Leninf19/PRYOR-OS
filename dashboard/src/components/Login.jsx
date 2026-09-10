import { useState } from 'react'

// Split-screen redesign (UI/UX only -- see README/commit message for the
// exact scope). Every network call, field name, status-code handling, and
// success/failure contract below is BYTE-IDENTICAL to the prior version:
// POST /api/session/login with { email, password }, onSuccess(data.account)
// on 200, the same three server-distinguishable outcomes surfaced as text
// (invalid_request / invalid_credentials / service_unavailable), and the
// same plain <a href="/forgot-password"> navigation. No "remember me" --
// the backend has never accepted that field (a 12h fixed session, no
// persistent-login concept), so no control for it is rendered; inventing
// one here would imply behavior that does not exist server-side.
//
// A disabled account and an unknown email are -- deliberately, by the
// server's own no-enumeration design (session/[action].js's login()) --
// INDISTINGUISHABLE from a wrong password. All three produce the exact
// same generic_credentials response. This component does not fabricate a
// separate "disabled account" message; doing so would either be wrong
// (most invalid_credentials responses are not a disabled account) or
// would require a new backend signal this pass is not authorized to add.
//
// No self-service signup and no access-code redemption exist yet (no
// /register or /access-code route) -- both links below render as inert,
// visually-prepared placeholders, never a live network call.
export default function Login({ onSuccess }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/session/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.message || 'Invalid email or password.')
        return
      }
      onSuccess(data.account)
    } catch {
      setError('Could not reach the server. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    // min-h-screen (100vh) as a fallback, min-h-[100dvh] on top for
    // browsers that support it -- keeps the Sign in button reachable above
    // an open mobile keyboard instead of pinned against a stale 100vh that
    // doesn't shrink with the visual viewport.
    <div className="min-h-screen min-h-[100dvh] flex" style={{ background: 'var(--color-bg)' }}>
      <div className="w-full lg:w-[40%] lg:min-w-[420px] flex flex-col justify-center px-6 sm:px-12 lg:px-16 py-12 relative overflow-y-auto">
        <div className="w-full max-w-sm mx-auto">
          <Brand />

          <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>
            Welcome back
          </h1>
          <p className="text-sm mb-8" style={{ color: 'var(--color-text-2)' }}>
            Sign in to your PRYOR workspace
          </p>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Field label="Email">
              <input
                type="email"
                required
                autoComplete="username"
                autoFocus
                value={email}
                onChange={e => setEmail(e.target.value)}
                disabled={submitting}
                className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none transition-colors focus:ring-2"
                style={{
                  background: 'var(--color-surface)',
                  borderColor: 'var(--color-border)',
                  color: 'var(--color-text-1)',
                  '--tw-ring-color': 'var(--color-accent-lt)',
                }}
              />
            </Field>

            <Field label="Password" trailing={<a href="/forgot-password" className="text-xs font-medium" style={{ color: 'var(--color-accent)' }}>Forgot password?</a>}>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  disabled={submitting}
                  className="w-full rounded-lg border pl-3.5 pr-10 py-2.5 text-sm outline-none transition-colors focus:ring-2"
                  style={{
                    background: 'var(--color-surface)',
                    borderColor: 'var(--color-border)',
                    color: 'var(--color-text-1)',
                    '--tw-ring-color': 'var(--color-accent-lt)',
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  tabIndex={-1}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-0 top-0 h-full w-10 flex items-center justify-center"
                  style={{ color: 'var(--color-text-3)' }}
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </Field>

            {error && (
              <div
                role="alert"
                className="rounded-lg border px-3.5 py-2.5 text-xs font-medium"
                style={{ background: 'var(--color-danger-bg)', borderColor: 'var(--color-danger-border)', color: 'var(--color-danger)' }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg py-2.5 text-sm font-semibold transition-opacity flex items-center justify-center gap-2"
              style={{ background: 'var(--color-text-1)', color: 'var(--color-bg)', opacity: submitting ? 0.7 : 1 }}
            >
              {submitting ? (
                <>
                  <span className="flex items-center gap-1">
                    {[0, 1, 2].map(i => (
                      <span key={i} className="w-1.5 h-1.5 rounded-full pulse-dot" style={{ background: 'var(--color-bg)', animationDelay: `${i * 0.2}s` }} />
                    ))}
                  </span>
                  Signing in
                </>
              ) : 'Sign in'}
            </button>
          </form>

          <div className="flex items-center gap-3 my-7">
            <div className="h-px flex-1" style={{ background: 'var(--color-border)' }} />
            <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--color-text-3)' }}>or</span>
            <div className="h-px flex-1" style={{ background: 'var(--color-border)' }} />
          </div>

          <div className="space-y-2.5">
            <EntryLink href="/register" label="New to PRYOR?" action="Create an account" />
            <EntryLink href="/access-code" label="Have an access code?" action="Enter code" />
          </div>
        </div>
      </div>

      <div className="hidden lg:block lg:w-[60%] relative overflow-hidden" style={{ background: 'linear-gradient(155deg, #17130F 0%, #1F1911 55%, #241C13 100%)' }}>
        <ProductPreview />
      </div>
    </div>
  )
}

function Brand() {
  return (
    <div>
      <img src="/pryor-os-black-cropped.svg" alt="Pryor OS" className="w-[148px] h-auto dark:hidden" />
      <img src="/pryor-os-white-cropped.svg" alt="Pryor OS" className="hidden w-[148px] h-auto dark:block" />
      <p className="text-[9px] font-bold tracking-[0.2em] uppercase mt-2" style={{ color: 'var(--color-text-3)' }}>
        By Future Marketing Studio
      </p>
    </div>
  )
}

function Field({ label, trailing, children }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <label className="text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>{label}</label>
        {trailing}
      </div>
      {children}
    </div>
  )
}

// Multi-Tenant Phase 4Q.1: /register and /access-code are now real,
// public (no-lta_session-required) routes -- see AuthGate.jsx's
// PUBLIC_PATHS. A plain <a> (full navigation), matching this file's own
// existing "Forgot password?" link exactly -- never a fabricated network
// call, never any auth/session behavior change here.
function EntryLink({ href, label, action }) {
  return (
    <a
      href={href}
      className="w-full rounded-lg border px-3.5 py-2.5 flex items-center justify-between text-xs transition-colors"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-2)' }}
    >
      <span style={{ color: 'var(--color-text-2)' }}>{label}</span>
      <span className="font-semibold" style={{ color: 'var(--color-accent)' }}>{action}</span>
    </a>
  )
}

function EyeIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l18 18" />
      <path d="M10.6 5.2A10.9 10.9 0 0 1 12 5c7 0 10.5 7 10.5 7a13.9 13.9 0 0 1-3.2 4.1M6.6 6.6C3.6 8.5 1.5 12 1.5 12S5 19 12 19a10.6 10.6 0 0 0 4.2-.85" />
      <path d="M9.5 9.6a3.2 3.2 0 0 0 4.5 4.4" />
    </svg>
  )
}

// Sanitized, entirely fictional product preview -- no real tenant, no real
// reviews, no real names/metrics of any kind. Purely decorative; renders
// no network request.
function ProductPreview() {
  const locations = [
    { name: 'Sunset Grill — Riverside', rating: 4.6, trend: '+0.2' },
    { name: 'The Copper Fork — Midtown', rating: 4.3, trend: '+0.1' },
    { name: 'Harbor House — Bayview', rating: 4.8, trend: '+0.4' },
  ]
  const reviews = [
    { author: 'A. Martinez', text: '“Fast reply from the manager and the fix actually stuck — noticeably better visit.”', stars: 5 },
    { author: 'J. Whitfield', text: '“Wait times down since the team started acting on the weekly digest.”', stars: 4 },
  ]

  return (
    <div className="absolute inset-0 flex items-center justify-center p-14">
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(60% 50% at 72% 28%, rgba(224,165,38,0.16), transparent 70%)',
        }}
      />

      <div className="relative w-full max-w-[520px]">
        <div
          className="rounded-2xl border shadow-2xl overflow-hidden"
          style={{ background: '#FBFAF8', borderColor: 'rgba(255,255,255,0.08)' }}
        >
          <div className="flex items-center justify-between px-5 py-3.5 border-b" style={{ borderColor: '#EDE8E1' }}>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ background: '#E0A526' }} />
              <span className="text-[13px] font-semibold" style={{ color: '#1A1714' }}>Network Overview</span>
            </div>
            <span className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: '#9C9590' }}>Last 30 days</span>
          </div>

          <div className="grid grid-cols-3 gap-px" style={{ background: '#EDE8E1' }}>
            {[
              { label: 'Avg. rating', value: '4.6' },
              { label: 'Response rate', value: '96%' },
              { label: 'Open items', value: '3' },
            ].map(stat => (
              <div key={stat.label} className="px-5 py-4" style={{ background: '#FBFAF8' }}>
                <div className="text-[20px] font-serif" style={{ color: '#1A1714' }}>{stat.value}</div>
                <div className="text-[10px] mt-0.5" style={{ color: '#9C9590' }}>{stat.label}</div>
              </div>
            ))}
          </div>

          <div className="px-5 py-4 space-y-3">
            {locations.map(loc => (
              <div key={loc.name} className="flex items-center justify-between">
                <span className="text-[12.5px]" style={{ color: '#413B34' }}>{loc.name}</span>
                <span className="flex items-center gap-2">
                  <span className="text-[12.5px] font-semibold" style={{ color: '#1A1714' }}>{loc.rating}★</span>
                  <span className="text-[10.5px] font-medium" style={{ color: '#9A6B00' }}>{loc.trend}</span>
                </span>
              </div>
            ))}
          </div>

          <div className="px-5 py-4 space-y-3 border-t" style={{ borderColor: '#EDE8E1' }}>
            {reviews.map(r => (
              <div key={r.author}>
                <p className="text-[12px] leading-relaxed" style={{ color: '#5A544C' }}>{r.text}</p>
                <p className="text-[10.5px] mt-1" style={{ color: '#9C9590' }}>{r.author} · {'★'.repeat(r.stars)}{'☆'.repeat(5 - r.stars)}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-8 text-center">
          <p className="font-serif text-[22px] leading-snug" style={{ color: '#F3EFE9' }}>
            See every location. Understand every review.<br />Act before problems repeat.
          </p>
          <p className="text-[13px] mt-3" style={{ color: '#B8AFA3' }}>
            Reputation and operations intelligence for restaurant groups.
          </p>
        </div>
      </div>

      <div
        className="absolute inset-y-0 left-0 w-24 pointer-events-none"
        style={{ background: 'linear-gradient(90deg, #17130F, transparent)' }}
      />
    </div>
  )
}
