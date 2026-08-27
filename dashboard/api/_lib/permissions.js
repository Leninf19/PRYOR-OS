// The permission registry -- Phase 2 Milestone 2. Every permission the
// system knows about is named once, here, as a constant. The role table
// below references only these constants, never a raw string, so a typo in
// a permission name fails immediately (a no-such-key lookup miss) instead
// of silently granting or denying the wrong thing at runtime. Renaming a
// permission is a one-place edit; an IDE can autocomplete `Permission.` at
// every call site; auditing "everything that can reply" is a single
// grep-able symbol instead of a scattered string literal.
//
// This file is purely additive and, as of Milestone 2, unused by any
// endpoint -- see auth.js for the composable helpers built on top of it,
// and the Phase 2 architecture doc (Revision 3, §3/§5) for the approved
// role/permission matrix this encodes.
//
// Edge AND Node runtime compatible -- no fs/bcrypt/Redis import, same
// constraint every other _lib module in the authorization path has.

export const Permission = Object.freeze({
  VIEW_ALL:        'view_all',
  VIEW_ASSIGNED:   'view_assigned',
  REPLY:           'reply',
  REPLY_ASSIGNED:  'reply_assigned',
  EXPORT:          'export',
  EXPORT_ASSIGNED: 'export_assigned',
  CAMPAIGNS:       'campaigns',
  ADMIN:           'admin',
  // Phase 8 (Operational Settings Platform): Restaurant Contacts, Email
  // System, and Audit Log capabilities. CONTACTS_VIEW is granted
  // unrestricted to owner/marketing and location-scoped (via
  // requireScopedAuth's resolveLocationId) to location_manager --
  // CONTACTS_MANAGE (add/edit/delete/disable/send-test-email) is NOT
  // granted to location_manager, per the approved Phase 8 role matrix.
  CONTACTS_VIEW:   'contacts_view',
  CONTACTS_MANAGE: 'contacts_manage',
  EMAIL_VIEW:      'email_view',
  SETTINGS_ADMIN:  'settings_admin', // Google Business Profile connect/disconnect
  AUDIT_VIEW:      'audit_view',
  // Multi-Location Authentication & User Access System: invite/disable/
  // role-and-location-reassign other users. Deliberately separate from
  // SETTINGS_ADMIN -- user management is an operational capability Owner
  // and Admin both hold; GBP OAuth is an infrastructure-credential
  // capability that stays Owner-only. See the role table below.
  USERS_MANAGE:    'users_manage',
  // Operations Calendar + Content Library milestone. Deliberately granular
  // (not one giant CALENDAR_MANAGE) -- TASK_ASSIGN (assign to someone else)
  // and TASK_MANAGE (edit/delete/reassign any task within scope) are
  // separate from TASK_VIEW/TASK_CREATE so a future role can hold one
  // without the others, and so location_manager's "complete your own
  // assigned task" capability (granted per-record in the endpoint, not via
  // this table -- see api/tasks/[action].js's canUpdateOwnTask()) never
  // needs to imply full TASK_MANAGE.
  TASK_VIEW:       'task_view',
  TASK_CREATE:     'task_create',
  TASK_ASSIGN:     'task_assign',
  TASK_MANAGE:     'task_manage',
  CALENDAR_VIEW:   'calendar_view',
  CALENDAR_MANAGE: 'calendar_manage',
  CONTENT_VIEW:    'content_view',
  CONTENT_UPLOAD:  'content_upload',
  CONTENT_MANAGE:  'content_manage',
  CAMPAIGN_CREATE: 'campaign_create',
  CAMPAIGN_MANAGE: 'campaign_manage',
})

