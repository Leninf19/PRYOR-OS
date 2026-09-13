// Phase B.4 -- commercial storage quota (Part B). Regression tests for the
// commercial storage/asset-count check added to dashboard/api/content/
// [action].js's upload() -- inserted INSIDE the SAME per-tenant upload
// lease/critical section as the pre-existing Phase A platform-safety
// ceiling (2GB/2000 assets, unchanged, tests/test_content_endpoint.js), as
// a SEPARATE, earlier check. Mirrors tests/test_content_endpoint.js's own
// fake-Redis/fake-Blob harness, but seeds a genuine NON-BOOTSTRAP tenant
// with real commercial plan data (test_content_endpoint.js's tenant is
// always LTA's static-directory BOOTSTRAP tenant, which this new
// commercial layer must never enforce anything against).
//
// Run directly: node tests/test_storage_commercial_quota.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import { readFileSync } from 'fs'
import handler, {
  _setUploadLockRenewIntervalMsForTests, _resetUploadLockRenewIntervalMsForTests,
} from '../dashboard/api/content/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests as _setCampaignRedis, _resetRedisClientForTests as _resetCampaignRedis } from '../dashboard/api/_lib/campaignStore.js'
import {
  _setRedisClientForTests as _setAssetRedis, _resetRedisClientForTests as _resetAssetRedis,
} from '../dashboard/api/_lib/contentAssetStore.js'
import { _setBlobClientForTests, _resetBlobClientForTests } from '../dashboard/api/_lib/blobStore.js'
import {
  upsertTenantConfig,
  _setRedisClientForTests as _setConfigRedis, _resetRedisClientForTests as _resetConfigRedis,
} from '../dashboard/api/_lib/tenantConfigStore.js'
import {
  upsertUser, UserCreationMode,
  _setRedisClientForTests as _setUserStoreRedis, _resetRedisClientForTests as _resetUserStoreRedis,
} from '../dashboard/api/_lib/userStore.js'
import { DEFAULT_TENANT_ID } from '../dashboard/api/_lib/tenants.js'

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
    _resetCampaignRedis()
    _resetAssetRedis()
    _resetConfigRedis()
    _resetUserStoreRedis()
    _resetBlobClientForTests()
    _resetUploadLockRenewIntervalMsForTests()
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

// Same shape as test_content_endpoint.js's own fakeRedis() -- one FLAT hash
// namespace (the key argument is deliberately ignored) + one string
// namespace (for the SET NX EX upload lease) per fake instance, with an
// eval() emulating both the lease's RENEW_SCRIPT (2 args) and
// RELEASE_SCRIPT (1 arg). Safe for campaignStore.js/contentAssetStore.js
// specifically because each of those uses exactly ONE hash key internally
// in this file's usage -- NOT safe for userStore.js (a record hash + a
// separate email-identity-index hash, which a flat/key-ignoring store would
// silently merge into one namespace) or tenantConfigStore.js -- see
// fakeKeyedHashRedis() below for those.
function fakeRedis() {
  const store = {}
  const strings = {}
  return {
    hgetall: async () => ({ ...store }),
    hget: async (_key, field) => store[field] ?? null,
    hset: async (_key, fields) => { Object.assign(store, fields) },
    hdel: async (_key, field) => { const had = field in store; delete store[field]; return had ? 1 : 0 },
    set: async (key, value, opts) => {
      if (opts?.nx && key in strings) return null
      strings[key] = value
      return 'OK'
    },
    del: async (key) => { const had = key in strings; delete strings[key]; return had ? 1 : 0 },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [token] = args
      if (strings[key] !== token) return 0
      if (args.length === 1) delete strings[key] // RELEASE_SCRIPT
      return 1 // RENEW_SCRIPT
    },
  }
}

