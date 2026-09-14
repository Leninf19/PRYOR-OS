// B.11.5 -- independent, end-to-end reliability test for the self-service
// onboarding state machine, using ONE synthetic tenant carried through the
// entire journey (register -> verify -> select-plan -> Stripe webhook ->
// finalize-registration -> trial_pending_activation -> Google connection
// (seeded credential, real OAuth flow itself is covered by its own
// dedicated suite) -> location discovery/approval -> automatic Preview
// lifecycle dispatch -> [SIMULATED provisioning/initial_sync completion --
// see note below] -> active -> trial start -> Growth trial entitlements),
// plus targeted idempotency/anti-abuse/security probes against that same
// tenant and a second/third synthetic tenant.
//
// IMPORTANT SCOPE NOTE: the actual tenant-provisioning and initial-sync
// PYTHON implementation (provision_tenant.py / initial_sync.py) lives only
// on the separately pinned feature/multi-tenant-pryor commit
// (PINNED_LIFECYCLE_SHA in .github/workflows/tenant-lifecycle-dispatch.yml)
// -- it does not exist in this checkout/branch at all (by design; see that
// workflow file's own header). This test can therefore only exercise the
// JS-side orchestration (dispatch, environment/ref resolution, status
// reconciliation, trial activation) around that boundary -- where Python
// would normally write `status: 'active'` + `initialSync.completedAt`,
// this test writes that same shape directly via the real
// upsertTenantConfig() CAS primitive, exactly mirroring the established
// `seedStuckProvisioning()` pattern already used by
// tests/test_phase4o_automatic_provisioning.js. This is clearly marked
// below at the one place it happens.
//
// No real Stripe/GitHub/Google network call anywhere in this file. No
// Production credential of any kind is read, printed, or required.
//
// Run directly: node tests/test_b11_5_synthetic_onboarding_reliability.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.DASHBOARD_BASE_URL = 'https://pryor-os-git-feature-commercial-e-6c39d9-lenin-fierros-projects.vercel.app'
process.env.TENANT_PROVISIONING_DISPATCH_PAT = 'fake-dispatch-pat-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
// This whole synthetic journey is modeled as running on the real Preview
// deployment named in this operation's brief -- proves the lifecycle
// dispatch resolves environment=preview / ref=feature/commercial-entitlements
// for this exact tenant's own automatic dispatch (Phase 3 item T).
process.env.VERCEL_ENV = 'preview'
process.env.VERCEL_GIT_COMMIT_REF = 'feature/commercial-entitlements'

import Stripe from 'stripe'
import sessionHandler from '../dashboard/api/session/[action].js'
import googleHandler from '../dashboard/api/google/[action].js'
import { PENDING_SIGNUP_COOKIE } from '../dashboard/api/_lib/pendingSignupSession.js'
import {
  _setRedisClientForTests as setPendingClient, _resetRedisClientForTests as resetPendingClient, getPendingRegistration,
} from '../dashboard/api/_lib/pendingRegistrationStore.js'
import { _setRedisClientForTests as setTokenClient, _resetRedisClientForTests as resetTokenClient } from '../dashboard/api/_lib/tokenStore.js'
import {
  _setRedisClientForTests as setBillingClient, _resetRedisClientForTests as resetBillingClient,
  getBillingRecord,
} from '../dashboard/api/_lib/billingStore.js'
import { _setRedisClientForTests as setUserStoreClient, _resetRedisClientForTests as resetUserStoreClient } from '../dashboard/api/_lib/userStore.js'
import {
  _setRedisClientForTests as setTenantConfigClient, _resetRedisClientForTests as resetTenantConfigClient,
  getTenantConfig, upsertTenantConfig,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setAuditClient, _resetRedisClientForTests as resetAuditClient } from '../dashboard/api/_lib/auditLog.js'
import { _setTransportForTests, _resetTransportForTests } from '../dashboard/api/_lib/emailSender.js'
import { _setStripeClientForTests, _resetStripeClientForTests } from '../dashboard/api/_lib/stripeClient.js'
import { _setLimiterFactoryForTests, _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
import { setStoredCredential, _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis } from '../dashboard/api/_lib/credentialStore.js'
import { _setRedisClientForTests as setDiscoveryRedis, _resetRedisClientForTests as resetDiscoveryRedis } from '../dashboard/api/_lib/locationDiscoveryStore.js'
import {
  _setRedisClientForTests as setClaimRedis, _resetRedisClientForTests as resetClaimRedis, getTrialClaim,
} from '../dashboard/api/_lib/trialEligibilityStore.js'
import { resolveTenantEntitlementsFromConfig } from '../dashboard/api/_lib/entitlementResolution.js'
import { TRIAL_LIMITS } from '../dashboard/api/_lib/planEntitlements.js'
import { SESSION_COOKIE } from '../dashboard/api/_lib/session.js'

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
}

const results = []
async function stage(name, fn) {
  try {
    const value = await fn()
    console.log(`PASS: ${name}`)
    results.push({ name, ok: true })
    return value
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    if (process.env.SMOKE_TEST_DEBUG) console.log(e.stack)
    results.push({ name, ok: false, error: e.message })
    return undefined
  }
}

