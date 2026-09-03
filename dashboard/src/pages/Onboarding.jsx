import { useState } from 'react'
import { useAccount } from '../components/AuthGate.jsx'
import { useTenantStatus, useDiscoverLocations, useApproveLocations } from '../hooks/useTenantStatus.js'
import { useGoogleOAuthStatus, useConnectGoogle } from '../hooks/useGoogleOAuthStatus.js'
import Button from '../components/ui/Button.jsx'

// Multi-Tenant Phase 4J -- the guided Owner onboarding flow, rendered
// INSTEAD of the normal dashboard shell for any tenant not yet
// operationally 'active' (see AuthGate.jsx's gating, which mounts this
// component rather than <App/>). Every step below renders EXACTLY the
// backend's own tenant lifecycle status (useTenantStatus(), reading
// GET /api/session/tenant-status) -- there is no local/inferred "onboarding
// complete" state anywhere in this file. In particular: Google OAuth
// succeeding (gbpStatus.state === 'connected') is necessary to move past
// Step 1, but is NEVER treated as onboarding completion by itself -- the
// component keeps rendering discovery/approval/provisioning/sync steps
// for as long as tenantStatus.status says so, regardless of connection
// state.
//
// Provisioning and Initial Sync are NOT triggered from this UI at all --
// per Phase 4H.1's established architecture, those are dispatched by a
// human platform operator via .github/workflows/tenant-lifecycle.yml
// (confirmation-gated GitHub Actions), never by a tenant-facing control.
// This component's ENTIRE job during those two states is to poll and
// display status (useTenantStatus()'s refetchInterval) -- there is no
// "Retry" button that re-triggers anything server-side; "retryable" here
// means the failure is clearly explained and the user can re-check status
// on demand (a plain refetch), never a hidden self-service dispatcher.

const STEP_ORDER = ['connect', 'discover', 'approve', 'provisioning', 'initial_sync', 'ready']

function OnboardingShell({ activeStep, children }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 px-4" style={{ background: 'var(--color-bg)' }}>
      <div className="text-center">
        <img src="/pryor-os-black-cropped.svg" alt="Pryor OS" className="mx-auto w-[200px] max-w-[70vw] h-auto dark:hidden" />
        <img src="/pryor-os-white-cropped.svg" alt="Pryor OS" className="hidden mx-auto w-[200px] max-w-[70vw] h-auto dark:block" />
      </div>
      <div className="flex items-center gap-2">
        {STEP_ORDER.map((step, i) => (
          <div key={step}
               className="w-2 h-2 rounded-full transition-colors"
               style={{ background: STEP_ORDER.indexOf(activeStep) >= i ? 'var(--color-accent)' : 'var(--color-border, #e7e5e4)' }} />
        ))}
      </div>
      <div className="w-full max-w-md rounded-2xl border p-8 text-center"
           style={{ background: 'var(--color-surface, #fff)', borderColor: 'var(--color-border, #e7e5e4)' }}>
        {children}
      </div>
    </div>
  )
}

function StepTitle({ children }) {
  return <h1 className="text-lg font-semibold mb-2" style={{ color: 'var(--color-text-1)' }}>{children}</h1>
}

function StepBody({ children }) {
  return <p className="text-sm mb-6" style={{ color: 'var(--color-text-3)' }}>{children}</p>
}

function ErrorBanner({ message }) {
  if (!message) return null
  return (
    <div className="text-xs rounded-lg px-3 py-2 mb-4 text-left"
         style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}>
      {message}
    </div>
  )
}

function NotOwnerNotice() {
  return (
    <StepBody>
      Your account's administrator (Owner) needs to finish connecting Google Business Profile before
      this account is ready. Check back shortly, or ask your Owner for an update.
    </StepBody>
  )
}

// --- Step 1: Connect Google -------------------------------------------

function ConnectStep({ isOwner, gbpStatus, onConnect }) {
  return (
    <OnboardingShell activeStep="connect">
      <StepTitle>Connect your Google Business Profile</StepTitle>
      {isOwner ? (
        <>
          <StepBody>
            To get started, connect the Google account that manages your business locations on Google.
          </StepBody>
          {gbpStatus?.state === 'auth_failed' && <ErrorBanner message="Google authorization failed. Please try connecting again." />}
          {gbpStatus?.state === 'quota_blocked' && <ErrorBanner message="Google Business Profile access is temporarily unavailable for this account. Please try again shortly, or contact support." />}
          <Button variant="primary" className="w-full justify-center" onClick={onConnect}>
            Connect Google Business Profile
          </Button>
        </>
      ) : <NotOwnerNotice />}
    </OnboardingShell>
  )
}

