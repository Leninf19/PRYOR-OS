import { useEffect, useState } from 'react'
import AuthShell, { ErrorBanner } from './auth/AuthShell.jsx'

// Phase B.11 -- Pricing UX + Stripe Setup-mode Checkout. This page now
// drives the FIRST real Stripe payment-method-collection path: choose a
// plan -> explicitly accept recurring-billing terms -> redirect to a
// Stripe-hosted Setup Checkout page that saves a card. No Subscription is
// created, no charge occurs, and no PRYOR trial starts here -- see
// session/[action].js's selectPlan()/stripeWebhookAction() for the full
// server-side contract. Growth's price is $249/month (dashboard/api/_lib/
// plans.js is the single source of truth this page's display values must
// keep matching -- the previous, stale display bug (a pre-Phase-B price
// left over from before the product's own pricing correction) is fixed).
//
// Phase B.11 pre-commit correction (Part 8) -- audited: no real, public
// Terms of Service / Privacy Policy page or URL exists anywhere in this
// codebase or its documentation today. The consent copy below therefore
// references them BY NAME ONLY, deliberately never as a clickable link to
// an invented/placeholder page -- linking to something that doesn't exist
// would be worse than not linking at all. This is an explicit
// PRE-PRODUCTION LAUNCH BLOCKER: real Terms of Service / Privacy Policy
// pages must exist and be linked here before this consent flow is
// considered production-ready. Not resolved in B.11 -- writing legal copy
// is out of scope for this phase.
//
// Email verification (Part Q) is enforced server-side regardless of what
// this page does -- get-started-status is fetched proactively purely so an
// unverified visitor sees an honest message immediately, matching
// GetStarted.jsx's own pattern, rather than only discovering the problem
// after filling out the consent step.

const PLAN_COPY = {
  core: {
    name: 'Core',
    price: '$149',
    tagline: 'Essential reputation management for individual restaurants and smaller groups.',
    features: [
      '1 location',
      'Up to 3 users',
      'Review monitoring',
      'Review replies',
      'AI reply rewriting',
      'Basic dashboard',
      'Review trends',
      'Bad-review alerts',
      'Basic tasks',
      'Email digest',
      '500 MB content storage',
      'Core AI allowance',
    ],
  },
  growth: {
    name: 'Growth',
    price: '$249',
    tagline: 'Advanced intelligence for multi-location restaurant operators.',
    badge: 'MOST POPULAR',
    features: [
      'Up to 5 locations',
      'Up to 10 users',
      'Everything in Core',
      'Live Executive Brief',
      'Advanced Intelligence',
      'Operations Impact',
      'Marketing Intelligence',
      'Advanced reporting',
      'Higher AI allowance',
      '1 GB content storage',
    ],
  },
}

const ENTERPRISE_FEATURES = [
  'Custom finite location/user limits',
  'Growth intelligence suite',
  'Multi-brand / regional configurations',
  'Custom reporting/support as available',
]

const ERROR_MESSAGES = {
  invalid_plan: 'Choose Core or Growth. Enterprise is available by contacting sales.',
  consent_required: 'Please confirm recurring billing to continue.',
  billing_not_configured: 'Plan checkout isn\'t available yet. Use an access code, or contact sales to get started.',
  checkout_creation_failed: 'Could not start checkout. Please try again.',
  invalid_state: 'This registration is not ready for plan selection. Please sign in or register again.',
  unauthenticated: 'Please verify your email to continue.',
}

