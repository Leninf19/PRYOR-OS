// Phase B.4 -- commercial AI usage metering (Part A). Regression tests for
// dashboard/api/_lib/aiUsageUnits.js (pure weighting), dashboard/api/_lib/
// aiUsageStore.js (Redis-backed period tracking), and the quota-check/
// usage-recording wiring added to dashboard/api/_lib/rewriteEngine.js's
// generateRewrite() (Haiku) and dashboard/api/executive-brief.js (Sonnet).
// Phase A's own per-user/per-tenant rate limits and input-size caps are
// covered by tests/test_ai_tenant_limits.js and tests/test_rewrite_policy.js/
// tests/test_executive_brief.js -- unchanged and not re-tested here except
// for one structural "still applies independently" check.
//
// Run directly: node tests/test_ai_usage_metering.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests'

import { readFileSync } from 'fs'
import bcrypt from 'bcryptjs'
import { generateRewrite } from '../dashboard/api/_lib/rewriteEngine.js'
import executiveBriefHandler from '../dashboard/api/executive-brief.js'
import actionsHandler from '../dashboard/api/actions/[action].js'
import { calculateAiUsageUnits, resolveTokenCounts, AI_USAGE_UNIT_WEIGHTS_VERSION } from '../dashboard/api/_lib/aiUsageUnits.js'
import {
  getAiUsage, recordAiUsage, currentUsagePeriod,
  _setRedisClientForTests as setUsageRedis, _resetRedisClientForTests as resetUsageRedis,
} from '../dashboard/api/_lib/aiUsageStore.js'
import {
  upsertTenantConfig,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import {
  upsertUser, UserCreationMode,
  _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis,
} from '../dashboard/api/_lib/userStore.js'
import { _setLimiterFactoryForTests, _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

function rewriteHandler(req, res) { return actionsHandler({ ...req, query: { ...req.query, action: 'rewrite' } }, res) }

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
    resetUsageRedis()
    resetConfigRedis()
    resetUserRedis()
    _resetLimiterFactoryForTests()
  }
}

// --- fake stores -------------------------------------------------------

// CRITICAL: the factory passed to _setRedisClientForTests must return the
// SAME persistent instance on every call (see tenantConfigStore.js's
// getClient() / test_location_seat_limits.js's own header comment on this
// exact bug class) -- a factory that builds a fresh store per call
// silently discards every earlier write.
function fakeConfigRedis() {
  const store = {}
  return {
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
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

function fakeAiUsageRedis() {
  const store = {}
  return {
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [inputTokensStr, outputTokensStr, usageUnitsStr, , estimatedStr] = args
      const cur = store[key] ?? {}
      store[key] = {
        requestCount: (Number(cur.requestCount) || 0) + 1,
        inputTokens: (Number(cur.inputTokens) || 0) + Number(inputTokensStr),
        outputTokens: (Number(cur.outputTokens) || 0) + Number(outputTokensStr),
        usageUnits: (Number(cur.usageUnits) || 0) + Number(usageUnitsStr),
        estimatedRequestCount: (Number(cur.estimatedRequestCount) || 0) + Number(estimatedStr),
      }
      return 1
    },
    _dump: () => store,
  }
}

function installFakeConfigRedis() {
  const client = fakeConfigRedis()
  setConfigRedis(() => client)
  return client
}
function installFakeUsageRedis() {
  const client = fakeAiUsageRedis()
  setUsageRedis(() => client)
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

let tenantCounter = 0
function freshTenantId() { return `t_ai-usage-${++tenantCounter}` }

// status/locationCatalogEnabled mirror tests/test_ai_tenant_limits.js's own
// seedTenant() -- required so a wildcard-role account is genuinely treated
// as covering every location by tenants.js's tenantOwnsLocationCatalog(),
// matching how a real provisioned Owner account behaves.
async function seedTenant(tenantId, commercial) {
  return upsertTenantConfig(tenantId, { status: 'active', locationCatalogEnabled: true, commercial }, { allowCreate: true, creationSource: 'migration' })
}

function installSuccessFetch({ inputTokens = 500, outputTokens = 100, text = 'A generated reply.' } = {}) {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return { ok: true, json: async () => ({ content: [{ text }], usage: { input_tokens: inputTokens, output_tokens: outputTokens } }) }
  }
  return () => calls
}
function installFailureFetch() {
  let calls = 0
  globalThis.fetch = async () => { calls++; return { ok: false, status: 500, statusText: 'Internal error', text: async () => 'boom' } }
  return () => calls
}
function installNeverCalledFetch() {
  globalThis.fetch = async (url) => { throw new Error(`Anthropic must not be called, but fetch was invoked for: ${url}`) }
}
// General-purpose fetch installer for constructing arbitrary/malformed
// `usage` shapes -- pass `usage: undefined` to omit the field entirely.
function installFetchWithUsage({ usage, text = 'ok' } = {}) {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    const body = usage === undefined ? { content: [{ text }] } : { content: [{ text }], usage }
    return { ok: true, json: async () => body }
  }
  return () => calls
}

