import { useMemo } from 'react'
import { usePriorityDigest } from './usePriorityDigest.js'
import { useExecutiveBrief } from './useExecutiveBrief.js'
import { useCompanySummary, useMonthlyTrend, useLocationStats, useActionItems, useKPIs } from './useIntelligence.js'
import { mirroredPrevRange } from '../utils/dataUtils.js'

const OVERDUE_HOURS = 48

// Same noon-anchoring convention ExecutiveDashboard.jsx's hoursToRespond()
// already uses for date-only fields (review_date has no time-of-day).
function hoursSinceReview(review) {
  if (!review.review_date) return null
  return (Date.now() - new Date(`${review.review_date}T12:00:00`).getTime()) / 3_600_000
}

/**
 * M4 -- the single hook Today.jsx composes from. Consolidates the three
 * previously-overlapping "what's happening" hooks (usePriorityDigest,
 * useExecutiveBrief, useActivityFeed) into one call site: this hook reuses
 * the first two directly (their composition logic already does exactly what
 * Today needs, unchanged) and adds the two pieces of data Today's wireframe
 * needs that none of the three old hooks produced -- reply-backlog counts,
 * the chart data sources (monthly trend, location stats), and Overview's KPI
 * cards (useKPIs -- required verbatim by the Engineering Implementation Plan
 * v1.0's Component Inventory). It does not
 * re-fetch or re-derive anything an existing hook/pure function already
 * computes; see priorityDigest.js's recentLosses for the one genuinely new
 * pure computation this milestone added (a mirror of its existing recentWins).
 *
 * useActivityFeed.js is intentionally NOT composed here -- Today's in-page
 * History drawer (Navigation Specification v1.0's "History available as an
 * in-page tab/drawer, not a route") calls it directly, since its output
 * (timed/signals) isn't part of the above-the-fold digest.
 */
export function useTodayDigest(filtered, prevFiltered, allReviews, filters) {
  const periodLabel = filters?.start && filters?.end ? `${filters.start} — ${filters.end}` : null
  const prevPeriodLabel = mirroredPrevRange(filters)

  const { data: digest, isLoading: digestLoading, isError: digestError } =
    usePriorityDigest(filtered, prevFiltered, allReviews)

  const brief = useExecutiveBrief(filtered, prevFiltered, periodLabel, prevPeriodLabel)
  const { data: summary, isLoading: summaryLoading } = useCompanySummary()

  const { data: trend,  isLoading: trendLoading }  = useMonthlyTrend()
  const { data: stats,  isLoading: statsLoading }  = useLocationStats()
  const { data: actionItems, isLoading: actionItemsLoading, isError: actionItemsError } = useActionItems()
  // Engineering Implementation Plan v1.0's Component Inventory: Overview's
  // "KPI cards" are one of the three named child-component groups that must
  // be "reused unchanged" when it merges into Today.
  const { data: kpis, isLoading: kpisLoading } = useKPIs()

  const replyBacklog = useMemo(() => {
    const unanswered = actionItems?.unanswered ?? []
    const overdue = unanswered.filter(r => {
      const hours = hoursSinceReview(r)
      return hours != null && hours > OVERDUE_HOURS
    })
    return { total: unanswered.length, overdue: overdue.length, overdueHours: OVERDUE_HOURS }
  }, [actionItems])

  return {
    periodLabel,
    prevPeriodLabel,
    digest,
    digestLoading,
    digestError,
    brief,
    summary,
    summaryLoading,
    trend,
    trendLoading,
    stats,
    statsLoading,
    kpis,
    kpisLoading,
    replyBacklog,
    replyBacklogLoading: actionItemsLoading,
    replyBacklogError: actionItemsError,
  }
}
