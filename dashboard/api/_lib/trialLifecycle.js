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
// FINAL TRIAL-INTEGRITY CORRECTION #1 (superseded/hardened by the B.11
// pre-commit correction below) -- commercial === null is NEVER, by itself,
// sufficient grounds for automatic trial enrollment. B.2 deliberately made
// commercial === null mean "legacy compatibility" while
// COMMERCIAL_ENFORCEMENT_CUTOFF is disabled, and for grandfathered
// pre-cutoff tenants once it is armed -- an EXISTING REDIS_ONLY tenant with
// no commercial record must never be silently upgraded into a 7-day trial
// merely because tenantStatus() happens to be read.
//
// B.11 PRE-COMMIT CORRECTION -- commercial === null is now not merely
// insufficient but structurally IMPOSSIBLE as the automatic-trial entry
// condition: real self-service tenant creation
// (session/[action].js's finalizeRegistration()) never leaves `commercial`
// null even transiently -- it always writes the explicit,
// resolver-recognized `trial_pending_activation` status (the same shape
// B.8 already proved safe for access-code trials) atomically alongside the
// trialEligibility marker below, via selfServiceCommercial.js. This closes
// the exact hole a naive `commercial: null` + `trialEligibility: true`
// self-service tenant would otherwise open: while
// COMMERCIAL_ENFORCEMENT_CUTOFF stays disabled, `commercial === null`
// resolves as fully-unrestricted LEGACY_UNMANAGED (entitlementResolution.js),
// which would have given a brand-new, real, paid-card-backed tenant
// unrestricted access for the entire window before its first sync. This
// module therefore requires a SEPARATE, explicit, server-controlled
// marker -- tenant_config.trialEligibility = { eligible: true, markedAt,
// source } -- distinguishing "this tenant is intentionally entering the
// self-service free-trial onboarding flow" from "commercial state is
// merely missing." This marker:
//   - defaults to absent/not-eligible for every existing tenant (backward
//     compatible -- the ONLY production writer is finalizeRegistration(),
//     which always pairs it with trial_pending_activation in the same
//     atomic write);
//   - is never read from a request (see TRIAL_ELIGIBILITY_SOURCES below --
//     only a small enumerated set of SERVER-SIDE provenance values is ever
//     legal, mirroring tenantConfigStore.js's own TENANT_CREATION_SOURCES
//     pattern);
//   - is checked IN ADDITION TO, never instead of, the explicit
//     trial_pending_activation / status === 'active' preconditions below.
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
import { isSelfServicePlan } from './stripePriceMap.js'
import { appendAuditEntry } from './auditLog.js'

// Phase B.13 -- the ONE enumerated, reviewable set of automatic
// billing-failure suspension reasons this codebase will ever write.
// Mirrors TRIAL_ELIGIBILITY_SOURCES/TENANT_CREATION_SOURCES's own
// discipline: "how did this happen" stays a small, reviewed set of real
// answers, never an arbitrary string. Exactly one value exists in B.13 --
// a future manual/admin/fraud suspension reason would be a SEPARATE,
// explicitly-reviewed addition, never silently auto-resumable by
// activatePaidSubscriptionIfValid() below (see that function's own guard).
export const SUSPENSION_REASONS = Object.freeze(['stripe_unpaid_terminal'])