// --- Part 1: calculateAiUsageUnits (pure weighting) ---------------------

function testHaikuAndSonnetWeightingDiffer() {
  const haiku = calculateAiUsageUnits({ model: 'claude-haiku-4-5-20251001', inputTokens: 1000, outputTokens: 1000 })
  const sonnet = calculateAiUsageUnits({ model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 1000 })
  assert(haiku !== sonnet, `Haiku and Sonnet must weight the same token counts differently, got ${haiku} vs ${sonnet}`)
  assert(sonnet > haiku, `Sonnet must be weighted more expensive than Haiku for identical token counts, got haiku=${haiku} sonnet=${sonnet}`)
}

function testInputAndOutputWeightedDifferently() {
  const inputHeavy = calculateAiUsageUnits({ model: 'claude-haiku-4-5-20251001', inputTokens: 1000, outputTokens: 0 })
  const outputHeavy = calculateAiUsageUnits({ model: 'claude-haiku-4-5-20251001', inputTokens: 0, outputTokens: 1000 })
  assert(inputHeavy !== outputHeavy, `1000 input-only tokens and 1000 output-only tokens must weight differently, got ${inputHeavy} vs ${outputHeavy}`)
}

function testMalformedTokenCountsTreatedAsZero() {
  const a = calculateAiUsageUnits({ model: 'claude-haiku-4-5-20251001', inputTokens: NaN, outputTokens: undefined })
  const b = calculateAiUsageUnits({ model: 'claude-haiku-4-5-20251001', inputTokens: -50, outputTokens: 'abc' })
  assert(a === 0, `NaN/undefined token counts must safely resolve to 0 usage units, got ${a}`)
  assert(b === 0, `negative/non-numeric token counts must safely resolve to 0 usage units, got ${b}`)
}

function testUnknownModelFallsBackToMostExpensiveWeight() {
  const known = calculateAiUsageUnits({ model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 1000 })
  const unknown = calculateAiUsageUnits({ model: 'some-future-model-xyz', inputTokens: 1000, outputTokens: 1000 })
  assert(unknown === known, `an unrecognized model must fall back to the most expensive known weighting (Sonnet's), got ${unknown} vs ${known}`)
  assert(unknown > 0, `the unknown-model fallback weighting must remain the highest-cost weighting, never zero, got ${unknown}`)
}

function testWeightsVersionIsExported() {
  assert(Number.isInteger(AI_USAGE_UNIT_WEIGHTS_VERSION) && AI_USAGE_UNIT_WEIGHTS_VERSION >= 1, 'a versioned weights constant must be exported')
}

// --- Part 2: aiUsageStore.js mechanics -----------------------------------

async function testGetAiUsageReturnsZerosForUnseenPeriod() {
  installFakeUsageRedis()
  const usage = await getAiUsage('t_some_tenant', '2026-01')
  assert(usage.requestCount === 0 && usage.inputTokens === 0 && usage.outputTokens === 0 && usage.usageUnits === 0,
    `an unseen tenant/period must read back as all zeros, got ${JSON.stringify(usage)}`)
}

async function testRecordAiUsageAccumulatesAcrossCalls() {
  installFakeUsageRedis()
  await recordAiUsage('t_x', '2026-02', { inputTokens: 100, outputTokens: 50, usageUnits: 300 })
  await recordAiUsage('t_x', '2026-02', { inputTokens: 200, outputTokens: 20, usageUnits: 400 })
  const usage = await getAiUsage('t_x', '2026-02')
  assert(usage.requestCount === 2, `expected requestCount 2, got ${usage.requestCount}`)
  assert(usage.inputTokens === 300 && usage.outputTokens === 70 && usage.usageUnits === 700,
    `expected accumulated totals, got ${JSON.stringify(usage)}`)
}

async function testSeparateTenantsHaveSeparateCounters() {
  installFakeUsageRedis()
  await recordAiUsage('t_alpha', '2026-03', { inputTokens: 1000, outputTokens: 1000, usageUnits: 5000 })
  const alpha = await getAiUsage('t_alpha', '2026-03')
  const beta = await getAiUsage('t_beta', '2026-03')
  assert(alpha.usageUnits === 5000, `tenant alpha must reflect its own recorded usage, got ${JSON.stringify(alpha)}`)
  assert(beta.usageUnits === 0, `a wholly separate tenant must be completely unaffected, got ${JSON.stringify(beta)}`)
}

