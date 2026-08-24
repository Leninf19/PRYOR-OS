import { useMemo, useState } from 'react'
import Badge from '../../components/ui/Badge.jsx'
import Button from '../../components/ui/Button.jsx'
import Modal from '../../components/ui/Modal.jsx'
import Skeleton from '../../components/ui/Skeleton.jsx'
import EmptyState from '../../components/ui/EmptyState.jsx'
import ErrorState from '../../components/ui/ErrorState.jsx'
import { useToast } from '../../components/ui/Toast.jsx'
import { useAccount } from '../../components/AuthGate.jsx'
import { useMeta } from '../../hooks/useIntelligence.js'
import {
  useUsersList, useInviteUser, useResendInvite, useRevokeInvite, useGenerateResetLink,
  useUpdateUserRoleLocations, useDisableUser, useEnableUser,
} from '../../hooks/useUsers.js'

const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', marketing: 'Marketing', location_manager: 'Location Manager', read_only: 'Viewer' }
const ROLE_OPTIONS = ['admin', 'marketing', 'location_manager', 'read_only'] // 'owner' added conditionally, see below
const STATUS_VARIANT = { active: 'success', invited: 'warning', disabled: 'neutral', revoked: 'danger', expired: 'danger' }
const STATUS_LABEL = { active: 'Active', invited: 'Pending', disabled: 'Disabled', revoked: 'Revoked', expired: 'Expired' }

