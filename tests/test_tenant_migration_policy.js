// Regression tests for the Multi-Tenant Phase 2 HARDENING PASS --
// dashboard/api/_lib/tenantDualRead.js's migration-mode policy.
//
// Context: the original Phase 2 dual-read design picked the authoritative
// READ key by checking, at read time, whether a tenant-scoped v2 key
// happened to already contain data, while the WRITE key was picked purely
// by tenant identity. Those were two independent decisions that could
// diverge the moment a v2 key became populated by anything at all (a bug,
// a partial migration run, a stray write) -- reads would silently flip to
// v2 while writes kept landing on v1. This file proves that failure mode
// is now structurally impossible: both read and write resolution for every
// key shape delegate to the SAME per-tenant migration-mode lookup, so they
// can never disagree, regardless of what Redis currently contains.
//
// No real Upstash account anywhere -- every test drives each store's own
// existing test-only client-factory seam (_setRedisClientForTests).
//
// Run directly: node tests/test_tenant_migration_policy.js

import {
  TenantMigrationMode,
  getTenantMigrationMode,
  isLegacyAuthoritative,
  resolveHashReadKey,
  resolveHashWriteKey,
  resolveListReadKey,
  resolveListWriteKey,
  resolveIndividualStringReadKey,
  resolveIndividualHashReadKey,
  resolveIndividualWriteKey,
} from '../dashboard/api/_lib/tenantDualRead.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'
import { contactsKeyV2, auditLogKeyV2, notifReplyFailureKeyV2, publishBridgeKeyV2 } from '../dashboard/api/_lib/tenantKeys.js'

import {
  getAllContacts, upsertContact,
  _setRedisClientForTests as setContactRedis, _resetRedisClientForTests as resetContactRedis,
} from '../dashboard/api/_lib/contactStore.js'
import {
  appendAuditEntry, listAuditEntries,
  _setRedisClientForTests as setAuditRedis, _resetRedisClientForTests as resetAuditRedis,
} from '../dashboard/api/_lib/auditLog.js'
import {
  recordReplyFailure, listReplyFailures,
  _setRedisClientForTests as setNotifRedis, _resetRedisClientForTests as resetNotifRedis,
} from '../dashboard/api/_lib/notificationStore.js'
import {
  writePublishBridge, getPublishBridges,
  _setRedisClientForTests as setBridgeRedis, _resetRedisClientForTests as resetBridgeRedis,
} from '../dashboard/api/_lib/publishBridgeStore.js'

const CONTACT_DIRECTORY_KEY = 'restaurant_contacts:v1'
const AUDIT_LOG_KEY = 'audit_log:v1'
const REPLY_FAILURE_PREFIX = 'notif_reply_failed:v1:'
const PUBLISH_BRIDGE_PREFIX = 'publish_bridge:v1:'

const SYNTHETIC_TENANT_ID = 't_synthetic-second-tenant'

const OWNER = { userId: 'usr_owner', email: 'owner@example.com', displayName: 'Owner Person' }

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
    resetContactRedis()
    resetAuditRedis()
    resetNotifRedis()
    resetBridgeRedis()
  }
}

// A key-respecting in-memory Redis stand-in (unlike several existing store
// test files' fakes, which ignore the `key` argument because, pre-hardening,
// only one key ever mattered for the default tenant -- this suite's whole
// point is proving behavior when TWO distinct keys, v1 and v2, both exist
// with DIFFERENT data at once).
function fakeRedis(initial = {}) {
  const store = {}
  for (const [k, v] of Object.entries(initial)) store[k] = v
  return {
    hgetall: async (key) => (store[key] && typeof store[key] === 'object' && !Array.isArray(store[key]) ? { ...store[key] } : {}),
    hget: async (key, field) => {
      const h = store[key]
      return h && typeof h === 'object' ? (h[field] ?? null) : null
    },
    hset: async (key, fields) => {
      store[key] = { ...(store[key] || {}), ...fields }
      return Object.keys(fields).length
    },
    hdel: async (key, field) => {
      if (!store[key] || !(field in store[key])) return 0
      delete store[key][field]
      return 1
    },
    lrange: async (key, start, end) => {
      const l = Array.isArray(store[key]) ? store[key] : []
      return end === -1 ? l.slice(start) : l.slice(start, end + 1)
    },
    lpush: async (key, val) => {
      store[key] = [val, ...(Array.isArray(store[key]) ? store[key] : [])]
      return store[key].length
    },
    ltrim: async () => 'OK',
    get: async (key) => (key in store ? store[key] : null),
    set: async (key, val) => { store[key] = val; return 'OK' },
    del: async (key) => { const had = key in store; delete store[key]; return had ? 1 : 0 },
    keys: async (pattern) => {
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern
      return Object.keys(store).filter(k => k.startsWith(prefix))
    },
    mget: async (...keys) => keys.map(k => (k in store ? store[k] : null)),
    expire: async () => 1,
    _store: store,
  }
}

