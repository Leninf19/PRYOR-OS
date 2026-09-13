// Phase B.2 -- Commercial Entitlement Foundation: regression tests for the
// ONE authoritative resolver, dashboard/api/_lib/entitlements.js, and its
// plan/feature/limit table, dashboard/api/_lib/planEntitlements.js.
//
// PLUMBING ONLY: nothing here exercises any live endpoint's enforcement
// (there isn't any yet) -- every test calls resolveTenantEntitlements()
// directly against a fake tenant_config store, matching every other
// tenant-config test file's established convention (fakeHashRedis + this
// module's own _setRedisClientForTests/_resetRedisClientForTests seam).
//
// Run directly: node tests/test_entitlements.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  resolveTenantEntitlements, isNewShapeCommercial, isOldShapeCommercial,
  COMMERCIAL_STATUSES, RESOLUTION_FAILURE_STATUSES, LEGACY_UNMANAGED_PLAN,
  COMMERCIAL_ENFORCEMENT_CUTOFF,
  _setCommercialEnforcementCutoffForTests, _resetCommercialEnforcementCutoffForTests,
} from '../dashboard/api/_lib/entitlements.js'
import {
  PLAN_ENTITLEMENTS, TRIAL_ENTITLEMENTS, PLATFORM_SAFETY_CEILING, isValidPlanId,
} from '../dashboard/api/_lib/planEntitlements.js'
import {
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
async function run(name, fn) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  } finally {
    resetConfigRedis()
    _resetCommercialEnforcementCutoffForTests()
  }
}

// Minimal fake, matching this codebase's established fakeHashRedis
// convention (test_tenant_entitlement_boundary.js etc.) -- entitlements.js
// only ever reads via getTenantConfig() -> client.hget(), never writes.
function fakeConfigRedis(recordsByTenantId) {
  return {
    hget: async (_key, tenantId) => {
      const record = recordsByTenantId[tenantId]
      return record ? JSON.stringify(record) : null
    },
  }
}

// A fixed, arbitrary test-only cutoff -- COMMERCIAL_ENFORCEMENT_CUTOFF
// itself is `null` (not yet activated) per Phase B.2's pre-commit
// correction, so tests that need to exercise the "cutoff IS activated"
// branch use _setCommercialEnforcementCutoffForTests(TEST_CUTOFF) rather
// than deriving anything from the (disabled) real constant. Every OTHER
// test's createdAt below is simply "recent" -- irrelevant while the real
// cutoff is disabled by default.
const TEST_CUTOFF = '2026-06-01T00:00:00.000Z'
const BEFORE_CUTOFF = new Date(Date.parse(TEST_CUTOFF) - 7 * 24 * 60 * 60 * 1000).toISOString()
const AFTER_CUTOFF = new Date(Date.parse(TEST_CUTOFF) + 7 * 24 * 60 * 60 * 1000).toISOString()

function baseConfig(overrides = {}) {
  return {
    tenantId: 't_test-tenant', displayName: 't_test-tenant', status: 'active',
    locationCatalogEnabled: true, approvedLocations: [], createdAt: AFTER_CUTOFF, updatedAt: AFTER_CUTOFF,
    configVersion: 1, commercial: null,
    ...overrides,
  }
}

function newShapeCommercial(overrides = {}) {
  return {
    commercialStatus: 'active', plan: 'growth', planSource: 'access_code',
    trial: null, limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
    accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null,
    createdAt: AFTER_CUTOFF, updatedAt: AFTER_CUTOFF,
    ...overrides,
  }
}

// --- Plan resolution ---------------------------------------------------------

