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
//
// Global Filter Expiration / Rolling Date Default: a custom DATE range
// (start/end only -- never locations/brands/stars, which keep persisting
// indefinitely exactly as before) is only ever honored for DATE_RANGE_EXPIRY_MS
// after it was last deliberately accepted -- a user picking a date, applying
// a preset, or opening a URL that carries an explicit (and actually
// different) start/end. Past that window, resolution falls back to the
// LIVE rolling default (getDefaultDateRange(), recomputed from the current
// clock, never a frozen snapshot). This is tracked with an explicit
// `dateExpiresAt` (absolute ms epoch, Date.now() + DATE_RANGE_EXPIRY_MS)
// persisted alongside start/end in localStorage -- never a running timer --
// so it survives a refresh, a closed/reopened browser, or a computer sleep,
// and is simply compared against `now` (injectable, for tests) every time
// filter state is resolved. See resolveDateRangeWithExpiration() below for
// the exact acceptance/expiry/URL-staleness rules.

const FILTERS_STORAGE_KEY = 'lta_global_filters_v1'
const FILTER_PARAM_KEYS = ['start', 'end', 'locations', 'brands', 'stars']
export const DATE_RANGE_EXPIRY_MS = 60 * 60 * 1000 // 1 hour

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
//
// `dateExpiresAt`: sanitized to either a positive finite number or null --
// a missing field (a record saved before this milestone), zero, a negative
// number, NaN, or a non-numeric value all fail safe to null, which
// resolveDateRangeWithExpiration() below treats identically to "no custom
// date was ever accepted" (never a crash, never a value trusted verbatim).
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
      dateExpiresAt: Number.isFinite(parsed.dateExpiresAt) && parsed.dateExpiresAt > 0 ? parsed.dateExpiresAt : null,
    }
  } catch {
    return null
  }
}

