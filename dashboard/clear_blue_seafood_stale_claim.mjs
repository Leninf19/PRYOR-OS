#!/usr/bin/env node
// One-off, narrowly-scoped cleanup: removes ONLY the stale access-code
// redemption claim for lenin@futuremark.studio (access_code_redemption_claims:v1:...),
// which was blocking the valid replacement code from ever being looked at
// -- redeemAccessCodeAction() (session/[action].js:2012-2021) checks this
// claim FIRST, keyed only by email, and resumes from it before ever
// reading the code the caller actually submitted.
//
// Immediately before the write, re-verifies every fact this cleanup
// depends on and ABORTS without writing anything if any of them changed:
//   1. The claim still points to the original (consumed) code, not the
//      replacement.
//   2. No account exists for this email.
//   3. No tenant was created from the reserved pending-registration id.
//   4. The replacement code still has redemptionCount 0 and is active.
//
// The ONLY write is clearAccessCodeRedemptionClaim(email) -- deletes a
// single string key. Never touches access_codes:v1 (either code record),
// never resets a redemption count, never redeems anything, never prints
// the raw code.

import { listAccessCodes, getAccessCodeRedemptionClaim, clearAccessCodeRedemptionClaim } from './api/_lib/accessCodeStore.js'
import { getPendingRegistration } from './api/_lib/pendingRegistrationStore.js'
import { getAccountByEmail } from './api/_lib/accountStore.js'
import { getTenantConfig } from './api/_lib/tenantConfigStore.js'

const TARGET_EMAIL = 'lenin@futuremark.studio'
const CLIENT_LABEL = 'Blue Seafood & Grill'

function abort(reason) {
  console.log(`ABORT -- ${reason}. No write performed.`)
  process.exitCode = 1
}

async function main() {
  console.log('=== Pre-write verification ===')

  const claim = await getAccessCodeRedemptionClaim(TARGET_EMAIL)
  if (!claim) return abort('no redemption claim exists for this email -- nothing to clear')

  const matches = (await listAccessCodes()).filter(c => c.allowedEmail === TARGET_EMAIL && c.clientLabel === CLIENT_LABEL)
  const claimedCode = matches.find(c => c.codeHash === claim.codeHash)
  if (!claimedCode) return abort('the claim points to a code that no longer matches this email/label -- refusing to guess')
  if (claimedCode.redemptionCount < 1) return abort('the claimed code has redemptionCount 0 -- it does not look like the failed original code, refusing to clear')
  console.log(`Claim points to a code with redemptionCount ${claimedCode.redemptionCount}/${claimedCode.maxRedemptions} -- consistent with the original failed code.`)

  const others = matches.filter(c => c.codeHash !== claim.codeHash)
  const replacement = others.find(c => c.redemptionCount === 0 && c.status === 'active')
  if (!replacement) return abort('could not find a distinct, active, unredeemed replacement code -- refusing to clear')
  console.log(`Replacement code confirmed distinct from the claimed code, status active, redemptionCount 0.`)

  const account = await getAccountByEmail(TARGET_EMAIL)
  if (account) return abort('an account now exists for this email -- refusing to clear, state has changed')
  console.log('Confirmed: no account exists for this email.')

  const pending = await getPendingRegistration(TARGET_EMAIL)
  const tenantConfig = pending?.tenantIdReserved ? await getTenantConfig(pending.tenantIdReserved) : null
  if (tenantConfig) return abort('a tenant now exists for this registration -- refusing to clear, state has changed')
  console.log('Confirmed: no tenant was created for this registration.')

  console.log('\n=== All pre-write facts confirmed unchanged. Clearing the stale claim only. ===')
  await clearAccessCodeRedemptionClaim(TARGET_EMAIL)

  console.log('\n=== Post-write verification ===')
  const claimAfter = await getAccessCodeRedemptionClaim(TARGET_EMAIL)
  console.log(`Claim now absent: ${claimAfter === null}`)

  const codesAfter = (await listAccessCodes()).filter(c => c.codeHash === replacement.codeHash)
  const replacementAfter = codesAfter[0]
  console.log(`Replacement code -- status: ${replacementAfter.status}, redemptionCount: ${replacementAfter.redemptionCount}/${replacementAfter.maxRedemptions}`)
}

main().catch(err => { console.error(err.stack || err.message); process.exitCode = 1 })
