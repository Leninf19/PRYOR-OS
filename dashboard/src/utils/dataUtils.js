// ── Brand detection ───────────────────────────────────────────────────────────
export const BRANDS = ['Los Tres Amigos', 'Los Tres Mex Grill', 'Mi Lindo San Blas', 'Rio Luna', 'Casa Tequila']
const BRAND_COLORS  = {
  'Los Tres Amigos':    '#bb9230',
  'Los Tres Mex Grill': '#0369a1',
  'Mi Lindo San Blas':  '#7c3aed',
  'Rio Luna':           '#be185d',
  'Casa Tequila':       '#15803d',
  'Other':              '#5e4530',
}

export function getBrand(name) {
  for (const b of BRANDS) if (name.startsWith(b)) return b
  return 'Other'
}
export function getBrandColor(brand) { return BRAND_COLORS[brand] || BRAND_COLORS.Other }

export function isUnverified(locationName, city) {
  const knownBrand = BRANDS.some(b => locationName.startsWith(b))
  return !knownBrand || !city || city === 'Unknown' || city === ''
}

// ── Confidence ────────────────────────────────────────────────────────────────
export function getConfidence(n) {
  if (n === 0)  return { level: 0, label: 'Insufficient data', color: 'text-stone-400' }
  if (n < 5)    return { level: 1, label: 'Low confidence',    color: 'text-orange-500' }
  if (n < 10)   return { level: 2, label: 'Moderate',          color: 'text-yellow-600' }
  return                { level: 3, label: 'Good',             color: 'text-emerald-600' }
}

// ── Sentiment ─────────────────────────────────────────────────────────────────
// AI-derived sentiment judges the actual review text (a 5★ review can read as
// negative, a 3★ review can read as positive) -- see ai_engine.py's
// classify_reviews_batch. Falls back to star-based bucketing only for reviews
// the pipeline hasn't classified yet (brand new since the last run).
export function sentimentBucket(r) {
  if (r.ai_sentiment === 'positive' || r.ai_sentiment === 'neutral' || r.ai_sentiment === 'negative') {
    return r.ai_sentiment
  }
  if (r.star_rating == null) return null
  if (r.star_rating >= 4) return 'positive'
  if (r.star_rating === 3) return 'neutral'
  return 'negative'
}

export function getSentiment(reviews) {
  const n = reviews.length
  if (n === 0) return { n: 0, positiveN: 0, neutralN: 0, badN: 0, positive: 0, neutral: 0, bad: 0 }
  const buckets = reviews.map(sentimentBucket)
  const positiveN = buckets.filter(b => b === 'positive').length
  const neutralN  = buckets.filter(b => b === 'neutral').length
  const badN      = buckets.filter(b => b === 'negative').length
  return {
    n, positiveN, neutralN, badN,
    positive: positiveN / n * 100,
    neutral:  neutralN  / n * 100,
    bad:      badN      / n * 100,
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────
export function fmtPct(v) {
  if (v == null || isNaN(v)) return '—'
  return v.toFixed(1) + '%'
}
export function fmtRating(v) {
  if (v == null || isNaN(v)) return '—'
  return v.toFixed(2)
}
export function stars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n) }

// ── Date helpers ──────────────────────────────────────────────────────────────
export function parseYM(ym) {
  // 'YYYY-MM' → Date (1st of month)
  const [y, m] = ym.split('-').map(Number)
  return new Date(y, m - 1, 1)
}
export function toYM(d) {
  if (!d || typeof d !== 'string') return ''
  return d.slice(0, 7)
}
export function ymLabel(ym, isPartial, lastDate) {
  const [y, m] = ym.split('-').map(Number)
  const mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]
  if (isPartial) return `${mn} ${y} (through ${lastDate})`
  return `${mn} ${y}`
}

export function getDateBounds(reviews) {
  const dates = reviews.map(r => r.review_date).filter(Boolean).sort()
  return { min: dates[0] || '', max: dates[dates.length - 1] || '' }
}

