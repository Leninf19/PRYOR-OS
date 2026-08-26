// Notification Center Audit & Fix -- builds the list of notification
// CANDIDATES for one authenticated caller. Deliberately not a new
// "notification generation" backend: every event type here is derived live
// from data that already exists (export_chunks.py's per-location review
// exports, actionStore.js's assignment records, credentialStore.js's GBP
// health), never a separately-maintained event log. This is what makes
// deduplication automatic (see each builder's own comment) and keeps this
// feature from drifting out of sync with the systems it surfaces.
//
// Server-side location authorization happens HERE, not in the frontend:
// loadAuthorizedReviews() only ever reads the location files the caller is
// actually allowed to see (mirrors dashboard/api/data.js's own per-location
// filtering), and every other builder filters its own source by the
// caller's account.locationIds before a single candidate is created. The
// API layer (dashboard/api/notifications/[action].js) never re-derives
// authorization -- it trusts this module's output completely, the same
// division of labor dashboard/api/data.js already has with
// reviewLocationIndex.js.

import { readFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { requireLocationAccess } from './auth.js'
import { getAllActions, ActionStoreUnavailableError } from './actionStore.js'
import { getStoredCredential } from './credentialStore.js'
import { listReplyFailures } from './notificationStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PRIVATE_ROOT = path.resolve(__dirname, '..', '..', 'private-data')

// Review-based notifications only ever look back this far -- see the
// milestone report for the retention rationale (30 days, matching the
// reply-failure Redis TTL). This is a pure read-time filter, not a stored
// cutoff: it always reflects "30 days before right now," never a frozen
// snapshot.
const REVIEW_NOTIFICATION_RETENTION_DAYS = 30

// Terminal Action Center statuses (Actions.jsx's own STATUSES enum) -- an
// action in one of these no longer needs the assignee's attention.
const TERMINAL_ACTION_STATUSES = new Set(['Completed', 'Dismissed'])

// Duplicated from dashboard/src/utils/dataUtils.js's reviewId() rather than
// imported -- this codebase's established boundary keeps dashboard/api/_lib
// self-contained from dashboard/src (see reviewLocationIndex.js, which
// takes the same approach for the same identity). Any change to the
// canonical formula must be mirrored here; test_notification_events.js
// asserts the two stay identical.
function reviewId(r) {
  return r.review_id || r.review_url || `${r.review_date}-${r.reviewer_name}`
}

function truncate(text, max = 100) {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function daysAgo(dateStr) {
  const t = new Date(dateStr).getTime()
  if (Number.isNaN(t)) return Infinity
  return (Date.now() - t) / 86_400_000
}

// Test-only seam, same pattern as reviewLocationIndex.js's
// _setReviewLocationIndexForTests / data.js's _setMetaLocationsForTests --
// lets tests inject meta.json + per-location review fixtures without
// touching the real filesystem. Keyed by the same relative path readJsonFile
// would otherwise resolve on disk (e.g. 'meta.json', 'reviews/by-location/casa-tequila-prime.json').
let privateDataTestOverride = null
export function _setPrivateDataForTests(filesByRelPath) { privateDataTestOverride = filesByRelPath }
export function _resetPrivateDataForTests() { privateDataTestOverride = null }

async function readJsonFile(relPath) {
  if (privateDataTestOverride !== null) {
    return Object.prototype.hasOwnProperty.call(privateDataTestOverride, relPath)
      ? privateDataTestOverride[relPath]
      : null
  }
  try {
    const raw = await readFile(path.join(PRIVATE_ROOT, relPath), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// Mirrors dashboard/api/data.js's own per-location authorization exactly:
// company-wide callers get every location's reviews; a scoped caller only
// ever gets the by-location files their own locationIds grant covers. A
// review from an unauthorized location is never even READ, let alone
// filtered client-side.
async function loadAuthorizedReviews(account) {
  const meta = await readJsonFile('meta.json')
  if (!meta?.locations) return []
  const locations = account.locationIds === '*'
    ? meta.locations
    : meta.locations.filter(l => requireLocationAccess(account, l.locationId))

  const perLocation = await Promise.all(locations.map(async loc => {
    const reviews = await readJsonFile(`reviews/by-location/${loc.slug}.json`)
    return Array.isArray(reviews) ? reviews : []
  }))
  return perLocation.flat()
}

// Critical / 1-star / 2-star reviews. A review already answered
// (owner_response non-empty) is never notification-worthy -- it no longer
// needs anyone's attention, matching this milestone's explicit "genuinely
// actionable events, not noise" requirement. A review that is BOTH
// ai_priority='critical' AND <=2 stars produces exactly one notification
// (critical_review takes priority), never two, for the same review.
//
// Deduplication is automatic, not tracked state: this function is called
// fresh on every request against the SAME source data (the exported review
// JSON), so the SAME still-unanswered critical review always produces the
// exact same stable key (`critical_review:<reviewId>`) every single time --
// there is no "run" that creates a new row, so there is nothing to
// duplicate. This is why a critical review does not generate a new
// notification every time critical-alert-check.yml's 15-minute cron ticks.
function reviewNotificationCandidates(reviews) {
  const out = []
  for (const r of reviews) {
    if ((r.owner_response || '').trim()) continue
    if (daysAgo(r.review_date) > REVIEW_NOTIFICATION_RETENTION_DAYS) continue
    const id = reviewId(r)
    if (r.ai_priority === 'critical') {
      out.push({
        key: `critical_review:${id}`, type: 'critical_review', severity: 'critical',
        title: 'New critical review', location: r.location_name,
        context: truncate(r.review_text), starRating: r.star_rating,
        timestamp: new Date(`${r.review_date}T12:00:00Z`).toISOString(),
        link: { type: 'review', id },
      })
    } else if (typeof r.star_rating === 'number' && r.star_rating <= 2) {
      out.push({
        key: `low_star_review:${id}`, type: 'low_star_review', severity: 'warning',
        title: `New ${r.star_rating}-star review`, location: r.location_name,
        context: truncate(r.review_text), starRating: r.star_rating,
        timestamp: new Date(`${r.review_date}T12:00:00Z`).toISOString(),
        link: { type: 'review', id },
      })
    }
  }
  return out
}

// Reply/publish failures -- recorded additively by google/[action].js's
// publish() on a genuine failure (never on a bridge-write hiccup after
// Google already succeeded -- that path already has its own bridgeWarning
// signal and is deliberately NOT a failure notification). Deduplicated by
// construction: recordReplyFailure() writes to a key keyed by the review's
// own id, so a second failure for the SAME review overwrites (refreshes)
// the existing record rather than creating a second one.
function replyFailureCandidates(failures, account) {
  return failures
    .filter(f => account.locationIds === '*' || requireLocationAccess(account, f.locationId))
    .map(f => ({
      key: `reply_failed:${f.reviewId}`, type: 'reply_failed', severity: 'critical',
      title: 'Reply failed to publish', location: f.locationName ?? null,
      context: f.failReason ?? 'Google did not accept the reply.',
      timestamp: f.failedAt,
      link: { type: 'review', id: f.reviewId },
    }))
}

// Actions assigned to the caller specifically. Authorization here is the
// assignment itself, not a location check: `assignedTo` must equal the
// caller's OWN userId (never another user's), which is already the
// narrowest possible scope -- a task assigned to you is about you, not
// about browsing a location's data, so assignedLocation (a free-text
// location name, not a numeric id -- see actionStore.js) is not used as an
// additional filter. An action store outage degrades this to "no assigned-
// action notifications this request," never an error for the whole feed.
async function assignedActionCandidates(account) {
  let all
  try {
    all = await getAllActions()
  } catch (err) {
    if (err instanceof ActionStoreUnavailableError) return []
    throw err
  }
  return Object.values(all)
    .filter(a => a.assignedTo === account.userId && !TERMINAL_ACTION_STATUSES.has(a.status))
    .map(a => ({
      key: `assigned_action:${a.id}`, type: 'assigned_action', severity: 'info',
      title: a.title ?? 'Action assigned to you', location: a.assignedLocation ?? null,
      context: truncate(a.suggestedAction ?? a.notes ?? ''),
      timestamp: a.updatedAt ?? a.createdAt ?? new Date().toISOString(),
      link: { type: 'action', id: a.id },
    }))
}

// GBP disconnected -- Owner-only. Not location-scoped (the Google
// connection is one company-wide credential, see credentialStore.js), and
// deliberately shown to no other role: only Owner holds SETTINGS_ADMIN
// (the permission that gates reconnecting it), so surfacing this to anyone
// else would be pure noise -- an alert nobody looking at it could act on,
// which this milestone's "only when actionable" requirement explicitly
// rules out.
async function gbpDisconnectedCandidate(account) {
  if (account.role !== 'owner') return null
  const credential = await getStoredCredential().catch(() => null)
  if (!credential || !credential.health) return null
  if (credential.health === 'connected' || credential.health === 'never_connected') return null
  const messages = {
    token_expired: 'Google Business Profile needs to be reconnected -- the connection has expired.',
    token_revoked: 'Google Business Profile access was revoked -- reconnect to keep publishing replies.',
    auth_failed: 'Google Business Profile authentication failed -- reconnect in Settings.',
    quota_blocked: 'Google Business Profile is quota-blocked -- see Settings for details.',
  }
  return {
    key: 'gbp_disconnected', type: 'gbp_disconnected', severity: 'critical',
    title: 'Google Business Profile disconnected', location: null,
    context: messages[credential.health] ?? 'Google Business Profile needs attention.',
    timestamp: new Date().toISOString(),
    link: { type: 'settings', id: 'google' },
  }
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 }
const MAX_NOTIFICATIONS = 50

// The single entry point the API layer calls. Returns candidates sorted
// severity-first, then most-recent-first, capped at MAX_NOTIFICATIONS --
// read/unread state is layered on top by the caller (dashboard/api/
// notifications/[action].js), not here, since read state is per-user and
// this function's output must stay identical for every user sharing the
// same authorized scope.
export async function getNotificationCandidates(account) {
  const [reviews, failures, assignedActions, gbpDisconnected] = await Promise.all([
    loadAuthorizedReviews(account),
    listReplyFailures(),
    assignedActionCandidates(account),
    gbpDisconnectedCandidate(account),
  ])

  const candidates = [
    ...reviewNotificationCandidates(reviews),
    ...replyFailureCandidates(failures, account),
    ...assignedActions,
    ...(gbpDisconnected ? [gbpDisconnected] : []),
  ]

  candidates.sort((a, b) =>
    (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) ||
    (new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  )

  return candidates.slice(0, MAX_NOTIFICATIONS)
}

export { REVIEW_NOTIFICATION_RETENTION_DAYS, reviewId as _reviewIdForTests }
