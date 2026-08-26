// Regression tests for the Global Filter Expiration / Rolling Date Default
// milestone -- dashboard/src/utils/filterPersistence.js's
// resolveDateRangeWithExpiration(), plus its interaction with
// loadStoredFilters/saveStoredFilters/withFreshDefaults/
// restrictLocationsToAllowed exactly as App.jsx's useFilterPersistence
// effect composes them. resolveDateRangeWithExpiration is a pure function
// (now/stored/defaultDateRange are all plain injected parameters) so every
// scenario below -- including "an hour has passed" and "the browser was
// closed and reopened" -- is expressed as a different injected `now`
// against a persisted `dateExpiresAt`, never a real wait or a fake-timer
// library.
//
// Run directly: node tests/test_filter_expiration.js

import {
  resolveDateRangeWithExpiration, loadStoredFilters, saveStoredFilters, clearStoredFilters,
  withFreshDefaults, restrictLocationsToAllowed, parseFiltersFromSearchParams,
  buildSearchParamsFromFilters, DATE_RANGE_EXPIRY_MS, FILTERS_STORAGE_KEY,
} from '../dashboard/src/utils/filterPersistence.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const results = []
function run(name, fn) {
  try {
    fn()
    console.log(`PASS: ${name}`)
    results.push(true)
  } catch (e) {
    console.log(`FAIL: ${name} -- ${e.message}`)
    results.push(false)
  }
}

function installFakeLocalStorage() {
  const store = new Map()
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
  }
  return store
}

// A fixed "today" for every test -- the rolling default for THIS instant.
const NOW = new Date('2026-08-26T14:00:00.000Z').getTime() // 2:00 PM
const DR_TODAY = { start: '2026-08-19', end: '2026-08-26' } // stand-in getDefaultDateRange() result at NOW
const CUSTOM = { start: '2026-08-01', end: '2026-08-15' }
const CUSTOM_2 = { start: '2026-08-10', end: '2026-08-20' }

// Full end-to-end composition, exactly mirroring App.jsx's useFilterPersistence
// effect body, so these tests exercise the real integration, not just the
// one new function in isolation.
function resolveLikeApp({ searchParams, stored, now, defaultDateRange, allowedLocationNames = null }) {
  const fromUrl = parseFiltersFromSearchParams(searchParams)
  if (fromUrl) {
    const dateResult = resolveDateRangeWithExpiration({
      urlPresent: true, urlStart: fromUrl.start, urlEnd: fromUrl.end, stored, now, defaultDateRange,
    })
    const merged = { ...fromUrl, start: dateResult.start, end: dateResult.end }
    const resolved = restrictLocationsToAllowed(withFreshDefaults(merged, defaultDateRange), allowedLocationNames)
    return { filters: { ...resolved, _dateExpiresAt: dateResult.dateExpiresAt }, storedRecord: { ...merged, dateExpiresAt: dateResult.dateExpiresAt }, expired: dateResult.expired }
  }
  const dateResult = resolveDateRangeWithExpiration({
    urlPresent: false, urlStart: null, urlEnd: null, stored, now, defaultDateRange,
  })
  const merged = { ...stored, start: dateResult.start, end: dateResult.end }
  const resolved = restrictLocationsToAllowed(withFreshDefaults(merged, defaultDateRange), allowedLocationNames)
  return { filters: { ...resolved, _dateExpiresAt: dateResult.dateExpiresAt }, storedRecord: { ...merged, dateExpiresAt: dateResult.dateExpiresAt }, expired: dateResult.expired }
}

// ── 1. Default load -> rolling 7-day range ──────────────────────────────

function testDefaultLoadNoStoredNoUrlResolvesToRollingDefault() {
  const r = resolveDateRangeWithExpiration({ urlPresent: false, urlStart: null, urlEnd: null, stored: null, now: NOW, defaultDateRange: DR_TODAY })
  assert(r.start === DR_TODAY.start && r.end === DR_TODAY.end, 'a fresh session with nothing stored must resolve to the live rolling default')
  assert(r.dateExpiresAt === null, 'the rolling default is never a time-boxed custom selection')
  assert(r.expired === false)
}