export function getDefaultDateRange(reviews) {
  // Rolling 7-day window ending today -- "the day of and a week before" --
  // rather than snapping to the latest complete calendar month found in the
  // data, which made the default view look frozen on whatever month the
  // most recent review happened to land in.
  const now   = new Date()
  const end   = now.toISOString().slice(0, 10)
  const start = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
  const { max } = getDateBounds(reviews)
  return { start, end, latestDate: max }
}

// ── Filter reviews ────────────────────────────────────────────────────────────
export function filterReviews(reviews, { brands, locations, start, end, stars: starFilter }) {
  return reviews.filter(r => {
    if (brands    && brands.length    && !brands.includes(getBrand(r.location_name))) return false
    if (locations && locations.length && !locations.includes(r.location_name))        return false
    if (start && r.review_date < start) return false
    if (end   && r.review_date > end)   return false
    if (starFilter && starFilter.length && !starFilter.includes(r.star_rating)) return false
    return true
  })
}

// ── Monthly trend ─────────────────────────────────────────────────────────────
export function getMonthlyTrend(reviews) {
  const map = {}
  reviews.forEach(r => {
    const ym = toYM(r.review_date)
    if (!ym) return
    if (!map[ym]) map[ym] = { ym, sum: 0, count: 0 }
    map[ym].sum += r.star_rating
    map[ym].count++
  })
  return Object.values(map)
    .sort((a, b) => a.ym.localeCompare(b.ym))
    .map(d => ({ ym: d.ym, count: d.count, avg: d.count > 0 ? +(d.sum / d.count).toFixed(2) : null }))
}

// ── Location stats ────────────────────────────────────────────────────────────
// `filters` (optional) lets the sparkline respect brand/location/star filters
// and anchor its trailing 6-month window to the selected period's end date,
// instead of always showing the lifetime trend regardless of active filters.
export function getLocationStats(allReviews, periodReviews, filters) {
  const sparkSource = filters
    ? filterReviews(allReviews, { brands: filters.brands, locations: filters.locations, stars: filters.stars, end: filters.end })
    : allReviews
  const locs = [...new Set(allReviews.map(r => r.location_name))].sort()
  return locs.map(name => {
    const all    = allReviews.filter(r => r.location_name === name)
    const period = periodReviews.filter(r => r.location_name === name)
    const spark_all = sparkSource.filter(r => r.location_name === name)
    const city   = all[0]?.city || ''
    const brand  = getBrand(name)
    const lifetimeRating = all.length ? +(all.reduce((s, r) => s + r.star_rating, 0) / all.length).toFixed(2) : null
    const periodSentiment = getSentiment(period)
    // Star breakdown 1-5 for period
    const starBreakdown = [1,2,3,4,5].map(s => ({ star: s, count: period.filter(r => r.star_rating === s).length }))
    // Sparkline: last 6 months up to the selected period's end, honoring brand/location/star filters
    const spark = buildSparkline(spark_all)
    return {
      name, city, brand,
      lifetimeRating,
      lifetimeCount: all.length,
      periodSentiment,
      starBreakdown,
      confidence: getConfidence(period.length),
      isUnverified: isUnverified(name, city),
      spark,
    }
  })
}

function buildSparkline(reviews) {
  const map = {}
  reviews.forEach(r => {
    const ym = toYM(r.review_date)
    if (!map[ym]) map[ym] = { sum: 0, n: 0 }
    map[ym].sum += r.star_rating
    map[ym].n++
  })
  const sorted = Object.entries(map).sort((a, b) => a[0].localeCompare(b[0])).slice(-6)
  return sorted.map(([ym, d]) => ({ ym, avg: d.n > 0 ? +(d.sum / d.n).toFixed(2) : null }))
}

