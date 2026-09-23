#!/usr/bin/env node
// Read-only diagnostic for a specific registration access-code redemption
// failure. Answers exactly the 5 verification questions the operator asked
// -- code exists / status+redemptionCount / allowedEmail match / account or
// tenant created / whether the stored settings pass the deployed
// commercial-state validators -- as booleans and enums, NOT as raw record
// dumps. Deliberately never prints allowedEmail, codeHash, userId, or any
// other identifying field: only derived pass/fail answers.
//
// Reuses ONLY existing, already-exported functions -- accessCodeStore.js's
// listAccessCodes()/getAccessCodeRedemptionClaim()/isValidTrialDays()/
// isValidDiscountPercent()/isValidDiscountFixedCents() (the SAME validators
// buildAccessCodeCommercialWrite() calls in production, re-run here against
// the live stored record rather than re-implemented), pendingRegistrationStore.js's
// getPendingRegistration(), accountStore.js's getAccountByEmail().
//
// Makes NO writes: no revoke, no reset, no redemption. Requires
// UPSTASH_REDIS_REST_URL/TOKEN in the environment (GitHub Actions secret,
// same as every other operator diagnostic in this repo).
//
// Usage: node access_code_diagnostic.mjs --email lenin@futuremark.studio --label "Blue Seafood & Grill"

import {
  listAccessCodes, getAccessCodeRedemptionClaim,
  isValidTrialDays, isValidDiscountPercent, isValidDiscountFixedCents,
} from './dashboard/api/_lib/accessCodeStore.js'
import { getPendingRegistration } from './dashboard/api/_lib/pendingRegistrationStore.js'
import { getAccountByEmail } from './dashboard/api/_lib/accountStore.js'

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i++ }
  }
  return flags
}

async function main() {
  const { email, label } = parseArgs(process.argv.slice(2))
  if (!email) { console.error('Usage: node access_code_diagnostic.mjs --email <email> [--label <clientLabel>]'); process.exitCode = 1; return }

  console.log('=== 1. Code existence + 2. status/redemption count ===')
  try {
    const codes = await listAccessCodes()
    const matches = codes.filter(c => (label && c.label === label) || c.allowedEmail === email)
    console.log(JSON.stringify({ matchCount: matches.length }, null, 2))
    for (const c of matches) {
      const dupSuffix = matches.length > 1 ? ` [match ${matches.indexOf(c) + 1}/${matches.length}]` : ''
      console.log(`--- code${dupSuffix} ---`)
      console.log(JSON.stringify({
        status: c.status,
        redemptionCount: c.redemptionCount,
        maxRedemptions: c.maxRedemptions,
        paymentRequired: c.paymentRequired,
        expired: c.expiresAt ? new Date(c.expiresAt).getTime() < Date.now() : false,
        revoked: Boolean(c.revokedAt),
        // 3. does the allowedEmail on file match the email under
        // investigation -- boolean only, the email itself is never printed.
        allowedEmailMatchesInvestigatedEmail: c.allowedEmail == null ? null : c.allowedEmail === email,
        hasAllowedEmailRestriction: c.allowedEmail != null,
        // 5. re-run the SAME validators buildAccessCodeCommercialWrite()
        // calls in production against this stored record.
        commercialWriteValidation: {
          trialDaysValid: isValidTrialDays(c.trialDays),
          trialDaysType: typeof c.trialDays,
          discountPercentValid: isValidDiscountPercent(c.discountPercent),
          discountPercentType: typeof c.discountPercent,
          discountFixedCentsValid: isValidDiscountFixedCents(c.discountFixedCents),
          discountFixedCentsType: typeof c.discountFixedCents,
          bothDiscountFieldsSetSimultaneously: c.discountPercent != null && c.discountFixedCents != null,
          wouldPassBuildAccessCodeCommercialWrite:
            !c.paymentRequired
            && isValidTrialDays(c.trialDays)
            && isValidDiscountPercent(c.discountPercent)
            && isValidDiscountFixedCents(c.discountFixedCents)
            && !(c.discountPercent != null && c.discountFixedCents != null),
        },
        // tenantId is only populated once a code is actually redeemed into
        // a real tenant -- presence/absence answers part of Q4 without
        // printing the tenant id itself.
        redeemedIntoATenant: Boolean(c.tenantId),
      }, null, 2))
    }
  } catch (err) {
    console.log(`Could not list access codes: ${err.message}`)
  }

  console.log('\n=== 4a. Redemption claim recorded for this email ===')
  try {
    const claim = await getAccessCodeRedemptionClaim(email)
    console.log(JSON.stringify({ redemptionClaimExists: Boolean(claim) }, null, 2))
  } catch (err) {
    console.log(`Could not read redemption claim: ${err.message}`)
  }

  console.log('\n=== 4b. Pending registration for this email ===')
  try {
    const pending = await getPendingRegistration(email)
    console.log(JSON.stringify({
      pendingRegistrationExists: Boolean(pending),
      status: pending?.status ?? null,
      emailVerified: pending?.emailVerified ?? null,
    }, null, 2))
  } catch (err) {
    console.log(`Could not read pending registration: ${err.message}`)
  }

  console.log('\n=== 4c. Real account for this email ===')
  try {
    const account = await getAccountByEmail(email)
    console.log(JSON.stringify({
      accountExists: Boolean(account),
      disabled: account?.disabled ?? null,
    }, null, 2))
  } catch (err) {
    console.log(`Could not read account: ${err.message}`)
  }
}

main().catch(err => { console.error(err.stack || err.message); process.exitCode = 1 })
