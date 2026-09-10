// The durable, dynamically-writable user directory -- Multi-Location
// Authentication & User Access System, Commit 1. This is the "hosted `users`
// table" accounts.js's own header comment anticipated ("promote this same
// shape into a users table once the hosted-database phase lands") -- except
// the smallest reliable persistent store already compatible with this
// project is Upstash Redis (already used for the publish bridge, Action
// Center, Restaurant Contacts, and the audit log), not a new database.
//
// Storage: two Redis hashes, following contactStore.js's established
// "one hash per directory" shape --
//   USERS_KEY       (users:v1)             field = userId,          value = JSON record
//   EMAIL_INDEX_KEY  (users_email_index:v1) field = normalizedEmail, value = userId
// The email index exists because login looks up by email, not userId, and a
// Redis hash has no secondary index -- this mirrors how contactStore.js is
// keyed by locationId (its own natural lookup key) while this store needs
// two.
//
// Record shape (superset of accounts.js's static-directory shape -- every
// field that shape has, plus the fields Phase 2 of this milestone requires):
//   userId, email, passwordHash (null until the invitee sets one),
//   role, locationIds ('*' or int[]), sessionVersion, disabled,
//   displayName, createdAt, updatedAt, lastLoginAt, invitedAt, passwordSetAt
// `status` ('invited' | 'active' | 'disabled') is deliberately NOT stored --
// it's derived (deriveUserStatus() below) from disabled/passwordSetAt so it
// can never drift from the fields that actually gate behavior.
//
// Edge runtime note: unlike bcryptjs/fs, @upstash/redis's client is a plain
// fetch-based REST client with no Node-only APIs, so -- unlike password.js --
// this file IS safe to import from dashboard/middleware.js (Edge). It is
// imported there indirectly via accountStore.js's dual-read.
//
// Failure model: every function here throws UserStoreUnavailableError on a
// missing/unreachable Redis, the same "never fail open on a write, never
// silently show a false empty result on a read" convention contactStore.js
// and auditLog.js use. accountStore.js (the auth-path caller) is
// deliberately the ONE place that catches this and degrades to
// static-directory-only, because ONLY the auth path has the requirement
// that a Redis outage must never take down the existing Owner accounts --
// every other caller (the Users & Access admin UI) should see a real
// failure, not a silently-incomplete user list.

import { Redis } from '@upstash/redis'
import { normalizeEmail, isValidLocationIds, ROLES } from './accounts.js'
import { usersKeyV2, usersEmailIndexKeyV2 } from './tenantKeys.js'
import { resolveHashReadKey, resolveHashWriteKey, getTenantMigrationMode, TenantMigrationMode } from './tenantDualRead.js'

const USERS_KEY = 'users:v1'
const EMAIL_INDEX_KEY = 'users_email_index:v1'

