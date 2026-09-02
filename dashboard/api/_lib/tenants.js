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

import { getTenantConfig, TenantConfigStoreUnavailableError } from './tenantConfigStore.js'

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

// --- Tenant location catalog ownership (Multi-Tenant Phase 4E, closure) --
// Every location this deployment knows about lives under a tenant's own
// filesystem export (dashboard/api/_lib/reviewDataPaths.js's per-tenant
// private-data root, Phase 4D) and its own SQLite file (tenant_paths.py's
// per-tenant reviews.db, also Phase 4D) -- reviews, per-location
// intelligence, and the review-to-location internal index are all already
// physically partitioned by tenant. Two separate questions build on that:
//   tenantOwnsLocationCatalog(tenantId, authz)  -- is this TENANT active
//     and activated at all (tenantConfigStore.js's status/locationCatalogEnabled)
//   tenantOwnsLocation(tenantId, locationId, authz) -- does this SPECIFIC
//     numeric location id actually belong to that tenant's own approved
//     catalog (tenantConfigStore.js's approvedLocations, written by
//     google/[action].js's approveLocations() via a STABLE, persistent
//     googleLocationId -> localLocationId mapping -- see
//     tenantConfigStore.js's recordLocationApproval() for how ids never
//     drift or get reassigned across a re-approval)
// requireLocationAccess() (below) requires BOTH of these AND the account's
// own locationIds grant -- a location id or a wildcard grant alone can
// never establish ownership; only tenantOwnsLocation() can, and it is
// never satisfied merely because a numeric id happens to already exist in
// a reviews.db row somewhere (this project does not trust the future
// review database's contents as a tenant boundary -- authorization
// enforces ownership itself, from tenantConfigStore's own record).
//
// `authz` -- A REQUEST-BOUND AUTHORIZATION SNAPSHOT, NOT SHARED STATE
// (final review closure): earlier revisions cached this same
// {status, locationCatalogEnabled, approvedLocationIds} shape in a
// process-global `Map` keyed by tenantId, "primed" once per request. That
// was REJECTED on review: two concurrent requests for the SAME tenant can
// interleave their own async work around the prime-then-read pair (a
// rate-limit check, a credential-store read, anything else the handler
// `await`s in between), so a slower, chronologically OLDER request's write
// to that shared Map could still land AFTER a newer request's write and
// silently clobber it -- an older "active" read finishing after a newer
// "suspended" read could resurrect stale authorization for whichever
// request (even a third, unrelated one) reads the Map next. A Map keyed by
// tenantId is genuinely shared, persistent, cross-request module state; it
// does not become "request-scoped" merely because each request happens to
// write it right before reading it back.
//
// The fix: resolveLocationCatalogAuthz(tenantId) (below) is a pure
// function that RETURNS a fresh, frozen snapshot object -- it writes to
// NOTHING shared. auth.js's evaluateSession() calls it once per
// authenticated request and attaches the result directly onto that
// request's own, freshly-constructed account object (toSafeAccount()),
// exactly how `tenantId` itself is already attached -- never into any
// structure a second request could read or overwrite. tenantOwnsLocationCatalog()/
// tenantOwnsLocation() take that snapshot as an explicit parameter and
// consult NOTHING else; requireLocationAccess()/isWildcardGrant() read it
// off `account.locationCatalogAuthz` (the same account object every
// production call site already has in hand) and pass it through. Two
// concurrent requests -- for the same tenant or different ones -- now
// literally cannot interact: each holds its own snapshot object, on its
// own account object, with no shared mutable location for one to clobber
// the other's. See test_tenant_location_catalog_concurrency.js for the
// adversarial proof (deliberately interleaved/delayed resolves, mutation
// attempts on one snapshot checked against another, a failing resolve
// racing a succeeding one).
//
// The client can never supply or influence this snapshot: it is built
// exclusively from resolveTenantId(account) (server-derived, Phase 3) and
// a fresh tenantConfigStore.js read keyed by that same server-derived
// tenantId -- toSafeAccount() below never spreads or otherwise copies
// arbitrary fields from the raw account record or from request input into
// the safe account shape it returns.
//
// SYNC/ASYNC SEAM: every call site of these functions (auth.js and its 7
// production callers -- data.js, google/[action].js, actions/[action].js,
// tasks/[action].js, notifications/[action].js, reviewLocationIndex.js,
// notificationEvents.js) stays synchronous by design and by now-extensive
// precedent (test_authorization_matrix.js and test_permissions.js alone
// have dozens of synchronous assertions against these functions) --
// converting all of them to async would be a large, invasive change to
// frozen regression baselines for a benefit this design achieves without
// it. The one, single async step (the tenantConfigStore.js read) happens
// exactly once per request, inside evaluateSession(), before any
// synchronous authorization function is ever reached.
//
// TENANT STATUS SEMANTICS: a tenant owns its location catalog if and only
// if status === 'active' AND locationCatalogEnabled === true, both read
// fresh into the SAME snapshot on every resolve. A suspended tenant
// (status: 'suspended') is denied even though locationCatalogEnabled may
// still be true on the stored record -- suspension is a superseding
// state, not a field that must be separately cleared. An 'onboarding'
// tenant (approve-locations not yet completed) is denied. Any malformed
// record (a status other than the three known values, or a non-boolean
// locationCatalogEnabled) fails closed via plain strict equality -- there
// is no separate "is this well-formed" pre-check because none is needed:
// `status === 'active'` and `=== true` are already false for anything
// that isn't exactly right.
//
// MIGRATION MODE (unchanged from the prior revision -- still explicit,
// still not inferred from Redis contents): every tenant is in exactly one
// reviewed LocationCatalogMigrationMode --
//   BOOTSTRAP    -- ignores tenantConfigStore.js ENTIRELY; always owns its
//                   catalog and every location id, unconditionally. Not a
//                   fallback for "no record yet" -- a tenant in this mode
//                   never consults Redis for this decision AT ALL, whether
//                   or not a record exists, whether or not Redis is
//                   reachable, whether or not a record exists that says
//                   otherwise. This is what makes it a MODE, not a
//                   fallback: Redis contents can never override it, and no
//                   automatic transition out of it is possible.
//   REDIS_ONLY   -- the real, self-service path: status/locationCatalogEnabled/
//                   approvedLocations are read fresh from tenantConfigStore.js
//                   on every resolve; missing, deleted, malformed, or
//                   unreadable (Redis outage) config ALL fail closed to
//                   false, with no fallback of any kind.
// TENANT_LOCATION_CATALOG_MODE_REGISTRY below is the ONLY place a mode is
// assigned, and it is a plain object literal committed with the
// application -- not inferred, not defaulted from Redis state, not
// changeable at runtime. Los Tres Amigos is the one tenant explicitly
// registered as BOOTSTRAP today, preserving its current unconstrained
// behavior without writing production Redis. Every other tenant --
// including every future self-service tenant, which is never listed here
// at all -- is REDIS_ONLY by construction (the lookup below defaults to
// REDIS_ONLY for anything not explicitly registered as BOOTSTRAP), which
// is exactly what keeps self-service onboarding free of any source change.
//
// THE FUTURE LTA MIGRATION (not performed by this or any prior phase) is,
// in order: (1) create a verified, correct tenant_config record for
// t_los-tres-amigos in production Redis (reflecting its real, existing
// locations as approvedLocations); (2) change its entry below from
// BOOTSTRAP to REDIS_ONLY, as its own separately reviewed code change;
// (3) deploy that code+config transition together; (4) verify LTA's
// production behavior is unchanged post-deploy; (5) once confident, delete
// the BOOTSTRAP branch and TENANT_LOCATION_CATALOG_MODE_REGISTRY entirely,
// since REDIS_ONLY-for-everyone is the only mode that should exist
// long-term. There is no automatic transition between modes anywhere in
// this file -- every step above is a deliberate, reviewed, deployed change.
export const LocationCatalogMigrationMode = Object.freeze({
  BOOTSTRAP:   'bootstrap',
  REDIS_ONLY:  'redis_only',
})

