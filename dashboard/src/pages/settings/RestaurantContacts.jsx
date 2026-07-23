import { useState, useMemo } from 'react'
import Badge from '../../components/ui/Badge.jsx'
import Button from '../../components/ui/Button.jsx'
import Skeleton from '../../components/ui/Skeleton.jsx'
import EmptyState from '../../components/ui/EmptyState.jsx'
import ErrorState from '../../components/ui/ErrorState.jsx'
import ConfirmDialog from '../../components/ui/ConfirmDialog.jsx'
import { useToast } from '../../components/ui/Toast.jsx'
import { useMeta } from '../../hooks/useIntelligence.js'
import { useRestaurantContacts, useDeleteContact, useToggleContactActive } from '../../hooks/useRestaurantContacts.js'
import ContactEditorModal from './ContactEditorModal.jsx'

const PAGE_SIZE = 40

// Sortable column header -- same hand-rolled pattern ReviewExplorer.jsx's
// own Th uses (no shared table component exists yet in this app).
function Th({ label, sortKey, active, dir, onSort, className = '' }) {
  return (
    <th
      className={`px-4 py-2.5 text-left ${className}`}
      style={{ background: 'var(--color-surface-2)', borderBottom: '1px solid var(--color-border)',
               color: 'var(--color-text-2)', fontSize: '0.6875rem', fontWeight: 600, letterSpacing: '0.05em',
               textTransform: 'uppercase', whiteSpace: 'nowrap', cursor: sortKey ? 'pointer' : 'default',
               userSelect: 'none' }}
      onClick={() => sortKey && onSort(sortKey)}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}{active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )
}

