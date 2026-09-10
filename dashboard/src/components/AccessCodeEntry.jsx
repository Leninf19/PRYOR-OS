import { useState } from 'react'
import AuthShell, { Field, ErrorBanner, PrimaryButton, LoadingDots } from './auth/AuthShell.jsx'

// Multi-Tenant Phase 4Q.1 -- POST /api/session/redeem-access-code. On
// success the server has already created the real tenant_config + user
// record and set the real lta_session cookie (see session/[action].js's
// createTenantForVerifiedRegistration()) -- this page does a full
// navigation to "/" so AuthGate.jsx re-evaluates the session fresh and
// naturally lands on the completely unmodified Onboarding.jsx (status:
// onboarding). No client-side session-state plumbing is needed or
// attempted here.
export default function AccessCodeEntry() {
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/session/redeem-access-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.message || 'This code is invalid or can no longer be used.')
        return
      }
      window.location.href = '/'
    } catch {
      setError('Could not reach the server. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell showPreview={false}>
      <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>Enter your access code</h1>
      <p className="text-sm mb-8" style={{ color: 'var(--color-text-2)' }}>e.g. LTA-ENT-7K4M9Q2X8P</p>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Field label="Access code">
          <input
            required autoComplete="off" autoCapitalize="characters" value={code}
            onChange={e => setCode(e.target.value)} disabled={submitting}
            className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none tracking-wide font-mono uppercase"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }}
          />
        </Field>

        <ErrorBanner>{error}</ErrorBanner>

        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? <LoadingDots label="Setting up your workspace" /> : 'Continue'}
        </PrimaryButton>
      </form>

      <p className="text-xs text-center mt-6" style={{ color: 'var(--color-text-3)' }}>
        No code? <a href="/pricing" className="font-semibold" style={{ color: 'var(--color-accent)' }}>See plans instead</a>
      </p>
    </AuthShell>
  )
}
