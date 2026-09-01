// Regression tests for Multi-Tenant Phase 1 (Additive Data Model & Los
// Tres Amigos Tenant Backfill) -- dashboard/api/_lib/tenants.js,
// tenantKeys.js, tenantLocation.js, and scripts/migrate-tenant-backfill.js.
//
// No real Upstash account, no real Google credentials, no production
// Redis connection anywhere in this file -- every Redis-touching test
// drives the migration script's test-only client-factory seam, same
// pattern as test_credential_store.js/test_action_store.js. This file
// also proves that NOTHING in the existing single-tenant codebase changed
// behavior: it cross-checks every real store file's own v1 (or v2, for
// tasks) key constant against tenantKeys.js's V1_TO_V2_KEY_MAP, and it
// never imports, modifies, or asserts anything about auth.js,
// accountStore.js, credentialStore.js, or data.js's actual runtime logic
// -- those are covered by their own existing, unmodified test files
// (test_auth.js, test_authorization_matrix.js, test_credential_store.js,
// test_data_endpoint.js), which this phase does not touch.
//
// Run directly: node tests/test_tenant_model.js

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

import {
  DEFAULT_TENANT_ID, LOS_TRES_AMIGOS_TENANT, TenantRole,
  LEGACY_ROLE_TO_TENANT_ROLE, isValidTenantId, isValidTenant,
  isKnownTenantRole, isValidLocationGrant, isValidTenantMembership,
  buildLosTresAmigosMembership, isPlatformOwnerEmail,
} from '../dashboard/api/_lib/tenants.js'

import {
  usersKeyV2, usersEmailIndexKeyV2, contactsKeyV2, actionWorkspaceKeyV2,
  campaignsKeyV2, contentAssetsKeyV2, tasksKeyV3, auditLogKeyV2,
  notifSeededKeyV2, notifReplyFailureKeyV2, notifReadStateKeyV2,
  publishBridgeKeyV2, credentialKeyV2, V1_TO_V2_KEY_MAP,
} from '../dashboard/api/_lib/tenantKeys.js'

import { isValidBaseLocation, withTenantId, withTenantIdForAllLocations } from '../dashboard/api/_lib/tenantLocation.js'

import { ROLES } from '../dashboard/api/_lib/accounts.js'

import { spawnSync } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DASHBOARD_ROOT = path.join(__dirname, '..', 'dashboard')

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
  }
}

// --- Tenant identity ------------------------------------------------

function testDefaultTenantIdIsStable() {
  assert(DEFAULT_TENANT_ID === 't_los-tres-amigos', 'DEFAULT_TENANT_ID must be the exact stable, hand-assigned id')
  assert(isValidTenantId(DEFAULT_TENANT_ID), 'DEFAULT_TENANT_ID must pass its own validator')
}

function testLosTresAmigosTenantIsValid() {
  assert(isValidTenant(LOS_TRES_AMIGOS_TENANT), 'the Phase 1 tenant record must pass isValidTenant')
  assert(LOS_TRES_AMIGOS_TENANT.tenantId === DEFAULT_TENANT_ID)
  assert(LOS_TRES_AMIGOS_TENANT.status === 'active')
}

function testInvalidTenantIdsRejected() {
  for (const bad of [null, undefined, '', 'los-tres-amigos', 'T_LOS-TRES-AMIGOS', 't_', 't_HasCaps', 123]) {
    assert(!isValidTenantId(bad), `expected ${JSON.stringify(bad)} to be an invalid tenantId`)
  }
}

// --- Roles ------------------------------------------------------------

function testAllSixRolesExist() {
  const expected = ['platform_owner', 'tenant_owner', 'tenant_admin', 'marketing', 'location_manager', 'read_only']
  const actual = Object.values(TenantRole).sort()
  assert(
    JSON.stringify(actual) === JSON.stringify(expected.slice().sort()),
    `TenantRole must contain exactly ${expected.join(', ')}, got ${actual.join(', ')}`
  )
}

function testEveryExistingRoleMapsToATenantRole() {
  for (const legacyRole of ROLES) {
    const mapped = LEGACY_ROLE_TO_TENANT_ROLE[legacyRole]
    assert(isKnownTenantRole(mapped), `existing role "${legacyRole}" must map to a known TenantRole`)
    assert(mapped !== TenantRole.PLATFORM_OWNER, `no existing role may map to platform_owner (got this for "${legacyRole}")`)
  }
}

