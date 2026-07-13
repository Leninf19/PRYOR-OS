import { useState } from 'react'
import { useScraperStatus } from '../hooks/useScraperStatus.js'
import Card from '../components/ui/Card.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import DataValidation from './DataValidation.jsx'

const SUBTABS = [
  { id: 'runs',       label: 'Scrape Runs' },
  { id: 'validation', label: 'Data Validation' },
]

const STATUS_STYLE = {
  success: 'text-emerald-600 dark:text-[var(--color-success)] bg-emerald-50 dark:bg-[var(--color-success-bg)]',
  partial: 'text-orange-600 dark:text-[var(--color-grade-c)] bg-orange-50 dark:bg-[var(--color-warning-bg)]',
  failed:  'text-red-600 dark:text-[var(--color-danger)] bg-red-50 dark:bg-[var(--color-danger-bg)]',
}

function StatusBadge({ status }) {
  const style = STATUS_STYLE[status] || 'text-stone-500 dark:text-[var(--color-text-2)] bg-stone-100 dark:bg-[var(--color-surface-2)]'
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${style}`}>
      {status || 'unknown'}
    </span>
  )
}

function RunRow({ run }) {
  const [expanded, setExpanded] = useState(false)
  const failedLocs = (run.locations || []).filter(l => l.status !== 'success')

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
              <span className={`w-2 h-2 rounded-full shrink-0 ${loc.status === 'success' ? 'bg-emerald-500' : 'bg-red-500'}`} />
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
      <div className="border-b border-stone-200 dark:border-[var(--color-border)]">
        <nav className="flex gap-1" role="tablist" aria-label="Scraper Status sections">
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
    </div>
  )
}
