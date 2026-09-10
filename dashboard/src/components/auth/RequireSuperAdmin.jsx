import { useAccount } from '../AuthGate.jsx'

// Multi-Tenant Phase 4Q.1 -- CLIENT-SIDE convenience gate only, for hiding
// the nav/route from anyone who obviously isn't the platform admin. The
// REAL enforcement is server-side: dashboard/api/admin/[action].js's own
// requireSuperAdmin() (isSuperAdmin() from auth.js) -- every request this
// page makes is independently authorized there regardless of what this
// component does or doesn't render. A mismatch here only ever costs an
// extra click to a 403, never grants access to anything.
const PLATFORM_ADMIN_TENANT_ID = 't_los-tres-amigos'

export function isSuperAdminAccount(account) {
  return Boolean(account) && account.role === 'owner' && account.tenantId === PLATFORM_ADMIN_TENANT_ID
}

export default function RequireSuperAdmin({ children }) {
  const account = useAccount()
  if (!isSuperAdminAccount(account)) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--color-bg)' }}>
        <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>Not found.</p>
      </div>
    )
  }
  return children
}
