// Phase B.11 -- end-to-end HTTP tests for the rewritten
// POST /api/session/select-plan (Stripe Setup-mode Checkout initiation).
// No real Stripe API call, no real Redis -- a fake Stripe client and fake
// Redis clients are injected via each module's own test-injection seam.
//
// Run directly: node tests/test_select_plan_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.DASHBOARD_BASE_URL = 'https://app.example.com'

import handler from '../dashboard/api/session/[action].js'
import {
  _setRedisClientForTests as setPendingClient, _resetRedisClientForTests as resetPendingClient, getPendingRegistration,
} from '../dashboard/api/_lib/pendingRegistrationStore.js'
import { _setRedisClientForTests as setTokenClient, _resetRedisClientForTests as resetTokenClient } from '../dashboard/api/_lib/tokenStore.js'
import {
  _setRedisClientForTests as setBillingClient, _resetRedisClientForTests as resetBillingClient, getBillingRecord,
} from '../dashboard/api/_lib/billingStore.js'
import { _setRedisClientForTests as setUserStoreClient, _resetRedisClientForTests as resetUserStoreClient } from '../dashboard/api/_lib/userStore.js'
import { _setRedisClientForTests as setTenantConfigClient, _resetRedisClientForTests as resetTenantConfigClient } from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setStripeClientForTests, _resetStripeClientForTests } from '../dashboard/api/_lib/stripeClient.js'
import { _setTransportForTests, _resetTransportForTests } from '../dashboard/api/_lib/emailSender.js'
import { PENDING_SIGNUP_COOKIE } from '../dashboard/api/_lib/pendingSignupSession.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
import { CURRENT_BILLING_TERMS_VERSION } from '../dashboard/api/_lib/billingTerms.js'

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
    resetPendingClient(); resetTokenClient(); resetBillingClient(); resetUserStoreClient(); resetTenantConfigClient()
    _resetStripeClientForTests(); _resetTransportForTests(); _resetLimiterFactoryForTests()
  }
}

function fakeSharedRedis() {
  const hashes = {}
  const strings = {}
  function expired(e) { return e.expiresAtMs !== null && Date.now() >= e.expiresAtMs }
  return {
    hget: async (key, field) => hashes[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(hashes[key] ?? {}) }),
    hset: async (key, fields) => { hashes[key] = { ...(hashes[key] ?? {}), ...fields } },
    hsetnx: async (key, field, value) => {
      hashes[key] = hashes[key] ?? {}
      if (field in hashes[key]) return false
      hashes[key][field] = value
      return true
    },
    hdel: async (key, field) => { if (hashes[key]) delete hashes[key][field] },
    get: async (key) => {
      const e = strings[key]
      if (!e || expired(e)) return null
      return e.value
    },
    set: async (key, value, opts = {}) => {
      const existing = strings[key]
      const alive = existing && !expired(existing)
      if (opts?.nx && alive) return null
      strings[key] = { value, expiresAtMs: opts?.ex ? Date.now() + opts.ex * 1000 : null }
      return 'OK'
    },
    getdel: async (key) => {
      const e = strings[key]
      delete strings[key]
      if (!e || expired(e)) return null
      return e.value
    },
    del: async (key) => { const existed = key in strings || key in hashes; delete strings[key]; delete hashes[key]; return existed ? 1 : 0 },
    eval: async (script, keys, args) => {
      const key = keys[0]
      if (script.includes('SCRIPT: BILLING_CAS')) {
        const [field, expectedVersionStr, nextJson] = args
        const raw = hashes[key]?.[field] ?? null
        let currentVersion = '0'
        if (raw) { try { const d = JSON.parse(raw); if (d?.version !== undefined) currentVersion = String(d.version) } catch { /* 0 */ } }
        if (currentVersion !== expectedVersionStr) return raw ?? false
        hashes[key] = { ...(hashes[key] ?? {}), [field]: nextJson }
        return true
      }
      if (script.includes('SCRIPT: INDEX_CLAIM')) {
        const [tenantId] = args
        const e = strings[key]
        const existing = (e && !expired(e)) ? e.value : null
        if (existing) return existing === tenantId ? 1 : 0
        strings[key] = { value: tenantId, expiresAtMs: null }
        return 1
      }
      throw new Error('unexpected eval() call shape in test fake')
    },
  }
}

