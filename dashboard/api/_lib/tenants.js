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

// --- Tenant membership resolution (Multi-Tenant Phase 3) ----------------
// Returns every TenantMembership an account holds, as an ARRAY -- even
// though, today, that array always has exactly one entry. The array shape
// is deliberate and forward-looking: a later phase that looks up real
// per-user memberships from a durable multi-tenant membership store can
// change only this function's internals (querying that store instead of
// calling buildLosTresAmigosMembership()) without changing what any caller
// expects back. Returns [] for a falsy account (nothing to resolve).
export function resolveTenantMembershipsForAccount(account) {
  if (!account) return []
  return [buildLosTresAmigosMembership(account)]
}

export class AmbiguousTenantMembershipError extends Error {}

// The membership Phase 3's login/token-issuance flow uses to decide which
// tenant a session is issued for. Phase 3 never builds a tenant-picker UI --
// if an account ever resolved to more than one membership, this throws
// rather than silently guessing one, so a future phase is forced to add
// the picker before that state can ever reach a real user. Every account
// today resolves to exactly one membership (Los Tres Amigos), so this
// never throws in practice yet.
export function resolveSingleTenantMembershipForLogin(account) {
  const memberships = resolveTenantMembershipsForAccount(account)
  if (memberships.length === 0) return null
  if (memberships.length > 1) {
    throw new AmbiguousTenantMembershipError(
      `account ${JSON.stringify(account?.userId)} resolves to ${memberships.length} tenant memberships -- a tenant-picker UI is required and does not exist yet`
    )
  }
  return memberships[0]
}

// Thrown by resolveTenantId() below whenever a tenant cannot be safely
// established for an account -- callers on the authentication/session path
// (auth.js's evaluateSession(), session/[action].js's login/accept-invite/
// reset-password) MUST catch this and reject the request (401/503, a
// generic message), never let it propagate as an unhandled error, and
// never include this error's own message (which may name the offending
// field) in a response body.
export class TenantResolutionError extends Error {}

// --- Tenant resolution (Multi-Tenant Phase 3, hardened) -------------------
// The ONE function every server-side call site uses to answer "which
// tenant is this request for" -- deliberately centralized so that
// (a) no call site ever accepts a tenantId from req.query/req.body (an
// attacker-controlled value would be a direct cross-tenant read/write
// vector the moment a second tenant exists), and (b) Phase 3's session
// tenant claim is a ONE-FUNCTION change, not a find-and-replace across
// every endpoint.
//
// FAIL-CLOSED, by design: this function THROWS TenantResolutionError
// rather than returning DEFAULT_TENANT_ID for anything it cannot
// positively resolve -- a null account, a non-object, an account with an
// explicit-but-invalid tenantId, an unrecognized legacy role, or an
// invalid location grant. Falling back to the default tenant for any of
// those would mean "we don't know who this is, so let's assume Los Tres
// Amigos" -- exactly the permissive behavior a security boundary must not
// have. There is no silent, permissive path here anymore.
//
// Resolution order:
//   1. If `account` carries an explicit `tenantId` key at all, it MUST be a
//      valid tenant id string, or this throws immediately -- an explicit
//      but malformed/invalid tenantId is never silently ignored in favor
//      of re-deriving one a different way. The valid case is the path
//      every REAL request takes: dashboard/api/_lib/auth.js's
//      evaluateSession() is the ONLY place that ever attaches `tenantId`
//      to an account object, and it does so from a freshly SERVER-side
//      re-derived value (never from the raw, client-controlled JWT claim
//      directly -- see evaluateSession()'s own header comment) -- so by
//      the time any endpoint/store call site sees `account.tenantId`, it
//      has already been proven to match the account's real membership.
//      This is also the seam a future multi-tenant phase's account objects
//      (or this file's own unit tests, constructing a synthetic account
//      shape directly) use to exercise a hypothetical non-default tenant
//      without needing a real second tenant to exist.
//   2. Otherwise (a raw account record fresh from accountStore.js/
//      userStore.js, which never carries a `tenantId` field itself), this
//      requires `account` to be a valid legacy PRYOR/LTA account that
//      buildLosTresAmigosMembership() can successfully transform into a
//      real TenantMembership (valid recognized role, valid location
//      grant, non-empty userId) -- every account that was ever actually
//      written by this codebase's own validated writers (accounts.js's
//      loadAccountDirectory(), userStore.js's upsertUser()) satisfies
//      this, so every genuine Los Tres Amigos account still resolves to
//      DEFAULT_TENANT_ID exactly as before. Anything else throws.
//
// There is deliberately NO tolerant path for `account === null`. A
// pre-authentication caller that genuinely has no account yet (e.g.
// accountStore.js deciding which tenant's store to search BEFORE the
// account is known) must use resolveBootstrapTenantId() below instead --
// a distinctly-named function that makes that "not yet identified" search
// scope explicit rather than routing it through the same function that
// makes access-control decisions for an (attempted) identity.
export function resolveTenantId(account) {
  if (!account || typeof account !== 'object') {
    throw new TenantResolutionError('resolveTenantId: cannot resolve a tenant for a null or non-object account')
  }
  if ('tenantId' in account) {
    if (typeof account.tenantId !== 'string' || !isValidTenantId(account.tenantId)) {
      throw new TenantResolutionError('resolveTenantId: account.tenantId is present but is not a valid tenant id')
    }
    return account.tenantId
  }
  let membership
  try {
    membership = resolveSingleTenantMembershipForLogin(account)
  } catch (err) {
    throw new TenantResolutionError(`resolveTenantId: account could not be resolved to a tenant membership (${err.message})`)
  }
  if (!membership) {
    throw new TenantResolutionError('resolveTenantId: account resolved to no tenant membership')
  }
  return membership.tenantId
}

