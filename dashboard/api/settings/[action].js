// Single serverless function handling every operational Settings action
// (Phase 8) -- the second new function slot freed up by Milestone 8.2's
// google/[action].js consolidation, following the identical dynamic-route
// dispatch pattern actions/[action].js and session/[action].js already use.
// Vercel/Node populates req.query.action from the URL segment.
//
// Milestone 8.3 adds the Restaurant Contacts actions (this replaces the old
// edit-reviews.db -> export_chunks.py -> commit -> deploy cycle -- see
// README "Restaurant Contacts Store"). Future Settings sections (Email
// System, Audit Log, and later Email Templates/Notification Rules/Manager
// Accounts/API Integrations/System Health) are each meant to add new
// `case`s here, never a new file -- see dashboard/src/pages/settings/
// settingsSections.js's own header comment for the matching frontend
// extensibility mechanism.
//
// GET  /api/settings/contacts               -- list (all for owner/marketing,
//                                               own-location(s)-only for
//                                               location_manager)
// POST /api/settings/contacts-upsert        -- create/edit
// POST /api/settings/contacts-delete        -- genuine removal
// POST /api/settings/contacts-toggle-active -- Disable/Enable Contact
// POST /api/settings/contacts-backfill-from-legacy -- Milestone 8.5, see below
// GET  /api/settings/audit-log              -- Milestone 8.6
// GET  /api/settings/email-status           -- Milestone 8.9
// POST /api/settings/contacts-send-test-email -- Milestone 8.9

import { readFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { requireAuth, requireScopedAuth } from '../_lib/auth.js'
import { roleHasPermission, Permission } from '../_lib/permissions.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import {
  getAllContacts, getContact, upsertContact, deleteContact, ContactStoreUnavailableError,
} from '../_lib/contactStore.js'
import { appendAuditEntry, listAuditEntries, clientIp, AuditLogUnavailableError } from '../_lib/auditLog.js'
import { hasSmtpConfig, sendReviewEmail, EmailSenderUnavailableError } from '../_lib/emailSender.js'
import { buildTestEmailSubject, buildTestEmail } from '../_lib/testEmailTemplate.js'

function actorFields(account, req) {
  return { actorId: account.userId, actorName: account.displayName ?? account.email, actorEmail: account.email, ip: clientIp(req) }
}

