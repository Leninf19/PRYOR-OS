// Single serverless function handling both Action Center workspace
// endpoints -- consolidated into one dynamic-route file for the same
// reason dashboard/api/session/[action].js is: staying under the Vercel
// Hobby plan's 12-serverless-function-per-deployment limit. Vercel/Node
// populates req.query.action from the URL segment, so the external routes
// are GET /api/actions/list and POST /api/actions/update.
//
// This is the collaborative-state tier, not the analytics pipeline: it
// reads/writes Redis via _lib/actionStore.js only. It never touches
// reviews.db, analytics_cache, or anything export_chunks.py/
// refresh_analytics.py produce.
//
// Multi-Location Authentication & User Access System, Commit 4: the
// "location_manager accounts aren't safe to grant this yet" gap this
// comment used to describe is closed -- reviewLocationIndex.js now resolves
// a review action's owning location server-side. `list` is readable by any
// authenticated role (VIEW_ALL/VIEW_ASSIGNED, i.e. every role), filtered by
// location for a scoped account; `update` and the restaurant-email actions
// are gated by REPLY/REPLY_ASSIGNED (the same permission pair publish()
// uses) plus per-item location scope.
//
// actionStore.js's `id` is always the review's own reviewId() value (review_id
// || review_url || `${review_date}-${reviewer_name}`) -- the exact same
// identity space reviewLocationIndex.js is keyed by (see
// dashboard/src/hooks/usePriorityDigest.js's own reliance on this), so
// resolving an action's location is the same lookup publish() uses.

import { requireAuth, requireScopedAuth, requireLocationAccess } from '../_lib/auth.js'
import { Permission, roleHasPermission } from '../_lib/permissions.js'
import { resolveLocationIdForReview, resolveLocationIdForReviewOrDeny } from '../_lib/reviewLocationIndex.js'
import { enforceRateLimit } from '../_lib/rateLimit.js'
import { getAllActions, getAction, upsertAction, ActionStoreUnavailableError } from '../_lib/actionStore.js'
import { getLocationContact } from '../_lib/locationContacts.js'
import { getEscalationCcEmails, getReplyToEmail } from '../_lib/reviewEmailConfig.js'
import { sendReviewEmail, EmailSenderUnavailableError } from '../_lib/emailSender.js'
import { buildDefaultSubject, buildReviewEmail } from '../_lib/reviewEmailTemplate.js'

const REPLY_PERMISSIONS = [Permission.REPLY, Permission.REPLY_ASSIGNED]

// Mirrors ActionCenter.jsx's STATUSES exactly (dashboard/src/pages/ActionCenter.jsx).
// Intentionally duplicated rather than shared across the frontend/backend
// boundary -- same tradeoff db.py's BRANDS/dataUtils.js's BRANDS already make.
const VALID_STATUSES = new Set(['New', 'Assigned', 'In Progress', 'Completed', 'Monitoring', 'Dismissed'])

// Fields a caller may patch. id/createdBy/createdAt/updatedBy/updatedAt/history
// are server-authoritative and deliberately excluded -- a request containing
// any of them is rejected outright (accounts.js's "reject unknown fields
// outright" convention), not silently stripped.
const PATCHABLE_FIELDS = new Set([
  'status', 'assignedTo', 'assignedLocation', 'assignedDepartment',
  'dueDate', 'notes', 'outcomeSnapshot',
])

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Returns a sanitized patch, or null (caller responds 400) if the patch
// contains an unrecognized/forbidden key or a field with the wrong shape.
function validatePatch(patch) {
  if (!isPlainObject(patch)) return null
  for (const key of Object.keys(patch)) {
    if (!PATCHABLE_FIELDS.has(key)) return null
  }
  if ('status' in patch && !VALID_STATUSES.has(patch.status)) return null
  if ('dueDate' in patch && patch.dueDate !== null && typeof patch.dueDate !== 'string') return null
  if ('notes' in patch && typeof patch.notes !== 'string') return null
  if ('assignedTo' in patch && patch.assignedTo !== null && typeof patch.assignedTo !== 'string') return null
  if ('assignedLocation' in patch && patch.assignedLocation !== null && typeof patch.assignedLocation !== 'string') return null
  if ('assignedDepartment' in patch && patch.assignedDepartment !== null && typeof patch.assignedDepartment !== 'string') return null
  if ('logAction' in patch) return null // logAction is a sibling request field, never a patch field
  return patch
}