// The tenant to search BEFORE an account is known at all -- e.g.
// accountStore.js's getAccountById()/getAccountByEmail()/listAccounts()
// need to pick which tenant's Redis-backed user store to query before they
// have found (or ruled out) any account. This is NOT a security decision
// (it grants nothing by itself -- the account found, if any, still has its
// own disabled/sessionVersion/credential checks applied afterward) and is
// NOT the same question resolveTenantId() answers ("which tenant does this
// [already-identified-or-attempted] account belong to") -- it exists
// specifically so that question is never silently answered by passing
// `null` into resolveTenantId(), which would defeat the fail-closed
// guarantee above. Always returns DEFAULT_TENANT_ID today, since Phase 3
// onboards no second tenant and therefore has only one store to search.
export function resolveBootstrapTenantId() {
  return DEFAULT_TENANT_ID
}

// --- Tenant location catalog ownership (Multi-Tenant Phase 3) -----------
// Every location this deployment knows about (dashboard/private-data's
// meta.json and everything keyed off it -- reviews, per-location
// intelligence, the review-to-location internal index) belongs to
// DEFAULT_TENANT_ID: it is a single shared filesystem export, not a
// Redis store partitioned by tenantId the way the 9 stores Phase 2
// tenantized are. Phase 3 onboards no second tenant, so no location data
// exists anywhere for any other tenantId. This is the explicit,
// centralized statement of that fact -- any location-authorization check
// (see auth.js's requireLocationAccess/isWildcardGrant) MUST consult this
// before trusting an account's own locationIds grant, so a hypothetical
// future or synthetic tenant can never be authorized against a location
// that doesn't actually belong to it, even if its grant is '*' or an
// explicit array that happens to numerically collide with a Los Tres
// Amigos locationId. When a second tenant is actually onboarded (a later,
// separately reviewed phase, once per-tenant location data exists), this
// function -- not each call site -- is what will change.
export function tenantOwnsLocationCatalog(tenantId) {
  return tenantId === DEFAULT_TENANT_ID
}
