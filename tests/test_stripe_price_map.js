// Phase B.10 -- regression tests for dashboard/api/_lib/stripePriceMap.js.
// Pure lookup logic over plans.js -- no I/O, no Stripe API.
//
// Run directly: node tests/test_stripe_price_map.js

import {
  SELF_SERVICE_PLAN_IDS, isSelfServicePlan, resolveApprovedStripePriceId, resolvePlanIdForStripePriceId,
} from '../dashboard/api/_lib/stripePriceMap.js'
import { PLANS } from '../dashboard/api/_lib/plans.js'

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

function testCoreAndGrowthAreSelfService() {
  assert(isSelfServicePlan('core'), 'core must be self-service-eligible')
  assert(isSelfServicePlan('growth'), 'growth must be self-service-eligible')
  assert(SELF_SERVICE_PLAN_IDS.includes('core') && SELF_SERVICE_PLAN_IDS.includes('growth'))
}

function testEnterpriseExcludedFromSelfService() {
  assert(!isSelfServicePlan('enterprise'), 'enterprise must NOT be self-service-eligible -- manual sales only')
  assert(resolveApprovedStripePriceId('enterprise') === null, 'enterprise must never resolve to a self-service price id')
}

function testUnconfiguredPriceFailsClosed() {
  // plans.js has stripePriceId: null for every plan as of B.10 -- no real
  // Stripe price has been created yet.
  assert(PLANS.core.stripePriceId === null && PLANS.growth.stripePriceId === null, 'sanity: no fake Stripe price ids have been populated')
  assert(resolveApprovedStripePriceId('core') === null, 'an unconfigured Core price must resolve to null (fail closed), never a fabricated id')
  assert(resolveApprovedStripePriceId('growth') === null, 'an unconfigured Growth price must resolve to null (fail closed)')
}

function testUnknownOrArbitraryPlanIdNeverResolves() {
  assert(resolveApprovedStripePriceId('not_a_real_plan') === null, 'an unrecognized plan id must resolve to null, never throw or fabricate a price')
  assert(resolveApprovedStripePriceId(undefined) === null)
  assert(resolveApprovedStripePriceId(null) === null)
}

function testReversePriceLookupNeverInventsAPlan() {
  assert(resolvePlanIdForStripePriceId('price_totally_made_up') === null, 'an arbitrary/unrecognized price id must never resolve to a plan')
  assert(resolvePlanIdForStripePriceId('') === null)
  assert(resolvePlanIdForStripePriceId(null) === null)
}

function testNullNeverMatchesAnUnconfiguredPriceSlot() {
  // Every plan currently has stripePriceId: null (no real Stripe price
  // exists yet) -- resolvePlanIdForStripePriceId(null) must NOT "match"
  // core/growth's own null slot and return a plan id. This is the specific
  // bug this function's `typeof stripePriceId !== 'string'` guard exists
  // to prevent.
  assert(resolvePlanIdForStripePriceId(null) === null, 'null must never match an unconfigured (also null) price slot')
}

const tests = [
  ['Core and Growth are self-service-eligible', testCoreAndGrowthAreSelfService],
  ['Enterprise is excluded from self-service', testEnterpriseExcludedFromSelfService],
  ['an unconfigured price fails closed (null), never fabricated', testUnconfiguredPriceFailsClosed],
  ['an unknown/arbitrary plan id never resolves to a price', testUnknownOrArbitraryPlanIdNeverResolves],
  ['an arbitrary price id never resolves to a plan', testReversePriceLookupNeverInventsAPlan],
  ['null never matches an unconfigured price slot', testNullNeverMatchesAnUnconfiguredPriceSlot],
]

for (const [name, fn] of tests) run(name, fn)
const failed = results.filter(r => !r).length
if (failed > 0) {
  console.log(`\n${failed} of ${tests.length} TESTS FAILED`)
  process.exit(1)
}
console.log(`\nALL ${tests.length} TESTS PASSED`)
