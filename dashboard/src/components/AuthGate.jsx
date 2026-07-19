import { useSession } from '../hooks/useSession.js'
import Login from './Login.jsx'

// Sits above <App/> (see main.jsx) so no protected data request ever fires
// before a session is confirmed: children (App, and everything it renders --
// useGlobalPrefetch, useReviewsData, etc) simply aren't mounted until
// status === 'authenticated'. On a 401 discovered later during data loading,
// useSession's SESSION_EXPIRED_EVENT listener flips status back to
// 'unauthenticated', which unmounts App and remounts the login screen here.
export default function AuthGate({ children }) {
  const { status, login } = useSession()

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

  return children
}