// ── 2. Custom date persists immediately ─────────────────────────────────

function testCustomDateIsAcceptedAndTimestampedImmediately() {
  const r = resolveDateRangeWithExpiration({ urlPresent: true, urlStart: CUSTOM.start, urlEnd: CUSTOM.end, stored: null, now: NOW, defaultDateRange: DR_TODAY })
  assert(r.start === CUSTOM.start && r.end === CUSTOM.end)
  assert(r.dateExpiresAt === NOW + DATE_RANGE_EXPIRY_MS, `expected dateExpiresAt exactly 1 hour after acceptance, got ${r.dateExpiresAt}`)
  assert(r.expired === false)
}

// ── 3. Refresh within 59 minutes preserves the same custom dates ────────

function testRefreshWithin59MinutesPreservesSameCustomDatesAndDoesNotRenew() {
  const acceptedAt = NOW
  const expiresAt = acceptedAt + DATE_RANGE_EXPIRY_MS
  const stored = { ...CUSTOM, dateExpiresAt: expiresAt }
  const refreshNow = acceptedAt + 59 * 60 * 1000
  const r = resolveDateRangeWithExpiration({ urlPresent: true, urlStart: CUSTOM.start, urlEnd: CUSTOM.end, stored, now: refreshNow, defaultDateRange: DR_TODAY })
  assert(r.start === CUSTOM.start && r.end === CUSTOM.end, 'the same custom dates must still be showing 59 minutes in')
  assert(r.dateExpiresAt === expiresAt, 'a refresh must NEVER renew the expiration -- it must stay the exact original timestamp')
  assert(r.expired === false)
}

// ── 7. Simple page reload does NOT restart the clock (same as #3, framed
//        explicitly as the "reload" scenario the spec calls out) ────────

function testPlainReloadNeverRestartsTheClock() {
  const expiresAt = NOW + DATE_RANGE_EXPIRY_MS
  const stored = { ...CUSTOM, dateExpiresAt: expiresAt }
  // Reload 5 minutes later -- URL still literally carries the same values
  // (the browser's own address bar, not app state).
  const r1 = resolveDateRangeWithExpiration({ urlPresent: true, urlStart: CUSTOM.start, urlEnd: CUSTOM.end, stored, now: NOW + 5 * 60 * 1000, defaultDateRange: DR_TODAY })
  assert(r1.dateExpiresAt === expiresAt, 'reload #1 must not move the expiration')
  // A second reload, later still, using the FIRST reload's own (unchanged)
  // stored record -- still must not move.
  const r2 = resolveDateRangeWithExpiration({ urlPresent: true, urlStart: CUSTOM.start, urlEnd: CUSTOM.end, stored: { ...CUSTOM, dateExpiresAt: r1.dateExpiresAt }, now: NOW + 30 * 60 * 1000, defaultDateRange: DR_TODAY })
  assert(r2.dateExpiresAt === expiresAt, 'reload #2 must still carry the ORIGINAL expiration, never a renewed one')
}

// ── 4. Expiration after 60+ minutes -> rolling default ──────────────────

function testExpirationAfter60PlusMinutesFallsBackToRollingDefault() {
  const expiresAt = NOW + DATE_RANGE_EXPIRY_MS
  const stored = { ...CUSTOM, dateExpiresAt: expiresAt }
  const laterNow = expiresAt + 60 * 1000 // just over an hour past acceptance
  const r = resolveDateRangeWithExpiration({ urlPresent: true, urlStart: CUSTOM.start, urlEnd: CUSTOM.end, stored, now: laterNow, defaultDateRange: DR_TODAY })
  assert(r.start === DR_TODAY.start && r.end === DR_TODAY.end, 'past expiration, the rolling default must apply, not the old custom range')
  assert(r.dateExpiresAt === null, 'expiration metadata must be cleared once lapsed')
  assert(r.expired === true, 'this specific resolution is the one that detected the expiry -- the caller needs this to know to rewrite the URL')
}

