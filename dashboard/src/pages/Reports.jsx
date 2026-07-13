import { useMemo } from 'react'
import { useWeeklyReport } from '../hooks/useWeeklyReport.js'
import { useReviewsData } from '../hooks/useReviewsData.js'
import { getBrand, getBrandColor, fmtRating } from '../utils/dataUtils.js'
import { buildCategorySummary, COMPLAINT_CATEGORIES, PRAISE_CATEGORIES } from '../utils/textAnalysis.js'
import Card from '../components/ui/Card.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'

function KpiCard({ icon, value, label, sub, tone = 'amber' }) {
  const TONES = {
    amber:   'bg-amber-50 dark:bg-[var(--color-accent-lt)] border-amber-200 dark:border-[var(--color-accent-md)] text-amber-700 dark:text-[var(--color-accent)]',
    red:     'bg-red-50 dark:bg-[var(--color-danger-bg)] border-red-200 dark:border-[var(--color-danger-border)] text-red-700 dark:text-[var(--color-danger)]',
    emerald: 'bg-emerald-50 dark:bg-[var(--color-success-bg)] border-emerald-200 dark:border-[var(--color-success-border)] text-emerald-700 dark:text-[var(--color-success)]',
    stone:   'bg-stone-50 dark:bg-[var(--color-surface-2)] border-stone-200 dark:border-[var(--color-border)] text-stone-600 dark:text-[var(--color-text-2)]',
  }
  return (
    <div className={`rounded-xl border p-5 text-center ${TONES[tone]}`}>
      <p className="text-2xl mb-1" aria-hidden="true">{icon}</p>
      <p className="text-3xl font-bold tracking-tight">{value}</p>
      <p className="text-xs font-semibold uppercase tracking-wide mt-1.5">{label}</p>
      <p className="text-xs text-stone-400 dark:text-[var(--color-text-3)] mt-0.5">{sub}</p>
    </div>
  )
}

function TrendBadge({ cur, prev }) {
  if (cur == null) return <span className="text-xs text-stone-300 dark:text-[var(--color-text-3)]">—</span>
  if (prev == null) return <span className="text-xs text-stone-400 dark:text-[var(--color-text-3)]">First month</span>
  const delta = cur - prev
  if (delta >= 0.1) return <span className="text-xs font-semibold text-emerald-700 dark:text-[var(--color-success)] bg-emerald-50 dark:bg-[var(--color-success-bg)] px-2 py-0.5 rounded-full">▲ +{delta.toFixed(2)}</span>
  if (delta <= -0.1) return <span className="text-xs font-semibold text-red-700 dark:text-[var(--color-danger)] bg-red-50 dark:bg-[var(--color-danger-bg)] px-2 py-0.5 rounded-full">▼ {delta.toFixed(2)}</span>
  return <span className="text-xs text-stone-500 dark:text-[var(--color-text-2)] bg-stone-100 dark:bg-[var(--color-surface-2)] px-2 py-0.5 rounded-full">— Stable</span>
}

