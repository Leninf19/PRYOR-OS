// Multi-Tenant Phase 4D: canonical, server-controlled mapping from a
// validated tenantId to the ONE private-data source that tenant is approved
// to read tenant-owned generated review artifacts from (meta.json, per-
// location review chunks, the review->location index, location contacts,
// analytics, etc). No function here ever builds a Blob key or filesystem
// path via naive string interpolation of tenantId alone -- every
// resolution either hits an explicit, reviewed registry (LEGACY_REPO) or a
// verified, provisioning-confirmed tenant_config record plus
// tenantBlobKeys.js's deterministic formula (BLOB).
//
// Multi-Tenant Phase 4F.1 -- STORAGE MODE. The production-persistence audit
// that motivated this phase found the original design (a single "private-
// data root directory" concept) cannot generalize: LTA's data is a real
// git-committed, bundled-into-the-deployment directory (LEGACY_REPO), but a
// self-service tenant's data lives in Vercel Blob (BLOB) -- there is no
// local directory for it at all. `resolveTenantStorage()` below returns a
// discriminated {mode, ...} descriptor instead of a bare path string, and
// `readPrivateDataFile()` is the ONE function that knows how to read a file
// under either mode -- every call site reads through it now, never through
// its own ad hoc path.join()+readFile() pair.
//
// ARTIFACT LAYOUT DECISION (Phase 4D, unchanged for LEGACY_REPO): Los Tres
// Amigos is pinned to the EXISTING flat dashboard/private-data/ directory --
// a controlled, explicit, LTA-only compatibility mapping. This is NOT a
// general fallback -- it is a single, reviewed registry row that keeps
// every existing LTA production artifact working without moving any data.
// A future tenant is never onboarded into this registry; every new tenant
// is BLOB-mode (see tenantConfigStore.js's storageMode default).

import { readFile } from 'fs/promises'
import { text as streamToText } from 'stream/consumers'
import path from 'path'
import { fileURLToPath } from 'url'
import { DEFAULT_TENANT_ID, isValidTenantId } from './tenants.js'
import { getTenantConfig } from './tenantConfigStore.js'
import { getBlob } from './blobStore.js'
import { privateDataBlobKey } from './tenantBlobKeys.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export class UnknownTenantError extends Error {}

// Multi-Tenant Phase 4F.1 -- thrown by readPrivateDataFile() for BOTH
// storage modes' "this specific file doesn't exist" case, deliberately
// shaped like Node's own fs ENOENT error (a real `.code` property, not just
// a subclass name) so every one of this function's 6 call sites' EXISTING
// `catch (err) { if (err.code === 'ENOENT') ... }` handling keeps working
// completely unchanged for BOTH modes -- this was the whole point of
// unifying the read path into one function: callers should not need to
// know or care which storage mode produced a given "not found."
export class PrivateDataFileNotFoundError extends Error {
  constructor(message) {
    super(message)
    this.code = 'ENOENT'
  }
}

function assertValidTenantId(tenantId, fnName) {
  if (!isValidTenantId(tenantId)) {
    throw new TypeError(`${fnName}: invalid tenantId ${JSON.stringify(tenantId)}`)
  }
}

// Single source of truth: which physical directory is Los Tres Amigos's
// private-data root. A plain object literal, not derived from any env var/
// request/runtime state.
const TENANT_PRIVATE_DATA_ROOT_REGISTRY = Object.freeze({
  [DEFAULT_TENANT_ID]: path.resolve(__dirname, '..', '..', 'private-data'),
})

// --- Test-only override seam --------------------------------------------
// Same pattern as credentialStore.js's _setRedisClientForTests(): lets a
// test register a scratch storage descriptor for a given tenantId for the
// duration of the test, without ever touching the real registry or a real
// Blob store. Never used by production code paths.
let testOverrides = {}

// Registers a LEGACY_REPO (filesystem) override -- unchanged shape/behavior
// from Phase 4F.
export function _setPrivateDataRootForTests(tenantId, rootPath) {
  testOverrides = { ...testOverrides, [tenantId]: { mode: 'LEGACY_REPO', root: rootPath } }
}
// Multi-Tenant Phase 4F.1: registers a synthetic BLOB storage descriptor for
// a test tenant -- pairs with blobStore.js's own _setBlobClientForTests() to
// exercise the BLOB read branch end-to-end with a fake in-memory client,
// never a real Vercel Blob store or network call.
export function _setBlobStorageForTests(tenantId, privateDataPrefix) {
  testOverrides = { ...testOverrides, [tenantId]: { mode: 'BLOB', privateDataPrefix } }
}
export function _resetPrivateDataRootsForTests() {
  testOverrides = {}
}

// Multi-Tenant Phase 4F closure / 4F.1 revision -- the dynamic,
// provisioning-backed counterpart to the static registry above, for a
// self-service tenant onboarded via Connect Google -> Discover -> Approve
// -> provision_tenant.py (Python) rather than a source-code registry edit.
//
// Reads the SAME tenant_config:v1 record provision_tenant.py writes to, and
// returns a storage descriptor ONLY IF the tenant is genuinely OPERATIONAL
// -- status === 'active' (NOT 'provisioned' -- a tenant whose storage
// exists but has not completed Phase 4G's Initial Sync is deliberately NOT
// resolvable here) AND provisioning.status === 'provisioned' (the resources
// actually exist and were verified). Returns null (never throws) for
// anything short of that.
async function resolveProvisionedStorage(tenantId) {
  let config
  try {
    config = await getTenantConfig(tenantId)
  } catch {
    return null
  }
  if (!config || config.status !== 'active') return null
  const provisioning = config.provisioning ?? {}
  if (provisioning.status !== 'provisioned') return null
  if (config.storageMode === 'BLOB') {
    const prefix = provisioning.privateDataPrefix
    if (typeof prefix !== 'string' || !prefix) return null
    return { mode: 'BLOB', privateDataPrefix: prefix }
  }
  // storageMode 'LEGACY_REPO' has no dynamic counterpart -- LTA (the only
  // LEGACY_REPO tenant) is served exclusively by the static registry above,
  // which never even reaches this function. Any other tenant recorded as
  // LEGACY_REPO here is unreachable in practice (provision_tenant.py never
  // provisions that mode), and this falls through to null rather than
  // guessing at a nonexistent path.
  return null
}