function testAccountsRolesUnchanged() {
  // Locks in that Phase 1 did not rename/remove any existing role --
  // accounts.js's ROLES is the single source of truth this phase must
  // never touch.
  assert(
    JSON.stringify(ROLES) === JSON.stringify(['owner', 'admin', 'marketing', 'location_manager', 'read_only']),
    'accounts.js ROLES must be unchanged by Multi-Tenant Phase 1'
  )
}

// --- Location grant / wildcard semantics -----------------------------

function testWildcardIsAValidLocationGrant() {
  assert(isValidLocationGrant('*'), "'*' must be a valid location grant")
}

function testExplicitLocationArraysValidated() {
  assert(isValidLocationGrant([1, 2, 3]), 'a non-empty array of positive integers must be valid')
  assert(!isValidLocationGrant([]), 'an empty array must be invalid (matches accounts.js\'s existing rule)')
  assert(!isValidLocationGrant([-1]), 'a negative id must be invalid')
  assert(!isValidLocationGrant([1.5]), 'a non-integer id must be invalid')
  assert(!isValidLocationGrant('all'), 'any string other than the literal "*" must be invalid')
  assert(!isValidLocationGrant(null), 'null must be invalid')
}

function testTenantMembershipRejectsPlatformOwnerRole() {
  const membership = { tenantId: DEFAULT_TENANT_ID, userId: 'u1', role: TenantRole.PLATFORM_OWNER, locationIds: '*' }
  assert(!isValidTenantMembership(membership), 'a TenantMembership must never carry the platform_owner role')
}

function testValidTenantMembershipShape() {
  const membership = { tenantId: DEFAULT_TENANT_ID, userId: 'u1', role: TenantRole.TENANT_OWNER, locationIds: '*', canCreateTasks: false }
  assert(isValidTenantMembership(membership), 'a well-formed membership must pass validation')
}

// --- buildLosTresAmigosMembership (the backfill transform) ------------

function testBuildMembershipPreservesLocationIdsAndFlags() {
  const account = { userId: 'u42', role: 'location_manager', locationIds: [3], canCreateTasks: true }
  const membership = buildLosTresAmigosMembership(account)
  assert(membership.tenantId === DEFAULT_TENANT_ID)
  assert(membership.userId === 'u42')
  assert(membership.role === TenantRole.LOCATION_MANAGER)
  assert(JSON.stringify(membership.locationIds) === JSON.stringify([3]), 'locationIds must round-trip exactly, unchanged')
  assert(membership.canCreateTasks === true)
}

function testBuildMembershipHandlesWildcardOwner() {
  const account = { userId: 'u1', role: 'owner', locationIds: '*' }
  const membership = buildLosTresAmigosMembership(account)
  assert(membership.role === TenantRole.TENANT_OWNER)
  assert(membership.locationIds === '*')
}

function testBuildMembershipThrowsOnUnknownRole() {
  let threw = false
  try {
    buildLosTresAmigosMembership({ userId: 'u1', role: 'super_admin', locationIds: '*' })
  } catch (err) {
    threw = /unrecognized legacy role/.test(err.message)
  }
  assert(threw, 'an unrecognized legacy role must throw a clear error, never silently default to a role')
}

function testBuildMembershipDoesNotMutateInput() {
  const account = Object.freeze({ userId: 'u1', role: 'marketing', locationIds: [1, 2] })
  buildLosTresAmigosMembership(account) // would throw TypeError on write if this tried to mutate a frozen object
}

// --- Platform owner (identity check only, no bypass) -------------------

function testPlatformOwnerAllowlistEmptyByDefault() {
  const original = process.env.PLATFORM_OWNER_EMAILS
  delete process.env.PLATFORM_OWNER_EMAILS
  try {
    assert(isPlatformOwnerEmail('anyone@example.com') === false, 'with no allowlist configured, nobody is a platform owner -- Phase 1 introduces no bypass')
  } finally {
    if (original !== undefined) process.env.PLATFORM_OWNER_EMAILS = original
  }
}

