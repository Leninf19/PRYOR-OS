// Phase B.10 -- regression tests for
// dashboard/api/_lib/billingStatusProjection.js. This is a PURE mapping
// helper -- no I/O, no writes -- so every test here is a plain function
// call/assertion, no Redis/Stripe injection needed.
//
// Phase B.10 pre-commit correction: 'trialing' no longer authoritatively
// maps to 'trial' -- it now returns commercialStatus: null (shouldWrite:
// false), identical in write-behavior to 'incomplete'/'incomplete_expired',
// plus a distinct `confirmation: 'provider_trialing'` signal reserved for a
// future, deliberately-written B.11/B.12 reconciliation step. See this
// test file's own assertions below for the exact locked contract.
//
// Run directly: node tests/test_billing_status_projection.js

import {
  projectProviderStatusToCommercialStatus, everyMappedStatusIsCanonical,
} from '../dashboard/api/_lib/billingStatusProjection.js'
import { COMMERCIAL_STATUSES } from '../dashboard/api/_lib/entitlementResolution.js'

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

// commercialStatus expectations only -- 'trialing' is deliberately absent
// from "writes a real status" territory now; it is covered by its own
// dedicated tests below instead.
const EXPECTED_COMMERCIAL_STATUS = {
  incomplete: null,
  incomplete_expired: null,
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
  unpaid: 'suspended',
  paused: 'suspended',
}

function testLockedMappingTableExcludingTrialing() {
  for (const [status, expected] of Object.entries(EXPECTED_COMMERCIAL_STATUS)) {
    const { commercialStatus } = projectProviderStatusToCommercialStatus(status)
    assert(commercialStatus === expected, `${status} must map to ${JSON.stringify(expected)}, got ${JSON.stringify(commercialStatus)}`)
  }
}

function testProviderTrialingCannotAuthoritativelyReturnPryorTrial() {
  const result = projectProviderStatusToCommercialStatus('trialing')
  assert(result.commercialStatus === null, `trialing must NEVER return commercialStatus: 'trial' (or any other real status) -- got ${JSON.stringify(result.commercialStatus)}`)
  assert(result.shouldWrite === false, 'trialing must never be marked shouldWrite -- a naive "if (shouldWrite) write it" caller must be structurally unable to create a PRYOR trial from this alone')
  assert(result.confirmation === 'provider_trialing', 'trialing must still surface a distinct, explicit confirmation signal for a future deliberate reconciliation step')
}

function testTrialingProducesNoTrialTimestamps() {
  const result = projectProviderStatusToCommercialStatus('trialing')
  const keys = Object.keys(result)
  assert(!keys.includes('trialStartedAt') && !keys.includes('trialEndsAt') && !keys.includes('trialConsumedAt'),
    'trialing must never carry any trial-timestamp field -- it is structurally incapable of starting/extending a PRYOR trial clock')
}

function testActiveStillProjectsToActive() {
  const result = projectProviderStatusToCommercialStatus('active')
  assert(result.commercialStatus === 'active' && result.shouldWrite === true && result.confirmation === null)
}

function testPastDueStillProjectsToPastDue() {
  const result = projectProviderStatusToCommercialStatus('past_due')
  assert(result.commercialStatus === 'past_due' && result.shouldWrite === true && result.confirmation === null)
}

function testCanceledStillProjectsToCanceled() {
  const result = projectProviderStatusToCommercialStatus('canceled')
  assert(result.commercialStatus === 'canceled' && result.shouldWrite === true && result.confirmation === null)
}

function testUnpaidAndPausedStillProjectToSuspended() {
  for (const status of ['unpaid', 'paused']) {
    const result = projectProviderStatusToCommercialStatus(status)
    assert(result.commercialStatus === 'suspended' && result.shouldWrite === true && result.confirmation === null, `${status} must still project to suspended`)
  }
}

function testIncompleteStatusesRemainNoWrite() {
  for (const status of ['incomplete', 'incomplete_expired']) {
    const result = projectProviderStatusToCommercialStatus(status)
    assert(result.commercialStatus === null && result.shouldWrite === false && result.confirmation === null, `${status} must remain a no-write, no-confirmation status`)
  }
}

function testInvalidProviderStatusFailsClosed() {
  let threw = null
  try { projectProviderStatusToCommercialStatus('not_a_real_status') } catch (err) { threw = err }
  assert(threw instanceof TypeError, 'an unrecognized provider status must throw TypeError, never silently map to something')
}

function testNoNewCommercialStatusesAreAddedByStripeMapping() {
  assert(everyMappedStatusIsCanonical(), 'every mapped commercialStatus must already exist in entitlementResolution.js\'s own COMMERCIAL_STATUSES enum')
  for (const value of Object.values(EXPECTED_COMMERCIAL_STATUS)) {
    if (value !== null) assert(COMMERCIAL_STATUSES.includes(value), `${value} must be one of the existing COMMERCIAL_STATUSES`)
  }
}

function testOnlyTrialingEverCarriesAConfirmation() {
  for (const status of ['incomplete', 'incomplete_expired', 'active', 'past_due', 'canceled', 'unpaid', 'paused']) {
    assert(projectProviderStatusToCommercialStatus(status).confirmation === null, `${status} must never carry a confirmation value -- only 'trialing' does`)
  }
}

function testFunctionTakesNoTenantStateAndPerformsNoIo() {
  // Called with only a bare string, twice, with identical results -- proof
  // this is a pure function with no hidden dependency on tenant/store state.
  const a = projectProviderStatusToCommercialStatus('past_due')
  const b = projectProviderStatusToCommercialStatus('past_due')
  assert(JSON.stringify(a) === JSON.stringify(b), 'must be a pure function -- same input, same output, every time')
}

const tests = [
  ['locked Stripe status -> commercialStatus mapping table (excluding trialing)', testLockedMappingTableExcludingTrialing],
  ['provider trialing cannot authoritatively return a PRYOR trial', testProviderTrialingCannotAuthoritativelyReturnPryorTrial],
  ['trialing produces no trial timestamps', testTrialingProducesNoTrialTimestamps],
  ['active still projects to active', testActiveStillProjectsToActive],
  ['past_due still projects to past_due', testPastDueStillProjectsToPastDue],
  ['canceled still projects to canceled', testCanceledStillProjectsToCanceled],
  ['unpaid/paused still project to suspended', testUnpaidAndPausedStillProjectToSuspended],
  ['incomplete/incomplete_expired remain no-write, no-confirmation', testIncompleteStatusesRemainNoWrite],
  ['malformed provider status fails closed', testInvalidProviderStatusFailsClosed],
  ['no new commercialStatus values are introduced by this mapping', testNoNewCommercialStatusesAreAddedByStripeMapping],
  ['only trialing ever carries a confirmation value', testOnlyTrialingEverCarriesAConfirmation],
  ['the mapping function is pure -- no tenant state, no I/O', testFunctionTakesNoTenantStateAndPerformsNoIo],
]

for (const [name, fn] of tests) run(name, fn)
const failed = results.filter(r => !r).length
if (failed > 0) {
  console.log(`\n${failed} of ${tests.length} TESTS FAILED`)
  process.exit(1)
}
console.log(`\nALL ${tests.length} TESTS PASSED`)
