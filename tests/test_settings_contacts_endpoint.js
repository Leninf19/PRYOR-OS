// Regression tests for dashboard/api/settings/[action].js's Restaurant
// Contacts actions (Phase 8, Milestone 8.3). Drives the real handler with a
// fake req/res, same pattern as test_actions_endpoint.js, and controls the
// underlying Redis-backed store via contactStore.js's test-only
// client-factory seam (no real Upstash account).
//
// Run directly: node tests/test_settings_contacts_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/settings/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests, _resetRedisClientForTests } from '../dashboard/api/_lib/contactStore.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'

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
    delete process.env.VERCEL_ENV
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

function fakeRedis(initial = {}) {
  const store = { ...initial }
  return {
    hgetall: async () => ({ ...store }),
    hget: async (_key, field) => store[field] ?? null,
    hset: async (_key, fields) => { Object.assign(store, fields) },
    hdel: async (_key, field) => { if (!(field in store)) return 0; delete store[field]; return 1 },
  }
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner Person' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Marketing Person' },
      { userId: 'usr_lm', email: 'lm@example.com', passwordHash: hash, role: 'location_manager', locationIds: [9], sessionVersion: 1, disabled: false, displayName: 'Canton Manager' },
      { userId: 'usr_readonly', email: 'readonly@example.com', passwordHash: hash, role: 'read_only', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'RO Person' },
    ],
  })
}

async function tokenFor(userId, email, role, locationIds) {
  return signSession({ userId, email, role, locationIds, sessionVersion: 1 })
}
const ownerToken = () => tokenFor('usr_owner', 'owner@example.com', 'owner', '*')
const marketingToken = () => tokenFor('usr_marketing', 'marketing@example.com', 'marketing', '*')
const managerToken = () => tokenFor('usr_lm', 'lm@example.com', 'location_manager', [9])
const readOnlyToken = () => tokenFor('usr_readonly', 'readonly@example.com', 'read_only', '*')

async function invoke({ action, method = 'GET', token, body }) {
  const req = {
    method,
    query: { action },
    body: body ?? {},
    headers: token ? { cookie: `lta_session=${token}` } : {},
    socket: {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function testUnknownActionReturns404() {
  await setDirectory()
  const res = await invoke({ action: 'nonsense', token: await ownerToken() })
  assert(res.statusCode === 404, `expected 404, got ${res.statusCode}`)
}

async function testListRejectsUnauthenticated() {
  await setDirectory()
  const res = await invoke({ action: 'contacts' })
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testListRejectsReadOnly() {
  await setDirectory()
  const res = await invoke({ action: 'contacts', token: await readOnlyToken() })
  assert(res.statusCode === 403, `read_only must not view restaurant contacts, expected 403, got ${res.statusCode}`)
}

async function testOwnerSeesAllContacts() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await invoke({ action: 'contacts-upsert', method: 'POST', token: await ownerToken(), body: { locationId: 9, patch: { locationName: 'Canton', primaryEmail: 'canton@example.com' } } })
  await invoke({ action: 'contacts-upsert', method: 'POST', token: await ownerToken(), body: { locationId: 2, patch: { locationName: 'Chelsea', primaryEmail: 'chelsea@example.com' } } })
  const res = await invoke({ action: 'contacts', token: await ownerToken() })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(Object.keys(res.body.contacts).length === 2, 'owner must see every location\'s contact')
}

async function testManagerSeesOnlyOwnLocation() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await invoke({ action: 'contacts-upsert', method: 'POST', token: await ownerToken(), body: { locationId: 9, patch: { locationName: 'Canton', primaryEmail: 'canton@example.com' } } })
  await invoke({ action: 'contacts-upsert', method: 'POST', token: await ownerToken(), body: { locationId: 2, patch: { locationName: 'Chelsea', primaryEmail: 'chelsea@example.com' } } })
  const res = await invoke({ action: 'contacts', token: await managerToken() })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  const keys = Object.keys(res.body.contacts)
  assert(keys.length === 1 && keys[0] === '9', `manager (locationIds: [9]) must see only their own location, got keys: ${keys.join(', ')}`)
}

async function testUpsertRejectsManager() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'contacts-upsert', method: 'POST', token: await managerToken(), body: { locationId: 9, patch: { primaryEmail: 'x@example.com' } } })
  assert(res.statusCode === 403, `location_manager must not have CONTACTS_MANAGE, expected 403, got ${res.statusCode}`)
}