// ── 14. Clock moving exactly to / beyond the expiration boundary ────────

function testExpiryBoundaryIsInclusiveOfTheExactMoment() {
  const expiresAt = NOW + DATE_RANGE_EXPIRY_MS
  const stored = { ...CUSTOM, dateExpiresAt: expiresAt }
  const exactly = resolveDateRangeWithExpiration({ urlPresent: true, urlStart: CUSTOM.start, urlEnd: CUSTOM.end, stored, now: expiresAt, defaultDateRange: DR_TODAY })
  assert(exactly.expired === true, 'the exact expiry instant itself must already be treated as expired, not one tick later')
  const oneMsBefore = resolveDateRangeWithExpiration({ urlPresent: true, urlStart: CUSTOM.start, urlEnd: CUSTOM.end, stored, now: expiresAt - 1, defaultDateRange: DR_TODAY })
  assert(oneMsBefore.dateExpiresAt === expiresAt && oneMsBefore.expired === false, '1ms before expiry must still be valid')
}

// ── 6. Changing the date again restarts the 1-hour expiration ───────────

function testChangingTheDateAgainRestartsTheWindow() {
  const firstAcceptedAt = NOW
  const firstExpiresAt = firstAcceptedAt + DATE_RANGE_EXPIRY_MS
  const stored = { ...CUSTOM, dateExpiresAt: firstExpiresAt }
  const secondChangeAt = firstAcceptedAt + 45 * 60 * 1000 // 2:45 PM
  const r = resolveDateRangeWithExpiration({ urlPresent: true, urlStart: CUSTOM_2.start, urlEnd: CUSTOM_2.end, stored, now: secondChangeAt, defaultDateRange: DR_TODAY })
  assert(r.start === CUSTOM_2.start && r.end === CUSTOM_2.end)
  assert(r.dateExpiresAt === secondChangeAt + DATE_RANGE_EXPIRY_MS, 'a genuinely different date change must start a brand-new hour from the moment of the change')
  assert(r.dateExpiresAt !== firstExpiresAt, 'the new expiration must not equal the old one')
}

// ── 10. An explicit, fresh shared URL still works ────────────────────────

function testFreshSharedUrlWithNothingStoredIsHonoredAndTimestamped() {
  const r = resolveDateRangeWithExpiration({ urlPresent: true, urlStart: CUSTOM.start, urlEnd: CUSTOM.end, stored: null, now: NOW, defaultDateRange: DR_TODAY })
  assert(r.start === CUSTOM.start && r.end === CUSTOM.end, 'a freshly-opened shared URL must be honored even with nothing in localStorage')
  assert(r.dateExpiresAt === NOW + DATE_RANGE_EXPIRY_MS, 'opening it must timestamp the acceptance starting now, for the next hour')
}

function testSharedUrlDifferentFromAnExpiredStoredCustomRangeIsTreatedAsNewAcceptance() {
  // Someone had Aug1-15 (now expired); they open a DIFFERENT shared URL
  // (Aug10-20) -- this must be a fresh acceptance, not silently swallowed
  // by the unrelated stale stored record.
  const stored = { ...CUSTOM, dateExpiresAt: NOW - 1000 } // already expired
  const r = resolveDateRangeWithExpiration({ urlPresent: true, urlStart: CUSTOM_2.start, urlEnd: CUSTOM_2.end, stored, now: NOW, defaultDateRange: DR_TODAY })
  assert(r.start === CUSTOM_2.start && r.end === CUSTOM_2.end)
  assert(r.dateExpiresAt === NOW + DATE_RANGE_EXPIRY_MS)
}

// ── "All"/default-valued explicit change is never treated as custom ─────
// (also the regression guard for the URL-rewrite feedback loop: once an
// expired range resets and gets written back into the URL as explicit
// default-valued params, re-resolving that URL must NOT re-arm a fake hour)

