import { useMemo, useState } from 'react'
import { getBrand, getUniqueLocations, isUnverified } from '../utils/dataUtils.js'

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000)
}

function buildReport(allReviews) {
  const locations = getUniqueLocations(allReviews)
  const maxDate = allReviews.reduce((m, r) => (r.review_date > m ? r.review_date : m), '')

  // Exact-URL duplicates (should be ~0 after build-time dedup, but verify live)
  const byUrl = {}
  allReviews.forEach(r => {
    if (!r.review_url) return
    if (!byUrl[r.review_url]) byUrl[r.review_url] = []
    byUrl[r.review_url].push(r)
  })
  const duplicateGroups = Object.values(byUrl).filter(g => g.length > 1)
  const duplicateCount = duplicateGroups.reduce((s, g) => s + g.length - 1, 0)

  let missingText = 0, missingUrl = 0, missingReviewer = 0, badStar = 0
  allReviews.forEach(r => {
    if (!r.review_text) missingText++
    if (!r.review_url) missingUrl++
    if (!r.reviewer_name) missingReviewer++
    if (!(r.star_rating >= 1 && r.star_rating <= 5)) badStar++
  })

  const perLocation = locations.map(name => {
    const revs = allReviews.filter(r => r.location_name === name)
    const city = revs[0]?.city || ''
    const brand = getBrand(name)
    const lastDate = revs.reduce((m, r) => (r.review_date > m ? r.review_date : m), '')
    const staleDays = lastDate && maxDate ? daysBetween(lastDate, maxDate) : null
    const noText = revs.filter(r => !r.review_text).length
    const noUrl = revs.filter(r => !r.review_url).length
    return {
      name, city, brand,
      count: revs.length,
      lastDate,
      staleDays,
      stale: staleDays != null && staleDays > 60,
      unverified: isUnverified(name, city),
      noTextPct: revs.length ? +(noText / revs.length * 100).toFixed(1) : 0,
      noUrlPct: revs.length ? +(noUrl / revs.length * 100).toFixed(1) : 0,
    }
  }).sort((a, b) => (b.staleDays ?? 0) - (a.staleDays ?? 0))

  return {
    totalReviews: allReviews.length,
    totalLocations: locations.length,
    maxDate,
    duplicateGroups,
    duplicateCount,
    missingText, missingUrl, missingReviewer, badStar,
    perLocation,
    staleLocations: perLocation.filter(l => l.stale),
    unverifiedLocations: perLocation.filter(l => l.unverified),
  }
}

function StatCard({ label, value, sub, warn }) {
  return (
    <div className="bg-white dark:bg-[var(--color-surface)] rounded-xl border border-stone-200 dark:border-[var(--color-border)] p-5 flex flex-col gap-1">
      <p className="text-xs font-semibold text-stone-500 dark:text-[var(--color-text-2)] uppercase tracking-wide">{label}</p>
      <p className={`text-3xl font-bold tracking-tight ${warn ? 'text-orange-500 dark:text-[var(--color-grade-c)]' : 'text-stone-800 dark:text-[var(--color-text-1)]'}`}>{value}</p>
      {sub && <p className="text-xs text-stone-400 dark:text-[var(--color-text-3)] mt-0.5">{sub}</p>}
    </div>
  )
}

