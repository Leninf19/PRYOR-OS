import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import * as emailSystemService from '../services/emailSystemService.js'

const QK = ['email-system-status']

// Email System settings state (Phase 8, Milestone 8.9) -- read-only status
// over emailSender.js's configuration + the audit log's `entity: 'email'`
// entries, same useQuery convention as useAuditLog.js.
export function useEmailSystemStatus() {
  return useQuery({
    queryKey: QK,
    queryFn: emailSystemService.getStatus,
    staleTime: 15 * 1000,
  })
}

// "Send Test Email" (used from both Settings -> Email and the Restaurant
// Contacts row action) changes both this status view's lastSuccessAt/
// lastFailureAt AND the target contact's own embedded history --
// invalidating both query keys rather than an optimistic merge, since the
// endpoint's response ({ sentTo, response }) doesn't carry either resource's
// full updated shape back.
export function useSendTestEmail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (locationId) => emailSystemService.sendTestEmail(locationId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: QK })
      qc.invalidateQueries({ queryKey: ['restaurant-contacts'] })
    },
  })
}
