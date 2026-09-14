// Phase B.10 -- regression tests for dashboard/api/_lib/billingStore.js.
// No real Redis, no real Stripe -- every test injects a fake in-memory
// client via _setRedisClientForTests(). No webhook processing exists to
// test yet; these tests cover only the storage primitives themselves
// (create/read/CAS, reverse indices, event ledger, structural validation).
//
// Run directly: node tests/test_billing_store.js

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  getBillingRecord, createBillingRecord, updateBillingRecord,
  claimCustomerIndex, getTenantIdForCustomer, claimSubscriptionIndex, getTenantIdForSubscription,
  claimStripeEvent, getStripeEventRecord, markStripeEventProcessed, markStripeEventFailed, isStaleBillingEvent,
  isValidStripeCustomerId, isValidStripeSubscriptionId, isValidStripePriceId, isValidStripePaymentMethodId,
  isValidStripeEventId, isValidProviderSubscriptionStatus, PROVIDER_SUBSCRIPTION_STATUSES,
  BillingStoreUnavailableError, BillingRecordNotFoundError, BillingRecordAlreadyExistsError,
  BillingVersionConflictError, BillingIndexCollisionError, StaleProcessingTokenError,
  _setRedisClientForTests, _resetRedisClientForTests,
} from '../dashboard/api/_lib/billingStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
async function run(name, fn) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  } finally {
    _resetRedisClientForTests()
  }
}

function fakeBillingRedis() {
  const hashes = {}
  const strings = {}
  function expired(e) { return e.expiresAtMs !== null && Date.now() >= e.expiresAtMs }
  return {
    hget: async (key, field) => hashes[key]?.[field] ?? null,
    hset: async (key, fields) => { hashes[key] = { ...(hashes[key] ?? {}), ...fields } },
    get: async (key) => {
      const e = strings[key]
      if (!e || expired(e)) return null
      return e.value
    },
    set: async (key, value, opts = {}) => {
      strings[key] = { value, expiresAtMs: opts?.ex ? Date.now() + opts.ex * 1000 : null }
      return 'OK'
    },
    // Dispatches by a distinguishing marker comment inside each Lua script
    // string (billingStore.js's own scripts each open with `-- SCRIPT:
    // NAME`) -- arg count alone no longer disambiguates every script since
    // EVENT_CLAIM and EVENT_MARK both take 5 args. This faithfully emulates
    // whichever real script is actually being called, exactly like
    // test_tenant_entitlement_change.js's own single-script fake does for
    // tenantConfigStore.js's CAS_UPSERT_SCRIPT.
    eval: async (script, keys, args) => {
      const key = keys[0]
      if (script.includes('SCRIPT: BILLING_CAS')) {
        const [field, expectedVersionStr, nextJson] = args
        const raw = hashes[key]?.[field] ?? null
        let currentVersion = '0'
        if (raw) {
          try {
            const decoded = JSON.parse(raw)
            if (decoded && decoded.version !== undefined) currentVersion = String(decoded.version)
          } catch { /* treat as version 0 */ }
        }
        if (currentVersion !== expectedVersionStr) return raw ?? false
        hashes[key] = { ...(hashes[key] ?? {}), [field]: nextJson }
        return true
      }
      if (script.includes('SCRIPT: INDEX_CLAIM')) {
        const [tenantId] = args
        const e = strings[key]
        const existing = (e && !expired(e)) ? e.value : null
        if (existing) return existing === tenantId ? 1 : 0
        strings[key] = { value: tenantId, expiresAtMs: null }
        return 1
      }
      if (script.includes('SCRIPT: EVENT_CLAIM')) {
        const [nowMsStr, leaseMsStr, newToken, freshRecordJson, ttlSecondsStr] = args
        const nowMs = Number(nowMsStr)
        const leaseMs = Number(leaseMsStr)
        const ttlSeconds = Number(ttlSecondsStr)
        const e = strings[key]
        // Staleness here is entirely about leaseExpiresAtMs (an explicit
        // field inside the record), never the outer Redis key's own TTL --
        // the 90-day dedup TTL is a completely separate, much longer-lived
        // concern that no test here ever actually reaches.
        const existingRaw = e ? e.value : null
        if (existingRaw) {
          const rec = JSON.parse(existingRaw)
          if (rec.status === 'processed') {
            return JSON.stringify({ claimed: false, reason: 'already_processed', record: rec })
          }
          if (rec.status === 'claimed' && (rec.leaseExpiresAtMs ?? 0) > nowMs) {
            return JSON.stringify({ claimed: false, reason: 'lease_active', record: rec })
          }
          rec.status = 'claimed'
          rec.processingToken = newToken
          rec.claimedAtMs = nowMs
          rec.leaseExpiresAtMs = nowMs + leaseMs
          rec.attemptCount = (rec.attemptCount ?? 0) + 1
          const nextJson = JSON.stringify(rec)
          strings[key] = { value: nextJson, expiresAtMs: Date.now() + ttlSeconds * 1000 }
          return JSON.stringify({ claimed: true, reason: 'reclaimed', record: nextJson })
        }
        strings[key] = { value: freshRecordJson, expiresAtMs: Date.now() + ttlSeconds * 1000 }
        return JSON.stringify({ claimed: true, reason: 'new', record: freshRecordJson })
      }
      if (script.includes('SCRIPT: EVENT_MARK')) {
        const [processingToken, nowMsStr, finalStatus, resultNote, ttlSecondsStr] = args
        const e = strings[key]
        if (!e) return JSON.stringify({ ok: false, reason: 'not_found' })
        const rec = JSON.parse(e.value)
        if (rec.processingToken !== processingToken) {
          return JSON.stringify({ ok: false, reason: 'stale_token' })
        }
        const nowMs = Number(nowMsStr)
        rec.status = finalStatus
        if (finalStatus === 'processed') rec.processedAtMs = nowMs
        else rec.failedAtMs = nowMs
        rec.result = resultNote
        rec.processingToken = null
        const nextJson = JSON.stringify(rec)
        strings[key] = { value: nextJson, expiresAtMs: Date.now() + Number(ttlSecondsStr) * 1000 }
        return JSON.stringify({ ok: true, record: nextJson })
      }
      throw new Error(`unexpected eval() call in test fake -- unrecognized script marker`)
    },
    _hashes: hashes,
    _strings: strings,
  }
}

