// Phase B.6 -- 7-day Growth trial: server-controlled, idempotent trial
// START orchestration. This is the ONE place tenant_config.commercial ever
// transitions from "no commercial decision yet" into an active trial --
// no endpoint/UI ever writes commercial.trial directly.
//
// TRIAL START INSERTION POINT (Part A's audit finding, restated here since
// it drives this whole module's design): there is no dedicated Node-side
// hook for "GBP OAuth connected + first initial sync completed" -- the
// real production writer of that event is Python's initial_sync.py, which
// writes tenant_config.status: 'active' directly via
// tenant_config_store.upsert_tenant_config(), gated by its own
// _ELIGIBLE_STATUSES = {'provisioned', 'initial_sync_failed'} so this write
// is PROVABLY only ever a genuine first transition into 'active', never a
// later re-sync. Node code (including this module) only ever OBSERVES the
// resulting status via a fresh getTenantConfig() read -- it never invokes
// or hooks the Python write itself. maybeStartTrial() is therefore called
// as a lazy, read-time reaction, from session/[action].js's tenantStatus()
// action (already polled every ~15s by the frontend's useTenantStatus()
// hook) -- this makes "the server notices the tenant just became eligible"
// a natural, already-existing, frequently-recurring server-authoritative
// moment, with zero new client-triggered surface and zero changes to the
// Python provisioning/sync pipeline.
//
// FINAL TRIAL-INTEGRITY CORRECTION #1 -- commercial === null is NEVER, by
// itself, sufficient grounds for automatic trial enrollment. B.2
// deliberately made commercial === null mean "legacy compatibility" while
// COMMERCIAL_ENFORCEMENT_CUTOFF is disabled, and for grandfathered
// pre-cutoff tenants once it is armed -- an EXISTING REDIS_ONLY tenant with
// no commercial record must never be silently upgraded into a 7-day trial
// merely because tenantStatus() happens to be read. This module therefore
// requires a SEPARATE, explicit, server-controlled marker --
// tenant_config.trialEligibility = { eligible: true, markedAt, source } --
// distinguishing "this tenant is intentionally entering the self-service
// free-trial onboarding flow" from "commercial state is merely missing."
// This marker:
//   - defaults to absent/not-eligible for every existing tenant (backward
//     compatible -- nothing today writes it, so automatic enrollment stays
//     dormant in production until a later, separately reviewed self-service
//     tenant-creation path explicitly sets it at creation time);
//   - is never read from a request (see TRIAL_ELIGIBILITY_SOURCES below --
//     only a small enumerated set of SERVER-SIDE provenance values is ever
//     legal, mirroring tenantConfigStore.js's own TENANT_CREATION_SOURCES
//     pattern);
//   - is checked IN ADDITION TO, never instead of, the existing
//     commercial === null / status === 'active' preconditions below.
//
// FINAL TRIAL-INTEGRITY CORRECTION #2 -- the 7-day clock is anchored to
// tenant_config.initialSync.completedAt, NEVER to the trial claim's own
// reservedAt (which depends on when tenantStatus() happens to run) and
// NEVER to Date.now(). initialSync.completedAt is written EXACTLY ONCE, by
// initial_sync.py's own success path (initial_sync.py:540), and is
// structurally guaranteed immutable thereafter: that file's own
// _ELIGIBLE_STATUSES = {'provisioned', 'initial_sync_failed'} excludes
// 'active' as a valid entry state, so initial_sync.py can never re-run
// (and therefore never re-write initialSync.completedAt) once a tenant has
// reached 'active'. No other Python file (apply_entitlement_change.py,
// provision_tenant.py) ever writes the initialSync key at all -- confirmed
// by direct source audit before this correction. This is exactly the
// "authoritative timestamp already exists" case -- no Python change was
// needed. The trial claim's own reservedAt remains claim
// bookkeeping/ownership/audit metadata ONLY; it no longer defines the
// commercial clock in any way.

import {
  getTenantConfig, upsertTenantConfig,
  ConfigVersionConflictError, TenantConfigStoreUnavailableError,
} from './tenantConfigStore.js'
import { locationCatalogModeFor, LocationCatalogMigrationMode } from './tenants.js'
import { reserveTrialClaim, finalizeTrialClaim, TrialEligibilityStoreUnavailableError } from './trialEligibilityStore.js'
import { commercialIdentityKey } from './commercialIdentity.js'
import { listUsers } from './userStore.js'

const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000

// Enumerated, server-only provenance values for tenant_config.trialEligibility
// -- mirrors tenantConfigStore.js's TENANT_CREATION_SOURCES discipline
// ("how was this decided" stays a small, reviewable set of real answers,
// never an arbitrary caller-supplied string). No production writer exists
// yet for 'self_service_registration' (self-service commercial activation
// is not live) -- 'test_fixture' exists solely so tests can seed eligible
// tenants directly, matching this phase's "tests may set fixture state
// directly" precedent, without inventing a public endpoint to do so.
export const TRIAL_ELIGIBILITY_SOURCES = Object.freeze(['self_service_registration', 'test_fixture'])

