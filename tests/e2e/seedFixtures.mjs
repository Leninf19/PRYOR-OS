// Phase 4L pilot-readiness harness -- seeds synthetic, unmistakably
// non-production tenant fixtures into the shared fake Redis/Blob store
// (fakeInfra.mjs) using ONLY the real, reviewed domain functions
// (tenantConfigStore.js / userStore.js / credentialStore.js) every
// production code path already uses -- never a raw Redis write. Reaching a
// given lifecycle state this way is the same operation the real system
// performs to reach it (proven cross-language-consistent with the Python
// side by tests/test_tenant_config_cross_language_consistency.*); this
// script just orchestrates the sequence directly instead of waiting for a
// live GitHub Actions run, since Phase 4L explicitly asks for "test/local
// infrastructure ... where production credentials would otherwise be
// required."
//
// No real Upstash, no real Vercel Blob, no real Google, no production data.

import bcrypt from 'bcryptjs'
import { installFakeInfra, registerGoogleFixture } from './fakeInfra.mjs'
import { upsertUser } from '../../dashboard/api/_lib/userStore.js'
import {
  recordLocationApproval, getTenantConfig, markTenantProvisioned, markTenantProvisioningFailed,
  markTenantInitialSyncStarted, markTenantInitialSyncFailed, markTenantActive, upsertTenantConfig,
} from '../../dashboard/api/_lib/tenantConfigStore.js'
import { setStoredCredential } from '../../dashboard/api/_lib/credentialStore.js'
import { signSession } from '../../dashboard/api/_lib/session.js'
import { generationPrivateDataBlobKey, reviewDbBlobKey as reviewDbBlobKeyFor } from '../../dashboard/api/_lib/tenantBlobKeys.js'

const { blob } = installFakeInfra()

