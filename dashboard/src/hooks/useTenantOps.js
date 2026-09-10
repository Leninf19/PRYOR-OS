import { useQuery } from '@tanstack/react-query'
import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

// Multi-Tenant Phase 4H.1 -- reads the super-admin-only, read-only tenant
// operations status endpoint. Originally its own top-level route
// (GET /api/tenant-ops?action=list); merged into api/admin/[action].js
// (PRYOR OS Vercel Serverless Function Count Reduction) since both share
// the identical isSuperAdmin gate and Vercel Hobby's 12-function ceiling
// left no room for a standalone route. Mirrors useAccounts.js's own
// direct-fetch shape (this endpoint isn't a /api/data?file= chunk, so
// dataClient.js's fetchJSON doesn't apply).
//
// Polls periodically (see refetchInterval below) rather than relying on a
// long staleTime -- an operator watching this page while a GitHub Actions
// tenant-lifecycle run is in flight needs to see state change without a
// manual refresh, and the endpoint itself is already `Cache-Control:
// private, no-store` so there is no stale HTTP-level cache to fight
// either. staleTime: 0 means every refetch (interval or manual) is always
// treated as immediately stale-on-arrival, never served from a lingering
// in-memory cache entry mid-poll.
async function fetchTenantOpsList() {
  const res = await fetch('/api/admin?action=tenant-list')
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error('Session expired fetching tenant operations')
  }
  if (res.status === 403) {
    const err = new Error('You do not have permission to view tenant operations.')
    err.forbidden = true
    throw err
  }
  if (!res.ok) throw new Error(`Failed to fetch tenant operations: ${res.status}`)
  const { tenants } = await res.json()
  return tenants ?? []
}

export function useTenantOpsList({ enabled = true } = {}) {
  return useQuery({
    queryKey: ['tenant-ops', 'list'],
    queryFn: fetchTenantOpsList,
    enabled,
    staleTime: 0,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    retry: (failureCount, err) => !err?.forbidden && failureCount < 2,
  })
}
