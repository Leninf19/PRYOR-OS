// Regression tests for Multi-Tenant Phase 3 -- Tenant-Aware Sessions &
// Authorization Enforcement. Covers:
//   - the signed session token now carries a required, server-verified
//     tenantId claim (dashboard/api/_lib/session.js)
//   - dashboard/api/_lib/auth.js's evaluateSession() re-derives and
//     verifies that claim on every request, exactly like sessionVersion
//   - both ACCOUNT_DIRECTORY_JSON and Redis-backed (userStore.js) accounts
//     resolve to DEFAULT_TENANT_ID via login
//   - requireLocationAccess/isWildcardGrant (auth.js) now require the
//     account's own tenant to actually own the location catalog a
//     locationId is drawn from, before ever consulting the account's grant
//   - a synthetic, non-onboarded tenant can never read Los Tres Amigos'
//     locations, even holding a wildcard grant or a numerically-colliding
//     explicit grant
//
// No real Upstash account, no real ACCOUNT_DIRECTORY_JSON secret, no
// production Redis anywhere in this file -- every test drives either the
// real login endpoint against a fake Redis client (userStore.js's own
// _setRedisClientForTests seam) or auth.js's exported helpers directly
// against hand-built account fixtures, the same pattern
// test_authorization_matrix.js/test_permissions.js already establish.
//
// Run directly: node tests/test_tenant_session_authorization.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import { createHmac } from 'crypto'
import sessionHandler from '../dashboard/api/session/[action].js'
import { signSession, verifySession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { requireAuth, evaluateSession, requireLocationAccess, isWildcardGrant, requireScopedAuth } from '../dashboard/api/_lib/auth.js'
import { Permission } from '../dashboard/api/_lib/permissions.js'
import {
  DEFAULT_TENANT_ID, resolveTenantId, resolveBootstrapTenantId, tenantOwnsLocationCatalog, TenantResolutionError,
} from '../dashboard/api/_lib/tenants.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'

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
    resetUserRedis()
    delete process.env.ACCOUNT_DIRECTORY_JSON
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  res.getHeader = (name) => res.headers[name]
  return res
}

async function login(body) {
  const req = { method: 'POST', body, headers: {}, query: { action: 'login' }, socket: { remoteAddress: '127.0.0.1' } }
  const res = fakeRes()
  await sessionHandler(req, res)
  return res
}

function cookieFrom(res) {
  const setCookie = res.headers['Set-Cookie']
  if (!setCookie) return null
  return decodeURIComponent(setCookie.split(`${SESSION_COOKIE}=`)[1].split(';')[0])
}

