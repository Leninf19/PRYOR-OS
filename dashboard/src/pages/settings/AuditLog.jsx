import { useState, useMemo } from 'react'
import Badge from '../../components/ui/Badge.jsx'
import Button from '../../components/ui/Button.jsx'
import Skeleton from '../../components/ui/Skeleton.jsx'
import EmptyState from '../../components/ui/EmptyState.jsx'
import ErrorState from '../../components/ui/ErrorState.jsx'
import { useAuditLog } from '../../hooks/useAuditLog.js'

const PAGE_SIZE = 40

const ENTITY_LABELS = {
  contact: 'Restaurant Contact',
  google_oauth: 'Google Business Profile',
  email: 'Email',
  account: 'Account',
}

function fmtWhen(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// Global, cross-entity Audit Log (Phase 8, Milestone 8.6) -- Owner-only,
// distinct from each Restaurant Contact's own embedded per-record history
// (visible more broadly, shown inline in Settings -> Restaurant Contacts).
// Read-only: this page never mutates anything.
export default function AuditLog() {
  const [entity, setEntity] = useState('')
  const [result, setResult] = useState('')
  const [page, setPage] = useState(0)

  const filters = useMemo(() => ({
    entity: entity || undefined,
    result: result || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  }), [entity, result, page])

  const { data, isLoading, isError, refetch } = useAuditLog(filters)
  const entries = data?.entries ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function updateEntity(value) { setEntity(value); setPage(0) }
  function updateResult(value) { setResult(value); setPage(0) }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Audit Log</h2>
        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
          Every operational change across Settings -- who, when, what changed, and from where.
        </p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={entity}
          onChange={e => updateEntity(e.target.value)}
          aria-label="Filter by entity"
          className="text-xs px-3 py-2 rounded-lg border focus:outline-none"
          style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
        >
          <option value="">All entities</option>
          <option value="contact">Restaurant Contacts</option>
          <option value="google_oauth">Google Business Profile</option>
          <option value="email">Email</option>
        </select>
        <select
          value={result}
          onChange={e => updateResult(e.target.value)}
          aria-label="Filter by result"
          className="text-xs px-3 py-2 rounded-lg border focus:outline-none"
          style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
        >
          <option value="">All results</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-10 w-full rounded-lg" />)}
        </div>
      ) : isError ? (
        <ErrorState body="Couldn't load the audit log." onRetry={refetch} />
      ) : entries.length === 0 ? (
        <EmptyState icon="🗒" title="No matching audit entries" body="Try a different filter, or check back after the next change is made." />
      ) : (
        <div className="card overflow-hidden">
          {/* Desktop: full table. Mobile: stacked cards -- same sm breakpoint
              and pattern RestaurantContacts.jsx/ReviewExplorer.jsx use
              (Phase 8, Milestone 8.11 hardening pass; this table was the one
              new Phase 8 table that hadn't yet gotten a mobile fallback). */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  {['When', 'Actor', 'Entity', 'Action', 'Result', 'Message', 'IP'].map(label => (
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
                {entries.map(e => (
                  <tr key={e.id} className="border-t align-top" style={{ borderColor: 'var(--color-border)' }}>
                    <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--color-text-3)' }}>{fmtWhen(e.at)}</td>
                    <td className="px-4 py-3" style={{ color: 'var(--color-text-1)' }}>{e.actorName || e.actorEmail || '—'}</td>
                    <td className="px-4 py-3" style={{ color: 'var(--color-text-2)' }}>{ENTITY_LABELS[e.entity] ?? e.entity}</td>
                    <td className="px-4 py-3 font-mono" style={{ color: 'var(--color-text-2)' }}>{e.action}</td>
                    <td className="px-4 py-3">
                      <Badge variant={e.result === 'success' ? 'success' : 'danger'}>{e.result}</Badge>
                    </td>
                    <td className="px-4 py-3 max-w-xs" style={{ color: 'var(--color-text-2)' }}>{e.message}</td>
                    <td className="px-4 py-3 font-mono" style={{ color: 'var(--color-text-3)' }}>{e.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="sm:hidden divide-y" style={{ borderColor: 'var(--color-border)' }}>
            {entries.map(e => (
              <div key={e.id} className="p-4 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-sm" style={{ color: 'var(--color-text-1)' }}>{e.actorName || e.actorEmail || '—'}</p>
                  <Badge variant={e.result === 'success' ? 'success' : 'danger'}>{e.result}</Badge>
                </div>
                <p style={{ color: 'var(--color-text-2)' }}>{ENTITY_LABELS[e.entity] ?? e.entity} · <span className="font-mono">{e.action}</span></p>
                {e.message && <p style={{ color: 'var(--color-text-2)' }}>{e.message}</p>}
                <p className="text-[11px]" style={{ color: 'var(--color-text-3)' }}>{fmtWhen(e.at)}{e.ip ? ` · ${e.ip}` : ''}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isLoading && !isError && totalPages > 1 && (
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>Prev</Button>
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>Page {page + 1} of {totalPages} ({total} total)</span>
          <Button variant="ghost" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>Next</Button>
        </div>
      )}
    </div>
  )
}