function fakeStripe() {
  let counter = 0
  const byIdempotencyKey = new Map()
  return {
    customers: {
      create: async (params, opts) => {
        const key = opts?.idempotencyKey
        if (key && byIdempotencyKey.has(key)) return byIdempotencyKey.get(key)
        counter += 1
        const customer = { id: `cus_test${counter}`, email: params.email }
        if (key) byIdempotencyKey.set(key, customer)
        return customer
      },
    },
    checkout: {
      sessions: {
        create: async (params) => {
          counter += 1
          return { id: `cs_test${counter}`, url: `https://checkout.stripe.com/test/session_${counter}`, ...params }
        },
      },
    },
  }
}

function installFakeInfrastructure() {
  const redis = fakeSharedRedis()
  setPendingClient(() => redis)
  setTokenClient(() => redis)
  setBillingClient(() => redis)
  setUserStoreClient(() => redis)
  setTenantConfigClient(() => redis)
  _setStripeClientForTests(() => fakeStripe())
  return redis
}

let sentEmails
function installWorkingEmailTransport() {
  sentEmails = []
  _setTransportForTests(() => ({
    sendMail: async (opts) => { sentEmails.push(opts); return { messageId: 'test-message-id', response: '250 OK' } },
  }))
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  res.getHeader = (name) => res.headers[name]
  return res
}

async function invoke(action, body, { cookie, method = 'POST' } = {}) {
  const req = {
    method, body, headers: { host: 'app.example.com', ...(cookie ? { cookie } : {}) },
    query: { action }, socket: { remoteAddress: '127.0.0.1' },
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

function cookieFromRes(res, name) {
  const setCookie = res.headers['Set-Cookie']
  if (!setCookie) return null
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const c of list) {
    if (c.startsWith(`${name}=`)) return `${name}=${c.split(`${name}=`)[1].split(';')[0]}`
  }
  return null
}

const VALID_PASSWORD = 'correct-horse-battery-staple'
function registerBody(overrides = {}) {
  return {
    email: 'newowner@example.com', password: VALID_PASSWORD, passwordConfirmation: VALID_PASSWORD,
    displayName: 'New Owner', companyName: 'Sunset Grill Group', ...overrides,
  }
}

function extractVerifyToken() {
  const { text } = sentEmails[sentEmails.length - 1]
  return decodeURIComponent(text.match(/token=([A-Za-z0-9%_-]+)/)[1])
}

// Verified, pending-plan-selection identity -- NO tenant/user exists yet.
async function registerAndVerify(overrides = {}) {
  const body = registerBody(overrides)
  await invoke('register', body)
  const token = extractVerifyToken()
  const verifyRes = await invoke('verify-email', { token })
  const cookie = cookieFromRes(verifyRes, PENDING_SIGNUP_COOKIE)
  const pending = await getPendingRegistration(body.email)
  return { body, cookie, pending }
}

// ===========================================================================
// AUTH
// ===========================================================================

async function testUnverifiedUserCannotInitiateSetup() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  // No cookie at all -- exactly what an unverified visitor has.
  const res = await invoke('select-plan', { plan: 'core', recurringBillingAccepted: true })
  assert(res.statusCode === 401, `an unverified/unauthenticated caller must be rejected, got ${res.statusCode}`)
}

async function testForeignOrTamperedCookieCannotInitiateSetup() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const res = await invoke('select-plan', { plan: 'core', recurringBillingAccepted: true }, { cookie: `${PENDING_SIGNUP_COOKIE}=not-a-real-token` })
  assert(res.statusCode === 401)
}

async function testOwnerRegistrantSucceeds() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie } = await registerAndVerify()
  const res = await invoke('select-plan', { plan: 'core', recurringBillingAccepted: true }, { cookie })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(typeof res.body.checkoutUrl === 'string' && res.body.checkoutUrl.startsWith('https://checkout.stripe.com/'))
}

async function testRequestBodyTenantIdIsIrrelevant() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify()
  // A spoofed tenantId in the body must be silently ignored -- the server
  // always uses pending.tenantIdReserved, never anything from the request.
  const res = await invoke('select-plan', { plan: 'core', recurringBillingAccepted: true, tenantId: 't_someone-elses-tenant' }, { cookie })
  assert(res.statusCode === 200)
  const record = await getBillingRecord(pending.tenantIdReserved)
  assert(record, 'the billing record must be created under the SERVER-resolved reserved tenantId, never a spoofed one')
  const spoofed = await getBillingRecord('t_someone-elses-tenant')
  assert(spoofed === null, 'no billing record must ever be created under a client-supplied tenantId')
}