// Phase B.11 pre-commit correction -- exported so selfServiceCommercial.js's
// consent-snapshot fields (session/[action].js's selectPlan()) can never
// drift from the SAME number this file's own trial-duration math uses.
export const SELF_SERVICE_TRIAL_DAYS = 7
const TRIAL_DURATION_MS = SELF_SERVICE_TRIAL_DAYS * 24 * 60 * 60 * 1000

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

  // Phase B.11 pre-commit correction (Part 2/3) -- commercial === null is
  // NEVER, by itself, sufficient OR even a valid entry condition for the
  // automatic self-service trial anymore. Self-service tenant creation
  // (session/[action].js's finalizeRegistration(), via
  // selfServiceCommercial.js's buildSelfServicePendingActivationCommercial())
  // now ALWAYS writes the explicit, resolver-recognized
  // `trial_pending_activation` commercial status atomically alongside the
  // trialEligibility marker below -- it never leaves `commercial: null`
  // even transiently. This mirrors maybeStartAccessCodeTrial()'s own
  // structure exactly: the two pending-activation provenances
  // (self-service vs. access-code) share the SAME `trial_pending_activation`
  // commercialStatus value but are mutually exclusive by construction,
  // disambiguated below by the presence/absence of `accessCodeGrant` --
  // each transitions out via its own dedicated function only. A tenant
  // whose trial has already started/expired/converted, or any other real
  // commercial decision, is excluded by the same status check (once
  // consumed, this function never revisits it -- "once consumed, never
  // again" falls out of the precondition itself, no separate flag needed).
  if (config.commercial?.commercialStatus !== 'trial_pending_activation') return config

  // An access-code trial GRANT (accessCodeGrant, written at tenant-creation
  // time, pending its own lazy activation via maybeStartAccessCodeTrial()
  // below) must independently and durably exclude the automatic
  // self-service trial -- the two pending-activation provenances are
  // mutually exclusive, and this is deliberately a SEPARATE, explicit
  // check (never relying solely on "no self-service trialEligibility
  // marker," which the guard below already checks, for defense in depth).
  if (config.accessCodeGrant != null) return config

  // A pending-activation commercialStatus is NECESSARY but never
  // SUFFICIENT by itself -- an explicit,
  // server-controlled trialEligibility marker is REQUIRED too, mirroring
  // the discipline this precondition has always had (originally checked
  // against `commercial === null`, now checked against the explicit
  // pending-activation status instead -- see the correction above). No
  // production writer of trial_pending_activation + trialEligibility
  // together exists yet other than finalizeRegistration()'s own
  // self-service path (which always writes both in the same atomic
  // tenant-creation write), so this stays a precise, narrow gate rather
  // than a broad one.
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

