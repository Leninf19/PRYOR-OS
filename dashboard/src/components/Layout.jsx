import { useState, useEffect, useRef } from 'react'
import { NavLink, Link, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useMeta, usePredictiveAlerts, useActionItems } from '../hooks/useIntelligence.js'
import { useGoogleOAuthStatus } from '../hooks/useGoogleOAuthStatus.js'
import ThemeToggle from './ui/ThemeToggle.jsx'
import SmartSearch from './SmartSearch.jsx'
import LogoutButton from './LogoutButton.jsx'

// ── Icons (inline SVG, 15×15, Heroicons solid) ────────────────────────────────

const I = {
  overview:    <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M2 10a8 8 0 018-8v8h8a8 8 0 11-16 0z"/><path d="M12 2.252A8.014 8.014 0 0117.748 8H12V2.252z"/></svg>,
  locations:   <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M9.293 2.293a1 1 0 011.414 0l7 7A1 1 0 0117 11h-1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-3a1 1 0 00-1-1H9a1 1 0 00-1 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-6H3a1 1 0 01-.707-1.707l7-7z" clipRule="evenodd"/></svg>,
  reviews:     <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M2 5a2 2 0 012-2h8a2 2 0 012 2v10a2 2 0 002 2H4a2 2 0 01-2-2V5zm3 1h6v4H5V6zm6 6H5v2h6v-2z" clipRule="evenodd"/><path d="M15 7h1a2 2 0 012 2v5.5a1.5 1.5 0 01-3 0V7z"/></svg>,
  complaint:   <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M3 3a1 1 0 000 2v8a2 2 0 002 2h2.586l-1.293 1.293a1 1 0 101.414 1.414L10 15.414l2.293 2.293a1 1 0 001.414-1.414L12.414 15H15a2 2 0 002-2V5a1 1 0 100-2H3zm11 4a1 1 0 10-2 0v4a1 1 0 102 0V7zm-3 1a1 1 0 10-2 0v3a1 1 0 102 0V8zM8 9a1 1 0 00-2 0v2a1 1 0 102 0V9z" clipRule="evenodd"/></svg>,
  department:  <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M4 4a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H8v2h5a1 1 0 011 1v3h1a1 1 0 110 2h-6a1 1 0 110-2h1v-2H8v2h1a1 1 0 110 2H3a1 1 0 110-2h1v-3a1 1 0 011-1h5V9H8a1 1 0 01-1-1V4H5v3a1 1 0 11-2 0V4z" clipRule="evenodd"/></svg>,
  actioncenter: <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M6 3a1 1 0 00-1 1v1H4a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h-1V4a1 1 0 10-2 0v1H7V4a1 1 0 00-1-1zm8.707 5.293a1 1 0 00-1.414-1.414L9 11.172l-1.293-1.293a1 1 0 10-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/></svg>,
  opsimpact:   <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M3 3a1 1 0 00-1 1v12a1 1 0 001 1h14a1 1 0 100-2H4V4a1 1 0 00-1-1z"/><path d="M6 15a1 1 0 01-1-1v-3a1 1 0 112 0v3a1 1 0 01-1 1zm4 0a1 1 0 01-1-1V8a1 1 0 112 0v6a1 1 0 01-1 1zm4 0a1 1 0 01-1-1v-5a1 1 0 112 0v5a1 1 0 01-1 1zm4 0a1 1 0 01-1-1V5a1 1 0 112 0v9a1 1 0 01-1 1z"/></svg>,
  whatchanged: <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M4 3a1 1 0 00-1 1v3a1 1 0 001 1h3a1 1 0 100-2H6.414A6.985 6.985 0 0110 5c2.4 0 4.462 1.469 5.325 3.556a1 1 0 101.848-.764A9 9 0 004 4.83V4a1 1 0 00-1-1zm12 8a1 1 0 00-1 1v.17A6.985 6.985 0 0110 15a6.985 6.985 0 01-5.325-2.444 1 1 0 10-1.593 1.208A9 9 0 0016 15.17V16a1 1 0 102 0v-3a1 1 0 00-1-1h-1z" clipRule="evenodd"/></svg>,
  execdash:    <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M10 2a1 1 0 011 1v6h6a1 1 0 011 1 8 8 0 11-8-8z"/><path d="M12.5 1.5a1 1 0 011-1A7.5 7.5 0 0121 8a1 1 0 01-1 1h-6.5a1 1 0 01-1-1V1.5z"/></svg>,
  competitive: <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>,
  marketing:   <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M18 3a1 1 0 00-1.447-.894L8.763 6H5a3 3 0 000 6h.28l1.771 5.316A1 1 0 008 18h1a1 1 0 001-1v-4.382l6.553 3.276A1 1 0 0018 15V3z"/></svg>,
  employee:    <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v3h8v-3zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-3a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v3h-3zM4.75 12.094A5.973 5.973 0 004 15v3H1v-3a3 3 0 013.75-2.906z"/></svg>,
  advisor:     <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.381z" clipRule="evenodd"/></svg>,
  response:    <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M2 5a2 2 0 012-2h7a2 2 0 012 2v4a2 2 0 01-2 2H9l-3 3v-3H4a2 2 0 01-2-2V5z"/><path d="M15 7v2a4 4 0 01-4 4H9.828l-1.766 1.767c.28.149.599.233.938.233h2l3 3v-3h2a2 2 0 002-2V9a2 2 0 00-2-2h-1z"/></svg>,
  trends:      <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"/></svg>,
  alerts:      <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z"/></svg>,
  execreports: <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V7.414A2 2 0 0015.414 6L12 2.586A2 2 0 0010.586 2H6zm2 10a1 1 0 10-2 0v3a1 1 0 102 0v-3zm2-3a1 1 0 011 1v5a1 1 0 11-2 0v-5a1 1 0 011-1zm4-1a1 1 0 10-2 0v6a1 1 0 102 0V8z" clipRule="evenodd"/></svg>,
  reports:     <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V7.414A2 2 0 0015.414 6L12 2.586A2 2 0 0010.586 2H6zm2 10a1 1 0 10-2 0v3a1 1 0 102 0v-3zm2-3a1 1 0 011 1v5a1 1 0 11-2 0v-5a1 1 0 011-1zm4-1a1 1 0 10-2 0v6a1 1 0 102 0V8z" clipRule="evenodd"/></svg>,
  scraper:     <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd"/></svg>,
  settings:    <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M5 4a1 1 0 00-2 0v7.268a2 2 0 000 3.464V16a1 1 0 102 0v-1.268a2 2 0 000-3.464V4zM11 4a1 1 0 10-2 0v1.268a2 2 0 000 3.464V16a1 1 0 102 0V8.732a2 2 0 000-3.464V4zM16 3a1 1 0 011 1v7.268a2 2 0 010 3.464V16a1 1 0 11-2 0v-1.268a2 2 0 010-3.464V4a1 1 0 011-1z"/></svg>,
  activity:    <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd"/></svg>,
  execintel:   <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z"/></svg>,
}

