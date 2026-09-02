// Multi-Tenant Phase 4E Revision -- the durable, dynamically-writable
// tenant configuration record. Before this, whether a tenant "owned a
// location catalog" lived in tenants.js's TENANT_LOCATION_CATALOG_REGISTRY,
// a hardcoded Set committed with the application -- activating a real
// paying customer's tenant required a source-code change and a deploy,
// which conflicts with PRYOR OS's intended self-service onboarding model
// (authenticated customer -> connect Google -> discover locations ->
// approve locations -> tenant becomes operational). This store is the
// trusted, server-side, runtime-writable replacement.
//
// Storage: ONE Redis hash (tenant_config:v1), field = tenantId, value = a
// JSON tenant config record --
//   tenantId, displayName, status ('onboarding'|'active'|'suspended'),
//   locationCatalogEnabled (boolean), approvedLocations (array, the
//   Google-discovered locations an Owner approved -- see
//   locationDiscoveryStore.js/google/[action].js's approveLocations()),
//   brands (string[]), logoUrl (string|null),
//   createdAt, updatedAt, activatedAt
//
// This is a BRAND NEW store -- unlike userStore.js/credentialStore.js,
// there is no pre-existing v1 key with real production data to dual-read
// against, so this file does NOT use tenantDualRead.js's LEGACY/CUTOVER
// machinery; there is nothing to migrate. A single hash is the whole
// store, exactly like userStore.js's users:v1 hash-of-all-records shape.
// tenants.js's tenantOwnsLocationCatalog() is the ONLY authorization
// consumer of this store's `locationCatalogEnabled` field -- see that
// file's header comment for how a fresh read here gets safely turned into
// a synchronous, per-request-primed answer, and for the explicit,
// transitional, Los-Tres-Amigos-only bootstrap this store's absence for
// LTA (no production Redis migration in this phase) intentionally falls
// back to.
//
// Failure model matches contactStore.js/userStore.js: every function here
// throws TenantConfigStoreUnavailableError on a missing/unreachable
// Redis -- it never silently returns "not configured" as a false `null`,
// since a caller that mishandled that distinction could wrongly treat an
// outage as "definitely not onboarded" (acceptable, fails closed) or worse
// swallow the error entirely. tenants.js's primeLocationCatalogState() is
// the one caller that deliberately catches this and degrades to a
// fail-closed cache value (see its own header comment).

import { Redis } from '@upstash/redis'

const TENANT_CONFIG_KEY = 'tenant_config:v1'
const TENANT_ID_PATTERN = /^t_[a-z0-9-]+$/

let redisClient = null
let testClientFactory = null

export function _setRedisClientForTests(factory) { testClientFactory = factory }
export function _resetRedisClientForTests() { testClientFactory = null; redisClient = null }

export class TenantConfigStoreUnavailableError extends Error {}

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

