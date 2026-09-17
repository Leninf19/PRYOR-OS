// Phase B.10/B.12 -- regression tests for dashboard/api/_lib/stripePriceMap.js.
// Pure lookup logic -- no I/O, no Stripe API. Phase B.12: price identity now
// comes from STRIPE_CORE_PRICE_ID/STRIPE_GROWTH_PRICE_ID env vars, not
// plans.js's static (still-null) stripePriceId field.
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
  } finally {
    delete process.env.STRIPE_CORE_PRICE_ID
    delete process.env.STRIPE_GROWTH_PRICE_ID
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

// ===========================================================================
// Phase B.12 -- STRIPE_CORE_PRICE_ID/STRIPE_GROWTH_PRICE_ID env-var mapping.
// ===========================================================================

function testCoreResolvesOnlyFromItsOwnEnvVar() {
  process.env.STRIPE_CORE_PRICE_ID = 'price_coreabc123'
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthxyz789'
  assert(resolveApprovedStripePriceId('core') === 'price_coreabc123')
  assert(resolveApprovedStripePriceId('core') !== 'price_growthxyz789', 'Core must never resolve to the Growth price')
}

function testGrowthResolvesOnlyFromItsOwnEnvVar() {
  process.env.STRIPE_CORE_PRICE_ID = 'price_coreabc123'
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthxyz789'
  assert(resolveApprovedStripePriceId('growth') === 'price_growthxyz789')
  assert(resolveApprovedStripePriceId('growth') !== 'price_coreabc123', 'Growth must never resolve to the Core price')
}

function testEnterpriseNeverReadsAnyPriceEnvVar() {
  process.env.STRIPE_CORE_PRICE_ID = 'price_coreabc123'
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthxyz789'
  assert(resolveApprovedStripePriceId('enterprise') === null, 'Enterprise must never resolve to a self-service price, no matter what is configured')
}

function testMalformedEnvValueFailsClosed() {
  // Does not even look like a real Stripe price id (e.g. a copy/paste
  // mistake of a Customer or Secret Key id) -- must fail closed, never be
  // passed through to Stripe as-is.
  process.env.STRIPE_CORE_PRICE_ID = 'cus_notAPriceId'
  assert(resolveApprovedStripePriceId('core') === null, 'a malformed env value must fail closed (null), never be trusted as a real price id')
}

function testMissingEnvVarFailsClosedIndependently() {
  process.env.STRIPE_CORE_PRICE_ID = 'price_coreabc123'
  // STRIPE_GROWTH_PRICE_ID deliberately left unset.
  assert(resolveApprovedStripePriceId('growth') === null, 'a missing Growth price env var must fail closed independently of Core being configured')
  assert(resolveApprovedStripePriceId('core') === 'price_coreabc123', 'Core must still resolve correctly even while Growth is unconfigured')
}

function testReverseLookupTracksTheLiveEnvMapping() {
  process.env.STRIPE_CORE_PRICE_ID = 'price_coreabc123'
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growthxyz789'
  assert(resolvePlanIdForStripePriceId('price_coreabc123') === 'core')
  assert(resolvePlanIdForStripePriceId('price_growthxyz789') === 'growth')
}

const tests = [
  ['Core and Growth are self-service-eligible', testCoreAndGrowthAreSelfService],
  ['Enterprise is excluded from self-service', testEnterpriseExcludedFromSelfService],
  ['an unconfigured price fails closed (null), never fabricated', testUnconfiguredPriceFailsClosed],
  ['an unknown/arbitrary plan id never resolves to a price', testUnknownOrArbitraryPlanIdNeverResolves],
  ['an arbitrary price id never resolves to a plan', testReversePriceLookupNeverInventsAPlan],
  ['null never matches an unconfigured price slot', testNullNeverMatchesAnUnconfiguredPriceSlot],
  ['Core resolves only from STRIPE_CORE_PRICE_ID', testCoreResolvesOnlyFromItsOwnEnvVar],
  ['Growth resolves only from STRIPE_GROWTH_PRICE_ID', testGrowthResolvesOnlyFromItsOwnEnvVar],
  ['Enterprise never reads any price env var', testEnterpriseNeverReadsAnyPriceEnvVar],
  ['a malformed env value fails closed', testMalformedEnvValueFailsClosed],
  ['a missing env var fails closed independently per plan', testMissingEnvVarFailsClosedIndependently],
  ['the reverse lookup tracks the live env mapping', testReverseLookupTracksTheLiveEnvMapping],
]

for (const [name, fn] of tests) run(name, fn)
const failed = results.filter(r => !r).length
if (failed > 0) {
  console.log(`\n${failed} of ${tests.length} TESTS FAILED`)
  process.exit(1)
}
console.log(`\nALL ${tests.length} TESTS PASSED`)
