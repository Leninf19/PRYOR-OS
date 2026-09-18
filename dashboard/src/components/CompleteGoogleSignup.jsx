import { useEffect, useState } from 'react'
import AuthShell, { Field, ErrorBanner, PrimaryButton, LoadingDots } from './auth/AuthShell.jsx'

// Google Sign-In (PRYOR login identity) -- the ONE small extra step a
// brand-new "Continue with Google" signup needs: Google's identity-only
// scope (openid email profile) never provides a company/restaurant name,
// which PRYOR requires to reserve a tenant id (see tenantIdGenerator.js).
// Reachable ONLY via the short-lived lta_google_signup_pending cookie set
// by session/[action].js's googleLoginCallback() -- never by navigating
// here directly with no prior Google auth (GET google-signup-status
// returns 401 in that case, handled below exactly like GetStarted.jsx's
// own 'error' state).
//
// On submit (POST google-signup-complete), the SAME lta_pending_signup
// cookie every email/password registrant gets after verifying their email
// is issued here too -- from that point on this Google-originated signup
// is indistinguishable from any other pending registration continuing into
// /get-started, /pricing, /access-code.
export default function CompleteGoogleSignup() {
  const [state, setState] = useState('loading') // 'loading' | 'ready' | 'error'
  const [identity, setIdentity] = useState(null)
  const [companyName, setCompanyName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/session/google-signup-status')
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          setState('error')
          return
        }
        setIdentity(data)
        setDisplayName(data.name || '')
        setState('ready')
      } catch {
        if (!cancelled) setState('error')
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/session/google-signup-complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ companyName, displayName }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.message || 'Something went wrong. Please try again.')
        return
      }
      // Full navigation, same convention as VerifyEmail.jsx's own
      // continuation to /get-started -- lets AuthGate/get-started pick up
      // the freshly-set lta_pending_signup cookie from scratch.
      window.location.href = '/get-started'
    } catch {
      setError('Could not reach the server. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (state === 'loading') {
    return (
      <AuthShell>
        <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>One moment…</h1>
      </AuthShell>
    )
  }

  if (state === 'error') {
    return (
      <AuthShell>
        <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>This link has expired</h1>
        <ErrorBanner>Please continue with Google again to finish creating your account.</ErrorBanner>
        <a href="/register" className="text-xs font-semibold block text-center mt-6" style={{ color: 'var(--color-accent)' }}>Back to sign up</a>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>Almost there</h1>
      <p className="text-sm mb-8" style={{ color: 'var(--color-text-2)' }}>
        {identity?.email} is verified. Just one more thing before your workspace is ready.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Field label="Your name">
          <input required autoComplete="name" value={displayName} onChange={e => setDisplayName(e.target.value)} disabled={submitting}
            className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
        </Field>
        <Field label="Company / restaurant group name">
          <input required autoFocus value={companyName} onChange={e => setCompanyName(e.target.value)} disabled={submitting}
            className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
        </Field>

        <ErrorBanner>{error}</ErrorBanner>

        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? <LoadingDots label="Setting up" /> : 'Continue'}
        </PrimaryButton>
      </form>
    </AuthShell>
  )
}
