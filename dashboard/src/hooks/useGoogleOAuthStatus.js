import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

// Google Business Profile connection status (Phase 8, Milestone 8.7) --
// replaces useGoogleStatus.js's raw useState/useEffect with a proper React
// Query hook, the one place in the codebase that didn't already follow
// this app's own convention. Shared by Settings -> Google Business Profile
// (the detailed status page), Alerts (disconnected warning), and
// ScraperStatus/Data Health (connection signal alongside pipeline
// freshness).
//
// `state` is one of: not_configured | never_connected | connected |
// token_expired | token_revoked | auth_failed -- see
// dashboard/api/_lib/credentialStore.js's GoogleHealth enum for the
// authoritative source of these values.
const QK = ['gbp-oauth-status']

export function useGoogleOAuthStatus() {
  return useQuery({
    queryKey: QK,
    queryFn: async () => {
      const res = await fetch('/api/google/status')
      if (!res.ok) throw new Error(`Failed to fetch Google status: ${res.status}`)
      return res.json()
    },
    staleTime: 15 * 1000,
    // A live exchange with Google runs on every fetch (see status()'s own
    // implementation) -- refetching too aggressively would burn API quota
    // for no benefit, but the health banner elsewhere in the app should
    // still notice a change without a manual page reload.
    refetchInterval: 5 * 60 * 1000,
  })
}

export function useConnectGoogle() {
  // Not a fetch mutation -- Connect is a real browser navigation (the
  // OAuth flow needs a full-page redirect to Google), never an XHR/fetch.
  return { connect: () => { window.location.href = '/api/google/auth' } }
}

export function useDisconnectGoogle() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (confirm) => {
      const res = await fetch('/api/google/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = new Error(body.message || `Failed to disconnect: ${res.status}`)
        err.code = body.error
        throw err
      }
      return body
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK })
    },
  })
}
