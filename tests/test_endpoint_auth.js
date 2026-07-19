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
import statusHandler from '../dashboard/api/google/status.js'
import testConnectionHandler from '../dashboard/api/google/test-connection.js'
import triggerSyncHandler from '../dashboard/api/google/trigger-sync.js'
import triggerImportHandler from '../dashboard/api/google/trigger-import.js'
import rewriteHandler from '../dashboard/api/rewrite.js'
import executiveBriefHandler from '../dashboard/api/executive-brief.js'
import { signSession } from '../dashboard/api/_lib/session.js'

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
  await expectUnauthenticated('rewrite.js', rewriteHandler, 'POST', { tone: 'friendly' })
  await expectUnauthenticated('executive-brief.js', executiveBriefHandler, 'POST', { totalReviews: 1 })
}

async function ownerDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{ userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false }],
  })
  return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', sessionVersion: 1 })
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

async function main() {
  await run('status/test-connection/trigger-sync/trigger-import/rewrite/executive-brief all reject unauthenticated requests with 401 before any network call', testAllEndpointsRejectUnauthenticated)
  await run('trigger-import.js: apply=true without the confirm phrase -> 400, no dispatch', testTriggerImportApplyRequiresConfirmPhrase)
  await run('trigger-import.js: apply=true with the confirm phrase -> proceeds', testTriggerImportApplyWithConfirmPhraseProceeds)
  await run('trigger-sync.js: authenticated Owner request succeeds', testOwnerCanReachTriggerSync)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
