// Server-side-only reader for dashboard/private-data/location-contacts.json
// (written by export_chunks.py's export_location_contacts(), recovery-audit
// milestone). Read directly off disk via fs, the same technique
// dashboard/api/data.js uses for every other private-data file -- but this
// file is deliberately NEVER added to data.js's own EXACT_ALLOWLIST/
// DYNAMIC_ALLOWLIST, so the browser can never fetch the whole contact
// directory, authenticated or not. Only dashboard/api/actions/[action].js
// imports this module, and only ever exposes the ONE resolved recipient
// for the location being acted on -- never the full parsed object.
//
// Vercel bundling note: like data.js, this needs an explicit
// functions["api/actions/[action].js"].includeFiles entry in
// dashboard/vercel.json (already added) -- Vercel's static dependency
// tracer cannot discover a fs.readFile path built at request time.

import { readFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONTACTS_PATH = path.resolve(__dirname, '..', '..', 'private-data', 'location-contacts.json')

let cache = null

// A missing file (pipeline hasn't run export_location_contacts() yet, or a
// local/test environment with no private-data at all) means "nobody has a
// configured contact" -- the same safe, non-crashing default as every
// location simply being absent from the file's own keys.
export async function getLocationContact(locationId) {
  if (!cache) {
    try {
      cache = JSON.parse(await readFile(CONTACTS_PATH, 'utf-8'))
    } catch {
      cache = {}
    }
  }
  return cache[String(locationId)] ?? null
}

// Test-only seam -- lets tests inject a fixed contact map without touching
// the real filesystem path or dashboard/private-data/.
export function _setContactsForTests(map) {
  cache = map
}
export function _resetContactsForTests() {
  cache = null
}
