import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { fetchJSON } from '../lib/dataClient.js'
import { useAccount } from '../components/AuthGate.jsx'

const OPTS = { staleTime: 1000 * 60 * 10 } // 10 min cache

// Multi-Location Authentication & User Access System: every file below
// except meta.json/useLocationDetail/useLocationReviews is COMPANY-WIDE and
// permanently blocked (403) by dashboard/api/data.js for a location-scoped
// account (account.locationIds !== '*') -- see that file's DATA_FILE_REGISTRY.
// `enabled: false` stops each query from ever firing for a scoped account,
// rather than letting a doomed request fail and surface a console error or
// a failed-request toast for data the UI already knows it can't use.
export function isLocationScoped(account) {
  return Boolean(account) && account.locationIds !== '*'
}

function useCompanyWideQuery(queryKey, path) {
  const account = useAccount()
  return useQuery({ queryKey, queryFn: () => fetchJSON(path), enabled: !isLocationScoped(account), ...OPTS })
}

export function useMeta()               { return useQuery({ queryKey: ['meta'],               queryFn: () => fetchJSON('meta.json'),                                ...OPTS }) }
export function useKPIs()               { return useCompanyWideQuery(['kpis'], 'analytics/kpis.json') }
export function useMonthlyTrend()       { return useCompanyWideQuery(['monthly-trend'], 'analytics/monthly-trend.json') }
export function useLocationStats()      { return useCompanyWideQuery(['location-stats'], 'analytics/location-stats.json') }
export function useRankings()           { return useCompanyWideQuery(['rankings'], 'analytics/rankings-30d.json') }
export function useComplaintIntel()     { return useCompanyWideQuery(['complaint-intel'], 'intelligence/complaint-intelligence.json') }
export function useCompanySummary()     { return useCompanyWideQuery(['company-summary'], 'intelligence/company-summary.json') }
export function usePredictiveAlerts()   { return useCompanyWideQuery(['predictive-alerts'], 'intelligence/predictive-alerts.json') }
export function useResponseDrafts()     { return useCompanyWideQuery(['response-drafts'], 'intelligence/response-drafts.json') }
export function useScraperStatusData()  { return useCompanyWideQuery(['scraper-status'], 'scraper-status.json') }
export function useCompetitorIntel()    { return useCompanyWideQuery(['competitor-intel'], 'intelligence/competitive-intelligence.json') }
export function useWeeklyReportData()   { return useCompanyWideQuery(['weekly-report'], 'reports/weekly-summary.json') }
export function useActionItems()        { return useCompanyWideQuery(['action-items'], 'action-items.json') }
export function useDepartmentPerformance() { return useCompanyWideQuery(['department-performance'], 'intelligence/department-performance.json') }
export function useActionCenter()       { return useCompanyWideQuery(['action-center'], 'intelligence/action-center.json') }
export function useOperationsImpact()   { return useCompanyWideQuery(['operations-impact'], 'intelligence/operations-impact.json') }
export function useCXIndex()            { return useCompanyWideQuery(['cx-index'], 'intelligence/cx-index.json') }
export function useBestQuotes()         { return useCompanyWideQuery(['best-quotes'], 'intelligence/best-quotes.json') }
export function useSeasonalTrends()     { return useCompanyWideQuery(['seasonal-trends'], 'intelligence/seasonal-trends.json') }
export function useExecutiveScores()    { return useCompanyWideQuery(['executive-scores'], 'intelligence/executive-scores.json') }

export function useLocationDetail(slug) {
  return useQuery({
    queryKey: ['location-detail', slug],
    queryFn: () => fetchJSON(`intelligence/locations/${slug}.json`),
    enabled: !!slug,
    ...OPTS,
  })
}

// Prefetch all heavy data files in the background at app startup -- every
// entry except meta.json is company-wide and permanently blocked for a
// location-scoped account (see useCompanyWideQuery's header comment above),
// so this skips straight to just meta.json for one, rather than firing 13
// doomed requests that would each 403.
export function useGlobalPrefetch() {
  const qc = useQueryClient()
  const account = useAccount()
  useEffect(() => {
    const files = isLocationScoped(account)
      ? [['meta', 'meta.json']]
      : [
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
  }, [qc, account])
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
