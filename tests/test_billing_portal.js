// Phase B.13 -- regression tests for POST /api/session?action=billing-portal-session
// (createBillingPortalSession()/billingPortalSessionAction()). No real
// Stripe API, no real Redis -- fake clients injected via each module's own
// test-injection seam, exactly like every other B.10-B.13 test file.
//
// Run directly: node tests/test_billing_portal.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import handler from '../dashboard/api/session/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import {
  _setRedisClientForTests as setBillingClient, _resetRedisClientForTests as resetBillingClient,
  createBillingRecord,
} from '../dashboard/api/_lib/billingStore.js'
import { _setStripeClientForTests, _resetStripeClientForTests } from '../dashboard/api/_lib/stripeClient.js'
import {
  upsertUser, UserCreationMode,
  _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis,
} from '../dashboard/api/_lib/userStore.js'
import {
  upsertTenantConfig, recordLocationApproval,
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
    resetBillingClient(); _resetStripeClientForTests(); resetUserRedis(); resetConfigClient(); _resetLimiterFactoryForTests()
    delete process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID
    delete process.env.DASHBOARD_BASE_URL
  }
}

const CONFIGURATION_ID = 'bpc_test_configuration_1'

function validPortalConfiguration({ featureOverrides = {}, loginPage = { enabled: false }, active = true } = {}) {
  return {
    id: CONFIGURATION_ID,
    active,
    login_page: loginPage,
    features: {
      subscription_update: { enabled: false },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      customer_update: { enabled: false },
      ...featureOverrides,
    },
  }
}

function fakePortalStripe({ configuration = validPortalConfiguration() } = {}) {
  const sessionCreateCalls = []
  const configRetrieveCalls = []
  return {
    billingPortal: {
      configurations: {
        retrieve: async (id) => { configRetrieveCalls.push(id); return configuration },
      },
      sessions: {
        create: async (params) => { sessionCreateCalls.push(params); return { id: 'bps_test1', url: 'https://billing.stripe.com/session/test1' } },
      },
    },
    _sessionCreateCalls: sessionCreateCalls,
    _configRetrieveCalls: configRetrieveCalls,
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

function install({ configuration } = {}) {
  const billingRedis = fakeBillingRedis()
  const userRedis = fakeUserRedis()
  const configRedis = fakeUserRedis() // identical generic keyed-hash shape works for tenantConfigStore.js too
  const stripe = fakePortalStripe({ configuration })
  setBillingClient(() => billingRedis)
  setUserRedis(() => userRedis)
  setConfigClient(() => configRedis)
  _setStripeClientForTests(() => stripe)
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: true, remaining: 99 }) }))
  process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID = CONFIGURATION_ID
  process.env.DASHBOARD_BASE_URL = 'https://app.example.com'
  return { stripe }
}

let tenantCounter = 0
function freshTenantId() { return `t_portal-${++tenantCounter}` }

async function seedOwnerSession(tenantId, { role = 'owner' } = {}) {
  await upsertTenantConfig(tenantId, { status: 'onboarding', locationCatalogEnabled: true }, { allowCreate: true, creationSource: 'migration' })
  await recordLocationApproval(tenantId, [{ googleLocationId: `accounts/acc-${tenantId}/locations/loc-1`, title: 'Primary Location', address: '' }])
  const record = { userId: `usr_${role}_${tenantId}`, email: `${role}-${tenantId}@example.com`, role, locationIds: '*', tenantId, sessionVersion: 1, disabled: false, displayName: 'Test User' }
  await upsertUser(tenantId, { ...record, passwordHash: 'x' }, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  return signSession({ userId: record.userId, email: record.email, role, locationIds: '*', tenantId, sessionVersion: 1 })
}

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}

