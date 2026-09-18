import { useState } from 'react'
import Card from '../../components/ui/Card.jsx'
import Badge from '../../components/ui/Badge.jsx'
import Button from '../../components/ui/Button.jsx'
import Skeleton from '../../components/ui/Skeleton.jsx'
import ErrorState from '../../components/ui/ErrorState.jsx'
import EmptyState from '../../components/ui/EmptyState.jsx'
import { useToast } from '../../components/ui/Toast.jsx'
import { useAccount } from '../../components/AuthGate.jsx'
import { useBillingStatus, useCreateBillingPortalSession, useRedeemComplimentaryCode } from '../../hooks/useBilling.js'

// Billing settings page (Phase B.13.1) -- a read-only view over the existing
// owner-only GET /api/session/billing-status endpoint, plus a single
// "Manage Billing" action that opens the existing owner-only Stripe
// Customer Portal (POST /api/session/billing-portal-session). The Portal
// itself remains the sole authority for payment methods, invoices,
// cancel-at-period-end, and reactivation -- this page never adds a second,
// competing billing-mutation surface, and the server response this page
// reads from never contains a raw Stripe customer/subscription/payment-
// method id to begin with (see billing-status's own header), so there is
// nothing here to accidentally leak.

const PLAN_LABELS = { core: 'Core', growth: 'Growth', enterprise: 'Enterprise' }

function humanize(value) {
  if (typeof value !== 'string' || !value) return 'Unknown'
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ')
}

function humanizePlan(plan) {
  if (typeof plan !== 'string' || !plan) return 'Unknown'
  return PLAN_LABELS[plan] ?? humanize(plan)
}

const STATUS_LABELS = {
  trial: 'Trial', active: 'Active', past_due: 'Past Due', suspended: 'Suspended', canceled: 'Canceled',
  complimentary: 'Complimentary', complimentary_pending_activation: 'Complimentary (Reserved)',
}
const STATUS_BADGE_VARIANTS = {
  trial: 'info', active: 'success', past_due: 'warning', suspended: 'danger', canceled: 'neutral',
  complimentary: 'success', complimentary_pending_activation: 'info',
}

function humanizeStatus(status) {
  if (typeof status !== 'string' || !status) return 'Unknown'
  return STATUS_LABELS[status] ?? humanize(status)
}

function statusBadgeVariant(status) {
  return STATUS_BADGE_VARIANTS[status] ?? 'neutral'
}

function fmtDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

// Deterministic, non-locale-dependent price formatting (never
// toLocaleString(), which can vary by environment/currency settings and
// would make this text unstable to assert on) -- whole-dollar plan prices
// (the only kind PLANS currently defines) render without decimals; a
// malformed/non-finite value safely omits the price rather than crashing
// or rendering "NaN/month".
function fmtMonthlyPrice(priceCents) {
  if (typeof priceCents !== 'number' || !Number.isFinite(priceCents) || priceCents < 0) return null
  const dollars = priceCents / 100
  const amount = Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2)
  return `$${amount}/month`
}

// "Plan after trial" line text -- built ONLY from the server-provided
// planAfterTrial.name/priceCents (never a hardcoded plan/price pair, never
// derived from status.plan). A missing/malformed price degrades to just
// the plan name rather than omitting the whole line or crashing.
function formatPlanAfterTrial(planAfterTrial) {
  if (typeof planAfterTrial?.name !== 'string' || !planAfterTrial.name) return null
  const price = fmtMonthlyPrice(planAfterTrial.priceCents)
  return price ? `${planAfterTrial.name} — ${price}` : planAfterTrial.name
}

// Maps the portal-session endpoint's own error codes to owner-facing copy --
// never the raw server error/message, per this phase's explicit
// "don't expose raw error details" requirement.
function friendlyPortalError(code) {
  if (code === 'billing_not_ready') return 'Billing is not ready for this account yet.'
  if (code === 'portal_not_configured') return 'Billing management is temporarily unavailable. Please try again later.'
  return 'Unable to open billing management. Please try again.'
}

