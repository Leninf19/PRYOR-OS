// DEPRECATED (Phase 8, Milestone 8.7) -- superseded by
// useGoogleOAuthStatus.js, a proper React Query hook. Every in-repo
// consumer (Settings' Google Business Profile page, Alerts.jsx,
// ScraperStatus.jsx) has been switched to the new hook; this file is kept
// for one release cycle only, as a thin adapter back to the old
// `{ loading, connected, state, ... }` shape, in case anything outside
// this migration's tracked call sites still imports it. Scheduled for
// removal in Milestone 8.12's cleanup pass.
import { useGoogleOAuthStatus } from './useGoogleOAuthStatus.js'

export function useGoogleStatus() {
  const { data, isLoading } = useGoogleOAuthStatus()
  return { loading: isLoading, ...(data ?? {}) }
}
