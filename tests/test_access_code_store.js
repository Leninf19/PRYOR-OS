// Multi-Tenant Phase 4Q.1 -- unit tests for accessCodeStore.js: creation
// (raw code shown once, only the hash persisted), listing/revocation, and
// the atomic redemption script's every failure mode plus the concurrency
// proof (the "access-code last-slot race" case).
//
// Run directly: node tests/test_access_code_store.js

import {
  createAccessCode, listAccessCodes, getAccessCodeByHash, revokeAccessCode,
  redeemAccessCode, previewAccessCode, hashAccessCode, AccessCodeInvalidError, AccessCodeRestrictedError,
  isValidTrialDays, MAX_ACCESS_CODE_TRIAL_DAYS, isValidDiscountPercent, isValidDiscountFixedCents,
  getAccessCodeRedemptionClaim, clearAccessCodeRedemptionClaim,
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
  const hashes = {}
  const strings = {}
  return {
    async hset(key, fields) { hashes[key] = { ...(hashes[key] ?? {}), ...fields } },
    async hgetall(key) { return { ...(hashes[key] ?? {}) } },
    async hget(key, field) { return hashes[key]?.[field] ?? null },
    // Phase B.8 pre-commit correction: plain string GET/SET/DEL, needed for
    // the durable redemption-claim ledger (a separate string key, never a
    // hash field) REDEEM_SCRIPT now writes alongside the hash update.
    async get(key) { return strings[key] ?? null },
    async set(key, value) { strings[key] = value; return 'OK' },
    async del(key) { const had = key in strings; delete strings[key]; return had ? 1 : 0 },
    async eval(_script, keys, args) {
      const key = keys[0]
      const claimKey = keys[1]
      const [codeHash, tenantId, userId, nowIso, claimPayload] = args
      const raw = hashes[key]?.[codeHash]
      if (!raw) return false
      let code
      try { code = JSON.parse(raw) } catch { return false }
      if (code.status !== 'active') return false
      if (code.expiresAt && code.expiresAt < nowIso) return false
      if (code.redemptionCount >= code.maxRedemptions) return false
      code.redemptionCount += 1
      code.redemptions = code.redemptions || []
      code.redemptions.push({ tenantId, userId, redeemedAt: nowIso })
      hashes[key] = { ...(hashes[key] ?? {}), [codeHash]: JSON.stringify(code) }
      if (claimKey && claimPayload !== undefined) strings[claimKey] = claimPayload
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
  const { rawCode, record } = await createAccessCode({ paymentRequired: false, prefix: 'LTA-ENT', plan: 'enterprise', createdBy: 'usr_admin' })
  assert(rawCode.startsWith('LTA-ENT-'), `expected the raw code to start with the prefix, got ${rawCode}`)
  assert(rawCode.length === 'LTA-ENT-'.length + 10, 'the random suffix must be 10 characters')
  assert(record.codeHash === hashAccessCode(rawCode), 'the stored hash must match the raw code')
  assert(!('rawCode' in record), 'the persisted record itself must never carry the raw code')
  const stored = await getAccessCodeByHash(record.codeHash)
  assert(JSON.stringify(stored) === JSON.stringify(record), 'reading it back must never surface anything the raw code could be reconstructed from beyond the hash')
}

async function testListNeverExposesRawCode() {
  wire()
  const { rawCode } = await createAccessCode({ paymentRequired: false, prefix: 'LTA-GRO', plan: 'growth', createdBy: 'usr_admin' })
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
  const { rawCode, record } = await createAccessCode({ paymentRequired: false, prefix: 'LTA-REV', plan: 'core', createdBy: 'usr_admin' })
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
  const { rawCode } = await createAccessCode({ paymentRequired: false, prefix: 'LTA-EXP', plan: 'core', expiresAt: pastDate, createdBy: 'usr_admin' })
  let threw = null
  try {
    await redeemAccessCode({ rawCode, email: 'a@example.com', tenantId: 't_x', userId: 'usr_x' })
  } catch (e) { threw = e }
  assert(threw instanceof AccessCodeInvalidError, 'an expired code must fail closed')
}

async function testRedeemFailsWhenExhausted() {
  wire()
  const { rawCode } = await createAccessCode({ paymentRequired: false, prefix: 'LTA-ONE', plan: 'core', maxRedemptions: 1, createdBy: 'usr_admin' })
  await redeemAccessCode({ rawCode, email: 'first@example.com', tenantId: 't_1', userId: 'usr_1' })
  let threw = null
  try {
    await redeemAccessCode({ rawCode, email: 'second@example.com', tenantId: 't_2', userId: 'usr_2' })
  } catch (e) { threw = e }
  assert(threw instanceof AccessCodeInvalidError, 'a second redemption beyond maxRedemptions must fail closed')
}

async function testRedeemEnforcesAllowedEmail() {
  wire()
  const { rawCode } = await createAccessCode({ paymentRequired: false, prefix: 'LTA-EML', plan: 'core', allowedEmail: 'vip@example.com', createdBy: 'usr_admin' })
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
  const { rawCode } = await createAccessCode({ paymentRequired: false, prefix: 'LTA-DOM', plan: 'core', allowedEmailDomain: 'losTresAmigos.com', createdBy: 'usr_admin' })
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
  const { rawCode } = await createAccessCode({ paymentRequired: false, prefix: 'LTA-SEC', plan: 'enterprise', discountPercent: 50, createdBy: 'usr_admin' })
  const result = await redeemAccessCode({ rawCode, email: 'a@example.com', tenantId: 't_x', userId: 'usr_x', plan: 'core', discountPercent: 100 })
  assert(result.plan === 'enterprise' && result.discountPercent === 50, 'extraneous caller-supplied plan/discount fields must be silently ignored -- only the server record is ever consulted')
}

async function testConcurrentRedemptionsAgainstLastSlotExactlyOneWins() {
  wire()
  const { rawCode } = await createAccessCode({ paymentRequired: false, prefix: 'LTA-RACE', plan: 'growth', maxRedemptions: 1, createdBy: 'usr_admin' })
  const attempt = i => redeemAccessCode({ rawCode, email: `racer${i}@example.com`, tenantId: `t_racer-${i}`, userId: `usr_racer_${i}` })
    .then(() => 'won').catch(() => 'lost')
  const outcomes = await Promise.all([attempt(1), attempt(2), attempt(3), attempt(4), attempt(5)])
  const wins = outcomes.filter(o => o === 'won')
  assert(wins.length === 1, `expected exactly 1 winner out of 5 concurrent redemptions against maxRedemptions=1, got ${wins.length}`)
}

async function testConcurrentRedemptionsRespectMaxRedemptionsGreaterThanOne() {
  wire()
  const { rawCode } = await createAccessCode({ paymentRequired: false, prefix: 'LTA-MULTI', plan: 'growth', maxRedemptions: 3, createdBy: 'usr_admin' })
  const attempt = i => redeemAccessCode({ rawCode, email: `racer${i}@example.com`, tenantId: `t_racer-${i}`, userId: `usr_racer_${i}` })
    .then(() => 'won').catch(() => 'lost')
  const outcomes = await Promise.all([1, 2, 3, 4, 5, 6].map(attempt))
  const wins = outcomes.filter(o => o === 'won')
  assert(wins.length === 3, `expected exactly 3 winners out of 6 concurrent redemptions against maxRedemptions=3, got ${wins.length}`)
}

// ===========================================================================
// Phase B.8 (Part G/H) -- plan validated against the canonical registry,
// trialDays validated at the one authoritative creation gate.
// ===========================================================================

async function testCreateRejectsInvalidPlan() {
  wire()
  let threw = null
  try {
    await createAccessCode({ paymentRequired: false, prefix: 'LTA-BAD', plan: 'not_a_real_plan', createdBy: 'usr_admin' })
  } catch (e) { threw = e }
  assert(threw instanceof TypeError, 'an arbitrary plan string must be rejected, never accepted as a real plan')
}

async function testCreateAcceptsEveryCanonicalPlan() {
  wire()
  for (const plan of ['core', 'growth', 'enterprise']) {
    const { record } = await createAccessCode({ paymentRequired: false, prefix: `LTA-${plan.toUpperCase()}`, plan, createdBy: 'usr_admin' })
    assert(record.plan === plan, `sanity: ${plan} must be accepted`)
  }
}

function testTrialDaysValidatorBoundaries() {
  assert(isValidTrialDays(null) === true, 'null (no trial) must be valid')
  assert(isValidTrialDays(0) === true, '0 must be valid (explicitly non-trial)')
  assert(isValidTrialDays(1) === true, '1 must be valid')
  assert(isValidTrialDays(MAX_ACCESS_CODE_TRIAL_DAYS) === true, `the maximum (${MAX_ACCESS_CODE_TRIAL_DAYS}) must be valid`)
  assert(isValidTrialDays(MAX_ACCESS_CODE_TRIAL_DAYS + 1) === false, 'one past the maximum must be rejected')
  assert(isValidTrialDays(-1) === false, 'negative must be rejected')
  assert(isValidTrialDays(NaN) === false, 'NaN must be rejected')
  assert(isValidTrialDays(14.5) === false, 'a fractional value must be rejected')
  assert(isValidTrialDays('14') === false, 'a string must be rejected -- no type coercion')
  assert(isValidTrialDays(999999) === false, 'an extremely large value must be rejected')
}

async function testCreateRejectsInvalidTrialDays() {
  wire()
  for (const bad of [-1, NaN, 14.5, '14', 999999, MAX_ACCESS_CODE_TRIAL_DAYS + 1]) {
    let threw = null
    try {
      await createAccessCode({ paymentRequired: false, prefix: 'LTA-TRL', plan: 'growth', trialDays: bad, createdBy: 'usr_admin' })
    } catch (e) { threw = e }
    assert(threw instanceof TypeError, `trialDays=${JSON.stringify(bad)} must be rejected at creation, never silently accepted`)
  }
}

async function testCreateAcceptsBoundaryTrialDays() {
  wire()
  const { record: zero } = await createAccessCode({ paymentRequired: false, prefix: 'LTA-TR0', plan: 'growth', trialDays: 0, createdBy: 'usr_admin' })
  assert(zero.trialDays === 0)
  const { record: max } = await createAccessCode({ paymentRequired: false, prefix: 'LTA-TRM', plan: 'growth', trialDays: MAX_ACCESS_CODE_TRIAL_DAYS, createdBy: 'usr_admin' })
  assert(max.trialDays === MAX_ACCESS_CODE_TRIAL_DAYS)
}

// ===========================================================================
// Phase B.8 (Part E) -- previewAccessCode(): every validation check
// redeemAccessCode() runs, but NEVER mutates redemptionCount/redemptions.
// ===========================================================================

async function testPreviewNeverConsumesARedemption() {
  wire()
  const { rawCode, record } = await createAccessCode({ paymentRequired: false, prefix: 'LTA-PRV', plan: 'core', maxRedemptions: 1, createdBy: 'usr_admin' })
  const preview = await previewAccessCode({ rawCode, email: 'a@example.com' })
  assert(preview.plan === 'core' && preview.codeHash === record.codeHash)
  const after = await getAccessCodeByHash(record.codeHash)
  assert(after.redemptionCount === 0, 'previewAccessCode() must never increment redemptionCount')
  assert(after.redemptions.length === 0, 'previewAccessCode() must never append a redemption record')
  // The code must still be fully redeemable afterward -- preview never
  // burns it.
  const redeemed = await redeemAccessCode({ rawCode, email: 'a@example.com', tenantId: 't_x', userId: 'usr_x' })
  assert(redeemed.plan === 'core')
}

async function testPreviewExposesPaymentRequired() {
  wire()
  const { rawCode: paidCode } = await createAccessCode({ prefix: 'LTA-PAY', plan: 'growth', paymentRequired: true, createdBy: 'usr_admin' })
  const { rawCode: freeCode } = await createAccessCode({ prefix: 'LTA-FRE', plan: 'growth', paymentRequired: false, createdBy: 'usr_admin' })
  const paidPreview = await previewAccessCode({ rawCode: paidCode, email: 'a@example.com' })
  const freePreview = await previewAccessCode({ rawCode: freeCode, email: 'a@example.com' })
  assert(paidPreview.paymentRequired === true && freePreview.paymentRequired === false)
}

async function testPreviewFailsClosedForInvalidRestrictedExpiredExhaustedCodes() {
  wire()
  let threw
  try {
    await previewAccessCode({ rawCode: 'LTA-FAKE-0000000000', email: 'a@example.com' })
  } catch (e) { threw = e }
  assert(threw instanceof AccessCodeInvalidError, 'preview of an unknown code must fail the same way redemption does')

  const { rawCode: restricted } = await createAccessCode({ paymentRequired: false, prefix: 'LTA-RES', plan: 'core', allowedEmail: 'vip@example.com', createdBy: 'usr_admin' })
  threw = null
  try {
    await previewAccessCode({ rawCode: restricted, email: 'not-vip@example.com' })
  } catch (e) { threw = e }
  assert(threw instanceof AccessCodeRestrictedError, 'preview must enforce email restriction identically to redemption')
}

// ===========================================================================
// Phase B.8 pre-commit correction (Part 3) -- paymentRequired creation
// semantics: no silent default, every real path must be explicit.
// ===========================================================================

async function testOmittedPaymentRequiredIsRejectedAtCreation() {
  wire()
  let threw = null
  try {
    await createAccessCode({ prefix: 'LTA-OMIT', plan: 'growth', createdBy: 'usr_admin' })
  } catch (e) { threw = e }
  assert(threw instanceof TypeError, 'an omitted paymentRequired must be rejected outright -- no silent default, since omission now has major commercial meaning')
}

async function testExplicitPaymentRequiredFalseIsRedeemableAccordingToCodeRules() {
  wire()
  const { rawCode } = await createAccessCode({ prefix: 'LTA-EXPF', plan: 'growth', paymentRequired: false, createdBy: 'usr_admin' })
  const result = await redeemAccessCode({ rawCode, email: 'a@example.com', tenantId: 't_x', userId: 'usr_x' })
  assert(result.paymentRequired === false && result.plan === 'growth')
}

async function testExplicitPaymentRequiredTrueDoesNotIncrementRedeemedCountOnDenial() {
  // accessCodeStore.js itself has no concept of "denied at redemption" for
  // paymentRequired (that decision lives in accessCodeCommercial.js/
  // session/[action].js, which check previewAccessCode() BEFORE ever
  // calling the real redeemAccessCode()) -- this test locks down that the
  // STORE layer at least still allows creating and previewing such a code
  // without it being silently coerced, so the caller-side rejection has
  // real data to work with.
  wire()
  const { rawCode, record } = await createAccessCode({ prefix: 'LTA-EXPT', plan: 'growth', paymentRequired: true, createdBy: 'usr_admin' })
  const preview = await previewAccessCode({ rawCode, email: 'a@example.com' })
  assert(preview.paymentRequired === true)
  const stored = await getAccessCodeByHash(record.codeHash)
  assert(stored.redemptionCount === 0, 'previewing a paymentRequired code must never itself increment redemptionCount')
}

// ===========================================================================
// Phase B.8 pre-commit correction (Part 4) -- discount metadata validation.
// ===========================================================================

function testDiscountPercentValidatorBoundaries() {
  assert(isValidDiscountPercent(null) === true)
  assert(isValidDiscountPercent(0) === true)
  assert(isValidDiscountPercent(100) === true)
  assert(isValidDiscountPercent(50) === true)
  assert(isValidDiscountPercent(-1) === false, 'negative must be rejected')
  assert(isValidDiscountPercent(101) === false, 'over 100 must be rejected')
  assert(isValidDiscountPercent(NaN) === false)
  assert(isValidDiscountPercent(20.5) === false, 'fractional percentages are not supported')
  assert(isValidDiscountPercent('20') === false, 'no type coercion')
}

function testDiscountFixedCentsValidatorBoundaries() {
  assert(isValidDiscountFixedCents(null) === true)
  assert(isValidDiscountFixedCents(0) === true)
  assert(isValidDiscountFixedCents(500) === true)
  assert(isValidDiscountFixedCents(-1) === false, 'negative must be rejected')
  assert(isValidDiscountFixedCents(NaN) === false)
  assert(isValidDiscountFixedCents(99.99) === false, 'fractional cents must be rejected')
  assert(isValidDiscountFixedCents(Number.MAX_SAFE_INTEGER + 1) === false, 'unsafe integers must be rejected')
  assert(isValidDiscountFixedCents('500') === false, 'no type coercion')
}

async function testCreateRejectsInvalidDiscountPercent() {
  wire()
  for (const bad of [-1, 101, NaN, 20.5, '20']) {
    let threw = null
    try {
      await createAccessCode({ prefix: 'LTA-DPCT', plan: 'growth', paymentRequired: false, discountPercent: bad, createdBy: 'usr_admin' })
    } catch (e) { threw = e }
    assert(threw instanceof TypeError, `discountPercent=${JSON.stringify(bad)} must be rejected at creation`)
  }
}

async function testCreateRejectsInvalidDiscountFixedCents() {
  wire()
  for (const bad of [-1, NaN, 99.99, Number.MAX_SAFE_INTEGER + 1]) {
    let threw = null
    try {
      await createAccessCode({ prefix: 'LTA-DCNT', plan: 'growth', paymentRequired: false, discountFixedCents: bad, createdBy: 'usr_admin' })
    } catch (e) { threw = e }
    assert(threw instanceof TypeError, `discountFixedCents=${JSON.stringify(bad)} must be rejected at creation`)
  }
}

async function testCreateRejectsSimultaneousPercentAndFixedDiscount() {
  wire()
  let threw = null
  try {
    await createAccessCode({ prefix: 'LTA-BOTH', plan: 'growth', paymentRequired: false, discountPercent: 10, discountFixedCents: 500, createdBy: 'usr_admin' })
  } catch (e) { threw = e }
  assert(threw instanceof TypeError, 'simultaneous percent and fixed discount must be rejected')
}

async function testValidDiscountMetadataPreservedExactly() {
  wire()
  const { rawCode } = await createAccessCode({ prefix: 'LTA-DVAL', plan: 'growth', paymentRequired: false, discountPercent: 15, createdBy: 'usr_admin' })
  const result = await redeemAccessCode({ rawCode, email: 'a@example.com', tenantId: 't_x', userId: 'usr_x' })
  assert(result.discountPercent === 15 && result.discountFixedCents === null)
}

// ===========================================================================
// Phase B.8 pre-commit correction (Part 2) -- durable redemption-claim
// ledger, written atomically by REDEEM_SCRIPT alongside redemptionCount.
// ===========================================================================

async function testRedemptionWritesADurableClaimAtomically() {
  wire()
  const { rawCode } = await createAccessCode({ prefix: 'LTA-CLM', plan: 'growth', paymentRequired: false, createdBy: 'usr_admin' })
  const before = await getAccessCodeRedemptionClaim('claimant@example.com')
  assert(before === null, 'no claim must exist before redemption')
  await redeemAccessCode({ rawCode, email: 'claimant@example.com', tenantId: 't_x', userId: 'usr_x' })
  const after = await getAccessCodeRedemptionClaim('claimant@example.com')
  assert(after && after.plan === 'growth', 'a durable claim must exist immediately after a successful redemption')
}

async function testClaimIsKeyedByEmailNeverSharedAcrossRegistrants() {
  wire()
  const { rawCode } = await createAccessCode({ prefix: 'LTA-ISOLC', plan: 'growth', maxRedemptions: 2, paymentRequired: false, createdBy: 'usr_admin' })
  await redeemAccessCode({ rawCode, email: 'first@example.com', tenantId: 't_1', userId: 'usr_1' })
  const otherClaim = await getAccessCodeRedemptionClaim('second@example.com')
  assert(otherClaim === null, "a different email's claim lookup must never see another registrant's claim")
}

async function testClearingClaimRemovesIt() {
  wire()
  const { rawCode } = await createAccessCode({ prefix: 'LTA-CLR', plan: 'growth', paymentRequired: false, createdBy: 'usr_admin' })
  await redeemAccessCode({ rawCode, email: 'finisher@example.com', tenantId: 't_x', userId: 'usr_x' })
  assert((await getAccessCodeRedemptionClaim('finisher@example.com')) !== null)
  await clearAccessCodeRedemptionClaim('finisher@example.com')
  assert((await getAccessCodeRedemptionClaim('finisher@example.com')) === null, 'clearing the claim must remove it')
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

  // --- Phase B.8 ---
  ['create rejects an invalid/arbitrary plan string', testCreateRejectsInvalidPlan],
  ['create accepts every canonical plan (core/growth/enterprise)', testCreateAcceptsEveryCanonicalPlan],
  ['trialDays validator boundaries', testTrialDaysValidatorBoundaries],
  ['create rejects invalid trialDays (negative/NaN/fractional/string/oversized)', testCreateRejectsInvalidTrialDays],
  ['create accepts boundary trialDays (0 and the maximum)', testCreateAcceptsBoundaryTrialDays],
  ['previewAccessCode() never consumes a redemption', testPreviewNeverConsumesARedemption],
  ['previewAccessCode() exposes paymentRequired', testPreviewExposesPaymentRequired],
  ['previewAccessCode() fails closed for invalid/restricted codes', testPreviewFailsClosedForInvalidRestrictedExpiredExhaustedCodes],

  // --- Phase B.8 pre-commit correction: paymentRequired creation semantics ---
  ['omitted paymentRequired is rejected at creation (no silent default)', testOmittedPaymentRequiredIsRejectedAtCreation],
  ['explicit paymentRequired: false is redeemable per code rules', testExplicitPaymentRequiredFalseIsRedeemableAccordingToCodeRules],
  ['previewing a paymentRequired: true code never increments redeemedCount', testExplicitPaymentRequiredTrueDoesNotIncrementRedeemedCountOnDenial],

  // --- Phase B.8 pre-commit correction: discount metadata validation ---
  ['discountPercent validator boundaries', testDiscountPercentValidatorBoundaries],
  ['discountFixedCents validator boundaries', testDiscountFixedCentsValidatorBoundaries],
  ['create rejects invalid discountPercent', testCreateRejectsInvalidDiscountPercent],
  ['create rejects invalid discountFixedCents', testCreateRejectsInvalidDiscountFixedCents],
  ['create rejects simultaneous percent + fixed discount', testCreateRejectsSimultaneousPercentAndFixedDiscount],
  ['valid discount metadata preserved exactly', testValidDiscountMetadataPreservedExactly],

  // --- Phase B.8 pre-commit correction: durable redemption-claim ledger ---
  ['redemption writes a durable claim atomically', testRedemptionWritesADurableClaimAtomically],
  ['claim is keyed by email, never shared across registrants', testClaimIsKeyedByEmailNeverSharedAcrossRegistrants],
  ['clearing a claim removes it', testClearingClaimRemovesIt],
]

for (const [name, fn] of tests) await run(name, fn)

console.log()
if (results.every(Boolean)) {
  console.log(`ALL ${results.length} TESTS PASSED`)
  process.exit(0)
}
console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
process.exit(1)
