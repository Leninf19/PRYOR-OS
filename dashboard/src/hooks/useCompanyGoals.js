import { useCallback } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import * as companyGoalsService from '../services/companyGoalsService.js'

const QK = ['company-goals']

export function useCompanyGoals() {
  const qc = useQueryClient()
  // M5 bug fix (same root cause as useReviewWorkspace.js/useActionWorkspace.js):
  // `initialData` combined with `staleTime: Infinity` made react-query treat
  // the seeded default goals as permanently fresh data, so queryFn (the real
  // localStorage read) never actually ran on mount -- every fresh page load
  // silently served DEFAULT_GOALS instead of any goals a user had actually
  // saved via Settings, until a same-session edit repopulated the cache.
  // staleTime: Infinity is kept (mutations already update the cache
  // directly); only initialData needed to go -- the `?? DEFAULT_GOALS`
  // below already guards the brief undefined tick before the first load.
  const { data } = useQuery({
    queryKey: QK,
    queryFn: companyGoalsService.getGoals,
    staleTime: Infinity,
  })

  const mutation = useMutation({
    mutationFn: patch => companyGoalsService.setGoals(patch),
    onMutate: async patch => {
      await qc.cancelQueries({ queryKey: QK })
      const prev = qc.getQueryData(QK) ?? companyGoalsService.DEFAULT_GOALS
      qc.setQueryData(QK, { ...prev, ...patch })
      return { prev }
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) qc.setQueryData(QK, context.prev)
    },
    onSuccess: result => qc.setQueryData(QK, result),
  })

  const setGoals = useCallback(patch => mutation.mutate(patch), [mutation])

  return { goals: data ?? companyGoalsService.DEFAULT_GOALS, setGoals }
}
