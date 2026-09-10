import { useEffect, useState } from 'react'
import AuthShell, { ErrorBanner } from './auth/AuthShell.jsx'

// Multi-Tenant Phase 4Q.1 -- reads GET /api/session/get-started-status
// (the lta_pending_signup cookie is sent automatically; never read
// client-side). Presents the two commercial/onboarding-eligibility paths
// only -- neither directly grants any backend privilege; both eventually
// call the SAME tenant-creation transaction server-side.
export default function GetStarted() {
  const [state, setState] = useState('loading') // 'loading' | 'ready' | 'error'
  const [info, setInfo] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/session/get-started-status')
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          setState('error')
          return
        }
        setInfo(data)
        setState('ready')
      } catch {
        if (!cancelled) setState('error')
      }
    })()
    return () => { cancelled = true }
  }, [])

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
        <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>Session expired</h1>
        <ErrorBanner>Please verify your email again to continue.</ErrorBanner>
        <a href="/register" className="text-xs font-semibold block text-center mt-6" style={{ color: 'var(--color-accent)' }}>Register again</a>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>
        Welcome, {info.companyName}
      </h1>
      <p className="text-sm mb-8" style={{ color: 'var(--color-text-2)' }}>
        Your email is verified. Choose how you'd like to get started.
      </p>

      <div className="space-y-3">
        <a href="/pricing" className="block rounded-lg border px-5 py-4 transition-colors"
           style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
          <div className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>Choose a Plan</div>
          <div className="text-xs mt-1" style={{ color: 'var(--color-text-2)' }}>Core, Growth, or Enterprise</div>
        </a>
        <a href="/access-code" className="block rounded-lg border px-5 py-4 transition-colors"
           style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
          <div className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>Enter Access Code</div>
          <div className="text-xs mt-1" style={{ color: 'var(--color-text-2)' }}>Have a code from PRYOR? Redeem it here</div>
        </a>
      </div>
    </AuthShell>
  )
}