function install() {
  const client = fakeBillingRedis()
  _setRedisClientForTests(() => client)
  return client
}

const TENANT_A = 't_alpha'
const TENANT_B = 't_beta'

// ===========================================================================
// BILLING STORE
// ===========================================================================

async function testCreateAndReadRoundTrip() {
  install()
  assert((await getBillingRecord(TENANT_A)) === null, 'sanity: nothing exists yet')
  const created = await createBillingRecord(TENANT_A, { stripeCustomerId: 'cus_abc123' })
  assert(created.version === 1 && created.tenantId === TENANT_A && created.provider === 'stripe')
  assert(created.stripeCustomerId === 'cus_abc123')
  const read = await getBillingRecord(TENANT_A)
  assert(read.stripeCustomerId === 'cus_abc123' && read.version === 1)
}

async function testCreateRejectsWhenAlreadyExists() {
  install()
  await createBillingRecord(TENANT_A)
  let threw = null
  try { await createBillingRecord(TENANT_A) } catch (err) { threw = err }
  assert(threw instanceof BillingRecordAlreadyExistsError, 'creating a second record for the same tenant must be rejected, never silently overwrite')
}

async function testCasUpdateSucceedsWithCorrectVersion() {
  install()
  const created = await createBillingRecord(TENANT_A)
  const updated = await updateBillingRecord(TENANT_A, { stripeSubscriptionId: 'sub_xyz789', subscriptionStatus: 'active' }, { expectedVersion: created.version })
  assert(updated.version === 2 && updated.stripeSubscriptionId === 'sub_xyz789' && updated.subscriptionStatus === 'active')
  assert(updated.billingCreatedAt === created.billingCreatedAt, 'billingCreatedAt must never change on update')
}

