// Node-only authorization orchestrator. This is the AUTHORITATIVE layer --
// dashboard/middleware.js performs a lightweight version of this same check
// at the Edge for defense-in-depth, but every API handler calls requireAuth
// independently and never trusts that middleware already ran (a route not
// covered by the middleware matcher, a misconfigured matcher, or a future
// change must not silently lose protection).
//
// What this checks, in order (mirrors the session-lifecycle design):
//   1. Cookie present and signature/expiry valid (via _lib/session.js).
//   2. The account still exists in the CURRENT account directory.
//   3. The account is not disabled.
//   4. The token's sessionVersion matches the account's CURRENT
//      sessionVersion -- a password change, role change, or removal bumps
//      this and immediately invalidates every outstanding token for that
//      account, even ones issued seconds ago.
//   5. The account's CURRENT role is in the caller's allowed-roles list --
//      decided from the freshly-read account record, never from the
//      possibly-stale role claim embedded in the cookie.

import { parseCookies } from '../google/_lib/cookies.js'
import { verifySession, SESSION_COOKIE } from './session.js'
import { getAccountById } from './accountStore.js'
import { Permission, roleHasPermission } from './permissions.js'
import { resolveTenantId, tenantOwnsLocationCatalog, tenantOwnsLocation, resolveLocationCatalogAuthz, DEFAULT_TENANT_ID } from './tenants.js'

// Never include passwordHash (or anything else not needed by the caller) in
// data that might reach the frontend or a log line. The only caller is
// evaluateSession() below, so this lives here rather than in accountStore.js
// -- account lookup and account shaping are separate concerns.
//
// Multi-Tenant Phase 3: `tenantId` is now part of this shape -- the value
// passed in is ALWAYS the freshly server-derived tenantId evaluateSession()
// just verified (see below), never the raw session-cookie claim directly.
// This is what lets every downstream call site (every endpoint's
// resolveTenantId(account) call, requireLocationAccess(), the 9 Phase-2
// tenant-scoped stores) simply read account.tenantId off an already-
// authenticated account without re-deriving or re-verifying anything --
// resolveTenantId() (tenants.js) trusts this field precisely because only
// this one function ever attaches it.
// `locationCatalogAuthz` -- Multi-Tenant Phase 4E closure: a REQUEST-BOUND
// authorization snapshot (tenants.js's resolveLocationCatalogAuthz()),
// attached here exactly like `tenantId` already is -- always the value
// evaluateSession() JUST resolved for this exact request from a fresh
// tenantConfigStore.js read keyed by the server-derived tenantId above,
// never from request input, and never written to any shared/module-level
// location a second request could read or overwrite. requireLocationAccess()/
// isWildcardGrant() (below) read it directly off this field. This function
// never spreads `...account` -- every field on the object it returns is
// explicitly named, so nothing from the raw account record (or, by
// construction, from request input) can smuggle its own
// locationCatalogAuthz-shaped value through.
function toSafeAccount(account, tenantId, locationCatalogAuthz) {
  if (!account) return null
  return {
    userId: account.userId,
    email: account.email,
    role: account.role,
    locationIds: account.locationIds,
    tenantId,
    locationCatalogAuthz,
    displayName: account.displayName ?? account.email,
    // Operations Calendar + Content Library milestone -- only meaningful
    // for role: 'location_manager' (see canCreateTask() below), but exposed
    // on every account's own session shape so the frontend can gate its
    // "+ Add Task" button without a second round trip.
    canCreateTasks: Boolean(account.canCreateTasks),
  }
}