async function testMonthRolloverCreatesIndependentPeriod() {
  installFakeUsageRedis()
  await recordAiUsage('t_gamma', '2026-01', { inputTokens: 1000, outputTokens: 1000, usageUnits: 9000 })
  const january = await getAiUsage('t_gamma', '2026-01')
  const february = await getAiUsage('t_gamma', '2026-02')
  assert(january.usageUnits === 9000, 'January usage must be recorded')
  assert(february.usageUnits === 0, `a new calendar month must start with an independent, empty counter, got ${JSON.stringify(february)}`)
}

function testCurrentUsagePeriodIsUtcCalendarMonth() {
  const p = currentUsagePeriod(new Date(Date.UTC(2026, 0, 31, 23, 59)))
  assert(p === '2026-01', `expected UTC calendar month "2026-01", got ${p}`)
  const q = currentUsagePeriod(new Date(Date.UTC(2026, 11, 1, 0, 0)))
  assert(q === '2026-12', `expected UTC calendar month "2026-12", got ${q}`)
}

async function testStoreNotConfiguredNeverThrowsOnRecord() {
  // No _setRedisClientForTests call, and no real UPSTASH_* env vars in this
  // test process -- getClient() returns null. recordAiUsage() must log and
  // return, never throw (see this module's own "never fails an
  // already-successful request over bookkeeping" contract).
  await recordAiUsage('t_unconfigured', '2026-04', { inputTokens: 10, outputTokens: 10, usageUnits: 10 })
}

// --- Part 3: quota enforcement via generateRewrite() (Haiku) -------------

async function testCoreAllowanceEnforced() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'core' }))
  const getCalls = installSuccessFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId })
  assert(result.ok === true, `a Core tenant well under its 1,000,000-usage-unit allowance must succeed, got ${JSON.stringify(result)}`)
  assert(getCalls() === 1, 'exactly one Anthropic call must have been made')
}

async function testGrowthAllowanceEnforced() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'growth' }))
  installSuccessFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId })
  assert(result.ok === true, `a Growth tenant well under its 4,000,000-usage-unit allowance must succeed, got ${JSON.stringify(result)}`)
}

async function testTrialAllowanceEnforced() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({
    commercialStatus: 'trial', plan: 'growth',
    trial: { status: 'trialing', endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
  }))
  installSuccessFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId })
  assert(result.ok === true, `an active trial tenant well under its 500,000-usage-unit allowance must succeed, got ${JSON.stringify(result)}`)
}

async function testEnterpriseOverrideEnforced() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  // A deliberately tiny Enterprise AI override -- aiAllowanceMonthly is
  // NEVER clamped to any platform ceiling (only storage/asset counts are,
  // via clampToSafetyCeiling()), so this override applies exactly as given.
  await seedTenant(tenantId, newShapeCommercial({ plan: 'enterprise', limitsOverride: { aiAllowanceMonthly: { usageUnits: 10 } } }))
  await recordAiUsage(tenantId, currentUsagePeriod(), { inputTokens: 0, outputTokens: 0, usageUnits: 10 })
  installNeverCalledFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId })
  assert(result.ok === false && result.status === 403 && result.error === 'ai_quota_exhausted' && result.limit === 10,
    `an Enterprise tenant must be bound by its own server-authorized override once reached, got ${JSON.stringify(result)}`)
}

async function testEnterpriseOverrideAllowsUntilItsOwnLimit() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'enterprise', limitsOverride: { aiAllowanceMonthly: { usageUnits: 10_000_000 } } }))
  const getCalls = installSuccessFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId })
  assert(result.ok === true, `an Enterprise tenant with a large override must succeed while under it, got ${JSON.stringify(result)}`)
  assert(getCalls() === 1, 'exactly one Anthropic call must have been made')
}

async function testLegacyUnmanagedTenantHasNoAiAllowanceEnforcement() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, null) // no commercial field at all -- legacy/unmanaged, cutoff still disabled
  const getCalls = installSuccessFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId })
  assert(result.ok === true, `a legacy/unmanaged tenant must have no commercial AI allowance enforcement, got ${JSON.stringify(result)}`)
  assert(getCalls() === 1, 'exactly one Anthropic call must have been made')
}

async function testLtaBootstrapTenantUnaffected() {
  // No fake config Redis registered at all -- BOOTSTRAP short-circuits
  // resolveTenantEntitlements() before any Redis read, exactly as it did
  // before this phase (LTA behavior must be completely unchanged).
  installFakeUsageRedis()
  const getCalls = installSuccessFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId: DEFAULT_TENANT_ID })
  assert(result.ok === true, `LTA's BOOTSTRAP tenant must be completely unaffected by commercial AI quota enforcement, got ${JSON.stringify(result)}`)
  assert(getCalls() === 1, 'exactly one Anthropic call must have been made')
}

