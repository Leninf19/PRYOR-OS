import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/dataClient.js'

// Fetches the small per-location chunks (written by export_chunks.py) in
// parallel and concatenates them into the same flat review-array shape the
// app used to get from the single static reviews.json import -- this keeps
// every downstream filter/page untouched while moving the 7MB+ payload out
// of the JS bundle and into cacheable, parallelizable HTTP requests.
export function useReviewsData() {
  return useQuery({
    queryKey: ['all-reviews'],
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
