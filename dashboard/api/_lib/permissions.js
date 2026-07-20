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
})

// The role table: references Permission.* constants, never raw strings.
// Matches the approved capability matrix exactly -- Owner/Marketing hold
// the *_ASSIGNED variants' unrestricted counterparts (REPLY, EXPORT)
// instead of the scoped ones, since their access is never location-limited
// in the first place. Read Only holds no export permission at all -- the
// distinction the Phase 2 test matrix (Revision 3) makes explicit.
export const ROLE_PERMISSIONS = Object.freeze({
  owner: new Set([
    Permission.VIEW_ALL, Permission.VIEW_ASSIGNED, Permission.REPLY,
    Permission.CAMPAIGNS, Permission.EXPORT, Permission.ADMIN,
  ]),
  marketing: new Set([
    Permission.VIEW_ALL, Permission.VIEW_ASSIGNED, Permission.REPLY,
    Permission.CAMPAIGNS, Permission.EXPORT,
  ]),
  location_manager: new Set([
    Permission.VIEW_ASSIGNED, Permission.REPLY_ASSIGNED, Permission.EXPORT_ASSIGNED,
  ]),
  read_only: new Set([
    Permission.VIEW_ASSIGNED,
  ]),
})

// Unknown role -> no permissions, never a thrown error -- consistent with
// the rest of this codebase's "fail closed, don't fail loudly" convention
// for authorization decisions.
export function roleHasPermission(role, permission) {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false
}