async function testResolverFailureBlocksWithNoAnthropicRequest() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  // Malformed commercial state: a real commercialStatus but an unrecognized
  // plan id -- resolves to unresolvedBundle('unknown_plan'), 0 AI allowance,
  // fail-closed.
  await seedTenant(tenantId, newShapeCommercial({ plan: 'not_a_real_plan' }))
  installNeverCalledFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId })
  assert(result.ok === false && result.status === 403 && result.error === 'ai_quota_exhausted',
    `a resolver failure must fail closed (0 usage units) and block the very first request, got ${JSON.stringify(result)}`)
}

async function testExhaustedAllowanceBlocksWithNoAnthropicRequest() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'core' }))
  await recordAiUsage(tenantId, currentUsagePeriod(), { inputTokens: 0, outputTokens: 0, usageUnits: 1_000_000 })
  installNeverCalledFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId })
  assert(result.ok === false && result.status === 403 && result.error === 'ai_quota_exhausted',
    `a tenant already at its Core allowance must be blocked before any Anthropic call, got ${JSON.stringify(result)}`)
  assert(result.current === 1_000_000 && result.limit === 1_000_000, `expected current/limit in the response, got ${JSON.stringify(result)}`)
}

async function testSeparateTenantsIndependentQuota() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const exhausted = freshTenantId()
  const fresh = freshTenantId()
  await seedTenant(exhausted, newShapeCommercial({ plan: 'core' }))
  await seedTenant(fresh, newShapeCommercial({ plan: 'core' }))
  await recordAiUsage(exhausted, currentUsagePeriod(), { inputTokens: 0, outputTokens: 0, usageUnits: 1_000_000 })
  installSuccessFetch()
  const blocked = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId: exhausted })
  assert(blocked.ok === false, `the exhausted tenant must still be blocked, got ${JSON.stringify(blocked)}`)
  const allowed = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId: fresh })
  assert(allowed.ok === true, `a wholly separate, unexhausted tenant must be unaffected, got ${JSON.stringify(allowed)}`)
}

async function testNoClientSuppliedQuotaFieldHasAnyEffect() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'core' }))
  await recordAiUsage(tenantId, currentUsagePeriod(), { inputTokens: 0, outputTokens: 0, usageUnits: 1_000_000 })
  installNeverCalledFetch()
  // A spoofed body carrying fields that LOOK like quota/plan overrides --
  // generateRewrite() never reads body.aiAllowanceMonthly/body.plan/
  // body.commercialStatus/body.limitsOverride at all; only the server-side
  // resolver (keyed by tenantId, never by request body) can ever determine
  // the limit.
  const result = await generateRewrite({
    tone: 'friendly', reviewText: 'Great food!',
    aiAllowanceMonthly: { usageUnits: 999999999 }, plan: 'enterprise', commercialStatus: 'active', limitsOverride: { aiAllowanceMonthly: { usageUnits: 999999999 } },
  }, { tenantId })
  assert(result.ok === false && result.error === 'ai_quota_exhausted',
    `a spoofed request body must have NO effect on the server-resolved quota decision, got ${JSON.stringify(result)}`)
}

// --- Part 4: usage recording correctness ---------------------------------

async function testRawUsageAndUsageUnitsRecordedAfterSuccess() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'core' }))
  installSuccessFetch({ inputTokens: 321, outputTokens: 87 })
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId })
  assert(result.ok === true, `setup call must succeed, got ${JSON.stringify(result)}`)
  const usage = await getAiUsage(tenantId, currentUsagePeriod())
  assert(usage.requestCount === 1, `expected requestCount 1, got ${usage.requestCount}`)
  assert(usage.inputTokens === 321 && usage.outputTokens === 87, `expected raw token counts to be recorded verbatim, got ${JSON.stringify(usage)}`)
  const expectedUnits = calculateAiUsageUnits({ model: 'claude-haiku-4-5-20251001', inputTokens: 321, outputTokens: 87 })
  assert(usage.usageUnits === expectedUnits, `expected weighted usageUnits ${expectedUnits}, got ${usage.usageUnits}`)
}

async function testNoPromptOrContentEverStoredInUsageRecord() {
  // Functional, not a source-text scan (the module's OWN header comments
  // legitimately mention "prompt"/"review text" while explaining what is
  // NOT stored, which would false-positive a naive substring scan): record
  // real usage, including generously long/suspicious-looking token counts,
  // and assert the record's field set is EXACTLY the four integer counters
  // -- nothing else can ever have been persisted, because recordAiUsage()
  // only ever accepts {inputTokens, outputTokens, usageUnits} and writes
  // exactly requestCount/inputTokens/outputTokens/usageUnits.
  installFakeUsageRedis()
  await recordAiUsage('t_content_check', '2026-05', { inputTokens: 500, outputTokens: 200, usageUnits: 900 })
  const usage = await getAiUsage('t_content_check', '2026-05')
  const keys = Object.keys(usage).sort()
  assert(JSON.stringify(keys) === JSON.stringify(['estimatedRequestCount', 'inputTokens', 'outputTokens', 'requestCount', 'usageUnits']),
    `a usage record must contain exactly the five integer counters and nothing else, got keys ${JSON.stringify(keys)}`)
}

