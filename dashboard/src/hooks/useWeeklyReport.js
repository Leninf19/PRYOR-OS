import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/dataClient.js'

export function useWeeklyReport() {
  return useQuery({
    queryKey: ['weekly-report'],
    queryFn: () => fetchJSON('reports/weekly-summary.json'),
    staleTime: 5 * 60 * 1000,
  })
}
