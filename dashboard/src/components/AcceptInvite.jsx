import { useEffect, useState } from 'react'

const MIN_PASSWORD_LENGTH = 10

const ROLE_LABELS = {
  owner: 'Owner', admin: 'Admin', marketing: 'Marketing',
  location_manager: 'Location Manager', read_only: 'Viewer',
}

// Public page, rendered by AuthGate.jsx OUTSIDE the normal login gate (a
// brand-new invitee has no session and must never be shown the sign-in
// form) -- reads ?token= from the URL, previews the invitation (non-
// consuming, GET /api/session/invite-status) so the invitee sees who/what
// they're joining before typing anything, then submits the real
// POST /api/session/accept-invite which sets the password and auto-logs
// in. On success this does a full page navigation (not a client-side
// route change) so AuthGate's normal whoami-based flow picks up the fresh
// session cookie from scratch -- the same "full reload after an auth state
// change" pattern LogoutButton.jsx already uses.
export default function AcceptInvite() {
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') || '')
  const [status, setStatus] = useState('loading') // loading | valid | invalid
  const [invite, setInvite] = useState(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!token) { setStatus('invalid'); return }
    let cancelled = false
    fetch(`/api/session/invite-status?token=${encodeURIComponent(token)}`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return
        if (data.valid) {
          setInvite(data)
          setStatus('valid')
        } else {
          setStatus('invalid')
        }
      })
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
      const res = await fetch('/api/session/accept-invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, name: name.trim() || undefined, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.message || 'Could not set up your account. Please try again.')
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
          <p className="text-sm text-center" style={{ color: 'var(--color-text-2)' }}>Checking your invitation…</p>
        )}

        {status === 'invalid' && (
          <div className="text-center space-y-2">
            <p className="text-sm font-semibold" style={{ color: 'var(--color-danger, #dc2626)' }}>
              This invitation link is invalid, expired, or has already been used.
            </p>
            <p className="text-xs" style={{ color: 'var(--color-text-2)' }}>
              Ask an Owner or Admin to send a new invitation.
            </p>
          </div>
        )}

        {status === 'valid' && done && (
          <p className="text-sm text-center font-semibold" style={{ color: 'var(--color-text-1)' }}>
            Account created — redirecting…
          </p>
        )}

        {status === 'valid' && !done && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="text-center space-y-1 pb-1">
              <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>
                You've been invited to Pryor OS
              </p>
              <p className="text-xs" style={{ color: 'var(--color-text-2)' }}>
                {invite?.email} · {ROLE_LABELS[invite?.role] ?? invite?.role}
              </p>
            </div>

            <div>
              <label className="text-xs font-semibold block mb-1.5" style={{ color: 'var(--color-text-2)' }}>
                Your name
              </label>
              <input
                type="text"
                autoComplete="name"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }}
              />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1.5" style={{ color: 'var(--color-text-2)' }}>
                Create password
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
                Confirm password
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
              {submitting ? 'Setting up your account…' : 'Create account'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
