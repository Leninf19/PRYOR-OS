// Dual-client Google Business Profile OAuth migration (PRYOR OS Google
// Cloud project migration, Phase 5) -- regression tests for:
//   - dashboard/api/google/_lib/googleOAuthClients.js (compatibility
//     bridge, client-key recognition, the GOOGLE_GBP_AUTH_CLIENT_KEY flag)
//   - dashboard/api/google/_lib/oauthState.js's clientKey claim
//   - dashboard/api/_lib/credentialStore.js's clientKey field
//   - dashboard/api/google/_lib/googleAuth.js's client selection
//   - dashboard/api/google/[action].js's auth()/callback() end to end
//
// No real Upstash account, no real Google credentials, no real network
// call anywhere in this file -- every Google HTTP call is mocked, every
// Redis client is a fake in-memory store (same fakeRedis/fakeHashRedis
// pattern as test_credential_store.js/test_google_reconnect_reconciliation.js).
//
// Run directly: node tests/test_google_oauth_dual_client.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'

import bcrypt from 'bcryptjs'
import googleHandler from '../dashboard/api/google/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { signOAuthState, verifyOAuthState } from '../dashboard/api/google/_lib/oauthState.js'
import {
  GoogleOAuthClientKey, resolveGoogleOAuthClientCredentials, resolveAuthClientKeyFromFlag,
  hasAnyGoogleOAuthClientConfigured, UnrecognizedClientKeyError, GoogleOAuthClientNotConfiguredError,
} from '../dashboard/api/google/_lib/googleOAuthClients.js'
import { exchangeRefreshToken, getAccessToken } from '../dashboard/api/google/_lib/googleAuth.js'
import {
  getStoredCredential, setStoredCredential, setStoredCredentialIfVersion, recordOAuthRefresh,
  _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis,
} from '../dashboard/api/_lib/credentialStore.js'
import {
  recordLocationApproval, getTenantConfig, upsertTenantConfig, markTenantProvisioned,
  _setRedisClientForTests as setConfigRedis, _resetRedisClientForTests as resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import { _setRedisClientForTests as setUserRedis, _resetRedisClientForTests as resetUserRedis } from '../dashboard/api/_lib/userStore.js'
import { _setRedisClientForTests as setAuditRedis, _resetRedisClientForTests as resetAuditRedis } from '../dashboard/api/_lib/auditLog.js'

const STATE_COOKIE = 'gbp_oauth_state'
const TENANT = 't_synthetic-dual-client-tenant'

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
    delete process.env.GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_SECRET
    delete process.env.GOOGLE_CLIENT_ID_LEGACY
    delete process.env.GOOGLE_CLIENT_SECRET_LEGACY
    delete process.env.GOOGLE_CLIENT_ID_PRYOR
    delete process.env.GOOGLE_CLIENT_SECRET_PRYOR
    delete process.env.GOOGLE_GBP_AUTH_CLIENT_KEY
    resetCredentialRedis()
    resetConfigRedis()
    resetUserRedis()
    resetAuditRedis()
    delete globalThis.fetch
  }
}

// ===========================================================================
// Compatibility bridge (legacy client resolution)
// ===========================================================================

async function testLegacySuffixedPairPresentIsUsed() {
  process.env.GOOGLE_CLIENT_ID_LEGACY = 'suffixed-id'
  process.env.GOOGLE_CLIENT_SECRET_LEGACY = 'suffixed-secret'
  process.env.GOOGLE_CLIENT_ID = 'bare-id'
  process.env.GOOGLE_CLIENT_SECRET = 'bare-secret'
  const { clientId, clientSecret } = resolveGoogleOAuthClientCredentials(GoogleOAuthClientKey.LEGACY)
  assert(clientId === 'suffixed-id' && clientSecret === 'suffixed-secret', 'the suffixed pair must win when fully present, never the bare pair')
}

async function testLegacySuffixedAbsentBareFallbackUsed() {
  process.env.GOOGLE_CLIENT_ID = 'bare-id'
  process.env.GOOGLE_CLIENT_SECRET = 'bare-secret'
  const { clientId, clientSecret } = resolveGoogleOAuthClientCredentials(GoogleOAuthClientKey.LEGACY)
  assert(clientId === 'bare-id' && clientSecret === 'bare-secret', 'the bare pair must be used when neither suffixed var is set')
}