// ── Navigation (M3: flat 8-item structure per Navigation Specification v1.0.
//    Today and Insights are interim aliases onto the existing page that best
//    represents each merge target until M4/M8 ship their real merged content;
//    see App.jsx's /today and /insights routes.) ──────────────────────────────

const NAV_ITEMS = [
  { id: 'today',     path: '/today',     label: 'Today',     icon: I.execintel },
  { id: 'reviews',   path: '/reviews',   label: 'Reviews',   icon: I.response, badge: 'unanswered' },
  { id: 'actions',   path: '/actions',   label: 'Actions',   icon: I.actioncenter },
  { id: 'locations', path: '/locations', label: 'Locations', icon: I.locations },
  { id: 'insights',  path: '/insights',  label: 'Insights',  icon: I.trends },
  { id: 'studio',    path: '/studio',    label: 'Studio',    icon: I.marketing },
  { id: 'reports',   path: '/reports',   label: 'Reports',   icon: I.reports },
  { id: 'settings',  path: '/settings',  label: 'Settings',  icon: I.settings },
]

// Flat list used for "current page" label lookup
const NAV_FLAT = NAV_ITEMS

// ── Compact snapshot bar ──────────────────────────────────────────────────────

function SnapshotBar() {
  const { data: meta }    = useMeta()
  const { data: alerts, isError: alertsError }   = usePredictiveAlerts()
  const { data: actions, isError: actionsError } = useActionItems()
  // Design System Specification v1.0, Phase 7 -- the single canonical
  // Google-connection source. Alerts.jsx and ScraperStatus.jsx each still
  // independently render their own copy of this same signal (out of scope
  // for M2, which only touches Layout.jsx/Breadcrumb.jsx) -- this is the
  // one persistent, always-visible indicator reachable from every page.
  const { data: googleStatusData, isLoading: googleStatusLoading, isError: googleStatusIsError } = useGoogleOAuthStatus()
  const googleConnected = googleStatusData?.connected ?? false
  const googleStatusText = googleStatusLoading
    ? 'Checking Google…'
    : googleStatusIsError
      ? 'Google status unavailable'
      : googleConnected ? 'Google Connected' : 'Google Not Connected'

  const now        = new Date()
  const dateLabel  = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  const totalLocs  = meta?.locations?.length ?? '—'
  const totalRevs  = meta?.totalReviews != null ? meta.totalReviews.toLocaleString() : '—'
  const alertCount = Array.isArray(alerts) ? alerts.length : (alerts?.alerts?.length ?? 0)
  const backlog    = actions?.unanswered?.length ?? 0

  const lastRun = meta?.generatedAt
    ? (() => {
        const d = new Date(meta.generatedAt)
        const diffH = Math.round((now - d) / 3600000)
        return diffH < 1 ? 'Just now' : diffH < 24 ? `${diffH}h ago` : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      })()
    : null

  const pills = [
    { label: dateLabel, dimmed: false },
    lastRun && { label: `Updated ${lastRun}`, dimmed: true },
    { label: `${totalLocs} locations`, dimmed: true },
    { label: `${totalRevs} reviews`, dimmed: true },
    alertCount > 0 && { label: `${alertCount} alerts`, color: 'var(--color-warning)', dot: true },
    backlog > 0 && { label: `${backlog} need reply`, color: 'var(--color-danger)', dot: true },
  ].filter(Boolean)

  return (
    <div className="no-print hidden lg:flex items-center gap-4 px-8 py-2 flex-shrink-0 overflow-x-auto"
         style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }}>
      {pills.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5 flex-shrink-0">
          {p.dot && (
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: p.color }} />
          )}
          <span className="text-[10px] font-medium"
                style={{ color: p.color ?? (p.dimmed ? 'var(--color-text-3)' : 'var(--color-text-2)') }}>
            {p.label}
          </span>
          {i < pills.length - 1 && (
            <span className="ml-2 text-[10px]" style={{ color: 'var(--color-border)' }}>·</span>
          )}
        </div>
      ))}

      {/* Connection status -- persistent, always shown (unlike the alert/
          backlog pills above, which only appear when non-zero) */}
      <Link to="/settings/google" className="flex items-center gap-1.5 flex-shrink-0"
            aria-label={`Google Business Profile connection: ${googleStatusText}. View settings.`}>
        <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: googleStatusLoading || googleStatusIsError ? 'var(--color-text-3)' : googleConnected ? 'var(--color-success)' : 'var(--color-danger)' }} />
        <span aria-hidden="true" className="text-[10px] font-medium" style={{ color: 'var(--color-text-2)' }}>
          {googleStatusText}
        </span>
      </Link>

      <NotificationBell alerts={alerts} actions={actions} hasError={alertsError || actionsError} />
    </div>
  )
}