function fmtWhen(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// Restaurant Contacts management page (Phase 8, Milestone 8.4) -- the
// dashboard-editable replacement for the old edit-reviews.db ->
// export_chunks.py -> commit -> deploy cycle. Every location from meta.json
// gets a row, whether or not it has a configured contact yet -- an
// unconfigured location shows a "Configure Contact" prompt inline (per the
// spec's "do NOT simply show Restaurant email not configured" requirement)
// rather than being hidden from the table.
export default function RestaurantContacts() {
  const showToast = useToast()
  const { data: meta, isLoading: metaLoading, isError: metaError, refetch: refetchMeta } = useMeta()
  const { data: contacts, isLoading: contactsLoading, isError: contactsError, refetch: refetchContacts } = useRestaurantContacts()
  const deleteMutation = useDeleteContact()
  const toggleActiveMutation = useToggleContactActive()

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all') // all | configured | not_configured | disabled
  const [sortKey, setSortKey] = useState('locationName')
  const [sortDir, setSortDir] = useState('asc')
  const [page, setPage] = useState(0)
  const [editorState, setEditorState] = useState(null) // { locationId, locationName, initialContact } | null
  const [deleteTarget, setDeleteTarget] = useState(null) // { locationId, locationName } | null

  const isLoading = metaLoading || contactsLoading
  const isError = metaError || contactsError

  const rows = useMemo(() => {
    const locations = meta?.locations ?? []
    return locations.map(loc => {
      const contact = contacts?.[String(loc.locationId)] ?? null
      return {
        locationId: loc.locationId,
        locationName: loc.name,
        managerName: contact?.managerName ?? null,
        primaryEmail: contact?.primaryEmail ?? null,
        ccEmails: contact?.ccEmails ?? [],
        active: contact?.active ?? null, // null = not configured at all
        updatedAt: contact?.updatedAt ?? null,
        updatedBy: contact?.updatedBy ?? null,
        history: contact?.history ?? [],
      }
    })
  }, [meta, contacts])

  const toggleSort = (key) => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
    setPage(0)
  }

  const processed = useMemo(() => {
    const kw = search.trim().toLowerCase()
    let out = rows.filter(r => {
      if (statusFilter === 'configured' && r.active === null) return false
      if (statusFilter === 'not_configured' && r.active !== null) return false
      if (statusFilter === 'disabled' && r.active !== false) return false
      if (!kw) return true
      return [r.locationName, r.managerName, r.primaryEmail].some(v => v?.toLowerCase().includes(kw))
    })
    out.sort((a, b) => {
      const av = a[sortKey] ?? ''
      const bv = b[sortKey] ?? ''
      const cmp = String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return out
  }, [rows, search, statusFilter, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(processed.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const visible = processed.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  function openAdd(row) {
    setEditorState({ locationId: row.locationId, locationName: row.locationName, initialContact: null })
  }
  function openEdit(row) {
    setEditorState({
      locationId: row.locationId,
      locationName: row.locationName,
      initialContact: { managerName: row.managerName, primaryEmail: row.primaryEmail, ccEmails: row.ccEmails },
    })
  }

  async function handleToggleActive(row) {
    try {
      await toggleActiveMutation.mutateAsync({ locationId: row.locationId, active: !row.active })
      showToast(row.active ? `${row.locationName} contact disabled` : `${row.locationName} contact enabled`, { variant: 'success' })
    } catch (err) {
      showToast(err.message || 'Could not update this contact', { variant: 'error' })
    }
  }

  async function handleConfirmDelete() {
    try {
      await deleteMutation.mutateAsync({ locationId: deleteTarget.locationId })
      showToast(`${deleteTarget.locationName} contact removed`, { variant: 'success' })
    } catch (err) {
      showToast(err.message || 'Could not remove this contact', { variant: 'error' })
    } finally {
      setDeleteTarget(null)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}
      </div>
    )
  }

  if (isError) {
    return <ErrorState body="Couldn't load restaurant contacts." onRetry={() => { refetchMeta(); refetchContacts() }} />
  }

  if (rows.length === 0) {
    return <EmptyState icon="📇" title="No locations found" body="Location data isn't available yet." />
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Restaurant Contacts</h2>
        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
          Who receives the bad-review email escalation for each location. Changes here take effect immediately -- no export, commit, or deploy needed.
        </p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0) }}
          placeholder="Search location, manager, or email…"
          aria-label="Search restaurant contacts"
          className="text-xs px-3 py-2 rounded-lg border focus:outline-none flex-1 min-w-[220px]"
          style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
        />
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(0) }}
          aria-label="Filter by status"
          className="text-xs px-3 py-2 rounded-lg border focus:outline-none"
          style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
        >
          <option value="all">All statuses</option>
          <option value="configured">Configured</option>
          <option value="not_configured">Not Configured</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>

      <div className="card overflow-hidden">
        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <Th label="Location" sortKey="locationName" active={sortKey === 'locationName'} dir={sortDir} onSort={toggleSort} />
                <Th label="Manager" sortKey="managerName" active={sortKey === 'managerName'} dir={sortDir} onSort={toggleSort} />
                <Th label="Primary Email" sortKey="primaryEmail" active={sortKey === 'primaryEmail'} dir={sortDir} onSort={toggleSort} />
                <Th label="CC Emails" />
                <Th label="Status" />
                <Th label="Last Updated" sortKey="updatedAt" active={sortKey === 'updatedAt'} dir={sortDir} onSort={toggleSort} />
                <Th label="Updated By" />
                <Th label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visible.map(row => (
                <tr key={row.locationId} className="border-t" style={{ borderColor: 'var(--color-border)' }}>
                  <td className="px-4 py-3 font-medium" style={{ color: 'var(--color-text-1)' }}>{row.locationName}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--color-text-2)' }}>{row.managerName ?? '—'}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--color-text-2)' }}>{row.primaryEmail ?? '—'}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--color-text-2)' }}>{row.ccEmails.length > 0 ? row.ccEmails.join(', ') : '—'}</td>
                  <td className="px-4 py-3">
                    {row.active === null
                      ? <Badge variant="warning">⚠ Not Configured</Badge>
                      : row.active
                        ? <Badge variant="success">Active</Badge>
                        : <Badge variant="neutral">Disabled</Badge>}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--color-text-3)' }}>{fmtWhen(row.updatedAt)}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--color-text-3)' }}>{row.updatedBy ?? '—'}</td>
                  <td className="px-4 py-3">
                    {row.active === null ? (
                      <Button variant="primary" onClick={() => openAdd(row)}>Configure Contact</Button>
                    ) : (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Button variant="ghost" onClick={() => openEdit(row)}>Edit</Button>
                        <Button variant="ghost" onClick={() => handleToggleActive(row)}>{row.active ? 'Disable' : 'Enable'}</Button>
                        <Button variant="ghost" onClick={() => setDeleteTarget({ locationId: row.locationId, locationName: row.locationName })}>Delete</Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: stacked cards instead of a cramped table, same breakpoint ReviewExplorer.jsx uses */}
        <div className="sm:hidden divide-y" style={{ borderColor: 'var(--color-border)' }}>
          {visible.map(row => (
            <div key={row.locationId} className="p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-sm" style={{ color: 'var(--color-text-1)' }}>{row.locationName}</p>
                {row.active === null
                  ? <Badge variant="warning">⚠ Not Configured</Badge>
                  : row.active
                    ? <Badge variant="success">Active</Badge>
                    : <Badge variant="neutral">Disabled</Badge>}
              </div>
              {row.active !== null && (
                <>
                  <p style={{ color: 'var(--color-text-2)' }}>{row.managerName ?? '—'} · {row.primaryEmail}</p>
                  {row.ccEmails.length > 0 && <p style={{ color: 'var(--color-text-3)' }}>CC: {row.ccEmails.join(', ')}</p>}
                  <p className="text-[11px]" style={{ color: 'var(--color-text-3)' }}>Updated {fmtWhen(row.updatedAt)} by {row.updatedBy ?? '—'}</p>
                </>
              )}
              <div className="flex items-center gap-1.5 flex-wrap pt-1">
                {row.active === null ? (
                  <Button variant="primary" onClick={() => openAdd(row)}>Configure Contact</Button>
                ) : (
                  <>
                    <Button variant="ghost" onClick={() => openEdit(row)}>Edit</Button>
                    <Button variant="ghost" onClick={() => handleToggleActive(row)}>{row.active ? 'Disable' : 'Enable'}</Button>
                    <Button variant="ghost" onClick={() => setDeleteTarget({ locationId: row.locationId, locationName: row.locationName })}>Delete</Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {processed.length === 0 && (
          <EmptyState icon="🔍" title="No matching locations" body="Try a different search term or status filter." />
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}>Prev</Button>
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>Page {safePage + 1} of {totalPages}</span>
          <Button variant="ghost" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}>Next</Button>
        </div>
      )}

      {editorState && (
        <ContactEditorModal
          open={Boolean(editorState)}
          onClose={() => setEditorState(null)}
          locationId={editorState.locationId}
          locationName={editorState.locationName}
          initialContact={editorState.initialContact}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
        title="Delete Restaurant Contact"
        body={deleteTarget ? `Remove the contact for ${deleteTarget.locationName}? This cannot be undone -- you'll need to add it again from scratch.` : ''}
        confirmLabel="Delete"
        danger
        busy={deleteMutation.isPending}
      />
    </div>
  )
}
