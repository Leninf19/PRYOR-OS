import { useMemo, useEffect, useState, useRef, lazy, Suspense } from 'react'
import { Routes, Route, Navigate, Outlet, useLocation, useOutletContext, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import Layout               from './components/Layout.jsx'
import GlobalFilters        from './components/GlobalFilters.jsx'
import Skeleton              from './components/ui/Skeleton.jsx'
import { useAccount }        from './components/AuthGate.jsx'
import { useReviewsData }    from './hooks/useReviewsData.js'
import { useGlobalPrefetch } from './hooks/useIntelligence.js'
import { useUnansweredCount } from './hooks/useReviewWorkspace.js'
import { filterReviews, getDefaultDateRange, getUniqueLocations } from './utils/dataUtils.js'
import { isLocationScoped } from './hooks/useIntelligence.js'
import {
  parseFiltersFromSearchParams, loadStoredFilters, saveStoredFilters, clearStoredFilters,
  withFreshDefaults, buildSearchParamsFromFilters, stripFilterParams, restrictLocationsToAllowed,
  resolveDateRangeWithExpiration,
} from './utils/filterPersistence.js'
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
// Operations Calendar + Content Library milestone: Calendar.jsx replaces
// Actions.jsx as the primary /calendar experience. Actions.jsx stays on
// disk, fully working, and gets its own explicit rollback route
// (/actions-legacy, one release cycle) rather than going fully unrouted
// like the M4/M5 retired pages -- the existing AI Action Center pipeline
// underneath it is unchanged and still worth a direct escape hatch.
const Actions                = lazy(() => import('./pages/Actions.jsx'))
const Calendar                = lazy(() => import('./pages/Calendar.jsx'))
const Content                 = lazy(() => import('./pages/Content.jsx'))
const OperationsImpact       = lazy(() => import('./pages/OperationsImpact.jsx'))
const WhatChanged            = lazy(() => import('./pages/WhatChanged.jsx'))
const CompetitorIntelligence = lazy(() => import('./pages/CompetitorIntelligence.jsx'))
const Alerts                 = lazy(() => import('./pages/Alerts.jsx'))
const MarketingIntelligence  = lazy(() => import('./pages/MarketingIntelligence.jsx'))
const EmployeeIntelligence   = lazy(() => import('./pages/EmployeeIntelligence.jsx'))
const ExecutiveReports       = lazy(() => import('./pages/ExecutiveReports.jsx'))
const SettingsLayout         = lazy(() => import('./pages/settings/SettingsLayout.jsx'))
// Today UX Simplification: Activity History moves off Today (a "what do I
// act on today" command center) back to its own page -- ActivityTimeline.jsx
// already existed for exactly this content (pre-M4) and needs no changes,
// it just gets a live route again instead of redirecting to /today.
const ActivityTimeline       = lazy(() => import('./pages/ActivityTimeline.jsx'))

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
// Operations Calendar + Content Library milestone: /calendar and /content
// replace /actions in this list -- both have their own dedicated filter
// UIs (location/assignee/type/status/priority/date/campaign for Calendar;
// location/campaign/type/status/date/tags for Content), unrelated to the
// global review date-range/location/brand/star bar. /actions-legacy is
// added (the rollback path keeps its own prior behavior).
const NO_FILTER_PATHS = [
  '/scraper-status', '/insights', '/department-performance', '/actions-legacy', '/calendar', '/content',
  '/operations-impact', '/competitive', '/alerts', '/studio',
  '/employee-intel', '/reports', '/settings',
]

function buildDefaultFilters(reviews) {
  return withFreshDefaults(null, getDefaultDateRange(reviews))
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

// Recovery Milestone (Global Filter Persistence): the URL is the reactive
// source of truth once mounted -- both a user-driven filter change AND a
// browser back/forward navigation land here the same way (searchParams
// changing), and both are resolved through the exact same priority chain
// (URL -> localStorage -> computed defaults), so there is only ever one
// code path deciding what `filters` should be, never two that could
// disagree. Writes flow OUT through setSearchParams (see handleFilterChange
// below); this effect never itself calls setSearchParams except in the
// "URL had no filter params at all" branch, where it reflects whatever it
// resolved (localStorage or defaults) back into the CURRENT url so the
// address bar is always an accurate, shareable snapshot of what's actually
// showing -- including right after a plain <Link> navigation to a page
// that never had filter params of its own.
function useFilterPersistence(allReviews, account) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [filters, setFilters] = useState(null)
  // Multi-Location Authentication & User Access System (Phase 10): never
  // trust a URL query parameter or localStorage for authorization -- the
  // server/session's allowed locations are authoritative. `allReviews`
  // itself is already server-side scoped (dashboard/api/data.js filters
  // meta.json/reviews.by-location for a scoped account), so the set of
  // location names actually present in it can never contain an
  // unauthorized name; intersecting a stored/URL `locations` value against
  // it is a pure narrowing, never a widening, of what a scoped account can
  // select. null (company-wide account) means "no restriction."
  const scoped = isLocationScoped(account)
  // Memoized -- getUniqueLocations() would otherwise return a new array
  // reference every render, which as a useEffect dependency below would
  // re-run that effect (and its setSearchParams call) on every single
  // render instead of only when the underlying review data actually changes.
  const allowedLocationNames = useMemo(
    () => (scoped ? getUniqueLocations(allReviews ?? []) : null),
    [scoped, allReviews]
  )
  // Set for exactly one effect pass right after handleResetFilters strips
  // the URL, so that pass resolves `filters` to fresh computed defaults
  // WITHOUT also writing them back into the URL as explicit params -- the
  // whole point of Reset is that the address bar visibly goes back to
  // having no filter params at all, not "no params for an instant, then
  // immediately refilled with today's computed dates." Every other "URL
  // has no filter params" case (a genuinely bare bookmark/first visit)
  // still gets its resolved state reflected back for shareability.
  const justReset = useRef(false)

  // Global Filter Expiration / Rolling Date Default: a custom date range
  // only lives for DATE_RANGE_EXPIRY_MS past when it was last deliberately
  // accepted (see resolveDateRangeWithExpiration's own header for the full
  // acceptance/reflection/expiry rules) -- locations/brands/stars are
  // untouched by any of this and keep persisting exactly as before.
  // `expiryTick` exists solely so the dashboard can self-correct while a
  // tab stays open across the hour mark, without polling: a single
  // setTimeout scheduled to the known expiration (see the effect below)
  // bumps this, which re-runs the resolution effect with a fresh
  // Date.now() -- the persisted `dateExpiresAt` remains the actual source
  // of truth either way, so this is a convenience, not a requirement (every
  // refresh/navigation/filter-state resolution already re-checks it).
  const [expiryTick, setExpiryTick] = useState(0)

  useEffect(() => {
    if (!allReviews) return
    const dr = getDefaultDateRange(allReviews)
    const now = Date.now()
    const fromUrl = parseFiltersFromSearchParams(searchParams)
    const stored = loadStoredFilters()

    if (fromUrl) {
      const dateResult = resolveDateRangeWithExpiration({
        urlPresent: true, urlStart: fromUrl.start, urlEnd: fromUrl.end, stored, now, defaultDateRange: dr,
      })
      const merged = { ...fromUrl, start: dateResult.start, end: dateResult.end }
      const resolved = restrictLocationsToAllowed(withFreshDefaults(merged, dr), allowedLocationNames)
      setFilters({ ...resolved, _dateExpiresAt: dateResult.dateExpiresAt })
      // Persists the AUTHORIZATION-NARROWED `resolved.locations`, never
      // `merged.locations` -- a URL a scoped account was handed (or typed)
      // can carry another restaurant's name, and that must never survive
      // into localStorage/a later bare-visit resolution even inertly.
      // mirror to localStorage so a later bare visit reflects this
      saveStoredFilters({ start: resolved.start, end: resolved.end, locations: resolved.locations, brands: resolved.brands, stars: resolved.stars, dateExpiresAt: dateResult.dateExpiresAt })
      if (dateResult.expired) {
        // The address bar still carries the now-lapsed start/end -- rewrite
        // it to the just-recomputed rolling default rather than letting a
        // stale query string keep resolving to an old frozen range forever.
        setSearchParams(buildSearchParamsFromFilters(resolved, searchParams), { replace: true })
      }
      return
    }

    const dateResult = resolveDateRangeWithExpiration({
      urlPresent: false, urlStart: null, urlEnd: null, stored, now, defaultDateRange: dr,
    })
    const merged = { ...stored, start: dateResult.start, end: dateResult.end }
    const resolved = restrictLocationsToAllowed(withFreshDefaults(merged, dr), allowedLocationNames)
    setFilters({ ...resolved, _dateExpiresAt: dateResult.dateExpiresAt })
    if (justReset.current) {
      // Reset just cleared localStorage and stripped the URL -- this pass
      // must leave both genuinely empty (not immediately repopulate them
      // with today's freshly-computed defaults), matching handleResetFilters'
      // own contract below.
      justReset.current = false
      return
    }
    // See the fromUrl branch above for why this persists resolved.locations
    // (authorization-narrowed), never merged.locations (raw storage/URL).
    saveStoredFilters({ start: resolved.start, end: resolved.end, locations: resolved.locations, brands: resolved.brands, stars: resolved.stars, dateExpiresAt: dateResult.dateExpiresAt })
    // No filter params were in the URL -- reflect the resolved state (from
    // localStorage, or fresh defaults) into it now, without adding a
    // history entry, so the address bar is immediately accurate/shareable.
    setSearchParams(buildSearchParamsFromFilters(resolved, searchParams), { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- searchParams
    // is intentionally read fresh each run, not a reactive dependency in
    // the usual sense (see module docstring above) -- adding it here would
    // make the "write resolved defaults back" branch above re-trigger this
    // same effect an extra, harmless-but-pointless time; it's still
    // correctly re-run on every REAL searchParams change because useSearchParams
    // itself causes this component to re-render with a new searchParams value.
    // `expiryTick` is a deliberate extra trigger (see its own comment above) --
    // bumping it re-runs this exact same resolution logic with a fresh `now`.
  }, [allReviews, searchParams, allowedLocationNames, expiryTick])

  // Single scheduled timeout to the known expiration -- not a recurring
  // countdown/poll, and cleaned up (cleared) whenever the expiration moves
  // or this unmounts. Purely a live-tab convenience; see expiryTick's own
  // comment above for why the persisted timestamp remains authoritative
  // regardless of whether this timer ever fires.
  useEffect(() => {
    const expiresAt = filters?._dateExpiresAt
    if (!Number.isFinite(expiresAt)) return
    const msRemaining = expiresAt - Date.now()
    if (msRemaining <= 0) { setExpiryTick(t => t + 1); return }
    const id = setTimeout(() => setExpiryTick(t => t + 1), msRemaining)
    return () => clearTimeout(id)
  }, [filters?._dateExpiresAt])

  // A normal filter edit (date input, pill toggle, preset click) -- writes
  // the change into the URL; the effect above picks up the resulting
  // searchParams change and updates `filters` state as a consequence. Uses
  // `replace` so tweaking filters doesn't spam browser history -- back/
  // forward still works correctly at the granularity of actual page
  // navigations, each of which carries its own filter snapshot in its URL.
  function handleFilterChange(next) {
    setSearchParams(buildSearchParamsFromFilters(next, searchParams), { replace: true })
  }

  // Reset Filters: strips the 5 filter keys from the URL entirely (rather
  // than writing today's computed defaults back in as explicit params, which
  // would freeze them and defeat the point of a "no params = fresh defaults"
  // reset) and clears localStorage, so both persistence layers agree there is
  // nothing saved and the very next resolution recomputes a genuinely fresh
  // default from current data -- see justReset above for why that one
  // resolution pass doesn't re-populate the URL it was just asked to clear.
  function handleResetFilters() {
    clearStoredFilters()
    justReset.current = true
    setSearchParams(stripFilterParams(searchParams), { replace: true })
  }

  return { filters, handleFilterChange, handleResetFilters }
}

function RootLayout() {
  useGlobalPrefetch()
  const account = useAccount()
  const { data: allReviews, isLoading, isError } = useReviewsData()
  const { filters, handleFilterChange, handleResetFilters } = useFilterPersistence(allReviews, account)
  const location = useLocation()

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
          <GlobalFilters allReviews={allReviews} filters={filters} onChange={handleFilterChange} onReset={handleResetFilters} />
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
        {/* Operations Calendar + Content Library milestone: Calendar
            replaces Actions as the primary /calendar destination. /actions
            now redirects here (see the M3-style migration redirects below);
            /actions-legacy keeps the old UI reachable for one release
            cycle. The underlying AI Action Center pipeline (actionStore.js,
            action-center.json) is completely unchanged either way. */}
        <Route path="calendar" element={<Calendar />} />
        <Route path="content"  element={<Content />} />
        <Route path="actions-legacy" element={<Actions />} />
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
        {/* Operations Calendar + Content Library milestone: both old
            aliases for the AI Action Center now land on Calendar, its new
            live home (AI Suggestions section) -- /actions itself is no
            longer the primary destination, /actions-legacy is. */}
        <Route path="actions"                element={<Navigate to="/calendar" replace />} />
        <Route path="action-center"          element={<Navigate to="/calendar" replace />} />
        <Route path="marketing-intel"        element={<Navigate to="/studio"  replace />} />
        <Route path="executive-reports"      element={<Navigate to="/reports" replace />} />

        {/* M4 migration redirects -- Today now carries this content (Execution
            Master Plan v1.0 M4.4). /alerts is deliberately excluded above. */}
        <Route path="overview"            element={<Navigate to="/today" replace />} />
        <Route path="executive-dashboard" element={<Navigate to="/today" replace />} />
        {/* Today UX Simplification: un-redirected -- Activity History moved
            back off Today onto its own page, exactly where it lived pre-M4. */}
        <Route path="activity"            element={<ActivityTimeline />} />

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