async function testCorePlanResolves() {
  setConfigRedis(() => fakeConfigRedis({ 't_test-core': baseConfig({ tenantId: 't_test-core', commercial: newShapeCommercial({ plan: 'core' }) }) }))
  const e = await resolveTenantEntitlements('t_test-core')
  assert(e.plan === 'core' && e.effectivePlan === 'core', `expected core, got ${e.plan}`)
  assert(e.commercialStatus === 'active', e.commercialStatus)
  assert(e.limits.maxLocations === 1 && e.limits.maxActiveUsers === 3, JSON.stringify(e.limits))
  assert(e.limits.storageBytes === 500 * 1024 * 1024 && e.limits.assetCount === 500, JSON.stringify(e.limits))
  assert(e.features.advancedExecutiveBrief === false && e.features.advancedIntelligence === false, JSON.stringify(e.features))
  assert(e.features.reviews === true && e.features.aiRewrite === true && e.features.basicTasks === true, JSON.stringify(e.features))
}

async function testGrowthPlanResolves() {
  setConfigRedis(() => fakeConfigRedis({ 't_test-growth': baseConfig({ tenantId: 't_test-growth', commercial: newShapeCommercial({ plan: 'growth' }) }) }))
  const e = await resolveTenantEntitlements('t_test-growth')
  assert(e.plan === 'growth' && e.effectivePlan === 'growth', e.plan)
  assert(e.limits.maxLocations === 5 && e.limits.maxActiveUsers === 10, JSON.stringify(e.limits))
  assert(e.limits.storageBytes === 1024 * 1024 * 1024 && e.limits.assetCount === 1200, JSON.stringify(e.limits))
  assert(e.features.advancedExecutiveBrief === true && e.features.advancedIntelligence === true, JSON.stringify(e.features))
  assert(e.features.locationComparison === true && e.features.operationsImpact === true, JSON.stringify(e.features))
  assert(e.features.marketingIntelligence === true && e.features.advancedAutomation === true, JSON.stringify(e.features))
  assert(e.features.advancedReporting === true && e.features.managerWorkflow === true && e.features.priorityAlerts === true, JSON.stringify(e.features))
}

async function testEnterpriseOverrideApplied() {
  setConfigRedis(() => fakeConfigRedis({
    't_test-ent': baseConfig({ tenantId: 't_test-ent', commercial: newShapeCommercial({
      plan: 'enterprise', limitsOverride: { maxLocations: 9, maxActiveUsers: 25, storageBytes: 1.5 * 1024 * 1024 * 1024, assetCount: 1800 },
    }) }),
  }))
  const e = await resolveTenantEntitlements('t_test-ent')
  assert(e.plan === 'enterprise', e.plan)
  assert(e.limits.maxLocations === 9 && e.limits.maxActiveUsers === 25, JSON.stringify(e.limits))
  assert(e.limits.storageBytes === 1.5 * 1024 * 1024 * 1024 && e.limits.assetCount === 1800, JSON.stringify(e.limits))
  assert(e.features.managerWorkflow === true, 'Enterprise must include the Growth feature baseline')
}

async function testEnterpriseOverrideClampsToSafetyCeiling() {
  setConfigRedis(() => fakeConfigRedis({
    't_test-ent-over': baseConfig({ tenantId: 't_test-ent-over', commercial: newShapeCommercial({
      plan: 'enterprise', limitsOverride: { maxLocations: 50, maxActiveUsers: 200, storageBytes: 50 * 1024 * 1024 * 1024, assetCount: 999999 },
    }) }),
  }))
  const e = await resolveTenantEntitlements('t_test-ent-over')
  assert(e.limits.storageBytes === PLATFORM_SAFETY_CEILING.storageBytes, `expected clamp to ${PLATFORM_SAFETY_CEILING.storageBytes}, got ${e.limits.storageBytes}`)
  assert(e.limits.assetCount === PLATFORM_SAFETY_CEILING.assetCount, `expected clamp to ${PLATFORM_SAFETY_CEILING.assetCount}, got ${e.limits.assetCount}`)
  // maxLocations/maxActiveUsers are NOT clamped against a platform ceiling
  // (Phase A never defined one for those) -- only storage/asset-count have
  // a hard safety ceiling today.
  assert(e.limits.maxLocations === 50 && e.limits.maxActiveUsers === 200, JSON.stringify(e.limits))
}

