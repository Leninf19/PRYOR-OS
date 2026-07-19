import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/dataClient.js'

export function useScraperStatus() {
  return useQuery({
    queryKey: ['scraper-status'],
    queryFn: () => fetchJSON('scraper-status.json'),
    staleTime: 5 * 60 * 1000,
  })
}