const TENANT_LOCATION_CATALOG_MODE_REGISTRY = Object.freeze({
  [DEFAULT_TENANT_ID]: LocationCatalogMigrationMode.BOOTSTRAP,
})

function locationCatalogModeFor(tenantId) {
  return TENANT_LOCATION_CATALOG_MODE_REGISTRY[tenantId] ?? LocationCatalogMigrationMode.REDIS_ONLY
}

// Test-only seam, mirroring reviewDataPaths.js's _setPrivateDataRootForTests
// -- lets a test register a synthetic tenant as owning a location catalog
// AND every location id under it, directly (bypassing tenantConfigStore.js/
// Redis and the migration-mode distinction entirely), without touching
// production state. Existing tests written against earlier Phase 4E
// passes use this exact seam and continue to pass unchanged. This is the
// ONLY module-level mutable state left in this file for this feature, and
// it is exclusively a test double, never consulted by, or reachable from,
// any production request path (production code never calls the
// `_set.../_reset...` pair below).
let testRegistryOverride = null

export function _setLocationCatalogRegistryForTests(tenantIds) {
  testRegistryOverride = new Set(tenantIds)
}

export function _resetLocationCatalogRegistryForTests() {
  testRegistryOverride = null
}

// Resolves a FRESH, FROZEN, request-scoped authorization snapshot for
// tenantId -- called by auth.js's evaluateSession() exactly once per
// authenticated request, immediately after the account's tenant has been
// verified (never before -- an unverified/mismatched tenant claim must
// never reach even a Redis read keyed by it), and attached directly onto
// that request's own account object. Returns null for an invalid tenantId
// or for a BOOTSTRAP-mode tenant (nothing to resolve -- see
// tenantOwnsLocationCatalog()/tenantOwnsLocation() below, which answer
// unconditionally for BOOTSTRAP without ever consulting a snapshot, which
// is also what keeps this from ever issuing a Redis read for Los Tres
// Amigos, let alone a write). Writes to NO shared variable of any kind --
// every call produces an independent object; two concurrent calls (same
// tenant or different) can never observe or influence each other's result.
export async function resolveLocationCatalogAuthz(tenantId) {
  if (typeof tenantId !== 'string' || !isValidTenantId(tenantId)) return null
  if (locationCatalogModeFor(tenantId) === LocationCatalogMigrationMode.BOOTSTRAP) return null

  let config = null
  try {
    config = await getTenantConfig(tenantId)
  } catch (err) {
    console.error(`[tenants] could not read tenant config for ${JSON.stringify(tenantId)}: ${err instanceof TenantConfigStoreUnavailableError ? err.message : err}`)
    // REDIS_ONLY fails closed on a genuine store outage too -- there is no
    // mode this tenant could fall back into.
    return Object.freeze({ tenantId, status: null, locationCatalogEnabled: false, approvedLocationIds: [] })
  }
  if (config === null) {
    // No tenant_config record exists (never created, or deleted) --
    // REDIS_ONLY tenants fail closed.
    return Object.freeze({ tenantId, status: null, locationCatalogEnabled: false, approvedLocationIds: [] })
  }
  return Object.freeze({
    tenantId,
    status: config.status,
    locationCatalogEnabled: config.locationCatalogEnabled,
    approvedLocationIds: Object.freeze(
      Array.isArray(config.approvedLocations)
        ? config.approvedLocations.map(l => l?.locationId).filter(id => Number.isInteger(id))
        : []
    ),
  })
}