// The role table: references Permission.* constants, never raw strings.
// Matches the approved capability matrix exactly -- Owner/Marketing hold
// the *_ASSIGNED variants' unrestricted counterparts (REPLY, EXPORT)
// instead of the scoped ones, since their access is never location-limited
// in the first place. Read Only holds no export permission at all -- the
// distinction the Phase 2 test matrix (Revision 3) makes explicit.
// Operations Calendar + Content Library milestone: the 11 permissions
// above, granted per the approved role table. owner/admin/marketing get the
// full set (creation, assignment/upload, and management/approval);
// location_manager and read_only get view-only via the table -- their
// narrower write capabilities (complete an assigned task, add notes,
// download an APPROVED asset for their own location) are enforced per-record
// in the endpoint layer, never by widening this table. TASK_CREATE is
// deliberately NOT granted to location_manager here even conditionally --
// the account-level `canCreateTasks` override (api/_lib/auth.js's
// canCreateTask()) is a separate, explicit combinator, not a table entry,
// so this table stays a pure function of role alone.
const CALENDAR_CONTENT_FULL = [
  Permission.TASK_VIEW, Permission.TASK_CREATE, Permission.TASK_ASSIGN, Permission.TASK_MANAGE,
  Permission.CALENDAR_VIEW, Permission.CALENDAR_MANAGE,
  Permission.CONTENT_VIEW, Permission.CONTENT_UPLOAD, Permission.CONTENT_MANAGE,
  Permission.CAMPAIGN_CREATE, Permission.CAMPAIGN_MANAGE,
]

export const ROLE_PERMISSIONS = Object.freeze({
  owner: new Set([
    Permission.VIEW_ALL, Permission.VIEW_ASSIGNED, Permission.REPLY,
    Permission.CAMPAIGNS, Permission.EXPORT, Permission.ADMIN,
    Permission.CONTACTS_VIEW, Permission.CONTACTS_MANAGE,
    Permission.EMAIL_VIEW, Permission.SETTINGS_ADMIN, Permission.AUDIT_VIEW,
    Permission.USERS_MANAGE,
    ...CALENDAR_CONTENT_FULL,
  ]),
  // 'admin': core operational tier (same VIEW_ALL/REPLY/EXPORT/CAMPAIGNS as
  // owner/marketing) plus USERS_MANAGE -- deliberately introduced in the
  // Commit 1 (user model + roles) scope only. CONTACTS_VIEW/CONTACTS_MANAGE/
  // EMAIL_VIEW/AUDIT_VIEW are intentionally NOT granted yet: those gate
  // settings/[action].js endpoints this milestone hasn't reviewed for admin
  // access yet (Restaurant Contacts/Email/Audit Log), and granting them here
  // first would let admin reach those endpoints before their own commit
  // adds admin to ENDPOINT_REGISTRY/tests for them. Widened in that later,
  // reviewed commit -- see the milestone's implementation sequence. Never
  // granted: SETTINGS_ADMIN (GBP OAuth connect/disconnect) or the ADMIN
  // capability itself -- both stay Owner-only by design. Calendar/Content
  // ARE granted in full ("operationally similar to Owner for Calendar/
  // Content" -- Operations Calendar + Content Library milestone, explicit
  // product decision), since those are operational, not infra-credential,
  // capabilities.
  admin: new Set([
    Permission.VIEW_ALL, Permission.VIEW_ASSIGNED, Permission.REPLY,
    Permission.CAMPAIGNS, Permission.EXPORT,
    Permission.USERS_MANAGE,
    ...CALENDAR_CONTENT_FULL,
  ]),
  marketing: new Set([
    Permission.VIEW_ALL, Permission.VIEW_ASSIGNED, Permission.REPLY,
    Permission.CAMPAIGNS, Permission.EXPORT,
    Permission.CONTACTS_VIEW, Permission.CONTACTS_MANAGE, Permission.EMAIL_VIEW,
    ...CALENDAR_CONTENT_FULL,
  ]),
  location_manager: new Set([
    Permission.VIEW_ASSIGNED, Permission.REPLY_ASSIGNED, Permission.EXPORT_ASSIGNED,
    Permission.CONTACTS_VIEW, // scoped to their own location via requireScopedAuth
    Permission.TASK_VIEW, Permission.CALENDAR_VIEW, Permission.CONTENT_VIEW,
  ]),
  read_only: new Set([
    Permission.VIEW_ASSIGNED,
    Permission.TASK_VIEW, Permission.CALENDAR_VIEW, Permission.CONTENT_VIEW,
  ]),
})

// Unknown role -> no permissions, never a thrown error -- consistent with
// the rest of this codebase's "fail closed, don't fail loudly" convention
// for authorization decisions.
export function roleHasPermission(role, permission) {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false
}
