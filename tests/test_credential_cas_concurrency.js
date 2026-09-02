// Multi-Tenant Phase 4I.2 (concurrency closure) -- deterministic,
// store-level proof of credentialStore.js's atomic credential CAS.
//
// The prior revision of google/[action].js's reconnect race guard was
// "read connectedAt -> compare in JS -> write" -- narrower than nothing,
// but still a genuine TOCTOU window: two concurrent reconnects can both
// observe the same "current" state and then both proceed to write,
// sequentially, letting the chronologically OLDER request win merely
// because its own external round trip happened to finish last. This file
// proves the FIX -- credentialVersion + a single atomic Redis EVAL
// (CREDENTIAL_CAS_SCRIPT, mirroring tenantConfigStore.js's own
// CAS_UPSERT_SCRIPT discipline exactly) -- directly against
// credentialStore.js's exported functions, with no HTTP layer involved
// (test_google_reconnect_reconciliation.js already proves the full OAuth
// callback wires this correctly end to end).
//
// No timing-dependent sleeps anywhere in this file: every "concurrent"
// scenario is produced by deterministically hooking a fake Redis client's
// own method (a plain synchronous JS function body is trivially atomic
// with respect to any other code in this single-threaded process) to
// perform the "other" operation's side effect at the exact point a real
// race would land, then asserting the one, deterministic, correct outcome.
//
// No real Upstash, no real Redis, no production data.
//
// Run directly: node tests/test_credential_cas_concurrency.js

process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'

import {
  getStoredCredential, setStoredCredential, setStoredCredentialIfVersion, recordOAuthRefresh, recordSyncOutcome,
  clearStoredCredential, CredentialVersionConflictError,
  _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis,
} from '../dashboard/api/_lib/credentialStore.js'
import { credentialKeyV2 } from '../dashboard/api/_lib/tenantKeys.js'

const TENANT_A = 't_synthetic-cas-tenant-a'
const TENANT_B = 't_synthetic-cas-tenant-b'

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
    resetCredentialRedis()
  }
}

