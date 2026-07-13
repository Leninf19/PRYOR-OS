import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'theme_preference_v1' // 'light' | 'dark' | 'system'
const MEDIA = '(prefers-color-scheme: dark)'

function systemPrefersDark() {
  return typeof window !== 'undefined' && window.matchMedia(MEDIA).matches
}

function resolve(preference) {
  return preference === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : preference
}

function applyResolvedTheme(resolved) {
  document.documentElement.setAttribute('data-theme', resolved)
}

/**
 * Three-way preference (light / dark / system), persisted to localStorage.
 * Always applies a concrete data-theme="light"|"dark" to <html> -- even for
 * "system" -- so both the CSS custom-property theme (index.css) and
 * Tailwind's `dark:` variant (tailwind.config.js darkMode: ['selector', ...])
 * read the same signal instead of two different mechanisms drifting apart.
 * Subscribes to OS-level changes so a "system" preference updates live.
 */
export function useTheme() {
  const [preference, setPreference] = useState(
    () => localStorage.getItem(STORAGE_KEY) || 'system'
  )

  useEffect(() => {
    applyResolvedTheme(resolve(preference))
    localStorage.setItem(STORAGE_KEY, preference)

    if (preference !== 'system') return
    const mq = window.matchMedia(MEDIA)
    const onChange = () => applyResolvedTheme(resolve('system'))
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [preference])

  const setTheme = useCallback((next) => setPreference(next), [])

  return { preference, resolved: resolve(preference), setTheme }
}

// Runs once at app startup, before React mounts, so the very first paint
// already has the right theme instead of flashing light then swapping.
export function applyInitialTheme() {
  const preference = localStorage.getItem(STORAGE_KEY) || 'system'
  applyResolvedTheme(resolve(preference))
}
