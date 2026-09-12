// Regression tests for dashboard/api/content/[action].js -- the Content
// Library endpoint. Drives the real handler with a fake req/res, controls
// campaignStore.js/contentAssetStore.js via their test-only client-factory
// seams, and blobStore.js via its own _setBlobClientForTests seam (no real
// Vercel Blob account, no real Upstash account).
//
// Focus: Draft/Approved/Archived authorization, upload validation
// (MIME/extension/size/malicious payloads), and download authorization --
// the hard security requirements this milestone calls out explicitly.
//
// Run directly: node tests/test_content_endpoint.js

process.env.SESSION_SIGNING_SECRET = 'test-secret-at-least-32-characters-long-xyz'

import bcrypt from 'bcryptjs'
import handler, {
  _setUploadLockRenewIntervalMsForTests, _resetUploadLockRenewIntervalMsForTests,
} from '../dashboard/api/content/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests as _setCampaignRedis, _resetRedisClientForTests as _resetCampaignRedis } from '../dashboard/api/_lib/campaignStore.js'
import {
  _setRedisClientForTests as _setAssetRedis, _resetRedisClientForTests as _resetAssetRedis, getAsset,
  acquireContentUploadLock, renewContentUploadLock, releaseContentUploadLock,
} from '../dashboard/api/_lib/contentAssetStore.js'
import { _setBlobClientForTests, _resetBlobClientForTests } from '../dashboard/api/_lib/blobStore.js'
import { _setLimiterFactoryForTests, _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'
import { _setRedisClientForTests as _setTaskRedis, _resetRedisClientForTests as _resetTaskRedis, createTask, getTask } from '../dashboard/api/_lib/taskStore.js'
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
    _resetTaskRedis()
    _resetConfigRedis()
    _resetUserStoreRedis()
    _resetBlobClientForTests()
    _resetLimiterFactoryForTests()
    _resetUploadLockRenewIntervalMsForTests()
    delete process.env.VERCEL_ENV
  }
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (obj) => { res.body = obj; return res }
  res.send = (buf) => { res.body = buf; return res }
  res.setHeader = (name, value) => { res.headers[name] = value }
  return res
}

// One shared Redis-hash-shaped fake, used by both campaignStore.js and
// contentAssetStore.js independently (they're separate keys/instances in
// production but a single in-memory object works fine for one test file).
// Also carries a separate string-keyed store for contentAssetStore.js's
// per-tenant upload LEASE (SET NX EX, then an ownership-token-checked `eval`
// for renew/release -- a different key SHAPE than the hash records above,
// so it needs its own namespace, same dual-shape pattern
// test_google_integration_architecture.js's fakeCredentialRedis() already
// uses). `eval` here emulates BOTH contentAssetStore.js's RENEW_SCRIPT (2
// args: token, ttlSeconds -- renew) and RELEASE_SCRIPT (1 arg: token --
// release), distinguished by args.length, exactly like the real Lua
// scripts' GET-then-conditional-act shape: a token that no longer matches
// what's stored is always a harmless no-op, never able to act on a
// different (newer) holder's lease. This fake does not model TTL expiry at
// all (fine for every test using it -- none of them need a lease to
// actually expire); see fakeExpiringLockRedis() below for the tests that do.
function fakeRedis(initial = {}) {
  const store = { ...initial }
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
      return 1 // RENEW_SCRIPT (args.length === 2) leaves the value in place -- this fake has no TTL to bump
    },
  }
}

// A dedicated fake for the upload-lock PRIMITIVES themselves (acquire/renew/
// release), independent of the campaign/asset hash fakes above, with a
// controllable virtual clock (`_advance(ms)`) so lease-expiry tests never
// need to actually wait in real time. Models exactly the two operations
// contentAssetStore.js's lock functions issue: SET NX EX (acquire) and the
// two ownership-token-checked eval scripts (renew/release) -- both
// TTL-aware here, unlike fakeRedis() above.
function fakeExpiringLockRedis() {
  let now = 0
  const strings = {} // key -> { value, expiresAt }
  function isLive(key) {
    const entry = strings[key]
    return Boolean(entry) && entry.expiresAt > now
  }
  return {
    set: async (key, value, opts) => {
      if (opts?.nx && isLive(key)) return null
      strings[key] = { value, expiresAt: now + (opts?.ex ?? 0) * 1000 }
      return 'OK'
    },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      if (!isLive(key)) return 0
      const [token] = args
      if (strings[key].value !== token) return 0
      if (args.length === 2) { strings[key].expiresAt = now + Number(args[1]) * 1000; return 1 } // RENEW_SCRIPT
      delete strings[key] // RELEASE_SCRIPT
      return 1
    },
    _advance(ms) { now += ms },
  }
}

// CRITICAL: the test factory passed to _setRedisClientForTests must return
// a PERSISTENT captured instance, never a fresh fakeRedis() per call --
// campaignStore.js/contentAssetStore.js call getClient() (and therefore the
// factory) on every single read/write, so a factory that builds a new
// object each time silently loses every previous write.
function setFreshCampaignStore() {
  const client = fakeRedis()
  _setCampaignRedis(() => client)
  return client
}
function setFreshAssetStore() {
  const client = fakeRedis()
  _setAssetRedis(() => client)
  return client
}
function setFreshTaskStore() {
  const client = fakeRedis()
  _setTaskRedis(() => client)
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
        return {
          statusCode: 200,
          stream: (async function* () { yield buf })(),
          blob: { contentType: 'application/octet-stream', size: buf.length },
        }
      },
      del: async (pathname) => { delete blobs[pathname] },
    },
    blobs,
  }
}

async function setDirectory() {
  const hash = await bcrypt.hash('x', 12)
  process.env.ACCOUNT_DIRECTORY_JSON = JSON.stringify({
    accounts: [
      { userId: 'usr_owner', email: 'owner@example.com', passwordHash: hash, role: 'owner', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Owner' },
      { userId: 'usr_admin', email: 'admin@example.com', passwordHash: hash, role: 'admin', locationIds: '*', sessionVersion: 1, disabled: false, displayName: 'Admin' },
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: [7], sessionVersion: 1, disabled: false, displayName: 'Marketing' },
      { userId: 'usr_lm', email: 'lm@example.com', passwordHash: hash, role: 'location_manager', locationIds: [7], sessionVersion: 1, disabled: false, displayName: 'LM' },
      { userId: 'usr_lm_other', email: 'lm-other@example.com', passwordHash: hash, role: 'location_manager', locationIds: [99], sessionVersion: 1, disabled: false, displayName: 'LM Other' },
      { userId: 'usr_viewer', email: 'viewer@example.com', passwordHash: hash, role: 'read_only', locationIds: [7], sessionVersion: 1, disabled: false, displayName: 'Viewer' },
    ],
  })
}

async function tokenFor(userId, role, locationIds) {
  return signSession({ userId, email: `${userId}@example.com`, role, locationIds, tenantId: DEFAULT_TENANT_ID, sessionVersion: 1 })
}
const ownerToken = () => tokenFor('usr_owner', 'owner', '*')
const adminToken = () => tokenFor('usr_admin', 'admin', '*')
const marketingToken = () => tokenFor('usr_marketing', 'marketing', [7])
const lmToken = () => tokenFor('usr_lm', 'location_manager', [7])
const lmOtherToken = () => tokenFor('usr_lm_other', 'location_manager', [99])
const viewerToken = () => tokenFor('usr_viewer', 'read_only', [7])

async function invoke({ action, method = 'GET', token, body, query }) {
  const resolvedToken = await token
  const req = {
    method, query: { action, ...(query ?? {}) }, body: body ?? {},
    headers: resolvedToken ? { cookie: `lta_session=${resolvedToken}` } : {}, socket: {},
  }
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function createCampaignAndApprove(campaignClient, status = 'Approved') {
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'Kids Eat Free', locationIds: [7] } })
  if (status === 'Draft') return created.body.campaign
  const approved = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { id: created.body.campaign.id, status } })
  return approved.body.campaign
}