// --- Global identity index (Multi-Tenant Phase 4K) -------------------------
// Every account record above is TENANT-SCOPED (its own per-tenant hash, or
// the LEGACY bootstrap hash) -- but login and every other pre-authentication
// lookup starts with ONLY an email or a userId, with no tenant known yet.
// Before this phase, that gap was papered over by always searching the ONE
// bootstrap tenant's hash (accountStore.js's resolveBootstrapTenantId()
// calls) -- correct by accident while Los Tres Amigos is the only tenant,
// silently broken the moment a second, TENANT_SCOPED-mode tenant's users
// are created (their records live in THEIR OWN usersKeyV2() hash, which
// the bootstrap-only lookup never even looks at).
//
// This index is deliberately GLOBAL (no tenant segment in its key, unlike
// every other key in tenantKeys.js) and deliberately minimal: it stores
// ONLY {tenantId, userId} per email, and tenantId per userId -- enough to
// locate the tenant-owned account, nothing else. It is a POINTER, never a
// second copy of account data; accountStore.js still performs a real,
// tenant-scoped getUserById()/getUserByEmail() read after consulting it.
//
// EMAIL IS GLOBALLY UNIQUE BY DESIGN in this system (see
// settings/[action].js's inviteUserAction(), which already rejects an
// invite for an email that resolves to ANY existing account, checked via
// the cross-tenant-capable accountStore.js:getAccountByEmail() -- this
// phase does not change that intent, only makes the lookup that enforces
// it actually correct for a second tenant). There is therefore no
// "disambiguation" case to design for the SAME email existing in two
// tenants -- it is a precondition violation, prevented at write time, not
// a runtime ambiguity to resolve at read time.
//
// MIGRATION MODE, explicit and delegated (never inferred from a record's
// absence): a tenant's participation in this index is decided by the exact
// same, already-reviewed per-tenant registry tenantDualRead.js uses to
// decide WHERE a tenant's own user hash lives (TENANT_MIGRATION_MODE) --
// see getUserIdentityMigrationMode() below. Los Tres Amigos (LEGACY) is
// never written to this index by upsertUser() below, exactly preserving
// its current, index-free resolution path (accountStore.js's bootstrap+
// static-directory fallback) with zero behavior change. Every
// TENANT_SCOPED-mode tenant (every tenant other than Los Tres Amigos) is
// unconditionally indexed on every upsertUser() call.
export const UserIdentityMigrationMode = Object.freeze({
  LEGACY: 'legacy',
  TENANT_SCOPED: 'tenant_scoped',
})

// Deliberately DELEGATES to tenantDualRead.js's own registry rather than
// maintaining a second, independently-driftable one -- a tenant's identity-
// index participation and its user-hash storage location answer the exact
// same underlying question ("has this tenant been migrated off the
// bootstrap/LEGACY path yet"), so one reviewed change to
// TENANT_MIGRATION_MODE moves both at once, never one without the other.
export function getUserIdentityMigrationMode(tenantId) {
  return getTenantMigrationMode(tenantId) === TenantMigrationMode.LEGACY
    ? UserIdentityMigrationMode.LEGACY
    : UserIdentityMigrationMode.TENANT_SCOPED
}

const IDENTITY_INDEX_BY_EMAIL_KEY = 'identity_index_by_email:v1'
const IDENTITY_INDEX_BY_USER_ID_KEY = 'identity_index_by_user_id:v1'

async function writeIdentityIndexEntries(client, tenantId, userId, normalizedEmail) {
  await client.hset(IDENTITY_INDEX_BY_EMAIL_KEY, { [normalizedEmail]: JSON.stringify({ tenantId, userId }) })
  await client.hset(IDENTITY_INDEX_BY_USER_ID_KEY, { [userId]: tenantId })
}

// Looks up the {tenantId, userId} a normalized email belongs to via the
// GLOBAL identity index. Returns null if this email was never indexed
// (every LEGACY-mode tenant's accounts, by construction -- never a
// migration-status inference, see the header above) or is genuinely
// unknown. Throws UserStoreUnavailableError on a real store outage,
// exactly like every other read in this file -- accountStore.js is the
// one caller that catches this and degrades to its own LEGACY fallback.
export async function lookupIdentityByEmail(email) {
  const client = getClient()
  if (!client) throw new UserStoreUnavailableError('user store is not configured')
  const normalized = normalizeEmail(email)
  let raw
  try {
    raw = await client.hget(IDENTITY_INDEX_BY_EMAIL_KEY, normalized)
  } catch (err) {
    throw new UserStoreUnavailableError(`user store unreachable: ${err.message}`)
  }
  return parseRecord(raw)
}

// Looks up which tenant owns a given userId, via the GLOBAL identity
// index. Returns null (not a tenantId) if never indexed -- same LEGACY/
// unknown distinction as lookupIdentityByEmail() above.
export async function lookupTenantIdForUserId(userId) {
  const client = getClient()
  if (!client) throw new UserStoreUnavailableError('user store is not configured')
  try {
    return (await client.hget(IDENTITY_INDEX_BY_USER_ID_KEY, userId)) || null
  } catch (err) {
    throw new UserStoreUnavailableError(`user store unreachable: ${err.message}`)
  }
}