function testPlatformOwnerAllowlistHonored() {
  const original = process.env.PLATFORM_OWNER_EMAILS
  process.env.PLATFORM_OWNER_EMAILS = 'owner@example.com, Other@Example.com'
  try {
    assert(isPlatformOwnerEmail('owner@example.com') === true)
    assert(isPlatformOwnerEmail('OTHER@example.com') === true, 'comparison must be case-insensitive')
    assert(isPlatformOwnerEmail('random@example.com') === false)
    assert(isPlatformOwnerEmail('') === false)
    assert(isPlatformOwnerEmail(null) === false)
  } finally {
    if (original === undefined) delete process.env.PLATFORM_OWNER_EMAILS
    else process.env.PLATFORM_OWNER_EMAILS = original
  }
}

// --- Key builders -------------------------------------------------

function testKeyBuildersProduceExactExpectedStrings() {
  const t = DEFAULT_TENANT_ID
  assert(usersKeyV2(t) === `users:v2:${t}`)
  assert(usersEmailIndexKeyV2(t) === `users_email_index:v2:${t}`)
  assert(contactsKeyV2(t) === `restaurant_contacts:v2:${t}`)
  assert(actionWorkspaceKeyV2(t) === `action_workspace:v2:${t}`)
  assert(campaignsKeyV2(t) === `content_campaigns:v2:${t}`)
  assert(contentAssetsKeyV2(t) === `content_assets:v2:${t}`)
  assert(tasksKeyV3(t) === `tasks:v3:${t}`)
  assert(auditLogKeyV2(t) === `audit_log:v2:${t}`)
  assert(credentialKeyV2(t) === `gbp_credentials:v2:${t}`)
  assert(notifSeededKeyV2(t, 'u1') === `notif_seeded:v2:${t}:u1`)
  assert(notifReplyFailureKeyV2(t, 'r1') === `notif_reply_failed:v2:${t}:r1`)
  assert(notifReadStateKeyV2(t, 'u1') === `notif_read:v2:${t}:u1`)
  assert(publishBridgeKeyV2(t, 'r1') === `publish_bridge:v2:${t}:r1`)
}

function testKeyBuildersThrowOnInvalidTenantId() {
  for (const bad of [null, undefined, '', 'not-a-tenant-id']) {
    let threw = false
    try { usersKeyV2(bad) } catch { threw = true }
    assert(threw, `usersKeyV2(${JSON.stringify(bad)}) must throw rather than build a malformed key`)
  }
}

// This is the regression-proofing test: if any real store file's own key
// constant ever changes, this test must fail loudly rather than letting
// V1_TO_V2_KEY_MAP silently drift out of sync with production reality.
function testV1KeyMapMatchesRealStoreFiles() {
  const checks = [
    { file: 'userStore.js', constant: 'USERS_KEY', expected: 'users:v1' },
    { file: 'userStore.js', constant: 'EMAIL_INDEX_KEY', expected: 'users_email_index:v1' },
    { file: 'contactStore.js', constant: 'CONTACT_DIRECTORY_KEY', expected: 'restaurant_contacts:v1' },
    { file: 'actionStore.js', constant: 'ACTION_WORKSPACE_KEY', expected: 'action_workspace:v1' },
    { file: 'campaignStore.js', constant: 'CAMPAIGN_KEY', expected: 'content_campaigns:v1' },
    { file: 'contentAssetStore.js', constant: 'ASSET_KEY', expected: 'content_assets:v1' },
    { file: 'taskStore.js', constant: 'TASK_KEY', expected: 'tasks:v2' },
    { file: 'auditLog.js', constant: 'AUDIT_LOG_KEY', expected: 'audit_log:v1' },
    { file: 'credentialStore.js', constant: 'CREDENTIAL_KEY', expected: 'gbp_credentials:v1' },
  ]
  for (const { file, constant, expected } of checks) {
    const source = readFileSync(path.join(DASHBOARD_ROOT, 'api', '_lib', file), 'utf-8')
    const re = new RegExp(`const ${constant}\\s*=\\s*'([^']+)'`)
    const match = source.match(re)
    assert(match, `${file}: could not find constant ${constant} -- update this test if it was intentionally renamed`)
    assert(match[1] === expected, `${file}'s ${constant} is "${match[1]}", expected "${expected}" -- V1_TO_V2_KEY_MAP or this test is out of sync with production`)
  }
  const mappedV1Keys = V1_TO_V2_KEY_MAP.map(e => e.v1Key).sort()
  const expectedV1Keys = checks.map(c => c.expected).sort()
  assert(
    JSON.stringify(mappedV1Keys) === JSON.stringify(expectedV1Keys),
    `V1_TO_V2_KEY_MAP's key set (${mappedV1Keys.join(', ')}) must exactly match the audited real key set (${expectedV1Keys.join(', ')})`
  )
}