// Phase B.2 pre-commit correction: there is NO reviewed administrative
// safety-override mechanism yet -- hardSafetyOverrideApproved must have NO
// EFFECT on resolver output in B.2, even when explicitly set true alongside
// a huge override. This replaces the earlier (pre-correction) test that
// proved the opposite.
async function testHardSafetyOverrideApprovedHasNoEffectInB2() {
  setConfigRedis(() => fakeConfigRedis({
    't_test-ent-approved': baseConfig({ tenantId: 't_test-ent-approved', commercial: newShapeCommercial({
      plan: 'enterprise', limitsOverride: { storageBytes: 50 * 1024 * 1024 * 1024, assetCount: 999999, hardSafetyOverrideApproved: true },
    }) }),
  }))
  const e = await resolveTenantEntitlements('t_test-ent-approved')
  assert(e.limits.storageBytes === PLATFORM_SAFETY_CEILING.storageBytes, `hardSafetyOverrideApproved:true must NOT bypass the clamp in B.2 -- expected ${PLATFORM_SAFETY_CEILING.storageBytes}, got ${e.limits.storageBytes}`)
  assert(e.limits.assetCount === PLATFORM_SAFETY_CEILING.assetCount, `hardSafetyOverrideApproved:true must NOT bypass the clamp in B.2 -- expected ${PLATFORM_SAFETY_CEILING.assetCount}, got ${e.limits.assetCount}`)
}

async function testTrialUsesGrowthFeaturesButTrialLimits() {
  setConfigRedis(() => fakeConfigRedis({
    't_test-trial': baseConfig({ tenantId: 't_test-trial', commercial: newShapeCommercial({
      commercialStatus: 'trial', plan: 'growth',
      trial: { status: 'active', startedAt: AFTER_CUTOFF, endsAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(), consumedAt: AFTER_CUTOFF },
    }) }),
  }))
  const e = await resolveTenantEntitlements('t_test-trial')
  assert(e.commercialStatus === 'trial', e.commercialStatus)
  assert(e.effectivePlan === 'growth', e.effectivePlan)
  assert(e.features.advancedIntelligence === true && e.features.advancedExecutiveBrief === true, 'trial must carry the Growth feature set')
  assert(e.limits.maxLocations === 1 && e.limits.maxActiveUsers === 3, `trial must use trial limits, not Growth's, got ${JSON.stringify(e.limits)}`)
  assert(e.limits.storageBytes === 250 * 1024 * 1024 && e.limits.assetCount === 250, JSON.stringify(e.limits))
  assert(e.trialStatus === 'active', e.trialStatus)
}

async function testExpiredTrialResolvesToSuspended() {
  setConfigRedis(() => fakeConfigRedis({
    't_test-trial-expired': baseConfig({ tenantId: 't_test-trial-expired', commercial: newShapeCommercial({
      commercialStatus: 'trial', plan: 'growth',
      trial: { status: 'active', startedAt: BEFORE_CUTOFF, endsAt: new Date(Date.now() - 1000).toISOString(), consumedAt: BEFORE_CUTOFF },
    }) }),
  }))
  const e = await resolveTenantEntitlements('t_test-trial-expired')
  assert(e.commercialStatus === 'suspended', `expired trial must resolve to suspended, got ${e.commercialStatus}`)
  assert(e.reason === 'trial_expired', e.reason)
  assert(e.plan === 'growth', 'plan must be preserved even though status collapsed to suspended')
  assert(Object.values(e.features).every(v => v === false), 'a suspended (expired trial) tenant must have every feature denied')
  assert(e.limits.maxLocations === 0 && e.limits.maxActiveUsers === 0, 'a suspended (expired trial) tenant must have zero limits, not null')
}