function PlanCard({ planId, emphasized, onChoose, submittingPlan }) {
  const plan = PLAN_COPY[planId]
  return (
    <div
      className="relative rounded-2xl border p-6 flex flex-col"
      style={{
        borderColor: emphasized ? 'var(--color-accent)' : 'var(--color-border)',
        background: 'var(--color-surface)',
        boxShadow: emphasized ? '0 8px 28px -12px rgba(154,107,0,0.28)' : '0 1px 2px rgba(0,0,0,0.03)',
      }}
    >
      {plan.badge && (
        <span
          className="absolute -top-3 left-6 rounded-full px-3 py-1 text-[10px] font-bold tracking-[0.12em] uppercase"
          style={{ background: 'var(--color-accent)', color: '#FFFDF8' }}
        >
          {plan.badge}
        </span>
      )}
      <div className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>{plan.name}</div>
      <div className="font-serif text-3xl mt-2" style={{ color: 'var(--color-text-1)' }}>
        {plan.price}<span className="text-xs font-sans font-medium" style={{ color: 'var(--color-text-3)' }}> /mo</span>
      </div>
      <p className="text-xs mt-2.5 leading-relaxed" style={{ color: 'var(--color-text-2)' }}>{plan.tagline}</p>

      <ul className="mt-5 space-y-2 flex-1">
        {plan.features.map(feature => (
          <li key={feature} className="flex items-start gap-2 text-[12.5px]" style={{ color: 'var(--color-text-2)' }}>
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" className="mt-0.5 shrink-0" style={{ color: 'var(--color-accent)' }}>
              <path d="M4 10.5L8 14.5L16 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <button
        type="button"
        disabled={submittingPlan === planId}
        onClick={() => onChoose(planId)}
        className="w-full rounded-lg py-2.5 mt-6 text-sm font-semibold transition-opacity"
        style={
          emphasized
            ? { background: 'var(--color-accent)', color: '#FFFDF8', opacity: submittingPlan === planId ? 0.7 : 1 }
            : { background: 'var(--color-text-1)', color: 'var(--color-bg)', opacity: submittingPlan === planId ? 0.7 : 1 }
        }
      >
        {submittingPlan === planId ? 'One moment…' : 'Start 7-Day Trial'}
      </button>
    </div>
  )
}

function EnterpriseCard() {
  return (
    <div className="rounded-2xl border p-6 flex flex-col" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-2)' }}>
      <div className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>Enterprise</div>
      <div className="font-serif text-3xl mt-2" style={{ color: 'var(--color-text-1)' }}>Contact Sales</div>
      <p className="text-xs mt-2.5 leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
        For restaurant groups that need configuration beyond Growth's limits.
      </p>
      <ul className="mt-5 space-y-2 flex-1">
        {ENTERPRISE_FEATURES.map(feature => (
          <li key={feature} className="flex items-start gap-2 text-[12.5px]" style={{ color: 'var(--color-text-2)' }}>
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" className="mt-0.5 shrink-0" style={{ color: 'var(--color-text-3)' }}>
              <path d="M4 10.5L8 14.5L16 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <a
        href="mailto:sales@futuremark.studio?subject=PRYOR%20Enterprise"
        className="w-full rounded-lg py-2.5 mt-6 text-sm font-semibold text-center transition-opacity"
        style={{ background: 'var(--color-surface)', color: 'var(--color-text-1)', border: '1px solid var(--color-border-2)' }}
      >
        Contact Sales
      </a>
    </div>
  )
}

function ConsentPanel({ planId, accepted, onToggle, onCancel, onConfirm, submitting, error }) {
  const plan = PLAN_COPY[planId]
  return (
    <div className="rounded-2xl border p-6 mt-6" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
      <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>Confirm your trial</h2>
      <p className="text-xs mt-2 leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
        You're starting a 7-day Growth trial. After your trial, you'll continue on{' '}
        <strong style={{ color: 'var(--color-text-1)' }}>{plan.name} for {plan.price}/month</strong> unless you change or cancel before billing begins.
      </p>
      <p className="text-xs mt-2 leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
        Your 7-day trial begins after your restaurant is connected and your first sync completes.
      </p>
      <p className="text-xs mt-2 font-medium leading-relaxed" style={{ color: 'var(--color-text-1)' }}>
        Card required. You won't be charged when you enter your payment method.
      </p>

      <ErrorBanner>{error ? ERROR_MESSAGES[error] ?? 'Something went wrong. Please try again.' : null}</ErrorBanner>

      <label className="flex items-start gap-2.5 mt-4 cursor-pointer">
        <input
          type="checkbox"
          checked={accepted}
          onChange={e => onToggle(e.target.checked)}
          className="mt-0.5 w-4 h-4 shrink-0"
          style={{ accentColor: 'var(--color-accent)' }}
        />
        <span className="text-[11.5px] leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
          I agree that after my 7-day trial, PRYOR may automatically charge my saved payment method{' '}
          <strong style={{ color: 'var(--color-text-1)' }}>{plan.price}/month for {plan.name}</strong> until I cancel. I can cancel any time before
          billing begins at no charge. This agreement is subject to PRYOR's Terms of Service and Privacy Policy.
        </span>
      </label>

      <div className="flex gap-3 mt-5">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-lg py-2.5 px-4 text-sm font-semibold"
          style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)', border: '1px solid var(--color-border)' }}
        >
          Back
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!accepted || submitting}
          className="flex-1 rounded-lg py-2.5 text-sm font-semibold transition-opacity"
          style={{ background: 'var(--color-text-1)', color: 'var(--color-bg)', opacity: (!accepted || submitting) ? 0.5 : 1 }}
        >
          {submitting ? 'One moment…' : 'Start 7-Day Trial'}
        </button>
      </div>
    </div>
  )
}

export default function Pricing() {
  const [verifyState, setVerifyState] = useState('loading') // 'loading' | 'ready' | 'unverified'
  const [selectedPlan, setSelectedPlan] = useState(null) // 'core' | 'growth' | null
  const [consentAccepted, setConsentAccepted] = useState(false)
  const [submittingPlan, setSubmittingPlan] = useState(null)
  const [errorCode, setErrorCode] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/session/get-started-status')
        if (cancelled) return
        setVerifyState(res.ok ? 'ready' : 'unverified')
      } catch {
        if (!cancelled) setVerifyState('unverified')
      }
    })()
    return () => { cancelled = true }
  }, [])

  function choosePlan(planId) {
    setErrorCode(null)
    setConsentAccepted(false)
    setSelectedPlan(planId)
  }

  async function confirmTrial() {
    if (!consentAccepted || !selectedPlan) return
    setErrorCode(null)
    setSubmittingPlan(selectedPlan)
    try {
      const res = await fetch('/api/session/select-plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan: selectedPlan, recurringBillingAccepted: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErrorCode(data.error || 'checkout_creation_failed')
        setSubmittingPlan(null)
        return
      }
      window.location.href = data.checkoutUrl
    } catch {
      setErrorCode('checkout_creation_failed')
      setSubmittingPlan(null)
    }
  }

  if (verifyState === 'loading') {
    return (
      <AuthShell showPreview={false} maxWidth="max-w-2xl">
        <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>One moment…</h1>
      </AuthShell>
    )
  }

  if (verifyState === 'unverified') {
    return (
      <AuthShell showPreview={false} maxWidth="max-w-2xl">
        <h1 className="font-serif text-[26px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>Almost there</h1>
        <ErrorBanner>{ERROR_MESSAGES.unauthenticated}</ErrorBanner>
        <a href="/register" className="text-xs font-semibold block text-center mt-6" style={{ color: 'var(--color-accent)' }}>Register again</a>
      </AuthShell>
    )
  }

  return (
    <AuthShell showPreview={false} maxWidth="max-w-5xl">
      <h1 className="font-serif text-[28px] leading-tight mt-9 mb-1.5" style={{ color: 'var(--color-text-1)' }}>Choose a plan</h1>
      <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>Reputation and operations intelligence for restaurant groups.</p>
      <p className="text-xs mt-2" style={{ color: 'var(--color-text-3)' }}>
        Start with 7 days of Growth, on us. Your trial begins once your restaurant is connected and your first sync completes.
      </p>

      {!selectedPlan && (
        <div className="grid sm:grid-cols-3 gap-5 mt-8">
          <PlanCard planId="core" onChoose={choosePlan} submittingPlan={submittingPlan} />
          <PlanCard planId="growth" emphasized onChoose={choosePlan} submittingPlan={submittingPlan} />
          <EnterpriseCard />
        </div>
      )}

      {selectedPlan && (
        <ConsentPanel
          planId={selectedPlan}
          accepted={consentAccepted}
          onToggle={setConsentAccepted}
          onCancel={() => { setSelectedPlan(null); setErrorCode(null) }}
          onConfirm={confirmTrial}
          submitting={submittingPlan === selectedPlan}
          error={errorCode}
        />
      )}

      <p className="text-xs text-center mt-8" style={{ color: 'var(--color-text-3)' }}>
        Have an access code instead? <a href="/access-code" className="font-semibold" style={{ color: 'var(--color-accent)' }}>Enter it here</a>
      </p>
    </AuthShell>
  )
}