async function testStaleCasIsRejected() {
  install()
  const created = await createBillingRecord(TENANT_A)
  await updateBillingRecord(TENANT_A, { subscriptionStatus: 'active' }, { expectedVersion: created.version })
  let threw = null
  try {
    // Stale caller still thinks version is 1 -- must fail, not overwrite.
    await updateBillingRecord(TENANT_A, { subscriptionStatus: 'past_due' }, { expectedVersion: created.version })
  } catch (err) { threw = err }
  assert(threw instanceof BillingVersionConflictError, 'a stale expectedVersion must be rejected')
  assert(threw.currentRecord && threw.currentRecord.version === 2, 'the conflict error must carry the CURRENT record')
  const final = await getBillingRecord(TENANT_A)
  assert(final.subscriptionStatus === 'active', 'the stale write must never have applied')
}

async function testUpdateRequiresExpectedVersion() {
  install()
  await createBillingRecord(TENANT_A)
  let threw = null
  try { await updateBillingRecord(TENANT_A, { subscriptionStatus: 'active' }, {}) } catch (err) { threw = err }
  assert(threw instanceof TypeError, 'updateBillingRecord must REQUIRE expectedVersion -- no last-write-wins escape hatch for billing-critical state')
}

async function testUpdateOnMissingRecordThrowsNotFound() {
  install()
  let threw = null
  try { await updateBillingRecord(TENANT_A, { subscriptionStatus: 'active' }, { expectedVersion: 1 }) } catch (err) { threw = err }
  assert(threw instanceof BillingRecordNotFoundError)
}

async function testSchemaValidationRejectsMalformedFields() {
  install()
  await createBillingRecord(TENANT_A)
  const cases = [
    { stripeCustomerId: 'not-a-real-id' },
    { stripeSubscriptionId: 'cus_wrong_prefix' },
    { stripePriceId: 12345 },
    { subscriptionStatus: 'not_a_real_status' },
    { cancelAtPeriodEnd: 'yes' },
    { currentPeriodStart: 'not-a-timestamp' },
    { defaultPaymentMethodId: 'card_wrong_prefix' },
  ]
  for (const patch of cases) {
    let threw = null
    try { await updateBillingRecord(TENANT_A, patch, { expectedVersion: 1 }) } catch (err) { threw = err }
    assert(threw instanceof TypeError, `malformed patch ${JSON.stringify(patch)} must be rejected with TypeError`)
  }
}

async function testNoUnknownFieldsAccepted() {
  install()
  let threw = null
  try { await createBillingRecord(TENANT_A, { commercialStatus: 'active' }) } catch (err) { threw = err }
  assert(threw instanceof TypeError, 'commercialStatus is not, and must never be, a billing-record field -- it lives only in tenant_config.commercial')
}

// ===========================================================================
// REVERSE INDICES / IDENTITY
// ===========================================================================

async function testCustomerIndexIdempotentForSameTenant() {
  install()
  await claimCustomerIndex('cus_shared1', TENANT_A)
  await claimCustomerIndex('cus_shared1', TENANT_A) // must not throw
  assert((await getTenantIdForCustomer('cus_shared1')) === TENANT_A)
}

async function testCustomerIndexCollisionRejected() {
  install()
  await claimCustomerIndex('cus_shared2', TENANT_A)
  let threw = null
  try { await claimCustomerIndex('cus_shared2', TENANT_B) } catch (err) { threw = err }
  assert(threw instanceof BillingIndexCollisionError, 'tenant B must not be able to claim a Customer already mapped to tenant A')
  assert((await getTenantIdForCustomer('cus_shared2')) === TENANT_A, 'the original mapping must be unchanged')
}

