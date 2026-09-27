/**
 * Persistence for this tenant's own public, customer-facing review-response
 * contact (Tenant-Isolated Review Contact: multi-tenant readiness) -- the
 * only place in the app that calls fetch() for it, same convention as
 * contactsService.js. A DIFFERENT, deliberately separate concept from
 * Restaurant Contacts (contactsService.js): that's the internal
 * manager/escalation directory, never shown to a customer; this is what an
 * AI-generated reply may offer a guest for a serious/escalated review.
 */

import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

async function handleAuthFailure(res, action) {
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error(`Session expired ${action}`)
  }
}

export async function getReviewContact() {
  const res = await fetch('/api/settings/review-contact')
  await handleAuthFailure(res, 'fetching the review-response contact')
  if (!res.ok) throw new Error(`Failed to fetch the review-response contact: ${res.status}`)
  return res.json()
}

// Throws on both transport failure and a non-2xx response; the thrown
// Error carries `.code` (the API's error string) so the caller can
// distinguish a validation failure (invalid_request) from a service outage
// (service_unavailable) without string-matching the message.
export async function upsertReviewContact({ email, phone }) {
  const res = await fetch('/api/settings/review-contact-upsert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, phone }),
  })
  await handleAuthFailure(res, 'updating the review-response contact')
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(body.message || `Failed to update the review-response contact: ${res.status}`)
    err.code = body.error
    throw err
  }
  return body
}
