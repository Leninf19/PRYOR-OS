// Notification Center Audit & Fix -- GET/POST /api/notifications?action=...
//
// Consolidated into one dynamic-route file (this project's established
// convention -- see actions/[action].js, settings/[action].js -- Vercel
// Hobby's 12-serverless-function ceiling means a new top-level route per
// action is not an option; this is the 8th function).
//
//   GET  ?action=list       -> { notifications: [...], unreadCount }
//   POST ?action=mark-read  { key } -> { ok: true }
//   POST ?action=mark-all-read -> { ok: true, count }
//
// Every action starts with requireAuth(req, res, null) -- every role holds
// at least Permission.VIEW_ASSIGNED (see permissions.js), so there is no
// flat role gate here, exactly like GET /api/actions/list. The real
// decision is location scoping, and it happens entirely inside
// notificationEvents.js's getNotificationCandidates() (never re-derived
// here) -- this file trusts that module's output completely, the same
// division of labor dashboard/api/data.js has with reviewLocationIndex.js.

import { requireAuth, requireLocationAccess } from '../_lib/auth.js'
import { getNotificationCandidates } from '../_lib/notificationEvents.js'
import {
  getReadState, markRead, hasBeenSeeded, markSeeded, NotificationStoreUnavailableError,
} from '../_lib/notificationStore.js'
import { getAction } from '../_lib/actionStore.js'
import { resolveLocationIdForReview } from '../_lib/reviewLocationIndex.js'
import { resolveTenantId } from '../_lib/tenants.js'

async function list(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireAuth(req, res, null)
  if (!account) return

  res.setHeader('Cache-Control', 'private, no-store')

  const [candidates, readState, seeded] = await Promise.all([
    getNotificationCandidates(account),
    getReadState(resolveTenantId(account), account.userId),
    hasBeenSeeded(resolveTenantId(account), account.userId),
  ])

  // Rollout-backlog fix: a user's FIRST-EVER visit seeds whatever's
  // currently in scope as already-read, rather than reporting up to 30
  // days of pre-existing, already-known-about backlog as unread all at
  // once (see notificationStore.js's hasBeenSeeded/markSeeded for the full
  // rationale). Nothing is hidden -- every candidate is still returned
  // (shown under "Earlier"), and the underlying reviews/actions remain
  // fully visible/actionable through their normal pages; only the unread
  // badge treats this one-time baseline as already seen.
  if (!seeded) {
    try {
      if (candidates.length) await markRead(resolveTenantId(account), account.userId, candidates.map(c => c.key))
      await markSeeded(resolveTenantId(account), account.userId)
      return res.status(200).json({
        notifications: candidates.map(c => ({ ...c, read: true })),
        unreadCount: 0,
      })
    } catch (err) {
      // A resilient GET matters more than a perfect first impression --
      // fall through to the normal path below. Worst case: this user sees
      // today's backlog as unread once and it seeds successfully on their
      // next request once the store recovers.
      console.error(`[notifications] failed to seed backlog for ${account.userId}: ${err.message}`)
    }
  }

  const notifications = candidates.map(c => ({ ...c, read: Boolean(readState[c.key]) }))
  const unreadCount = notifications.filter(n => !n.read).length

  return res.status(200).json({ notifications, unreadCount })
}

// Parses a notification key's type prefix and validates that THIS caller
// is actually authorized to mark it read -- never trusts a client-supplied
// key at face value. Fails closed (returns false) for any unrecognized
// prefix or any resource this caller cannot resolve/own, exactly the
// "direct API tampering must fail" requirement.
async function callerMayMarkKeyRead(key, account) {
  const [type, ...rest] = key.split(':')
  const id = rest.join(':')

  if (type === 'critical_review' || type === 'low_star_review' || type === 'reply_failed') {
    if (account.locationIds === '*') return true
    const locationId = await resolveLocationIdForReview(id, resolveTenantId(account))
    return locationId !== null && requireLocationAccess(account, locationId)
  }
  if (type === 'assigned_action') {
    const action = await getAction(resolveTenantId(account), id).catch(() => null)
    return Boolean(action) && action.assignedTo === account.userId
  }
  if (type === 'gbp_disconnected') {
    return account.role === 'owner'
  }
  return false
}

async function markOneRead(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireAuth(req, res, null)
  if (!account) return

  const { key } = req.body ?? {}
  if (typeof key !== 'string' || !key) {
    return res.status(400).json({ error: 'api_error', message: 'Missing key.' })
  }

  const allowed = await callerMayMarkKeyRead(key, account)
  if (!allowed) return res.status(404).json({ error: 'not_found' })

  try {
    await markRead(resolveTenantId(account), account.userId, [key])
  } catch (err) {
    if (err instanceof NotificationStoreUnavailableError) {
      return res.status(503).json({ error: 'server_error', message: 'Could not save read state right now.' })
    }
    throw err
  }
  return res.status(200).json({ ok: true })
}

// Recomputes the caller's OWN authorized candidate list server-side and
// marks all of it read -- never accepts a client-supplied list of keys.
// This is what makes mark-all-read safe by construction: it can only ever
// touch notifications this exact caller is already authorized to see.
async function markAllRead(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' })
  const account = await requireAuth(req, res, null)
  if (!account) return

  const candidates = await getNotificationCandidates(account)
  const keys = candidates.map(c => c.key)

  try {
    await markRead(resolveTenantId(account), account.userId, keys)
  } catch (err) {
    if (err instanceof NotificationStoreUnavailableError) {
      return res.status(503).json({ error: 'server_error', message: 'Could not save read state right now.' })
    }
    throw err
  }
  return res.status(200).json({ ok: true, count: keys.length })
}

export default async function handler(req, res) {
  switch (req.query?.action) {
    case 'list':           return list(req, res)
    case 'mark-read':      return markOneRead(req, res)
    case 'mark-all-read':  return markAllRead(req, res)
    default:               return res.status(404).json({ error: 'not_found' })
  }
}
