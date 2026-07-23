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

import { requireAuth, requireScopedAuth } from '../_lib/auth.js'
import { roleHasPermission, Permission } from '../_lib/permissions.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import {
  getAllContacts, getContact, upsertContact, deleteContact, ContactStoreUnavailableError,
} from '../_lib/contactStore.js'

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
    const record = await upsertContact(locationId, sanitized, account, logAction ?? (existing ? 'Contact updated' : 'Contact created'))

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
    const removed = await deleteContact(locationId)
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
    return res.status(200).json({ record })
  } catch (err) {
    if (err instanceof ContactStoreUnavailableError) {
      console.error(`[settings/contacts-toggle-active] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Restaurant contacts are temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

export default async function handler(req, res) {
  switch (req.query?.action) {
    case 'contacts':                return listContacts(req, res)
    case 'contacts-upsert':          return upsertContactAction(req, res)
    case 'contacts-delete':          return deleteContactAction(req, res)
    case 'contacts-toggle-active':   return toggleContactActiveAction(req, res)
    default:                         return res.status(404).json({ error: 'not_found' })
  }
}