async function invokePortalSession({ token, extraBodyFields = {} } = {}) {
  const req = {
    method: 'POST', query: { action: 'billing-portal-session' },
    headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
    body: { ...extraBodyFields },
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

// ===========================================================================
// 1/2 -- owner creates a portal session; non-owner is rejected.
// ===========================================================================

async function testOwnerCreatesPortalSession() {
  install()
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_owner1', stripeSubscriptionId: 'sub_owner1' })
  const token = await seedOwnerSession(tenantId)
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(typeof res.body.url === 'string' && res.body.url.length > 0)
}

async function testNonOwnerIsRejected() {
  install()
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_nonowner1', stripeSubscriptionId: 'sub_nonowner1' })
  const token = await seedOwnerSession(tenantId, { role: 'location_manager' })
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 403, `a non-owner must be rejected, got ${res.statusCode}`)
}

// ===========================================================================
// 3-6 -- forged identifiers/return URL are structurally impossible to
// inject -- the action reads NOTHING from the request body at all.
// ===========================================================================

async function testForgedCustomerIdIgnored() {
  const { stripe } = install()
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_realforged1', stripeSubscriptionId: 'sub_realforged1' })
  const token = await seedOwnerSession(tenantId)
  await invokePortalSession({ token, extraBodyFields: { customerId: 'cus_attacker1', stripeCustomerId: 'cus_attacker1' } })
  assert(stripe._sessionCreateCalls[0].customer === 'cus_realforged1', 'the forged customerId must have zero effect -- only the tenant\'s own billing:v1 customer is ever used')
}

async function testForgedSubscriptionIdIgnored() {
  const { stripe } = install()
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_subforged1', stripeSubscriptionId: 'sub_realforged2' })
  const token = await seedOwnerSession(tenantId)
  await invokePortalSession({ token, extraBodyFields: { subscriptionId: 'sub_attacker1', stripeSubscriptionId: 'sub_attacker1' } })
  // There is no `subscription` param on stripe.billingPortal.sessions.create()
  // at all -- Stripe derives the subscription from the Customer itself.
  // This assertion proves the forged field was never even read.
  assert(stripe._sessionCreateCalls[0].subscription === undefined, 'no subscriptionId parameter exists on the Portal Session call for a forged value to occupy')
  assert(stripe._sessionCreateCalls[0].customer === 'cus_subforged1')
}

async function testForgedConfigurationIdIgnored() {
  const { stripe } = install()
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_configforged1', stripeSubscriptionId: 'sub_configforged1' })
  const token = await seedOwnerSession(tenantId)
  await invokePortalSession({ token, extraBodyFields: { configurationId: 'bpc_attacker1', configuration: 'bpc_attacker1' } })
  assert(stripe._configRetrieveCalls[0] === CONFIGURATION_ID, 'only the pinned STRIPE_BILLING_PORTAL_CONFIGURATION_ID is ever retrieved/used')
  assert(stripe._sessionCreateCalls[0].configuration === CONFIGURATION_ID)
}

async function testForgedReturnUrlIgnored() {
  const { stripe } = install()
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_urlforged1', stripeSubscriptionId: 'sub_urlforged1' })
  const token = await seedOwnerSession(tenantId)
  await invokePortalSession({ token, extraBodyFields: { returnUrl: 'https://evil.example.com/steal', return_url: 'https://evil.example.com/steal' } })
  const call = stripe._sessionCreateCalls[0]
  assert(call.return_url.startsWith('https://app.example.com/'), 'return_url must always be the server-built one')
  assert(!JSON.stringify(call).includes('evil.example.com'), 'the attacker-supplied domain must never appear anywhere in the Portal Session params')
}

// ===========================================================================
// 7/8 -- missing billing customer/subscription fails closed.
// ===========================================================================

async function testMissingBillingCustomerFailsClosed() {
  install()
  const tenantId = freshTenantId()
  const token = await seedOwnerSession(tenantId)
  // No billing record created at all.
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 409 && res.body.error === 'billing_not_ready')
}

async function testMissingSubscriptionFailsClosed() {
  install()
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_nosub1' }) // no stripeSubscriptionId
  const token = await seedOwnerSession(tenantId)
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 409 && res.body.error === 'billing_not_ready')
}

// ===========================================================================
// 9 -- missing Portal config env fails closed.
// ===========================================================================

async function testMissingPortalConfigEnvFailsClosed() {
  install()
  delete process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_noenv1', stripeSubscriptionId: 'sub_noenv1' })
  const token = await seedOwnerSession(tenantId)
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 503 && res.body.error === 'portal_not_configured')
}