async function testProviderFailureDoesNotRecordUsage() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'core' }))
  installFailureFetch()
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId })
  assert(result.ok === false, `an Anthropic 5xx must surface as a failure, got ${JSON.stringify(result)}`)
  const usage = await getAiUsage(tenantId, currentUsagePeriod())
  assert(usage.requestCount === 0 && usage.usageUnits === 0, `no usage may be recorded when the provider call itself failed, got ${JSON.stringify(usage)}`)
}

// --- Final cost-metering correction: A-D failure-mode matrix (rewrite) ---
// A successful, already-billed Anthropic call must NEVER meter as zero
// usage solely because the provider's own usage metadata is unusable.

async function testRewriteNoUsageObjectStillRecordsNonzeroUsage() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'core' }))
  installFetchWithUsage({ usage: undefined, text: 'A generated reply.' }) // no `usage` key at all
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId })
  assert(result.ok === true && result.rewritten === 'A generated reply.',
    `(A) the customer must still receive the successful AI result even with no usage object, got ${JSON.stringify(result)}`)
  const usage = await getAiUsage(tenantId, currentUsagePeriod())
  assert(usage.requestCount === 1 && usage.usageUnits > 0,
    `(A) a successful call with no usage object at all must still record NONZERO usageUnits, got ${JSON.stringify(usage)}`)
  assert(usage.estimatedRequestCount === 1, `(A) this request must be flagged as estimated, got ${JSON.stringify(usage)}`)
}

async function testRewriteMalformedInputTokensStillRecordsNonzeroConservativeUsage() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'core' }))
  installFetchWithUsage({ usage: { input_tokens: 'not-a-number', output_tokens: 100 } })
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId })
  assert(result.ok === true, `setup call must succeed, got ${JSON.stringify(result)}`)
  const usage = await getAiUsage(tenantId, currentUsagePeriod())
  assert(usage.inputTokens > 0, `(B) a malformed input_tokens must fall back to a nonzero conservative estimate, got ${JSON.stringify(usage)}`)
  assert(usage.outputTokens === 100, `(B) the genuinely valid output_tokens must be preserved exactly, got ${JSON.stringify(usage)}`)
  assert(usage.usageUnits > 0, `(B) usageUnits must be nonzero, got ${JSON.stringify(usage)}`)
  assert(usage.estimatedRequestCount === 1, `(B) this request must be flagged as estimated, got ${JSON.stringify(usage)}`)
}

async function testRewriteMalformedOutputTokensStillRecordsNonzeroConservativeUsage() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'core' }))
  installFetchWithUsage({ usage: { input_tokens: 500, output_tokens: -7 } }) // negative -- unusable
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId })
  assert(result.ok === true, `setup call must succeed, got ${JSON.stringify(result)}`)
  const usage = await getAiUsage(tenantId, currentUsagePeriod())
  assert(usage.inputTokens === 500, `(C) the genuinely valid input_tokens must be preserved exactly, got ${JSON.stringify(usage)}`)
  assert(usage.outputTokens > 0, `(C) a malformed (negative) output_tokens must fall back to a nonzero conservative estimate (the request's max_tokens), got ${JSON.stringify(usage)}`)
  assert(usage.outputTokens === 300, `(C) the output fallback must be the request's own configured max_tokens (300 for rewrite), got ${JSON.stringify(usage)}`)
  assert(usage.usageUnits > 0, `(C) usageUnits must be nonzero, got ${JSON.stringify(usage)}`)
  assert(usage.estimatedRequestCount === 1, `(C) this request must be flagged as estimated, got ${JSON.stringify(usage)}`)
}

async function testRewriteGenuinelyValidZeroUsageIsAcceptedNeverEstimated() {
  // A genuinely, validly-reported zero (e.g. a cached/deduped provider
  // response) must be ACCEPTED as-is, never replaced by an estimate --
  // isUsableTokenCount() treats 0 as usable, distinct from malformed/missing.
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'core' }))
  installFetchWithUsage({ usage: { input_tokens: 0, output_tokens: 0 } })
  const result = await generateRewrite({ tone: 'friendly', reviewText: 'Great food!' }, { tenantId })
  assert(result.ok === true, `setup call must succeed, got ${JSON.stringify(result)}`)
  const usage = await getAiUsage(tenantId, currentUsagePeriod())
  assert(usage.inputTokens === 0 && usage.outputTokens === 0 && usage.usageUnits === 0,
    `a genuinely valid zero-usage report must be accepted as-is, got ${JSON.stringify(usage)}`)
  assert(usage.estimatedRequestCount === 0, `a genuinely valid zero report must NOT be flagged as estimated, got ${JSON.stringify(usage)}`)
}

