/**
 * Shared pill-style tab switcher — same markup previously hand-rolled in
 * TrendsAnalytics, MarketingIntelligence, ExecutiveReports, and ActionCenter.
 *
 * <Tabs tabs={[{ id: 'a', label: 'A' }]} value={tab} onChange={setTab} />
 * <Tabs tabs={['All', 'Critical']} value={tab} onChange={setTab} />
 */
export default function Tabs({ tabs, value, onChange, wrap = true, size = 'md' }) {
  const items = tabs.map(t => (typeof t === 'string' ? { id: t, label: t } : t))
  const sizeClass = size === 'xs' ? 'px-3 py-1.5 text-xs'
    : size === 'sm' ? 'px-3.5 py-2 text-xs' : 'px-4 py-2 text-sm'

  return (
    <div className={`flex gap-1 p-1 rounded-xl w-fit ${wrap ? 'flex-wrap' : ''}`}
         style={{ background: 'var(--color-surface-2)' }}>
      {items.map(t => (
        <button key={t.id} onClick={() => onChange(t.id)}
                className={`${sizeClass} font-medium rounded-lg transition-all`}
                style={value === t.id
                  ? { background: 'var(--color-surface)', color: 'var(--color-text-1)', boxShadow: 'var(--shadow-sm)' }
                  : { color: 'var(--color-text-2)' }}>
          {t.label}
        </button>
      ))}
    </div>
  )
}