async function testSubscriptionIndexIdempotentForSameTenant() {
  install()
  await claimSubscriptionIndex('sub_shared1', TENANT_A)
  await claimSubscriptionIndex('sub_shared1', TENANT_A)
  assert((await getTenantIdForSubscription('sub_shared1')) === TENANT_A)
}

async function testSubscriptionIndexCollisionRejected() {
  install()
  await claimSubscriptionIndex('sub_shared2', TENANT_A)
  let threw = null
  try { await claimSubscriptionIndex('sub_shared2', TENANT_B) } catch (err) { threw = err }
  assert(threw instanceof BillingIndexCollisionError, 'tenant B must not be able to claim a Subscription already mapped to tenant A')
}

async function testTenantACannotClaimCustomerMappedToTenantB() {
  install()
  await claimCustomerIndex('cus_ownedbyB', TENANT_B)
  let threw = null
  try { await claimCustomerIndex('cus_ownedbyB', TENANT_A) } catch (err) { threw = err }
  assert(threw instanceof BillingIndexCollisionError)
  assert((await getTenantIdForCustomer('cus_ownedbyB')) === TENANT_B)
}

async function testTenantACannotClaimSubscriptionMappedToTenantB() {
  install()
  await claimSubscriptionIndex('sub_ownedbyB', TENANT_B)
  let threw = null
  try { await claimSubscriptionIndex('sub_ownedbyB', TENANT_A) } catch (err) { threw = err }
  assert(threw instanceof BillingIndexCollisionError)
  assert((await getTenantIdForSubscription('sub_ownedbyB')) === TENANT_B)
}

async function testRecordsAndIndicesHaveNoTtl() {
  const client = install()
  await createBillingRecord(TENANT_A)
  await claimCustomerIndex('cus_noexpiry', TENANT_A)
  await claimSubscriptionIndex('sub_noexpiry', TENANT_A)
  // Billing records live in a hash (no per-field TTL concept at all in this
  // fake, matching real Redis HSET semantics). The two index keys are
  // plain SET calls with no `ex` option -- confirm the fake recorded no
  // expiry.
  const customerEntry = client._strings['billing_customer_index:v1:cus_noexpiry']
  const subEntry = client._strings['billing_subscription_index:v1:sub_noexpiry']
  assert(customerEntry.expiresAtMs === null, 'customer index must have no TTL')
  assert(subEntry.expiresAtMs === null, 'subscription index must have no TTL')
}

// ===========================================================================
// EVENT LEDGER
// ===========================================================================

function eventFixture(overrides = {}) {
  return { eventId: 'evt_abc111', eventType: 'customer.subscription.updated', stripeCreatedAt: 1700000000, ...overrides }
}

async function testFirstClaimSucceeds() {
  install()
  const result = await claimStripeEvent(eventFixture())
  assert(result.claimed === true && result.reason === 'new')
  assert(typeof result.processingToken === 'string' && result.processingToken.length > 0, 'a successful claim must return a processingToken')
  assert(result.record.attemptCount === 1 && result.record.status === 'claimed')
}

async function testConcurrentSecondClaimDuringActiveLeaseDoesNotProcess() {
  install()
  const first = await claimStripeEvent(eventFixture({ eventId: 'evt_lease1' }))
  const second = await claimStripeEvent(eventFixture({ eventId: 'evt_lease1' }))
  assert(first.claimed === true)
  assert(second.claimed === false && second.reason === 'lease_active', 'a second claim while the first worker\'s lease is still active must not be allowed to process')
  assert(second.processingToken === null, 'a losing claim must never receive a processingToken')
  assert(second.record.processingToken == null, 'a losing claim must never be able to read the CURRENT owner\'s real processingToken either')
}

async function testProcessedEventCannotBeReclaimed() {
  install()
  const claim = await claimStripeEvent(eventFixture({ eventId: 'evt_done1' }))
  await markStripeEventProcessed('evt_done1', claim.processingToken)
  const retry = await claimStripeEvent(eventFixture({ eventId: 'evt_done1' }))
  assert(retry.claimed === false && retry.reason === 'already_processed', 'a processed event must never be reclaimed or reprocessed')
}

