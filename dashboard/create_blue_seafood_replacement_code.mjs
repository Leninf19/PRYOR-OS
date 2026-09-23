#!/usr/bin/env node
// One-off remediation script: creates EXACTLY ONE replacement registration
// access code for lenin@futuremark.studio, using the identical settings
// originally requested (see the 2026-09-23 incident), now that
// accessCodeStore.js's REDEEM_SCRIPT null-encoding bug and the
// burn-before-validate ordering are both fixed and verified against the
// real backend.
//
// Settings are hardcoded (not workflow_dispatch inputs) -- this is a
// precise, one-time, auditable replacement for a specific known failure,
// not a general-purpose "mint any code" tool.
//
// Safety: aborts without creating anything if an account or tenant already
// exists for this email (re-checks immediately before creating, to avoid a
// race between a separate check and this create). The raw code is written
// ONLY to a local file for the workflow to upload as an artifact -- it is
// NEVER printed to stdout/stderr/the log, matching accessCodeStore.js's
// own header: "the raw code is generated here, returned to the caller...
// EXACTLY ONCE at creation, and never persisted or retrievable again in
// any form."

import { writeFileSync } from 'node:fs'
import { createAccessCode, previewAccessCode, isValidTrialDays, isValidDiscountPercent, isValidDiscountFixedCents } from './api/_lib/accessCodeStore.js'
import { getPendingRegistration } from './api/_lib/pendingRegistrationStore.js'
import { getAccountByEmail } from './api/_lib/accountStore.js'

const TARGET_EMAIL = 'lenin@futuremark.studio'
const OUTPUT_FILE = 'replacement-code.txt'

async function main() {
  console.log(`=== Pre-create safety check: confirming no account/tenant exists for ${TARGET_EMAIL} ===`)
  const account = await getAccountByEmail(TARGET_EMAIL)
  if (account) {
    console.log('ABORT: an account already exists for this email. Not creating a replacement code.')
    process.exitCode = 1
    return
  }
  const pending = await getPendingRegistration(TARGET_EMAIL)
  console.log(`accountExists: false, pendingRegistrationStatus: ${pending?.status ?? 'none'} (expected: verified_awaiting_plan, unchanged from before)`)

  console.log('\n=== Creating the replacement code ===')
  const { rawCode, record } = await createAccessCode({
    prefix: 'PRYOR-GROWTH',
    plan: 'growth',
    paymentRequired: false,
    trialDays: null,
    expiresAt: '2026-10-22T00:00:00.000Z',
    maxRedemptions: 1,
    allowedEmail: TARGET_EMAIL,
    clientLabel: 'Blue Seafood & Grill',
    createdBy: 'operator_cli',
  })
  console.log('Created (raw code withheld from this log -- see the uploaded artifact).')

  console.log('\n=== Verifying stored fields via previewAccessCode() (the same read path redemption uses) ===')
  const preview = await previewAccessCode({ rawCode, email: TARGET_EMAIL })
  console.log(JSON.stringify({
    plan: preview.plan,
    paymentRequired: preview.paymentRequired,
    trialDaysValid: isValidTrialDays(preview.trialDays),
    discountPercentValid: isValidDiscountPercent(preview.discountPercent),
    discountFixedCentsValid: isValidDiscountFixedCents(preview.discountFixedCents),
  }, null, 2))
  console.log(JSON.stringify({
    status: record.status,
    redemptionCount: record.redemptionCount,
    maxRedemptions: record.maxRedemptions,
    expiresAt: record.expiresAt,
    allowedEmailMatches: record.allowedEmail === TARGET_EMAIL,
  }, null, 2))

  writeFileSync(OUTPUT_FILE, `${rawCode}\nRestricted to: ${TARGET_EMAIL}\nExpires: ${record.expiresAt}\nSingle use -- delete this file once you have saved the code.\n`)
  console.log(`\nRaw code written to ${OUTPUT_FILE} for artifact upload only (never logged).`)
}

main().catch(err => { console.error(err.stack || err.message); process.exitCode = 1 })
