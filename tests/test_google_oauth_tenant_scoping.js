// Regression tests for Multi-Tenant Phase 4A -- Tenant-Scoped Google OAuth
// & Credential Storage. Covers the parts test_credential_store.js's own
// (store-level) tenant-isolation tests don't reach: the OAuth /auth start
// deriving tenantId only from the authenticated session, the hardened,
// signed OAuth state (dashboard/api/google/_lib/oauthState.js), and
// /callback's full verification chain (CSRF cookie match + signature/
// expiry + tenant/user cross-check) before any credential is written.
//
// No real Upstash account, no real Google OAuth client, no real network
// calls, and no real secret material anywhere in this file -- every
// Google network call is mocked via globalThis.fetch, and the credential
// store is driven entirely through its test-only client-factory seam.
//
// Run directly: node tests/test_google_oauth_tenant_scoping.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'

import bcrypt from 'bcryptjs'
import { createHmac } from 'crypto'
import googleHandler from '../dashboard/api/google/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { signOAuthState, verifyOAuthState } from '../dashboard/api/google/_lib/oauthState.js'
import {
  _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis,
  getStoredCredential,
} from '../dashboard/api/_lib/credentialStore.js'
import { _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis } from '../dashboard/api/_lib/tenantConfigStore.js'
import { credentialKeyV2 } from '../dashboard/api/_lib/tenantKeys.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'

const SYNTHETIC_TENANT_ID = 't_synthetic-second-tenant'
const LEGACY_V1_KEY = 'gbp_credentials:v1'
const STATE_COOKIE = 'gbp_oauth_state'
const FAKE_REFRESH_TOKEN = 'do-not-leak-this-fake-refresh-token'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// Multi-Tenant Phase 4I.2: callback() now reads tenant_config (to decide
// pre-commit vs. committed reconciliation) before writing a credential.
// None of this file's tests are about entitlement state -- an empty,
// never-populated store correctly reports "no tenant_config record yet"
// (pre-commit/'onboarding'), exactly this file's synthetic tenants' real
// state, so callback() proceeds exactly as it did before this store
// existed. Wired globally per-test (fresh per run) so no individual test
// body needs to know this dependency exists.
function fakeTenantConfigRedis() {
  const store = {}
  return {
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
  }
}

const results = []
async function run(name, fn) {
  setConfigRedis(() => fakeTenantConfigRedis())
  try {
    await fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  } finally {
    resetCredentialRedis()
    resetConfigRedis()
    _resetLimiterFactoryForTests()
    delete process.env.ACCOUNT_DIRECTORY_JSON
    delete globalThis.fetch
  }
}

function authHandler(req, res) { return googleHandler({ ...req, query: { ...req.query, action: 'auth' } }, res) }
function callbackHandler(req, res) { return googleHandler({ ...req, query: { ...req.query, action: 'callback' } }, res) }

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.send = (str) => { res.body = str; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.redirect = (_code, location) => { res.statusCode = 302; res.location = location; return res }
  res.setHeader = (name, value) => { res.headers[name] = value; return res }
  res.getHeader = (name) => res.headers[name]
  return res
}

