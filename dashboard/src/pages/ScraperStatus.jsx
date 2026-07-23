import { useState, useMemo } from 'react'
import { useScraperStatus } from '../hooks/useScraperStatus.js'
import { useCompanySummary } from '../hooks/useIntelligence.js'
import { useGoogleOAuthStatus } from '../hooks/useGoogleOAuthStatus.js'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import DataValidation, { buildReport } from './DataValidation.jsx'
import ProviderHealth from './ProviderHealth.jsx'

const SUBTABS = [
  { id: 'runs',       label: 'Scrape Runs' },
  { id: 'validation', label: 'Data Validation' },
  { id: 'health',     label: 'Provider Health' },
]

// The pipeline has two writers with two different status vocabularies for
// the same columns: auto_update.py (the currently-active scraper) writes
// run status 'ok'/'partial'/'failed' and location status 'ok'/'error';
// gbp_sync.py writes location status 'success'/'failed'. Recognize both
// rather than hardcoding just one, or a run/location from whichever writer
// isn't matched renders as a false failure.
const OK_STATUSES = new Set(['ok', 'success'])
const FAILED_STATUSES = new Set(['error', 'failed'])

const STATUS_STYLE = {
  success: 'text-emerald-600 dark:text-[var(--color-success)] bg-emerald-50 dark:bg-[var(--color-success-bg)]',
  partial: 'text-orange-600 dark:text-[var(--color-grade-c)] bg-orange-50 dark:bg-[var(--color-warning-bg)]',
  failed:  'text-red-600 dark:text-[var(--color-danger)] bg-red-50 dark:bg-[var(--color-danger-bg)]',
}

function runStatusVariant(status) {
  if (OK_STATUSES.has(status)) return 'success'
  if (status === 'partial') return 'partial'
  if (FAILED_STATUSES.has(status)) return 'failed'
  return null
}

