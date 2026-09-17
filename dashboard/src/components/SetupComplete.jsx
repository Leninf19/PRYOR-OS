import { useEffect, useState } from 'react'
import AuthShell, { ErrorBanner } from './auth/AuthShell.jsx'

// Phase B.11 pre-commit correction (Part 1) -- the page Stripe redirects
// the browser to after Setup Checkout (success_url, built server-side in
// billingCustomer.js's createSetupCheckoutSession()). The browser's mere
// arrival here is NOT proof of anything -- this page's only job is to
// call POST /api/session/finalize-registration, which independently
// verifies billing readiness server-side (the already-verified Stripe
// webhook's own defaultPaymentMethodId) before ever creating a real
// tenant/Owner/session. If the webhook hasn't landed yet (billing_not_ready),
// this polls with a short, bounded retry rather than failing immediately
// or retrying forever.
const ERROR_MESSAGES = {
  already_completed: 'This registration has already been completed. Please sign in.',
  invalid_state: 'This registration is not ready to finalize. Please start over.',
  creation_in_progress: 'Your workspace is already being created. Please wait a moment and try again.',
  email_occupied: 'An account for this email already exists. Please sign in instead.',
  not_found: 'This registration is no longer available. Please register again.',
  service_unavailable: 'This is temporarily unavailable. Please try again shortly.',
  checkout_creation_failed: 'Something went wrong finishing your setup. Please try again.',
}

const MAX_ATTEMPTS = 5
const RETRY_DELAY_MS = 2000

export default function SetupComplete() {
  const [state, setState] = useState('finalizing') // 'finalizing' | 'error'
  const [errorCode, setErrorCode] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let res, data
      try {
        res = await fetch('/api/session/finalize-registration', { method: 'POST' })
        data = await res.json().catch(() => ({}))
      } catch {
        if (!cancelled) { setErrorCode('checkout_creation_failed'); setState('error') }
        return
      }
      if (cancelled) return
      if (res.ok) {
        // The server has already issued the real session cookie -- a full
        // navigation lets AuthGate.jsx re-evaluate it fresh, exactly like
        // AccessCodeEntry.jsx's own success path.
        window.location.href = '/'
        return
      }
      if (data.error === 'billing_not_ready' && attempt < MAX_ATTEMPTS - 1) {
        setTimeout(() => { if (!cancelled) setAttempt(a => a + 1) }, RETRY_DELAY_MS)
        return
      }
      setErrorCode(data.error || 'checkout_creation_failed')
      setState('error')
    })()
    return () => { cancelled = true }
  }, [attempt])

  function retryNow() {
    setState('finalizing')
    setErrorCode(null)
    setAttempt(a => a + 1)
  }

  if (state === 'error') {
    return (
      <AuthShell showPreview={false} maxWidth="max-w-2xl">
        <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>One more step</h1>
        <ErrorBanner>{ERROR_MESSAGES[errorCode] ?? 'Something went wrong finishing your setup. Please try again.'}</ErrorBanner>
        <button
          type="button" onClick={retryNow}
          className="w-full rounded-lg py-2.5 mt-4 text-sm font-semibold"
          style={{ background: 'var(--color-text-1)', color: 'var(--color-bg)' }}
        >
          Try again
        </button>
        <p className="text-xs text-center mt-6" style={{ color: 'var(--color-text-3)' }}>
          <a href="/pricing" className="font-semibold" style={{ color: 'var(--color-accent)' }}>Back to plans</a>
        </p>
      </AuthShell>
    )
  }

  return (
    <AuthShell showPreview={false} maxWidth="max-w-2xl">
      <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>Setting up your workspace…</h1>
      <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>Confirming your payment method. This only takes a moment.</p>
    </AuthShell>
  )
}
