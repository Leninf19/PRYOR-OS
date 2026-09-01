// Regression tests for dashboard/api/_lib/userStore.js (the Redis-backed
// durable user directory) and dashboard/api/_lib/accountStore.js's dual-read
// precedence over it plus the static ACCOUNT_DIRECTORY_JSON -- Multi-
// Location Authentication & User Access System, Commit 1.
//
// Mirrors test_contact_store.js's fake-Redis-client-factory pattern; the one
// difference is userStore.js touches TWO Redis keys (the user hash and the
// email index), so the fake below routes by key instead of ignoring it.
//
// Run directly: node tests/test_user_store.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import {
  getUserById, getUserByEmail, listUsers, upsertUser, updateUser, touchLastLogin,
  deriveUserStatus, UserStoreUnavailableError,
  _setRedisClientForTests, _resetRedisClientForTests,
} from '../dashboard/api/_lib/userStore.js'
import { getAccountById, getAccountByEmail, listAccounts } from '../dashboard/api/_lib/accountStore.js'
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
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    delete process.env.ACCOUNT_DIRECTORY_JSON
  }
}

// Routes by key -- unlike contactStore.js's single-hash fake, userStore.js
// genuinely uses two independent hashes together (users:v1 and
// users_email_index:v1), so a single shared namespace would silently pass
// tests that a real two-key Redis would fail.
function fakeRedis(initial = {}) {
  const stores = {} // { [key]: { [field]: value } }
  function bucket(key) { return (stores[key] ??= { ...(initial[key] ?? {}) }) }
  return {
    hgetall: async (key) => ({ ...bucket(key) }),
    hget: async (key, field) => bucket(key)[field] ?? null,
    hset: async (key, fields) => { Object.assign(bucket(key), fields) },
    hdel: async (key, field) => {
      const b = bucket(key)
      if (!(field in b)) return 0
      delete b[field]
      return 1
    },
    _stores: stores,
  }
}

async function bcryptHash() {
  return bcrypt.hash('correct-horse-battery-staple', 12)
}

const BASE_USER = {
  userId: 'usr_lm_1', email: 'lm1@example.com', passwordHash: null,
  role: 'location_manager', locationIds: [3], sessionVersion: 1, disabled: false,
  displayName: 'Location Manager One', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null, invitedAt: '2026-01-01T00:00:00.000Z', passwordSetAt: null,
}

// --- userStore.js: basic CRUD -------------------------------------------

async function testUnconfiguredStoreThrows() {
  let threw = false
  try { await listUsers(DEFAULT_TENANT_ID) } catch (e) { threw = e instanceof UserStoreUnavailableError }
  assert(threw, 'listUsers(DEFAULT_TENANT_ID) must throw UserStoreUnavailableError when Redis is not configured')
}

async function testUpsertAndGetById() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client) // same instance every call -- getClient() has no caching for the test-factory path
  await upsertUser(DEFAULT_TENANT_ID, BASE_USER)
  const found = await getUserById(DEFAULT_TENANT_ID, 'usr_lm_1')
  assert(found && found.email === 'lm1@example.com', 'upserted user must be retrievable by id')
  assert(JSON.stringify(found.locationIds) === JSON.stringify([3]), 'locationIds must round-trip exactly')
}

async function testUpsertAndGetByEmailCaseInsensitive() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client) // same instance every call -- getClient() has no caching for the test-factory path
  await upsertUser(DEFAULT_TENANT_ID, { ...BASE_USER, email: 'Mixed.Case@Example.com' })
  const found = await getUserByEmail(DEFAULT_TENANT_ID, 'mixed.case@example.com')
  assert(found && found.userId === 'usr_lm_1', 'email lookup must be case/whitespace-insensitive, matching normalizeEmail()')
}

async function testUpsertRejectsInvalidRole() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client) // same instance every call -- getClient() has no caching for the test-factory path
  let threw = false
  try { await upsertUser(DEFAULT_TENANT_ID, { ...BASE_USER, role: 'superadmin' }) } catch { threw = true }
  assert(threw, 'upsertUser must reject an unknown role')
}

async function testUpsertRejectsInvalidLocationIds() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client) // same instance every call -- getClient() has no caching for the test-factory path
  let threw = false
  try { await upsertUser(DEFAULT_TENANT_ID, { ...BASE_USER, locationIds: [0, -1] }) } catch { threw = true }
  assert(threw, 'upsertUser must reject malformed locationIds (same rule as the static directory)')
}