// ---------------------------------------------------------------------------
// Restaurant bad-review email workflow (recovery-audit milestone,
// Phases 5-6). Adds three actions to this same file/function:
//   GET  /api/actions/preview-review-email  -- resolve recipient/CC/status
//   POST /api/actions/send-review-email     -- send + record the outcome
//   POST /api/actions/update-email-status   -- manual replied/follow_up/resolved
//
// email* / source* fields are NEVER reachable through the generic
// update() action above -- PATCHABLE_FIELDS doesn't list them, and
// validatePatch() rejects any unrecognized key outright. Only the two
// handlers below can ever write them, and both construct the patch
// entirely server-side (never from a client-supplied field-by-field
// patch object) -- this is what keeps "emailStatus: sent" a trustworthy
// claim: it can only be set at the moment sendReviewEmail() actually
// succeeds, and "replied"/"follow_up_required"/"resolved" can only be
// reached from an email that was actually sent (see updateEmailStatus).
// ---------------------------------------------------------------------------

// 'queued' is part of the schema (Phase 6) for forward-compatibility with a
// future async delivery path, but this milestone's direct-delivery
// architecture (see emailSender.js's header comment) never produces it --
// every send resolves to 'sent' or 'failed' immediately, never leaves a
// request in an unknown state.
//
// States a human sets by hand, only ever on an item that already has an
// outgoing email -- never reachable before a send, never a way to fake
// "sent" without actually sending.
const MANUAL_EMAIL_STATUSES = new Set(['replied', 'follow_up_required', 'resolved'])
// Prior states a manual transition may start from -- 'sent' (the normal
// case) plus any manual state already reached (replied -> resolved, etc).
// Deliberately excludes 'not_sent' and 'failed'.
const TRANSITIONABLE_EMAIL_STATUSES = new Set(['sent', 'replied', 'follow_up_required', 'resolved'])

const MANUAL_EMAIL_STATUS_HISTORY_LABEL = {
  replied: 'Restaurant response recorded',
  follow_up_required: 'Follow-up required',
  resolved: 'Email workflow resolved',
}

function isPositiveInteger(n) {
  return Number.isInteger(n) && n > 0
}

// Strips CR/LF so a subject (the one email-adjacent field this action
// accepts from the client) can never inject extra headers -- defense in
// depth on top of nodemailer's own header sanitization.
function sanitizeHeaderValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

// SMTP/provider error text could in principle echo back configuration
// details -- strip the configured SMTP credentials defensively (belt and
// suspenders; nodemailer/mail providers don't echo the password in error
// text today) and cap length so a verbose provider error (a full
// Microsoft 365 authentication failure can be quite verbose) can't balloon
// the stored record or the response body. This is the "sanitized
// server-side diagnostic" -- the caller still returns a generic top-level
// message to the response; only this sanitized (never raw) string reaches
// the Action Center record's emailLastError field for an authenticated
// owner/marketing viewer, never the public.
function sanitizeErrorMessage(message) {
  let out = String(message ?? 'unknown error')
  if (process.env.SMTP_PASSWORD) out = out.split(process.env.SMTP_PASSWORD).join('[redacted]')
  if (process.env.SMTP_USER) out = out.split(process.env.SMTP_USER).join('[redacted]')
  if (process.env.MICROSOFT_CLIENT_SECRET) out = out.split(process.env.MICROSOFT_CLIENT_SECRET).join('[redacted]')
  return out.slice(0, 300)
}

function buildInternalReferenceUrl(reviewId) {
  const base = process.env.DASHBOARD_BASE_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  if (!base) return null
  return `${base.replace(/\/$/, '')}/explorer?reviewId=${encodeURIComponent(reviewId)}`
}

// Validates the client-supplied review-content snapshot used to render the
// email. This content necessarily comes from the client -- the Vercel/Node
// layer has no reviews.db access of its own (see README "Architecture
// overview") -- but it is pure display content, never a recipient/
// authorization decision, which is what stays strictly server-resolved.
function validateReviewSnapshot(review) {
  if (typeof review !== 'object' || review === null) return null
  const { locationName, city, starRating, reviewerName, reviewDate, reviewText, reviewUrl } = review
  if (typeof locationName !== 'string' || !locationName.trim()) return null
  if (!Number.isInteger(starRating) || starRating < 1 || starRating > 5) return null
  for (const [key, val] of Object.entries({ city, reviewerName, reviewDate, reviewText, reviewUrl })) {
    if (val !== undefined && val !== null && typeof val !== 'string') return null
  }
  return {
    locationName: locationName.trim(),
    city: city ?? null,
    starRating,
    reviewerName: reviewerName ?? null,
    reviewDate: reviewDate ?? null,
    reviewText: reviewText ?? null,
    reviewUrl: reviewUrl ?? null,
  }
}

