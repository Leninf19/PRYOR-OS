// Google Integration + Reviews End-to-End Validation, Part A -- regression
// tests proving GET /api/google/test-connection is gated by the narrow,
// owner-only Permission.SETTINGS_ADMIN (a real, multi-call live diagnostic
// that reads actual review content and Vercel-configuration-level error
// detail), while GET /api/google/status stays gated by the broad
// Permission.INTEGRATIONS_VIEW every role holds (a cheap "is Google
// connected" read). The two must NOT share a gate -- this file is the
// direct proof they don't, plus that a denied test-connection call never
// even reaches Google (no quota consumed).
//
// Run directly: node tests/test_google_test_connection_permission.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'

import bcrypt from 'bcryptjs'
import googleHandler from '../dashboard/api/google/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import { setStoredCredential, _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis } from '../dashboard/api/_lib/credentialStore.js'

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
    resetCredentialRedis()
    delete process.env.ACCOUNT_DIRECTORY_JSON
    globalThis.fetch = undefined
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

function fakeCredentialRedis(initial = null) {
  let value = initial
  return {
    get: async () => value,
    set: async (_key, v) => { value = v },
    del: async () => { value = null },
    eval: async (_script, _keys, args) => {
      const [expectedVersionStr, nextJson] = args
      let currentVersion = '0'
      if (value) {
        try { const d = JSON.parse(value); if (d?.credentialVersion !== undefined) currentVersion = String(d.credentialVersion) } catch {}
      }
      if (currentVersion !== expectedVersionStr) return value ?? false
      value = nextJson
      return true
    },
  }
}

// A factory that recreates a fresh fakeCredentialRedis() on every call would
// silently lose whatever setStoredCredential() just wrote (a NEW, empty
// instance on the very next read) -- this wires ONE instance for the
// lifetime of a single test, the same pattern every other test file in this
// suite uses (see test_publish_reply.js/test_google_oauth_auto_recovery.js).
function wireCredentialRedis() {
  const client = fakeCredentialRedis()
  setCredentialRedis(() => client)
  return client
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' },
      { userId: 'usr_admin', email: 'admin@example.com', passwordHash: hash, role: 'admin', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Admin' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Marketing' },
      { userId: 'usr_lm', email: 'lm@example.com', passwordHash: hash, role: 'location_manager', locationIds: [1], sessionVersion: 1, disabled: false, displayName: 'Location Manager' },
      { userId: 'usr_ro', email: 'ro@example.com', passwordHash: hash, role: 'read_only', locationIds: [1], sessionVersion: 1, disabled: false, displayName: 'Read Only' },
    ],
  })
}

const tokenFor = (userId, email, role, locationIds) =>
  signSession({ userId, email, role, locationIds, tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })

// `token` may be a raw string or (as every call site above actually passes)
// a still-pending Promise<string> from tokenFor() -- awaited here once so
// every call site stays a plain, un-cluttered `tokenFor(...)` rather than
// needing its own `await`.
async function invoke(action, token) {
  const resolvedToken = await token
  const req = { method: 'GET', query: { action }, body: {}, headers: resolvedToken ? { cookie: `lta_session=${resolvedToken}` } : {}, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await googleHandler(req, res)
  return res
}

function mockPassingGoogleDiagnosticChain() {
  globalThis.fetch = async (url) => {
    if (typeof url !== 'string') throw new Error('unexpected non-string fetch url')
    if (url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'fresh-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/business.manage' }) }
    }
    if (url.includes('mybusinessaccountmanagement.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ accounts: [{ accountName: 'Los Tres Amigos', name: 'accounts/1' }] }) }
    }
    if (url.includes('mybusinessbusinessinformation.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ locations: [{ name: 'locations/1', title: 'Location One' }] }) }
    }
    if (url.includes('mybusiness.googleapis.com/v4') && url.includes('/reviews')) {
      return { ok: true, status: 200, json: async () => ({ reviews: [] }) }
    }
    throw new Error(`unexpected fetch during test-connection: ${url}`)
  }
}