// --- Campaign status authorization ------------------------------------------

async function testDraftCampaignInvisibleToLocationManager() {
  await setDirectory()
  setFreshCampaignStore()
  await createCampaignAndApprove(null, 'Draft')
  const res = await invoke({ action: 'list-campaigns', token: lmToken() })
  assert(res.body.campaigns.length === 0, 'a Draft campaign must be invisible to a location_manager, even one authorized for its location')
}

async function testDraftCampaignVisibleToMarketingWithContentManage() {
  await setDirectory()
  setFreshCampaignStore()
  await createCampaignAndApprove(null, 'Draft')
  const res = await invoke({ action: 'list-campaigns', token: marketingToken() })
  assert(res.body.campaigns.length === 1, 'a Draft campaign must be visible to marketing (holds CONTENT_MANAGE)')
}

async function testApprovedCampaignVisibleToAuthorizedLocationManager() {
  await setDirectory()
  setFreshCampaignStore()
  await createCampaignAndApprove(null, 'Approved')
  const res = await invoke({ action: 'list-campaigns', token: lmToken() })
  assert(res.body.campaigns.length === 1, 'an Approved campaign for the manager\'s own location must be visible')
}

async function testApprovedCampaignInvisibleToUnauthorizedLocationManager() {
  await setDirectory()
  setFreshCampaignStore()
  await createCampaignAndApprove(null, 'Approved') // locationIds: [7]
  const res = await invoke({ action: 'list-campaigns', token: lmOtherToken() }) // scoped to [99]
  assert(res.body.campaigns.length === 0, 'an Approved campaign for a DIFFERENT location must never be visible to an unauthorized location_manager')
}

async function testArchivedCampaignHiddenFromDefaultListButVisibleWithFlag() {
  await setDirectory()
  const client = fakeRedis()
  _setCampaignRedis(() => client)
  await createCampaignAndApprove(null, 'Archived')
  const defaultList = await invoke({ action: 'list-campaigns', token: ownerToken() })
  assert(defaultList.body.campaigns.length === 0, 'an Archived campaign must not clutter the default active view')
  const withArchived = await invoke({ action: 'list-campaigns', token: ownerToken(), query: { includeArchived: '1' } })
  assert(withArchived.body.campaigns.length === 1, 'an Archived campaign must remain accessible to management via the explicit filter')
}

async function testOnlyContentManageRolesCanApproveACampaign() {
  await setDirectory()
  setFreshCampaignStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'X', locationIds: [7] } })
  const attempt = await invoke({ action: 'upsert-campaign', method: 'POST', token: lmToken(), body: { id: created.body.campaign.id, status: 'Approved' } })
  assert(attempt.statusCode === 403, `location_manager must never be able to approve a campaign, got ${attempt.statusCode}`)
}

async function testCompanyWideCampaignCreationRestrictedToUnscopedAccounts() {
  await setDirectory()
  setFreshCampaignStore()
  const res = await invoke({ action: 'upsert-campaign', method: 'POST', token: marketingToken(), body: { name: 'X', locationIds: '*' } })
  assert(res.statusCode === 403, `a location-scoped marketing account requesting a company-wide campaign must be rejected, got ${res.statusCode}`)
}

async function testViewerCanSeeApprovedButCannotCreateOrApprove() {
  await setDirectory()
  setFreshCampaignStore()
  await createCampaignAndApprove(null, 'Approved')
  const list = await invoke({ action: 'list-campaigns', token: viewerToken() })
  assert(list.body.campaigns.length === 1, 'read_only must see Approved campaigns for its own location')
  const create = await invoke({ action: 'upsert-campaign', method: 'POST', token: viewerToken(), body: { name: 'Y', locationIds: [7] } })
  assert(create.statusCode === 403, 'read_only must never be able to create a campaign')
}

// --- Upload authorization + validation ---------------------------------------

function b64(str) { return Buffer.from(str).toString('base64') }
const FAKE_JPEG = () => b64('x'.repeat(1000)) // content doesn't need to be a real JPEG for these tests -- validation is MIME/extension/size based, not magic-byte sniffing (documented limitation)

async function testAuthorizedUploadSucceeds() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  const blob = fakeBlob()
  _setBlobClientForTests(() => blob.client)
  const campaign = await createCampaignAndApprove(null, 'Draft')
  const res = await invoke({
    action: 'upload', method: 'POST', token: ownerToken(),
    body: { campaignId: campaign.id, type: 'flyer_pdf', filename: 'flyer.pdf', mimeType: 'application/pdf', fileBase64: b64('%PDF-1.4 fake pdf content') },
  })
  assert(res.statusCode === 201, `authorized owner upload expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.asset.blobPathname === undefined, 'the response must never expose the internal blob pathname')
}

async function testUnauthorizedUploadRejected() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  const blob = fakeBlob()
  _setBlobClientForTests(() => blob.client)
  const campaign = await createCampaignAndApprove(null, 'Approved')
  const res = await invoke({
    action: 'upload', method: 'POST', token: lmToken(),
    body: { campaignId: campaign.id, type: 'flyer_pdf', filename: 'flyer.pdf', mimeType: 'application/pdf', fileBase64: b64('content') },
  })
  assert(res.statusCode === 403, `location_manager must never hold CONTENT_UPLOAD, got ${res.statusCode}`)
}

async function testUploadToACampaignOutsideUploaderScopeRejected() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  const blob = fakeBlob()
  _setBlobClientForTests(() => blob.client)
  const campaign = await createCampaignAndApprove(null, 'Approved') // locationIds: [7]
  // marketing is scoped to [7] in this fixture, matching the campaign -- use
  // a campaign at a location marketing does NOT cover instead.
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'Other', locationIds: [99] } })
  const res = await invoke({
    action: 'upload', method: 'POST', token: marketingToken(),
    body: { campaignId: created.body.campaign.id, type: 'flyer_pdf', filename: 'flyer.pdf', mimeType: 'application/pdf', fileBase64: b64('content') },
  })
  assert(res.statusCode === 404, `an upload targeting a campaign outside the uploader's location grant must be denied (404, non-disclosure), got ${res.statusCode}`)
}

