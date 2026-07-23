import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'

// First modal/dialog primitive in the codebase (Phase 8, Milestone 8.1) --
// every future Settings editor (Restaurant Contacts, Email Templates,
// Notification Rules, Manager Accounts) builds on this rather than each
// inventing its own overlay. Portal-based, focus-trapped, ESC-to-close,
// backdrop-click-to-close, restores focus to whatever triggered it on close.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function Modal({ open, onClose, title, children, footer, size = 'md' }) {
  const panelRef = useRef(null)
  const previouslyFocused = useRef(null)

  const widthClass = size === 'sm' ? 'max-w-sm' : size === 'lg' ? 'max-w-2xl' : 'max-w-md'

  useEffect(() => {
    if (!open) return undefined

    previouslyFocused.current = document.activeElement
    const panel = panelRef.current
    const focusable = panel?.querySelectorAll(FOCUSABLE_SELECTOR)
    ;(focusable?.[0] ?? panel)?.focus()

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const nodes = panel?.querySelectorAll(FOCUSABLE_SELECTOR)
      if (!nodes || nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      previouslyFocused.current?.focus?.()
    }
  }, [open, onClose])

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            className="absolute inset-0"
            style={{ background: 'rgba(0,0,0,0.4)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? 'modal-title' : undefined}
            tabIndex={-1}
            className={`relative w-full ${widthClass} rounded-2xl border overflow-hidden`}
            style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ duration: 0.18 }}
          >
            {title && (
              <div className="px-6 py-4 border-b flex items-center justify-between gap-4" style={{ borderColor: 'var(--color-border)' }}>
                <p id="modal-title" className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>{title}</p>
                <button onClick={onClose} aria-label="Close"
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-sm transition-colors"
                        style={{ color: 'var(--color-text-3)' }}>
                  ✕
                </button>
              </div>
            )}
            <div className="px-6 py-5 max-h-[70vh] overflow-y-auto">
              {children}
            </div>
            {footer && (
              <div className="px-6 py-4 border-t flex items-center justify-end gap-2"
                   style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-2)' }}>
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  )
}
