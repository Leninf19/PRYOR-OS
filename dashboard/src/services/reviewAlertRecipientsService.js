/**
 * Persistence for this tenant's OWN internal review-alert notification list
 * (who on the business's own team gets emailed about new/critical reviews
 * -- notify.py's rating-drop alert, critical_alert_check.py's immediate
 * critical alert, nightly_digest.py's nightly digest) -- the only place in
 * the app that calls fetch() for it, same convention as
 * reviewContactService.js. A DIFFERENT, deliberately separate concept from
 * reviewContactService.js's public, customer-facing review-response
 * contact -- never shown to a customer, never merged with that setting.
 */

import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

async function handleAuthFailure(res, action) {
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error(`Session expired ${action}`)
  }
}

export async function getReviewAlertRecipients() {
  const res = await fetch('/api/settings/review-alert-recipients')
  await handleAuthFailure(res, 'fetching the review-alert recipient list')
  if (!res.ok) throw new Error(`Failed to fetch the review-alert recipient list: ${res.status}`)
  return res.json()
}

// Throws on both transport failure and a non-2xx response; the thrown
// Error carries `.code` (the API's error string) so the caller can
// distinguish a validation failure (invalid_request) from a service outage
// (service_unavailable) without string-matching the message. `recipients`
// REPLACES the tenant's whole list -- the caller is expected to pass the
// full desired array, never a delta.
export async function upsertReviewAlertRecipients(recipients) {
  const res = await fetch('/api/settings/review-alert-recipients-upsert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipients }),
  })
  await handleAuthFailure(res, 'updating the review-alert recipient list')
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(body.message || `Failed to update the review-alert recipient list: ${res.status}`)
    err.code = body.error
    throw err
  }
  return body
}