async function testMimeTypeValidationRejectsUnsupportedTypes() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  _setBlobClientForTests(() => fakeBlob().client)
  const campaign = await createCampaignAndApprove(null, 'Draft')
  const res = await invoke({
    action: 'upload', method: 'POST', token: ownerToken(),
    body: { campaignId: campaign.id, type: 'other', filename: 'script.exe', mimeType: 'application/x-msdownload', fileBase64: b64('MZ fake exe') },
  })
  assert(res.statusCode === 400, `an executable disguised as a marketing file must be rejected, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testMimeExtensionMismatchRejected() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  _setBlobClientForTests(() => fakeBlob().client)
  const campaign = await createCampaignAndApprove(null, 'Draft')
  // Claims to be a PDF by MIME type, but the filename extension says .html
  // -- a classic disguise attempt.
  const res = await invoke({
    action: 'upload', method: 'POST', token: ownerToken(),
    body: { campaignId: campaign.id, type: 'other', filename: 'evil.html', mimeType: 'application/pdf', fileBase64: b64('<script>evil</script>') },
  })
  assert(res.statusCode === 400, `a mismatched extension/MIME type must be rejected, got ${res.statusCode}`)
}

async function testOversizedFileRejected() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  _setBlobClientForTests(() => fakeBlob().client)
  const campaign = await createCampaignAndApprove(null, 'Draft')
  const oversized = b64('x'.repeat(16 * 1024 * 1024)) // > 15MB image cap
  const res = await invoke({
    action: 'upload', method: 'POST', token: ownerToken(),
    body: { campaignId: campaign.id, type: 'website_graphic', filename: 'huge.png', mimeType: 'image/png', fileBase64: oversized },
  })
  assert(res.statusCode === 400, `an oversized image must be rejected, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// --- "Minimum content cost guardrail" hardening (Phase A6) ------------------
// getAllAssets() reads only metadata (sizeBytes), never the actual Blob
// bytes -- these tests seed synthetic records directly into the fake Redis
// hash to simulate a tenant near/at the safety ceiling without needing any
// real large payloads.
async function seedAssetRecord(client, id, { campaignId, sizeBytes = 1000 }) {
  await client.hset('content_assets:v1', {
    [id]: JSON.stringify({
      id, campaignId, type: 'other', filename: `${id}.png`, mimeType: 'image/png',
      sizeBytes, blobPathname: `content/${campaignId}/${id}.png`, captionText: null, createdAt: new Date().toISOString(),
    }),
  })
}

async function testUploadAboveTenantStorageCeilingRejectedBeforeBlobWrite() {
  await setDirectory()
  setFreshCampaignStore()
  const assetClient = setFreshAssetStore()
  const blob = fakeBlob()
  _setBlobClientForTests(() => blob.client)
  const campaign = await createCampaignAndApprove(null, 'Draft')
  await seedAssetRecord(assetClient, 'existing-1', { campaignId: campaign.id, sizeBytes: 2 * 1024 * 1024 * 1024 })
  const res = await invoke({
    action: 'upload', method: 'POST', token: ownerToken(),
    body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: FAKE_JPEG() },
  })
  assert(res.statusCode === 413, `expected 413 once the tenant storage ceiling is reached, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(Object.keys(blob.blobs).length === 0, 'no Blob write may occur once the storage ceiling is exceeded')
}

async function testAssetCountCeilingEnforced() {
  await setDirectory()
  setFreshCampaignStore()
  const assetClient = setFreshAssetStore()
  const blob = fakeBlob()
  _setBlobClientForTests(() => blob.client)
  const campaign = await createCampaignAndApprove(null, 'Draft')
  const fields = {}
  for (let i = 0; i < 2000; i++) {
    fields[`existing-${i}`] = JSON.stringify({
      id: `existing-${i}`, campaignId: campaign.id, type: 'other', filename: `x${i}.png`, mimeType: 'image/png',
      sizeBytes: 10, blobPathname: `content/${campaign.id}/x${i}.png`, captionText: null, createdAt: new Date().toISOString(),
    })
  }
  await assetClient.hset('content_assets:v1', fields)
  const res = await invoke({
    action: 'upload', method: 'POST', token: ownerToken(),
    body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: FAKE_JPEG() },
  })
  assert(res.statusCode === 413, `expected 413 once the tenant asset-count ceiling is reached, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(Object.keys(blob.blobs).length === 0, 'no Blob write may occur once the asset-count ceiling is exceeded')
}

async function testSecondUserInSameTenantCannotBypassTenantCeiling() {
  await setDirectory()
  setFreshCampaignStore()
  const assetClient = setFreshAssetStore()
  const blob = fakeBlob()
  _setBlobClientForTests(() => blob.client)
  const campaign = await createCampaignAndApprove(null, 'Draft')
  await seedAssetRecord(assetClient, 'existing-1', { campaignId: campaign.id, sizeBytes: 2 * 1024 * 1024 * 1024 })
  // A DIFFERENT user (Admin, not the Owner who "used up" the ceiling) in
  // the SAME tenant -- the ceiling is per-tenant, never per-user.
  const res = await invoke({
    action: 'upload', method: 'POST', token: adminToken(),
    body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: FAKE_JPEG() },
  })
  assert(res.statusCode === 413, `a different user in the same tenant must also be blocked by the tenant-wide ceiling, got ${res.statusCode}`)
}

// "Make content safety ceiling race-safe" hardening (final pre-deploy
// review, item 2): a hash-shaped fake whose READ operations (hget/hgetall,
// what getAllAssets() uses) incur a REAL macrotask delay -- forcing two
// "concurrent" uploads to genuinely interleave their usage reads, unlike
// this file's other tests' purely-synchronous fakes. SET NX (the lock)
// deliberately stays UNDELAYED/atomic: a real Redis SET NX is a single,
// indivisible server-side command regardless of network latency to reach
// it -- injecting a delay there would let two "concurrent" callers both
// see the lock key absent, defeating the very race this test exists to prove.
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
      if (args.length === 1) delete strings[key] // RELEASE_SCRIPT
      return 1 // RENEW_SCRIPT
    },
  }
}

async function testConcurrentUploadsNearCeilingExactlyOneSucceeds() {
  await setDirectory()
  setFreshCampaignStore()
  const assetClient = fakeAssetRedisWithReadDelay()
  _setAssetRedis(() => assetClient)
  const blob = fakeBlob()
  _setBlobClientForTests(() => blob.client)
  const campaign = await createCampaignAndApprove(null, 'Draft')

  // Seed existing usage to leave exactly 20MB of headroom under the 2GB
  // ceiling (avoids allocating real multi-GB buffers in a unit test, while
  // still proving the real ceiling arithmetic).
  const HEADROOM_BYTES = 20 * 1024 * 1024
  await seedAssetRecord(assetClient, 'existing-1', { campaignId: campaign.id, sizeBytes: 2 * 1024 * 1024 * 1024 - HEADROOM_BYTES })

  // Two NEW uploads, each 12MB -- individually well under the 20MB
  // headroom (and under the 15MB per-file image cap), but together (24MB)
  // exceed it. Fired truly concurrently via Promise.all.
  const twelveMb = b64('x'.repeat(12 * 1024 * 1024))
  const uploadOnce = () => invoke({
    action: 'upload', method: 'POST', token: ownerToken(),
    body: { campaignId: campaign.id, type: 'website_graphic', filename: 'new.png', mimeType: 'image/png', fileBase64: twelveMb },
  })
  const [resA, resB] = await Promise.all([uploadOnce(), uploadOnce()])

  const successes = [resA, resB].filter(r => r.statusCode === 201)
  const rejections = [resA, resB].filter(r => r.statusCode !== 201)
  assert(successes.length === 1, `exactly one of the two concurrent near-ceiling uploads must succeed, got ${successes.length} (statuses: ${resA.statusCode}, ${resB.statusCode})`)
  assert(rejections.length === 1, `exactly one must be rejected, got ${rejections.length}`)
  // The loser must be refused outright -- either denied the lock (409,
  // "try again") or, if it acquired the lock after the winner released it,
  // correctly re-evaluates against FRESH usage and is over the ceiling
  // (413) -- never silently allowed through.
  assert([409, 413].includes(rejections[0].statusCode), `the loser must be refused with a deterministic 409 (lock busy) or 413 (over ceiling on fresh data), got ${rejections[0].statusCode}`)
  assert(Object.keys(blob.blobs).length === 1, `exactly one Blob object may be written for two uploads that together exceed the ceiling, got ${Object.keys(blob.blobs).length}`)
}

// --- "Content upload lock must outlive the critical section" hardening
// (two final safety invariants, item 2) -- tests against the lock
// PRIMITIVES directly (acquire/renew/release), independent of the full
// upload() handler, using fakeExpiringLockRedis()'s virtual clock so lease
// expiry is proven without any real waiting. ---------------------------------

async function testLockGrantsMutualExclusion() {
  const client = fakeExpiringLockRedis()
  _setAssetRedis(() => client)
  const tokenA = await acquireContentUploadLock(DEFAULT_TENANT_ID)
  assert(typeof tokenA === 'string' && tokenA.length > 0, 'request A must acquire the lock and receive an ownership token')
  const tokenB = await acquireContentUploadLock(DEFAULT_TENANT_ID)
  assert(tokenB === null, 'request B must be refused the lock while A still holds it')
}