function testResolveTokenCountsUnitBehavior() {
  const clean = resolveTokenCounts({ rawUsage: { input_tokens: 200, output_tokens: 50 }, promptChars: 900, maxTokens: 300 })
  assert(clean.inputTokens === 200 && clean.outputTokens === 50 && !clean.inputEstimated && !clean.outputEstimated,
    `(D) fully valid usage must pass through unchanged, got ${JSON.stringify(clean)}`)

  const noUsage = resolveTokenCounts({ rawUsage: undefined, promptChars: 900, maxTokens: 300 })
  assert(noUsage.inputEstimated && noUsage.outputEstimated && noUsage.inputTokens > 0 && noUsage.outputTokens === 300,
    `a missing usage object must estimate both fields (output = maxTokens), got ${JSON.stringify(noUsage)}`)

  const zeroChars = resolveTokenCounts({ rawUsage: undefined, promptChars: 0, maxTokens: 300 })
  assert(zeroChars.inputTokens >= 1, `an input estimate must never floor to literally zero, got ${JSON.stringify(zeroChars)}`)
}

// --- Part 5: executive-brief (Sonnet) parity ------------------------------

async function testExecutiveBriefExhaustedAllowanceBlocksBeforeAnthropicCall() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'growth' }))
  await recordAiUsage(tenantId, currentUsagePeriod(), { inputTokens: 0, outputTokens: 0, usageUnits: 4_000_000 })
  await installFakeUserRedisAndSeedOwner(tenantId)
  installNeverCalledFetch()
  const res = await postExecutiveBrief(tenantId)
  assert(res.statusCode === 403 && res.body?.error === 'ai_quota_exhausted',
    `a Growth tenant already at its 4,000,000-usage-unit allowance must be blocked before any Anthropic call, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testExecutiveBriefRecordsSonnetWeightedUsage() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'growth' }))
  await installFakeUserRedisAndSeedOwner(tenantId)
  installSuccessFetch({ inputTokens: 400, outputTokens: 150, text: 'An executive briefing.' })
  const res = await postExecutiveBrief(tenantId)
  assert(res.statusCode === 200, `expected a successful briefing, got ${res.statusCode} (${JSON.stringify(res.body)})`)
  const usage = await getAiUsage(tenantId, currentUsagePeriod())
  const expectedUnits = calculateAiUsageUnits({ model: 'claude-sonnet-4-6', inputTokens: 400, outputTokens: 150 })
  assert(usage.usageUnits === expectedUnits, `expected Sonnet-weighted usageUnits ${expectedUnits}, got ${usage.usageUnits}`)
  assert(usage.inputTokens === 400 && usage.outputTokens === 150, `expected raw token counts recorded, got ${JSON.stringify(usage)}`)
  assert(usage.estimatedRequestCount === 0, `a fully valid provider report must not be flagged as estimated, got ${JSON.stringify(usage)}`)
}

// --- Final cost-metering correction: A-C failure-mode matrix (executive-brief) ---

async function testExecutiveBriefNoUsageObjectStillRecordsNonzeroUsage() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'growth' }))
  await installFakeUserRedisAndSeedOwner(tenantId)
  installFetchWithUsage({ usage: undefined, text: 'An executive briefing.' })
  const res = await postExecutiveBrief(tenantId)
  assert(res.statusCode === 200 && res.body.briefing === 'An executive briefing.',
    `(A) the customer must still receive the successful briefing even with no usage object, got ${res.statusCode} (${JSON.stringify(res.body)})`)
  const usage = await getAiUsage(tenantId, currentUsagePeriod())
  assert(usage.usageUnits > 0, `(A) a successful call with no usage object at all must still record NONZERO usageUnits, got ${JSON.stringify(usage)}`)
  assert(usage.estimatedRequestCount === 1, `(A) this request must be flagged as estimated, got ${JSON.stringify(usage)}`)
}

async function testExecutiveBriefMalformedInputTokensStillRecordsNonzeroConservativeUsage() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'growth' }))
  await installFakeUserRedisAndSeedOwner(tenantId)
  installFetchWithUsage({ usage: { input_tokens: null, output_tokens: 150 } })
  const res = await postExecutiveBrief(tenantId)
  assert(res.statusCode === 200, `setup call must succeed, got ${res.statusCode}`)
  const usage = await getAiUsage(tenantId, currentUsagePeriod())
  assert(usage.inputTokens > 0, `(B) a malformed input_tokens must fall back to a nonzero conservative estimate, got ${JSON.stringify(usage)}`)
  assert(usage.outputTokens === 150, `(B) the genuinely valid output_tokens must be preserved exactly, got ${JSON.stringify(usage)}`)
  assert(usage.estimatedRequestCount === 1, `(B) this request must be flagged as estimated, got ${JSON.stringify(usage)}`)
}

async function testExecutiveBriefMalformedOutputTokensStillRecordsNonzeroConservativeUsage() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'growth' }))
  await installFakeUserRedisAndSeedOwner(tenantId)
  installFetchWithUsage({ usage: { input_tokens: 900, output_tokens: 'NaN' } })
  const res = await postExecutiveBrief(tenantId)
  assert(res.statusCode === 200, `setup call must succeed, got ${res.statusCode}`)
  const usage = await getAiUsage(tenantId, currentUsagePeriod())
  assert(usage.inputTokens === 900, `(C) the genuinely valid input_tokens must be preserved exactly, got ${JSON.stringify(usage)}`)
  assert(usage.outputTokens === 400, `(C) the output fallback must be the request's own configured max_tokens (400 for executive-brief), got ${JSON.stringify(usage)}`)
  assert(usage.estimatedRequestCount === 1, `(C) this request must be flagged as estimated, got ${JSON.stringify(usage)}`)
}

