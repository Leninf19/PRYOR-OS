import { useState, useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'

const NAV = [
  {
    id: 'overview', path: '/overview', label: 'Command Center',
    icon: <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M2 10a8 8 0 018-8v8h8a8 8 0 11-16 0z"/><path d="M12 2.252A8.014 8.014 0 0117.748 8H12V2.252z"/></svg>,
  },
  {
    id: 'locations', path: '/locations', label: 'Locations',
    icon: <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M9.293 2.293a1 1 0 011.414 0l7 7A1 1 0 0117 11h-1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-3a1 1 0 00-1-1H9a1 1 0 00-1 1v3a1 1 0 01-1 1H5a1 1 0 01-1-1v-6H3a1 1 0 01-.707-1.707l7-7z" clipRule="evenodd"/></svg>,
  },
  {
    id: 'explorer', path: '/explorer', label: 'Review Center',
    icon: <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M2 5a2 2 0 012-2h8a2 2 0 012 2v10a2 2 0 002 2H4a2 2 0 01-2-2V5zm3 1h6v4H5V6zm6 6H5v2h6v-2z" clipRule="evenodd"/><path d="M15 7h1a2 2 0 012 2v5.5a1.5 1.5 0 01-3 0V7z"/></svg>,
  },
  {
    id: 'actions', path: '/actions', label: 'Response Center', badge: 'unanswered',
    icon: <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M2 5a2 2 0 012-2h7a2 2 0 012 2v4a2 2 0 01-2 2H9l-3 3v-3H4a2 2 0 01-2-2V5z"/><path d="M15 7v2a4 4 0 01-4 4H9.828l-1.766 1.767c.28.149.599.233.938.233h2l3 3v-3h2a2 2 0 002-2V9a2 2 0 00-2-2h-1z"/></svg>,
  },
  {
    id: 'intelligence', path: '/intelligence', label: 'Complaint Intel',
    icon: <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M3 3a1 1 0 000 2v8a2 2 0 002 2h2.586l-1.293 1.293a1 1 0 101.414 1.414L10 15.414l2.293 2.293a1 1 0 001.414-1.414L12.414 15H15a2 2 0 002-2V5a1 1 0 100-2H3zm11 4a1 1 0 10-2 0v4a1 1 0 102 0V7zm-3 1a1 1 0 10-2 0v3a1 1 0 102 0V8zM8 9a1 1 0 00-2 0v2a1 1 0 102 0V9z" clipRule="evenodd"/></svg>,
  },
  {
    id: 'competitive', path: '/competitive', label: 'Competitive Intel',
    icon: <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>,
  },
  {
    id: 'trends', path: '/trends', label: 'Trends & Predictions',
    icon: <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"/></svg>,
  },
  {
    id: 'scraper', path: '/scraper-status', label: 'Scraper Status',
    icon: <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd"/></svg>,
  },
  {
    id: 'reports', path: '/reports', label: 'Reports',
    icon: <svg viewBox="0 0 20 20" fill="currentColor" className="w-[15px] h-[15px] flex-shrink-0"><path fillRule="evenodd" d="M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V7.414A2 2 0 0015.414 6L12 2.586A2 2 0 0010.586 2H6zm2 10a1 1 0 10-2 0v3a1 1 0 102 0v-3zm2-3a1 1 0 011 1v5a1 1 0 11-2 0v-5a1 1 0 011-1zm4-1a1 1 0 10-2 0v6a1 1 0 102 0V8z" clipRule="evenodd"/></svg>,
  },
]

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

      {/* Nav */}
      <nav className="flex-1 p-3 overflow-y-auto min-h-0">
        <p className="text-[10px] font-bold tracking-[0.15em] uppercase px-2 pt-1 pb-2"
           style={{ color: 'var(--color-text-3)' }}>
          Navigation
        </p>
        <ul className="space-y-0.5">
          {NAV.map(item => (
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
      <div className="px-5 py-3 flex-shrink-0" style={{ borderTop: '1px solid var(--color-border)' }}>
        <p className="text-[10px]" style={{ color: 'var(--color-text-3)' }}>
          Los Tres Amigos · 21 Locations
        </p>
      </div>
    </>
  )
}

export default function Layout({ unansweredCount = 0, children }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()

  useEffect(() => { setMobileOpen(false) }, [location.pathname])
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [mobileOpen])

  const current = NAV.find(n => location.pathname.startsWith(n.path))

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--color-bg)' }}>

      {/* ── Fixed desktop sidebar ──────────────────────────────────────────── */}
      <aside
        className="hidden lg:flex flex-col fixed inset-y-0 left-0 z-30"
        style={{ width: 'var(--sidebar-w)', background: 'var(--color-surface)', borderRight: '1px solid var(--color-border)' }}
      >
        <SidebarContent unansweredCount={unansweredCount} />
      </aside>

      {/* ── Mobile overlay drawer ──────────────────────────────────────────── */}
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
              className="fixed inset-y-0 left-0 z-50 flex flex-col w-72 lg:hidden"
              style={{ background: 'var(--color-surface)', borderRight: '1px solid var(--color-border)', boxShadow: 'var(--shadow-xl)' }}
              initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            >
              {/* Mobile close button */}
              <div className="absolute top-3 right-3">
                <button onClick={() => setMobileOpen(false)}
                        className="p-1.5 rounded-lg hover:bg-stone-100"
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

      {/* ── Main content (offset by sidebar width on lg) ───────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 lg:pl-[228px]">

        {/* Mobile topbar */}
        <header className="lg:hidden sticky top-0 z-40 flex items-center gap-3 px-4 h-14 flex-shrink-0"
                style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', boxShadow: 'var(--shadow-sm)' }}>
          <button onClick={() => setMobileOpen(true)}
                  className="p-1.5 rounded-lg"
                  style={{ color: 'var(--color-text-2)' }}
                  aria-label="Open menu">
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

        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 lg:py-8 animate-fade-up">
          {children}
        </main>
      </div>
    </div>
  )
}
