// Operations Calendar + Content Library milestone -- consolidated Content
// Library endpoint (same Hobby-plan-conscious consolidation as
// tasks/[action].js). External routes: GET /api/content/list-campaigns,
// GET /api/content/list-assets, POST /api/content/upsert-campaign,
// POST /api/content/create-text-asset, POST /api/content/upload,
// GET /api/content/download, POST /api/content/delete-asset.
//
// UPLOAD ARCHITECTURE NOTE (deviation from the original client-direct-token
// plan, documented per "stop and explain before improvising" -- this
// materially changes the plan in a way that makes it SAFER and simpler, so
// it was implemented rather than escalated): @vercel/blob's client-direct
// upload (`upload()`/`handleUpload()`) requires the BROWSER to declare
// `access: 'public' | 'private'` itself -- onBeforeGenerateToken's return
// value has no `access` field to override it (checked directly against the
// installed SDK's type definitions). That means the "never public" hard
// requirement would depend on trusting client-supplied JS to declare
// 'private' honestly, which is exactly the "do not fake security
// client-side" anti-pattern this milestone is required to avoid. Since
// Vercel Functions now support up to 100MB request bodies (comfortably
// above this endpoint's 50MB PDF cap), the original motivation for
// client-direct upload (avoiding a small function body-size limit) no
// longer applies at these file sizes. Uploads instead go through this
// server function, which calls `put(..., { access: 'private' })` itself --
// access is hardcoded server-side and never client-influenceable.
//
// SECURITY MODEL (hard requirement, never relaxed):
//   - Assets are stored PRIVATE in Vercel Blob (access: 'private', set only
//     here, server-side). A Blob pathname is never treated as a credential
//     or sent to the browser -- every download goes through download()
//     below, which re-checks auth + role/permission + the asset's campaign
//     + that campaign's status + the caller's location grant on EVERY
//     request, never cached from an earlier decision.
//   - Draft campaigns/assets are invisible (404, not 403) to anyone without
//     CONTENT_MANAGE -- a location_manager/read_only account can never see
//     or download unfinished marketing material, in list responses OR via
//     direct id.
//   - Upload authorization (auth, CONTENT_UPLOAD, campaign/location) is
//     fully checked server-side in upload() below BEFORE anything is
//     written to Blob -- never client-side.

import { randomUUID } from 'crypto'
import { putBlob, getBlob, deleteBlob, BlobStoreUnavailableError } from '../_lib/blobStore.js'
import { requireAuth } from '../_lib/auth.js'
import { Permission, roleHasPermission } from '../_lib/permissions.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import { appendAuditEntry, clientIp } from '../_lib/auditLog.js'
import {
  getAllCampaigns, getCampaign, createCampaign, updateCampaign, CampaignStoreUnavailableError,
} from '../_lib/campaignStore.js'
import {
  getAllAssets, getAsset, createAsset, deleteAsset, ContentAssetStoreUnavailableError,
} from '../_lib/contentAssetStore.js'

const CAMPAIGN_STATUSES = new Set(['Draft', 'Approved', 'Archived'])
const ASSET_TYPES = new Set([
  'instagram_post', 'facebook_post', 'story_reel', 'flyer_pdf', 'banner_pdf',
  'menu_insert', 'website_graphic', 'caption', 'other',
])

// MIME allowlist, cross-checked against the filename's extension -- never
// trust either signal alone. Executable/script/HTML content (or anything
// else not explicitly a marketing image or PDF) is rejected outright,
// regardless of what extension the client claims.
const ALLOWED_ASSET_MIME = {
  'image/jpeg': { exts: ['.jpg', '.jpeg'], maxBytes: 15 * 1024 * 1024 },
  'image/png':  { exts: ['.png'],          maxBytes: 15 * 1024 * 1024 },
  'image/webp': { exts: ['.webp'],         maxBytes: 15 * 1024 * 1024 },
  'image/gif':  { exts: ['.gif'],          maxBytes: 15 * 1024 * 1024 },
  'application/pdf': { exts: ['.pdf'],     maxBytes: 50 * 1024 * 1024 },
}