// ── Rankings ──────────────────────────────────────────────────────────────────
export function getRankings(periodReviews, prevReviews) {
  const locs = [...new Set([...periodReviews, ...prevReviews].map(r => r.location_name))]
  return locs.map(name => {
    const cur  = periodReviews.filter(r => r.location_name === name)
    const prev = prevReviews.filter(r => r.location_name === name)
    const curSent  = getSentiment(cur)
    const prevSent = getSentiment(prev)
    const curConf  = getConfidence(cur.length)
    const prevConf = getConfidence(prev.length)
    const canCompare = curConf.level >= 3 && prevConf.level >= 3
    const delta = canCompare ? +(curSent.positive - prevSent.positive).toFixed(1) : null
    return {
      name,
      brand: getBrand(name),
      curN: cur.length,
      prevN: prev.length,
      curPositive: curSent.positive,
      prevPositive: prevSent.positive,
      curConfidence: curConf,
      prevConfidence: prevConf,
      canCompare,
      delta,
    }
  }).sort((a, b) => b.curPositive - a.curPositive)
}

// ── Unique locations and brands from dataset ───────────────────────────────────
export function getUniqueLocations(reviews) {
  return [...new Set(reviews.map(r => r.location_name))].sort()
}
export function getUniqueBrands(reviews) {
  return [...new Set(reviews.map(r => getBrand(r.location_name)))].filter(b => b !== 'Other').sort()
}

// ── Rating breakdown (★5→★1 with trend vs. a prior period) ────────────────────
export function getRatingBreakdown(reviews, prevReviews = []) {
  const n = reviews.length
  const prevN = prevReviews.length
  return [5, 4, 3, 2, 1].map(star => {
    const count = reviews.filter(r => r.star_rating === star).length
    const prevCount = prevReviews.filter(r => r.star_rating === star).length
    const pct = n ? count / n * 100 : 0
    const prevPct = prevN ? prevCount / prevN * 100 : 0
    const delta = pct - prevPct
    return {
      star, count, pct, prevCount, prevPct,
      delta: +delta.toFixed(1),
      trend: prevN === 0 ? null : delta > 1 ? 'up' : delta < -1 ? 'down' : 'stable',
    }
  })
}

// ── Period comparison metrics ──────────────────────────────────────────────────
// Note: "response time" (how long it took to reply) isn't computable — the
// review schema only captures whether/what the owner replied, not when, since
// that timestamp isn't exposed by the data source. Every other metric here
// is real and filter-reactive.
function daySpan(reviews) {
  const dates = reviews.map(r => r.review_date).filter(Boolean).sort()
  if (!dates.length) return 0
  const start = new Date(dates[0]).getTime()
  const end   = new Date(dates[dates.length - 1]).getTime()
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1)
}

function metric(value, prev) {
  const pctChange = (value != null && prev != null && prev !== 0) ? +((value - prev) / prev * 100).toFixed(1) : null
  return { value, prev, pctChange }
}

export function computePeriodMetrics(reviews, prevReviews = []) {
  const sent     = getSentiment(reviews)
  const prevSent = getSentiment(prevReviews)

  const rated     = reviews.filter(r => r.star_rating != null)
  const prevRated = prevReviews.filter(r => r.star_rating != null)
  const avgRating     = rated.length     ? rated.reduce((s, r) => s + r.star_rating, 0) / rated.length         : null
  const prevAvgRating = prevRated.length ? prevRated.reduce((s, r) => s + r.star_rating, 0) / prevRated.length : null

  const negative     = reviews.filter(r => r.star_rating != null && r.star_rating <= 2)
  const prevNegative = prevReviews.filter(r => r.star_rating != null && r.star_rating <= 2)
  const negReplied     = negative.filter(r => (r.owner_response || '').trim())
  const prevNegReplied = prevNegative.filter(r => (r.owner_response || '').trim())
  const responseRate     = negative.length     ? negReplied.length     / negative.length     * 100 : null
  const prevResponseRate = prevNegative.length ? prevNegReplied.length / prevNegative.length * 100 : null

  const allReplied     = reviews.filter(r => (r.owner_response || '').trim())
  const prevAllReplied = prevReviews.filter(r => (r.owner_response || '').trim())

  const days     = daySpan(reviews)
  const prevDays = daySpan(prevReviews)

  return {
    reviews:       metric(reviews.length, prevReviews.length),
    avgRating:     metric(avgRating != null ? +avgRating.toFixed(2) : null, prevAvgRating != null ? +prevAvgRating.toFixed(2) : null),
    positivePct:   metric(+sent.positive.toFixed(1), +prevSent.positive.toFixed(1)),
    neutralPct:    metric(+sent.neutral.toFixed(1),  +prevSent.neutral.toFixed(1)),
    negativePct:   metric(+sent.bad.toFixed(1),      +prevSent.bad.toFixed(1)),
    responseRate:  metric(responseRate != null ? +responseRate.toFixed(1) : null, prevResponseRate != null ? +prevResponseRate.toFixed(1) : null),
    reviewsPerDay: metric(+(reviews.length / days).toFixed(2), prevDays ? +(prevReviews.length / prevDays).toFixed(2) : null),
    ownerReplies:  metric(allReplied.length, prevAllReplied.length),
    unanswered:    metric(negative.length - negReplied.length, prevNegative.length - prevNegReplied.length),
    netSentiment:  metric(+(sent.positive - sent.bad).toFixed(1), +(prevSent.positive - prevSent.bad).toFixed(1)),
  }
}