function testExplicitRangeEqualToLiveDefaultIsNeverTreatedAsCustom() {
  const r = resolveDateRangeWithExpiration({ urlPresent: true, urlStart: DR_TODAY.start, urlEnd: DR_TODAY.end, stored: null, now: NOW, defaultDateRange: DR_TODAY })
  assert(r.dateExpiresAt === null, 'a URL that explicitly carries exactly today\'s rolling default must never be armed with an expiration')
  assert(r.expired === false)
}

function testUrlRewriteAfterExpiryDoesNotCascadeIntoAFakeNewWindow() {
  // Pass 1: URL still shows the (now-expired) custom range.
  const expiresAt = NOW + DATE_RANGE_EXPIRY_MS
  const pass1 = resolveDateRangeWithExpiration({ urlPresent: true, urlStart: CUSTOM.start, urlEnd: CUSTOM.end, stored: { ...CUSTOM, dateExpiresAt: expiresAt }, now: expiresAt + 1, defaultDateRange: DR_TODAY })
  assert(pass1.expired === true && pass1.start === DR_TODAY.start)
  // Pass 2: the caller has now rewritten the URL/storage to pass1's result
  // -- re-resolving that exact state must be a no-op, not a new "accept".
  const pass2 = resolveDateRangeWithExpiration({ urlPresent: true, urlStart: pass1.start, urlEnd: pass1.end, stored: { start: pass1.start, end: pass1.end, dateExpiresAt: pass1.dateExpiresAt }, now: expiresAt + 2, defaultDateRange: DR_TODAY })
  assert(pass2.dateExpiresAt === null, 'resolving the just-reset default-valued URL a second time must not manufacture a brand-new fake expiration')
}

// ── 12. Zero/invalid timestamps fail safely ─────────────────────────────

function testZeroOrInvalidStoredTimestampsFailSafely() {
  for (const badValue of [0, -1, NaN, Infinity, 'not-a-number', null, undefined]) {
    const stored = { ...CUSTOM, dateExpiresAt: badValue }
    const r = resolveDateRangeWithExpiration({ urlPresent: false, urlStart: null, urlEnd: null, stored, now: NOW, defaultDateRange: DR_TODAY })
    assert(r.start === DR_TODAY.start && r.end === DR_TODAY.end, `dateExpiresAt=${badValue} must fail safe to the rolling default, got ${JSON.stringify(r)}`)
    assert(r.dateExpiresAt === null)
  }
}

function testLoadStoredFiltersSanitizesInvalidTimestamps() {
  const store = installFakeLocalStorage()
  for (const badValue of [0, -5, NaN, 'soon', {}]) {
    store.set(FILTERS_STORAGE_KEY, JSON.stringify({ ...CUSTOM, locations: [], brands: [], stars: [], dateExpiresAt: badValue }))
    const loaded = loadStoredFilters()
    assert(loaded.dateExpiresAt === null, `loadStoredFilters must sanitize dateExpiresAt=${JSON.stringify(badValue)} to null, got ${loaded.dateExpiresAt}`)
  }
}

function testSaveStoredFiltersSanitizesInvalidTimestamps() {
  installFakeLocalStorage()
  saveStoredFilters({ ...CUSTOM, locations: [], brands: [], stars: [], dateExpiresAt: -1 })
  assert(loadStoredFilters().dateExpiresAt === null, 'saving an invalid dateExpiresAt must persist null, never the raw invalid value')
}

// ── 13. Corrupted localStorage fails safely (resolution never throws) ───

function testCorruptedLocalStorageNeverThrowsDuringResolution() {
  const store = installFakeLocalStorage()
  store.set(FILTERS_STORAGE_KEY, 'not valid json{')
  let threw = false
  let stored
  try { stored = loadStoredFilters() } catch { threw = true }
  assert(!threw && stored === null)
  let r
  try {
    r = resolveDateRangeWithExpiration({ urlPresent: false, urlStart: null, urlEnd: null, stored, now: NOW, defaultDateRange: DR_TODAY })
  } catch { threw = true }
  assert(!threw, 'resolution must never throw even when localStorage was corrupted')
  assert(r.start === DR_TODAY.start && r.end === DR_TODAY.end)
}

// ── 11. Reset clears custom date + expiration metadata ──────────────────