// Persists the 5 reused fields plus `dateExpiresAt` -- never
// _defaultStart/_defaultEnd (those are always recomputed fresh, see
// withFreshDefaults), never any other filter-bar-unrelated state. Silently
// no-ops if localStorage is unavailable (private browsing, quota) -- the
// URL-sync path still works without it; this is a convenience fallback, not
// the only persistence layer.
//
// `dateExpiresAt` is caller-supplied (resolveDateRangeWithExpiration()'s
// output), not derived from `filters.start`/`filters.end` here -- this
// function only persists whatever expiration the caller already decided;
// omitting it (or passing an invalid value) persists null, meaning "this
// start/end is not a time-boxed custom selection" -- exactly the rolling-
// default state, which is what every pre-this-milestone caller (still
// passing plain { start, end, locations, brands, stars }) continues to get.
export function saveStoredFilters(filters) {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({
      start: filters.start ?? null,
      end: filters.end ?? null,
      locations: filters.locations ?? [],
      brands: filters.brands ?? [],
      stars: filters.stars ?? [],
      dateExpiresAt: Number.isFinite(filters.dateExpiresAt) && filters.dateExpiresAt > 0 ? filters.dateExpiresAt : null,
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

// Global Filter Expiration / Rolling Date Default: decides what the DATE
// portion of the filter state should resolve to, and whether a custom
// selection is being freshly accepted, merely reflected back unchanged, or
// has lapsed. Pure and deterministic -- `now` is always caller-supplied
// (Date.now() in production, an injected fixed value in tests), and this
// never reads localStorage/the URL/the clock itself, so every branch below
// is directly unit-testable without fake timers or a DOM.
//
// Params:
//   urlPresent:       true iff the URL currently carries ANY of the 5 filter
//                     keys (parseFiltersFromSearchParams(searchParams) !==
//                     null) -- mirrors this module's existing "URL has an
//                     opinion" signal, unchanged.
//   urlStart/urlEnd:  the URL's own start/end (each already validated to a
//                     real date string or null by parseFiltersFromSearchParams).
//   stored:           the loadStoredFilters() result (or null) -- only
//                     .start/.end/.dateExpiresAt are read here.
//   now:              Date.now(), injected.
//   defaultDateRange: getDefaultDateRange(allReviews)'s current result --
//                     the LIVE rolling default, recomputed by the caller
//                     every time from the current clock.
//
// Returns { start, end, dateExpiresAt, expired }:
//   dateExpiresAt is the value the caller should persist (null means "not a
//   time-boxed custom selection -- this is just the rolling default").
//   `expired` is true only when an actual past custom selection (a real,
//   past-tense dateExpiresAt) just lapsed on THIS resolution -- the signal
//   the caller uses to know a stale start/end sitting in the address bar
//   needs to be rewritten, not a generic "this happens to be the default"
//   case.
//
// Rules, in order:
//   1. If the candidate start/end are EXACTLY today's live default, it is
//      never "custom" regardless of what's stored -- nothing to protect,
//      since it already tracks the live rolling window on its own. This
//      also stops a feedback loop: once an expired custom range resets and
//      gets written back into the URL as explicit default-valued params,
//      the next resolution pass (URL now "present" with those default
//      values) must not re-arm a brand-new fake hour for values that are
//      already just the default.
//   2. Otherwise, if the URL explicitly carries a start+end:
//        a. Same as what's already stored AND that stored selection is
//           still within its window -- a reload/reflection, not a new
//           acceptance. The ORIGINAL expiration is preserved untouched
//           (this is what makes a plain refresh/re-render never restart
//           the clock).
//        b. Same as what's stored, but that stored selection's window has
//           lapsed -- stale state riding along in the address bar. Falls
//           back to the rolling default; `expired: true` tells the caller
//           to rewrite the URL.
//        c. Anything else (a genuinely different range -- a deliberate UI
//           edit, or a shared/bookmarked URL never seen on this browser
//           before) -- accept it now and start a brand-new hour.
//   3. If the URL is present but doesn't carry an explicit start+end pair
//      (e.g. only ?locations=...), this module's existing contract already
//      treats that as "explicitly un-filtered" for every field it doesn't
//      carry -- the date resolves to the rolling default, never a stored
//      custom range, and this is not an expiry event.
//   4. If the URL has no filter params at all (plain in-app navigation, or
//      a bare refresh with an unparameterized address bar), use a still-
//      valid stored custom range if one exists, else the rolling default.
//      This branch never creates or renews an expiration -- it is a pure
//      read of whatever the last acceptance decided.
export function resolveDateRangeWithExpiration({ urlPresent, urlStart, urlEnd, stored, now, defaultDateRange }) {
  const hasValidStoredDates = Boolean(stored) && isValidDateString(stored.start) && isValidDateString(stored.end)
  const storedHadTimestamp = hasValidStoredDates && Number.isFinite(stored.dateExpiresAt) && stored.dateExpiresAt > 0
  const storedStillValid = storedHadTimestamp && stored.dateExpiresAt > now
  const rawStoredMatchesUrl = hasValidStoredDates && stored.start === urlStart && stored.end === urlEnd

  if (urlPresent) {
    if (urlStart && urlEnd) {
      if (urlStart === defaultDateRange.start && urlEnd === defaultDateRange.end) {
        return { start: urlStart, end: urlEnd, dateExpiresAt: null, expired: false }
      }
      if (rawStoredMatchesUrl && storedStillValid) {
        return { start: urlStart, end: urlEnd, dateExpiresAt: stored.dateExpiresAt, expired: false }
      }
      if (rawStoredMatchesUrl && storedHadTimestamp) {
        return { start: defaultDateRange.start, end: defaultDateRange.end, dateExpiresAt: null, expired: true }
      }
      return { start: urlStart, end: urlEnd, dateExpiresAt: now + DATE_RANGE_EXPIRY_MS, expired: false }
    }
    return { start: defaultDateRange.start, end: defaultDateRange.end, dateExpiresAt: null, expired: false }
  }

  if (storedStillValid) {
    return { start: stored.start, end: stored.end, dateExpiresAt: stored.dateExpiresAt, expired: false }
  }
  return { start: defaultDateRange.start, end: defaultDateRange.end, dateExpiresAt: null, expired: storedHadTimestamp }
}

// Multi-Location Authentication & User Access System (Phase 10): a stored
// or URL-carried `locations` value must never be trusted as authorization --
// only the server-derived allowed-locations set is authoritative (never a
// browser's localStorage or a URL a link could hand anyone). `allowedNames`
// is null for a company-wide (unscoped) account, meaning "no restriction,
// return filters unchanged" -- for a scoped account it's the exact set
// meta.json's own (already server-filtered) locations list names, so this
// is a pure intersection, never a widening: requested filters ∩
// session.allowedLocationIds, never the reverse. Applied identically
// whether `locations` came from the URL, localStorage, or neither (an
// empty array already intersects down to itself).
export function restrictLocationsToAllowed(filters, allowedNames) {
  if (allowedNames === null) return filters
  const allowed = new Set(allowedNames)
  return {
    ...filters,
    locations: (filters.locations ?? []).filter(name => allowed.has(name)),
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
