// Phase B.5 -- commercial feature gating. Regression tests for:
//   - dashboard/api/_lib/featureAuthorization.js (requireFeature() -- the
//     one centralized feature-decision helper)
//   - dashboard/api/executive-brief.js's advancedExecutiveBrief gate
//   - dashboard/api/data.js's PREMIUM_DATA_FEATURE_MAP gate
// Phase A/B.2/B.3/B.4 behavior (rate limits, input caps, AI quota, location/
// seat limits) is covered by its own existing test files and is not
// re-tested here except for the specific interactions this phase requires
// (feature check before AI quota/Anthropic; location auth independent of
// commercial auth).
//
// Run directly: node tests/test_commercial_feature_gating.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests'

import { readFileSync, readdirSync, statSync } from 'fs'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import bcrypt from 'bcryptjs'
import dataHandler, { _setMetaLocationsForTests, _resetMetaLocationsForTests } from '../dashboard/api/data.js'
import executiveBriefHandler from '../dashboard/api/executive-brief.js'
import {
  _setPrivateDataRootForTests, _resetPrivateDataRootsForTests,
} from '../dashboard/api/_lib/reviewDataPaths.js'
import {
  upsertTenantConfig,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import {
  upsertUser, UserCreationMode,
  _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis,
} from '../dashboard/api/_lib/userStore.js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { requireFeature } from '../dashboard/api/_lib/featureAuthorization.js'
import {
  _setRedisClientForTests as setUsageRedis, _resetRedisClientForTests as resetUsageRedis,
} from '../dashboard/api/_lib/aiUsageStore.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

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
    resetUserRedis()
    resetUsageRedis()
    _resetPrivateDataRootsForTests()
    _resetMetaLocationsForTests()
  }
}

// --- fakes (same shapes established across B.2-B.4) ----------------------