function testResetClearsStoredCustomDateAndExpiration() {
  installFakeLocalStorage()
  saveStoredFilters({ ...CUSTOM, locations: ['Casa Tequila Prime'], brands: [], stars: [4, 5], dateExpiresAt: NOW + DATE_RANGE_EXPIRY_MS })
  clearStoredFilters()
  assert(loadStoredFilters() === null, 'Reset must leave nothing usable stored -- including the expiration metadata')
}

// ── 5. Expiration resets ONLY dates, not location/brand/star ────────────

function testExpirationResetsOnlyDatesNotLocationBrandStar() {
  const expiresAt = NOW + DATE_RANGE_EXPIRY_MS
  const stored = { ...CUSTOM, locations: ['Casa Tequila Prime'], brands: [], stars: [4, 5], dateExpiresAt: expiresAt }
  const laterNow = expiresAt + 60 * 1000
  const { filters } = resolveLikeApp({ searchParams: new URLSearchParams(), stored, now: laterNow, defaultDateRange: DR_TODAY })
  assert(filters.start === DR_TODAY.start && filters.end === DR_TODAY.end, 'the date portion must fall back to the rolling default')
  assert(JSON.stringify(filters.locations) === JSON.stringify(['Casa Tequila Prime']), 'locations must survive date expiration untouched')
  assert(JSON.stringify(filters.stars) === JSON.stringify([4, 5]), 'stars must survive date expiration untouched')
}

// ── 15/16. /today -> /reviews -> /reports (plain-path nav, no query
//           string) within the hour preserves the range; after expiry all
//           three resolve to the rolling week ─────────────────────────────

function testNavigatingBetweenPlainRoutesPreservesCustomRangeWithinTheHour() {
  const expiresAt = NOW + DATE_RANGE_EXPIRY_MS
  const stored = { ...CUSTOM, locations: [], brands: [], stars: [], dateExpiresAt: expiresAt }
  const withinWindowNow = NOW + 20 * 60 * 1000
  for (const route of ['/today', '/reviews', '/reports']) {
    const { filters } = resolveLikeApp({ searchParams: new URLSearchParams(), stored, now: withinWindowNow, defaultDateRange: DR_TODAY })
    assert(filters.start === CUSTOM.start && filters.end === CUSTOM.end, `${route}: custom range must still apply within the hour`)
    assert(filters._dateExpiresAt === expiresAt, `${route}: expiration must not have moved just from navigating`)
  }
}

function testNavigatingBetweenPlainRoutesAfterExpiryAllUseRollingWeek() {
  const expiresAt = NOW + DATE_RANGE_EXPIRY_MS
  const stored = { ...CUSTOM, locations: [], brands: [], stars: [], dateExpiresAt: expiresAt }
  const pastWindowNow = expiresAt + 5 * 60 * 1000
  for (const route of ['/today', '/reviews', '/reports']) {
    const { filters } = resolveLikeApp({ searchParams: new URLSearchParams(), stored, now: pastWindowNow, defaultDateRange: DR_TODAY })
    assert(filters.start === DR_TODAY.start && filters.end === DR_TODAY.end, `${route}: must use the rolling week once expired`)
    assert(filters._dateExpiresAt === null)
  }
}

// ── 8. Browser close/reopen semantics, simulated purely through the
//        persisted timestamp (no real timers, no real browser) ─────────

function testBrowserCloseAndReopenWithinTheHourStillHonorsTheCustomRange() {
  const expiresAt = NOW + DATE_RANGE_EXPIRY_MS
  const stored = { ...CUSTOM, dateExpiresAt: expiresAt }
  // "Reopen" = a brand-new resolution pass reading the same persisted
  // record, with no in-memory state carried over at all (no timers, no
  // React state) -- only `now` moved forward.
  const reopenNow = NOW + 40 * 60 * 1000
  const r = resolveDateRangeWithExpiration({ urlPresent: false, urlStart: null, urlEnd: null, stored, now: reopenNow, defaultDateRange: DR_TODAY })
  assert(r.start === CUSTOM.start && r.end === CUSTOM.end)
  assert(r.dateExpiresAt === expiresAt)
}