// --- Location backfill -------------------------------------------------

const SAMPLE_LOCATION = Object.freeze({
  locationId: 20, name: 'Casa Tequila Brighton', city: 'Brighton',
  brand: 'Casa Tequila', slug: 'casa-tequila-brighton',
  maps_url: 'https://maps.example.com/x', hasContact: false,
})

function testIsValidBaseLocation() {
  assert(isValidBaseLocation(SAMPLE_LOCATION))
  assert(!isValidBaseLocation({ name: 'no id or slug' }))
}

function testWithTenantIdPreservesEveryField() {
  const tagged = withTenantId(SAMPLE_LOCATION, DEFAULT_TENANT_ID)
  for (const key of Object.keys(SAMPLE_LOCATION)) {
    assert(tagged[key] === SAMPLE_LOCATION[key], `withTenantId must preserve "${key}" unchanged`)
  }
  assert(tagged.tenantId === DEFAULT_TENANT_ID)
}

function testWithTenantIdDoesNotMutateInput() {
  withTenantId(SAMPLE_LOCATION, DEFAULT_TENANT_ID) // SAMPLE_LOCATION is frozen; a mutation attempt would throw
  assert(SAMPLE_LOCATION.tenantId === undefined, 'the original location object must be untouched')
}

function testWithTenantIdRejectsUserFacingIdChanges() {
  const tagged = withTenantId(SAMPLE_LOCATION, DEFAULT_TENANT_ID)
  assert(tagged.locationId === 20 && tagged.slug === 'casa-tequila-brighton' && tagged.name === 'Casa Tequila Brighton',
    'locationId/slug/name must never change as part of tenant tagging')
}

function testWithTenantIdForAllLocationsPreservesMetaShape() {
  const meta = Object.freeze({
    locations: Object.freeze([SAMPLE_LOCATION, Object.freeze({ locationId: 1, name: 'A', slug: 'a' })]),
    brands: Object.freeze(['Casa Tequila']),
    totalReviews: 3150,
    generatedAt: '2026-08-31T00:00:00.000Z',
  })
  const tagged = withTenantIdForAllLocations(meta, DEFAULT_TENANT_ID)
  assert(tagged.locations.length === 2)
  assert(tagged.locations.every(l => l.tenantId === DEFAULT_TENANT_ID))
  assert(tagged.brands === meta.brands, 'unrelated top-level fields must be carried over unchanged')
  assert(tagged.totalReviews === 3150)
  assert(meta.locations[0].tenantId === undefined, 'the original meta object must be untouched')
}

// --- Real meta.json compatibility (read-only) ---------------------------
// Proves the backfill transform actually works against the real, current
// production location dataset shape -- read-only, never writes the file.

function testRealMetaJsonLocationsAreBackfillable() {
  const metaPath = path.join(DASHBOARD_ROOT, 'private-data', 'meta.json')
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
  assert(Array.isArray(meta.locations) && meta.locations.length > 0, 'expected at least one real location in private-data/meta.json')
  const tagged = withTenantIdForAllLocations(meta, DEFAULT_TENANT_ID)
  assert(tagged.locations.length === meta.locations.length)
  for (let i = 0; i < meta.locations.length; i++) {
    assert(tagged.locations[i].locationId === meta.locations[i].locationId, 'every real location\'s id must survive backfill unchanged')
    assert(tagged.locations[i].slug === meta.locations[i].slug, 'every real location\'s slug must survive backfill unchanged')
    assert(tagged.locations[i].tenantId === DEFAULT_TENANT_ID)
  }
}

// --- Migration script: dry-run behavior, read-only enforcement ---------

