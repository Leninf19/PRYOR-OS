/**
 * Persistence for the global Audit Log (Phase 8, Milestone 8.6) -- the only
 * place in the app that calls fetch() for it, same convention as
 * contactsService.js/actionWorkspaceService.js.
 */

import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'

async function handleAuthFailure(res, action) {
  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error(`Session expired ${action}`)
  }
}

export async function getEntries(filters = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, value)
  }
  const qs = params.toString()
  const res = await fetch(`/api/settings/audit-log${qs ? `?${qs}` : ''}`)
  await handleAuthFailure(res, 'fetching the audit log')
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `Failed to fetch audit log: ${res.status}`)
  }
  return res.json()
}
