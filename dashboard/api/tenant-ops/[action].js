// Multi-Tenant Phase 4H.1 -- GET /api/tenant-ops?action=... -- a READ-ONLY
// status surface over tenant_config:v1 for the platform operator (Los Tres
// Amigos's own Owner accounts -- see auth.js's isSuperAdmin() for why this
// is deliberately narrower than "any tenant's Owner"). Consolidated into
// this project's established dynamic-route convention (see
// notifications/[action].js, settings/[action].js -- Vercel Hobby's
// 12-serverless-function ceiling means a new top-level route per action is
// not an option; this is the 11th function).
//
//   GET ?action=list -> { tenants: [...] }
//
// THIS FILE NEVER MUTATES tenant_config, NEVER calls provision_tenant.py/
// initial_sync.py, and NEVER dispatches a GitHub Actions workflow --
// mutation happens exclusively through .github/workflows/tenant-lifecycle.yml
// (a human-operated, confirmation-gated dispatch), per this phase's explicit
// "do not fake an in-dashboard dispatch button" requirement. This route
// exists only so an operator can SEE current state before deciding what to
// dispatch there.
//
// SANITIZATION: the response is an explicit allowlist of fields, never a
// spread of the raw tenant_config record or a raw credential object --
// approvedLocations (Google resource ids/addresses), locationIdMap,
// reviewDbBlobKey/privateDataPrefix, and any refreshToken are all
// deliberately excluded. getStoredCredential()'s return value is reduced
// to a single boolean (hasGoogleCredential) before it ever reaches this
// response -- the decrypted token itself is discarded immediately, never
// serialized.

import { requireAuth, isSuperAdmin } from '../_lib/auth.js'
import { listTenantConfigs, TenantConfigStoreUnavailableError } from '../_lib/tenantConfigStore.js'
import { getStoredCredential, CredentialStoreUnavailableError } from '../_lib/credentialStore.js'

// Multi-Tenant Phase 4H.1 -- MIRRORS the real, authoritative precondition
// sets initial_sync.py's _ELIGIBLE_STATUSES / provision_tenant.py's
// _PROVISIONABLE_STATUSES enforce server-side. Informational ONLY: this
// page never performs the operation itself, so a drift here is a UX bug
// (an operator sees "eligible" for an operation that then fails closed
// server-side), never a security bug -- the Python scripts re-validate
// every precondition themselves regardless of what this page displays.
// Kept as explicit, named constants (not inlined) so a future change to
// either Python set is easy to notice needs mirroring here too.
const PROVISIONING_ELIGIBLE_STATUSES = new Set(['locations_approved', 'provisioning', 'provisioning_failed', 'provisioned', 'active'])
const INITIAL_SYNC_ELIGIBLE_STATUSES = new Set(['provisioned', 'initial_sync_failed'])

async function resolveHasGoogleCredential(tenantId) {
  try {
    const credential = await getStoredCredential(tenantId)
    return Boolean(credential && credential.refreshToken)
  } catch (err) {
    if (err instanceof CredentialStoreUnavailableError) return null
    throw err
  }
}

function sanitizeTenant(config, hasGoogleCredential) {
  const provisioning = config.provisioning ?? {}
  const initialSync = config.initialSync ?? {}
  return {
    tenantId: config.tenantId,
    displayName: config.displayName ?? config.tenantId,
    status: config.status,
    storageMode: config.storageMode,
    approvedLocationCount: Array.isArray(config.approvedLocations) ? config.approvedLocations.length : 0,
    provisioning: {
      status: provisioning.status ?? 'none',
      lastAttemptAt: provisioning.lastAttemptAt ?? null,
      artifactGeneration: provisioning.artifactGeneration ?? null,
    },
    initialSync: {
      status: initialSync.status ?? 'none',
      startedAt: initialSync.startedAt ?? null,
      completedAt: initialSync.completedAt ?? null,
      failedAt: initialSync.failedAt ?? null,
      reviewCount: initialSync.reviewCount ?? null,
      locationCount: initialSync.locationCount ?? null,
      // lastError is already a sanitized, operator-safe string by
      // construction -- see initial_sync.py's _safe_error()/
      // provision_tenant.py's own str(e) usage, neither of which ever
      // embeds a credential, token, or raw review text. Never a stack
      // trace: both scripts catch at their own top level and store only
      // "{ExceptionClassName}: {message}".
      lastError: initialSync.lastError ?? provisioning.lastError ?? null,
    },
    hasGoogleCredential,
    eligibility: {
      canProvision: PROVISIONING_ELIGIBLE_STATUSES.has(config.status) && config.storageMode === 'BLOB',
      canInitialSync: INITIAL_SYNC_ELIGIBLE_STATUSES.has(config.status) && config.storageMode === 'BLOB',
    },
  }
}

async function list(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return
  if (!isSuperAdmin(account)) {
    // Existence-hiding is not meaningful here (this isn't a per-resource
    // lookup a caller could otherwise probe) -- a plain 403 is the correct,
    // unambiguous signal for "you are authenticated but not the platform
    // operator," matching google/[action].js's own owner-only actions.
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to view tenant operations.' })
  }

  // Never cached -- an operator watching this page while a GitHub Actions
  // run is in flight must see fresh state on every poll, never a stale
  // shared/CDN-cached snapshot.
  res.setHeader('Cache-Control', 'private, no-store')

  let configs
  try {
    configs = await listTenantConfigs()
  } catch (err) {
    if (err instanceof TenantConfigStoreUnavailableError) {
      return res.status(503).json({ error: 'service_unavailable', message: 'The tenant configuration store is temporarily unavailable.' })
    }
    throw err
  }

  const tenants = await Promise.all(configs.map(async config => {
    const hasGoogleCredential = await resolveHasGoogleCredential(config.tenantId)
    return sanitizeTenant(config, hasGoogleCredential)
  }))
  tenants.sort((a, b) => a.tenantId.localeCompare(b.tenantId))

  return res.status(200).json({ tenants })
}

export default async function handler(req, res) {
  switch (req.query?.action) {
    case 'list': return list(req, res)
    default:     return res.status(404).json({ error: 'not_found' })
  }
}
