import Badge from '../../components/ui/Badge.jsx'
import Skeleton from '../../components/ui/Skeleton.jsx'
import EmptyState from '../../components/ui/EmptyState.jsx'
import ErrorState from '../../components/ui/ErrorState.jsx'
import { useAccount } from '../../components/AuthGate.jsx'
import { useTenantOpsList } from '../../hooks/useTenantOps.js'

// Multi-Tenant Phase 4H.1 -- super-admin-only, READ-ONLY tenant lifecycle
// status page. Deliberately has NO dispatch button: mutating a tenant's
// state (provisioning, Initial Sync, retry) happens exclusively through
// the confirmation-gated GitHub Actions workflow
// (.github/workflows/tenant-lifecycle.yml) a human operator runs directly
// -- see that workflow's own header for why a long-lived dashboard-to-
// GitHub token is deliberately not introduced in this phase. This page
// exists only so an operator can see current state before deciding what
// to dispatch there, and to link straight to that workflow's dispatch form.
//
// AUTHORIZATION: server-side (isSuperAdmin(), dashboard/api/_lib/auth.js)
// is the real boundary -- this component's own `account` check below is a
// presentation nicety (avoids a flash of "Loading…" before the 403 lands
// for a caller who can never see this page), never the enforcement. A
// tenant-scoped Owner (a real future Tenant B, say) gets a 403 from the
// API exactly like any other unauthorized caller, regardless of what this
// component renders.
//
// STATE ELIGIBILITY: `eligibility.canProvision`/`canInitialSync` on each
// row are informational only, mirrored from initial_sync.py's/
// provision_tenant.py's own precondition sets server-side (see
// dashboard/api/tenant-ops/[action].js's own comment on why a drift here
// is a UX bug, not a security bug) -- the Python scripts re-validate every
// precondition themselves regardless of what this page shows.

const TENANT_LIFECYCLE_WORKFLOW_URL = 'https://github.com/Leninf19/PRYOR-OS/actions/workflows/tenant-lifecycle.yml'

const STATUS_VARIANT = {
  onboarding: 'neutral',
  locations_approved: 'neutral',
  provisioning: 'info',
  provisioning_failed: 'danger',
  provisioned: 'info',
  initial_sync: 'info',
  initial_sync_failed: 'danger',
  active: 'success',
  suspended: 'danger',
}

function fmtWhen(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function StatusBadge({ status }) {
  return <Badge variant={STATUS_VARIANT[status] ?? 'neutral'}>{status ?? 'unknown'}</Badge>
}

function EligibilityCell({ eligible, label }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs" style={{ color: eligible ? 'var(--color-success)' : 'var(--color-text-3)' }}>
      <span aria-hidden="true">{eligible ? '✓' : '—'}</span> {label}
    </span>
  )
}

function TenantRow({ tenant }) {
  return (
    <tr>
      <td className="px-4 py-2.5 align-top">
        <div className="font-semibold" style={{ color: 'var(--color-text-1)' }}>{tenant.displayName}</div>
        <div className="font-mono text-[0.6875rem]" style={{ color: 'var(--color-text-3)' }}>{tenant.tenantId}</div>
      </td>
      <td className="px-4 py-2.5 align-top"><StatusBadge status={tenant.status} /></td>
      <td className="px-4 py-2.5 align-top text-xs" style={{ color: 'var(--color-text-2)' }}>{tenant.storageMode}</td>
      <td className="px-4 py-2.5 align-top text-xs text-center" style={{ color: 'var(--color-text-2)' }}>{tenant.approvedLocationCount}</td>
      <td className="px-4 py-2.5 align-top">
        <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>{tenant.provisioning.status}</div>
        <div className="text-[0.6875rem]" style={{ color: 'var(--color-text-3)' }}>{fmtWhen(tenant.provisioning.lastAttemptAt)}</div>
      </td>
      <td className="px-4 py-2.5 align-top">
        <div className="text-xs" style={{ color: 'var(--color-text-2)' }}>{tenant.initialSync.status}</div>
        <div className="text-[0.6875rem]" style={{ color: 'var(--color-text-3)' }}>
          start {fmtWhen(tenant.initialSync.startedAt)}<br />
          done {fmtWhen(tenant.initialSync.completedAt)}<br />
          {tenant.initialSync.failedAt && <>failed {fmtWhen(tenant.initialSync.failedAt)}</>}
        </div>
      </td>
      <td className="px-4 py-2.5 align-top text-xs text-center" style={{ color: 'var(--color-text-2)' }}>{tenant.initialSync.reviewCount ?? '—'}</td>
      <td className="px-4 py-2.5 align-top text-xs text-center" style={{ color: 'var(--color-text-2)' }}>{tenant.initialSync.locationCount ?? '—'}</td>
      <td className="px-4 py-2.5 align-top font-mono text-[0.6875rem]" style={{ color: 'var(--color-text-3)' }}>{tenant.provisioning.artifactGeneration ?? '—'}</td>
      <td className="px-4 py-2.5 align-top text-xs" style={{ color: tenant.initialSync.lastError ? 'var(--color-danger)' : 'var(--color-text-3)' }}>
        {tenant.initialSync.lastError ?? '—'}
      </td>
      <td className="px-4 py-2.5 align-top text-xs text-center">
        {tenant.hasGoogleCredential === null ? '—' : tenant.hasGoogleCredential ? '✓' : '✕'}
      </td>
      <td className="px-4 py-2.5 align-top">
        <EligibilityCell eligible={tenant.eligibility.canProvision} label="Provision" /><br />
        <EligibilityCell eligible={tenant.eligibility.canInitialSync} label="Initial sync" />
      </td>
    </tr>
  )
}

const COLUMNS = [
  'Tenant', 'Status', 'Storage', 'Locations', 'Provisioning', 'Initial Sync',
  'Reviews', 'Synced Locations', 'Artifact Gen.', 'Last Error', 'Google Cred.', 'Next Op.',
]

export default function TenantOperations() {
  const account = useAccount()
  const isLikelySuperAdmin = account?.role === 'owner' && account?.tenantId === 't_los-tres-amigos'
  const { data: tenants, isLoading, isError, error, refetch } = useTenantOpsList({ enabled: isLikelySuperAdmin })

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Tenant Operations</h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
            Read-only lifecycle status for every tenant. Provisioning and Initial Sync are run from a dedicated,
            confirmation-gated GitHub Actions workflow, not from this page.
          </p>
        </div>
        <a href={TENANT_LIFECYCLE_WORKFLOW_URL} target="_blank" rel="noreferrer" className="btn btn-secondary text-xs">
          Open tenant-lifecycle workflow ↗
        </a>
      </div>

      {!isLikelySuperAdmin ? (
        <EmptyState icon="🔒" title="Not available" body="This page is only available to the platform operator." />
      ) : isLoading ? (
        <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full rounded-lg" />)}</div>
      ) : isError ? (
        <ErrorState body={error?.message ?? "Couldn't load tenant operations."} onRetry={refetch} />
      ) : (tenants ?? []).length === 0 ? (
        <EmptyState icon="🏢" title="No tenants yet" body="No tenant_config records exist." />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  {COLUMNS.map(label => (
                    <th key={label} className="px-4 py-2.5 text-left"
                        style={{ background: 'var(--color-surface-2)', borderBottom: '1px solid var(--color-border)',
                                 color: 'var(--color-text-2)', fontSize: '0.6875rem', fontWeight: 600, letterSpacing: '0.05em',
                                 textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tenants.map(tenant => <TenantRow key={tenant.tenantId} tenant={tenant} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