// executive-brief needs a real signed session (requireAuth, unlike
// generateRewrite() which is called directly with a bare {tenantId}) --
// mirrors tests/test_ai_tenant_limits.js's own seeding/session pattern.
let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}
function installFakeUserRedisAndSeedOwner(tenantId) {
  const client = fakeConfigRedis() // identical hash+eval shape works fine as a generic fake for userStore too
  setUserRedis(() => client)
  return (async () => {
    const record = { userId: 'usr_owner', email: 'owner@example.com', passwordHash: await passwordHash(), role: 'owner', locationIds: '*', tenantId, sessionVersion: 1, disabled: false, displayName: 'Owner' }
    await upsertUser(tenantId, record, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  })()
}
function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}
async function postExecutiveBrief(tenantId, body = { totalReviews: 5 }) {
  const token = await signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
  const res = fakeRes()
  await executiveBriefHandler({ method: 'POST', body, headers: { cookie: `${SESSION_COOKIE}=${token}` } }, res)
  return res
}

// --- Part 6: Phase A rate limits still apply independently --------------

async function testPhaseARateLimitStillBlocksEvenWithFullAiQuotaAvailable() {
  installFakeConfigRedis()
  installFakeUsageRedis()
  const tenantId = freshTenantId()
  await seedTenant(tenantId, newShapeCommercial({ plan: 'growth' })) // huge allowance, nothing used
  await installFakeUserRedisAndSeedOwner(tenantId)
  // Force the PER-USER rewrite rate limit (30/60s) to report exhausted --
  // every other shape (including the tenant bucket) stays healthy.
  _setLimiterFactoryForTests((requestsPerWindow, windowSeconds) => {
    if (requestsPerWindow === 30 && windowSeconds === 60) return { limit: async () => ({ success: false, remaining: 0 }) }
    return { limit: async () => ({ success: true, remaining: 99 }) }
  })
  installNeverCalledFetch()
  const token = await signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
  const res = fakeRes()
  await rewriteHandler({ method: 'POST', body: { tone: 'friendly', reviewText: 'A fine review.' }, headers: { cookie: `${SESSION_COOKIE}=${token}` } }, res)
  assert(res.statusCode === 429, `Phase A's per-user rate limit must still block independently of AI quota state, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

// --- Part 7: structural guards --------------------------------------------

function testPhaseARateLimitConstantsUnweakened() {
  const src = readFileSync(new URL('../dashboard/api/actions/[action].js', import.meta.url), 'utf8')
  assert(src.includes("`rewrite:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 }"), 'rewrite per-user rate limit must be unchanged')
  assert(src.includes("`rewrite-tenant:${tenantId}`, { requestsPerWindow: 60, windowSeconds: 300 }"), 'rewrite per-tenant rate limit must be unchanged')
  const briefSrc = readFileSync(new URL('../dashboard/api/executive-brief.js', import.meta.url), 'utf8')
  assert(briefSrc.includes("`executive-brief:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 }"), 'executive-brief per-user rate limit must be unchanged')
  assert(briefSrc.includes("`executive-brief-tenant:${account.tenantId}`, { requestsPerWindow: 30, windowSeconds: 600 }"), 'executive-brief per-tenant rate limit must be unchanged')
  const engineSrc = readFileSync(new URL('../dashboard/api/_lib/rewriteEngine.js', import.meta.url), 'utf8')
  assert(engineSrc.includes('MAX_REVIEW_TEXT_CHARS = 4000'), 'rewriteEngine input-size caps must be unchanged')
}

