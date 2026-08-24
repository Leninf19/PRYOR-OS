import { useState } from 'react'

// Public page (routed outside the login gate by AuthGate.jsx, same pattern
// as AcceptInvite.jsx) -- POSTs to /api/session/forgot-password, which
// always returns the same generic response regardless of whether the email
// exists (no-enumeration). This page mirrors that: it shows one message no
// matter what, never a distinguishable "email not found" state.
export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await fetch('/api/session/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
    } catch {
      // Deliberately ignored -- the confirmation message below is shown
      // regardless, matching the endpoint's own no-enumeration contract
      // (a network error here must not read differently than a real send).
    } finally {
      setSubmitting(false)
      setSubmitted(true)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 px-4"
         style={{ background: 'var(--color-bg)' }}>
      <div className="text-center">
        <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-2" style={{ color: 'var(--color-accent)' }}>
          Future Marketing Studio
        </p>
        <p className="text-lg font-bold" style={{ color: 'var(--color-text-1)' }}>
          Future Insights
        </p>
      </div>

      <div className="w-full max-w-sm rounded-2xl border p-6"
           style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
        {submitted ? (
          <div className="text-center space-y-2">
            <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>Check your email</p>
            <p className="text-xs" style={{ color: 'var(--color-text-2)' }}>
              If an account exists for {email}, a password reset link has been sent.
            </p>
            <a href="/" className="text-xs font-semibold inline-block mt-2" style={{ color: 'var(--color-accent)' }}>
              Back to sign in
            </a>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="text-center pb-1">
              <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>Reset your password</p>
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1.5" style={{ color: 'var(--color-text-2)' }}>
                Email
              </label>
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }}
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg border py-2 text-sm font-semibold transition-opacity"
              style={{ background: 'var(--color-accent)', borderColor: 'var(--color-accent)', color: 'white', opacity: submitting ? 0.6 : 1 }}>
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>
            <a href="/" className="text-xs font-semibold block text-center" style={{ color: 'var(--color-text-2)' }}>
              Back to sign in
            </a>
          </form>
        )}
      </div>
    </div>
  )
}
