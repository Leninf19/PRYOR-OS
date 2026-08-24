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
  {
    id: 'contacts',
    path: 'contacts',
    label: 'Restaurant Contacts',
    icon: '📇',
    component: lazy(() => import('./RestaurantContacts.jsx')),
    // read_only has no CONTACTS_VIEW at all; location_manager sees a
    // scoped (own-location) view -- both enforced server-side too, this
    // is nav-visibility only (see the comment above).
    requiredRoles: ['owner', 'marketing', 'location_manager'],
  },
  {
    id: 'email',
    path: 'email',
    label: 'Email System',
    icon: '✉',
    component: lazy(() => import('./EmailSystem.jsx')),
    // EMAIL_VIEW is granted to owner/marketing only, per the approved
    // Phase 8 role matrix -- location_manager/read_only have no view into
    // the aggregate, company-wide SMTP status.
    requiredRoles: ['owner', 'marketing'],
  },
  {
    id: 'audit-log',
    path: 'audit-log',
    label: 'Audit Log',
    icon: '🗒',
    component: lazy(() => import('./AuditLog.jsx')),
    // The global, cross-entity, compliance-facing audit trail is
    // Owner-only per the approved Phase 8 role matrix -- Marketing has
    // CONTACTS_MANAGE but not AUDIT_VIEW.
    requiredRoles: ['owner'],
  },
  {
    id: 'users',
    path: 'users',
    label: 'Users & Access',
    icon: '🧑‍🤝‍🧑',
    component: lazy(() => import('./UsersAccess.jsx')),
    // Multi-Location Authentication & User Access System -- USERS_MANAGE
    // is granted only to owner/admin (permissions.js); Marketing/
    // location_manager/read_only never see this nav item, matching the
    // backend gate every action in this section enforces.
    requiredRoles: ['owner', 'admin'],
  },
]