function fakeKeyedHashRedis() {
  const store = {}
  return {
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [field, expectedVersionStr, nextJson] = args
      const raw = store[key]?.[field] ?? null
      let currentVersion = '0'
      if (raw) {
        try { const decoded = JSON.parse(raw); if (decoded && decoded.configVersion !== undefined) currentVersion = String(decoded.configVersion) } catch { /* version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
  }
}

function installFakeConfigRedis() {
  const client = fakeKeyedHashRedis()
  setConfigRedis(() => client)
  return client
}
function installFakeUserRedis() {
  const client = fakeKeyedHashRedis()
  setUserRedis(() => client)
  return client
}

function newShapeCommercial(overrides = {}) {
  return {
    commercialStatus: 'active', plan: 'growth', planSource: 'access_code',
    trial: null, limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
    accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

let tenantCounter = 0
function freshTenantId() { return `t_feature-gate-${++tenantCounter}` }

// Seeds a genuine non-BOOTSTRAP tenant with a real Redis-backed Owner
// account and returns a signed session token for that Owner. userId/email
// are derived from tenantId (never a fixed 'usr_owner'/'owner@example.com')
// so seeding two different tenants in the same test never collides in the
// (email-keyed, cross-tenant) identity index.
async function seedTenant(tenantId, commercial) {
  await upsertTenantConfig(tenantId, { status: 'active', locationCatalogEnabled: true, commercial }, { allowCreate: true, creationSource: 'migration' })
  const userId = `usr_owner_${tenantId}`
  const email = `owner+${tenantId}@example.com`
  const record = {
    userId, email, passwordHash: await passwordHash(), role: 'owner',
    locationIds: '*', tenantId, sessionVersion: 1, disabled: false, displayName: 'Owner',
  }
  await upsertUser(tenantId, record, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  return signSession({ userId, email, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
}

function installFakeUsageRedis() {
  const client = fakeKeyedHashRedis()
  setUsageRedis(() => client)
  return client
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.send = (str) => { res.body = str; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

async function invokeData(fileParam, token, extra = {}) {
  const resolvedToken = await token
  const req = {
    method: 'GET',
    query: { file: fileParam, ...(extra.query ?? {}) },
    headers: resolvedToken ? { cookie: `lta_session=${resolvedToken}` } : {},
  }
  const res = fakeRes()
  await dataHandler(req, res)
  return res
}

async function postExecutiveBrief(token, body = { totalReviews: 5 }) {
  const resolvedToken = await token
  const res = fakeRes()
  await executiveBriefHandler({ method: 'POST', body, headers: { cookie: `${SESSION_COOKIE}=${resolvedToken}` } }, res)
  return res
}

function installSuccessFetch() {
  let calls = 0
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ content: [{ text: 'A generated briefing.' }], usage: { input_tokens: 100, output_tokens: 50 } }) } }
  return () => calls
}
function installNeverCalledFetch() {
  globalThis.fetch = async (url) => { throw new Error(`Anthropic must not be called, but fetch was invoked for: ${url}`) }
}

function makeTenantDir(prefix) { return mkdtempSync(path.join(tmpdir(), prefix)) }
function writeJson(root, relPath, data) {
  const full = path.join(root, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, JSON.stringify(data))
}

// Seeds a full set of private-data fixtures (both premium-gated and
// Core-required files) for a tenant, so every scenario in this file can
// share one fixture layout.
function seedPrivateData(tenantId) {
  const root = makeTenantDir('feature-gate-tenant-')
  writeJson(root, 'meta.json', { locations: [], totalReviews: 42 })
  writeJson(root, 'action-items.json', { items: [] })
  writeJson(root, 'analytics/kpis.json', { ok: true })
  writeJson(root, 'intelligence/company-summary.json', { summary: 'static summary' })
  writeJson(root, 'intelligence/complaint-intelligence.json', { ok: true })
  writeJson(root, 'intelligence/competitive-intelligence.json', { alerts: [] })
  writeJson(root, 'intelligence/predictive-alerts.json', { ok: true })
  writeJson(root, 'intelligence/response-drafts.json', { ok: true })
  writeJson(root, 'intelligence/operations-impact.json', { needsAttention: null })
  writeJson(root, 'intelligence/department-performance.json', { ok: true })
  writeJson(root, 'intelligence/best-quotes.json', { ok: true })
  writeJson(root, 'intelligence/seasonal-trends.json', { ok: true })
  writeJson(root, 'reports/weekly-summary.json', { ok: true })
  writeJson(root, 'intelligence/executive-scores.json', { ok: true })
  _setPrivateDataRootForTests(tenantId, root)
  return root
}

const PREMIUM_FILES = Object.freeze({
  operationsImpact: 'intelligence/operations-impact.json',
  advancedIntelligence: 'intelligence/department-performance.json',
  marketingIntelligence1: ['intelligence/best-quotes.json', 'marketingIntelligence'],
  marketingIntelligence2: ['intelligence/seasonal-trends.json', 'marketingIntelligence'],
  advancedReporting1: ['reports/weekly-summary.json', 'advancedReporting'],
  advancedReporting2: ['intelligence/executive-scores.json', 'advancedReporting'],
})

const CORE_REQUIRED_FILES = Object.freeze([
  'meta.json', 'action-items.json', 'analytics/kpis.json',
  'intelligence/company-summary.json', 'intelligence/complaint-intelligence.json',
  'intelligence/competitive-intelligence.json', 'intelligence/predictive-alerts.json',
  'intelligence/response-drafts.json',
])

// --- Part 1: requireFeature() unit behavior -------------------------------

function testRequireFeatureAllowsWhenTrue() {
  const entitlements = { commercialStatus: 'active', features: { operationsImpact: true } }
  const result = requireFeature(entitlements, 'operationsImpact')
  assert(result.allowed === true, JSON.stringify(result))
}

function testRequireFeatureDeniesNotIncluded() {
  const entitlements = { commercialStatus: 'active', features: { operationsImpact: false } }
  const result = requireFeature(entitlements, 'operationsImpact')
  assert(result.allowed === false && result.reason === 'not_included', JSON.stringify(result))
}

function testRequireFeatureFailsClosedOnResolverFailure() {
  const entitlements = { commercialStatus: 'unconfigured', features: { operationsImpact: false } }
  const result = requireFeature(entitlements, 'operationsImpact')
  assert(result.allowed === false && result.reason === 'resolver_failure', JSON.stringify(result))
  const entitlements2 = { commercialStatus: 'unknown', features: {} }
  const result2 = requireFeature(entitlements2, 'operationsImpact')
  assert(result2.allowed === false && result2.reason === 'resolver_failure', JSON.stringify(result2))
}

function testRequireFeatureFailsClosedOnUnknownFeatureName() {
  const entitlements = { commercialStatus: 'active', features: { operationsImpact: true } }
  const result = requireFeature(entitlements, 'someTypoedFeatureName')
  assert(result.allowed === false && result.reason === 'not_included', JSON.stringify(result))
}

function testRequireFeatureFailsClosedOnMalformedEntitlements() {
  assert(requireFeature(null, 'operationsImpact').allowed === false)
  assert(requireFeature(undefined, 'operationsImpact').allowed === false)
  assert(requireFeature({}, 'operationsImpact').allowed === false)
}

// --- Part 2: Executive Brief (advancedExecutiveBrief) ---------------------

async function testExecBriefCoreDeniedZeroAnthropicCalls() {
  installFakeConfigRedis()
  installFakeUserRedis()
  const tenantId = freshTenantId()
  const token = await seedTenant(tenantId, newShapeCommercial({ plan: 'core' }))
  installNeverCalledFetch()
  const res = await postExecutiveBrief(token)
  assert(res.statusCode === 403 && res.body.error === 'feature_not_available' && res.body.feature === 'advancedExecutiveBrief',
    `Core must be denied advancedExecutiveBrief, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testExecBriefGrowthAllowed() {
  installFakeConfigRedis()
  installFakeUserRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  const token = await seedTenant(tenantId, newShapeCommercial({ plan: 'growth' }))
  installSuccessFetch()
  const res = await postExecutiveBrief(token)
  assert(res.statusCode === 200, `Growth must be allowed, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testExecBriefTrialAllowed() {
  installFakeConfigRedis()
  installFakeUserRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  const token = await seedTenant(tenantId, newShapeCommercial({
    commercialStatus: 'trial', plan: 'growth',
    trial: { status: 'trialing', endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
  }))
  installSuccessFetch()
  const res = await postExecutiveBrief(token)
  assert(res.statusCode === 200, `Trial must be allowed, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testExecBriefEnterpriseAllowed() {
  installFakeConfigRedis()
  installFakeUserRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  const token = await seedTenant(tenantId, newShapeCommercial({ plan: 'enterprise' }))
  installSuccessFetch()
  const res = await postExecutiveBrief(token)
  assert(res.statusCode === 200, `Enterprise must be allowed, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testExecBriefLegacyUnchanged() {
  // LTA's BOOTSTRAP tenant -- no fake config Redis registered at all.
  installFakeUserRedis()
  const record = { userId: 'usr_owner', email: 'owner@example.com', passwordHash: await passwordHash(), role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1, disabled: false, displayName: 'Owner' }
  await upsertUser(DEFAULT_TENANT_ID, record, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  const token = await signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  installSuccessFetch()
  const res = await postExecutiveBrief(token)
  assert(res.statusCode === 200, `LTA/legacy must remain unaffected, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testExecBriefResolverFailureNoAnthropicCall() {
  installFakeConfigRedis()
  installFakeUserRedis()
  const tenantId = freshTenantId()
  // Malformed commercial state -- unresolvedBundle, fail closed.
  const token = await seedTenant(tenantId, newShapeCommercial({ plan: 'not_a_real_plan' }))
  installNeverCalledFetch()
  const res = await postExecutiveBrief(token)
  assert(res.statusCode === 503 && res.body.error === 'service_unavailable',
    `a resolver failure must fail closed with a distinct service-unavailable response, not "feature_not_available", got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testExecBriefFeatureCheckBeforeAiQuotaAndAnthropic() {
  installFakeConfigRedis()
  installFakeUserRedis()
  const usageClient = fakeKeyedHashRedis()
  setUsageRedis(() => usageClient)
  const tenantId = freshTenantId()
  // Core, with an ALREADY-EXHAUSTED (in fact irrelevant) AI quota bucket --
  // if the feature check did not run first, this would still 403 with
  // ai_quota_exhausted rather than feature_not_available; if it ran first,
  // no AI-usage read/Anthropic call happens at all.
  const token = await seedTenant(tenantId, newShapeCommercial({ plan: 'core' }))
  installNeverCalledFetch()
  const res = await postExecutiveBrief(token)
  assert(res.statusCode === 403 && res.body.error === 'feature_not_available',
    `feature check must run before AI quota check, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

// --- Part 3: /api/data premium-file gating --------------------------------

async function testDataCoreDeniedEachPremiumFile() {
  installFakeConfigRedis()
  installFakeUserRedis()
  const tenantId = freshTenantId()
  seedPrivateData(tenantId)
  const token = await seedTenant(tenantId, newShapeCommercial({ plan: 'core' }))
  for (const [file, feature] of premiumFileList()) {
    const res = await invokeData(file, token)
    assert(res.statusCode === 403 && res.body.error === 'feature_not_available' && res.body.feature === feature,
      `Core must be denied ${file} (${feature}), got ${res.statusCode} (${JSON.stringify(res.body)})`)
  }
}

function premiumFileList() {
  return [
    ['intelligence/operations-impact.json', 'operationsImpact'],
    ['intelligence/department-performance.json', 'advancedIntelligence'],
    ['intelligence/best-quotes.json', 'marketingIntelligence'],
    ['intelligence/seasonal-trends.json', 'marketingIntelligence'],
    ['reports/weekly-summary.json', 'advancedReporting'],
    ['intelligence/executive-scores.json', 'advancedReporting'],
  ]
}

async function testDataGrowthTrialEnterpriseAllowedForEachPremiumFile() {
  for (const commercial of [
    newShapeCommercial({ plan: 'growth' }),
    newShapeCommercial({ commercialStatus: 'trial', plan: 'growth', trial: { status: 'trialing', endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() } }),
    newShapeCommercial({ plan: 'enterprise' }),
  ]) {
    installFakeConfigRedis()
    installFakeUserRedis()
    const tenantId = freshTenantId()
    seedPrivateData(tenantId)
    const token = await seedTenant(tenantId, commercial)
    for (const [file] of premiumFileList()) {
      const res = await invokeData(file, token)
      assert(res.statusCode === 200, `${commercial.commercialStatus}/${commercial.plan} must be allowed ${file}, got ${res.statusCode} (${JSON.stringify(res.body)})`)
    }
    resetConfigRedis(); resetUserRedis(); _resetPrivateDataRootsForTests()
  }
}

async function testDataLegacyUnaffectedForEachPremiumFile() {
  installFakeUserRedis()
  const record = { userId: 'usr_owner', email: 'owner@example.com', passwordHash: await passwordHash(), role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1, disabled: false, displayName: 'Owner' }
  await upsertUser(DEFAULT_TENANT_ID, record, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  const token = await signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  seedPrivateData(DEFAULT_TENANT_ID)
  for (const [file] of premiumFileList()) {
    const res = await invokeData(file, token)
    assert(res.statusCode === 200, `LTA/legacy must remain unaffected for ${file}, got ${res.statusCode} (${JSON.stringify(res.body)})`)
  }
}

async function testDataResolverFailureDeniesEachPremiumFile() {
  installFakeConfigRedis()
  installFakeUserRedis()
  const tenantId = freshTenantId()
  seedPrivateData(tenantId)
  const token = await seedTenant(tenantId, newShapeCommercial({ plan: 'not_a_real_plan' }))
  for (const [file] of premiumFileList()) {
    const res = await invokeData(file, token)
    assert(res.statusCode === 503 && res.body.error === 'service_unavailable',
      `a resolver failure must fail closed with service_unavailable for ${file}, got ${res.statusCode} (${JSON.stringify(res.body)})`)
  }
}

async function testDataCoreBasicFilesRemainAvailable() {
  installFakeConfigRedis()
  installFakeUserRedis()
  const tenantId = freshTenantId()
  seedPrivateData(tenantId)
  const token = await seedTenant(tenantId, newShapeCommercial({ plan: 'core' }))
  for (const file of CORE_REQUIRED_FILES) {
    const res = await invokeData(file, token)
    assert(res.statusCode === 200, `Core must retain access to basic/shared file ${file}, got ${res.statusCode} (${JSON.stringify(res.body)})`)
  }
}

async function testNoClientSuppliedFeatureOrPlanFieldHasAnyEffect() {
  installFakeConfigRedis()
  installFakeUserRedis()
  const tenantId = freshTenantId()
  seedPrivateData(tenantId)
  const token = await seedTenant(tenantId, newShapeCommercial({ plan: 'core' }))
  // Spoofed query params alongside a legitimate file request -- data.js
  // never reads plan/feature/commercialStatus from req.query at all.
  const res = await invokeData('intelligence/operations-impact.json', token, {
    query: { plan: 'enterprise', feature: 'operationsImpact', commercialStatus: 'active', features: 'operationsImpact:true' },
  })
  assert(res.statusCode === 403 && res.body.error === 'feature_not_available',
    `spoofed query params must have no effect, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testLocationAuthorizationStillAppliesIndependentlyOfCommercialPlan() {
  // A location-SCOPED account (not wildcard) on a Growth plan must still be
  // blocked from a company-wide file by the PRE-EXISTING location/tenant
  // authorization -- commercial allowance never overrides it. Uses one of
  // the Core-required (never premium-gated) company-wide files specifically
  // to prove this is the ORIGINAL company-wide gate, not the new one.
  installFakeConfigRedis()
  installFakeUserRedis()
  const tenantId = freshTenantId()
  seedPrivateData(tenantId)
  await upsertTenantConfig(tenantId, { status: 'active', locationCatalogEnabled: true, commercial: newShapeCommercial({ plan: 'growth' }) }, { allowCreate: true, creationSource: 'migration' })
  const scopedRecord = {
    userId: 'usr_scoped', email: 'scoped@example.com', passwordHash: await passwordHash(), role: 'location_manager',
    locationIds: [7], tenantId, sessionVersion: 1, disabled: false, displayName: 'Scoped',
  }
  await upsertUser(tenantId, scopedRecord, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: scopedRecord })
  const scopedToken = await signSession({ userId: 'usr_scoped', email: 'scoped@example.com', role: 'location_manager', locationIds: [7], tenantId, sessionVersion: 1 })
  const res = await invokeData('analytics/kpis.json', scopedToken)
  assert(res.statusCode === 403 && res.body.error === 'forbidden',
    `a location-scoped account on a Growth plan must still be blocked from company-wide data by the PRE-EXISTING location gate, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testNoCrossTenantRegressionAcrossDifferentPlans() {
  installFakeConfigRedis()
  installFakeUserRedis()
  const coreTenanId = freshTenantId()
  const growthTenantId = freshTenantId()
  seedPrivateData(coreTenanId)
  seedPrivateData(growthTenantId)
  const coreToken = await seedTenant(coreTenanId, newShapeCommercial({ plan: 'core' }))
  const growthToken = await seedTenant(growthTenantId, newShapeCommercial({ plan: 'growth' }))
  const coreRes = await invokeData('intelligence/operations-impact.json', coreToken)
  assert(coreRes.statusCode === 403, `Core tenant must be denied, got ${coreRes.statusCode}`)
  const growthRes = await invokeData('intelligence/operations-impact.json', growthToken)
  assert(growthRes.statusCode === 200, `a wholly separate Growth tenant must be unaffected by the Core tenant's denial, got ${growthRes.statusCode}`)
}

// --- Part 4: structural/security guards -----------------------------------

function testTasksEndpointNeverReferencesManagerWorkflow() {
  const src = readFileSync(new URL('../dashboard/api/tasks/[action].js', import.meta.url), 'utf8')
  assert(!/managerWorkflow/.test(src), 'tasks/[action].js must never gate generic Task CRUD behind managerWorkflow')
}

function testDataEndpointNeverGatesCoreRequiredFilesAsPremium() {
  const src = readFileSync(new URL('../dashboard/api/data.js', import.meta.url), 'utf8')
  const mapMatch = src.match(/PREMIUM_DATA_FEATURE_MAP = Object\.freeze\(\{([\s\S]*?)\}\)/)
  assert(mapMatch, 'PREMIUM_DATA_FEATURE_MAP must exist in data.js')
  const mapBody = mapMatch[1]
  for (const file of CORE_REQUIRED_FILES) {
    assert(!mapBody.includes(`'${file}'`), `${file} must never be listed in PREMIUM_DATA_FEATURE_MAP -- it is required by Core's basic dashboard/alerts/reviews surface`)
  }
  assert(!mapBody.includes("'meta.json'"), 'meta.json itself must never be premium-gated (it is filtered, not blocked)')
}

function testDataEndpointNeverGatesTheEntireEndpointBehindGrowth() {
  const src = readFileSync(new URL('../dashboard/api/data.js', import.meta.url), 'utf8')
  // The feature-gate check must be conditional on a specific relPath match
  // (PREMIUM_DATA_FEATURE_MAP[relPath]), never an unconditional check that
  // would apply to every request.
  assert(/const requiredFeature = PREMIUM_DATA_FEATURE_MAP\[relPath\]/.test(src),
    'the feature check must be keyed off the specific requested relPath, never applied unconditionally to the whole endpoint')
}

function testCommercialCheckRunsAfterLocationAuthorizationInSource() {
  const src = readFileSync(new URL('../dashboard/api/data.js', import.meta.url), 'utf8')
  const locationCheckIdx = src.indexOf("category === 'company-wide'")
  const featureCheckIdx = src.indexOf('const requiredFeature = PREMIUM_DATA_FEATURE_MAP')
  assert(locationCheckIdx !== -1 && featureCheckIdx !== -1, 'both checks must exist in source')
  assert(locationCheckIdx < featureCheckIdx, 'the location/tenant authorization block must appear BEFORE the commercial feature check in source order -- commercial authorization must never replace or precede it')
}

function testExecutiveBriefFeatureCheckPrecedesAiQuotaCheckInSource() {
  const src = readFileSync(new URL('../dashboard/api/executive-brief.js', import.meta.url), 'utf8')
  const featureCheckIdx = src.indexOf("requireFeature(entitlements, 'advancedExecutiveBrief')")
  const quotaCheckIdx = src.indexOf('const monthlyLimit = entitlements.limits.aiAllowanceMonthly.usageUnits')
  assert(featureCheckIdx !== -1 && quotaCheckIdx !== -1, 'both checks must exist in source')
  assert(featureCheckIdx < quotaCheckIdx, 'the feature check must precede the AI commercial quota check in source order')
}

// Structural guard: no endpoint/lib file may branch on `.plan ===`/
// `.commercialStatus ===`/`.features[` read directly -- every real
// authorization decision must go through requireFeature()/the resolver
// itself, never a hand-rolled `plan === 'growth'` check scattered through
// endpoint code (the exact anti-pattern Part B explicitly forbids). Files
// that legitimately define/resolve/re-export these fields are exempted.
function listJsFilesRecursive(dirPath) {
  const out = []
  for (const entry of readdirSync(dirPath)) {
    const full = path.join(dirPath, entry)
    if (statSync(full).isDirectory()) out.push(...listJsFilesRecursive(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

function testNoEndpointReadsPlanOrCommercialStatusDirectlyOutsideResolver() {
  const exemptFiles = new Set([
    'entitlementResolution.js', 'entitlements.js', 'planEntitlements.js',
    'featureAuthorization.js', 'tenantConfigStore.js', 'plans.js',
  ])
  const apiDir = path.dirname(fileURLToPath(new URL('../dashboard/api/data.js', import.meta.url)))
  const offenders = []
  for (const file of listJsFilesRecursive(apiDir)) {
    const base = path.basename(file)
    if (exemptFiles.has(base)) continue
    const src = readFileSync(file, 'utf8')
    if (/\.plan\s*===\s*['"]/.test(src) || /\.commercialStatus\s*===\s*['"]/.test(src)) {
      offenders.push(base)
    }
  }
  assert(offenders.length === 0, `endpoint/lib files must never branch on .plan/.commercialStatus directly -- use requireFeature() instead: ${offenders.join(', ')}`)
}

const tests = [
  ['requireFeature: allows when the resolved plan genuinely includes the feature', testRequireFeatureAllowsWhenTrue],
  ['requireFeature: denies (not_included) when the resolved plan excludes the feature', testRequireFeatureDeniesNotIncluded],
  ['requireFeature: fails closed (resolver_failure) on a resolution-failure status', testRequireFeatureFailsClosedOnResolverFailure],
  ['requireFeature: an unknown/malformed feature name fails closed (not_included)', testRequireFeatureFailsClosedOnUnknownFeatureName],
  ['requireFeature: malformed/missing entitlements fails closed', testRequireFeatureFailsClosedOnMalformedEntitlements],

  ['executive-brief: Core denied advancedExecutiveBrief, zero Anthropic calls', testExecBriefCoreDeniedZeroAnthropicCalls],
  ['executive-brief: Growth allowed', testExecBriefGrowthAllowed],
  ['executive-brief: Trial allowed', testExecBriefTrialAllowed],
  ['executive-brief: Enterprise allowed', testExecBriefEnterpriseAllowed],
  ['executive-brief: Legacy/LTA unchanged', testExecBriefLegacyUnchanged],
  ['executive-brief: resolver failure -> service_unavailable, zero Anthropic calls', testExecBriefResolverFailureNoAnthropicCall],
  ['executive-brief: feature check runs before AI quota check and Anthropic', testExecBriefFeatureCheckBeforeAiQuotaAndAnthropic],

  ['/api/data: Core denied every premium file', testDataCoreDeniedEachPremiumFile],
  ['/api/data: Growth/Trial/Enterprise allowed for every premium file', testDataGrowthTrialEnterpriseAllowedForEachPremiumFile],
  ['/api/data: Legacy/LTA unaffected for every premium file', testDataLegacyUnaffectedForEachPremiumFile],
  ['/api/data: resolver failure denies every premium file', testDataResolverFailureDeniesEachPremiumFile],
  ['/api/data: Core retains access to all basic/shared data files', testDataCoreBasicFilesRemainAvailable],
  ['/api/data: no client-supplied plan/feature query param has any effect', testNoClientSuppliedFeatureOrPlanFieldHasAnyEffect],
  ['/api/data: location authorization still applies independently of commercial plan', testLocationAuthorizationStillAppliesIndependentlyOfCommercialPlan],
  ['/api/data: no cross-tenant regression across different plans', testNoCrossTenantRegressionAcrossDifferentPlans],

  ['structural: tasks/[action].js never references managerWorkflow', testTasksEndpointNeverReferencesManagerWorkflow],
  ['structural: PREMIUM_DATA_FEATURE_MAP never lists a Core-required file', testDataEndpointNeverGatesCoreRequiredFilesAsPremium],
  ['structural: the feature check is keyed per-file, never applied to the whole endpoint', testDataEndpointNeverGatesTheEntireEndpointBehindGrowth],
  ['structural: commercial check runs after location authorization in source', testCommercialCheckRunsAfterLocationAuthorizationInSource],
  ['structural: executive-brief feature check precedes the AI quota check in source', testExecutiveBriefFeatureCheckPrecedesAiQuotaCheckInSource],
  ['structural: no endpoint/lib file reads .plan/.commercialStatus directly outside the resolver', testNoEndpointReadsPlanOrCommercialStatusDirectlyOutsideResolver],
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
