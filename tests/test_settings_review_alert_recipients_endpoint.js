// Regression tests for dashboard/api/settings/[action].js's
// review-alert-recipients/review-alert-recipients-upsert actions (Tenant
// Alert Recipients revision: internal team notification list for
// new/critical review alerts). Drives the real handler with a fake
// req/res, same pattern as test_settings_review_contact_endpoint.js, and
// controls the underlying Redis-backed tenant_config store via
// tenantConfigStore.js's own test-only client-factory seam.
//
// Run directly: node tests/test_settings_review_alert_recipients_endpoint.js

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

// Same shape/semantics as test_settings_review_contact_endpoint.js's own
// fake -- this codebase's established per-test-file convention of
// duplicating rather than sharing fakes.
function fakeTenantConfigRedis(records) {
  return {
    hget: async (_key, tenantId) => (records[tenantId] ? JSON.stringify(records[tenantId]) : null),
    hset: async (_key, fields) => { Object.assign(records, Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, JSON.parse(v)]))) },
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
  const res = await invoke({ action: 'review-alert-recipients' })
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testGetRejectsMarketing() {
  await setDirectory()
  const res = await invoke({ action: 'review-alert-recipients', token: await marketingToken() })
  assert(res.statusCode === 403, `expected 403 for marketing (owner/admin only), got ${res.statusCode}`)
}

async function testGetReturnsEmptyWhenNoRecordExists() {
  await setDirectory()
  _setRedisClientForTests(() => fakeTenantConfigRedis({}))
  const res = await invoke({ action: 'review-alert-recipients', token: await ownerToken() })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(Array.isArray(res.body.recipients) && res.body.recipients.length === 0, 'an unconfigured tenant must report an empty list, never invent one')
}

async function testGetReturnsTheConfiguredValue() {
  await setDirectory()
  _setRedisClientForTests(() => fakeTenantConfigRedis({
    [DEFAULT_TENANT_ID]: { configVersion: 1, reviewAlertRecipients: ['owner@lta.example', 'manager@lta.example'] },
  }))
  const res = await invoke({ action: 'review-alert-recipients', token: await ownerToken() })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(JSON.stringify(res.body.recipients) === JSON.stringify(['owner@lta.example', 'manager@lta.example']), JSON.stringify(res.body))
}

async function testUpsertRejectsUnauthenticated() {
  await setDirectory()
  const res = await invoke({ action: 'review-alert-recipients-upsert', method: 'POST', body: { recipients: ['x@example.com'] } })
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testUpsertRejectsMarketing() {
  await setDirectory()
  const res = await invoke({ action: 'review-alert-recipients-upsert', method: 'POST', token: await marketingToken(), body: { recipients: ['x@example.com'] } })
  assert(res.statusCode === 403, `expected 403 for marketing (owner/admin only, i.e. a lower-privilege member cannot), got ${res.statusCode}`)
}

async function testUpsertRejectsNonArrayBody() {
  await setDirectory()
  _setRedisClientForTests(() => fakeTenantConfigRedis({ [DEFAULT_TENANT_ID]: { configVersion: 1 } }))
  const res = await invoke({ action: 'review-alert-recipients-upsert', method: 'POST', token: await ownerToken(), body: { recipients: 'not-an-array@example.com' } })
  assert(res.statusCode === 400, `expected 400 for a non-array body, got ${res.statusCode}`)
}

async function testUpsertRejectsWholeRequestOnOneInvalidEmail() {
  await setDirectory()
  const records = { [DEFAULT_TENANT_ID]: { configVersion: 1 } }
  _setRedisClientForTests(() => fakeTenantConfigRedis(records))
  const res = await invoke({
    action: 'review-alert-recipients-upsert', method: 'POST', token: await ownerToken(),
    body: { recipients: ['valid@example.com', 'not-an-email'] },
  })
  assert(res.statusCode === 400, `expected 400 when any entry is malformed, got ${res.statusCode}`)
  assert(!records[DEFAULT_TENANT_ID].reviewAlertRecipients, 'a rejected request must never partially save the valid entries either -- clear feedback beats silent partial data loss')
}

async function testUpsertDedupesCaseInsensitively() {
  await setDirectory()
  setAuditClient(() => fakeAuditRedis())
  const records = { [DEFAULT_TENANT_ID]: { configVersion: 1 } }
  _setRedisClientForTests(() => fakeTenantConfigRedis(records))
  const res = await invoke({
    action: 'review-alert-recipients-upsert', method: 'POST', token: await ownerToken(),
    body: { recipients: ['Owner@Example.com', 'owner@example.com', ' manager@example.com '] },
  })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.recipients.length === 2, `expected duplicates removed (2 remaining), got ${JSON.stringify(res.body.recipients)}`)
  assert(res.body.recipients.includes('Owner@Example.com'), 'first-seen casing should be preserved')
  assert(res.body.recipients.includes('manager@example.com'), 'entries should be trimmed')
}

