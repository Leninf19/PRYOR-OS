// Regression/adversarial tests for Multi-Tenant Phase 4B -- hardening pass
// over the remaining Google Business Profile flow after Phase 4A's
// tenant-scoped credential storage. Phase 4B's audit found two structural
// gaps neither scoped-authorization (Phase 3) nor credential-scoping
// (Phase 4A) had covered:
//
//   1. trigger-sync / trigger-import dispatch a single, HARDCODED
//      (REPO_OWNER/REPO_NAME) GitHub Actions pipeline that syncs/exports
//      ONE tenant's data (Los Tres Amigos's reviews.db) -- unlike every
//      Redis-backed store and the Phase 4A credential store, this
//      pipeline has no per-tenant equivalent. Before this phase, ANY
//      Owner-role account (regardless of tenant) could dispatch it --
//      a "sync state" cross-tenant gap per the Phase 4B audit brief.
//   2. publish-bridge's bulk read used a bare `locationIds === '*'` check
//      to decide whether to skip per-record location filtering, instead
//      of the tenant-aware isWildcardGrant() -- inconsistent with every
//      other wildcard check in this codebase since Phase 3.
//
// IMPORTANT CONTEXT FOR THIS FILE'S TEST DESIGN: Phase 3's fail-closed
// tenant resolution means a REAL, evaluateSession()-passing HTTP session
// can only ever resolve to DEFAULT_TENANT_ID today -- there is no second
// real tenant, and this phase is explicitly forbidden from creating one
// ("Do not create real Client #2 credentials yet"). So neither of the two
// gaps above can be driven end-to-end through a live, forged HTTP session
// the way Phase 4A's OAuth-state tests could (those forged a STATE token,
// not a whole authenticated session). Instead, each fix is proven three
// ways: (a) a structural source check that the guard exists and is
// positioned before the sensitive operation, (b) a direct unit test of
// the underlying primitive (resolveTenantId/isWildcardGrant) against a
// synthetic non-default-tenant account shape, proving the LOGIC the guard
// depends on is correct, and (c) an HTTP-level regression test proving
// Los Tres Amigos's own behavior is completely unchanged.
//
// No real Upstash account, no real GitHub token, no real Google OAuth
// client, and no production Redis anywhere in this file.
//
// Run directly: node tests/test_phase4b_cross_tenant_adversarial.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'
process.env.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-not-a-real-secret'
process.env.GOOGLE_CLIENT_ID = 'fake-client-id'
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret'
process.env.GITHUB_SYNC_PAT = 'fake-github-pat'

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import bcrypt from 'bcryptjs'
import googleHandler from '../dashboard/api/google/[action].js'
import { signSession, SESSION_COOKIE } from '../dashboard/api/_lib/session.js'
import { requireLocationAccess, isWildcardGrant } from '../dashboard/api/_lib/auth.js'
import { resolveTenantId, DEFAULT_TENANT_ID, tenantOwnsLocationCatalog } from '../dashboard/api/_lib/tenants.js'
import {
  _setRedisClientForTests as setCredentialRedis, _resetRedisClientForTests as resetCredentialRedis,
} from '../dashboard/api/_lib/credentialStore.js'
import { _resetReviewLocationIndexForTests, _setReviewLocationIndexForTests } from '../dashboard/api/_lib/reviewLocationIndex.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const GOOGLE_ACTION_SRC = readFileSync(path.resolve(__dirname, '..', 'dashboard', 'api', 'google', '[action].js'), 'utf-8')

const SYNTHETIC_TENANT_ID = 't_synthetic-second-tenant'
const LTA_LOCATION_ID = 7 // stands in for a real Los Tres Amigos location

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
    resetCredentialRedis()
    _resetReviewLocationIndexForTests()
    _resetLimiterFactoryForTests()
    delete process.env.ACCOUNT_DIRECTORY_JSON
    delete globalThis.fetch
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value; return res }
  res.getHeader = (name) => res.headers[name]
  return res
}

async function seedOwnerDirectory() {
  const hash = await bcrypt.hash('correct-horse-battery-staple', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{ userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' }],
  })
}

async function ownerToken() {
  return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
}

