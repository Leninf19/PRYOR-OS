import { useCallback, useEffect, useState } from 'react'
import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

// Drives AuthGate: checks for an existing session on load, exposes
// login/logout actions, and listens for SESSION_EXPIRED_EVENT so a 401
// discovered mid-session (cookie expired while the tab was open) drops the
// app back to the login screen instead of leaving every page to render its
// own "failed to load" state for what is actually "please sign in again".
export function useSession() {
  const [state, setState] = useState({ status: 'loading', account: null })

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch('/api/session/whoami')
      if (res.ok) {
        const data = await res.json()
        setState({ status: 'authenticated', account: data.account })
      } else {
        setState({ status: 'unauthenticated', account: null })
      }
    } catch {
      setState({ status: 'unauthenticated', account: null })
    }
  }, [])

  useEffect(() => { checkSession() }, [checkSession])

  useEffect(() => {
    const onExpired = () => setState({ status: 'unauthenticated', account: null })
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired)
  }, [])

  const login = useCallback((account) => {
    setState({ status: 'authenticated', account })
  }, [])

  const logout = useCallback(async () => {
    try { await fetch('/api/session/logout', { method: 'POST' }) } catch { /* clearing client state regardless */ }
    setState({ status: 'unauthenticated', account: null })
  }, [])

  return { ...state, login, logout, recheck: checkSession }
}
