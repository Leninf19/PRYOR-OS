// Regression test for dashboard/api/_lib/plans.js -- pure pricing/display
// metadata, deliberately never imported by permissions.js/auth.js/any
// authorization function (see that file's own header). This guards ONLY
// against the approved pricing table drifting; it proves nothing about
// authorization/limits -- that's planEntitlements.js's job (see
// tests/test_entitlements.js).
//
// Run directly: node tests/test_plans.js

import { PLANS, isValidPlanId } from '../dashboard/api/_lib/plans.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
function run(name, fn) {
  try {
    fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  }
}

function testCorePriceIsApproved() {
  assert(PLANS.core.priceCents === 14900, `Core must be $149.00/month (14900 cents), got ${PLANS.core.priceCents}`)
}

function testGrowthPriceIsApproved() {
  // Phase B.2 pre-commit correction: product decision finalized Growth at
  // $249/month -- this is the exact regression guard requested for that
  // correction.
  assert(PLANS.growth.priceCents === 24900, `Growth must be $249.00/month (24900 cents), got ${PLANS.growth.priceCents}`)
}

function testEnterpriseHasNoHardcodedPublicPrice() {
  assert(PLANS.enterprise.priceCents === null, 'Enterprise must stay contact-sales, no hardcoded public starting price required for entitlement enforcement')
  assert(PLANS.enterprise.contactSales === true, 'Enterprise must be flagged contactSales')
}

function testBillingPeriodsAreMonthlyForPricedPlans() {
  assert(PLANS.core.billingPeriod === 'month', PLANS.core.billingPeriod)
  assert(PLANS.growth.billingPeriod === 'month', PLANS.growth.billingPeriod)
}

function testIsValidPlanIdAgreesWithTable() {
  assert(isValidPlanId('core') && isValidPlanId('growth') && isValidPlanId('enterprise'), 'every real plan id must validate')
  assert(isValidPlanId('bogus') === false, 'an unrecognized plan id must be rejected')
  assert(isValidPlanId(undefined) === false && isValidPlanId(null) === false, 'non-string input must be rejected, not throw')
}

function testPlansTableIsFrozen() {
  assert(Object.isFrozen(PLANS), 'PLANS must stay frozen -- pricing metadata must never be mutated at runtime')
}

const tests = [
  ['Core priceCents matches the approved pricing model ($149)', testCorePriceIsApproved],
  ['Growth priceCents matches the approved pricing model ($249, corrected from $349)', testGrowthPriceIsApproved],
  ['Enterprise has no hardcoded public starting price, stays contact-sales', testEnterpriseHasNoHardcodedPublicPrice],
  ['priced plans bill monthly', testBillingPeriodsAreMonthlyForPricedPlans],
  ['isValidPlanId agrees exactly with the PLANS table', testIsValidPlanIdAgreesWithTable],
  ['PLANS is frozen', testPlansTableIsFrozen],
]

function main() {
  for (const [name, fn] of tests) run(name, fn)
  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
