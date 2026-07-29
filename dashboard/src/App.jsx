import { useMemo, useEffect, useState, lazy, Suspense } from 'react'
import { Routes, Route, Navigate, Outlet, useLocation, useOutletContext } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import Layout               from './components/Layout.jsx'
import GlobalFilters        from './components/GlobalFilters.jsx'
import Skeleton              from './components/ui/Skeleton.jsx'
import { useAccount }        from './components/AuthGate.jsx'
import { useReviewsData }    from './hooks/useReviewsData.js'
import { useGlobalPrefetch } from './hooks/useIntelligence.js'
import { useUnansweredCount } from './hooks/useReviewWorkspace.js'
import { filterReviews, getDefaultDateRange } from './utils/dataUtils.js'
import { settingsSections } from './pages/settings/settingsSections.js'

// Route-level code-splitting -- each page ships in its own chunk, fetched
// only when its route is visited, instead of one ~480KB bundle up front.
// M4: Today merges Overview/Executive Dashboard/Executive Intelligence
// Center/Activity Timeline content behind one route. Their page files stay
// on disk, fully working, for the rollback path the Execution Master Plan
// v1.0 describes ("redirect /today back to /overview") -- they're just no
// longer imported here since no route renders them directly anymore.
const Today                  = lazy(() => import('./pages/Today.jsx'))
const LocationDetail         = lazy(() => import('./pages/LocationDetail.jsx'))
// M5: Reviews replaces ReviewExplorer at /reviews. ReviewExplorer.jsx stays on
// disk, fully working, for the same rollback path M4's retired pages use --
// just no longer imported here since no route renders it directly anymore.
const Reviews                = lazy(() => import('./pages/Reviews.jsx'))
const TrendsAnalytics        = lazy(() => import('./pages/TrendsAnalytics.jsx'))
const ScraperStatus          = lazy(() => import('./pages/ScraperStatus.jsx'))
const ComplaintIntelligence  = lazy(() => import('./pages/ComplaintIntelligence.jsx'))
const DepartmentPerformance  = lazy(() => import('./pages/DepartmentPerformance.jsx'))
const ActionCenter           = lazy(() => import('./pages/ActionCenter.jsx'))
const OperationsImpact       = lazy(() => import('./pages/OperationsImpact.jsx'))
const WhatChanged            = lazy(() => import('./pages/WhatChanged.jsx'))
const CompetitorIntelligence = lazy(() => import('./pages/CompetitorIntelligence.jsx'))
const Alerts                 = lazy(() => import('./pages/Alerts.jsx'))
const MarketingIntelligence  = lazy(() => import('./pages/MarketingIntelligence.jsx'))
const EmployeeIntelligence   = lazy(() => import('./pages/EmployeeIntelligence.jsx'))
const ExecutiveReports       = lazy(() => import('./pages/ExecutiveReports.jsx'))
const SettingsLayout         = lazy(() => import('./pages/settings/SettingsLayout.jsx'))

function RouteFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
    </div>
  )
}

