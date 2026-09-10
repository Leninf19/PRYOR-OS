import { useEffect, useState } from 'react'
import AuthShell, { ErrorBanner, PrimaryButton } from './auth/AuthShell.jsx'

// Multi-Tenant Phase 4Q.1 -- reads ?token= from the URL, POSTs it to
// /api/session/verify-email exactly once on mount. Success sets the
// lta_pending_signup cookie server-side (this page never touches it
// directly) and redirects to /get-started.
export default function VerifyEmail() {
  const [state, setState] = useState('verifying') // 'verifying' | 'success' | 'error'
  const [error, setError] = useState(null)

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token')
    if (!token) {
      setState('error')
      setError('This verification link is missing its token.')
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/session/verify-email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        })
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          setState('error')
          setError(data.message || 'This verification link is invalid or has expired.')
          return
        }
        setState('success')
        window.location.href = '/get-started'
      } catch {
        if (!cancelled) {
          setState('error')
          setError('Could not reach the server. Please try again.')
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  return (
    <AuthShell showPreview={false}>
      <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>Verifying your email</h1>
      {state === 'verifying' && (
        <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>One moment…</p>
      )}
      {state === 'success' && (
        <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>Email verified — taking you to the next step…</p>
      )}
      {state === 'error' && (
        <>
          <ErrorBanner>{error}</ErrorBanner>
          <a href="/register" className="block mt-4">
            <PrimaryButton type="button">Register again</PrimaryButton>
          </a>
        </>
      )}
    </AuthShell>
  )
}
