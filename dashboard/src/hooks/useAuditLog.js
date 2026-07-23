import { useQuery } from '@tanstack/react-query'
import * as auditLogService from '../services/auditLogService.js'

// Global Audit Log state (Phase 8, Milestone 8.6) -- read-only, so a plain
// useQuery (no mutations) is all this needs. Refetches whenever the filter
// object changes (the query key includes it), matching
// useReviewEmailWorkflow.js's parameterized-key convention.
export function useAuditLog(filters = {}) {
  return useQuery({
    queryKey: ['audit-log', filters],
    queryFn: () => auditLogService.getEntries(filters),
    staleTime: 15 * 1000,
    placeholderData: (prev) => prev, // keep showing the old page while a new filter/page loads
  })
}