// Same redaction discipline as actions/[action].js's own copy -- SMTP send
// errors could in principle echo configured credentials back, so strip them
// defensively before this ever reaches a log line, an audit entry, or a
// response body. Duplicated rather than imported, matching this codebase's
// established convention for small cross-boundary helpers (see auditLog.js's
// clientIp()).
function sanitizeErrorMessage(message) {
  let out = String(message ?? 'unknown error')
  if (process.env.SMTP_PASSWORD) out = out.split(process.env.SMTP_PASSWORD).join('[redacted]')
  if (process.env.SMTP_USER) out = out.split(process.env.SMTP_USER).join('[redacted]')
  return out.slice(0, 300)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LEGACY_CONTACTS_PATH = path.resolve(__dirname, '..', '..', 'private-data', 'location-contacts.json')
const META_PATH = path.resolve(__dirname, '..', '..', 'private-data', 'meta.json')

// Test-only seam for the backfill action below -- lets tests inject fixed
// legacy-contacts/meta content without touching the real filesystem path,
// same pattern locationContacts.js's own _setContactsForTests uses.
let legacyContactsOverride = null
let metaOverride = null
export function _setLegacyBackfillDataForTests(legacyContacts, meta) {
  legacyContactsOverride = legacyContacts
  metaOverride = meta
}
export function _resetLegacyBackfillDataForTests() {
  legacyContactsOverride = null
  metaOverride = null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidEmail(v) {
  return typeof v === 'string' && EMAIL_RE.test(v.trim())
}

function isPositiveInteger(n) {
  return Number.isInteger(n) && n > 0
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Fields a caller may patch. locationId/createdBy/createdAt/updatedBy/
// updatedAt/history are server-authoritative and deliberately excluded --
// a request containing any of them is rejected outright (accounts.js's/
// actions/[action].js's "reject unknown fields outright" convention), not
// silently stripped.
const CONTACT_PATCHABLE_FIELDS = new Set(['locationName', 'managerName', 'primaryEmail', 'ccEmails', 'active'])

// Returns a sanitized patch, or null (caller responds 400) if the patch
// contains an unrecognized/forbidden key, an invalid email, or a field with
// the wrong shape.
function validateContactPatch(patch) {
  if (!isPlainObject(patch)) return null
  for (const key of Object.keys(patch)) {
    if (!CONTACT_PATCHABLE_FIELDS.has(key)) return null
  }
  if ('locationName' in patch && (typeof patch.locationName !== 'string' || !patch.locationName.trim())) return null
  if ('managerName' in patch && patch.managerName !== null && typeof patch.managerName !== 'string') return null
  if ('primaryEmail' in patch && !isValidEmail(patch.primaryEmail)) return null
  if ('ccEmails' in patch) {
    if (!Array.isArray(patch.ccEmails)) return null
    for (const email of patch.ccEmails) {
      if (!isValidEmail(email)) return null
    }
  }
  if ('active' in patch && typeof patch.active !== 'boolean') return null
  return patch
}

// GET /api/settings/contacts
// Returns { contacts: { [locationId]: record } }. Owner/Marketing see every
// location; location_manager sees only the location(s) in their own
// locationIds grant (never all 21) -- read_only is rejected outright, since
// Restaurant Contacts is not part of its read-only surface per the
// approved Phase 8 role matrix.
async function listContacts(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return

  if (!roleHasPermission(account.role, Permission.CONTACTS_VIEW)) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to view restaurant contacts.' })
  }

  try {
    const all = await getAllContacts()
    const scoped = account.locationIds === '*'
      ? all
      : Object.fromEntries(
          Object.entries(all).filter(([locationId]) => account.locationIds.includes(Number(locationId)))
        )
    return res.status(200).json({ contacts: scoped })
  } catch (err) {
    if (err instanceof ContactStoreUnavailableError) {
      console.error(`[settings/contacts] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Restaurant contacts are temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// POST /api/settings/contacts-upsert  { locationId, patch, logAction? }
// Returns { record, warnings } -- warnings is a non-blocking array (e.g. a
// duplicate primary email across locations), never a hard failure, per the
// spec's "validate format, warn on duplicates" wording.
async function upsertContactAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  // requireScopedAuth resolves the location BEFORE any body validation, so
  // an unauthenticated/unauthorized/out-of-scope caller never learns
  // whether their payload was well-formed (auth-before-validation, matching
  // every other endpoint in this codebase).
  const scope = await requireScopedAuth(req, res, {
    permission: Permission.CONTACTS_MANAGE,
    resolveLocationId: async (req) => Number(req.body?.locationId),
  })
  if (!scope) return
  const { account, locationId } = scope

  if (!isPositiveInteger(locationId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'locationId must be a positive integer.' })
  }

  const allowed = await enforceRateLimit(req, res, `settings:contacts-upsert:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const { patch, logAction } = req.body ?? {}
  if (logAction !== undefined && typeof logAction !== 'string') {
    return res.status(400).json({ error: 'invalid_request', message: 'logAction must be a string when provided.' })
  }
  const sanitized = validateContactPatch(patch ?? {})
  if (sanitized === null) {
    return res.status(400).json({ error: 'invalid_request', message: 'patch contains an unrecognized or invalid field, or a malformed email address.' })
  }

  try {
    const existing = await getContact(locationId)
    const isNew = !existing
    const record = await upsertContact(locationId, sanitized, account, logAction ?? (isNew ? 'Contact created' : 'Contact updated'))

    const warnings = []
    if (sanitized.primaryEmail) {
      const all = await getAllContacts()
      const dupe = Object.values(all).find(c =>
        c.locationId !== locationId && c.primaryEmail?.toLowerCase() === sanitized.primaryEmail.toLowerCase()
      )
      if (dupe) {
        warnings.push(`${sanitized.primaryEmail} is already the primary contact for ${dupe.locationName || 'another location'}.`)
      }
    }

    await appendAuditEntry({
      ...actorFields(account, req),
      entity: 'contact',
      entityId: String(locationId),
      action: isNew ? 'contact.created' : 'contact.updated',
      changes: Object.keys(sanitized).map(field => ({ field, oldValue: existing?.[field] ?? null, newValue: sanitized[field] })),
      result: 'success',
      message: `${isNew ? 'Created' : 'Updated'} contact for ${record.locationName || `location ${locationId}`}${warnings.length ? ' (with a duplicate-email warning)' : ''}.`,
    })

    return res.status(200).json({ record, warnings })
  } catch (err) {
    if (err instanceof ContactStoreUnavailableError) {
      console.error(`[settings/contacts-upsert] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Restaurant contacts are temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// POST /api/settings/contacts-delete  { locationId }
// Genuine removal -- distinct from contacts-toggle-active, which preserves
// the record and its history.
async function deleteContactAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const scope = await requireScopedAuth(req, res, {
    permission: Permission.CONTACTS_MANAGE,
    resolveLocationId: async (req) => Number(req.body?.locationId),
  })
  if (!scope) return
  const { account, locationId } = scope

  if (!isPositiveInteger(locationId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'locationId must be a positive integer.' })
  }

  const allowed = await enforceRateLimit(req, res, `settings:contacts-delete:${account.userId}`, { requestsPerWindow: 20, windowSeconds: 60 })
  if (!allowed) return

  try {
    const existing = await getContact(locationId)
    const removed = await deleteContact(locationId)
    if (removed) {
      await appendAuditEntry({
        ...actorFields(account, req),
        entity: 'contact',
        entityId: String(locationId),
        action: 'contact.deleted',
        changes: null,
        result: 'success',
        message: `Deleted contact for ${existing?.locationName || `location ${locationId}`}.`,
      })
    }
    return res.status(200).json({ removed })
  } catch (err) {
    if (err instanceof ContactStoreUnavailableError) {
      console.error(`[settings/contacts-delete] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Restaurant contacts are temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// POST /api/settings/contacts-toggle-active  { locationId, active }
async function toggleContactActiveAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const scope = await requireScopedAuth(req, res, {
    permission: Permission.CONTACTS_MANAGE,
    resolveLocationId: async (req) => Number(req.body?.locationId),
  })
  if (!scope) return
  const { account, locationId } = scope

  if (!isPositiveInteger(locationId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'locationId must be a positive integer.' })
  }
  if (typeof req.body?.active !== 'boolean') {
    return res.status(400).json({ error: 'invalid_request', message: 'active must be a boolean.' })
  }

  const allowed = await enforceRateLimit(req, res, `settings:contacts-toggle-active:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  try {
    const existing = await getContact(locationId)
    if (!existing) {
      return res.status(404).json({ error: 'not_found', message: 'No contact is configured for this location yet.' })
    }
    const active = req.body.active
    const record = await upsertContact(locationId, { active }, account, active ? 'Contact enabled' : 'Contact disabled')

    await appendAuditEntry({
      ...actorFields(account, req),
      entity: 'contact',
      entityId: String(locationId),
      action: active ? 'contact.enabled' : 'contact.disabled',
      changes: [{ field: 'active', oldValue: existing.active, newValue: active }],
      result: 'success',
      message: `${active ? 'Enabled' : 'Disabled'} contact for ${record.locationName || `location ${locationId}`}.`,
    })

    return res.status(200).json({ record })
  } catch (err) {
    if (err instanceof ContactStoreUnavailableError) {
      console.error(`[settings/contacts-toggle-active] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Restaurant contacts are temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// POST /api/settings/contacts-backfill-from-legacy (Phase 8, Milestone 8.5)
// Owner-only, idempotent, one-off admin action: seeds contactStore.js
// (Redis) from the legacy private-data/location-contacts.json for any
// location_id NOT already present in Redis -- once anything has been
// edited through Settings -> Restaurant Contacts, Redis always wins;
// this never overwrites an existing Redis record. Location names are
// resolved from meta.json (the legacy file only carries email/name).
// Safe to call more than once -- re-running it after further legacy edits
// only fills in whatever is still missing from Redis.
async function backfillContactsFromLegacyAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, ['owner'])
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `settings:contacts-backfill:${account.userId}`, { requestsPerWindow: 5, windowSeconds: 60 })
  if (!allowed) return

  let legacy = legacyContactsOverride
  if (legacy === null) {
    try {
      legacy = JSON.parse(await readFile(LEGACY_CONTACTS_PATH, 'utf-8'))
    } catch {
      legacy = {}
    }
  }
  let meta = metaOverride
  if (meta === null) {
    try {
      meta = JSON.parse(await readFile(META_PATH, 'utf-8'))
    } catch {
      meta = { locations: [] }
    }
  }
  const nameById = new Map((meta.locations ?? []).map(l => [String(l.locationId), l.name]))

  const seeded = []
  const skipped = []
  try {
    for (const [locationIdStr, entry] of Object.entries(legacy)) {
      const locationId = Number(locationIdStr)
      if (!isPositiveInteger(locationId) || !isValidEmail(entry?.email)) continue

      const existing = await getContact(locationId)
      if (existing) {
        skipped.push(locationId) // Redis already has this location -- never overwrite
        continue
      }

      await upsertContact(locationId, {
        locationName: nameById.get(locationIdStr) ?? null,
        managerName: entry.name ?? null,
        primaryEmail: entry.email,
        ccEmails: [],
        active: true,
      }, account, 'Backfilled from legacy export')
      seeded.push(locationId)
    }
    if (seeded.length > 0) {
      await appendAuditEntry({
        ...actorFields(account, req),
        entity: 'contact',
        entityId: null,
        action: 'contacts.backfilled',
        changes: null,
        result: 'success',
        message: `Backfilled ${seeded.length} contact(s) from the legacy export (${skipped.length} already configured, skipped).`,
      })
    }
    return res.status(200).json({ seeded, skipped })
  } catch (err) {
    if (err instanceof ContactStoreUnavailableError) {
      console.error(`[settings/contacts-backfill-from-legacy] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Restaurant contacts are temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// GET /api/settings/audit-log?entity=&actorId=&from=&to=&result=&limit=&offset=
// Owner-only, per the approved Phase 8 role matrix -- the global,
// cross-entity audit trail is a company-wide compliance surface, distinct
// from each contact's own embedded history (visible to owner/marketing,
// and to location_manager for their own location).
async function auditLogAction(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, ['owner'])
  if (!account) return

  const allowed = await enforceRateLimit(req, res, `settings:audit-log:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const { entity, actorId, from, to, result } = req.query ?? {}
  const limitRaw = Number(req.query?.limit)
  const offsetRaw = Number(req.query?.offset)
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0

  try {
    const { entries, total } = await listAuditEntries({ entity, actorId, from, to, result, limit, offset })
    return res.status(200).json({ entries, total })
  } catch (err) {
    if (err instanceof AuditLogUnavailableError) {
      console.error(`[settings/audit-log] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The audit log is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// GET /api/settings/email-status (Phase 8, Milestone 8.9)
// Owner/Marketing only. A read-only summary over emailSender.js's own
// configuration check plus the audit log's `entity: 'email'` entries --
// never a live SMTP connection probe on a page load (see hasSmtpConfig()'s
// own header comment: a real login attempt only happens on an actual send).
// "Pending Queue" is reported explicitly as a direct-delivery model, not a
// fabricated queue depth -- emailSender.js's documented architecture is
// synchronous send-or-fail, never a queue.
async function emailStatusAction(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  const account = await requireAuth(req, res, null)
  if (!account) return

  if (!roleHasPermission(account.role, Permission.EMAIL_VIEW)) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not have permission to view the email system status.' })
  }

  const allowed = await enforceRateLimit(req, res, `settings:email-status:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const configured = hasSmtpConfig()
  let lastSuccess = null
  let lastFailure = null
  let recentErrors = []
  let auditDegraded = false

  try {
    const { entries } = await listAuditEntries({ entity: 'email', limit: 200, offset: 0 })
    lastSuccess = entries.find(e => e.result === 'success') ?? null
    lastFailure = entries.find(e => e.result === 'failure') ?? null
    recentErrors = entries.filter(e => e.result === 'failure').slice(0, 5)
      .map(e => ({ at: e.at, entityId: e.entityId ?? null, message: e.message ?? null }))
  } catch (err) {
    if (err instanceof AuditLogUnavailableError) {
      console.error(`[settings/email-status] ${err.message}`)
      auditDegraded = true
    } else {
      throw err
    }
  }

  return res.status(200).json({
    configured,
    host: process.env.SMTP_HOST ?? null,
    port: Number(process.env.SMTP_PORT) || 587,
    authenticated: configured,
    lastSuccessAt: lastSuccess?.at ?? null,
    lastFailureAt: lastFailure?.at ?? null,
    lastFailureMessage: lastFailure?.message ?? null,
    recentErrors,
    auditDegraded,
    queueModel: 'direct-synchronous',
    queueMessage: 'Direct delivery — no queue. Every send resolves immediately as sent or failed.',
  })
}

// POST /api/settings/contacts-send-test-email  { locationId }
// Owner/Marketing only (CONTACTS_MANAGE, same gate as the other contacts-*
// writes) -- a connectivity/configuration check, not a real customer-facing
// message, so it reuses sendReviewEmail() unchanged with testEmailTemplate.js's
// review-agnostic content. Records the outcome to BOTH the contact's own
// embedded history (contactStore.js) and the global audit log, mirroring
// actions/[action].js's sendReviewEmailAction -- truthful success/failure,
// never a queued/unknown state.
async function sendTestEmailAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const scope = await requireScopedAuth(req, res, {
    permission: Permission.CONTACTS_MANAGE,
    resolveLocationId: async (req) => Number(req.body?.locationId),
  })
  if (!scope) return
  const { account, locationId } = scope

  if (!isPositiveInteger(locationId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'locationId must be a positive integer.' })
  }

  const allowed = await enforceRateLimit(req, res, `settings:contacts-send-test-email:${account.userId}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  let contact
  try {
    contact = await getContact(locationId)
  } catch (err) {
    if (err instanceof ContactStoreUnavailableError) {
      console.error(`[settings/contacts-send-test-email] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Restaurant contacts are temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
  if (!contact || !contact.primaryEmail) {
    return res.status(400).json({ error: 'no_contact_configured', message: 'This location has no configured restaurant contact email yet.' })
  }

  const sentAt = new Date().toISOString()
  const sentByName = account.displayName ?? account.email
  const locationName = contact.locationName || `location ${locationId}`
  const subject = buildTestEmailSubject({ locationName })
  const { html, text } = buildTestEmail({ locationName, sentByName, sentAt })

  try {
    const { response } = await sendReviewEmail({ to: contact.primaryEmail, cc: contact.ccEmails, replyTo: undefined, subject, html, text })

    await Promise.all([
      upsertContact(locationId, {}, account, 'Test email sent'),
      appendAuditEntry({
        ...actorFields(account, req),
        entity: 'email',
        entityId: String(locationId),
        action: 'email.test_sent',
        changes: null,
        result: 'success',
        message: `Test email sent to ${contact.primaryEmail} for ${locationName}.`,
      }),
    ])

    return res.status(200).json({ sentTo: contact.primaryEmail, response: response ?? null })
  } catch (err) {
    if (err instanceof EmailSenderUnavailableError) {
      console.error(`[settings/contacts-send-test-email] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Email sending is not configured. Please contact an administrator.' })
    }

    const sanitized = sanitizeErrorMessage(err.message)
    console.error(`[settings/contacts-send-test-email] send failed: ${sanitized}`)

    try {
      await Promise.all([
        upsertContact(locationId, {}, account, 'Test email failed'),
        appendAuditEntry({
          ...actorFields(account, req),
          entity: 'email',
          entityId: String(locationId),
          action: 'email.test_failed',
          changes: null,
          result: 'failure',
          message: `Test email to ${contact.primaryEmail} for ${locationName} failed: ${sanitized}`,
        }),
      ])
    } catch (recordErr) {
      if (!(recordErr instanceof ContactStoreUnavailableError)) throw recordErr
      console.error(`[settings/contacts-send-test-email] ${recordErr.message}`)
    }

    return res.status(502).json({ error: 'send_failed', message: 'The test email could not be sent.', detail: sanitized })
  }
}

export default async function handler(req, res) {
  switch (req.query?.action) {
    case 'contacts':                       return listContacts(req, res)
    case 'contacts-upsert':                 return upsertContactAction(req, res)
    case 'contacts-delete':                 return deleteContactAction(req, res)
    case 'contacts-toggle-active':          return toggleContactActiveAction(req, res)
    case 'contacts-backfill-from-legacy':   return backfillContactsFromLegacyAction(req, res)
    case 'contacts-send-test-email':        return sendTestEmailAction(req, res)
    case 'audit-log':                       return auditLogAction(req, res)
    case 'email-status':                    return emailStatusAction(req, res)
    default:                                return res.status(404).json({ error: 'not_found' })
  }
}