async function testExplicitlyFailedEventCanBeRetried() {
  install()
  const claim = await claimStripeEvent(eventFixture({ eventId: 'evt_fail1' }))
  await markStripeEventFailed('evt_fail1', claim.processingToken, 'simulated transient error')
  const retry = await claimStripeEvent(eventFixture({ eventId: 'evt_fail1' }))
  assert(retry.claimed === true && retry.reason === 'reclaimed', 'a failed event must be immediately retryable, no lease wait required')
  assert(retry.record.attemptCount === 2, 'attemptCount must increment on retry')
  assert(retry.processingToken !== claim.processingToken, 'a retry must receive a FRESH processingToken, never reuse the old one')
}

async function testAbandonedClaimBecomesReclaimableAfterLeaseExpiry() {
  const client = install()
  const claim = await claimStripeEvent(eventFixture({ eventId: 'evt_crash1' }))
  assert(claim.claimed === true)
  // Simulate the worker crashing (never calling markStripeEventProcessed/
  // Failed) by directly expiring the lease in the fake store, rather than
  // sleeping for real -- proves the RECLAIM branch, not merely the passage
  // of wall-clock time.
  const rec = JSON.parse(client._strings['stripe_event:v1:evt_crash1'].value)
  rec.leaseExpiresAtMs = Date.now() - 1000 // already expired
  client._strings['stripe_event:v1:evt_crash1'].value = JSON.stringify(rec)

  const retry = await claimStripeEvent(eventFixture({ eventId: 'evt_crash1' }))
  assert(retry.claimed === true && retry.reason === 'reclaimed', 'an abandoned claim (expired lease, never marked processed/failed) must become reclaimable')
  assert(retry.record.attemptCount === 2)
}

async function testStaleProcessingTokenCannotMarkNewerClaimProcessed() {
  const client = install()
  const original = await claimStripeEvent(eventFixture({ eventId: 'evt_stale1' }))
  // Force the lease to expire and let a second worker take over.
  const rec = JSON.parse(client._strings['stripe_event:v1:evt_stale1'].value)
  rec.leaseExpiresAtMs = Date.now() - 1000
  client._strings['stripe_event:v1:evt_stale1'].value = JSON.stringify(rec)
  const reclaimed = await claimStripeEvent(eventFixture({ eventId: 'evt_stale1' }))
  assert(reclaimed.claimed === true && reclaimed.processingToken !== original.processingToken)

  let threw = null
  try { await markStripeEventProcessed('evt_stale1', original.processingToken) } catch (err) { threw = err }
  assert(threw instanceof StaleProcessingTokenError, 'the ORIGINAL (now-superseded) worker\'s token must never be able to mark the newer claim processed')
  const current = await getStripeEventRecord('evt_stale1')
  assert(current.status === 'claimed', 'the stale mark attempt must not have changed the newer claim\'s status')
}

async function testStaleProcessingTokenCannotMarkNewerClaimFailed() {
  const client = install()
  const original = await claimStripeEvent(eventFixture({ eventId: 'evt_stale2' }))
  const rec = JSON.parse(client._strings['stripe_event:v1:evt_stale2'].value)
  rec.leaseExpiresAtMs = Date.now() - 1000
  client._strings['stripe_event:v1:evt_stale2'].value = JSON.stringify(rec)
  await claimStripeEvent(eventFixture({ eventId: 'evt_stale2' }))

  let threw = null
  try { await markStripeEventFailed('evt_stale2', original.processingToken) } catch (err) { threw = err }
  assert(threw instanceof StaleProcessingTokenError, 'the ORIGINAL (now-superseded) worker\'s token must never be able to mark the newer claim failed either')
}