function StatusBadge({ status }) {
  const style = STATUS_STYLE[runStatusVariant(status)] || 'text-stone-500 dark:text-[var(--color-text-2)] bg-stone-100 dark:bg-[var(--color-surface-2)]'
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${style}`}>
      {status || 'unknown'}
    </span>
  )
}

// ── Data Health summary header ──────────────────────────────────────────────
// Composes signals that today are split across this page (run history),
// DataValidation.jsx (duplicate/missing-data checks), and Alerts.jsx/Settings
// (Google connection) into one glanceable freshness verdict.

const CADENCE_HOURS = 6 // matches update-reviews.yml's cron

function freshness(lastRunStartedAt) {
  if (!lastRunStartedAt) return { label: 'Unknown', variant: 'neutral' }
  const hours = (Date.now() - new Date(lastRunStartedAt).getTime()) / 3_600_000
  if (hours <= CADENCE_HOURS * 1.5) return { label: 'Fresh', variant: 'success', hours }
  if (hours <= CADENCE_HOURS * 4)   return { label: 'Stale', variant: 'warning', hours }
  return { label: 'Critical', variant: 'danger', hours }
}

function HealthStat({ label, value, sub, variant }) {
  const color = variant === 'danger' ? 'var(--color-danger)' : variant === 'warning' ? 'var(--color-grade-c)' : variant === 'success' ? 'var(--color-success)' : 'var(--color-text-1)'
  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--color-surface-2)' }}>
      <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>{label}</p>
      <p className="text-lg font-bold mt-0.5" style={{ color }}>{value}</p>
      {sub && <p className="text-[10px] mt-0.5" style={{ color: 'var(--color-text-3)' }}>{sub}</p>}
    </div>
  )
}

function DataHealthHeader({ allReviews }) {
  const { data: runs, isLoading } = useScraperStatus()
  const { data: summary } = useCompanySummary()
  const { data: googleStatusData, isLoading: googleStatusLoading } = useGoogleOAuthStatus()
  const googleStatus = { loading: googleStatusLoading, ...(googleStatusData ?? {}) }

  const validation = useMemo(() => buildReport(allReviews ?? []), [allReviews])

  if (isLoading) return <Skeleton className="h-32 w-full rounded-2xl" />

  const lastRun = runs?.[0]
  const fresh = freshness(lastRun?.started_at)
  const failedLocs = (lastRun?.locations || []).filter(l => !OK_STATUSES.has(l.status)).length

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <div className="flex items-center gap-2">
          <Badge variant={fresh.variant}>{fresh.label}</Badge>
          <p className="text-xs" style={{ color: 'var(--color-text-2)' }}>
            {lastRun ? `Last sync ${new Date(lastRun.started_at).toLocaleString()}` : 'No sync recorded yet'}
          </p>
        </div>
        <Badge variant={googleStatus.connected ? 'success' : 'neutral'}>
          {googleStatus.loading ? 'Checking Google…' : googleStatus.connected ? 'Google Connected' : 'Google Not Connected'}
        </Badge>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <HealthStat label="Pipeline Status" value={lastRun?.status ?? '—'}
                    variant={OK_STATUSES.has(lastRun?.status) ? 'success' : FAILED_STATUSES.has(lastRun?.status) ? 'danger' : 'warning'} />
        <HealthStat label="Reviews This Run" value={lastRun?.new_reviews_count ?? 0} sub="new reviews found" />
        <HealthStat label="Locations Updated" value={`${lastRun?.locations_succeeded ?? 0}/${lastRun?.locations_attempted ?? 0}`}
                    variant={failedLocs > 0 ? 'warning' : 'success'} sub={failedLocs > 0 ? `${failedLocs} failed` : 'all succeeded'} />
        <HealthStat label="Last AI Analysis" value={summary?.generatedAt ? new Date(summary.generatedAt).toLocaleDateString() : '—'} />
        <HealthStat label="Duplicate Reviews" value={validation.duplicateCount}
                    variant={validation.duplicateCount > 0 ? 'warning' : 'success'} />
        <HealthStat label="Missing Data" value={validation.missingText} sub="reviews with no text"
                    variant={validation.missingText > 0 ? 'warning' : 'success'} />
      </div>
    </Card>
  )
}

function RunRow({ run }) {
  const [expanded, setExpanded] = useState(false)
  const failedLocs = (run.locations || []).filter(l => !OK_STATUSES.has(l.status))

  return (
    <div className="border-b border-stone-100 dark:border-[var(--color-border)] last:border-b-0">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-4 px-4 py-3 text-left hover:bg-stone-50 dark:bg-[var(--color-surface-2)] dark:hover:bg-[var(--color-surface-2)] transition-colors"
      >
        <StatusBadge status={run.status} />
        <span className="text-xs text-stone-500 dark:text-[var(--color-text-2)] w-40 shrink-0">{run.started_at}</span>
        <span className="text-xs text-stone-400 dark:text-[var(--color-text-3)] w-16 shrink-0">{run.mode || '—'}</span>
        <span className="text-xs text-stone-600 dark:text-[var(--color-text-2)]">
          {run.locations_succeeded ?? 0}/{run.locations_attempted ?? 0} locations ·{' '}
          {run.new_reviews_count ?? 0} new
          {run.edited_reviews_count ? ` · ${run.edited_reviews_count} edited` : ''}
          {run.deleted_reviews_count ? ` · ${run.deleted_reviews_count} deleted` : ''}
        </span>
        {failedLocs.length > 0 && (
          <span className="text-[10px] font-semibold text-red-600 dark:text-[var(--color-danger)] bg-red-50 dark:bg-[var(--color-danger-bg)] px-2 py-0.5 rounded-full ml-auto">
            {failedLocs.length} failed
          </span>
        )}
        <span className="text-stone-300 dark:text-[var(--color-text-3)] text-xs">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-3 space-y-1">
          {run.error_summary && (
            <p className="text-xs text-red-600 dark:text-[var(--color-danger)] bg-red-50 dark:bg-[var(--color-danger-bg)] rounded-lg px-3 py-2 mb-2">{run.error_summary}</p>
          )}
          {(run.locations || []).map(loc => (
            <div key={loc.id} className="flex items-center gap-3 text-xs px-3 py-1.5 rounded-lg bg-stone-50 dark:bg-[var(--color-surface-2)]">
              <span className={`w-2 h-2 rounded-full shrink-0 ${OK_STATUSES.has(loc.status) ? 'bg-emerald-500' : 'bg-red-500'}`} />
              <span className="text-stone-700 dark:text-[var(--color-text-1)] font-medium w-48 truncate">{loc.location_name}</span>
              <span className="text-stone-400 dark:text-[var(--color-text-3)]">{loc.reviews_found ?? 0} found · {loc.reviews_new ?? 0} new</span>
              {loc.error_message && <span className="text-red-500 dark:text-[var(--color-danger)] truncate">{loc.error_message}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ScraperRuns() {
  const { data: runs, isLoading, isError } = useScraperStatus()

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    )
  }

  if (isError) {
    return <p className="text-sm text-red-600 dark:text-[var(--color-danger)]">Failed to load scraper run history.</p>
  }

  if (!runs || runs.length === 0) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm font-medium text-stone-600 dark:text-[var(--color-text-2)]">No scraper runs recorded yet</p>
        <p className="text-xs text-stone-400 dark:text-[var(--color-text-3)] mt-1">
          The scheduled GitHub Actions scrape hasn't completed a run since this log was added.
          Once a scrape runs, its result will appear here automatically.
        </p>
      </Card>
    )
  }

  return (
    <Card className="overflow-hidden">
      {runs.map(run => <RunRow key={run.id} run={run} />)}
    </Card>
  )
}

export default function ScraperStatus({ allReviews }) {
  const [tab, setTab] = useState('runs')

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Data Health</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Is the data trustworthy right now? Sync freshness, pipeline status, and data quality in one place.
        </p>
      </div>

      <DataHealthHeader allReviews={allReviews} />

      <div className="border-b border-stone-200 dark:border-[var(--color-border)]">
        <nav className="flex gap-1" role="tablist" aria-label="Data Health sections">
          {SUBTABS.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 ${
                tab === t.id
                  ? 'border-amber-500 text-stone-800 dark:text-[var(--color-text-1)]'
                  : 'border-transparent text-stone-400 dark:text-[var(--color-text-3)] hover:text-stone-600 dark:text-[var(--color-text-2)] hover:border-stone-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'runs'       && <ScraperRuns />}
      {tab === 'validation' && <DataValidation allReviews={allReviews} />}
      {tab === 'health'     && <ProviderHealth />}
    </div>
  )
}
