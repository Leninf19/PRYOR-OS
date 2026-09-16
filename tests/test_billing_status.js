// Phase B.13 -- regression tests for GET /api/session?action=billing-status
// (billingStatusAction()). Owner-only, READ-ONLY safe projection of
// canonical commercial cancellation/suspension state. No real Stripe API, no
// real Redis -- fake clients injected via each module's own test-injection
// seam, exactly like every other B.10-B.13 test file.
//
// Run directly: node tests/test_billing_status.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import handler from '../dashboard/api/session/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import {
  _setRedisClientForTests as setBillingClient, _resetRedisClientForTests as resetBillingClient,
  createBillingRecord, getBillingRecord,
} from '../dashboard/api/_lib/billingStore.js'
import {
  upsertUser, UserCreationMode,
  _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis,
} from '../dashboard/api/_lib/userStore.js'
import {
  upsertTenantConfig, getTenantConfig, recordLocationApproval,
  _setRedisClientForTests as setConfigClient, _resetRedisClientForTests as resetConfigClient,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import { _resetLimiterFactoryForTests, _setLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'

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
    resetBillingClient(); resetUserRedis(); resetConfigClient(); _resetLimiterFactoryForTests()
  }
}

function fakeBillingRedis() {
  const hashes = {}
  return {
    hget: async (key, field) => hashes[key]?.[field] ?? null,
    hset: async (key, fields) => { hashes[key] = { ...(hashes[key] ?? {}), ...fields } },
    hsetnx: async (key, field, value) => {
      hashes[key] = hashes[key] ?? {}
      if (field in hashes[key]) return false
      hashes[key][field] = value
      return true
    },
    get: async () => null,
    set: async () => 'OK',
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [field, expectedVersionStr, nextJson] = args
      const raw = hashes[key]?.[field] ?? null
      let currentVersion = '0'
      if (raw) { try { const d = JSON.parse(raw); if (d?.version !== undefined) currentVersion = String(d.version) } catch { /* 0 */ } }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      hashes[key] = { ...(hashes[key] ?? {}), [field]: nextJson }
      return true
    },
  }
}

function fakeUserRedis() {
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
      if (raw) { try { const decoded = JSON.parse(raw); if (decoded?.configVersion !== undefined) currentVersion = String(decoded.configVersion) } catch { /* 0 */ } }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
  }
}

function install() {
  const billingRedis = fakeBillingRedis()
  const userRedis = fakeUserRedis()
  const configRedis = fakeUserRedis() // identical generic keyed-hash shape works for tenantConfigStore.js too
  setBillingClient(() => billingRedis)
  setUserRedis(() => userRedis)
  setConfigClient(() => configRedis)
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: true, remaining: 99 }) }))
}

let tenantCounter = 0
function freshTenantId() { return `t_billingstatus-${++tenantCounter}` }

async function seedOwnerSession(tenantId, { role = 'owner' } = {}) {
  await upsertTenantConfig(tenantId, { status: 'onboarding', locationCatalogEnabled: true }, { allowCreate: true, creationSource: 'migration' })
  await recordLocationApproval(tenantId, [{ googleLocationId: `accounts/acc-${tenantId}/locations/loc-1`, title: 'Primary Location', address: '' }])
  const record = { userId: `usr_${role}_${tenantId}`, email: `${role}-${tenantId}@example.com`, role, locationIds: '*', tenantId, sessionVersion: 1, disabled: false, displayName: 'Test User' }
  await upsertUser(tenantId, { ...record, passwordHash: 'x' }, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  return signSession({ userId: record.userId, email: record.email, role, locationIds: '*', tenantId, sessionVersion: 1 })
}

// Mirrors test_stripe_webhook.js's own seedCommercialTenantConfig() -- a
// tenant already sitting in a given commercial state (active/suspended/
// canceled, with or without a pending cancellation), needed since this
// endpoint's whole purpose is projecting exactly these fields.
// Must be called AFTER seedOwnerSession() has already created the tenant
// (status: 'onboarding') -- this only layers the commercial state on top,
// finishing with status: 'active' so it is the last write to `status`.
async function seedCommercialConfig(tenantId, {
  commercialStatus = 'active', plan = 'growth', suspension = null, cancellation = null,
  trialStartedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
} = {}) {
  const trialEndsAt = new Date(Date.parse(trialStartedAt) + 7 * 24 * 60 * 60 * 1000).toISOString()
  await upsertTenantConfig(tenantId, {
    status: 'active',
    commercial: {
      commercialStatus, plan, planSource: 'stripe_subscription_active',
      trial: { status: 'active', startedAt: trialStartedAt, endsAt: trialEndsAt, consumedAt: trialStartedAt },
      limitsOverride: null, suspension, cancellation, overLimit: null,
      accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null,
      createdAt: trialStartedAt, updatedAt: trialStartedAt,
    },
    trialEligibility: { eligible: true, markedAt: trialStartedAt, source: 'test_fixture' },
  }, {})
}

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}