async function testSuccessfulRetryBecomesProcessedExactlyOnce() {
  install()
  const first = await claimStripeEvent(eventFixture({ eventId: 'evt_retrysuccess1' }))
  await markStripeEventFailed('evt_retrysuccess1', first.processingToken, 'first attempt failed')
  const retry = await claimStripeEvent(eventFixture({ eventId: 'evt_retrysuccess1' }))
  const processed = await markStripeEventProcessed('evt_retrysuccess1', retry.processingToken, 'second attempt succeeded')
  assert(processed.status === 'processed' && processed.attemptCount === 2)
  // A THIRD delivery of the same event (Stripe's own at-least-once
  // redelivery) must be a permanent, harmless no-op from here on.
  const third = await claimStripeEvent(eventFixture({ eventId: 'evt_retrysuccess1' }))
  assert(third.claimed === false && third.reason === 'already_processed')
}

async function testEventMetadataRemainsMinimal() {
  install()
  const claim = await claimStripeEvent(eventFixture({ eventId: 'evt_minimal1', providerObjectId: 'sub_min', tenantId: TENANT_A }))
  const allowedKeys = [
    'eventId', 'eventType', 'stripeCreatedAt', 'providerObjectId', 'tenantId',
    'status', 'processingToken', 'claimedAtMs', 'leaseExpiresAtMs',
    'processedAtMs', 'failedAtMs', 'attemptCount', 'result',
  ]
  const unexpected = Object.keys(claim.record).filter(k => !allowedKeys.includes(k))
  assert(unexpected.length === 0, `event ledger record must never carry extra fields (e.g. a raw Stripe payload): found ${unexpected.join(', ')}`)
}

async function testProcessedRecordRetainsNinetyDayDedupTtl() {
  const client = install()
  const claim = await claimStripeEvent(eventFixture({ eventId: 'evt_ttlcheck1' }))
  await markStripeEventProcessed('evt_ttlcheck1', claim.processingToken)
  const entry = client._strings['stripe_event:v1:evt_ttlcheck1']
  const remainingDays = (entry.expiresAtMs - Date.now()) / (24 * 60 * 60 * 1000)
  assert(remainingDays > 89 && remainingDays <= 90, `processed record must retain approximately the 90-day dedup TTL, got ~${remainingDays.toFixed(1)} days`)
}

async function testMarkOnUnclaimedEventThrowsNotFound() {
  install()
  let threw = null
  try { await markStripeEventProcessed('evt_neverclaimed', 'sometoken') } catch (err) { threw = err }
  assert(threw instanceof BillingRecordNotFoundError, `expected BillingRecordNotFoundError, got ${threw?.constructor?.name}: ${threw?.message}`)
}

async function testEventRecordFieldsArePopulatedCorrectly() {
  install()
  const claim = await claimStripeEvent({ eventId: 'evt_fields1', eventType: 'customer.subscription.created', stripeCreatedAt: 1700000002, providerObjectId: 'sub_x', tenantId: TENANT_A })
  assert(claim.record.eventType === 'customer.subscription.created' && claim.record.tenantId === TENANT_A && claim.record.providerObjectId === 'sub_x')
  const marked = await markStripeEventProcessed('evt_fields1', claim.processingToken, 'applied cleanly')
  assert(marked.result === 'applied cleanly' && marked.status === 'processed' && marked.processedAtMs != null)
}

// ===========================================================================
// STALE-EVENT / OBJECT VERSION MODEL (Part K, pure)
// ===========================================================================

function testStaleEventOlderTimestampIsStale() {
  const current = { lastStripeEventCreatedAt: 1700000100, stripeSubscriptionId: 'sub_current' }
  assert(isStaleBillingEvent({ candidateStripeCreatedAt: 1700000050, candidateSubscriptionId: 'sub_current' }, current) === true)
}

function testFreshEventIsNotStale() {
  const current = { lastStripeEventCreatedAt: 1700000100, stripeSubscriptionId: 'sub_current' }
  assert(isStaleBillingEvent({ candidateStripeCreatedAt: 1700000200, candidateSubscriptionId: 'sub_current' }, current) === false)
}

