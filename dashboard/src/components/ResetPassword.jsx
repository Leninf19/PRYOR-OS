import { useEffect, useState } from 'react'

const MIN_PASSWORD_LENGTH = 10

// Public page (routed outside the login gate, same pattern as
// AcceptInvite.jsx). Unlike AcceptInvite's preview, reset-status
// deliberately reveals only valid/invalid -- no email/role -- so this page
// never displays account identity before the password is set.
export default function ResetPassword() {
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') || '')
  const [status, setStatus] = useState('loading') // loading | valid | invalid
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!token) { setStatus('invalid'); return }
    let cancelled = false
    fetch(`/api/session/reset-status?token=${encodeURIComponent(token)}`)
      .then(res => res.json())
      .then(data => { if (!cancelled) setStatus(data.valid ? 'valid' : 'invalid') })
      .catch(() => { if (!cancelled) setStatus('invalid') })
    return () => { cancelled = true }
  }, [token])

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/session/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.message || 'Could not reset your password. Please try again.')
        return
      }
      setDone(true)
      window.setTimeout(() => { window.location.href = '/' }, 1200)
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
        <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-2" style={{ color: 'var(--color-accent)' }}>
          Future Marketing Studio
        </p>
        <img src="/pryor-os-black.svg" alt="Pryor OS" className="h-6 mx-auto mt-0.5" />
      </div>

      <div className="w-full max-w-sm rounded-2xl border p-6"
           style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>

        {status === 'loading' && (
          <p className="text-sm text-center" style={{ color: 'var(--color-text-2)' }}>Checking your reset link…</p>
        )}

        {status === 'invalid' && (
          <div className="text-center space-y-2">
            <p className="text-sm font-semibold" style={{ color: 'var(--color-danger, #dc2626)' }}>
              This reset link is invalid, expired, or has already been used.
            </p>
            <a href="/forgot-password" className="text-xs font-semibold inline-block mt-1" style={{ color: 'var(--color-accent)' }}>
              Request a new link
            </a>
          </div>
        )}

        {status === 'valid' && done && (
          <p className="text-sm text-center font-semibold" style={{ color: 'var(--color-text-1)' }}>
            Password updated — redirecting…
          </p>
        )}

        {status === 'valid' && !done && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="text-center pb-1">
              <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>Choose a new password</p>
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1.5" style={{ color: 'var(--color-text-2)' }}>
                New password
              </label>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }}
              />
              <p className="text-[11px] mt-1" style={{ color: 'var(--color-text-3, var(--color-text-2))' }}>
                At least {MIN_PASSWORD_LENGTH} characters.
              </p>
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1.5" style={{ color: 'var(--color-text-2)' }}>
                Confirm new password
              </label>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
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
              {submitting ? 'Updating…' : 'Update password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
