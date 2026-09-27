// Regression tests for dashboard/api/settings/[action].js's
// review-contact/review-contact-upsert actions (Tenant-Isolated Review
// Contact: multi-tenant readiness). Drives the real handler with a fake
// req/res, same pattern as test_settings_audit_log_endpoint.js, and
// controls the underlying Redis-backed tenant_config store via
// tenantConfigStore.js's own test-only client-factory seam.
//
// Run directly: node tests/test_settings_review_contact_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/settings/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests, _resetRedisClientForTests } from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setAuditClient, _resetRedisClientForTests as resetAuditClient } from '../dashboard/api/_lib/auditLog.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'
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
    resetAuditClient()
    resetUserRedis()
    _resetLimiterFactoryForTests()
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

function fakeAuditRedis() {
  return { lpush: async () => 1, ltrim: async () => 'OK', lrange: async () => [] }
}

// Same shape/semantics as other test files' own tenant_config fakes
// (test_initial_sync.py's FakeTenantConfigStore, test_rewrite_policy.js's
// fakeTenantConfigRedis) -- this codebase's established per-test-file
// convention of duplicating rather than sharing fakes.
function fakeTenantConfigRedis(records) {
  return {
    hget: async (_key, tenantId) => (records[tenantId] ? JSON.stringify(records[tenantId]) : null),
    hset: async (_key, fields) => { Object.assign(records, Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, JSON.parse(v)]))) },
    // Mirrors upsertTenantConfig()'s CAS_UPSERT_SCRIPT contract: true on a
    // matching configVersion (writes `next`), or the current raw record
    // (as a JSON string) on a mismatch -- never a real Lua eval, just the
    // same check-then-write semantics the real atomic script guarantees.
    eval: async (_script, _keys, [tenantId, expectedVersion, nextJson]) => {
      const current = records[tenantId]
      const currentVersion = current?.configVersion ?? 0
      if (String(currentVersion) !== expectedVersion) return current ? JSON.stringify(current) : null
      records[tenantId] = JSON.parse(nextJson)
      return true
    },
  }
}

const OTHER_TENANT_ID = 't_blue-seafood-grill-dldh5k'

function fakeUserRedis(users) {
  const store = { 'users:v1': { ...users } }
  return {
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hget: async (key, field) => store[key]?.[field] ?? null,
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
  }
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner Person' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Marketing Person' },
    ],
  })
}