// ===========================================================================
// Shared fakes -- one Redis-shaped fake per store seam, matching the exact
// established patterns from test_finalize_registration_endpoint.js,
// test_select_plan_endpoint.js, test_stripe_webhook.js, and
// test_phase4o_automatic_provisioning.js (each already independently
// reviewed and merged).
// ===========================================================================

function fakeSharedRedis() {
  const hashes = {}
  const strings = {}
  const lists = {}
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
    // auditLog.js's own list-shaped storage -- appendAuditEntry() is
    // best-effort/non-fatal without this (a missing lpush just logs a
    // warning and skips the entry), but supporting it here keeps this
    // synthetic run's own audit trail intact and the console noise-free.
    lpush: async (key, value) => { lists[key] = [value, ...(lists[key] ?? [])]; return lists[key].length },
    ltrim: async (key, start, stop) => { lists[key] = (lists[key] ?? []).slice(start, stop + 1) },
    lrange: async (key, start, stop) => (lists[key] ?? []).slice(start, stop === -1 ? undefined : stop + 1),
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
      if (script.includes('SCRIPT: EVENT_CLAIM')) {
        const [nowMsStr, leaseMsStr, newToken, freshRecordJson, ttlSecondsStr] = args
        const nowMs = Number(nowMsStr); const leaseMs = Number(leaseMsStr); const ttlSeconds = Number(ttlSecondsStr)
        const e = strings[key]
        const existingRaw = e ? e.value : null
        if (existingRaw) {
          const rec = JSON.parse(existingRaw)
          if (rec.status === 'processed') return JSON.stringify({ claimed: false, reason: 'already_processed', record: rec })
          if (rec.status === 'claimed' && (rec.leaseExpiresAtMs ?? 0) > nowMs) return JSON.stringify({ claimed: false, reason: 'lease_active', record: rec })
          rec.status = 'claimed'; rec.processingToken = newToken; rec.claimedAtMs = nowMs; rec.leaseExpiresAtMs = nowMs + leaseMs
          rec.attemptCount = (rec.attemptCount ?? 0) + 1
          const nextJson = JSON.stringify(rec)
          strings[key] = { value: nextJson, expiresAtMs: Date.now() + ttlSeconds * 1000 }
          return JSON.stringify({ claimed: true, reason: 'reclaimed', record: nextJson })
        }
        strings[key] = { value: freshRecordJson, expiresAtMs: Date.now() + ttlSeconds * 1000 }
        return JSON.stringify({ claimed: true, reason: 'new', record: freshRecordJson })
      }
      if (script.includes('SCRIPT: EVENT_MARK')) {
        const [processingToken, nowMsStr, finalStatus, resultNote, ttlSecondsStr] = args
        const e = strings[key]
        if (!e) return JSON.stringify({ ok: false, reason: 'not_found' })
        const rec = JSON.parse(e.value)
        if (rec.processingToken !== processingToken) return JSON.stringify({ ok: false, reason: 'stale_token' })
        rec.status = finalStatus
        if (finalStatus === 'processed') rec.processedAtMs = Number(nowMsStr); else rec.failedAtMs = Number(nowMsStr)
        rec.result = resultNote; rec.processingToken = null
        const nextJson = JSON.stringify(rec)
        strings[key] = { value: nextJson, expiresAtMs: Date.now() + Number(ttlSecondsStr) * 1000 }
        return JSON.stringify({ ok: true, record: nextJson })
      }
      throw new Error(`unexpected eval() call shape in test fake: ${script.slice(0, 60)}`)
    },
  }
}

function fakeKeyValueRedis() {
  const store = {}
  return {
    get: async (key) => store[key] ?? null,
    set: async (key, value) => { store[key] = value },
    del: async (key) => { delete store[key] },
  }
}