async function testLegacyPartialSuffixedFailsClosed() {
  process.env.GOOGLE_CLIENT_ID_LEGACY = 'suffixed-id'
  // GOOGLE_CLIENT_SECRET_LEGACY deliberately absent
  process.env.GOOGLE_CLIENT_ID = 'bare-id'
  process.env.GOOGLE_CLIENT_SECRET = 'bare-secret'
  let threw = false
  try { resolveGoogleOAuthClientCredentials(GoogleOAuthClientKey.LEGACY) } catch (e) { threw = e instanceof GoogleOAuthClientNotConfiguredError }
  assert(threw, 'exactly one suffixed var present must fail closed, never complete the pair from the bare fallback')
}

async function testLegacyPartialBareFailsClosed() {
  process.env.GOOGLE_CLIENT_ID = 'bare-id'
  // GOOGLE_CLIENT_SECRET deliberately absent, no suffixed pair either
  let threw = false
  try { resolveGoogleOAuthClientCredentials(GoogleOAuthClientKey.LEGACY) } catch (e) { threw = e instanceof GoogleOAuthClientNotConfiguredError }
  assert(threw, 'a partial bare fallback pair (suffixed pair absent too) must fail closed')
}

async function testLegacyNeitherPairConfiguredFailsClosed() {
  let threw = false
  try { resolveGoogleOAuthClientCredentials(GoogleOAuthClientKey.LEGACY) } catch (e) { threw = e instanceof GoogleOAuthClientNotConfiguredError }
  assert(threw, 'no configuration at all must fail closed')
}

async function testPryorRequiresBothVars() {
  process.env.GOOGLE_CLIENT_ID_PRYOR = 'pryor-id'
  // GOOGLE_CLIENT_SECRET_PRYOR deliberately absent
  let threw = false
  try { resolveGoogleOAuthClientCredentials(GoogleOAuthClientKey.PRYOR) } catch (e) { threw = e instanceof GoogleOAuthClientNotConfiguredError }
  assert(threw, 'PRYOR resolution requires both GOOGLE_CLIENT_ID_PRYOR and GOOGLE_CLIENT_SECRET_PRYOR')
}

async function testPryorNeverReadsBareVars() {
  process.env.GOOGLE_CLIENT_ID = 'bare-id'
  process.env.GOOGLE_CLIENT_SECRET = 'bare-secret'
  // No PRYOR-suffixed vars at all -- the bare pair must NEVER be used for pryor-2026.
  let threw = false
  try { resolveGoogleOAuthClientCredentials(GoogleOAuthClientKey.PRYOR) } catch (e) { threw = e instanceof GoogleOAuthClientNotConfiguredError }
  assert(threw, 'the bare GOOGLE_CLIENT_ID/SECRET must never be used to resolve a pryor-2026 credential')
}

async function testPryorFullPairResolves() {
  process.env.GOOGLE_CLIENT_ID_PRYOR = 'pryor-id'
  process.env.GOOGLE_CLIENT_SECRET_PRYOR = 'pryor-secret'
  const { clientId, clientSecret } = resolveGoogleOAuthClientCredentials(GoogleOAuthClientKey.PRYOR)
  assert(clientId === 'pryor-id' && clientSecret === 'pryor-secret', 'a full PRYOR pair must resolve correctly')
}

async function testHasAnyGoogleOAuthClientConfigured() {
  assert(hasAnyGoogleOAuthClientConfigured() === false, 'with nothing configured, the coarse check must be false')
  process.env.GOOGLE_CLIENT_ID = 'bare-id'
  process.env.GOOGLE_CLIENT_SECRET = 'bare-secret'
  assert(hasAnyGoogleOAuthClientConfigured() === true, 'the bare legacy fallback pair alone must satisfy the coarse check')
}

// ===========================================================================
// Client-key recognition
// ===========================================================================

async function testUnrecognizedClientKeysFailClosed() {
  for (const bad of ['', '  ', 'Legacy-LTA', 'PRYOR-2026', 'pryor', 'legacy', 'garbage', null, undefined]) {
    let threw = false
    let message = ''
    try { resolveGoogleOAuthClientCredentials(bad) } catch (e) { threw = e instanceof UnrecognizedClientKeyError; message = e.message }
    assert(threw, `clientKey ${JSON.stringify(bad)} must fail closed, never be coerced to legacy`)
    // Only meaningful for non-trivial raw values -- every string "includes"
    // '' by definition, so that case would trivially (and incorrectly) fail.
    if (bad) assert(!message.includes(String(bad)), `the rejected raw value must never appear in the error message (got: ${message})`)
  }
}

