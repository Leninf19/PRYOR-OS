import { useState } from 'react'
import { getUniqueBrands, getUniqueLocations, getBrand } from '../utils/dataUtils.js'
import { useTheme } from '../hooks/useTheme.js'

// ── Quick date presets ──────────────────────────────────────────────────────
const PRESETS = [
  { label: '7D',  days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: '6M',  days: 180 },
  { label: '1Y',  days: 365 },
  { label: 'All', days: null },
]

function toISO(d) { return d.toISOString().slice(0, 10) }

function getPresetRange(days, defaultStart, defaultEnd) {
  if (days === null) return { start: defaultStart, end: defaultEnd }
  const end   = toISO(new Date())
  const start = toISO(new Date(Date.now() - days * 86_400_000))
  return { start, end }
}

function activePreset(filters) {
  const end   = filters.end
  const start = filters.start
  if (start === filters._defaultStart && end === filters._defaultEnd) return 'All'
  for (const { label, days } of PRESETS) {
    if (days === null) continue
    const expected = toISO(new Date(Date.now() - days * 86_400_000))
    if (start === expected && end === toISO(new Date())) return label
  }
  return null
}

// ── Pill multi-select ───────────────────────────────────────────────────────
function Pills({ options, selected, onChange, colorActive = 'bg-amber-500 text-white border-amber-500' }) {
  const all = selected.length === 0
  function toggle(v) {
    onChange(selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v])
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        onClick={() => onChange([])}
        className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
          all
            ? 'bg-stone-800 text-white border-stone-800 dark:bg-[var(--color-accent)] dark:text-[#14100D] dark:border-[var(--color-accent)]'
            : 'bg-transparent text-stone-500 border-stone-200 hover:border-stone-400 hover:text-stone-700 dark:text-[var(--color-text-3)] dark:border-[var(--color-border)] dark:hover:border-[var(--color-border-2)] dark:hover:text-[var(--color-text-1)]'
        }`}
      >
        All
      </button>
      {options.map(o => (
        <button
          key={o}
          onClick={() => toggle(o)}
          className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
            selected.includes(o)
              ? colorActive
              : 'bg-transparent text-stone-500 border-stone-200 hover:border-stone-400 hover:text-stone-700 dark:text-[var(--color-text-3)] dark:border-[var(--color-border)] dark:hover:border-[var(--color-border-2)] dark:hover:text-[var(--color-text-1)]'
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  )
}

function StarPills({ selected, onChange }) {
  const all = selected.length === 0
  function toggle(s) {
    onChange(selected.includes(s) ? selected.filter(x => x !== s) : [...selected, s].sort())
  }
  return (
    <div className="flex gap-1.5">
      <button
        onClick={() => onChange([])}
        className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
          all
            ? 'bg-stone-800 text-white border-stone-800 dark:bg-[var(--color-accent)] dark:text-[#14100D] dark:border-[var(--color-accent)]'
            : 'bg-transparent text-stone-500 border-stone-200 hover:border-stone-400 dark:text-[var(--color-text-3)] dark:border-[var(--color-border)] dark:hover:border-[var(--color-border-2)]'
        }`}
      >All</button>
      {[5, 4, 3, 2, 1].map(s => (
        <button
          key={s}
          onClick={() => toggle(s)}
          className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
            selected.includes(s)
              ? 'bg-amber-500 text-white border-amber-500'
              : 'bg-transparent text-stone-500 border-stone-200 hover:border-stone-400 dark:text-[var(--color-text-3)] dark:border-[var(--color-border)] dark:hover:border-[var(--color-border-2)]'
          }`}
        >
          {'★'.repeat(s)}
        </button>
      ))}
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────────
export default function GlobalFilters({ allReviews, filters, onChange }) {
  const [advOpen, setAdvOpen] = useState(false)
  const { resolved } = useTheme()

  const allBrands    = getUniqueBrands(allReviews)
  const allLocations = getUniqueLocations(allReviews).filter(loc =>
    filters.brands.length === 0 || filters.brands.includes(getBrand(loc))
  )

  function set(key, val) { onChange({ ...filters, [key]: val }) }

  function applyPreset(days) {
    const { start, end } = getPresetRange(days, filters._defaultStart, filters._defaultEnd)
    onChange({ ...filters, start, end })
  }

  function reset() {
    onChange({
      brands:    [],
      locations: [],
      start:     filters._defaultStart,
      end:       filters._defaultEnd,
      stars:     [],
      _defaultStart: filters._defaultStart,
      _defaultEnd:   filters._defaultEnd,
    })
    setAdvOpen(false)
  }

  const current = activePreset(filters)
  const hasActive = filters.brands.length || filters.locations.length || filters.stars.length

  return (
    <div className="bg-white border border-stone-200 rounded-2xl shadow-sm overflow-hidden dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]">

      {/* ── Top bar: date presets + advanced toggle + clear ── */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-stone-100 dark:border-[var(--color-border)]">

        {/* Quick presets */}
        <div className="flex items-center gap-1 flex-wrap">
          {PRESETS.map(({ label, days }) => (
            <button
              key={label}
              onClick={() => applyPreset(days)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                current === label
                  ? 'bg-stone-900 text-amber-400 shadow-sm dark:bg-[var(--color-accent)] dark:text-[#14100D]'
                  : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800 dark:text-[var(--color-text-3)] dark:hover:bg-[var(--color-surface-2)] dark:hover:text-[var(--color-text-1)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Custom date range */}
        <div className="flex items-center gap-1.5 ml-1">
          <input
            type="date"
            value={filters.start}
            onChange={e => set('start', e.target.value)}
            className="text-xs bg-white border border-stone-200 rounded-lg px-2 py-1.5 text-stone-700 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent dark:bg-[var(--color-surface-2)] dark:border-[var(--color-border)] dark:text-[var(--color-text-1)]"
            style={{ colorScheme: resolved }}
          />
          <span className="text-stone-300 text-xs font-medium dark:text-[var(--color-text-3)]">–</span>
          <input
            type="date"
            value={filters.end}
            onChange={e => set('end', e.target.value)}
            className="text-xs bg-white border border-stone-200 rounded-lg px-2 py-1.5 text-stone-700 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent dark:bg-[var(--color-surface-2)] dark:border-[var(--color-border)] dark:text-[var(--color-text-1)]"
            style={{ colorScheme: resolved }}
          />
        </div>

        {/* Right side: advanced toggle + clear */}
        <div className="flex items-center gap-2 ml-auto">
          {hasActive && (
            <button
              onClick={reset}
              className="text-xs text-stone-400 hover:text-red-500 transition-colors font-medium flex items-center gap-1 dark:text-[var(--color-text-3)]"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
              Clear
            </button>
          )}
          <button
            onClick={() => setAdvOpen(o => !o)}
            className={`flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
              advOpen || hasActive
                ? 'bg-amber-50 text-amber-700 border border-amber-200 dark:bg-[var(--color-accent-lt)] dark:text-[var(--color-accent)] dark:border-[var(--color-accent-md)]'
                : 'text-stone-500 hover:bg-stone-100 hover:text-stone-700 dark:text-[var(--color-text-3)] dark:hover:bg-[var(--color-surface-2)] dark:hover:text-[var(--color-text-1)]'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h18M7 8h10M11 12h2" />
            </svg>
            Filters
            {hasActive > 0 && (
              <span className="bg-amber-500 text-white text-[9px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5">
                {(filters.brands.length + filters.locations.length + filters.stars.length)}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ── Expandable advanced filters ── */}
      {advOpen && (
        <div className="px-4 py-4 space-y-4 bg-stone-50/50 border-t border-stone-100 dark:bg-[var(--color-surface-2)] dark:border-[var(--color-border)]">
          <div className="grid sm:grid-cols-3 gap-4">
            <div>
              <p className="text-[10px] font-bold tracking-widest text-stone-400 uppercase mb-2 dark:text-[var(--color-text-3)]">Brand</p>
              <Pills
                options={allBrands}
                selected={filters.brands}
                onChange={v => set('brands', v)}
              />
            </div>
            <div>
              <p className="text-[10px] font-bold tracking-widest text-stone-400 uppercase mb-2 dark:text-[var(--color-text-3)]">Location</p>
              <Pills
                options={allLocations}
                selected={filters.locations}
                onChange={v => set('locations', v)}
              />
            </div>
            <div>
              <p className="text-[10px] font-bold tracking-widest text-stone-400 uppercase mb-2 dark:text-[var(--color-text-3)]">Stars</p>
              <StarPills selected={filters.stars} onChange={v => set('stars', v)} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
