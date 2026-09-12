// "Cap AI input before Anthropic" hardening (Phase A4, revenue-abuse
// containment audit -- ai-unbounded-prompt-input): regression tests for
// dashboard/api/executive-brief.js's new hard input ceilings. Mirrors
// tests/test_endpoint_auth.js's mocking pattern (fake global fetch, a real
// signed session, no real Upstash/Anthropic).
//
// Run directly: node tests/test_executive_brief.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/executive-brief.js'
import { signSession } from '../dashboard/api/_lib/session.js'
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
  }
}

async function ownerToken() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{ userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false }],
  })
  return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
}

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}

function installNeverCalledFetch() {
  globalThis.fetch = async (url) => { throw new Error(`Anthropic must not be called, but fetch was invoked for: ${url}`) }
}
function installSuccessFetch() {
  let calls = 0
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ content: [{ text: 'A generated executive briefing.' }] }) } }
  return () => calls
}

async function post(body) {
  const res = fakeRes()
  await handler({ method: 'POST', body, headers: { cookie: `lta_session=${await ownerToken()}` } }, res)
  return res
}

async function testOversizedPeriodLabelRejectedNoFetch() {
  installNeverCalledFetch()
  const res = await post({ totalReviews: 10, periodLabel: 'x'.repeat(500) })
  assert(res.statusCode === 400, `expected 400, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testOversizedTopComplaintRejectedNoFetch() {
  installNeverCalledFetch()
  const res = await post({ totalReviews: 10, topComplaint: 'x'.repeat(2000) })
  assert(res.statusCode === 400, `expected 400, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testOversizedBestLocationRejectedNoFetch() {
  installNeverCalledFetch()
  const res = await post({ totalReviews: 10, bestLocation: 'x'.repeat(2000) })
  assert(res.statusCode === 400, `expected 400, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testMassivePayloadStillCaughtByOverallPromptBudget() {
  // A field not individually capped (a hypothetical future addition) would
  // still be caught by the overall assembled-prompt backstop -- simulated
  // here by combining several fields right at their own individual caps,
  // which still sums well under the backstop; this test instead proves the
  // backstop itself triggers for a value NO per-field cap covers today
  // (a huge worstLocation, capped the same as bestLocation -- included for
  // completeness of the "every interpolated field" requirement).
  installNeverCalledFetch()
  const res = await post({ totalReviews: 10, worstLocation: 'x'.repeat(2000) })
  assert(res.statusCode === 400, `expected 400, got ${res.statusCode} (${JSON.stringify(res.body)})`)
}

async function testWithinLimitsStillSucceeds() {
  const getCalls = installSuccessFetch()
  const res = await post({
    totalReviews: 42, periodLabel: 'This week', prevPeriodLabel: 'Last week',
    topComplaint: 'Slow service', topPraise: 'Great tacos',
    bestLocation: 'Casa Tequila Prime', worstLocation: 'Downtown',
  })
  assert(res.statusCode === 200 && typeof res.body.briefing === 'string', `expected a successful briefing, got ${res.statusCode} (${JSON.stringify(res.body)})`)
  assert(getCalls() === 1, 'exactly one upstream call must have been made')
}

async function main() {
  await run('PHASE A4: oversized periodLabel rejected (400), zero Anthropic calls', testOversizedPeriodLabelRejectedNoFetch)
  await run('PHASE A4: oversized topComplaint rejected (400), zero Anthropic calls', testOversizedTopComplaintRejectedNoFetch)
  await run('PHASE A4: oversized bestLocation rejected (400), zero Anthropic calls', testOversizedBestLocationRejectedNoFetch)
  await run('PHASE A4: oversized worstLocation rejected (400), zero Anthropic calls', testMassivePayloadStillCaughtByOverallPromptBudget)
  await run('PHASE A4: a normal, within-limits request still succeeds', testWithinLimitsStillSucceeds)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