async function testSuspendedDeniesFeaturesAndZeroesLimits() {
  setConfigRedis(() => fakeConfigRedis({
    't_test-suspended': baseConfig({ tenantId: 't_test-suspended', commercial: newShapeCommercial({ commercialStatus: 'suspended', plan: 'growth' }) }),
  }))
  const e = await resolveTenantEntitlements('t_test-suspended')
  assert(e.commercialStatus === 'suspended', e.commercialStatus)
  assert(e.plan === 'growth', 'plan must still be reported so a suspended owner sees "Growth, suspended," not "no plan"')
  assert(Object.values(e.features).every(v => v === false), JSON.stringify(e.features))
  assert(Object.entries(e.limits).every(([k, v]) => k === 'aiAllowanceMonthly' ? v.usageUnits === 0 : v === 0), JSON.stringify(e.limits))
}

async function testCanceledDeniesFeaturesAndZeroesLimits() {
  setConfigRedis(() => fakeConfigRedis({
    't_test-canceled': baseConfig({ tenantId: 't_test-canceled', commercial: newShapeCommercial({
      commercialStatus: 'canceled', plan: 'core', cancellation: { canceledAt: AFTER_CUTOFF, retentionEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), reason: 'customer_request', actorId: 'usr_owner' },
    }) }),
  }))
  const e = await resolveTenantEntitlements('t_test-canceled')
  assert(e.commercialStatus === 'canceled', e.commercialStatus)
  assert(Object.values(e.features).every(v => v === false), JSON.stringify(e.features))
  assert(e.limits.maxLocations === 0, JSON.stringify(e.limits))
}

async function testPastDueDeniesFeaturesAndZeroesLimits() {
  // No production endpoint can ever WRITE past_due yet (no billing signal
  // exists) -- this proves the resolver still handles it correctly via
  // direct test-fixture store setup, per Phase B.2's explicit instruction
  // not to build an admin endpoint solely to simulate it.
  setConfigRedis(() => fakeConfigRedis({
    't_test-pastdue': baseConfig({ tenantId: 't_test-pastdue', commercial: newShapeCommercial({ commercialStatus: 'past_due', plan: 'growth' }) }),
  }))
  const e = await resolveTenantEntitlements('t_test-pastdue')
  assert(e.commercialStatus === 'past_due', e.commercialStatus)
  assert(Object.values(e.features).every(v => v === false), JSON.stringify(e.features))
  assert(e.limits.maxActiveUsers === 0, JSON.stringify(e.limits))
}

// --- Bootstrap / legacy / unconfigured differentiation -----------------------

async function testBootstrapLtaResolvesToLegacyUnmanaged() {
  // No fake store needed at all -- BOOTSTRAP mode never consults
  // tenant_config, exactly like tenants.js's own location-catalog checks.
  const e = await resolveTenantEntitlements(DEFAULT_TENANT_ID)
  assert(e.plan === LEGACY_UNMANAGED_PLAN && e.effectivePlan === LEGACY_UNMANAGED_PLAN, e.plan)
  assert(e.reason === 'bootstrap_legacy', e.reason)
  assert(e.commercialStatus === 'active', e.commercialStatus)
  assert(Object.values(e.features).every(v => v === true), 'LTA must retain its current fully-unrestricted feature access')
  assert(Object.values(e.limits).every(v => v === null || (typeof v === 'object' && v.usageUnits === null)), 'LTA limits must be unenforced (null), never a magic number')
}

// Phase B.2 pre-commit correction #1's own required proof, part 1: while
// the cutoff is NOT activated (the real, shipped default), a
// commercial === null tenant -- regardless of when it was created --
// resolves to legacy compatibility, not fail-closed. B.2 has no live
// commercial writer yet, so this is the correct, honest behavior for
// today: every existing and newly-created tenant keeps working exactly as
// it does now.
async function testCommercialNullResolvesToLegacyCompatibilityWhileCutoffDisabled() {
  assert(COMMERCIAL_ENFORCEMENT_CUTOFF === null, 'the shipped default MUST be the disabled sentinel -- Phase B.2 must not arm a real cutoff')
  setConfigRedis(() => fakeConfigRedis({
    't_test-new-tenant': baseConfig({ tenantId: 't_test-new-tenant', createdAt: AFTER_CUTOFF, commercial: null }),
  }))
  const e = await resolveTenantEntitlements('t_test-new-tenant')
  assert(e.plan === LEGACY_UNMANAGED_PLAN, `expected legacy compatibility while the cutoff is disabled, got plan=${e.plan}`)
  assert(e.reason === 'commercial_enforcement_not_activated', e.reason)
  assert(Object.values(e.features).every(v => v === true), 'a null-commercial tenant must keep full access while enforcement is not yet activated')
  assert(Object.values(e.limits).every(v => v === null || (typeof v === 'object' && v.usageUnits === null)), 'limits must be unenforced (null) while the cutoff is disabled, matching real-world unrestricted behavior today')
}

