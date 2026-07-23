/**
 * Persistence for the Email System settings page (Phase 8, Milestone 8.9) --
 * the only place in the app that calls fetch() for it, same convention as
 * auditLogService.js/contactsService.js.
 */

import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

async function handleAuthFailure(res, action) {
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error(`Session expired ${action}`)
  }
}

export async function getStatus() {
  const res = await fetch('/api/settings/email-status')
  await handleAuthFailure(res, 'fetching the email system status')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `Failed to fetch the email system status: ${res.status}`)
  }
  return res.json()
}

// Throws on both transport failure and a non-2xx response; the thrown Error
// carries `.code` (the API's error string), matching contactsService.js's
// upsertContact()/deleteContact() convention.
export async function sendTestEmail(locationId) {
  const res = await fetch('/api/settings/contacts-send-test-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId }),
  })
  await handleAuthFailure(res, `sending a test email for location ${locationId}`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(body.message || body.detail || `Failed to send test email: ${res.status}`)
    err.code = body.error
    throw err
  }
  return body
}