function assertValidTenantId(tenantId, fnName) {
  if (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new TypeError(`${fnName}: invalid tenantId ${JSON.stringify(tenantId)}`)
  }
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

// Multi-Tenant Phase 4F: expanded from the original 3-value enum
// ('onboarding'|'active'|'suspended') so a tenant cannot become 'active'
// (the ONLY status tenants.js's tenantOwnsLocationCatalog() treats as
// authorized) merely by approving Google locations -- provisioning its
// actual review-storage resources (see provision_tenant.py) is a distinct,
// later step. This preserves the exact existing authorization check
// (`status === 'active' && locationCatalogEnabled === true`, tenants.js)
// completely unchanged -- only WHEN 'active' is reached moves later, from
// approveLocations() to a successful provisioning run.
//   onboarding           -- no locations approved yet (unchanged default)
//   locations_approved   -- approveLocations() succeeded; review-storage
//                           resources not yet (successfully) provisioned
//   provisioning         -- a provisioning attempt is currently in progress
//   provisioned          -- review-storage (reviews.db + private-data)
//                           exists and was verified; NOT yet operational
//   initial_sync         -- Multi-Tenant Phase 4G: initial_sync.py (Python)
//                           is currently running this tenant's first real
//                           Google sync. A tenant may sit here across
//                           multiple retries (see initial_sync.py's header)
//                           -- it is never, by itself, treated as
//                           operational.
//   active               -- Phase 4G's Initial Sync completed successfully
//                           and was verified (real Google data synced, a
//                           new reviews.db Blob generation uploaded and
//                           confirmed, a complete private-data artifact
//                           generation published) -- the ONLY status
//                           tenants.js's tenantOwnsLocationCatalog()
//                           authorizes. This is the ONLY status transition
//                           initial_sync.py is allowed to make; nothing
//                           else in this codebase ever writes it.
//   initial_sync_failed  -- the last Initial Sync attempt failed; a valid
//                           retry starting point, distinct from
//                           'provisioned' so operators/logs can see
//                           something went wrong. Retrying re-enters
//                           initial_sync.py exactly like retrying a failed
//                           provisioning attempt re-enters provision_tenant.py.
//   provisioning_failed  -- the last provisioning attempt failed; a valid
//                           retry starting point, distinct from
//                           locations_approved so operators/logs can see
//                           something went wrong
//   suspended            -- unchanged, admin-superseding state. A stale
//                           Initial Sync attempt that started before a
//                           suspension can never overwrite it -- see the
//                           configVersion CAS discipline both
//                           provision_tenant.py and initial_sync.py use for
//                           every write.
function isValidStatus(status) {
  return [
    'onboarding', 'locations_approved', 'provisioning', 'provisioned',
    'initial_sync', 'active', 'initial_sync_failed', 'provisioning_failed', 'suspended',
  ].includes(status)
}

// Multi-Tenant Phase 4F.1 -- explicit, stored, NEVER-inferred storage
// architecture for a tenant's durable review data (reviews.db +
// private-data). This exists because the Phase 4F production-persistence
// audit found that PROVISIONED_TENANTS_ROOT's local-filesystem design
// cannot survive across GitHub Actions runners / local provisioning
// machines / Vercel serverless Node, which do not share a filesystem --
// see that audit and provision_tenant.py's header for the full reasoning.
//   LEGACY_REPO -- data lives in the git-committed, bundled-into-the-
//                  Vercel-deployment layout (dashboard/reviews.db,
//                  dashboard/private-data/**). Reserved for Los Tres
//                  Amigos's existing, pre-existing production data ONLY --
//                  nothing in this codebase ever assigns this value to a
//                  new tenant; LTA's own resolution is the static registry
//                  in reviewDataPaths.js, which never even reads this
//                  field.
//   BLOB        -- data lives in Vercel Blob, at the deterministic keys
//                  tenantBlobKeys.js computes from tenantId (see
//                  provisioning.reviewDbBlobKey/privateDataPrefix below).
//                  The ONLY mode any new self-service tenant is ever
//                  provisioned under (see recordLocationApproval()/
//                  provision_tenant.py) -- there is no runtime code path
//                  that infers BLOB from "a Blob object happens to exist
//                  at that key" or any other implicit signal; a tenant is
//                  BLOB-mode because this field says so, full stop.
function isValidStorageMode(mode) {
  return mode === 'LEGACY_REPO' || mode === 'BLOB'
}

// Multi-Tenant Phase 4F closure -- optimistic concurrency control.
// Node (approveLocations(), admin actions) and Python (provision_tenant.py)
// both read-modify-write the SAME tenant_config:v1 record; a naive
// read-then-write from either side has a lost-update race window between
// the two round trips. `configVersion` is a monotonically increasing
// integer, incremented on every write regardless of which fields changed
// -- it is the single generation counter for the WHOLE record (approved
// locations, status, branding, everything), so capturing it once
// automatically detects "anything about this tenant changed," not just a
// change to one specific field.
//
// The actual atomicity guarantee comes from CAS_SCRIPT below, executed
// server-side via Redis EVAL (a single atomic operation -- there is no
// window between Upstash checking the version and writing the new value
// for a second writer to race into, unlike a plain HGET-then-HSET pair
// from application code). upsertTenantConfig()'s optional `expectedVersion`
// parameter routes through this script; omitting it uses the original
// plain (last-write-wins) HSET path, unchanged, for callers that don't
// need CAS (e.g. approveLocations(), which is a short, single-step write
// with no earlier "captured state" to protect).
const CAS_UPSERT_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local currentVersion = '0'
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and decoded and decoded.configVersion then
    currentVersion = tostring(decoded.configVersion)
  end
end
if currentVersion ~= ARGV[2] then
  return raw or false
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return true
`

// Thrown when a CAS write's expectedVersion no longer matches the record's
// CURRENT configVersion -- something else (a newer provisioning attempt,
// a suspension, an approved-locations change, anything) wrote to this
// tenant's config after the caller captured its starting state. Carries
// the CURRENT record (parsed from what the Lua script itself returned, the
// same atomic read used for the comparison -- never a second, separate,
// racy GET) so a caller can decide whether to retry against fresh state.
export class ConfigVersionConflictError extends Error {
  constructor(message, currentRecord) {
    super(message)
    this.currentRecord = currentRecord ?? null
  }
}

// Returns null if no config record exists yet for this tenant -- a
// perfectly normal state for a tenant mid-onboarding (or, transitionally,
// for Los Tres Amigos, which has never been migrated into this store).
// Throws only on a genuine store outage/misconfiguration.
export async function getTenantConfig(tenantId) {
  assertValidTenantId(tenantId, 'getTenantConfig')
  const client = getClient()
  if (!client) throw new TenantConfigStoreUnavailableError('tenant config store is not configured')
  let raw
  try {
    raw = await client.hget(TENANT_CONFIG_KEY, tenantId)
  } catch (err) {
    throw new TenantConfigStoreUnavailableError(`tenant config store unreachable: ${err.message}`)
  }
  return parseRecord(raw)
}

// Admin-listing use only (a future Users & Access-style tenant admin view) --
// no authorization call site consults this today.
export async function listTenantConfigs() {
  const client = getClient()
  if (!client) throw new TenantConfigStoreUnavailableError('tenant config store is not configured')
  let raw
  try {
    raw = await client.hgetall(TENANT_CONFIG_KEY)
  } catch (err) {
    throw new TenantConfigStoreUnavailableError(`tenant config store unreachable: ${err.message}`)
  }
  const out = []
  for (const value of Object.values(raw ?? {})) {
    const record = parseRecord(value)
    if (record) out.push(record)
  }
  return out
}

// Partial merge + updatedAt stamp, matching userStore.js's updateUser()
// shape -- every write this file exposes (including recordLocationApproval
// below) goes through this one function so "what does a tenant config
// record look like" has one canonical answer.
// `expectedVersion` (optional): when provided, the write is a CAS
// (compare-and-swap) -- it only commits if the record's CURRENT
// configVersion still equals this value, checked and applied atomically
// server-side (CAS_UPSERT_SCRIPT above), never as a separate read-then-write
// pair from this function. Throws ConfigVersionConflictError if the
// record changed since the caller captured expectedVersion. Omit it for
// the original plain (last-write-wins) behavior -- appropriate for a
// short, single-step write with no earlier "captured state" to protect
// (e.g. recordLocationApproval() below).
export async function upsertTenantConfig(tenantId, patch, { expectedVersion } = {}) {
  assertValidTenantId(tenantId, 'upsertTenantConfig')
  const client = getClient()
  if (!client) throw new TenantConfigStoreUnavailableError('tenant config store is not configured')
  const existing = await getTenantConfig(tenantId)
  const now = new Date().toISOString()
  const next = {
    tenantId,
    displayName: tenantId,
    status: 'onboarding',
    locationCatalogEnabled: false,
    approvedLocations: [],
    // See recordLocationApproval() below for what these two fields are
    // and why they -- not approvedLocations' array position, and not a
    // fresh sequential counter -- are the permanent source of a location's
    // numeric identity.
    locationIdMap: {},
    nextLocationId: 1,
    brands: [],
    logoUrl: null,
    // Multi-Tenant Phase 4F.1 -- see isValidStorageMode() above. Defaults
    // to BLOB because every tenant that reaches its FIRST tenant_config
    // write via this codebase's self-service path (recordLocationApproval)
    // is a new tenant, and BLOB is the only storage architecture this
    // codebase provisions new tenants under. LTA never receives a fresh
    // record through this default (it has a real record with
    // storageMode: 'LEGACY_REPO' predating this field, or is served
    // entirely by the static registry that never reads this field at all).
    storageMode: 'BLOB',
    // Multi-Tenant Phase 4F -- written by provision_tenant.py (Python),
    // never by this file directly; present here only so a fresh record's
    // shape is correct from its very first write, and so Node-side reads
    // (a future admin view, tests) see a stable, always-present shape
    // rather than an optional field that may or may not exist.
    // Multi-Tenant Phase 4F.1: reviewDbPath/privateDataRoot (absolute local
    // filesystem paths -- non-portable across GitHub Actions / local /
    // Vercel, per the production-persistence audit) replaced with logical,
    // storage-mode-relative identifiers. reviewDbEtag records the Vercel
    // Blob ETag of the most recently CONFIRMED reviews.db upload -- the
    // concurrency guarantee itself always comes from Blob's own
    // conditional-write (ifMatch) mechanism at write time (see
    // provision_tenant.py/initial_sync.py), never from comparing this
    // stored value alone, but Multi-Tenant Phase 4G's initial_sync.py DOES
    // read it as a precondition (its own head_blob() read must still match
    // this recorded value before trusting the Blob as this tenant's own,
    // un-tampered-with database).
    // artifactGeneration (Phase 4G): the currently PUBLISHED private-data
    // artifact generation id -- see tenantBlobKeys.js's
    // generationPrivateDataBlobKey(). Every artifact read
    // (reviewDataPaths.js's readPrivateDataFile()) resolves through this
    // field, never a flat, non-generational key, so a reader can never
    // observe a mix of an old and a new sync's artifacts (see
    // initial_sync.py's header for the full atomic-publication design).
    provisioning: {
      status: 'none', reviewDbBlobKey: null, privateDataPrefix: null, reviewDbEtag: null,
      artifactGeneration: null, provisionedLocationIds: [], lastAttemptAt: null, lastError: null,
    },
    // Multi-Tenant Phase 4G -- Initial Sync's OWN state, kept separate from
    // `provisioning` (which only ever describes "does durable storage
    // exist," not "has real data been synced into it"). See
    // initial_sync.py's header for the full state machine.
    initialSync: {
      status: 'none', startedAt: null, completedAt: null, failedAt: null,
      reviewDbEtag: null, artifactGeneration: null,
      reviewCount: null, locationCount: null, lastError: null,
    },
    ...existing,
    createdAt: existing?.createdAt ?? now,
    ...patch,
    tenantId, // never overwritable via patch
    updatedAt: now,
    // Multi-Tenant Phase 4F closure: ALWAYS incremented relative to
    // whatever was actually read as `existing` -- never overwritable via
    // patch (a caller cannot claim an arbitrary version), and always
    // strictly greater than the previous write's, regardless of which
    // fields the patch touched.
    configVersion: (existing?.configVersion ?? 0) + 1,
  }
  if (!isValidStatus(next.status)) {
    throw new Error(`upsertTenantConfig: invalid status ${JSON.stringify(next.status)}`)
  }
  if (!isValidStorageMode(next.storageMode)) {
    throw new Error(`upsertTenantConfig: invalid storageMode ${JSON.stringify(next.storageMode)}`)
  }
  if (typeof next.locationCatalogEnabled !== 'boolean') {
    throw new Error('upsertTenantConfig: locationCatalogEnabled must be a boolean')
  }
  if (typeof next.locationIdMap !== 'object' || next.locationIdMap === null || Array.isArray(next.locationIdMap)) {
    throw new Error('upsertTenantConfig: locationIdMap must be a plain object')
  }
  if (!Number.isInteger(next.nextLocationId) || next.nextLocationId < 1) {
    throw new Error('upsertTenantConfig: nextLocationId must be a positive integer')
  }

  if (expectedVersion !== undefined) {
    const currentVersion = existing?.configVersion ?? 0
    if (currentVersion !== expectedVersion) {
      throw new ConfigVersionConflictError(
        `upsertTenantConfig: version conflict for tenant ${JSON.stringify(tenantId)} -- expected ${expectedVersion}, found ${currentVersion}`,
        existing,
      )
    }
    let evalResult
    try {
      evalResult = await client.eval(CAS_UPSERT_SCRIPT, [TENANT_CONFIG_KEY], [tenantId, String(expectedVersion), JSON.stringify(next)])
    } catch (err) {
      throw new TenantConfigStoreUnavailableError(`tenant config store unreachable: ${err.message}`)
    }
    if (evalResult !== true && evalResult !== 1) {
      // The script's own atomic check failed (a writer committed between
      // our read above and the EVAL itself) -- evalResult is the CURRENT
      // raw record it read, if any.
      const currentRecord = typeof evalResult === 'string' ? parseRecord(evalResult) : null
      throw new ConfigVersionConflictError(
        `upsertTenantConfig: version conflict for tenant ${JSON.stringify(tenantId)} detected atomically at write time`,
        currentRecord,
      )
    }
    return next
  }

  try {
    await client.hset(TENANT_CONFIG_KEY, { [tenantId]: JSON.stringify(next) })
  } catch (err) {
    throw new TenantConfigStoreUnavailableError(`tenant config store unreachable: ${err.message}`)
  }
  return next
}

// The one write the activation transaction performs (google/[action].js's
// approveLocations()) -- a narrow, explicit helper rather than making the
// caller build the right patch by hand, so "what does activation actually
// change" has one canonical, reviewable answer.
//
// STABLE LOCAL LOCATION IDs (final review closure): `selectedLocations` is
// the CURRENT approval's full selected set -- [{googleLocationId, title,
// address}], with NO locationId field; this function is the only place
// numeric ids are ever assigned, and it assigns them by RECONCILING
// against this tenant's own persistent `locationIdMap`
// (googleLocationId -> stable localLocationId) and monotonic
// `nextLocationId` counter, never by array position or by renumbering
// from 1 on every call:
//   - a googleLocationId already present in locationIdMap (from ANY prior
//     approval, even one that no longer includes it in approvedLocations)
//     keeps its existing numeric id, unconditionally;
//   - a googleLocationId never seen before gets the current
//     nextLocationId, which is then incremented -- ids are allocated once
//     and never reused, even after the location they were allocated to is
//     later dropped from approvedLocations;
//   - array order and which locations happen to be selected THIS call
//     never affect either of the above.
// This is what makes A/B/C's ids stable across re-approving only B/C,
// what makes adding D allocate a genuinely new id, and what guarantees a
// user's existing [B_ID] permission can never silently start referring to
// C, D, or any other physical location -- B_ID remains permanently
// reserved for B's own googleLocationId in locationIdMap even if B is
// later removed from approvedLocations (in which case tenantOwnsLocation()
// simply stops granting it, exactly as if B_ID had never been approved --
// see tenants.js).
//
// FUTURE reviews.db MAPPING (documented now, not built -- per-tenant
// reviews.db provisioning remains a separate, later milestone): there must
// be exactly ONE numeric location-id namespace per tenant, not two
// unrelated ones. tenantConfigStore's locationIdMap is authoritative from
// the moment of first approval -- possibly before any reviews.db exists
// for a brand-new self-service tenant at all -- so when that tenant's
// reviews.db is eventually provisioned, the provisioning step MUST insert
// each `locations` row using the id ALREADY reserved here (matched by
// gbp_location_name/googleLocationId), via an explicit
// `INSERT INTO locations (id, ...)` naming that exact integer (SQLite
// permits an explicit value for an INTEGER PRIMARY KEY column) -- never
// letting SQLite's own autoincrement assign an independent number. A
// location added after the reviews.db already exists still originates its
// id from this map first (approve-locations runs before any DB row would
// exist for it), and the DB insert then follows the same rule.
//
// `approvedLocations` is the exact list validated against a trusted
// discovery-session record by the caller BEFORE this is ever called --
// this function does not, and cannot, re-validate provenance; that is the
// caller's job (see locationDiscoveryStore.js).
//
// Multi-Tenant Phase 4F RENAME (was activateLocationCatalog): this no
// longer sets status to 'active' -- doing so before any review-storage
// resources exist was exactly what Phase 4F's review rejected ("a tenant
// should not become fully ready merely because Google locations were
// approved"). It now sets 'locations_approved', a distinct status that
// still fails tenantOwnsLocationCatalog()'s `status === 'active'` check
// (tenants.js) until provision_tenant.py (Python) successfully creates and
// verifies that tenant's reviews.db/private-data root and calls
// markTenantProvisioned() below.
//
// Multi-Tenant Phase 4I.1 -- ELIGIBILITY GATE (entitlement boundary): this
// function REPLACES `approvedLocations` wholesale with whatever
// `selectedLocations` contains -- correct for onboarding (where there is no
// prior commercial commitment to protect), but if called again on a tenant
// that has already started provisioning, it would let the caller (Owner-only
// authenticated at google/[action].js's approveLocations()) silently
// re-select an entirely different set of Google locations and have them
// become the tenant's approved/licensed catalog -- exactly the "Google
// authorization determines PRYOR access" conflation this phase exists to
// prevent, and exactly the "Tenant Owner unilaterally expands their own
// entitlement" path the phase's audit flagged as the one real gap in an
// otherwise-correct authorization design (tenantOwnsLocation()/
// requireLocationAccess() already correctly gate all DATA access on
// whatever this array currently holds; nothing there stops this array
// itself from being rewritten). LOCATION_APPROVAL_ELIGIBLE_STATUSES is
// exactly the set of statuses that exist BEFORE any durable resource
// (Blob storage, reviews.db, a published artifact generation) has been
// provisioned against the current approvedLocations -- 'onboarding' (no
// record yet, or approval never completed) and 'locations_approved' (an
// approval exists but provisioning has not yet started, so revising the
// selection before that happens is still just finishing onboarding, not
// changing a live entitlement). A tenant in ANY OTHER status --
// 'provisioning', 'provisioning_failed', 'provisioned', 'initial_sync',
// 'initial_sync_failed', 'active', 'suspended' -- has already committed
// durable resources and/or gone live against its current approvedLocations;
// self-service re-approval is refused (LocationApprovalNotEligibleError,
// fail closed) rather than silently accepted. There is deliberately no
// super-admin bypass parameter here: per this phase's explicit scope, no
// safe platform-super-admin mutation path is being built in this phase
// either (see the Phase 4I.1 report) -- changing an already-committed
// tenant's approved locations is intentionally left with NO mutation path
// at all until a future, separately reviewed phase builds one.
// Exported (Multi-Tenant Phase 4I.2): google/[action].js's OAuth callback
// reuses this EXACT set to decide whether a reconnecting tenant is
// "pre-commit" (no reconciliation needed, same as this file's own
// eligibility question) or "committed" (reconciliation required before a
// new credential may be persisted) -- one authoritative status
// classification, not two independently-maintained enums that could drift
// apart.
export const LOCATION_APPROVAL_ELIGIBLE_STATUSES = new Set(['onboarding', 'locations_approved'])

export class LocationApprovalNotEligibleError extends Error {
  constructor(message, currentStatus) {
    super(message)
    this.currentStatus = currentStatus ?? null
  }
}

export async function recordLocationApproval(tenantId, selectedLocations) {
  if (!Array.isArray(selectedLocations) || selectedLocations.length === 0) {
    throw new TypeError('recordLocationApproval: selectedLocations must be a non-empty array')
  }
  if (!selectedLocations.every(l => l && typeof l.googleLocationId === 'string' && l.googleLocationId)) {
    throw new TypeError('recordLocationApproval: every selected location must have a googleLocationId')
  }

  const existing = await getTenantConfig(tenantId)
  if (existing && !LOCATION_APPROVAL_ELIGIBLE_STATUSES.has(existing.status)) {
    throw new LocationApprovalNotEligibleError(
      `recordLocationApproval: tenant ${tenantId} has status ${JSON.stringify(existing.status)} -- the location catalog can only be self-service (re-)approved during onboarding, before provisioning begins. Once a tenant has started provisioning, its approved locations are a committed entitlement and this endpoint cannot change them.`,
      existing.status
    )
  }
  const locationIdMap = { ...(existing?.locationIdMap ?? {}) }
  let nextLocationId = Number.isInteger(existing?.nextLocationId) && existing.nextLocationId >= 1 ? existing.nextLocationId : 1

  const approvedLocations = selectedLocations.map(loc => {
    if (!(loc.googleLocationId in locationIdMap)) {
      locationIdMap[loc.googleLocationId] = nextLocationId
      nextLocationId += 1
    }
    return {
      locationId: locationIdMap[loc.googleLocationId],
      googleLocationId: loc.googleLocationId,
      title: loc.title ?? '',
      address: loc.address ?? '',
    }
  })

  return upsertTenantConfig(tenantId, {
    locationCatalogEnabled: true,
    status: 'locations_approved',
    approvedLocations,
    locationIdMap,
    nextLocationId,
    // Multi-Tenant Phase 4F.1: explicit, not merely inherited from
    // upsertTenantConfig()'s default -- every tenant approved through this
    // self-service function is provisioned via Vercel Blob (see
    // provision_tenant.py); LTA never calls this function at all.
    storageMode: 'BLOB',
  })
}

// Multi-Tenant Phase 4F closure -- the ONE place a tenant's status is
// allowed to become 'provisioned' (NOT 'active' -- see isValidStatus()'s
// comment: successful provisioning alone must never make a tenant
// operationally active; only Phase 4G's Initial Sync completion, not built
// yet, is allowed to write 'active'). The actual filesystem/SQLite work
// happens in Python (provision_tenant.py), which writes this exact same
// tenant_config:v1 record directly via its own tenant_config_store.py
// client (see that file's header for why this is a single shared record,
// never two independent ones). This Node-side helper exists so Node code
// (tests, a future admin status view) has the same one-function-does-the-
// write discipline every other status transition in this file has.
//
// `expectedVersion`, if provided, makes this a CAS write (see
// upsertTenantConfig()) -- provision_tenant.py's own Python equivalent
// always supplies it, binding a provisioning attempt to the exact
// tenant_config generation it validated at the START of its run, so a
// stale attempt (one where the record changed underneath it -- a
// suspension, a locations change, a newer completed attempt) can never
// publish itself as successful.
export async function markTenantProvisioned(tenantId, { reviewDbBlobKey, privateDataPrefix, reviewDbEtag, artifactGeneration, provisionedLocationIds, expectedVersion } = {}) {
  if (typeof reviewDbBlobKey !== 'string' || !reviewDbBlobKey) throw new TypeError('markTenantProvisioned: reviewDbBlobKey is required')
  if (typeof privateDataPrefix !== 'string' || !privateDataPrefix) throw new TypeError('markTenantProvisioned: privateDataPrefix is required')
  if (!Array.isArray(provisionedLocationIds)) throw new TypeError('markTenantProvisioned: provisionedLocationIds must be an array')
  return upsertTenantConfig(tenantId, {
    status: 'provisioned',
    provisioning: {
      status: 'provisioned', reviewDbBlobKey, privateDataPrefix, reviewDbEtag: reviewDbEtag ?? null,
      artifactGeneration: artifactGeneration ?? null, provisionedLocationIds,
      lastAttemptAt: new Date().toISOString(), lastError: null,
    },
  }, expectedVersion === undefined ? {} : { expectedVersion })
}

export async function markTenantProvisioningFailed(tenantId, errorMessage, { expectedVersion } = {}) {
  const existing = await getTenantConfig(tenantId)
  return upsertTenantConfig(tenantId, {
    status: 'provisioning_failed',
    provisioning: {
      ...(existing?.provisioning ?? {}),
      status: 'failed',
      lastAttemptAt: new Date().toISOString(),
      lastError: String(errorMessage ?? 'unknown error'),
    },
  }, expectedVersion === undefined ? {} : { expectedVersion })
}

// Multi-Tenant Phase 4G -- the ONE place a tenant's status is allowed to
// become 'initial_sync'. Mirrors markTenantProvisioned()'s CAS discipline
// exactly; the actual Google sync/DB/artifact work happens in Python
// (initial_sync.py), which writes this exact same tenant_config:v1 record
// via tenant_config_store.py. This Node-side helper exists purely for
// tests/a future admin status view -- initial_sync.py never calls it (it
// writes tenant_config_store.upsert_tenant_config() directly, exactly like
// provision_tenant.py already does).
export async function markTenantInitialSyncStarted(tenantId, { expectedVersion } = {}) {
  const existing = await getTenantConfig(tenantId)
  return upsertTenantConfig(tenantId, {
    status: 'initial_sync',
    initialSync: {
      ...(existing?.initialSync ?? {}),
      status: 'in_progress',
      startedAt: new Date().toISOString(),
      completedAt: null, failedAt: null, lastError: null,
    },
  }, expectedVersion === undefined ? {} : { expectedVersion })
}

export async function markTenantInitialSyncFailed(tenantId, errorMessage, { expectedVersion } = {}) {
  const existing = await getTenantConfig(tenantId)
  return upsertTenantConfig(tenantId, {
    status: 'initial_sync_failed',
    initialSync: {
      ...(existing?.initialSync ?? {}),
      status: 'failed',
      failedAt: new Date().toISOString(),
      lastError: String(errorMessage ?? 'unknown error'),
    },
  }, expectedVersion === undefined ? {} : { expectedVersion })
}

// Multi-Tenant Phase 4G -- the ONLY place in this ENTIRE codebase allowed
// to write the 'active' status. See isValidStatus()'s comment above and
// initial_sync.py's header for the full set of preconditions that must
// hold before this may ever be called (Google sync succeeded for every
// approved location, the reviews.db Blob upload was confirmed via a
// conditional write, a complete private-data artifact generation was fully
// uploaded) -- this function itself does not re-verify any of that; it is
// the final, narrow write step, not the decision-maker. tests/
// test_provisioned_not_active.js's source-scan assertion is extended
// (Phase 4G) to also confirm this is the only 'active' literal anywhere in
// this file.
export async function markTenantActive(tenantId, { reviewDbEtag, artifactGeneration, reviewCount, locationCount, expectedVersion } = {}) {
  if (typeof reviewDbEtag !== 'string' || !reviewDbEtag) throw new TypeError('markTenantActive: reviewDbEtag is required')
  if (typeof artifactGeneration !== 'string' || !artifactGeneration) throw new TypeError('markTenantActive: artifactGeneration is required')
  const existing = await getTenantConfig(tenantId)
  return upsertTenantConfig(tenantId, {
    status: 'active',
    provisioning: {
      ...(existing?.provisioning ?? {}),
      reviewDbEtag,
      artifactGeneration,
    },
    initialSync: {
      ...(existing?.initialSync ?? {}),
      status: 'completed',
      completedAt: new Date().toISOString(), failedAt: null,
      reviewDbEtag, artifactGeneration,
      reviewCount: Number.isInteger(reviewCount) ? reviewCount : null,
      locationCount: Number.isInteger(locationCount) ? locationCount : null,
      lastError: null,
    },
  }, expectedVersion === undefined ? {} : { expectedVersion })
}