async function testUpsertRejectsOutOfScopeLocationWith404NotForbidden() {
  // A location_manager somehow lacking CONTACTS_MANAGE already gets 403 above;
  // this test targets the requireScopedAuth ordering itself using an owner
  // account artificially scoped to a single location, confirming the
  // out-of-scope branch is 404 (existence-hiding), never 403, matching the
  // frozen API error contract every other requireScopedAuth caller follows.
  await setDirectory()
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{
      userId: 'usr_scoped', email: 'scoped@example.com', passwordHash: await bcrypt.hash('x', 12),
      role: 'location_manager', locationIds: [9], sessionVersion: 1, disabled: false, displayName: 'Scoped',
    }],
  })
  // location_manager lacks CONTACTS_MANAGE entirely, so this always 403s at
  // the permission check before ever reaching the location-scope check --
  // confirms the permission gate is checked BEFORE location scope (a role
  // with no permission at all must never leak location-existence info).
  const token = await tokenFor('usr_scoped', 'scoped@example.com', 'location_manager', [9])
  const res = await invoke({ action: 'contacts-upsert', method: 'POST', token, body: { locationId: 99, patch: { primaryEmail: 'x@example.com' } } })
  assert(res.statusCode === 403, `a role with no CONTACTS_MANAGE permission at all must 403 regardless of location, got ${res.statusCode}`)
}

// Phase 8, Milestone 8.10 (cross-cutting RBAC verification): every real
// production account with CONTACTS_MANAGE today (owner/marketing) is
// company-wide (locationIds: '*'), so requireScopedAuth's genuine 404
// (out-of-scope, permission-holding) branch has never actually been
// exercised end-to-end by a permitted-but-scoped account -- only by a role
// that lacks the permission entirely (which 403s before scope is even
// checked, see above). This constructs a hypothetical marketing account
// scoped to a single location to close that gap and prove the ordering is
// really permission-then-scope, not scope-then-permission.
async function testScopedMarketingAccountCanWriteOwnLocationButGets404ForAnother() {
  await setDirectory()
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{
      userId: 'usr_scoped_mkt', email: 'scopedmkt@example.com', passwordHash: await bcrypt.hash('x', 12),
      role: 'marketing', locationIds: [9], sessionVersion: 1, disabled: false, displayName: 'Scoped Marketing',
    }],
  })
  _setRedisClientForTests(() => fakeRedis())
  const token = await tokenFor('usr_scoped_mkt', 'scopedmkt@example.com', 'marketing', [9])

  const inScope = await invoke({ action: 'contacts-upsert', method: 'POST', token, body: { locationId: 9, patch: { primaryEmail: 'ok@example.com' } } })
  assert(inScope.statusCode === 200, `a scoped account with CONTACTS_MANAGE must succeed for its own location, got ${inScope.statusCode}`)

  const outOfScope = await invoke({ action: 'contacts-upsert', method: 'POST', token, body: { locationId: 2, patch: { primaryEmail: 'ok@example.com' } } })
  assert(outOfScope.statusCode === 404, `a scoped account WITH the permission must 404 (never 403) for a location outside its grant, got ${outOfScope.statusCode}`)
}

// Same gap, closed for contacts-delete and contacts-toggle-active -- both
// call requireScopedAuth identically to contacts-upsert.
async function testScopedMarketingAccountGets404FromDeleteAndToggleForAnotherLocation() {
  await setDirectory()
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{
      userId: 'usr_scoped_mkt', email: 'scopedmkt@example.com', passwordHash: await bcrypt.hash('x', 12),
      role: 'marketing', locationIds: [9], sessionVersion: 1, disabled: false, displayName: 'Scoped Marketing',
    }],
  })
  _setRedisClientForTests(() => fakeRedis())
  const token = await tokenFor('usr_scoped_mkt', 'scopedmkt@example.com', 'marketing', [9])

  const deleteRes = await invoke({ action: 'contacts-delete', method: 'POST', token, body: { locationId: 2 } })
  assert(deleteRes.statusCode === 404, `contacts-delete: expected 404 for an out-of-scope location, got ${deleteRes.statusCode}`)

  const toggleRes = await invoke({ action: 'contacts-toggle-active', method: 'POST', token, body: { locationId: 2, active: false } })
  assert(toggleRes.statusCode === 404, `contacts-toggle-active: expected 404 for an out-of-scope location, got ${toggleRes.statusCode}`)
}

async function testUpsertRejectsInvalidEmailFormat() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'contacts-upsert', method: 'POST', token: await ownerToken(), body: { locationId: 9, patch: { primaryEmail: 'not-an-email' } } })
  assert(res.statusCode === 400, `expected 400 for a malformed email, got ${res.statusCode}`)
}

async function testUpsertRejectsInvalidCcEmail() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'contacts-upsert', method: 'POST', token: await ownerToken(), body: { locationId: 9, patch: { primaryEmail: 'ok@example.com', ccEmails: ['also-ok@example.com', 'nope'] } } })
  assert(res.statusCode === 400, `expected 400 when any CC email is malformed, got ${res.statusCode}`)
}

async function testUpsertRejectsUnknownPatchField() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'contacts-upsert', method: 'POST', token: await ownerToken(), body: { locationId: 9, patch: { primaryEmail: 'ok@example.com', locationId: 999 } } })
  assert(res.statusCode === 400, `patch containing a server-owned field (locationId) must be rejected outright, got ${res.statusCode}`)
}