// Returns { account, reason } where account is null on failure and reason
// is one of 'unauthenticated' | 'session_expired' | 'tenant_mismatch' |
// 'forbidden' when it is. Does not touch `res` -- used by both requireAuth()
// (JSON API responses) and auth.js (an HTML/redirect endpoint that needs a
// different failure presentation).
//
// Multi-Tenant Phase 3, TENANT VERIFICATION (mirrors the existing
// sessionVersion pattern exactly): the session cookie's `tenantId` claim is
// never trusted on its own. On every request, this re-derives the
// account's CURRENT tenant fresh via resolveTenantId(account) -- called
// here with the RAW account record from accountStore.js, which never
// carries a `tenantId` field itself, so this always re-derives it from the
// account's own role via the Phase 1 membership transform, exactly as if
// the claim didn't exist. If that freshly-derived value doesn't match what
// the token claims, the whole session is rejected (same failure class as a
// stale sessionVersion) BEFORE any permission or location check ever runs
// -- a tampered, forged, or stale tenantId claim can never reach a
// resource. Because every real account resolves to exactly one tenant
// today (DEFAULT_TENANT_ID), this check is a no-op for every legitimate
// Los Tres Amigos session and only ever fires for a claim that could not
// have been produced by this codebase's own signSession() callers.
//
// Phase 3 hardening: resolveTenantId() now FAILS CLOSED (throws
// TenantResolutionError) rather than defaulting to DEFAULT_TENANT_ID for
// anything it cannot positively resolve. A currently-stored account record
// should never reach that state (accountStore.js/userStore.js only ever
// persist accounts that already passed a strict shape validator), but if
// one somehow did (e.g. a hand-edited ACCOUNT_DIRECTORY_JSON, or a Redis
// record corrupted out-of-band), this MUST reject the session the same
// safe way a tenant mismatch does -- never propagate as an unhandled
// error, and never leak which field was invalid to the response body.
export async function evaluateSession(req, allowedRoles) {
  const cookies = parseCookies(req)
  const claims = await verifySession(cookies[SESSION_COOKIE])
  if (!claims) return { account: null, reason: 'unauthenticated' }

  const account = await getAccountById(claims.userId)
  if (!account || account.disabled) return { account: null, reason: 'unauthenticated' }

  if (account.sessionVersion !== claims.sessionVersion) {
    return { account: null, reason: 'session_expired' }
  }

  let currentTenantId
  try {
    currentTenantId = resolveTenantId(account)
  } catch (err) {
    console.error(`[auth] tenant resolution failed for userId ${claims.userId}: ${err.message}`)
    return { account: null, reason: 'tenant_mismatch' }
  }
  if (claims.tenantId !== currentTenantId) {
    return { account: null, reason: 'tenant_mismatch' }
  }

  if (allowedRoles && !allowedRoles.includes(account.role)) {
    return { account: null, reason: 'forbidden' }
  }

  // Multi-Tenant Phase 4E closure: resolves a FRESH, request-bound
  // authorization snapshot from tenantConfigStore.js (Redis) for THIS
  // request's own, just-verified tenantId -- never a client-supplied one,
  // and never written anywhere a second request could read or clobber it
  // (see tenants.js's header comment for the concurrency reasoning this
  // replaced a process-global Map to satisfy). Attached directly onto
  // this request's own account object below.
  const locationCatalogAuthz = await resolveLocationCatalogAuthz(currentTenantId)

  return { account: toSafeAccount(account, currentTenantId, locationCatalogAuthz), reason: null }
}

// Maps an evaluateSession() failure `reason` to the correct HTTP status per
// the frozen API error contract: 401 for "no valid identity at all"
// (unauthenticated / session_expired / tenant_mismatch -- a tenant-claim
// mismatch is an invalid-identity condition, the same tier as a stale
// sessionVersion, never a "valid identity, wrong capability" 403), 403 for
// "valid identity, wrong capability" (forbidden -- includes an
// unrecognized/unknown role, which evaluateSession() already fails closed
// into 'forbidden' rather than granting access). Shared by any endpoint
// that calls evaluateSession() directly instead of requireAuth() -- today
// that's the HTML-responding Google OAuth endpoints (auth.js/callback.js),
// which need a different failure presentation than requireAuth()'s JSON
// body but must still use the same status-code decision.
export function statusForAuthFailure(reason) {
  return reason === 'forbidden' ? 403 : 401
}

// JSON-API form: writes the 401/403 response itself and returns null, or
// returns the current account record (safe subset) on success. Caller's
// only job is `if (!account) return`.
export async function requireAuth(req, res, allowedRoles) {
  const { account, reason } = await evaluateSession(req, allowedRoles)
  if (account) return account

  if (reason === 'forbidden') {
    res.status(403).json({ error: 'forbidden', message: 'You do not have permission to perform this action.' })
  } else if (reason === 'session_expired' || reason === 'tenant_mismatch') {
    res.status(401).json({ error: 'session_expired', message: 'Your session is no longer valid. Please sign in again.' })
  } else {
    res.status(401).json({ error: 'unauthenticated', message: 'Sign in required.' })
  }
  return null
}

