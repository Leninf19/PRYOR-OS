import { useState, useMemo, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useToast } from '../components/ui/Toast.jsx'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Button from '../components/ui/Button.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import { sentimentBucket } from '../utils/dataUtils.js'
import { useResponseDrafts } from '../hooks/useIntelligence.js'

const PAGE_SIZE = 40

// ─── Helpers ─────────────────────────────────────────────────────────────────

function exportCSV(rows) {
  const headers = ['Date','Location','City','Stars','AI Sentiment','AI Priority','Reviewer','Review','Owner Response','Response Status','Review URL']
  const escape  = v => `"${(v ?? '').toString().replace(/"/g, '""')}"`
  const lines   = [
    headers.join(','),
    ...rows.map(r => [
      r.review_date, r.location_name, r.city, r.star_rating,
      sentimentBucket(r) ?? '', r.ai_priority ?? '',
      r.reviewer_name, r.review_text, r.owner_response,
      r.response_status || (r.owner_response ? 'responded' : 'unanswered'),
      r.review_url,
    ].map(escape).join(',')),
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `lta-reviews-${new Date().toISOString().slice(0, 10)}.csv`,
  })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

function StarBadge({ n }) {
  const cls = n >= 4 ? 'star-4' : n === 3 ? 'star-3' : 'star-1'
  return <span className={`font-bold text-sm ${cls}`}>{'★'.repeat(n)}{'☆'.repeat(5 - n)}</span>
}

function buildReviewLink(r) {
  if (r.review_url) return { href: r.review_url, label: 'View ↗' }
  const q = [r.location_name, r.reviewer_name && `"${r.reviewer_name}"`].filter(Boolean).join(' ') + ' google review'
  return { href: `https://www.google.com/search?q=${encodeURIComponent(q)}`, label: 'Search ↗' }
}

function reviewLength(text) {
  const len = (text || '').trim().length
  if (len === 0) return null
  if (len < 100) return 'short'
  if (len < 300) return 'medium'
  return 'long'
}

const LENGTH_LABEL = { short: 'Short', medium: 'Medium', long: 'Long' }

const SENTIMENT_META = {
  positive: { label: 'Positive', icon: '✅', variant: 'success' },
  neutral:  { label: 'Neutral',  icon: '😐', variant: 'warning' },
  negative: { label: 'Negative', icon: '❌', variant: 'danger' },
}

const PRIORITY_META = {
  critical: { label: 'Critical', variant: 'danger'  },
  high:     { label: 'High',     variant: 'danger'  },
  medium:   { label: 'Medium',   variant: 'warning' },
  low:      { label: 'Low',      variant: 'neutral' },
}

function SentimentBadge({ r }) {
  const s = sentimentBucket(r)
  const meta = SENTIMENT_META[s]
  if (!meta) return <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>—</span>
  return <Badge variant={meta.variant}>{meta.icon} {meta.label}</Badge>
}