const PASSWORD = 'pilot-harness-not-a-real-password'
let hashCache = null
async function ownerPasswordHash() {
  if (!hashCache) hashCache = await bcrypt.hash(PASSWORD, 12)
  return hashCache
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

// Writes the exact "day-zero" empty-state artifact set provision_tenant.py's
// own _build_initial_artifacts() produces (same field names/shape), so
// data.js's real dynamic-resolution code path has something genuine to
// serve once a tenant reaches 'active'.
function buildDayZeroArtifacts(approvedLocations) {
  const locations = approvedLocations.map(l => ({
    locationId: l.locationId, name: l.title, city: '', brand: null, slug: slugify(l.title || `location-${l.locationId}`), maps_url: '', hasContact: false,
  }))
  const artifacts = {
    'meta.json': { locations, brands: [], totalReviews: 0, generatedAt: new Date().toISOString(), initialSyncCompleted: true },
    'action-items.json': { items: [] },
    'gbp-sync.json': { locations: [], generatedAt: new Date().toISOString(), neverSynced: false },
    '_internal/review-location-index.json': {},
  }
  for (const loc of locations) artifacts[`reviews/by-location/${loc.slug}.json`] = []
  return artifacts
}

async function uploadArtifacts(tenantId, generation, artifacts) {
  for (const [relPath, data] of Object.entries(artifacts)) {
    const key = generationPrivateDataBlobKey(tenantId, generation, relPath)
    await blob.client.put(key, Buffer.from(JSON.stringify(data)), { contentType: 'application/json' })
  }
}

async function seedOwnerAccount(tenantId, userId, email) {
  const passwordHash = await ownerPasswordHash()
  await upsertUser(tenantId, {
    userId, email, passwordHash, role: 'owner', locationIds: '*',
    sessionVersion: 1, disabled: false, displayName: 'Pilot Owner',
    tenantId, passwordSetAt: new Date().toISOString(),
  })
  return signSession({ userId, email, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
}

// Stage 1: brand new tenant -- no tenant_config record at all yet (the real
// "day zero" state; session/[action].js's tenant-status action synthesizes
// {status:'onboarding'} for this with ZERO reads/writes needed).
export async function seedOnboardingTenant({ tenantId, userId, email }) {
  return { tenantId, token: await seedOwnerAccount(tenantId, userId, email) }
}

// Stage 2: locations approved (owner has connected Google + approved a
// location set) but not yet provisioned.
export async function seedLocationsApprovedTenant({ tenantId, userId, email, googleLocationIds, titlePrefix = 'Pilot Location' }) {
  const { token } = await seedOnboardingTenant({ tenantId, userId, email })
  // titlePrefix is tenant-distinctive on purpose (Phase 4L finding): two
  // different tenants both legitimately reaching locationId=1 in their own
  // namespace is the exact "duplicate local ID stays harmless" case this
  // phase's A/B isolation check proves -- but that proof is only
  // meaningful if their DISPLAY names actually differ too, the way two
  // real, unrelated restaurants' locations would.
  await recordLocationApproval(tenantId, googleLocationIds.map((id, i) => ({ googleLocationId: id, title: `${titlePrefix} ${i + 1}`, address: `${i + 1} Test St` })))
  return { tenantId, token }
}

// Stage 3: provisioning failed (the operator ran provision_tenant.py, it
// failed) -- surfaces the dashboard's provisioning_failed UI.
export async function seedProvisioningFailedTenant(args) {
  const { tenantId, token } = await seedLocationsApprovedTenant(args)
  await markTenantProvisioningFailed(tenantId, 'fake: simulated Blob upload failure for pilot-readiness testing')
  return { tenantId, token }
}

// Stage 4: provisioned (successful provision_tenant.py run) but Initial
// Sync has not run yet.
export async function seedProvisionedTenant(args) {
  const { tenantId, token } = await seedLocationsApprovedTenant(args)
  const config = await getTenantConfig(tenantId)
  const generation = `pilot-gen-${tenantId}-1`
  const artifacts = buildDayZeroArtifacts(config.approvedLocations)
  await uploadArtifacts(tenantId, generation, artifacts)
  await markTenantProvisioned(tenantId, {
    reviewDbBlobKey: reviewDbBlobKeyFor(tenantId),
    privateDataPrefix: `tenant-data/${tenantId}/private-data/`,
    reviewDbEtag: 'fake-etag-provisioned-1',
    artifactGeneration: generation,
    provisionedLocationIds: config.approvedLocations.map(l => l.locationId),
  })
  return { tenantId, token, generation }
}

// Stage 5: Initial Sync in progress.
export async function seedInitialSyncInProgressTenant(args) {
  const { tenantId, token } = await seedProvisionedTenant(args)
  await markTenantInitialSyncStarted(tenantId)
  return { tenantId, token }
}

// Stage 6: Initial Sync failed.
export async function seedInitialSyncFailedTenant(args) {
  const { tenantId, token } = await seedInitialSyncInProgressTenant(args)
  await markTenantInitialSyncFailed(tenantId, 'fake: simulated Google API outage during Initial Sync for pilot-readiness testing')
  return { tenantId, token }
}

// Stage 7: active -- the full, real pilot end state. Also stores a
// working fake Google credential so google/status + reconnect flows have
// something real to read.
export async function seedActiveTenant(args) {
  const { tenantId, token, generation } = await seedProvisionedTenant(args)
  await markTenantActive(tenantId, { reviewDbEtag: 'fake-etag-active-1', artifactGeneration: generation, reviewCount: 0, locationCount: args.googleLocationIds.length })
  const refreshToken = `fake-refresh-${tenantId}`
  registerGoogleFixture({
    refreshToken,
    accounts: { [`accounts/${tenantId}`]: args.googleLocationIds.map((id, i) => ({ name: id.split('/').pop() ? id : `locations/${i + 1}`, title: `Pilot Location ${i + 1}` })) },
  })
  await setStoredCredential(tenantId, { refreshToken, connectedAccountName: `Pilot Account (${tenantId})` })
  return { tenantId, token }
}

// Stage 8: suspended -- Multi-Tenant Phase 4L finding: there is currently NO
// exposed API action anywhere in this codebase that sets status:'suspended'
// (tenant-ops/[action].js is read-only "list" only, confirmed in Phase 4J/
// 4K). Directly calling upsertTenantConfig() here is therefore not a
// shortcut around a real mechanism -- it IS the only mechanism that exists
// today (an operator would currently have to do the equivalent via a
// one-off script or direct Redis edit). Documented as a real gap in the
// Phase 4L report, not silently worked around.
export async function seedSuspendedTenant(args) {
  const { tenantId, token } = await seedActiveTenant(args)
  const config = await getTenantConfig(tenantId)
  await upsertTenantConfig(tenantId, { status: 'suspended' }, { expectedVersion: config.configVersion })
  return { tenantId, token }
}
