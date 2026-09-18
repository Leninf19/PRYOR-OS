// Preview Infrastructure Isolation -- dedicated regression coverage for
// dispatchTenantLifecycleWorkflow()'s environment derivation (dashboard/api/
// google/[action].js). Complements test_phase4o_automatic_provisioning.js
// (which pins VERCEL_ENV='production' and covers the accepted/rejected/
// ambiguous HTTP-outcome classification already) and
// tests/test_tenant_lifecycle_dispatch_workflow.py (which proves the
// GitHub Actions workflow's own environment-scoped-secret gating).
//
// This file proves, through the REAL HTTP approve-locations path (never a
// unit call to an unexported helper), that:
//   - the environment sent to GitHub is derived SOLELY from this server
//     process's own VERCEL_ENV -- never from anything in the request;
//   - an unresolvable VERCEL_ENV (unset, 'development', or any unknown
//     value) refuses to dispatch AT ALL -- the GitHub API is never even
//     called, so there is zero chance of it running against either
//     infrastructure with a guessed/defaulted environment.
//
// No real Upstash account, no real GitHub API call, no real Google network
// call anywhere in this file.
//
// Run directly: node tests/test_preview_lifecycle_isolation.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'
process.env.TENANT_PROVISIONING_DISPATCH_PAT = 'fake-dispatch-pat-not-a-real-secret'

import bcrypt from 'bcryptjs'
import googleHandler from '../dashboard/api/google/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import {
  getTenantConfig, upsertTenantConfig,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'
import { setStoredCredential, _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis } from '../dashboard/api/_lib/credentialStore.js'
import { _setRedisClientForTests as setDiscoveryRedis, _resetRedisClientForTests as resetDiscoveryRedis } from '../dashboard/api/_lib/locationDiscoveryStore.js'
import { _setLimiterFactoryForTests, _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
async function run(name, fn) {
  // Several of these tests set VERCEL_ENV='production', which trips
  // rateLimit.js's own, entirely unrelated, pre-existing "never fail open
  // in production" hardening unless a real Upstash config or this
  // test-only limiter seam is present. A permissive fake keeps every test
  // here exercising ONLY environment-derivation logic.
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: true, remaining: 999, reset: Date.now() + 60000 }) }))
  try {
    await fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  } finally {
    resetUserRedis()
    resetCredentialRedis()
    resetConfigRedis()
    resetDiscoveryRedis()
    _resetLimiterFactoryForTests()
    delete globalThis.fetch
    delete process.env.VERCEL_ENV
    delete process.env.VERCEL_GIT_COMMIT_REF
  }
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

function fakeHashRedis() {
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

function fakeKeyValueRedis() {
  const store = {}
  return {
    get: async (key) => store[key] ?? null,
    set: async (key, value) => { store[key] = value },
    del: async (key) => { delete store[key] },
  }
}

function fakeUserRedis(users) {
  const store = { 'users:v1': { ...users } }
  return {
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hget: async (key, field) => store[key]?.[field] ?? null,
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value; return res }
  res.getHeader = (name) => res.headers[name]
  return res
}

function wireSharedStores() {
  const configClient = fakeHashRedis()
  setConfigRedis(() => configClient)
  const credentialClient = fakeKeyValueRedis()
  setCredentialRedis(() => credentialClient)
  const discoveryClient = fakeKeyValueRedis()
  setDiscoveryRedis(() => discoveryClient)
}

// Routes Google's own endpoints normally; routes GitHub's workflow_dispatch
// endpoint to a caller-supplied callback that captures (url, opts) so the
// exact dispatch body can be inspected.
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
    throw new Error(`unexpected fetch in test: ${u}`)
  }
}

async function setupTenant(tenantId, { userId, email }) {
  const hash = await passwordHash()
  const record = { userId, email, passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId }
  setUserRedis(() => fakeUserRedis({ [userId]: JSON.stringify(record) }))
  if (!(await getTenantConfig(tenantId))) {
    await upsertTenantConfig(tenantId, {}, { allowCreate: true, creationSource: 'migration' })
  }
  await setStoredCredential(tenantId, { refreshToken: `fake-refresh-token-${tenantId}`, connectedAccountName: 'Fake Account' })
}

