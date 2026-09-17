import Card from '../../components/ui/Card.jsx'
import Badge from '../../components/ui/Badge.jsx'
import Button from '../../components/ui/Button.jsx'
import Skeleton from '../../components/ui/Skeleton.jsx'
import ErrorState from '../../components/ui/ErrorState.jsx'
import EmptyState from '../../components/ui/EmptyState.jsx'
import { useToast } from '../../components/ui/Toast.jsx'
import { useAccount } from '../../components/AuthGate.jsx'
import { useBillingStatus, useCreateBillingPortalSession } from '../../hooks/useBilling.js'

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
}
const STATUS_BADGE_VARIANTS = {
  trial: 'info', active: 'success', past_due: 'warning', suspended: 'danger', canceled: 'neutral',
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

// Maps the portal-session endpoint's own error codes to owner-facing copy --
// never the raw server error/message, per this phase's explicit
// "don't expose raw error details" requirement.
function friendlyPortalError(code) {
  if (code === 'billing_not_ready') return 'Billing is not ready for this account yet.'
  if (code === 'portal_not_configured') return 'Billing management is temporarily unavailable. Please try again later.'
  return 'Unable to open billing management. Please try again.'
}

function BillingStatusCard({ status }) {
  const trialEndsAt = status.trialStatus === 'active' ? fmtDate(status.trialEndsAt) : null
  const cancellationEffectiveAt = status.cancellation != null ? fmtDate(status.cancellation.effectiveAt) : null
  const isStripeUnpaidTerminal = status.commercialStatus === 'suspended' && status.suspension?.reason === 'stripe_unpaid_terminal'

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-medium" style={{ color: 'var(--color-text-3)' }}>Current Plan</p>
          <p className="text-sm font-bold mt-0.5" style={{ color: 'var(--color-text-1)' }}>{humanizePlan(status.plan)}</p>
        </div>
        <Badge variant={statusBadgeVariant(status.commercialStatus)}>{humanizeStatus(status.commercialStatus)}</Badge>
      </div>

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

export default function Billing() {
  const account = useAccount()
  const isOwner = account?.role === 'owner'
  const { data: status, isLoading, isError, refetch } = useBillingStatus()

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
          ) : (
            <BillingStatusCard status={status} />
          )}

          {/* Manage Billing is independent of the status query above -- it
              must stay usable even when billing-status fails to load, and
              even for a tenant with no subscription yet (the portal
              endpoint itself is the one authority for readiness, via its
              own billing_not_ready response -- never duplicated here). */}
          <ManageBillingCard />
        </>
      )}
    </div>
  )
}
