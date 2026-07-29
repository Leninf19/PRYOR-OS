const BASE = 'inline-flex items-center gap-1.5 font-medium rounded-lg transition-all duration-150 focus-visible:outline-none disabled:opacity-40 disabled:cursor-not-allowed select-none'

const VARIANTS = {
  // Design System Specification v1.0: primary now uses the canonical
  // --color-accent token with theme-appropriate text (--color-bg in dark
  // mode for contrast) instead of Tailwind's separately-recolored amber
  // scale. Hover/active darken the background via color-mix() rather than
  // reducing element opacity, so text contrast is never diluted.
  primary:   'bg-[var(--color-accent)] text-white hover:bg-[color-mix(in_srgb,var(--color-accent)_90%,black)] active:bg-[color-mix(in_srgb,var(--color-accent)_80%,black)] shadow-sm text-xs px-3.5 py-2 dark:text-[var(--color-bg)]',
  secondary: 'bg-white text-stone-700 hover:bg-stone-50 border border-stone-200 hover:border-stone-300 shadow-xs text-xs px-3.5 py-2 dark:bg-[var(--color-surface)] dark:text-[var(--color-text-1)] dark:border-[var(--color-border)] dark:hover:bg-[var(--color-surface-2)] dark:hover:border-[var(--color-border-2)]',
  ghost:     'text-stone-500 hover:text-stone-800 hover:bg-stone-100 text-xs px-2.5 py-1.5 dark:text-[var(--color-text-3)] dark:hover:text-[var(--color-text-1)] dark:hover:bg-[var(--color-surface-2)]',
  danger:    'bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 text-xs px-3.5 py-2 dark:bg-[var(--color-danger-bg)] dark:text-[var(--color-danger)] dark:border-[var(--color-danger-border)] dark:hover:opacity-90',
  accent:    'bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200 text-xs px-3.5 py-2 dark:bg-[var(--color-accent-lt)] dark:text-[var(--color-accent)] dark:border-[var(--color-accent-md)] dark:hover:opacity-90',
}

export default function Button({ variant = 'secondary', size, className = '', children, ...props }) {
  return (
    <button className={`${BASE} ${VARIANTS[variant] ?? VARIANTS.secondary} ${className}`} {...props}>
      {children}
    </button>
  )
}
