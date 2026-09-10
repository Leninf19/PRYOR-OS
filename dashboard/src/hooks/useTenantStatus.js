import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

// Multi-Tenant Phase 4J -- reads GET /api/session/tenant-status, the ONE
// endpoint that answers "what lifecycle state is MY OWN tenant in"
// (onboarding/locations_approved/provisioning/.../active/suspended).
// Mirrors useTenantOps.js's own hand-rolled-fetch + polling shape (this
// isn't a /api/data?file= chunk either), including its 401/403 handling
// convention.
//
// Polls (rather than a long staleTime) because AuthGate uses this hook to
// decide whether to show the onboarding flow or the real dashboard at all
// -- a tenant sitting on the onboarding screen while a platform operator
// runs provisioning/Initial Sync via GitHub Actions needs to notice the
// transition without a manual reload, exactly like TenantOperations.jsx's
// operator-facing poll for the same underlying state machine.
const QK = ['tenant-status']

async function fetchTenantStatus() {
  const res = await fetch('/api/session/tenant-status')
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error('Session expired fetching tenant status')
  }
  if (!res.ok) throw new Error(`Failed to fetch tenant status: ${res.status}`)
  return res.json()
}

export function useTenantStatus({ enabled = true, refetchInterval } = {}) {
  return useQuery({
    queryKey: QK,
    queryFn: fetchTenantStatus,
    enabled,
    staleTime: 0,
    refetchInterval: refetchInterval ?? 15_000,
    refetchOnWindowFocus: true,
    retry: 2,
  })
}

// POST /api/google/discover-locations -- Owner-only server-side (enforced
// by google/[action].js itself; this mutation simply surfaces whatever
// that endpoint decides). Returns { discoverySessionId, expiresAt,
// locations }. Never trusted as authorization by itself -- see
// useApproveLocations() below, which is the only thing that can ever turn
// a discovery result into an actual entitlement, and only via the SAME
// trusted discoverySessionId this call produced.
export function useDiscoverLocations() {
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/google/discover-locations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = new Error(body.message || `Failed to discover locations: ${res.status}`)
        err.code = body.error
        throw err
      }
      return body
    },
  })
}

// POST /api/google/approve-locations -- the ONLY thing this phase's
// onboarding UI ever calls to change approvedLocations, and only while a
// tenant is still pre-commit (google/[action].js's own
// LOCATION_APPROVAL_ELIGIBLE_STATUSES gate enforces this server-side --
// this hook has no client-side awareness of eligibility at all, it just
// surfaces whatever the server decides, including a 409 not_eligible for
// an already-committed tenant).
export function useApproveLocations() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ discoverySessionId, selectedGoogleLocationIds }) => {
      const res = await fetch('/api/google/approve-locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discoverySessionId, selectedGoogleLocationIds }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = new Error(body.message || `Failed to approve locations: ${res.status}`)
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
