// "Tenant-level AI safety circuit breaker" hardening (final pre-deploy
// review, item 1): regression tests for the tenant-scoped rate limits added
// to dashboard/api/executive-brief.js and dashboard/api/actions/[action].js's
// 'rewrite' action, ON TOP OF (never replacing) their existing per-user
// limits. Drives the real HTTP handlers with two genuinely separate
// tenants, each with its own Redis-backed Owner account and an active
// tenant_config (so a wildcard-role account is treated as wildcard for
// location purposes -- see tenants.js's tenantOwnsLocationCatalog()).
//
// Run directly: node tests/test_ai_tenant_limits.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests'

import bcrypt from 'bcryptjs'
import executiveBriefHandler from '../dashboard/api/executive-brief.js'
import actionsHandler from '../dashboard/api/actions/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import {
  upsertTenantConfig,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import {
  upsertUser, UserCreationMode,
  _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis,
} from '../dashboard/api/_lib/userStore.js'
import { _setLimiterFactoryForTests, _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'

function rewriteHandler(req, res) { return actionsHandler({ ...req, query: { ...req.query, action: 'rewrite' } }, res) }

const TENANT_A = 't_ai-limit-tenant-a'
const TENANT_B = 't_ai-limit-tenant-b'

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
    _resetLimiterFactoryForTests()
  }
}

