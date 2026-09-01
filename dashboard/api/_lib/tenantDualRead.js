// Multi-Tenant Phase 2 (hardened) -- centralized, hard-to-bypass key
// resolution for every store this phase tenantizes.
//
// PHASE 2 HARDENING PASS: the original version of this file decided the
// authoritative READ key by checking, at read time, whether the v2 key
// happened to already have data (`isHashPopulated(v2Key)` etc.), while the
// WRITE key was decided purely by tenant identity (always v1 for
// DEFAULT_TENANT_ID). Those are two INDEPENDENT decisions -- the moment a
// v2 key became populated by anything (a bug, a partial migration run, a
// stray write), reads would silently flip to v2 while writes kept landing
// on v1. That is a split-brain: the app would read one copy of the data
// while continuing to durably write another, with nothing forcing the two
// to agree. This rewrite removes that possibility structurally rather than
// patching around it.
//
// THE MODEL: every tenant has exactly one MIGRATION MODE (see
// TenantMigrationMode below), decided ONLY by tenantId -- never by
// inspecting Redis. Both the read-key resolver and the write-key resolver
// for a given shape call the exact same `authoritativeKeyFor()` helper, so
// they can never disagree: whichever version (v1/legacy or v2/v3) is
// authoritative for a tenant, it is authoritative for BOTH reads and
// writes, always, atomically, by construction.
//
//   LEGACY  (DEFAULT_TENANT_ID, i.e. "t_los-tres-amigos", today): the
//           legacy key (v1, or the pre-tenant v2 key for stores like
//           tasks:v2 that were already versioned before this migration)
//           is authoritative for both reads and writes -- byte-identical
//           to pre-Phase-2 production behavior. A tenant-scoped v2/v3 key
//           may exist (e.g. written by a future migration/backfill run)
//           and may be SHADOW-READ for verification (see
//           isHashPopulated/isListPopulated/isStringKeyPopulated below),
//           but its mere presence or population never changes which key
//           is authoritative. Only a reviewed code change to
//           TENANT_MIGRATION_MODE (a genuine cutover, done once real
//           production data has been migrated and verified) can move a
//           tenant out of LEGACY mode.
//
//   CUTOVER (every other tenantId -- Phase 2 onboards none, but this is
//           where any future tenant lands from the moment it's created):
//           the tenant-scoped v2/v3 key is authoritative for both reads
//           and writes. There is no legacy key for a tenant that never
//           had pre-tenant data, so legacy fallback is not just avoided
//           but structurally impossible -- authoritativeKeyFor() never
//           even looks at v1Key in this mode.
//
// Deliberately NOT an environment variable or other runtime-flippable
// setting: TENANT_MIGRATION_MODE is a plain code-level map, so a cutover
// is a reviewed commit (with its own migration verification), never a
// config change that could be toggled independently of (or out of sync
// with) an actual data migration.
//
// Every store calls resolveHashReadKey/resolveHashWriteKey (or the List/
// Individual variants below) rather than reimplementing this branching
// itself.

import { DEFAULT_TENANT_ID } from './tenants.js'

export function assertKnownTenantId(tenantId, fnName) {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new TypeError(`${fnName}: tenantId is required and must be a non-empty string`)
  }
}

export const TenantMigrationMode = Object.freeze({
  // Legacy (v1/pre-tenant) key is authoritative for BOTH reads and writes.
  LEGACY: 'legacy',
  // Tenant-scoped (v2/v3) key is authoritative for BOTH reads and writes.
  CUTOVER: 'cutover',
})

// THE single source of truth for every tenant's migration mode. A plain
// object literal, not derived from any env var/request/runtime state --
// changing a tenant's mode is a reviewed source change, not a flippable
// setting. During Phase 2 this holds exactly one entry: the real tenant,
// explicitly pinned to LEGACY. Do not add a second tenant here without a
// reviewed migration/cutover plan -- that is precisely what this map exists
// to gate.
const TENANT_MIGRATION_MODE = Object.freeze({
  [DEFAULT_TENANT_ID]: TenantMigrationMode.LEGACY,
})

// Any tenantId not explicitly listed above resolves to CUTOVER -- a new
// tenant (Phase 2 onboards none) has no legacy data to be compatible with,
// so it is tenant-scoped-only from the moment it exists. This is what makes
// "legacy global fallback must remain impossible" true for every tenant
// other than the one explicitly grandfathered into LEGACY above.
export function getTenantMigrationMode(tenantId) {
  assertKnownTenantId(tenantId, 'getTenantMigrationMode')
  return TENANT_MIGRATION_MODE[tenantId] ?? TenantMigrationMode.CUTOVER
}

