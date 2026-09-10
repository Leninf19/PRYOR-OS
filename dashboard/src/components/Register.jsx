import { useState } from 'react'
import AuthShell, { Field, ErrorBanner, SuccessBanner, PrimaryButton, LoadingDots } from './auth/AuthShell.jsx'

// Multi-Tenant Phase 4Q.1 -- POST /api/session/register. Always shows the
// SAME success message regardless of what the server actually did
// (existing account, existing pending registration, or genuinely new) --
// the server itself is no-enumeration by design (see session/[action].js's
// register()), and this page must not undo that by, say, showing a
// different message on a client-side "email looks taken" guess.
export default function Register() {
  const [form, setForm] = useState({ email: '', password: '', passwordConfirmation: '', displayName: '', companyName: '' })
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  function set(field) {
    return e => setForm(f => ({ ...f, [field]: e.target.value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    if (form.password !== form.passwordConfirmation) {
      setError('Passwords do not match.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/session/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.message || 'Something went wrong. Please try again.')
        return
      }
      setSubmitted(true)
    } catch {
      setError('Could not reach the server. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <AuthShell>
        <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>Check your email</h1>
        <p className="text-sm mb-6" style={{ color: 'var(--color-text-2)' }}>
          If that email is available, we've sent a link to verify your address and continue setting up your workspace.
        </p>
        <SuccessBanner>Didn't get it? Check spam, or try again in a few minutes.</SuccessBanner>
        <a href="/" className="text-xs font-semibold block text-center mt-6" style={{ color: 'var(--color-accent)' }}>Back to sign in</a>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>Create your workspace</h1>
      <p className="text-sm mb-8" style={{ color: 'var(--color-text-2)' }}>Register now to get started with PRYOR</p>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Field label="Your name">
          <input required autoComplete="name" value={form.displayName} onChange={set('displayName')} disabled={submitting}
            className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
        </Field>
        <Field label="Company / restaurant group name">
          <input required value={form.companyName} onChange={set('companyName')} disabled={submitting}
            className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
        </Field>
        <Field label="Email">
          <input type="email" required autoComplete="username" value={form.email} onChange={set('email')} disabled={submitting}
            className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
        </Field>
        <Field label="Password">
          <input type="password" required autoComplete="new-password" minLength={10} value={form.password} onChange={set('password')} disabled={submitting}
            className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
        </Field>
        <Field label="Confirm password">
          <input type="password" required autoComplete="new-password" minLength={10} value={form.passwordConfirmation} onChange={set('passwordConfirmation')} disabled={submitting}
            className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
        </Field>

        <ErrorBanner>{error}</ErrorBanner>

        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? <LoadingDots label="Creating account" /> : 'Create account'}
        </PrimaryButton>
      </form>

      <p className="text-xs text-center mt-6" style={{ color: 'var(--color-text-3)' }}>
        Already have an account? <a href="/" className="font-semibold" style={{ color: 'var(--color-accent)' }}>Sign in</a>
      </p>
    </AuthShell>
  )
}