async function testStaleExpiredLeaseCannotDeleteANewerLock() {
  const client = fakeExpiringLockRedis()
  _setAssetRedis(() => client)
  const tokenA = await acquireContentUploadLock(DEFAULT_TENANT_ID)
  assert(tokenA, 'A must acquire the initial lease')
  // A never renews -- simulate its lease expiring (well past any TTL this
  // module could plausibly configure) without A ever calling release().
  client._advance(60_000)
  const tokenB = await acquireContentUploadLock(DEFAULT_TENANT_ID)
  assert(tokenB && tokenB !== tokenA, 'B must be able to acquire a fresh lease once A\'s has expired')
  // A's belated finally/release fires AFTER B already holds a new lease --
  // its stale token must never match what's currently stored, so this must
  // be a harmless no-op, never deleting B's lock.
  await releaseContentUploadLock(DEFAULT_TENANT_ID, tokenA)
  const stillBlocked = await acquireContentUploadLock(DEFAULT_TENANT_ID)
  assert(stillBlocked === null, 'A\'s stale release must NEVER delete a newer request\'s (B\'s) still-live lock')
}

async function testHeartbeatRenewalKeepsLeaseAliveBeyondOriginalTtlWindow() {
  const client = fakeExpiringLockRedis()
  _setAssetRedis(() => client)
  const token = await acquireContentUploadLock(DEFAULT_TENANT_ID)
  assert(token, 'lock acquired')
  // Renew partway through the original TTL window (mirrors upload()'s real
  // heartbeat, which renews well before the lease could expire).
  client._advance(10_000)
  const renewed = await renewContentUploadLock(DEFAULT_TENANT_ID, token)
  assert(renewed === true, 'a renewal with the correct, still-current token must succeed')
  // Advance far enough that the ORIGINAL fixed-TTL lease (acquired at t=0,
  // 15s TTL) would already have expired on its own (now: 20s total), but
  // still within the FRESH TTL window the renewal at t=10s established
  // (alive until 25s) -- proving it is the RENEWAL, not merely the
  // original acquire's TTL, that is now the thing keeping this lease alive
  // for a "long-running" critical section.
  client._advance(10_000)
  const competingAcquire = await acquireContentUploadLock(DEFAULT_TENANT_ID)
  assert(competingAcquire === null, 'a long-running critical section must remain protected for its entire duration via heartbeat renewal, even once the ORIGINAL lease TTL window has fully elapsed')
}

async function testRenewalWithWrongTokenNeverExtendsSomeoneElsesLease() {
  const client = fakeExpiringLockRedis()
  _setAssetRedis(() => client)
  const tokenA = await acquireContentUploadLock(DEFAULT_TENANT_ID)
  assert(tokenA, 'A acquires the lease')
  const forgedRenew = await renewContentUploadLock(DEFAULT_TENANT_ID, 'not-a-real-token')
  assert(forgedRenew === false, 'renewing with a token that does not match the current holder must fail, never extend the lease on someone else\'s behalf')
}

async function testBlobFailureDuringUploadReleasesLockWithoutCorruptingMetadata() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  const campaign = await createCampaignAndApprove(null, 'Draft')
  _setBlobClientForTests(() => ({
    put: async () => { throw new Error('simulated Blob outage') },
    get: async () => ({ statusCode: 404, stream: null, blob: null }),
    del: async () => {},
  }))
  const failed = await invoke({
    action: 'upload', method: 'POST', token: ownerToken(),
    body: { campaignId: campaign.id, type: 'other', filename: 'x.png', mimeType: 'image/png', fileBase64: FAKE_JPEG() },
  })
  // putBlob() (blobStore.js) always re-wraps any underlying client error as
  // BlobStoreUnavailableError, which upload()'s outer catch classifies as a
  // 503 (fail-closed "service temporarily unavailable"), not a raw 502.
  assert(failed.statusCode === 503, `a Blob write failure must surface as a clean 503, got ${failed.statusCode}: ${JSON.stringify(failed.body)}`)

  // The lock must have been released (via `finally`) despite the thrown
  // error -- a second, otherwise-unrelated upload must not be blocked by a
  // stuck reservation.
  const blob = fakeBlob()
  _setBlobClientForTests(() => blob.client)
  const succeeded = await invoke({
    action: 'upload', method: 'POST', token: ownerToken(),
    body: { campaignId: campaign.id, type: 'other', filename: 'y.png', mimeType: 'image/png', fileBase64: FAKE_JPEG() },
  })
  assert(succeeded.statusCode === 201, `after the failed upload releases its lock, a subsequent upload must succeed, got ${succeeded.statusCode}: ${JSON.stringify(succeeded.body)}`)

  // No orphaned/corrupt asset metadata from the failed attempt.
  const list = await invoke({ action: 'list-assets', token: ownerToken(), query: { campaignId: campaign.id } })
  assert(list.body.assets.length === 1, `exactly one asset record (the successful second upload) must exist -- the failed attempt must leave no metadata behind, got ${list.body.assets.length}`)
}

// --- "Verify orphan-Blob cleanup on lease loss" (deployment-gate hardening,
// item 2) --------------------------------------------------------------------
// A fake asset-store client shaped like the general-purpose fakeRedis()
// above, but exposing its raw lock-string store (`_strings`) so the test can
// simulate an external actor (a genuinely different, newer request) taking
// over the upload lock WHILE this request's Blob write is still in flight --
// the exact "lease lost mid-critical-section, after Blob creation, before
// metadata creation" sequence this hardening item is about.
function fakeAssetRedisWithHijackableLock() {
  const store = {}
  const strings = {}
  return {
    hgetall: async () => ({ ...store }),
    hget: async (_key, field) => store[field] ?? null,
    hset: async (_key, fields) => { Object.assign(store, fields) },
    hdel: async (_key, field) => { const had = field in store; delete store[field]; return had ? 1 : 0 },
    set: async (key, value, opts) => { if (opts?.nx && key in strings) return null; strings[key] = value; return 'OK' },
    del: async (key) => { const had = key in strings; delete strings[key]; return had ? 1 : 0 },
    eval: async (_script, keys, args) => {
      const key = keys[0]
      const [token] = args
      if (strings[key] !== token) return 0
      if (args.length === 1) delete strings[key] // RELEASE_SCRIPT
      return 1 // RENEW_SCRIPT
    },
    _strings: strings,
  }
}

