import { useCallback } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import * as actionWorkspaceService from '../services/actionWorkspaceService.js'

const QK = ['action-workspace']

/**
 * Task-tracking state for Action Center recommendations -- same
 * useQuery+mutation wrapper as useReviewWorkspace.js, so components never
 * touch localStorage directly.
 */
export function useActionWorkspace() {
  const qc = useQueryClient()
  // M5 bug fix (same root cause as useReviewWorkspace.js): `initialData: {}`
  // with `staleTime: Infinity` made react-query treat the seeded empty
  // object as permanently fresh, so queryFn -- a real fetch('/api/actions/list')
  // -- never actually ran on mount. Every fresh page load silently served an
  // empty workspace until a mutation this session repopulated the cache,
  // discarding real server state (assignment/status/email-thread history)
  // on reload. staleTime: Infinity is kept (mutations already update the
  // cache directly); only initialData needed to go.
  const { data } = useQuery({
    queryKey: QK,
    queryFn: actionWorkspaceService.getAll,
    staleTime: Infinity,
  })

  const mutation = useMutation({
    mutationFn: ({ id, patch, logAction }) => actionWorkspaceService.setRecord(id, patch, logAction),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: QK })
      const prev = qc.getQueryData(QK) ?? {}
      qc.setQueryData(QK, { ...prev, [id]: { ...prev[id], ...patch } })
      return { prev }
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) qc.setQueryData(QK, context.prev)
    },
    // The server now returns just the one updated record (server-stamped
    // createdBy/At, updatedBy/At, history) rather than the whole workspace --
    // merge it into the existing cache instead of replacing the cache
    // wholesale, so a concurrent update to a DIFFERENT id (another manager,
    // or this same tab's own optimistic write to a different row) is never
    // clobbered by an in-flight response for this one.
    onSuccess: (record, { id }) => {
      const prev = qc.getQueryData(QK) ?? {}
      qc.setQueryData(QK, { ...prev, [id]: record })
    },
  })

  const setRecord = useCallback(
    (id, patch, logAction) => mutation.mutate({ id, patch, logAction }),
    [mutation]
  )

  return { data: data ?? {}, setRecord }
}