// Phase B.2 pre-commit correction #1's own required proof, part 2: once a
// LATER phase activates the cutoff, a pre-cutoff tenant is grandfathered...
async function testGrandfatheredPreCutoffTenantResolvesToLegacyUnmanagedOnceCutoffActivated() {
  _setCommercialEnforcementCutoffForTests(TEST_CUTOFF)
  setConfigRedis(() => fakeConfigRedis({
    't_test-grandfathered': baseConfig({ tenantId: 't_test-grandfathered', createdAt: BEFORE_CUTOFF, commercial: null }),
  }))
  const e = await resolveTenantEntitlements('t_test-grandfathered')
  assert(e.plan === LEGACY_UNMANAGED_PLAN, e.plan)
  assert(e.reason === 'grandfathered_pre_phase_b', e.reason)
  assert(Object.values(e.limits).every(v => v === null || (typeof v === 'object' && v.usageUnits === null)), JSON.stringify(e.limits))
}

// ...while a POST-cutoff tenant with the same commercial === null fails
// closed -- this is the actual fail-closed behavior Correction #1 protects,
// live only once a later phase deliberately arms the cutoff.
async function testPostCutoffTenantWithNullCommercialFailsClosedOnceCutoffActivated() {
  _setCommercialEnforcementCutoffForTests(TEST_CUTOFF)
  setConfigRedis(() => fakeConfigRedis({
    't_test-new-empty': baseConfig({ tenantId: 't_test-new-empty', createdAt: AFTER_CUTOFF, commercial: null }),
  }))
  const e = await resolveTenantEntitlements('t_test-new-empty')
  assert(RESOLUTION_FAILURE_STATUSES.includes(e.commercialStatus), `expected a resolution-failure status, got ${e.commercialStatus}`)
  assert(e.reason === 'commercial_unconfigured', e.reason)
  assert(e.plan !== LEGACY_UNMANAGED_PLAN, 'a post-cutoff tenant missing commercial state must NEVER be treated as legacy-unmanaged')
  assert(Object.values(e.features).every(v => v === false), 'a post-cutoff tenant missing commercial state must have every feature denied, never true')
  assert(e.limits.maxLocations === 0 && e.limits.storageBytes === 0, 'a post-cutoff tenant missing commercial state must have zero limits, never null/unlimited')
}

// CRITICAL RESOLVER CORRECTION #2's own required proof: an old-shape record
// with an EXPIRED trialEndsAt must never be inferred as an active paid sub.
async function testOldShapeCommercialNeverInfersActivePaid() {
  setConfigRedis(() => fakeConfigRedis({
    't_test-oldshape': baseConfig({ tenantId: 't_test-oldshape', createdAt: AFTER_CUTOFF, commercial: {
      plan: 'growth', source: 'access_code', accessCodeHash: 'deadbeef',
      trialEndsAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // long expired
    } }),
  }))
  const e = await resolveTenantEntitlements('t_test-oldshape')
  assert(e.reason === 'legacy_commercial_shape', `expected legacy_commercial_shape, got ${e.reason}`)
  assert(e.plan === LEGACY_UNMANAGED_PLAN, `an old-shape record must never resolve to a real paid plan id, got ${e.plan}`)
  assert(e.commercialStatus !== 'active' || e.plan === LEGACY_UNMANAGED_PLAN, 'must not be interpreted as a genuinely active paid Growth subscription')
}