async function testLeaseLostAfterBlobCreationCleansUpOrphanAndNeverCreatesMetadata() {
  await setDirectory()
  setFreshCampaignStore()
  const assetClient = fakeAssetRedisWithHijackableLock()
  _setAssetRedis(() => assetClient)
  const campaign = await createCampaignAndApprove(null, 'Draft')

  // Shorten the heartbeat interval (test-only seam) so a renewal genuinely
  // fires WHILE the fake Blob write below is still in flight, without a
  // multi-second real wait for the production 5s interval.
  _setUploadLockRenewIntervalMsForTests(10)

  const blob = fakeBlob()
  let putWasAttempted = false
  _setBlobClientForTests(() => ({
    put: async (pathname, buffer) => {
      putWasAttempted = true
      // Let a couple of heartbeat ticks pass with the lock still intact
      // (proving those renewals succeed normally), THEN simulate a
      // genuinely different, newer request taking over the lock (e.g. an
      // operator-forced expiry, or a store hiccup that let another
      // acquire() through) -- this must happen strictly AFTER the Blob
      // write is committed below, mirroring "Blob upload succeeds" (step 5
      // of the required sequence) happening before "request notices
      // lockLost" (step 6).
      await new Promise(resolve => setTimeout(resolve, 25))
      const result = await blob.client.put(pathname, buffer)
      const lockKey = Object.keys(assetClient._strings)[0]
      assetClient._strings[lockKey] = 'a-different-newer-owners-token'
      // Give the shortened-interval heartbeat time to observe the mismatch
      // (setting leaseLost) before putBlob() resolves back to upload().
      await new Promise(resolve => setTimeout(resolve, 30))
      return result
    },
    get: blob.client.get,
    del: blob.client.del,
  }))

  const res = await invoke({
    action: 'upload', method: 'POST', token: ownerToken(),
    body: { campaignId: campaign.id, type: 'other', filename: 'x.png', mimeType: 'image/png', fileBase64: FAKE_JPEG() },
  })

  assert(putWasAttempted, 'sanity: the Blob write was actually attempted')
  assert(res.statusCode === 503, `lease loss discovered after a successful Blob write must fail closed with 503, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(Object.keys(blob.blobs).length === 0, 'the orphaned Blob this request itself created must be cleaned up (deleted), never left behind')
  const list = await invoke({ action: 'list-assets', token: ownerToken(), query: { campaignId: campaign.id } })
  assert(list.body.assets.length === 0, `no asset metadata may ever be committed once lease loss is detected, even though the Blob write had already succeeded -- got ${list.body.assets.length} asset(s)`)
  const remainingLockKey = Object.keys(assetClient._strings)[0]
  assert(assetClient._strings[remainingLockKey] === 'a-different-newer-owners-token', 'the newer owner\'s lock must remain completely untouched by this request\'s failed cleanup/release -- its stale token can never match, so release() must be a harmless no-op')
}

// --- "Tenant-scope content download abuse protection" hardening
// (final pre-deploy review, item 3) ------------------------------------------

const OTHER_TENANT = 't_content-download-other-tenant'

// A properly key-namespaced fake (UNLIKE this file's own fakeRedis() above,
// which deliberately flattens every hash into one shared object -- fine
// for campaignStore.js/contentAssetStore.js, which each only ever address
// ONE logical hash per client, but userStore.js writes to FOUR distinct
// hash keys through the same client (the user record, the email index,
// and the two global identity-index hashes) -- a flat namespace would let
// the identity-index write silently clobber the user record whenever a
// field name (the userId) collides across those hashes. Mirrors
// tests/test_ai_tenant_limits.js's own fakeRedisWithEval().
function fakeNamespacedHashRedis() {
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
        try { const decoded = JSON.parse(raw); if (decoded && decoded.configVersion !== undefined) currentVersion = String(decoded.configVersion) } catch { /* treat as version 0 */ }
      }
      if (currentVersion !== expectedVersionStr) return raw ?? false
      store[key] = { ...(store[key] ?? {}), [field]: nextJson }
      return true
    },
  }
}

// A genuinely separate tenant (not just a different role in DEFAULT_TENANT_ID)
// -- required for "Tenant B remains unaffected." Mirrors
// tests/test_ai_tenant_limits.js's lightweight seeding pattern (an active
// tenant_config + one Redis-backed Owner account); Content Library
// authorization itself doesn't need location catalog details, just a
// resolvable account.
async function seedOtherTenant(userId, email) {
  const configClient = fakeNamespacedHashRedis()
  _setConfigRedis(() => configClient)
  const userClient = fakeNamespacedHashRedis()
  _setUserStoreRedis(() => userClient)
  await upsertTenantConfig(OTHER_TENANT, { status: 'active', locationCatalogEnabled: true }, { allowCreate: true, creationSource: 'migration' })
  const record = { userId, email, passwordHash: await bcrypt.hash('x', 12), role: 'owner', locationIds: '*', tenantId: OTHER_TENANT, sessionVersion: 1, disabled: false, displayName: userId }
  await upsertUser(OTHER_TENANT, record, { creationMode: UserCreationMode.MIGRATION, sourceIdentity: record })
  return signSession({ userId, email, role: 'owner', locationIds: '*', tenantId: OTHER_TENANT, sessionVersion: 1 })
}

// Simulates a REAL per-identifier limiter, isolated to the tenant-shaped
// bucket only (200/60s) -- every other shape (the existing per-user 60/60s
// limiter) always succeeds, so repeatedly calling as the SAME user doesn't
// also exhaust their own separate bucket and confound the result.
function makeTenantOnlyDownloadCountingFactory() {
  const counts = new Map()
  return (requestsPerWindow, windowSeconds) => {
    if (requestsPerWindow !== 200 || windowSeconds !== 60) return { limit: async () => ({ success: true, remaining: 99 }) }
    return {
      limit: async (identifier) => {
        const n = (counts.get(identifier) ?? 0) + 1
        counts.set(identifier, n)
        return { success: n <= requestsPerWindow, remaining: Math.max(0, requestsPerWindow - n) }
      },
    }
  }
}

async function testDownloadTenantBucketBlocksSecondUserSameTenant() {
  await setDirectory()
  // Deny only the tenant-shaped bucket (200/60s); the per-user bucket
  // (60/60s) stays healthy for both Owner and Admin.
  _setLimiterFactoryForTests((requestsPerWindow, windowSeconds) => {
    if (requestsPerWindow === 200 && windowSeconds === 60) return { limit: async () => ({ success: false, remaining: 0 }) }
    return { limit: async () => ({ success: true, remaining: 99 }) }
  })
  // User A (Owner) "used up" the tenant bucket; User B (Admin, same
  // tenant, own per-user bucket untouched) must still be blocked.
  const res = await invoke({ action: 'download', method: 'GET', token: adminToken(), query: { id: 'whatever' } })
  assert(res.statusCode === 429, `Admin must be blocked by the exhausted TENANT bucket despite an untouched personal bucket, got ${res.statusCode}`)
}

async function testDownloadTenantBucketIndependentAcrossTenants() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  const otherTenantToken = await seedOtherTenant('usr_other', 'other@example.com')
  _setLimiterFactoryForTests(makeTenantOnlyDownloadCountingFactory())
  // Exhaust DEFAULT_TENANT_ID's 200-request tenant bucket (as Owner).
  for (let i = 0; i < 200; i++) {
    const r = await invoke({ action: 'download', method: 'GET', token: ownerToken(), query: { id: 'whatever' } })
    assert(r.statusCode === 404, `setup call ${i} must reach the (nonexistent-asset) 404, not be rate-limited, got ${r.statusCode}`)
  }
  const blockedDefault = await invoke({ action: 'download', method: 'GET', token: ownerToken(), query: { id: 'whatever' } })
  assert(blockedDefault.statusCode === 429, `the default tenant must now be blocked by its own exhausted bucket, got ${blockedDefault.statusCode}`)
  // A wholly separate tenant must have its own, independent allowance.
  const okOther = await invoke({ action: 'download', method: 'GET', token: otherTenantToken, query: { id: 'whatever' } })
  assert(okOther.statusCode === 404, `Tenant B must be unaffected by Tenant A's exhausted bucket (its own request reaches the nonexistent-asset 404, not 429), got ${okOther.statusCode}`)
}

async function testDownloadPerUserLimiterStillEnforced() {
  // The per-user limiter (item 3's "do not remove the per-user limiter")
  // must still independently apply -- denies only the 60/60s shape.
  await setDirectory()
  _setLimiterFactoryForTests((requestsPerWindow, windowSeconds) => {
    if (requestsPerWindow === 60 && windowSeconds === 60) return { limit: async () => ({ success: false, remaining: 0 }) }
    return { limit: async () => ({ success: true, remaining: 99 }) }
  })
  const res = await invoke({ action: 'download', method: 'GET', token: ownerToken(), query: { id: 'whatever' } })
  assert(res.statusCode === 429, `the existing per-user limiter must still be enforced, got ${res.statusCode}`)
}

async function testDownloadRateLimitEnforced() {
  await setDirectory()
  _setLimiterFactoryForTests(() => ({ limit: async () => ({ success: false, remaining: 0 }) }))
  const res = await invoke({ action: 'download', method: 'GET', token: ownerToken(), query: { id: 'whatever' } })
  assert(res.statusCode === 429, `expected 429 from the new download rate limit, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testEmptyFileRejected() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  _setBlobClientForTests(() => fakeBlob().client)
  const campaign = await createCampaignAndApprove(null, 'Draft')
  const res = await invoke({
    action: 'upload', method: 'POST', token: ownerToken(),
    body: { campaignId: campaign.id, type: 'other', filename: 'empty.png', mimeType: 'image/png', fileBase64: '' },
  })
  assert(res.statusCode === 400, `a missing/empty fileBase64 must be rejected, got ${res.statusCode}`)
}

async function testPathTraversalFilenameRejected() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  _setBlobClientForTests(() => fakeBlob().client)
  const campaign = await createCampaignAndApprove(null, 'Draft')
  const res = await invoke({
    action: 'upload', method: 'POST', token: ownerToken(),
    body: { campaignId: campaign.id, type: 'other', filename: '../../etc/passwd.png', mimeType: 'image/png', fileBase64: FAKE_JPEG() },
  })
  assert(res.statusCode === 400, `a filename containing path-traversal characters must be rejected, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

// --- Download authorization ---------------------------------------------

async function uploadOneAsset(token, campaignId, blobClientFactory) {
  _setBlobClientForTests(blobClientFactory)
  return invoke({
    action: 'upload', method: 'POST', token,
    body: { campaignId, type: 'flyer_pdf', filename: 'flyer.pdf', mimeType: 'application/pdf', fileBase64: b64('%PDF-1.4 real-ish content') },
  })
}

async function testAuthorizedDownloadSucceeds() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  const blob = fakeBlob()
  const campaign = await createCampaignAndApprove(null, 'Approved')
  const uploaded = await uploadOneAsset(ownerToken(), campaign.id, () => blob.client)
  const res = await invoke({ action: 'download', token: lmToken(), query: { id: uploaded.body.asset.id } })
  assert(res.statusCode === 200, `an authorized download of an Approved asset expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testDraftAssetDownloadBlockedForLocationManager() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  const blob = fakeBlob()
  const campaign = await createCampaignAndApprove(null, 'Draft')
  const uploaded = await uploadOneAsset(ownerToken(), campaign.id, () => blob.client)
  const res = await invoke({ action: 'download', token: lmToken(), query: { id: uploaded.body.asset.id } })
  assert(res.statusCode === 404, `a Draft asset must never be downloadable by a location_manager, got ${res.statusCode}`)
}

async function testUnauthorizedDirectAssetDownloadReturns404() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  const blob = fakeBlob()
  const campaign = await createCampaignAndApprove(null, 'Approved') // locationIds: [7]
  const uploaded = await uploadOneAsset(ownerToken(), campaign.id, () => blob.client)
  const res = await invoke({ action: 'download', token: lmOtherToken(), query: { id: uploaded.body.asset.id } }) // scoped to [99]
  assert(res.statusCode === 404, `a direct-id download attempt for an asset outside the caller's location must return 404 (never confirm existence), got ${res.statusCode}`)
}

async function testApprovedAssetAvailableToAuthorizedViewer() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  const blob = fakeBlob()
  const campaign = await createCampaignAndApprove(null, 'Approved')
  const uploaded = await uploadOneAsset(ownerToken(), campaign.id, () => blob.client)
  const res = await invoke({ action: 'download', token: viewerToken(), query: { id: uploaded.body.asset.id } })
  assert(res.statusCode === 200, `read_only must be able to download an Approved asset for its own authorized location, got ${res.statusCode}`)
}

async function testDeletingAnAssetAlsoRemovesTheBlob() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  const blob = fakeBlob()
  const campaign = await createCampaignAndApprove(null, 'Draft')
  const uploaded = await uploadOneAsset(ownerToken(), campaign.id, () => blob.client)
  assert(Object.keys(blob.blobs).length === 1, 'the blob was actually written')
  const res = await invoke({ action: 'delete-asset', method: 'POST', token: ownerToken(), body: { id: uploaded.body.asset.id } })
  assert(res.statusCode === 200, 'delete-asset succeeds for an authorized manager')
  assert(Object.keys(blob.blobs).length === 0, 'deleting the asset record must also delete the underlying blob, never leaving an orphan')
}

// --- Campaign edit (upsert-campaign with an id) --------------------------

async function testOwnerCanEditCampaign() {
  await setDirectory()
  setFreshCampaignStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'Original', locationIds: [7] } })
  const res = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { id: created.body.campaign.id, name: 'Renamed' } })
  assert(res.statusCode === 200, `Owner edit expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.campaign.name === 'Renamed', 'the campaign name must reflect the edit')
}

async function testAdminCanEditCampaign() {
  await setDirectory()
  setFreshCampaignStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'Original', locationIds: [7] } })
  const res = await invoke({ action: 'upsert-campaign', method: 'POST', token: adminToken(), body: { id: created.body.campaign.id, name: 'Renamed by Admin' } })
  assert(res.statusCode === 200, `Admin edit expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(res.body.campaign.name === 'Renamed by Admin', 'the campaign name must reflect the admin edit')
}

