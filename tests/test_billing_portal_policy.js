// Phase B.10 -- regression tests for
// dashboard/api/_lib/billingPortalPolicy.js. No Portal Session is created
// anywhere -- this only guards the locked policy constants themselves.
//
// Run directly: node tests/test_billing_portal_policy.js

import {
  BILLING_PORTAL_ALLOWED_ACTIONS, BILLING_PORTAL_DISALLOWED_ACTIONS, isBillingPortalActionAllowed,
} from '../dashboard/api/_lib/billingPortalPolicy.js'

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

function testAllowedActions() {
  for (const action of ['update_payment_method', 'view_invoice_history', 'cancel_at_period_end']) {
    assert(isBillingPortalActionAllowed(action), `${action} must be allowed in the Portal`)
  }
}

function testDisallowedActions() {
  for (const action of ['change_plan', 'change_price', 'apply_promotion_code', 'change_quantity', 'cancel_immediately']) {
    assert(!isBillingPortalActionAllowed(action), `${action} must NOT be allowed in the Portal`)
  }
}

function testNoOverlapBetweenAllowedAndDisallowed() {
  const overlap = BILLING_PORTAL_ALLOWED_ACTIONS.filter(a => BILLING_PORTAL_DISALLOWED_ACTIONS.includes(a))
  assert(overlap.length === 0, `allowed/disallowed lists must never overlap: ${overlap.join(', ')}`)
}

function testPlanChangesAreExplicitlyDisallowed() {
  assert(!isBillingPortalActionAllowed('change_plan'), 'plan changes must stay inside PRYOR\'s own UI so the downgrade-grace policy can be enforced server-side before Stripe is ever called')
}

function testUnknownActionIsNotAllowed() {
  assert(!isBillingPortalActionAllowed('something_made_up'), 'an unrecognized action must default to NOT allowed')
}

const tests = [
  ['payment method / invoices / cancellation are allowed', testAllowedActions],
  ['plan/price/quantity/promo changes and immediate cancel are disallowed', testDisallowedActions],
  ['allowed and disallowed lists never overlap', testNoOverlapBetweenAllowedAndDisallowed],
  ['plan changes are explicitly excluded from the Portal', testPlanChangesAreExplicitlyDisallowed],
  ['an unrecognized action defaults to not allowed', testUnknownActionIsNotAllowed],
]

for (const [name, fn] of tests) run(name, fn)
const failed = results.filter(r => !r).length
if (failed > 0) {
  console.log(`\n${failed} of ${tests.length} TESTS FAILED`)
  process.exit(1)
}
console.log(`\nALL ${tests.length} TESTS PASSED`)