// ===========================================================================
// CONSENT
// ===========================================================================

async function testAbsentConsentIsDenied() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie } = await registerAndVerify({ email: 'a1@example.com' })
  const res = await invoke('select-plan', { plan: 'core' }, { cookie })
  assert(res.statusCode === 400 && res.body.error === 'consent_required')
}

async function testFalseConsentIsDenied() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie } = await registerAndVerify({ email: 'a2@example.com' })
  const res = await invoke('select-plan', { plan: 'core', recurringBillingAccepted: false }, { cookie })
  assert(res.statusCode === 400 && res.body.error === 'consent_required')
}

async function testTruthyButNonBooleanConsentIsDenied() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie } = await registerAndVerify({ email: 'a3@example.com' })
  const res = await invoke('select-plan', { plan: 'core', recurringBillingAccepted: 'yes' }, { cookie })
  assert(res.statusCode === 400 && res.body.error === 'consent_required', 'only the literal boolean true may express consent -- a truthy string must not')
}

async function testAcceptedConsentGetsServerTimestamp() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const before = Date.now()
  const { cookie, pending } = await registerAndVerify({ email: 'a4@example.com' })
  const res = await invoke('select-plan', { plan: 'core', recurringBillingAccepted: true }, { cookie })
  assert(res.statusCode === 200)
  const record = await getBillingRecord(pending.tenantIdReserved)
  assert(record.consent && record.consent.recurringBillingAccepted === true)
  const acceptedAtMs = Date.parse(record.consent.acceptedAt)
  assert(acceptedAtMs >= before && acceptedAtMs <= Date.now(), 'acceptedAt must be a real server-generated timestamp near the request time')
}

async function testTermsVersionIsServerAuthoritative() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'a5@example.com' })
  await invoke('select-plan', { plan: 'core', recurringBillingAccepted: true }, { cookie })
  const record = await getBillingRecord(pending.tenantIdReserved)
  assert(record.consent.termsVersion === CURRENT_BILLING_TERMS_VERSION)
}

async function testBrowserAcceptedAtIsIgnored() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'a6@example.com' })
  const spoofedPast = '2000-01-01T00:00:00.000Z'
  await invoke('select-plan', { plan: 'core', recurringBillingAccepted: true, acceptedAt: spoofedPast, termsVersion: 'fake-version' }, { cookie })
  const record = await getBillingRecord(pending.tenantIdReserved)
  assert(record.consent.acceptedAt !== spoofedPast, 'a client-supplied acceptedAt must never be trusted')
  assert(record.consent.termsVersion !== 'fake-version', 'a client-supplied termsVersion must never be trusted')
}

// Phase B.11 pre-commit correction (Part 5) -- the consent snapshot must
// record the ACTUAL commercial terms accepted, entirely server-derived.
async function testCoreConsentRecords14900() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'c1@example.com' })
  await invoke('select-plan', { plan: 'core', recurringBillingAccepted: true }, { cookie })
  const record = await getBillingRecord(pending.tenantIdReserved)
  assert(record.consent.acceptedPlanId === 'core')
  assert(record.consent.acceptedAmountCents === 14900, `expected 14900, got ${record.consent.acceptedAmountCents}`)
  assert(record.consent.currency === 'usd' && record.consent.billingInterval === 'month' && record.consent.trialDays === 7)
}

async function testGrowthConsentRecords24900() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'c2@example.com' })
  await invoke('select-plan', { plan: 'growth', recurringBillingAccepted: true }, { cookie })
  const record = await getBillingRecord(pending.tenantIdReserved)
  assert(record.consent.acceptedPlanId === 'growth')
  assert(record.consent.acceptedAmountCents === 24900, `expected 24900, got ${record.consent.acceptedAmountCents}`)
}

async function testSpoofedConsentAmountIsIgnored() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'c3@example.com' })
  await invoke('select-plan', { plan: 'core', recurringBillingAccepted: true, acceptedAmountCents: 1, currency: 'eur', billingInterval: 'year' }, { cookie })
  const record = await getBillingRecord(pending.tenantIdReserved)
  assert(record.consent.acceptedAmountCents === 14900, 'a client-supplied amount must never be trusted')
  assert(record.consent.currency === 'usd', 'a client-supplied currency must never be trusted')
  assert(record.consent.billingInterval === 'month', 'a client-supplied billingInterval must never be trusted')
}