async function testMarketingCanEditCampaignWithinScope() {
  await setDirectory()
  setFreshCampaignStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'Original', locationIds: [7] } })
  const res = await invoke({ action: 'upsert-campaign', method: 'POST', token: marketingToken(), body: { id: created.body.campaign.id, name: 'Renamed by Marketing' } })
  assert(res.statusCode === 200, `scoped marketing editing its own location's campaign expected 200, got ${res.statusCode}`)
}

async function testScopedMarketingCannotAddUnauthorizedLocation() {
  await setDirectory()
  setFreshCampaignStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'Original', locationIds: [7] } })
  const res = await invoke({ action: 'upsert-campaign', method: 'POST', token: marketingToken(), body: { id: created.body.campaign.id, locationIds: [7, 99] } })
  assert(res.statusCode === 403, `adding an unauthorized location must be rejected outright, got ${res.statusCode}`)
  const after = await invoke({ action: 'list-campaigns', token: ownerToken() })
  const campaign = after.body.campaigns.find(c => c.id === created.body.campaign.id)
  assert(JSON.stringify(campaign.locationIds) === JSON.stringify([7]), 'a rejected location expansion must never be partially applied (no silent trimming)')
}

async function testLocationManagerCannotEditCampaign() {
  await setDirectory()
  setFreshCampaignStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'Original', locationIds: [7] } })
  const res = await invoke({ action: 'upsert-campaign', method: 'POST', token: lmToken(), body: { id: created.body.campaign.id, name: 'Hijacked' } })
  assert(res.statusCode === 403, `location_manager must never hold CAMPAIGN_MANAGE, got ${res.statusCode}`)
}

async function testViewerCannotEditCampaign() {
  await setDirectory()
  setFreshCampaignStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'Original', locationIds: [7] } })
  const res = await invoke({ action: 'upsert-campaign', method: 'POST', token: viewerToken(), body: { id: created.body.campaign.id, name: 'Hijacked' } })
  assert(res.statusCode === 403, `read_only must never hold CAMPAIGN_MANAGE, got ${res.statusCode}`)
}

async function testEditPreservesIdAndCreatedMetadataButUpdatesUpdatedMetadata() {
  await setDirectory()
  setFreshCampaignStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'Original', locationIds: [7] } })
  const original = created.body.campaign
  // A real clock tick between the two writes -- toISOString() is only
  // millisecond-precise, and two back-to-back calls against an in-memory
  // fake store can otherwise land in the same millisecond, making the
  // "updatedAt changed" assertion below flaky rather than a real signal.
  await new Promise(r => setTimeout(r, 5))
  const res = await invoke({ action: 'upsert-campaign', method: 'POST', token: adminToken(), body: { id: original.id, name: 'Renamed' } })
  const edited = res.body.campaign
  assert(edited.id === original.id, 'editing must never change the campaign id')
  assert(edited.createdBy === original.createdBy, 'createdBy must be preserved across an edit')
  assert(edited.createdAt === original.createdAt, 'createdAt must be preserved across an edit')
  assert(edited.updatedBy === 'usr_admin', 'updatedBy must reflect the account that performed the edit')
  assert(edited.updatedAt !== original.updatedAt, 'updatedAt must change on every edit')
}

