import { useState, useEffect } from 'react'
import Modal from '../../components/ui/Modal.jsx'
import Button from '../../components/ui/Button.jsx'
import EmailFieldList from '../../components/ui/EmailFieldList.jsx'
import { useToast } from '../../components/ui/Toast.jsx'
import { isValidEmailFormat } from '../../utils/emailValidation.js'
import { useUpsertContact } from '../../hooks/useRestaurantContacts.js'

// Add/Edit Contact editor (Phase 8, Milestone 8.4) -- built on Modal.jsx,
// exported as a standalone component (not private to RestaurantContacts.jsx)
// so it can be opened directly from Review Explorer's "Configure Contact"
// button without navigating away from the review, per the spec's
// "immediately opens the editor" requirement.
//
// The record's primary-recipient field is future-proofed for multiple TO
// recipients (a `primaryEmail` string today; the spec explicitly asks this
// be future-proofed, not built -- no multi-TO UI exists yet, just a single
// required input) -- see contactStore.js's record shape.
export default function ContactEditorModal({ open, onClose, locationId, locationName, initialContact }) {
  const showToast = useToast()
  const upsertMutation = useUpsertContact()

  const [managerName, setManagerName] = useState('')
  const [primaryEmail, setPrimaryEmail] = useState('')
  const [ccEmails, setCcEmails] = useState([])
  const [primaryEmailError, setPrimaryEmailError] = useState(null)
  const [warnings, setWarnings] = useState([])

  const isEdit = Boolean(initialContact)

  useEffect(() => {
    if (!open) return
    setManagerName(initialContact?.managerName ?? '')
    setPrimaryEmail(initialContact?.primaryEmail ?? '')
    setCcEmails(initialContact?.ccEmails ?? [])
    setPrimaryEmailError(null)
    setWarnings([])
  }, [open, initialContact])

  async function handleSave() {
    if (!isValidEmailFormat(primaryEmail)) {
      setPrimaryEmailError('Enter a valid email address.')
      return
    }
    setPrimaryEmailError(null)

    try {
      const { warnings: returnedWarnings } = await upsertMutation.mutateAsync({
        locationId,
        patch: {
          locationName,
          managerName: managerName.trim() || null,
          primaryEmail: primaryEmail.trim(),
          ccEmails,
        },
        logAction: isEdit ? 'Contact updated' : 'Contact created',
      })
      // The write already succeeded at this point -- a warning is
      // informational only (e.g. a duplicate primary email elsewhere),
      // never a reason to retry. Keep the modal open just long enough for
      // the user to see it, rather than auto-closing over it.
      if (returnedWarnings?.length) {
        setWarnings(returnedWarnings)
        return
      }
      showToast(isEdit ? 'Contact updated' : 'Contact added', { variant: 'success' })
      onClose()
    } catch (err) {
      showToast(err.message || 'Could not save this contact', { variant: 'error' })
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Restaurant Contact' : 'Add Restaurant Contact'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={upsertMutation.isPending}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={upsertMutation.isPending}>
            {upsertMutation.isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Contact'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="text-[10px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>
            Location
          </label>
          <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>{locationName}</p>
        </div>

        <div>
          <label htmlFor="contact-manager-name" className="text-[10px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>
            Manager Name (optional)
          </label>
          <input
            id="contact-manager-name"
            type="text"
            value={managerName}
            onChange={e => setManagerName(e.target.value)}
            placeholder="e.g. Martin Rodriguez"
            className="w-full text-sm px-2.5 py-2 rounded-lg border focus:outline-none"
            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
          />
        </div>

        <div>
          <label htmlFor="contact-primary-email" className="text-[10px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>
            Primary Email
          </label>
          <input
            id="contact-primary-email"
            type="email"
            required
            value={primaryEmail}
            onChange={e => { setPrimaryEmail(e.target.value); setPrimaryEmailError(null) }}
            placeholder="manager@restaurant.com"
            aria-invalid={Boolean(primaryEmailError)}
            aria-describedby={primaryEmailError ? 'contact-primary-email-error' : undefined}
            className="w-full text-sm px-2.5 py-2 rounded-lg border focus:outline-none"
            style={{ background: 'var(--color-surface-2)', border: `1px solid ${primaryEmailError ? 'var(--color-danger)' : 'var(--color-border)'}`, color: 'var(--color-text-1)' }}
          />
          {primaryEmailError && <p id="contact-primary-email-error" className="text-[11px] mt-1" style={{ color: 'var(--color-danger)' }}>{primaryEmailError}</p>}
        </div>

        <EmailFieldList label="CC Emails (optional)" emails={ccEmails} onChange={setCcEmails} />

        {warnings.length > 0 && (
          <div className="rounded-lg p-3 space-y-2" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
            <p className="text-[11px] font-semibold" style={{ color: 'var(--color-text-2)' }}>
              Saved, with a note:
            </p>
            {warnings.map((w, i) => (
              <p key={i} className="text-xs flex items-start gap-1.5" style={{ color: 'var(--color-grade-c, #b45309)' }}>
                <span aria-hidden="true">⚠</span> {w}
              </p>
            ))}
            <Button variant="secondary" onClick={onClose}>Got it</Button>
          </div>
        )}
      </div>
    </Modal>
  )
}
