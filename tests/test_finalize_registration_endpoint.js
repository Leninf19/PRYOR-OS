// Phase B.11 pre-commit correction (Part 1) -- end-to-end HTTP tests for
// the new POST /api/session/finalize-registration, the action that
// bridges authoritative Setup completion (Stripe webhook-verified) into a
// real tenant/Owner/session. No real Stripe API call -- only the billing
// record's own already-verified state (defaultPaymentMethodId, exactly as
// stripeWebhookAction() would have set it) is ever consulted.
//
// Run directly: node tests/test_finalize_registration_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import handler from '../dashboard/api/session/[action].js'
import {
  _setRedisClientForTests as setPendingClient, _resetRedisClientForTests as resetPendingClient, getPendingRegistration,
} from '../dashboard/api/_lib/pendingRegistrationStore.js'
import { _setRedisClientForTests as setTokenClient, _resetRedisClientForTests as resetTokenClient } from '../dashboard/api/_lib/tokenStore.js'
import {
  _setRedisClientForTests as setBillingClient, _resetRedisClientForTests as resetBillingClient,
  createBillingRecord, getBillingRecord,
} from '../dashboard/api/_lib/billingStore.js'
import { _setRedisClientForTests as setUserStoreClient, _resetRedisClientForTests as resetUserStoreClient, getUserByEmail } from '../dashboard/api/_lib/userStore.js'
import { _setRedisClientForTests as setTenantConfigClient, _resetRedisClientForTests as resetTenantConfigClient, getTenantConfig } from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setAuditClient, _resetRedisClientForTests as resetAuditClient } from '../dashboard/api/_lib/auditLog.js'
import { _setTransportForTests, _resetTransportForTests } from '../dashboard/api/_lib/emailSender.js'
import { PENDING_SIGNUP_COOKIE, signPendingSignupToken } from '../dashboard/api/_lib/pendingSignupSession.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'

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
    resetPendingClient(); resetTokenClient(); resetBillingClient(); resetUserStoreClient(); resetTenantConfigClient(); resetAuditClient()
    _resetTransportForTests(); _resetLimiterFactoryForTests()
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
      throw new Error('unexpected eval() call shape in test fake')
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
  setAuditClient(() => redis)
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

async function invoke(action, body, { cookie } = {}) {
  const req = {
    method: 'POST', body, headers: { host: 'app.example.com', ...(cookie ? { cookie } : {}) },
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

async function registerAndVerify(overrides = {}) {
  const body = registerBody(overrides)
  await invoke('register', body)
  const token = extractVerifyToken()
  const verifyRes = await invoke('verify-email', { token })
  const cookie = cookieFromRes(verifyRes, PENDING_SIGNUP_COOKIE)
  const pending = await getPendingRegistration(body.email)
  return { body, cookie, pending }
}

// Simulates the verified webhook already having set defaultPaymentMethodId
// -- the ONLY signal finalize-registration ever trusts for "billing is
// ready."
async function markBillingReady(tenantId, { plan = 'core', paymentMethodId = 'pm_testsavedcard' } = {}) {
  await createBillingRecord(tenantId, { pendingPaidPlan: plan, defaultPaymentMethodId: paymentMethodId })
}

// ===========================================================================

async function testFakeQueryParamsCannotSubstituteForBillingReadiness() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie } = await registerAndVerify({ email: 'f1@example.com' })
  // No billing record at all -- a fake "?session_id=cs_fake" arriving via
  // the browser has no bearing since finalize-registration reads no query
  // string at all.
  const res = await invoke('finalize-registration', {}, { cookie })
  assert(res.statusCode === 409 && res.body.error === 'billing_not_ready')
}

async function testNoPaymentMethodMeansNoFinalization() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'f2@example.com' })
  await createBillingRecord(pending.tenantIdReserved, { pendingPaidPlan: 'core' }) // no defaultPaymentMethodId
  const res = await invoke('finalize-registration', {}, { cookie })
  assert(res.statusCode === 409 && res.body.error === 'billing_not_ready')
  const config = await getTenantConfig(pending.tenantIdReserved)
  assert(config === null, 'no tenant must ever be created without a confirmed payment method')
}

async function testWebhookDelayedThenSucceedsOnRetry() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'f3@example.com' })
  const first = await invoke('finalize-registration', {}, { cookie })
  assert(first.statusCode === 409 && first.body.error === 'billing_not_ready', 'before the webhook lands, this must be a stable, retryable response')
  // The webhook "lands" -- mark billing ready.
  await markBillingReady(pending.tenantIdReserved)
  const second = await invoke('finalize-registration', {}, { cookie })
  assert(second.statusCode === 200, `after billing is ready, the retry must succeed: ${JSON.stringify(second.body)}`)
}

