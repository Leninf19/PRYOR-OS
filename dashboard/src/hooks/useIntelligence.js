import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

async function fetchJSON(path) {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  return res.json()
}

const OPTS = { staleTime: 1000 * 60 * 10 } // 10 min cache

export function useKPIs()               { return useQuery({ queryKey: ['kpis'],               queryFn: () => fetchJSON('/data/analytics/kpis.json'),                      ...OPTS }) }
export function useMonthlyTrend()       { return useQuery({ queryKey: ['monthly-trend'],       queryFn: () => fetchJSON('/data/analytics/monthly-trend.json'),             ...OPTS }) }
export function useLocationStats()      { return useQuery({ queryKey: ['location-stats'],      queryFn: () => fetchJSON('/data/analytics/location-stats.json'),            ...OPTS }) }
export function useRankings()           { return useQuery({ queryKey: ['rankings'],            queryFn: () => fetchJSON('/data/analytics/rankings-30d.json'),              ...OPTS }) }
export function useComplaintIntel()     { return useQuery({ queryKey: ['complaint-intel'],     queryFn: () => fetchJSON('/data/intelligence/complaint-intelligence.json'), ...OPTS }) }
export function useCompanySummary()     { return useQuery({ queryKey: ['company-summary'],     queryFn: () => fetchJSON('/data/intelligence/company-summary.json'),        ...OPTS }) }
export function usePredictiveAlerts()   { return useQuery({ queryKey: ['predictive-alerts'],   queryFn: () => fetchJSON('/data/intelligence/predictive-alerts.json'),      ...OPTS }) }
export function useResponseDrafts()     { return useQuery({ queryKey: ['response-drafts'],     queryFn: () => fetchJSON('/data/intelligence/response-drafts.json'),        ...OPTS }) }
export function useScraperStatusData()  { return useQuery({ queryKey: ['scraper-status'],      queryFn: () => fetchJSON('/data/scraper-status.json'),                      ...OPTS }) }
export function useCompetitorIntel()    { return useQuery({ queryKey: ['competitor-intel'],      queryFn: () => fetchJSON('/data/intelligence/competitive-intelligence.json'), ...OPTS }) }
export function useWeeklyReportData()   { return useQuery({ queryKey: ['weekly-report'],       queryFn: () => fetchJSON('/data/reports/weekly-summary.json'),              ...OPTS }) }
export function useActionItems()        { return useQuery({ queryKey: ['action-items'],        queryFn: () => fetchJSON('/data/action-items.json'),                        ...OPTS }) }

export function useLocationDetail(slug) {
  return useQuery({
    queryKey: ['location-detail', slug],
    queryFn: () => fetchJSON(`/data/intelligence/locations/${slug}.json`),
    enabled: !!slug,
    ...OPTS,
  })
}

// Prefetch all heavy data files in the background at app startup
export function useGlobalPrefetch() {
  const qc = useQueryClient()
  useEffect(() => {
    const files = [
      ['kpis',              '/data/analytics/kpis.json'],
      ['monthly-trend',     '/data/analytics/monthly-trend.json'],
      ['location-stats',    '/data/analytics/location-stats.json'],
      ['rankings',          '/data/analytics/rankings-30d.json'],
      ['complaint-intel',   '/data/intelligence/complaint-intelligence.json'],
      ['company-summary',   '/data/intelligence/company-summary.json'],
      ['predictive-alerts', '/data/intelligence/predictive-alerts.json'],
      ['response-drafts',   '/data/intelligence/response-drafts.json'],
      ['competitor-intel',  '/data/intelligence/competitive-intelligence.json'],
      ['action-items',      '/data/action-items.json'],
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
        queryFn: () => fetchJSON(`/data/intelligence/locations/${slug}.json`),
        staleTime: 1000 * 60 * 10,
      })
    })
  }, [stats, qc])
}

export function useLocationReviews(slug) {
  return useQuery({
    queryKey: ['location-reviews', slug],
    queryFn: () => fetchJSON(`/data/reviews/by-location/${slug}.json`),
    enabled: !!slug,
    ...OPTS,
  })
}
