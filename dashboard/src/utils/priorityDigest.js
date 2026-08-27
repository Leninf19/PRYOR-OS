// Phase 3 Milestone 6 (Executive Intelligence Center) -- a pure, deterministic
// function that merges and ranks signals already computed elsewhere into one
// digest. No new scoring model, no AI, no backend changes: every input here
// is data an existing export (operations-impact.json, action-center.json,
// predictive-alerts.json, action-items.json's trendAlerts) or an existing
// dataUtils.js function (getLocationMomentum, getCategoryChanges) already
// produced. This file only merges, ranks, deduplicates, and formats -- it
// never re-derives a score from raw reviews itself.

import { COMPLAINT_CATEGORIES, PRAISE_CATEGORIES } from './textAnalysis.js'

function buildCategoryLabelMap() {
  const map = {}
  COMPLAINT_CATEGORIES.forEach(c => { map[c.id] = c.label })
  PRAISE_CATEGORIES.forEach(p => { map[p.id] = p.label })
  return map
}
const CATEGORY_LABELS = buildCategoryLabelMap()
// Same lookup ExecutiveIntelligenceCenter.jsx's own categoryLabel() already
// uses -- kept in sync here so the M4 theme win/loss candidates (Recent
// Wins/Losses) render the same human label as every other category display.
function categoryLabel(id) {
  return CATEGORY_LABELS[id] ?? id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// "Today's Priorities" (Section 1) draws from these six sources -- What
// Changed's momentum/category-change signals belong to Sections 2/3, not
// here. The fifth source (Action Center Accountability milestone): tasks
// overdue and assigned to the CURRENT user. The sixth (recovery-audit
// milestone, restaurant bad-review email workflow): email threads whose
// follow-up is overdue. Both are computed by the caller (usePriorityDigest.js,
// which has access to the workspace + authenticated account + allReviews)
// and handed in pre-filtered -- this file stays a pure function with no
// knowledge of who's logged in, what "overdue" means, or review content.
const OPERATIONS_IMPACT_PRIORITY_SEVERITY = {
  needsAttention: 'critical',
  biggestComplaint: 'critical',
  lowestPerforming: 'critical',
  fastestGrowingComplaint: 'high',
  leastConsistent: 'high',
}

// The mirror-image set: operations-impact.json fields that are inherently
// positive, used only for Recent Wins (Section 2), never for Priorities.
const OPERATIONS_IMPACT_WIN_KEYS = [
  'biggestCompliment', 'fastestGrowingCompliment', 'highestPerforming', 'bestManaged', 'mostConsistent',
]

const SEVERITY_WEIGHT = { critical: 4, high: 3, warning: 2, info: 1 }

// Fixed, deterministic tiebreak when two candidates land on the same
// severity weight -- arbitrary but stable, so ties never depend on object
// insertion order alone.
const SOURCE_ORDER = {
  'Operations Impact': 0, 'Action Center': 1, 'Predictive Alerts': 2, 'Trend Alerts': 3,
  'My Overdue Tasks': 4, 'Restaurant Follow-Up': 5,
}

const MAX_PRIORITIES = 5
const MAX_WINS = 3
const MAX_LOSSES = 3
const MAX_NEXT_ACTIONS = 3

function opsImpactHeadline(entry) {
  if (!entry) return null
  if (entry.category) return entry.category.name
  if (entry.location) return entry.location.name
  return null
}

function normalizeSubject(s) {
  return (s || '').toLowerCase().trim()
}

// ── Section 1 candidate collection ──────────────────────────────────────────

function collectOperationsImpactPriorityCandidates(operationsImpact) {
  if (!operationsImpact) return []
  const out = []
  Object.entries(OPERATIONS_IMPACT_PRIORITY_SEVERITY).forEach(([key, severity]) => {
    const entry = operationsImpact[key]
    const headline = opsImpactHeadline(entry)
    if (!headline || !entry?.explanation) return
    out.push({
      id: `opsimpact-${key}`,
      title: headline,
      explanation: entry.explanation,
      severity,
      sourceLabel: 'Operations Impact',
      sourcePath: '/operations-impact',
      subject: normalizeSubject(headline),
    })
  })
  return out
}

function collectActionCenterPriorityCandidates(actionCenter) {
  const items = Array.isArray(actionCenter) ? actionCenter : []
  return items
    .filter(a => a.priority === 'Critical' || a.priority === 'High')
    .map(a => ({
      id: `actioncenter-${a.id}`,
      title: a.title,
      explanation: a.reason,
      severity: a.priority === 'Critical' ? 'critical' : 'high',
      sourceLabel: 'Action Center',
      // Operations Calendar + Content Library milestone: AI Suggestions now
      // live inside Calendar, not the deprecated /actions-legacy page.
      sourcePath: '/calendar',
      subject: normalizeSubject(a.title || a.id),
    }))
}

function collectPredictiveAlertPriorityCandidates(predictiveAlerts) {
  const arr = Array.isArray(predictiveAlerts) ? predictiveAlerts : (predictiveAlerts?.alerts ?? [])
  return arr
    .filter(a => a.severity !== 'positive')
    .map((a, i) => {
      const title = a.title ?? a.name ?? 'Predictive signal detected'
      return {
        id: `predictive-${i}`,
        title,
        explanation: a.body ?? a.description ?? a.message ?? '',
        severity: a.severity === 'critical' ? 'critical' : 'warning',
        sourceLabel: 'Predictive Alerts',
        sourcePath: '/alerts',
        subject: normalizeSubject(a.location ?? a.locationName ?? title),
      }
    })
}

function collectTrendAlertPriorityCandidates(trendAlerts) {
  const arr = Array.isArray(trendAlerts) ? trendAlerts : []
  return arr
    .filter(t => t.delta < 0)
    .map(t => ({
      id: `trendalert-${t.name}`,
      title: `${t.name} rating is declining`,
      explanation: `Average rating dropped from ${fmt(t.avgPrev)}★ to ${fmt(t.avgCur)}★.`,
      severity: 'warning',
      sourceLabel: 'Trend Alerts',
      sourcePath: '/alerts',
      subject: normalizeSubject(t.name),
    }))
}

// `assignedOverdueItems` is already-filtered { id, title, dueDate }[] --
// tasks whose workspace entry has assignedTo === the current user and
// isOverdue(entry) is true (dashboard/src/utils/actionWorkspaceUtils.js).
// Always 'critical': an overdue task assigned to you is, by construction,
// something you personally owe right now.
function collectAssignedOverdueCandidates(assignedOverdueItems) {
  const items = Array.isArray(assignedOverdueItems) ? assignedOverdueItems : []
  return items.map(a => ({
    id: `overdue-${a.id}`,
    title: `Overdue: ${a.title}`,
    explanation: a.dueDate ? `Assigned to you, due ${a.dueDate}.` : 'Assigned to you and overdue.',
    severity: 'critical',
    sourceLabel: 'My Overdue Tasks',
    sourcePath: '/calendar',
    subject: normalizeSubject(a.title || a.id),
  }))
}

// `emailFollowUpItems` is already-filtered { id (Action Center record id,
// same as reviewId(review)), reviewId, locationName, emailFollowUpDueAt }[]
// -- restaurant bad-review email threads whose follow-up is overdue
// (dashboard/src/utils/actionWorkspaceUtils.js's isEmailFollowUpOverdue()),
// computed by the caller (usePriorityDigest.js). 'high', not 'critical' --
// an external loose end worth surfacing, one tier below a personally-owed
// overdue task.
function collectEmailFollowUpCandidates(emailFollowUpItems) {
  const items = Array.isArray(emailFollowUpItems) ? emailFollowUpItems : []
  return items.map(a => ({
    id: `email-followup-${a.id}`,
    title: `Follow-up needed: ${a.locationName || 'Unknown location'}`,
    explanation: a.emailFollowUpDueAt
      ? `A restaurant bad-review email is still awaiting follow-up (due ${a.emailFollowUpDueAt}).`
      : 'A restaurant bad-review email is still awaiting follow-up.',
    severity: 'high',
    sourceLabel: 'Restaurant Follow-Up',
    sourcePath: a.reviewId ? `/reviews?reviewId=${encodeURIComponent(a.reviewId)}` : '/actions',
    subject: normalizeSubject(a.locationName || a.id),
  }))
}

function fmt(n) {
  return typeof n === 'number' ? n.toFixed(2) : n
}

function rankAndDedupe(candidates, maxItems) {
  const ranked = candidates
    .map((c, i) => ({ ...c, _i: i, _weight: SEVERITY_WEIGHT[c.severity] ?? 0 }))
    .sort((a, b) => (b._weight - a._weight) || ((SOURCE_ORDER[a.sourceLabel] ?? 9) - (SOURCE_ORDER[b.sourceLabel] ?? 9)) || (a._i - b._i))

  const seen = new Set()
  const deduped = []
  for (const c of ranked) {
    if (seen.has(c.subject)) continue
    seen.add(c.subject)
    // eslint-disable-next-line no-unused-vars
    const { _i, _weight, ...rest } = c
    deduped.push(rest)
  }
  return deduped.slice(0, maxItems).map((item, idx) => ({ ...item, rank: idx + 1 }))
}

// ── Section 2 candidate collection (Recent Wins) ────────────────────────────

function collectOperationsImpactWinCandidates(operationsImpact) {
  if (!operationsImpact) return []
  const out = []
  OPERATIONS_IMPACT_WIN_KEYS.forEach(key => {
    const entry = operationsImpact[key]
    const headline = opsImpactHeadline(entry)
    if (!headline || !entry?.explanation) return
    out.push({
      id: `win-opsimpact-${key}`,
      title: headline,
      explanation: entry.explanation,
      sourceLabel: 'Operations Impact',
      sourcePath: '/operations-impact',
      subject: normalizeSubject(headline),
    })
  })
  return out
}

function collectMomentumWinCandidate(momentum) {
  // getLocationMomentum() already returns results sorted descending by
  // delta, so the first entry with a positive delta is the top gainer.
  const best = (Array.isArray(momentum) ? momentum : []).find(m => m.delta > 0)
  if (!best) return []
  return [{
    id: `win-momentum-${best.name}`,
    title: `${best.name} is improving`,
    explanation: `Average rating rose from ${fmt(best.prevAvg)}★ to ${fmt(best.curAvg)}★ (+${fmt(best.delta)}) this period.`,
    sourceLabel: 'What Changed',
    sourcePath: '/what-changed',
    subject: normalizeSubject(best.name),
  }]
}

function collectPraiseThemeWinCandidate(categoryChanges) {
  const top = (categoryChanges?.praises?.new ?? []).sort((a, b) => b.count - a.count)[0]
  if (!top) return []
  return [{
    id: `win-theme-${top.id}`,
    title: `New praise theme: ${categoryLabel(top.id)}`,
    explanation: `${top.count} mentions this period.`,
    sourceLabel: 'Complaint Intelligence',
    sourcePath: '/insights',
    subject: normalizeSubject(top.id),
  }]
}

function collectTrendAlertWinCandidate(trendAlerts) {
  const rising = (Array.isArray(trendAlerts) ? trendAlerts : [])
    .filter(t => t.delta > 0)
    .sort((a, b) => b.delta - a.delta)[0]
  if (!rising) return []
  return [{
    id: `win-trendalert-${rising.name}`,
    title: `${rising.name} rating is improving`,
    explanation: `Average rating improved from ${fmt(rising.avgPrev)}★ to ${fmt(rising.avgCur)}★.`,
    sourceLabel: 'Trend Alerts',
    sourcePath: '/alerts',
    subject: normalizeSubject(rising.name),
  }]
}

// ── Section 2b candidate collection (Recent Losses) -- mirrors Recent Wins
// exactly, from the same already-fetched sources, for Today's "Worsening"
// column (Design System Specification v1.0 Phase 8 wireframe). Deliberately
// separate from Section 1's "Needs Attention" priorities: this is a lighter,
// momentum-only pulse-check (rating direction per location/theme), not the
// heavier actionable-item queue Section 1 already covers.
function collectOperationsImpactLossCandidates(operationsImpact) {
  if (!operationsImpact) return []
  const out = []
  Object.entries(OPERATIONS_IMPACT_PRIORITY_SEVERITY).forEach(([key]) => {
    const entry = operationsImpact[key]
    const headline = opsImpactHeadline(entry)
    if (!headline || !entry?.explanation) return
    out.push({
      id: `loss-opsimpact-${key}`,
      title: headline,
      explanation: entry.explanation,
      sourceLabel: 'Operations Impact',
      sourcePath: '/operations-impact',
      subject: normalizeSubject(headline),
    })
  })
  return out
}

function collectMomentumLossCandidate(momentum) {
  const arr = Array.isArray(momentum) ? momentum : []
  // getLocationMomentum() sorts descending by delta, so the worst decline is last.
  const worst = [...arr].reverse().find(m => m.delta < 0)
  if (!worst) return []
  return [{
    id: `loss-momentum-${worst.name}`,
    title: `${worst.name} is declining`,
    explanation: `Average rating fell from ${fmt(worst.prevAvg)}★ to ${fmt(worst.curAvg)}★ (${fmt(worst.delta)}) this period.`,
    sourceLabel: 'What Changed',
    sourcePath: '/what-changed',
    subject: normalizeSubject(worst.name),
  }]
}

function collectTrendAlertLossCandidate(trendAlerts) {
  const falling = (Array.isArray(trendAlerts) ? trendAlerts : [])
    .filter(t => t.delta < 0)
    .sort((a, b) => a.delta - b.delta)[0]
  if (!falling) return []
  return [{
    id: `loss-trendalert-${falling.name}`,
    title: `${falling.name} rating is declining`,
    explanation: `Average rating dropped from ${fmt(falling.avgPrev)}★ to ${fmt(falling.avgCur)}★.`,
    sourceLabel: 'Trend Alerts',
    sourcePath: '/alerts',
    subject: normalizeSubject(falling.name),
  }]
}

function collectComplaintThemeLossCandidate(categoryChanges) {
  const top = (categoryChanges?.complaints?.new ?? []).sort((a, b) => b.count - a.count)[0]
  if (!top) return []
  return [{
    id: `loss-theme-${top.id}`,
    title: `New complaint theme: ${categoryLabel(top.id)}`,
    explanation: `${top.count} mentions this period.`,
    sourceLabel: 'Complaint Intelligence',
    sourcePath: '/insights',
    subject: normalizeSubject(top.id),
  }]
}

function dedupeInOrder(candidates, maxItems) {
  const seen = new Set()
  const out = []
  for (const c of candidates) {
    if (seen.has(c.subject)) continue
    seen.add(c.subject)
    out.push(c)
    if (out.length >= maxItems) break
  }
  return out.map((item, idx) => ({ ...item, rank: idx + 1 }))
}

// ── Section 3 (What Changed condensed) ──────────────────────────────────────

function computeBiggestMover(momentum) {
  const arr = Array.isArray(momentum) ? momentum : []
  if (!arr.length) return null
  const top = [...arr].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0]
  return {
    name: top.name,
    delta: top.delta,
    direction: top.delta >= 0 ? 'up' : 'down',
    curAvg: top.curAvg,
    prevAvg: top.prevAvg,
  }
}

