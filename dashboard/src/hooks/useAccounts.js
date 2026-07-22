import { useQuery } from '@tanstack/react-query'
import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

// Reads the reusable identity-directory endpoint (GET /api/session/accounts)
// -- lives on the auth/identity layer, not on Action Center, precisely so
// this same hook is the one future features (workload reporting,
// notifications, settings/manager-administration, audit-log attribution)
// call too, instead of each re-fetching or re-shaping the account list.
// Fetches directly (no dataClient.js fetchJSON reuse -- that helper is
// shaped around /api/data?file=, a different endpoint), but reuses its
// SESSION_EXPIRED_EVENT constant so a 401 here behaves identically to every
// other data fetch in the app.
async function fetchAccounts() {
  const res = await fetch('/api/session/accounts')
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error('Session expired fetching accounts')
  }
  if (!res.ok) throw new Error(`Failed to fetch accounts: ${res.status}`)
  const { accounts } = await res.json()
  return accounts ?? []
}

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
    staleTime: 5 * 60 * 1000, // the account directory changes rarely
  })
}
