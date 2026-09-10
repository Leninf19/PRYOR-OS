// Multi-Tenant Phase 1 -- adds a tenantId to an existing meta.json-shaped
// location record WITHOUT changing anything user-facing. locationId, slug,
// name, city, brand, maps_url, hasContact, and every other existing field
// are carried over untouched -- tenantId is purely additive. Not wired
// into api/data.js, export_chunks.py, or any endpoint yet: the real
// dashboard/private-data/meta.json on disk is not read or modified by
// this phase.

import { isValidTenantId } from './tenants.js'

const REQUIRED_LOCATION_FIELDS = ['locationId', 'name', 'slug']

export function isValidBaseLocation(location) {
  return (
    location !== null && typeof location === 'object' &&
    REQUIRED_LOCATION_FIELDS.every(f => location[f] !== undefined)
  )
}

// Pure function: returns a NEW object (never mutates `location`), with
// every existing field preserved exactly and `tenantId` added. Throws on
// an invalid tenantId or a location missing its required fields, rather
// than silently producing a half-tagged record a later phase might trust.
export function withTenantId(location, tenantId) {
  if (!isValidBaseLocation(location)) {
    throw new TypeError(`withTenantId: location is missing one of ${REQUIRED_LOCATION_FIELDS.join(', ')}`)
  }
  if (!isValidTenantId(tenantId)) {
    throw new TypeError(`withTenantId: invalid tenantId ${JSON.stringify(tenantId)}`)
  }
  return { ...location, tenantId }
}

// Applies withTenantId() to every location in a meta.json-shaped
// `{ locations: [...], ... }` object, returning a NEW top-level object.
// Neither the input's `locations` array nor any location object inside it
// is mutated. Every other top-level field (brands, totalReviews,
// generatedAt, ...) is carried over unchanged.
export function withTenantIdForAllLocations(meta, tenantId) {
  if (!meta || !Array.isArray(meta.locations)) {
    throw new TypeError('withTenantIdForAllLocations: meta.locations must be an array')
  }
  return {
    ...meta,
    locations: meta.locations.map(loc => withTenantId(loc, tenantId)),
  }
}
