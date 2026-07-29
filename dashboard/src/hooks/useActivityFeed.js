import { useMemo } from 'react'
import {
  useCompanySummary, useWeeklyReportData, usePredictiveAlerts, useActionCenter,
} from './useIntelligence.js'
import { useReviewWorkspace } from './useReviewWorkspace.js'
import { useActionWorkspace } from './useActionWorkspace.js'
import { getCategoryChanges, getLocationMomentum } from '../utils/dataUtils.js'
import { COMPLAINT_CATEGORIES, PRAISE_CATEGORIES } from '../utils/textAnalysis.js'

const NEW_REVIEW_LIMIT = 15

function labelFor(id, map) {
  return map[id]?.label ?? id.replace(/_/g, ' ')
}

function buildLabelMaps() {
  const complaints = {}, praises = {}
  COMPLAINT_CATEGORIES.forEach(c => { complaints[c.id] = c })
  PRAISE_CATEGORIES.forEach(p => { praises[p.id] = p })
  return { complaints, praises }
}
const LABELS = buildLabelMaps()

/**
 * Merges several already-available data sources into one company-wide
 * activity feed. Two kinds of entries, kept visually distinct rather than
 * faked into false precision:
 *  - `timed` events have a real timestamp (workspace history, new reviews,
 *    report generation) and are shown newest-first, grouped by day.
 *  - `signals` are period-level (category/location momentum, alerts) with
 *    no exact clock time, and are shown as a separate "this period" list.
 */
export function useActivityFeed(allReviews, filtered, prevFiltered, periodLabel) {
  const { data: summary }    = useCompanySummary()
  const { data: weekly }     = useWeeklyReportData()
  const { data: predictive } = usePredictiveAlerts()
  const { data: actions }    = useActionCenter()
  const { data: reviewWs }   = useReviewWorkspace()
  const { data: actionWs }   = useActionWorkspace()

  const reviewById = useMemo(() => {
    const out = {}
    ;(allReviews ?? []).forEach(r => {
      const id = r.review_id || r.review_url || `${r.review_date}-${r.reviewer_name}`
      out[id] = r
    })
    return out
  }, [allReviews])

  const actionTitleById = useMemo(() => {
    const out = {}
    ;(actions ?? []).forEach(a => { out[a.id] = a.title })
    return out
  }, [actions])

  const timed = useMemo(() => {
    const events = []

    Object.entries(reviewWs ?? {}).forEach(([id, entry]) => {
      const r = reviewById[id]
      ;(entry.history ?? []).forEach((h, i) => {
        events.push({
          id: `review-${id}-${i}`, at: h.at, icon: '💬',
          title: h.action,
          sub: r ? `${r.reviewer_name || 'Anonymous'} · ${r.location_name}` : 'Review',
          path: '/reviews',
        })
      })
    })

    Object.entries(actionWs ?? {}).forEach(([id, entry]) => {
      ;(entry.history ?? []).forEach((h, i) => {
        events.push({
          id: `action-${id}-${i}`, at: h.at, icon: '🛠',
          title: h.action,
          sub: actionTitleById[id] ?? 'Action Center recommendation',
          path: '/actions',
        })
      })
    })

    if (summary?.generatedAt) {
      events.push({
        id: 'company-summary', at: summary.generatedAt, icon: '✦',
        title: 'Executive summary regenerated', sub: 'Pipeline run', path: '/today',
      })
    }
    if (weekly?.generatedAt) {
      events.push({
        id: 'weekly-report', at: weekly.generatedAt, icon: '📋',
        title: 'Weekly report generated', sub: weekly.weekStr ?? '', path: '/reports',
      })
    }

    const recentReviews = [...(filtered ?? [])]
      .filter(r => r.review_date)
      .sort((a, b) => b.review_date.localeCompare(a.review_date))
      .slice(0, NEW_REVIEW_LIMIT)
    recentReviews.forEach(r => {
      events.push({
        id: `newreview-${r.review_id || r.review_url || r.review_date + r.reviewer_name}`,
        at: `${r.review_date}T12:00:00`, icon: r.star_rating <= 2 ? '⚠️' : '⭐',
        title: `New ${r.star_rating ?? '?'}★ review`,
        sub: `${r.reviewer_name || 'Anonymous'} · ${r.location_name}`,
        path: '/reviews',
      })
    })

    return events
      .filter(e => e.at)
      .sort((a, b) => new Date(b.at) - new Date(a.at))
  }, [reviewWs, actionWs, reviewById, actionTitleById, summary, weekly, filtered])

  const signals = useMemo(() => {
    const out = []
    const changes = getCategoryChanges(filtered ?? [], prevFiltered ?? [])
    changes.complaints.new.forEach(c => out.push({
      icon: '🔴', title: `New complaint theme: ${labelFor(c.id, LABELS.complaints)}`,
      sub: `${c.count} mentions this period`, path: '/insights',
    }))
    changes.complaints.resolved.forEach(c => out.push({
      icon: '✅', title: `Complaint theme resolved: ${labelFor(c.id, LABELS.complaints)}`,
      sub: `Was ${c.prevCount} mentions, now below threshold`, path: '/insights',
    }))
    changes.praises.new.forEach(p => out.push({
      icon: '⭐', title: `New praise theme: ${labelFor(p.id, LABELS.praises)}`,
      sub: `${p.count} mentions this period`, path: '/studio',
    }))

    getLocationMomentum(filtered ?? [], prevFiltered ?? []).forEach(l => {
      if (Math.abs(l.delta) < 0.15) return
      out.push({
        icon: l.delta > 0 ? '📈' : '📉',
        title: `${l.name} ${l.delta > 0 ? 'gaining' : 'losing'} momentum`,
        sub: `${l.prevAvg}★ → ${l.curAvg}★ (${l.delta > 0 ? '+' : ''}${l.delta})`,
        path: '/what-changed',
      })
    })

    const predAlerts = Array.isArray(predictive) ? predictive : (predictive?.alerts ?? [])
    predAlerts.forEach(a => out.push({ icon: '⚡', title: 'Predictive alert', sub: a.message, path: '/alerts' }))

    return out
  }, [filtered, prevFiltered, predictive])

  return { timed, signals, periodLabel }
}