// ===========================================================================
// Feature flag
// ===========================================================================

async function testAuthFlagAbsentDefaultsLegacy() {
  assert(resolveAuthClientKeyFromFlag() === GoogleOAuthClientKey.LEGACY, 'an unset flag must default to legacy-lta')
}

async function testAuthFlagExplicitLegacy() {
  process.env.GOOGLE_GBP_AUTH_CLIENT_KEY = 'legacy-lta'
  assert(resolveAuthClientKeyFromFlag() === GoogleOAuthClientKey.LEGACY, 'explicit legacy-lta must resolve to legacy')
}

async function testAuthFlagExplicitPryor() {
  process.env.GOOGLE_GBP_AUTH_CLIENT_KEY = 'pryor-2026'
  assert(resolveAuthClientKeyFromFlag() === GoogleOAuthClientKey.PRYOR, 'explicit pryor-2026 must resolve to pryor')
}

async function testAuthFlagInvalidFailsClosed() {
  process.env.GOOGLE_GBP_AUTH_CLIENT_KEY = 'something-else'
  let threw = false
  try { resolveAuthClientKeyFromFlag() } catch (e) { threw = e instanceof UnrecognizedClientKeyError }
  assert(threw, 'an invalid flag value must fail closed, never silently default to legacy')
}

// ===========================================================================
// OAuth state clientKey claim
// ===========================================================================

async function testSignedLegacyStateWithoutClientKey() {
  const state = await signOAuthState({ nonce: 'n1', tenantId: TENANT, userId: 'u1' })
  const decoded = await verifyOAuthState(state)
  assert(decoded.clientKey === GoogleOAuthClientKey.LEGACY, 'a state signed without clientKey must verify as legacy-lta')
}

async function testSignedPryorState() {
  const state = await signOAuthState({ nonce: 'n2', tenantId: TENANT, userId: 'u1', clientKey: GoogleOAuthClientKey.PRYOR })
  const decoded = await verifyOAuthState(state)
  assert(decoded.clientKey === GoogleOAuthClientKey.PRYOR, 'a state signed with clientKey=pryor-2026 must verify as pryor-2026')
}

async function testTamperedClientKeyRejected() {
  const state = await signOAuthState({ nonce: 'n3', tenantId: TENANT, userId: 'u1', clientKey: GoogleOAuthClientKey.LEGACY })
  const [headerB64, payloadB64, sigB64] = state.split('.')
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  payload.clientKey = GoogleOAuthClientKey.PRYOR // forge the claim
  const tampered = `${headerB64}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sigB64}`
  const decoded = await verifyOAuthState(tampered)
  assert(decoded === null, 'a state with a forged clientKey must fail signature verification entirely, not just be ignored')
}

async function testExpiredStateRejected() {
  const state = await signOAuthState({ nonce: 'n4', tenantId: TENANT, userId: 'u1', clientKey: GoogleOAuthClientKey.PRYOR }, { expiresInSeconds: -1 })
  const decoded = await verifyOAuthState(state)
  assert(decoded === null, 'an expired state must be rejected regardless of clientKey')
}

// ===========================================================================
// credentialStore.js clientKey persistence
// ===========================================================================

async function testHistoricalRecordMissingClientKeyReadsLegacy() {
  const store = {}
  setCredentialRedis(() => ({
    get: async (key) => (key in store ? store[key] : null),
    set: async (key, value) => { store[key] = value },
    del: async (key) => { delete store[key] },
    eval: async (_s, keys, args) => { store[keys[0]] = args[1]; return true },
  }))
  // Simulate a pre-migration record: no clientKey field at all.
  store['gbp_credentials:v2:t_synthetic-dual-client-tenant'] = JSON.stringify({
    refreshTokenCiphertext: 'x', refreshTokenIv: 'y', refreshTokenAuthTag: 'z',
    connectedAccountName: null, connectedAt: '2026-01-01T00:00:00.000Z', credentialVersion: 3, health: 'connected',
  })
  const cred = await getStoredCredential(TENANT)
  assert(cred.clientKey === GoogleOAuthClientKey.LEGACY, 'a historical record with no clientKey field must read as legacy-lta without any backfill write')
}