// Resolves which storage mode + location descriptor is authoritative for a
// tenant's private-data artifacts. Order: (1) test override, (2) the
// static, source-controlled registry (LTA -- zero Redis reads), (3) the
// dynamic, provisioning-backed lookup above. Throws UnknownTenantError for
// a well-formed but unregistered/unprovisioned/not-yet-operational tenant.
async function resolveTenantStorage(tenantId) {
  assertValidTenantId(tenantId, 'resolveTenantStorage')
  if (Object.prototype.hasOwnProperty.call(testOverrides, tenantId)) {
    return testOverrides[tenantId]
  }
  const staticRoot = TENANT_PRIVATE_DATA_ROOT_REGISTRY[tenantId]
  if (staticRoot) return { mode: 'LEGACY_REPO', root: staticRoot }
  const provisioned = await resolveProvisionedStorage(tenantId)
  if (provisioned) return provisioned
  throw new UnknownTenantError(
    `resolveTenantStorage: tenant ${JSON.stringify(tenantId)} has no registered or operational private-data storage -- ` +
    `it must be explicitly onboarded (added to TENANT_PRIVATE_DATA_ROOT_REGISTRY) or successfully provisioned AND ` +
    `active (provision_tenant.py, then Phase 4G's Initial Sync) before any tenant-owned file can be read for it`
  )
}

// RETAINED for any caller that specifically needs a LEGACY_REPO filesystem
// root (none remain in this codebase as of Phase 4F.1 -- every former call
// site migrated to readPrivateDataFile() below). Throws UnknownTenantError
// if the tenant resolves to BLOB storage, since there is no filesystem root
// to return for it -- a caller expecting the old contract fails loudly
// instead of silently operating on a wrong/empty path.
export async function resolvePrivateDataRoot(tenantId) {
  const storage = await resolveTenantStorage(tenantId)
  if (storage.mode !== 'LEGACY_REPO') {
    throw new UnknownTenantError(
      `resolvePrivateDataRoot: tenant ${JSON.stringify(tenantId)} uses BLOB storage -- callers must use ` +
      `readPrivateDataFile() instead of a filesystem root`
    )
  }
  return storage.root
}

// THE one function every endpoint/helper that reads a tenant-owned
// generated file calls -- never a hardcoded/default directory, never its
// own fs.readFile()/getBlob() pair. Returns the file's content as a UTF-8
// string (every private-data artifact is JSON text). Throws
// PrivateDataFileNotFoundError (ENOENT-shaped, see above) for a legitimately
// missing file under EITHER mode, UnknownTenantError for an unresolvable
// tenant, PathEscapeError for a relPath that would escape a LEGACY_REPO
// root (defense-in-depth; callers' own allowlists are the primary guard).
export async function readPrivateDataFile(tenantId, relPath) {
  const storage = await resolveTenantStorage(tenantId)
  if (storage.mode === 'LEGACY_REPO') {
    const resolved = resolveWithinRoot(storage.root, relPath)
    try {
      return await readFile(resolved, 'utf-8')
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new PrivateDataFileNotFoundError(`private-data file not found: ${relPath}`)
      }
      throw err
    }
  }
  // BLOB: getBlob() (blobStore.js) authenticates via Vercel OIDC at
  // runtime -- no credential handling needed here at all. Returns null for
  // a genuine 404 (per @vercel/blob's own get() contract), a
  // {statusCode, stream, ...} result otherwise.
  const key = privateDataBlobKey(tenantId, relPath, storage.privateDataPrefix)
  const result = await getBlob(key)
  if (result === null) {
    throw new PrivateDataFileNotFoundError(`private-data file not found in Blob: ${key}`)
  }
  return streamToText(result.stream)
}

// Non-throwing existence check for diagnostics that want to report "not
// onboarded" without raising. Still validates tenantId's shape first.
// Static registry only -- deliberately does NOT consult the dynamic path.
export function isPrivateDataTenantOnboarded(tenantId) {
  assertValidTenantId(tenantId, 'isPrivateDataTenantOnboarded')
  return Object.prototype.hasOwnProperty.call(TENANT_PRIVATE_DATA_ROOT_REGISTRY, tenantId)
}

// Multi-Tenant Phase 4F -- retained as its own export (a future admin
// status view may want "is this tenant's provisioning genuinely complete
// and operational" as a plain boolean) -- delegates to the exact same
// internal logic resolveTenantStorage()'s dynamic branch uses.
export async function resolveProvisionedPrivateDataRoot(tenantId) {
  assertValidTenantId(tenantId, 'resolveProvisionedPrivateDataRoot')
  return resolveProvisionedStorage(tenantId)
}

// Safely joins a tenant's resolved LEGACY_REPO root with a caller-provided
// relative path segment, guaranteeing the result can never escape that
// root -- second, independent layer of defense after callers' own
// allowlist/segment checks, not the only one. Throws PathEscapeError if
// resolution would land outside root.
export class PathEscapeError extends Error {}

export function resolveWithinRoot(root, relPath) {
  const resolved = path.resolve(root, relPath)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathEscapeError(`resolveWithinRoot: ${JSON.stringify(relPath)} escapes root ${root}`)
  }
  return resolved
}