function PriorityBadge({ r }) {
  const meta = PRIORITY_META[r.ai_priority]
  if (!meta) return <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>—</span>
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

// ─── Filter bar ───────────────────────────────────────────────────────────────

function FilterBar({
  keyword, onKeyword, noReply, onNoReply, stars, onStars, locations, location, onLocation,
  sentiment, onSentiment, length, onLength, count,
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Keyword */}
      <div className="flex-1 min-w-48 relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
             style={{ color: 'var(--color-text-3)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
        <input
          type="search"
          placeholder="Search reviews, reviewer, location…"
          value={keyword}
          onChange={e => onKeyword(e.target.value)}
          className="w-full text-sm pl-9 pr-3 py-2 rounded-lg border focus:outline-none focus:ring-2"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-1)',
            '--tw-ring-color': 'var(--color-accent)',
          }}
          aria-label="Keyword search"
        />
      </div>

      {/* Star filter */}
      <select
        value={stars}
        onChange={e => onStars(e.target.value)}
        className="text-sm px-3 py-2 rounded-lg border focus:outline-none"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
        aria-label="Filter by stars"
      >
        <option value="">All stars</option>
        {[1,2,3,4,5].map(s => <option key={s} value={s}>{s}★</option>)}
      </select>

      {/* AI Sentiment filter */}
      <select
        value={sentiment}
        onChange={e => onSentiment(e.target.value)}
        className="text-sm px-3 py-2 rounded-lg border focus:outline-none"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
        aria-label="Filter by AI sentiment"
      >
        <option value="">All sentiment</option>
        <option value="positive">✅ Positive</option>
        <option value="neutral">😐 Neutral</option>
        <option value="negative">❌ Negative</option>
      </select>

      {/* Review length filter */}
      <select
        value={length}
        onChange={e => onLength(e.target.value)}
        className="text-sm px-3 py-2 rounded-lg border focus:outline-none"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
        aria-label="Filter by review length"
      >
        <option value="">Any length</option>
        <option value="short">Short (&lt;100 chars)</option>
        <option value="medium">Medium (100–300)</option>
        <option value="long">Long (300+)</option>
      </select>

      {/* Location */}
      {locations.length > 0 && (
        <select
          value={location}
          onChange={e => onLocation(e.target.value)}
          className="text-sm px-3 py-2 rounded-lg border focus:outline-none max-w-[200px]"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
          aria-label="Filter by location"
        >
          <option value="">All locations</option>
          {locations.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      )}

      {/* No reply toggle */}
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none"
             style={{ color: 'var(--color-text-2)' }}>
        <input type="checkbox" checked={noReply} onChange={e => onNoReply(e.target.checked)}
               className="w-3.5 h-3.5 rounded accent-amber-700" />
        No reply only
      </label>

      <span className="text-xs ml-auto" style={{ color: 'var(--color-text-3)' }}>
        {count.toLocaleString()} results
      </span>
    </div>
  )
}

// ─── Review row (click opens the side panel) ──────────────────────────────────

