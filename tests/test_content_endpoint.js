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
import handler from '../dashboard/api/content/[action].js'
import { signSession } from '../dashboard/api/_lib/session.js'
import { _setRedisClientForTests as _setCampaignRedis, _resetRedisClientForTests as _resetCampaignRedis } from '../dashboard/api/_lib/campaignStore.js'
import { _setRedisClientForTests as _setAssetRedis, _resetRedisClientForTests as _resetAssetRedis } from '../dashboard/api/_lib/contentAssetStore.js'
import { _setBlobClientForTests, _resetBlobClientForTests } from '../dashboard/api/_lib/blobStore.js'
import { _resetLimiterFactoryForTests } from '../dashboard/api/_lib/rateLimit.js'

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
    _resetBlobClientForTests()
    _resetLimiterFactoryForTests()
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
function fakeRedis(initial = {}) {
  const store = { ...initial }
  return {
    hgetall: async () => ({ ...store }),
    hget: async (_key, field) => store[field] ?? null,
    hset: async (_key, fields) => { Object.assign(store, fields) },
    hdel: async (_key, field) => { const had = field in store; delete store[field]; return had ? 1 : 0 },
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
      { userId: 'usr_marketing', email: 'marketing@example.com', passwordHash: hash, role: 'marketing', locationIds: [7], sessionVersion: 1, disabled: false, displayName: 'Marketing' },
      { userId: 'usr_lm', email: 'lm@example.com', passwordHash: hash, role: 'location_manager', locationIds: [7], sessionVersion: 1, disabled: false, displayName: 'LM' },
      { userId: 'usr_lm_other', email: 'lm-other@example.com', passwordHash: hash, role: 'location_manager', locationIds: [99], sessionVersion: 1, disabled: false, displayName: 'LM Other' },
      { userId: 'usr_viewer', email: 'viewer@example.com', passwordHash: hash, role: 'read_only', locationIds: [7], sessionVersion: 1, disabled: false, displayName: 'Viewer' },
    ],
  })
}

async function tokenFor(userId, role, locationIds) {
  return signSession({ userId, email: `${userId}@example.com`, role, locationIds, sessionVersion: 1 })
}
const ownerToken = () => tokenFor('usr_owner', 'owner', '*')
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
  ['an empty/missing file is rejected', testEmptyFileRejected],
  ['a path-traversal filename is rejected', testPathTraversalFilenameRejected],
  ['an authorized download of an Approved asset succeeds', testAuthorizedDownloadSucceeds],
  ['a Draft asset is never downloadable by a location manager', testDraftAssetDownloadBlockedForLocationManager],
  ['an unauthorized direct asset download returns 404, never confirming existence', testUnauthorizedDirectAssetDownloadReturns404],
  ['an Approved asset is available to an authorized viewer (read_only)', testApprovedAssetAvailableToAuthorizedViewer],
  ['deleting an asset also deletes the underlying blob, never leaving an orphan', testDeletingAnAssetAlsoRemovesTheBlob],
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