// Phase B.8 -- the lazy activation counterpart to maybeStartTrial(), for an
// EXPLICIT access-code trial grant (accessCodeCommercial.js's
// buildAccessCodeCommercialWrite() Case 2) instead of the automatic
// self-service one. Called from the exact same read-time hook
// (session/[action].js's tenantStatus(), immediately after maybeStartTrial()
// -- the two are mutually exclusive by construction: a tenant only ever has
// EITHER trialEligibility ELSE accessCodeGrant set, never both) so this is
// just as naturally recurring and client-trigger-free as the automatic
// trial's own activation.
//
// DELIBERATELY DOES NOT touch trialEligibilityStore.js's per-GBP-location
// claim ledger at all -- that system exists to stop the SAME physical
// location from harvesting multiple free self-service trials across
// different signups, an anti-abuse concern that does not apply to an
// explicit, human-authorized sales/admin grant. This is this phase's
// approved policy (an access-code trial is independent of the automatic
// free-trial anti-abuse claim, but its provenance stays auditable via
// accessCodeGrant.accessCodeHash carrying through into the final
// commercial.accessCodeHash) -- never invented casually; see this file's
// own accessCodeCommercial.js header for the full reasoning.
export async function maybeStartAccessCodeTrial(tenantId, config) {
  if (!config) return config

  // No LTA/BOOTSTRAP read or write, ever -- identical discipline to
  // maybeStartTrial() above.
  if (locationCatalogModeFor(tenantId) === LocationCatalogMigrationMode.BOOTSTRAP) return config

  // Only a tenant sitting in the explicit 'trial_pending_activation'
  // commercial shape (Phase B.8 pre-commit correction -- see
  // accessCodeCommercial.js's header for why this is never `commercial ===
  // null`), with its accompanying grant, is eligible. Any OTHER commercial
  // state (already a real trial, active, suspended, anything) is never
  // touched again -- mirrors "once consumed, never again" exactly, and this
  // status is the ONLY one this function ever transitions out of.
  if (config.commercial?.commercialStatus !== 'trial_pending_activation') return config
  if (config.accessCodeGrant?.grantType !== 'trial') return config

  // Same authoritative-anchor requirement as the automatic trial: GBP OAuth
  // connection + first successful initial sync, represented by
  // tenant_config.status === 'active', never inferred from anything else.
  if (config.status !== 'active') return config

  const authoritativeActivationAt = config.initialSync?.completedAt
  if (typeof authoritativeActivationAt !== 'string' || !authoritativeActivationAt) {
    console.error(`[trialLifecycle] tenant ${JSON.stringify(tenantId)} is 'active' with a pending access-code trial grant but has no initialSync.completedAt -- refusing to start without an authoritative clock anchor`)
    return config
  }

  const grant = config.accessCodeGrant
  const trialStartedAt = authoritativeActivationAt
  const trialEndsAt = new Date(Date.parse(trialStartedAt) + grant.trialDays * 24 * 60 * 60 * 1000).toISOString()

  const newCommercial = {
    commercialStatus: 'trial',
    plan: grant.plan,
    planSource: 'access_code_trial',
    trial: { status: 'active', startedAt: trialStartedAt, endsAt: trialEndsAt, consumedAt: trialStartedAt },
    limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
    accessCodeHash: grant.accessCodeHash,
    discountPercent: grant.discountPercent, discountFixedCents: grant.discountFixedCents,
    paymentRequired: false,
    createdAt: trialStartedAt, updatedAt: new Date().toISOString(),
  }

  try {
    // CAS-bound to the SAME config this function was handed -- a
    // concurrent write (another observation racing this same tenant) fails
    // closed via ConfigVersionConflictError, retried on the next
    // tenantStatus() poll exactly like maybeStartTrial()'s own CAS write.
    // trialStartedAt/trialEndsAt are a pure function of immutable inputs
    // (grant.trialDays, initialSync.completedAt), so a retry recomputes the
    // identical object -- never a later/extended one.
    return await upsertTenantConfig(tenantId, { commercial: newCommercial }, { expectedVersion: config.configVersion })
  } catch (err) {
    if (err instanceof ConfigVersionConflictError) {
      console.log(`[trialLifecycle] tenant ${JSON.stringify(tenantId)} access-code trial-start CAS conflict -- will retry on next observation`)
      return config
    }
    if (err instanceof TenantConfigStoreUnavailableError) {
      console.error(`[trialLifecycle] tenant config store unavailable during access-code trial-start for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
      return config
    }
    throw err
  }
}

// Phase B.12 -- the ONE place tenant_config.commercial ever transitions from
// the completed-trial state into the existing, already-resolver-recognized
// canonical PAID-ACTIVE state (commercialStatus: 'active') -- mirrors
// maybeStartTrial()/maybeStartAccessCodeTrial()'s exact discipline (a
// server-controlled, idempotent, CAS-protected write against an
// ALREADY-LOADED config, never re-read independently here) and reuses
// COMMERCIAL_STATUSES's existing 'active' value and PLAN_ENTITLEMENTS'
// existing Core/Growth/Enterprise resolution -- there is deliberately NO
// separate/parallel "paid" schema anywhere in this codebase.
//
// AUTHORITY AND CALLER CONTRACT: this function trusts its OWN two
// arguments completely -- `plan` MUST already be a value the caller
// independently derived from SERVER billing state (stripePriceMap.js's
// resolvePlanIdForStripePriceId() against the tenant's OWN billing:v1
// record, itself resolved via the Stripe subscription reverse index --
// never from Stripe object metadata alone). This function does not
// re-validate the caller's provenance for that value beyond the one
// structural guard below (isSelfServicePlan) -- the caller (session/
// [action].js's handleSubscriptionProjectionEvent()) is responsible for
// every customer/price/subscription cross-check BEFORE calling this.
//
// ONE-DIRECTIONAL, "ONCE CONSUMED, NEVER AGAIN" -- Phase B.13 amendment:
// this now transitions OUT OF THREE states, never any other:
//   - 'trial'                                          -> genuine first activation (B.12, unchanged)
//   - 'past_due'                                       -> delinquency recovery (B.13)
//   - 'suspended' WITH suspension.reason === 'stripe_unpaid_terminal' -> billing-failure recovery (B.13)
// A tenant already 'active' (duplicate/redelivered event, a second
// observation racing this same one) is a pure, harmless no-op. Every OTHER
// existing state (canceled, trial_pending_activation, or 'suspended' for
// any OTHER reason -- there is exactly one reason value today, see
// SUSPENSION_REASONS, but this guard is written to stay correct if a
// future manual/admin/fraud reason is ever added) is left completely
// untouched -- this function is never a general-purpose "set
// commercialStatus" writer, only these specific, narrow transitions, and
// NEVER auto-resumes a suspension it did not itself create for this exact
// reason.
//
// NEVER creates or restarts a trial (there is no trial-shaped object
// written here at all -- the tenant's own historical `trial` sub-object is
// preserved via the spread below, purely as a record of when the trial
// that led here started/ended, never reinterpreted as a live trial once
// commercialStatus is 'active'), and NEVER grants Enterprise (Enterprise is
// excluded from isSelfServicePlan() by construction, mirroring
// stripePriceMap.js's own SELF_SERVICE_PLAN_IDS gate).
//
// PLAN NEVER CHANGES on the past_due/suspended recovery paths -- B.14's
// job, not this function's. `plan` is required and validated on every
// call (even for a past_due/suspended resume) as a defense-in-depth
// cross-check: the caller (session/[action].js's handleSubscriptionProjectionEvent())
// already resolved it from the tenant's OWN current Stripe price via
// stripePriceMap.js, so it MUST already equal the tenant's existing
// commercial.plan on a recovery path -- a mismatch (e.g. Stripe reporting
// a different price than what PRYOR has on record) is treated as an
// anomaly and refused, never silently absorbed as an implicit plan change.
export async function activatePaidSubscriptionIfValid(tenantId, plan) {
  if (locationCatalogModeFor(tenantId) === LocationCatalogMigrationMode.BOOTSTRAP) return null

  let config
  try {
    config = await getTenantConfig(tenantId)
  } catch (err) {
    if (err instanceof TenantConfigStoreUnavailableError) {
      console.error(`[trialLifecycle] tenant config store unavailable during paid-active activation for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
      return null
    }
    throw err
  }
  if (!config) return null

  const existingCommercial = config.commercial
  const currentStatus = existingCommercial?.commercialStatus
  const isFromTrial = currentStatus === 'trial'
  const isFromPastDue = currentStatus === 'past_due'
  const isFromBillingSuspension = currentStatus === 'suspended' && SUSPENSION_REASONS.includes(existingCommercial?.suspension?.reason) && existingCommercial?.suspension?.reason === 'stripe_unpaid_terminal'
  if (!isFromTrial && !isFromPastDue && !isFromBillingSuspension) return config

  // Defense in depth -- the caller must already have validated `plan`
  // against real server billing state before ever calling this, but this
  // function never trusts that alone: Enterprise (or any other
  // non-self-service value) can never be applied here either way.
  if (!isSelfServicePlan(plan)) {
    console.error(`[trialLifecycle] refusing paid-active activation for tenant ${JSON.stringify(tenantId)} -- plan ${JSON.stringify(plan)} is not a self-service plan`)
    return config
  }

  // Recovery paths (past_due/suspended) must never silently change plan --
  // B.14's future job, not this one. A mismatch here means the incoming
  // validated Stripe price does not match what this tenant is already on
  // record for; refuse rather than guess.
  if ((isFromPastDue || isFromBillingSuspension) && plan !== existingCommercial.plan) {
    console.error(`[trialLifecycle] refusing recovery activation for tenant ${JSON.stringify(tenantId)} -- incoming plan ${JSON.stringify(plan)} does not match existing commercial.plan ${JSON.stringify(existingCommercial.plan)}`)
    return config
  }

  const now = new Date().toISOString()
  // Fields explicitly changed by this transition: commercialStatus (->
  // 'active'), plan/planSource (ONLY set on the trial-activation path --
  // left completely unchanged on a past_due/suspended recovery, per the
  // guard above), suspension (cleared to null ONLY on the billing-suspension
  // recovery path), updatedAt. Every other field -- including `trial`
  // itself (kept as a historical record only), limitsOverride,
  // cancellation, overLimit, accessCodeHash, discountPercent,
  // discountFixedCents, paymentRequired, createdAt -- is carried forward
  // completely unchanged via this spread, never reset, never reinterpreted.
  const newCommercial = {
    ...existingCommercial,
    commercialStatus: 'active',
    plan: isFromTrial ? plan : existingCommercial.plan,
    planSource: isFromTrial ? 'stripe_subscription_active' : existingCommercial.planSource,
    suspension: isFromBillingSuspension ? null : existingCommercial.suspension,
    updatedAt: now,
  }

  let updated
  try {
    updated = await upsertTenantConfig(tenantId, { commercial: newCommercial }, { expectedVersion: config.configVersion })
  } catch (err) {
    if (err instanceof ConfigVersionConflictError) {
      // Something else already changed this tenant's commercial state
      // underneath this attempt (another concurrent webhook delivery, a
      // support action, etc.) -- never retried blindly here; the next
      // delivery/observation re-evaluates fresh state on its own.
      console.log(`[trialLifecycle] tenant ${JSON.stringify(tenantId)} paid-active activation CAS conflict -- leaving current state as-is`)
      return config
    }
    if (err instanceof TenantConfigStoreUnavailableError) {
      console.error(`[trialLifecycle] tenant config store unavailable while activating paid-active state for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
      return config
    }
    throw err
  }

  if (isFromBillingSuspension) {
    try {
      await appendAuditEntry(tenantId, {
        actorId: null, actorEmail: null,
        action: 'tenant.billing_suspension_resumed', entity: 'tenant', entityId: tenantId,
        result: 'success', message: 'Stripe reported a validated active subscription -- resumed from stripe_unpaid_terminal suspension.',
      })
    } catch (err) {
      console.error(`[trialLifecycle] failed to record audit entry for billing-suspension resume of tenant ${JSON.stringify(tenantId)} (non-fatal): ${err.message}`)
    }
  }

  return updated
}

// Phase B.13 -- the ONE place tenant_config.commercial ever transitions
// INTO the delinquency-grace state (commercialStatus: 'past_due'). Mirrors
// activatePaidSubscriptionIfValid()'s exact discipline. Per the locked
// B.13 policy (entitlementResolution.js's own B.7 `isPastDue` branch,
// unchanged): past_due retains FULL plan limits/features -- this function
// never touches limits/features itself, it only flips the status the
// resolver already knows how to interpret correctly.
//
// FROM {'trial', 'active'} ONLY -> 'past_due'. Idempotent no-op if already
// 'past_due' (a duplicate/redelivered/later past_due event for the SAME
// ongoing episode) -- the caller (session/[action].js) is responsible for
// deriving/preserving billing:v1.pastDueSince separately; this function
// touches ONLY tenant_config.commercial, never billing:v1.
export async function recordPastDueIfValid(tenantId) {
  if (locationCatalogModeFor(tenantId) === LocationCatalogMigrationMode.BOOTSTRAP) return null

  let config
  try {
    config = await getTenantConfig(tenantId)
  } catch (err) {
    if (err instanceof TenantConfigStoreUnavailableError) {
      console.error(`[trialLifecycle] tenant config store unavailable while recording past_due for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
      return null
    }
    throw err
  }
  if (!config) return null

  const existingCommercial = config.commercial
  const currentStatus = existingCommercial?.commercialStatus
  if (currentStatus !== 'trial' && currentStatus !== 'active') return config

  const now = new Date().toISOString()
  const newCommercial = { ...existingCommercial, commercialStatus: 'past_due', updatedAt: now }

  try {
    return await upsertTenantConfig(tenantId, { commercial: newCommercial }, { expectedVersion: config.configVersion })
  } catch (err) {
    if (err instanceof ConfigVersionConflictError) {
      console.log(`[trialLifecycle] tenant ${JSON.stringify(tenantId)} past_due recording CAS conflict -- leaving current state as-is`)
      return config
    }
    if (err instanceof TenantConfigStoreUnavailableError) {
      console.error(`[trialLifecycle] tenant config store unavailable while recording past_due for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
      return config
    }
    throw err
  }
}

// Phase B.13 -- the ONE automatic billing-failure suspension writer. FROM
// {'active', 'past_due'} ONLY -> 'suspended'. Deliberately NEVER from
// 'trial' -- an unpaid signal arriving while PRYOR still considers the
// tenant trialing is outside this function's scope; PRYOR's own
// independent trial-expiry computation (entitlementResolution.js's
// `trialExpired` check) already provides a completely separate safety net
// for that case. `suspendedAt` is REQUIRED and must be the caller's own
// Stripe `event.created` (converted to ISO) -- never Date.now() -- so the
// recorded timestamp reflects when STRIPE decided the subscription was
// terminal, not whenever this function happened to run.
export async function suspendForTerminalUnpaidIfValid(tenantId, { suspendedAt }) {
  if (locationCatalogModeFor(tenantId) === LocationCatalogMigrationMode.BOOTSTRAP) return null
  if (typeof suspendedAt !== 'string' || Number.isNaN(Date.parse(suspendedAt))) {
    throw new TypeError('suspendForTerminalUnpaidIfValid: suspendedAt must be a valid ISO timestamp')
  }

  let config
  try {
    config = await getTenantConfig(tenantId)
  } catch (err) {
    if (err instanceof TenantConfigStoreUnavailableError) {
      console.error(`[trialLifecycle] tenant config store unavailable while suspending tenant ${JSON.stringify(tenantId)}: ${err.message}`)
      return null
    }
    throw err
  }
  if (!config) return null

  const existingCommercial = config.commercial
  const currentStatus = existingCommercial?.commercialStatus
  // Idempotent no-op if already suspended for this SAME reason (duplicate/
  // redelivered event) -- never overwrites an existing suspendedAt.
  if (currentStatus === 'suspended') return config
  if (currentStatus !== 'active' && currentStatus !== 'past_due') return config

  const now = new Date().toISOString()
  const newCommercial = {
    ...existingCommercial,
    commercialStatus: 'suspended',
    suspension: { reason: 'stripe_unpaid_terminal', suspendedAt },
    updatedAt: now,
  }

  let updated
  try {
    updated = await upsertTenantConfig(tenantId, { commercial: newCommercial }, { expectedVersion: config.configVersion })
  } catch (err) {
    if (err instanceof ConfigVersionConflictError) {
      console.log(`[trialLifecycle] tenant ${JSON.stringify(tenantId)} suspension CAS conflict -- leaving current state as-is`)
      return config
    }
    if (err instanceof TenantConfigStoreUnavailableError) {
      console.error(`[trialLifecycle] tenant config store unavailable while suspending tenant ${JSON.stringify(tenantId)}: ${err.message}`)
      return config
    }
    throw err
  }

  try {
    await appendAuditEntry(tenantId, {
      actorId: null, actorEmail: null,
      action: 'tenant.suspended_billing', entity: 'tenant', entityId: tenantId,
      result: 'success', message: `Stripe reported the subscription as terminally unpaid -- suspended (reason: stripe_unpaid_terminal, suspendedAt: ${suspendedAt}).`,
    })
  } catch (err) {
    console.error(`[trialLifecycle] failed to record audit entry for suspension of tenant ${JSON.stringify(tenantId)} (non-fatal): ${err.message}`)
  }

  return updated
}

// Trial-cancellation patch (live-Preview-discovered edge case) -- Stripe
// does NOT represent a cancellation requested DURING an active trial the
// same way it represents an ordinary post-trial cancellation. The normal
// case sets `cancel_at_period_end: true` and leaves `cancel_at` alone; a
// mid-trial cancellation instead leaves `cancel_at_period_end: false` and
// sets an ABSOLUTE `cancel_at` aligned exactly to the subscription's own
// `trial_end` (confirmed against a live Stripe sandbox subscription and its
// own Portal UI copy, "Cancels <trial_end date>"). Treating
// `cancel_at_period_end === false` as "definitely not scheduled to cancel"
// is therefore wrong -- this narrow, pure, no-I/O helper recognizes BOTH
// representations so syncCancellationIntentIfValid() below has a single,
// uniform "is this subscription currently scheduled to end" signal to act
// on, regardless of which lifecycle stage (trial vs. paid) the
// cancellation was requested during.
//
// Deliberately narrow -- this is not a general Stripe-scheduling framework,
// just the two representations Stripe is documented/observed to actually
// use for "not yet canceled, but scheduled to end". Never trusts
// `cancellation_details` (informational/human-readable only, never
// structurally validated by Stripe) -- only raw `status`/`cancel_at`/
// `trial_end`/`ended_at`, exactly the fields the caller has already
// cross-validated belong to this tenant's own subscription.
export function getEffectiveScheduledCancellation(subscription) {
  if (subscription?.cancel_at_period_end === true) {
    const item = subscription?.items?.data?.[0]
    const periodEndEpoch = typeof subscription?.current_period_end === 'number'
      ? subscription.current_period_end
      : (typeof item?.current_period_end === 'number' ? item.current_period_end : null)
    if (typeof periodEndEpoch !== 'number') return null
    return { scheduled: true, effectiveAtEpoch: periodEndEpoch }
  }

  // Trial-end cancellation -- every one of these conditions is required;
  // this is intentionally strict rather than inferring intent from any
  // single field. `ended_at` must be absent/null -- an already-ended
  // subscription is never "scheduled" to end, it already has.
  if (
    subscription?.status === 'trialing' &&
    typeof subscription?.cancel_at === 'number' &&
    typeof subscription?.trial_end === 'number' &&
    subscription.cancel_at === subscription.trial_end &&
    subscription?.ended_at == null
  ) {
    return { scheduled: true, effectiveAtEpoch: subscription.cancel_at }
  }

  return null
}

// Phase B.13 -- cancellation-INTENT sync only. NEVER changes
// commercialStatus or limits/features -- the tenant keeps full access
// through the remainder of the current paid period (or trial, in the
// trial-cancellation case above) regardless of this field. Idempotent by
// construction: recomputes the exact same object on a redelivered/
// duplicate event (requestedAt is preserved, never reset, as long as the
// existing cancellation is already 'pending_at_period_end') and
// short-circuits to a no-op write when nothing actually changed.
//
// `scheduled`/`effectiveAt` are the caller's already-resolved output of
// getEffectiveScheduledCancellation() above (converted to ISO) -- this
// function itself stays representation-agnostic; the canonical
// `pending_at_period_end` status string is unchanged for either Stripe
// representation (trial-cancellation patch: deliberately not renamed).
export async function syncCancellationIntentIfValid(tenantId, { scheduled, effectiveAt, requestedAt }) {
  if (locationCatalogModeFor(tenantId) === LocationCatalogMigrationMode.BOOTSTRAP) return null

  let config
  try {
    config = await getTenantConfig(tenantId)
  } catch (err) {
    if (err instanceof TenantConfigStoreUnavailableError) {
      console.error(`[trialLifecycle] tenant config store unavailable while syncing cancellation intent for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
      return null
    }
    throw err
  }
  if (!config || !config.commercial) return config

  const existingCommercial = config.commercial
  const existingCancellation = existingCommercial.cancellation ?? null

  let newCancellation
  if (scheduled) {
    // Preserve the ORIGINAL requestedAt if a pending cancellation is
    // already recorded -- a redelivered/duplicate/later true event must
    // never reset it, mirroring pastDueSince's own stability requirement.
    const preservedRequestedAt = existingCancellation?.status === 'pending_at_period_end' ? existingCancellation.requestedAt : requestedAt
    newCancellation = { status: 'pending_at_period_end', requestedAt: preservedRequestedAt, effectiveAt }
  } else {
    newCancellation = null
  }

  if (JSON.stringify(existingCancellation) === JSON.stringify(newCancellation)) return config

  const now = new Date().toISOString()
  const newCommercial = { ...existingCommercial, cancellation: newCancellation, updatedAt: now }

  try {
    return await upsertTenantConfig(tenantId, { commercial: newCommercial }, { expectedVersion: config.configVersion })
  } catch (err) {
    if (err instanceof ConfigVersionConflictError) {
      console.log(`[trialLifecycle] tenant ${JSON.stringify(tenantId)} cancellation-intent sync CAS conflict -- leaving current state as-is`)
      return config
    }
    if (err instanceof TenantConfigStoreUnavailableError) {
      console.error(`[trialLifecycle] tenant config store unavailable while syncing cancellation intent for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
      return config
    }
    throw err
  }
}

// Phase B.13 -- the ONE place a subscription's ACTUAL completed
// cancellation (Stripe's customer.subscription.deleted, never a mere
// cancel_at_period_end toggle -- see syncCancellationIntentIfValid() above
// for that) transitions tenant_config.commercial into the terminal
// 'canceled' state. Preserves plan, trial history, and every billing
// identifier -- no destructive deletion of any kind. Idempotent: a
// tenant already 'canceled' is a pure no-op (duplicate/redelivered
// deletion event).
export async function completeCancellationIfValid(tenantId) {
  if (locationCatalogModeFor(tenantId) === LocationCatalogMigrationMode.BOOTSTRAP) return null

  let config
  try {
    config = await getTenantConfig(tenantId)
  } catch (err) {
    if (err instanceof TenantConfigStoreUnavailableError) {
      console.error(`[trialLifecycle] tenant config store unavailable while completing cancellation for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
      return null
    }
    throw err
  }
  if (!config) return null

  const existingCommercial = config.commercial
  if (!existingCommercial) return config
  const currentStatus = existingCommercial.commercialStatus
  if (currentStatus === 'canceled') return config

  const now = new Date().toISOString()
  const newCommercial = { ...existingCommercial, commercialStatus: 'canceled', cancellation: null, updatedAt: now }

  let updated
  try {
    updated = await upsertTenantConfig(tenantId, { commercial: newCommercial }, { expectedVersion: config.configVersion })
  } catch (err) {
    if (err instanceof ConfigVersionConflictError) {
      console.log(`[trialLifecycle] tenant ${JSON.stringify(tenantId)} cancellation-completion CAS conflict -- leaving current state as-is`)
      return config
    }
    if (err instanceof TenantConfigStoreUnavailableError) {
      console.error(`[trialLifecycle] tenant config store unavailable while completing cancellation for tenant ${JSON.stringify(tenantId)}: ${err.message}`)
      return config
    }
    throw err
  }

  try {
    await appendAuditEntry(tenantId, {
      actorId: null, actorEmail: null,
      action: 'tenant.subscription_canceled', entity: 'tenant', entityId: tenantId,
      result: 'success', message: 'Stripe confirmed the subscription was deleted -- tenant commercial state transitioned to canceled. No data was deleted.',
    })
  } catch (err) {
    console.error(`[trialLifecycle] failed to record audit entry for cancellation of tenant ${JSON.stringify(tenantId)} (non-fatal): ${err.message}`)
  }

  return updated
}