function extractFunctionSource(src, fnName) {
  const start = src.indexOf(`async function ${fnName}(`)
  if (start === -1) return null
  const nextFnMatch = src.slice(start + 1).search(/\nasync function \w+\(|\nexport default async function/)
  return nextFnMatch === -1 ? src.slice(start) : src.slice(start, start + 1 + nextFnMatch)
}

// ===========================================================================
// GAP 1: trigger-sync / trigger-import -- shared, hardcoded-to-LTA pipeline
// ===========================================================================

// --- (a) Structural: the tenant gate exists and runs before the dispatch --

function testTriggerSyncSourceGatesOnDefaultTenantBeforeDispatch() {
  const fnSrc = extractFunctionSource(GOOGLE_ACTION_SRC, 'triggerSync')
  assert(fnSrc, 'could not locate triggerSync() in google/[action].js -- has it been renamed?')
  const gateIdx = fnSrc.search(/resolveTenantId\(account\)\s*!==\s*DEFAULT_TENANT_ID/)
  const dispatchIdx = fnSrc.indexOf('workflows/update-reviews.yml/dispatches')
  assert(gateIdx !== -1, 'triggerSync() must gate on resolveTenantId(account) !== DEFAULT_TENANT_ID')
  assert(dispatchIdx !== -1, 'sanity: the GitHub dispatch call must still exist')
  assert(gateIdx < dispatchIdx, 'the tenant gate must run BEFORE the GitHub Actions dispatch, not after')
}

function testTriggerImportSourceGatesOnDefaultTenantBeforeDispatch() {
  const fnSrc = extractFunctionSource(GOOGLE_ACTION_SRC, 'triggerImport')
  assert(fnSrc, 'could not locate triggerImport() in google/[action].js -- has it been renamed?')
  const gateIdx = fnSrc.search(/resolveTenantId\(account\)\s*!==\s*DEFAULT_TENANT_ID/)
  const dispatchIdx = fnSrc.indexOf('workflows/historical-import.yml/dispatches')
  assert(gateIdx !== -1, 'triggerImport() must gate on resolveTenantId(account) !== DEFAULT_TENANT_ID')
  assert(dispatchIdx !== -1, 'sanity: the GitHub dispatch call must still exist')
  assert(gateIdx < dispatchIdx, 'the tenant gate must run BEFORE the GitHub Actions dispatch, not after')
}

// --- (b) Unit: the underlying predicate correctly distinguishes tenants ---

function testResolveTenantIdPredicateDistinguishesNonDefaultTenant() {
  // The exact condition triggerSync()/triggerImport() evaluate -- proven
  // directly against a synthetic non-default-tenant account shape (the
  // same pattern Phase 3/4A's own tests use), since no real second tenant
  // can be authenticated end-to-end yet.
  const ltaAccount = { userId: 'usr_owner', role: 'owner', locationIds: '*' }
  const syntheticAccount = { userId: 'usr_synthetic', role: 'owner', locationIds: '*', tenantId: SYNTHETIC_TENANT_ID }
  assert(resolveTenantId(ltaAccount) === DEFAULT_TENANT_ID, 'a real LTA account must resolve to DEFAULT_TENANT_ID')
  assert(resolveTenantId(syntheticAccount) !== DEFAULT_TENANT_ID, 'a synthetic non-default tenant account must resolve to something other than DEFAULT_TENANT_ID')
  assert(resolveTenantId(syntheticAccount) === SYNTHETIC_TENANT_ID)
}

// --- (c) HTTP-level regression: Los Tres Amigos behavior unchanged --------

async function testTriggerSyncStillSucceedsForDefaultTenant() {
  await seedOwnerDirectory()
  globalThis.fetch = async (url) => {
    assert(url.includes('workflows/update-reviews.yml/dispatches'), `unexpected fetch: ${url}`)
    return { status: 204 }
  }
  const req = { method: 'POST', query: { action: 'trigger-sync' }, body: {}, headers: { cookie: `${SESSION_COOKIE}=${await ownerToken()}` } }
  const res = fakeRes()
  await googleHandler(req, res)
  assert(res.statusCode === 200 && res.body.success === true, `Los Tres Amigos's Owner must still be able to trigger a sync, got ${res.statusCode} ${JSON.stringify(res.body)}`)
}

async function testTriggerImportStillSucceedsForDefaultTenant() {
  await seedOwnerDirectory()
  globalThis.fetch = async (url) => {
    assert(url.includes('workflows/historical-import.yml/dispatches'), `unexpected fetch: ${url}`)
    return { status: 204 }
  }
  const req = { method: 'POST', query: { action: 'trigger-import' }, body: {}, headers: { cookie: `${SESSION_COOKIE}=${await ownerToken()}` } }
  const res = fakeRes()
  await googleHandler(req, res)
  assert(res.statusCode === 200 && res.body.success === true, `Los Tres Amigos's Owner must still be able to trigger a historical import (dry-run), got ${res.statusCode} ${JSON.stringify(res.body)}`)
}

// ===========================================================================
// GAP 2: publish-bridge's bulk read must use tenant-aware wildcard semantics
// ===========================================================================

function testPublishBridgeSourceUsesIsWildcardGrantNotBareCheck() {
  const fnSrc = extractFunctionSource(GOOGLE_ACTION_SRC, 'publishBridge')
  assert(fnSrc, 'could not locate publishBridge() in google/[action].js -- has it been renamed?')
  assert(/isWildcardGrant\(account\)/.test(fnSrc), 'publishBridge() must gate its per-record location filter on isWildcardGrant(account), not a bare locationIds === \'*\' check')
  assert(!/account\.locationIds\s*!==\s*'\*'/.test(fnSrc), 'publishBridge() must no longer use the raw, tenant-unaware locationIds !== \'*\' check')
}

// --- Unit: isWildcardGrant/requireLocationAccess correctly deny a          -
//     non-onboarded tenant's wildcard grant against an LTA-shaped record --

function testWildcardGrantForNonOnboardedTenantNeverBypassesLocationFilter() {
  const syntheticWildcardAccount = { userId: 'usr_synthetic', role: 'owner', locationIds: '*', tenantId: SYNTHETIC_TENANT_ID }
  assert(!isWildcardGrant(syntheticWildcardAccount), 'a wildcard grant for a tenant that owns no location catalog must never be treated as company-wide')
  assert(!tenantOwnsLocationCatalog(SYNTHETIC_TENANT_ID), 'a non-onboarded tenant must own no location catalog')
  // Even with a record whose locationId is a real LTA location, the
  // synthetic tenant's account must still be denied -- this is exactly
  // the per-record check publishBridge() now runs whenever
  // isWildcardGrant() is false.
  assert(!requireLocationAccess(syntheticWildcardAccount, LTA_LOCATION_ID), 'a synthetic tenant\'s wildcard account must never be granted an LTA location via the bridge filter')
}

function testWildcardGrantForLtaStillBypassesFilterAsBefore() {
  const ltaWildcardAccount = { userId: 'usr_owner', role: 'owner', locationIds: '*' }
  assert(isWildcardGrant(ltaWildcardAccount), 'Los Tres Amigos\'s own wildcard accounts must remain unrestricted, unchanged by this fix')
}

// --- HTTP-level regression: LTA's own publish-bridge bulk read unaffected -

async function testPublishBridgeStillWorksForDefaultTenantWildcardAccount() {
  await seedOwnerDirectory()
  const req = {
    method: 'POST', query: { action: 'publish-bridge' }, body: { ids: ['rev-1', 'rev-2'] },
    headers: { cookie: `${SESSION_COOKIE}=${await ownerToken()}` },
  }
  const res = fakeRes()
  await googleHandler(req, res)
  // No bridge records exist for these ids (nothing was ever written) --
  // the important assertion is that the call succeeds cleanly (200) for
  // LTA's own wildcard Owner, exactly as before this fix.
  assert(res.statusCode === 200 && typeof res.body.bridges === 'object', `expected a clean 200 with a bridges object, got ${res.statusCode} ${JSON.stringify(res.body)}`)
}

// ===========================================================================
// GENERAL ADVERSARIAL PROBES -- re-confirm Phase 3/4A guarantees hold when
// combined with Phase 4B's fixes (defense-in-depth, not new mechanisms)
// ===========================================================================

async function testSyntheticTenantCannotResolveAnyLtaReviewLocation() {
  // The private review-location index is LTA-only data by construction
  // (export_chunks.py only ever runs against LTA's reviews.db) --
  // regardless of what a synthetic tenant's account shape claims
  // (wildcard or explicit array), it can never be authorized against any
  // entry in that index, because tenantOwnsLocationCatalog() denies it
  // before the account's own grant is ever consulted.
  _setReviewLocationIndexForTests({ 'lta-review-1': LTA_LOCATION_ID })
  const syntheticScoped = { userId: 'usr_synthetic', role: 'location_manager', locationIds: [LTA_LOCATION_ID], tenantId: SYNTHETIC_TENANT_ID }
  const syntheticWildcard = { userId: 'usr_synthetic', role: 'owner', locationIds: '*', tenantId: SYNTHETIC_TENANT_ID }
  assert(!requireLocationAccess(syntheticScoped, LTA_LOCATION_ID), 'a synthetic tenant with a numerically-colliding explicit grant must never resolve an LTA review location')
  assert(!requireLocationAccess(syntheticWildcard, LTA_LOCATION_ID), 'a synthetic tenant\'s wildcard grant must never resolve an LTA review location')
}

async function testDisconnectTenantGateUnaffectedByThisPhase() {
  // Regression: Phase 4A's disconnect()/status()/publish() tenant scoping
  // must remain fully intact after Phase 4B's changes -- exercised here
  // via the real handler for the one tenant that can actually authenticate.
  await seedOwnerDirectory()
  const client = { get: async () => null, set: async () => {}, del: async () => {} }
  setCredentialRedis(() => client)
  const req = {
    method: 'POST', query: { action: 'disconnect' }, body: { confirm: 'DISCONNECT' },
    headers: { cookie: `${SESSION_COOKIE}=${await ownerToken()}` },
  }
  const res = fakeRes()
  await googleHandler(req, res)
  assert(res.statusCode === 200 && res.body.success === true, 'disconnect must still work correctly for Los Tres Amigos after Phase 4B')
}

async function main() {
  console.log('--- GAP 1: trigger-sync / trigger-import tenant gate ---')
  await run('triggerSync() source gates on DEFAULT_TENANT_ID before dispatching', testTriggerSyncSourceGatesOnDefaultTenantBeforeDispatch)
  await run('triggerImport() source gates on DEFAULT_TENANT_ID before dispatching', testTriggerImportSourceGatesOnDefaultTenantBeforeDispatch)
  await run('resolveTenantId correctly distinguishes a non-default tenant account', testResolveTenantIdPredicateDistinguishesNonDefaultTenant)
  await run('trigger-sync still succeeds for Los Tres Amigos (regression)', testTriggerSyncStillSucceedsForDefaultTenant)
  await run('trigger-import still succeeds for Los Tres Amigos (regression)', testTriggerImportStillSucceedsForDefaultTenant)

  console.log('\n--- GAP 2: publish-bridge tenant-aware wildcard semantics ---')
  await run('publishBridge() source uses isWildcardGrant(), not a bare locationIds check', testPublishBridgeSourceUsesIsWildcardGrantNotBareCheck)
  await run('a wildcard grant for a non-onboarded tenant never bypasses the per-record location filter', testWildcardGrantForNonOnboardedTenantNeverBypassesLocationFilter)
  await run('Los Tres Amigos\'s own wildcard accounts still bypass the filter as before', testWildcardGrantForLtaStillBypassesFilterAsBefore)
  await run('publish-bridge bulk read still works cleanly for Los Tres Amigos (regression)', testPublishBridgeStillWorksForDefaultTenantWildcardAccount)

  console.log('\n--- GENERAL ADVERSARIAL PROBES ---')
  await run('a synthetic tenant can never resolve any LTA review location, scoped or wildcard', testSyntheticTenantCannotResolveAnyLtaReviewLocation)
  await run('disconnect() tenant scoping remains intact after Phase 4B', testDisconnectTenantGateUnaffectedByThisPhase)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