async function testUpsertRejectsMoreThanTenRecipients() {
  await setDirectory()
  _setRedisClientForTests(() => fakeTenantConfigRedis({ [DEFAULT_TENANT_ID]: { configVersion: 1 } }))
  const eleven = Array.from({ length: 11 }, (_, i) => `person${i}@example.com`)
  const res = await invoke({ action: 'review-alert-recipients-upsert', method: 'POST', token: await ownerToken(), body: { recipients: eleven } })
  assert(res.statusCode === 400, `expected 400 for more than 10 recipients, got ${res.statusCode}`)
}

async function testOwnerCanUpdate() {
  await setDirectory()
  setAuditClient(() => fakeAuditRedis())
  const records = { [DEFAULT_TENANT_ID]: { configVersion: 1 } }
  _setRedisClientForTests(() => fakeTenantConfigRedis(records))
  const res = await invoke({
    action: 'review-alert-recipients-upsert', method: 'POST', token: await ownerToken(),
    body: { recipients: ['owner@lta.example', 'manager@lta.example'] },
  })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(JSON.stringify(records[DEFAULT_TENANT_ID].reviewAlertRecipients) === JSON.stringify(['owner@lta.example', 'manager@lta.example']))
}

async function testUpsertOnlyEverTouchesTheCallersOwnTenant() {
  await setDirectory()
  await setupOtherTenantOwner()
  setAuditClient(() => fakeAuditRedis())
  const records = {
    [DEFAULT_TENANT_ID]: { configVersion: 1, reviewAlertRecipients: ['advertising@l3amigos.com'] },
    [OTHER_TENANT_ID]: { configVersion: 1 },
  }
  _setRedisClientForTests(() => fakeTenantConfigRedis(records))
  const res = await invoke({
    action: 'review-alert-recipients-upsert', method: 'POST', token: await otherTenantOwnerToken(),
    body: { recipients: ['owner@blueseafoodgrill.example'] },
  })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(JSON.stringify(records[OTHER_TENANT_ID].reviewAlertRecipients) === JSON.stringify(['owner@blueseafoodgrill.example']))
  assert(JSON.stringify(records[DEFAULT_TENANT_ID].reviewAlertRecipients) === JSON.stringify(['advertising@l3amigos.com']),
    "LTA's own recipient list must be completely untouched by another tenant's update")
}

async function testUpsertCanClearBackToEmpty() {
  await setDirectory()
  setAuditClient(() => fakeAuditRedis())
  const records = { [DEFAULT_TENANT_ID]: { configVersion: 1, reviewAlertRecipients: ['old@example.com'] } }
  _setRedisClientForTests(() => fakeTenantConfigRedis(records))
  const res = await invoke({ action: 'review-alert-recipients-upsert', method: 'POST', token: await ownerToken(), body: { recipients: [] } })
  assert(res.statusCode === 200)
  assert(Array.isArray(res.body.recipients) && res.body.recipients.length === 0, 'an empty array must clear the list, not be rejected')
}