// --- Steps 2-3: Discover + choose locations -----------------------------

function DiscoverApproveStep({ isOwner }) {
  const discoverMutation = useDiscoverLocations()
  const approveMutation = useApproveLocations()
  const [discovery, setDiscovery] = useState(null) // { discoverySessionId, expiresAt, locations }
  const [selected, setSelected] = useState(() => new Set())

  if (!isOwner) {
    return (
      <OnboardingShell activeStep="discover">
        <StepTitle>Almost there</StepTitle>
        <NotOwnerNotice />
      </OnboardingShell>
    )
  }

  const runDiscovery = () => {
    discoverMutation.mutate(undefined, {
      onSuccess: (data) => {
        setDiscovery(data)
        setSelected(new Set((data.locations ?? []).map(l => l.googleLocationId)))
      },
    })
  }

  // Step 2: nothing discovered yet.
  if (!discovery) {
    return (
      <OnboardingShell activeStep="discover">
        <StepTitle>Find your locations</StepTitle>
        <StepBody>We'll look up every Google Business Profile location this Google account manages.</StepBody>
        {discoverMutation.isError && <ErrorBanner message={discoverMutation.error?.message || 'Could not discover locations. Please try again.'} />}
        <Button variant="primary" className="w-full justify-center" onClick={runDiscovery} disabled={discoverMutation.isPending}>
          {discoverMutation.isPending ? 'Looking…' : 'Find my locations'}
        </Button>
      </OnboardingShell>
    )
  }

  // No locations discovered at all -- a distinct, actionable state, never
  // silently treated the same as a fetch error.
  if ((discovery.locations ?? []).length === 0) {
    return (
      <OnboardingShell activeStep="discover">
        <StepTitle>No locations found</StepTitle>
        <StepBody>
          We couldn't find any Google Business Profile locations on the connected Google account.
          Make sure you connected the account that actually manages your business locations, then try again.
        </StepBody>
        <Button variant="secondary" className="w-full justify-center" onClick={() => setDiscovery(null)}>Try again</Button>
      </OnboardingShell>
    )
  }

  // Step 3: choose which of the DISCOVERED locations to approve -- the
  // checkbox list is built ENTIRELY from discovery.locations; there is no
  // way to select anything this discovery call didn't itself return.
  const toggle = (googleLocationId) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(googleLocationId)) next.delete(googleLocationId); else next.add(googleLocationId)
      return next
    })
  }

  const submit = () => {
    approveMutation.mutate({ discoverySessionId: discovery.discoverySessionId, selectedGoogleLocationIds: [...selected] })
  }

  return (
    <OnboardingShell activeStep="approve">
      <StepTitle>Choose your locations</StepTitle>
      <StepBody>Select the locations you'd like PRYOR to manage.</StepBody>
      {approveMutation.isError && <ErrorBanner message={approveMutation.error?.message || 'Could not activate the selected locations. Please try again.'} />}
      <div className="text-left max-h-64 overflow-y-auto mb-4 border rounded-lg divide-y" style={{ borderColor: 'var(--color-border, #e7e5e4)' }}>
        {discovery.locations.map(loc => (
          <label key={loc.googleLocationId} className="flex items-start gap-2 px-3 py-2 text-sm cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={selected.has(loc.googleLocationId)} onChange={() => toggle(loc.googleLocationId)} />
            <span>
              <span className="block font-medium" style={{ color: 'var(--color-text-1)' }}>{loc.title || loc.googleLocationId}</span>
              {loc.address && <span className="block text-xs" style={{ color: 'var(--color-text-3)' }}>{loc.address}</span>}
            </span>
          </label>
        ))}
      </div>
      <Button variant="primary" className="w-full justify-center" onClick={submit} disabled={selected.size === 0 || approveMutation.isPending}>
        {approveMutation.isPending ? 'Activating…' : `Activate ${selected.size || ''} location${selected.size === 1 ? '' : 's'}`}
      </Button>
    </OnboardingShell>
  )
}

// --- Steps 4-5: provisioning / initial sync (status-only, never triggered) -

function WaitingStep({ step, title, message, onRefresh }) {
  return (
    <OnboardingShell activeStep={step}>
      <StepTitle>{title}</StepTitle>
      <StepBody>{message}</StepBody>
      <div className="flex items-center justify-center gap-2 mb-6">
        {[0, 1, 2].map(i => (
          <div key={i} className="w-1.5 h-1.5 rounded-full pulse-dot" style={{ background: 'var(--color-accent)', animationDelay: `${i * 0.25}s` }} />
        ))}
      </div>
      <Button variant="ghost" className="w-full justify-center" onClick={onRefresh}>Check again</Button>
    </OnboardingShell>
  )
}

