// Multi-Tenant Phase 4Q.1 -- unit tests for accessCodeStore.js: creation
// (raw code shown once, only the hash persisted), listing/revocation, and
// the atomic redemption script's every failure mode plus the concurrency
// proof (the "access-code last-slot race" case).
//
// Run directly: node tests/test_access_code_store.js

import {
  createAccessCode, listAccessCodes, getAccessCodeByHash, revokeAccessCode,
  redeemAccessCode, hashAccessCode, AccessCodeInvalidError, AccessCodeRestrictedError,
  _setRedisClientForTests, _resetRedisClientForTests,
} from '../dashboard/api/_lib/accessCodeStore.js'

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
  }
}

// Faithfully emulates the REDEEM_SCRIPT's Lua logic in JS -- same pattern
// this project already established for CAS_UPSERT_SCRIPT-style Lua
// mirroring (see test_tenant_entitlement_change.js). Because this
// function's body contains no `await` between its read and its write, two
// concurrent callers (Promise.all) can never interleave mid-check the way
// a real single-threaded Redis EVAL never can either -- this is what
// makes the concurrency test below a genuine proof, not a coincidence of
// timing.
function fakeAccessCodeRedis() {
  const store = {}
  return {
    async hset(key, fields) { store[key] = { ...(store[key] ?? {}), ...fields } },
    async hgetall(key) { return { ...(store[key] ?? {}) } },
    async hget(key, field) { return store[key]?.[field] ?? null },
    async eval(_script, keys, args) {
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
      store[key] = { ...(store[key] ?? {}), [codeHash]: JSON.stringify(code) }
      return JSON.stringify(code)
    },
  }
}

function wire() {
  const client = fakeAccessCodeRedis()
  _setRedisClientForTests(() => client)
  return client
}

async function testCreateReturnsRawCodeOnceAndOnlyHashPersists() {
  wire()
  const { rawCode, record } = await createAccessCode({ prefix: 'LTA-ENT', plan: 'enterprise', createdBy: 'usr_admin' })
  assert(rawCode.startsWith('LTA-ENT-'), `expected the raw code to start with the prefix, got ${rawCode}`)
  assert(rawCode.length === 'LTA-ENT-'.length + 10, 'the random suffix must be 10 characters')
  assert(record.codeHash === hashAccessCode(rawCode), 'the stored hash must match the raw code')
  assert(!('rawCode' in record), 'the persisted record itself must never carry the raw code')
  const stored = await getAccessCodeByHash(record.codeHash)
  assert(JSON.stringify(stored) === JSON.stringify(record), 'reading it back must never surface anything the raw code could be reconstructed from beyond the hash')
}

async function testListNeverExposesRawCode() {
  wire()
  const { rawCode } = await createAccessCode({ prefix: 'LTA-GRO', plan: 'growth', createdBy: 'usr_admin' })
  const all = await listAccessCodes()
  const serialized = JSON.stringify(all)
  assert(!serialized.includes(rawCode), 'the raw code must never appear anywhere in the admin listing')
}

async function testRedeemSuccessReturnsPlanFieldsFromServerRecordOnly() {
  wire()
  const { rawCode } = await createAccessCode({
    prefix: 'LTA-COR', plan: 'core', discountPercent: 20, trialDays: 14, paymentRequired: false, createdBy: 'usr_admin',
  })
  const result = await redeemAccessCode({ rawCode, email: 'owner@example.com', tenantId: 't_x', userId: 'usr_x' })
  assert(result.plan === 'core' && result.discountPercent === 20 && result.trialDays === 14 && result.paymentRequired === false)
}

async function testRedeemFailsForUnknownCode() {
  wire()
  let threw = null
  try {
    await redeemAccessCode({ rawCode: 'LTA-FAKE-0000000000', email: 'a@example.com', tenantId: 't_x', userId: 'usr_x' })
  } catch (e) { threw = e }
  assert(threw instanceof AccessCodeInvalidError, 'an unknown code must be rejected as invalid')
}

async function testRedeemFailsForRevokedCode() {
  wire()
  const { rawCode, record } = await createAccessCode({ prefix: 'LTA-REV', plan: 'core', createdBy: 'usr_admin' })
  await revokeAccessCode(record.codeHash)
  let threw = null
  try {
    await redeemAccessCode({ rawCode, email: 'a@example.com', tenantId: 't_x', userId: 'usr_x' })
  } catch (e) { threw = e }
  assert(threw instanceof AccessCodeInvalidError, 'a revoked code must fail closed')
}

async function testRedeemFailsForExpiredCode() {
  wire()
  const pastDate = new Date(Date.now() - 60_000).toISOString()
  const { rawCode } = await createAccessCode({ prefix: 'LTA-EXP', plan: 'core', expiresAt: pastDate, createdBy: 'usr_admin' })
  let threw = null
  try {
    await redeemAccessCode({ rawCode, email: 'a@example.com', tenantId: 't_x', userId: 'usr_x' })
  } catch (e) { threw = e }
  assert(threw instanceof AccessCodeInvalidError, 'an expired code must fail closed')
}

async function testRedeemFailsWhenExhausted() {
  wire()
  const { rawCode } = await createAccessCode({ prefix: 'LTA-ONE', plan: 'core', maxRedemptions: 1, createdBy: 'usr_admin' })
  await redeemAccessCode({ rawCode, email: 'first@example.com', tenantId: 't_1', userId: 'usr_1' })
  let threw = null
  try {
    await redeemAccessCode({ rawCode, email: 'second@example.com', tenantId: 't_2', userId: 'usr_2' })
  } catch (e) { threw = e }
  assert(threw instanceof AccessCodeInvalidError, 'a second redemption beyond maxRedemptions must fail closed')
}

