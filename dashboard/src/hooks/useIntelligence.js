import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { fetchJSON } from '../lib/dataClient.js'

const OPTS = { staleTime: 1000 * 60 * 10 } // 10 min cache

export function useMeta()               { return useQuery({ queryKey: ['meta'],               queryFn: () => fetchJSON('meta.json'),                                ...OPTS }) }
export function useKPIs()               { return useQuery({ queryKey: ['kpis'],               queryFn: () => fetchJSON('analytics/kpis.json'),                      ...OPTS }) }
export function useMonthlyTrend()       { return useQuery({ queryKey: ['monthly-trend'],       queryFn: () => fetchJSON('analytics/monthly-trend.json'),             ...OPTS }) }
export function useLocationStats()      { return useQuery({ queryKey: ['location-stats'],      queryFn: () => fetchJSON('analytics/location-stats.json'),            ...OPTS }) }
export function useRankings()           { return useQuery({ queryKey: ['rankings'],            queryFn: () => fetchJSON('analytics/rankings-30d.json'),              ...OPTS }) }
export function useComplaintIntel()     { return useQuery({ queryKey: ['complaint-intel'],     queryFn: () => fetchJSON('intelligence/complaint-intelligence.json'), ...OPTS }) }
export function useCompanySummary()     { return useQuery({ queryKey: ['company-summary'],     queryFn: () => fetchJSON('intelligence/company-summary.json'),        ...OPTS }) }
export function usePredictiveAlerts()   { return useQuery({ queryKey: ['predictive-alerts'],   queryFn: () => fetchJSON('intelligence/predictive-alerts.json'),      ...OPTS }) }
export function useResponseDrafts()     { return useQuery({ queryKey: ['response-drafts'],     queryFn: () => fetchJSON('intelligence/response-drafts.json'),        ...OPTS }) }
export function useScraperStatusData()  { return useQuery({ queryKey: ['scraper-status'],      queryFn: () => fetchJSON('scraper-status.json'),                      ...OPTS }) }
export function useCompetitorIntel()    { return useQuery({ queryKey: ['competitor-intel'],      queryFn: () => fetchJSON('intelligence/competitive-intelligence.json'), ...OPTS }) }
export function useWeeklyReportData()   { return useQuery({ queryKey: ['weekly-report'],       queryFn: () => fetchJSON('reports/weekly-summary.json'),              ...OPTS }) }
export function useActionItems()        { return useQuery({ queryKey: ['action-items'],        queryFn: () => fetchJSON('action-items.json'),                        ...OPTS }) }
export function useDepartmentPerformance() { return useQuery({ queryKey: ['department-performance'], queryFn: () => fetchJSON('intelligence/department-performance.json'), ...OPTS }) }
export function useActionCenter()       { return useQuery({ queryKey: ['action-center'],        queryFn: () => fetchJSON('intelligence/action-center.json'),          ...OPTS }) }
export function useOperationsImpact()   { return useQuery({ queryKey: ['operations-impact'],    queryFn: () => fetchJSON('intelligence/operations-impact.json'),      ...OPTS }) }
export function useCXIndex()            { return useQuery({ queryKey: ['cx-index'],             queryFn: () => fetchJSON('intelligence/cx-index.json'),               ...OPTS }) }
export function useBestQuotes()         { return useQuery({ queryKey: ['best-quotes'],          queryFn: () => fetchJSON('intelligence/best-quotes.json'),            ...OPTS }) }
export function useSeasonalTrends()     { return useQuery({ queryKey: ['seasonal-trends'],       queryFn: () => fetchJSON('intelligence/seasonal-trends.json'),        ...OPTS }) }
export function useExecutiveScores()    { return useQuery({ queryKey: ['executive-scores'],      queryFn: () => fetchJSON('intelligence/executive-scores.json'),       ...OPTS }) }

export function useLocationDetail(slug) {
  return useQuery({
    queryKey: ['location-detail', slug],
    queryFn: () => fetchJSON(`intelligence/locations/${slug}.json`),
    enabled: !!slug,
    ...OPTS,
  })
}

// Prefetch all heavy data files in the background at app startup
export function useGlobalPrefetch() {
  const qc = useQueryClient()
  useEffect(() => {
    const files = [
      ['kpis',              'analytics/kpis.json'],
      ['monthly-trend',     'analytics/monthly-trend.json'],
      ['location-stats',    'analytics/location-stats.json'],
      ['rankings',          'analytics/rankings-30d.json'],
      ['complaint-intel',   'intelligence/complaint-intelligence.json'],
      ['department-performance', 'intelligence/department-performance.json'],
      ['company-summary',   'intelligence/company-summary.json'],
      ['predictive-alerts', 'intelligence/predictive-alerts.json'],
      ['response-drafts',   'intelligence/response-drafts.json'],
      ['competitor-intel',  'intelligence/competitive-intelligence.json'],
      ['action-items',      'action-items.json'],
      ['meta',              'meta.json'],
      // Phase 3 Milestone 6 (Executive Intelligence Center): its priority
      // digest needs these two on first load just like every other page's
      // data, so it isn't the one page without an instant-load cache hit.
      ['action-center',      'intelligence/action-center.json'],
      ['operations-impact',  'intelligence/operations-impact.json'],
    ]
    files.forEach(([key, path]) => {
      qc.prefetchQuery({
        queryKey: [key],
        queryFn: () => fetchJSON(path),
        staleTime: 1000 * 60 * 10,
      })
    })
  }, [qc])
}

export function usePrefetchLocationDetails(stats) {
  const qc = useQueryClient()
  useEffect(() => {
    if (!stats?.length) return
    stats.forEach(loc => {
      const slug = loc.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      qc.prefetchQuery({
        queryKey: ['location-detail', slug],
        queryFn: () => fetchJSON(`intelligence/locations/${slug}.json`),
        staleTime: 1000 * 60 * 10,
      })
    })
  }, [stats, qc])
}

// Network-wide staff-mention data lives per-location, in intelligence/locations/{slug}.json
// (there is no staff field on location-stats.json). This fetches every location's
// detail file at once -- reusing the same ['location-detail', slug] cache key
// usePrefetchLocationDetails() already primes, so on most navigations this resolves
// from cache instantly instead of firing 20+ new requests.
export function useAllLocationDetails(stats) {
  const slugs = (stats ?? []).map(s => s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
  const results = useQueries({
    queries: slugs.map(slug => ({
      queryKey: ['location-detail', slug],
      queryFn: () => fetchJSON(`intelligence/locations/${slug}.json`),
      enabled: !!slug,
      ...OPTS,
    })),
  })
  return {
    data: results.map(r => r.data).filter(Boolean),
    isLoading: slugs.length > 0 && results.some(r => r.isLoading),
  }
}

export function useLocationReviews(slug) {
  return useQuery({
    queryKey: ['location-reviews', slug],
    queryFn: () => fetchJSON(`reviews/by-location/${slug}.json`),
    enabled: !!slug,
    ...OPTS,
  })
}