// Multi-Tenant Phase 2: every exported function below now takes `tenantId`
// as its first argument -- see tenantDualRead.js's header for the full
// read/write rule. For DEFAULT_TENANT_ID (the only tenant that exists
// today), this resolves to exactly USERS_KEY/EMAIL_INDEX_KEY, unchanged --
// nothing about login, the Users & Access admin list, or invite/reset
// behavior changes for Los Tres Amigos as a result of this refactor.

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class UserStoreUnavailableError extends Error {}

function hasUpstashConfig() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

function getClient() {
  if (testClientFactory) return testClientFactory()
  if (!hasUpstashConfig()) return null
  if (!redisClient) {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  }
  return redisClient
}

function parseRecord(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// 'invited' | 'active' | 'disabled' | 'revoked' | 'expired', derived so it
// can never drift from the fields that actually gate login/authorization --
// see the header comment. Order is deliberate: disabled always wins (an
// account explicitly turned off, regardless of how it got there); an
// account that has genuinely set a password is 'active' even if it still
// carries stale invite metadata; only then do the not-yet-accepted invite
// states (revoked/expired/invited) apply.
export function deriveUserStatus(record) {
  if (!record) return null
  if (record.disabled) return 'disabled'
  // A static (ACCOUNT_DIRECTORY_JSON) account has none of the Redis-only
  // invite-tracking fields at all -- the field's ABSENCE (not just a null
  // value) means "never went through the invite flow", i.e. active by
  // default, same as passwordSetAt being genuinely set for a Redis user.
  if (!('passwordSetAt' in record) || record.passwordSetAt) return 'active'
  if (record.inviteRevokedAt) return 'revoked'
  if (record.inviteExpiresAt && new Date(record.inviteExpiresAt).getTime() < Date.now()) return 'expired'
  return 'invited'
}

export async function getUserById(tenantId, userId) {
  const client = getClient()
  if (!client) throw new UserStoreUnavailableError('user store is not configured')
  let raw
  try {
    const key = await resolveHashReadKey(client, { v1Key: USERS_KEY, v2Key: usersKeyV2(tenantId), tenantId })
    raw = key ? await client.hget(key, userId) : null
  } catch (err) {
    throw new UserStoreUnavailableError(`user store unreachable: ${err.message}`)
  }
  return parseRecord(raw)
}

export async function getUserByEmail(tenantId, email) {
  const client = getClient()
  if (!client) throw new UserStoreUnavailableError('user store is not configured')
  const normalized = normalizeEmail(email)
  let userId
  try {
    const indexKey = await resolveHashReadKey(client, { v1Key: EMAIL_INDEX_KEY, v2Key: usersEmailIndexKeyV2(tenantId), tenantId })
    userId = indexKey ? await client.hget(indexKey, normalized) : null
  } catch (err) {
    throw new UserStoreUnavailableError(`user store unreachable: ${err.message}`)
  }
  if (!userId) return null
  return getUserById(tenantId, userId)
}

// Returns every user record (no filtering) -- callers (the Users & Access
// admin action, assertNotLastActiveOwner) are responsible for any
// filtering/sanitization they need.
export async function listUsers(tenantId) {
  const client = getClient()
  if (!client) throw new UserStoreUnavailableError('user store is not configured')
  let raw
  try {
    const key = await resolveHashReadKey(client, { v1Key: USERS_KEY, v2Key: usersKeyV2(tenantId), tenantId })
    raw = key ? await client.hgetall(key) : {}
  } catch (err) {
    throw new UserStoreUnavailableError(`user store unreachable: ${err.message}`)
  }
  const out = []
  for (const value of Object.values(raw ?? {})) {
    const record = parseRecord(value)
    if (record) out.push(record)
  }
  return out
}

function isValidRoleIncludingAdmin(role) {
  return ROLES.includes(role) // 'admin' is added to accounts.js's ROLES in this same commit
}

// Creates or fully replaces a user record. Both the primary hash and the
// email index are written -- if the email changed (not currently exposed by
// any endpoint, but defended here so this function is safe if that changes
// later), the OLD email's index entry is left stale unless `previousEmail`
// is passed, since a hash has no atomic "rename key" -- callers that ever
// change email must pass the prior value explicitly.
//
// Minimal shape validation only (role is a known role, locationIds is
// well-formed if present) -- the caller (invitation-accept, user-management
// actions) is responsible for its own request-body validation; this is a
// second, defensive layer, matching contactStore.js's division of labor.
export async function upsertUser(tenantId, record, { previousEmail } = {}) {
  const client = getClient()
  if (!client) throw new UserStoreUnavailableError('user store is not configured')
  if (!record || typeof record.userId !== 'string' || !record.userId) {
    throw new Error('upsertUser: record.userId is required')
  }
  if (!isValidRoleIncludingAdmin(record.role)) {
    throw new Error(`upsertUser: invalid role "${record.role}"`)
  }
  // Multi-Tenant Phase 4K: allowEmpty -- the DYNAMIC store, unlike the
  // static ACCOUNT_DIRECTORY_JSON directory, can legitimately reach zero
  // authorized locations at runtime (see isValidLocationIds()'s own header
  // comment). This does not loosen anything for hand-authored config.
  if (!isValidLocationIds(record.locationIds, { allowEmpty: true })) {
    throw new Error('upsertUser: invalid locationIds')
  }

  const usersKey = resolveHashWriteKey({ v1Key: USERS_KEY, v2Key: usersKeyV2(tenantId), tenantId })
  const emailIndexKey = resolveHashWriteKey({ v1Key: EMAIL_INDEX_KEY, v2Key: usersEmailIndexKeyV2(tenantId), tenantId })

  const normalized = normalizeEmail(record.email)
  const toWrite = { ...record, email: normalized }

  try {
    await client.hset(usersKey, { [record.userId]: JSON.stringify(toWrite) })
    await client.hset(emailIndexKey, { [normalized]: record.userId })
    if (previousEmail && normalizeEmail(previousEmail) !== normalized) {
      await client.hdel(emailIndexKey, normalizeEmail(previousEmail))
    }
    // Multi-Tenant Phase 4K -- maintain the GLOBAL identity index for any
    // TENANT_SCOPED-mode tenant. Los Tres Amigos (LEGACY) is deliberately
    // NEVER written here, even though it goes through this exact same
    // upsertUser() call for password resets/promotions today -- its
    // resolution path stays index-free, exactly as before this phase.
    if (getUserIdentityMigrationMode(tenantId) === UserIdentityMigrationMode.TENANT_SCOPED) {
      await writeIdentityIndexEntries(client, tenantId, record.userId, normalized)
      if (previousEmail && normalizeEmail(previousEmail) !== normalized) {
        await client.hdel(IDENTITY_INDEX_BY_EMAIL_KEY, normalizeEmail(previousEmail))
      }
    }
  } catch (err) {
    throw new UserStoreUnavailableError(`user store unreachable: ${err.message}`)
  }
  return toWrite
}

// Partial merge + updatedAt stamp -- the shape every write endpoint (role
// change, location change, disable/enable, password set) actually wants,
// rather than requiring every caller to read-modify-write the full record
// itself. Returns the updated record, or null if userId doesn't exist.
export async function updateUser(tenantId, userId, patch) {
  const existing = await getUserById(tenantId, userId)
  if (!existing) return null
  const next = {
    ...existing,
    ...patch,
    userId, // never overwritable via patch
    updatedAt: new Date().toISOString(),
  }
  return upsertUser(tenantId, next, { previousEmail: patch.email ? existing.email : undefined })
}

// Best-effort, non-blocking timestamp touch -- called from the login
// endpoint. Deliberately swallows its own errors (returns false rather than
// throwing) so a Redis hiccup on this one bookkeeping field never breaks an
// otherwise-successful login, mirroring auditLog.js's appendAuditEntry()
// same "this matters but is not the source of truth for the action itself"
// reasoning.
export async function touchLastLogin(tenantId, userId) {
  try {
    await updateUser(tenantId, userId, { lastLoginAt: new Date().toISOString() })
    return true
  } catch (err) {
    console.error(`[userStore] failed to record lastLoginAt for ${userId}: ${err.message}`)
    return false
  }
}

// Multi-Tenant Phase 4I.3 -- best-effort account-grant hygiene after a
// platform admin removes location(s) from a tenant's approvedLocations
// (tenantConfigStore.js's applyEntitlementChange()). NOT ITSELF A SECURITY
// BOUNDARY -- tenants.js's tenantOwnsLocation() already denies access to a
// removed location unconditionally the moment the entitlement change
// commits, regardless of what any individual account's own locationIds
// array still says (requireLocationAccess() requires BOTH tenantOwnsLocation()
// AND the account's own grant -- tenant-level denial alone already blocks
// access). This function exists so a removed location's numeric id
// doesn't linger indefinitely in account records, and so every affected
// account's outstanding session tokens are invalidated (sessionVersion
// bump) even though those sessions were never actually able to reach the
// removed location in the first place.
//
// Wildcard ('*') accounts are skipped entirely -- wildcard already means
// "every CURRENTLY approved location" (tenants.js's isWildcardGrant(),
// resolved fresh on every request from live tenant config), so removing a
// location from approvedLocations already narrows a wildcard account's
// effective access with zero per-account bookkeeping required. Adding a
// location never touches any account's grant either (not called by that
// path at all) -- a wildcard account gains it automatically and for the
// same reason; a non-wildcard account's own explicit array is NEVER
// widened by this function, only ever narrowed.
//
// Multi-Tenant Phase 4K -- now calls listUsers(tenantId)/updateUser(tenantId, ...)
// DIRECTLY: with the identity-index fix above, listUsers(tenantId) for a
// TENANT_SCOPED-mode tenant correctly reads ONLY that tenant's own hash
// (usersKeyV2(tenantId)) -- there is no longer a bootstrap-hash detour to
// route around, and this function can never scan or mutate a different
// tenant's accounts. For Los Tres Amigos (LEGACY), listUsers(DEFAULT_TENANT_ID)
// still resolves to the same bootstrap hash as always -- unchanged.
//
// Phase 4I.3's KNOWN LIMITATION is now closed: accounts.js's
// isValidLocationIds() accepts an explicit empty array as of this phase, so
// an account whose explicit locationIds would become EMPTY after stripping
// every removed id is written as a genuine `locationIds: []` -- "zero
// authorized locations" -- rather than left with a stale, no-longer-
// meaningful array. `emptied` (vs. `narrowed`) in the return value is now
// purely descriptive (which accounts landed at zero vs. some-but-fewer
// locations), not a report of a schema limitation.
export async function reconcileAccountGrantsAfterLocationRemoval(tenantId, removedLocationIds) {
  const removeSet = new Set(removedLocationIds ?? [])
  if (removeSet.size === 0) return { narrowed: [], emptied: [] }

  const users = await listUsers(tenantId)
  const narrowed = []
  const emptied = []
  for (const user of users) {
    if (!Array.isArray(user.locationIds)) continue // wildcard, or a shape this codebase's own validated writers never produce
    if (!user.locationIds.some(id => removeSet.has(id))) continue // nothing to remove for this account

    const remaining = user.locationIds.filter(id => !removeSet.has(id))
    const nextSessionVersion = (Number.isInteger(user.sessionVersion) ? user.sessionVersion : 1) + 1
    await updateUser(tenantId, user.userId, { locationIds: remaining, sessionVersion: nextSessionVersion })
    if (remaining.length === 0) emptied.push(user.userId)
    else narrowed.push(user.userId)
  }
  return { narrowed, emptied }
}