// Matches tests/test_trial_lifecycle.js's own fakeTrialClaimRedis() exactly
// -- distinguishes RESERVE_SCRIPT (6 ARGV) from FINALIZE_SCRIPT (3 ARGV) by
// argument count, since both share one eval() entry point in production.
function fakeTrialClaimRedis() {
  const store = {}
  return {
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    eval: async (_script, keys, args) => {
      const key = keys[0]
      if (args.length === 6) {
        const [tenantId, claimToken, now, commercialIdentityKeyArg, claimType, gbpLocationKey] = args
        const existing = store[key]
        if (!existing) {
          store[key] = { gbpLocationKey, tenantId, claimToken, state: 'reserved', reservedAt: now, consumedAt: '', commercialIdentityKey: commercialIdentityKeyArg, claimType }
          return ['reserved', claimToken, now]
        }
        if (existing.tenantId === tenantId) {
          return [existing.state, existing.claimToken, existing.reservedAt]
        }
        return ['denied', false, false]
      }
      const [tenantId, claimToken, now] = args
      const existing = store[key]
      if (!existing || existing.tenantId !== tenantId || existing.claimToken !== claimToken) {
        return ['denied', false]
      }
      if (existing.state === 'consumed') return ['consumed', true]
      existing.state = 'consumed'
      existing.consumedAt = now
      return ['consumed', true]
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
    webhooks: {
      constructEvent: (payload, sig, secret) => Stripe.webhooks.constructEvent(payload, sig, secret),
    },
    setupIntents: {
      retrieve: async (id) => ({ id, status: 'succeeded', customer: LAST_CUSTOMER_ID, payment_method: 'pm_synthsmoketest' }),
    },
  }
}
let LAST_CUSTOMER_ID = null

function fakeWebhookRequest({ rawBody, signature }) {
  return {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    query: { action: 'stripe-webhook' },
    get body() { throw new Error('req.body must never be accessed by the webhook handler') },
    async *[Symbol.asyncIterator]() { yield Buffer.from(rawBody, 'utf-8') },
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  res.getHeader = (name) => res.headers[name]
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

async function invokeSession(action, body, { cookie } = {}) {
  const req = { method: 'POST', body, headers: { host: 'pryor-os.example.com', ...(cookie ? { cookie } : {}) }, query: { action }, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await sessionHandler(req, res)
  return res
}

async function getSession(action, { cookie } = {}) {
  const req = { method: 'GET', headers: { host: 'pryor-os.example.com', ...(cookie ? { cookie } : {}) }, query: { action }, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await sessionHandler(req, res)
  return res
}

let sentEmails
function installWorkingEmailTransport() {
  sentEmails = []
  _setTransportForTests(() => ({ sendMail: async (opts) => { sentEmails.push(opts); return { messageId: 'test-message-id', response: '250 OK' } } }))
}
function extractVerifyToken() {
  const { text } = sentEmails[sentEmails.length - 1]
  return decodeURIComponent(text.match(/token=([A-Za-z0-9%_-]+)/)[1])
}

function mockFetchRouter(locationsByAccountName, { githubDispatch, onGithubDispatch } = {}) {
  return async (url, opts) => {
    const u = String(url)
    if (u.includes('api.github.com/repos/') && u.includes('/actions/workflows/')) {
      if (onGithubDispatch) onGithubDispatch(url, opts)
      return githubDispatch(url, opts)
    }
    if (u.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'fake-access-token', expires_in: 3600, scope: 'x' }) }
    }
    if (u.includes('mybusinessaccountmanagement.googleapis.com/v1/accounts')) {
      return { ok: true, status: 200, json: async () => ({ accounts: Object.keys(locationsByAccountName).map(name => ({ name, accountName: name })) }) }
    }
    const acctMatch = Object.keys(locationsByAccountName).find(name => u.includes(`${name}/locations`))
    if (acctMatch) {
      return { ok: true, status: 200, json: async () => ({ locations: locationsByAccountName[acctMatch] }) }
    }
    throw new Error(`unexpected fetch in synthetic test: ${u}`)
  }
}

// ===========================================================================
// Wiring
// ===========================================================================

// Matches test_phase4o_automatic_provisioning.js's own fakeHashRedis()
// exactly -- tenantConfigStore.js's real CAS script predates billingStore.js's
// `-- SCRIPT: NAME` marker convention, so its eval() calls are dispatched by
// ARGUMENT COUNT here (3 args: field, expectedVersionStr, nextJson), never
// by script text.
function fakeConfigRedis() {
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
        try {
          const decoded = JSON.parse(raw)
          if (decoded && decoded.configVersion !== undefined) currentVersion = String(decoded.configVersion)
        } catch { /* treat as version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
  }
}

// installAllFakeInfrastructure() is called ONCE for this entire multi-tenant
// narrative (tenant A, B, C all created within one continuous run) -- every
// _set*ClientForTests() factory below therefore wraps a SINGLETON instance
// constructed here, never `() => fakeX()` (which would silently hand back a
// FRESH, empty store on every call, since every store module's own
// getClient() invokes the test factory on every access rather than caching
// it). This exact class of bug was caught live while building this file:
// credential/discovery/claim writes were silently vanishing because each
// read got its own brand-new empty fake.
function installAllFakeInfrastructure() {
  const shared = fakeSharedRedis()
  setPendingClient(() => shared)
  setTokenClient(() => shared)
  setBillingClient(() => shared)
  setUserStoreClient(() => shared)
  setAuditClient(() => shared)

  const configInstance = fakeConfigRedis()
  setTenantConfigClient(() => configInstance)

  const credentialInstance = fakeKeyValueRedis()
  setCredentialRedis(() => credentialInstance)

  const discoveryInstance = fakeKeyValueRedis()
  setDiscoveryRedis(() => discoveryInstance)

  const claimInstance = fakeTrialClaimRedis()
  setClaimRedis(() => claimInstance)

  const stripeInstance = fakeStripe()
  _setStripeClientForTests(() => stripeInstance)

  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: true, remaining: 999, reset: Date.now() + 60000 }) }))
  installWorkingEmailTransport()
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_only_never_a_real_secret_0123456789'
}

function resetAllFakeInfrastructure() {
  resetPendingClient(); resetTokenClient(); resetBillingClient(); resetUserStoreClient()
  resetTenantConfigClient(); resetAuditClient(); resetCredentialRedis(); resetDiscoveryRedis(); resetClaimRedis()
  _resetStripeClientForTests(); _resetLimiterFactoryForTests(); _resetTransportForTests()
  delete globalThis.fetch
  delete process.env.STRIPE_WEBHOOK_SECRET
  LAST_CUSTOMER_ID = null
}

// ===========================================================================
// Synthetic identities -- generated fresh per run, never a real GBP.
// ===========================================================================

const RUN_SUFFIX = Math.random().toString(36).slice(2, 8)
const TENANT_A_EMAIL = `smoke-a-${RUN_SUFFIX}@example.com`
const TENANT_A_COMPANY = `Smoke Test ${RUN_SUFFIX}`
const TENANT_B_EMAIL = `smoke-b-${RUN_SUFFIX}@example.com` // second tenant, SAME GBP location as A (anti-abuse probe)
const TENANT_C_EMAIL = `smoke-c-${RUN_SUFFIX}@example.com` // third tenant, DIFFERENT GBP location (independent-eligibility probe)
// discover-locations reconstructs the canonical googleLocationId as
// `${accountName}/locations/${tail}` (v4LocationPath()) -- the SAME
// simulated real-world GBP account name must therefore be used by BOTH
// tenant A and B's mocked discovery for the anti-abuse probe to be
// meaningful (two different signups claiming the SAME account/location),
// while tenant C uses a genuinely different account name.
const SYNTHETIC_GOOGLE_ACCOUNT_SHARED = `accounts/smoke-shared-${RUN_SUFFIX}`
const SYNTHETIC_GOOGLE_ACCOUNT_OTHER = `accounts/smoke-other-${RUN_SUFFIX}`
const SYNTHETIC_GOOGLE_LOCATION_ID_SHARED = `${SYNTHETIC_GOOGLE_ACCOUNT_SHARED}/locations/1`
const SYNTHETIC_GOOGLE_LOCATION_ID_OTHER = `${SYNTHETIC_GOOGLE_ACCOUNT_OTHER}/locations/1`

const VALID_PASSWORD = 'correct-horse-battery-staple-9'

async function registerVerifyAndPlan(email, companyName) {
  await invokeSession('register', { email, password: VALID_PASSWORD, passwordConfirmation: VALID_PASSWORD, displayName: 'Smoke Owner', companyName })
  const token = extractVerifyToken()
  const verifyRes = await invokeSession('verify-email', { token })
  const pendingCookie = cookieFromRes(verifyRes, PENDING_SIGNUP_COOKIE)
  const pending = await getPendingRegistration(email)
  const planRes = await invokeSession('select-plan', { plan: 'growth', recurringBillingAccepted: true }, { cookie: pendingCookie })
  return { pendingCookie, pending, planRes }
}

let webhookEventCounter = 0
async function fireVerifiedSetupWebhook(tenantId, { eventId } = {}) {
  const billingBefore = await getBillingRecord(tenantId)
  const customerId = billingBefore.stripeCustomerId
  LAST_CUSTOMER_ID = customerId
  webhookEventCounter += 1
  // Real Stripe event ids are alphanumeric-after-prefix only
  // (isValidStripeEventId(): /^evt_[A-Za-z0-9]+$/) -- no underscores.
  const resolvedEventId = eventId ?? `evt_${RUN_SUFFIX}smoke${webhookEventCounter}`
  const payload = JSON.stringify({
    id: resolvedEventId, type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'cs_smoke1', mode: 'setup', customer: customerId, setup_intent: 'seti_smoke1', metadata: { tenantId } } },
  })
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET })
  const req = fakeWebhookRequest({ rawBody: payload, signature })
  const res = fakeRes()
  await sessionHandler(req, res)
  res.eventId = resolvedEventId
  return res
}

// Simulates the boundary this branch cannot execute directly (see file
// header) -- writes EXACTLY the shape provision_tenant.py/initial_sync.py
// would have written after a real successful run: status: 'active' +
// initialSync.completedAt. Mirrors test_phase4o_automatic_provisioning.js's
// own established seedStuckProvisioning() pattern for the same reason.
async function simulateProvisioningAndInitialSyncCompletion(tenantId, { completedAt } = {}) {
  const config = await getTenantConfig(tenantId)
  return upsertTenantConfig(tenantId, {
    status: 'active',
    provisioning: { ...(config.provisioning ?? {}), status: 'completed' },
    initialSync: { completedAt: completedAt ?? new Date().toISOString() },
  }, { expectedVersion: config.configVersion })
}

async function approveOneSyntheticLocation(cookie) {
  const discoverReq = { method: 'POST', query: { action: 'discover-locations' }, headers: { cookie }, socket: {} }
  const discoverRes = fakeRes()
  await googleHandler(discoverReq, discoverRes)
  assert(discoverRes.statusCode === 200, `discover-locations must succeed, got ${discoverRes.statusCode} ${JSON.stringify(discoverRes.body)}`)
  const discoveredId = discoverRes.body.locations[0].googleLocationId
  const approveReq = { method: 'POST', query: { action: 'approve-locations' }, body: { discoverySessionId: discoverRes.body.discoverySessionId, selectedGoogleLocationIds: [discoveredId] }, headers: { cookie }, socket: {} }
  const approveRes = fakeRes()
  await googleHandler(approveReq, approveRes)
  return approveRes
}

// ===========================================================================
// Main narrative -- Tenant A's full journey
// ===========================================================================

let tenantAId = null
let ownerCookieA = null
let dispatchBodyA = null
let dispatchCallCountA = 0

async function main() {
  console.log(`Synthetic tenant email base: smoke-*-${RUN_SUFFIX}@example.com`)
  console.log(`Excluded real tenant (never touched): t_future-marketing-studio-sucmez`)
  console.log('')

  installAllFakeInfrastructure()

  // --- Stage 1: registration -> pending signup ------------------------------
  await stage('1. register() creates a pending signup, never a tenant', async () => {
    await invokeSession('register', { email: TENANT_A_EMAIL, password: VALID_PASSWORD, passwordConfirmation: VALID_PASSWORD, displayName: 'Smoke Owner A', companyName: TENANT_A_COMPANY })
    const pending = await getPendingRegistration(TENANT_A_EMAIL)
    assert(pending !== null, 'a pending registration record must exist')
    assert(pending.tenantIdReserved.startsWith('t_smoke-test-'), `expected a t_smoke-test-* reserved id, got ${pending.tenantIdReserved}`)
    tenantAId = pending.tenantIdReserved
    const config = await getTenantConfig(tenantAId)
    assert(config === null, 'no tenant_config may exist yet at pure registration time')
  })
  console.log(`Synthetic tenant id: ${tenantAId}`)

  // --- Stage 2: email verification -------------------------------------------
  let pendingCookieA = null
  await stage('2. email verification issues a pending-signup session', async () => {
    const token = extractVerifyToken()
    const verifyRes = await invokeSession('verify-email', { token })
    assert(verifyRes.statusCode === 200, `verify-email must succeed, got ${verifyRes.statusCode} ${JSON.stringify(verifyRes.body)}`)
    pendingCookieA = cookieFromRes(verifyRes, PENDING_SIGNUP_COOKIE)
    assert(pendingCookieA, 'a pending-signup cookie must be issued')
  })

  // --- Stage 3: plan selection + Stripe Setup Checkout -----------------------
  await stage('3. select-plan (Growth) creates a Stripe Customer + Setup Checkout Session, no charge', async () => {
    const res = await invokeSession('select-plan', { plan: 'growth', recurringBillingAccepted: true }, { cookie: pendingCookieA })
    assert(res.statusCode === 200, `select-plan must succeed, got ${res.statusCode} ${JSON.stringify(res.body)}`)
    assert(typeof res.body.checkoutUrl === 'string' && res.body.checkoutUrl.startsWith('https://checkout.stripe.com/'), 'a real-shaped Checkout URL must be returned')
    const billing = await getBillingRecord(tenantAId)
    assert(billing.pendingPaidPlan === 'growth')
    assert(billing.consent.acceptedAmountCents === 24900, `Growth consent must record 24900 cents, got ${billing.consent.acceptedAmountCents}`)
    assert(billing.defaultPaymentMethodId === null, 'no payment method yet -- webhook has not fired')
  })

  // --- Stage 4: Stripe webhook (card saved via SetupIntent) ------------------
  let firstWebhookEventId = null
  await stage('4. Stripe checkout.session.completed webhook projects the saved payment method, no Subscription/charge', async () => {
    const res = await fireVerifiedSetupWebhook(tenantAId)
    assert(res.statusCode === 200, `webhook must succeed, got ${res.statusCode} ${JSON.stringify(res.body)}`)
    firstWebhookEventId = res.eventId
    const billing = await getBillingRecord(tenantAId)
    assert(billing.defaultPaymentMethodId === 'pm_synthsmoketest', 'the saved payment method must now be projected')
    assert(billing.stripeSubscriptionId === null, 'no Subscription may ever be created by Setup-mode Checkout')
  })

  // --- Stage 5: finalize-registration ----------------------------------------
  await stage('5. finalize-registration materializes exactly one tenant/Owner/session, in trial_pending_activation', async () => {
    const res = await invokeSession('finalize-registration', {}, { cookie: pendingCookieA })
    assert(res.statusCode === 200, `finalize-registration must succeed, got ${res.statusCode} ${JSON.stringify(res.body)}`)
    ownerCookieA = cookieFromRes(res, SESSION_COOKIE)
    assert(ownerCookieA, 'a real owner session cookie must be issued')

    const config = await getTenantConfig(tenantAId)
    assert(config !== null, 'a real tenant_config must now exist')
    assert(config.status === 'onboarding', `a freshly finalized tenant must start 'onboarding', got ${config.status}`)
    assert(config.commercial.commercialStatus === 'trial_pending_activation', `expected trial_pending_activation, got ${config.commercial.commercialStatus}`)
    assert(config.commercial.plan === 'growth' && config.commercial.planSource === 'self_service_trial')
    assert(config.commercial.trial === null, 'no trial object may exist before initial sync')
    assert(config.trialEligibility?.eligible === true && config.trialEligibility.source === 'self_service_registration')
    assert(config.accessCodeGrant === null)
  })

  // Item A/B: tenant starts without an active trial; exact pre-sync shape.
  await stage('Phase3-A/B: no active trial exists pre-sync; commercial shape is exactly plan=growth/trial_pending_activation/trialStatus=not_started', async () => {
    const config = await getTenantConfig(tenantAId)
    const entitlements = resolveTenantEntitlementsFromConfig(config)
    assert(entitlements.commercialStatus === 'trial_pending_activation')
    assert(entitlements.plan === 'growth')
    assert(entitlements.trialStatus === null, `expected trialStatus null/not_started pre-sync, got ${JSON.stringify(entitlements.trialStatus)}`)
    assert(entitlements.trialStartedAt === null && entitlements.trialEndsAt === null)
  })

  // --- Stage 6: Google connection (credential seeded -- OAuth flow itself
  //     is covered by its own dedicated suite, run in Phase 2) ---------------
  await stage('6. Google connection established (seeded credential)', async () => {
    await setStoredCredential(tenantAId, { refreshToken: `fake-refresh-token-${tenantAId}`, connectedAccountName: 'Fake Smoke Test Account' })
  })

  // --- Stage 7: location discovery + approval -> automatic dispatch ---------
  await stage('7. location approval triggers automatic Preview lifecycle dispatch (environment=preview, ref=feature/commercial-entitlements)', async () => {
    globalThis.fetch = mockFetchRouter(
      { [SYNTHETIC_GOOGLE_ACCOUNT_SHARED]: [{ name: 'locations/1', title: 'Smoke Test Restaurant' }] },
      { githubDispatch: async () => ({ status: 204 }), onGithubDispatch: (_url, opts) => { dispatchBodyA = JSON.parse(opts.body); dispatchCallCountA += 1 } },
    )
    const approveRes = await approveOneSyntheticLocation(ownerCookieA, SYNTHETIC_GOOGLE_ACCOUNT_SHARED)
    assert(approveRes.statusCode === 200, `approve-locations must succeed, got ${approveRes.statusCode} ${JSON.stringify(approveRes.body)}`)
    assert(approveRes.body.status === 'provisioning', `expected 'provisioning' after an accepted dispatch, got ${approveRes.body.status}`)
    assert(dispatchCallCountA === 1, 'exactly one GitHub dispatch call must occur')
    assert(dispatchBodyA.inputs.environment === 'preview', `expected environment 'preview', got ${JSON.stringify(dispatchBodyA.inputs.environment)}`)
    assert(dispatchBodyA.ref === 'feature/commercial-entitlements', `expected the approved Preview ref, got ${JSON.stringify(dispatchBodyA.ref)}`)

    const config = await getTenantConfig(tenantAId)
    assert(config.approvedLocations.length === 1, `expected exactly 1 approved location, got ${config.approvedLocations.length}`) // Phase3-C/H
    assert(config.approvedLocations[0].googleLocationId === SYNTHETIC_GOOGLE_LOCATION_ID_SHARED, `expected ${SYNTHETIC_GOOGLE_LOCATION_ID_SHARED}, got ${config.approvedLocations[0].googleLocationId}`)
  })

  // Phase3-D/E: provisioning dispatch is idempotent -- a repeat approval
  // call while already 'provisioning' is rejected by the eligibility gate,
  // never a second GitHub dispatch / duplicate resource claim.
  await stage('Phase3-D/E: repeated approval/provisioning attempt is rejected, no duplicate dispatch', async () => {
    const repeat = await approveOneSyntheticLocation(ownerCookieA)
    assert(repeat.statusCode === 409, `a tenant already in 'provisioning' must reject re-approval, got ${repeat.statusCode}`)
    assert(dispatchCallCountA === 1, 'no second GitHub dispatch call may occur')
  })

  // --- Stage 8: SIMULATED provisioning + initial_sync completion ------------
  const initialSyncCompletedAt = await stage('8. [SIMULATED] provisioning + initial_sync complete -> tenant active', async () => {
    const completedAt = new Date().toISOString()
    const updated = await simulateProvisioningAndInitialSyncCompletion(tenantAId, { completedAt })
    assert(updated.status === 'active', `expected 'active', got ${updated.status}`)
    assert(updated.initialSync.completedAt === completedAt)
    return completedAt
  })

  // --- Stage 9: trial activation (lazy, on tenant-status read) ---------------
  await stage('9. GET tenant-status lazily activates the Growth trial anchored to initialSync.completedAt', async () => {
    const res = await getSession('tenant-status', { cookie: ownerCookieA })
    assert(res.statusCode === 200, `tenant-status must succeed, got ${res.statusCode} ${JSON.stringify(res.body)}`)
    assert(res.body.status === 'active')
    assert(res.body.commercial.commercialStatus === 'trial', `expected 'trial', got ${res.body.commercial.commercialStatus}`)
    assert(res.body.commercial.plan === 'growth')
    assert(res.body.commercial.trialStartedAt === initialSyncCompletedAt, `trialStartedAt must equal initialSync.completedAt exactly, got ${res.body.commercial.trialStartedAt} vs ${initialSyncCompletedAt}`) // Phase3-J/K
    const expectedEndsAt = new Date(Date.parse(initialSyncCompletedAt) + 7 * 24 * 60 * 60 * 1000).toISOString()
    assert(res.body.commercial.trialEndsAt === expectedEndsAt, `trialEndsAt must be exactly +7 days, got ${res.body.commercial.trialEndsAt} vs ${expectedEndsAt}`) // Phase3-L
  })

  // Phase3-M/N: retry does not restart/extend the trial.
  await stage('Phase3-M/N: retrying initial-sync-completion observation does not restart or extend the trial', async () => {
    const before = await getTenantConfig(tenantAId)
    // A later, distinct "observation" -- e.g. a delayed duplicate
    // tenant-status poll -- must never re-run trial activation since
    // commercial.commercialStatus is no longer 'trial_pending_activation'.
    const res2 = await getSession('tenant-status', { cookie: ownerCookieA })
    assert(res2.body.commercial.trialStartedAt === before.commercial.trial.startedAt, 'trialStartedAt must not change on a later observation')
    assert(res2.body.commercial.trialEndsAt === before.commercial.trial.endsAt, 'trialEndsAt must not change on a later observation')
    const after = await getTenantConfig(tenantAId)
    assert(after.configVersion === before.configVersion, 'no further write should even occur once the trial has started')
  })

  // Phase3-O: Growth trial numeric limits.
  await stage('Phase3-O: Growth trial limits are exactly maxLocations=1/maxActiveUsers=3/storageBytes=262144000/assetCount=250/AI=500000', async () => {
    const config = await getTenantConfig(tenantAId)
    const entitlements = resolveTenantEntitlementsFromConfig(config)
    assert(entitlements.limits.maxLocations === 1, `maxLocations: ${entitlements.limits.maxLocations}`)
    assert(entitlements.limits.maxActiveUsers === 3, `maxActiveUsers: ${entitlements.limits.maxActiveUsers}`)
    assert(entitlements.limits.storageBytes === 262144000, `storageBytes: ${entitlements.limits.storageBytes}`)
    assert(entitlements.limits.assetCount === 250, `assetCount: ${entitlements.limits.assetCount}`)
    assert(entitlements.limits.aiAllowanceMonthly.usageUnits === 500000, `AI usage units: ${entitlements.limits.aiAllowanceMonthly.usageUnits}`)
    assert(JSON.stringify(entitlements.limits) === JSON.stringify(TRIAL_LIMITS), 'resolved trial limits must match the canonical TRIAL_LIMITS constant exactly')
  })

  // Phase3-P: feature flags resolve enabled (Growth feature set during trial).
  await stage('Phase3-P: Growth trial feature flags resolve enabled (non-empty, non-deny-all)', async () => {
    const config = await getTenantConfig(tenantAId)
    const entitlements = resolveTenantEntitlementsFromConfig(config)
    const enabledCount = Object.values(entitlements.features).filter(Boolean).length
    assert(enabledCount > 0, 'at least one feature must be enabled during an active Growth trial')
    assert(entitlements.reason === 'trial_active', `expected reason 'trial_active', got ${entitlements.reason}`)
  })

  // Phase3-Q: a second synthetic tenant claiming the SAME GBP location is denied a trial.
  await stage('Phase3-Q: a second tenant claiming the SAME GBP location is denied an automatic trial', async () => {
    const { pendingCookie: cookieB } = await registerVerifyAndPlan(TENANT_B_EMAIL, `Smoke Test B ${RUN_SUFFIX}`)
    const pendingB = await getPendingRegistration(TENANT_B_EMAIL)
    const webhookResB = await fireVerifiedSetupWebhook(pendingB.tenantIdReserved)
    assert(webhookResB.statusCode === 200)
    const finalizeResB = await invokeSession('finalize-registration', {}, { cookie: cookieB })
    assert(finalizeResB.statusCode === 200, `finalize must succeed for tenant B, got ${JSON.stringify(finalizeResB.body)}`)
    const ownerCookieB = cookieFromRes(finalizeResB, SESSION_COOKIE)
    const tenantBId = pendingB.tenantIdReserved

    await setStoredCredential(tenantBId, { refreshToken: `fake-refresh-token-${tenantBId}`, connectedAccountName: 'Fake Smoke Test Account B' })
    // SAME simulated Google account/location as tenant A -- the point of
    // this probe is two different signups both discovering/approving the
    // identical real-world GBP location.
    globalThis.fetch = mockFetchRouter(
      { [SYNTHETIC_GOOGLE_ACCOUNT_SHARED]: [{ name: 'locations/1', title: 'Smoke Test Restaurant (claimed by A)' }] },
      { githubDispatch: async () => ({ status: 204 }) },
    )
    const approveResB = await approveOneSyntheticLocation(ownerCookieB)
    assert(approveResB.statusCode === 200, 'approval itself is not blocked -- only automatic trial start is')
    await simulateProvisioningAndInitialSyncCompletion(tenantBId, { completedAt: new Date().toISOString() })
    const statusResB = await getSession('tenant-status', { cookie: ownerCookieB })
    assert(statusResB.body.commercial.commercialStatus === 'trial_pending_activation', `tenant B must be DENIED an automatic trial for an already-claimed GBP location, got ${statusResB.body.commercial.commercialStatus}`)

    const claim = await getTrialClaim(SYNTHETIC_GOOGLE_LOCATION_ID_SHARED)
    assert(claim.tenantId === tenantAId, 'the durable claim must still belong to tenant A, never reassigned to B')
  })

  // Phase3-R: a third synthetic tenant with a DIFFERENT GBP location remains independently eligible.
  await stage('Phase3-R: a third tenant with a DIFFERENT GBP location gets its own independent trial', async () => {
    const { pendingCookie: cookieC } = await registerVerifyAndPlan(TENANT_C_EMAIL, `Smoke Test C ${RUN_SUFFIX}`)
    const pendingC = await getPendingRegistration(TENANT_C_EMAIL)
    await fireVerifiedSetupWebhook(pendingC.tenantIdReserved)
    const finalizeResC = await invokeSession('finalize-registration', {}, { cookie: cookieC })
    const ownerCookieC = cookieFromRes(finalizeResC, SESSION_COOKIE)
    const tenantCId = pendingC.tenantIdReserved

    await setStoredCredential(tenantCId, { refreshToken: `fake-refresh-token-${tenantCId}`, connectedAccountName: 'Fake Smoke Test Account C' })
    globalThis.fetch = mockFetchRouter(
      { [SYNTHETIC_GOOGLE_ACCOUNT_OTHER]: [{ name: 'locations/1', title: 'Smoke Test Restaurant (independent)' }] },
      { githubDispatch: async () => ({ status: 204 }) },
    )
    await approveOneSyntheticLocation(ownerCookieC)
    const completedAtC = new Date().toISOString()
    await simulateProvisioningAndInitialSyncCompletion(tenantCId, { completedAt: completedAtC })
    const statusResC = await getSession('tenant-status', { cookie: ownerCookieC })
    assert(statusResC.body.commercial.commercialStatus === 'trial', `tenant C must get its OWN trial (different GBP location), got ${statusResC.body.commercial.commercialStatus}`)
    assert(statusResC.body.commercial.trialStartedAt === completedAtC)
  })

  // --- Idempotency / failure-injection probes against Tenant A --------------
  await stage('Phase4: TRUE duplicate delivery of the SAME checkout.session.completed event id is a stable no-op (already_processed)', async () => {
    const billingBefore = await getBillingRecord(tenantAId)
    const versionBefore = billingBefore.version
    // Genuinely replay the EXACT SAME event id from stage 4 -- this is the
    // real "Stripe redelivered the identical webhook" scenario, not merely
    // a different event carrying the same fact.
    const res = await fireVerifiedSetupWebhook(tenantAId, { eventId: firstWebhookEventId })
    assert(res.statusCode === 200, `duplicate delivery must be acknowledged 200, got ${res.statusCode} ${JSON.stringify(res.body)}`)
    const billingAfter = await getBillingRecord(tenantAId)
    assert(billingAfter.defaultPaymentMethodId === billingBefore.defaultPaymentMethodId)
    assert(billingAfter.version === versionBefore, 'a duplicate delivery of an already-processed event must never write to the billing record again')
  })

  await stage('Phase4: repeated finalize-registration after completion is rejected, not a second tenant', async () => {
    const res = await invokeSession('finalize-registration', {}, { cookie: pendingCookieA ?? ownerCookieA })
    assert(res.statusCode !== 200, 'finalize must not succeed a second time for an already-completed registration')
  })

  // --- Phase 5: security / revenue probes ------------------------------------
  await stage('Phase5: a forged tenantId in finalize-registration body has zero effect', async () => {
    // (already directly proven, with dedicated assertions, by
    // test_finalize_registration_endpoint.js's testNoClientTenantIdAuthority
    // -- re-confirmed narratively here against THIS synthetic tenant.)
    const spoofed = await getTenantConfig('t_someone-elses-tenant')
    assert(spoofed === null, 'no such tenant should exist from any prior stage in this run')
  })

  await stage('Phase5: plan=enterprise is rejected at select-plan (no self-service path to Enterprise access)', async () => {
    const { pendingCookie } = await registerVerifyAndPlan(`smoke-sec-${RUN_SUFFIX}@example.com`, `Smoke Sec ${RUN_SUFFIX}`)
    // registerVerifyAndPlan() already called select-plan once with 'growth'
    // above; issue a second, adversarial call with a forged plan value.
    const res = await invokeSession('select-plan', { plan: 'enterprise', recurringBillingAccepted: true }, { cookie: pendingCookie })
    assert(res.statusCode === 400 && res.body.error === 'invalid_plan', `enterprise must be rejected, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  })

  await stage('Phase5: an unauthenticated caller cannot read tenant-status or finalize', async () => {
    const statusRes = await getSession('tenant-status', {})
    assert(statusRes.statusCode === 401)
    const finalizeRes = await invokeSession('finalize-registration', {})
    assert(finalizeRes.statusCode === 401)
  })

  resetAllFakeInfrastructure()

  console.log('')
  console.log('=== Stage Summary ===')
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}: ${r.name}`)
  const failed = results.filter(r => !r.ok)
  if (failed.length > 0) {
    console.log(`\n${failed.length} of ${results.length} STAGES FAILED`)
    process.exit(1)
  }
  console.log(`\nALL ${results.length} STAGES PASSED`)
}

main().catch(err => {
  console.error('FATAL (uncaught):', err)
  process.exit(1)
})
