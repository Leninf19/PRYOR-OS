/**
 * Persistence for company-wide goal targets (Settings defines them,
 * ExecutiveDashboard displays progress against them) -- same
 * localStorage-today / swappable-later pattern as the review/action
 * workspace services.
 */

const KEY = 'company_goals_v1'

export const DEFAULT_GOALS = {
  avgRating: 4.6,
  negativePct: 8,
  responseRate: 95,
  avgResponseHours: 24,
  criticalResolutionHours: 12,
}

export async function getGoals() {
  try {
    return { ...DEFAULT_GOALS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return { ...DEFAULT_GOALS }
  }
}

export async function setGoals(patch) {
  const current = await getGoals()
  const next = { ...current, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // localStorage unavailable -- state stays in-memory for this session
  }
  return next
}