const tests = [
  ['Haiku and Sonnet weighting differs for identical token counts', testHaikuAndSonnetWeightingDiffer],
  ['input and output tokens are weighted differently', testInputAndOutputWeightedDifferently],
  ['malformed/negative token counts safely resolve to 0 usage units', testMalformedTokenCountsTreatedAsZero],
  ['an unrecognized model falls back to the most expensive known weighting', testUnknownModelFallsBackToMostExpensiveWeight],
  ['a versioned weights constant is exported', testWeightsVersionIsExported],

  ['getAiUsage returns zeros for an unseen tenant/period', testGetAiUsageReturnsZerosForUnseenPeriod],
  ['recordAiUsage accumulates atomically across calls', testRecordAiUsageAccumulatesAcrossCalls],
  ['separate tenants have separate usage counters', testSeparateTenantsHaveSeparateCounters],
  ['a month rollover creates an independent period', testMonthRolloverCreatesIndependentPeriod],
  ['currentUsagePeriod() is the UTC calendar month', testCurrentUsagePeriodIsUtcCalendarMonth],
  ['recordAiUsage never throws when the store is not configured', testStoreNotConfiguredNeverThrowsOnRecord],

  ['Core allowance is enforced (allows while under it)', testCoreAllowanceEnforced],
  ['Growth allowance is enforced (allows while under it)', testGrowthAllowanceEnforced],
  ['Trial allowance is enforced (allows while under it)', testTrialAllowanceEnforced],
  ['Enterprise override blocks once its own (tiny) limit is reached', testEnterpriseOverrideEnforced],
  ['Enterprise override allows normal usage under its own (large) limit', testEnterpriseOverrideAllowsUntilItsOwnLimit],
  ['a legacy/unmanaged tenant has no commercial AI allowance enforcement', testLegacyUnmanagedTenantHasNoAiAllowanceEnforcement],
  ['LTA\'s BOOTSTRAP tenant is completely unaffected', testLtaBootstrapTenantUnaffected],
  ['a resolver failure fails closed with zero Anthropic calls', testResolverFailureBlocksWithNoAnthropicRequest],
  ['an exhausted allowance blocks with zero Anthropic calls', testExhaustedAllowanceBlocksWithNoAnthropicRequest],
  ['separate tenants have independent quota decisions', testSeparateTenantsIndependentQuota],
  ['no client-supplied quota/plan field in the request body has any effect', testNoClientSuppliedQuotaFieldHasAnyEffect],

  ['raw token counts and weighted usageUnits are recorded after a successful call (D)', testRawUsageAndUsageUnitsRecordedAfterSuccess],
  ['aiUsageStore.js never references prompt/review/output content fields (F)', testNoPromptOrContentEverStoredInUsageRecord],
  ['a provider failure records no usage (E)', testProviderFailureDoesNotRecordUsage],
  ['resolveTokenCounts() unit behavior: clean/missing/zero-char edge cases', testResolveTokenCountsUnitBehavior],

  ['rewrite (A): no usage object -> success, usageUnits recorded > 0', testRewriteNoUsageObjectStillRecordsNonzeroUsage],
  ['rewrite (B): malformed input_tokens -> nonzero conservative accounting', testRewriteMalformedInputTokensStillRecordsNonzeroConservativeUsage],
  ['rewrite (C): malformed output_tokens -> nonzero conservative accounting', testRewriteMalformedOutputTokensStillRecordsNonzeroConservativeUsage],
  ['rewrite: a genuinely valid zero usage report is accepted, never estimated', testRewriteGenuinelyValidZeroUsageIsAcceptedNeverEstimated],

  ['executive-brief: an exhausted Growth allowance blocks before any Anthropic call', testExecutiveBriefExhaustedAllowanceBlocksBeforeAnthropicCall],
  ['executive-brief (D): Sonnet-weighted usage is recorded exactly after success', testExecutiveBriefRecordsSonnetWeightedUsage],
  ['executive-brief (A): no usage object -> success, usageUnits recorded > 0', testExecutiveBriefNoUsageObjectStillRecordsNonzeroUsage],
  ['executive-brief (B): malformed input_tokens -> nonzero conservative accounting', testExecutiveBriefMalformedInputTokensStillRecordsNonzeroConservativeUsage],
  ['executive-brief (C): malformed output_tokens -> nonzero conservative accounting', testExecutiveBriefMalformedOutputTokensStillRecordsNonzeroConservativeUsage],

  ['Phase A\'s per-user rate limit still blocks independently of AI quota state', testPhaseARateLimitStillBlocksEvenWithFullAiQuotaAvailable],

  ['Phase A rate-limit/input-cap constants are unweakened by this phase', testPhaseARateLimitConstantsUnweakened],
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
