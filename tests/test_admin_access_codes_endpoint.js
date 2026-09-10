// Multi-Tenant Phase 4Q.1 -- regression tests for
// dashboard/api/admin/[action].js (the isSuperAdmin-gated access-code
// management endpoint): the authorization boundary (real LTA non-owner
// roles, and a genuine OTHER tenant's own Owner, must all be rejected --
// only Los Tres Amigos's own Owner may pass), the raw-code-shown-exactly-
// once contract, revoke-then-redeem failing closed, and the audit-log
// forbidden-field scan (never the raw code).
//
// Mirrors test_tenant_ops_endpoint.js's own "Tenant B account lives in
// userStore.js's bootstrap hash, carrying its own tenantId field" pattern
// for constructing a genuine cross-tenant Owner account.
//
// Run directly: node tests/test_admin_access_codes_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/admin/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import { _setRedisClientForTests as setTenantConfigRedis, _resetRedisClientForTests as resetTenantConfigRedis } from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'
import { _setRedisClientForTests as setAccessCodeRedis, _resetRedisClientForTests as resetAccessCodeRedis, redeemAccessCode, AccessCodeInvalidError } from '../dashboard/api/_lib/accessCodeStore.js'
import { _setRedisClientForTests as setAuditRedis, _resetRedisClientForTests as resetAuditRedis } from '../dashboard/api/_lib/auditLog.js'

const TENANT_B = 't_synthetic-admin-endpoint-b'

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
    resetTenantConfigRedis()
    resetUserRedis()
    resetAccessCodeRedis()
    resetAuditRedis()
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

function wireTenantConfigRedis() {
  const store = {}
  setTenantConfigRedis(() => ({
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
  }))
}

function fakeUserRedis(users) {
  const store = { 'users:v1': { ...users } }
  return {
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hget: async (key, field) => store[key]?.[field] ?? null,
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
  }
}

function wireAccessCodeRedis() {
  const store = {}
  setAccessCodeRedis(() => ({
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    // Real Lua-mirrored eval, same as test_access_code_store.js -- needed
    // for the "revoke then redeem fails closed" test, which exercises the
    // real redeemAccessCode() against a code this endpoint revoked.
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [codeHash, tenantId, userId, nowIso] = args
      const raw = store[key]?.[codeHash]
      if (!raw) return false
      let code
      try { code = JSON.parse(raw) } catch { return false }
      if (code.status !== 'active') return false
      if (code.expiresAt && code.expiresAt < nowIso) return false
      if (code.redemptionCount >= code.maxRedemptions) return false
      code.redemptionCount += 1
      code.redemptions = code.redemptions || []
      code.redemptions.push({ tenantId, userId, redeemedAt: nowIso })
      store[key][codeHash] = JSON.stringify(code)
      return JSON.stringify(code)
    },
  }))
}

let auditEntries
function wireAuditRedis() {
  auditEntries = []
  const lists = {}
  setAuditRedis(() => ({
    lpush: async (key, value) => { (lists[key] ??= []).unshift(value); auditEntries.push(JSON.parse(value)) },
    ltrim: async () => {},
  }))
}

async function passwordHash() { return bcrypt.hash('x', 12) }

async function setDirectory() {
  const hash = await passwordHash()
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_lta_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'LTA Owner' },
      { userId: 'usr_lta_admin', email: 'admin@example.com', passwordHash: hash, role: 'admin', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'LTA Admin' },
    ],
  })
}