async function invokeBillingStatus({ token } = {}) {
  const req = {
    method: 'GET', query: { action: 'billing-status' },
    headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

// ===========================================================================
// 1/2 -- owner can read; non-owner cannot.
// ===========================================================================

async function testOwnerCanReadBillingStatus() {
  install()
  const tenantId = freshTenantId()
  const token = await seedOwnerSession(tenantId)
  await seedCommercialConfig(tenantId, { commercialStatus: 'trial', plan: 'growth' })
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_owner1', stripeSubscriptionId: 'sub_owner1', subscriptionStatus: 'trialing' })
  const res = await invokeBillingStatus({ token })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.plan === 'growth')
  assert(res.body.commercialStatus === 'trial')
  assert(res.body.stripeStatus === 'trialing')
  assert(res.body.subscriptionPresent === true)
}

async function testNonOwnerIsRejected() {
  install()
  const tenantId = freshTenantId()
  const token = await seedOwnerSession(tenantId, { role: 'location_manager' })
  await seedCommercialConfig(tenantId, { commercialStatus: 'active' })
  const res = await invokeBillingStatus({ token })
  assert(res.statusCode === 403, `a non-owner must be rejected, got ${res.statusCode}`)
}

// ===========================================================================
// 3/4 -- cancellation shape.
// ===========================================================================

async function testCancellationPendingShapeReturnedExactly() {
  install()
  const tenantId = freshTenantId()
  const requestedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const effectiveAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
  const token = await seedOwnerSession(tenantId)
  await seedCommercialConfig(tenantId, {
    commercialStatus: 'active',
    cancellation: { status: 'pending_at_period_end', requestedAt, effectiveAt },
  })
  const res = await invokeBillingStatus({ token })
  assert(res.statusCode === 200)
  assert(res.body.cancellation !== null, 'a pending cancellation must never serialize as null')
  assert(res.body.cancellation.status === 'pending_at_period_end')
  assert(res.body.cancellation.requestedAt === requestedAt)
  assert(res.body.cancellation.effectiveAt === effectiveAt)
}

async function testCancellationNullReturnsNull() {
  install()
  const tenantId = freshTenantId()
  const token = await seedOwnerSession(tenantId)
  await seedCommercialConfig(tenantId, { commercialStatus: 'active', cancellation: null })
  const res = await invokeBillingStatus({ token })
  assert(res.statusCode === 200)
  assert(res.body.cancellation === null, 'no cancellation must serialize as null, never omitted or invented')
}

// ===========================================================================
// 5 -- suspension safe shape.
// ===========================================================================

async function testSuspensionSafeShapeReturned() {
  install()
  const tenantId = freshTenantId()
  const suspendedAt = new Date().toISOString()
  const token = await seedOwnerSession(tenantId)
  await seedCommercialConfig(tenantId, {
    commercialStatus: 'suspended',
    suspension: { reason: 'stripe_unpaid_terminal', suspendedAt },
  })
  const res = await invokeBillingStatus({ token })
  assert(res.statusCode === 200)
  assert(res.body.suspension !== null)
  assert(res.body.suspension.reason === 'stripe_unpaid_terminal')
  assert(res.body.suspension.suspendedAt === suspendedAt)
}

// ===========================================================================
// 6 -- no raw billing/customer/subscription/secret leakage.
// ===========================================================================

async function testNoRawIdentifiersOrSecretsLeak() {
  install()
  const tenantId = freshTenantId()
  const token = await seedOwnerSession(tenantId)
  await seedCommercialConfig(tenantId, { commercialStatus: 'active' })
  await createBillingRecord(tenantId, {
    stripeCustomerId: 'cus_secretcheck1', stripeSubscriptionId: 'sub_secretcheck1',
    defaultPaymentMethodId: 'pm_secretcheck1', subscriptionStatus: 'active',
  })
  const res = await invokeBillingStatus({ token })
  assert(res.statusCode === 200)
  const serialized = JSON.stringify(res.body)
  assert(!serialized.includes('cus_secretcheck1'), 'the Stripe customer id must never appear in the billing-status response')
  assert(!serialized.includes('sub_secretcheck1'), 'the Stripe subscription id must never appear in the billing-status response')
  assert(!serialized.includes('pm_secretcheck1'), 'the default payment method id must never appear in the billing-status response')
  assert(res.body.subscriptionPresent === true, 'subscriptionPresent must still report true without exposing the raw id')
}

// ===========================================================================
// 7 -- store unavailable fails safely (never a raw record, never a 200).
// ===========================================================================

async function testStoreUnavailableFailsSafely() {
  install()
  const tenantId = freshTenantId()
  const token = await seedOwnerSession(tenantId)
  await seedCommercialConfig(tenantId, { commercialStatus: 'trial' })
  resetBillingClient() // simulate a billing-store outage for the read itself, auth/config remain healthy
  const res = await invokeBillingStatus({ token })
  assert(res.statusCode === 503 && res.body.error === 'service_unavailable', `expected 503 service_unavailable, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// ===========================================================================
// 8 -- the endpoint performs no mutation of any kind.
// ===========================================================================

async function testEndpointPerformsNoMutation() {
  install()
  const tenantId = freshTenantId()
  const token = await seedOwnerSession(tenantId)
  await seedCommercialConfig(tenantId, { commercialStatus: 'active' })
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_nomutate1', stripeSubscriptionId: 'sub_nomutate1', subscriptionStatus: 'active' })

  const beforeConfig = await getTenantConfig(tenantId)
  const beforeRecord = await getBillingRecord(tenantId)

  const res = await invokeBillingStatus({ token })
  assert(res.statusCode === 200)

  const afterConfig = await getTenantConfig(tenantId)
  const afterRecord = await getBillingRecord(tenantId)
  assert(afterConfig.configVersion === beforeConfig.configVersion, 'billing-status must never write tenant_config')
  assert(afterRecord.version === beforeRecord.version, 'billing-status must never write billing:v1')
}

const tests = [
  ['an owner can read billing-status', testOwnerCanReadBillingStatus],
  ['a non-owner is rejected', testNonOwnerIsRejected],
  ['a pending cancellation returns the exact canonical shape', testCancellationPendingShapeReturnedExactly],
  ['no cancellation returns null', testCancellationNullReturnsNull],
  ['a suspension returns the exact safe shape', testSuspensionSafeShapeReturned],
  ['no raw billing identifiers/secrets leak', testNoRawIdentifiersOrSecretsLeak],
  ['a billing-store outage fails safely', testStoreUnavailableFailsSafely],
  ['the endpoint performs no mutation', testEndpointPerformsNoMutation],
]

async function main() {
  for (const [name, fn] of tests) await run(name, fn)
  const failed = results.filter(r => !r).length
  if (failed > 0) {
    console.log(`\n${failed} of ${tests.length} TESTS FAILED`)
    process.exit(1)
  }
  console.log(`\nALL ${tests.length} TESTS PASSED`)
}

main()
