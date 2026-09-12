// "Prevent duplicate/shadow tenant creation during self-service onboarding"
// hardening phase -- the ONE centralized primitive allowed to materialize a
// BRAND-NEW tenant identity (a fresh tenant_config + its initial owner
// user). This exists because the investigation for this phase found that
// dashboard/api/_lib/tenantConfigStore.js's upsertTenantConfig() and
// dashboard/api/_lib/userStore.js's upsertUser() were both plain exported
// functions, reachable from any Node script with real Upstash credentials,
// capable of creating a real, usable owner account under an arbitrary
// (including entirely nonexistent) tenantId with ZERO identity/collision
// checks -- almost certainly the actual mechanism behind the
// t_los-tres-amigos-pilot incident (see that investigation's report; it was
// NOT the self-service registration flow, which has always used a
// random-suffixed generateTenantId() output no hand-typed id could match).
//
// Both of those functions now REFUSE to create a new record at all unless
// the caller explicitly says so (tenantConfigStore.js's `allowCreate` +
// `creationSource`, userStore.js's `creationMode`) -- this file is the one
// place that does, so "how can a brand-new tenant come to exist" has
// exactly one reviewable answer, enumerated by
// tests/test_tenant_creation_callers.js.
//
// Existing-tenant flows (invite-user, role/location changes, disable/
// enable, password reset, every provisioning/sync status transition) are
// COMPLETELY UNCHANGED by this file -- they call upsertTenantConfig()/
// upsertUser() exactly as before, since none of them are creating a new
// tenant identity; see each store's own comments for their approved,
// narrower creation modes.

import { getTenantConfig, upsertTenantConfig, TenantConfigStoreUnavailableError } from './tenantConfigStore.js'
import { upsertUser, UserCreationMode, UserStoreUnavailableError } from './userStore.js'
import { getAccountByEmailRequireRedisHealthy } from './accountStore.js'
import { generateTenantId } from './tenantIdGenerator.js'
import { isValidTenantId, DEFAULT_TENANT_ID } from './tenants.js'

// Every legitimate reason a brand-new tenant identity can come to exist --
// deliberately small and enumerated, never an arbitrary caller string.
// Reused verbatim as tenantConfigStore.js's `creationSource` (the two
// concepts are the same thing: "why does this tenant exist at all").
export const TenantCreationMode = Object.freeze({
  SELF_SERVICE: 'self_service',
  ADMIN_PROVISIONING: 'admin_provisioning',
  MIGRATION: 'migration',
})

export class TenantCreationModeRequiredError extends Error {}
export class IdentityAlreadyExistsError extends Error {}
export class TenantAlreadyExistsError extends Error {}

// A self-service tenantId must be EXACTLY what generateTenantId() itself
// produces (t_<slug>-<6 lowercase-alphanumeric chars>) -- checked whenever
// a caller supplies one (see `reservedTenantId` below) as defense in depth
// against a hand-typed id masquerading as a self-service reservation. This
// does not, by itself, prove provenance (a determined caller could satisfy
// the pattern deliberately) -- see this project's own documented position
// on that limitation in the phase report ("Internal credential reality").
const SELF_SERVICE_TENANT_ID_PATTERN = /^t_[a-z0-9-]*-[a-z0-9]{6}$/

/**
 * The one centralized way a brand-new tenant identity (tenant_config +
 * its initial owner user) may be created.
 *
 * @param {object} params
 * @param {'self_service'|'admin_provisioning'|'migration'} params.mode -
 *   REQUIRED, no permissive default -- every caller must declare intent.
 * @param {string} [params.tenantIdOverride] - an explicit, operator-chosen
 *   tenant id. Permitted ONLY for 'admin_provisioning'/'migration' modes;
 *   passing this for 'self_service' throws.
 * @param {string} [params.reservedTenantId] - for 'self_service' mode only:
 *   a tenantId ALREADY produced by generateTenantId() at an earlier step
 *   (session/[action].js's register(), which reserves an id up front so a
 *   retry of the final creation step -- possibly days later, after email
 *   verification -- reuses the same id rather than orphaning a new one on
 *   every attempt). Must match generateTenantId()'s own output shape
 *   (checked, not merely trusted). Omit to have this function mint a fresh
 *   id itself via generateTenantId(companyName).
 * @param {string} params.companyName - human-provided display name; also
 *   the slug seed when a self-service id must be freshly generated.
 * @param {string} params.ownerEmail
 * @param {string} params.ownerUserId
 * @param {string} params.ownerPasswordHash
 * @param {string} [params.ownerDisplayName]
 * @param {string} [params.ownerPasswordSetAt] - ISO timestamp; defaults to
 *   "now" but a caller that already knows the owner set their password
 *   earlier (self-service registration, which hashes it at register()
 *   time, not at this later creation step) should pass that original
 *   timestamp through rather than let this function overwrite it with the
 *   creation moment.
 * @param {object} [params.commercial] - plain descriptive commercial/
 *   billing metadata (tenantConfigStore.js's `commercial` field) -- never
 *   consulted by any authorization check.
 * @param {string} [params.createdByType] - 'user'|'admin'|'system' (provenance only)
 * @param {string} [params.createdByActorId] - provenance only
 * @returns {Promise<{tenantId: string, userRecord: object}>}
 */