// A key-respecting fake, same shape as test_credential_store.js's -- needed
// here to independently inspect which key(s) callback() actually wrote to.
function fakeCredentialRedis(initial = {}) {
  const store = { ...initial }
  return {
    get: async (key) => (key in store ? store[key] : null),
    set: async (key, value) => { store[key] = value },
    del: async (key) => { delete store[key] },
    // Multi-Tenant Phase 4I.2: callback() now writes via
    // setStoredCredentialIfVersion()'s CAS EVAL, not a plain set() --
    // faithfully emulated here (single-threaded JS, so trivially atomic).
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [expectedVersionStr, nextJson] = args
      const raw = key in store ? store[key] : null
      let currentVersion = '0'
      if (raw) {
        try {
          const decoded = JSON.parse(raw)
          if (decoded && decoded.credentialVersion !== undefined) currentVersion = String(decoded.credentialVersion)
        } catch { /* treat as version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = nextJson
      return true
    },
    _store: store,
  }
}

async function seedOwnerDirectory(overrides = {}) {
  const hash = await bcrypt.hash('correct-horse-battery-staple', 12)
  const base = {
    usr_owner: { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' },
    usr_owner2: { userId: 'usr_owner2', email: 'owner2@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Second Owner' },
  }
  for (const [k, patch] of Object.entries(overrides)) base[k] = { ...base[k], ...patch }
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: Object.values(base) })
}

function ownerToken(userId = 'usr_owner') {
  const email = userId === 'usr_owner2' ? 'owner2@example.com' : 'owner@example.com'
  return signSession({ userId, email, role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
}

function reqWithCookies(cookies, extra = {}) {
  const cookieHeader = Object.entries(cookies).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join('; ')
  return { method: 'GET', query: {}, headers: { cookie: cookieHeader }, ...extra }
}

function extractStateFromRedirect(location) {
  const url = new URL(location)
  return url.searchParams.get('state')
}

// --- OAuth start (/auth): tenant comes only from the authenticated session -

async function testAuthDerivesTenantFromAuthenticatedSession() {
  await seedOwnerDirectory()
  const req = reqWithCookies({ [SESSION_COOKIE]: await ownerToken() })
  const res = fakeRes()
  await authHandler(req, res)
  assert(res.statusCode === 302, `expected a redirect to Google, got ${res.statusCode}`)
  const state = extractStateFromRedirect(res.location)
  const decoded = await verifyOAuthState(state)
  assert(decoded !== null, 'auth() must produce a validly-signed OAuth state')
  assert(decoded.tenantId === DEFAULT_TENANT_ID, `expected tenantId ${DEFAULT_TENANT_ID} derived from the session, got ${decoded.tenantId}`)
  assert(decoded.userId === 'usr_owner', 'the state must bind the initiating user\'s id')
}

async function testClientSuppliedTenantIdCannotSwitchOAuthTenants() {
  await seedOwnerDirectory()
  // An attacker (or a buggy client) tries to smuggle a different tenant via
  // every plausible request-input channel -- query string, body, and a
  // custom header -- none of which auth() ever reads for this purpose.
  const req = reqWithCookies(
    { [SESSION_COOKIE]: await ownerToken() },
    {
      query: { tenantId: SYNTHETIC_TENANT_ID },
      body: { tenantId: SYNTHETIC_TENANT_ID },
      headers: { 'x-tenant-id': SYNTHETIC_TENANT_ID },
    }
  )
  // reqWithCookies already set headers.cookie; merge the extra header in.
  req.headers.cookie = `${SESSION_COOKIE}=${await ownerToken()}`
  const res = fakeRes()
  await authHandler(req, res)
  const state = extractStateFromRedirect(res.location)
  const decoded = await verifyOAuthState(state)
  assert(decoded.tenantId === DEFAULT_TENANT_ID, `a client-supplied tenantId must never override the session-derived tenant -- got ${decoded.tenantId}`)
}

// --- OAuth state: signing/verification integrity ----------------------------

async function testOAuthStateSecurelyBindsTenant() {
  const state = await signOAuthState({ nonce: 'a-random-nonce', tenantId: DEFAULT_TENANT_ID, userId: 'usr_owner' })
  assert(typeof state === 'string' && state.split('.').length === 3, 'the signed state must be a JWT (three dot-separated segments), never plain base64 JSON')
  const decoded = await verifyOAuthState(state)
  assert(decoded.nonce === 'a-random-nonce' && decoded.tenantId === DEFAULT_TENANT_ID && decoded.userId === 'usr_owner',
    'every bound claim must round-trip exactly')
}

async function testModifiedStateFails() {
  const state = await signOAuthState({ nonce: 'n1', tenantId: DEFAULT_TENANT_ID, userId: 'usr_owner' })
  const tampered = state.slice(0, -4) + 'abcd' // flip the signature's tail
  assert(await verifyOAuthState(tampered) === null, 'a tampered signature must be rejected outright')

  // Tampering with a MIDDLE segment (the payload) while leaving the
  // signature untouched must also fail -- proves the check is a genuine
  // signature verification, not just "does it look like a JWT".
  const parts = state.split('.')
  const forgedPayload = Buffer.from(JSON.stringify({ purpose: 'gbp_oauth_connect', nonce: 'n1', tenantId: SYNTHETIC_TENANT_ID, userId: 'usr_owner' })).toString('base64url')
  const forged = `${parts[0]}.${forgedPayload}.${parts[2]}`
  assert(await verifyOAuthState(forged) === null, 'altering the tenantId claim without a valid re-signature must be rejected')
}

async function testExpiredStateFails() {
  const state = await signOAuthState({ nonce: 'n1', tenantId: DEFAULT_TENANT_ID, userId: 'usr_owner' }, { expiresInSeconds: -10 })
  assert(await verifyOAuthState(state) === null, 'an already-expired state must be rejected')
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Hand-rolled HS256 JWT signer using only Node's built-in crypto -- avoids
// depending on the `jose` package being resolvable from tests/ (it's a
// dashboard/-scoped dependency; oauthState.js/session.js import it fine
// from within dashboard/, but a bare `import('jose')` from tests/ cannot
// resolve it). Used only to construct a deliberately non-compliant token
// (wrong purpose claim) that signOAuthState() itself would never produce.
function forgeHS256Token(payload, { expiresInSeconds = 600 } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds }
  const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(fullPayload)))}`
  const signature = base64url(createHmac('sha256', process.env.SESSION_SIGNING_SECRET).update(signingInput).digest())
  return `${signingInput}.${signature}`
}

async function testMissingOrWrongPurposeStateFails() {
  // A validly-signed token for a DIFFERENT purpose (e.g. accidentally
  // reusing a real session token as OAuth state) must never be accepted.
  const wrongPurpose = forgeHS256Token({ purpose: 'something_else', nonce: 'n1', tenantId: DEFAULT_TENANT_ID, userId: 'usr_owner' })
  assert(await verifyOAuthState(wrongPurpose) === null, 'a token with the wrong (or missing) purpose claim must be rejected')
}

// --- /callback: full verification chain before any credential write --------

async function mockSuccessfulGoogleFetch({ accountName = 'Los Tres Amigos' } = {}) {
  globalThis.fetch = async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return { ok: true, json: async () => ({ access_token: 'fake-access-token', refresh_token: FAKE_REFRESH_TOKEN, expires_in: 3600 }) }
    }
    if (url.includes('mybusinessaccountmanagement.googleapis.com')) {
      return { ok: true, json: async () => ({ accounts: [{ accountName, name: 'accounts/123' }] }) }
    }
    throw new Error(`unexpected fetch during callback test: ${url}`)
  }
}

async function testCallbackStoresCredentialOnlyUnderVerifiedTenant() {
  await seedOwnerDirectory()
  const client = fakeCredentialRedis()
  setCredentialRedis(() => client)
  await mockSuccessfulGoogleFetch()

  const token = await ownerToken()
  const nonce = 'fresh-nonce'
  const state = await signOAuthState({ nonce, tenantId: DEFAULT_TENANT_ID, userId: 'usr_owner' })

  const req = {
    method: 'GET',
    query: { code: 'fake-auth-code', state },
    headers: { cookie: `${SESSION_COOKIE}=${token}; ${STATE_COOKIE}=${state}` },
  }
  const res = fakeRes()
  await callbackHandler(req, res)

  assert(res.statusCode === null || res.statusCode === 200, `expected the success page (200/no explicit status), got ${res.statusCode}`)
  const stored = await getStoredCredential(DEFAULT_TENANT_ID)
  assert(stored && stored.refreshToken === FAKE_REFRESH_TOKEN, 'the credential must be stored under the verified tenant\'s own key')
  // Phase 4C: Los Tres Amigos is pinned to LEGACY migration mode, so its
  // verified-tenant key resolves to the literal gbp_credentials:v1 --
  // deliberately, to keep Node and the still-v1-only Python background
  // pipeline reading/writing the same physical key for this tenant.
  assert(client._store[LEGACY_V1_KEY] !== undefined, 'the physical key written for the LEGACY-mode default tenant must be gbp_credentials:v1')
  assert(client._store[credentialKeyV2(DEFAULT_TENANT_ID)] === undefined, 'a LEGACY-mode tenant must never ALSO write its v2 key')
}

async function testCallbackForLtaCorrectlyWritesLegacyV1Key() {
  // Renamed/inverted from the pre-Phase-4C assumption that callback()
  // must NEVER write v1 for any tenant -- that blanket rule created the
  // exact Node-v2/Python-v1 split-brain Phase 4C's audit flagged. For the
  // one tenant explicitly pinned to LEGACY mode (Los Tres Amigos), writing
  // gbp_credentials:v1 is now the correct, intended behavior.
  await seedOwnerDirectory()
  const client = fakeCredentialRedis()
  setCredentialRedis(() => client)
  await mockSuccessfulGoogleFetch()

  const token = await ownerToken()
  const state = await signOAuthState({ nonce: 'n2', tenantId: DEFAULT_TENANT_ID, userId: 'usr_owner' })
  const req = {
    method: 'GET',
    query: { code: 'fake-auth-code', state },
    headers: { cookie: `${SESSION_COOKIE}=${token}; ${STATE_COOKIE}=${state}` },
  }
  await callbackHandler(req, fakeRes())

  assert(client._store[LEGACY_V1_KEY] !== undefined, 'callback() for the LEGACY-mode default tenant must write gbp_credentials:v1')
}

async function testCallbackFailsClosedOnMissingState() {
  await seedOwnerDirectory()
  const req = { method: 'GET', query: { code: 'fake-code' }, headers: { cookie: `${SESSION_COOKIE}=${await ownerToken()}` } } // no state, no cookie
  const res = fakeRes()
  await callbackHandler(req, res)
  assert(res.statusCode === 400, `expected 400 for a missing state, got ${res.statusCode}`)
}

async function testCallbackFailsClosedOnWrongCsrfCookie() {
  await seedOwnerDirectory()
  const state = await signOAuthState({ nonce: 'n3', tenantId: DEFAULT_TENANT_ID, userId: 'usr_owner' })
  const req = {
    method: 'GET',
    query: { code: 'fake-code', state },
    // Cookie holds a DIFFERENT (but validly-signed) state -- the double-submit check must reject this before signature verification even matters.
    headers: { cookie: `${SESSION_COOKIE}=${await ownerToken()}; ${STATE_COOKIE}=different-value-entirely` },
  }
  const res = fakeRes()
  await callbackHandler(req, res)
  assert(res.statusCode === 400, `expected 400 for a CSRF cookie mismatch, got ${res.statusCode}`)
}

async function testCallbackFailsClosedOnExpiredState() {
  await seedOwnerDirectory()
  const state = await signOAuthState({ nonce: 'n4', tenantId: DEFAULT_TENANT_ID, userId: 'usr_owner' }, { expiresInSeconds: -10 })
  const req = {
    method: 'GET',
    query: { code: 'fake-code', state },
    headers: { cookie: `${SESSION_COOKIE}=${await ownerToken()}; ${STATE_COOKIE}=${state}` },
  }
  const res = fakeRes()
  await callbackHandler(req, res)
  assert(res.statusCode === 400, `expected 400 for an expired state, got ${res.statusCode}`)
}

async function testCallbackFailsClosedOnModifiedState() {
  await seedOwnerDirectory()
  const state = await signOAuthState({ nonce: 'n5', tenantId: DEFAULT_TENANT_ID, userId: 'usr_owner' })
  const tampered = state.slice(0, -4) + 'abcd'
  // Attacker controls both the URL param and (hypothetically) the cookie --
  // even with a matching cookie, the signature itself must still fail.
  const req = {
    method: 'GET',
    query: { code: 'fake-code', state: tampered },
    headers: { cookie: `${SESSION_COOKIE}=${await ownerToken()}; ${STATE_COOKIE}=${tampered}` },
  }
  const res = fakeRes()
  await callbackHandler(req, res)
  assert(res.statusCode === 400, `expected 400 for a modified/tampered state, got ${res.statusCode}`)
}

async function testCallbackFailsClosedWhenStateBelongsToADifferentSession() {
  // A state validly signed for usr_owner is presented, but the CURRENT
  // authenticated session (the cookie evaluated at callback time) belongs
  // to a different Owner account entirely -- must fail closed, never
  // silently proceed using either identity.
  await seedOwnerDirectory()
  const state = await signOAuthState({ nonce: 'n6', tenantId: DEFAULT_TENANT_ID, userId: 'usr_owner' })
  const req = {
    method: 'GET',
    query: { code: 'fake-code', state },
    headers: { cookie: `${SESSION_COOKIE}=${await ownerToken('usr_owner2')}; ${STATE_COOKIE}=${state}` },
  }
  const res = fakeRes()
  await callbackHandler(req, res)
  assert(res.statusCode === 400, `expected 400 when the state's userId doesn't match the current session, got ${res.statusCode}`)
}

async function testCallbackFailsClosedWhenStateTenantDoesNotMatchCurrentSessionTenant() {
  // A state claiming a DIFFERENT (synthetic, non-onboarded) tenant than
  // the one the current, real, authenticated session actually resolves to
  // -- proves the tenant half of the cross-check, independent of userId.
  await seedOwnerDirectory()
  const state = await signOAuthState({ nonce: 'n7', tenantId: SYNTHETIC_TENANT_ID, userId: 'usr_owner' })
  const req = {
    method: 'GET',
    query: { code: 'fake-code', state },
    headers: { cookie: `${SESSION_COOKIE}=${await ownerToken()}; ${STATE_COOKIE}=${state}` },
  }
  const res = fakeRes()
  await callbackHandler(req, res)
  assert(res.statusCode === 400, `expected 400 when the state's tenantId doesn't match the current session's resolved tenant, got ${res.statusCode}`)
}

// --- Synthetic Tenant B cannot load LTA's credential (end-to-end style) ----

async function testSyntheticTenantCannotLoadLtaCredentialViaStore() {
  // Complements test_credential_store.js's own direct coverage of this --
  // here, seeded via a realistic callback-shaped write for the real
  // tenant, then read back through the store using a synthetic tenantId,
  // exactly as any endpoint (status/publish/disconnect) would.
  const client = fakeCredentialRedis()
  setCredentialRedis(() => client)
  await mockSuccessfulGoogleFetch()
  await seedOwnerDirectory()
  const state = await signOAuthState({ nonce: 'n8', tenantId: DEFAULT_TENANT_ID, userId: 'usr_owner' })
  await callbackHandler(
    { method: 'GET', query: { code: 'fake-code', state }, headers: { cookie: `${SESSION_COOKIE}=${await ownerToken()}; ${STATE_COOKIE}=${state}` } },
    fakeRes()
  )
  const tenantBView = await getStoredCredential(SYNTHETIC_TENANT_ID)
  assert(tenantBView === null, 'a synthetic Tenant B must see no credential at all after Los Tres Amigos connects')
}

// --- No secrets leak through this test's own execution ----------------------

async function testNoSecretTokensAppearInCapturedOutput() {
  await seedOwnerDirectory()
  const client = fakeCredentialRedis()
  setCredentialRedis(() => client)
  await mockSuccessfulGoogleFetch()

  const originalLog = console.log
  const originalError = console.error
  const captured = []
  console.log = (...args) => captured.push(args.join(' '))
  console.error = (...args) => captured.push(args.join(' '))
  try {
    const state = await signOAuthState({ nonce: 'n9', tenantId: DEFAULT_TENANT_ID, userId: 'usr_owner' })
    const req = { method: 'GET', query: { code: 'fake-code', state }, headers: { cookie: `${SESSION_COOKIE}=${await ownerToken()}; ${STATE_COOKIE}=${state}` } }
    const res = fakeRes()
    await callbackHandler(req, res)
    const combined = captured.join('\n') + JSON.stringify(res.body ?? '')
    assert(!combined.includes(FAKE_REFRESH_TOKEN), 'the refresh token must never appear in logs or the response body')
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

async function main() {
  console.log('--- OAUTH START: TENANT DERIVATION ---')
  await run('auth() derives tenantId from the authenticated session', testAuthDerivesTenantFromAuthenticatedSession)
  await run('a client-supplied tenantId (query/body/header) cannot switch OAuth tenants', testClientSuppliedTenantIdCannotSwitchOAuthTenants)

  console.log('\n--- OAUTH STATE INTEGRITY ---')
  await run('OAuth state securely binds nonce/tenantId/userId in a signed JWT, not plain base64 JSON', testOAuthStateSecurelyBindsTenant)
  await run('a modified/tampered state is rejected', testModifiedStateFails)
  await run('an expired state is rejected', testExpiredStateFails)
  await run('a state with the wrong or missing purpose claim is rejected', testMissingOrWrongPurposeStateFails)

  console.log('\n--- CALLBACK VERIFICATION CHAIN ---')
  await run('callback() stores the credential only under the verified tenant\'s (migration-mode-resolved) key', testCallbackStoresCredentialOnlyUnderVerifiedTenant)
  await run('callback() for the LEGACY-mode default tenant (Los Tres Amigos) correctly writes gbp_credentials:v1', testCallbackForLtaCorrectlyWritesLegacyV1Key)
  await run('callback() fails closed on a missing state', testCallbackFailsClosedOnMissingState)
  await run('callback() fails closed on a CSRF cookie mismatch', testCallbackFailsClosedOnWrongCsrfCookie)
  await run('callback() fails closed on an expired state', testCallbackFailsClosedOnExpiredState)
  await run('callback() fails closed on a modified/tampered state', testCallbackFailsClosedOnModifiedState)
  await run('callback() fails closed when the state belongs to a different user\'s session', testCallbackFailsClosedWhenStateBelongsToADifferentSession)
  await run('callback() fails closed when the state\'s tenant does not match the current session\'s tenant', testCallbackFailsClosedWhenStateTenantDoesNotMatchCurrentSessionTenant)

  console.log('\n--- CROSS-TENANT ISOLATION ---')
  await run('a synthetic Tenant B cannot load Los Tres Amigos\' credential after a real connect', testSyntheticTenantCannotLoadLtaCredentialViaStore)

  console.log('\n--- NO SECRET LEAKAGE ---')
  await run('no refresh token appears in logs or response bodies during a real callback run', testNoSecretTokensAppearInCapturedOutput)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