async function testSuccessfulPromotionWritesProvenanceAndIncrementsVersion() {
  const client = fakeKeyValueRedis()
  setCredentialRedis(() => client)
  await setStoredCredential(TENANT, { refreshToken: 'rt-1', connectedAccountName: 'Acme', clientKey: GoogleOAuthClientKey.LEGACY })
  const before = await getStoredCredential(TENANT)
  assert(before.clientKey === GoogleOAuthClientKey.LEGACY && before.credentialVersion === 1)

  await setStoredCredentialIfVersion(TENANT, { refreshToken: 'rt-2', connectedAccountName: 'Acme', clientKey: GoogleOAuthClientKey.PRYOR }, before.credentialVersion)
  const after = await getStoredCredential(TENANT)
  assert(after.clientKey === GoogleOAuthClientKey.PRYOR, 'promotion must write the new clientKey')
  assert(after.credentialVersion === before.credentialVersion + 1, 'promotion must increment credentialVersion correctly')
  assert(after.refreshToken === 'rt-2', 'promotion must replace the refresh token')
}

async function testReadModifyWritePreservesClientKey() {
  const client = fakeKeyValueRedis()
  setCredentialRedis(() => client)
  await setStoredCredential(TENANT, { refreshToken: 'rt-1', connectedAccountName: null, clientKey: GoogleOAuthClientKey.PRYOR })
  await recordOAuthRefresh(TENANT)
  const after = await getStoredCredential(TENANT)
  assert(after.clientKey === GoogleOAuthClientKey.PRYOR, 'recordOAuthRefresh (a read-modify-CAS-write) must preserve clientKey unchanged')
}

function fakeKeyValueRedis() {
  const store = {}
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
        try { const decoded = JSON.parse(raw); if (decoded?.credentialVersion !== undefined) currentVersion = String(decoded.credentialVersion) } catch { /* treat as 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = nextJson
      return true
    },
  }
}

// ===========================================================================
// googleAuth.js client selection
// ===========================================================================

async function testNodeRefreshSelectsOnlyLegacyPair() {
  process.env.GOOGLE_CLIENT_ID_LEGACY = 'legacy-id'
  process.env.GOOGLE_CLIENT_SECRET_LEGACY = 'legacy-secret'
  process.env.GOOGLE_CLIENT_ID_PRYOR = 'pryor-id'
  process.env.GOOGLE_CLIENT_SECRET_PRYOR = 'pryor-secret'
  let seenBody = null
  globalThis.fetch = async (_url, opts) => { seenBody = JSON.parse(opts.body); return { json: async () => ({ access_token: 'a', expires_in: 3600 }) } }
  await exchangeRefreshToken('some-refresh-token', GoogleOAuthClientKey.LEGACY)
  assert(seenBody.client_id === 'legacy-id' && seenBody.client_secret === 'legacy-secret', 'a legacy-lta credential must refresh using ONLY the legacy pair')
}

async function testNodeRefreshSelectsOnlyPryorPair() {
  process.env.GOOGLE_CLIENT_ID_LEGACY = 'legacy-id'
  process.env.GOOGLE_CLIENT_SECRET_LEGACY = 'legacy-secret'
  process.env.GOOGLE_CLIENT_ID_PRYOR = 'pryor-id'
  process.env.GOOGLE_CLIENT_SECRET_PRYOR = 'pryor-secret'
  let seenBody = null
  globalThis.fetch = async (_url, opts) => { seenBody = JSON.parse(opts.body); return { json: async () => ({ access_token: 'a', expires_in: 3600 }) } }
  await exchangeRefreshToken('some-refresh-token', GoogleOAuthClientKey.PRYOR)
  assert(seenBody.client_id === 'pryor-id' && seenBody.client_secret === 'pryor-secret', 'a pryor-2026 credential must refresh using ONLY the PRYOR pair')
}

async function testNodeRefreshUnrecognizedClientKeyNeverCallsFetch() {
  let fetchCalled = false
  globalThis.fetch = async () => { fetchCalled = true; return { json: async () => ({}) } }
  let threw = false
  try { await getAccessToken('rt', 'not-a-real-key') } catch (e) { threw = e instanceof UnrecognizedClientKeyError }
  assert(threw, 'an unrecognized clientKey must throw before any network call')
  assert(!fetchCalled, 'no fetch may occur when the clientKey cannot be resolved')
}

// ===========================================================================
// auth()/callback() end to end
// ===========================================================================

function fakeHashRedis() {
  const store = {}
  return {
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [field, expectedVersionStr, nextJson] = args
      const raw = store[key]?.[field] ?? null
      let currentVersion = '0'
      if (raw) { try { const decoded = JSON.parse(raw); if (decoded?.configVersion !== undefined) currentVersion = String(decoded.configVersion) } catch { /* 0 */ } }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
  }
}
function fakeUserRedis() {
  const store = { 'users:v1': {} }
  return {
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hget: async (key, field) => store[key]?.[field] ?? null,
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
  }
}
function fakeListRedis() {
  const store = {}
  return {
    lrange: async (key, start, end) => { const l = Array.isArray(store[key]) ? store[key] : []; return end === -1 ? l.slice(start) : l.slice(start, end + 1) },
    lpush: async (key, val) => { store[key] = [val, ...(Array.isArray(store[key]) ? store[key] : [])]; return store[key].length },
    ltrim: async () => 'OK',
  }
}
function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.send = (str) => { res.body = str; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value; return res }
  res.getHeader = (name) => res.headers[name]
  return res
}

