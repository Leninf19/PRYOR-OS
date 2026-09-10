// Multi-Tenant Google Integration Architecture Fix -- unit tests for
// dashboard/api/_lib/googleConnectionStore.js: the primary connection is a
// byte-for-byte pass-through to credentialStore.js (LTA's real, existing
// gbp_credentials:v1 record included -- this store must never require a
// migration or touch it), and a tenant may register genuine ADDITIONAL
// ("secondary") connections that coexist without any credential crossover,
// either between connections on the SAME tenant or between different
// tenants.
//
// Run directly: node tests/test_google_connection_store.js

process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'

import {
  PRIMARY_CONNECTION_ID, getConnection, listConnectionsMetadata,
  setSecondaryConnection, setSecondaryConnectionIfVersion, recordConnectionSyncOutcome,
  recordConnectionOAuthRefresh, deleteConnection, ConnectionVersionConflictError,
  GoogleConnectionStoreUnavailableError,
  _setRedisClientForTests as setConnStoreRedis, _resetRedisClientForTests as resetConnStoreRedis,
} from '../dashboard/api/_lib/googleConnectionStore.js'
import {
  setStoredCredential, GoogleHealth,
  _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis,
} from '../dashboard/api/_lib/credentialStore.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

const TENANT_B = 't_synthetic-google-connection-b'

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
    resetConnStoreRedis()
    resetCredentialRedis()
  }
}

// A single in-memory Redis stand-in shared by BOTH credentialStore.js (the
// primary connection's own get/set/eval on its legacy/v2 string key) and
// googleConnectionStore.js (hget/hset/hgetall/hdel/eval on the new
// per-tenant hash) -- exactly how the real app shares one Upstash instance
// across both modules.
function fakeRedis() {
  const strings = {}
  const hashes = {}
  return {
    get: async (key) => (key in strings ? strings[key] : null),
    set: async (key, value) => { strings[key] = value },
    del: async (key) => { delete strings[key] },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      // credentialStore.js's CAS script: [expectedVersionStr, nextJson] against a plain string key.
      if (args.length === 2) {
        const [expectedVersionStr, nextJson] = args
        const raw = strings[key] ?? null
        let currentVersion = '0'
        if (raw) {
          try { const d = JSON.parse(raw); if (d?.credentialVersion !== undefined) currentVersion = String(d.credentialVersion) } catch {}
        }
        if (currentVersion !== expectedVersionStr) return raw ?? false
        strings[key] = nextJson
        return true
      }
      // googleConnectionStore.js's CAS_SCRIPT_HASH: [field, expectedVersionStr, nextJson] against a hash field.
      const [field, expectedVersionStr, nextJson] = args
      const raw = hashes[key]?.[field] ?? null
      let currentVersion = '0'
      if (raw) {
        try { const d = JSON.parse(raw); if (d?.credentialVersion !== undefined) currentVersion = String(d.credentialVersion) } catch {}
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      hashes[key] ??= {}
      hashes[key][field] = nextJson
      return true
    },
    hget: async (key, field) => hashes[key]?.[field] ?? null,
    hset: async (key, fields) => { hashes[key] = { ...(hashes[key] ?? {}), ...fields } },
    hgetall: async (key) => ({ ...(hashes[key] ?? {}) }),
    hdel: async (key, field) => { if (hashes[key]) delete hashes[key][field] },
    _strings: strings, _hashes: hashes,
  }
}

function wire() {
  const client = fakeRedis()
  setConnStoreRedis(() => client)
  setCredentialRedis(() => client)
  return client
}

async function testPrimaryConnectionIsAPassThroughToCredentialStore() {
  wire()
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'lta-real-refresh-token', connectedAccountName: 'Los Tres Amigos Mexican Restaurant' })
  const primary = await getConnection(DEFAULT_TENANT_ID, PRIMARY_CONNECTION_ID)
  assert(primary.refreshToken === 'lta-real-refresh-token', 'the primary connection must round-trip the exact refresh token credentialStore.js stored')
  assert(primary.connectedAccountName === 'Los Tres Amigos Mexican Restaurant')
  assert(primary.connectionId === PRIMARY_CONNECTION_ID)
  assert(primary.tenantId === DEFAULT_TENANT_ID)
  assert(primary.provider === 'google_business_profile')
}

async function testPrimaryConnectionNeverTouchesTheLegacyKeyDirectlyFromThisFile() {
  const client = wire()
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'lta-real-refresh-token', connectedAccountName: 'LTA' })
  const before = client._strings['gbp_credentials:v1']
  await getConnection(DEFAULT_TENANT_ID, PRIMARY_CONNECTION_ID)
  const after = client._strings['gbp_credentials:v1']
  assert(before === after, 'reading the primary connection through googleConnectionStore.js must never rewrite LTA\'s real legacy record')
}

