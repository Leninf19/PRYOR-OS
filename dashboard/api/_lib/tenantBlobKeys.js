// Multi-Tenant Phase 4F.1 -- the canonical, server-controlled formula for
// turning a validated tenantId into the Vercel Blob object keys that
// tenant's durable review-storage data lives at. This is the Blob-storage
// counterpart to reviewDataPaths.js's TENANT_PRIVATE_DATA_ROOT_REGISTRY: the
// registry there is a lookup table because a filesystem root is an
// arbitrary, source-controlled decision (and LTA's is a pre-existing,
// non-formulaic path); a Blob key for a BLOB-mode tenant is NOT arbitrary --
// it is a fixed, deterministic function of tenantId alone, so both languages
// can independently compute (and cross-check) the SAME key from nothing but
// an already-validated tenantId, with no registry/Redis read required.
//
// Server control still holds: these functions take ONLY a tenantId that has
// already passed isValidTenantId()/tenant_keys.assert_valid_tenant_id() (the
// same `^t_[a-z0-9-]+$` pattern enforced everywhere else in this codebase),
// never raw request input, and a relPath that must already have passed a
// caller's own allowlist/segment validation (see data.js's
// buildRequestedRelPath()) before it ever reaches here -- this module adds
// one more independent defense-in-depth check (no '..' segments, no leading
// slash, no NUL/backslash) but is not the only place that validation lives.
//
// CANONICAL LAYOUT (mirrored byte-for-byte in tenant_blob_keys.py --
// tests/test_tenant_blob_keys_cross_language_consistency.{js,py} cross-check
// both languages against the same fixture, exactly like
// tenant_config_shape.json does for the config record):
//   tenant-data/{tenantId}/reviews.db
//   tenant-data/{tenantId}/private-data/meta.json
//   tenant-data/{tenantId}/private-data/action-items.json
//   tenant-data/{tenantId}/private-data/gbp-sync.json
//   tenant-data/{tenantId}/private-data/_internal/review-location-index.json
//   tenant-data/{tenantId}/private-data/reviews/by-location/{slug}.json

import { isValidTenantId } from './tenants.js'

export class InvalidBlobKeyInputError extends Error {}

function assertValidTenantId(tenantId, fnName) {
  if (!isValidTenantId(tenantId)) {
    throw new InvalidBlobKeyInputError(`${fnName}: invalid tenantId ${JSON.stringify(tenantId)}`)
  }
}

// Defense-in-depth only -- callers (data.js's buildRequestedRelPath(), the
// EXACT/DYNAMIC allowlists) are the primary guard against a malformed
// relPath ever reaching this module.
function assertSafeRelPath(relPath, fnName) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new InvalidBlobKeyInputError(`${fnName}: relPath must be a non-empty string`)
  }
  const segments = relPath.split('/')
  for (const seg of segments) {
    if (seg.length === 0 || seg === '.' || seg === '..' || seg.includes('\0') || seg.includes('\\')) {
      throw new InvalidBlobKeyInputError(`${fnName}: unsafe relPath segment ${JSON.stringify(seg)} in ${JSON.stringify(relPath)}`)
    }
  }
}

export function tenantBlobRoot(tenantId) {
  assertValidTenantId(tenantId, 'tenantBlobRoot')
  return `tenant-data/${tenantId}`
}

export function reviewDbBlobKey(tenantId) {
  return `${tenantBlobRoot(tenantId)}/reviews.db`
}

// Always ends with a trailing slash -- this is the exact prefix value
// recorded in tenant_config's provisioning.privateDataPrefix and consumed by
// reviewDataPaths.js's readPrivateDataFile().
export function privateDataPrefix(tenantId) {
  return `${tenantBlobRoot(tenantId)}/private-data/`
}

// `prefix`, if supplied, must be the tenant's OWN recorded
// provisioning.privateDataPrefix (reviewDataPaths.js passes it explicitly,
// having already verified it belongs to this tenant's verified-provisioned
// config record) -- defaults to the freshly-derived formula so direct
// callers (tests, provisioning) don't have to compute it separately.
export function privateDataBlobKey(tenantId, relPath, prefix) {
  assertSafeRelPath(relPath, 'privateDataBlobKey')
  const base = prefix ?? privateDataPrefix(tenantId)
  return `${base}${relPath}`
}
