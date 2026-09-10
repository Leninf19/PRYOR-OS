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

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import bcrypt from 'bcryptjs'
import middleware from '../dashboard/middleware.js'
import dataHandler from '../dashboard/api/data.js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import { generateTenantId } from '../dashboard/api/_lib/tenantIdGenerator.js'
import { _setRedisClientForTests, _resetRedisClientForTests } from '../dashboard/api/_lib/tenantConfigStore.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard')
const MIDDLEWARE_FILE = path.join(DASHBOARD_DIR, 'middleware.js')
const TENANTS_FILE = path.join(DASHBOARD_DIR, 'api', '_lib', 'tenants.js')

// Vercel Edge Middleware unsupported Node crypto dependency fix -- a plain
// static scanner over the actual on-disk import graph, not a guess about
// what "should" be reachable. Follows every relative import
// (`./x.js`/`../x.js`) transitively from middleware.js exactly the way
// Vercel's own bundler must, and records every bare (non-relative)
// specifier it encounters along the way (npm packages AND Node builtins
// look identical at this syntactic level, which is exactly why this check
// exists -- a new transitive `import ... from 'crypto'` anywhere in this
// graph must fail this test, not just a `crypto` import in tenants.js
// specifically).
const NODE_BUILTIN_SPECIFIERS = new Set([
  'crypto', 'fs', 'path', 'os', 'child_process', 'net', 'tls', 'dns',
  'worker_threads', 'http', 'https', 'stream', 'zlib', 'cluster', 'v8',
  'buffer', 'querystring', 'url', 'vm', 'assert', 'readline',
])

function isNodeBuiltinSpecifier(spec) {
  return spec.startsWith('node:') || NODE_BUILTIN_SPECIFIERS.has(spec)
}

function extractImportSpecifiers(source) {
  const specs = []
  const staticRe = /(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g
  let m
  while ((m = staticRe.exec(source))) specs.push(m[1])
  const dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = dynRe.exec(source))) specs.push(m[1])
  return specs
}

function collectTransitiveGraph(entryFile) {
  const files = new Set()
  const bareSpecifiers = new Set()
  function walk(file) {
    if (files.has(file)) return
    files.add(file)
    const source = fs.readFileSync(file, 'utf-8')
    for (const spec of extractImportSpecifiers(source)) {
      if (spec.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), spec)
        if (fs.existsSync(resolved)) walk(resolved)
      } else {
        bareSpecifiers.add(spec)
      }
    }
  }
  walk(entryFile)
  return { files, bareSpecifiers }
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

// --- Vercel Edge Middleware unsupported Node crypto dependency fix ------
// (Phase F, tenants.js's generateTenantId()/randomTenantSuffix() moved to
// the new Node-only tenantIdGenerator.js). These prove the fix at three
// levels: the static bundle-time level (crypto is no longer reachable at
// all), the file-level source proof (tenants.js has no crypto import),
// and the runtime level (the relocated code still behaves identically,
// and server-side authorization still works correctly with zero
// dependency on middleware ever having run -- since data.js is always the
// authoritative layer, per this file's own header comment).

async function testMiddlewareTransitiveGraphHasNoNodeBuiltins() {
  const { bareSpecifiers } = collectTransitiveGraph(MIDDLEWARE_FILE)
  const hits = [...bareSpecifiers].filter(isNodeBuiltinSpecifier)
  assert(hits.length === 0, `middleware.js's transitive import graph must contain zero Node builtin imports (fs/path/crypto/etc), found: ${hits.join(', ') || 'none'}`)
}

async function testMiddlewareTransitiveGraphExcludesTenantIdGenerator() {
  const { files } = collectTransitiveGraph(MIDDLEWARE_FILE)
  const pulledIn = [...files].some(f => f.endsWith(`${path.sep}tenantIdGenerator.js`))
  assert(!pulledIn, 'middleware.js must never transitively import tenantIdGenerator.js -- that file exists specifically to hold the Node-only (crypto) tenant-id-generation code OUT of the Edge bundle')
}