// Pages that don't use the global review filter bar. M4 bug fix: this list
// still had the pre-M3 path names (/intelligence, /action-center,
// /marketing-intel, /executive-reports) after M3 renamed those routes to
// /insights, /actions, /studio, /reports -- meaning the filter bar had been
// incorrectly showing on all four pages since M3 shipped. /executive-dashboard
// is dropped (it's now a pure redirect to /today, which does want the filter
// bar, matching Overview.jsx's prior un-excluded behavior).
const NO_FILTER_PATHS = [
  '/scraper-status', '/insights', '/department-performance', '/actions',
  '/operations-impact', '/competitive', '/alerts', '/studio',
  '/employee-intel', '/reports', '/settings',
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
  const account = useAccount()
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

  const unansweredCount = useUnansweredCount()

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
          <Suspense fallback={<RouteFallback />}>
            <Outlet context={{ allReviews, filtered, prevFiltered, filters, account }} />
          </Suspense>
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

        {/* ── Final 8-item navigation destinations. M4: /today now ships its
             real merged content (Today.jsx). Insights remains an interim
             alias onto the existing page that best represents its merge
             target until M8 ships its real merged content. ── */}
        <Route path="today"    element={<Today />} />
        <Route path="reviews"  element={<RReviews />} />
        <Route path="actions"  element={<ActionCenter />} />
        <Route path="insights" element={<ComplaintIntelligence />} />
        <Route path="studio"   element={<MarketingIntelligence />} />
        <Route path="reports"  element={<ExecutiveReports />} />
        <Route path="locations"         element={<RLocations />} />
        <Route path="settings" element={<SettingsLayout />}>
          {settingsSections.map(s => {
            const Component = s.component
            return s.path === ''
              ? <Route key={s.id} index element={<Component />} />
              : <Route key={s.id} path={s.path} element={<Component />} />
          })}
        </Route>

        {/* Pages not yet migrated -- still live at their existing routes,
            content unchanged. Each redirects to its new home once its own
            content milestone (M7/M8) lands. */}
        <Route path="department-performance" element={<DepartmentPerformance />} />
        <Route path="operations-impact" element={<OperationsImpact />} />
        <Route path="what-changed"      element={<WhatChanged />} />
        <Route path="competitive"       element={<CompetitorIntelligence />} />
        <Route path="employee-intel"    element={<EmployeeIntelligence />} />
        <Route path="trends"            element={<RTrends />} />
        {/* Alerts is explicitly NOT merged into Today (Execution Master Plan
            v1.0 M4.4) -- it stays live here as a standalone secondary view,
            linked from Today's Needs Attention section. */}
        <Route path="alerts"            element={<Alerts />} />
        <Route path="scraper-status"    element={<RScraper />} />

        {/* Legacy redirects (pre-existing, untouched) */}
        <Route path="rankings"   element={<Navigate to="/trends"      replace />} />
        <Route path="validation" element={<Navigate to="/scraper-status" replace />} />
        <Route path="advisor"    element={<Navigate to="/overview"    replace />} />

        {/* M3 migration redirects -- old route superseded by a new, final
            destination serving identical content */}
        <Route path="executive-intelligence" element={<Navigate to="/today"    replace />} />
        <Route path="intelligence"           element={<Navigate to="/insights" replace />} />
        <Route path="explorer"               element={<RedirectPreservingSearch to="/reviews" />} />
        <Route path="action-center"          element={<Navigate to="/actions" replace />} />
        <Route path="marketing-intel"        element={<Navigate to="/studio"  replace />} />
        <Route path="executive-reports"      element={<Navigate to="/reports" replace />} />

        {/* M4 migration redirects -- Today now carries this content (Execution
            Master Plan v1.0 M4.4). /alerts is deliberately excluded above. */}
        <Route path="overview"            element={<Navigate to="/today" replace />} />
        <Route path="executive-dashboard" element={<Navigate to="/today" replace />} />
        <Route path="activity"            element={<Navigate to="/today" replace />} />

        <Route path="*"          element={<Navigate to="/overview"    replace />} />
      </Route>
    </Routes>
  )
}

function RLocations()  { const c = useOutletContext(); return <LocationDetail allReviews={c.allReviews} filtered={c.filtered} prevFiltered={c.prevFiltered} filters={c.filters} /> }
function RReviews()    { const { allReviews, filtered, prevFiltered } = useOutletContext(); return <Reviews allReviews={allReviews} filtered={filtered} prevFiltered={prevFiltered} /> }
function RTrends()     { const c = useOutletContext(); return <TrendsAnalytics allReviews={c.allReviews} filtered={c.filtered} prevFiltered={c.prevFiltered} /> }
function RScraper()    { const { allReviews } = useOutletContext(); return <ScraperStatus allReviews={allReviews} /> }

// M5 bug fix: a plain <Navigate to="/reviews" replace /> drops the current
// URL's query string, silently breaking /explorer?reviewId=X deep links
// (used by the email-followup priority item, Action Center's "Open review"
// links, and Activity History) the moment the redirect fires. Preserves
// location.search across the redirect instead.
function RedirectPreservingSearch({ to }) {
  const location = useLocation()
  return <Navigate to={{ pathname: to, search: location.search }} replace />
}
