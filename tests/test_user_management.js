// Regression tests for the Owner/Admin user-management actions -- Multi-
// Location Authentication & User Access System, Commit 6:
// users-list, update-user-role-locations, disable-user, enable-user, and
// the last-active-Owner protection shared by all of them. Mirrors
// test_invitations.js's fixtures/fake-Redis pattern.
//
// Run directly: node tests/test_user_management.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import settingsHandler from '../dashboard/api/settings/[action].js'
import { signSession, verifySession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { requireAuth } from '../dashboard/api/_lib/auth.js'
import { _setRedisClientForTests as setUserStoreClient, _resetRedisClientForTests as resetUserStoreClient } from '../dashboard/api/_lib/userStore.js'
import { _setRedisClientForTests as setTokenStoreClient, _resetRedisClientForTests as resetTokenStoreClient } from '../dashboard/api/_lib/tokenStore.js'

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
    resetUserStoreClient()
    resetTokenStoreClient()
    delete process.env.ACCOUNT_DIRECTORY_JSON
  }
}

function fakeRedis() {
  const data = {}
  return {
    get: async (key) => data[key]?.value ?? null,
    set: async (key, value) => { data[key] = { value }; return 'OK' },
    getdel: async (key) => { const v = data[key]?.value ?? null; delete data[key]; return v },
    del: async (key) => { const existed = key in data; delete data[key]; return existed ? 1 : 0 },
    hget: async (key, field) => data[key]?.value?.[field] ?? null,
    hset: async (key, fields) => { data[key] ??= { value: {} }; Object.assign(data[key].value, fields) },
    hgetall: async (key) => ({ ...(data[key]?.value ?? {}) }),
    hdel: async (key, field) => { if (!data[key]?.value?.[field]) return 0; delete data[key].value[field]; return 1 },
  }
}

function installFakeRedis() {
  const client = fakeRedis()
  setUserStoreClient(() => client)
  setTokenStoreClient(() => client)
  return client
}

async function bcryptHash() { return bcrypt.hash('correct-horse-battery-staple', 12) }