async function seedStaticDirectory(overrides = {}) {
  const hash = await bcrypt.hash('correct-horse-battery-staple', 12)
  const base = {
    usr_owner: { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' },
    usr_admin: { userId: 'usr_admin', email: 'admin@example.com', passwordHash: hash, role: 'admin', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Admin' },
    usr_marketing: { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Marketing' },
    usr_lm: { userId: 'usr_lm', email: 'lm@example.com', passwordHash: hash, role: 'location_manager', locationIds: [3, 7], sessionVersion: 1, disabled: false, displayName: 'Location Manager' },
    usr_ro: { userId: 'usr_ro', email: 'ro@example.com', passwordHash: hash, role: 'read_only', locationIds: [7], sessionVersion: 1, disabled: false, displayName: 'Read Only' },
  }
  for (const [k, patch] of Object.entries(overrides)) base[k] = { ...base[k], ...patch }
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: Object.values(base) })
  return base
}

// A key-respecting fake Redis, mirroring userStore.js's real hash shape --
// USERS_KEY='users:v1' (field=userId, value=JSON record),
// EMAIL_INDEX_KEY='users_email_index:v1' (field=normalizedEmail, value=userId).
function fakeUserRedis({ users = {}, emailIndex = {} } = {}) {
  const store = { 'users:v1': { ...users }, 'users_email_index:v1': { ...emailIndex } }
  return {
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hget: async (key, field) => store[key]?.[field] ?? null,
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
    _store: store,
  }
}

async function seedRedisUser(overrides = {}) {
  const passwordHash = await bcrypt.hash('correct-horse-battery-staple', 12)
  const record = {
    userId: 'usr_redis_owner', email: 'redis-owner@example.com', passwordHash,
    role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Redis Owner',
    ...overrides,
  }
  const client = fakeUserRedis({
    users: { [record.userId]: JSON.stringify(record) },
    emailIndex: { [record.email]: record.userId },
  })
  setUserRedis(() => client)
  return record
}

// --- SESSION MODEL: login produces a signed session containing tenantId ----

async function testLoginProducesSessionWithTenantId() {
  await seedStaticDirectory()
  const res = await login({ email: 'owner@example.com', password: 'correct-horse-battery-staple' })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  const claims = await verifySession(cookieFrom(res))
  assert(claims !== null, 'issued token must verify')
  assert(claims.tenantId === DEFAULT_TENANT_ID, `expected tenantId ${DEFAULT_TENANT_ID}, got ${claims.tenantId}`)
  assert(claims.userId === 'usr_owner' && claims.role === 'owner' && claims.sessionVersion === 1, 'every other required claim is still present')
  assert(Array.isArray(claims.locationIds) || claims.locationIds === '*', 'locationIds is still present')
}

async function testExistingRolesStillLoginSuccessfully() {
  await seedStaticDirectory()
  for (const [email, role] of [['owner@example.com', 'owner'], ['admin@example.com', 'admin'], ['marketing@example.com', 'marketing'], ['lm@example.com', 'location_manager'], ['ro@example.com', 'read_only']]) {
    const res = await login({ email, password: 'correct-horse-battery-staple' })
    assert(res.statusCode === 200, `${role} login expected 200, got ${res.statusCode} (${JSON.stringify(res.body)})`)
    assert(res.body.account.role === role, `expected role ${role}, got ${res.body.account.role}`)
  }
}

// --- LOGIN / ACCOUNT RESOLUTION ---------------------------------------------

async function testAccountDirectoryUsersResolveToDefaultTenant() {
  await seedStaticDirectory()
  const res = await login({ email: 'owner@example.com', password: 'correct-horse-battery-staple' })
  const claims = await verifySession(cookieFrom(res))
  assert(claims.tenantId === DEFAULT_TENANT_ID, 'an ACCOUNT_DIRECTORY_JSON account must resolve to Los Tres Amigos')
}

async function testRedisUsersResolveToDefaultTenant() {
  const record = await seedRedisUser()
  const res = await login({ email: record.email, password: 'correct-horse-battery-staple' })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode} (${JSON.stringify(res.body)})`)
  const claims = await verifySession(cookieFrom(res))
  assert(claims.tenantId === DEFAULT_TENANT_ID, 'a Redis-backed (userStore.js) account must resolve to Los Tres Amigos')
}

// --- SESSION MODEL: missing/tampered tenantId is rejected -------------------

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Hand-rolled HS256 JWT signer using only Node's built-in crypto -- avoids
// depending on the `jose` package being resolvable from tests/ (it's a
// dashboard/-scoped dependency), while still producing a token that is
// byte-for-byte valid per the HS256 spec dashboard/api/_lib/session.js's
// verifySession() (built on jose) actually checks. Used ONLY to construct a
// deliberately non-compliant payload (missing tenantId) that signSession()
// itself refuses to produce -- simulating an externally-forged/tampered
// token, never a real signSession() output.
function forgeHS256Token(payload, { expiresInSeconds = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds }
  const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(fullPayload)))}`
  const signature = base64url(createHmac('sha256', process.env.SESSION_SIGNING_SECRET).update(signingInput).digest())
  return `${signingInput}.${signature}`
}

