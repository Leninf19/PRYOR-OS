// Regression tests for the TEMPORARY Phase 4M one-time synchronization
// mechanism:
//   - dashboard/api/_lib/encryptionKeySealer.js
//   - POST /api/google/seal-encryption-key-for-github (google/[action].js)
//
// Proves: the endpoint accepts NO caller-supplied key material (a
// request body of any shape is rejected outright), the sealed value is
// always produced against the hardcoded, repository-pinned GitHub public
// key (never a caller-suppliable one), the response contains ONLY
// {sealedValueBase64, keyId}, the plaintext CREDENTIAL_ENCRYPTION_KEY
// never appears in any response or error output, Owner + platform-owner
// gating and rate limiting are enforced, and no Redis credential record
// or Google API call is ever touched.
//
// No real GitHub API call, no real libsodium key exchange with GitHub's
// actual private key (that only GitHub itself can do) -- this only
// proves the LOCAL sealing/response/gating behavior.
//
// This whole mechanism is TEMPORARY -- delete this test file alongside
// encryptionKeySealer.js, google/[action].js's sealEncryptionKeyForGithub
// action, and the libsodium-wrappers dependency once the
// CREDENTIAL_ENCRYPTION_KEY synchronization is verified complete.
//
// Run directly: node tests/test_encryption_key_sealer.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-should-never-appear-in-output'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'
process.env.PLATFORM_OWNER_EMAILS = 'owner@example.com'

import bcrypt from 'bcryptjs'
import handler from '../dashboard/api/google/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import {
  sealCredentialEncryptionKeyForPinnedGitHubRepo, EncryptionKeyNotConfiguredError,
} from '../dashboard/api/_lib/encryptionKeySealer.js'
import { _setRedisClientForTests as _setAuditRedis, _resetRedisClientForTests as _resetAuditRedis } from '../dashboard/api/_lib/auditLog.js'
import { _setLimiterFactoryForTests, _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'

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
    _resetAuditRedis()
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
  const store = new Map()
  return {
    lpush: async (key, value) => { store.set(key, [value, ...(store.get(key) || [])]) },
    ltrim: async () => {},
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
const ownerToken = () => signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: 't_los-tres-amigos', sessionVersion: 1 })
const marketingToken = () => signSession({ userId: 'usr_marketing', email: 'marketing@example.com', role: 'marketing', locationIds: '*', tenantId: 't_los-tres-amigos', sessionVersion: 1 })

async function invoke(body, token) {
  await setDirectory()
  _setAuditRedis(() => fakeAuditRedis())
  const req = { method: 'POST', query: { action: 'seal-encryption-key-for-github' }, body, headers: { cookie: token ? `lta_session=${await token}` : '' } }
  const res = fakeRes()
  await handler(req, res)
  return res
}

// ===========================================================================
// No request-controlled sealing key
// ===========================================================================

function testSealerFunctionAcceptsNoArguments() {
  assert(sealCredentialEncryptionKeyForPinnedGitHubRepo.length === 0, 'the sealer function must take zero parameters -- there is no way to pass it a key/public key at all')
}

async function testEndpointRejectsAnyNonEmptyBody() {
  for (const body of [{ publicKeyBase64: 'attacker-controlled-key' }, { keyId: 'x' }, { anything: true }]) {
    const res = await invoke(body, ownerToken())
    assert(res.statusCode === 400, `a non-empty body ${JSON.stringify(body)} must be rejected with 400, got ${res.statusCode}`)
  }
}