export default function DataValidation({ allReviews }) {
  const report = useMemo(() => buildReport(allReviews), [allReviews])
  const [showDupes, setShowDupes] = useState(false)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-stone-800 dark:text-[var(--color-text-1)]">Data Validation Report</h2>
        <p className="text-sm text-stone-500 dark:text-[var(--color-text-2)]">
          Quality checks against the full lifetime dataset ({report.totalReviews.toLocaleString()} reviews
          across {report.totalLocations} locations, latest review {report.maxDate || '—'}).
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Duplicate Reviews"
          value={report.duplicateCount}
          sub={report.duplicateCount > 0 ? `${report.duplicateGroups.length} duplicate group(s)` : 'None found'}
          warn={report.duplicateCount > 0}
        />
        <StatCard
          label="Missing Review Text"
          value={report.missingText}
          sub={`${(report.missingText / report.totalReviews * 100).toFixed(1)}% of reviews`}
          warn={report.missingText > 0}
        />
        <StatCard
          label="Locations Possibly Stale"
          value={report.staleLocations.length}
          sub="No new review in 60+ days vs. latest data"
          warn={report.staleLocations.length > 0}
        />
        <StatCard
          label="Unverified Locations"
          value={report.unverifiedLocations.length}
          sub="Unknown brand or missing city"
          warn={report.unverifiedLocations.length > 0}
        />
      </div>

      {/* Duplicate reviews */}
      {report.duplicateGroups.length > 0 && (
        <div className="bg-white dark:bg-[var(--color-surface)] border border-orange-200 dark:border-[var(--color-grade-c)] rounded-xl p-5">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-stone-700 dark:text-[var(--color-text-1)]">Duplicate Reviews (same review_url)</h3>
            <button
              onClick={() => setShowDupes(s => !s)}
              className="text-xs text-amber-600 hover:text-amber-800"
            >{showDupes ? 'Hide' : 'Show'} details</button>
          </div>
          <p className="text-xs text-stone-400 dark:text-[var(--color-text-3)] mb-2">
            These rows share the exact same Google review URL and should be de-duplicated in dashboard/reviews.csv.
          </p>
          {showDupes && (
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {report.duplicateGroups.slice(0, 50).map((g, i) => (
                <div key={i} className="text-xs border border-stone-100 dark:border-[var(--color-border)] rounded-lg p-2">
                  <p className="text-stone-400 dark:text-[var(--color-text-3)] truncate">{g[0].review_url}</p>
                  {g.map((r, j) => (
                    <p key={j} className="text-stone-600 dark:text-[var(--color-text-2)]">
                      {r.location_name} · {r.reviewer_name} · {r.review_date} · {r.star_rating}★
                    </p>
                  ))}
                </div>
              ))}
              {report.duplicateGroups.length > 50 && (
                <p className="text-xs text-stone-400 dark:text-[var(--color-text-3)]">+ {report.duplicateGroups.length - 50} more groups not shown</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Per-location table */}
      <div className="bg-white dark:bg-[var(--color-surface)] border border-stone-200 dark:border-[var(--color-border)] rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-100 dark:border-[var(--color-border)]">
          <h3 className="text-sm font-semibold text-stone-700 dark:text-[var(--color-text-1)]">Per-Location Data Health</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 dark:bg-[var(--color-surface-2)] border-b border-stone-200 dark:border-[var(--color-border)]">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-stone-500 dark:text-[var(--color-text-2)] uppercase">Location</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-stone-500 dark:text-[var(--color-text-2)] uppercase">Brand</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-stone-500 dark:text-[var(--color-text-2)] uppercase">Reviews</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-stone-500 dark:text-[var(--color-text-2)] uppercase">Last Review</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-stone-500 dark:text-[var(--color-text-2)] uppercase">Missing Text</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-stone-500 dark:text-[var(--color-text-2)] uppercase">Flags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {report.perLocation.map(l => (
                <tr key={l.name} className="hover:bg-stone-50 dark:bg-[var(--color-surface-2)] dark:hover:bg-[var(--color-surface-2)]">
                  <td className="px-3 py-2 text-stone-700 dark:text-[var(--color-text-1)] font-medium">{l.name}</td>
                  <td className="px-3 py-2 text-stone-500 dark:text-[var(--color-text-2)]">{l.brand}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.count}</td>
                  <td className="px-3 py-2 text-stone-500 dark:text-[var(--color-text-2)]">{l.lastDate || '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.noTextPct}%</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1.5">
                      {l.stale && (
                        <span className="text-[10px] font-semibold text-orange-600 dark:text-[var(--color-grade-c)] bg-orange-50 dark:bg-[var(--color-warning-bg)] px-2 py-0.5 rounded-full">
                          Stale ({l.staleDays}d)
                        </span>
                      )}
                      {l.unverified && (
                        <span className="text-[10px] font-semibold text-red-600 dark:text-[var(--color-danger)] bg-red-50 dark:bg-[var(--color-danger-bg)] px-2 py-0.5 rounded-full">
                          Unverified
                        </span>
                      )}
                      {!l.stale && !l.unverified && (
                        <span className="text-[10px] font-semibold text-emerald-600 dark:text-[var(--color-success)] bg-emerald-50 dark:bg-[var(--color-success-bg)] px-2 py-0.5 rounded-full">
                          OK
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
