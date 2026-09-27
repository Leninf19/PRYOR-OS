import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/dataClient.js'
import { useAccount } from '../components/AuthGate.jsx'

// Fetches the small per-location chunks (written by export_chunks.py) in
// parallel and concatenates them into the same flat review-array shape the
// app used to get from the single static reviews.json import -- this keeps
// every downstream filter/page untouched while moving the 7MB+ payload out
// of the JS bundle and into cacheable, parallelizable HTTP requests.
export function useReviewsData() {
  const account = useAccount()
  return useQuery({
    // Dashboard-parity revision -- see useIntelligence.js's identical
    // comment: tenantId folded into the key as defense-in-depth, doubly
    // important here since staleTime: Infinity means this key is never
    // otherwise invalidated by time.
    queryKey: ['all-reviews', account?.tenantId],
    queryFn: async () => {
      const meta = await fetchJSON('meta.json')
      const chunks = await Promise.all(
        meta.locations.map(loc => fetchJSON(`reviews/by-location/${loc.slug}.json`))
      )
      return chunks.flat().sort((a, b) => a.review_date.localeCompare(b.review_date))
    },
    staleTime: Infinity,
  })
}
