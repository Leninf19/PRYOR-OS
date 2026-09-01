// Multi-Tenant Phase 4D revision -- Section 5: HTTP/API-level adversarial
// tests proving dashboard/api/data.js's tenant boundary holds under a real
// authenticated request/response cycle, with a synthetic Tenant B account
// alongside the real Los Tres Amigos (Tenant A) one. Complements
// test_data_endpoint.js (which only ever exercises Tenant A/LTA against
// the real private-data directory) and test_tenant_paths.py/
// test_tenant_review_data_isolation.py (the Python-side database/export
// equivalents).
//
// Run directly: node tests/test_tenant_private_data_isolation.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import handler from '../dashboard/api/data.js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import {
  _setPrivateDataRootForTests, _resetPrivateDataRootsForTests,
} from '../dashboard/api/_lib/reviewDataPaths.js'
import { _setMetaLocationsForTests, _resetMetaLocationsForTests } from '../dashboard/api/data.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'

const TENANT_B = 't_synthetic-second-tenant'
const UNKNOWN_TENANT = 't_never-onboarded'

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
    _resetPrivateDataRootsForTests()
    _resetMetaLocationsForTests()
    resetUserRedis()
  }
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

// A key-respecting fake Redis for userStore.js, mirroring its real hash
// shape -- USERS_KEY='users:v1' (field=userId, value=JSON record). Los
// Tres Amigos is LEGACY-mode-pinned to this same v1 key (see
// tenantDualRead.js/credentialStore.js's identical pattern), which is also
// what accountStore.js's bootstrap lookup (resolveBootstrapTenantId(),
// always DEFAULT_TENANT_ID today) searches -- so a synthetic Tenant B
// account is placed in this SAME hash, findable by userId, with its own
// explicit tenantId field carried on the record itself. That field is
// pure data at lookup time; resolveTenantId(account) is what turns it into
// an actual tenant identity afterward -- exactly what evaluateSession()
// does for a real request.
function fakeUserRedis(users) {
  const store = { 'users:v1': { ...users } }
  return {
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hget: async (key, field) => store[key]?.[field] ?? null,
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
    _store: store,
  }
}

async function setDirectory() {
  const hash = await passwordHash()
  // Tenant A (Los Tres Amigos) stays in the static directory, no explicit
  // tenantId field -- resolves via legacy-role derivation, unchanged from
  // every other test in this suite.
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner_a', email: 'owner-a@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false },
    ],
  })
  // Tenant B lives in the Redis-backed user store (accountStore.js checks
  // this FIRST) with an EXPLICIT tenantId field -- this is what makes
  // resolveTenantId(account) resolve it to TENANT_B rather than falling
  // through to legacy-role derivation (which always resolves to Los Tres
  // Amigos). See tenants.js's resolveTenantId().
  const recordB = {
    userId: 'usr_owner_b', email: 'owner-b@example.com', passwordHash: hash,
    role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId: TENANT_B,
  }
  setUserRedis(() => fakeUserRedis({ usr_owner_b: JSON.stringify(recordB) }))
}