async function testListUsersReturnsEveryRecord() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client) // same instance every call -- getClient() has no caching for the test-factory path
  await upsertUser(DEFAULT_TENANT_ID, BASE_USER)
  await upsertUser(DEFAULT_TENANT_ID, { ...BASE_USER, userId: 'usr_lm_2', email: 'lm2@example.com' })
  const all = await listUsers(DEFAULT_TENANT_ID)
  assert(all.length === 2, `expected 2 users, got ${all.length}`)
}

async function testUpdateUserPartialMergeAndTimestamp() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client) // same instance every call -- getClient() has no caching for the test-factory path
  await upsertUser(DEFAULT_TENANT_ID, BASE_USER)
  const updated = await updateUser(DEFAULT_TENANT_ID, 'usr_lm_1', { disabled: true })
  assert(updated.disabled === true, 'patched field must be applied')
  assert(updated.email === BASE_USER.email, 'unpatched fields must be preserved')
  assert(updated.updatedAt !== BASE_USER.updatedAt, 'updatedAt must be stamped on every update')
}

async function testUpdateUserReturnsNullForUnknownId() {
  const client = fakeRedis()
  _setRedisClientForTests(() => client) // same instance every call -- getClient() has no caching for the test-factory path
  const result = await updateUser(DEFAULT_TENANT_ID, 'usr_does_not_exist', { disabled: true })
  assert(result === null, 'updateUser on an unknown userId must return null, not throw or create a record')
}

async function testTouchLastLoginNeverThrows() {
  _setRedisClientForTests(() => ({ hget: async () => { throw new Error('ECONNREFUSED fake-outage') } }))
  const ok = await touchLastLogin(DEFAULT_TENANT_ID, 'usr_lm_1')
  assert(ok === false, 'touchLastLogin must swallow a Redis outage and report false, never throw')
}

async function testDeriveUserStatus() {
  assert(deriveUserStatus({ disabled: true, passwordSetAt: '2026-01-01T00:00:00.000Z' }) === 'disabled', 'disabled always wins regardless of passwordSetAt')
  assert(deriveUserStatus({ disabled: false, passwordSetAt: null }) === 'invited', 'no passwordSetAt yet -> invited')
  assert(deriveUserStatus({ disabled: false, passwordSetAt: '2026-01-01T00:00:00.000Z' }) === 'active', 'disabled false + passwordSetAt -> active')
  assert(deriveUserStatus({ disabled: false, passwordSetAt: null, inviteRevokedAt: '2026-01-01T00:00:00.000Z' }) === 'revoked', 'revoked invite (never activated) -> revoked')
  assert(deriveUserStatus({ disabled: false, passwordSetAt: null, inviteExpiresAt: '2000-01-01T00:00:00.000Z' }) === 'expired', 'past inviteExpiresAt, never activated -> expired')
  assert(deriveUserStatus({ disabled: false, passwordSetAt: '2026-01-01T00:00:00.000Z', inviteRevokedAt: '2026-01-01T00:00:00.000Z' }) === 'active', 'an activated account is active even if stale invite metadata lingers')
  // A static (ACCOUNT_DIRECTORY_JSON) account never has a passwordSetAt
  // FIELD at all -- its absence, not a null value, must mean active.
  assert(deriveUserStatus({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false }) === 'active', 'a static account with no passwordSetAt field at all must be treated as active, not invited')
}

// --- accountStore.js: dual-read precedence ------------------------------

function staticDirectoryJSON(accounts) {
  return JSON.stringify({ accounts })
}

async function testRedisAccountTakesPrecedenceOverStaticForSameEmail() {
  const hash = await bcryptHash()
  // Same normalized email in BOTH stores, different displayName, so the
  // precedence winner is unambiguous from the returned record alone.
  process.env.ACCOUNT_DIRECTORY_JSON = staticDirectoryJSON([
    { userId: 'usr_static', email: 'shared@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Static Copy' },
  ])
  const client = fakeRedis()
  _setRedisClientForTests(() => client) // same instance every call -- getClient() has no caching for the test-factory path
  await upsertUser(DEFAULT_TENANT_ID, { ...BASE_USER, userId: 'usr_redis', email: 'shared@example.com', displayName: 'Redis Copy', role: 'owner', locationIds: '*' })

  const byEmail = await getAccountByEmail('shared@example.com')
  assert(byEmail.displayName === 'Redis Copy', `Redis must win for getAccountByEmail on a shared identity, got ${byEmail?.displayName}`)

  const byId = await getAccountById('usr_redis')
  assert(byId.displayName === 'Redis Copy', 'the Redis-only userId must resolve from Redis')
  const staticById = await getAccountById('usr_static')
  assert(staticById.displayName === 'Static Copy', 'the static-only userId must still resolve from the static directory')
}

