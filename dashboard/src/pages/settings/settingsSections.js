import { lazy } from 'react'

// Extensibility mechanism for the Settings section (Phase 8, Part 7): every
// current and future Settings sub-page is one entry in this array. Adding a
// new operational settings section later (Email Templates, Notification
// Rules, Manager Accounts, API Integrations, System Health, Audit Log) is a
// one-object addition here plus one route generated from it in App.jsx --
// never a new file, never touching SettingsLayout.jsx itself.
//
// `component` is wrapped in React.lazy() here (not imported eagerly) so
// each section still ships in its own code-split chunk, matching every
// other page in dashboard/src/App.jsx.
//
// `requiredRoles`: null means every authenticated role sees the nav item
// (matches today's Settings page, which has no role gating at all). This
// is a client-side PRESENTATION filter only -- hiding a nav item a role
// can't use -- never the actual security boundary; the backend endpoint
// each section calls is always the real enforcement point (requireAuth()/
// requireScopedAuth() in dashboard/api/_lib/auth.js). Kept as plain role
// strings (matching every existing frontend role check, e.g.
// `account?.role === 'owner'`) rather than importing the Node-only
// Permission enum from dashboard/api/_lib/permissions.js across the
// api/<->src boundary -- no frontend file does that today, and this app's
// established convention is to duplicate small constants across such
// boundaries deliberately (see db.py/dataUtils.js's BRANDS) rather than
// introduce a new cross-boundary import.
export const settingsSections = [
  {
    id: 'general',
    path: '',
    label: 'General',
    icon: '⚙',
    component: lazy(() => import('./General.jsx')),
    requiredRoles: null,
  },
  {
    id: 'google',
    path: 'google',
    label: 'Google Business Profile',
    icon: '🔗',
    component: lazy(() => import('./GoogleBusinessProfile.jsx')),
    requiredRoles: null,
  },
]
