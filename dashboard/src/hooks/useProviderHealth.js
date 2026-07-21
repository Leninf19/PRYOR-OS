import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/dataClient.js'

export function useProviderHealth() {
  return useQuery({
    queryKey: ['provider-health'],
    queryFn: () => fetchJSON('provider-health.json'),
    staleTime: 5 * 60 * 1000,
  })
}
