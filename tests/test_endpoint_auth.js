// Confirms every write-capable / sensitive endpoint rejects unauthenticated
// requests before doing anything else (no fetch to Google/GitHub/Anthropic
// ever fires for an unauthenticated caller -- global.fetch is left
// unmocked/throwing in the unauthenticated tests specifically so a handler
// that skipped the auth check and tried a real network call would fail
// loudly instead of silently passing), plus the apply=true confirmation
// requirement on trigger-import.js.
//
// Run directly: node tests/test_endpoint_auth.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
delete process.env.ACCOUNT_DIRECTORY_JSON // unauthenticated by construction

import bcrypt from 'bcryptjs'
import googleHandler from '../dashboard/api/google/[action].js'
import rewriteHandler from '../dashboard/api/rewrite.js'
import executiveBriefHandler from '../dashboard/api/executive-brief.js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests as _setCredentialRedisForTests, _resetRedisClientForTests as _resetCredentialRedisForTests, setStoredCredential } from '../dashboard/api/_lib/credentialStore.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

// All google/*.js files below were merged into the consolidated dispatch
// file (Phase 8, Milestone 8.2) -- these wrappers keep every call site
// further down exactly as it read before the merge, just routing through
// req.query.action.
function statusHandler(req, res) { return googleHandler({ ...req, query: { ...req.query, action: 'status' } }, res) }
function testConnectionHandler(req, res) { return googleHandler({ ...req, query: { ...req.query, action: 'test-connection' } }, res) }
function triggerSyncHandler(req, res) { return googleHandler({ ...req, query: { ...req.query, action: 'trigger-sync' } }, res) }
function triggerImportHandler(req, res) { return googleHandler({ ...req, query: { ...req.query, action: 'trigger-import' } }, res) }
function disconnectHandler(req, res) { return googleHandler({ ...req, query: { ...req.query, action: 'disconnect' } }, res) }

process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
function fakeCredentialRedis(initial = null) {
  let value = initial
  return { get: async () => value, set: async (_key, v) => { value = v }, del: async () => { value = null } }
}

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
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

async function expectUnauthenticated(name, handler, method, body) {
  globalThis.fetch = async (url) => { throw new Error(`fetch must not be called (unauthenticated): ${url}`) }
  const req = { method, body, headers: {} }
  const res = fakeRes()
  await handler(req, res)
  assert(res.statusCode === 401, `${name}: expected 401, got ${res.statusCode}`)
}

async function testAllEndpointsRejectUnauthenticated() {
  await expectUnauthenticated('status.js', statusHandler, 'GET')
  await expectUnauthenticated('test-connection.js', testConnectionHandler, 'GET')
  await expectUnauthenticated('trigger-sync.js', triggerSyncHandler, 'POST')
  await expectUnauthenticated('trigger-import.js', triggerImportHandler, 'POST', { apply: false })
  await expectUnauthenticated('google/disconnect', disconnectHandler, 'POST', { confirm: 'DISCONNECT' })
  await expectUnauthenticated('rewrite.js', rewriteHandler, 'POST', { tone: 'friendly' })
  await expectUnauthenticated('executive-brief.js', executiveBriefHandler, 'POST', { totalReviews: 1 })
}

async function ownerDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{ userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false }],
  })
  return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
}

async function testTriggerImportApplyRequiresConfirmPhrase() {
  const token = await ownerDirectory()
  process.env.GITHUB_SYNC_PAT = 'fake-pat'
  globalThis.fetch = async (url) => { throw new Error(`fetch must not be called without the confirm phrase: ${url}`) }

  const req = { method: 'POST', body: { apply: true }, headers: { cookie: `lta_session=${token}` } }
  const res = fakeRes()
  await triggerImportHandler(req, res)
  assert(res.statusCode === 400, `expected 400 without confirm phrase, got ${res.statusCode}`)
  assert(res.body.error === 'confirmation_required', res.body.error)
}

async function testTriggerImportApplyWithConfirmPhraseProceeds() {
  const token = await ownerDirectory()
  process.env.GITHUB_SYNC_PAT = 'fake-pat'
  globalThis.fetch = async () => ({ status: 204, json: async () => ({}) })

  const req = { method: 'POST', body: { apply: true, confirm: 'IMPORT' }, headers: { cookie: `lta_session=${token}` } }
  const res = fakeRes()
  await triggerImportHandler(req, res)
  assert(res.statusCode === 200, `expected 200 with correct confirm phrase, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
}

async function testOwnerCanReachTriggerSync() {
  const token = await ownerDirectory()
  process.env.GITHUB_SYNC_PAT = 'fake-pat'
  globalThis.fetch = async () => ({ status: 204, json: async () => ({}) })

  const req = { method: 'POST', headers: { cookie: `lta_session=${token}` } }
  const res = fakeRes()
  await triggerSyncHandler(req, res)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
}

async function testDisconnectRequiresConfirmPhrase() {
  const token = await ownerDirectory()
  _setCredentialRedisForTests(() => fakeCredentialRedis())
  try {
    globalThis.fetch = async (url) => { throw new Error(`fetch must not be called: ${url}`) }
    const req = { method: 'POST', body: {}, headers: { cookie: `lta_session=${token}` } }
    const res = fakeRes()
    await disconnectHandler(req, res)
    assert(res.statusCode === 400, `expected 400 without confirm phrase, got ${res.statusCode}`)
    assert(res.body.error === 'confirmation_required', res.body.error)
  } finally {
    _resetCredentialRedisForTests()
  }
}

async function testDisconnectWithConfirmPhraseSucceeds() {
  const token = await ownerDirectory()
  const client = fakeCredentialRedis()
  _setCredentialRedisForTests(() => client)
  try {
    await setStoredCredential({ refreshToken: 'x', connectedAccountName: 'Los Tres Amigos' })
    const req = { method: 'POST', body: { confirm: 'DISCONNECT' }, headers: { cookie: `lta_session=${token}` } }
    const res = fakeRes()
    await disconnectHandler(req, res)
    assert(res.statusCode === 200 && res.body.success === true, `expected 200 {success:true}, got ${res.statusCode}, body=${JSON.stringify(res.body)}`)
  } finally {
    _resetCredentialRedisForTests()
  }
}

async function main() {
  await run('status/test-connection/trigger-sync/trigger-import/google-disconnect/rewrite/executive-brief all reject unauthenticated requests with 401 before any network call', testAllEndpointsRejectUnauthenticated)
  await run('trigger-import.js: apply=true without the confirm phrase -> 400, no dispatch', testTriggerImportApplyRequiresConfirmPhrase)
  await run('trigger-import.js: apply=true with the confirm phrase -> proceeds', testTriggerImportApplyWithConfirmPhraseProceeds)
  await run('trigger-sync.js: authenticated Owner request succeeds', testOwnerCanReachTriggerSync)
  await run('google/disconnect: requires the literal confirm phrase, matching trigger-import.js\'s pattern', testDisconnectRequiresConfirmPhrase)
  await run('google/disconnect: succeeds with the correct confirm phrase', testDisconnectWithConfirmPhraseSucceeds)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
