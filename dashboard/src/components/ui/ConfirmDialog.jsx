import { useState, useEffect } from 'react'
import Modal from './Modal.jsx'
import Button from './Button.jsx'

// Thin wrapper on Modal.jsx for the two confirmation patterns already
// established elsewhere in this app (Phase 8, Milestone 8.1):
//   - click-to-arm (default): ReviewExplorer.jsx's SendToRestaurantSection
//     precedent -- a single Confirm click, no typing required. Use for
//     routine destructive actions (Delete Contact, Disable Contact).
//   - type-the-word (pass `confirmWord`): Settings.jsx's
//     HistoricalImportPanel "type IMPORT" precedent -- the confirm button
//     stays disabled until the exact word is typed. Reserve for genuinely
//     higher-blast-radius actions (Disconnect Google).
export default function ConfirmDialog({
  open, onClose, onConfirm, title, body,
  confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = false, confirmWord = null, busy = false,
}) {
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (open) setTyped('')
  }, [open])

  const canConfirm = confirmWord ? typed === confirmWord : true

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy || !canConfirm}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      {body && <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>{body}</p>}
      {confirmWord && (
        <div className="mt-3">
          <input
            type="text"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            placeholder={`Type "${confirmWord}" to confirm`}
            aria-label={`Type ${confirmWord} to confirm`}
            className="w-full text-xs px-2.5 py-2 rounded-lg border focus:outline-none"
            style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
          />
        </div>
      )}
    </Modal>
  )
}
