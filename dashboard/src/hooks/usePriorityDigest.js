import { useMemo } from 'react'
import { useOperationsImpact, useActionCenter, usePredictiveAlerts, useActionItems } from './useIntelligence.js'
import { useActionWorkspace } from './useActionWorkspace.js'
import { useAccount } from '../components/AuthGate.jsx'
import { getLocationMomentum, getCategoryChanges, reviewId } from '../utils/dataUtils.js'
import { isOverdue, isEmailFollowUpOverdue } from '../utils/actionWorkspaceUtils.js'
import { priorityDigest } from '../utils/priorityDigest.js'

/**
 * Phase 3 Milestone 6 (Executive Intelligence Center): composes the four
 * already-existing data sources the approved design scopes Section 1 to
 * (Operations Impact, Action Center, Predictive Alerts, Trend Alerts), plus
 * the same period-comparison utilities What Changed already uses
 * (getLocationMomentum/getCategoryChanges), and hands all of it to the pure
 * priorityDigest() ranking function. No new fetch, no new backend export --
 * every hook here already exists and is already used elsewhere.
 *
 * Action Center Accountability milestone: adds a fifth source -- Action
 * Center items assigned to the CURRENT user (useAccount()) that are
 * overdue (useActionWorkspace() + the same isOverdue() Action Center's own
 * Overdue filter uses) -- computed here, not in priorityDigest.js itself,
 * so that function stays a pure ranker with no notion of "who's logged in".
 *
 * Recovery-audit milestone (restaurant bad-review email workflow): adds a
 * sixth source -- email threads (same useActionWorkspace() data) whose
 * follow-up is overdue (isEmailFollowUpOverdue()), cross-referenced against
 * `allReviews` (via the shared reviewId()) for a display-friendly location
 * name, the same cross-reference ActionCenter.jsx's own email-thread cards
 * already do.
 */
export function usePriorityDigest(filtered, prevFiltered, allReviews = []) {
  const opsImpact = useOperationsImpact()
  const actionCtr = useActionCenter()
  const predictive = usePredictiveAlerts()
  const actionItems = useActionItems()
  const { data: ws } = useActionWorkspace()
  const account = useAccount()

  const momentum = useMemo(() => getLocationMomentum(filtered ?? [], prevFiltered ?? []), [filtered, prevFiltered])
  const categoryChanges = useMemo(() => getCategoryChanges(filtered ?? [], prevFiltered ?? []), [filtered, prevFiltered])

  const assignedOverdueItems = useMemo(() => {
    if (!account?.userId) return []
    return (actionCtr.data ?? [])
      .filter(a => ws[a.id]?.assignedTo === account.userId && isOverdue(ws[a.id]))
      .map(a => ({ id: a.id, title: a.title, dueDate: ws[a.id]?.dueDate ?? null }))
  }, [actionCtr.data, ws, account?.userId])

  const emailFollowUpItems = useMemo(() => {
    return Object.entries(ws)
      .filter(([, entry]) => isEmailFollowUpOverdue(entry))
      .map(([id, entry]) => ({
        id,
        reviewId: id,
        locationName: allReviews.find(r => reviewId(r) === id)?.location_name ?? null,
        emailFollowUpDueAt: entry.emailFollowUpDueAt,
      }))
  }, [ws, allReviews])

  const digest = useMemo(() => priorityDigest({
    operationsImpact: opsImpact.data ?? null,
    actionCenter: actionCtr.data ?? null,
    predictiveAlerts: predictive.data ?? null,
    trendAlerts: actionItems.data?.trendAlerts ?? null,
    momentum,
    categoryChanges,
    assignedOverdueItems,
    emailFollowUpItems,
  }), [opsImpact.data, actionCtr.data, predictive.data, actionItems.data, momentum, categoryChanges, assignedOverdueItems, emailFollowUpItems])

  return {
    data: digest,
    isLoading: opsImpact.isLoading || actionCtr.isLoading || predictive.isLoading || actionItems.isLoading,
    isError: opsImpact.isError || actionCtr.isError || predictive.isError || actionItems.isError,
  }
}