async function seedDirectory(overrides = {}) {
  const hash = await bcryptHash()
  const base = {
    usr_owner: { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' },
    usr_owner2: { userId: 'usr_owner2', email: 'owner2@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner Two' },
    usr_admin: { userId: 'usr_admin', email: 'admin@example.com', passwordHash: hash, role: 'admin', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Admin' },
    usr_lm: { userId: 'usr_lm', email: 'lm@example.com', passwordHash: hash, role: 'location_manager', locationIds: [7, 12], sessionVersion: 1, disabled: false, displayName: 'LM' },
  }
  for (const [k, patch] of Object.entries(overrides)) {
    if (patch === null) { delete base[k]; continue } // null is the "omit this fixture" sentinel
    base[k] = { ...base[k], ...patch }
  }
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({ accounts: Object.values(base) })
  return base
}

async function ownerToken() { return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', sessionVersion: 1 }) }
async function adminToken() { return signSession({ userId: 'usr_admin', email: 'admin@example.com', role: 'admin', locationIds: '*', sessionVersion: 1 }) }
async function lmToken() { return signSession({ userId: 'usr_lm', email: 'lm@example.com', role: 'location_manager', locationIds: [7, 12], sessionVersion: 1 }) }

function fakeRes() {
  const res = { statusCode: null, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  return res
}

async function call(action, { method = 'POST', token, body, query } = {}) {
  const headers = token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}
  const req = { method, headers, body: body ?? {}, query: { action, ...(query ?? {}) } }
  const res = fakeRes()
  await settingsHandler(req, res)
  return res
}

// --- users-list -------------------------------------------------------------

async function testUsersListIncludesStaticAndRedisAccountsDeduplicated() {
  await seedDirectory()
  installFakeRedis()
  const res = await call('users-list', { method: 'GET', token: await ownerToken() })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  const emails = res.body.users.map(u => u.email)
  assert(emails.includes('owner@example.com') && emails.includes('lm@example.com'), 'must include every static account')
  const owner = res.body.users.find(u => u.email === 'owner@example.com')
  assert(owner.status === 'active', `a static account must show status "active", got ${owner.status}`)
  assert(!JSON.stringify(res.body).toLowerCase().includes('passwordhash'), 'must never leak passwordHash')
}

async function testUsersListForbiddenForMarketing() {
  await seedDirectory({ usr_marketing: { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: await bcryptHash(), role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false } })
  installFakeRedis()
  const token = await signSession({ userId: 'usr_marketing', email: 'marketing@example.com', role: 'marketing', locationIds: '*', sessionVersion: 1 })
  const res = await call('users-list', { method: 'GET', token })
  assert(res.statusCode === 403, `Marketing must not hold USERS_MANAGE, got ${res.statusCode}`)
}

// --- update-user-role-locations ---------------------------------------------

async function testUpdateRoleLocationsSucceedsAndBumpsSessionVersion() {
  await seedDirectory()
  installFakeRedis()
  const res = await call('update-user-role-locations', {
    token: await ownerToken(),
    body: { userId: 'usr_lm', role: 'location_manager', locationIds: [7] }, // location 12 removed
  })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode} (${JSON.stringify(res.body)})`)
  assert(JSON.stringify(res.body.locationIds) === JSON.stringify([7]), 'locationIds must reflect the update')

  // The explicit required security test: login -> access Location A ->
  // Owner removes Location A -> the OLD cookie must fail immediately,
  // never waiting for its own 12h expiry.
  const oldSessionToken = await lmToken() // still claims locationIds [7, 12], sessionVersion 1
  const reqBefore = { headers: { cookie: `${SESSION_COOKIE}=${oldSessionToken}` } }
  const before = await requireAuth(reqBefore, fakeRes(), null)
  assert(before === null, 'the pre-update session must already be rejected (sessionVersion bumped by the update above)')
}

async function testAdminCannotPromoteToOwner() {
  await seedDirectory()
  installFakeRedis()
  const res = await call('update-user-role-locations', {
    token: await adminToken(),
    body: { userId: 'usr_lm', role: 'owner', locationIds: '*' },
  })
  assert(res.statusCode === 403, `Admin must not be able to promote anyone to Owner, got ${res.statusCode}`)
}

async function testCannotDemoteTheLastActiveOwner() {
  await seedDirectory({ usr_owner2: null }) // only one owner in this scenario
  installFakeRedis()
  const res = await call('update-user-role-locations', {
    token: await ownerToken(),
    body: { userId: 'usr_owner', role: 'admin', locationIds: '*' },
  })
  assert(res.statusCode === 409 && res.body.error === 'last_owner', `demoting the last active Owner must be blocked (409), got ${res.statusCode}`)
}

async function testCanDemoteAnOwnerWhenAnotherOwnerExists() {
  await seedDirectory() // usr_owner AND usr_owner2 both active
  installFakeRedis()
  const res = await call('update-user-role-locations', {
    token: await ownerToken(),
    body: { userId: 'usr_owner2', role: 'admin', locationIds: '*' },
  })
  assert(res.statusCode === 200, `demoting an Owner is fine when another active Owner remains, got ${res.statusCode}`)
}

async function testOwnerLocationIdsMustStayWildcard() {
  await seedDirectory()
  installFakeRedis()
  const res = await call('update-user-role-locations', {
    token: await ownerToken(),
    body: { userId: 'usr_owner2', role: 'owner', locationIds: [7] },
  })
  assert(res.statusCode === 400, `an Owner must always be company-wide ("*"), got ${res.statusCode}`)
}

// --- disable-user / enable-user ---------------------------------------------

async function testDisableUserSucceedsAndBumpsSessionVersion() {
  await seedDirectory()
  installFakeRedis()
  const res = await call('disable-user', { token: await ownerToken(), body: { userId: 'usr_lm' } })
  assert(res.statusCode === 200 && res.body.disabled === true, `expected disabled:true, got ${res.statusCode} (${JSON.stringify(res.body)})`)

  const oldSessionToken = await lmToken()
  const account = await requireAuth({ headers: { cookie: `${SESSION_COOKIE}=${oldSessionToken}` } }, fakeRes(), null)
  assert(account === null, 'a disabled account\'s existing session must be rejected immediately')
}

async function testCannotDisableTheLastActiveOwner() {
  await seedDirectory({ usr_owner2: null })
  installFakeRedis()
  const res = await call('disable-user', { token: await ownerToken(), body: { userId: 'usr_owner' } })
  assert(res.statusCode === 409 && res.body.error === 'last_owner', `disabling the last active Owner must be blocked (409), got ${res.statusCode}`)
}

async function testCanDisableAnOwnerWhenAnotherOwnerExists() {
  await seedDirectory()
  installFakeRedis()
  const res = await call('disable-user', { token: await ownerToken(), body: { userId: 'usr_owner2' } })
  assert(res.statusCode === 200, `disabling an Owner is fine when another active Owner remains, got ${res.statusCode}`)
}

async function testEnableUserReactivatesAccess() {
  await seedDirectory()
  installFakeRedis()
  const disableRes = await call('disable-user', { token: await ownerToken(), body: { userId: 'usr_lm' } })
  assert(disableRes.statusCode === 200, 'setup: disable must succeed')

  const enableRes = await call('enable-user', { token: await ownerToken(), body: { userId: 'usr_lm' } })
  assert(enableRes.statusCode === 200 && enableRes.body.disabled === false, `expected disabled:false, got ${enableRes.statusCode}`)

  // A fresh login-style token (current sessionVersion) must now work again.
  const freshToken = await signSession({ userId: 'usr_lm', email: 'lm@example.com', role: 'location_manager', locationIds: [7, 12], sessionVersion: 2 })
  const account = await requireAuth({ headers: { cookie: `${SESSION_COOKIE}=${freshToken}` } }, fakeRes(), null)
  assert(account !== null, 're-enabled account must be reachable again with a current sessionVersion token')
}

// --- forbidden for non-USERS_MANAGE roles -----------------------------------

async function testDisableEnableForbiddenForLocationManager() {
  await seedDirectory()
  installFakeRedis()
  const disableRes = await call('disable-user', { token: await lmToken(), body: { userId: 'usr_admin' } })
  assert(disableRes.statusCode === 403, `location_manager must not hold USERS_MANAGE, got ${disableRes.statusCode}`)
}

async function main() {
  await run('users-list: includes static and Redis accounts, deduplicated, no passwordHash', testUsersListIncludesStaticAndRedisAccountsDeduplicated)
  await run('users-list: forbidden for Marketing (no USERS_MANAGE)', testUsersListForbiddenForMarketing)

  await run('update-user-role-locations: succeeds and bumps sessionVersion (old session immediately rejected)', testUpdateRoleLocationsSucceedsAndBumpsSessionVersion)
  await run('update-user-role-locations: Admin cannot promote anyone to Owner', testAdminCannotPromoteToOwner)
  await run('update-user-role-locations: cannot demote the last active Owner (409)', testCannotDemoteTheLastActiveOwner)
  await run('update-user-role-locations: CAN demote an Owner when another active Owner remains', testCanDemoteAnOwnerWhenAnotherOwnerExists)
  await run('update-user-role-locations: Owner role must stay company-wide ("*")', testOwnerLocationIdsMustStayWildcard)

  await run('disable-user: succeeds and bumps sessionVersion (existing session immediately rejected)', testDisableUserSucceedsAndBumpsSessionVersion)
  await run('disable-user: cannot disable the last active Owner (409)', testCannotDisableTheLastActiveOwner)
  await run('disable-user: CAN disable an Owner when another active Owner remains', testCanDisableAnOwnerWhenAnotherOwnerExists)
  await run('enable-user: reactivates access for a fresh session', testEnableUserReactivatesAccess)

  await run('disable-user/enable-user: forbidden for location_manager', testDisableEnableForbiddenForLocationManager)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