let sharedUserClient = null
function wireSharedStores() {
  // Each client must be constructed ONCE and the factory must return that
  // SAME instance every time -- a factory that constructs a new store
  // inline hands back an empty store on every getClient() call, silently
  // discarding whatever a prior write wrote.
  const configClient = fakeHashRedis()
  setConfigRedis(() => configClient)
  const credentialClient = fakeKeyValueRedis()
  setCredentialRedis(() => credentialClient)
  const auditClient = fakeListRedis()
  setAuditRedis(() => auditClient)
  sharedUserClient = fakeUserRedis()
  setUserRedis(() => sharedUserClient)
}

let hashCache = null
async function passwordHash() { if (!hashCache) hashCache = await bcrypt.hash('x', 12); return hashCache }
async function setupOwner(tenantId, userId = 'usr_owner') {
  const hash = await passwordHash()
  await sharedUserClient.hset('users:v1', { [userId]: JSON.stringify({ userId, email: `${userId}@example.com`, passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, tenantId }) })
}
async function commitTenant(tenantId, googleLocationIds) {
  if (!(await getTenantConfig(tenantId))) await upsertTenantConfig(tenantId, {}, { allowCreate: true, creationSource: 'migration' })
  await recordLocationApproval(tenantId, googleLocationIds.map((id, i) => ({ googleLocationId: id, title: `Location ${i + 1}`, address: '' })))
  const approvedConfig = await getTenantConfig(tenantId)
  await markTenantProvisioned(tenantId, { reviewDbBlobKey: `tenant-data/${tenantId}/reviews.db`, privateDataPrefix: `tenant-data/${tenantId}/private-data/`, provisionedLocationIds: approvedConfig.approvedLocations.map(l => l.locationId) })
  await upsertTenantConfig(tenantId, { status: 'active' })
  return getTenantConfig(tenantId)
}

function mockGoogleFetch(locationsByAccountName, { refreshToken = 'fake-refresh-token', accountsOk = true, scope } = {}) {
  return async (url) => {
    const u = String(url)
    if (u.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'fake-access-token', refresh_token: refreshToken, expires_in: 3600, ...(scope ? { scope } : {}) }) }
    }
    if (u.includes('mybusinessaccountmanagement.googleapis.com') && u.includes('/accounts')) {
      if (!accountsOk) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ accounts: Object.keys(locationsByAccountName).map(name => ({ name, accountName: name })) }) }
    }
    const acctMatch = Object.keys(locationsByAccountName).find(name => u.includes(`${name}/locations`))
    if (acctMatch) return { ok: true, status: 200, json: async () => ({ locations: locationsByAccountName[acctMatch] }) }
    throw new Error(`unexpected fetch in test: ${u}`)
  }
}

