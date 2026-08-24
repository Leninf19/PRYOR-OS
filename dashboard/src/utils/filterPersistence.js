// Durable persistence for the global review filter bar (App.jsx's
// RootLayout / GlobalFilters.jsx). Pure functions only -- no React, no
// router import here, so these are trivially unit-testable and reusable
// from anywhere that needs to read/write the same filter shape.
//
// Priority (mount / whenever the URL has no filter params of its own):
//   1. URL query parameters (?start=&end=&locations=&brands=&stars=)
//   2. localStorage (FILTERS_STORAGE_KEY)
//   3. computed defaults (getDefaultDateRange(allReviews))
//
// Reused filter shape, unchanged: { start, end, locations, brands, stars }.
// `_defaultStart`/`_defaultEnd` are NEVER read from the URL or localStorage
// -- they are bookkeeping GlobalFilters.jsx uses to detect "All" and to
// reset, always recomputed fresh from the current allReviews (see
// withFreshDefaults below). Nothing here invents new filter semantics;
// filterReviews() in dataUtils.js is untouched.

const FILTERS_STORAGE_KEY = 'lta_global_filters_v1'
const FILTER_PARAM_KEYS = ['start', 'end', 'locations', 'brands', 'stars']

function isValidDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const t = new Date(s + 'T00:00:00').getTime()
  return !Number.isNaN(t)
}

function parseListValue(raw) {
  if (!raw) return []
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

function parseStarsValue(raw) {
  if (!raw) return []
  return [...new Set(
    raw.split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 5)
  )].sort()
}

// Reads the 5 persisted fields from a URLSearchParams instance. Returns
// null if NONE of the 5 keys are present at all (the "URL has no opinion,
// fall through to localStorage" signal) -- returns a full object (missing
// individual fields resolved to their "unset" value: [] for lists, null for
// dates) the moment ANY of the 5 keys is present, so a partial URL like
// `?start=...&end=...` means "these two are explicit, everything else is
// explicitly un-filtered" rather than silently inheriting the reader's own
// localStorage for the other fields -- required for "opening a copied
// filtered URL recreates the same filters" to mean exactly that URL, not a
// mix with whatever the opener already had saved locally.
export function parseFiltersFromSearchParams(searchParams) {
  const hasAny = FILTER_PARAM_KEYS.some(k => searchParams.has(k))
  if (!hasAny) return null

  const start = searchParams.get('start')
  const end = searchParams.get('end')
  return {
    start: isValidDateString(start) ? start : null,
    end: isValidDateString(end) ? end : null,
    locations: parseListValue(searchParams.get('locations')),
    brands: parseListValue(searchParams.get('brands')),
    stars: parseStarsValue(searchParams.get('stars')),
  }
}

// Per-element filtering (not an all-or-nothing array-shape check) -- one
// corrupted entry in an otherwise-fine array must not discard the whole
// field, matching parseListValue/parseStarsValue's URL-parsing behavior
// exactly, so a malformed stored record degrades exactly as gracefully as
// a malformed URL does.
function filterStringArray(v) {
  return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length > 0) : []
}

function filterStarArray(v) {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter(n => Number.isInteger(n) && n >= 1 && n <= 5))].sort()
}

// Reads and validates the stored filter object. Any structurally invalid
// stored value (corrupted JSON, wrong top-level type, a stale/foreign
// shape) is treated as "nothing usable stored" -- returns null, never
// throws. Individual field-level garbage (a non-array locations, a mixed
// valid/invalid stars array) degrades field-by-field instead, never
// discarding an otherwise-fine sibling field.
export function loadStoredFilters() {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    return {
      start: isValidDateString(parsed.start) ? parsed.start : null,
      end: isValidDateString(parsed.end) ? parsed.end : null,
      locations: filterStringArray(parsed.locations),
      brands: filterStringArray(parsed.brands),
      stars: filterStarArray(parsed.stars),
    }
  } catch {
    return null
  }
}

// Persists exactly the 5 reused fields -- never _defaultStart/_defaultEnd
// (those are always recomputed fresh, see withFreshDefaults), never any
// other filter-bar-unrelated state. Silently no-ops if localStorage is
// unavailable (private browsing, quota) -- the URL-sync path still works
// without it; this is a convenience fallback, not the only persistence layer.
export function saveStoredFilters(filters) {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({
      start: filters.start ?? null,
      end: filters.end ?? null,
      locations: filters.locations ?? [],
      brands: filters.brands ?? [],
      stars: filters.stars ?? [],
    }))
  } catch {
    // localStorage unavailable -- non-fatal, matches every other localStorage
    // consumer in this app (e.g. reviewWorkspaceService.js's own try/catch).
  }
}

export function clearStoredFilters() {
  try {
    localStorage.removeItem(FILTERS_STORAGE_KEY)
  } catch {
    // see saveStoredFilters -- non-fatal
  }
}

// Fills in whatever a URL/localStorage-derived partial filter object left
// unset, and ALWAYS recomputes _defaultStart/_defaultEnd fresh from the
// current review data -- these two are bookkeeping for GlobalFilters.jsx's
// "All" detection and its Reset button, never a persisted user selection.
export function withFreshDefaults(partial, defaultDateRange) {
  return {
    start: partial?.start ?? defaultDateRange.start,
    end: partial?.end ?? defaultDateRange.end,
    locations: partial?.locations ?? [],
    brands: partial?.brands ?? [],
    stars: partial?.stars ?? [],
    _defaultStart: defaultDateRange.start,
    _defaultEnd: defaultDateRange.end,
  }
}

// Builds a NEW URLSearchParams reflecting `filters` -- always constructed
// fresh from `existingParams` with the 5 filter keys deleted first and only
// non-empty ones re-added, so this can never accumulate duplicates and
// never silently drops an unrelated param (e.g. Reviews.jsx's own
// ?filter=all, or a ?reviewId= deep link) that some other part of the app
// put on the same URL. _defaultStart/_defaultEnd are never written here --
// they are never part of the URL's vocabulary.
export function buildSearchParamsFromFilters(filters, existingParams) {
  const next = new URLSearchParams(existingParams)
  FILTER_PARAM_KEYS.forEach(k => next.delete(k))
  if (filters.start) next.set('start', filters.start)
  if (filters.end) next.set('end', filters.end)
  if (filters.locations?.length) next.set('locations', filters.locations.join(','))
  if (filters.brands?.length) next.set('brands', filters.brands.join(','))
  if (filters.stars?.length) next.set('stars', filters.stars.join(','))
  return next
}

// Used by Reset: strips just the 5 filter keys from the URL (as opposed to
// buildSearchParamsFromFilters, which would write the computed defaults
// back in as explicit params) -- so a reset URL has NO filter params at
// all, meaning a later visit recomputes a truly fresh default rather than
// replaying today's frozen "default" dates forever.
export function stripFilterParams(existingParams) {
  const next = new URLSearchParams(existingParams)
  FILTER_PARAM_KEYS.forEach(k => next.delete(k))
  return next
}

export { FILTERS_STORAGE_KEY, FILTER_PARAM_KEYS, isValidDateString }