// --- Policy invariant: read and write can never disagree --------------------

async function testReadAndWriteKeyResolutionCanNeverDisagree() {
  // Covers every shape the store layer uses, across a tenant known to be
  // LEGACY (DEFAULT_TENANT_ID) and a tenant that has no explicit entry in
  // the migration-mode map at all (falls through to CUTOVER) -- proving the
  // "cannot select different authoritative read and write versions"
  // requirement holds for both branches of the policy, not just the one
  // tenant that exists in production today.
  const tenants = [DEFAULT_TENANT_ID, SYNTHETIC_TENANT_ID, 't_another-hypothetical-tenant']
  for (const tenantId of tenants) {
    const v1Key = 'some_store:v1'
    const v2Key = `some_store:v2:${tenantId}`

    const hashRead = await resolveHashReadKey(null, { v1Key, v2Key, tenantId })
    const hashWrite = resolveHashWriteKey({ v1Key, v2Key, tenantId })
    assert(hashRead === hashWrite, `hash shape: read (${hashRead}) and write (${hashWrite}) key diverged for ${tenantId}`)

    const listRead = await resolveListReadKey(null, { v1Key, v2Key, tenantId })
    const listWrite = resolveListWriteKey({ v1Key, v2Key, tenantId })
    assert(listRead === listWrite, `list shape: read (${listRead}) and write (${listWrite}) key diverged for ${tenantId}`)

    const strRead = await resolveIndividualStringReadKey(null, { v1Key, v2Key, tenantId })
    const hashIndivRead = await resolveIndividualHashReadKey(null, { v1Key, v2Key, tenantId })
    const indivWrite = resolveIndividualWriteKey({ v1Key, v2Key, tenantId })
    assert(strRead === indivWrite, `individual-string shape: read (${strRead}) and write (${indivWrite}) key diverged for ${tenantId}`)
    assert(hashIndivRead === indivWrite, `individual-hash shape: read (${hashIndivRead}) and write (${indivWrite}) key diverged for ${tenantId}`)
  }
}

async function testDefaultTenantIsExplicitlyLegacyModeToday() {
  assert(getTenantMigrationMode(DEFAULT_TENANT_ID) === TenantMigrationMode.LEGACY, 'Los Tres Amigos must be explicitly LEGACY during Phase 2')
  assert(isLegacyAuthoritative(DEFAULT_TENANT_ID) === true)
}

async function testAnyOtherTenantIsCutoverModeByDefault() {
  assert(getTenantMigrationMode(SYNTHETIC_TENANT_ID) === TenantMigrationMode.CUTOVER, 'a tenant with no explicit map entry must default to CUTOVER, never LEGACY')
  assert(isLegacyAuthoritative(SYNTHETIC_TENANT_ID) === false)
}

// --- Requirement 1 & 5: LEGACY reads v1 even when v2 is populated; -----------
//     populating a tenant-scoped key alone changes nothing -------------------

async function testLegacyTenantReadsV1EvenWhenAPopulatedV2KeyExists() {
  const client = fakeRedis({
    [CONTACT_DIRECTORY_KEY]: { 10: JSON.stringify({ locationId: 10, primaryEmail: 'legacy@example.com', active: true }) },
    // Simulates a migration/backfill script having already copied (possibly
    // stale or different) data into the tenant-scoped key -- its mere
    // existence, and being non-empty, must not matter at all.
    [contactsKeyV2(DEFAULT_TENANT_ID)]: { 10: JSON.stringify({ locationId: 10, primaryEmail: 'migrated-but-not-yet-cutover@example.com', active: true }) },
  })
  setContactRedis(() => client)
  const all = await getAllContacts(DEFAULT_TENANT_ID)
  assert(all['10'].primaryEmail === 'legacy@example.com', `LEGACY tenant must read the legacy v1 key regardless of a populated v2 key -- got ${all['10']?.primaryEmail}`)
}

