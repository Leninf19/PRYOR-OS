// Regression tests for the "automatic recovery" requirement (Phase 8,
// Milestone 8.7): if Google reports invalid_grant/revoked/expired anywhere
// (a status check, test-connection, or a failed publish), the stored
// connection health must flip immediately -- the very next status read
// must already reflect "Reconnect Required" (one of GoogleHealth's
// token_expired/token_revoked states), never a silent failure that leaves
// the dashboard showing a stale "Connected".
//
// Run directly: node tests/test_google_oauth_auto_recovery.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/google/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import {
  _setRedisClientForTests, _resetRedisClientForTests, setStoredCredential, getStoredCredential, GoogleHealth,
} from '../dashboard/api/_lib/credentialStore.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

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
    _resetRedisClientForTests()
    _resetLimiterFactoryForTests()
  }
}

function fakeCredentialRedis(initial = null) {
  let value = initial
  return { get: async () => value, set: async (_key, v) => { value = v }, del: async () => { value = null } }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{ userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner Person' }],
  })
}
const ownerToken = () => signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })

async function invokeStatus(token) {
  globalThis.fetch = async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) }
    }
    throw new Error(`unexpected fetch during a rejected token exchange: ${url}`)
  }
  const req = { method: 'GET', query: { action: 'status' }, body: {}, headers: { cookie: `lta_session=${token}` } }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function testStatusFlipsToReconnectRequiredOnInvalidGrant() {
  await setDirectory()
  const client = fakeCredentialRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential({ refreshToken: 'now-revoked-token', connectedAccountName: 'Los Tres Amigos' })

  const before = await getStoredCredential()
  assert(before.health === GoogleHealth.CONNECTED, 'sanity check: starts connected')

  const res = await invokeStatus(await ownerToken())
  assert(res.statusCode === 200, `expected 200 (status is always 200, state carries the signal), got ${res.statusCode}`)
  assert(res.body.connected === false, 'connected must flip to false')
  assert(res.body.state === GoogleHealth.TOKEN_REVOKED, `expected state token_revoked, got ${res.body.state}`)

  // The critical assertion: the health flip must already be PERSISTED by
  // the time this response is sent -- the very next independent read must
  // see it too, without needing a second manual check.
  const after = await getStoredCredential()
  assert(after.health === GoogleHealth.TOKEN_REVOKED, 'the stored health must be updated BEFORE the response is sent, not lazily on a later request')
  assert(after.lastFailedSyncAt !== null, 'lastFailedSyncAt must be stamped')
  assert(after.lastFailureReason === 'invalid_grant', 'the failure reason must be recorded')
}

async function testSubsequentSuccessfulStatusRestoresConnected() {
  await setDirectory()
  const client = fakeCredentialRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential({ refreshToken: 'a-token', connectedAccountName: null })

  // First: simulate the failure.
  await invokeStatus(await ownerToken())
  assert((await getStoredCredential()).health === GoogleHealth.TOKEN_REVOKED, 'sanity check: failed first')

  // Then: simulate a successful reconnect (as if the Owner reconnected and
  // the token now works) -- fetch is remocked for a passing exchange.
  globalThis.fetch = async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'fresh-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/business.manage' }) }
    }
    if (url.includes('mybusinessaccountmanagement.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ accounts: [{ accountName: 'Los Tres Amigos', name: 'accounts/123' }] }) }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  const req = { method: 'GET', query: { action: 'status' }, body: {}, headers: { cookie: `lta_session=${await ownerToken()}` } }
  const res = fakeRes()
  await handler(req, res)

  assert(res.body.connected === true && res.body.state === GoogleHealth.CONNECTED, 'a subsequent successful check must restore Connected')
  const after = await getStoredCredential()
  assert(after.health === GoogleHealth.CONNECTED, 'the stored health must also be restored to connected')
  assert(after.lastFailureReason === null, 'the prior failure reason must be cleared on success')
}

async function testNeverConnectedReturnsCorrectState() {
  await setDirectory()
  _setRedisClientForTests(() => fakeCredentialRedis())
  const req = { method: 'GET', query: { action: 'status' }, body: {}, headers: { cookie: `lta_session=${await ownerToken()}` } }
  const res = fakeRes()
  globalThis.fetch = async (url) => { throw new Error(`fetch must not be called when never connected: ${url}`) }
  await handler(req, res)
  assert(res.body.state === GoogleHealth.NEVER_CONNECTED, `expected never_connected, got ${res.body.state}`)
  assert(res.body.connected === false)
}

async function testFailedPublishAlsoTriggersAutomaticRecovery() {
  // "Anywhere" per the spec includes a failed publish attempt, not just a
  // manual status/test-connection check.
  await setDirectory()
  const client = fakeCredentialRedis()
  _setRedisClientForTests(() => client)
  await setStoredCredential({ refreshToken: 'now-revoked-token', connectedAccountName: null })

  globalThis.fetch = async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ error: 'invalid_grant', error_description: 'Token has been revoked.' }) }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  const req = {
    method: 'POST', query: { action: 'publish' },
    body: { reviewName: 'accounts/1/locations/2/reviews/3', replyText: 'Thanks!' },
    headers: { cookie: `lta_session=${await ownerToken()}` },
  }
  const res = fakeRes()
  await handler(req, res)
  assert(res.statusCode === 503, `a publish attempt with a revoked token must fail with 503 not_connected, got ${res.statusCode}`)

  const after = await getStoredCredential()
  assert(after.health === GoogleHealth.TOKEN_REVOKED, 'a failed publish must also flip the stored connection health, not just status/test-connection checks')
}

async function main() {
  await run('a status check with an invalid_grant response flips stored health to token_revoked BEFORE responding', testStatusFlipsToReconnectRequiredOnInvalidGrant)
  await run('a subsequent successful status check restores health to connected and clears the failure reason', testSubsequentSuccessfulStatusRestoresConnected)
  await run('never having connected reports state: never_connected', testNeverConnectedReturnsCorrectState)
  await run('a failed publish attempt also triggers automatic recovery (health flips), not just status/test-connection', testFailedPublishAlsoTriggersAutomaticRecovery)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