// A real user record in a DIFFERENT tenant's own Redis-backed userStore.js
// (never the static, LTA-only ACCOUNT_DIRECTORY_JSON) -- matches
// test_provisioned_tenant_api_reads.js's own established pattern for
// authenticating a non-default-tenant account.
async function setupOtherTenantOwner() {
  const hash = await bcrypt.hash('x', 12)
  const record = { userId: 'usr_owner_other', email: 'owner-other@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId: OTHER_TENANT_ID }
  setUserRedis(() => fakeUserRedis({ usr_owner_other: JSON.stringify(record) }))
}

const ownerToken = () => signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
const otherTenantOwnerToken = () => signSession({ userId: 'usr_owner_other', email: 'owner-other@example.com', role: 'owner', locationIds: '*', tenantId: OTHER_TENANT_ID, sessionVersion: 1 })
const marketingToken = () =>
  signSession({ userId: 'usr_marketing', email: 'marketing@example.com', role: 'marketing', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })

async function invoke({ action, method = 'GET', token, body = {} }) {
  const req = {
    method,
    query: { action },
    body,
    headers: token ? { cookie: `lta_session=${token}` } : {},
    socket: {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function testGetRejectsUnauthenticated() {
  await setDirectory()
  const res = await invoke({ action: 'review-contact' })
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testGetRejectsMarketing() {
  await setDirectory()
  const res = await invoke({ action: 'review-contact', token: await marketingToken() })
  assert(res.statusCode === 403, `expected 403 for marketing (owner/admin only), got ${res.statusCode}`)
}

async function testGetReturnsUnsetWhenNoRecordExists() {
  await setDirectory()
  _setRedisClientForTests(() => fakeTenantConfigRedis({}))
  const res = await invoke({ action: 'review-contact', token: await ownerToken() })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(res.body.email === null && res.body.phone === null, 'an unconfigured tenant must report no contact, never invent one')
}

async function testGetReturnsTheConfiguredValue() {
  await setDirectory()
  _setRedisClientForTests(() => fakeTenantConfigRedis({
    [DEFAULT_TENANT_ID]: { configVersion: 1, reviewContact: { email: 'owner@lta.example', phone: null } },
  }))
  const res = await invoke({ action: 'review-contact', token: await ownerToken() })
  assert(res.statusCode === 200 && res.body.email === 'owner@lta.example', `expected the configured email, got ${JSON.stringify(res.body)}`)
}

async function testUpsertRejectsUnauthenticated() {
  await setDirectory()
  const res = await invoke({ action: 'review-contact-upsert', method: 'POST', body: { email: 'x@example.com' } })
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testUpsertRejectsMarketing() {
  await setDirectory()
  const res = await invoke({ action: 'review-contact-upsert', method: 'POST', token: await marketingToken(), body: { email: 'x@example.com' } })
  assert(res.statusCode === 403, `expected 403 for marketing (owner/admin only), got ${res.statusCode}`)
}

async function testUpsertRejectsInvalidEmail() {
  await setDirectory()
  _setRedisClientForTests(() => fakeTenantConfigRedis({ [DEFAULT_TENANT_ID]: { configVersion: 1 } }))
  const res = await invoke({ action: 'review-contact-upsert', method: 'POST', token: await ownerToken(), body: { email: 'not-an-email' } })
  assert(res.statusCode === 400, `expected 400 for a malformed email, got ${res.statusCode}`)
}

async function testUpsertSavesAndPersistsTheOwnersOwnTenantContact() {
  await setDirectory()
  setAuditClient(() => fakeAuditRedis())
  const records = { [DEFAULT_TENANT_ID]: { configVersion: 1 } }
  _setRedisClientForTests(() => fakeTenantConfigRedis(records))
  const res = await invoke({ action: 'review-contact-upsert', method: 'POST', token: await ownerToken(), body: { email: 'newcontact@example.com', phone: '555-0100' } })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(records[DEFAULT_TENANT_ID].reviewContact.email === 'newcontact@example.com')
  assert(records[DEFAULT_TENANT_ID].reviewContact.phone === '555-0100')
}

async function testUpsertOnlyEverTouchesTheCallersOwnTenant() {
  // The caller is authenticated for OTHER_TENANT_ID -- confirms
  // resolveTenantId(account) (server-derived from the session, never from
  // request input) is what's used, so there is no way for a caller to
  // target a different tenant's contact record even by trying.
  await setDirectory()
  await setupOtherTenantOwner()
  setAuditClient(() => fakeAuditRedis())
  const records = {
    [DEFAULT_TENANT_ID]: { configVersion: 1, reviewContact: { email: 'advertising@l3amigos.com', phone: null } },
    [OTHER_TENANT_ID]: { configVersion: 1 },
  }
  _setRedisClientForTests(() => fakeTenantConfigRedis(records))
  const res = await invoke({ action: 'review-contact-upsert', method: 'POST', token: await otherTenantOwnerToken(), body: { email: 'owner@blueseafoodgrill.example' } })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(records[OTHER_TENANT_ID].reviewContact.email === 'owner@blueseafoodgrill.example')
  assert(records[DEFAULT_TENANT_ID].reviewContact.email === 'advertising@l3amigos.com', "LTA's own contact must be completely untouched by another tenant's update")
}

async function testUpsertCanClearBothFields() {
  await setDirectory()
  setAuditClient(() => fakeAuditRedis())
  const records = { [DEFAULT_TENANT_ID]: { configVersion: 1, reviewContact: { email: 'old@example.com', phone: null } } }
  _setRedisClientForTests(() => fakeTenantConfigRedis(records))
  const res = await invoke({ action: 'review-contact-upsert', method: 'POST', token: await ownerToken(), body: { email: '', phone: '' } })
  assert(res.statusCode === 200)
  assert(res.body.email === null && res.body.phone === null, 'an empty email/phone must clear the field, not be rejected')
}

async function testUpsertRejectsNonPostMethod() {
  await setDirectory()
  const res = await invoke({ action: 'review-contact-upsert', method: 'GET', token: await ownerToken() })
  assert(res.statusCode === 405, `expected 405 for GET, got ${res.statusCode}`)
}

async function main() {
  await run('GET review-contact rejects an unauthenticated request with 401', testGetRejectsUnauthenticated)
  await run('GET review-contact rejects marketing (owner/admin only) with 403', testGetRejectsMarketing)
  await run('GET review-contact returns no contact for an unconfigured tenant, never invents one', testGetReturnsUnsetWhenNoRecordExists)
  await run('GET review-contact returns the configured value', testGetReturnsTheConfiguredValue)
  await run('POST review-contact-upsert rejects an unauthenticated request with 401', testUpsertRejectsUnauthenticated)
  await run('POST review-contact-upsert rejects marketing (owner/admin only) with 403', testUpsertRejectsMarketing)
  await run('POST review-contact-upsert rejects a malformed email with 400', testUpsertRejectsInvalidEmail)
  await run('POST review-contact-upsert saves and persists the tenant\'s own contact', testUpsertSavesAndPersistsTheOwnersOwnTenantContact)
  await run("POST review-contact-upsert only ever touches the caller's own tenant, never another's", testUpsertOnlyEverTouchesTheCallersOwnTenant)
  await run('POST review-contact-upsert can clear both fields back to unset', testUpsertCanClearBothFields)
  await run('POST review-contact-upsert rejects a non-POST method with 405', testUpsertRejectsNonPostMethod)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