async function testUpsertRejectsNonPostMethod() {
  await setDirectory()
  const res = await invoke({ action: 'review-alert-recipients-upsert', method: 'GET', token: await ownerToken() })
  assert(res.statusCode === 405, `expected 405 for GET, got ${res.statusCode}`)
}

// reviewContact and reviewAlertRecipients stay fully independent of each
// other -- setting one must never read, clear, or otherwise touch the
// other, since both live as separate fields on the same tenant_config
// record and are edited through separate settings actions.
async function testReviewAlertRecipientsIndependentOfReviewContact() {
  await setDirectory()
  setAuditClient(() => fakeAuditRedis())
  const records = {
    [DEFAULT_TENANT_ID]: { configVersion: 1, reviewContact: { email: 'public@lta.example', phone: '555-0100' } },
  }
  _setRedisClientForTests(() => fakeTenantConfigRedis(records))

  const res = await invoke({
    action: 'review-alert-recipients-upsert', method: 'POST', token: await ownerToken(),
    body: { recipients: ['internal-team@lta.example'] },
  })
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  assert(JSON.stringify(records[DEFAULT_TENANT_ID].reviewAlertRecipients) === JSON.stringify(['internal-team@lta.example']))
  assert(records[DEFAULT_TENANT_ID].reviewContact.email === 'public@lta.example',
    'updating reviewAlertRecipients must never touch the independent reviewContact field')
  assert(records[DEFAULT_TENANT_ID].reviewContact.phone === '555-0100')

  // And the reverse direction: updating review-contact must never touch
  // reviewAlertRecipients.
  const res2 = await invoke({
    action: 'review-contact-upsert', method: 'POST', token: await ownerToken(),
    body: { email: 'new-public@lta.example', phone: null },
  })
  assert(res2.statusCode === 200, `expected 200, got ${res2.statusCode}`)
  assert(JSON.stringify(records[DEFAULT_TENANT_ID].reviewAlertRecipients) === JSON.stringify(['internal-team@lta.example']),
    'updating reviewContact must never touch the independent reviewAlertRecipients field')
}

async function main() {
  await run('GET review-alert-recipients rejects an unauthenticated request with 401', testGetRejectsUnauthenticated)
  await run('GET review-alert-recipients rejects marketing (owner/admin only) with 403', testGetRejectsMarketing)
  await run('GET review-alert-recipients returns an empty list for an unconfigured tenant, never invents one', testGetReturnsEmptyWhenNoRecordExists)
  await run('GET review-alert-recipients returns the configured value', testGetReturnsTheConfiguredValue)
  await run('POST review-alert-recipients-upsert rejects an unauthenticated request with 401', testUpsertRejectsUnauthenticated)
  await run('POST review-alert-recipients-upsert rejects marketing (owner/admin only) with 403 -- a lower-privilege member cannot update', testUpsertRejectsMarketing)
  await run('POST review-alert-recipients-upsert rejects a non-array body with 400', testUpsertRejectsNonArrayBody)
  await run('POST review-alert-recipients-upsert rejects the WHOLE request with 400 when any entry is malformed', testUpsertRejectsWholeRequestOnOneInvalidEmail)
  await run('POST review-alert-recipients-upsert de-dupes case-insensitively, preserving first-seen casing', testUpsertDedupesCaseInsensitively)
  await run('POST review-alert-recipients-upsert rejects more than 10 recipients', testUpsertRejectsMoreThanTenRecipients)
  await run('Owner can update reviewAlertRecipients', testOwnerCanUpdate)
  await run("POST review-alert-recipients-upsert only ever touches the caller's own tenant, never another's", testUpsertOnlyEverTouchesTheCallersOwnTenant)
  await run('POST review-alert-recipients-upsert can clear the list back to empty', testUpsertCanClearBackToEmpty)
  await run('POST review-alert-recipients-upsert rejects a non-POST method with 405', testUpsertRejectsNonPostMethod)
  await run('reviewContact and reviewAlertRecipients stay fully independent of each other', testReviewAlertRecipientsIndependentOfReviewContact)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