async function tokenFor(userId, email, tenantId) {
  return signSession({ userId, email, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
}

async function discover(token) {
  const req = { method: 'POST', query: { action: 'discover-locations' }, headers: { cookie: `${SESSION_COOKIE}=${token}` } }
  const res = fakeRes()
  await googleHandler(req, res)
  return res
}

async function approve(token, body) {
  const req = { method: 'POST', query: { action: 'approve-locations' }, body, headers: { cookie: `${SESSION_COOKIE}=${token}` } }
  const res = fakeRes()
  await googleHandler(req, res)
  return res
}

let tenantCounter = 0
async function approveFreshLocation(accountName, googleLocationId, fetchImpl, extraApproveBodyFields = {}) {
  tenantCounter += 1
  const tenantId = `t_preview-iso-${tenantCounter}`
  await setupTenant(tenantId, { userId: `usr_${tenantId}`, email: `${tenantId}@example.com` })
  const token = await tokenFor(`usr_${tenantId}`, `${tenantId}@example.com`, tenantId)
  globalThis.fetch = fetchImpl
  const discoverRes = await discover(token)
  assert(discoverRes.statusCode === 200, `sanity: discover must succeed, got ${discoverRes.statusCode} ${JSON.stringify(discoverRes.body)}`)
  const discoveredGoogleLocationId = discoverRes.body.locations[0].googleLocationId
  const approveRes = await approve(token, {
    discoverySessionId: discoverRes.body.discoverySessionId,
    selectedGoogleLocationIds: [discoveredGoogleLocationId],
    ...extraApproveBodyFields,
  })
  return { tenantId, approveRes }
}

// ===========================================================================
// 1. Environment is derived from VERCEL_ENV and included in the dispatch
// ===========================================================================

async function testPreviewVercelEnvSendsPreviewEnvironment() {
  wireSharedStores()
  process.env.VERCEL_ENV = 'preview'
  let capturedBody = null
  const { approveRes } = await approveFreshLocation('accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
      githubDispatch: async () => ({ status: 204 }),
      onGithubDispatch: (_url, opts) => { capturedBody = JSON.parse(opts.body) },
    }))
  assert(approveRes.statusCode === 200, `sanity: approval must succeed, got ${approveRes.statusCode}`)
  assert(approveRes.body.status === 'provisioning', `expected 'provisioning', got ${approveRes.body.status}`)
  assert(capturedBody?.inputs?.environment === 'preview', `expected inputs.environment 'preview', got ${JSON.stringify(capturedBody?.inputs?.environment)}`)
  // Blocker 2 fix -- the dispatch's own top-level `ref` (which branch's
  // copy of the WORKFLOW FILE executes) must be the approved Preview ref,
  // never 'main' -- main does not yet contain the Preview-isolation
  // workflow logic being smoke-tested.
  assert(capturedBody?.ref === 'feature/google-social-auth', `expected ref 'feature/google-social-auth', got ${JSON.stringify(capturedBody?.ref)}`)
}

// ===========================================================================
// 1b. Blocker 2 -- server-derived git ref, never main for Preview
// ===========================================================================

async function testProductionVercelEnvSendsMainRef() {
  wireSharedStores()
  process.env.VERCEL_ENV = 'production'
  let capturedBody = null
  const { approveRes } = await approveFreshLocation('accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
      githubDispatch: async () => ({ status: 204 }),
      onGithubDispatch: (_url, opts) => { capturedBody = JSON.parse(opts.body) },
    }))
  assert(approveRes.statusCode === 200, `sanity: approval must succeed, got ${approveRes.statusCode}`)
  assert(capturedBody?.ref === 'main', `Production must keep dispatching ref 'main' exactly as before, got ${JSON.stringify(capturedBody?.ref)}`)
  assert(capturedBody?.inputs?.environment === 'production')
}

async function testPreviewRefMismatchWithDeployedRefFailsClosed() {
  wireSharedStores()
  process.env.VERCEL_ENV = 'preview'
  // Vercel's OWN trusted deployment metadata disagrees with the one
  // approved Preview ref -- e.g. a preview build of some unrelated
  // branch. Must refuse rather than dispatch the approved ref anyway
  // against what might be genuinely different running code.
  process.env.VERCEL_GIT_COMMIT_REF = 'some-other-unrelated-branch'
  let dispatchCallCount = 0
  const { approveRes } = await approveFreshLocation('accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
      githubDispatch: async () => ({ status: 204 }),
      onGithubDispatch: () => { dispatchCallCount += 1 },
    }))
  assert(dispatchCallCount === 0, 'a mismatched VERCEL_GIT_COMMIT_REF must refuse to dispatch at all, never fall back to the approved ref anyway')
  assert(approveRes.body.status === 'provisioning_dispatch_failed', `expected 'provisioning_dispatch_failed', got ${approveRes.body.status}`)
}