function computeEmergingTrend(categoryChanges) {
  if (!categoryChanges) return null
  const complaints = (categoryChanges.complaints?.new ?? []).map(c => ({ ...c, kind: 'complaint' }))
  const praises = (categoryChanges.praises?.new ?? []).map(p => ({ ...p, kind: 'praise' }))
  const top = [...complaints, ...praises].sort((a, b) => b.count - a.count)[0]
  return top ? { id: top.id, count: top.count, prevCount: top.prevCount, kind: top.kind } : null
}

const ACTION_PRIORITY_ORDER = { Critical: 0, High: 1, Medium: 2, Low: 3 }

function computeNextActionsFocus(actionCenter) {
  const items = Array.isArray(actionCenter) ? actionCenter : []
  if (!items.length) return null
  const sorted = [...items].sort((a, b) => (ACTION_PRIORITY_ORDER[a.priority] ?? 4) - (ACTION_PRIORITY_ORDER[b.priority] ?? 4))
  return {
    items: sorted.slice(0, MAX_NEXT_ACTIONS).map(a => ({ id: a.id, title: a.title, priority: a.priority })),
    total: items.length,
  }
}

/**
 * priorityDigest({ operationsImpact, actionCenter, predictiveAlerts,
 * trendAlerts, momentum, categoryChanges, assignedOverdueItems }) -> {
 *   topPriorities,   // max 5, ranked, deduplicated by subject
 *   recentWins,      // max 3, deduplicated by subject
 *   recentLosses,    // max 3, deduplicated by subject -- mirrors recentWins
 *                     // (Today's "Worsening" column, M4)
 *   biggestMover,    // single item or null
 *   emergingTrend,   // single item or null
 *   nextActionsFocus,// top-3 action-center items + total count, or null
 * }
 *
 * All inputs are the raw JSON payloads / dataUtils.js outputs the caller
 * already fetched/computed -- this function does no fetching and no
 * classification of its own. assignedOverdueItems is likewise pre-filtered
 * by the caller (usePriorityDigest.js) -- see collectAssignedOverdueCandidates.
 */
