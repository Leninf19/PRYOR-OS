import { useMemo } from 'react'
import { useOperationsImpact, useActionCenter, usePredictiveAlerts, useActionItems } from './useIntelligence.js'
import { useActionWorkspace } from './useActionWorkspace.js'
import { useAccount } from '../components/AuthGate.jsx'
import { getLocationMomentum, getCategoryChanges } from '../utils/dataUtils.js'
import { isOverdue } from '../utils/actionWorkspaceUtils.js'
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
 */
export function usePriorityDigest(filtered, prevFiltered) {
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

  const digest = useMemo(() => priorityDigest({
    operationsImpact: opsImpact.data ?? null,
    actionCenter: actionCtr.data ?? null,
    predictiveAlerts: predictive.data ?? null,
    trendAlerts: actionItems.data?.trendAlerts ?? null,
    momentum,
    categoryChanges,
    assignedOverdueItems,
  }), [opsImpact.data, actionCtr.data, predictive.data, actionItems.data, momentum, categoryChanges, assignedOverdueItems])

  return {
    data: digest,
    isLoading: opsImpact.isLoading || actionCtr.isLoading || predictive.isLoading || actionItems.isLoading,
    isError: opsImpact.isError || actionCtr.isError || predictive.isError || actionItems.isError,
  }
}