async function testEndpointAcceptsAnEmptyBody() {
  for (const body of [{}, undefined, null]) {
    const res = await invoke(body, ownerToken())
    assert(res.statusCode === 200, `an empty body ${JSON.stringify(body)} must be accepted, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  }
}

// ===========================================================================
// The pinned public key is well-formed (a successful, non-throwing seal
// against it proves libsodium accepted it as a valid 32-byte X25519 key --
// crypto_box_seal throws on any other length).
// ===========================================================================

async function testPinnedPublicKeyIsAValid32ByteKey() {
  const result = await sealCredentialEncryptionKeyForPinnedGitHubRepo()
  assert(typeof result.sealedValueBase64 === 'string' && result.sealedValueBase64.length > 0, 'sealing against the pinned key must succeed and produce a non-empty value')
}

// ===========================================================================
// Response shape: ONLY the sealed value and the pinned keyId
// ===========================================================================

async function testSuccessResponseContainsOnlySealedValueAndKeyId() {
  const res = await invoke({}, ownerToken())
  assert(res.statusCode === 200)
  assert(Object.keys(res.body).sort().join(',') === 'keyId,sealedValueBase64', `response must contain exactly sealedValueBase64/keyId, got ${JSON.stringify(Object.keys(res.body))}`)
  assert(typeof res.body.sealedValueBase64 === 'string' && res.body.sealedValueBase64.length > 0)
  assert(typeof res.body.keyId === 'string' && res.body.keyId.length > 0)
}

async function testKeyIdIsAlwaysTheSamePinnedValueRegardlessOfInput() {
  const res1 = await invoke({}, ownerToken())
  const res2 = await invoke(undefined, ownerToken())
  assert(res1.body.keyId === res2.body.keyId, 'keyId must be the fixed pinned value, never influenced by the request')
}

// ===========================================================================
// Plaintext never appears in success or error output
// ===========================================================================

async function testPlaintextNeverAppearsInSuccessResponse() {
  const res = await invoke({}, ownerToken())
  const serialized = JSON.stringify(res.body)
  assert(!serialized.includes('test-encryption-key-should-never-appear-in-output'), 'the plaintext CREDENTIAL_ENCRYPTION_KEY must never appear in the response')
}

async function testPlaintextNeverAppearsInErrorResponseWhenNotConfigured() {
  const original = process.env.CREDENTIAL_ENCRYPTION_KEY
  delete process.env.CREDENTIAL_ENCRYPTION_KEY
  try {
    const res = await invoke({}, ownerToken())
    assert(res.statusCode === 503, `an unconfigured key must respond 503, got ${res.statusCode}`)
    assert(!JSON.stringify(res.body).includes(original), 'the error response must never leak the (now-removed) plaintext key')
  } finally {
    process.env.CREDENTIAL_ENCRYPTION_KEY = original
  }
}

async function testSealerThrowsCleanlyWhenUnconfigured() {
  const original = process.env.CREDENTIAL_ENCRYPTION_KEY
  delete process.env.CREDENTIAL_ENCRYPTION_KEY
  try {
    let threw = false
    try {
      await sealCredentialEncryptionKeyForPinnedGitHubRepo()
    } catch (e) {
      threw = e instanceof EncryptionKeyNotConfiguredError
    }
    assert(threw, 'must throw EncryptionKeyNotConfiguredError, never silently return something')
  } finally {
    process.env.CREDENTIAL_ENCRYPTION_KEY = original
  }
}

// ===========================================================================
// Owner + platform-owner gating
// ===========================================================================

async function testRequiresOwnerRole() {
  const res = await invoke({}, marketingToken())
  assert(res.statusCode === 403, `a non-Owner role must be rejected with 403, got ${res.statusCode}`)
}

async function testRejectsUnauthenticated() {
  const res = await invoke({}, null)
  assert(res.statusCode === 401, `no session must be rejected with 401, got ${res.statusCode}`)
}

async function testRejectsTenantOwnerNotOnPlatformOwnerAllowlist() {
  const original = process.env.PLATFORM_OWNER_EMAILS
  delete process.env.PLATFORM_OWNER_EMAILS
  try {
    const res = await invoke({}, ownerToken())
    assert(res.statusCode === 403, `an Owner not on PLATFORM_OWNER_EMAILS must be rejected with 403, got ${res.statusCode}`)
  } finally {
    process.env.PLATFORM_OWNER_EMAILS = original
  }
}

// ===========================================================================
// Rate limiting is enforced
// ===========================================================================

async function testRateLimitIsEnforced() {
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: false, remaining: 0 }) }))
  const res = await invoke({}, ownerToken())
  assert(res.statusCode === 429, `an exhausted rate limit must respond 429, got ${res.statusCode}`)
}

// ===========================================================================
// No Redis credential mutation, no Google API call
// ===========================================================================

async function testMakesNoGoogleApiCall() {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => { throw new Error(`sealEncryptionKeyForGithub must never call fetch (attempted: ${url})`) }
  try {
    const res = await invoke({}, ownerToken())
    assert(res.statusCode === 200)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testDoesNotImportCredentialStoreOrRedisClient() {
  // Source-scan, same discipline as this project's other "must never
  // touch X" tests -- the sealer module must have no path to reading or
  // writing any tenant's stored credential record.
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'api', '_lib', 'encryptionKeySealer.js'), 'utf-8')
  assert(!source.includes('@upstash/redis'), 'encryptionKeySealer.js must never import the Redis client')
  assert(!source.includes('credentialStore'), 'encryptionKeySealer.js must never import credentialStore.js')
}

async function main() {
  await run('sealer function accepts zero arguments (no request-controlled key)', testSealerFunctionAcceptsNoArguments)
  await run('endpoint rejects any non-empty request body', testEndpointRejectsAnyNonEmptyBody)
  await run('endpoint accepts an empty request body', testEndpointAcceptsAnEmptyBody)
  await run('the pinned public key is a valid 32-byte key (seal succeeds)', testPinnedPublicKeyIsAValid32ByteKey)
  await run('success response contains ONLY sealedValueBase64 and keyId', testSuccessResponseContainsOnlySealedValueAndKeyId)
  await run('keyId is always the fixed pinned value', testKeyIdIsAlwaysTheSamePinnedValueRegardlessOfInput)
  await run('plaintext never appears in the success response', testPlaintextNeverAppearsInSuccessResponse)
  await run('plaintext never appears in the error response when unconfigured', testPlaintextNeverAppearsInErrorResponseWhenNotConfigured)
  await run('sealer throws EncryptionKeyNotConfiguredError cleanly when unconfigured', testSealerThrowsCleanlyWhenUnconfigured)
  await run('requires the Owner role', testRequiresOwnerRole)
  await run('rejects an unauthenticated request', testRejectsUnauthenticated)
  await run('rejects a tenant Owner not on PLATFORM_OWNER_EMAILS', testRejectsTenantOwnerNotOnPlatformOwnerAllowlist)
  await run('rate limiting is enforced', testRateLimitIsEnforced)
  await run('makes no Google API call', testMakesNoGoogleApiCall)
  await run('never imports the Redis client or credentialStore.js', testDoesNotImportCredentialStoreOrRedisClient)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  } else {
    console.log(`${results.filter((r) => !r).length} of ${results.length} TESTS FAILED`)
    process.exit(1)
  }
}

main()