function testBrowserCloseAndReopenPastTheHourRevertsToRollingDefault() {
  const expiresAt = NOW + DATE_RANGE_EXPIRY_MS
  const stored = { ...CUSTOM, dateExpiresAt: expiresAt }
  const reopenNow = expiresAt + 2 * 60 * 60 * 1000 // reopened 2 hours after expiry (e.g. next morning)
  const r = resolveDateRangeWithExpiration({ urlPresent: false, urlStart: null, urlEnd: null, stored, now: reopenNow, defaultDateRange: DR_TODAY })
  assert(r.start === DR_TODAY.start && r.end === DR_TODAY.end)
  assert(r.dateExpiresAt === null)
}

// ── A persisted range created yesterday, expired today, recomputes the
//    NEW 7-day window (never a stale/frozen one) ─────────────────────────

function testExpiredYesterdaysRangeRecomputesAgainstTodaysFreshDefaultNotYesterdays() {
  const yesterdayDefault = { start: '2026-08-18', end: '2026-08-25' }
  const todayDefault = { start: '2026-08-19', end: '2026-08-26' }
  const stored = { ...CUSTOM, dateExpiresAt: NOW - 1000 } // expired
  // Two independent resolutions with two DIFFERENT defaultDateRange values
  // (simulating "yesterday's app instance" vs "today's") prove the function
  // never caches/reuses a prior default -- it always reflects whichever
  // fresh defaultDateRange the caller (App.jsx, calling getDefaultDateRange
  // anew every effect run) hands it for THIS instant.
  const rYesterday = resolveDateRangeWithExpiration({ urlPresent: false, urlStart: null, urlEnd: null, stored, now: NOW, defaultDateRange: yesterdayDefault })
  const rToday = resolveDateRangeWithExpiration({ urlPresent: false, urlStart: null, urlEnd: null, stored, now: NOW, defaultDateRange: todayDefault })
  assert(rYesterday.start === yesterdayDefault.start && rYesterday.end === yesterdayDefault.end)
  assert(rToday.start === todayDefault.start && rToday.end === todayDefault.end)
  assert(rToday.start !== rYesterday.start, 'the resolved default must track whatever fresh window is passed in, never a stale prior one')
}

// ── 17. Location-manager authorization still overrides restored filters ──

function testAuthorizationOverridesRestoredFiltersRegardlessOfDateExpiry() {
  const stored = { start: '2026-08-01', end: '2026-08-15', locations: ['Farmington', 'Casa Tequila Prime'], brands: [], stars: [], dateExpiresAt: NOW + DATE_RANGE_EXPIRY_MS }
  const allowedLocationNames = ['Casa Tequila Prime'] // this account may only ever see this one location
  const { filters } = resolveLikeApp({ searchParams: new URLSearchParams(), stored, now: NOW + 10 * 60 * 1000, defaultDateRange: DR_TODAY, allowedLocationNames })
  assert(JSON.stringify(filters.locations) === JSON.stringify(['Casa Tequila Prime']), 'an unauthorized location restored from storage must be stripped regardless of the (still-valid) custom date range')

  // Same check again, but now past expiry -- authorization must still hold.
  const { filters: filtersAfterExpiry } = resolveLikeApp({ searchParams: new URLSearchParams(), stored, now: NOW + 2 * DATE_RANGE_EXPIRY_MS, defaultDateRange: DR_TODAY, allowedLocationNames })
  assert(JSON.stringify(filtersAfterExpiry.locations) === JSON.stringify(['Casa Tequila Prime']), 'authorization must still hold after the date itself has expired and reset')
}

function testAuthorizationOverridesUrlSuppliedLocationsToo() {
  const sp = new URLSearchParams('start=2026-08-01&end=2026-08-15&locations=' + encodeURIComponent('Farmington,Casa Tequila Prime'))
  const allowedLocationNames = ['Casa Tequila Prime']
  const { filters } = resolveLikeApp({ searchParams: sp, stored: null, now: NOW, defaultDateRange: DR_TODAY, allowedLocationNames })
  assert(JSON.stringify(filters.locations) === JSON.stringify(['Casa Tequila Prime']), 'a URL-supplied unauthorized location must be stripped, even on a freshly-accepted custom date range')
}