// Key-respecting (multi-tenant) fake, faithfully emulating
// CREDENTIAL_CAS_SCRIPT's GET/compare-credentialVersion/SET logic exactly
// as the real Lua script would execute it -- a synchronous JS function
// body is trivially atomic with respect to any other code in this
// single-threaded test process.
function fakeCredentialRedis(initial = {}) {
  const store = { ...initial }
  return {
    get: async (key) => (key in store ? store[key] : null),
    set: async (key, value) => { store[key] = value },
    del: async (key) => { delete store[key] },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [expectedVersionStr, nextJson] = args
      const raw = key in store ? store[key] : null
      let currentVersion = '0'
      if (raw) {
        try {
          const decoded = JSON.parse(raw)
          if (decoded && decoded.credentialVersion !== undefined) currentVersion = String(decoded.credentialVersion)
        } catch { /* treat as version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = nextJson
      return true
    },
    _store: store,
  }
}

// ===========================================================================
// 1. Two reconnects start from the same version -- the loser's later CAS fails
// ===========================================================================

async function testOlderCandidateCannotOverwriteNewerAfterConcurrentCasWrites() {
  const client = fakeCredentialRedis()
  setCredentialRedis(() => client)
  await setStoredCredential(TENANT_A, { refreshToken: 'initial-token', connectedAccountName: 'Initial' })
  const before = await getStoredCredential(TENANT_A)
  assert(before.credentialVersion === 1, `sanity: expected version 1 after the first connect, got ${before.credentialVersion}`)

  // Candidate B reads version 1 and wins the race, installing first.
  const bResult = await setStoredCredentialIfVersion(TENANT_A, { refreshToken: 'candidate-b-token', connectedAccountName: 'B' }, 1)
  assert(bResult.credentialVersion === 2, `expected candidate B to become version 2, got ${bResult.credentialVersion}`)

  // Candidate A ALSO captured expectedVersion=1 (the same starting point B
  // started from, before either had written) -- its own CAS-write must now
  // fail, since the stored version has already moved on to 2.
  let threw = null
  try {
    await setStoredCredentialIfVersion(TENANT_A, { refreshToken: 'candidate-a-token', connectedAccountName: 'A' }, 1)
  } catch (e) {
    threw = e
  }
  assert(threw instanceof CredentialVersionConflictError, `expected CredentialVersionConflictError, got ${threw?.constructor?.name ?? 'no throw'}`)

  const final = await getStoredCredential(TENANT_A)
  assert(final.refreshToken === 'candidate-b-token', 'candidate B\'s credential must remain in effect -- candidate A must never overwrite it')
  assert(final.credentialVersion === 2, 'the version must remain at B\'s value -- A\'s rejected attempt must not itself advance it')
}

async function testConflictErrorCarriesCurrentRecordWithoutLeakingPlaintextToken() {
  const client = fakeCredentialRedis()
  setCredentialRedis(() => client)
  await setStoredCredential(TENANT_A, { refreshToken: 'super-secret-refresh-token', connectedAccountName: 'A' })
  let caught = null
  try {
    await setStoredCredentialIfVersion(TENANT_A, { refreshToken: 'attempted-replacement', connectedAccountName: 'X' }, 0) // wrong -- actual is 1
  } catch (e) {
    caught = e
  }
  assert(caught instanceof CredentialVersionConflictError, 'sanity: expected a version conflict')
  assert(caught.currentRecord && caught.currentRecord.credentialVersion === 1, 'the conflict error must carry the CURRENT stored record')
  assert(!('refreshToken' in caught.currentRecord), 'the conflict error\'s currentRecord must be the raw STORED (encrypted) shape, never a decrypted refreshToken field')
  assert(JSON.stringify(caught.currentRecord).includes('super-secret-refresh-token') === false, 'the plaintext refresh token must never appear anywhere in a conflict error')
}

// ===========================================================================
// 2. A stale token-refresh cannot overwrite a newer reconnect
// ===========================================================================

async function testStaleTokenRefreshCannotOverwriteNewerReconnect() {
  const client = fakeCredentialRedis()
  setCredentialRedis(() => client)
  await setStoredCredential(TENANT_A, { refreshToken: 'old-token', connectedAccountName: 'Old' }) // version 1

  // recordOAuthRefresh() reads the record, then (deterministically, via
  // this hook) a full reconnect completes in the gap before its own
  // CAS-write executes -- exactly the race the spec calls out: "a token
  // refresh based on Credential Version N must not overwrite a newly
  // reconnected Credential Version N+1 with old refresh-token state."
  let injected = false
  const originalGet = client.get.bind(client)
  client.get = async (key) => {
    const value = await originalGet(key)
    if (!injected) {
      injected = true
      await setStoredCredentialIfVersion(TENANT_A, { refreshToken: 'reconnected-token', connectedAccountName: 'Reconnected' }, 1)
    }
    return value
  }

  await recordOAuthRefresh(TENANT_A) // built on the now-STALE version-1 read

  const final = await getStoredCredential(TENANT_A)
  assert(final.refreshToken === 'reconnected-token', 'the newer, reconnected credential must remain in effect -- a stale refresh update must never revert it')
  assert(final.credentialVersion === 2, `expected the reconnect's version (2) to remain current, got ${final.credentialVersion}`)
}

async function testStaleSyncOutcomeCannotOverwriteNewerReconnect() {
  const client = fakeCredentialRedis()
  setCredentialRedis(() => client)
  await setStoredCredential(TENANT_A, { refreshToken: 'old-token', connectedAccountName: 'Old' }) // version 1

  let injected = false
  const originalGet = client.get.bind(client)
  client.get = async (key) => {
    const value = await originalGet(key)
    if (!injected) {
      injected = true
      await setStoredCredentialIfVersion(TENANT_A, { refreshToken: 'reconnected-token', connectedAccountName: 'Reconnected' }, 1)
    }
    return value
  }

  await recordSyncOutcome(TENANT_A, { success: false, reason: 'invalid_grant', errorDescription: 'Token has been expired or revoked' })

  const final = await getStoredCredential(TENANT_A)
  assert(final.refreshToken === 'reconnected-token', 'a stale sync-outcome update (computed from an old, already-superseded credential) must never revert a newer reconnect')
  assert(final.health === 'connected', 'the reconnected credential\'s own health must not be overwritten by the stale failure record either')
}

// ===========================================================================
// 3. Disconnect racing with reconnect -- explicit, deterministic behavior
// ===========================================================================

async function testDisconnectAfterCompletedReconnectAlwaysResultsInDisconnected() {
  const client = fakeCredentialRedis()
  setCredentialRedis(() => client)
  await setStoredCredential(TENANT_A, { refreshToken: 'v1', connectedAccountName: 'A' })
  await setStoredCredentialIfVersion(TENANT_A, { refreshToken: 'v2', connectedAccountName: 'A' }, 1)
  await clearStoredCredential(TENANT_A)
  const cred = await getStoredCredential(TENANT_A)
  assert(cred === null, 'Disconnect must always win outright against whatever credential currently exists, regardless of how recently a reconnect completed')
}

async function testReconnectCapturedBeforeADisconnectFailsClosedRatherThanReinstalling() {
  const client = fakeCredentialRedis()
  setCredentialRedis(() => client)
  await setStoredCredential(TENANT_A, { refreshToken: 'v1', connectedAccountName: 'A' })
  const capturedVersion = (await getStoredCredential(TENANT_A)).credentialVersion // 1, captured BEFORE the disconnect below

  await clearStoredCredential(TENANT_A) // a disconnect races in and completes first

  let threw = null
  try {
    await setStoredCredentialIfVersion(TENANT_A, { refreshToken: 'stale-reconnect-attempt', connectedAccountName: 'Stale' }, capturedVersion)
  } catch (e) {
    threw = e
  }
  assert(threw instanceof CredentialVersionConflictError, 'a reconnect whose captured version predates a concurrent disconnect must fail closed, never silently reinstall a credential the user just disconnected')
  const cred = await getStoredCredential(TENANT_A)
  assert(cred === null, 'the tenant must remain disconnected -- the rejected reconnect attempt must not resurrect any credential')
}

async function testFreshReconnectAfterDisconnectSucceedsNormally() {
  const client = fakeCredentialRedis()
  setCredentialRedis(() => client)
  await setStoredCredential(TENANT_A, { refreshToken: 'v1', connectedAccountName: 'A' })
  await clearStoredCredential(TENANT_A)

  // A FRESH attempt captures its expected version AFTER the disconnect
  // (i.e. observes "never connected", version 0) and must succeed exactly
  // like any genuine first-time connect.
  const freshExpectedVersion = (await getStoredCredential(TENANT_A))?.credentialVersion ?? 0
  assert(freshExpectedVersion === 0, 'sanity: a disconnected tenant reads back as version 0')
  const result = await setStoredCredentialIfVersion(TENANT_A, { refreshToken: 'fresh-after-disconnect', connectedAccountName: 'Fresh' }, 0)
  assert(result.credentialVersion === 1, `expected the fresh connect to become version 1, got ${result.credentialVersion}`)
  const cred = await getStoredCredential(TENANT_A)
  assert(cred.refreshToken === 'fresh-after-disconnect', 'the fresh connect must succeed and be indistinguishable from a genuine first-time connection')
}

// ===========================================================================
// 4. Cross-tenant isolation of credential versions
// ===========================================================================

async function testCrossTenantCredentialVersionsAreIsolated() {
  const client = fakeCredentialRedis()
  setCredentialRedis(() => client)
  await setStoredCredential(TENANT_A, { refreshToken: 'a-v1', connectedAccountName: 'A' })
  await setStoredCredentialIfVersion(TENANT_A, { refreshToken: 'a-v2', connectedAccountName: 'A' }, 1)
  await setStoredCredential(TENANT_B, { refreshToken: 'b-v1', connectedAccountName: 'B' })

  const credA = await getStoredCredential(TENANT_A)
  const credB = await getStoredCredential(TENANT_B)
  assert(credA.credentialVersion === 2 && credA.refreshToken === 'a-v2', 'sanity: Tenant A is at version 2')
  assert(credB.credentialVersion === 1 && credB.refreshToken === 'b-v1', 'sanity: Tenant B is at version 1, independent of Tenant A')

  // An operation against Tenant B using a version that would only be valid
  // for Tenant A must be evaluated purely against Tenant B's OWN state.
  let threw = false
  try {
    await setStoredCredentialIfVersion(TENANT_B, { refreshToken: 'wrong-tenant-version-attempt', connectedAccountName: 'X' }, 2)
  } catch (e) {
    threw = e instanceof CredentialVersionConflictError
  }
  assert(threw, 'Tenant B\'s version check must never be satisfied by a version that only happens to be correct for Tenant A')

  const credAAfter = await getStoredCredential(TENANT_A)
  const credBAfter = await getStoredCredential(TENANT_B)
  assert(credAAfter.credentialVersion === 2 && credAAfter.refreshToken === 'a-v2', 'Tenant A must be completely unaffected by any operation against Tenant B')
  assert(credBAfter.credentialVersion === 1 && credBAfter.refreshToken === 'b-v1', 'Tenant B\'s own state must be unaffected by its own rejected attempt')

  // Physical key separation, proven directly (both are CUTOVER-mode
  // synthetic tenants, so each gets its own v2 key -- never a shared one).
  assert(client._store[credentialKeyV2(TENANT_A)] !== client._store[credentialKeyV2(TENANT_B)], 'Tenant A and Tenant B must never share a physical credential key')
}

async function main() {
  console.log('--- Concurrent reconnect CAS writes ---')
  await run('an older candidate cannot overwrite a newer one after concurrent CAS writes', testOlderCandidateCannotOverwriteNewerAfterConcurrentCasWrites)
  await run('a conflict error carries the current record without leaking a plaintext token', testConflictErrorCarriesCurrentRecordWithoutLeakingPlaintextToken)

  console.log('\n--- Stale metadata updates cannot overwrite a newer reconnect ---')
  await run('a stale token refresh cannot overwrite a newer reconnect', testStaleTokenRefreshCannotOverwriteNewerReconnect)
  await run('a stale sync outcome cannot overwrite a newer reconnect', testStaleSyncOutcomeCannotOverwriteNewerReconnect)

  console.log('\n--- Disconnect vs. reconnect: explicit, deterministic behavior ---')
  await run('disconnect after a completed reconnect always results in disconnected', testDisconnectAfterCompletedReconnectAlwaysResultsInDisconnected)
  await run('a reconnect captured before a disconnect fails closed rather than reinstalling', testReconnectCapturedBeforeADisconnectFailsClosedRatherThanReinstalling)
  await run('a fresh reconnect after a disconnect succeeds normally', testFreshReconnectAfterDisconnectSucceedsNormally)

  console.log('\n--- Cross-tenant isolation ---')
  await run('cross-tenant credential versions remain completely isolated', testCrossTenantCredentialVersionsAreIsolated)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