function BillingStatusCard({ status }) {
  const isTrial = status.commercialStatus === 'trial'
  const trialEndsAt = status.trialStatus === 'active' ? fmtDate(status.trialEndsAt) : null
  const cancellationEffectiveAt = status.cancellation != null ? fmtDate(status.cancellation.effectiveAt) : null
  const isStripeUnpaidTerminal = status.commercialStatus === 'suspended' && status.suspension?.reason === 'stripe_unpaid_terminal'

  // During a trial, `status.plan` is the EFFECTIVE feature-entitlement tier
  // (always Growth, per entitlementResolution.js -- unaffected by this UI
  // change), never what the tenant selected/will be billed for -- labeling
  // it "Current Plan" during trial is exactly the smoke-test-discovered
  // confusion this corrects. Once trialing ends, `status.plan` already
  // equals the real billed plan (unchanged), so the paid-state label and
  // meaning are untouched.
  const planRowLabel = isTrial ? 'Trial Access' : 'Current Plan'

  // "Plan after trial" is deliberately suppressed once a cancellation is
  // scheduled (even if the server still reports a planAfterTrial value) --
  // the subscription is ending, so presenting a future paid plan would
  // wrongly imply billing continues past the trial.
  const planAfterTrialText = isTrial && status.cancellation == null
    ? formatPlanAfterTrial(status.planAfterTrial)
    : null

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-medium" style={{ color: 'var(--color-text-3)' }}>{planRowLabel}</p>
          <p className="text-sm font-bold mt-0.5" style={{ color: 'var(--color-text-1)' }}>{humanizePlan(status.plan)}</p>
        </div>
        <Badge variant={statusBadgeVariant(status.commercialStatus)}>{humanizeStatus(status.commercialStatus)}</Badge>
      </div>

      {planAfterTrialText && (
        <div>
          <p className="text-[10px] font-medium" style={{ color: 'var(--color-text-3)' }}>Plan after trial</p>
          <p className="text-sm font-bold mt-0.5" style={{ color: 'var(--color-text-1)' }}>{planAfterTrialText}</p>
        </div>
      )}

      {trialEndsAt && (
        <p className="text-xs" style={{ color: 'var(--color-text-2)' }}>Trial ends {trialEndsAt}</p>
      )}

      {status.cancellation != null && (
        <div className="rounded-lg p-3" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
          <p className="text-xs font-bold" style={{ color: 'var(--color-text-1)' }}>Cancellation Scheduled</p>
          <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
            Your subscription is scheduled to end on {cancellationEffectiveAt ?? 'the end of the current period'}.
          </p>
        </div>
      )}

      {status.commercialStatus === 'past_due' && (
        <div className="rounded-lg p-3" style={{ background: 'var(--color-warning-bg)', border: '1px solid var(--color-border)' }}>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-1)' }}>
            We couldn't process your latest payment. Your account remains accessible while Stripe retries the payment.
          </p>
        </div>
      )}

      {status.commercialStatus === 'suspended' && (
        <div className="rounded-lg p-3" style={{ background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger-border)' }}>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-1)' }}>
            {isStripeUnpaidTerminal
              ? "Your subscription is suspended because payment could not be collected. Update your payment method and pay the outstanding balance to restore access."
              : 'Your account is suspended. Contact support.'}
          </p>
        </div>
      )}
    </Card>
  )
}

// Complimentary Restaurant Access Codes -- three additional, mutually
// exclusive states, deliberately kept as SEPARATE components from
// BillingStatusCard above rather than threading more branches into it: none
// of these states involve a Stripe subscription, a trial, or a cancellation
// at all, and keeping them separate means the existing, already-tested
// trial/active/past_due/suspended/canceled rendering above is byte-for-byte
// unmodified.

function ComplimentaryPendingCard({ complimentary }) {
  return (
    <Card className="p-6 space-y-2">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Complimentary Access Reserved</p>
        <Badge variant="info">{humanizePlan(complimentary.planId)}</Badge>
      </div>
      <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
        Your {complimentary.durationDays} days will begin after your restaurant completes its first successful data sync.
      </p>
    </Card>
  )
}

function ComplimentaryActiveCard({ complimentary }) {
  const endsAt = fmtDate(complimentary.endsAt)
  return (
    <Card className="p-6 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-medium" style={{ color: 'var(--color-text-3)' }}>Complimentary Access</p>
          <p className="text-sm font-bold mt-0.5" style={{ color: 'var(--color-text-1)' }}>{humanizePlan(complimentary.planId)}</p>
        </div>
        <Badge variant="success">Complimentary</Badge>
      </div>
      <ul className="text-xs space-y-1" style={{ color: 'var(--color-text-2)' }}>
        <li>{complimentary.maxLocations} location{complimentary.maxLocations === 1 ? '' : 's'}</li>
        <li>Up to {complimentary.maxUsers} user{complimentary.maxUsers === 1 ? '' : 's'}</li>
        <li>No credit card required</li>
      </ul>
      {endsAt && <p className="text-xs" style={{ color: 'var(--color-text-2)' }}>Ends: {endsAt}</p>}
    </Card>
  )
}

function ComplimentaryExpiredCard() {
  return (
    <Card className="p-6 space-y-2">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Complimentary Access Ended</p>
        <Badge variant="neutral">Ended</Badge>
      </div>
      <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
        Your complimentary access period has ended. Contact us to continue on a paid plan.
      </p>
    </Card>
  )
}

