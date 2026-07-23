// Client-side email validation for the Restaurant Contacts editor (Phase 8,
// Milestone 8.4). Net new -- before this, the only client-side check
// anywhere in dashboard/src was a native <input type="email"> on the login
// form. Mirrors the same permissive format regex used server-side
// (dashboard/api/settings/[action].js, db.py's set_location_contact()) so a
// value accepted here is never rejected by the API.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmailFormat(value) {
  return typeof value === 'string' && EMAIL_RE.test(value.trim())
}

// Case-insensitive duplicate check against a list of already-loaded
// contacts (never a separate network round trip -- the caller already has
// the full contact list loaded for the table). `excludeLocationId` lets an
// edit-in-place skip flagging a contact's own unchanged email as a
// duplicate of itself.
export function findDuplicatePrimaryEmail(email, contacts, excludeLocationId) {
  if (!isValidEmailFormat(email)) return null
  const normalized = email.trim().toLowerCase()
  return Object.values(contacts ?? {}).find(c =>
    c.locationId !== excludeLocationId && c.primaryEmail?.toLowerCase() === normalized
  ) ?? null
}