async function testSecondaryConnectionCoexistsWithPrimaryOnTheSameTenant() {
  wire()
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'primary-token', connectedAccountName: 'Primary Account' })
  await setSecondaryConnection(DEFAULT_TENANT_ID, 'second-brand', { refreshToken: 'secondary-token', connectedAccountName: 'Second Brand Account', connectedByUserId: 'usr_owner' })

  const primary = await getConnection(DEFAULT_TENANT_ID, PRIMARY_CONNECTION_ID)
  const secondary = await getConnection(DEFAULT_TENANT_ID, 'second-brand')
  assert(primary.refreshToken === 'primary-token', 'creating a second connection must never alter the primary connection\'s own token')
  assert(secondary.refreshToken === 'secondary-token')
  assert(secondary.connectedByUserId === 'usr_owner', 'connectedByUserId is recorded for audit')

  const listed = await listConnectionsMetadata(DEFAULT_TENANT_ID)
  assert(listed.length === 2, `expected 2 connections listed, got ${listed.length}`)
  assert(listed.every(c => c.refreshToken === undefined), 'listConnectionsMetadata must never include a refresh token')
  const ids = listed.map(c => c.connectionId).sort()
  assert(ids[0] === 'primary' && ids[1] === 'second-brand', `expected [primary, second-brand], got ${JSON.stringify(ids)}`)
}

async function testSecondaryConnectionsDoNotCrossOverBetweenTenants() {
  wire()
  await setSecondaryConnection(DEFAULT_TENANT_ID, 'branch-a', { refreshToken: 'lta-branch-a-token', connectedAccountName: 'LTA Branch A' })
  await setSecondaryConnection(TENANT_B, 'branch-a', { refreshToken: 'tenant-b-branch-a-token', connectedAccountName: 'Tenant B Branch A' })

  const ltaConn = await getConnection(DEFAULT_TENANT_ID, 'branch-a')
  const tenantBConn = await getConnection(TENANT_B, 'branch-a')
  assert(ltaConn.refreshToken === 'lta-branch-a-token', 'two tenants using the SAME connectionId must never read each other\'s token')
  assert(tenantBConn.refreshToken === 'tenant-b-branch-a-token')
  assert(ltaConn.refreshToken !== tenantBConn.refreshToken)
}

async function testPrimaryAndSecondaryNeverCrossOverEvenWithSharedNaming() {
  wire()
  await setStoredCredential(TENANT_B, { refreshToken: 'tenant-b-primary-token', connectedAccountName: 'Tenant B Primary' })
  await setSecondaryConnection(TENANT_B, 'other', { refreshToken: 'tenant-b-secondary-token', connectedAccountName: 'Tenant B Other' })

  const primary = await getConnection(TENANT_B, PRIMARY_CONNECTION_ID)
  const other = await getConnection(TENANT_B, 'other')
  assert(primary.refreshToken === 'tenant-b-primary-token')
  assert(other.refreshToken === 'tenant-b-secondary-token')
}

async function testSecondaryConnectionCasPreventsConcurrentOverwrite() {
  wire()
  await setSecondaryConnection(DEFAULT_TENANT_ID, 'branch-b', { refreshToken: 'first-token', connectedAccountName: 'Branch B' })
  const conn = await getConnection(DEFAULT_TENANT_ID, 'branch-b')
  let threw = null
  try {
    // Stale expectedVersion (0) after a real write already bumped it to 1.
    await setSecondaryConnectionIfVersion(DEFAULT_TENANT_ID, 'branch-b', { refreshToken: 'racer-token', connectedAccountName: 'Racer' }, 0)
  } catch (err) { threw = err }
  assert(threw instanceof ConnectionVersionConflictError, 'a stale expectedVersion must fail closed with ConnectionVersionConflictError')
  const stillFirst = await getConnection(DEFAULT_TENANT_ID, 'branch-b')
  assert(stillFirst.refreshToken === 'first-token', 'a rejected CAS write must never overwrite the winning record')
  assert(conn.credentialVersion === 1)
}

async function testRecordSyncOutcomeAndOAuthRefreshStayScopedToTheirOwnConnection() {
  wire()
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'primary-token', connectedAccountName: 'Primary' })
  await setSecondaryConnection(DEFAULT_TENANT_ID, 'branch-c', { refreshToken: 'branch-c-token', connectedAccountName: 'Branch C' })

  await recordConnectionSyncOutcome(DEFAULT_TENANT_ID, 'branch-c', { success: false, reason: 'unauthorized' })
  const branchC = await getConnection(DEFAULT_TENANT_ID, 'branch-c')
  const primary = await getConnection(DEFAULT_TENANT_ID, PRIMARY_CONNECTION_ID)
  assert(branchC.health === GoogleHealth.AUTH_FAILED, 'the failure must be recorded on the connection it actually happened for')
  assert(primary.health === GoogleHealth.CONNECTED, 'a failure on one connection must never affect a sibling connection\'s recorded health')

  await recordConnectionOAuthRefresh(DEFAULT_TENANT_ID, 'branch-c')
  const branchCAfterRefresh = await getConnection(DEFAULT_TENANT_ID, 'branch-c')
  assert(branchCAfterRefresh.lastOAuthRefreshAt !== branchC.lastOAuthRefreshAt || branchCAfterRefresh.credentialVersion > branchC.credentialVersion)
}

