// Multi-Tenant Phase 1 (Additive Data Model & Los Tres Amigos Tenant
// Backfill) -- defines what a Tenant and a TenantMembership ARE, and
// establishes the one tenant that exists today. Nothing in this file is
// wired into any existing endpoint, store, or auth check yet -- auth.js,
// accountStore.js, credentialStore.js, and every Redis store still behave
// exactly as before this phase. See the Phase 1 audit report for the full
// design; this module is the first, purely additive step of that plan.
//
// WHY A STABLE, EXPLICIT TENANT ID (not runtime-generated): Los Tres Amigos
// is not a placeholder -- it is real production data that will eventually
// be re-keyed under `*:v2:{tenantId}` Redis keys in a later, separately
// reviewed phase. A generated ID (uuid, timestamp-based, etc.) would make
// every future migration script, support ticket, and log line
// unnecessarily opaque for the one tenant every human working on this
// system already knows by name. Every tenant created later (via
// self-service onboarding) gets a generated ID; this one is hand-assigned
// once, here, and never regenerated.

export const DEFAULT_TENANT_ID = 't_los-tres-amigos'

// --- Tenant -----------------------------------------------------------
// A Tenant record shape (not yet persisted anywhere -- Phase 1 defines the
// shape so a later phase doesn't have to invent it under time pressure):
//   tenantId:  string, matches /^t_[a-z0-9-]+$/
//   name:      display name ("Los Tres Amigos")
//   status:    'active' | 'suspended'
//   createdAt: ISO 8601 string

export function isValidTenantId(tenantId) {
  return typeof tenantId === 'string' && /^t_[a-z0-9-]+$/.test(tenantId)
}

export function isValidTenant(tenant) {
  return (
    tenant !== null && typeof tenant === 'object' &&
    isValidTenantId(tenant.tenantId) &&
    typeof tenant.name === 'string' && tenant.name.length > 0 &&
    (tenant.status === 'active' || tenant.status === 'suspended') &&
    typeof tenant.createdAt === 'string'
  )
}

// The one tenant that exists during Phase 1. Not persisted to Redis yet --
// this is the value the (not-yet-run, dry-run-only) backfill script and
// the Phase 1 tests use as ground truth. `createdAt` marks when this
// record was established in code, not Los Tres Amigos' actual founding
// date.
export const LOS_TRES_AMIGOS_TENANT = Object.freeze({
  tenantId: DEFAULT_TENANT_ID,
  name: 'Los Tres Amigos',
  status: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
})

// --- Membership roles ---------------------------------------------------
// dashboard/api/_lib/accounts.js's existing ROLES
// (owner/admin/marketing/location_manager/read_only) are PRESERVED
// UNCHANGED by this phase -- see LEGACY_ROLE_TO_TENANT_ROLE below for the
// reviewed mapping. Two roles here are new:
//   PLATFORM_OWNER -- NOT a tenant role. A platform owner is never a row
//     in any tenant's membership list; see isPlatformOwnerEmail() below.
//     Included in this enum only so callers have one place to reference
//     every role name that can appear anywhere in the system.
//   TENANT_OWNER / TENANT_ADMIN -- Phase 1 naming for what today's single
//     tenant calls 'owner' / 'admin'.
export const TenantRole = Object.freeze({
  PLATFORM_OWNER:   'platform_owner',
  TENANT_OWNER:     'tenant_owner',
  TENANT_ADMIN:     'tenant_admin',
  MARKETING:        'marketing',
  LOCATION_MANAGER: 'location_manager',
  READ_ONLY:        'read_only',
})

// Existing accounts.js role name -> new TenantRole name. Phase 1 does not
// rename anything in accounts.js/permissions.js/ACCOUNT_DIRECTORY_JSON --
// this mapping exists so a later phase (and these tests) has one
// canonical, reviewed answer to "what does 'owner' become", rather than
// each call site guessing independently.
export const LEGACY_ROLE_TO_TENANT_ROLE = Object.freeze({
  owner:            TenantRole.TENANT_OWNER,
  admin:            TenantRole.TENANT_ADMIN,
  marketing:        TenantRole.MARKETING,
  location_manager: TenantRole.LOCATION_MANAGER,
  read_only:        TenantRole.READ_ONLY,
})

export function isKnownTenantRole(role) {
  return Object.values(TenantRole).includes(role)
}

