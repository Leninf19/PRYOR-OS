import { useMemo, useEffect, useState } from 'react'
import { Routes, Route, Navigate, Outlet, useLocation, useOutletContext } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import Layout               from './components/Layout.jsx'
import GlobalFilters        from './components/GlobalFilters.jsx'
import Overview             from './pages/Overview.jsx'
import LocationDetail       from './pages/LocationDetail.jsx'
import ReviewExplorer       from './pages/ReviewExplorer.jsx'
import TrendsAnalytics      from './pages/TrendsAnalytics.jsx'
import ActionItems, { useUnansweredCount } from './pages/ActionItems.jsx'
import ScraperStatus        from './pages/ScraperStatus.jsx'
import Reports              from './pages/Reports.jsx'
import ComplaintIntelligence   from './pages/ComplaintIntelligence.jsx'
import CompetitorIntelligence  from './pages/CompetitorIntelligence.jsx'
import Alerts               from './pages/Alerts.jsx'
import AIAdvisor            from './pages/AIAdvisor.jsx'
import MarketingIntelligence   from './pages/MarketingIntelligence.jsx'
import EmployeeIntelligence    from './pages/EmployeeIntelligence.jsx'
import ExecutiveReports     from './pages/ExecutiveReports.jsx'
import Settings             from './pages/Settings.jsx'
import { useReviewsData }    from './hooks/useReviewsData.js'
import { useGlobalPrefetch } from './hooks/useIntelligence.js'
import { filterReviews, getDefaultDateRange } from './utils/dataUtils.js'

// Pages that don't use the global review filter bar
const NO_FILTER_PATHS = [
  '/actions', '/scraper-status', '/reports', '/intelligence', '/competitive',
  '/alerts', '/advisor', '/marketing-intel', '/employee-intel', '/executive-reports', '/settings',
]

function buildDefaultFilters(reviews) {
  const dr = getDefaultDateRange(reviews)
  return { brands: [], locations: [], start: dr.start, end: dr.end, stars: [],
           _defaultStart: dr.start, _defaultEnd: dr.end }
}

function LoadingScreen() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6"
         style={{ background: 'var(--color-bg)' }}>
      <div className="text-center">
        <p className="text-[10px] font-bold tracking-[0.2em] uppercase mb-2"
           style={{ color: 'var(--color-accent)' }}>
          Future Marketing Studio
        </p>
        <p className="text-lg font-bold" style={{ color: 'var(--color-text-1)' }}>
          Future Insights
        </p>
      </div>
      <div className="flex items-center gap-2">
        {[0, 1, 2].map(i => (
          <div key={i}
               className="w-2 h-2 rounded-full pulse-dot"
               style={{ background: 'var(--color-accent)', animationDelay: `${i * 0.25}s` }} />
        ))}
      </div>
      <p className="text-sm" style={{ color: 'var(--color-text-3)' }}>Loading intelligence data…</p>
    </div>
  )
}

function ErrorScreen() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4"
         style={{ background: 'var(--color-bg)' }}>
      <div className="w-12 h-12 rounded-xl flex items-center justify-center text-xl"
           style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)' }}>
        ⚠
      </div>
      <div className="text-center">
        <p className="font-semibold text-sm" style={{ color: 'var(--color-text-1)' }}>
          Failed to load review data
        </p>
        <p className="text-sm mt-1" style={{ color: 'var(--color-text-2)' }}>
          Please refresh. If this persists, check the Scraper Status page.
        </p>
      </div>
      <button onClick={() => window.location.reload()}
              className="badge badge-accent cursor-pointer hover:opacity-80 transition-opacity text-xs px-4 py-2">
        Retry
      </button>
    </div>
  )
}