// ===========================================================================
// 10-13 -- a live Portal Configuration that does not match the exact
// reviewed B.13 policy fails closed -- checked fresh on every call, never
// cached/assumed.
// ===========================================================================

async function testSubscriptionUpdateEnabledFailsClosed() {
  install({ configuration: validPortalConfiguration({ featureOverrides: { subscription_update: { enabled: true } } }) })
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_badconfig1', stripeSubscriptionId: 'sub_badconfig1' })
  const token = await seedOwnerSession(tenantId)
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 503 && res.body.error === 'portal_not_configured', 'subscription_update.enabled=true must fail closed -- it would let a customer change Core<->Growth via the Portal')
}

async function testImmediateCancelModeFailsClosed() {
  install({ configuration: validPortalConfiguration({ featureOverrides: { subscription_cancel: { enabled: true, mode: 'immediately' } } }) })
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_badcancel1', stripeSubscriptionId: 'sub_badcancel1' })
  const token = await seedOwnerSession(tenantId)
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 503 && res.body.error === 'portal_not_configured', 'subscription_cancel.mode=immediately must fail closed -- B.13 requires at_period_end')
}

async function testDisabledPaymentMethodUpdateFailsClosed() {
  install({ configuration: validPortalConfiguration({ featureOverrides: { payment_method_update: { enabled: false } } }) })
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_badpm1', stripeSubscriptionId: 'sub_badpm1' })
  const token = await seedOwnerSession(tenantId)
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 503 && res.body.error === 'portal_not_configured')
}

async function testDisabledInvoiceHistoryFailsClosed() {
  install({ configuration: validPortalConfiguration({ featureOverrides: { invoice_history: { enabled: false } } }) })
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_badinv1', stripeSubscriptionId: 'sub_badinv1' })
  const token = await seedOwnerSession(tenantId)
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 503 && res.body.error === 'portal_not_configured')
}

// ===========================================================================
// Hardening patch -- login_page.enabled must be exactly false.
// ===========================================================================

async function testLoginPageEnabledFailsClosed() {
  install({ configuration: validPortalConfiguration({ loginPage: { enabled: true } }) })
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_loginpage1', stripeSubscriptionId: 'sub_loginpage1' })
  const token = await seedOwnerSession(tenantId)
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 503 && res.body.error === 'portal_not_configured', 'login_page.enabled=true must fail closed -- it creates a Stripe-hosted entry path that bypasses PRYOR\'s owner-only session authorization')
}

async function testMissingLoginPageFieldFailsClosed() {
  // A configuration whose login_page field is entirely absent (never
  // explicitly disabled) must ALSO fail closed -- this is deliberately not
  // a `!== true` check, which would silently accept undefined.
  const configuration = validPortalConfiguration()
  delete configuration.login_page
  install({ configuration })
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_loginpagemissing1', stripeSubscriptionId: 'sub_loginpagemissing1' })
  const token = await seedOwnerSession(tenantId)
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 503 && res.body.error === 'portal_not_configured', 'a missing login_page field must fail closed, never be treated as implicitly disabled')
}

