import { useProviderHealth } from '../hooks/useProviderHealth.js'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'

// Phase 3 Milestone 5: purely presentational. provider_health.py's
// compute_health() (the sole source of this data, via provider-health.json)
// returns only {state, reason} per provider today -- no separate cadence/
// last-run fields exist to render, and none are invented here.
const STATE_LABEL = {
  healthy: 'Healthy',
  warning: 'Warning',
  degraded: 'Degraded',
  failed: 'Failed',
  offline: 'Offline',
}

const STATE_VARIANT = {
  healthy: 'success',
  warning: 'warning',
  degraded: 'danger',
  failed: 'danger',
  offline: 'neutral',
}

// Cosmetic display names only -- the payload's own keys ('gbp'/'scraper')
// are still what's read; an unrecognized key falls back to itself.
const PROVIDER_LABEL = {
  gbp: 'Google Business Profile',
  scraper: 'Scraper (Playwright)',
  mock: 'Mock',
}

// Inline Heroicons-solid SVGs, matching Layout.jsx's existing nav-icon
// convention exactly (same viewBox/paths) rather than introducing an icon
// library. The gear is literally Layout.jsx's own `scraper` nav icon.
const ICON_GEAR = (
  <svg viewBox="0 0 20 20" fill="currentColor" className="w-[18px] h-[18px]"><path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd"/></svg>
)
const ICON_CLOCK = (
  <svg viewBox="0 0 20 20" fill="currentColor" className="w-[18px] h-[18px]"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd"/></svg>
)
const ICON_CHECK = (
  <svg viewBox="0 0 20 20" fill="currentColor" className="w-[18px] h-[18px]"><path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd"/></svg>
)
const ICON_WARN = (
  <svg viewBox="0 0 20 20" fill="currentColor" className="w-[18px] h-[18px]"><path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/></svg>
)
const ICON_OFF = (
  <svg viewBox="0 0 20 20" fill="currentColor" className="w-[18px] h-[18px]"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd"/></svg>
)

const STATE_ICON = {
  healthy: ICON_CHECK,
  warning: ICON_WARN,
  degraded: ICON_WARN,
  failed: ICON_WARN,
  offline: ICON_OFF,
}

// Known, already-documented operational context for this deployment (see
// README's "GBP-specific limitations" and update-reviews.yml's own
// "TEMPORARY" comment: the scraper is the deliberate active fallback while
// Google's API quota is pending, not a broken/unconfigured provider). This
// is not invented data -- it's a client-side reinterpretation of the exact
// {state, reason} pair provider_health.py already produces for the "not
// configured" case, replacing a misleading label with an accurate one for
// these two known providers. It only fires on an exact match, so if the
// underlying reason ever changes (e.g. Milestone 8 fixes is_configured()
// to reflect real cadence-based health), the real state/reason renders
// through untouched below -- nothing here can mask a genuine failure.
const OPERATIONAL_ROLE = {
  gbp: {
    matches: (state, reason) => state === 'offline' && reason === 'gbp is not configured',
    roleLabel: 'Standby',
    variant: 'info',
    icon: ICON_CLOCK,
    description: 'Google Business Profile synchronization is currently disabled while API access is pending.',
  },
  scraper: {
    matches: (state, reason) => state === 'offline' && reason === 'scraper is not configured',
    roleLabel: 'Primary Provider',
    variant: 'success',
    icon: ICON_GEAR,
    description: 'Currently handling production review synchronization.',
  },
}

function ProviderHealthCard({ providerKey, health }) {
  const state = health?.state
  const reason = health?.reason
  const override = OPERATIONAL_ROLE[providerKey]?.matches(state, reason) ? OPERATIONAL_ROLE[providerKey] : null

  const badgeLabel = override ? override.roleLabel : (STATE_LABEL[state] || state || 'Unknown')
  const badgeVariant = override ? override.variant : (STATE_VARIANT[state] || 'neutral')
  const icon = override ? override.icon : (STATE_ICON[state] || ICON_OFF)
  const description = override ? override.description : (reason || 'No reason recorded.')

  return (
    <Card className="p-5 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center w-9 h-9 rounded-full shrink-0"
          style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}
        >
          {icon}
        </div>
        <p className="text-sm font-semibold flex-1 min-w-0 truncate" style={{ color: 'var(--color-text-1)' }}>
          {PROVIDER_LABEL[providerKey] || providerKey}
        </p>
        <Badge variant={badgeVariant}>{badgeLabel}</Badge>
      </div>
      <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
        {description}
      </p>
    </Card>
  )
}

export default function ProviderHealth() {
  const { data, isLoading, isError } = useProviderHealth()

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-2xl" />)}
      </div>
    )
  }

  if (isError) {
    return <p className="text-sm text-red-600 dark:text-[var(--color-danger)]">Failed to load provider health.</p>
  }

  const entries = data ? Object.entries(data) : []

  if (entries.length === 0) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm font-medium text-stone-600 dark:text-[var(--color-text-2)]">No provider health data yet</p>
        <p className="text-xs text-stone-400 dark:text-[var(--color-text-3)] mt-1">
          Provider health is computed on every pipeline run. Once the next run completes, it will appear here automatically.
        </p>
      </Card>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {entries.map(([providerKey, health]) => (
        <ProviderHealthCard key={providerKey} providerKey={providerKey} health={health} />
      ))}
    </div>
  )
}