async function testUpsertWarnsOnDuplicatePrimaryEmailButDoesNotFail() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await invoke({ action: 'contacts-upsert', method: 'POST', token: await ownerToken(), body: { locationId: 9, patch: { locationName: 'Canton', primaryEmail: 'shared@example.com' } } })
  const res = await invoke({ action: 'contacts-upsert', method: 'POST', token: await ownerToken(), body: { locationId: 2, patch: { locationName: 'Chelsea', primaryEmail: 'shared@example.com' } } })
  assert(res.statusCode === 200, `a duplicate primary email must not be a hard failure, expected 200, got ${res.statusCode}`)
  assert(Array.isArray(res.body.warnings) && res.body.warnings.length === 1, 'a non-blocking warning must be returned for the duplicate')
}

async function testDeleteRemovesRecord() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await invoke({ action: 'contacts-upsert', method: 'POST', token: await ownerToken(), body: { locationId: 9, patch: { primaryEmail: 'canton@example.com' } } })
  const res = await invoke({ action: 'contacts-delete', method: 'POST', token: await marketingToken(), body: { locationId: 9 } })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.removed === true, 'removed must be true')
  const after = await invoke({ action: 'contacts', token: await ownerToken() })
  assert(Object.keys(after.body.contacts).length === 0, 'the contact must actually be gone after delete')
}

async function testToggleActiveDisablesThenEnables() {
  await setDirectory()
  const client = fakeRedis()
  _setRedisClientForTests(() => client)
  await invoke({ action: 'contacts-upsert', method: 'POST', token: await ownerToken(), body: { locationId: 9, patch: { primaryEmail: 'canton@example.com' } } })
  const disableRes = await invoke({ action: 'contacts-toggle-active', method: 'POST', token: await marketingToken(), body: { locationId: 9, active: false } })
  assert(disableRes.statusCode === 200 && disableRes.body.record.active === false, `expected active:false, got ${JSON.stringify(disableRes.body)}`)
  const enableRes = await invoke({ action: 'contacts-toggle-active', method: 'POST', token: await marketingToken(), body: { locationId: 9, active: true } })
  assert(enableRes.statusCode === 200 && enableRes.body.record.active === true, `expected active:true, got ${JSON.stringify(enableRes.body)}`)
}

async function testToggleActiveOnUnconfiguredLocationReturns404() {
  await setDirectory()
  _setRedisClientForTests(() => fakeRedis())
  const res = await invoke({ action: 'contacts-toggle-active', method: 'POST', token: await ownerToken(), body: { locationId: 9, active: false } })
  assert(res.statusCode === 404, `toggling a never-configured location must 404, got ${res.statusCode}`)
}

async function testStoreUnavailableReturns503() {
  await setDirectory()
  _setRedisClientForTests(() => ({ hgetall: async () => { throw new Error('ECONNREFUSED') } }))
  const res = await invoke({ action: 'contacts', token: await ownerToken() })
  assert(res.statusCode === 503, `expected 503 when the contact store is unreachable, got ${res.statusCode}`)
}

async function main() {
  await run('an unrecognized action returns 404', testUnknownActionReturns404)
  await run('GET /contacts rejects an unauthenticated request with 401', testListRejectsUnauthenticated)
  await run('GET /contacts rejects read_only with 403', testListRejectsReadOnly)
  await run('owner sees every location\'s contact', testOwnerSeesAllContacts)
  await run('location_manager sees only their own assigned location\'s contact', testManagerSeesOnlyOwnLocation)
  await run('contacts-upsert rejects location_manager (no CONTACTS_MANAGE) with 403', testUpsertRejectsManager)
  await run('a role with no CONTACTS_MANAGE permission 403s regardless of location scope', testUpsertRejectsOutOfScopeLocationWith404NotForbidden)
  await run('a scoped account WITH CONTACTS_MANAGE succeeds for its own location and 404s (not 403) for another', testScopedMarketingAccountCanWriteOwnLocationButGets404ForAnother)
  await run('the same scoped-account 404 behavior holds for contacts-delete and contacts-toggle-active', testScopedMarketingAccountGets404FromDeleteAndToggleForAnotherLocation)
  await run('contacts-upsert rejects a malformed primary email with 400', testUpsertRejectsInvalidEmailFormat)
  await run('contacts-upsert rejects a malformed CC email with 400', testUpsertRejectsInvalidCcEmail)
  await run('contacts-upsert rejects a patch containing a server-owned field outright', testUpsertRejectsUnknownPatchField)
  await run('contacts-upsert warns (not fails) on a duplicate primary email across locations', testUpsertWarnsOnDuplicatePrimaryEmailButDoesNotFail)
  await run('contacts-delete genuinely removes the record', testDeleteRemovesRecord)
  await run('contacts-toggle-active disables then re-enables, preserving the record', testToggleActiveDisablesThenEnables)
  await run('contacts-toggle-active on a never-configured location returns 404', testToggleActiveOnUnconfiguredLocationReturns404)
  await run('an unavailable contact store surfaces as 503, not a crash or empty list', testStoreUnavailableReturns503)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
