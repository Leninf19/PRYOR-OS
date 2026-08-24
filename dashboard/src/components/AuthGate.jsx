import { createContext, useContext } from 'react'
import { useLocation } from 'react-router-dom'
import { useSession } from '../hooks/useSession.js'
import Login from './Login.jsx'
import AcceptInvite from './AcceptInvite.jsx'

// Paths reachable WITHOUT a session, checked before any loading/
// authenticated/unauthenticated branching below -- an invitee has no
// account yet and must never see the sign-in form. useSession()'s whoami
// check still fires in the background on these paths (harmless, ignored;
// not worth threading a skip-flag through the hook for one wasted 401).
const PUBLIC_PATHS = {
  '/accept-invite': AcceptInvite,
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
export default function AuthGate({ children }) {
  const { status, account, login } = useSession()
  const location = useLocation()

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

  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>
}