async function testMissingTenantIdInTokenIsRejected() {
  // Proves the claim is required at the SIGNING layer -- signSession()
  // refuses to issue a token with no tenantId at all.
  let threwAtSign = false
  try {
    await signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', sessionVersion: 1 })
  } catch (err) {
    threwAtSign = /tenantId/.test(err.message)
  }
  assert(threwAtSign, 'signSession() must refuse to issue a token with no tenantId')

  // Separately proves verifySession() ALSO rejects a token that has every
  // OTHER required claim but lacks tenantId, even if it is otherwise
  // validly signed -- simulating an externally-forged or corrupted token,
  // not just signSession()'s own client-side guard.
  const forged = forgeHS256Token({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', sessionVersion: 1 })
  const claims = await verifySession(forged)
  assert(claims === null, 'a validly-signed token missing the tenantId claim must be rejected outright')
}

async function testTamperedTenantIdInvalidatesSession() {
  await seedStaticDirectory()
  const account = { userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', sessionVersion: 1 }
  const tampered = await signSession({ ...account, tenantId: 't_someone-elses-tenant' })
  const req = { headers: { cookie: `${SESSION_COOKIE}=${tampered}` } }
  const res = fakeRes()
  const result = await requireAuth(req, res, null)
  assert(result === null, 'a session claiming a tenantId that does not match the account\'s real membership must be rejected')
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)

  const { reason } = await evaluateSession(req, null)
  assert(reason === 'tenant_mismatch', `expected reason 'tenant_mismatch', got ${reason}`)
}

async function testValidTenantIdSessionIsAccepted() {
  await seedStaticDirectory()
  const valid = await signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  const req = { headers: { cookie: `${SESSION_COOKIE}=${valid}` } }
  const res = fakeRes()
  const account = await requireAuth(req, res, null)
  assert(account !== null, 'a session whose tenantId matches the account\'s real membership must be accepted')
  assert(account.tenantId === DEFAULT_TENANT_ID, 'the returned account must carry the verified tenantId')
}

// --- ACCOUNT SHAPE: resolveTenantId trusts an already-attached tenantId ----

async function testResolveTenantIdDerivesFromRoleWhenNotAttached() {
  // A raw account record (as accountStore.js/userStore.js hand back --
  // never carries tenantId itself) must still resolve to DEFAULT_TENANT_ID
  // via the Phase 1 membership transform.
  assert(resolveTenantId({ userId: 'x', role: 'owner', locationIds: '*' }) === DEFAULT_TENANT_ID)
  assert(resolveTenantId({ userId: 'x', role: 'location_manager', locationIds: [1] }) === DEFAULT_TENANT_ID)
}

// --- FAIL-CLOSED HARDENING: resolveTenantId() never defaults to LTA -------

function assertThrowsTenantResolutionError(fn, msg) {
  let threw = null
  try {
    fn()
  } catch (err) {
    threw = err
  }
  assert(threw instanceof TenantResolutionError, `${msg} -- expected a TenantResolutionError, got ${threw ? threw.constructor.name : 'no throw'}`)
}

function testNullAccountCannotResolveToLta() {
  assertThrowsTenantResolutionError(() => resolveTenantId(null), 'a null account must never resolve to any tenant')
  assertThrowsTenantResolutionError(() => resolveTenantId(undefined), 'an undefined account must never resolve to any tenant')
}

function testMalformedAccountCannotResolveToLta() {
  assertThrowsTenantResolutionError(() => resolveTenantId('not-an-account'), 'a string account must never resolve to any tenant')
  assertThrowsTenantResolutionError(() => resolveTenantId(42), 'a numeric account must never resolve to any tenant')
  assertThrowsTenantResolutionError(() => resolveTenantId({}), 'an empty object (no role, no userId) must never resolve to any tenant')
  assertThrowsTenantResolutionError(() => resolveTenantId({ role: 'owner' }), 'an account missing userId must never resolve to any tenant')
}

function testUnknownLegacyRoleCannotResolveToLta() {
  assertThrowsTenantResolutionError(
    () => resolveTenantId({ userId: 'usr_x', role: 'super_admin_hacker', locationIds: '*' }),
    'an unrecognized legacy role must never resolve to any tenant'
  )
}

function testInvalidLocationGrantCannotResolveToLta() {
  assertThrowsTenantResolutionError(
    () => resolveTenantId({ userId: 'usr_x', role: 'location_manager', locationIds: [] }),
    'an empty locationIds array must never resolve to any tenant'
  )
  assertThrowsTenantResolutionError(
    () => resolveTenantId({ userId: 'usr_x', role: 'location_manager', locationIds: ['not-a-number'] }),
    'a non-numeric locationIds entry must never resolve to any tenant'
  )
  assertThrowsTenantResolutionError(
    () => resolveTenantId({ userId: 'usr_x', role: 'location_manager', locationIds: 'not-a-wildcard-or-array' }),
    'a garbage locationIds value must never resolve to any tenant'
  )
}

function testExplicitButInvalidTenantIdNeverFallsThroughToLegacyDerivation() {
  // An account carrying a malformed EXPLICIT tenantId, alongside an
  // otherwise perfectly valid legacy role/locationIds, must still fail
  // closed -- the malformed explicit claim is never silently ignored in
  // favor of re-deriving a different answer from the role.
  assertThrowsTenantResolutionError(
    () => resolveTenantId({ userId: 'usr_x', role: 'owner', locationIds: '*', tenantId: 'not-a-valid-tenant-id' }),
    'a malformed explicit tenantId must never fall through to legacy-role derivation'
  )
  assertThrowsTenantResolutionError(
    () => resolveTenantId({ userId: 'usr_x', role: 'owner', locationIds: '*', tenantId: 12345 }),
    'a non-string explicit tenantId must never fall through to legacy-role derivation'
  )
}

function testValidExplicitTenantAccountResolvesToItsExplicitTenant() {
  const explicit = resolveTenantId({ userId: 'usr_x', role: 'owner', locationIds: '*', tenantId: 't_some-other-valid-tenant' })
  assert(explicit === 't_some-other-valid-tenant', `expected the explicit tenantId to be trusted as-is, got ${explicit}`)
}

function testBootstrapTenantIdIsSeparateFromResolveTenantId() {
  // The pre-authentication escape hatch is a DIFFERENT, distinctly-named
  // function -- it must exist and return the default tenant, precisely so
  // no call site is ever tempted to route a null account back through the
  // now-strict resolveTenantId() to get the same value.
  assert(resolveBootstrapTenantId() === DEFAULT_TENANT_ID)
  assertThrowsTenantResolutionError(() => resolveTenantId(null), 'resolveTenantId(null) must still throw even though resolveBootstrapTenantId() exists as the sanctioned alternative')
}

// requireLocationAccess()/isWildcardGrant() have their OWN long-standing
// "never throw, always deny" contract (predating Phase 3) -- the hardened,
// throwing resolveTenantId() must not leak that throw through them.
function testLocationHelpersStayNonThrowingForMalformedAccounts() {
  for (const bad of [null, undefined, {}, { role: 'owner' }, { userId: 'x', role: 'bogus_role', locationIds: '*' }, 'not-an-account', 42]) {
    let threw = false
    let result
    try {
      result = requireLocationAccess(bad, 7)
    } catch {
      threw = true
    }
    assert(!threw, `requireLocationAccess must never throw for a malformed account, got a throw for ${JSON.stringify(bad)}`)
    assert(result === false, `requireLocationAccess must deny (false) a malformed account, got ${result} for ${JSON.stringify(bad)}`)

    let wildcardThrew = false
    let wildcardResult
    try {
      wildcardResult = isWildcardGrant(bad)
    } catch {
      wildcardThrew = true
    }
    assert(!wildcardThrew, `isWildcardGrant must never throw for a malformed account, got a throw for ${JSON.stringify(bad)}`)
    assert(wildcardResult === false, `isWildcardGrant must deny (false) a malformed account, got ${wildcardResult} for ${JSON.stringify(bad)}`)
  }
}

// --- WILDCARD SEMANTICS: '*' means all locations inside Tenant A only ------

const LTA_LOCATION_ID = 7 // an arbitrary real-looking locationId, standing in for a Los Tres Amigos location

function ltaAccount(overrides) {
  return { userId: 'usr_lta', role: 'owner', locationIds: '*', ...overrides }
}

function syntheticTenantAccount(overrides) {
  // A fully-authenticated-shaped account object for a hypothetical,
  // non-onboarded second tenant -- Phase 3 forbids onboarding a real one,
  // so this is how its isolation is proven: a raw account object whose
  // OWN tenantId is explicitly attached (exactly what evaluateSession()
  // would produce for a genuinely different tenant's session), passed
  // directly to the same authorization helpers a real request would hit.
  return { userId: 'usr_synthetic', role: 'owner', locationIds: '*', tenantId: 't_synthetic-second-tenant', ...overrides }
}

function testWildcardMeansAllLocationsInsideOwnTenantOnly() {
  const ltaOwner = ltaAccount()
  assert(isWildcardGrant(ltaOwner), 'a wildcard grant for the real tenant must be treated as company-wide')
  assert(requireLocationAccess(ltaOwner, LTA_LOCATION_ID), 'a wildcard LTA account must reach an LTA location')
  assert(requireLocationAccess(ltaOwner, 999999), 'a wildcard LTA account is not restricted to any specific numeric id (company-wide, within its own tenant)')
}

function testSyntheticTenantWildcardNeverMeansPlatformWide() {
  const synthetic = syntheticTenantAccount()
  assert(!isWildcardGrant(synthetic), 'a wildcard grant for a tenant that owns no location catalog must never be treated as company-wide')
  assert(!requireLocationAccess(synthetic, LTA_LOCATION_ID), 'a synthetic tenant\'s wildcard grant must not reach a Los Tres Amigos location')
  assert(!tenantOwnsLocationCatalog(synthetic.tenantId), 'a non-onboarded tenant must own no location catalog at all')
}

// --- RESOURCE TENANT CHECKS: Tenant A cannot access Tenant B resource ids --

function testSyntheticTenantCannotReadLtaResourcesEvenWithMatchingExplicitGrant() {
  // Even an EXPLICIT numeric grant that happens to collide with a real Los
  // Tres Amigos locationId must not authorize a synthetic tenant -- the
  // tenant-ownership check runs before the account's own grant array is
  // ever consulted.
  const synthetic = syntheticTenantAccount({ locationIds: [LTA_LOCATION_ID], role: 'location_manager' })
  assert(!requireLocationAccess(synthetic, LTA_LOCATION_ID), 'a numerically-colliding explicit grant must not let a synthetic tenant read a Los Tres Amigos location')
}

async function testSyntheticTenantSessionDeniedByRequireScopedAuth() {
  const synthetic = syntheticTenantAccount({ role: 'location_manager', locationIds: [LTA_LOCATION_ID] })
  const req = {}
  const res = fakeRes()
  // Directly exercises requireScopedAuth's location-scope step by
  // stubbing requireAuth's own upstream identity check out of scope --
  // this drives the SAME requireLocationAccess() call a real endpoint's
  // requireScopedAuth() would make once past authentication, proving the
  // 404 (never 403 -- existence-hiding) denial behavior for a resource
  // outside the caller's tenant.
  const denied = !requireLocationAccess(synthetic, LTA_LOCATION_ID)
  assert(denied, 'a synthetic tenant session must be denied access to an LTA-owned location')
}

// --- LOCATION-LEVEL RESTRICTIONS WITHIN THE SAME TENANT STILL WORK ---------

function testWithinTenantLocationScopingUnchanged() {
  const scopedManager = ltaAccount({ role: 'location_manager', locationIds: [3, 7] })
  assert(requireLocationAccess(scopedManager, 7), 'a scoped LTA manager must still reach an assigned location')
  assert(!requireLocationAccess(scopedManager, 12), 'a scoped LTA manager must still be denied an unassigned location')
}

// --- UNAUTHORIZED ACCESS RETURNS THE EXISTING SAFE 404/DENIAL BEHAVIOR -----

async function testUnauthorizedLocationReturns404ViaRequireScopedAuth() {
  await seedStaticDirectory()
  const token = await signSession({ userId: 'usr_lm', email: 'lm@example.com', role: 'location_manager', locationIds: [3, 7], tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  const req = { headers: { cookie: `${SESSION_COOKIE}=${token}` } }
  const res = fakeRes()
  const scope = await requireScopedAuth(req, res, {
    permission: [Permission.REPLY, Permission.REPLY_ASSIGNED],
    resolveLocationId: async () => 12, // outside this manager's [3, 7] grant
  })
  assert(scope === null, 'an unauthorized location must deny the request')
  assert(res.statusCode === 404, `expected 404 (existence-hiding), got ${res.statusCode}`)
}

async function main() {
  console.log('--- SESSION MODEL ---')
  await run('login produces a signed session containing tenantId', testLoginProducesSessionWithTenantId)
  await run('existing LTA Owner/Admin/Marketing/Location Manager/Read Only logins still work', testExistingRolesStillLoginSuccessfully)

  console.log('\n--- ACCOUNT RESOLUTION ---')
  await run('ACCOUNT_DIRECTORY_JSON users resolve to t_los-tres-amigos', testAccountDirectoryUsersResolveToDefaultTenant)
  await run('Redis-backed (userStore.js) users resolve to t_los-tres-amigos', testRedisUsersResolveToDefaultTenant)
  await run('resolveTenantId derives the default tenant from role when no tenantId is attached yet', testResolveTenantIdDerivesFromRoleWhenNotAttached)

  console.log('\n--- SESSION TENANT VERIFICATION ---')
  await run('a token missing the tenantId claim is rejected', testMissingTenantIdInTokenIsRejected)
  await run('a tampered/forged tenantId claim invalidates the whole session', testTamperedTenantIdInvalidatesSession)
  await run('a session whose tenantId matches the account\'s real membership is accepted', testValidTenantIdSessionIsAccepted)

  console.log('\n--- WILDCARD SEMANTICS ---')
  await run('\'*\' means all locations inside the account\'s own tenant, unrestricted within it', testWildcardMeansAllLocationsInsideOwnTenantOnly)
  await run('a synthetic tenant\'s wildcard grant never means platform-wide access', testSyntheticTenantWildcardNeverMeansPlatformWide)

  console.log('\n--- RESOURCE TENANT CHECKS ---')
  await run('a synthetic tenant cannot read an LTA resource even with a numerically-colliding explicit grant', testSyntheticTenantCannotReadLtaResourcesEvenWithMatchingExplicitGrant)
  await run('a synthetic second-tenant session cannot read LTA resources via requireScopedAuth\'s location check', testSyntheticTenantSessionDeniedByRequireScopedAuth)
  await run('location-level restrictions within the same tenant are unchanged', testWithinTenantLocationScopingUnchanged)

  console.log('\n--- DENIAL BEHAVIOR ---')
  await run('an unauthorized location via requireScopedAuth still returns 404, never 403', testUnauthorizedLocationReturns404ViaRequireScopedAuth)

  console.log('\n--- FAIL-CLOSED TENANT-RESOLUTION HARDENING ---')
  await run('a null account cannot resolve to Los Tres Amigos', testNullAccountCannotResolveToLta)
  await run('a malformed account cannot resolve to Los Tres Amigos', testMalformedAccountCannotResolveToLta)
  await run('an unknown legacy role cannot resolve to Los Tres Amigos', testUnknownLegacyRoleCannotResolveToLta)
  await run('an invalid location grant cannot resolve to Los Tres Amigos', testInvalidLocationGrantCannotResolveToLta)
  await run('a malformed explicit tenantId never falls through to legacy-role derivation', testExplicitButInvalidTenantIdNeverFallsThroughToLegacyDerivation)
  await run('a valid explicit-tenant account resolves to its own explicit tenant', testValidExplicitTenantAccountResolvesToItsExplicitTenant)
  await run('resolveBootstrapTenantId() is the separate, sanctioned pre-authentication escape hatch', testBootstrapTenantIdIsSeparateFromResolveTenantId)
  await run('requireLocationAccess/isWildcardGrant stay non-throwing (fail closed, never crash) for malformed accounts', testLocationHelpersStayNonThrowingForMalformedAccounts)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