async function testLoginPageDisabledIsPermittedWithOtherValidPolicy() {
  const { stripe } = install({ configuration: validPortalConfiguration({ loginPage: { enabled: false } }) })
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_loginpageok1', stripeSubscriptionId: 'sub_loginpageok1' })
  const token = await seedOwnerSession(tenantId)
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 200, `login_page.enabled=false with all other valid policy fields must succeed, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(stripe._sessionCreateCalls.length === 1)
}

// ===========================================================================
// Hardening patch -- features.customer_update.enabled must be exactly false.
// ===========================================================================

async function testCustomerUpdateEnabledFailsClosed() {
  install({ configuration: validPortalConfiguration({ featureOverrides: { customer_update: { enabled: true } } }) })
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_customerupdate1', stripeSubscriptionId: 'sub_customerupdate1' })
  const token = await seedOwnerSession(tenantId)
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 503 && res.body.error === 'portal_not_configured', 'customer_update.enabled=true must fail closed -- generic customer-profile editing is not an approved B.13 Portal capability')
}

// ===========================================================================
// Optional defense-in-depth -- configuration.active must be true when present.
// ===========================================================================

async function testInactiveConfigurationFailsClosed() {
  install({ configuration: validPortalConfiguration({ active: false }) })
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_inactive1', stripeSubscriptionId: 'sub_inactive1' })
  const token = await seedOwnerSession(tenantId)
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 503 && res.body.error === 'portal_not_configured', 'an inactive pinned Portal configuration must fail closed before attempting session creation')
}

// ===========================================================================
// 14 -- the correct, reviewed Portal config succeeds.
// ===========================================================================

async function testCorrectReviewedConfigSucceeds() {
  const { stripe } = install({ configuration: validPortalConfiguration() })
  const tenantId = freshTenantId()
  await createBillingRecord(tenantId, { stripeCustomerId: 'cus_goodconfig1', stripeSubscriptionId: 'sub_goodconfig1' })
  const token = await seedOwnerSession(tenantId)
  const res = await invokePortalSession({ token })
  assert(res.statusCode === 200)
  assert(stripe._sessionCreateCalls.length === 1)
}

// ===========================================================================
// 52 -- cross-tenant Portal access impossible.
// ===========================================================================

async function testCrossTenantPortalAccessImpossible() {
  const { stripe } = install()
  const tenantA = freshTenantId()
  const tenantB = freshTenantId()
  await createBillingRecord(tenantA, { stripeCustomerId: 'cus_tenantA1', stripeSubscriptionId: 'sub_tenantA1' })
  await createBillingRecord(tenantB, { stripeCustomerId: 'cus_tenantB1', stripeSubscriptionId: 'sub_tenantB1' })
  const tokenA = await seedOwnerSession(tenantA)
  const res = await invokePortalSession({ token: tokenA })
  assert(res.statusCode === 200)
  assert(stripe._sessionCreateCalls[0].customer === 'cus_tenantA1', 'tenant A\'s owner must only ever be able to open a Portal session against tenant A\'s own Customer')
  assert(stripe._sessionCreateCalls[0].customer !== 'cus_tenantB1', 'tenant A\'s owner must never be able to reach tenant B\'s Customer, by any means')
}

const tests = [
  ['an owner creates a portal session', testOwnerCreatesPortalSession],
  ['a non-owner is rejected', testNonOwnerIsRejected],
  ['a forged customerId is ignored', testForgedCustomerIdIgnored],
  ['a forged subscriptionId is ignored', testForgedSubscriptionIdIgnored],
  ['a forged configurationId is ignored', testForgedConfigurationIdIgnored],
  ['a forged return URL is ignored', testForgedReturnUrlIgnored],
  ['a missing billing customer fails closed', testMissingBillingCustomerFailsClosed],
  ['a missing subscription fails closed', testMissingSubscriptionFailsClosed],
  ['a missing Portal config env var fails closed', testMissingPortalConfigEnvFailsClosed],
  ['a Portal configuration with subscription_update enabled fails closed', testSubscriptionUpdateEnabledFailsClosed],
  ['an immediate-cancel Portal mode fails closed', testImmediateCancelModeFailsClosed],
  ['a disabled payment-method-update feature fails closed', testDisabledPaymentMethodUpdateFailsClosed],
  ['a disabled invoice-history feature fails closed', testDisabledInvoiceHistoryFailsClosed],
  ['login_page.enabled=true fails closed', testLoginPageEnabledFailsClosed],
  ['a missing login_page field fails closed', testMissingLoginPageFieldFailsClosed],
  ['login_page.enabled=false is permitted with otherwise-valid policy', testLoginPageDisabledIsPermittedWithOtherValidPolicy],
  ['customer_update.enabled=true fails closed', testCustomerUpdateEnabledFailsClosed],
  ['an inactive pinned Portal configuration fails closed', testInactiveConfigurationFailsClosed],
  ['the correct, reviewed Portal configuration succeeds', testCorrectReviewedConfigSucceeds],
  ['cross-tenant Portal access is impossible', testCrossTenantPortalAccessImpossible],
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