async function testEditingMetadataDoesNotChangeCampaignStatus() {
  await setDirectory()
  setFreshCampaignStore()
  const campaign = await createCampaignAndApprove(null, 'Approved')
  const res = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { id: campaign.id, name: 'New Name' } })
  assert(res.body.campaign.status === 'Approved', 'editing ordinary metadata must never reset or bypass the campaign\'s approval status')
}

async function testEditDoesNotAffectLinkedCalendarTask() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshTaskStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'Original', locationIds: [7] } })
  const campaignId = created.body.campaign.id
  const task = await createTask(DEFAULT_TENANT_ID, { title: 'Post flyer', type: 'promotion', locationIds: [7], startAt: '2026-09-01T00:00:00.000Z', campaignId }, { userId: 'usr_owner', displayName: 'Owner', email: 'owner@example.com' })
  await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { id: campaignId, name: 'Renamed' } })
  const afterEdit = await getTask(DEFAULT_TENANT_ID, task.id)
  assert(afterEdit.campaignId === campaignId, 'editing a campaign\'s metadata must never disturb a task\'s reference to it')
}

// --- Campaign delete -----------------------------------------------------

async function testOwnerCanDeleteCampaign() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  setFreshTaskStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'To Delete', locationIds: [7] } })
  const res = await invoke({ action: 'delete-campaign', method: 'POST', token: ownerToken(), body: { id: created.body.campaign.id } })
  assert(res.statusCode === 200, `Owner delete expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  const after = await invoke({ action: 'list-campaigns', token: ownerToken(), query: { includeArchived: '1' } })
  assert(after.body.campaigns.length === 0, 'the deleted campaign must no longer appear in any listing')
}

async function testAdminCanDeleteCampaign() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  setFreshTaskStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'To Delete', locationIds: [7] } })
  const res = await invoke({ action: 'delete-campaign', method: 'POST', token: adminToken(), body: { id: created.body.campaign.id } })
  assert(res.statusCode === 200, `Admin delete expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
}

async function testMarketingCanDeleteWithinScopeButNotOutsideIt() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  setFreshTaskStore()
  const ownCampaign = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'Mine', locationIds: [7] } })
  const otherCampaign = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'Not Mine', locationIds: [99] } })
  const okRes = await invoke({ action: 'delete-campaign', method: 'POST', token: marketingToken(), body: { id: ownCampaign.body.campaign.id } })
  assert(okRes.statusCode === 200, `marketing deleting its own scoped campaign expected 200, got ${okRes.statusCode}`)
  const deniedRes = await invoke({ action: 'delete-campaign', method: 'POST', token: marketingToken(), body: { id: otherCampaign.body.campaign.id } })
  assert(deniedRes.statusCode === 404, `marketing deleting a campaign outside its scope must be denied (404, non-disclosure), got ${deniedRes.statusCode}`)
}

async function testLocationManagerCannotDeleteCampaign() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  setFreshTaskStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'To Delete', locationIds: [7] } })
  const res = await invoke({ action: 'delete-campaign', method: 'POST', token: lmToken(), body: { id: created.body.campaign.id } })
  assert(res.statusCode === 403, `location_manager must never hold CAMPAIGN_MANAGE, got ${res.statusCode}`)
}

async function testViewerCannotDeleteCampaign() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  setFreshTaskStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'To Delete', locationIds: [7] } })
  const res = await invoke({ action: 'delete-campaign', method: 'POST', token: viewerToken(), body: { id: created.body.campaign.id } })
  assert(res.statusCode === 403, `read_only must never hold CAMPAIGN_MANAGE, got ${res.statusCode}`)
}

async function testCrossLocationDirectIdDeleteDenied() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  setFreshTaskStore()
  // lmOther holds CAMPAIGN_MANAGE-equivalent permissions? No -- location_manager
  // never does (see testLocationManagerCannotDeleteCampaign). To isolate the
  // LOCATION check specifically (as opposed to the ROLE check), attempt the
  // delete as marketing (scoped to [7], holds CAMPAIGN_MANAGE) against a
  // campaign scoped to a different location ([99]) via its direct id.
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'Location 99 Campaign', locationIds: [99] } })
  const res = await invoke({ action: 'delete-campaign', method: 'POST', token: marketingToken(), body: { id: created.body.campaign.id } })
  assert(res.statusCode === 404, `direct-id delete of a campaign outside the caller's location grant must return 404, never confirming existence, got ${res.statusCode}`)
}

async function testDeleteOfNonexistentOrMalformedIdIsSafe() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  setFreshTaskStore()
  const missing = await invoke({ action: 'delete-campaign', method: 'POST', token: ownerToken(), body: { id: 'campaign_does_not_exist' } })
  assert(missing.statusCode === 404, `deleting a nonexistent id must return 404, got ${missing.statusCode}`)
  const malformed = await invoke({ action: 'delete-campaign', method: 'POST', token: ownerToken(), body: { id: 12345 } })
  assert(malformed.statusCode === 400, `a non-string id must be rejected as invalid, got ${malformed.statusCode}`)
  const empty = await invoke({ action: 'delete-campaign', method: 'POST', token: ownerToken(), body: {} })
  assert(empty.statusCode === 400, `a missing id must be rejected as invalid, got ${empty.statusCode}`)
}

async function testDoubleDeleteIsSafe() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  setFreshTaskStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'To Delete Twice', locationIds: [7] } })
  const first = await invoke({ action: 'delete-campaign', method: 'POST', token: ownerToken(), body: { id: created.body.campaign.id } })
  assert(first.statusCode === 200, 'the first delete must succeed')
  const second = await invoke({ action: 'delete-campaign', method: 'POST', token: ownerToken(), body: { id: created.body.campaign.id } })
  assert(second.statusCode === 404, `a repeated delete of an already-deleted campaign must return 404, never crash or report success, got ${second.statusCode}`)
}