// Deterministic trial-eligible-location selection (Part F): the approved
// location with the SMALLEST locationId. locationId is assigned once, at
// first-ever-approval time, from tenant_config's own monotonic
// nextLocationId counter (tenantConfigStore.js) -- so the minimum-locationId
// entry is provably the earliest location this tenant ever approved,
// regardless of any later reordering, additions, or removals via
// applyEntitlementChange(). This is evaluated only once, at the moment
// status first becomes 'active' (before which applyEntitlementChange()
// cannot yet have run against an unactivated tenant), so in practice this
// is exactly the tenant's original onboarding location set. Exported for
// direct unit testing.
export function selectTrialEligibleLocation(approvedLocations) {
  if (!Array.isArray(approvedLocations) || approvedLocations.length === 0) return null
  return [...approvedLocations].sort((a, b) => a.locationId - b.locationId)[0]
}

// Best-effort ONLY -- commercialIdentityKey is an explicitly secondary,
// non-blocking signal (commercialIdentity.js's own header). A failure to
// look up the tenant's owner (store outage, no owner found yet) must NEVER
// block or fail trial start; it just means this attempt records a null key.
async function bestEffortOwnerCommercialIdentityKey(tenantId) {
  try {
    const users = await listUsers(tenantId)
    const owner = users.find(u => u.role === 'owner' && !u.disabled)
    return owner ? commercialIdentityKey(owner.email) : null
  } catch {
    return null
  }
}

