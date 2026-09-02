// The seam between authorization code and however accounts are actually
// stored -- Milestone 1 of the Phase 2 authorization plan. Every caller
// that needs "the account behind this id/email" goes through here, never
// through accounts.js's own loadAccountDirectory() directly. This is what
// let the Multi-Location Authentication & User Access System milestone
// replace only this file's internals -- an env-var-only parse became a
// dual-read against a durable store -- leaving every permission helper,
// every endpoint, and the whole role/location model unmodified.
//
// DUAL-READ (Commit 1 of that milestone): checks the Redis-backed
// userStore.js FIRST, falling back to the static ACCOUNT_DIRECTORY_JSON
// path only when Redis has no matching record. This is a deliberate,
// deterministic precedence rule, not a merge: once an account exists in
// Redis, it is authoritative for that identity, full stop. It exists so
// every new account (invited or self-service-reset) lives in Redis while
// the original hand-provisioned Owner accounts keep working from the
// static directory with zero migration required -- see README "Multi-
// Location Authentication" for the full migration story.
//
// FAILURE MODEL, load-bearing: userStore.js throws UserStoreUnavailableError
// on a missing/unreachable Redis. This file is the ONE place that catches
// that and degrades to static-directory-only, because ONLY the auth path
// carries the explicit requirement that a Redis outage must never take
// down the existing Owner accounts. Every other Redis-backed caller in this
// codebase (contactStore.js, auditLog.js, and this same userStore.js for
// non-auth callers like the Users & Access admin listing) lets the error
// propagate -- this is the one deliberate exception, and it only ever
// WIDENS availability (an account that exists only in the static directory
// still resolves), it never grants access to an account that doesn't
// legitimately exist.
//
// Edge AND Node runtime compatible -- the same constraint accounts.js
// itself has always had, since dashboard/middleware.js (Edge) calls this
// too. userStore.js's @upstash/redis client is a plain fetch-based REST
// client with no Node-only APIs, so it (unlike bcryptjs/fs) is safe here.

import { loadAccountDirectory, findAccountById, findAccountByEmail, normalizeEmail } from './accounts.js'
import {
  getUserById, getUserByEmail, listUsers, UserStoreUnavailableError,
  lookupIdentityByEmail, lookupTenantIdForUserId,
} from './userStore.js'
import { resolveBootstrapTenantId, DEFAULT_TENANT_ID } from './tenants.js'

// Multi-Tenant Phase 2/3: userStore.js's functions now require a tenantId.
// This module is the account-RESOLUTION layer -- it runs before any
// session/account is known (that's the whole point of "find the account
// behind this id/email"), so there is no `account` yet to resolve a
// tenant from.
//
// Multi-Tenant Phase 4K -- getAccountById()/getAccountByEmail() now consult
// userStore.js's GLOBAL identity index FIRST to learn which tenant actually
// owns a given userId/email, then perform a real, tenant-scoped read
// against THAT tenant's own store -- no more assuming every identity lives
// in the bootstrap tenant. An identity the index has never heard of (every
// Los Tres Amigos account, by construction -- see userStore.js's
// getUserIdentityMigrationMode()) falls back to EXACTLY today's LEGACY
// path: resolveBootstrapTenantId()'s own Redis hash, then the static
// ACCOUNT_DIRECTORY_JSON directory. This is a fallback for an unindexed
// IDENTITY, never an inference about a TENANT's migration status -- which
// tenants participate in the index at all is decided once, explicitly, by
// userStore.js's own reviewed registry (delegated from
// tenantDualRead.js's TENANT_MIGRATION_MODE), not by whether a lookup
// happens to come back empty.
//
// listAccounts(tenantId) is likewise now tenant-scoped (tenantId is a
// REQUIRED argument, no default) -- see its own header comment below for
// why a global, unscoped listing was itself a latent cross-tenant bug for
// every consumer (GET /api/session/accounts, the Users & Access admin
// roster, last-active-Owner counting) the moment a second tenant existed.

// A missing/invalid ACCOUNT_DIRECTORY_JSON is a whole-app misconfiguration
// (every static-directory account lookup fails, not just this one), so it's
// worth a single consistent log line regardless of which lookup triggered
// it -- this replaces the two slightly different '[auth]'/'[login]'-prefixed
// messages that used to live at each call site.
function loadDirectoryOrWarn() {
  const accounts = loadAccountDirectory()
  if (!accounts) {
    console.error('[accountStore] ACCOUNT_DIRECTORY_JSON is missing or invalid -- static-directory accounts unavailable.')
    return null
  }
  return accounts
}

// See the failure-model note above: a Redis outage degrades this ONE lookup
// to "not found in Redis" rather than propagating, so the caller falls
// through to the static directory instead of the whole request failing.
async function tryRedisLookup(fn, label) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof UserStoreUnavailableError) {
      console.error(`[accountStore] user store unreachable during ${label} -- falling back to the static directory only: ${err.message}`)
      return null
    }
    throw err
  }
}