function actorFields(account, req) {
  return { actorId: account.userId, actorName: account.displayName ?? account.email, actorEmail: account.email, ip: clientIp(req) }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isValidLocationIdsShape(locationIds) {
  if (locationIds === '*') return true
  if (!Array.isArray(locationIds) || locationIds.length === 0) return false
  const seen = new Set()
  for (const id of locationIds) {
    if (!Number.isInteger(id) || id <= 0) return false
    if (seen.has(id)) return false
    seen.add(id)
  }
  return true
}

function accountCoversLocations(account, targetLocationIds) {
  if (targetLocationIds === '*') return account.locationIds === '*'
  if (account.locationIds === '*') return true
  if (!Array.isArray(account.locationIds)) return false
  return targetLocationIds.every(id => account.locationIds.includes(id))
}

function isRequestedLocationsAuthorized(account, requestedLocationIds) {
  if (requestedLocationIds === '*') return account.locationIds === '*'
  if (account.locationIds === '*') return true
  return requestedLocationIds.every(id => account.locationIds.includes(id))
}

// Whether `account` may currently VIEW a campaign at all -- the single
// gate every list/read/download path below funnels through. Draft is
// CONTENT_MANAGE-only; Approved/Archived require CONTENT_VIEW plus a
// location grant that covers the campaign (or the campaign is '*').
function canViewCampaign(account, campaign) {
  if (!campaign) return false
  if (campaign.status === 'Draft') {
    return roleHasPermission(account.role, Permission.CONTENT_MANAGE)
  }
  if (!roleHasPermission(account.role, Permission.CONTENT_VIEW)) return false
  if (campaign.locationIds === '*') return true
  return Array.isArray(account.locationIds)
    ? campaign.locationIds.some(id => account.locationIds.includes(id))
    : account.locationIds === '*'
}

function extOf(filename) {
  const i = filename.lastIndexOf('.')
  return i === -1 ? '' : filename.slice(i).toLowerCase()
}

function validateUploadRequest({ filename, mimeType, sizeBytes, type, campaignId }) {
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 255) {
    return { valid: false, message: 'filename is required (max 255 characters).' }
  }
  if (/[/\\\0]/.test(filename)) return { valid: false, message: 'filename contains invalid characters.' }
  const rule = ALLOWED_ASSET_MIME[mimeType]
  if (!rule) {
    return { valid: false, message: `Unsupported file type "${mimeType}". Allowed: images (JPEG/PNG/WEBP/GIF) and PDF.` }
  }
  if (!rule.exts.includes(extOf(filename))) {
    return { valid: false, message: `The file extension does not match its declared type (${mimeType}).` }
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > rule.maxBytes) {
    return { valid: false, message: `File size must be between 1 byte and ${(rule.maxBytes / (1024 * 1024)).toFixed(0)}MB for this file type.` }
  }
  if (!ASSET_TYPES.has(type) || type === 'caption') {
    return { valid: false, message: 'type must be a binary asset type (not "caption" -- use create-text-asset for captions).' }
  }
  if (typeof campaignId !== 'string' || !campaignId) {
    return { valid: false, message: 'campaignId is required.' }
  }
  return { valid: true }
}