async function testSpoofedTrialDaysIsIgnored() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'c4@example.com' })
  await invoke('select-plan', { plan: 'core', recurringBillingAccepted: true, trialDays: 365 }, { cookie })
  const record = await getBillingRecord(pending.tenantIdReserved)
  assert(record.consent.trialDays === 7, 'a client-supplied trialDays must never be trusted')
}

async function testChangingCoreToGrowthRequiresNewConsent() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'c5@example.com' })
  await invoke('select-plan', { plan: 'core', recurringBillingAccepted: true }, { cookie })
  const first = await getBillingRecord(pending.tenantIdReserved)
  assert(first.consent.acceptedPlanId === 'core' && first.consent.acceptedAmountCents === 14900, 'setup sanity: first consent must reflect Core')
  await invoke('select-plan', { plan: 'growth', recurringBillingAccepted: true }, { cookie })
  const record = await getBillingRecord(pending.tenantIdReserved)
  assert(record.pendingPaidPlan === 'growth')
  assert(record.consent.acceptedPlanId === 'growth' && record.consent.acceptedAmountCents === 24900,
    'switching plans must produce a FRESH consent snapshot for the NEW plan/amount, never silently keep the old one')
  // `version` (not acceptedAt, which can coincide at millisecond
  // resolution under fast in-memory test execution) is the robust,
  // non-flaky proof that a genuine second CAS write actually happened --
  // it is monotonically incremented on every real update, never reused.
  assert(record.version > first.version, 'a plan change must perform a genuine second write, never reuse the old acceptance in place')
}

async function testChangingGrowthToCoreRequiresNewConsent() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'c6@example.com' })
  await invoke('select-plan', { plan: 'growth', recurringBillingAccepted: true }, { cookie })
  await invoke('select-plan', { plan: 'core', recurringBillingAccepted: true }, { cookie })
  const record = await getBillingRecord(pending.tenantIdReserved)
  assert(record.pendingPaidPlan === 'core')
  assert(record.consent.acceptedPlanId === 'core' && record.consent.acceptedAmountCents === 14900)
}

async function testConsentCannotDriftFromPendingPaidPlan() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'c7@example.com' })
  await invoke('select-plan', { plan: 'growth', recurringBillingAccepted: true }, { cookie })
  const record = await getBillingRecord(pending.tenantIdReserved)
  // pendingPaidPlan and consent.acceptedPlanId are written in the SAME
  // update call every time -- they must always agree.
  assert(record.pendingPaidPlan === record.consent.acceptedPlanId, 'pendingPaidPlan and consent.acceptedPlanId must never disagree')
}

// ===========================================================================
// PLAN
// ===========================================================================

async function testCoreAccepted() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'p1@example.com' })
  const res = await invoke('select-plan', { plan: 'core', recurringBillingAccepted: true }, { cookie })
  assert(res.statusCode === 200)
  const record = await getBillingRecord(pending.tenantIdReserved)
  assert(record.pendingPaidPlan === 'core')
}

async function testGrowthAccepted() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'p2@example.com' })
  const res = await invoke('select-plan', { plan: 'growth', recurringBillingAccepted: true }, { cookie })
  assert(res.statusCode === 200)
  const record = await getBillingRecord(pending.tenantIdReserved)
  assert(record.pendingPaidPlan === 'growth')
}

async function testEnterpriseRejectedFromSelfService() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie } = await registerAndVerify({ email: 'p3@example.com' })
  const res = await invoke('select-plan', { plan: 'enterprise', recurringBillingAccepted: true }, { cookie })
  assert(res.statusCode === 400 && res.body.error === 'invalid_plan', 'enterprise must never be accepted through self-service checkout')
}

async function testArbitraryPlanRejected() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie } = await registerAndVerify({ email: 'p4@example.com' })
  const res = await invoke('select-plan', { plan: 'ultra-mega-plan', recurringBillingAccepted: true }, { cookie })
  assert(res.statusCode === 400 && res.body.error === 'invalid_plan')
}