function main() {
  run('default load with nothing stored/no URL resolves to the rolling 7-day default', testDefaultLoadNoStoredNoUrlResolvesToRollingDefault)
  run('a custom date range is accepted and timestamped immediately', testCustomDateIsAcceptedAndTimestampedImmediately)
  run('a refresh within 59 minutes preserves the same custom dates and does not renew the expiration', testRefreshWithin59MinutesPreservesSameCustomDatesAndDoesNotRenew)
  run('a plain page reload never restarts the clock, even across repeated reloads', testPlainReloadNeverRestartsTheClock)
  run('expiration after 60+ minutes falls back to the rolling default', testExpirationAfter60PlusMinutesFallsBackToRollingDefault)
  run('the expiry boundary is inclusive of the exact expiration instant', testExpiryBoundaryIsInclusiveOfTheExactMoment)
  run('changing the date again restarts the 1-hour window from the moment of the change', testChangingTheDateAgainRestartsTheWindow)
  run('a fresh shared URL with nothing stored is honored and timestamped', testFreshSharedUrlWithNothingStoredIsHonoredAndTimestamped)
  run('a shared URL different from an expired stored custom range is treated as a new acceptance', testSharedUrlDifferentFromAnExpiredStoredCustomRangeIsTreatedAsNewAcceptance)
  run('an explicit range equal to the live default is never treated as custom', testExplicitRangeEqualToLiveDefaultIsNeverTreatedAsCustom)
  run('rewriting the URL after expiry does not cascade into a fake new window', testUrlRewriteAfterExpiryDoesNotCascadeIntoAFakeNewWindow)
  run('zero/invalid stored timestamps fail safely to the rolling default', testZeroOrInvalidStoredTimestampsFailSafely)
  run('loadStoredFilters sanitizes invalid timestamps to null', testLoadStoredFiltersSanitizesInvalidTimestamps)
  run('saveStoredFilters sanitizes invalid timestamps to null', testSaveStoredFiltersSanitizesInvalidTimestamps)
  run('corrupted localStorage never throws during resolution', testCorruptedLocalStorageNeverThrowsDuringResolution)
  run('Reset clears the stored custom date and its expiration metadata', testResetClearsStoredCustomDateAndExpiration)
  run('expiration resets only start/end, never location/brand/star', testExpirationResetsOnlyDatesNotLocationBrandStar)
  run('navigating between plain routes (/today, /reviews, /reports) preserves the custom range within the hour', testNavigatingBetweenPlainRoutesPreservesCustomRangeWithinTheHour)
  run('navigating between plain routes after expiry all resolve to the rolling week', testNavigatingBetweenPlainRoutesAfterExpiryAllUseRollingWeek)
  run('browser close/reopen within the hour (simulated via persisted timestamp) still honors the custom range', testBrowserCloseAndReopenWithinTheHourStillHonorsTheCustomRange)
  run('browser close/reopen past the hour (simulated via persisted timestamp) reverts to the rolling default', testBrowserCloseAndReopenPastTheHourRevertsToRollingDefault)
  run('an expired range created yesterday recomputes against today\'s fresh default, never a stale one', testExpiredYesterdaysRangeRecomputesAgainstTodaysFreshDefaultNotYesterdays)
  run('authorization overrides restored filters regardless of date-expiry state', testAuthorizationOverridesRestoredFiltersRegardlessOfDateExpiry)
  run('authorization overrides URL-supplied locations on a freshly-accepted custom date too', testAuthorizationOverridesUrlSuppliedLocationsToo)

  console.log()
  if (results.every(Boolean)) {
    console.log(`ALL ${results.length} TESTS PASSED`)
    process.exit(0)
  }
  console.log(`${results.filter(r => !r).length} of ${results.length} TESTS FAILED`)
  process.exit(1)
}

main()
