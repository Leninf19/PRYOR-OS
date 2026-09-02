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

function isValidStatus(status) {
  return status === 'onboarding' || status === 'active' || status === 'suspended'
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
// shape -- every write this file exposes (including activateLocationCatalog
// below) goes through this one function so "what does a tenant config
// record look like" has one canonical answer.
export async function upsertTenantConfig(tenantId, patch) {
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
    // See activateLocationCatalog() below for what these two fields are
    // and why they -- not approvedLocations' array position, and not a
    // fresh sequential counter -- are the permanent source of a location's
    // numeric identity.
    locationIdMap: {},
    nextLocationId: 1,
    brands: [],
    logoUrl: null,
    ...existing,
    createdAt: existing?.createdAt ?? now,
    ...patch,
    tenantId, // never overwritable via patch
    updatedAt: now,
  }
  if (!isValidStatus(next.status)) {
    throw new Error(`upsertTenantConfig: invalid status ${JSON.stringify(next.status)}`)
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
export async function activateLocationCatalog(tenantId, selectedLocations) {
  if (!Array.isArray(selectedLocations) || selectedLocations.length === 0) {
    throw new TypeError('activateLocationCatalog: selectedLocations must be a non-empty array')
  }
  if (!selectedLocations.every(l => l && typeof l.googleLocationId === 'string' && l.googleLocationId)) {
    throw new TypeError('activateLocationCatalog: every selected location must have a googleLocationId')
  }

  const existing = await getTenantConfig(tenantId)
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
    status: 'active',
    approvedLocations,
    locationIdMap,
    nextLocationId,
    activatedAt: new Date().toISOString(),
  })
}
