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
  const { data } = useQuery({
    queryKey: QK,
    queryFn: actionWorkspaceService.getAll,
    staleTime: Infinity,
    initialData: {},
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
    onSuccess: result => qc.setQueryData(QK, result),
  })

  const setRecord = useCallback(
    (id, patch, logAction) => mutation.mutate({ id, patch, logAction }),
    [mutation]
  )

  return { data: data ?? {}, setRecord }
}