function testEventForDifferentSubscriptionIsStale() {
  const current = { lastStripeEventCreatedAt: 1700000100, stripeSubscriptionId: 'sub_current' }
  assert(isStaleBillingEvent({ candidateStripeCreatedAt: 1700000999, candidateSubscriptionId: 'sub_old_superseded' }, current) === true,
    'an event for a subscription id different from the tenant\'s CURRENT one must never overwrite the current projection')
}

function testNothingAppliedYetIsNeverStale() {
  assert(isStaleBillingEvent({ candidateStripeCreatedAt: 1, candidateSubscriptionId: 'sub_first' }, null) === false)
}

// ===========================================================================
// STATUS ENUM
// ===========================================================================

function testProviderStatusEnumValidates() {
  for (const status of PROVIDER_SUBSCRIPTION_STATUSES) {
    assert(isValidProviderSubscriptionStatus(status) === true, `${status} must validate`)
  }
  assert(isValidProviderSubscriptionStatus(null) === true, 'null (no subscription yet) must be valid')
}

function testMalformedStatusFailsClosed() {
  assert(isValidProviderSubscriptionStatus('made_up_status') === false)
  assert(isValidProviderSubscriptionStatus(123) === false)
  assert(isValidProviderSubscriptionStatus(undefined) === false)
}

async function testNoDirectProviderStatusEntitlementAuthorization() {
  // Structural proof: billingStore.js must never import
  // entitlementResolution.js/commercialOperationPolicy.js/tenantConfigStore.js
  // -- it has no way to grant or deny entitlements directly, by construction.
  const source = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', '_lib', 'billingStore.js'), 'utf-8')
  const importLines = source.split('\n').filter(line => /^\s*import\b/.test(line))
  for (const forbidden of ['entitlementResolution.js', 'commercialOperationPolicy.js', 'tenantConfigStore.js']) {
    assert(!importLines.some(line => line.includes(forbidden)), `billingStore.js must never have a real import statement pulling in ${forbidden}`)
  }
}

// ===========================================================================
// STRUCTURAL ID VALIDATORS (Part F)
// ===========================================================================

function testStripeIdValidators() {
  assert(isValidStripeCustomerId('cus_ABC123') && !isValidStripeCustomerId('sub_ABC123') && isValidStripeCustomerId(null))
  assert(isValidStripeSubscriptionId('sub_ABC123') && !isValidStripeSubscriptionId('cus_ABC123') && isValidStripeSubscriptionId(null))
  assert(isValidStripePriceId('price_ABC123') && !isValidStripePriceId('prc_ABC123') && isValidStripePriceId(null))
  assert(isValidStripePaymentMethodId('pm_ABC123') && !isValidStripePaymentMethodId('card_ABC123') && isValidStripePaymentMethodId(null))
  assert(isValidStripeEventId('evt_ABC123') && !isValidStripeEventId('event_ABC123') && !isValidStripeEventId(null), 'an event id is never nullable -- a claim always names a real event')
}

// ===========================================================================
// SECURITY -- no request-body spread can mutate billing projection
// ===========================================================================

async function testNoGenericBodySpreadCanMutateBillingRecord() {
  install()
  await createBillingRecord(TENANT_A)
  // Simulates a naive future handler doing updateBillingRecord(tenantId,
  // {...req.body}, ...) where req.body contains attacker-controlled junk
  // alongside a legitimate field.
  const attackerBody = { subscriptionStatus: 'active', isSuperAdmin: true, tenantId: TENANT_B, version: 999 }
  let threw = null
  try { await updateBillingRecord(TENANT_A, attackerBody, { expectedVersion: 1 }) } catch (err) { threw = err }
  assert(threw instanceof TypeError, 'any unknown key in a patch (e.g. from a naive {...req.body} spread) must be rejected outright, not silently dropped or applied')
}

