/**
 * Persistence for Settings -> Users & Access (Multi-Location Authentication
 * & User Access System, Commit 6) -- the only place in the app that calls
 * fetch() for these endpoints, same convention as auditLogService.js/
 * contactsService.js.
 */

import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

async function handleAuthFailure(res, action) {
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error(`Session expired ${action}`)
  }
}

async function postJSON(action, body) {
  const res = await fetch(`/api/settings/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  await handleAuthFailure(res, `calling ${action}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.message || `Failed: ${action} (${res.status})`)
    err.code = data.error
    throw err
  }
  return data
}

export async function listUsers() {
  const res = await fetch('/api/settings/users-list')
  await handleAuthFailure(res, 'fetching users')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `Failed to fetch users: ${res.status}`)
  }
  const data = await res.json()
  return data.users ?? []
}

export function inviteUser({ name, email, role, locationIds }) {
  return postJSON('invite-user', { name, email, role, locationIds })
}
export function resendInvite(userId) { return postJSON('resend-invite', { userId }) }
export function revokeInvite(userId) { return postJSON('revoke-invite', { userId }) }
export function generateResetLink(userId) { return postJSON('generate-reset-link', { userId }) }
export function updateUserRoleLocations({ userId, role, locationIds }) {
  return postJSON('update-user-role-locations', { userId, role, locationIds })
}
export function disableUser(userId) { return postJSON('disable-user', { userId }) }
export function enableUser(userId) { return postJSON('enable-user', { userId }) }