// `authz` must be the snapshot resolveLocationCatalogAuthz() produced FOR
// THIS EXACT tenantId (checked below) -- omitted/undefined for a
// BOOTSTRAP-mode tenant is fine (never consulted), but omitted for a
// REDIS_ONLY tenant fails closed, exactly like a genuinely missing record.
export function tenantOwnsLocationCatalog(tenantId, authz) {
  if (typeof tenantId !== 'string' || !tenantId) return false
  if (testRegistryOverride) return testRegistryOverride.has(tenantId)
  if (locationCatalogModeFor(tenantId) === LocationCatalogMigrationMode.BOOTSTRAP) return true
  if (!authz || authz.tenantId !== tenantId) return false
  return authz.status === 'active' && authz.locationCatalogEnabled === true
}

// Does this SPECIFIC numeric locationId actually belong to this tenant's
// own approved catalog. Requires tenantOwnsLocationCatalog() first (a
// suspended/onboarding/never-activated tenant owns no individual location
// either, regardless of what its approvedLocations list contains). For a
// BOOTSTRAP-mode tenant (Los Tres Amigos), every location id is owned
// unconditionally -- LTA's real locations were never run through the
// approve-locations flow at all, so there is no approvedLocations list to
// check against; this preserves its current, unconstrained behavior. For a
// REDIS_ONLY tenant, ownership requires the id to appear in the STABLE
// numeric locationId list recorded on that tenant's own config record
// (see tenantConfigStore.js's recordLocationApproval() for the persistent
// googleLocationId -> localLocationId mapping that makes these ids never
// drift across a re-approval) -- a location id existing in a reviews.db
// row, or in another tenant's approvedLocations (even the identical
// number), never counts.
export function tenantOwnsLocation(tenantId, locationId, authz) {
  if (!tenantOwnsLocationCatalog(tenantId, authz)) return false
  if (testRegistryOverride) return true
  if (locationCatalogModeFor(tenantId) === LocationCatalogMigrationMode.BOOTSTRAP) return true
  if (!authz || authz.tenantId !== tenantId) return false
  return Array.isArray(authz.approvedLocationIds) && authz.approvedLocationIds.includes(locationId)
}