async function testSuccessfulFinalizationCreatesRealTenantOwnerSession() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending, body } = await registerAndVerify({ email: 'f4@example.com' })
  await markBillingReady(pending.tenantIdReserved, { plan: 'growth' })
  const res = await invoke('finalize-registration', {}, { cookie })
  assert(res.statusCode === 200 && res.body.account?.email === body.email)
  assert(cookieFromRes(res, 'lta_session'), 'a real session cookie must be issued')

  const config = await getTenantConfig(pending.tenantIdReserved)
  assert(config !== null, 'a real tenant_config must now exist')
  assert(config.commercial.commercialStatus === 'trial_pending_activation', 'the tenant must start in the explicit pending-activation state, never commercial: null')
  assert(config.commercial.plan === 'growth' && config.commercial.planSource === 'self_service_trial')
  assert(config.trialEligibility?.eligible === true && config.trialEligibility.source === 'self_service_registration')
  assert(config.accessCodeGrant === null, 'a self-service tenant must never carry an accessCodeGrant')

  const user = await getUserByEmail(pending.tenantIdReserved, body.email)
  assert(user.role === 'owner', 'the first user must be the Owner')
}

async function testSameReservedTenantIdIsPreserved() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'f5@example.com' })
  await markBillingReady(pending.tenantIdReserved)
  const res = await invoke('finalize-registration', {}, { cookie })
  assert(res.statusCode === 200)
  const config = await getTenantConfig(pending.tenantIdReserved)
  assert(config.tenantId === pending.tenantIdReserved, 'the tenant must be created under the SAME reserved tenantId from registration')
}

async function testDuplicateFinalizeCallsProduceExactlyOneTenant() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'f6@example.com' })
  await markBillingReady(pending.tenantIdReserved)
  const first = await invoke('finalize-registration', {}, { cookie })
  assert(first.statusCode === 200)
  const second = await invoke('finalize-registration', {}, { cookie })
  assert(second.statusCode !== 200, 'a second finalize call after the registration is already completed must never create a second tenant')
  assert(['already_completed', 'not_found'].includes(second.body.error), `expected a stable not-a-fresh-tenant error, got ${JSON.stringify(second.body)}`)
}

async function testConcurrentFinalizeCallsResolveToExactlyOneTenant() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'f7@example.com' })
  await markBillingReady(pending.tenantIdReserved)
  const [a, b] = await Promise.all([
    invoke('finalize-registration', {}, { cookie }),
    invoke('finalize-registration', {}, { cookie }),
  ])
  const successes = [a, b].filter(r => r.statusCode === 200)
  assert(successes.length === 1, `expected exactly one winner, got ${successes.length} (statuses: ${a.statusCode}, ${b.statusCode})`)
}

async function testForeignPendingSignupCannotFinalizeAnotherTenant() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { pending: pendingA } = await registerAndVerify({ email: 'f8a@example.com' })
  await markBillingReady(pendingA.tenantIdReserved)
  const { cookie: cookieB } = await registerAndVerify({ email: 'f8b@example.com' })
  // B has no billing record of their own -- B's cookie must only ever be
  // able to finalize B's OWN reserved tenant, never A's.
  const res = await invoke('finalize-registration', {}, { cookie: cookieB })
  assert(res.statusCode === 409 && res.body.error === 'billing_not_ready', 'B must never be able to ride A\'s billing readiness')
  const configA = await getTenantConfig(pendingA.tenantIdReserved)
  assert(configA === null, 'A\'s tenant must not have been created by B\'s request')
}

async function testNoClientTenantIdAuthority() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const { cookie, pending } = await registerAndVerify({ email: 'f9@example.com' })
  await markBillingReady(pending.tenantIdReserved)
  const res = await invoke('finalize-registration', { tenantId: 't_someone-elses-tenant' }, { cookie })
  assert(res.statusCode === 200)
  const spoofed = await getTenantConfig('t_someone-elses-tenant')
  assert(spoofed === null, 'a client-supplied tenantId in the request body must have zero effect')
  const real = await getTenantConfig(pending.tenantIdReserved)
  assert(real !== null, 'the tenant must still be created under the server-resolved reserved id')
}

async function testUnverifiedUserCannotFinalize() {
  installFakeInfrastructure(); installWorkingEmailTransport()
  const res = await invoke('finalize-registration', {})
  assert(res.statusCode === 401)
}

const tests = [
  ['a fake query param cannot substitute for billing readiness', testFakeQueryParamsCannotSubstituteForBillingReadiness],
  ['no payment method confirmation means no finalization', testNoPaymentMethodMeansNoFinalization],
  ['a delayed webhook resolves as billing_not_ready, then succeeds on retry', testWebhookDelayedThenSucceedsOnRetry],
  ['successful finalization creates a real tenant/Owner/session', testSuccessfulFinalizationCreatesRealTenantOwnerSession],
  ['the same reserved tenantId is preserved', testSameReservedTenantIdIsPreserved],
  ['duplicate finalize calls produce exactly one tenant', testDuplicateFinalizeCallsProduceExactlyOneTenant],
  ['concurrent finalize calls resolve to exactly one tenant', testConcurrentFinalizeCallsResolveToExactlyOneTenant],
  ['a foreign pending signup cannot finalize another tenant', testForeignPendingSignupCannotFinalizeAnotherTenant],
  ['no client tenantId authority', testNoClientTenantIdAuthority],
  ['an unverified/unauthenticated caller cannot finalize', testUnverifiedUserCannotFinalize],
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
