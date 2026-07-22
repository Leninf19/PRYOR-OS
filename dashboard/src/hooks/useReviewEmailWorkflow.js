import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as reviewEmailService from '../services/reviewEmailService.js'

// Same cache key useActionWorkspace.js's useQuery uses -- a successful
// send/status-update writes into the SAME Redis-backed record
// send-review-email/update-email-status just wrote, so Action Center's own
// workspace view reflects it immediately without a separate refetch.
const WORKSPACE_QK = ['action-workspace']

// Server-resolved recipient/CC/Reply-To preview for the confirmation panel
// -- read-only, never sends anything. `enabled` lets the caller defer the
// request until the panel is actually opened.
export function useReviewEmailPreview(id, locationId, enabled) {
  return useQuery({
    queryKey: ['review-email-preview', id, locationId],
    queryFn: () => reviewEmailService.previewReviewEmail(id, locationId),
    enabled: Boolean(enabled && id && locationId),
    staleTime: 30 * 1000,
  })
}

export function useSendReviewEmail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload) => reviewEmailService.sendReviewEmail(payload),
    onSuccess: (record, payload) => {
      const prev = qc.getQueryData(WORKSPACE_QK) ?? {}
      qc.setQueryData(WORKSPACE_QK, { ...prev, [payload.id]: record })
      qc.invalidateQueries({ queryKey: ['review-email-preview', payload.id, payload.locationId] })
    },
    // A duplicate (409)/send-failure (502) response still carries the
    // item's current record -- reflect it in the workspace cache too, so
    // the UI shows the real (e.g. 'failed') status rather than nothing.
    onError: (err, payload) => {
      if (!err.record) return
      const prev = qc.getQueryData(WORKSPACE_QK) ?? {}
      qc.setQueryData(WORKSPACE_QK, { ...prev, [payload.id]: err.record })
    },
  })
}

export function useUpdateEmailStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, emailStatus }) => reviewEmailService.updateEmailStatus(id, emailStatus),
    onSuccess: (record, { id }) => {
      const prev = qc.getQueryData(WORKSPACE_QK) ?? {}
      qc.setQueryData(WORKSPACE_QK, { ...prev, [id]: record })
    },
  })
}
