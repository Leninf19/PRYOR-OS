import { createContext, useContext } from 'react'
import { useLocation } from 'react-router-dom'
import { useSession } from '../hooks/useSession.js'
import { useTenantStatus } from '../hooks/useTenantStatus.js'
import Login from './Login.jsx'
import AcceptInvite from './AcceptInvite.jsx'
import ForgotPassword from './ForgotPassword.jsx'
import ResetPassword from './ResetPassword.jsx'
import Onboarding from '../pages/Onboarding.jsx'

// Paths reachable WITHOUT a session, checked before any loading/
// authenticated/unauthenticated branching below -- an invitee/locked-out
// user has no valid session yet and must never see the sign-in form.
// useSession()'s whoami check still fires in the background on these paths
// (harmless, ignored; not worth threading a skip-flag through the hook for
// one wasted 401).
const PUBLIC_PATHS = {
  '/accept-invite': AcceptInvite,
  '/forgot-password': ForgotPassword,
  '/reset-password': ResetPassword,
}

// The authenticated account (userId/email/role/locationIds/displayName from
// GET /api/session/whoami), available to any component below AuthGate --
// null only while unauthenticated, which never overlaps with children being
// mounted at all (see below). Pages that need "who is logged in" (Action
// Center's assignee picker/Mine filter, future workload reporting, etc.)
// call useAccount() instead of re-fetching whoami themselves.
const AccountContext = createContext(null)

export function useAccount() {
  return useContext(AccountContext)
}

// Sits above <App/> (see main.jsx) so no protected data request ever fires
// before a session is confirmed: children (App, and everything it renders --
// useGlobalPrefetch, useReviewsData, etc) simply aren't mounted until
// status === 'authenticated'. On a 401 discovered later during data loading,
// useSession's SESSION_EXPIRED_EVENT listener flips status back to
// 'unauthenticated', which unmounts App and remounts the login screen here.
//
// Multi-Tenant Phase 4J -- TENANT LIFECYCLE GATE: once authenticated, this
// component ALSO checks the account's own tenant lifecycle status
// (useTenantStatus(), GET /api/session/tenant-status) BEFORE ever mounting
// `children` (App/RootLayout). A tenant whose status is not 'active' gets
// <Onboarding/> instead -- App's RootLayout unconditionally fetches review
// data (useReviewsData/useGlobalPrefetch) and would otherwise hit its own
// loading/error screens for a tenant with no reviews.db yet, or worse,
// silently render an empty-but-technically-working dashboard that looks
// like onboarding succeeded when it did not. This is deliberately placed
// ABOVE App, not as a child route inside it, so NONE of App's data hooks
// ever fire for a non-active tenant. Los Tres Amigos (BOOTSTRAP mode) has
// no tenant_config record and its tenant-status response hardcodes
// status: 'active' (see session/[action].js's tenantStatus()), so this
// gate is a complete no-op for LTA -- it reaches `children` exactly as
// before this phase, with one extra (cheap, cached) network round trip.
export default function AuthGate({ children }) {
  const { status, account, login } = useSession()
  const location = useLocation()
  const tenantStatusQuery = useTenantStatus({ enabled: status === 'authenticated' })

  const PublicPage = PUBLIC_PATHS[location.pathname]
  if (PublicPage) {
    return <PublicPage />
  }

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--color-bg)' }}>
        <div className="flex items-center gap-2">
          {[0, 1, 2].map(i => (
            <div key={i}
                 className="w-2 h-2 rounded-full pulse-dot"
                 style={{ background: 'var(--color-accent)', animationDelay: `${i * 0.25}s` }} />
          ))}
        </div>
      </div>
    )
  }

  if (status === 'unauthenticated') {
    return <Login onSuccess={login} />
  }

  return (
    <AccountContext.Provider value={account}>
      <TenantLifecycleGate tenantStatusQuery={tenantStatusQuery}>{children}</TenantLifecycleGate>
    </AccountContext.Provider>
  )
}

function TenantLifecycleGate({ tenantStatusQuery, children }) {
  const { data, isLoading, isError, refetch } = tenantStatusQuery

  // While tenant status is still loading (first paint after login), show
  // the SAME loading affordance as the pre-auth loading screen above --
  // never a flash of the real dashboard shell before we actually know
  // whether this tenant is active.
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--color-bg)' }}>
        <div className="flex items-center gap-2">
          {[0, 1, 2].map(i => (
            <div key={i}
                 className="w-2 h-2 rounded-full pulse-dot"
                 style={{ background: 'var(--color-accent)', animationDelay: `${i * 0.25}s` }} />
          ))}
        </div>
      </div>
    )
  }

  // A read failure here fails closed to the onboarding screen (which has
  // its own retry affordance) rather than silently falling through to the
  // real dashboard -- "cannot confirm this tenant is active" must never be
  // treated the same as "confirmed active."
  if (isError || !data || data.status !== 'active') {
    return <Onboarding />
  }

  return children
}
