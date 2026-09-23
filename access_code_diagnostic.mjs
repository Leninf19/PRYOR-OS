#!/usr/bin/env node
// Read-only diagnostic for a specific registration access-code redemption
// failure. Reuses ONLY existing, already-exported store functions --
// accessCodeStore.js's listAccessCodes()/getAccessCodeRedemptionClaim(),
// pendingRegistrationStore.js's getPendingRegistration(), accountStore.js's
// getAccountByEmail() -- never a hand-rolled Redis write, never a raw code
// or codeHash printed (codeHash from listAccessCodes() is itself a
// one-way hash, safe to display, same convention as complimentary-code.js's
// own `list` command).
//
// Makes NO writes: no revoke, no reset, no redemption. Requires
// UPSTASH_REDIS_REST_URL/TOKEN in the environment (GitHub Actions secret,
// same as every other operator diagnostic in this repo).
//
// Usage: node access_code_diagnostic.mjs --email lenin@futuremark.studio --label "Blue Seafood & Grill"

import {
  listAccessCodes, getAccessCodeRedemptionClaim,
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

  console.log('=== Matching access codes (by clientLabel or allowedEmail) ===')
  try {
    const codes = await listAccessCodes()
    const matches = codes.filter(c => (label && c.label === label) || c.allowedEmail === email)
    if (matches.length === 0) {
      console.log('No access codes found matching that label/email.')
    }
    for (const c of matches) {
      console.log(JSON.stringify({
        codeHash: c.codeHash,
        label: c.label,
        plan: c.planId ?? c.plan,
        paymentRequired: c.paymentRequired,
        trialDays: c.trialDays,
        // Deliberately reporting typeof, not just the value -- distinguishes
        // a genuine `null` from an absent/undefined field, which is exactly
        // the class of bug this investigation is checking for.
        discountPercent: c.discountPercent, discountPercentType: typeof c.discountPercent,
        discountFixedCents: c.discountFixedCents, discountFixedCentsType: typeof c.discountFixedCents,
        allowedEmail: c.allowedEmail,
        allowedEmailDomain: c.allowedEmailDomain,
        maxRedemptions: c.maxRedemptions,
        redemptionCount: c.redemptionCount,
        status: c.status,
        expiresAt: c.expiresAt,
        createdAt: c.createdAt,
        createdBy: c.createdBy,
        revokedAt: c.revokedAt ?? null,
        tenantId: c.tenantId ?? null,
        redeemedAt: c.redeemedAt ?? null,
      }, null, 2))
    }
  } catch (err) {
    console.log(`Could not list access codes: ${err.message}`)
  }

  console.log('\n=== Redemption claim for this email ===')
  try {
    const claim = await getAccessCodeRedemptionClaim(email)
    console.log(claim ? JSON.stringify({ codeHash: claim.codeHash, claimedAt: claim.claimedAt }, null, 2) : 'No redemption claim exists for this email.')
  } catch (err) {
    console.log(`Could not read redemption claim: ${err.message}`)
  }

  console.log('\n=== Pending registration for this email ===')
  try {
    const pending = await getPendingRegistration(email)
    console.log(pending ? JSON.stringify({
      status: pending.status, tenantIdReserved: pending.tenantIdReserved,
      emailVerified: pending.emailVerified, createdAt: pending.createdAt, verifiedAt: pending.verifiedAt ?? null,
    }, null, 2) : 'No pending registration exists for this email.')
  } catch (err) {
    console.log(`Could not read pending registration: ${err.message}`)
  }

  console.log('\n=== Real account for this email ===')
  try {
    const account = await getAccountByEmail(email)
    console.log(account ? JSON.stringify({ userId: account.userId, role: account.role, disabled: account.disabled }, null, 2) : 'No account exists for this email.')
  } catch (err) {
    console.log(`Could not read account: ${err.message}`)
  }
}

main().catch(err => { console.error(err.stack || err.message); process.exitCode = 1 })