async function testPreviewRefMatchingDeployedRefSucceeds() {
  wireSharedStores()
  process.env.VERCEL_ENV = 'preview'
  process.env.VERCEL_GIT_COMMIT_REF = 'feature/google-social-auth'
  let capturedBody = null
  const { approveRes } = await approveFreshLocation('accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
      githubDispatch: async () => ({ status: 204 }),
      onGithubDispatch: (_url, opts) => { capturedBody = JSON.parse(opts.body) },
    }))
  assert(approveRes.statusCode === 200)
  assert(approveRes.body.status === 'provisioning', `expected 'provisioning', got ${approveRes.body.status}`)
  assert(capturedBody?.ref === 'feature/google-social-auth', `expected the approved Preview ref, got ${JSON.stringify(capturedBody?.ref)}`)
}

async function testPreviewWithoutDeployedRefMetadataStillUsesApprovedConstant() {
  wireSharedStores()
  process.env.VERCEL_ENV = 'preview'
  // VERCEL_GIT_COMMIT_REF deliberately left unset -- absence is not
  // treated as a mismatch (only a genuine, positive disagreement is), so
  // the fixed, reviewed constant remains authoritative.
  let capturedBody = null
  const { approveRes } = await approveFreshLocation('accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
      githubDispatch: async () => ({ status: 204 }),
      onGithubDispatch: (_url, opts) => { capturedBody = JSON.parse(opts.body) },
    }))
  assert(approveRes.body.status === 'provisioning')
  assert(capturedBody?.ref === 'feature/google-social-auth')
}

// ===========================================================================
// 2. Fail-closed: unresolvable VERCEL_ENV never calls GitHub at all
// ===========================================================================

async function testUnsetVercelEnvNeverCallsGithubAndFailsDispatch() {
  wireSharedStores()
  // VERCEL_ENV deliberately left unset -- simulates any execution context
  // Vercel itself would not label 'production' or 'preview' (e.g. a local
  // `node` process, a misconfigured runtime).
  let dispatchCallCount = 0
  const { tenantId, approveRes } = await approveFreshLocation('accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
      githubDispatch: async () => ({ status: 204 }),
      onGithubDispatch: () => { dispatchCallCount += 1 },
    }))
  assert(approveRes.statusCode === 200, 'sanity: the approval itself must still succeed even though the automatic dispatch is refused')
  assert(dispatchCallCount === 0, 'an unresolvable environment must NEVER result in a GitHub API call -- fail closed BEFORE any network request')
  assert(approveRes.body.status === 'provisioning_dispatch_failed', `expected 'provisioning_dispatch_failed', got ${approveRes.body.status}`)

  const config = await getTenantConfig(tenantId)
  assert(config.status === 'provisioning_dispatch_failed')
  assert(typeof config.provisioning?.lastError === 'string' && /environment/i.test(config.provisioning.lastError),
    `expected lastError to mention the environment problem, got ${JSON.stringify(config.provisioning?.lastError)}`)
}

async function testDevelopmentVercelEnvNeverCallsGithubAndFailsDispatch() {
  wireSharedStores()
  process.env.VERCEL_ENV = 'development'
  let dispatchCallCount = 0
  const { approveRes } = await approveFreshLocation('accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
      githubDispatch: async () => ({ status: 204 }),
      onGithubDispatch: () => { dispatchCallCount += 1 },
    }))
  assert(dispatchCallCount === 0, "'development' (vercel dev / local) must never be treated as either supported environment")
  assert(approveRes.body.status === 'provisioning_dispatch_failed', `expected 'provisioning_dispatch_failed', got ${approveRes.body.status}`)
}

