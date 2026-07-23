import Badge from '../../components/ui/Badge.jsx'
import Skeleton from '../../components/ui/Skeleton.jsx'
import ErrorState from '../../components/ui/ErrorState.jsx'
import { useEmailSystemStatus } from '../../hooks/useEmailSystemStatus.js'

// Email System settings page (Phase 8, Milestone 8.9) -- a read-only view
// over emailSender.js's own configuration check plus the audit log's
// `entity: 'email'` entries. "Send Test Email" lives on Settings ->
// Restaurant Contacts (it's a per-location action, scoped to a configured
// contact), not here -- this page is the aggregate, company-wide status.

function fmtWhen(iso) {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export default function EmailSystem() {
  const { data: status, isLoading, isError, refetch } = useEmailSystemStatus()

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border overflow-hidden"
           style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
        <div className="px-6 py-5 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Email System</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
              SMTP delivery status for restaurant escalation emails -- direct, synchronous send, no queue.
            </p>
          </div>
          {!isLoading && !isError && (
            <Badge variant={status?.configured ? 'success' : 'danger'}>
              {status?.configured ? '✅ Configured' : '⚠ Not Configured'}
            </Badge>
          )}
        </div>

        <div className="px-6 py-4 border-t" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-2)' }}>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          ) : isError ? (
            <ErrorState body="Couldn't load the email system status." onRetry={refetch} />
          ) : (
            <>
              {!status.configured && (
                <div className="mb-3 rounded-lg p-3" style={{ background: 'var(--color-danger-bg, rgba(220,38,38,0.06))', border: '1px solid var(--color-danger-border, rgba(220,38,38,0.2))' }}>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-1)', lineHeight: 1.7 }}>
                    SMTP_HOST, SMTP_USER, and SMTP_PASSWORD are not all set. Restaurant escalation emails and
                    Restaurant Contacts' "Send Test Email" will fail until these are configured as Vercel
                    environment variables.
                  </p>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  { label: 'Provider Host', value: status.host || '—' },
                  { label: 'Port', value: status.port ?? '—' },
                  { label: 'Authenticated', value: status.authenticated ? 'Yes' : 'No' },
                  { label: 'Delivery Model', value: status.queueMessage },
                  { label: 'Last Successful Send', value: fmtWhen(status.lastSuccessAt) },
                  { label: 'Last Failed Send', value: fmtWhen(status.lastFailureAt) },
                ].map(row => (
                  <div key={row.label}>
                    <p className="text-[10px] font-medium" style={{ color: 'var(--color-text-3)' }}>{row.label}</p>
                    <p className="text-xs font-mono mt-0.5 break-all" style={{ color: 'var(--color-text-1)' }}>{row.value}</p>
                  </div>
                ))}
              </div>
              {status.auditDegraded && (
                <p className="text-[11px] mt-3" style={{ color: 'var(--color-text-3)' }}>
                  The audit log is temporarily unavailable, so send history above may be incomplete.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {!isLoading && !isError && status.recentErrors?.length > 0 && (
        <div className="rounded-2xl border overflow-hidden"
             style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
          <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em]" style={{ color: 'var(--color-text-3)' }}>
              Recent Errors
            </p>
          </div>
          <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
            {status.recentErrors.map((err, i) => (
              <div key={i} className="px-6 py-3">
                <p className="text-xs" style={{ color: 'var(--color-text-1)' }}>{err.message}</p>
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--color-text-3)' }}>{fmtWhen(err.at)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