async function testLegacyTenantWritesV1NotV2() {
  const client = fakeRedis({
    [contactsKeyV2(DEFAULT_TENANT_ID)]: {}, // present but empty -- writes must still never target it
  })
  setContactRedis(() => client)
  await upsertContact(DEFAULT_TENANT_ID, 20, { primaryEmail: 'new@example.com' }, OWNER, 'created')
  assert(client._store[CONTACT_DIRECTORY_KEY]?.['20'], 'a LEGACY-tenant write must land on the v1 key')
  assert(!client._store[contactsKeyV2(DEFAULT_TENANT_ID)]['20'], 'a LEGACY-tenant write must never ALSO land on the v2 key (no silent dual-write)')
}

async function testPopulatingTenantScopedKeyAloneNeverFlipsWhichKeyIsAuthoritative() {
  // The precise split-brain scenario from the hardening request: v1 has the
  // real, currently-authoritative data; v2 becomes populated (e.g. by a
  // migration dry run that, hypothetically, wrote something) with DIFFERENT
  // data. A read immediately after must still come from v1, and a
  // subsequent write must still land on v1 -- v2's population is inert.
  const client = fakeRedis({
    [CONTACT_DIRECTORY_KEY]: { 30: JSON.stringify({ locationId: 30, primaryEmail: 'authoritative@example.com', active: true }) },
  })
  setContactRedis(() => client)

  const before = await getAllContacts(DEFAULT_TENANT_ID)
  assert(before['30'].primaryEmail === 'authoritative@example.com')

  // Now populate the tenant-scoped key directly, out of band, simulating a
  // migration script -- NOT through upsertContact (which would refuse to
  // target v2 for this tenant anyway; this simulates the key becoming
  // populated by some other means entirely).
  client._store[contactsKeyV2(DEFAULT_TENANT_ID)] = { 30: JSON.stringify({ locationId: 30, primaryEmail: 'shadow-copy@example.com', active: true }) }

  const after = await getAllContacts(DEFAULT_TENANT_ID)
  assert(after['30'].primaryEmail === 'authoritative@example.com', `populating v2 alone must never change read behavior -- got ${after['30']?.primaryEmail}`)

  await upsertContact(DEFAULT_TENANT_ID, 30, { primaryEmail: 'authoritative-updated@example.com' }, OWNER, 'updated')
  assert(client._store[CONTACT_DIRECTORY_KEY]['30'].includes('authoritative-updated@example.com'), 'a write after v2 became populated must still land on v1')
  assert(!client._store[contactsKeyV2(DEFAULT_TENANT_ID)]['30'].includes('authoritative-updated'), 'v2 must remain untouched by a LEGACY-tenant write')
}

// --- Requirement 3: a synthetic second tenant can never read/write v1 -------

async function testSyntheticTenantNeverReadsGlobalV1EvenWhenPopulated() {
  const client = fakeRedis({
    [CONTACT_DIRECTORY_KEY]: { 10: JSON.stringify({ locationId: 10, primaryEmail: 'los-tres-amigos-real-data@example.com', active: true }) },
  })
  setContactRedis(() => client)
  const all = await getAllContacts(SYNTHETIC_TENANT_ID)
  assert(Object.keys(all).length === 0, `a synthetic tenant must never see v1 data -- got ${JSON.stringify(all)}`)
}

async function testSyntheticTenantWritesOnlyItsOwnTenantScopedKey() {
  const client = fakeRedis()
  setContactRedis(() => client)
  await upsertContact(SYNTHETIC_TENANT_ID, 40, { primaryEmail: 'synthetic@example.com' }, OWNER, 'created')
  assert(!client._store[CONTACT_DIRECTORY_KEY], 'a synthetic tenant write must never touch the global v1 key')
  assert(client._store[contactsKeyV2(SYNTHETIC_TENANT_ID)]?.['40'], 'a synthetic tenant write must land on its own tenant-scoped key')
}

// --- Requirement 6a: audit log (list-shaped) follows the same guarantees ----

async function testAuditLogLegacyTenantIgnoresPopulatedV2List() {
  const client = fakeRedis({
    [AUDIT_LOG_KEY]: [JSON.stringify({ id: 'legacy-1', action: 'contact.updated' })],
    [auditLogKeyV2(DEFAULT_TENANT_ID)]: [JSON.stringify({ id: 'shadow-1', action: 'SHOULD_NEVER_BE_SEEN' })],
  })
  setAuditRedis(() => client)
  const { entries } = await listAuditEntries(DEFAULT_TENANT_ID)
  assert(entries.length === 1 && entries[0].id === 'legacy-1', `LEGACY tenant audit reads must ignore a populated v2 list -- got ${JSON.stringify(entries)}`)

  await appendAuditEntry(DEFAULT_TENANT_ID, { action: 'contact.updated', actorId: OWNER.userId })
  assert(client._store[AUDIT_LOG_KEY].length === 2, 'a LEGACY-tenant audit append must land on the v1 list')
  assert(client._store[auditLogKeyV2(DEFAULT_TENANT_ID)].length === 1, 'a LEGACY-tenant audit append must never also grow the v2 list')
}