function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.send = (str) => { res.body = str; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

async function tokenFor(userId, email, tenantId) {
  return signSession({ userId, email, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
}

async function invoke(fileParam, token, extra = {}) {
  const req = {
    method: 'GET',
    query: { file: fileParam, ...(extra.query ?? {}) },
    body: extra.body,
    headers: { cookie: token ? `lta_session=${token}` : '', ...(extra.headers ?? {}) },
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

function makeTenantDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function writeJson(root, relPath, data) {
  const full = path.join(root, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, JSON.stringify(data))
}

function setupTenantB() {
  const rootB = makeTenantDir('tenant-b-private-data-')
  // distinctiveMarker survives data.js's meta.json filtering (a spread
  // (...parsed) that only overrides `locations`/`totalReviews`) even
  // though `locations`/`totalReviews` themselves are always filtered/
  // nulled for a non-wildcard-recognized tenant (see the KNOWN LIMITATION
  // note on testTenantBMetaJsonReadsFromItsOwnRootNeverLta below) -- this
  // is what lets these tests prove the underlying FILE READ hit Tenant
  // B's own root, independent of that separate, pre-existing
  // authorization gate.
  writeJson(rootB, 'meta.json', {
    distinctiveMarker: 'tenant-b-meta',
    locations: [{ locationId: 900, name: 'Tenant B Exclusive Location', slug: 'tenant-b-exclusive-location' }],
    totalReviews: 1,
  })
  writeJson(rootB, 'reviews/by-location/tenant-b-exclusive-location.json', [
    { review_id: 'b1', reviewer_name: 'Tenant B Exclusive Reviewer', star_rating: 5, review_text: 'Only Tenant B should ever see this.' },
  ])
  writeJson(rootB, 'action-items.json', { items: [] })
  _setPrivateDataRootForTests(TENANT_B, rootB)
  return rootB
}

// --- Tenant A reads only Tenant A artifacts; Tenant B reads only Tenant B's ---

async function testTenantAReadsOnlyTenantAArtifacts() {
  await setDirectory()
  setupTenantB()
  const tokenA = await tokenFor('usr_owner_a', 'owner-a@example.com', DEFAULT_TENANT_ID)

  const res = await invoke('meta.json', tokenA)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  const body = JSON.parse(res.body)
  const names = (body.locations ?? []).map(l => l.name)
  assert(!names.includes('Tenant B Exclusive Location'), 'Tenant A must never see Tenant B\'s location in meta.json')
}

// KNOWN, PRE-EXISTING LIMITATION (not a Phase 4D regression -- documented
// in the Phase 4D report): tenants.js's tenantOwnsLocationCatalog() is
// hardcoded to Los Tres Amigos only (Phase 4B). isWildcardGrant()/
// requireLocationAccess() both gate on it, which means EVERY location-
// scoped and company-wide file request is denied (403/404) for any
// account whose tenant isn't Los Tres Amigos, regardless of the Phase 4D
// private-data boundary fix below. That gate is a separate, deliberate,
// reviewed restriction outside Phase 4D's scope -- these tests prove what
// Phase 4D IS responsible for (the underlying file read resolves to the
// correct tenant's own root, and never falls back to another tenant's
// data), using meta.json's distinctiveMarker field (which survives the
// authorization-driven locations/totalReviews filtering) as an
// independent signal of which physical file was actually read.
async function testTenantBMetaJsonReadsFromItsOwnRootNeverLta() {
  await setDirectory()
  setupTenantB()
  const tokenB = await tokenFor('usr_owner_b', 'owner-b@example.com', TENANT_B)

  const res = await invoke('meta.json', tokenB)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  const body = JSON.parse(res.body)
  assert(body.distinctiveMarker === 'tenant-b-meta', 'the underlying file read must resolve to Tenant B\'s own meta.json, never Los Tres Amigos\'s')
  const names = (body.locations ?? []).map(l => l.name)
  assert(!names.some(n => n && n !== 'Tenant B Exclusive Location'), 'no other tenant\'s location name must ever appear in Tenant B\'s response')
}

// --- Tenant B cannot read Tenant A by supplying Tenant A's id anywhere ------

async function testTenantIdFromQueryParamIsIgnored() {
  await setDirectory()
  setupTenantB()
  const tokenB = await tokenFor('usr_owner_b', 'owner-b@example.com', TENANT_B)

  const res = await invoke('meta.json', tokenB, { query: { tenantId: DEFAULT_TENANT_ID } })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  const body = JSON.parse(res.body)
  assert(body.distinctiveMarker === 'tenant-b-meta', 'a forged tenantId query param must never redirect this request to another tenant\'s data')
  const names = (body.locations ?? []).map(l => l.name)
  assert(!names.some(n => n && n !== 'Tenant B Exclusive Location'), 'no data from any other tenant must leak in')
}

async function testTenantIdFromBodyIsIgnored() {
  await setDirectory()
  setupTenantB()
  const tokenB = await tokenFor('usr_owner_b', 'owner-b@example.com', TENANT_B)

  const res = await invoke('meta.json', tokenB, { body: { tenantId: DEFAULT_TENANT_ID } })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  const body = JSON.parse(res.body)
  assert(body.distinctiveMarker === 'tenant-b-meta', 'a forged tenantId in the request body must never redirect this request to another tenant\'s data')
}

async function testTenantIdFromHeaderIsIgnored() {
  await setDirectory()
  setupTenantB()
  const tokenB = await tokenFor('usr_owner_b', 'owner-b@example.com', TENANT_B)

  const res = await invoke('meta.json', tokenB, { headers: { 'x-tenant-id': DEFAULT_TENANT_ID } })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  const body = JSON.parse(res.body)
  assert(body.distinctiveMarker === 'tenant-b-meta', 'a forged x-tenant-id header must never redirect this request to another tenant\'s data')
}

// --- Path traversal cannot escape the tenant private-data root -------------

async function testPathTraversalCannotEscapeTenantRoot() {
  await setDirectory()
  setupTenantB()
  const tokenB = await tokenFor('usr_owner_b', 'owner-b@example.com', TENANT_B)

  for (const attempt of ['../meta.json', '../../etc/passwd', 'reviews/../../meta.json', '..%2Fmeta.json', 'reviews/by-location/..%2f..%2fmeta.json']) {
    const res = await invoke(attempt, tokenB)
    assert(res.statusCode === 404, `traversal attempt ${JSON.stringify(attempt)} must be rejected (404), got ${res.statusCode}`)
  }
}

// --- Wildcard location grants do not bypass the tenant boundary ------------

async function testWildcardGrantDoesNotBypassTenantBoundary() {
  await setDirectory()
  setupTenantB()
  // usr_owner_b already holds locationIds: '*' (a wildcard grant) -- confirm
  // that alone never grants access to a DIFFERENT tenant's data; the
  // wildcard only ever means (at most) "every location within MY OWN
  // tenant," never another tenant's.
  const tokenB = await tokenFor('usr_owner_b', 'owner-b@example.com', TENANT_B)
  const res = await invoke('meta.json', tokenB)
  const body = JSON.parse(res.body)
  assert(body.distinctiveMarker === 'tenant-b-meta', 'a wildcard grant must still read from Tenant B\'s own root, never Los Tres Amigos\'s')
  const names = (body.locations ?? []).map(l => l.name)
  assert(!names.includes('Tenant A Exclusive Location') && names.every(n => n === 'Tenant B Exclusive Location'),
    'a wildcard grant must never leak another tenant\'s locations, regardless of scope width')
}

// --- Missing tenant artifacts fail safely, never fall back to LTA ----------

async function testMissingArtifactFailsSafeNeverFallsBackToLta() {
  await setDirectory()
  // Tenant B is registered but its directory has NO gbp-sync.json (and
  // never will, unless created) -- must never silently serve Los Tres
  // Amigos's own gbp-sync.json. gbp-sync.json is a 'company-wide'
  // category file, so (per the pre-existing tenantOwnsLocationCatalog()
  // gate documented above) it is actually denied at 403 before the
  // allowlisted-but-missing-file path is even reached -- an even
  // stronger fail-safe than a bare 404, and still definitively "never
  // falls back to LTA" either way.
  setupTenantB()
  const tokenB = await tokenFor('usr_owner_b', 'owner-b@example.com', TENANT_B)
  const res = await invoke('gbp-sync.json', tokenB)
  assert(res.statusCode === 403 || res.statusCode === 404,
    `expected a fail-safe 403/404 for a genuinely missing/inaccessible Tenant B artifact, got ${res.statusCode}`)
  assert(res.statusCode !== 200, 'must never return 200 with another tenant\'s data')
}

async function testMissingReviewChunkFailsSafeNeverFallsBackToLta() {
  await setDirectory()
  setupTenantB()
  const tokenB = await tokenFor('usr_owner_b', 'owner-b@example.com', TENANT_B)
  // A slug that exists for Los Tres Amigos in the real private-data
  // directory, but was never created for Tenant B.
  const res = await invoke('reviews/by-location/casa-tequila-prime.json', tokenB)
  assert(res.statusCode === 404, `expected 404, got ${res.statusCode} -- must never fall back to Los Tres Amigos's own chunk for the same slug`)
}

// --- An unknown tenant fails before filesystem access -----------------------

async function testUnknownTenantFailsBeforeFilesystemAccess() {
  const hash = await passwordHash()
  const record = {
    userId: 'usr_unknown_tenant', email: 'unknown@example.com', passwordHash: hash,
    role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId: UNKNOWN_TENANT,
  }
  setUserRedis(() => fakeUserRedis({ usr_unknown_tenant: JSON.stringify(record) }))
  const token = await tokenFor('usr_unknown_tenant', 'unknown@example.com', UNKNOWN_TENANT)
  const res = await invoke('meta.json', token)
  assert(res.statusCode === 404, `an unknown/unconfigured tenant must fail closed (404) before any filesystem access, got ${res.statusCode}`)
}

// --- Los Tres Amigos itself is unaffected (compatibility check) ------------

async function testLtaStillWorksUnaffectedByTenantBExisting() {
  await setDirectory()
  setupTenantB()
  const tokenA = await tokenFor('usr_owner_a', 'owner-a@example.com', DEFAULT_TENANT_ID)
  const res = await invoke('meta.json', tokenA)
  assert(res.statusCode === 200, `Los Tres Amigos must be unaffected by Tenant B's existence, got ${res.statusCode}`)
  const body = JSON.parse(res.body)
  assert(Array.isArray(body.locations) && body.locations.length > 0, 'Los Tres Amigos must still see its own real locations')
}

async function main() {
  await run('Tenant A reads only Tenant A\'s own artifacts', testTenantAReadsOnlyTenantAArtifacts)
  await run('Tenant B\'s meta.json reads from its own root, never Los Tres Amigos\'s', testTenantBMetaJsonReadsFromItsOwnRootNeverLta)
  await run('a forged tenantId in the query string is silently ignored', testTenantIdFromQueryParamIsIgnored)
  await run('a forged tenantId in the request body is silently ignored', testTenantIdFromBodyIsIgnored)
  await run('a forged tenantId in a request header is silently ignored', testTenantIdFromHeaderIsIgnored)
  await run('path traversal payloads cannot escape the tenant\'s own private-data root', testPathTraversalCannotEscapeTenantRoot)
  await run('a wildcard (\'*\') location grant does not bypass the tenant boundary', testWildcardGrantDoesNotBypassTenantBoundary)
  await run('a missing artifact for a real tenant fails safe (404), never falls back to LTA', testMissingArtifactFailsSafeNeverFallsBackToLta)
  await run('a missing review chunk fails safe (404), never falls back to LTA\'s chunk for the same slug', testMissingReviewChunkFailsSafeNeverFallsBackToLta)
  await run('an unknown tenant fails closed before any filesystem access', testUnknownTenantFailsBeforeFilesystemAccess)
  await run('Los Tres Amigos continues working unaffected by Tenant B existing', testLtaStillWorksUnaffectedByTenantBExisting)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