async function testRedeemEnforcesAllowedEmail() {
  wire()
  const { rawCode } = await createAccessCode({ prefix: 'LTA-EML', plan: 'core', allowedEmail: 'vip@example.com', createdBy: 'usr_admin' })
  let threw = null
  try {
    await redeemAccessCode({ rawCode, email: 'not-vip@example.com', tenantId: 't_x', userId: 'usr_x' })
  } catch (e) { threw = e }
  assert(threw instanceof AccessCodeRestrictedError, 'an email-restricted code must reject a non-matching email')
  // The rightful owner must still succeed.
  const ok = await redeemAccessCode({ rawCode, email: 'VIP@example.com', tenantId: 't_x', userId: 'usr_x' })
  assert(ok.plan === 'core')
}

async function testRedeemEnforcesAllowedDomain() {
  wire()
  const { rawCode } = await createAccessCode({ prefix: 'LTA-DOM', plan: 'core', allowedEmailDomain: 'losTresAmigos.com', createdBy: 'usr_admin' })
  let threw = null
  try {
    await redeemAccessCode({ rawCode, email: 'someone@other.com', tenantId: 't_x', userId: 'usr_x' })
  } catch (e) { threw = e }
  assert(threw instanceof AccessCodeRestrictedError, 'a domain-restricted code must reject a non-matching domain')
  const ok = await redeemAccessCode({ rawCode, email: 'owner@lostresamigos.com', tenantId: 't_x', userId: 'usr_x' })
  assert(ok.plan === 'core')
}

async function testPlanPayloadCannotBeSuppliedByCaller() {
  wire()
  // redeemAccessCode()'s own signature accepts no plan/discount fields at
  // all -- this test documents that contract directly rather than trying
  // to sneak extra fields past it (there is nowhere to put them).
  const { rawCode } = await createAccessCode({ prefix: 'LTA-SEC', plan: 'enterprise', discountPercent: 50, createdBy: 'usr_admin' })
  const result = await redeemAccessCode({ rawCode, email: 'a@example.com', tenantId: 't_x', userId: 'usr_x', plan: 'core', discountPercent: 100 })
  assert(result.plan === 'enterprise' && result.discountPercent === 50, 'extraneous caller-supplied plan/discount fields must be silently ignored -- only the server record is ever consulted')
}

async function testConcurrentRedemptionsAgainstLastSlotExactlyOneWins() {
  wire()
  const { rawCode } = await createAccessCode({ prefix: 'LTA-RACE', plan: 'growth', maxRedemptions: 1, createdBy: 'usr_admin' })
  const attempt = i => redeemAccessCode({ rawCode, email: `racer${i}@example.com`, tenantId: `t_racer-${i}`, userId: `usr_racer_${i}` })
    .then(() => 'won').catch(() => 'lost')
  const outcomes = await Promise.all([attempt(1), attempt(2), attempt(3), attempt(4), attempt(5)])
  const wins = outcomes.filter(o => o === 'won')
  assert(wins.length === 1, `expected exactly 1 winner out of 5 concurrent redemptions against maxRedemptions=1, got ${wins.length}`)
}

async function testConcurrentRedemptionsRespectMaxRedemptionsGreaterThanOne() {
  wire()
  const { rawCode } = await createAccessCode({ prefix: 'LTA-MULTI', plan: 'growth', maxRedemptions: 3, createdBy: 'usr_admin' })
  const attempt = i => redeemAccessCode({ rawCode, email: `racer${i}@example.com`, tenantId: `t_racer-${i}`, userId: `usr_racer_${i}` })
    .then(() => 'won').catch(() => 'lost')
  const outcomes = await Promise.all([1, 2, 3, 4, 5, 6].map(attempt))
  const wins = outcomes.filter(o => o === 'won')
  assert(wins.length === 3, `expected exactly 3 winners out of 6 concurrent redemptions against maxRedemptions=3, got ${wins.length}`)
}

const tests = [
  ['create returns the raw code once; only the hash persists', testCreateReturnsRawCodeOnceAndOnlyHashPersists],
  ['listing never exposes the raw code', testListNeverExposesRawCode],
  ['redemption returns plan fields from the server record', testRedeemSuccessReturnsPlanFieldsFromServerRecordOnly],
  ['redemption fails for an unknown code', testRedeemFailsForUnknownCode],
  ['redemption fails for a revoked code', testRedeemFailsForRevokedCode],
  ['redemption fails for an expired code', testRedeemFailsForExpiredCode],
  ['redemption fails once maxRedemptions is exhausted', testRedeemFailsWhenExhausted],
  ['redemption enforces an allowed-email restriction', testRedeemEnforcesAllowedEmail],
  ['redemption enforces an allowed-domain restriction', testRedeemEnforcesAllowedDomain],
  ['plan/discount payload cannot be supplied by the caller', testPlanPayloadCannotBeSuppliedByCaller],
  ['concurrent redemptions against the last slot -- exactly one wins', testConcurrentRedemptionsAgainstLastSlotExactlyOneWins],
  ['concurrent redemptions respect maxRedemptions > 1', testConcurrentRedemptionsRespectMaxRedemptionsGreaterThanOne],
]

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
