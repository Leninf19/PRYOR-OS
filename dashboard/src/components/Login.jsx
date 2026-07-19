import { useState } from 'react'

// Deliberately minimal: no self-service signup, no password reset link, no
// "remember me" -- Phase 1's account directory is 3 Owner accounts added by
// hand (see README). Failure message is always the same generic text
// regardless of whether the email doesn't exist or the password is wrong,
// matching the server's no-enumeration behavior.
export default function Login({ onSuccess }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 px-4"
         style={{ background: 'var(--color-bg)' }}>
      <div className="text-center">
        <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-2"
           style={{ color: 'var(--color-accent)' }}>
          Future Marketing Studio
        </p>
        <p className="text-lg font-bold" style={{ color: 'var(--color-text-1)' }}>
          Future Insights
        </p>
      </div>

      <form onSubmit={handleSubmit}
            className="w-full max-w-sm rounded-2xl border p-6 space-y-4"
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
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
        <div>
          <label className="text-xs font-semibold block mb-1.5" style={{ color: 'var(--color-text-2)' }}>
            Password
          </label>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-sm"
            style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }}
          />
        </div>

        {error && (
          <p className="text-xs" style={{ color: 'var(--color-danger, #dc2626)' }}>{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg border py-2 text-sm font-semibold transition-opacity"
          style={{ background: 'var(--color-accent)', borderColor: 'var(--color-accent)', color: 'white', opacity: submitting ? 0.6 : 1 }}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