async function testOldShapeDetectionHelpersAgree() {
  const oldShape = { plan: 'core', source: 'access_code', accessCodeHash: null, trialEndsAt: null }
  const newShape = { commercialStatus: 'active', plan: 'core' }
  assert(isOldShapeCommercial(oldShape) === true, 'must recognize the old 4-field shape')
  assert(isNewShapeCommercial(oldShape) === false, 'old shape must never be misidentified as new')
  assert(isNewShapeCommercial(newShape) === true, 'must recognize the new shape')
  assert(isOldShapeCommercial(newShape) === false, 'new shape must never be misidentified as old')
  assert(isOldShapeCommercial(null) === false && isNewShapeCommercial(null) === false, 'null must be neither shape')
}

// --- Fail-closed: store outage, missing record, malformed data --------------

async function testStoreOutageFailsClosed() {
  setConfigRedis(() => ({ hget: async () => { throw new Error('simulated Redis outage') } }))
  const e = await resolveTenantEntitlements('t_test-outage')
  assert(e.commercialStatus === 'unknown', `expected 'unknown' on a genuine store outage, got ${e.commercialStatus}`)
  assert(e.reason === 'resolution_failed', e.reason)
  assert(Object.values(e.features).every(v => v === false), 'a store outage must never grant any feature')
  assert(e.limits.maxLocations === 0, 'a store outage must never grant any quota')
}

async function testMissingTenantConfigRecordFailsClosed() {
  setConfigRedis(() => fakeConfigRedis({})) // no record for any tenantId
  const e = await resolveTenantEntitlements('t_test-does-not-exist')
  assert(e.reason === 'no_tenant_config', e.reason)
  assert(RESOLUTION_FAILURE_STATUSES.includes(e.commercialStatus), e.commercialStatus)
}

async function testMalformedCommercialStatusFailsClosed() {
  setConfigRedis(() => fakeConfigRedis({
    't_test-malformed-status': baseConfig({ tenantId: 't_test-malformed-status', commercial: newShapeCommercial({ commercialStatus: 'literally_not_a_status' }) }),
  }))
  const e = await resolveTenantEntitlements('t_test-malformed-status')
  assert(e.reason === 'malformed_commercial_state', e.reason)
  assert(Object.values(e.features).every(v => v === false), JSON.stringify(e.features))
}

async function testUnknownPlanFailsClosed() {
  setConfigRedis(() => fakeConfigRedis({
    't_test-badplan': baseConfig({ tenantId: 't_test-badplan', commercial: newShapeCommercial({ plan: 'super-ultra-plan' }) }),
  }))
  const e = await resolveTenantEntitlements('t_test-badplan')
  assert(e.reason === 'unknown_plan', e.reason)
  assert(e.plan === null, 'an unresolved bundle must never echo back an unrecognized plan id')
  assert(Object.values(e.features).every(v => v === false), JSON.stringify(e.features))
}

async function testMalformedCommercialObjectShapeFailsClosed() {
  setConfigRedis(() => fakeConfigRedis({
    't_test-malformed-obj': baseConfig({ tenantId: 't_test-malformed-obj', commercial: { commercialStatus: 42, plan: null } }),
  }))
  const e = await resolveTenantEntitlements('t_test-malformed-obj')
  assert(RESOLUTION_FAILURE_STATUSES.includes(e.commercialStatus), e.commercialStatus)
}

// --- Centralization / no-client-trust structural guards ----------------------