async function testAuditLogSyntheticTenantNeverReadsGlobalList() {
  const client = fakeRedis({
    [AUDIT_LOG_KEY]: [JSON.stringify({ id: 'los-tres-amigos-real-entry', action: 'contact.updated' })],
  })
  setAuditRedis(() => client)
  const { entries } = await listAuditEntries(SYNTHETIC_TENANT_ID)
  assert(entries.length === 0, `a synthetic tenant must never read the global audit list -- got ${JSON.stringify(entries)}`)
}

// --- Requirement 6b: notification bulk scan follows the same guarantees ----

async function testReplyFailureBulkListLegacyTenantIgnoresV2Prefix() {
  const client = fakeRedis({
    [`${REPLY_FAILURE_PREFIX}rev_legacy`]: JSON.stringify({ reviewId: 'rev_legacy', reason: 'timeout' }),
    [notifReplyFailureKeyV2(DEFAULT_TENANT_ID, 'rev_shadow')]: JSON.stringify({ reviewId: 'rev_shadow', reason: 'SHOULD_NEVER_BE_SEEN' }),
  })
  setNotifRedis(() => client)
  const failures = await listReplyFailures(DEFAULT_TENANT_ID)
  assert(failures.length === 1 && failures[0].reviewId === 'rev_legacy', `LEGACY tenant's bulk reply-failure scan must ignore v2-prefixed keys -- got ${JSON.stringify(failures)}`)

  await recordReplyFailure(DEFAULT_TENANT_ID, 'rev_new', { reason: 'quota' })
  assert(client._store[`${REPLY_FAILURE_PREFIX}rev_new`], 'a LEGACY-tenant reply-failure write must land on the v1-prefixed key')
}

async function testReplyFailureBulkListSyntheticTenantNeverSeesLegacyPrefix() {
  const client = fakeRedis({
    [`${REPLY_FAILURE_PREFIX}rev_los_tres_amigos`]: JSON.stringify({ reviewId: 'rev_los_tres_amigos', reason: 'timeout' }),
  })
  setNotifRedis(() => client)
  const failures = await listReplyFailures(SYNTHETIC_TENANT_ID)
  assert(failures.length === 0, `a synthetic tenant's bulk reply-failure scan must never see v1-prefixed keys -- got ${JSON.stringify(failures)}`)

  await recordReplyFailure(SYNTHETIC_TENANT_ID, 'rev_synth', { reason: 'quota' })
  assert(!client._store[`${REPLY_FAILURE_PREFIX}rev_synth`], 'a synthetic-tenant reply-failure write must never land on a v1-prefixed key')
  assert(client._store[notifReplyFailureKeyV2(SYNTHETIC_TENANT_ID, 'rev_synth')], 'a synthetic-tenant reply-failure write must land on its own tenant-scoped key')
}

// --- Requirement 6c: publish-bridge bulk lookup follows the same guarantees -

async function testPublishBridgeBulkLookupLegacyTenantIgnoresV2Keys() {
  const client = fakeRedis({
    [`${PUBLISH_BRIDGE_PREFIX}rev_1`]: JSON.stringify({ localReviewId: 'rev_1', status: 'pending_google_reconciliation' }),
    [publishBridgeKeyV2(DEFAULT_TENANT_ID, 'rev_1')]: JSON.stringify({ localReviewId: 'rev_1', status: 'SHOULD_NEVER_BE_SEEN' }),
  })
  setBridgeRedis(() => client)
  const bridges = await getPublishBridges(DEFAULT_TENANT_ID, ['rev_1'])
  assert(bridges.rev_1.status === 'pending_google_reconciliation', `LEGACY tenant's bulk bridge lookup must ignore the v2 key -- got ${JSON.stringify(bridges)}`)

  await writePublishBridge(DEFAULT_TENANT_ID, 'rev_2', { gbpReviewName: 'accounts/1/locations/1/reviews/2', responseText: 'Thanks!' })
  assert(client._store[`${PUBLISH_BRIDGE_PREFIX}rev_2`], 'a LEGACY-tenant publish-bridge write must land on the v1-prefixed key')
}