export async function getAccountById(userId) {
  const indexedTenantId = await tryRedisLookup(() => lookupTenantIdForUserId(userId), `getAccountById(${userId}):identity-index`)
  if (indexedTenantId) {
    // Indexed identities are resolved EXCLUSIVELY within their own tenant --
    // if the tenant's own hash doesn't have it (a genuine inconsistency),
    // this does not fall through to the bootstrap hash; that would be a
    // cross-tenant leak vector, not a helpful fallback.
    return (await tryRedisLookup(() => getUserById(indexedTenantId, userId), `getAccountById(${userId}):indexed`)) ?? null
  }
  // LEGACY fallback -- exactly today's behavior, reached only for an
  // identity the index has never heard of (every Los Tres Amigos account).
  const redisUser = await tryRedisLookup(() => getUserById(resolveBootstrapTenantId(), userId), `getAccountById(${userId}):bootstrap`)
  if (redisUser) return redisUser
  const accounts = loadDirectoryOrWarn()
  if (!accounts) return null
  return findAccountById(accounts, userId)
}

// Multi-Tenant Phase 4K -- the lookup every TENANT-SCOPED user-management
// MUTATION endpoint (update-user-role-locations, disable-user, enable-user,
// update-user-can-create-tasks) must use instead of getAccountById() above.
// getAccountById() is intentionally CROSS-TENANT-capable (via the global
// identity index) -- exactly right for login/session re-validation, wrong
// for a mutation endpoint, where a caller-supplied userId must never be
// resolvable to a DIFFERENT tenant's account no matter what the identity
// index says. This function looks ONLY within `tenantId`'s own store: a
// direct, tenant-scoped Redis read (getUserById(tenantId, userId), never
// consulting the identity index or any other tenant's hash at all), plus
// -- ONLY when tenantId is DEFAULT_TENANT_ID -- the static
// ACCOUNT_DIRECTORY_JSON directory, so Los Tres Amigos's original,
// possibly-never-promoted-to-Redis accounts remain manageable through
// these same endpoints exactly as before this phase. A userId that
// genuinely belongs to a different tenant returns null here, structurally,
// the same 404 an unknown userId would produce -- never distinguishable,
// never a cross-tenant existence leak.
export async function getAccountByIdForTenant(tenantId, userId) {
  const redisUser = await tryRedisLookup(() => getUserById(tenantId, userId), `getAccountByIdForTenant(${userId})`)
  if (redisUser) return redisUser
  if (tenantId !== DEFAULT_TENANT_ID) return null
  const accounts = loadDirectoryOrWarn()
  if (!accounts) return null
  return findAccountById(accounts, userId)
}

export async function getAccountByEmail(email) {
  const indexed = await tryRedisLookup(() => lookupIdentityByEmail(email), 'getAccountByEmail:identity-index')
  if (indexed?.tenantId && indexed?.userId) {
    return (await tryRedisLookup(() => getUserById(indexed.tenantId, indexed.userId), 'getAccountByEmail:indexed')) ?? null
  }
  // LEGACY fallback -- exactly today's behavior.
  const redisUser = await tryRedisLookup(() => getUserByEmail(resolveBootstrapTenantId(), email), `getAccountByEmail:bootstrap`)
  if (redisUser) return redisUser
  const accounts = loadDirectoryOrWarn()
  if (!accounts) return null
  return findAccountByEmail(accounts, email)
}

// Merged, de-duplicated listing FOR ONE TENANT: every Redis user belonging
// to `tenantId`, plus (ONLY for Los Tres Amigos, DEFAULT_TENANT_ID) every
// static-directory account whose normalized email is NOT already present
// in Redis (Redis wins on precedence, same rule as the single-record
// lookups above) -- so a legacy static account that has since been
// "promoted" into Redis (e.g. re-provisioned through the invite flow) is
// never listed twice.
//
// `tenantId` is REQUIRED (Multi-Tenant Phase 4K) -- there is no such thing
// as a meaningful global account listing in a multi-tenant system, and a
// caller that genuinely needs cross-tenant discovery (platform-admin
// tooling) must say so explicitly rather than getting it as this
// function's default. The static ACCOUNT_DIRECTORY_JSON directory is
// consulted ONLY when tenantId === DEFAULT_TENANT_ID -- every account it
// can ever describe is implicitly Los Tres Amigos's own (it has no
// tenantId field at all; see tenants.js's resolveTenantId(), which maps an
// account with no explicit tenantId to DEFAULT_TENANT_ID via legacy role
// mapping), so it would be actively wrong to merge it into any other
// tenant's roster.
export async function listAccounts(tenantId) {
  if (typeof tenantId !== 'string' || !tenantId) {
    throw new TypeError('listAccounts: tenantId is required')
  }
  const redisUsers = await tryRedisLookup(() => listUsers(tenantId), 'listAccounts') ?? []
  if (tenantId !== DEFAULT_TENANT_ID) return redisUsers

  const redisEmails = new Set(redisUsers.map(u => normalizeEmail(u.email)))
  const staticAccounts = loadDirectoryOrWarn() ?? []
  const staticOnly = staticAccounts.filter(a => !redisEmails.has(normalizeEmail(a.email)))

  return [...redisUsers, ...staticOnly]
}