async function testOwnerCanRunTestConnection() {
  await setDirectory()
  wireCredentialRedis()
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'real-refresh-token', connectedAccountName: 'Los Tres Amigos' })
  mockPassingGoogleDiagnosticChain()

  const res = await invoke('test-connection', tokenFor('usr_owner', 'owner@example.com', 'owner', '*'))
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.overallStatus === 'pass', `expected the full diagnostic chain to pass, got ${JSON.stringify(res.body)}`)
}

async function testNonOwnerRolesAreDeniedTestConnectionWithoutEverCallingGoogle() {
  await setDirectory()
  wireCredentialRedis()
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'real-refresh-token', connectedAccountName: 'Los Tres Amigos' })
  // Every non-owner role must be denied BEFORE any Google API call is
  // attempted -- a genuine 403 that consumes zero of the tenant's GBP quota,
  // not merely a check that happens to fail deep in the diagnostic chain.
  globalThis.fetch = async (url) => { throw new Error(`test-connection must never reach Google for a denied role: ${url}`) }

  const roles = [
    ['usr_admin', 'admin@example.com', 'admin', '*'],
    ['usr_marketing', 'marketing@example.com', 'marketing', '*'],
    ['usr_lm', 'lm@example.com', 'location_manager', [1]],
    ['usr_ro', 'ro@example.com', 'read_only', [1]],
  ]
  for (const [userId, email, role, locationIds] of roles) {
    const res = await invoke('test-connection', tokenFor(userId, email, role, locationIds))
    assert(res.statusCode === 403, `${role}: expected 403 from test-connection, got ${res.statusCode}`)
    assert(res.body.error === 'forbidden', `${role}: expected error: forbidden, got ${JSON.stringify(res.body)}`)
  }
}

async function testUnauthenticatedRequestDeniedBeforeAnyGoogleCall() {
  globalThis.fetch = async (url) => { throw new Error(`must never reach Google when unauthenticated: ${url}`) }
  const res = await invoke('test-connection', null)
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

// The direct proof that test-connection's NEW narrow gate did not
// accidentally narrow status() too -- the two endpoints must now have
// genuinely DIFFERENT authorization surfaces for the exact same tenant and
// the exact same non-owner accounts.
async function testStatusRemainsBroadlyAvailableWhileTestConnectionDoesNot() {
  await setDirectory()
  wireCredentialRedis()
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'real-refresh-token', connectedAccountName: 'Los Tres Amigos' })

  globalThis.fetch = async (url) => {
    if (typeof url === 'string' && url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'fresh-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/business.manage' }) }
    }
    if (typeof url === 'string' && url.includes('mybusinessaccountmanagement.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ accounts: [{ accountName: 'Los Tres Amigos', name: 'accounts/1' }] }) }
    }
    throw new Error(`unexpected fetch during status(): ${url}`)
  }
  const statusRes = await invoke('status', tokenFor('usr_lm', 'lm@example.com', 'location_manager', [1]))
  assert(statusRes.statusCode === 200 && statusRes.body.connected === true, `a location_manager must still get a real, connected status() read, got ${statusRes.statusCode} ${JSON.stringify(statusRes.body)}`)
  assert(statusRes.body.canManageIntegration === false)

  globalThis.fetch = async (url) => { throw new Error(`test-connection must never reach Google for this same account: ${url}`) }
  const testConnRes = await invoke('test-connection', tokenFor('usr_lm', 'lm@example.com', 'location_manager', [1]))
  assert(testConnRes.statusCode === 403, `the SAME location_manager must be denied the deeper diagnostic, got ${testConnRes.statusCode}`)
}

const tests = [
  ['an Owner can run the full test-connection diagnostic', testOwnerCanRunTestConnection],
  ['every non-owner role is denied test-connection with a 403, before any Google API call is attempted', testNonOwnerRolesAreDeniedTestConnectionWithoutEverCallingGoogle],
  ['an unauthenticated request is denied before any Google call', testUnauthenticatedRequestDeniedBeforeAnyGoogleCall],
  ['status() stays broadly available while test-connection() does not, for the SAME non-owner account', testStatusRemainsBroadlyAvailableWhileTestConnectionDoesNot],
]

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