export function priorityDigest({
  operationsImpact = null,
  actionCenter = null,
  predictiveAlerts = null,
  trendAlerts = null,
  momentum = null,
  categoryChanges = null,
  assignedOverdueItems = null,
  emailFollowUpItems = null,
} = {}) {
  const priorityCandidates = [
    ...collectOperationsImpactPriorityCandidates(operationsImpact),
    ...collectActionCenterPriorityCandidates(actionCenter),
    ...collectPredictiveAlertPriorityCandidates(predictiveAlerts),
    ...collectTrendAlertPriorityCandidates(trendAlerts),
    ...collectAssignedOverdueCandidates(assignedOverdueItems),
    ...collectEmailFollowUpCandidates(emailFollowUpItems),
  ]
  const topPriorities = rankAndDedupe(priorityCandidates, MAX_PRIORITIES)

  const winCandidates = [
    ...collectOperationsImpactWinCandidates(operationsImpact),
    ...collectMomentumWinCandidate(momentum),
    ...collectTrendAlertWinCandidate(trendAlerts),
    ...collectPraiseThemeWinCandidate(categoryChanges),
  ]
  const recentWins = dedupeInOrder(winCandidates, MAX_WINS)

  const lossCandidates = [
    ...collectOperationsImpactLossCandidates(operationsImpact),
    ...collectMomentumLossCandidate(momentum),
    ...collectTrendAlertLossCandidate(trendAlerts),
    ...collectComplaintThemeLossCandidate(categoryChanges),
  ]
  const recentLosses = dedupeInOrder(lossCandidates, MAX_LOSSES)

  return {
    topPriorities,
    recentWins,
    recentLosses,
    biggestMover: computeBiggestMover(momentum),
    emergingTrend: computeEmergingTrend(categoryChanges),
    nextActionsFocus: computeNextActionsFocus(actionCenter),
  }
}
