import { useCallback } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import * as reviewWorkspaceService from '../services/reviewWorkspaceService.js'
import { useActionItems } from './useIntelligence.js'

const QK = ['review-workspace']

/**
 * Per-review workspace state (status/draft/notes/assignment/history), the
 * same shape every other data hook in this app uses (useQuery + mutation)
 * even though it's backed by localStorage today -- components never touch
 * the storage layer directly, only reviewWorkspaceService.js does.
 */
export function useReviewWorkspace() {
  const qc = useQueryClient()
  // M5 bug fix: `initialData: {}` combined with `staleTime: Infinity` made
  // react-query treat the seeded empty object as permanently fresh data,
  // so queryFn (the real localStorage read) never actually ran on mount --
  // every fresh page load silently discarded any previously-saved workspace
  // state (status/drafts/notes/assignment/history) until a new edit this
  // session repopulated the cache. staleTime: Infinity is still correct
  // (this data only changes via explicit mutations, which already update
  // the cache directly) -- only the initialData needed to go; the `?? {}`
  // below already guards the brief undefined tick before the first load.
  const { data } = useQuery({
    queryKey: QK,
    queryFn: reviewWorkspaceService.getAll,
    staleTime: Infinity,
  })

  const mutation = useMutation({
    mutationFn: ({ id, patch, logAction }) => reviewWorkspaceService.setRecord(id, patch, logAction),
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

// Sidebar badge count -- reads the pipeline's precomputed unanswered-reviews
// list (data/action-items.json), not the workspace above (that's per-review
// draft/status state, unrelated to this raw count).
export function useUnansweredCount() {
  const { data: items } = useActionItems()
  return items?.unanswered?.length ?? 0
}