// --- TenantMembership -----------------------------------------------
// The future replacement (in a later, separate phase -- not wired in yet)
// for the flat account.locationIds model: an explicit per-tenant grant.
// Until that phase, this is a pure data shape + validator with no caller
// anywhere in the running app.
//   tenantId:       string, matches an existing Tenant
//   userId:         string, matches an existing account's userId
//   role:           one of TenantRole, never PLATFORM_OWNER (see above)
//   locationIds:    '*' | number[] -- SEE WILDCARD SEMANTICS below
//   canCreateTasks: boolean, same meaning as today's per-account flag

export function isValidLocationGrant(locationIds) {
  if (locationIds === '*') return true
  return Array.isArray(locationIds) && locationIds.length > 0 &&
    locationIds.every(id => Number.isInteger(id) && id > 0)
}

// *** WILDCARD SEMANTICS -- PHASE 1 DEFINITION, WRITTEN DOWN NOW ***
// `locationIds === '*'` on a TenantMembership means "every location that
// belongs to THIS MEMBERSHIP'S TENANT" -- never "every location on the
// platform," even though, during Phase 1, those two sets happen to be
// identical (there is exactly one tenant, Los Tres Amigos). This
// distinction is recorded now, before a second tenant exists, specifically
// so no later phase can quietly reinterpret '*' as platform-wide once it
// would actually matter. A future authorization check resolving a
// wildcard grant MUST resolve it against that tenant's own location list
// -- never against an unfiltered, platform-wide list.
export function isValidTenantMembership(membership) {
  return (
    membership !== null && typeof membership === 'object' &&
    isValidTenantId(membership.tenantId) &&
    typeof membership.userId === 'string' && membership.userId.length > 0 &&
    isKnownTenantRole(membership.role) && membership.role !== TenantRole.PLATFORM_OWNER &&
    isValidLocationGrant(membership.locationIds) &&
    (membership.canCreateTasks === undefined || typeof membership.canCreateTasks === 'boolean')
  )
}

// Builds a TenantMembership for an existing accounts.js-shaped account
// (the same shape accountStore.js/userStore.js already hand back), under
// the Phase 1 tenant. Pure function -- does not read or write anything,
// does not touch Redis, does not mutate `account`. This is the transform
// the (not-yet-run) backfill script will apply once per existing account;
// Phase 1 only defines and tests it.
export function buildLosTresAmigosMembership(account) {
  const legacyRole = account?.role
  const role = LEGACY_ROLE_TO_TENANT_ROLE[legacyRole]
  if (!role) {
    throw new Error(`buildLosTresAmigosMembership: unrecognized legacy role ${JSON.stringify(legacyRole)}`)
  }
  const membership = {
    tenantId: DEFAULT_TENANT_ID,
    userId: account.userId,
    role,
    locationIds: account.locationIds,
    ...(account.canCreateTasks !== undefined ? { canCreateTasks: Boolean(account.canCreateTasks) } : {}),
  }
  if (!isValidTenantMembership(membership)) {
    throw new Error(`buildLosTresAmigosMembership: produced an invalid membership for userId ${JSON.stringify(account?.userId)}`)
  }
  return membership
}

// --- Platform owner -------------------------------------------------
// A platform owner is explicitly NOT a TenantMembership row for any
// tenant -- see the audit's "Platform-Owner Administration Model"
// section. Phase 1 defines only the identity check, driven by an
// allowlist of emails from a NEW env var (PLATFORM_OWNER_EMAILS,
// comma-separated) that does not exist in Vercel yet and is NOT added by
// this phase. If the var is unset (true today, and true after this
// phase), the allowlist is empty and isPlatformOwnerEmail() returns false
// for every email -- Phase 1 introduces no broad authorization bypass.
// Phase 1 explicitly does NOT implement impersonation/support tooling --
// this function only answers "is this identity, if it existed, eligible
// to be treated as platform owner," nothing more, and nothing calls it
// yet.
function parsePlatformOwnerEmails(raw) {
  if (!raw) return []
  return raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
}

export function isPlatformOwnerEmail(email) {
  if (typeof email !== 'string' || !email) return false
  const allowlist = parsePlatformOwnerEmails(process.env.PLATFORM_OWNER_EMAILS)
  return allowlist.includes(email.trim().toLowerCase())
}