export async function createNewTenant({
  mode, tenantIdOverride, reservedTenantId, companyName,
  ownerEmail, ownerUserId, ownerPasswordHash, ownerDisplayName, ownerPasswordSetAt,
  commercial = null, createdByType = null, createdByActorId = null,
}) {
  if (!Object.values(TenantCreationMode).includes(mode)) {
    throw new TenantCreationModeRequiredError(`createNewTenant: mode is required and must be one of ${Object.values(TenantCreationMode).join(', ')} -- got ${JSON.stringify(mode)}`)
  }

  let tenantId
  if (mode === TenantCreationMode.SELF_SERVICE) {
    if (tenantIdOverride) {
      throw new TenantCreationModeRequiredError('createNewTenant: mode "self_service" must never accept an operator-chosen tenantIdOverride -- self-service tenants are always randomly suffixed')
    }
    if (reservedTenantId) {
      if (!SELF_SERVICE_TENANT_ID_PATTERN.test(reservedTenantId)) {
        throw new TenantCreationModeRequiredError(`createNewTenant: reservedTenantId ${JSON.stringify(reservedTenantId)} does not match generateTenantId()'s own output shape`)
      }
      tenantId = reservedTenantId
    } else {
      tenantId = await generateTenantId(companyName)
    }
  } else {
    if (!tenantIdOverride || !isValidTenantId(tenantIdOverride)) {
      throw new TenantCreationModeRequiredError(`createNewTenant: mode ${JSON.stringify(mode)} requires a valid, explicit tenantIdOverride`)
    }
    if (tenantIdOverride === DEFAULT_TENANT_ID) {
      throw new TenantCreationModeRequiredError('createNewTenant: may never create a tenant_config claiming to be Los Tres Amigos -- that tenant is served entirely by the static registry and never has a tenant_config record by design')
    }
    tenantId = tenantIdOverride
  }

  // 1. Fail-closed identity check (Phase D of this phase's report): if
  // Redis identity state cannot be authoritatively verified, this throws
  // UserStoreUnavailableError -- propagated as-is, never swallowed --
  // rather than proceeding as though no account exists. Callers already
  // treat UserStoreUnavailableError as a 503 (see
  // redeemAccessCodeAction()/register() in session/[action].js).
  const existingIdentity = await getAccountByEmailRequireRedisHealthy(ownerEmail)
  if (existingIdentity) {
    throw new IdentityAlreadyExistsError(`createNewTenant: an account already exists for ${JSON.stringify(ownerEmail)} -- refusing to create a new tenant for it`)
  }

  // 2. Tenant must not already exist. Idempotent-retry exception: if a
  // PRIOR attempt already created this exact tenant_config (possible only
  // for 'self_service' with a `reservedTenantId` reused across a retry --
  // the id's own uniqueness, minted once by generateTenantId(), IS the
  // proof this is the same caller's own earlier attempt, never a genuine
  // collision with anyone else), this is a safe continuation, not an
  // error -- mirroring the pre-existing, already-tested idempotent-retry
  // contract this function's callers rely on. 'admin_provisioning'/
  // 'migration' modes never get this exception: an explicit, operator-
  // chosen id colliding with something real is always a genuine conflict.
  const existingConfig = await getTenantConfig(tenantId)
  const isSelfServiceRetry = mode === TenantCreationMode.SELF_SERVICE && Boolean(reservedTenantId) && existingConfig !== null
  if (existingConfig && !isSelfServiceRetry) {
    throw new TenantAlreadyExistsError(`createNewTenant: tenant ${JSON.stringify(tenantId)} already exists`)
  }

  // 3. Repeat conflict checks immediately before write -- re-fetch both
  // signals right before committing, closing the window between step 1/2
  // (above) and the actual write. Still not a substitute for the caller
  // holding its own creation lock around this whole call (see
  // session/[action].js's createTenantForVerifiedRegistration(), which
  // already does via pendingRegistrationStore.js's per-email lock) --
  // documented as this function's caller's own responsibility, since a
  // lock keyed correctly for every mode (per-email for self-service,
  // possibly per-tenantId for admin/migration tooling) is a caller
  // concern, not something this shared primitive can assume.
  if (!existingConfig) {
    const recheckIdentity = await getAccountByEmailRequireRedisHealthy(ownerEmail)
    if (recheckIdentity) {
      throw new IdentityAlreadyExistsError(`createNewTenant: an account for ${JSON.stringify(ownerEmail)} was created concurrently -- refusing to create a new tenant for it`)
    }
    const recheckConfig = await getTenantConfig(tenantId)
    if (recheckConfig) {
      throw new TenantAlreadyExistsError(`createNewTenant: tenant ${JSON.stringify(tenantId)} was created concurrently`)
    }

    // 4. Write tenant_config -- the ONLY call in this codebase (besides
    // recordLocationApproval()'s own defensive, non-attacker-reachable
    // allowCreate use) permitted to pass allowCreate: true. creationSource
    // is exactly `mode` -- the two enums are deliberately identical sets.
    await upsertTenantConfig(tenantId, { displayName: companyName ?? tenantId, commercial }, {
      allowCreate: true, creationSource: mode, createdByType, createdByActorId,
    })
  }

  // 5. Write the initial owner user. UserCreationMode.INITIAL_TENANT_OWNER's
  // own structural invariant (userStore.js) independently re-proves "this
  // tenant has zero users yet" -- a second layer of protection beyond this
  // function being the only intended caller.
  const now = new Date().toISOString()
  const userRecord = await upsertUser(tenantId, {
    userId: ownerUserId, email: ownerEmail, passwordHash: ownerPasswordHash,
    role: 'owner', locationIds: '*', tenantId, sessionVersion: 1, disabled: false,
    displayName: ownerDisplayName ?? null, createdAt: now, updatedAt: now, lastLoginAt: null,
    invitedAt: null, invitedBy: null, lastInviteSentAt: null,
    inviteTokenHash: null, inviteExpiresAt: null, inviteRevokedAt: null,
    passwordSetAt: ownerPasswordSetAt ?? now,
  }, { creationMode: UserCreationMode.INITIAL_TENANT_OWNER })

  return { tenantId, userRecord }
}

export { TenantConfigStoreUnavailableError, UserStoreUnavailableError }