// Properly KEYED hash store (mirrors tests/test_ai_tenant_limits.js's own
// fakeRedisWithEval()) -- required for userStore.js (a main record hash
// PLUS a separate email-identity-index hash; a flat/key-ignoring fake would
// silently merge the two, breaking getAccountByEmail()'s identity-index
// lookup and producing spurious 401s) and tenantConfigStore.js (its
// CAS_UPSERT_SCRIPT eval shape: [field, expectedVersionStr, nextJson]).
function fakeKeyedHashRedis() {
  const store = {}
  return {
    hget: async (key, field) => store[key]?.[field] ?? null,
    hgetall: async (key) => ({ ...(store[key] ?? {}) }),
    hset: async (key, fields) => { store[key] = { ...(store[key] ?? {}), ...fields } },
    hdel: async (key, field) => { if (store[key]) delete store[key][field] },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [field, expectedVersionStr, nextJson] = args
      const raw = store[key]?.[field] ?? null
      let currentVersion = '0'
      if (raw) {
        try { const decoded = JSON.parse(raw); if (decoded && decoded.configVersion !== undefined) currentVersion = String(decoded.configVersion) } catch { /* version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
  }
}

function installFakeConfigRedis() {
  const client = fakeKeyedHashRedis()
  _setConfigRedis(() => client)
  return client
}
function installFakeUserRedis() {
  const client = fakeKeyedHashRedis()
  _setUserStoreRedis(() => client)
  return client
}
function installFakeCampaignRedis() {
  const client = fakeRedis()
  _setCampaignRedis(() => client)
  return client
}
function installFakeAssetRedis() {
  const client = fakeRedis()
  _setAssetRedis(() => client)
  return client
}

function fakeBlob() {
  const blobs = {}
  return {
    client: {
      put: async (pathname, buffer) => { blobs[pathname] = buffer; return { pathname, url: `https://blob.example/${pathname}` } },
      get: async (pathname) => {
        if (!(pathname in blobs)) return { statusCode: 404, stream: null, blob: null }
        const buf = blobs[pathname]
        return { statusCode: 200, stream: (async function* () { yield buf })(), blob: { contentType: 'application/octet-stream', size: buf.length } }
      },
      del: async (pathname) => { delete blobs[pathname] },
    },
    blobs,
  }
}

function newShapeCommercial(overrides = {}) {
  return {
    commercialStatus: 'active', plan: 'growth', planSource: 'access_code',
    trial: null, limitsOverride: null, suspension: null, cancellation: null, overLimit: null,
    accessCodeHash: null, discountPercent: null, discountFixedCents: null, paymentRequired: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

let hashCache = null
async function passwordHash() {
  if (!hashCache) hashCache = await bcrypt.hash('x', 12)
  return hashCache
}

let tenantCounter = 0
function freshTenantId() { return `t_storage-quota-${++tenantCounter}` }

// Seeds a genuine non-BOOTSTRAP tenant: an active tenant_config with
// locationCatalogEnabled (so a wildcard-role account is treated as
// covering every location -- same requirement as
// tests/test_ai_tenant_limits.js's seedTenant()), a real Redis-backed Owner
// account, and returns a signed session token for that Owner.
async function seedTenant(tenantId, commercial) {
  await upsertTenantConfig(tenantId, { status: 'active', locationCatalogEnabled: true, commercial }, { allowCreate: true, creationSource: 'migration' })
  const record = {
    userId: 'usr_owner', email: 'owner@example.com', passwordHash: await passwordHash(), role: 'owner',
    locationIds: '*', tenantId, sessionVersion: 1, disabled: false, displayName: 'Owner',
  }
  await upsertUser(tenantId, record, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  return signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId, sessionVersion: 1 })
}

async function invoke({ action, method = 'GET', token, body, query }) {
  const resolvedToken = await token
  const req = { method, query: { action, ...(query ?? {}) }, body: body ?? {}, headers: resolvedToken ? { cookie: `lta_session=${resolvedToken}` } : {}, socket: {} }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function createCampaign(token) {
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token, body: { name: 'Test Campaign', locationIds: '*' } })
  assert(created.statusCode === 200 || created.statusCode === 201, `campaign setup must succeed, got ${created.statusCode}: ${JSON.stringify(created.body)}`)
  return created.body.campaign
}

function b64(str) { return Buffer.from(str).toString('base64') }
const SMALL_FILE = () => b64('x'.repeat(1000))

async function seedAssetRecord(assetClient, id, { campaignId, sizeBytes }) {
  await assetClient.hset('content_assets:v1', {
    [id]: JSON.stringify({
      id, campaignId, type: 'other', filename: `${id}.png`, mimeType: 'image/png',
      sizeBytes, blobPathname: `content/${campaignId}/${id}.png`, captionText: null, createdAt: new Date().toISOString(),
    }),
  })
}

async function setUpTenant(commercial) {
  installFakeConfigRedis()
  installFakeUserRedis()
  installFakeCampaignRedis()
  const assetClient = installFakeAssetRedis()
  const blob = fakeBlob()
  _setBlobClientForTests(() => blob.client)
  const tenantId = freshTenantId()
  const token = await seedTenant(tenantId, commercial)
  const campaign = await createCampaign(token)
  return { tenantId, token, campaign, assetClient, blob }
}

const MB = 1024 * 1024
const GB = 1024 * MB

// --- Part 1: per-plan commercial ceilings --------------------------------

async function testCoreCeiling500MbEnforced() {
  const { token, campaign, assetClient, blob } = await setUpTenant(newShapeCommercial({ plan: 'core' }))
  await seedAssetRecord(assetClient, 'existing-1', { campaignId: campaign.id, sizeBytes: 500 * MB - 500 })
  const res = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(res.statusCode === 409 && res.body.error === 'storage_limit_reached', `expected a commercial 409 at Core's 500MB ceiling, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.limitBytes === 500 * MB, `expected limitBytes 500MB, got ${JSON.stringify(res.body)}`)
  assert(Object.keys(blob.blobs).length === 0, 'no Blob write may occur once the commercial ceiling is reached')
}

async function testCoreAllowsUploadsUnderItsCeiling() {
  const { token, campaign } = await setUpTenant(newShapeCommercial({ plan: 'core' }))
  const res = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(res.statusCode === 201, `a small upload well under Core's ceiling must succeed, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testCoreAssetCountCeiling500Enforced() {
  const { token, campaign, assetClient, blob } = await setUpTenant(newShapeCommercial({ plan: 'core' }))
  const fields = {}
  for (let i = 0; i < 500; i++) {
    fields[`existing-${i}`] = JSON.stringify({ id: `existing-${i}`, campaignId: campaign.id, type: 'other', filename: `x${i}.png`, mimeType: 'image/png', sizeBytes: 10, blobPathname: `content/${campaign.id}/x${i}.png`, captionText: null, createdAt: new Date().toISOString() })
  }
  await assetClient.hset('content_assets:v1', fields)
  const res = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(res.statusCode === 409 && res.body.error === 'storage_limit_reached' && res.body.assetLimit === 500, `expected a commercial 409 at Core's 500-asset ceiling, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(Object.keys(blob.blobs).length === 0, 'no Blob write may occur once the commercial asset ceiling is reached')
}

async function testGrowthCeiling1GbEnforced() {
  const { token, campaign, assetClient } = await setUpTenant(newShapeCommercial({ plan: 'growth' }))
  await seedAssetRecord(assetClient, 'existing-1', { campaignId: campaign.id, sizeBytes: 1 * GB - 500 })
  const res = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(res.statusCode === 409 && res.body.limitBytes === 1 * GB, `expected a commercial 409 at Growth's 1GB ceiling, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testGrowthAssetCountCeiling1200Enforced() {
  const { token, campaign, assetClient } = await setUpTenant(newShapeCommercial({ plan: 'growth' }))
  const fields = {}
  for (let i = 0; i < 1200; i++) {
    fields[`existing-${i}`] = JSON.stringify({ id: `existing-${i}`, campaignId: campaign.id, type: 'other', filename: `x${i}.png`, mimeType: 'image/png', sizeBytes: 10, blobPathname: `content/${campaign.id}/x${i}.png`, captionText: null, createdAt: new Date().toISOString() })
  }
  await assetClient.hset('content_assets:v1', fields)
  const res = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(res.statusCode === 409 && res.body.assetLimit === 1200, `expected a commercial 409 at Growth's 1200-asset ceiling, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testTrialCeiling250MbEnforced() {
  const { token, campaign, assetClient } = await setUpTenant(newShapeCommercial({
    commercialStatus: 'trial', plan: 'growth',
    trial: { status: 'trialing', endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
  }))
  await seedAssetRecord(assetClient, 'existing-1', { campaignId: campaign.id, sizeBytes: 250 * MB - 500 })
  const res = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(res.statusCode === 409 && res.body.limitBytes === 250 * MB, `expected a commercial 409 at Trial's 250MB ceiling, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testEnterpriseOverrideClampedToPhaseACeiling() {
  // A deliberately huge Enterprise override (10GB) -- storage/assetCount
  // ARE clamped to Phase A's 2GB/2000 platform safety ceiling
  // (clampToSafetyCeiling()), unlike AI's aiAllowanceMonthly, which is
  // never clamped. hardSafetyOverrideApproved must have no effect.
  const { token, campaign, assetClient } = await setUpTenant(newShapeCommercial({
    plan: 'enterprise',
    limitsOverride: { storageBytes: 10 * GB, assetCount: 10000, hardSafetyOverrideApproved: true },
  }))
  await seedAssetRecord(assetClient, 'existing-1', { campaignId: campaign.id, sizeBytes: 2 * GB - 500 })
  const res = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(res.statusCode === 409 && res.body.limitBytes === 2 * GB, `an Enterprise override must be clamped to the 2GB platform ceiling regardless of hardSafetyOverrideApproved, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testEnterpriseOverrideAllowsMoreThanCoreUnderItsOwnClampedCeiling() {
  const { token, campaign, assetClient } = await setUpTenant(newShapeCommercial({ plan: 'enterprise', limitsOverride: { storageBytes: 1.5 * GB } }))
  // Well above Core's 500MB but still under the Enterprise-override/clamped 1.5GB ceiling.
  await seedAssetRecord(assetClient, 'existing-1', { campaignId: campaign.id, sizeBytes: 800 * MB })
  const res = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(res.statusCode === 201, `an Enterprise tenant's own (clamped) higher ceiling must allow uploads Core would reject, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// --- Part 2: legacy/LTA + resolver failure --------------------------------

async function testLegacyUnmanagedTenantHasNoCommercialStorageEnforcement() {
  const { token, campaign, assetClient } = await setUpTenant(null) // no commercial field -- legacy/unmanaged
  // Well above every commercial plan's ceiling (Growth's 1GB) but still
  // under Phase A's 2GB hard ceiling.
  await seedAssetRecord(assetClient, 'existing-1', { campaignId: campaign.id, sizeBytes: 1.5 * GB })
  const res = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(res.statusCode === 201, `a legacy/unmanaged tenant must have no commercial storage ceiling, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testLegacyUnmanagedTenantStillHitsPhaseAHardCeiling() {
  const { token, campaign, assetClient, blob } = await setUpTenant(null)
  await seedAssetRecord(assetClient, 'existing-1', { campaignId: campaign.id, sizeBytes: 2 * GB - 500 })
  const res = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(res.statusCode === 413 && res.body.error === 'storage_limit_exceeded', `Phase A's own 2GB hard ceiling must still apply unconditionally to a legacy/unmanaged tenant, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(Object.keys(blob.blobs).length === 0, 'no Blob write may occur once Phase A\'s hard ceiling is reached')
}

async function testLtaBootstrapTenantCompletelyUnaffected() {
  // No fake config Redis registered -- BOOTSTRAP short-circuits
  // resolveTenantEntitlements() before any Redis read, matching every other
  // LTA-compatibility guarantee elsewhere in this phase.
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [{ userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' }],
  })
  installFakeCampaignRedis()
  const assetClient = installFakeAssetRedis()
  const blob = fakeBlob()
  _setBlobClientForTests(() => blob.client)
  const token = await signSession({ userId: 'usr_owner', email: 'owner@example.com', role: 'owner', locationIds: '*', tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
  const campaign = await createCampaign(token)
  // Below Phase A's ceiling but above every commercial plan's ceiling --
  // proves LTA is governed only by Phase A, exactly as before this phase.
  await seedAssetRecord(assetClient, 'existing-1', { campaignId: campaign.id, sizeBytes: 1.9 * GB })
  const res = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(res.statusCode === 201, `LTA's BOOTSTRAP tenant must be completely unaffected by commercial storage quota enforcement, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  delete process.env.ACCOUNT_DIRECTORY_JSON
}

async function testResolverFailureDeniesUploadIncludingTheVeryFirstOne() {
  // Malformed commercial state (unrecognized plan id) -- resolves to
  // unresolvedBundle('unknown_plan'), 0/0 limits, fail-closed.
  const { token, campaign } = await setUpTenant(newShapeCommercial({ plan: 'not_a_real_plan' }))
  const res = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(res.statusCode === 409 && res.body.error === 'storage_limit_reached' && res.body.limitBytes === 0 && res.body.assetLimit === 0,
    `a resolver failure must fail closed (0/0) and deny even the very first upload, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// --- Part 3: race safety + no separate quota counter ----------------------

// Same read-delay pattern as test_content_endpoint.js's
// fakeAssetRedisWithReadDelay() -- forces two "concurrent" uploads to
// genuinely interleave their usage reads; the lease's SET NX stays
// undelayed/atomic, mirroring real Redis.
function fakeAssetRedisWithReadDelay(delayMs = 15) {
  const store = {}
  const strings = {}
  const delay = () => new Promise(resolve => setTimeout(resolve, delayMs))
  return {
    hgetall: async () => { await delay(); return { ...store } },
    hget: async (_key, field) => { await delay(); return store[field] ?? null },
    hset: async (_key, fields) => { Object.assign(store, fields) },
    hdel: async (_key, field) => { const had = field in store; delete store[field]; return had ? 1 : 0 },
    set: async (key, value, opts) => { if (opts?.nx && key in strings) return null; strings[key] = value; return 'OK' },
    del: async (key) => { const had = key in strings; delete strings[key]; return had ? 1 : 0 },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [token] = args
      if (strings[key] !== token) return 0
      if (args.length === 1) delete strings[key]
      return 1
    },
  }
}

async function testConcurrentUploadsAtCommercialCeilingExactlyOneSucceeds() {
  installFakeConfigRedis()
  installFakeUserRedis()
  installFakeCampaignRedis()
  const assetClient = fakeAssetRedisWithReadDelay()
  _setAssetRedis(() => assetClient)
  const blob = fakeBlob()
  _setBlobClientForTests(() => blob.client)
  const tenantId = freshTenantId()
  const token = await seedTenant(tenantId, newShapeCommercial({ plan: 'core' })) // 500MB ceiling
  const campaign = await createCampaign(token)

  // Only 2MB of headroom under Core's 500MB ceiling -- two 1.2MB uploads
  // individually fit, but together (2.4MB) exceed it.
  const HEADROOM_BYTES = 2 * MB
  await seedAssetRecord(assetClient, 'existing-1', { campaignId: campaign.id, sizeBytes: 500 * MB - HEADROOM_BYTES })

  const oneMb = b64('x'.repeat(1.2 * MB))
  const uploadOnce = () => invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: oneMb } })
  const [resA, resB] = await Promise.all([uploadOnce(), uploadOnce()])

  const successes = [resA, resB].filter(r => r.statusCode === 201)
  const rejections = [resA, resB].filter(r => r.statusCode !== 201)
  assert(successes.length === 1, `exactly one of the two concurrent near-commercial-ceiling uploads must succeed, got ${successes.length} (statuses: ${resA.statusCode}, ${resB.statusCode})`)
  assert(rejections.length === 1, `exactly one must be rejected, got ${rejections.length}`)
  assert([409, 413].includes(rejections[0].statusCode), `the loser must be refused with a deterministic 409 (commercial ceiling) or 413 (Phase A ceiling), got ${rejections[0].statusCode}`)
  assert(Object.keys(blob.blobs).length === 1, `exactly one Blob object may be written for two uploads that together exceed the commercial ceiling, got ${Object.keys(blob.blobs).length}`)
}

async function testDeletingAnAssetFreesCommercialCapacityBasedOnFreshMetadata() {
  const { token, campaign, assetClient } = await setUpTenant(newShapeCommercial({ plan: 'core' }))
  await seedAssetRecord(assetClient, 'existing-1', { campaignId: campaign.id, sizeBytes: 500 * MB - 500 })
  const blocked = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(blocked.statusCode === 409, `setup: must be blocked while at the ceiling, got ${blocked.statusCode}`)
  // No separate quota counter to reset -- deleting the asset record
  // directly (simulating delete-asset's own metadata removal) must be
  // immediately reflected the next time getAllAssets() is read fresh.
  await assetClient.hdel('content_assets:v1', 'existing-1')
  const allowed = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new2.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(allowed.statusCode === 201, `deleting the blocking asset must immediately free real capacity, got ${allowed.statusCode}: ${JSON.stringify(allowed.body)}`)
}

async function testNoQuotaCounterDriftAcrossRepeatedUploadsAndDeletes() {
  const { token, campaign, assetClient } = await setUpTenant(newShapeCommercial({ plan: 'core' }))
  for (let i = 0; i < 5; i++) {
    const res = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: `n${i}.png`, mimeType: 'image/png', fileBase64: SMALL_FILE() } })
    assert(res.statusCode === 201, `upload ${i} must succeed, got ${res.statusCode}`)
    await assetClient.hdel('content_assets:v1', res.body.asset.id)
  }
  // After 5 upload+delete cycles, the tenant must be exactly back to zero
  // real assets -- no drift from any separate counter that upload()/delete
  // might otherwise have kept out of sync with the real metadata.
  const finalUpload = await invoke({ action: 'upload', method: 'POST', token, body: { campaignId: campaign.id, type: 'website_graphic', filename: 'final.png', mimeType: 'image/png', fileBase64: SMALL_FILE() } })
  assert(finalUpload.statusCode === 201, `expected the tenant to be back at zero real assets with full headroom, got ${finalUpload.statusCode}: ${JSON.stringify(finalUpload.body)}`)
}

// --- Part 4: no client-supplied override, no weakened Phase A constant ---

async function testNoClientSuppliedStorageQuotaFieldHasAnyEffect() {
  const { token, campaign, assetClient } = await setUpTenant(newShapeCommercial({ plan: 'core' }))
  await seedAssetRecord(assetClient, 'existing-1', { campaignId: campaign.id, sizeBytes: 500 * MB - 500 })
  const res = await invoke({
    action: 'upload', method: 'POST', token,
    body: {
      campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: SMALL_FILE(),
      // Spoofed fields that look like quota/plan overrides -- upload() never
      // reads any of these from the request body; only the server-side
      // resolver (keyed by tenantId) can ever determine the limit.
      storageBytes: 999999999999, assetCount: 999999, plan: 'enterprise', limitsOverride: { storageBytes: 999999999999 },
    },
  })
  assert(res.statusCode === 409 && res.body.error === 'storage_limit_reached', `a spoofed request body must have NO effect on the server-resolved commercial storage quota, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

function testPhaseAConstantsUnweakened() {
  const src = readFileSync(new URL('../dashboard/api/content/[action].js', import.meta.url), 'utf8')
  assert(src.includes('MAX_TENANT_STORAGE_BYTES = 2 * 1024 * 1024 * 1024'), 'Phase A\'s 2GB hard storage ceiling must be unchanged')
  assert(src.includes('MAX_TENANT_ASSET_COUNT = 2000'), 'Phase A\'s 2000-asset hard ceiling must be unchanged')
  assert(src.includes("requestsPerWindow: 20, windowSeconds: 60"), 'the per-user upload rate limit must be unchanged')
  assert(src.includes("requestsPerWindow: 40, windowSeconds: 60"), 'the per-tenant upload rate limit must be unchanged')
}

const tests = [
  ['Core: commercial 500MB storage ceiling enforced', testCoreCeiling500MbEnforced],
  ['Core: uploads under the ceiling still succeed', testCoreAllowsUploadsUnderItsCeiling],
  ['Core: commercial 500-asset count ceiling enforced', testCoreAssetCountCeiling500Enforced],
  ['Growth: commercial 1GB storage ceiling enforced', testGrowthCeiling1GbEnforced],
  ['Growth: commercial 1200-asset count ceiling enforced', testGrowthAssetCountCeiling1200Enforced],
  ['Trial: commercial 250MB storage ceiling enforced', testTrialCeiling250MbEnforced],
  ['Enterprise: override is clamped to Phase A\'s 2GB ceiling regardless of hardSafetyOverrideApproved', testEnterpriseOverrideClampedToPhaseACeiling],
  ['Enterprise: a smaller-than-platform override still allows more than Core would', testEnterpriseOverrideAllowsMoreThanCoreUnderItsOwnClampedCeiling],

  ['legacy/unmanaged tenant has no commercial storage enforcement', testLegacyUnmanagedTenantHasNoCommercialStorageEnforcement],
  ['legacy/unmanaged tenant still hits Phase A\'s 2GB hard ceiling', testLegacyUnmanagedTenantStillHitsPhaseAHardCeiling],
  ['LTA\'s BOOTSTRAP tenant is completely unaffected', testLtaBootstrapTenantCompletelyUnaffected],
  ['a resolver failure denies upload, including the very first one', testResolverFailureDeniesUploadIncludingTheVeryFirstOne],

  ['exactly one of two concurrent last-capacity uploads succeeds', testConcurrentUploadsAtCommercialCeilingExactlyOneSucceeds],
  ['deleting an asset frees commercial capacity based on fresh real metadata', testDeletingAnAssetFreesCommercialCapacityBasedOnFreshMetadata],
  ['no quota counter drift across repeated upload/delete cycles', testNoQuotaCounterDriftAcrossRepeatedUploadsAndDeletes],

  ['no client-supplied storage quota/plan field in the request body has any effect', testNoClientSuppliedStorageQuotaFieldHasAnyEffect],
  ['Phase A rate-limit/ceiling constants are unweakened by this phase', testPhaseAConstantsUnweakened],
]

async function main() {
  for (const [name, fn] of tests) await run(name, fn)
  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