function RootLayout() {
  useGlobalPrefetch()
  const { data: allReviews, isLoading, isError } = useReviewsData()
  const [filters, setFilters] = useState(null)
  const location = useLocation()

  useEffect(() => {
    if (allReviews && !filters) setFilters(buildDefaultFilters(allReviews))
  }, [allReviews, filters])

  const filtered = useMemo(() => {
    if (!allReviews || !filters) return []
    return filterReviews(allReviews, filters)
  }, [allReviews, filters])

  const prevFiltered = useMemo(() => {
    if (!allReviews || !filters?.start || !filters?.end) return []
    const startMs = new Date(filters.start).getTime()
    const endMs   = new Date(filters.end).getTime()
    const lenMs   = endMs - startMs
    return filterReviews(allReviews, {
      ...filters,
      start: new Date(startMs - lenMs - 1).toISOString().slice(0, 10),
      end:   new Date(startMs - 1).toISOString().slice(0, 10),
    })
  }, [allReviews, filters])

  const periodLabel = useMemo(() => {
    if (!filters?.start || !filters?.end) return 'All time'
    return `${filters.start} — ${filters.end}`
  }, [filters])

  const unansweredCount = useUnansweredCount(allReviews || [])

  if (isLoading || !filters) return <LoadingScreen />
  if (isError) return <ErrorScreen />

  const showFilterBar = !NO_FILTER_PATHS.some(p => location.pathname.startsWith(p))

  return (
    <Layout unansweredCount={unansweredCount}>
      {showFilterBar && (
        <div className="mb-6 space-y-3">
          <GlobalFilters allReviews={allReviews} filters={filters} onChange={setFilters} />
          <div className="flex items-center gap-2.5">
            <span className="badge badge-neutral">
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: 'var(--color-accent)' }} />
              {periodLabel}
            </span>
            <span className="text-xs font-medium" style={{ color: 'var(--color-text-3)' }}>
              {filtered.length.toLocaleString()} reviews
            </span>
          </div>
        </div>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={location.pathname}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
        >
          <Outlet context={{ allReviews, filtered, prevFiltered, filters }} />
        </motion.div>
      </AnimatePresence>
    </Layout>
  )
}

export default function App() {
  return (
    <Routes>
      <Route element={<RootLayout />}>
        <Route index                    element={<Navigate to="/overview" replace />} />
        <Route path="overview"          element={<ROverview />} />
        <Route path="locations"         element={<RLocations />} />
        <Route path="explorer"          element={<RExplorer />} />
        <Route path="actions"           element={<RActions />} />
        <Route path="intelligence"      element={<ComplaintIntelligence />} />
        <Route path="competitive"       element={<CompetitorIntelligence />} />
        <Route path="marketing-intel"   element={<MarketingIntelligence />} />
        <Route path="employee-intel"    element={<EmployeeIntelligence />} />
        <Route path="advisor"           element={<AIAdvisor />} />
        <Route path="trends"            element={<RTrends />} />
        <Route path="alerts"            element={<Alerts />} />
        <Route path="executive-reports" element={<ExecutiveReports />} />
        <Route path="reports"           element={<Reports />} />
        <Route path="scraper-status"    element={<RScraper />} />
        <Route path="settings"          element={<Settings />} />
        {/* Legacy redirects */}
        <Route path="rankings"   element={<Navigate to="/trends"      replace />} />
        <Route path="insights"   element={<Navigate to="/intelligence" replace />} />
        <Route path="validation" element={<Navigate to="/scraper-status" replace />} />
        <Route path="*"          element={<Navigate to="/overview"    replace />} />
      </Route>
    </Routes>
  )
}

function ROverview()   { const { allReviews, filtered } = useOutletContext(); return <Overview allReviews={allReviews} filtered={filtered} /> }
function RLocations()  { const c = useOutletContext(); return <LocationDetail allReviews={c.allReviews} filtered={c.filtered} filters={c.filters} /> }
function RExplorer()   { const { allReviews, filtered } = useOutletContext(); return <ReviewExplorer allReviews={allReviews} filtered={filtered} /> }
function RTrends()     { const c = useOutletContext(); return <TrendsAnalytics allReviews={c.allReviews} filtered={c.filtered} prevFiltered={c.prevFiltered} /> }
function RActions()    { const { allReviews } = useOutletContext(); return <ActionItems allReviews={allReviews} /> }
function RScraper()    { const { allReviews } = useOutletContext(); return <ScraperStatus allReviews={allReviews} /> }