const tests = [
  ['create/read round trip', testCreateAndReadRoundTrip],
  ['create rejects when a record already exists', testCreateRejectsWhenAlreadyExists],
  ['CAS update succeeds with the correct version', testCasUpdateSucceedsWithCorrectVersion],
  ['a stale CAS write is rejected, never applied', testStaleCasIsRejected],
  ['update requires expectedVersion -- no plain-write escape hatch', testUpdateRequiresExpectedVersion],
  ['updating a missing record throws BillingRecordNotFoundError', testUpdateOnMissingRecordThrowsNotFound],
  ['schema validation rejects every malformed field', testSchemaValidationRejectsMalformedFields],
  ['unknown fields (e.g. commercialStatus) are never accepted', testNoUnknownFieldsAccepted],
  ['customer index claim is idempotent for the same tenant', testCustomerIndexIdempotentForSameTenant],
  ['customer index collision with a different tenant is rejected', testCustomerIndexCollisionRejected],
  ['subscription index claim is idempotent for the same tenant', testSubscriptionIndexIdempotentForSameTenant],
  ['subscription index collision with a different tenant is rejected', testSubscriptionIndexCollisionRejected],
  ['tenant A cannot claim a Customer mapped to tenant B', testTenantACannotClaimCustomerMappedToTenantB],
  ['tenant A cannot claim a Subscription mapped to tenant B', testTenantACannotClaimSubscriptionMappedToTenantB],
  ['billing records and reverse indices carry no TTL', testRecordsAndIndicesHaveNoTtl],
  ['the first claim of an event succeeds', testFirstClaimSucceeds],
  ['a concurrent second claim during an active lease does not process', testConcurrentSecondClaimDuringActiveLeaseDoesNotProcess],
  ['a processed event can never be reclaimed', testProcessedEventCannotBeReclaimed],
  ['an explicitly failed event can be retried immediately', testExplicitlyFailedEventCanBeRetried],
  ['an abandoned claim becomes reclaimable after its lease expires', testAbandonedClaimBecomesReclaimableAfterLeaseExpiry],
  ['a stale processing token cannot mark a newer claim processed', testStaleProcessingTokenCannotMarkNewerClaimProcessed],
  ['a stale processing token cannot mark a newer claim failed', testStaleProcessingTokenCannotMarkNewerClaimFailed],
  ['a successful retry becomes processed exactly once', testSuccessfulRetryBecomesProcessedExactlyOnce],
  ['event ledger metadata remains minimal, never a raw payload', testEventMetadataRemainsMinimal],
  ['a processed record retains its 90-day dedup TTL', testProcessedRecordRetainsNinetyDayDedupTtl],
  ['marking an unclaimed event throws not-found', testMarkOnUnclaimedEventThrowsNotFound],
  ['event record fields are populated correctly end to end', testEventRecordFieldsArePopulatedCorrectly],
  ['an older event/object timestamp is classified stale', testStaleEventOlderTimestampIsStale],
  ['a fresh event/object timestamp is not stale', testFreshEventIsNotStale],
  ['an event for a different (superseded) subscription is stale', testEventForDifferentSubscriptionIsStale],
  ['nothing-applied-yet is never classified stale', testNothingAppliedYetIsNeverStale],
  ['the provider status enum validates every real value', testProviderStatusEnumValidates],
  ['a malformed provider status fails closed', testMalformedStatusFailsClosed],
  ['billingStore.js has no direct entitlement-authorization path', testNoDirectProviderStatusEntitlementAuthorization],
  ['Stripe id structural validators', testStripeIdValidators],
  ['no generic request-body spread can mutate a billing record', testNoGenericBodySpreadCanMutateBillingRecord],
]

async function main() {
  for (const [name, fn] of tests) await run(name, fn)
  const failed = results.filter(r => !r).length
  if (failed > 0) {
    console.log(`\n${failed} of ${tests.length} TESTS FAILED`)
    process.exit(1)
  }
  console.log(`\nALL ${tests.length} TESTS PASSED`)
}

main()