async function connectViaCallback(tenantId, { clientKey, userId = 'usr_owner' } = {}) {
  const token = await signSession({ userId, email: `${userId}@example.com`, role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
  const state = await signOAuthState({ nonce: `nonce-${Math.random()}`, tenantId, userId, ...(clientKey ? { clientKey } : {}) })
  const req = { method: 'GET', query: { code: 'fake-auth-code', state, action: 'callback' }, body: {}, headers: { cookie: `${SESSION_COOKIE}=${token}; ${STATE_COOKIE}=${state}` } }
  const res = fakeRes()
  await googleHandler(req, res)
  return res
}

async function testSuccessfulPryorPromotionEndToEnd() {
  process.env.GOOGLE_CLIENT_ID_PRYOR = 'pryor-id'
  process.env.GOOGLE_CLIENT_SECRET_PRYOR = 'pryor-secret'
  wireSharedStores()
  await setupOwner(TENANT)
  await commitTenant(TENANT, ['accounts/1/locations/A'])
  await setStoredCredential(TENANT, { refreshToken: 'old-token', connectedAccountName: 'Old Account', clientKey: GoogleOAuthClientKey.LEGACY })
  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A', title: 'A' }] }, { refreshToken: 'new-pryor-token' })

  const res = await connectViaCallback(TENANT, { clientKey: GoogleOAuthClientKey.PRYOR })
  assert(res.statusCode === null || res.statusCode === 200, `expected success, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  const stored = await getStoredCredential(TENANT)
  assert(stored.clientKey === GoogleOAuthClientKey.PRYOR, 'a PRYOR-state callback must store clientKey=pryor-2026')
  assert(stored.refreshToken === 'new-pryor-token', 'the new token must be stored')
}

async function testInFlightLegacyStateExchangesWithLegacyClient() {
  process.env.GOOGLE_CLIENT_ID = 'bare-legacy-id' // compatibility bridge: bare fallback
  process.env.GOOGLE_CLIENT_SECRET = 'bare-legacy-secret'
  wireSharedStores()
  await setupOwner(TENANT)
  await commitTenant(TENANT, ['accounts/1/locations/A'])
  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A', title: 'A' }] }, { refreshToken: 'legacy-token' })

  // No clientKey passed -- models a state signed by pre-deploy code.
  const res = await connectViaCallback(TENANT)
  assert(res.statusCode === null || res.statusCode === 200, `expected success, got ${res.statusCode} ${JSON.stringify(res.body)}`)
  const stored = await getStoredCredential(TENANT)
  assert(stored.clientKey === GoogleOAuthClientKey.LEGACY, 'an in-flight legacy state (no clientKey claim) must be exchanged with the legacy client and stored as legacy-lta')
}

async function testAccountsListHardFailurePreservesOldRecordByteForByte() {
  process.env.GOOGLE_CLIENT_ID_PRYOR = 'pryor-id'
  process.env.GOOGLE_CLIENT_SECRET_PRYOR = 'pryor-secret'
  wireSharedStores()
  await setupOwner(TENANT)
  await upsertTenantConfig(TENANT, {}, { allowCreate: true, creationSource: 'migration' }) // pre-commit tenant (no approved locations)
  await setStoredCredential(TENANT, { refreshToken: 'old-token', connectedAccountName: 'Old Account', clientKey: GoogleOAuthClientKey.LEGACY })
  const before = await getStoredCredential(TENANT)

  globalThis.fetch = mockGoogleFetch({}, { accountsOk: false })
  const res = await connectViaCallback(TENANT, { clientKey: GoogleOAuthClientKey.PRYOR })
  assert(res.statusCode === 502, `an accounts.list failure must abort promotion with a 502, got ${res.statusCode}`)

  const after = await getStoredCredential(TENANT)
  assert(JSON.stringify(after) === JSON.stringify(before), 'the previous record must be byte-for-byte unchanged when accounts.list validation fails')
}

async function testUnexpectedScopeRejectsCandidate() {
  process.env.GOOGLE_CLIENT_ID_PRYOR = 'pryor-id'
  process.env.GOOGLE_CLIENT_SECRET_PRYOR = 'pryor-secret'
  wireSharedStores()
  await setupOwner(TENANT)
  await upsertTenantConfig(TENANT, {}, { allowCreate: true, creationSource: 'migration' })
  await setStoredCredential(TENANT, { refreshToken: 'old-token', connectedAccountName: 'Old Account', clientKey: GoogleOAuthClientKey.LEGACY })
  const before = await getStoredCredential(TENANT)

  globalThis.fetch = mockGoogleFetch({ 'accounts/1': [{ name: 'locations/A', title: 'A' }] }, { scope: 'https://www.googleapis.com/auth/plus.me' })
  const res = await connectViaCallback(TENANT, { clientKey: GoogleOAuthClientKey.PRYOR })
  assert(res.statusCode === 400, `an unexpected granted scope must reject the candidate with 400, got ${res.statusCode}`)
  const after = await getStoredCredential(TENANT)
  assert(after.refreshToken === before.refreshToken, 'the previous credential must remain in effect when the granted scope is wrong')
}

async function testMissingPryorClientConfigFailsClosedAtCallback() {
  // GOOGLE_GBP_AUTH_CLIENT_KEY not set at auth()-time in this test -- we
  // directly model a PRYOR-provenance state (as if auth() had signed it)
  // arriving at callback() while GOOGLE_CLIENT_ID_PRYOR/SECRET_PRYOR are
  // NOT configured -- exactly the "missing client-specific env vars" case.
  wireSharedStores()
  await setupOwner(TENANT)
  await upsertTenantConfig(TENANT, {}, { allowCreate: true, creationSource: 'migration' })
  const res = await connectViaCallback(TENANT, { clientKey: GoogleOAuthClientKey.PRYOR })
  assert(res.statusCode === 503, `an unconfigured PRYOR client at callback time must fail closed with 503, got ${res.statusCode}`)
}

const tests = [
  ['legacy: suffixed pair present is used', testLegacySuffixedPairPresentIsUsed],
  ['legacy: suffixed absent, bare fallback used', testLegacySuffixedAbsentBareFallbackUsed],
  ['legacy: partial suffixed pair fails closed', testLegacyPartialSuffixedFailsClosed],
  ['legacy: partial bare fallback fails closed', testLegacyPartialBareFailsClosed],
  ['legacy: neither pair configured fails closed', testLegacyNeitherPairConfiguredFailsClosed],
  ['pryor: requires both vars', testPryorRequiresBothVars],
  ['pryor: never reads bare vars', testPryorNeverReadsBareVars],
  ['pryor: full pair resolves', testPryorFullPairResolves],
  ['coarse check: hasAnyGoogleOAuthClientConfigured', testHasAnyGoogleOAuthClientConfigured],
  ['unrecognized clientKeys fail closed, raw value never logged', testUnrecognizedClientKeysFailClosed],
  ['auth flag: absent defaults legacy', testAuthFlagAbsentDefaultsLegacy],
  ['auth flag: explicit legacy', testAuthFlagExplicitLegacy],
  ['auth flag: explicit pryor', testAuthFlagExplicitPryor],
  ['auth flag: invalid fails closed', testAuthFlagInvalidFailsClosed],
  ['state: signed legacy without clientKey verifies as legacy-lta', testSignedLegacyStateWithoutClientKey],
  ['state: signed pryor state verifies as pryor-2026', testSignedPryorState],
  ['state: tampered clientKey rejected', testTamperedClientKeyRejected],
  ['state: expired state rejected', testExpiredStateRejected],
  ['credentialStore: historical record missing clientKey reads legacy', testHistoricalRecordMissingClientKeyReadsLegacy],
  ['credentialStore: successful promotion writes provenance + increments version', testSuccessfulPromotionWritesProvenanceAndIncrementsVersion],
  ['credentialStore: read-modify-write preserves clientKey', testReadModifyWritePreservesClientKey],
  ['googleAuth: refresh selects only legacy pair', testNodeRefreshSelectsOnlyLegacyPair],
  ['googleAuth: refresh selects only pryor pair', testNodeRefreshSelectsOnlyPryorPair],
  ['googleAuth: unrecognized clientKey never calls fetch', testNodeRefreshUnrecognizedClientKeyNeverCallsFetch],
  ['callback: successful PRYOR promotion end to end', testSuccessfulPryorPromotionEndToEnd],
  ['callback: in-flight legacy state exchanges with legacy client', testInFlightLegacyStateExchangesWithLegacyClient],
  ['callback: accounts.list hard failure preserves old record byte-for-byte', testAccountsListHardFailurePreservesOldRecordByteForByte],
  ['callback: unexpected granted scope rejects the candidate', testUnexpectedScopeRejectsCandidate],
  ['callback: missing PRYOR client config fails closed', testMissingPryorClientConfigFailsClosedAtCallback],
]

const main = async () => {
  for (const [name, fn] of tests) await run(name, fn)
  const failed = results.filter(r => !r).length
  console.log(`\n${results.length - failed}/${results.length} tests passed`)
  process.exit(failed > 0 ? 1 : 0)
}
main()