function fmtWhen(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function locationsLabel(locationIds, allLocations) {
  if (locationIds === '*') return 'All locations'
  if (!Array.isArray(locationIds) || locationIds.length === 0) return '—'
  const byId = new Map((allLocations ?? []).map(l => [l.locationId, l.name]))
  return locationIds.map(id => byId.get(id) ?? `#${id}`).join(', ')
}

// ── User form (Invite / Edit Role & Locations) ───────────────────────────────

function UserFormModal({ open, onClose, mode, user, allLocations, actingRole, onSaved }) {
  const [name, setName] = useState(user?.displayName ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [role, setRole] = useState(user?.role ?? 'location_manager')
  const [companyWide, setCompanyWide] = useState(user ? user.locationIds === '*' : false)
  const [selectedLocations, setSelectedLocations] = useState(
    user && Array.isArray(user.locationIds) ? user.locationIds : []
  )
  const [error, setError] = useState(null)
  const [inviteResult, setInviteResult] = useState(null)
  const invite = useInviteUser()
  const update = useUpdateUserRoleLocations()
  const toast = useToast()

  const roleRequiresCompanyWide = role === 'owner' || role === 'admin'
  const effectiveLocationIds = roleRequiresCompanyWide || companyWide ? '*' : selectedLocations

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    if (!roleRequiresCompanyWide && !companyWide && selectedLocations.length === 0) {
      setError('Select at least one location, or choose "All locations."')
      return
    }
    try {
      if (mode === 'invite') {
        const result = await invite.mutateAsync({ name, email, role, locationIds: effectiveLocationIds })
        setInviteResult(result)
        toast(result.emailWarning ? 'Invitation created — email could not be sent, share the link manually.' : 'Invitation sent.', { variant: result.emailWarning ? 'info' : 'success' })
      } else {
        await update.mutateAsync({ userId: user.userId, role, locationIds: effectiveLocationIds })
        toast('Updated.', { variant: 'success' })
        onSaved?.()
        onClose()
      }
    } catch (err) {
      setError(err.message)
    }
  }

  const saving = invite.isPending || update.isPending

  return (
    <Modal open={open} onClose={onClose} title={mode === 'invite' ? 'Invite User' : `Edit ${user?.displayName ?? user?.email}`} size="md">
      {inviteResult ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: 'var(--color-text-1)' }}>
            Invitation created for <strong>{email}</strong>.
          </p>
          <div>
            <label className="text-xs font-semibold block mb-1.5" style={{ color: 'var(--color-text-2)' }}>Invitation link</label>
            <div className="flex gap-2">
              <input readOnly value={inviteResult.inviteUrl}
                     className="flex-1 rounded-lg border px-3 py-2 text-xs font-mono"
                     style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }}
                     onFocus={e => e.target.select()} />
              <Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(inviteResult.inviteUrl); toast('Copied.', { variant: 'success' }) }}>
                Copy
              </Button>
            </div>
            {inviteResult.emailWarning && (
              <p className="text-xs mt-2" style={{ color: 'var(--color-warning)' }}>{inviteResult.emailWarning}</p>
            )}
          </div>
          <div className="flex justify-end">
            <Button onClick={() => { onSaved?.(); onClose() }}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'invite' && (
            <>
              <div>
                <label className="text-xs font-semibold block mb-1.5" style={{ color: 'var(--color-text-2)' }}>Name</label>
                <input required value={name} onChange={e => setName(e.target.value)}
                       className="w-full rounded-lg border px-3 py-2 text-sm"
                       style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
              </div>
              <div>
                <label className="text-xs font-semibold block mb-1.5" style={{ color: 'var(--color-text-2)' }}>Email</label>
                <input required type="email" value={email} onChange={e => setEmail(e.target.value)}
                       className="w-full rounded-lg border px-3 py-2 text-sm"
                       style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }} />
              </div>
            </>
          )}

          <div>
            <label className="text-xs font-semibold block mb-1.5" style={{ color: 'var(--color-text-2)' }}>Role</label>
            <select value={role} onChange={e => setRole(e.target.value)}
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                    style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }}>
              {actingRole === 'owner' && <option value="owner">Owner</option>}
              {ROLE_OPTIONS.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
            {role === 'owner' && actingRole !== 'owner' && (
              <p className="text-xs mt-1" style={{ color: 'var(--color-danger)' }}>Only an Owner can assign the Owner role.</p>
            )}
          </div>

          {!roleRequiresCompanyWide && (
            <div>
              <label className="text-xs font-semibold block mb-1.5" style={{ color: 'var(--color-text-2)' }}>Locations</label>
              <label className="flex items-center gap-2 text-xs mb-2" style={{ color: 'var(--color-text-2)' }}>
                <input type="checkbox" checked={companyWide} onChange={e => setCompanyWide(e.target.checked)} />
                All locations
              </label>
              {!companyWide && (
                <div className="max-h-40 overflow-y-auto rounded-lg border p-2 space-y-1" style={{ borderColor: 'var(--color-border)' }}>
                  {(allLocations ?? []).map(loc => (
                    <label key={loc.locationId} className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-1)' }}>
                      <input
                        type="checkbox"
                        checked={selectedLocations.includes(loc.locationId)}
                        onChange={e => setSelectedLocations(sel =>
                          e.target.checked ? [...sel, loc.locationId] : sel.filter(id => id !== loc.locationId)
                        )}
                      />
                      {loc.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {error && <p className="text-xs" style={{ color: 'var(--color-danger)' }}>{error}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : mode === 'invite' ? 'Send Invitation' : 'Save'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function UsersAccess() {
  const account = useAccount()
  const { data: users, isLoading, isError, refetch } = useUsersList()
  const { data: meta } = useMeta()
  const [formState, setFormState] = useState(null) // { mode, user } | null
  const [linkFor, setLinkFor] = useState(null) // { userId, url, warning } | null
  const toast = useToast()

  const resend = useResendInvite()
  const revoke = useRevokeInvite()
  const generateReset = useGenerateResetLink()
  const disable = useDisableUser()
  const enable = useEnableUser()

  const activeOwnerCount = useMemo(
    () => (users ?? []).filter(u => u.role === 'owner' && u.status !== 'disabled').length,
    [users]
  )

  async function handleResend(user) {
    try {
      const result = await resend.mutateAsync(user.userId)
      toast(result.emailWarning ? 'New link created — share it manually.' : 'Invitation re-sent.', { variant: result.emailWarning ? 'info' : 'success' })
      if (result.emailWarning) setLinkFor({ userId: user.userId, url: result.inviteUrl, warning: result.emailWarning })
    } catch (err) { toast(err.message, { variant: 'error' }) }
  }
  async function handleRevoke(user) {
    if (!window.confirm(`Revoke the invitation for ${user.email}?`)) return
    try {
      await revoke.mutateAsync(user.userId)
      toast('Invitation revoked.', { variant: 'success' })
    } catch (err) { toast(err.message, { variant: 'error' }) }
  }
  async function handleGenerateReset(user) {
    try {
      const result = await generateReset.mutateAsync(user.userId)
      toast(result.emailWarning ? 'Reset link created — share it manually.' : 'Reset link emailed.', { variant: result.emailWarning ? 'info' : 'success' })
      setLinkFor({ userId: user.userId, url: result.resetUrl, warning: result.emailWarning })
    } catch (err) { toast(err.message, { variant: 'error' }) }
  }
  async function handleDisable(user) {
    if (!window.confirm(`Disable ${user.email}? They will be signed out immediately.`)) return
    try {
      await disable.mutateAsync(user.userId)
      toast('Account disabled.', { variant: 'success' })
    } catch (err) { toast(err.message, { variant: 'error' }) }
  }
  async function handleEnable(user) {
    try {
      await enable.mutateAsync(user.userId)
      toast('Account re-enabled.', { variant: 'success' })
    } catch (err) { toast(err.message, { variant: 'error' }) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Users & Access</h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
            Invite users, assign roles and locations, and manage access. New accounts create their own password — you'll never see it.
          </p>
        </div>
        <Button onClick={() => setFormState({ mode: 'invite' })}>Invite User</Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full rounded-lg" />)}</div>
      ) : isError ? (
        <ErrorState body="Couldn't load users." onRetry={refetch} />
      ) : (users ?? []).length === 0 ? (
        <EmptyState icon="👤" title="No users yet" body="Invite your first user to get started." />
      ) : (
        <div className="card overflow-hidden">
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  {['Name', 'Email', 'Role', 'Locations', 'Status', 'Last Login', ''].map(label => (
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
                {users.map(u => {
                  const isLastActiveOwner = u.role === 'owner' && u.status !== 'disabled' && activeOwnerCount <= 1
                  return (
                    <tr key={u.userId} className="border-t align-top" style={{ borderColor: 'var(--color-border)' }}>
                      <td className="px-4 py-3" style={{ color: 'var(--color-text-1)' }}>{u.displayName}</td>
                      <td className="px-4 py-3" style={{ color: 'var(--color-text-2)' }}>{u.email}</td>
                      <td className="px-4 py-3" style={{ color: 'var(--color-text-2)' }}>{ROLE_LABELS[u.role] ?? u.role}</td>
                      <td className="px-4 py-3 max-w-xs" style={{ color: 'var(--color-text-2)' }}>{locationsLabel(u.locationIds, meta?.locations)}</td>
                      <td className="px-4 py-3"><Badge variant={STATUS_VARIANT[u.status] ?? 'neutral'}>{STATUS_LABEL[u.status] ?? u.status}</Badge></td>
                      <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--color-text-3)' }}>{fmtWhen(u.lastLoginAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 flex-wrap justify-end">
                          {u.status === 'invited' && (
                            <>
                              <Button variant="ghost" onClick={() => handleResend(u)}>Resend</Button>
                              <Button variant="ghost" onClick={() => handleRevoke(u)}>Revoke</Button>
                            </>
                          )}
                          {u.status === 'active' && (
                            <>
                              <Button variant="ghost" onClick={() => setFormState({ mode: 'edit', user: u })} disabled={isLastActiveOwner && account?.role !== 'owner'}>Edit</Button>
                              <Button variant="ghost" onClick={() => handleGenerateReset(u)}>Reset Link</Button>
                              <Button variant="ghost" onClick={() => handleDisable(u)} disabled={isLastActiveOwner}
                                      title={isLastActiveOwner ? 'Cannot disable the last active Owner' : undefined}>
                                Disable
                              </Button>
                            </>
                          )}
                          {u.status === 'disabled' && (
                            <Button variant="ghost" onClick={() => handleEnable(u)}>Enable</Button>
                          )}
                          {(u.status === 'revoked' || u.status === 'expired') && (
                            <Button variant="ghost" onClick={() => handleResend(u)}>Re-invite</Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="sm:hidden divide-y" style={{ borderColor: 'var(--color-border)' }}>
            {users.map(u => (
              <div key={u.userId} className="p-4 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-sm" style={{ color: 'var(--color-text-1)' }}>{u.displayName}</p>
                  <Badge variant={STATUS_VARIANT[u.status] ?? 'neutral'}>{STATUS_LABEL[u.status] ?? u.status}</Badge>
                </div>
                <p style={{ color: 'var(--color-text-2)' }}>{u.email}</p>
                <p style={{ color: 'var(--color-text-2)' }}>{ROLE_LABELS[u.role] ?? u.role} · {locationsLabel(u.locationIds, meta?.locations)}</p>
                <p className="text-[11px]" style={{ color: 'var(--color-text-3)' }}>Last login: {fmtWhen(u.lastLoginAt)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {linkFor && (
        <Modal open onClose={() => setLinkFor(null)} title="Share this link" size="sm">
          <div className="space-y-3">
            <div className="flex gap-2">
              <input readOnly value={linkFor.url}
                     className="flex-1 rounded-lg border px-3 py-2 text-xs font-mono"
                     style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }}
                     onFocus={e => e.target.select()} />
              <Button variant="secondary" onClick={() => { navigator.clipboard?.writeText(linkFor.url); toast('Copied.', { variant: 'success' }) }}>Copy</Button>
            </div>
            {linkFor.warning && <p className="text-xs" style={{ color: 'var(--color-warning)' }}>{linkFor.warning}</p>}
          </div>
        </Modal>
      )}

      {formState && (
        <UserFormModal
          open
          onClose={() => setFormState(null)}
          mode={formState.mode}
          user={formState.user}
          allLocations={meta?.locations}
          actingRole={account?.role}
          onSaved={() => refetch()}
        />
      )}
    </div>
  )
}