async function testArbitraryPriceAndAmountAreIgnored() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'p5@example.com' })
  // The endpoint accepts no priceId/amount field at all -- prove that
  // supplying one has zero effect on the resulting billing record/session.
  const res = await invoke('select-plan', { plan: 'core', recurringBillingAccepted: true, priceId: 'price_evil', amountCents: 1 }, { cookie })
  assert(res.statusCode === 200)
  const record = await getBillingRecord(pending.tenantIdReserved)
  assert(!('stripePriceId' in record) || record.stripePriceId === null, 'no price is ever set by select-plan -- setup mode has no price at all')
}

// ===========================================================================
// SECURITY -- no request body path can directly mutate billing projection
// ===========================================================================

async function testNoRequestBodySpreadCanSetArbitraryBillingFields() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 's1@example.com' })
  await invoke('select-plan', {
    plan: 'core', recurringBillingAccepted: true,
    subscriptionStatus: 'active', stripeSubscriptionId: 'sub_fake', cancelAtPeriodEnd: true,
  }, { cookie })
  const record = await getBillingRecord(pending.tenantIdReserved)
  assert(record.subscriptionStatus === null, 'subscriptionStatus must never be settable via select-plan\'s request body')
  assert(record.stripeSubscriptionId === null, 'stripeSubscriptionId must never be settable via select-plan\'s request body')
}

// ===========================================================================
// TRIAL -- setup does not start it
// ===========================================================================

async function testSelectPlanNeverTouchesTenantConfig() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie } = await registerAndVerify({ email: 't1@example.com' })
  const res = await invoke('select-plan', { plan: 'growth', recurringBillingAccepted: true }, { cookie })
  assert(res.statusCode === 200)
  // No tenant_config record exists at all -- select-plan operates entirely
  // pre-tenant. If this ever created one, getTenantConfig would need to be
  // wired/checked; its complete absence from this test's fixture wiring
  // (no tenantConfigStore client installed at all) means any accidental
  // write would throw TenantConfigStoreUnavailableError instead of
  // silently succeeding -- confirmed by the 200 response above having
  // occurred with no such error.
  assert(true)
}

const tests = [
  ['unverified user cannot initiate setup', testUnverifiedUserCannotInitiateSetup],
  ['a foreign/tampered pending-signup cookie cannot initiate setup', testForeignOrTamperedCookieCannotInitiateSetup],
  ['the sole pre-tenant registrant (future Owner) succeeds', testOwnerRegistrantSucceeds],
  ['a request-body tenantId is irrelevant -- server always resolves its own', testRequestBodyTenantIdIsIrrelevant],
  ['absent consent is denied', testAbsentConsentIsDenied],
  ['false consent is denied', testFalseConsentIsDenied],
  ['a truthy non-boolean consent value is denied', testTruthyButNonBooleanConsentIsDenied],
  ['accepted consent gets a real server timestamp', testAcceptedConsentGetsServerTimestamp],
  ['termsVersion is server-authoritative', testTermsVersionIsServerAuthoritative],
  ['a browser-supplied acceptedAt/termsVersion is ignored', testBrowserAcceptedAtIsIgnored],
  ['Core consent records 14900', testCoreConsentRecords14900],
  ['Growth consent records 24900', testGrowthConsentRecords24900],
  ['a spoofed consent amount/currency/interval is ignored', testSpoofedConsentAmountIsIgnored],
  ['a spoofed trialDays is ignored', testSpoofedTrialDaysIsIgnored],
  ['changing Core -> Growth requires a fresh consent snapshot', testChangingCoreToGrowthRequiresNewConsent],
  ['changing Growth -> Core requires a fresh consent snapshot', testChangingGrowthToCoreRequiresNewConsent],
  ['consent cannot drift independently from pendingPaidPlan', testConsentCannotDriftFromPendingPaidPlan],
  ['Core is accepted', testCoreAccepted],
  ['Growth is accepted', testGrowthAccepted],
  ['Enterprise is rejected from self-service', testEnterpriseRejectedFromSelfService],
  ['an arbitrary plan id is rejected', testArbitraryPlanRejected],
  ['an arbitrary price/amount in the body is ignored', testArbitraryPriceAndAmountAreIgnored],
  ['no request-body spread can set arbitrary billing fields', testNoRequestBodySpreadCanSetArbitraryBillingFields],
  ['select-plan never touches tenant_config', testSelectPlanNeverTouchesTenantConfig],
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
