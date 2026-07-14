import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useReviewsData } from '../hooks/useReviewsData.js'
import { useMeta } from '../hooks/useIntelligence.js'
import { COMPLAINT_CATEGORIES, PRAISE_CATEGORIES, MENU_ITEMS } from '../utils/textAnalysis.js'

function useDebounced(value, delay = 150) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

// Everything's already loaded client-side (reviews via useReviewsData, meta via
// useMeta, categories/menu items are static lists) -- this is an in-browser
// fuzzy-match index across all of it, not a new backend or search service.
function buildResults(query, { meta, allReviews }) {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return null

  const locations = (meta?.locations ?? [])
    .filter(l => l.name.toLowerCase().includes(q) || (l.city || '').toLowerCase().includes(q))
    .slice(0, 5)
    .map(l => ({ group: 'Locations', icon: '📍', label: l.name, sub: l.city, path: '/locations' }))

  const categories = [
    ...COMPLAINT_CATEGORIES.map(c => ({ ...c, kind: 'Complaint' })),
    ...PRAISE_CATEGORIES.map(c => ({ ...c, kind: 'Praise' })),
  ]
    .filter(c => c.label.toLowerCase().includes(q))
    .slice(0, 5)
    .map(c => ({ group: 'Categories', icon: c.icon ?? '🏷', label: c.label, sub: c.kind, path: '/intelligence' }))

  const menuItems = MENU_ITEMS
    .filter(m => m.includes(q))
    .slice(0, 5)
    .map(m => ({ group: 'Menu Items', icon: '🌮', label: m[0].toUpperCase() + m.slice(1), sub: 'Mentioned in reviews', path: '/marketing-intel' }))

  const reviews = (allReviews ?? [])
    .filter(r => (r.review_text || '').toLowerCase().includes(q) || (r.reviewer_name || '').toLowerCase().includes(q))
    .slice(0, 8)
    .map(r => ({
      group: 'Reviews', icon: '💬', label: r.reviewer_name || 'Anonymous',
      sub: `${r.location_name} · ${(r.review_text || '').slice(0, 70)}${(r.review_text || '').length > 70 ? '…' : ''}`,
      path: '/explorer',
    }))

  const pages = [
    { label: 'Command Center', path: '/overview' }, { label: 'Locations', path: '/locations' },
    { label: 'Review Center', path: '/explorer' }, { label: 'Department Performance', path: '/department-performance' },
    { label: 'AI Action Center', path: '/action-center' }, { label: 'Operations Impact Center', path: '/operations-impact' },
    { label: 'What Changed?', path: '/what-changed' }, { label: 'Complaint Intel', path: '/intelligence' },
    { label: 'Marketing Intelligence', path: '/marketing-intel' }, { label: 'Executive Reports', path: '/executive-reports' },
    { label: 'Response Center', path: '/actions' }, { label: 'Settings', path: '/settings' },
  ]
    .filter(p => p.label.toLowerCase().includes(q))
    .slice(0, 5)
    .map(p => ({ group: 'Pages', icon: '↗', label: p.label, sub: null, path: p.path }))

  const all = [...pages, ...locations, ...categories, ...menuItems, ...reviews]
  return all
}

export default function SmartSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef(null)
  const navigate = useNavigate()
  const { data: meta } = useMeta()
  const { data: allReviews } = useReviewsData()

  const debouncedQuery = useDebounced(query)
  const results = useMemo(() => buildResults(debouncedQuery, { meta, allReviews }), [debouncedQuery, meta, allReviews])

  useEffect(() => {
    function onKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
    else { setQuery(''); setActiveIdx(0) }
  }, [open])

  useEffect(() => { setActiveIdx(0) }, [debouncedQuery])

  function go(result) {
    setOpen(false)
    navigate(result.path)
  }

  function onKeyDown(e) {
    if (!results?.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[activeIdx]) }
  }

  let groupCursor = null

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs w-full transition-colors"
        style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-3)', border: '1px solid var(--color-border)' }}
      >
        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
        <span className="flex-1 text-left">Search…</span>
        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded"
              style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          ⌘K
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              className="fixed inset-0 z-[60]"
              style={{ background: 'rgba(26,23,20,0.5)', backdropFilter: 'blur(4px)' }}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => setOpen(false)}
            />
            <motion.div
              className="fixed left-1/2 top-[12vh] z-[60] w-full max-w-xl -translate-x-1/2 rounded-2xl overflow-hidden"
              style={{ background: 'var(--color-surface)', boxShadow: 'var(--shadow-xl)', border: '1px solid var(--color-border)' }}
              initial={{ opacity: 0, y: -12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -12, scale: 0.98 }}
              transition={{ type: 'spring', damping: 28, stiffness: 340 }}
            >
              <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--color-border)' }}>
                <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                     style={{ color: 'var(--color-text-3)' }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                </svg>
                <input
                  ref={inputRef}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Search locations, reviews, categories, menu items, pages…"
                  className="flex-1 bg-transparent text-sm focus:outline-none"
                  style={{ color: 'var(--color-text-1)' }}
                />
                <kbd className="text-[9px] font-semibold px-1.5 py-0.5 rounded" style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-3)' }}>
                  ESC
                </kbd>
              </div>

              <div className="max-h-[60vh] overflow-y-auto p-2">
                {!results ? (
                  <p className="text-xs text-center py-8" style={{ color: 'var(--color-text-3)' }}>
                    Type at least 2 characters to search…
                  </p>
                ) : results.length === 0 ? (
                  <p className="text-xs text-center py-8" style={{ color: 'var(--color-text-3)' }}>
                    No results for "{debouncedQuery}"
                  </p>
                ) : (
                  results.map((r, i) => {
                    const showHeader = r.group !== groupCursor
                    groupCursor = r.group
                    return (
                      <div key={i}>
                        {showHeader && (
                          <p className="text-[9px] font-bold uppercase tracking-widest px-2 pt-2 pb-1" style={{ color: 'var(--color-text-3)' }}>
                            {r.group}
                          </p>
                        )}
                        <button
                          onClick={() => go(r)}
                          onMouseEnter={() => setActiveIdx(i)}
                          className="w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left transition-colors"
                          style={{ background: i === activeIdx ? 'var(--color-surface-2)' : 'transparent' }}
                        >
                          <span className="text-base flex-shrink-0" aria-hidden="true">{r.icon}</span>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>{r.label}</p>
                            {r.sub && <p className="text-[10px] truncate" style={{ color: 'var(--color-text-3)' }}>{r.sub}</p>}
                          </div>
                        </button>
                      </div>
                    )
                  })
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