async function testStaticDirectoryUsedWhenRedisHasNoMatch() {
  const hash = await bcryptHash()
  process.env.ACCOUNT_DIRECTORY_JSON = staticDirectoryJSON([
    { userId: 'usr_static_only', email: 'staticonly@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Static Only' },
  ])
  const client = fakeRedis()
  _setRedisClientForTests(() => client) // same instance every call -- getClient() has no caching for the test-factory path
  const account = await getAccountByEmail('staticonly@example.com')
  assert(account && account.displayName === 'Static Only', 'an account that exists only in the static directory must still resolve')
}

async function testRedisOutageDuringAuthLookupDegradesToStaticOnly() {
  const hash = await bcryptHash()
  process.env.ACCOUNT_DIRECTORY_JSON = staticDirectoryJSON([
    { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' },
  ])
  _setRedisClientForTests(() => ({
    hget: async () => { throw new Error('ECONNREFUSED fake-upstash-outage') },
    hgetall: async () => { throw new Error('ECONNREFUSED fake-upstash-outage') },
  }))
  // This is the load-bearing production requirement: a Redis outage must
  // NEVER take down the existing Owner accounts.
  const account = await getAccountByEmail('owner@example.com')
  assert(account !== null && account.displayName === 'Owner', 'Owner login must keep working from the static directory even when Redis is completely unreachable')
}

async function testListAccountsMergesWithoutDuplicatingSharedIdentity() {
  const hash = await bcryptHash()
  process.env.ACCOUNT_DIRECTORY_JSON = staticDirectoryJSON([
    { userId: 'usr_static_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Static Owner Copy' },
    { userId: 'usr_static_only', email: 'staticonly@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Static Only' },
  ])
  const client = fakeRedis()
  _setRedisClientForTests(() => client) // same instance every call -- getClient() has no caching for the test-factory path
  // Same normalized email as the static owner above, but a DIFFERENT userId
  // and record -- simulates "this identity was promoted into Redis".
  await upsertUser(DEFAULT_TENANT_ID, { ...BASE_USER, userId: 'usr_redis_owner', email: 'owner@example.com', displayName: 'Redis Owner Copy', role: 'owner', locationIds: '*' })

  const all = await listAccounts()
  const ownerEmailMatches = all.filter(a => a.email.toLowerCase() === 'owner@example.com')
  assert(ownerEmailMatches.length === 1, `a shared identity must appear exactly once in listAccounts(), found ${ownerEmailMatches.length}`)
  assert(ownerEmailMatches[0].displayName === 'Redis Owner Copy', 'the single merged entry must be the Redis record, not the static one')
  assert(all.some(a => a.displayName === 'Static Only'), 'a static-only account must still be present in the merged listing')
  assert(all.length === 2, `expected exactly 2 accounts after de-duplication (1 shared + 1 static-only), got ${all.length}`)
}

async function main() {
  await run('unconfigured user store throws UserStoreUnavailableError', testUnconfiguredStoreThrows)
  await run('upsertUser + getUserById round-trip', testUpsertAndGetById)
  await run('getUserByEmail is case/whitespace-insensitive', testUpsertAndGetByEmailCaseInsensitive)
  await run('upsertUser rejects an unknown role', testUpsertRejectsInvalidRole)
  await run('upsertUser rejects malformed locationIds', testUpsertRejectsInvalidLocationIds)
  await run('listUsers returns every record', testListUsersReturnsEveryRecord)
  await run('updateUser partially merges and stamps updatedAt', testUpdateUserPartialMergeAndTimestamp)
  await run('updateUser on an unknown userId returns null', testUpdateUserReturnsNullForUnknownId)
  await run('touchLastLogin never throws, even on a Redis outage', testTouchLastLoginNeverThrows)
  await run('deriveUserStatus: disabled/invited/active', testDeriveUserStatus)

  await run('accountStore: Redis takes precedence over the static directory for a shared identity', testRedisAccountTakesPrecedenceOverStaticForSameEmail)
  await run('accountStore: static directory resolves an account that only exists there', testStaticDirectoryUsedWhenRedisHasNoMatch)
  await run('accountStore: a Redis outage during auth lookup degrades to static-only, never breaks Owner login', testRedisOutageDuringAuthLookupDegradesToStaticOnly)
  await run('accountStore: listAccounts merges without duplicating a shared identity (Redis wins)', testListAccountsMergesWithoutDuplicatingSharedIdentity)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
