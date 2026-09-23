#!/usr/bin/env node
// One-off verification: exercises the REAL, shipped create -> preview ->
// redeem -> read -> (failed re-redeem) -> revoke sequence through
// accessCodeStore.js's actual exported functions (never a reimplementation)
// against a disposable, clearly-fake test code -- to confirm the
// REDEEM_SCRIPT fix (explicit field-by-field JSON emission instead of a
// whole-table cjson.encode) actually preserves null fields through a real
// redemption on this backend, and that the new pre-redemption
// buildAccessCodeCommercialWrite() check in session/[action].js validates
// against the same shape.
//
// Uses an .invalid-TLD email (RFC 2606 -- reserved, can never be a real
// address) and a distinct DIAGTEST prefix/clientLabel so this can never
// collide with or affect any real code, tenant, or account. Revokes the
// test code at the end (no delete function exists in this store) so
// nothing active lingers. Never touches any other record.
//
// Prints only sanitized booleans/types -- never the raw code.

import { createAccessCode, previewAccessCode, redeemAccessCode, getAccessCodeByHash, hashAccessCode, revokeAccessCode, AccessCodeInvalidError } from './api/_lib/accessCodeStore.js'
import { buildAccessCodeCommercialWrite } from './api/_lib/accessCodeCommercial.js'

const TEST_EMAIL = 'diagnostic-test-null-roundtrip@example.invalid'

async function main() {
  console.log('=== Step 1: create a disposable test code (mirrors the real settings shape: paymentRequired:false, trialDays:null, discounts:null) ===')
  const { rawCode, record: created } = await createAccessCode({
    prefix: 'DIAGTEST', plan: 'growth', paymentRequired: false,
    trialDays: null, discountPercent: null, discountFixedCents: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    maxRedemptions: 1, allowedEmail: TEST_EMAIL,
    clientLabel: 'DIAGNOSTIC TEST -- safe to ignore/revoke', createdBy: 'claude_fix_verification',
  })
  console.log(`Created -- trialDays: ${JSON.stringify(created.trialDays)}, discountPercent: ${JSON.stringify(created.discountPercent)}, discountFixedCents: ${JSON.stringify(created.discountFixedCents)}`)
  const codeHash = hashAccessCode(rawCode)

  console.log('\n=== Step 2: preview (pre-redemption read) ===')
  const preview = await previewAccessCode({ rawCode, email: TEST_EMAIL })
  console.log(`Preview -- trialDays: ${JSON.stringify(preview.trialDays)}, discountPercent: ${JSON.stringify(preview.discountPercent)}, discountFixedCents: ${JSON.stringify(preview.discountFixedCents)}`)

  console.log('\n=== Step 3: new pre-redemption validation (mirrors the added check in session/[action].js) ===')
  try {
    buildAccessCodeCommercialWrite(preview)
    console.log('buildAccessCodeCommercialWrite(preview) succeeded -- would NOT block redemption.')
  } catch (err) {
    console.log(`buildAccessCodeCommercialWrite(preview) threw: ${err.constructor.name}: ${err.message}`)
  }

  console.log('\n=== Step 4: real redemption via the fixed REDEEM_SCRIPT ===')
  const redemption = await redeemAccessCode({ rawCode, email: TEST_EMAIL, tenantId: 'diagnostic-test-tenant', userId: 'diagnostic-test-user' })
  console.log(`Redemption result -- trialDays present: ${'trialDays' in redemption}, value: ${JSON.stringify(redemption.trialDays)}, discountPercent present: ${'discountPercent' in redemption}, value: ${JSON.stringify(redemption.discountPercent)}, discountFixedCents present: ${'discountFixedCents' in redemption}, value: ${JSON.stringify(redemption.discountFixedCents)}`)

  console.log('\n=== Step 5: post-redemption validation (existing defense-in-depth check) ===')
  try {
    buildAccessCodeCommercialWrite(redemption)
    console.log('buildAccessCodeCommercialWrite(redemption) succeeded.')
  } catch (err) {
    console.log(`buildAccessCodeCommercialWrite(redemption) threw: ${err.constructor.name}: ${err.message}`)
  }

  console.log('\n=== Step 6: re-read from storage directly (not the script return value) ===')
  const stored = await getAccessCodeByHash(codeHash)
  console.log(`Stored record -- redemptionCount: ${stored.redemptionCount}, trialDays present: ${'trialDays' in stored}, value: ${JSON.stringify(stored.trialDays)}, discountPercent present: ${'discountPercent' in stored}, discountFixedCents present: ${'discountFixedCents' in stored}, revokedAt present: ${'revokedAt' in stored}, value: ${JSON.stringify(stored.revokedAt)}`)
  console.log(`redemptions entries: ${stored.redemptions.length}, first entry tenantId: ${stored.redemptions[0]?.tenantId}`)

  console.log('\n=== Step 7: attempt a second redemption on the now-exhausted test code (failure case) ===')
  try {
    await redeemAccessCode({ rawCode, email: TEST_EMAIL, tenantId: 'diagnostic-test-tenant-2', userId: 'diagnostic-test-user-2' })
    console.log('UNEXPECTED: second redemption succeeded (should have been rejected).')
  } catch (err) {
    console.log(`Second redemption correctly rejected: ${err instanceof AccessCodeInvalidError ? 'AccessCodeInvalidError' : err.constructor.name}`)
  }

  console.log('\n=== Step 8: cleanup -- revoke the test code (no delete function exists) ===')
  const revoked = await revokeAccessCode(codeHash)
  console.log(`Final status: ${revoked.status}`)
}

main().catch(err => { console.error(err.stack || err.message); process.exitCode = 1 })
