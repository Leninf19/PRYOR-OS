/**
 * Persistence for the restaurant bad-review email workflow -- the only
 * place in the app that calls fetch() for it, same convention as
 * actionWorkspaceService.js. Recipient/CC/Reply-To are never sent by this
 * file; they're resolved server-side from locationId, so there is no
 * client-editable field for them to begin with.
 */

import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

async function handleAuthFailure(res, action) {
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error(`Session expired ${action}`)
  }
}

export async function previewReviewEmail(id, locationId) {
  const res = await fetch(`/api/actions/preview-review-email?id=${encodeURIComponent(id)}&locationId=${encodeURIComponent(locationId)}`)
  await handleAuthFailure(res, 'previewing the review email')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `Failed to preview review email: ${res.status}`)
  }
  return res.json()
}

// Throws on both transport failure and a non-2xx response (409 duplicate,
// 502 send failure, etc.) -- the thrown Error carries `.code` (the API's
// error string) and `.record` (the item's current state, if the server
// returned one) so the caller can still show a truthful status after a
// failure/duplicate, not just a generic toast.
export async function sendReviewEmail(payload) {
  const res = await fetch('/api/actions/send-review-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  await handleAuthFailure(res, 'sending the review email')
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(body.message || `Failed to send review email: ${res.status}`)
    err.code = body.error
    err.record = body.record ?? null
    throw err
  }
  return body.record
}

export async function updateEmailStatus(id, emailStatus) {
  const res = await fetch('/api/actions/update-email-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, emailStatus }),
  })
  await handleAuthFailure(res, 'updating the email status')
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.message || `Failed to update email status: ${res.status}`)
  return body.record
}
