import { createContext, useCallback, useContext, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

const ToastContext = createContext(null)

// Phase 8, Milestone 8.4: an optional `variant` ('success'|'error'|'info')
// distinguishes a toast visually via a small colored left border --
// backward compatible, every pre-existing call site (which never passes
// `variant`) keeps rendering exactly as before via the 'default' style.
const VARIANT_BORDER = {
  success: 'var(--color-success, var(--toast-success-fallback))',
  error:   'var(--color-danger, var(--toast-danger-fallback))',
  info:    'var(--color-info, var(--toast-info-fallback))',
  default: 'transparent',
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const showToast = useCallback((message, { duration = 3000, variant = 'default' } = {}) => {
    const id = Date.now() + Math.random()
    setToasts(t => [...t, { id, message, variant }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), duration)
  }, [])

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 items-end">
        <AnimatePresence>
          {toasts.map(t => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 12, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.95 }}
              transition={{ duration: 0.18 }}
              className="bg-stone-900 text-white text-xs font-medium px-4 py-2.5 rounded-lg shadow-lg dark:border dark:border-[var(--color-border-2)]"
              style={{ borderLeft: `3px solid ${VARIANT_BORDER[t.variant] ?? VARIANT_BORDER.default}` }}
            >
              {t.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within a ToastProvider')
  return ctx
}
