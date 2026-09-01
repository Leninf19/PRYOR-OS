// Multi-Tenant Phase 4D: canonical, server-controlled mapping from a
// validated tenantId to the ONE private-data root directory that tenant is
// approved to read tenant-owned generated review artifacts from (meta.json,
// per-location review chunks, the review->location index, location
// contacts, analytics, etc). Mirrors tenant_paths.py's registry discipline
// exactly (Python side, Multi-Tenant Phase 4D) -- no function here ever
// builds a path via string interpolation of tenantId into a filesystem
// path; every resolution is a dict lookup against an explicit, reviewed
// registry, so a well-formed-but-unregistered tenantId fails closed with
// UnknownTenantError rather than silently deriving a plausible-looking
// path.
//
// ARTIFACT LAYOUT DECISION (Phase 4D): Los Tres Amigos is pinned to the
// EXISTING flat dashboard/private-data/ directory -- a controlled, explicit,
// LTA-only compatibility mapping, exactly like credentialStore.js's
// CREDENTIAL_MIGRATION_MODE LEGACY entry for gbp_credentials:v1. This is
// NOT a general fallback -- it is a single, reviewed registry row that
// keeps every existing LTA production artifact working without moving any
// data. A future tenant is onboarded by adding its OWN explicit registry
// row here (e.g. pointing at private-data/{tenantId}/, the proposed
// tenant-scoped layout), never by an automatic derivation from tenantId.
//
// TODO(multi-tenant-cutover): once Los Tres Amigos's real private-data
// artifacts are migrated to the tenant-scoped layout (see the Phase 4D
// report's migration procedure), remove this LTA-specific registry row so
// every tenant resolves through the same tenant-scoped structure.

import path from 'path'
import { fileURLToPath } from 'url'
import { DEFAULT_TENANT_ID, isValidTenantId } from './tenants.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export class UnknownTenantError extends Error {}

function assertValidTenantId(tenantId, fnName) {
  if (!isValidTenantId(tenantId)) {
    throw new TypeError(`${fnName}: invalid tenantId ${JSON.stringify(tenantId)}`)
  }
}

// Single source of truth: which physical directory is a given tenant's
// private-data root. A plain object literal, not derived from any env var/
// request/runtime state -- adding a tenant here is a reviewed source
// change, exactly like tenantDualRead.js's own migration-mode maps.
const TENANT_PRIVATE_DATA_ROOT_REGISTRY = Object.freeze({
  [DEFAULT_TENANT_ID]: path.resolve(__dirname, '..', '..', 'private-data'),
})

// --- Test-only override seam --------------------------------------------
// Same pattern as credentialStore.js's _setRedisClientForTests()/
// tenant_paths.py's _set_review_db_path_for_tests(): lets a test register a
// scratch root for a given tenantId for the duration of the test, without
// ever touching the real registry. Never used by production code paths.
let testOverrides = {}

export function _setPrivateDataRootForTests(tenantId, rootPath) {
  testOverrides = { ...testOverrides, [tenantId]: rootPath }
}
export function _resetPrivateDataRootsForTests() {
  testOverrides = {}
}

// THE one function that decides which physical directory is authoritative
// for a tenant's private-data artifacts. Every endpoint/helper that reads a
// tenant-owned generated file calls this before touching the filesystem --
// never a hardcoded/default directory once a tenantId is known. Fails
// closed (TypeError) before even considering the registry for a malformed
// tenantId, and fails closed (UnknownTenantError) for a well-formed but
// unregistered one -- there is no fallback path for either case, and
// critically, an unregistered tenant NEVER resolves to another tenant's
// (e.g. LTA's) directory.
export function resolvePrivateDataRoot(tenantId) {
  assertValidTenantId(tenantId, 'resolvePrivateDataRoot')
  if (Object.prototype.hasOwnProperty.call(testOverrides, tenantId)) {
    return testOverrides[tenantId]
  }
  const root = TENANT_PRIVATE_DATA_ROOT_REGISTRY[tenantId]
  if (!root) {
    throw new UnknownTenantError(
      `resolvePrivateDataRoot: tenant ${JSON.stringify(tenantId)} has no registered private-data root -- ` +
      `it must be explicitly onboarded (added to TENANT_PRIVATE_DATA_ROOT_REGISTRY) before any ` +
      `tenant-owned file can be read for it`
    )
  }
  return root
}

// Non-throwing existence check for diagnostics that want to report "not
// onboarded" without raising. Still validates tenantId's shape first.
export function isPrivateDataTenantOnboarded(tenantId) {
  assertValidTenantId(tenantId, 'isPrivateDataTenantOnboarded')
  return Object.prototype.hasOwnProperty.call(TENANT_PRIVATE_DATA_ROOT_REGISTRY, tenantId)
}

// Safely joins a tenant's resolved root with a caller-provided relative
// path segment, guaranteeing the result can never escape that root --
// second, independent layer of defense after callers' own allowlist/
// segment-character checks (see data.js's buildRequestedRelPath()), not the
// only one. Throws PathEscapeError if resolution would land outside root.
export class PathEscapeError extends Error {}

export function resolveWithinRoot(root, relPath) {
  const resolved = path.resolve(root, relPath)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathEscapeError(`resolveWithinRoot: ${JSON.stringify(relPath)} escapes root ${root}`)
  }
  return resolved
}