async function testDeleteCleansUpBlobAndAssetMetadata() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  setFreshTaskStore()
  const blob = fakeBlob()
  _setBlobClientForTests(() => blob.client)
  const campaign = await createCampaignAndApprove(null, 'Draft')
  await uploadOneAsset(ownerToken(), campaign.id, () => blob.client)
  assert(Object.keys(blob.blobs).length === 1, 'the asset\'s blob must have actually been written')
  const listBefore = await invoke({ action: 'list-assets', token: ownerToken(), query: { campaignId: campaign.id } })
  assert(listBefore.body.assets.length === 1, 'sanity: the asset is listed before deletion')

  const res = await invoke({ action: 'delete-campaign', method: 'POST', token: ownerToken(), body: { id: campaign.id } })
  assert(res.statusCode === 200, `campaign delete with an asset attached expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
  assert(Object.keys(blob.blobs).length === 0, 'deleting the campaign must delete every associated asset\'s blob object, never leaving an orphan')

  const assetRecord = await getAsset(DEFAULT_TENANT_ID, listBefore.body.assets[0].id)
  assert(assetRecord === null, 'the asset\'s own metadata record must also be deleted, not just hidden by the campaign\'s disappearance')
}

async function testDeleteUnlinksLinkedTaskWithoutDeletingIt() {
  await setDirectory()
  setFreshCampaignStore()
  setFreshAssetStore()
  setFreshTaskStore()
  const created = await invoke({ action: 'upsert-campaign', method: 'POST', token: ownerToken(), body: { name: 'Linked', locationIds: [7] } })
  const campaignId = created.body.campaign.id
  const task = await createTask(DEFAULT_TENANT_ID, { title: 'Post flyer', type: 'promotion', locationIds: [7], startAt: '2026-09-01T00:00:00.000Z', campaignId }, { userId: 'usr_owner', displayName: 'Owner', email: 'owner@example.com' })

  const res = await invoke({ action: 'delete-campaign', method: 'POST', token: ownerToken(), body: { id: campaignId } })
  assert(res.statusCode === 200, `delete expected 200, got ${res.statusCode}`)
  assert(res.body.unlinkedTaskCount === 1, 'the response must report exactly one unlinked task')

  const afterDelete = await getTask(DEFAULT_TENANT_ID, task.id)
  assert(afterDelete !== null, 'campaign deletion must never delete a Calendar task that merely referenced it')
  assert(afterDelete.campaignId === null, 'the task\'s broken campaignId reference must be cleared')
  assert(afterDelete.history.some(h => h.action.includes('Unlinked')), 'the unlink must be recorded in the task\'s own audit history')
}

const tests = [
  ['a Draft campaign is invisible to a location manager', testDraftCampaignInvisibleToLocationManager],
  ['a Draft campaign is visible to marketing (holds CONTENT_MANAGE)', testDraftCampaignVisibleToMarketingWithContentManage],
  ['an Approved campaign is visible to an authorized location manager', testApprovedCampaignVisibleToAuthorizedLocationManager],
  ['an Approved campaign is invisible to an unauthorized location manager', testApprovedCampaignInvisibleToUnauthorizedLocationManager],
  ['an Archived campaign is hidden from the default list but visible with includeArchived', testArchivedCampaignHiddenFromDefaultListButVisibleWithFlag],
  ['only CONTENT_MANAGE roles can approve a campaign', testOnlyContentManageRolesCanApproveACampaign],
  ['company-wide campaign creation is restricted to unscoped accounts', testCompanyWideCampaignCreationRestrictedToUnscopedAccounts],
  ['a viewer can see Approved campaigns but cannot create or approve', testViewerCanSeeApprovedButCannotCreateOrApprove],
  ['an authorized upload succeeds and never exposes the blob pathname', testAuthorizedUploadSucceeds],
  ['an unauthorized upload (no CONTENT_UPLOAD) is rejected', testUnauthorizedUploadRejected],
  ['an upload to a campaign outside the uploader\'s scope is rejected (404)', testUploadToACampaignOutsideUploaderScopeRejected],
  ['MIME type validation rejects an executable disguised as a marketing file', testMimeTypeValidationRejectsUnsupportedTypes],
  ['a mismatched file extension/MIME type is rejected', testMimeExtensionMismatchRejected],
  ['an oversized file is rejected', testOversizedFileRejected],
  ['PHASE A6: upload above the tenant storage ceiling is rejected before any Blob write', testUploadAboveTenantStorageCeilingRejectedBeforeBlobWrite],
  ['PHASE A6: upload above the tenant asset-count ceiling is rejected before any Blob write', testAssetCountCeilingEnforced],
  ['PHASE A6: a second user in the same tenant cannot bypass the tenant-wide ceiling', testSecondUserInSameTenantCannotBypassTenantCeiling],
  ['FINAL REVIEW item 2: two concurrent near-ceiling uploads -- exactly one succeeds', testConcurrentUploadsNearCeilingExactlyOneSucceeds],
  ['FINAL SAFETY INVARIANTS item 2 (1/5): the upload lock grants mutual exclusion', testLockGrantsMutualExclusion],
  ['FINAL SAFETY INVARIANTS item 2 (2/5): a stale expired lease can never delete a newer lock', testStaleExpiredLeaseCannotDeleteANewerLock],
  ['FINAL SAFETY INVARIANTS item 2 (3/5): heartbeat renewal keeps the lease alive beyond the original TTL window', testHeartbeatRenewalKeepsLeaseAliveBeyondOriginalTtlWindow],
  ['FINAL SAFETY INVARIANTS item 2: renewing with the wrong token never extends someone else\'s lease', testRenewalWithWrongTokenNeverExtendsSomeoneElsesLease],
  ['FINAL SAFETY INVARIANTS item 2 (5/5): a Blob failure releases the lock without corrupting metadata', testBlobFailureDuringUploadReleasesLockWithoutCorruptingMetadata],
  ['DEPLOYMENT GATE item 2: lease lost after Blob creation cleans up the orphan and never commits metadata', testLeaseLostAfterBlobCreationCleansUpOrphanAndNeverCreatesMetadata],
  ['PHASE A6: download is now rate-limited', testDownloadRateLimitEnforced],
  ['FINAL REVIEW item 3: download tenant bucket blocks a second user in the same tenant', testDownloadTenantBucketBlocksSecondUserSameTenant],
  ['FINAL REVIEW item 3: download tenant bucket is independent across tenants', testDownloadTenantBucketIndependentAcrossTenants],
  ['FINAL REVIEW item 3: per-user download limiter is still independently enforced', testDownloadPerUserLimiterStillEnforced],
  ['an empty/missing file is rejected', testEmptyFileRejected],
  ['a path-traversal filename is rejected', testPathTraversalFilenameRejected],
  ['an authorized download of an Approved asset succeeds', testAuthorizedDownloadSucceeds],
  ['a Draft asset is never downloadable by a location manager', testDraftAssetDownloadBlockedForLocationManager],
  ['an unauthorized direct asset download returns 404, never confirming existence', testUnauthorizedDirectAssetDownloadReturns404],
  ['an Approved asset is available to an authorized viewer (read_only)', testApprovedAssetAvailableToAuthorizedViewer],
  ['deleting an asset also deletes the underlying blob, never leaving an orphan', testDeletingAnAssetAlsoRemovesTheBlob],

  // --- Campaign edit ---
  ['Owner can edit a campaign', testOwnerCanEditCampaign],
  ['Admin can edit a campaign', testAdminCanEditCampaign],
  ['scoped Marketing can edit a campaign within its own location', testMarketingCanEditCampaignWithinScope],
  ['scoped Marketing cannot add an unauthorized location to a campaign (rejected outright, no trimming)', testScopedMarketingCannotAddUnauthorizedLocation],
  ['Location Manager cannot edit a campaign', testLocationManagerCannotEditCampaign],
  ['Viewer cannot edit a campaign', testViewerCannotEditCampaign],
  ['editing a campaign preserves its id and created metadata but updates updated metadata', testEditPreservesIdAndCreatedMetadataButUpdatesUpdatedMetadata],
  ['editing ordinary campaign metadata does not change its approval status', testEditingMetadataDoesNotChangeCampaignStatus],
  ['editing a campaign does not disturb a linked Calendar task\'s reference to it', testEditDoesNotAffectLinkedCalendarTask],

  // --- Campaign delete ---
  ['Owner can delete a campaign', testOwnerCanDeleteCampaign],
  ['Admin can delete a campaign', testAdminCanDeleteCampaign],
  ['Marketing can delete within its scope but not outside it', testMarketingCanDeleteWithinScopeButNotOutsideIt],
  ['Location Manager cannot delete a campaign', testLocationManagerCannotDeleteCampaign],
  ['Viewer cannot delete a campaign', testViewerCannotDeleteCampaign],
  ['a cross-location direct-id delete is denied (404, non-disclosure)', testCrossLocationDirectIdDeleteDenied],
  ['deleting a nonexistent or malformed campaign id is handled safely', testDeleteOfNonexistentOrMalformedIdIsSafe],
  ['a double delete of the same campaign is safe (second attempt 404s, never crashes)', testDoubleDeleteIsSafe],
  ['deleting a campaign cleans up its assets\' Blob objects and metadata', testDeleteCleansUpBlobAndAssetMetadata],
  ['deleting a campaign unlinks (never deletes) a linked Calendar task, with an audited history entry', testDeleteUnlinksLinkedTaskWithoutDeletingIt],
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
