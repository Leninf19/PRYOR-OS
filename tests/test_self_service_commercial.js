// Phase B.11 pre-commit correction (Part 2) -- regression tests for
// dashboard/api/_lib/selfServiceCommercial.js. Pure -- no I/O -- so every
// test is a plain function call/assertion.
//
// Run directly: node tests/test_self_service_commercial.js

import {
  buildSelfServicePendingActivationCommercial, selfServiceTrialEligibilitySourceIsCanonical, SELF_SERVICE_TRIAL_DAYS,
} from '../dashboard/api/_lib/selfServiceCommercial.js'
import { COMMERCIAL_STATUSES } from '../dashboard/api/_lib/entitlementResolution.js'
import { TRIAL_ELIGIBILITY_SOURCES } from '../dashboard/api/_lib/trialLifecycle.js'

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

function testCommercialIsNeverNull() {
  const { commercial } = buildSelfServicePendingActivationCommercial()
  assert(commercial !== null && typeof commercial === 'object', 'the self-service pending write must never be null -- that is exactly the legacy-unmanaged hole this module exists to close')
}

function testCommercialStatusIsExplicitPendingActivation() {
  const { commercial } = buildSelfServicePendingActivationCommercial()
  assert(commercial.commercialStatus === 'trial_pending_activation')
  assert(COMMERCIAL_STATUSES.includes(commercial.commercialStatus), 'must be a real, resolver-recognized status')
}

function testPlanIsAlwaysGrowthRegardlessOfPostTrialChoice() {
  // buildSelfServicePendingActivationCommercial() takes no arguments at
  // all -- the trial EXPERIENCE is always Growth; the customer's
  // post-trial plan choice lives entirely in the billing record's
  // pendingPaidPlan, never here.
  const { commercial } = buildSelfServicePendingActivationCommercial()
  assert(commercial.plan === 'growth')
}

function testPlanSourceIsSelfServiceNeverAccessCode() {
  const { commercial, trialEligibility } = buildSelfServicePendingActivationCommercial()
  assert(commercial.planSource === 'self_service_trial')
  assert(commercial.planSource !== 'access_code_trial')
  assert(trialEligibility.source === 'self_service_registration')
  assert(trialEligibility.source !== 'test_fixture', 'the real production writer must never use the test-only provenance value')
}

function testNoTrialObjectYetAndNoAccessCodeFields() {
  const { commercial } = buildSelfServicePendingActivationCommercial()
  assert(commercial.trial === null, 'the real, dated trial object is only written later by maybeStartTrial()')
  assert(commercial.accessCodeHash === null && commercial.discountPercent === null && commercial.discountFixedCents === null)
}

function testTrialEligibilityShapeIsComplete() {
  const { trialEligibility } = buildSelfServicePendingActivationCommercial()
  assert(trialEligibility.eligible === true)
  assert(typeof trialEligibility.markedAt === 'string' && !Number.isNaN(Date.parse(trialEligibility.markedAt)))
  assert(Object.keys(trialEligibility).sort().join(',') === 'eligible,markedAt,source')
}

function testCommercialAndTrialEligibilityShareTheSameTimestampMoment() {
  const before = Date.now()
  const { commercial, trialEligibility } = buildSelfServicePendingActivationCommercial()
  const after = Date.now()
  const commercialMs = Date.parse(commercial.createdAt)
  const eligibilityMs = Date.parse(trialEligibility.markedAt)
  assert(commercialMs >= before && commercialMs <= after)
  assert(eligibilityMs >= before && eligibilityMs <= after)
}

function testSourceIsCanonical() {
  assert(selfServiceTrialEligibilitySourceIsCanonical() === true)
  assert(TRIAL_ELIGIBILITY_SOURCES.includes('self_service_registration'))
}

function testSelfServiceTrialDaysIsSeven() {
  assert(SELF_SERVICE_TRIAL_DAYS === 7)
}

function testFunctionIsPureNoArgumentsNoIo() {
  const a = buildSelfServicePendingActivationCommercial()
  const b = buildSelfServicePendingActivationCommercial()
  // Timestamps will differ by microseconds -- compare everything else.
  assert(a.commercial.commercialStatus === b.commercial.commercialStatus)
  assert(a.commercial.plan === b.commercial.plan && a.commercial.planSource === b.commercial.planSource)
  assert(a.trialEligibility.source === b.trialEligibility.source)
  assert(buildSelfServicePendingActivationCommercial.length === 0, 'must accept no parameters -- nothing to spoof')
}

const tests = [
  ['commercial is never null', testCommercialIsNeverNull],
  ['commercialStatus is the explicit trial_pending_activation status', testCommercialStatusIsExplicitPendingActivation],
  ['plan is always growth regardless of post-trial choice', testPlanIsAlwaysGrowthRegardlessOfPostTrialChoice],
  ['planSource is self_service_trial, never access_code_trial', testPlanSourceIsSelfServiceNeverAccessCode],
  ['no trial object yet, no access-code fields', testNoTrialObjectYetAndNoAccessCodeFields],
  ['trialEligibility shape is complete', testTrialEligibilityShapeIsComplete],
  ['commercial and trialEligibility share the same timestamp moment', testCommercialAndTrialEligibilityShareTheSameTimestampMoment],
  ['the trialEligibility source is canonical', testSourceIsCanonical],
  ['SELF_SERVICE_TRIAL_DAYS is 7', testSelfServiceTrialDaysIsSeven],
  ['the builder is pure -- no arguments, no I/O', testFunctionIsPureNoArgumentsNoIo],
]

for (const [name, fn] of tests) run(name, fn)
const failed = results.filter(r => !r).length
if (failed > 0) {
  console.log(`\n${failed} of ${tests.length} TESTS FAILED`)
  process.exit(1)
}
console.log(`\nALL ${tests.length} TESTS PASSED`)
