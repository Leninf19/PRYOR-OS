import { Suspense } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import Skeleton from '../../components/ui/Skeleton.jsx'
import { useAccount } from '../../components/AuthGate.jsx'
import { settingsSections } from './settingsSections.js'

function SectionFallback() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full rounded-2xl" />
      <Skeleton className="h-40 w-full rounded-2xl" />
    </div>
  )
}

// The Settings shell (Phase 8, Milestone 8.1) -- first nested-route
// (Outlet-in-Outlet) layout in this app. Renders the section registry
// (settingsSections.js) as a real ARIA tablist -- a left-hand nav on
// desktop, a horizontal scrolling tab strip on mobile (same
// role=tablist/tab/aria-selected semantics either way, matching
// ScraperStatus.jsx's existing Data Health sub-nav) -- plus the nested
// Outlet each section renders into. Filters nav items by requiredRoles
// against the current account's role (presentation only, see
// settingsSections.js's own comment on why this isn't the security
// boundary).
export default function SettingsLayout() {
  const account = useAccount()
  const location = useLocation()

  const visibleSections = settingsSections.filter(
    s => !s.requiredRoles || s.requiredRoles.includes(account?.role)
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Settings</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Integrations and configuration for Pryor OS
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 lg:gap-10">
        <nav role="tablist" aria-label="Settings sections"
             className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible lg:w-52 flex-shrink-0 pb-1 lg:pb-0">
          {visibleSections.map(s => {
            const to = s.path === '' ? '/settings' : `/settings/${s.path}`
            const isActive = s.path === ''
              ? location.pathname === '/settings'
              : location.pathname.startsWith(to)
            return (
              <NavLink
                key={s.id}
                to={to}
                end={s.path === ''}
                role="tab"
                aria-selected={isActive}
                className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors whitespace-nowrap flex-shrink-0"
                style={{
                  background: isActive ? 'var(--color-surface-2)' : 'transparent',
                  color: isActive ? 'var(--color-text-1)' : 'var(--color-text-2)',
                }}
              >
                <span aria-hidden="true">{s.icon}</span>
                {s.label}
              </NavLink>
            )
          })}
        </nav>

        <div className="flex-1 min-w-0 max-w-[720px]">
          <Suspense fallback={<SectionFallback />}>
            <Outlet />
          </Suspense>
        </div>
      </div>
    </div>
  )
}