async function testTenantsFileHasNoCryptoImport() {
  const source = fs.readFileSync(TENANTS_FILE, 'utf-8')
  assert(!/from\s+['"](?:node:)?crypto['"]/.test(source), 'tenants.js must not import crypto (directly or via node:crypto) -- it is imported by middleware.js and must stay fully Edge-safe')
}

async function testGenerateTenantIdStillWorksAfterRelocation() {
  _setRedisClientForTests(() => ({ hget: async () => null })) // simulates "no existing config for this candidate id"
  try {
    const id = await generateTenantId('Rival Diner & Grill')
    assert(/^t_rival-diner-grill-[a-z0-9]{6}$/.test(id), `generateTenantId must still produce a valid, correctly-shaped id after relocating to tenantIdGenerator.js, got ${JSON.stringify(id)}`)
  } finally {
    _resetRedisClientForTests()
  }
}

function fakeDataRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.send = (str) => { res.body = str; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

async function testLocationScopedAccountDeniedCompanyWideFileWithoutMiddlewareInvolved() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_lm2', email: 'lm2@example.com', passwordHash: hash, role: 'location_manager', locationIds: [7], sessionVersion: 1, disabled: false },
    ],
  })
  const token = await signSession({ userId: 'usr_lm2', email: 'lm2@example.com', role: 'location_manager', locationIds: [7], tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  const res = fakeDataRes()
  // dataHandler is invoked DIRECTLY here -- middleware.js never runs in
  // this call path at all -- proving location/role authorization for a
  // company-wide file is enforced by the Node layer itself, not merely by
  // the Edge pre-check this whole file otherwise tests.
  await dataHandler({ method: 'GET', query: { file: 'analytics/kpis.json' }, headers: { cookie: `lta_session=${token}` } }, res)
  assert(res.statusCode === 403, `a location-scoped account requesting a company-wide file must be denied by data.js itself (middleware bypassed entirely), got ${res.statusCode}`)
}

async function testTamperedTenantClaimRejectedWithoutMiddlewareInvolved() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner2', email: 'owner2@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false },
    ],
  })
  // A real account (usr_owner2) resolves to DEFAULT_TENANT_ID -- this
  // token claims a different, forged tenantId, simulating an attacker who
  // skipped middleware.js's own tenant-claim check entirely and hit the
  // Node function directly.
  const token = await signSession({ userId: 'usr_owner2', email: 'owner2@example.com', role: 'owner', locationIds: '*', tenantId: 't_forged-other-tenant', sessionVersion: 1 })
  const res = fakeDataRes()
  await dataHandler({ method: 'GET', query: { file: 'meta.json' }, headers: { cookie: `lta_session=${token}` } }, res)
  assert(res.statusCode === 401, `a tampered/mismatched tenantId claim must be rejected by data.js's own auth check even with middleware never having run, got ${res.statusCode}`)
}

async function main() {
  await run('legacy /data/* always 404s (no session)', testLegacyDataPathAlways404)
  await run('legacy /data/* 404s even with a valid session (nothing should ever be served there)', testLegacyDataPath404EvenWithValidSession)
  await run('/api/data unauthenticated -> 401 at the edge', testApiDataUnauthenticatedRejected)
  await run('/api/data authenticated -> continues to the Node handler', testApiDataAuthenticatedContinues)
  await run('/api/data: a non-owner/marketing role also continues (role gate removed, Commit 4)', testApiDataNonOwnerRoleAlsoContinues)
  await run("middleware.js's transitive import graph contains zero Node builtins (crypto, fs, etc)", testMiddlewareTransitiveGraphHasNoNodeBuiltins)
  await run('middleware.js never transitively imports tenantIdGenerator.js', testMiddlewareTransitiveGraphExcludesTenantIdGenerator)
  await run('tenants.js source has no crypto import', testTenantsFileHasNoCryptoImport)
  await run('generateTenantId still works correctly after relocating out of tenants.js', testGenerateTenantIdStillWorksAfterRelocation)
  await run('location-scoped account denied a company-wide file by data.js directly (middleware bypassed)', testLocationScopedAccountDeniedCompanyWideFileWithoutMiddlewareInvolved)
  await run('tampered tenantId claim rejected by data.js directly (middleware bypassed)', testTamperedTenantClaimRejectedWithoutMiddlewareInvolved)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
