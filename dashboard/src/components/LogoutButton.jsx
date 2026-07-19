// Self-contained (no session-state prop drilling through Layout/App) --
// clears the cookie server-side, then a full reload lets AuthGate's own
// whoami check (at the top of the tree) decide what to render next.
export default function LogoutButton() {
  async function handleLogout() {
    try { await fetch('/api/session/logout', { method: 'POST' }) } finally {
      window.location.reload()
    }
  }
  return (
    <button
      onClick={handleLogout}
      className="text-[10px] font-semibold px-2 py-1 rounded-md transition-colors hover:opacity-80"
      style={{ color: 'var(--color-text-3)' }}
      title="Sign out">
      Sign out
    </button>
  )
}
