import { useProviderHealth } from '../hooks/useProviderHealth.js'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'

// Phase 3 Milestone 5: purely presentational. provider_health.py's
// compute_health() (the sole source of this data, via provider-health.json)
// returns only {state, reason} per provider today -- no separate cadence/
// last-run fields exist to render. Nothing here is computed client-side;
// this component only maps the exported `state` string to a label/color.
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

function ProviderHealthCard({ providerKey, health }) {
  const state = health?.state
  return (
    <Card className="p-5 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>
          {PROVIDER_LABEL[providerKey] || providerKey}
        </p>
        <Badge variant={STATE_VARIANT[state] || 'neutral'}>
          {STATE_LABEL[state] || state || 'Unknown'}
        </Badge>
      </div>
      <p className="text-xs" style={{ color: 'var(--color-text-2)' }}>
        {health?.reason || 'No reason recorded.'}
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