async function setTenantBOwner() {
  const hash = await passwordHash()
  const record = { userId: 'usr_tenantb_owner', email: 'ownerb@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId: TENANT_B }
  setUserRedis(() => fakeUserRedis({ usr_tenantb_owner: JSON.stringify(record) }))
}

const ltaOwnerToken = () => signSession({ userId: 'usr_lta_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
const ltaAdminToken = () => signSession({ userId: 'usr_lta_admin', email: 'admin@example.com', role: 'admin', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
const tenantBOwnerToken = () => signSession({ userId: 'usr_tenantb_owner', email: 'ownerb@example.com', role: 'owner', locationIds: '*', tenantId: TENANT_B, sessionVersion: 1 })

async function invoke(action, { method = 'POST', body = {}, token } = {}) {
  const req = {
    method, query: { action }, body,
    headers: token ? { cookie: `lta_session=${token}` } : {},
    socket: { remoteAddress: '127.0.0.1' },
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function testUnauthenticatedRejected() {
  wireTenantConfigRedis(); wireAccessCodeRedis(); wireAuditRedis()
  const res = await invoke('create-access-code', { body: { prefix: 'LTA-X', plan: 'core' } })
  assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`)
}

async function testLtaAdminRejected() {
  await setDirectory()
  wireTenantConfigRedis(); wireAccessCodeRedis(); wireAuditRedis()
  const res = await invoke('create-access-code', { token: await ltaAdminToken(), body: { prefix: 'LTA-X', plan: 'core' } })
  assert(res.statusCode === 403, `LTA's own Admin (not Owner) must still be rejected, got ${res.statusCode}`)
}

async function testTenantBOwnerRejected() {
  await setTenantBOwner()
  wireTenantConfigRedis(); wireAccessCodeRedis(); wireAuditRedis()
  const res = await invoke('create-access-code', { token: await tenantBOwnerToken(), body: { prefix: 'LTA-X', plan: 'core' } })
  assert(res.statusCode === 403, `a genuine OTHER tenant's own Owner must be rejected -- isSuperAdmin() requires Los Tres Amigos specifically, got ${res.statusCode}`)
}

async function testTenantBOwnerCannotListOrRevokeEither() {
  await setTenantBOwner()
  wireTenantConfigRedis(); wireAccessCodeRedis(); wireAuditRedis()
  const listRes = await invoke('list-access-codes', { method: 'GET', token: await tenantBOwnerToken() })
  assert(listRes.statusCode === 403)
  const revokeRes = await invoke('revoke-access-code', { token: await tenantBOwnerToken(), body: { codeHash: 'anything' } })
  assert(revokeRes.statusCode === 403)
}

async function testLtaOwnerCreateListRevokeFlow() {
  await setDirectory()
  wireTenantConfigRedis(); wireAccessCodeRedis(); wireAuditRedis()
  const token = await ltaOwnerToken()

  const createRes = await invoke('create-access-code', { token, body: { prefix: 'LTA-ENT', plan: 'enterprise', maxRedemptions: 3 } })
  assert(createRes.statusCode === 200, `expected 200, got ${createRes.statusCode}: ${JSON.stringify(createRes.body)}`)
  const { rawCode, code } = createRes.body
  assert(rawCode.startsWith('LTA-ENT-') && rawCode.length === 'LTA-ENT-'.length + 10, 'the create response must carry the raw code exactly once')
  assert(code.codeHash, 'the create response must also carry the persisted record (with its hash, never the raw code inside it)')
  assert(!('rawCode' in code), 'the persisted record object itself must never carry the raw code field')

  const listRes = await invoke('list-access-codes', { method: 'GET', token })
  assert(listRes.statusCode === 200)
  const serializedList = JSON.stringify(listRes.body)
  assert(!serializedList.includes(rawCode), 'the raw code must never appear in list-access-codes, at any nesting depth')
  assert(serializedList.includes(code.codeHash), 'the listing must still show the opaque codeHash')

  const revokeRes = await invoke('revoke-access-code', { token, body: { codeHash: code.codeHash } })
  assert(revokeRes.statusCode === 200)
  assert(revokeRes.body.code.status === 'revoked')

  // Cross-reference with accessCodeStore.js's own redemption path: a
  // revoked code must fail closed for every subsequent redemption attempt.
  let threw = null
  try {
    await redeemAccessCode({ rawCode, email: 'someone@example.com', tenantId: 't_x', userId: 'usr_x' })
  } catch (err) { threw = err }
  assert(threw instanceof AccessCodeInvalidError, 'a revoked code must fail closed on redemption, not just report status: revoked in the admin UI')
}

async function testCreateValidationErrors() {
  await setDirectory()
  wireTenantConfigRedis(); wireAccessCodeRedis(); wireAuditRedis()
  const token = await ltaOwnerToken()

  const badPlan = await invoke('create-access-code', { token, body: { prefix: 'LTA-X', plan: 'not-a-plan' } })
  assert(badPlan.statusCode === 400)

  const badPrefix = await invoke('create-access-code', { token, body: { prefix: 'lower case!', plan: 'core' } })
  assert(badPrefix.statusCode === 400)

  const bothDiscounts = await invoke('create-access-code', { token, body: { prefix: 'LTA-X', plan: 'core', discountPercent: 10, discountFixedCents: 500 } })
  assert(bothDiscounts.statusCode === 400)
}

async function testRevokeUnknownCodeReturns404() {
  await setDirectory()
  wireTenantConfigRedis(); wireAccessCodeRedis(); wireAuditRedis()
  const res = await invoke('revoke-access-code', { token: await ltaOwnerToken(), body: { codeHash: 'never-created' } })
  assert(res.statusCode === 404)
}

async function testAuditEntriesNeverCarryTheRawCode() {
  await setDirectory()
  wireTenantConfigRedis(); wireAccessCodeRedis(); wireAuditRedis()
  const token = await ltaOwnerToken()
  const createRes = await invoke('create-access-code', { token, body: { prefix: 'LTA-SEC', plan: 'core' } })
  const { rawCode, code } = createRes.body
  await invoke('revoke-access-code', { token, body: { codeHash: code.codeHash } })

  assert(auditEntries.length === 2, `expected exactly 2 audit entries (created + revoked), got ${auditEntries.length}`)
  const serialized = JSON.stringify(auditEntries)
  assert(!serialized.includes(rawCode), 'no audit entry may ever contain the raw access code, in any field')
  assert(auditEntries.some(e => e.action === 'access_code.created') && auditEntries.some(e => e.action === 'access_code.revoked'))
}

const tests = [
  ['unauthenticated request is rejected with 401', testUnauthenticatedRejected],
  ["LTA's own Admin (a real, high-privilege role for everything else) is still rejected -- isSuperAdmin() requires role owner", testLtaAdminRejected],
  ["a genuine OTHER tenant's own Owner is rejected -- isSuperAdmin() requires Los Tres Amigos specifically", testTenantBOwnerRejected],
  ['the other tenant Owner is rejected from list and revoke as well, not just create', testTenantBOwnerCannotListOrRevokeEither],
  ['LTA Owner create -> list -> revoke flow: raw code shown once, never in listing, revoked status reflected', testLtaOwnerCreateListRevokeFlow],
  ['create-access-code validation errors (bad plan, bad prefix, both discount types) all 400', testCreateValidationErrors],
  ['revoking an unknown codeHash returns 404', testRevokeUnknownCodeReturns404],
  ['audit log entries for create/revoke never carry the raw code', testAuditEntriesNeverCarryTheRawCode],
]

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