// Kept for the small number of call sites that need a plain boolean rather
// than the mode enum (e.g. notificationStore.js's prefix-scan). Backed by
// the exact same getTenantMigrationMode() lookup -- never a second,
// independently-maintained rule.
export function isLegacyAuthoritative(tenantId) {
  return getTenantMigrationMode(tenantId) === TenantMigrationMode.LEGACY
}

// THE one function that decides which physical key is authoritative for a
// given tenant + store. Synchronous and side-effect-free: authority is a
// property of the tenant's migration mode alone, never of what Redis
// currently contains. Both resolve*ReadKey and resolve*WriteKey below
// delegate to this exact function, which is what makes it structurally
// impossible for reads and writes to select different versions.
function authoritativeKeyFor({ v1Key, v2Key, tenantId }) {
  assertKnownTenantId(tenantId, 'authoritativeKeyFor')
  return getTenantMigrationMode(tenantId) === TenantMigrationMode.LEGACY ? v1Key : v2Key
}

// --- Shadow-read helpers -----------------------------------------------
//
// These inspect whether a tenant-scoped v2/v3 key has data -- useful for a
// future migration/backfill script to verify a copy before a reviewed
// cutover flips TENANT_MIGRATION_MODE. They are diagnostic only: nothing in
// this file (or any store) calls them to DECIDE an authoritative key, and
// they must never be wired in that way -- that is exactly the coupling this
// hardening pass removed. Populating a v2 key alone must never change
// application behavior; these functions exist so a human/script can check
// that fact and confirm migrated data matches, not so the app can auto-detect it.

export async function isHashPopulated(client, key) {
  if (!client) return false
  const raw = await client.hgetall(key)
  return raw !== null && Object.keys(raw ?? {}).length > 0
}

export async function isListPopulated(client, key) {
  if (!client) return false
  const sample = await client.lrange(key, 0, 0)
  return Array.isArray(sample) && sample.length > 0
}

export async function isStringKeyPopulated(client, key) {
  if (!client) return false
  return (await client.get(key)) !== null
}

// --- Hash-shaped stores (one Redis hash per store: users, contacts,
//     actions, campaigns, content assets, tasks) -----------------------

// Returns the key to READ from for this tenant. `client` is accepted for
// call-site/signature symmetry with the shadow-read helpers above and is
// not used to decide the result -- resolution is synchronous and mode-only,
// see authoritativeKeyFor().
export async function resolveHashReadKey(_client, { v1Key, v2Key, tenantId }) {
  assertKnownTenantId(tenantId, 'resolveHashReadKey')
  return authoritativeKeyFor({ v1Key, v2Key, tenantId })
}

// Returns the key to WRITE to for this tenant -- ALWAYS the same key
// resolveHashReadKey would return for the same tenant right now, since both
// delegate to authoritativeKeyFor(). This equivalence is the fix: it is no
// longer possible for the read path and the write path to compute different
// answers.
export function resolveHashWriteKey({ v1Key, v2Key, tenantId }) {
  assertKnownTenantId(tenantId, 'resolveHashWriteKey')
  return authoritativeKeyFor({ v1Key, v2Key, tenantId })
}

// --- List-shaped stores (audit_log) -----------------------------------

export async function resolveListReadKey(_client, { v1Key, v2Key, tenantId }) {
  assertKnownTenantId(tenantId, 'resolveListReadKey')
  return authoritativeKeyFor({ v1Key, v2Key, tenantId })
}

export function resolveListWriteKey({ v1Key, v2Key, tenantId }) {
  assertKnownTenantId(tenantId, 'resolveListWriteKey')
  return authoritativeKeyFor({ v1Key, v2Key, tenantId })
}

// --- Individually-keyed records (notificationStore.js's per-review
//     reply-failure and per-user seeded/read-state keys -- each is its
//     own Redis key, a STRING (reply-failure, seeded) or a per-user HASH
//     (read-state), never one shared hash for every user/review) --------

export async function resolveIndividualStringReadKey(_client, { v1Key, v2Key, tenantId }) {
  assertKnownTenantId(tenantId, 'resolveIndividualStringReadKey')
  return authoritativeKeyFor({ v1Key, v2Key, tenantId })
}

export async function resolveIndividualHashReadKey(_client, { v1Key, v2Key, tenantId }) {
  assertKnownTenantId(tenantId, 'resolveIndividualHashReadKey')
  return authoritativeKeyFor({ v1Key, v2Key, tenantId })
}

// Individually-keyed writes use the exact same rule as hash/list writes --
// exported separately (rather than reusing resolveHashWriteKey) only so
// each shape has its own clearly-named entry point at call sites.
export function resolveIndividualWriteKey({ v1Key, v2Key, tenantId }) {
  assertKnownTenantId(tenantId, 'resolveIndividualWriteKey')
  return authoritativeKeyFor({ v1Key, v2Key, tenantId })
}
