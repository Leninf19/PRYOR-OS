import { useEffect, useRef, useState } from 'react'
import { computePeriodMetrics } from '../utils/dataUtils.js'

const MIN_LOCATION_SAMPLE = 5

function topTag(reviews, field) {
  const counts = {}
  reviews.forEach(r => (r[field] || []).forEach(t => { counts[t] = (counts[t] || 0) + 1 }))
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
  return sorted[0] ? { tag: sorted[0][0].replace(/_/g, ' '), count: sorted[0][1] } : null
}

function bestAndWorstLocations(filtered, prevFiltered) {
  const byLoc = {}, prevByLoc = {}
  filtered.forEach(r => { if (r.star_rating != null) (byLoc[r.location_name] ??= []).push(r.star_rating) })
  prevFiltered.forEach(r => { if (r.star_rating != null) (prevByLoc[r.location_name] ??= []).push(r.star_rating) })

  const avg = arr => arr.reduce((s, n) => s + n, 0) / arr.length
  let best = null, worst = null
  Object.keys(byLoc).forEach(name => {
    const cur = byLoc[name], prev = prevByLoc[name]
    if (!prev || cur.length < MIN_LOCATION_SAMPLE || prev.length < MIN_LOCATION_SAMPLE) return
    const delta = +(avg(cur) - avg(prev)).toFixed(2)
    if (!best || delta > best.delta) best = { name, delta }
    if (!worst || delta < worst.delta) worst = { name, delta }
  })
  return { best, worst }
}

export function buildBriefPayload(filtered, prevFiltered, periodLabel, prevPeriodLabel) {
  const m = computePeriodMetrics(filtered, prevFiltered)
  const complaint = topTag(filtered, 'complaint_tags')
  const praise = topTag(filtered, 'praise_tags')
  const { best, worst } = bestAndWorstLocations(filtered, prevFiltered)

  return {
    periodLabel, prevPeriodLabel,
    totalReviews: m.reviews.value,
    avgRating: m.avgRating.value, avgRatingPrev: m.avgRating.prev,
    positivePct: m.positivePct.value, negativePct: m.negativePct.value,
    netSentiment: m.netSentiment.value,
    unanswered: m.unanswered.value,
    topComplaint: complaint?.tag ?? null, topComplaintCount: complaint?.count ?? 0,
    topPraise: praise?.tag ?? null, topPraiseCount: praise?.count ?? 0,
    bestLocation: best?.name ?? null, bestLocationDelta: best?.delta ?? null,
    worstLocation: worst?.name ?? null, worstLocationDelta: worst?.delta ?? null,
  }
}

/**
 * Live, filter-reactive executive briefing. Debounced so rapid filter changes
 * (e.g. dragging a date range) don't fire a Claude call per keystroke, and
 * memoized per unique metrics payload so flipping back to a previously-seen
 * filter state doesn't re-bill. Callers should fall back to the pipeline's
 * static company-summary.json on error (no API key configured, network
 * failure, etc.) -- this hook surfaces `error` for exactly that purpose.
 */
export function useExecutiveBrief(filtered, prevFiltered, periodLabel, prevPeriodLabel) {
  const [state, setState] = useState({ text: null, loading: false, error: null })
  const cacheRef = useRef(new Map())
  const timerRef = useRef(null)
  const reqIdRef = useRef(0)

  useEffect(() => {
    if (!filtered?.length) {
      setState({ text: null, loading: false, error: null })
      return
    }

    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      const payload = buildBriefPayload(filtered, prevFiltered, periodLabel, prevPeriodLabel)
      const key = JSON.stringify(payload)

      if (cacheRef.current.has(key)) {
        setState({ text: cacheRef.current.get(key), loading: false, error: null })
        return
      }

      const reqId = ++reqIdRef.current
      setState(s => ({ ...s, loading: true, error: null }))
      try {
        const res = await fetch('/api/executive-brief', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
        if (reqId !== reqIdRef.current) return // a newer request superseded this one
        cacheRef.current.set(key, data.briefing)
        setState({ text: data.briefing, loading: false, error: null })
      } catch (err) {
        if (reqId !== reqIdRef.current) return
        setState({ text: null, loading: false, error: err.message })
      }
    }, 800)

    return () => clearTimeout(timerRef.current)
  }, [filtered, prevFiltered, periodLabel, prevPeriodLabel])

  return state
}