// Multi-Tenant Phase 4H.1 -- the authorization boundary for the new
// cross-tenant tenant-operations status page (dashboard/api/tenant-ops/
// [action].js). This is DELIBERATELY narrower than a per-tenant 'owner':
// every other role/permission check in this codebase (roleHasPermission(),
// tenantOwnsLocation(), etc.) is scoped to the CALLER'S OWN tenant, but the
// tenant-ops page shows OTHER tenants' provisioning/sync state -- a real
// Tenant B's own Owner must never see this, only the platform operator.
// Los Tres Amigos is that operator (the business actually running this
// codebase) -- reusing its own existing Owner accounts, rather than
// inventing a new role or a new account flag, is the smallest change that
// satisfies "super-admin-only" without adding a second, parallel
// authorization system. If this platform ever needs a genuinely distinct
// platform-operator identity (independent of any one tenant), that is a
// separate, explicitly reviewed change -- not assumed here.
export function isSuperAdmin(account) {
  return Boolean(account) && account.role === 'owner' && resolveTenantId(account) === DEFAULT_TENANT_ID
}

// --- Phase 2 Milestone 2: composable, location-aware authorization -------
// Everything below is additive and, as of this milestone, unused by any
// endpoint. requireAuth() above is unchanged. These build on top of it
// rather than replacing it -- most endpoints will eventually call
// requireScopedAuth() instead of requireAuth() directly, but none do yet.

// Pure, synchronous, trivially unit-testable: does this account's location
// grant reach a given location? '*' means every location belonging to the
// account's OWN TENANT -- never every location platform-wide, even though,
// with exactly one real tenant today, those two sets happen to be
// identical (see tenants.js's WILDCARD SEMANTICS note). Otherwise the id
// must appear in the account's explicit list.
//
// Multi-Tenant Phase 3, RESOURCE-TENANT CHECK: before consulting the
// account's own grant at all, this verifies the account's tenant actually
// OWNS the location catalog a locationId is drawn from (dashboard/
// private-data/meta.json and everything keyed off it -- a single shared
// filesystem export, not one of the 9 Redis stores Phase 2 tenant-scoped
// by key). This is the "verify location belongs to the same tenant" step
// the Phase 3 authorization ordering requires, checked BEFORE "verify the
// user's location grant within that tenant" (the array/wildcard check
// below) -- so a wildcard grant, or an explicit array that happens to
// numerically collide with a Los Tres Amigos locationId, can never
// authorize an account whose tenant doesn't actually own any locations at
// all. tenantOwnsLocationCatalog() returns true only for DEFAULT_TENANT_ID
// today (Phase 3 onboards no second tenant), so this is a no-op for every
// real Los Tres Amigos account and denies outright for any other tenantId.
//
// Fails closed on any malformed shape rather than throwing -- a missing
// account, a missing/null/non-array locationIds, an account that
// resolveTenantId() (tenants.js, Phase 3 hardening) cannot safely resolve
// to any tenant at all, or any other unexpected shape simply denies access
// instead of raising. In practice accountStore.js only ever hands back
// accounts that already passed accounts.js's strict validator (locationIds
// is always '*' or a valid array of positive integers) and evaluateSession()
// only ever attaches an already-verified tenantId, so this defends against
// a hypothetical malformed caller, not a reachable production state. No
// normalization is performed -- a string locationId is still denied
// against a numeric grant unless that is explicitly designed later.
function tenantIdOrNull(account) {
  try {
    return resolveTenantId(account)
  } catch {
    // resolveTenantId() now throws (fail-closed) for anything it cannot
    // positively resolve -- translating that into `null` here preserves
    // this file's own "never throw, always deny" contract, since `null`
    // can never satisfy tenantOwnsLocationCatalog() below.
    return null
  }
}

// Multi-Tenant Phase 4E (closure): requires BOTH conditions, in this order --
// (1) tenantOwnsLocation(tenantId, locationId, account.locationCatalogAuthz):
// this SPECIFIC numeric id actually belongs to the account's own tenant's
// approved catalog (tenants.js -- backed by tenantConfigStore.js's
// approvedLocations via a stable, persistent googleLocationId ->
// localLocationId mapping, never by whether a matching row merely exists
// in some reviews.db), and (2) the account's OWN locationIds grant
// (wildcard or explicit array) covers it. Neither alone is sufficient: a
// wildcard or explicit grant can never widen ownership beyond what the
// tenant's own catalog contains, and the tenant owning a location can
// never widen an individual non-wildcard account's own assignment beyond
// its explicit array.
//
// account.locationCatalogAuthz is the request-bound snapshot
// evaluateSession() attached to THIS account object -- never a
// process-global lookup keyed by tenantId (see tenants.js's header
// comment). A hand-built account object with no such field (every
// pre-existing test in this codebase, and any account for a BOOTSTRAP-mode
// tenant) is handled correctly by tenantOwnsLocation()'s own fail-closed/
// BOOTSTRAP-unconditional handling of an absent snapshot.
export function requireLocationAccess(account, locationId) {
  if (!account) return false
  if (!tenantOwnsLocation(tenantIdOrNull(account), locationId, account.locationCatalogAuthz)) return false
  const { locationIds } = account
  if (locationIds === '*') return true
  if (!Array.isArray(locationIds)) return false
  return locationIds.includes(locationId)
}