// "Have a complimentary access code?" -- the ONLY client input this whole
// feature ever accepts is the raw code string typed here. Shown only for a
// tenant that has never redeemed complimentary access at all (the parent
// component hides this once `status.complimentary` is non-null, i.e. once a
// grant exists in any state -- pending, active, or expired).
function ComplimentaryRedeemCard() {
  const toast = useToast()
  const [code, setCode] = useState('')
  const redeemMutation = useRedeemComplimentaryCode()

  const handleSubmit = (e) => {
    e.preventDefault()
    const trimmed = code.trim()
    if (!trimmed) return
    redeemMutation.mutate(trimmed, {
      onSuccess: (data) => {
        setCode('')
        const c = data?.complimentary
        if (c?.state === 'active') {
          toast(`Complimentary Access — ${humanizePlan(c.planId)}: ${c.durationDays} days complimentary, ${c.maxLocations} location${c.maxLocations === 1 ? '' : 's'}, up to ${c.maxUsers} users. No credit card required.`, { variant: 'success' })
        } else {
          toast('Complimentary access reserved — it will begin once your first data sync completes.', { variant: 'success' })
        }
      },
      onError: (err) => {
        toast(err?.message || 'Unable to redeem this code. Please try again.', { variant: 'error' })
      },
    })
  }

  return (
    <Card className="p-6 space-y-3">
      <div>
        <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Have a complimentary access code?</p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
          Enter your code below to unlock complimentary PRYOR access. No credit card required.
        </p>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="PRYOR-..."
          className="w-full rounded-lg border px-3 py-2 text-sm font-mono"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }}
          disabled={redeemMutation.isPending}
        />
        <Button type="submit" variant="primary" disabled={redeemMutation.isPending || !code.trim()}>
          {redeemMutation.isPending ? 'Redeeming…' : 'Redeem Code'}
        </Button>
      </form>
    </Card>
  )
}

function ManageBillingCard() {
  const toast = useToast()
  const portalMutation = useCreateBillingPortalSession()

  const handleManageBilling = () => {
    portalMutation.mutate(undefined, {
      onSuccess: (data) => {
        if (typeof data?.url === 'string' && data.url.length > 0) {
          window.location.assign(data.url)
        } else {
          toast('Unable to open billing management. Please try again.', { variant: 'error' })
        }
      },
      onError: (err) => {
        toast(friendlyPortalError(err?.code), { variant: 'error' })
      },
    })
  }

  return (
    <Card className="p-6 space-y-3">
      <div>
        <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Manage Billing</p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
          Update payment methods, view invoices, or manage your subscription securely through Stripe.
        </p>
      </div>
      <Button variant="primary" onClick={handleManageBilling} disabled={portalMutation.isPending}>
        {portalMutation.isPending ? 'Opening…' : 'Manage Billing'}
      </Button>
    </Card>
  )
}

// Complimentary provenance -- true for pending/active/expired complimentary
// states alike. Used to (a) pick which status card to render and (b) hide
// Manage Billing, which would otherwise lead nowhere for an account with no
// applicable Stripe billing relationship at all (complimentary access never
// creates one -- see complimentaryAccessStore.js's own header).
function isComplimentaryProvenance(status) {
  return status.commercialStatus === 'complimentary'
    || status.commercialStatus === 'complimentary_pending_activation'
    || (status.commercialStatus === 'suspended' && status.reason === 'complimentary_expired')
}

export default function Billing() {
  const account = useAccount()
  const isOwner = account?.role === 'owner'
  const { data: status, isLoading, isError, refetch } = useBillingStatus()

  const complimentaryProvenance = !isLoading && !isError && status ? isComplimentaryProvenance(status) : false
  // The redemption form is offered only to a tenant that has NEVER redeemed
  // complimentary access at all -- once a grant exists (pending, active, or
  // expired), `status.complimentary` is non-null and the form disappears in
  // favor of whichever status card above already explains that state.
  const canRedeem = !isLoading && !isError && status && status.complimentary == null

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Billing</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Manage your PRYOR subscription, payment methods, and invoices.
        </p>
      </div>

      {!isOwner ? (
        <EmptyState icon="🔒" title="Not available" body="This page is only available to the account owner." />
      ) : (
        <>
          {isLoading ? (
            <Card className="p-6 space-y-3">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </Card>
          ) : isError ? (
            <Card className="p-0 overflow-hidden">
              <ErrorState body="Couldn't load your billing status." onRetry={refetch} />
            </Card>
          ) : status.commercialStatus === 'complimentary_pending_activation' ? (
            <ComplimentaryPendingCard complimentary={status.complimentary} />
          ) : status.commercialStatus === 'complimentary' ? (
            <ComplimentaryActiveCard complimentary={status.complimentary} />
          ) : status.commercialStatus === 'suspended' && status.reason === 'complimentary_expired' ? (
            <ComplimentaryExpiredCard />
          ) : (
            <BillingStatusCard status={status} />
          )}

          {canRedeem && <ComplimentaryRedeemCard />}

          {/* Manage Billing is independent of the status query above -- it
              must stay usable even when billing-status fails to load, and
              even for a tenant with no subscription yet (the portal
              endpoint itself is the one authority for readiness, via its
              own billing_not_ready response -- never duplicated here).
              Hidden ONLY for complimentary provenance, which never has any
              applicable Stripe billing state to manage -- every other
              existing status's behavior here is unchanged. */}
          {!complimentaryProvenance && <ManageBillingCard />}
        </>
      )}
    </div>
  )
}
