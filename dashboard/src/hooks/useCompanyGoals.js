import { useCallback } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import * as companyGoalsService from '../services/companyGoalsService.js'

const QK = ['company-goals']

export function useCompanyGoals() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: QK,
    queryFn: companyGoalsService.getGoals,
    staleTime: Infinity,
    initialData: companyGoalsService.DEFAULT_GOALS,
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