function listJsFilesRecursively(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...listJsFilesRecursively(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

async function testNoEndpointReimplementsPlanBranchingOutsideTheResolver() {
  const apiDir = path.join(REPO_ROOT, 'dashboard', 'api')
  const exemptFiles = new Set([
    path.join(apiDir, '_lib', 'entitlements.js'),
    path.join(apiDir, '_lib', 'planEntitlements.js'),
  ])
  const offenders = []
  for (const file of listJsFilesRecursively(apiDir)) {
    if (exemptFiles.has(file)) continue
    const source = readFileSync(file, 'utf8')
    if (/plan\s*===\s*['"](core|growth|enterprise)['"]/.test(source)) offenders.push(file)
  }
  assert(offenders.length === 0, `found endpoint(s) re-implementing plan branching outside the resolver/plan table: ${offenders.join(', ')}`)
}

async function testResolverSignatureAcceptsOnlyTenantId() {
  assert(resolveTenantEntitlements.length === 1, `resolveTenantEntitlements must take exactly one parameter (tenantId), got arity ${resolveTenantEntitlements.length} -- a second parameter would be a seam for a caller to inject an override`)
}

async function testNoProductionCallerPassesExtraArgumentsToTheResolver() {
  const apiDir = path.join(REPO_ROOT, 'dashboard', 'api')
  const offenders = []
  for (const file of listJsFilesRecursively(apiDir)) {
    const source = readFileSync(file, 'utf8')
    const matches = source.match(/resolveTenantEntitlements\(([^)]*)\)/g) || []
    for (const m of matches) {
      const argsInner = m.slice('resolveTenantEntitlements('.length, -1)
      if (argsInner.includes(',')) offenders.push(`${file}: ${m}`)
    }
  }
  assert(offenders.length === 0, `found a call site passing more than tenantId to the resolver: ${offenders.join(', ')}`)
}

async function testPlanTableIsTheSingleSourceForLimitsAndFeatures() {
  // Every plan entry must come from the SAME frozen table -- proves
  // resolveTenantEntitlements() cannot have a second, hand-duplicated
  // constant hiding inside it (a frozen object's reference equality is a
  // stronger guarantee than re-checking every field by hand).
  setConfigRedis(() => fakeConfigRedis({
    't_test-core-2': baseConfig({ tenantId: 't_test-core-2', commercial: newShapeCommercial({ plan: 'core' }) }),
  }))
  const e = await resolveTenantEntitlements('t_test-core-2')
  assert(e.features === PLAN_ENTITLEMENTS.core.features, 'features must be the exact frozen PLAN_ENTITLEMENTS.core.features reference, not a re-derived copy')
  assert(e.limits === PLAN_ENTITLEMENTS.core.limits, 'limits must be the exact frozen PLAN_ENTITLEMENTS.core.limits reference, not a re-derived copy')
}

async function testTrialPlanTableIsSingleSource() {
  setConfigRedis(() => fakeConfigRedis({
    't_test-trial-2': baseConfig({ tenantId: 't_test-trial-2', commercial: newShapeCommercial({
      commercialStatus: 'trial', plan: 'growth', trial: { status: 'active', startedAt: AFTER_CUTOFF, endsAt: new Date(Date.now() + 1000000).toISOString(), consumedAt: AFTER_CUTOFF },
    }) }),
  }))
  const e = await resolveTenantEntitlements('t_test-trial-2')
  assert(e.features === TRIAL_ENTITLEMENTS.features, 'trial features must be the exact frozen TRIAL_ENTITLEMENTS.features reference')
  assert(e.limits === TRIAL_ENTITLEMENTS.limits, 'trial limits must be the exact frozen TRIAL_ENTITLEMENTS.limits reference')
}

async function testPlanIdValidatorAgreesWithTable() {
  for (const id of ['core', 'growth', 'enterprise']) {
    assert(isValidPlanId(id), `${id} must be a valid plan id`)
    assert(PLAN_ENTITLEMENTS[id], `${id} must have a PLAN_ENTITLEMENTS entry`)
  }
  assert(isValidPlanId('bogus') === false, 'an unrecognized plan id must be rejected')
}

// --- Backward compatibility: real LTA behavior unchanged ---------------------

async function testRealLtaTenantIdResolvesUnchangedWithNoStoreConfigured() {
  // Deliberately NO _setRedisClientForTests call at all -- proves LTA's
  // resolution never even attempts a Redis read, exactly like
  // tenants.js's own BOOTSTRAP-mode guarantee (Redis contents, or a total
  // absence of Redis configuration, can never affect this tenant).
  const e = await resolveTenantEntitlements(DEFAULT_TENANT_ID)
  assert(e.reason === 'bootstrap_legacy', e.reason)
  assert(Object.values(e.features).every(v => v === true), 'LTA must remain fully unrestricted even with no store configured at all')
}

const tests = [
  ['Core plan resolves with the exact approved limits/features', testCorePlanResolves],
  ['Growth plan resolves with the exact approved limits/features', testGrowthPlanResolves],
  ['Enterprise applies a tenant-specific limitsOverride', testEnterpriseOverrideApplied],
  ['Enterprise overrides clamp to the Phase A hard safety ceiling', testEnterpriseOverrideClampsToSafetyCeiling],
  ['hardSafetyOverrideApproved has NO EFFECT on the clamp in B.2 (no reviewed override mechanism exists yet)', testHardSafetyOverrideApprovedHasNoEffectInB2],
  ['Trial bundle uses Growth features but trial-specific limits', testTrialUsesGrowthFeaturesButTrialLimits],
  ['An expired trial resolves to suspended with reason trial_expired', testExpiredTrialResolvesToSuspended],
  ['Suspended status denies every feature and zeroes every limit', testSuspendedDeniesFeaturesAndZeroesLimits],
  ['Canceled status denies every feature and zeroes every limit', testCanceledDeniesFeaturesAndZeroesLimits],
  ['past_due status denies every feature and zeroes every limit (fixture-only, no admin endpoint)', testPastDueDeniesFeaturesAndZeroesLimits],
  ['BOOTSTRAP LTA resolves to the legacy-unmanaged bundle, unenforced limits', testBootstrapLtaResolvesToLegacyUnmanaged],
  ['CORRECTION #1 (disabled cutoff): commercial=null resolves to legacy compatibility while enforcement is not yet activated', testCommercialNullResolvesToLegacyCompatibilityWhileCutoffDisabled],
  ['CORRECTION #1 (cutoff activated): a pre-cutoff tenant with commercial=null is grandfathered', testGrandfatheredPreCutoffTenantResolvesToLegacyUnmanagedOnceCutoffActivated],
  ['CORRECTION #1 (cutoff activated): a post-cutoff tenant with commercial=null fails closed, never unlimited', testPostCutoffTenantWithNullCommercialFailsClosedOnceCutoffActivated],
  ['CORRECTION #2: an old-shape record never infers an active paid subscription', testOldShapeCommercialNeverInfersActivePaid],
  ['old-shape vs new-shape detection helpers agree on both shapes and null', testOldShapeDetectionHelpersAgree],
  ['a genuine store outage fails closed (commercialStatus=unknown)', testStoreOutageFailsClosed],
  ['a definitively missing tenant_config record fails closed', testMissingTenantConfigRecordFailsClosed],
  ['a malformed commercialStatus value fails closed', testMalformedCommercialStatusFailsClosed],
  ['an unrecognized plan id fails closed', testUnknownPlanFailsClosed],
  ['a structurally malformed commercial object fails closed', testMalformedCommercialObjectShapeFailsClosed],
  ['no endpoint re-implements plan branching outside the resolver/plan table', testNoEndpointReimplementsPlanBranchingOutsideTheResolver],
  ['resolveTenantEntitlements only ever accepts tenantId (no override seam)', testResolverSignatureAcceptsOnlyTenantId],
  ['no production caller passes extra arguments to the resolver', testNoProductionCallerPassesExtraArgumentsToTheResolver],
  ['the plan table is the single source for limits/features (reference equality)', testPlanTableIsTheSingleSourceForLimitsAndFeatures],
  ['the trial table is the single source for limits/features (reference equality)', testTrialPlanTableIsSingleSource],
  ['isValidPlanId agrees exactly with PLAN_ENTITLEMENTS', testPlanIdValidatorAgreesWithTable],
  ['real LTA tenant id resolves unchanged even with no store configured at all', testRealLtaTenantIdResolvesUnchangedWithNoStoreConfigured],
]

async function main() {
  for (const [name, fn] of tests) await run(name, fn)
  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