// GET /api/actions/preview-review-email?id=...&locationId=...
// Resolves and returns the recipient/CC/Reply-To the send action WOULD use
// (read-only) plus the item's current email-workflow state, so the
// confirmation panel can show a truthful, server-resolved preview before
// the user commits to sending. Never returns the whole contact directory
// -- only the one location being acted on.
async function previewReviewEmail(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  const scope = await requireScopedAuth(req, res, {
    permission: REPLY_PERMISSIONS,
    resolveLocationId: async (req) => Number(req.query?.locationId),
  })
  if (!scope) return
  const { account } = scope

  const { id, locationId: locationIdRaw } = req.query ?? {}
  const locationId = Number(locationIdRaw)
  if (typeof id !== 'string' || !id.trim() || !isPositiveInteger(locationId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'id and a positive integer locationId are required.' })
  }

  // Management visibility (Martin/Ruffy) on every restaurant escalation is
  // a business requirement, not a nicety -- an empty CC list means the
  // whole feature is unusable right now, not "send anyway with no CC".
  // Checked here too (not just in the send action) so the confirmation
  // panel shows this failure before the user ever reaches Send.
  const cc = getEscalationCcEmails()
  if (cc.length === 0) {
    console.error('[actions/preview-review-email] REVIEW_ESCALATION_CC_EMAILS is not configured')
    return res.status(503).json({ error: 'service_unavailable', message: 'Review escalation recipients are not configured.' })
  }

  try {
    const [contact, existing] = await Promise.all([getLocationContact(locationId), getAction(id)])
    return res.status(200).json({
      recipient: contact ? { email: contact.email, name: contact.name ?? null } : null,
      cc,
      replyTo: getReplyToEmail(),
      existingRecord: existing ? {
        emailStatus: existing.emailStatus ?? 'not_sent',
        emailSentAt: existing.emailSentAt ?? null,
        emailSentBy: existing.emailSentBy ?? null,
        emailRecipient: existing.emailRecipient ?? null,
        emailFollowUpDueAt: existing.emailFollowUpDueAt ?? null,
      } : null,
    })
  } catch (err) {
    if (err instanceof ActionStoreUnavailableError) {
      console.error(`[actions/preview-review-email] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The task workspace is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// POST /api/actions/send-review-email
// { id, locationId, review, subject?, internalNote?, followUpDueAt?, confirmResend? }
async function sendReviewEmailAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const scope = await requireScopedAuth(req, res, {
    permission: REPLY_PERMISSIONS,
    resolveLocationId: async (req) => Number(req.body?.locationId),
  })
  if (!scope) return
  const { account } = scope

  const allowed = await enforceRateLimit(req, res, `actions:send-review-email:${account.userId}`, { requestsPerWindow: 10, windowSeconds: 60 })
  if (!allowed) return

  const {
    id, locationId: locationIdRaw, review, subject: subjectRaw,
    internalNote, followUpDueAt, confirmResend,
  } = req.body ?? {}

  const locationId = Number(locationIdRaw)
  if (typeof id !== 'string' || !id.trim() || !isPositiveInteger(locationId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'id and a positive integer locationId are required.' })
  }
  const reviewSnapshot = validateReviewSnapshot(review)
  if (!reviewSnapshot) {
    return res.status(400).json({ error: 'invalid_request', message: 'review must include at least locationName and a 1-5 starRating.' })
  }
  if (subjectRaw !== undefined && (typeof subjectRaw !== 'string' || !subjectRaw.trim() || subjectRaw.length > 300)) {
    return res.status(400).json({ error: 'invalid_request', message: 'subject must be a non-empty string under 300 characters.' })
  }
  if (internalNote !== undefined && internalNote !== null && (typeof internalNote !== 'string' || internalNote.length > 2000)) {
    return res.status(400).json({ error: 'invalid_request', message: 'internalNote must be a string under 2000 characters.' })
  }
  if (followUpDueAt !== undefined && followUpDueAt !== null && typeof followUpDueAt !== 'string') {
    return res.status(400).json({ error: 'invalid_request', message: 'followUpDueAt must be a string date or null.' })
  }

  // Management visibility (Martin/Ruffy) on every restaurant escalation is
  // a business requirement -- refuse to send with no CC rather than
  // silently omitting them. Checked before any Redis/contact lookup since
  // it's a pure config check.
  const cc = getEscalationCcEmails()
  if (cc.length === 0) {
    console.error('[actions/send-review-email] REVIEW_ESCALATION_CC_EMAILS is not configured -- refusing to send without management visibility')
    return res.status(503).json({ error: 'service_unavailable', message: 'Review escalation recipients are not configured.' })
  }

  let contact, existing
  try {
    ;[contact, existing] = await Promise.all([getLocationContact(locationId), getAction(id)])
  } catch (err) {
    if (err instanceof ActionStoreUnavailableError) {
      console.error(`[actions/send-review-email] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The task workspace is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }

  // Recipient is ALWAYS resolved server-side from locationId -- the
  // request body has no recipient/cc field for this action to ever read.
  if (!contact) {
    return res.status(400).json({ error: 'no_contact_configured', message: 'This location has no configured restaurant contact email yet.' })
  }

  // Duplicate-send protection: an item already sent/replied/awaiting
  // follow-up/resolved requires an explicit confirmResend to proceed.
  // A previously FAILED send is exempt -- it never actually reached the
  // restaurant, so retrying it is not a duplicate.
  const DUPLICATE_STATUSES = new Set(['sent', 'replied', 'follow_up_required', 'resolved'])
  if (existing && DUPLICATE_STATUSES.has(existing.emailStatus) && !confirmResend) {
    return res.status(409).json({ error: 'already_sent', message: 'This review already has an email sent to the restaurant. Resend to send it again.', record: existing })
  }

  const replyTo = getReplyToEmail()
  const subject = sanitizeHeaderValue(subjectRaw || buildDefaultSubject({ locationName: reviewSnapshot.locationName, starRating: reviewSnapshot.starRating }))
  const internalReferenceUrl = buildInternalReferenceUrl(id)
  const { html, text } = buildReviewEmail({
    review: reviewSnapshot,
    internalReferenceUrl,
    internalNote: internalNote || null,
    replyToEmail: replyTo,
  })

  const basePatch = {
    emailRecipient: contact.email,
    emailCcRecipients: cc,
    emailSubject: subject,
    emailFollowUpDueAt: followUpDueAt ?? null,
    sourceReviewId: id,
    sourceReviewUrl: reviewSnapshot.reviewUrl,
    sourceLocationId: locationId,
  }

  const logLabel = confirmResend ? 'Review email re-sent to restaurant' : 'Review email sent to restaurant'

  try {
    const { messageId } = await sendReviewEmail({ to: contact.email, cc, replyTo, subject, html, text })
    const record = await upsertAction(id, {
      ...basePatch,
      emailStatus: 'sent',
      emailSentAt: new Date().toISOString(),
      emailSentBy: account.userId,
      emailMessageId: messageId,
      emailLastError: null,
    }, account, logLabel)
    return res.status(200).json({ record })
  } catch (err) {
    if (err instanceof EmailSenderUnavailableError) {
      console.error(`[actions/send-review-email] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'Email sending is not configured. Please contact an administrator.' })
    }
    // A genuine send failure -- record it truthfully as failed, never as sent.
    const sanitized = sanitizeErrorMessage(err.message)
    console.error(`[actions/send-review-email] send failed: ${sanitized}`)
    let record
    try {
      record = await upsertAction(id, { ...basePatch, emailStatus: 'failed', emailLastError: sanitized }, account, 'Send failed')
    } catch (storeErr) {
      if (storeErr instanceof ActionStoreUnavailableError) {
        return res.status(503).json({ error: 'service_unavailable', message: 'The email failed to send, and the task workspace is also unavailable to record it. Please try again shortly.' })
      }
      throw storeErr
    }
    return res.status(502).json({ error: 'send_failed', message: 'The email could not be sent. See the record for details.', record })
  }
}

// POST /api/actions/update-email-status  { id, emailStatus }
// Manual transitions only -- replied/follow_up_required/resolved -- never
// reachable before an item has an outgoing email at all.
async function updateEmailStatus(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  // No explicit locationId in this action's payload (unlike preview/send-
  // review-email) -- resolved from `id` (the review) via reviewLocationIndex.js,
  // same as update() below.
  const scope = await requireScopedAuth(req, res, {
    permission: REPLY_PERMISSIONS,
    resolveLocationId: async (req, account) => resolveLocationIdForReviewOrDeny(req.body?.id, account),
  })
  if (!scope) return
  const { account } = scope

  const allowed = await enforceRateLimit(req, res, `actions:update-email-status:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const { id, emailStatus } = req.body ?? {}
  if (typeof id !== 'string' || !id.trim()) {
    return res.status(400).json({ error: 'invalid_request', message: 'id is required.' })
  }
  if (!MANUAL_EMAIL_STATUSES.has(emailStatus)) {
    return res.status(400).json({ error: 'invalid_request', message: `emailStatus must be one of: ${[...MANUAL_EMAIL_STATUSES].join(', ')}.` })
  }

  try {
    const existing = await getAction(id)
    // A manual transition is only valid from a genuinely-sent email
    // (including one already in a manual state, so replied -> resolved
    // etc. is allowed) -- 'not_sent' (nothing sent yet) and 'failed' (never
    // reached the restaurant) are both excluded, since "replied" or
    // "resolved" would be a lie if the email never actually arrived.
    if (!existing || !TRANSITIONABLE_EMAIL_STATUSES.has(existing.emailStatus)) {
      return res.status(400).json({ error: 'invalid_request', message: 'This item has no successfully-sent outgoing email to update the status of yet.' })
    }
    const record = await upsertAction(id, { emailStatus }, account, MANUAL_EMAIL_STATUS_HISTORY_LABEL[emailStatus])
    return res.status(200).json({ record })
  } catch (err) {
    if (err instanceof ActionStoreUnavailableError) {
      console.error(`[actions/update-email-status] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The task workspace is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// GET /api/actions/list -- returns every task record, keyed by action id.
// No rate limit, matching dashboard/api/data.js's read endpoint precedent
// (auth is the only gate on a read).
async function list(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })

  // Any authenticated role may read (every role holds at least
  // VIEW_ASSIGNED) -- a location-scoped account is filtered to its own
  // location's items below, never the flat role gate this used to be.
  const account = await requireAuth(req, res, null)
  if (!account) return

  try {
    const all = await getAllActions()
    if (account.locationIds === '*') {
      return res.status(200).json({ actions: all })
    }
    const scoped = {}
    for (const [id, record] of Object.entries(all)) {
      const locationId = await resolveLocationIdForReview(id)
      if (locationId !== null && requireLocationAccess(account, locationId)) {
        scoped[id] = record
      }
    }
    return res.status(200).json({ actions: scoped })
  } catch (err) {
    if (err instanceof ActionStoreUnavailableError) {
      console.error(`[actions/list] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The task workspace is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

// POST /api/actions/update  { id, patch, logAction? }
// Returns { record } -- the full merged record after the write, so the
// caller's optimistic-update cache can reconcile with the server's version
// (server-stamped updatedAt/updatedBy/history) in one round trip.
async function update(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })

  const scope = await requireScopedAuth(req, res, {
    permission: REPLY_PERMISSIONS,
    resolveLocationId: async (req, account) => resolveLocationIdForReviewOrDeny(req.body?.id, account),
  })
  if (!scope) return
  const { account } = scope

  const allowed = await enforceRateLimit(req, res, `actions:update:${account.userId}`, { requestsPerWindow: 30, windowSeconds: 60 })
  if (!allowed) return

  const { id, patch, logAction } = req.body ?? {}
  if (typeof id !== 'string' || !id.trim()) {
    return res.status(400).json({ error: 'invalid_request', message: 'id is required.' })
  }
  if (logAction !== undefined && typeof logAction !== 'string') {
    return res.status(400).json({ error: 'invalid_request', message: 'logAction must be a string when provided.' })
  }
  const sanitized = validatePatch(patch ?? {})
  if (sanitized === null) {
    return res.status(400).json({ error: 'invalid_request', message: 'patch contains an unrecognized or invalid field.' })
  }

  try {
    const record = await upsertAction(id, sanitized, account, logAction)
    return res.status(200).json({ record })
  } catch (err) {
    if (err instanceof ActionStoreUnavailableError) {
      console.error(`[actions/update] ${err.message}`)
      return res.status(503).json({ error: 'service_unavailable', message: 'The task workspace is temporarily unavailable. Please try again shortly.' })
    }
    throw err
  }
}

export default async function handler(req, res) {
  switch (req.query?.action) {
    case 'list':                 return list(req, res)
    case 'update':                return update(req, res)
    case 'preview-review-email':  return previewReviewEmail(req, res)
    case 'send-review-email':     return sendReviewEmailAction(req, res)
    case 'update-email-status':   return updateEmailStatus(req, res)
    default:                      return res.status(404).json({ error: 'not_found' })
  }
}
