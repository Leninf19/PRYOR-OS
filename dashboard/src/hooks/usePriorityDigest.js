import { useMemo } from 'react'
import { useOperationsImpact, useActionCenter, usePredictiveAlerts, useActionItems } from './useIntelligence.js'
import { getLocationMomentum, getCategoryChanges } from '../utils/dataUtils.js'
import { priorityDigest } from '../utils/priorityDigest.js'

/**
 * Phase 3 Milestone 6 (Executive Intelligence Center): composes the four
 * already-existing data sources the approved design scopes Section 1 to
 * (Operations Impact, Action Center, Predictive Alerts, Trend Alerts), plus
 * the same period-comparison utilities What Changed already uses
 * (getLocationMomentum/getCategoryChanges), and hands all of it to the pure
 * priorityDigest() ranking function. No new fetch, no new backend export --
 * every hook here already exists and is already used elsewhere.
 */
export function usePriorityDigest(filtered, prevFiltered) {
  const opsImpact = useOperationsImpact()
  const actionCtr = useActionCenter()
  const predictive = usePredictiveAlerts()
  const actionItems = useActionItems()

  const momentum = useMemo(() => getLocationMomentum(filtered ?? [], prevFiltered ?? []), [filtered, prevFiltered])
  const categoryChanges = useMemo(() => getCategoryChanges(filtered ?? [], prevFiltered ?? []), [filtered, prevFiltered])

  const digest = useMemo(() => priorityDigest({
    operationsImpact: opsImpact.data ?? null,
    actionCenter: actionCtr.data ?? null,
    predictiveAlerts: predictive.data ?? null,
    trendAlerts: actionItems.data?.trendAlerts ?? null,
    momentum,
    categoryChanges,
  }), [opsImpact.data, actionCtr.data, predictive.data, actionItems.data, momentum, categoryChanges])

  return {
    data: digest,
    isLoading: opsImpact.isLoading || actionCtr.isLoading || predictive.isLoading || actionItems.isLoading,
    isError: opsImpact.isError || actionCtr.isError || predictive.isError || actionItems.isError,
  }
}