function fakeReadOnlyRedis({ hashes = {}, list = [], credential = null } = {}) {
  // Deliberately defines ONLY read methods. If runDryRun ever called a
  // write method (hset/set/lpush/del/expire/...), the call would throw
  // "not a function" and the test below would fail loudly -- this is the
  // proof that the dry run never writes, not just an assertion about it.
  return {
    hgetall: async (key) => hashes[key] ?? {},
    lrange: async (key) => (key === 'audit_log:v1' ? list : []),
    get: async (key) => (key === 'gbp_credentials:v1' ? credential : null),
  }
}

async function testDryRunReportsCountsAndDestinationKeys() {
  const mod = await import('../dashboard/scripts/migrate-tenant-backfill.js')
  const client = fakeReadOnlyRedis({
    hashes: {
      'users:v1': { u1: JSON.stringify({ userId: 'u1' }), u2: JSON.stringify({ userId: 'u2' }) },
      'restaurant_contacts:v1': { '1': JSON.stringify({ locationId: 1 }) },
    },
    list: [JSON.stringify({ action: 'login' }), JSON.stringify({ action: 'logout' })],
    credential: JSON.stringify({ refreshTokenCiphertext: 'not-a-real-secret' }),
  })
  mod._setRedisClientForTests(() => client)
  try {
    const result = await mod.runDryRun(DEFAULT_TENANT_ID)
    assert(result.tenantId === DEFAULT_TENANT_ID)
    assert(result.mode === 'dry-run')

    const users = result.reports.find(r => r.sourceKey === 'users:v1')
    assert(users.recordCount === 2, `expected 2 user records, got ${users.recordCount}`)
    assert(users.destinationKey === `users:v2:${DEFAULT_TENANT_ID}`)
    assert(users.status === 'read_ok')

    const contacts = result.reports.find(r => r.sourceKey === 'restaurant_contacts:v1')
    assert(contacts.recordCount === 1)

    const audit = result.reports.find(r => r.sourceKey === 'audit_log:v1')
    assert(audit.recordCount === 2, 'audit_log:v1 must be read via lrange, counted as a list')
    assert(audit.destinationKey === `audit_log:v2:${DEFAULT_TENANT_ID}`)

    const cred = result.reports.find(r => r.sourceKey === 'gbp_credentials:v1')
    assert(cred.recordCount === 1)
    assert(cred.destinationKey === `gbp_credentials:v2:${DEFAULT_TENANT_ID}`)

    // Empty/unmentioned hash stores must still be reported, at zero, never omitted.
    const campaigns = result.reports.find(r => r.sourceKey === 'content_campaigns:v1')
    assert(campaigns && campaigns.recordCount === 0 && campaigns.status === 'read_ok')
  } finally {
    mod._resetRedisClientForTests()
  }
}

async function testDryRunReportsValidationFailures() {
  const mod = await import('../dashboard/scripts/migrate-tenant-backfill.js')
  const client = fakeReadOnlyRedis({
    hashes: { 'users:v1': { u1: 'not-valid-json{{{' } },
  })
  mod._setRedisClientForTests(() => client)
  try {
    const result = await mod.runDryRun(DEFAULT_TENANT_ID)
    const users = result.reports.find(r => r.sourceKey === 'users:v1')
    assert(users.validationFailures.length === 1, 'a malformed record must be reported as a validation failure, not silently dropped or thrown')
    assert(users.validationFailures[0].field === 'u1')
  } finally {
    mod._resetRedisClientForTests()
  }
}

async function testDryRunSkipsGracefullyWhenNotConfigured() {
  const mod = await import('../dashboard/scripts/migrate-tenant-backfill.js')
  mod._setRedisClientForTests(() => null)
  try {
    const result = await mod.runDryRun(DEFAULT_TENANT_ID)
    assert(result.reports.every(r => r.status === 'skipped_not_configured'), 'with no client available, every store must be reported as skipped, never throw')
  } finally {
    mod._resetRedisClientForTests()
  }
}

// Runs the actual CLI (a real subprocess, not the imported module) to
// prove --write is refused end-to-end, including the process exit code --
// this is the strongest possible guarantee that write mode cannot run in
// Phase 1 regardless of how it's invoked.
function testCliRefusesWriteFlag() {
  const scriptPath = path.join(DASHBOARD_ROOT, 'scripts', 'migrate-tenant-backfill.js')
  const proc = spawnSync(process.execPath, [scriptPath, '--write'], { encoding: 'utf-8' })
  assert(proc.status !== 0, '--write must exit non-zero')
  assert(/does not implement write mode/.test(proc.stderr), 'stderr must clearly explain that write mode is not implemented in Phase 1')
}