// ── Notification bell ────────────────────────────────────────────────────────

function NotificationBell({ alerts, actions, hasError }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef(null)
  const alertList  = Array.isArray(alerts) ? alerts : (alerts?.alerts ?? [])
  const unanswered = actions?.unanswered ?? []
  const count = alertList.length + unanswered.length
  const label = `Notifications${count > 0 ? `, ${count} item${count === 1 ? '' : 's'}` : ''}`

  useEffect(() => {
    if (!open) return
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <div className="relative ml-auto flex-shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className="relative p-1.5 rounded-lg hover:bg-[var(--color-surface-2)]"
        aria-label={label}
        aria-expanded={open}
        aria-controls="notification-bell-panel"
        style={{ color: 'var(--color-text-2)' }}
      >
        <span aria-hidden="true">{I.alerts}</span>
        {count > 0 && (
          <span aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 text-white text-[9px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5"
                style={{ background: 'var(--color-danger)' }}>
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div id="notification-bell-panel"
               className="absolute right-0 top-full mt-2 w-80 max-h-96 overflow-y-auto rounded-xl z-50"
               style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-lg)' }}>
            <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
              <p className="text-xs font-bold" style={{ color: 'var(--color-text-1)' }}>Notifications</p>
            </div>
            {hasError ? (
              <div className="px-4 py-6 text-center">
                <p className="text-xs" style={{ color: 'var(--color-danger)' }}>Couldn't load notifications</p>
              </div>
            ) : count === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>Nothing needs attention right now</p>
              </div>
            ) : (
              <div className="py-1">
                {alertList.slice(0, 5).map((a, i) => (
                  <Link key={`alert-${i}`} to="/alerts" onClick={() => setOpen(false)}
                        className="block px-4 py-2.5 hover:bg-[var(--color-surface-2)]">
                    <p className="text-xs font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>
                      {a.title ?? a.message ?? 'Predictive signal detected'}
                    </p>
                    <p className="text-[10px] truncate" style={{ color: 'var(--color-text-3)' }}>
                      {a.location ?? a.locationName ?? 'All locations'}
                    </p>
                  </Link>
                ))}
                {unanswered.slice(0, 5).map((r, i) => (
                  <Link key={`unanswered-${i}`} to="/explorer" onClick={() => setOpen(false)}
                        className="block px-4 py-2.5 hover:bg-[var(--color-surface-2)]">
                    <p className="text-xs font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>
                      {r.star_rating ?? '?'}★ from {r.reviewer_name || 'Anonymous'}
                    </p>
                    <p className="text-[10px] truncate" style={{ color: 'var(--color-text-3)' }}>
                      {r.location_name}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── Sidebar content ───────────────────────────────────────────────────────────

function SidebarContent({ unansweredCount, onLinkClick }) {
  return (
    <>
      {/* Brand */}
      <div className="px-5 py-5 flex-shrink-0" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <p className="text-[10px] font-bold tracking-[0.18em] uppercase mb-1"
           style={{ color: 'var(--color-text-3)' }}>
          Future Marketing Studio
        </p>
        <h1 className="text-sm font-bold leading-tight" style={{ color: 'var(--color-text-1)' }}>
          Future Insights
        </h1>
      </div>

      {/* Smart Search */}
      <div className="px-3 pt-3 flex-shrink-0">
        <SmartSearch />
      </div>

      {/* Nav -- flat 8-item structure, no section grouping (Navigation
          Specification v1.0 §5's approved sidebar has none) */}
      <nav className="flex-1 p-3 overflow-y-auto min-h-0">
        <ul className="space-y-0.5">
          {NAV_ITEMS.map(item => (
            <li key={item.id}>
              <NavLink
                to={item.path}
                onClick={onLinkClick}
                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              >
                {item.icon}
                <span className="flex-1 min-w-0 truncate">{item.label}</span>
                {item.badge === 'unanswered' && unansweredCount > 0 && (
                  <span className="flex-shrink-0 text-white text-[9px] font-bold rounded-full min-w-[17px] h-[17px] flex items-center justify-center px-1"
                        style={{ background: 'var(--color-danger)' }}>
                    {unansweredCount > 99 ? '99+' : unansweredCount}
                  </span>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Footer */}
      <div className="px-5 py-3 flex-shrink-0 flex items-center justify-between gap-2"
           style={{ borderTop: '1px solid var(--color-border)' }}>
        <p className="text-[10px] truncate" style={{ color: 'var(--color-text-3)' }}>
          Los Tres Amigos · 21 Locations
        </p>
        <div className="flex items-center gap-1 flex-shrink-0">
          <LogoutButton />
          <ThemeToggle compact />
        </div>
      </div>
    </>
  )
}

// ── Main Layout ───────────────────────────────────────────────────────────────

export default function Layout({ unansweredCount = 0, children }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()

  useEffect(() => { setMobileOpen(false) }, [location.pathname])
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [mobileOpen])

  const current = NAV_FLAT.find(n => location.pathname.startsWith(n.path))

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--color-bg)' }}>

      {/* ── Fixed desktop sidebar ───────────────────────────────────────────── */}
      <aside
        className="no-print hidden lg:flex flex-col fixed inset-y-0 left-0 z-30"
        style={{ width: 'var(--sidebar-w)', background: 'var(--color-surface)', borderRight: '1px solid var(--color-border)' }}
      >
        <SidebarContent unansweredCount={unansweredCount} />
      </aside>

      {/* ── Mobile overlay drawer ───────────────────────────────────────────── */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-50 lg:hidden"
              style={{ background: 'rgba(26,23,20,0.45)', backdropFilter: 'blur(4px)' }}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setMobileOpen(false)}
              aria-hidden="true"
            />
            <motion.aside
              id="mobile-nav-drawer"
              className="fixed inset-y-0 left-0 z-50 flex flex-col w-72 lg:hidden"
              style={{ background: 'var(--color-surface)', borderRight: '1px solid var(--color-border)', boxShadow: 'var(--shadow-xl)' }}
              initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            >
              <div className="absolute top-3 right-3">
                <button onClick={() => setMobileOpen(false)}
                        className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] dark:hover:bg-[var(--color-surface-2)]"
                        aria-label="Close menu"
                        style={{ color: 'var(--color-text-2)' }}>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
                  </svg>
                </button>
              </div>
              <SidebarContent unansweredCount={unansweredCount} onLinkClick={() => setMobileOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ── Main content area ───────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 lg:pl-[228px]">

        {/* Mobile topbar */}
        <header className="no-print lg:hidden sticky top-0 z-40 flex items-center gap-3 px-4 h-14 flex-shrink-0"
                style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', boxShadow: 'var(--shadow-sm)' }}>
          <button onClick={() => setMobileOpen(true)}
                  className="p-1.5 rounded-lg"
                  style={{ color: 'var(--color-text-2)' }}
                  aria-label="Open menu"
                  aria-expanded={mobileOpen}
                  aria-controls="mobile-nav-drawer">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16"/>
            </svg>
          </button>
          <span className="font-semibold text-sm truncate" style={{ color: 'var(--color-text-1)' }}>
            {current?.label ?? 'Future Insights'}
          </span>
          {current?.id === 'actions' && unansweredCount > 0 && (
            <span className="ml-auto badge badge-danger">{unansweredCount} pending</span>
          )}
        </header>

        {/* Desktop snapshot bar */}
        <SnapshotBar />

        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 lg:py-8 animate-fade-up">
          {children}
        </main>
      </div>
    </div>
  )
}