async function testUnknownVercelEnvValueNeverCallsGithubAndFailsDispatch() {
  wireSharedStores()
  process.env.VERCEL_ENV = 'staging' // not a real Vercel value, but proves the allowlist is exact, not a denylist
  let dispatchCallCount = 0
  const { approveRes } = await approveFreshLocation('accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
      githubDispatch: async () => ({ status: 204 }),
      onGithubDispatch: () => { dispatchCallCount += 1 },
    }))
  assert(dispatchCallCount === 0, 'any unrecognized VERCEL_ENV value must fail closed, never fall through to a default')
  assert(approveRes.body.status === 'provisioning_dispatch_failed')
}

// ===========================================================================
// 3. No browser-supplied field can influence the dispatched environment
// ===========================================================================

async function testForgedEnvironmentFieldInRequestBodyIsIgnored() {
  wireSharedStores()
  process.env.VERCEL_ENV = 'production'
  let capturedBody = null
  // A forged/extraneous `environment` field on the approve-locations
  // request body itself -- approveLocations() never reads any such field
  // (dispatchTenantLifecycleWorkflow() takes only (operation, tenantId)),
  // but this proves it end-to-end through the real HTTP path rather than
  // merely by code inspection.
  const { approveRes } = await approveFreshLocation('accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
      githubDispatch: async () => ({ status: 204 }),
      onGithubDispatch: (_url, opts) => { capturedBody = JSON.parse(opts.body) },
    }),
    { environment: 'preview', vercelEnv: 'preview', VERCEL_ENV: 'preview' })
  assert(approveRes.statusCode === 200, `sanity: approval must succeed, got ${approveRes.statusCode}`)
  assert(capturedBody?.inputs?.environment === 'production',
    `a browser-supplied 'environment'-shaped field must be completely ignored -- expected the SERVER's own VERCEL_ENV ('production') to win, got ${JSON.stringify(capturedBody?.inputs?.environment)}`)
}

// Blocker 2 fix -- the same proof, but for the git ref: a forged `ref`/
// `gitRef`/`branch` field on the request body must have zero influence on
// which workflow-file ref is dispatched.
async function testForgedRefFieldsInRequestBodyAreIgnored() {
  wireSharedStores()
  process.env.VERCEL_ENV = 'preview'
  let capturedBody = null
  const { approveRes } = await approveFreshLocation('accounts/1', 'locations/1',
    mockFetchRouter({ 'accounts/1': [{ name: 'locations/1', title: 'Location' }] }, {
      githubDispatch: async () => ({ status: 204 }),
      onGithubDispatch: (_url, opts) => { capturedBody = JSON.parse(opts.body) },
    }),
    { ref: 'main', gitRef: 'main', branch: 'main', workflowRef: 'main' })
  assert(approveRes.statusCode === 200, `sanity: approval must succeed, got ${approveRes.statusCode}`)
  assert(capturedBody?.ref === 'feature/google-social-auth',
    `a browser-supplied ref-shaped field must be completely ignored -- expected the SERVER's own approved Preview ref to win, got ${JSON.stringify(capturedBody?.ref)}`)
}

const tests = [
  ['previewVercelEnvSendsPreviewEnvironment', testPreviewVercelEnvSendsPreviewEnvironment],
  ['productionVercelEnvSendsMainRef', testProductionVercelEnvSendsMainRef],
  ['previewRefMismatchWithDeployedRefFailsClosed', testPreviewRefMismatchWithDeployedRefFailsClosed],
  ['previewRefMatchingDeployedRefSucceeds', testPreviewRefMatchingDeployedRefSucceeds],
  ['previewWithoutDeployedRefMetadataStillUsesApprovedConstant', testPreviewWithoutDeployedRefMetadataStillUsesApprovedConstant],
  ['unsetVercelEnvNeverCallsGithubAndFailsDispatch', testUnsetVercelEnvNeverCallsGithubAndFailsDispatch],
  ['developmentVercelEnvNeverCallsGithubAndFailsDispatch', testDevelopmentVercelEnvNeverCallsGithubAndFailsDispatch],
  ['unknownVercelEnvValueNeverCallsGithubAndFailsDispatch', testUnknownVercelEnvValueNeverCallsGithubAndFailsDispatch],
  ['forgedEnvironmentFieldInRequestBodyIsIgnored', testForgedEnvironmentFieldInRequestBodyIsIgnored],
  ['forgedRefFieldsInRequestBodyAreIgnored', testForgedRefFieldsInRequestBodyAreIgnored],
]

for (const [name, fn] of tests) {
  await run(name, fn)
}

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} tests passed`)
process.exit(passed === results.length ? 0 : 1)
