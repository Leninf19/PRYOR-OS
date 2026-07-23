/**
 * Persistence for Restaurant Contacts (Phase 8, Milestone 8.4) -- the only
 * place in the app that calls fetch() for it, same convention as
 * actionWorkspaceService.js/reviewEmailService.js. Replaces the old
 * edit-reviews.db -> export_chunks.py -> commit -> deploy cycle: every
 * write here lands immediately in dashboard/api/_lib/contactStore.js
 * (Redis), no deployment involved.
 */

import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

async function handleAuthFailure(res, action) {
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error(`Session expired ${action}`)
  }
}

export async function getAll() {
  const res = await fetch('/api/settings/contacts')
  await handleAuthFailure(res, 'fetching restaurant contacts')
  if (!res.ok) throw new Error(`Failed to fetch restaurant contacts: ${res.status}`)
  const { contacts } = await res.json()
  return contacts ?? {}
}

// Throws on both transport failure and a non-2xx response; the thrown
// Error carries `.code` (the API's error string) so the caller can
// distinguish a validation failure (invalid_request) from a service outage
// (service_unavailable) without string-matching the message.
export async function upsertContact(locationId, patch, logAction) {
  const res = await fetch('/api/settings/contacts-upsert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId, patch, logAction }),
  })
  await handleAuthFailure(res, `updating the contact for location ${locationId}`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(body.message || `Failed to update contact: ${res.status}`)
    err.code = body.error
    throw err
  }
  return { record: body.record, warnings: body.warnings ?? [] }
}

export async function deleteContact(locationId) {
  const res = await fetch('/api/settings/contacts-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId }),
  })
  await handleAuthFailure(res, `deleting the contact for location ${locationId}`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(body.message || `Failed to delete contact: ${res.status}`)
    err.code = body.error
    throw err
  }
  return body.removed
}

export async function toggleContactActive(locationId, active) {
  const res = await fetch('/api/settings/contacts-toggle-active', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId, active }),
  })
  await handleAuthFailure(res, `${active ? 'enabling' : 'disabling'} the contact for location ${locationId}`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(body.message || `Failed to update contact status: ${res.status}`)
    err.code = body.error
    throw err
  }
  return body.record
}