// ── Category changes (for the "What Changed?" page) ────────────────────────────
// Reads each review's already-classified complaint_tags/praise_tags (set by the
// pipeline's classify_review()) to find categories that crossed the minCount
// threshold between periods -- "new" this period, "resolved" since last period,
// or still present but meaningfully up/down.
function _tallyTags(reviews, field) {
  const counts = {}
  reviews.forEach(r => (r[field] || []).forEach(t => { counts[t] = (counts[t] || 0) + 1 }))
  return counts
}

function _diffTags(cur, prev, minCount = 2) {
  const allIds = new Set([...Object.keys(cur), ...Object.keys(prev)])
  const fresh = [], resolved = [], changed = []
  allIds.forEach(id => {
    const c = cur[id] || 0, p = prev[id] || 0
    if (c >= minCount && p < minCount) fresh.push({ id, count: c, prevCount: p })
    else if (p >= minCount && c < minCount) resolved.push({ id, count: c, prevCount: p })
    else if (c >= minCount || p >= minCount) changed.push({ id, count: c, prevCount: p, delta: c - p })
  })
  return {
    new: fresh.sort((a, b) => b.count - a.count),
    resolved: resolved.sort((a, b) => b.prevCount - a.prevCount),
    changed: changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
  }
}

export function getCategoryChanges(filtered, prevFiltered, minCount = 2) {
  return {
    complaints: _diffTags(_tallyTags(filtered, 'complaint_tags'), _tallyTags(prevFiltered, 'complaint_tags'), minCount),
    praises:    _diffTags(_tallyTags(filtered, 'praise_tags'),    _tallyTags(prevFiltered, 'praise_tags'),    minCount),
  }
}

// ── Location momentum (for the "What Changed?" page) ────────────────────────────
// All locations with enough sample size in both periods, sorted by rating
// delta -- top of the list is gaining momentum, bottom is losing it.
export function getLocationMomentum(filtered, prevFiltered, minSample = 5) {
  const byLoc = {}, prevByLoc = {}
  filtered.forEach(r => { if (r.star_rating != null) (byLoc[r.location_name] ??= []).push(r.star_rating) })
  prevFiltered.forEach(r => { if (r.star_rating != null) (prevByLoc[r.location_name] ??= []).push(r.star_rating) })

  const avg = arr => arr.reduce((s, n) => s + n, 0) / arr.length
  const out = []
  Object.keys(byLoc).forEach(name => {
    const cur = byLoc[name], prev = prevByLoc[name]
    if (!prev || cur.length < minSample || prev.length < minSample) return
    out.push({
      name, curAvg: +avg(cur).toFixed(2), prevAvg: +avg(prev).toFixed(2),
      delta: +(avg(cur) - avg(prev)).toFixed(2), curN: cur.length, prevN: prev.length,
    })
  })
  return out.sort((a, b) => b.delta - a.delta)
}