function testCliDryRunExitsCleanly() {
  const scriptPath = path.join(DASHBOARD_ROOT, 'scripts', 'migrate-tenant-backfill.js')
  const env = { ...process.env }
  delete env.UPSTASH_REDIS_REST_URL
  delete env.UPSTASH_REDIS_REST_TOKEN
  const proc = spawnSync(process.execPath, [scriptPath], { encoding: 'utf-8', env })
  assert(proc.status === 0, `dry run with no flags must exit 0, got ${proc.status}: ${proc.stderr}`)
  assert(/DRY RUN/.test(proc.stdout))
  assert(/No Redis key was written/.test(proc.stdout))
}

async function main() {
  await run('DEFAULT_TENANT_ID is the stable, hand-assigned id', testDefaultTenantIdIsStable)
  await run('LOS_TRES_AMIGOS_TENANT passes its own validator', testLosTresAmigosTenantIsValid)
  await run('malformed tenant ids are rejected', testInvalidTenantIdsRejected)
  await run('all six roles exist, exactly', testAllSixRolesExist)
  await run('every existing legacy role maps to a known, non-platform-owner TenantRole', testEveryExistingRoleMapsToATenantRole)
  await run('accounts.js ROLES is unchanged by Phase 1', testAccountsRolesUnchanged)
  await run("'*' is a valid location grant", testWildcardIsAValidLocationGrant)
  await run('explicit location-id arrays are validated correctly', testExplicitLocationArraysValidated)
  await run('a TenantMembership can never carry role: platform_owner', testTenantMembershipRejectsPlatformOwnerRole)
  await run('a well-formed TenantMembership passes validation', testValidTenantMembershipShape)
  await run('buildLosTresAmigosMembership preserves locationIds and canCreateTasks exactly', testBuildMembershipPreservesLocationIdsAndFlags)
  await run('buildLosTresAmigosMembership handles a wildcard owner account', testBuildMembershipHandlesWildcardOwner)
  await run('buildLosTresAmigosMembership throws on an unrecognized role', testBuildMembershipThrowsOnUnknownRole)
  await run('buildLosTresAmigosMembership does not mutate its input account', testBuildMembershipDoesNotMutateInput)
  await run('platform-owner allowlist is empty by default -- no bypass introduced', testPlatformOwnerAllowlistEmptyByDefault)
  await run('platform-owner allowlist is honored, case-insensitively, when explicitly configured', testPlatformOwnerAllowlistHonored)
  await run('every key builder produces the exact expected v2/v3 string', testKeyBuildersProduceExactExpectedStrings)
  await run('every key builder throws on an invalid tenantId', testKeyBuildersThrowOnInvalidTenantId)
  await run("V1_TO_V2_KEY_MAP matches every real store file's own v1 key constant", testV1KeyMapMatchesRealStoreFiles)
  await run('isValidBaseLocation requires locationId/name/slug', testIsValidBaseLocation)
  await run('withTenantId preserves every existing field unchanged', testWithTenantIdPreservesEveryField)
  await run('withTenantId does not mutate its input location', testWithTenantIdDoesNotMutateInput)
  await run('withTenantId never changes locationId/slug/name', testWithTenantIdRejectsUserFacingIdChanges)
  await run('withTenantIdForAllLocations preserves meta.json\'s other top-level fields', testWithTenantIdForAllLocationsPreservesMetaShape)
  await run('the real private-data/meta.json locations are backfillable without changing any id/slug', testRealMetaJsonLocationsAreBackfillable)
  await run('dry run reports accurate counts and destination keys for every store', testDryRunReportsCountsAndDestinationKeys)
  await run('dry run reports validation failures without throwing', testDryRunReportsValidationFailures)
  await run('dry run reports every store as skipped when Redis is not configured', testDryRunSkipsGracefullyWhenNotConfigured)
  await run('the CLI refuses --write with a non-zero exit and a clear message', testCliRefusesWriteFlag)
  await run('the CLI dry run (no flags) exits 0 and never claims a write happened', testCliDryRunExitsCleanly)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