async function testDeletingASecondaryConnectionNeverAffectsThePrimaryOrSiblings() {
  wire()
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'primary-token', connectedAccountName: 'Primary' })
  await setSecondaryConnection(DEFAULT_TENANT_ID, 'branch-d', { refreshToken: 'branch-d-token', connectedAccountName: 'Branch D' })
  await setSecondaryConnection(DEFAULT_TENANT_ID, 'branch-e', { refreshToken: 'branch-e-token', connectedAccountName: 'Branch E' })

  await deleteConnection(DEFAULT_TENANT_ID, 'branch-d')
  assert((await getConnection(DEFAULT_TENANT_ID, 'branch-d')) === null)
  assert((await getConnection(DEFAULT_TENANT_ID, 'branch-e')).refreshToken === 'branch-e-token', 'deleting one connection must never remove a sibling')
  assert((await getConnection(DEFAULT_TENANT_ID, PRIMARY_CONNECTION_ID)).refreshToken === 'primary-token', 'deleting a secondary connection must never touch the primary')
}

async function testListConnectionsMetadataForATenantWithOnlyThePrimaryMatchesTodaysSingleConnectionBehavior() {
  wire()
  await setStoredCredential(DEFAULT_TENANT_ID, { refreshToken: 'lta-token', connectedAccountName: 'LTA' })
  const listed = await listConnectionsMetadata(DEFAULT_TENANT_ID)
  assert(listed.length === 1, 'a tenant that has never registered a second connection must list exactly one')
  assert(listed[0].connectionId === PRIMARY_CONNECTION_ID)
}

async function testListConnectionsMetadataForANeverConnectedTenantIsEmpty() {
  wire()
  const listed = await listConnectionsMetadata(TENANT_B)
  assert(Array.isArray(listed) && listed.length === 0)
}

async function testUnconfiguredStoreThrowsOnSecondaryOperations() {
  let threw = false
  try {
    await setSecondaryConnection(DEFAULT_TENANT_ID, 'branch-f', { refreshToken: 'x', connectedAccountName: null })
  } catch (err) {
    threw = err instanceof GoogleConnectionStoreUnavailableError
  }
  assert(threw, 'an unconfigured store must throw, never silently succeed')
}

async function testInvalidConnectionIdsFailClosed() {
  wire()
  let threw = false
  try {
    await setSecondaryConnection(DEFAULT_TENANT_ID, 'primary', { refreshToken: 'x', connectedAccountName: null })
  } catch (err) { threw = err instanceof TypeError }
  assert(threw, "'primary' is reserved -- a caller must not be able to register a secondary connection that collides with it")

  let threw2 = false
  try {
    await setSecondaryConnection(DEFAULT_TENANT_ID, 'has a space', { refreshToken: 'x', connectedAccountName: null })
  } catch (err) { threw2 = err instanceof TypeError }
  assert(threw2, 'a malformed connectionId must fail closed')
}

const tests = [
  ["the primary connection is a byte-for-byte pass-through to credentialStore.js (LTA's real record included)", testPrimaryConnectionIsAPassThroughToCredentialStore],
  ['reading the primary connection through this file never rewrites the legacy key', testPrimaryConnectionNeverTouchesTheLegacyKeyDirectlyFromThisFile],
  ['a secondary connection coexists with the primary on the same tenant without crossover', testSecondaryConnectionCoexistsWithPrimaryOnTheSameTenant],
  ['secondary connections with the same connectionId on two different tenants never cross over', testSecondaryConnectionsDoNotCrossOverBetweenTenants],
  ['a tenant\'s primary and secondary connections never cross over even with shared naming', testPrimaryAndSecondaryNeverCrossOverEvenWithSharedNaming],
  ['a secondary connection\'s CAS write prevents a stale concurrent overwrite', testSecondaryConnectionCasPreventsConcurrentOverwrite],
  ['recordConnectionSyncOutcome/recordConnectionOAuthRefresh stay scoped to their own connection, never a sibling', testRecordSyncOutcomeAndOAuthRefreshStayScopedToTheirOwnConnection],
  ['deleting a secondary connection never affects the primary or a sibling connection', testDeletingASecondaryConnectionNeverAffectsThePrimaryOrSiblings],
  ['listConnectionsMetadata for a single-connection tenant matches today\'s one-connection behavior', testListConnectionsMetadataForATenantWithOnlyThePrimaryMatchesTodaysSingleConnectionBehavior],
  ['listConnectionsMetadata for a never-connected tenant is an empty array, not an error', testListConnectionsMetadataForANeverConnectedTenantIsEmpty],
  ['an unconfigured store throws on secondary-connection operations', testUnconfiguredStoreThrowsOnSecondaryOperations],
  ["invalid/reserved connectionIds fail closed with a TypeError", testInvalidConnectionIdsFailClosed],
]

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