async function testPublishBridgeBulkLookupSyntheticTenantNeverSeesLegacyKeys() {
  const client = fakeRedis({
    [`${PUBLISH_BRIDGE_PREFIX}rev_los_tres_amigos`]: JSON.stringify({ localReviewId: 'rev_los_tres_amigos', status: 'pending_google_reconciliation' }),
  })
  setBridgeRedis(() => client)
  const bridges = await getPublishBridges(SYNTHETIC_TENANT_ID, ['rev_los_tres_amigos'])
  assert(Object.keys(bridges).length === 0, `a synthetic tenant's bulk bridge lookup must never see a v1-prefixed key -- got ${JSON.stringify(bridges)}`)

  await writePublishBridge(SYNTHETIC_TENANT_ID, 'rev_synth', { gbpReviewName: 'accounts/2/locations/1/reviews/1', responseText: 'Thanks!' })
  assert(!client._store[`${PUBLISH_BRIDGE_PREFIX}rev_synth`], 'a synthetic-tenant publish-bridge write must never land on a v1-prefixed key')
  assert(client._store[publishBridgeKeyV2(SYNTHETIC_TENANT_ID, 'rev_synth')], 'a synthetic-tenant publish-bridge write must land on its own tenant-scoped key')
}

// --- Guardrail: the migration mode source of truth itself -------------------

async function testMigrationModeIsNotDerivedFromRedisContentOrEnv() {
  // Structural check: getTenantMigrationMode's decision must be a pure
  // function of tenantId alone -- calling it twice in a row (with no Redis
  // client, no env vars involved at all) must be stable and side-effect-free.
  assert(getTenantMigrationMode(DEFAULT_TENANT_ID) === getTenantMigrationMode(DEFAULT_TENANT_ID))
  assert(getTenantMigrationMode(SYNTHETIC_TENANT_ID) === getTenantMigrationMode(SYNTHETIC_TENANT_ID))
  assert(typeof process.env.TENANT_MIGRATION_MODE === 'undefined', 'Phase 2 hardening must not introduce an env-var-based migration toggle')
}

async function main() {
  await run('read and write key resolution can never disagree, for any shape or tenant', testReadAndWriteKeyResolutionCanNeverDisagree)
  await run('Los Tres Amigos is explicitly pinned to LEGACY mode today', testDefaultTenantIsExplicitlyLegacyModeToday)
  await run('any tenant without an explicit map entry defaults to CUTOVER, never LEGACY', testAnyOtherTenantIsCutoverModeByDefault)
  await run('LEGACY tenant reads v1 even when a populated v2 key exists', testLegacyTenantReadsV1EvenWhenAPopulatedV2KeyExists)
  await run('LEGACY tenant writes land on v1, never v2', testLegacyTenantWritesV1NotV2)
  await run('populating a tenant-scoped key alone never flips which key is authoritative', testPopulatingTenantScopedKeyAloneNeverFlipsWhichKeyIsAuthoritative)
  await run('a synthetic second tenant never reads global v1, even when populated', testSyntheticTenantNeverReadsGlobalV1EvenWhenPopulated)
  await run('a synthetic second tenant writes only its own tenant-scoped key', testSyntheticTenantWritesOnlyItsOwnTenantScopedKey)
  await run('audit log: LEGACY tenant ignores a populated v2 list', testAuditLogLegacyTenantIgnoresPopulatedV2List)
  await run('audit log: a synthetic tenant never reads the global list', testAuditLogSyntheticTenantNeverReadsGlobalList)
  await run('reply-failure bulk scan: LEGACY tenant ignores v2-prefixed keys', testReplyFailureBulkListLegacyTenantIgnoresV2Prefix)
  await run('reply-failure bulk scan: a synthetic tenant never sees legacy-prefixed keys', testReplyFailureBulkListSyntheticTenantNeverSeesLegacyPrefix)
  await run('publish-bridge bulk lookup: LEGACY tenant ignores v2 keys', testPublishBridgeBulkLookupLegacyTenantIgnoresV2Keys)
  await run('publish-bridge bulk lookup: a synthetic tenant never sees legacy keys', testPublishBridgeBulkLookupSyntheticTenantNeverSeesLegacyKeys)
  await run('migration mode is a pure, stable function of tenantId, not Redis content or an env var', testMigrationModeIsNotDerivedFromRedisContentOrEnv)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
