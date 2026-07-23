// Server-side-only resolver for a single location's restaurant contact,
// used only by dashboard/api/actions/[action].js's send-review-email/
// preview-review-email actions -- never exposes the full contact
// directory, authenticated or not; only the ONE resolved recipient for the
// location being acted on.
//
// Phase 8, Milestone 8.4/8.5: contactStore.js (Redis, live-editable from
// Settings -> Restaurant Contacts) is now the primary source -- this is
// what makes a contact added through the dashboard usable for a send
// immediately, no export/commit/deploy needed. The legacy
// dashboard/private-data/location-contacts.json (written by
// export_chunks.py's export_location_contacts(), recovery-audit milestone)
// is kept as a read-only fallback ONLY if Redis is unreachable/unconfigured
// -- reads, unlike writes, are safe to degrade rather than fail closed,
// consistent with this module's own original "missing file means empty
// map" philosophy. getLocationContact()'s signature is unchanged, so
// actions/[action].js needed zero changes for this migration.
//
// Vercel bundling note for the legacy fallback path: like data.js, this
// needs an explicit functions["api/actions/[action].js"].includeFiles entry
// in dashboard/vercel.json (already added) -- Vercel's static dependency
// tracer cannot discover a fs.readFile path built at request time.

import { readFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { getContact as getRedisContact, ContactStoreUnavailableError } from './contactStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONTACTS_PATH = path.resolve(__dirname, '..', '..', 'private-data', 'location-contacts.json')

let legacyCache = null

async function getLegacyContact(locationId) {
  if (!legacyCache) {
    try {
      legacyCache = JSON.parse(await readFile(CONTACTS_PATH, 'utf-8'))
    } catch {
      legacyCache = {}
    }
  }
  return legacyCache[String(locationId)] ?? null
}

// Returns { email, name } or null (no configured contact anywhere). Tries
// the live Redis store first; on ANY failure (unconfigured, unreachable),
// falls back to the last-baked legacy JSON file rather than failing the
// whole send/preview action -- a real outage of the newer store should
// degrade to the old behavior, not break a working feature.
export async function getLocationContact(locationId) {
  try {
    const record = await getRedisContact(locationId)
    if (record && record.active && record.primaryEmail) {
      return { email: record.primaryEmail, name: record.managerName ?? null }
    }
    if (record && !record.active) return null // explicitly disabled -- never fall back to a stale legacy entry
  } catch (err) {
    if (!(err instanceof ContactStoreUnavailableError)) throw err
    // fall through to the legacy path below
  }
  return getLegacyContact(locationId)
}

// Test-only seam -- lets tests inject a fixed legacy-fallback contact map
// without touching the real filesystem path or dashboard/private-data/.
// Redis itself is mocked independently via contactStore.js's own
// _setRedisClientForTests seam.
export function _setContactsForTests(map) {
  legacyCache = map
}
export function _resetContactsForTests() {
  legacyCache = null
}