function fakeRedisWithEval() {
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
        try { const decoded = JSON.parse(raw); if (decoded && decoded.configVersion !== undefined) currentVersion = String(decoded.configVersion) } catch { /* treat as version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
  }
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

// IMPORTANT: the client must be constructed ONCE and the factory must
// return that SAME instance every time -- _setRedisClientForTests's
// factory is invoked fresh on every getClient() call, so a factory that
// constructs a new store inline (`() => fakeRedisWithEval()`) would
// silently hand back an empty store on every read, discarding whatever a
// prior write wrote.
function wireConfigRedis() {
  const client = fakeRedisWithEval()
  setConfigRedis(() => client)
  return client
}
function wireUserRedis() {
  const client = fakeRedisWithEval()
  setUserRedis(() => client)
  return client
}

// Two fully independent tenants, each with one Owner account and an ACTIVE
// tenant_config (locationCatalogEnabled: true) -- required so a wildcard-role
// account is genuinely treated as wildcard by tenants.js's
// tenantOwnsLocationCatalog(), letting rewrite() skip its own location check
// cleanly (matching how a real Owner account behaves once provisioned).
async function seedTenant(tenantId, userId, email) {
  await upsertTenantConfig(tenantId, { status: 'active', locationCatalogEnabled: true }, { allowCreate: true, creationSource: 'migration' })
  const record = { userId, email, passwordHash: await passwordHash(), role: 'owner', locationIds: '*', tenantId, sessionVersion: 1, disabled: false, displayName: userId }
  await upsertUser(tenantId, record, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
}

function tokenFor(tenantId, userId, email) {
  return signSession({ userId, email, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
}

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}

// Simulates a REAL per-identifier sliding-window limiter (a plain counter,
// no actual time-windowing needed for these deterministic tests), but ONLY
// for calls matching `tenantShape` -- every OTHER shape (in practice, the
// existing PER-USER limiter, which shares the same enforceRateLimit()
// helper) always succeeds. This isolates the TENANT bucket specifically:
// without it, repeatedly calling as the SAME single user to exhaust the
// tenant bucket would also exhaust that user's own, separate per-user
// bucket at the same time, leaving it ambiguous which limit actually did
// the blocking.
function makeTenantOnlyCountingLimiterFactory(tenantShape) {
  const counts = new Map()
  return (requestsPerWindow, windowSeconds) => {
    if (requestsPerWindow !== tenantShape.requestsPerWindow || windowSeconds !== tenantShape.windowSeconds) {
      return { limit: async () => ({ success: true, remaining: 99 }) }
    }
    return {
      limit: async (identifier) => {
        const n = (counts.get(identifier) ?? 0) + 1
        counts.set(identifier, n)
        return { success: n <= requestsPerWindow, remaining: Math.max(0, requestsPerWindow - n) }
      },
    }
  }
}

async function postExecutiveBrief(token) {
  const resolvedToken = await token // tokenFor() returns a Promise (signSession is async) -- await it here so every call site can pass it directly
  const res = fakeRes()
  await executiveBriefHandler({ method: 'POST', body: { totalReviews: 5 }, headers: { cookie: `${SESSION_COOKIE}=${resolvedToken}` } }, res)
  return res
}

async function postRewrite(token) {
  const resolvedToken = await token
  const res = fakeRes()
  await rewriteHandler({ method: 'POST', body: { tone: 'friendly', reviewText: 'A fine review.' }, headers: { cookie: `${SESSION_COOKIE}=${resolvedToken}` } }, res)
  return res
}

function installSuccessFetch() {
  let calls = 0
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ content: [{ text: 'ok' }] }) } }
  return () => calls
}
function installNeverCalledFetch() {
  globalThis.fetch = async (url) => { throw new Error(`Anthropic must not be called, but fetch was invoked for: ${url}`) }
}

// --- executive-brief (Sonnet) ------------------------------------------------

async function testExecBriefTenantBucketBlocksSecondUserSameTenant() {
  wireConfigRedis()
  wireUserRedis()
  await seedTenant(TENANT_A, 'usr_a1', 'a1@example.com')
  await seedTenant(TENANT_A, 'usr_a2', 'a2@example.com')
  // Tenant-wide executive-brief budget is 30/10min -- deny it directly so
  // this test doesn't need 30 real round trips to prove the point.
  _setLimiterFactoryForTests((requestsPerWindow, windowSeconds) => {
    if (requestsPerWindow === 30 && windowSeconds === 600) return { limit: async () => ({ success: false, remaining: 0 }) }
    return { limit: async () => ({ success: true, remaining: 99 }) } // per-user bucket stays untouched/healthy
  })
  installNeverCalledFetch()
  const resB = await postExecutiveBrief(tokenFor(TENANT_A, 'usr_a2', 'a2@example.com'))
  assert(resB.statusCode === 429, `User B must be blocked by the exhausted TENANT bucket even though their own per-user bucket is fresh, got ${resB.statusCode} (${JSON.stringify(resB.body)})`)
}

async function testExecBriefTenantBucketIndependentAcrossTenants() {
  wireConfigRedis()
  wireUserRedis()
  await seedTenant(TENANT_A, 'usr_a1', 'a1@example.com')
  await seedTenant(TENANT_B, 'usr_b1', 'b1@example.com')
  _setLimiterFactoryForTests(makeTenantOnlyCountingLimiterFactory({ requestsPerWindow: 30, windowSeconds: 600 }))
  const getCalls = installSuccessFetch()
  // Exhaust Tenant A's 30-request tenant bucket.
  for (let i = 0; i < 30; i++) {
    const r = await postExecutiveBrief(tokenFor(TENANT_A, 'usr_a1', 'a1@example.com'))
    assert(r.statusCode === 200, `setup call ${i} for Tenant A must succeed, got ${r.statusCode}`)
  }
  const blockedA = await postExecutiveBrief(tokenFor(TENANT_A, 'usr_a1', 'a1@example.com'))
  assert(blockedA.statusCode === 429, `Tenant A must now be blocked by its own exhausted tenant bucket, got ${blockedA.statusCode}`)
  // Tenant B, wholly unrelated, must be completely unaffected.
  const okB = await postExecutiveBrief(tokenFor(TENANT_B, 'usr_b1', 'b1@example.com'))
  assert(okB.statusCode === 200, `Tenant B must have its own independent allowance, unaffected by Tenant A's exhaustion, got ${okB.statusCode} (${JSON.stringify(okB.body)})`)
  assert(getCalls() === 31, `expected exactly 31 real Anthropic calls (30 for Tenant A + 1 for Tenant B), got ${getCalls()}`)
}

async function testExecBrief429HappensBeforeAnthropicFetch() {
  wireConfigRedis()
  wireUserRedis()
  await seedTenant(TENANT_A, 'usr_a1', 'a1@example.com')
  _setLimiterFactoryForTests((requestsPerWindow, windowSeconds) => {
    if (requestsPerWindow === 30 && windowSeconds === 600) return { limit: async () => ({ success: false, remaining: 0 }) }
    return { limit: async () => ({ success: true, remaining: 99 }) }
  })
  installNeverCalledFetch() // throws if Anthropic is ever called
  const res = await postExecutiveBrief(tokenFor(TENANT_A, 'usr_a1', 'a1@example.com'))
  assert(res.statusCode === 429, `expected 429 before any Anthropic call, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testExecBriefOversizedInputStill400RegardlessOfTenantLimiter() {
  wireConfigRedis()
  wireUserRedis()
  await seedTenant(TENANT_A, 'usr_a1', 'a1@example.com')
  // Tenant bucket is healthy/untouched here -- the 400 must come from the
  // input-size cap (Phase A4), not be confused with (or masked by) the
  // tenant limiter.
  installNeverCalledFetch()
  const res = fakeRes()
  const token = await tokenFor(TENANT_A, 'usr_a1', 'a1@example.com')
  await executiveBriefHandler({
    method: 'POST', body: { totalReviews: 5, topComplaint: 'x'.repeat(2000) },
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  }, res)
  assert(res.statusCode === 400, `an oversized field must still be rejected 400, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

// --- rewrite (Haiku) ----------------------------------------------------------

async function testRewriteTenantBucketBlocksSecondUserSameTenant() {
  wireConfigRedis()
  wireUserRedis()
  await seedTenant(TENANT_A, 'usr_a1', 'a1@example.com')
  await seedTenant(TENANT_A, 'usr_a2', 'a2@example.com')
  _setLimiterFactoryForTests((requestsPerWindow, windowSeconds) => {
    if (requestsPerWindow === 60 && windowSeconds === 300) return { limit: async () => ({ success: false, remaining: 0 }) }
    return { limit: async () => ({ success: true, remaining: 99 }) }
  })
  installNeverCalledFetch()
  const resB = await postRewrite(tokenFor(TENANT_A, 'usr_a2', 'a2@example.com'))
  assert(resB.statusCode === 429, `User B must be blocked by the exhausted TENANT bucket despite an untouched personal bucket, got ${resB.statusCode} (${JSON.stringify(resB.body)})`)
}

async function testRewriteTenantBucketIndependentAcrossTenants() {
  wireConfigRedis()
  wireUserRedis()
  await seedTenant(TENANT_A, 'usr_a1', 'a1@example.com')
  await seedTenant(TENANT_B, 'usr_b1', 'b1@example.com')
  _setLimiterFactoryForTests(makeTenantOnlyCountingLimiterFactory({ requestsPerWindow: 60, windowSeconds: 300 }))
  installSuccessFetch()
  for (let i = 0; i < 60; i++) {
    const r = await postRewrite(tokenFor(TENANT_A, 'usr_a1', 'a1@example.com'))
    assert(r.statusCode === 200, `setup call ${i} for Tenant A must succeed, got ${r.statusCode}`)
  }
  const blockedA = await postRewrite(tokenFor(TENANT_A, 'usr_a1', 'a1@example.com'))
  assert(blockedA.statusCode === 429, `Tenant A must now be blocked, got ${blockedA.statusCode}`)
  const okB = await postRewrite(tokenFor(TENANT_B, 'usr_b1', 'b1@example.com'))
  assert(okB.statusCode === 200, `Tenant B must have its own independent allowance, got ${okB.statusCode} (${JSON.stringify(okB.body)})`)
}

async function testRewrite429HappensBeforeAnthropicFetch() {
  wireConfigRedis()
  wireUserRedis()
  await seedTenant(TENANT_A, 'usr_a1', 'a1@example.com')
  _setLimiterFactoryForTests((requestsPerWindow, windowSeconds) => {
    if (requestsPerWindow === 60 && windowSeconds === 300) return { limit: async () => ({ success: false, remaining: 0 }) }
    return { limit: async () => ({ success: true, remaining: 99 }) }
  })
  installNeverCalledFetch()
  const res = await postRewrite(tokenFor(TENANT_A, 'usr_a1', 'a1@example.com'))
  assert(res.statusCode === 429, `expected 429 before any Anthropic call, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function main() {
  await run('executive-brief: tenant bucket blocks a second user in the same tenant (their own bucket untouched)', testExecBriefTenantBucketBlocksSecondUserSameTenant)
  await run('executive-brief: tenant bucket is independent across tenants', testExecBriefTenantBucketIndependentAcrossTenants)
  await run('executive-brief: 429 happens before any Anthropic fetch', testExecBrief429HappensBeforeAnthropicFetch)
  await run('executive-brief: oversized input still 400s regardless of tenant limiter state', testExecBriefOversizedInputStill400RegardlessOfTenantLimiter)

  await run('rewrite: tenant bucket blocks a second user in the same tenant (their own bucket untouched)', testRewriteTenantBucketBlocksSecondUserSameTenant)
  await run('rewrite: tenant bucket is independent across tenants', testRewriteTenantBucketIndependentAcrossTenants)
  await run('rewrite: 429 happens before any Anthropic fetch', testRewrite429HappensBeforeAnthropicFetch)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