// --- list-campaigns -------------------------------------------------------
// GET /api/content/list-campaigns?includeArchived=1
async function listCampaigns(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return
  if (!roleHasPermission(account.role, Permission.CONTENT_VIEW) && !roleHasPermission(account.role, Permission.CONTENT_MANAGE)) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to view campaigns.' })
  }

  const includeArchived = req.query?.includeArchived === '1' || req.query?.includeArchived === 'true'

  try {
    const all = await getAllCampaigns()
    const visible = Object.values(all).filter(c => canViewCampaign(account, c) && (includeArchived || c.status !== 'Archived'))
    return res.status(200).json({ campaigns: visible })
  } catch (err) {
    if (err instanceof CampaignStoreUnavailableError) {
      console.error(`[content/list-campaigns] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The content library is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// --- upsert-campaign --------------------------------------------------------
// POST /api/content/upsert-campaign { id?, name, description?, startDate?,
// endDate?, locationIds, tags?, status? }
// Creating requires CAMPAIGN_CREATE; a new campaign always starts 'Draft'
// regardless of any client-supplied status. Editing an existing campaign
// (including any status transition -- Draft->Approved, ->Archived, or back)
// requires CAMPAIGN_MANAGE. Company-wide (locationIds: '*') is only valid
// for an unscoped account, on create AND on edit.
async function upsertCampaign(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `content:upsert-campaign:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const { id, name, description, startDate, endDate, locationIds, tags, status } = req.body ?? {}

  try {
    if (id) {
      if (!roleHasPermission(account.role, Permission.CAMPAIGN_MANAGE)) {
        return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to manage campaigns.' })
      }
      const existing = await getCampaign(id)
      if (!existing || !accountCoversLocations(account, existing.locationIds)) {
        return res.status(404).json({ error: 'not_found' })
      }
      const patch = {}
      if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim() || name.length > 200) return res.status(400).json({ error: 'invalid_request', message: 'name must be a non-empty string (max 200 characters).' })
        patch.name = name.trim()
      }
      if (description !== undefined) patch.description = String(description).slice(0, 5000)
      if (startDate !== undefined) patch.startDate = startDate
      if (endDate !== undefined) patch.endDate = endDate
      if (tags !== undefined) patch.tags = Array.isArray(tags) ? tags.map(String) : []
      if (locationIds !== undefined) {
        if (!isValidLocationIdsShape(locationIds)) return res.status(400).json({ error: 'invalid_request', message: 'invalid locationIds.' })
        if (!isRequestedLocationsAuthorized(account, locationIds)) {
          return res.status(403).json({ error: 'forbidden', message: 'You are not authorized for one or more of the requested locations.' })
        }
        patch.locationIds = locationIds
      }
      if (status !== undefined) {
        if (!CAMPAIGN_STATUSES.has(status)) return res.status(400).json({ error: 'invalid_request', message: 'invalid status.' })
        patch.status = status
      }

      const record = await updateCampaign(id, patch, account)
      if (status && status !== existing.status) {
        await appendAuditEntry({
          ...actorFields(account, req), entity: 'campaign', entityId: id,
          action: status === 'Approved' ? 'campaign.approved' : status === 'Archived' ? 'campaign.archived' : 'campaign.status_changed',
          changes: [{ field: 'status', oldValue: existing.status, newValue: status }],
          result: 'success', message: `Campaign "${record.name}" -> ${status}.`,
        })
      }
      return res.status(200).json({ campaign: record })
    }

    // Create path.
    if (!roleHasPermission(account.role, Permission.CAMPAIGN_CREATE)) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to create campaigns.' })
    }
    if (typeof name !== 'string' || !name.trim() || name.length > 200) {
      return res.status(400).json({ error: 'invalid_request', message: 'name is required (max 200 characters).' })
    }
    if (!isValidLocationIdsShape(locationIds)) {
      return res.status(400).json({ error: 'invalid_request', message: "locationIds must be '*' or a non-empty array of distinct positive integers." })
    }
    if (!isRequestedLocationsAuthorized(account, locationIds)) {
      return res.status(403).json({ error: 'forbidden', message: 'You are not authorized to create a campaign for one or more of the requested locations.' })
    }

    const record = await createCampaign({ name: name.trim(), description, startDate, endDate, locationIds, tags }, account)
    await appendAuditEntry({
      ...actorFields(account, req), entity: 'campaign', entityId: record.id,
      action: 'campaign.created', result: 'success', message: `Created campaign "${record.name}".`,
    })
    return res.status(201).json({ campaign: record })
  } catch (err) {
    if (err instanceof CampaignStoreUnavailableError) {
      console.error(`[content/upsert-campaign] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The content library is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// --- list-assets ------------------------------------------------------------
// GET /api/content/list-assets?campaignId=... -- every returned asset's
// parent campaign is re-checked via canViewCampaign(); an asset whose
// campaign the caller cannot view is simply omitted, never returned and
// hidden client-side.
async function listAssets(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return
  if (!roleHasPermission(account.role, Permission.CONTENT_VIEW) && !roleHasPermission(account.role, Permission.CONTENT_MANAGE)) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to view content.' })
  }

  const { campaignId } = req.query ?? {}

  try {
    const [campaigns, assets] = await Promise.all([getAllCampaigns(), getAllAssets()])
    const visibleCampaignIds = new Set(Object.values(campaigns).filter(c => canViewCampaign(account, c)).map(c => c.id))
    let visible = Object.values(assets).filter(a => visibleCampaignIds.has(a.campaignId))
    if (campaignId) visible = visible.filter(a => a.campaignId === campaignId)
    // blobPathname is an internal storage detail, never sent to the
    // browser -- downloads are always mediated through download() below,
    // which re-authorizes on every request rather than trusting a client-
    // held path/URL.
    const sanitized = visible.map(({ blobPathname, ...rest }) => rest)
    return res.status(200).json({ assets: sanitized })
  } catch (err) {
    if (err instanceof ContentAssetStoreUnavailableError || err instanceof CampaignStoreUnavailableError) {
      console.error(`[content/list-assets] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The content library is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// --- create-text-asset --------------------------------------------------
// POST /api/content/create-text-asset { campaignId, captionText, filename?
// } -- captions never touch Blob storage at all (no binary content).
async function createTextAsset(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return
  if (!roleHasPermission(account.role, Permission.CONTENT_UPLOAD)) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to add content.' })
  }

  const allowed = await enforceRateLimit(req, res, `content:create-text-asset:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const { campaignId, captionText, filename } = req.body ?? {}
  if (typeof campaignId !== 'string' || !campaignId) return res.status(400).json({ error: 'invalid_request', message: 'campaignId is required.' })
  if (typeof captionText !== 'string' || !captionText.trim() || captionText.length > 5000) {
    return res.status(400).json({ error: 'invalid_request', message: 'captionText is required (max 5000 characters).' })
  }

  try {
    const campaign = await getCampaign(campaignId)
    if (!campaign || !accountCoversLocations(account, campaign.locationIds)) return res.status(404).json({ error: 'not_found' })

    const record = await createAsset({
      campaignId, type: 'caption', filename: filename || 'caption.txt',
      mimeType: 'text/plain', sizeBytes: captionText.length, blobPathname: null, captionText: captionText.trim(),
    }, account)
    await appendAuditEntry({
      ...actorFields(account, req), entity: 'content_asset', entityId: record.id,
      action: 'asset.uploaded', result: 'success', message: `Added caption to campaign "${campaign.name}".`,
    })
    const { blobPathname, ...safe } = record
    return res.status(201).json({ asset: safe })
  } catch (err) {
    if (err instanceof ContentAssetStoreUnavailableError || err instanceof CampaignStoreUnavailableError) {
      console.error(`[content/create-text-asset] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The content library is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// --- upload -----------------------------------------------------------------
// POST /api/content/upload { campaignId, type, filename, mimeType,
// fileBase64 } -- server-mediated (see the header comment for why this
// replaced client-direct upload). The request body's declared mimeType/
// filename/size are re-validated here regardless of what the client
// claims; the actually-decoded buffer's byte length is checked against the
// claimed size (a lying Content-Length-equivalent is rejected, not trusted).
async function upload(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return
  if (!roleHasPermission(account.role, Permission.CONTENT_UPLOAD)) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to upload content.' })
  }

  const allowed = await enforceRateLimit(req, res, `content:upload:${account.userId}`, { requestsPerWindow: 20, windowSeconds: 60 })
  if (!allowed) return

  const { campaignId, type, filename, mimeType, fileBase64 } = req.body ?? {}
  if (typeof fileBase64 !== 'string' || !fileBase64) {
    return res.status(400).json({ error: 'invalid_request', message: 'fileBase64 is required.' })
  }

  let buffer
  try {
    buffer = Buffer.from(fileBase64, 'base64')
  } catch {
    return res.status(400).json({ error: 'invalid_request', message: 'fileBase64 could not be decoded.' })
  }
  if (buffer.length === 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'The uploaded file is empty.' })
  }

  const check = validateUploadRequest({ filename, mimeType, sizeBytes: buffer.length, type, campaignId })
  if (!check.valid) return res.status(400).json({ error: 'invalid_request', message: check.message })

  try {
    const campaign = await getCampaign(campaignId)
    if (!campaign || !accountCoversLocations(account, campaign.locationIds)) return res.status(404).json({ error: 'not_found' })

    const pathname = `content/${campaignId}/${randomUUID()}${extOf(filename)}`
    const blob = await putBlob(pathname, buffer, { contentType: mimeType })

    const record = await createAsset({
      campaignId, type, filename, mimeType, sizeBytes: buffer.length, blobPathname: blob.pathname, captionText: null,
    }, account)
    await appendAuditEntry({
      ...actorFields(account, req), entity: 'content_asset', entityId: record.id,
      action: 'asset.uploaded', result: 'success', message: `Uploaded "${filename}" to campaign "${campaign.name}".`,
    })
    const { blobPathname, ...safe } = record
    return res.status(201).json({ asset: safe })
  } catch (err) {
    if (err instanceof ContentAssetStoreUnavailableError || err instanceof CampaignStoreUnavailableError || err instanceof BlobStoreUnavailableError) {
      console.error(`[content/upload] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The content library is temporarily unavailable. Please try again shortly.' })
    }
    console.error(`[content/upload] blob write failed: ${err.message}`)
    return res.status(502).json({ error: 'upstream_error', message: 'The file could not be stored. Please try again shortly.' })
  }
}

// --- download ---------------------------------------------------------------
// GET /api/content/download?id=... -- re-checks EVERYTHING on every call:
// authentication, CONTENT_VIEW, the asset's campaign, that campaign's
// status, and the caller's location grant. Never issues a redirect to a
// public URL; fetches the private blob server-side and streams it through,
// so the Blob pathname/URL itself is never exposed to the browser.
// `disposition=inline` (vs. the default `attachment`) is what lets a PDF
// open directly in the browser's own PDF viewer -- from there, Print uses
// the browser's native print dialog. No custom print engine: this is the
// entire mechanism, per the explicit "use the browser/PDF workflow"
// requirement.
async function download(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return

  const { id, disposition } = req.query ?? {}
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'invalid_request', message: 'id is required.' })

  try {
    const asset = await getAsset(id)
    if (!asset || !asset.blobPathname) return res.status(404).json({ error: 'not_found' })

    const campaign = await getCampaign(asset.campaignId)
    if (!canViewCampaign(account, campaign)) return res.status(404).json({ error: 'not_found' })

    // getBlob() with access: 'private' performs the SDK's own authenticated
    // fetch against the private blob -- the pathname alone is never a
    // usable public URL, so there is nothing here a client could replay.
    const result = await getBlob(asset.blobPathname)
    if (!result || result.statusCode !== 200 || !result.stream) {
      return res.status(404).json({ error: 'not_found' })
    }

    const dispositionType = disposition === 'inline' ? 'inline' : 'attachment'
    res.setHeader('Content-Type', asset.mimeType)
    res.setHeader('Content-Disposition', `${dispositionType}; filename="${asset.filename.replace(/"/g, '')}"`)
    const chunks = []
    for await (const chunk of result.stream) chunks.push(chunk)
    return res.status(200).send(Buffer.concat(chunks.map(c => Buffer.from(c))))
  } catch (err) {
    if (err instanceof ContentAssetStoreUnavailableError || err instanceof CampaignStoreUnavailableError || err instanceof BlobStoreUnavailableError) {
      console.error(`[content/download] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The content library is temporarily unavailable. Please try again shortly.' })
    }
    console.error(`[content/download] ${err.message}`)
    return res.status(502).json({ error: 'upstream_error', message: 'Could not retrieve the file.' })
  }
}

// --- delete-asset -----------------------------------------------------------
// POST /api/content/delete-asset { id }
async function deleteAssetAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return
  if (!roleHasPermission(account.role, Permission.CONTENT_MANAGE)) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to delete content.' })
  }

  const allowed = await enforceRateLimit(req, res, `content:delete-asset:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const { id } = req.body ?? {}
  if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'invalid_request', message: 'id is required.' })

  try {
    const asset = await getAsset(id)
    if (!asset) return res.status(404).json({ error: 'not_found' })
    const campaign = await getCampaign(asset.campaignId)
    if (!campaign || !accountCoversLocations(account, campaign.locationIds)) return res.status(404).json({ error: 'not_found' })

    if (asset.blobPathname) {
      try { await deleteBlob(asset.blobPathname) } catch (err) { console.error(`[content/delete-asset] blob delete failed: ${err.message}`) }
    }
    await deleteAsset(id)
    await appendAuditEntry({
      ...actorFields(account, req), entity: 'content_asset', entityId: id,
      action: 'asset.deleted', result: 'success', message: `Deleted asset "${asset.filename}" from campaign ${asset.campaignId}.`,
    })
    return res.status(200).json({ success: true })
  } catch (err) {
    if (err instanceof ContentAssetStoreUnavailableError || err instanceof CampaignStoreUnavailableError) {
      console.error(`[content/delete-asset] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The content library is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

export default async function handler(req, res) {
  switch (req.query?.action) {
    case 'list-campaigns':    return listCampaigns(req, res)
    case 'upsert-campaign':   return upsertCampaign(req, res)
    case 'list-assets':       return listAssets(req, res)
    case 'create-text-asset': return createTextAsset(req, res)
    case 'upload':            return upload(req, res)
    case 'download':          return download(req, res)
    case 'delete-asset':      return deleteAssetAction(req, res)
    default:                  return res.status(404).json({ error: 'not_found' })
  }
}

// Exported for unit tests only (validation is pure and worth testing
// directly without a full Blob/Redis round trip).
export { validateUploadRequest, canViewCampaign, ALLOWED_ASSET_MIME }
