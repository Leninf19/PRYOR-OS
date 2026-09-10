import { useState } from 'react'
import AuthShell, { ErrorBanner, PrimaryButton } from './auth/AuthShell.jsx'

// Multi-Tenant Phase 4Q.1 -- POST /api/session/select-plan. Stubbed on the
// backend (paymentProvider.js) until Phase 4Q.2 wires real Stripe checkout
// -- this page must never claim success. Every plan click surfaces the
// SAME honest "checkout isn't available yet" message; no tenant is ever
// created from this page in 4Q.1.
const PLAN_DISPLAY = [
  { id: 'core', name: 'Core', price: '$149', period: '/mo' },
  { id: 'growth', name: 'Growth', price: '$349', period: '/mo' },
  { id: 'enterprise', name: 'Enterprise', price: 'Contact Sales', period: '' },
]

export default function Pricing() {
  const [message, setMessage] = useState(null)
  const [submittingPlan, setSubmittingPlan] = useState(null)

  async function choosePlan(planId) {
    if (planId === 'enterprise') {
      window.location.href = 'mailto:sales@futuremark.studio?subject=PRYOR%20Enterprise'
      return
    }
    setMessage(null)
    setSubmittingPlan(planId)
    try {
      const res = await fetch('/api/session/select-plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan: planId }),
      })
      const data = await res.json().catch(() => ({}))
      setMessage(data.message || 'Plan checkout isn\'t available yet. Use an access code, or contact sales.')
    } catch {
      setMessage('Could not reach the server. Please try again.')
    } finally {
      setSubmittingPlan(null)
    }
  }

  return (
    <AuthShell showPreview={false} maxWidth="max-w-2xl">
      <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>Choose a plan</h1>
      <p className="text-sm mb-8" style={{ color: 'var(--color-text-2)' }}>Reputation and operations intelligence for restaurant groups.</p>

      <ErrorBanner>{message}</ErrorBanner>

      <div className="grid sm:grid-cols-3 gap-4 mt-4">
        {PLAN_DISPLAY.map(plan => (
          <div key={plan.id} className="rounded-xl border p-5 flex flex-col" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
            <div className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>{plan.name}</div>
            <div className="font-serif text-2xl mt-2" style={{ color: 'var(--color-text-1)' }}>
              {plan.price}<span className="text-xs font-sans" style={{ color: 'var(--color-text-3)' }}>{plan.period}</span>
            </div>
            <div className="mt-4">
              <PrimaryButton type="button" disabled={submittingPlan === plan.id} onClick={() => choosePlan(plan.id)}>
                {plan.id === 'enterprise' ? 'Contact Sales' : 'Choose plan'}
              </PrimaryButton>
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-center mt-8" style={{ color: 'var(--color-text-3)' }}>
        Have an access code instead? <a href="/access-code" className="font-semibold" style={{ color: 'var(--color-accent)' }}>Enter it here</a>
      </p>
    </AuthShell>
  )
}