// Phase 4L live-browser finding: this previously rendered tenantStatus's raw
// internal lastError string (e.g. a Blob/Google API exception message)
// straight to the tenant Owner -- a real usability/hygiene issue, not just
// unpolished copy, since that string was never written with an end user as
// its audience. `lastError` is still read (so a future need to branch on it
// is easy), just never interpolated into what the Owner sees.
function FailedStep({ step, title, lastError, onRefresh }) {
  void lastError
  return (
    <OnboardingShell activeStep={step}>
      <StepTitle>{title}</StepTitle>
      <ErrorBanner message="Something went wrong on our end." />
      <StepBody>Our team has been notified and will retry this shortly. You can check back here anytime.</StepBody>
      <Button variant="secondary" className="w-full justify-center" onClick={onRefresh}>Check again</Button>
    </OnboardingShell>
  )
}

function ReadyStep() {
  return (
    <OnboardingShell activeStep="ready">
      <StepTitle>You're all set!</StepTitle>
      <StepBody>Your account is ready. Taking you to your dashboard…</StepBody>
    </OnboardingShell>
  )
}

function SuspendedStep() {
  return (
    <OnboardingShell activeStep="ready">
      <StepTitle>Account suspended</StepTitle>
      <StepBody>This account has been suspended. Please contact support for help restoring access.</StepBody>
    </OnboardingShell>
  )
}

function LoadingStep() {
  return (
    <OnboardingShell activeStep="connect">
      <StepTitle>Loading your account…</StepTitle>
    </OnboardingShell>
  )
}

function TenantStatusUnavailableStep({ onRetry }) {
  return (
    <OnboardingShell activeStep="connect">
      <StepTitle>Couldn't load your account status</StepTitle>
      <StepBody>Please check your connection and try again.</StepBody>
      <Button variant="secondary" className="w-full justify-center" onClick={onRetry}>Try again</Button>
    </OnboardingShell>
  )
}

export default function Onboarding() {
  const account = useAccount()
  const isOwner = account?.role === 'owner'
  const { data: tenantStatus, isLoading, isError, refetch } = useTenantStatus()
  const { data: gbpStatus } = useGoogleOAuthStatus()
  const { connect } = useConnectGoogle()

  if (isLoading) return <LoadingStep />
  if (isError || !tenantStatus) return <TenantStatusUnavailableStep onRetry={refetch} />

  const status = tenantStatus.status

  if (status === 'suspended') return <SuspendedStep />
  if (status === 'active') return <ReadyStep />

  if (status === 'onboarding') {
    const isConnected = gbpStatus?.state === 'connected'
    if (!isConnected) return <ConnectStep isOwner={isOwner} gbpStatus={gbpStatus} onConnect={connect} />
    return <DiscoverApproveStep isOwner={isOwner} />
  }

  if (status === 'locations_approved') {
    return <WaitingStep step="provisioning" title="Setting up your account"
      message="Your locations are approved. We're setting up your account's storage now -- this usually only takes a few minutes." onRefresh={refetch} />
  }
  if (status === 'provisioning') {
    return <WaitingStep step="provisioning" title="Setting up your account"
      message="We're setting up your account's storage now -- this usually only takes a few minutes." onRefresh={refetch} />
  }
  if (status === 'provisioning_failed') {
    return <FailedStep step="provisioning" title="Setup couldn't complete" lastError={tenantStatus.provisioning?.lastError} onRefresh={refetch} />
  }
  if (status === 'provisioned') {
    return <WaitingStep step="initial_sync" title="Syncing your reviews"
      message="We're pulling in your reviews from Google now -- this usually only takes a few minutes." onRefresh={refetch} />
  }
  if (status === 'initial_sync') {
    return <WaitingStep step="initial_sync" title="Syncing your reviews"
      message="We're pulling in your reviews from Google now -- this usually only takes a few minutes." onRefresh={refetch} />
  }
  if (status === 'initial_sync_failed') {
    return <FailedStep step="initial_sync" title="Sync couldn't complete" lastError={tenantStatus.initialSync?.lastError} onRefresh={refetch} />
  }

  // Any other/unrecognized status -- fail closed to a generic waiting
  // state rather than guessing; never inferred as "active."
  return <WaitingStep step="connect" title="Checking your account" message="One moment…" onRefresh={refetch} />
}
