// Regression tests for dashboard/middleware.js -- the Edge pre-check layer.
// Confirms it (a) always 404s the legacy /data/* prefix (nothing should
// ever be served from there again -- this is what stops Vercel's SPA
// rewrite from serving index.html with a 200 for a file that no longer
// exists), and (b) performs the coarse identity pre-check (signed session +
// disabled + sessionVersion) for /api/data, without being the only thing
// standing guard (dashboard/api/data.js re-verifies everything
// independently, plus the file-path allowlist and per-file location
// authorization this Edge layer cannot see -- it never reads req.query.file).
//
// REVISED (Multi-Location Authentication & User Access System, Commit 4):
// this layer no longer restricts by role at all -- see
// testApiDataNonOwnerRoleAlsoContinues below. The role/location decision
// moved entirely to data.js, which is the only layer that knows which file
// is actually being requested.
//
// Run directly: node tests/test_middleware.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import middleware from '../dashboard/middleware.js'
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

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false },
    ],
  })
}

function fakeRequest(pathname, cookieToken) {
  return new Request(`https://dashboard.example.com${pathname}`, {
    headers: cookieToken ? { cookie: `lta_session=${cookieToken}` } : {},
  })
}

async function testLegacyDataPathAlways404() {
  const res = await middleware(fakeRequest('/data/meta.json', null))
  assert(res instanceof Response, 'middleware must return a Response for /data/*')
  assert(res.status === 404, `expected 404, got ${res.status}`)
}

async function testLegacyDataPath404EvenWithValidSession() {
  await setDirectory()
  const token = await signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  const res = await middleware(fakeRequest('/data/meta.json', token))
  assert(res.status === 404, `legacy path must 404 regardless of auth, got ${res.status}`)
}

async function testApiDataUnauthenticatedRejected() {
  const res = await middleware(fakeRequest('/api/data?file=meta.json', null))
  assert(res instanceof Response, 'middleware must short-circuit an unauthenticated /api/data request')
  assert(res.status === 401, `expected 401, got ${res.status}`)
}

async function testApiDataAuthenticatedContinues() {
  await setDirectory()
  const token = await signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  const res = await middleware(fakeRequest('/api/data?file=meta.json', token))
  // next() from @vercel/functions returns a Response whose presence signals
  // "continue" to the platform -- what matters here is it did NOT
  // short-circuit with a 401/403/404 of its own.
  assert(res && ![401, 403, 404].includes(res.status), `authenticated request must be allowed to continue, got status ${res?.status}`)
}

async function testApiDataNonOwnerRoleAlsoContinues() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false },
      { userId: 'usr_lm', email: 'lm@example.com', passwordHash: hash, role: 'location_manager', locationIds: [7], sessionVersion: 1, disabled: false },
    ],
  })
  const token = await signSession({ userId: 'usr_lm', email: 'lm@example.com', role: 'location_manager', locationIds: [7], tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  const res = await middleware(fakeRequest('/api/data?file=meta.json', token))
  assert(res && ![401, 403, 404].includes(res.status), `a location_manager (or any authenticated role) must reach the Node layer, which makes the real per-file decision -- got status ${res?.status}`)
}

async function main() {
  await run('legacy /data/* always 404s (no session)', testLegacyDataPathAlways404)
  await run('legacy /data/* 404s even with a valid session (nothing should ever be served there)', testLegacyDataPath404EvenWithValidSession)
  await run('/api/data unauthenticated -> 401 at the edge', testApiDataUnauthenticatedRejected)
  await run('/api/data authenticated -> continues to the Node handler', testApiDataAuthenticatedContinues)
  await run('/api/data: a non-owner/marketing role also continues (role gate removed, Commit 4)', testApiDataNonOwnerRoleAlsoContinues)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