function ReviewRow({ r, selected, onSelect }) {
  const needsReply = !r.owner_response && (r.star_rating ?? 5) <= 2
  const tags = r.complaint_tags ?? []

  const statusBadge = r.owner_response
    ? <Badge variant="success">✓ Replied</Badge>
    : needsReply
      ? <Badge variant="danger">Needs reply</Badge>
      : <Badge variant="neutral">No reply</Badge>

  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3 px-4 py-3 border-b cursor-pointer transition-colors ${needsReply ? 'border-l-4' : ''}`}
      style={{
        borderColor: 'var(--color-border)',
        borderLeftColor: needsReply ? 'var(--color-danger)' : undefined,
        background: selected ? 'var(--color-surface-2)' : 'var(--color-surface)',
      }}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onSelect() }}
      aria-selected={selected}
    >
      {/* Star + date */}
      <div className="flex sm:flex-col items-center sm:items-start gap-2 sm:gap-0 sm:flex-shrink-0 sm:w-20 sm:pt-0.5">
        <StarBadge n={r.star_rating ?? 1} />
        <p className="text-[10px] sm:mt-1" style={{ color: 'var(--color-text-3)' }}>{r.review_date}</p>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>
          {r.reviewer_name || 'Anonymous'}
          <span className="font-normal ml-1.5" style={{ color: 'var(--color-text-3)' }}>
            · {r.location_name}
          </span>
        </p>
        {r.review_text
          ? <p className="text-xs mt-0.5 line-clamp-2 leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
              {r.review_text}
            </p>
          : <em className="text-xs" style={{ color: 'var(--color-text-3)' }}>No text</em>
        }
        {/* Below sm: sentiment/priority/status/tags all collapse into one wrapping badge row here
            instead of the fixed-width columns to the right, which don't fit a phone viewport. */}
        <div className="flex flex-wrap gap-1.5 mt-1.5 sm:hidden">
          <SentimentBadge r={r} />
          <PriorityBadge r={r} />
          {statusBadge}
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {tags.slice(0, 3).map(t => <span key={t} className="badge badge-danger">{t.replace(/_/g, ' ')}</span>)}
          </div>
        )}
      </div>

      {/* AI Sentiment — sm and up only */}
      <div className="hidden sm:block flex-shrink-0 w-28 pt-0.5"><SentimentBadge r={r} /></div>
      {/* AI Priority — sm and up only */}
      <div className="hidden sm:block flex-shrink-0 w-20 pt-0.5"><PriorityBadge r={r} /></div>
      {/* Status — sm and up only */}
      <div className="hidden sm:block flex-shrink-0 w-24 pt-0.5">{statusBadge}</div>
    </div>
  )
}

// ─── Side panel ────────────────────────────────────────────────────────────────

function ReviewDetailPanel({ r, draft, allReviews, onClose }) {
  const link = buildReviewLink(r)
  const sentiment = sentimentBucket(r)
  const sentMeta = SENTIMENT_META[sentiment]
  const priMeta = PRIORITY_META[r.ai_priority]
  const tags = [...(r.complaint_tags ?? []), ...(r.praise_tags ?? [])]

  const similar = useMemo(() => {
    if (!tags.length) return []
    return allReviews
      .filter(o => o !== r && o.location_name === r.location_name &&
        [...(o.complaint_tags ?? []), ...(o.praise_tags ?? [])].some(t => tags.includes(t)))
      .slice(0, 3)
  }, [allReviews, r, tags.join(',')])

  return (
    <>
      <motion.div
        className="fixed inset-0 z-50"
        style={{ background: 'rgba(26,23,20,0.45)', backdropFilter: 'blur(4px)' }}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={onClose}
        aria-hidden="true"
      />
      <motion.aside
        className="fixed inset-y-0 right-0 z-50 flex flex-col w-full sm:w-[440px] overflow-y-auto"
        style={{ background: 'var(--color-surface)', borderLeft: '1px solid var(--color-border)', boxShadow: 'var(--shadow-xl)' }}
        initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 320 }}
      >
        <div className="flex items-center justify-between px-5 py-4 flex-shrink-0"
             style={{ borderBottom: '1px solid var(--color-border)' }}>
          <div>
            <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>{r.reviewer_name || 'Anonymous'}</p>
            <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>{r.location_name} · {r.review_date}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-stone-100 dark:hover:bg-[var(--color-surface-2)]" aria-label="Close panel"
                  style={{ color: 'var(--color-text-2)' }}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="flex-1 p-5 space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <StarBadge n={r.star_rating ?? 1} />
            {sentMeta && <Badge variant={sentMeta.variant}>{sentMeta.icon} {sentMeta.label}</Badge>}
            {priMeta && <Badge variant={priMeta.variant}>{priMeta.label} priority</Badge>}
          </div>

          {/* Original review */}
          <div className="p-3 rounded-xl text-sm leading-relaxed"
               style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-2)' }}>
            {r.review_text ? `"${r.review_text}"` : <em>No review text</em>}
          </div>

          {/* AI reasoning ("why") */}
          {r.ai_sentiment_reason && (
            <div className="ai-card p-3">
              <p className="ai-label mb-1">✦ Why this sentiment</p>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--ai-card-text-2)' }}>{r.ai_sentiment_reason}</p>
            </div>
          )}

          {/* Detected topics */}
          {tags.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--color-text-3)' }}>
                Detected Topics
              </p>
              <div className="flex flex-wrap gap-1.5">
                {tags.map(t => (
                  <span key={t} className={`badge ${(r.complaint_tags ?? []).includes(t) ? 'badge-danger' : 'badge-success'}`}>
                    {t.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Review length -- operational context, not fabricated data */}
          <p className="text-[10px]" style={{ color: 'var(--color-text-3)' }}>
            {LENGTH_LABEL[reviewLength(r.review_text)] ?? 'No text'} review
            {reviewLength(r.review_text) && ` · ${(r.review_text || '').trim().length} characters`}
          </p>

          {/* Owner response */}
          {r.owner_response && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--color-text-3)' }}>
                Owner Response
              </p>
              <div className="p-3 rounded-xl text-xs leading-relaxed italic"
                   style={{ background: 'var(--color-accent-lt)', border: '1px solid var(--color-accent-md)', color: 'var(--color-text-2)' }}>
                {r.owner_response}
              </div>
            </div>
          )}

          {/* Suggested reply */}
          {draft && !r.owner_response && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5 ai-label">✦ Suggested Reply</p>
              <div className="p-3 rounded-xl text-xs leading-relaxed"
                   style={{ background: 'var(--ai-draft-bg)', color: 'var(--ai-draft-text)', border: '1px solid var(--ai-draft-border)' }}>
                {draft.draft}
              </div>
              <button
                onClick={() => navigator.clipboard?.writeText(draft.draft)}
                className="badge badge-neutral hover:opacity-80 transition-opacity cursor-pointer mt-2"
              >
                Copy suggested reply
              </button>
            </div>
          )}

          {/* Similar reviews */}
          {similar.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--color-text-3)' }}>
                Similar Reviews at This Location
              </p>
              <div className="space-y-2">
                {similar.map((s, i) => (
                  <div key={i} className="p-2.5 rounded-lg text-xs" style={{ background: 'var(--color-surface-2)' }}>
                    <div className="flex items-center justify-between mb-1">
                      <StarBadge n={s.star_rating ?? 1} />
                      <span style={{ color: 'var(--color-text-3)' }}>{s.review_date}</span>
                    </div>
                    <p className="line-clamp-2" style={{ color: 'var(--color-text-2)' }}>{s.review_text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <a href={link.href} target="_blank" rel="noopener noreferrer"
             className="badge badge-accent hover:opacity-80 transition-opacity inline-block">
            {link.label}
          </a>
        </div>
      </motion.aside>
    </>
  )
}

// ─── Sort header ──────────────────────────────────────────────────────────────

function Th({ label, sortKey, active, dir, onSort, className = '' }) {
  return (
    <th
      className={`px-4 py-2.5 text-left ${className}`}
      style={{ background: 'var(--color-surface-2)', borderBottom: '1px solid var(--color-border)',
               color: 'var(--color-text-2)', fontSize: '0.6875rem', fontWeight: 600, letterSpacing: '0.05em',
               textTransform: 'uppercase', whiteSpace: 'nowrap', cursor: sortKey ? 'pointer' : 'default',
               userSelect: 'none' }}
      onClick={() => sortKey && onSort(sortKey)}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}{active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ReviewExplorer({ allReviews = [], filtered = [] }) {
  const showToast = useToast()
  const { data: drafts } = useResponseDrafts()

  const [sortKey, setSortKey]     = useState('review_date')
  const [sortDir, setSortDir]     = useState('desc')
  const [keyword, setKeyword]     = useState('')
  const [noReply, setNoReply]     = useState(false)
  const [stars,   setStars]       = useState('')
  const [sentiment, setSentiment] = useState('')
  const [length,  setLength]      = useState('')
  const [locFilter, setLocFilter] = useState('')
  const [page,    setPage]        = useState(0)
  const [selectedKey, setSelectedKey] = useState(null)

  const resetPage = useCallback(() => setPage(0), [])

  const locations = useMemo(() => [...new Set(filtered.map(r => r.location_name).filter(Boolean))].sort(), [filtered])

  const processed = useMemo(() => {
    let rows = filtered
    if (noReply)   rows = rows.filter(r => !r.owner_response)
    if (stars)     rows = rows.filter(r => r.star_rating === Number(stars))
    if (locFilter) rows = rows.filter(r => r.location_name === locFilter)
    if (sentiment) rows = rows.filter(r => sentimentBucket(r) === sentiment)
    if (length)    rows = rows.filter(r => reviewLength(r.review_text) === length)
    if (keyword) {
      const kw = keyword.toLowerCase()
      rows = rows.filter(r =>
        (r.review_text   || '').toLowerCase().includes(kw) ||
        (r.reviewer_name || '').toLowerCase().includes(kw) ||
        (r.location_name || '').toLowerCase().includes(kw)
      )
    }
    return [...rows].sort((a, b) => {
      let av = a[sortKey] ?? '', bv = b[sortKey] ?? ''
      if (typeof av === 'string') { av = av.toLowerCase(); bv = bv.toLowerCase() }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ?  1 : -1
      return 0
    })
  }, [filtered, noReply, stars, locFilter, sentiment, length, keyword, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(processed.length / PAGE_SIZE))
  const safePage   = Math.min(page, totalPages - 1)
  const visible    = processed.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
    resetPage()
  }

  // Index drafts by review_id for O(1) lookup
  const draftByReviewId = useMemo(() => {
    if (!drafts) return {}
    const out = {}
    Object.values(drafts).forEach(d => {
      if (d.review_id) out[d.review_id] = d
    })
    return out
  }, [drafts])

  const selected = useMemo(
    () => visible.find((r, i) => `${r.review_id || r.review_url || i}` === selectedKey) ?? null,
    [visible, selectedKey]
  )
  const selectedDraft = selected ? draftByReviewId[selected.review_id || selected.review_url || ''] : null

  return (
    <div className="space-y-4 max-w-[1300px]">
      <div>
        <h2 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Review Center</h2>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Search, filter, and manage reviews across all locations
        </p>
      </div>

      <Card className="p-4">
        <FilterBar
          keyword={keyword}    onKeyword={v => { setKeyword(v); resetPage() }}
          noReply={noReply}    onNoReply={v => { setNoReply(v); resetPage() }}
          stars={stars}        onStars={v => { setStars(v); resetPage() }}
          sentiment={sentiment} onSentiment={v => { setSentiment(v); resetPage() }}
          length={length}      onLength={v => { setLength(v); resetPage() }}
          locations={locations} location={locFilter} onLocation={v => { setLocFilter(v); resetPage() }}
          count={processed.length}
        />
      </Card>

      {/* Action bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="secondary" onClick={() => { exportCSV(processed); showToast(`Exported ${processed.length.toLocaleString()} reviews`) }}>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a1 1 0 001 1h10a1 1 0 001-1v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
          </svg>
          Export CSV
        </Button>
        <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
          {processed.length.toLocaleString()} reviews · sorted by {sortKey.replace('_', ' ')} {sortDir === 'asc' ? '↑' : '↓'}
        </span>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {/* Column header row — hidden below sm: since the row layout collapses to
            stacked badges there instead of matching these fixed columns. */}
        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: 'collapse', minWidth: 880 }}>
            <thead>
              <tr>
                <Th label="Date"      sortKey="review_date" active={sortKey==='review_date'} dir={sortDir} onSort={toggleSort} className="w-20" />
                <Th label="Content"   sortKey={null}        active={false}                    dir={sortDir} onSort={toggleSort} />
                <Th label="AI Sentiment" sortKey={null}     active={false}                    dir={sortDir} onSort={toggleSort} className="w-28" />
                <Th label="AI Priority"  sortKey={null}      active={false}                    dir={sortDir} onSort={toggleSort} className="w-20" />
                <Th label="Reply Status" sortKey={null}     active={false}                    dir={sortDir} onSort={toggleSort} className="w-24" />
              </tr>
            </thead>
          </table>
        </div>

        {/* Review rows (not table rows — allows the flexible row layout below) */}
        <div>
          {visible.length === 0 ? (
            <EmptyState icon="🔍" title="No reviews match your filters"
                        body="Try adjusting your keyword, sentiment, star filter, or date range." />
          ) : visible.map((r, i) => {
            const rid = r.review_id || r.review_url || ''
            const key = `${rid || i}`
            return (
              <ReviewRow
                key={key}
                r={r}
                selected={selectedKey === key}
                onSelect={() => setSelectedKey(key)}
              />
            )
          })}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3"
               style={{ borderTop: '1px solid var(--color-border)' }}>
            <Button variant="ghost" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
              ← Previous
            </Button>
            <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
              Page {safePage + 1} of {totalPages} · {processed.length.toLocaleString()} reviews
            </span>
            <Button variant="ghost" disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)}>
              Next →
            </Button>
          </div>
        )}
      </div>

      <AnimatePresence>
        {selected && (
          <ReviewDetailPanel
            r={selected}
            draft={selectedDraft}
            allReviews={filtered}
            onClose={() => setSelectedKey(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