// Write-side specialization of requireLocationAccess -- the check is
// identical, but a distinct name keeps call sites self-documenting (reading
// a publish/reply path, "requireOwnership" states intent more clearly than
// a second call to "requireLocationAccess" would).
export function requireOwnership(account, resourceLocationId) {
  return requireLocationAccess(account, resourceLocationId)
}

// Multi-Tenant Phase 3: the centralized answer to "does this account's
// wildcard grant actually mean something" -- true only for a wildcard
// account whose tenant owns a location catalog at all. Every call site
// that used to shortcut on a bare `account.locationIds === '*'` before
// (or instead of) calling requireLocationAccess/resolving a per-location
// resource now goes through this so "wildcard access always has tenant
// context," per the Phase 3 requirement -- a wildcard grant for a tenant
// that owns no locations (any tenant other than DEFAULT_TENANT_ID today)
// must never be treated as "sees everything," only as "sees nothing."
export function isWildcardGrant(account) {
  return Boolean(account) && account.locationIds === '*' && tenantOwnsLocationCatalog(tenantIdOrNull(account), account?.locationCatalogAuthz)
}

// The composite most endpoints will eventually call: authenticate, check
// the role carries the required permission, then (if the request concerns
// a specific location) check the account's location grant covers it.
//
// `resolveLocationId(req, account)` returns the location id the request
// concerns, or null/undefined if the request isn't location-scoped (e.g. a
// company-wide view). It receives `account` so it can special-case a
// wildcard grant if resolving the id would otherwise require extra work.
//
// A location outside the account's grant returns 404, not 403 -- see the
// Phase 2 architecture's API error contract (§6): 403 would confirm the
// resource exists but is off-limits, disclosing its existence to an
// account that shouldn't even know to ask.
// `permission` may be a single Permission constant, or an array of them
// (ANY-of semantics -- the account needs at least one). The array form
// exists for the unrestricted/`_ASSIGNED` permission pairs (REPLY vs.
// REPLY_ASSIGNED, EXPORT vs. EXPORT_ASSIGNED): owner/marketing hold the
// unrestricted variant, location_manager (and a location-scoped marketing
// account) hold the `_ASSIGNED` variant -- both must be allowed to reach
// this same endpoint, with requireLocationAccess()'s own wildcard-vs-array
// handling (below) doing the actual scoping either way. Backward
// compatible: a single string still behaves exactly as before (a
// one-element ANY-of is the same check).
export async function requireScopedAuth(req, res, { permission, resolveLocationId }) {
  const account = await requireAuth(req, res, null)
  if (!account) return null

  const permissions = Array.isArray(permission) ? permission : [permission]
  if (!permissions.some(p => roleHasPermission(account.role, p))) {
    res.status(403).json({ error: 'forbidden', message: 'You do not have permission to perform this action.' })
    return null
  }

  const locationId = await resolveLocationId(req, account)
  if (locationId != null && !requireLocationAccess(account, locationId)) {
    res.status(404).json({ error: 'not_found' })
    return null
  }

  return { account, locationId }
}

// Operations Calendar + Content Library milestone: whether this account may
// create a task. Deliberately NOT folded into ROLE_PERMISSIONS -- that table
// is a pure function of role alone (owner/admin/marketing hold TASK_CREATE
// unconditionally), and a per-account override doesn't belong inside a
// table meant to answer "what can this ROLE do". A location_manager account
// never holds TASK_CREATE via the role table (see permissions.js); this is
// the ONE place that combines the role grant with the explicit, Owner/
// Admin-controlled `canCreateTasks` flag (Users & Access, USERS_MANAGE-
// gated) that lets a specific manager create tasks within their own
// authorized locations. Every other role's answer is unaffected by
// `canCreateTasks` -- the flag is inert noise on any account it doesn't
// apply to.
export function canCreateTask(account) {
  if (!account) return false
  return roleHasPermission(account.role, Permission.TASK_CREATE) || Boolean(account.canCreateTasks)
}