// Server-controlled, idempotent trial-start attempt against an
// ALREADY-LOADED tenant_config `config` (never re-read independently here
// -- the caller's own fresh getTenantConfig() read is what this function's
// CAS write is bound to). Returns the SAME `config` unchanged if no
// transition applies (not eligible, already decided, denied, or a
// recoverable failure), or the FRESHLY-WRITTEN config if a trial just
// started. Never reads anything from a request -- tenantId is the only
// caller-supplied input, and it must already be the authenticated,
// server-resolved tenant id, never a client-supplied value.
export async function maybeStartTrial(tenantId, config) {
  if (!config) return config

  // LTA/BOOTSTRAP never enters the trial flow -- no read, no write, no
  // claim lookup, ever attempted for it. No LTA tenant_config is created or
  // touched by this module, ever.
  if (locationCatalogModeFor(tenantId) === LocationCatalogMigrationMode.BOOTSTRAP) return config

  // Only a tenant with NO commercial decision at all yet is eligible for
  // the automatic GBP-triggered trial. This deliberately excludes:
  //   - a tenant whose trial has already started/expired/converted, or any
  //     other real commercial decision (commercial is already a populated
  //     new-shape object) -- Part F's "once consumed, never again,"
  //     satisfied purely by this precondition, with no separate
  //     "already consumed" flag needed.
  //   - a tenant created via an access code (commercial is already an
  //     OLD-shape {plan, source:'access_code', ...} object written at
  //     tenant-creation time) -- see this phase's stop-point report, Part
  //     J: an access-code-sourced tenant never ALSO independently earns
  //     the automatic GBP trial. This avoids two contradictory trial
  //     systems firing for the same tenant.
  if (config.commercial !== null && config.commercial !== undefined) return config

  // CORRECTION #1: commercial === null is NECESSARY but never SUFFICIENT.
  // An explicit, server-controlled trialEligibility marker is REQUIRED --
  // this is what distinguishes "this tenant is intentionally entering the
  // free-trial onboarding flow" from "commercial state merely happens to be
  // missing" (an existing/grandfathered/legacy tenant). No production
  // writer of this marker exists yet (self-service commercial activation is
  // not live), so this precondition keeps automatic enrollment fully
  // dormant for every tenant in the codebase today -- exactly the intended,
  // reviewed behavior until a later, separately reviewed tenant-creation
  // path sets it explicitly at creation time.
  if (config.trialEligibility?.eligible !== true) return config

  // Not yet eligible: GBP OAuth connection + first successful initial sync
  // together are represented by exactly one already-established signal --
  // tenant_config.status === 'active' (see this file's header). Never
  // inferred from OAuth completion alone, a frontend callback, or any
  // client-supplied timestamp.
  if (config.status !== 'active') return config

  // CORRECTION #2: the authoritative trial-clock anchor. Fail closed (no
  // start) if it is somehow absent on an 'active' tenant -- this function
  // never falls back to Date.now(), the claim's reservedAt, or any other
  // approximation. See this file's header for why this field is provably
  // write-once and immutable.
  const authoritativeActivationAt = config.initialSync?.completedAt
  if (typeof authoritativeActivationAt !== 'string' || !authoritativeActivationAt) {
    console.error(`[trialLifecycle] tenant ${JSON.stringify(tenantId)} is 'active' but has no initialSync.completedAt -- refusing to start a trial without an authoritative clock anchor`)
    return config
  }

  const eligibleLocation = selectTrialEligibleLocation(config.approvedLocations)
  if (!eligibleLocation || typeof eligibleLocation.googleLocationId !== 'string' || !eligibleLocation.googleLocationId) {
    // Fail closed / no start -- an active tenant with no valid canonical
    // GBP location identity to key a claim on. Should not happen in
    // practice (activation implies at least one approved location), but
    // this function never guesses or synthesizes an identity.
    return config
  }
  const gbpLocationKey = eligibleLocation.googleLocationId

  let reservation
  try {
    const identityKey = await bestEffortOwnerCommercialIdentityKey(tenantId)
    reservation = await reserveTrialClaim(gbpLocationKey, tenantId, { commercialIdentityKey: identityKey, claimType: 'trial_consumed' })
  } catch (err) {
    if (err instanceof TrialEligibilityStoreUnavailableError) {
      console.error(`[trialLifecycle] eligibility store unavailable for tenant ${JSON.stringify(tenantId)} -- deferring trial-start attempt: ${err.message}`)
      return config
    }
    throw err
  }

  if (!reservation.ok) {
    console.log(`[trialLifecycle] tenant ${JSON.stringify(tenantId)} denied a normal trial -- GBP location already claimed by another tenant`)
    return config
  }

  // trialStartedAt is ALWAYS tenant_config.initialSync.completedAt -- the
  // authoritative, server-written, write-once timestamp of this tenant's
  // FIRST successful initial sync (see this file's header) -- NEVER
  // reservation.reservedAt (which only reflects when THIS particular
  // observation happened to run) and never Date.now(). Because this value
  // is a pure function of already-immutable tenant_config state, every
  // retry -- whether from a tenant_config CAS conflict below, a delayed
  // tenantStatus() poll, or a claim-reservation idempotent replay --
  // recomputes the EXACT SAME trialStartedAt/trialEndsAt. No retry-tracking
  // state is needed to guarantee this: it falls out of the computation
  // being deterministic in its (immutable) input.
  const trialStartedAt = authoritativeActivationAt
  const trialEndsAt = new Date(Date.parse(trialStartedAt) + TRIAL_DURATION_MS).toISOString()

  const newCommercial = {
    commercialStatus: 'trial',
    plan: 'growth',
    planSource: 'trial_auto_gbp',
    trial: { status: 'active', startedAt: trialStartedAt, endsAt: trialEndsAt, consumedAt: trialStartedAt },
    limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
    accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null,
    createdAt: trialStartedAt, updatedAt: new Date().toISOString(),
  }

  let updatedConfig
  try {
    updatedConfig = await upsertTenantConfig(tenantId, { commercial: newCommercial }, { expectedVersion: config.configVersion })
  } catch (err) {
    if (err instanceof ConfigVersionConflictError) {
      // Do NOT finalize the claim -- it remains 'reserved', still owned by
      // this SAME tenant. The next observation (the next tenantStatus()
      // poll) re-reads fresh config, sees commercial is STILL null, and
      // retries: the claim reservation is itself idempotent (same
      // claimToken returned, never a new one), and trialStartedAt is
      // recomputed from the SAME immutable initialSync.completedAt either
      // way -- so the retry produces an IDENTICAL commercial.trial object,
      // never a later/extended one. "Do not burn the trial on a CAS
      // failure" is satisfied by construction, with no separate
      // retry-tracking state needed.
      console.log(`[trialLifecycle] tenant ${JSON.stringify(tenantId)} trial-start CAS conflict -- will retry on next observation`)
      return config
    }
    if (err instanceof TenantConfigStoreUnavailableError) {
      console.error(`[trialLifecycle] tenant config store unavailable during trial-start for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
      return config
    }
    throw err
  }

  // Best-effort finalize -- a failure here has no security consequence: a
  // claim left 'reserved' by its own rightful tenant already fully blocks
  // every other tenant from this GBP location, identically to 'consumed'
  // (see trialEligibilityStore.js's own header). Never retried from here;
  // this tenant will never revisit this branch again since commercial is
  // no longer null.
  try {
    await finalizeTrialClaim(gbpLocationKey, tenantId, reservation.claimToken)
  } catch (err) {
    console.error(`[trialLifecycle] failed to finalize trial claim for tenant ${JSON.stringify(tenantId)} (non-fatal, trial already started): ${err.message}`)
  }

  return updatedConfig
}
