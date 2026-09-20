import { useEffect } from 'react'

// Review Media Feature -- Scale & No-Backfill Audit (Phase 9): extracted
// from components/ui/Modal.jsx's own inline useEffect (byte-for-byte the
// same focus-trap/Escape/focus-restore logic, unchanged) so the new
// MediaLightbox can reuse the identical, already-proven pattern without
// duplicating it as a second, independently-maintained copy. Modal.jsx
// itself is left untouched -- it has no dedicated test coverage today, so
// refactoring it to consume this hook is deferred to a separate, reviewed
// change rather than risked as a side effect of this feature.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// `panelRef`: a ref to the dialog's root element. `open`: whether the
// dialog is currently shown. `onClose`: called on Escape. Focuses the
// panel's first focusable element on open, traps Tab/Shift+Tab within it,
// closes on Escape, and restores focus to whatever had it before the
// dialog opened once it closes.
export default function useFocusTrap(panelRef, open, onClose) {
  useEffect(() => {
    if (!open) return undefined

    const previouslyFocused = document.activeElement
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
      previouslyFocused?.focus?.()
    }
  }, [open, onClose, panelRef])
}