function WeeklyComplaintSummary() {
  const { data: allReviews } = useReviewsData()
  const d7 = useMemo(() => new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10), [])
  const d14 = useMemo(() => new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10), [])

  const negThisWeek = useMemo(() =>
    (allReviews || []).filter(r => Number(r.star_rating) <= 2 && r.review_date >= d7),
    [allReviews, d7]
  )
  const negLastWeek = useMemo(() =>
    (allReviews || []).filter(r => Number(r.star_rating) <= 2 && r.review_date >= d14 && r.review_date < d7),
    [allReviews, d7, d14]
  )
  const posThisWeek = useMemo(() =>
    (allReviews || []).filter(r => Number(r.star_rating) >= 4 && r.review_date >= d7),
    [allReviews, d7]
  )

  const complaints = useMemo(() => buildCategorySummary(negThisWeek, COMPLAINT_CATEGORIES, negLastWeek, 1), [negThisWeek, negLastWeek])
  const praise     = useMemo(() => buildCategorySummary(posThisWeek, PRAISE_CATEGORIES, [], 1), [posThisWeek])

  if (!allReviews) return null
  if (complaints.length === 0 && praise.length === 0) {
    return (
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-stone-700 dark:text-[var(--color-text-1)] mb-1">This Week's Customer Themes</h3>
        <p className="text-xs text-stone-400 dark:text-[var(--color-text-3)]">No reviews with text found for this week.</p>
      </Card>
    )
  }

  return (
    <div className="grid sm:grid-cols-2 gap-4">
      {complaints.length > 0 && (
        <Card className="border-red-200 dark:border-[var(--color-danger-border)] p-5">
          <h3 className="text-sm font-semibold text-red-800 dark:text-[var(--color-danger)] mb-1">🔴 Issues This Week</h3>
          <p className="text-xs text-stone-400 dark:text-[var(--color-text-3)] mb-3">Themes from {negThisWeek.length} negative reviews — grouped by meaning, not keywords.</p>
          <div className="space-y-1.5">
            {complaints.slice(0, 6).map(c => (
              <div key={c.id} className="flex items-center justify-between text-xs">
                <span className="text-stone-700 dark:text-[var(--color-text-1)] font-medium">{c.icon} {c.label}</span>
                <span className="font-bold text-red-700 dark:text-[var(--color-danger)] bg-red-50 dark:bg-[var(--color-danger-bg)] px-2 py-0.5 rounded-full">{c.count}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      {praise.length > 0 && (
        <Card className="border-emerald-200 dark:border-[var(--color-success-border)] p-5">
          <h3 className="text-sm font-semibold text-emerald-800 dark:text-[var(--color-success)] mb-1">⭐ Strengths This Week</h3>
          <p className="text-xs text-stone-400 dark:text-[var(--color-text-3)] mb-3">Themes from {posThisWeek.length} positive reviews.</p>
          <div className="space-y-1.5">
            {praise.slice(0, 6).map(c => (
              <div key={c.id} className="flex items-center justify-between text-xs">
                <span className="text-stone-700 dark:text-[var(--color-text-1)] font-medium">{c.icon} {c.label}</span>
                <span className="font-bold text-emerald-700 dark:text-[var(--color-success)] bg-emerald-50 dark:bg-[var(--color-success-bg)] px-2 py-0.5 rounded-full">{c.count}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

export default function Reports() {
  const { data, isLoading, isError } = useWeeklyReport()

  const locRows = useMemo(() => {
    if (!data) return []
    const names = new Set([...Object.keys(data.byLocation), ...Object.keys(data.avgNow)])
    return [...names].map(name => ({
      name,
      brand: getBrand(name),
      newCount: data.byLocation[name] || 0,
      avgNow: data.avgNow[name] ?? null,
      avgPrev: data.avgPrev[name] ?? null,
    })).sort((a, b) => b.newCount - a.newCount)
  }, [data])

  const { improving, declining } = useMemo(() => {
    if (!data) return { improving: 0, declining: 0 }
    let improving = 0, declining = 0
    for (const name of Object.keys(data.avgNow)) {
      const cur = data.avgNow[name], prev = data.avgPrev[name]
      if (prev == null) continue
      if (cur - prev >= 0.1) improving++
      else if (cur - prev <= -0.1) declining++
    }
    return { improving, declining }
  }, [data])

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (isError || !data) {
    return <p className="text-sm text-red-600 dark:text-[var(--color-danger)]">Failed to load the weekly report.</p>
  }

  const trendTone = data.unanswered > 0 ? 'red' : 'emerald'
  const trendValue = data.unanswered > 0 ? data.unanswered : 'None'

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-stone-800 dark:text-[var(--color-text-1)]">Weekly Review Report</h2>
        <p className="text-sm text-stone-500 dark:text-[var(--color-text-2)]">{data.weekStr} · generated {new Date(data.generatedAt).toLocaleString()}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard icon="📊" value={data.totalNew} label="New Reviews" sub="This week" tone="amber" />
        <KpiCard icon={data.unanswered > 0 ? '⚠️' : '✅'} value={trendValue} label="Need Reply" sub={data.unanswered > 0 ? 'Unanswered 1–2★ lifetime' : 'All clear'} tone={trendTone} />
        <KpiCard
          icon={declining > 0 ? '📉' : improving > 0 ? '📈' : '📍'}
          value={declining > 0 ? declining : improving > 0 ? improving : locRows.length}
          label={declining > 0 ? 'Declining' : improving > 0 ? 'Improving' : 'Active'}
          sub="Locations vs prior 30 days"
          tone={declining > 0 ? 'red' : improving > 0 ? 'emerald' : 'stone'}
        />
      </div>

      {data.unanswered > 0 && (
        <Card className="border-red-200 dark:border-[var(--color-danger-border)] bg-red-50 dark:bg-[var(--color-danger-bg)] p-5">
          <p className="text-sm font-semibold text-red-800 dark:text-[var(--color-danger)]">Action Required</p>
          <p className="text-xs text-red-700 dark:text-[var(--color-danger)] mt-1">
            You have <strong>{data.unanswered}</strong> unanswered 1–2 star review{data.unanswered !== 1 ? 's' : ''}.
            Responding to unhappy customers protects your reputation and improves your Google ranking. Aim to reply within 24 hours.
          </p>
        </Card>
      )}

      {data.totalNew === 0 && (
        <Card className="p-8 text-center">
          <p className="text-sm font-medium text-stone-600 dark:text-[var(--color-text-2)]">No new reviews this week</p>
          <p className="text-xs text-stone-400 dark:text-[var(--color-text-3)] mt-1">Consider running an update, or encourage satisfied customers to leave a review.</p>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-100 dark:border-[var(--color-border)]">
          <h3 className="text-sm font-semibold text-stone-700 dark:text-[var(--color-text-1)]">New Reviews by Location</h3>
          <p className="text-xs text-stone-400 dark:text-[var(--color-text-3)] mt-0.5">30-day average rating and trend vs. the prior 30 days.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 dark:bg-[var(--color-surface-2)] border-b border-stone-200 dark:border-[var(--color-border)]">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-stone-500 dark:text-[var(--color-text-2)] uppercase tracking-wide">Location</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold text-stone-500 dark:text-[var(--color-text-2)] uppercase tracking-wide">New Reviews</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-stone-500 dark:text-[var(--color-text-2)] uppercase tracking-wide">30-Day Rating</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-stone-500 dark:text-[var(--color-text-2)] uppercase tracking-wide">Trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {locRows.map(row => (
                <tr key={row.name} className="hover:bg-stone-50 dark:bg-[var(--color-surface-2)] dark:hover:bg-[var(--color-surface-2)]">
                  <td className="px-4 py-2.5">
                    <p className="font-medium text-stone-800 dark:text-[var(--color-text-1)]">{row.name}</p>
                    <span
                      className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full text-white mt-0.5"
                      style={{ backgroundColor: getBrandColor(row.brand) }}
                    >{row.brand}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="font-semibold text-stone-800 dark:text-[var(--color-text-1)] bg-stone-100 dark:bg-[var(--color-surface-2)] px-2 py-0.5 rounded-full text-xs">{row.newCount}</span>
                  </td>
                  <td className="px-4 py-2.5 text-stone-600 dark:text-[var(--color-text-2)]">{row.avgNow != null ? `${fmtRating(row.avgNow)} / 5.00` : <span className="text-stone-300 dark:text-[var(--color-text-3)]">No data</span>}</td>
                  <td className="px-4 py-2.5"><TrendBadge cur={row.avgNow} prev={row.avgPrev} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <WeeklyComplaintSummary />
    </div>
  )
}
