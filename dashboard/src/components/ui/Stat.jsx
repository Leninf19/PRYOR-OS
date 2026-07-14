import { Link } from 'react-router-dom'

/**
 * KPI stat card — shared chrome (card, label, optional link-wrap, loading
 * skeleton, delta/sub line) for any KPI grid in the app.
 *
 * <Stat label="Avg Rating" value="4.23" delta="+0.04" unit="★" trend="up" />
 * <Stat label="Health Score" link="/locations"><HealthRing .../></Stat>
 */
export default function Stat({ label, value, delta, unit, trend, sub, loading, link, children }) {
  const trendColor = trend === 'up' ? 'trend-up' : trend === 'down' ? 'trend-down' : 'trend-flat'
  const trendIcon  = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'

  const inner = (
    <div className="card p-4 flex flex-col gap-1.5 min-w-0 h-full">
      <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--color-text-3)' }}>
        {label}
      </p>
      {loading ? (
        <div className="skeleton h-7 w-20 mt-1" />
      ) : children ? children : (
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="text-2xl tracking-tight" style={{ color: 'var(--color-text-1)', fontWeight: 700 }}>
            {value ?? '—'}
          </span>
          {unit && (
            <span className="text-sm font-medium" style={{ color: 'var(--color-text-2)' }}>{unit}</span>
          )}
        </div>
      )}
      {(delta || sub) && !loading && (
        <p className={`text-xs font-medium ${delta ? trendColor : ''}`} style={!delta ? { color: 'var(--color-text-3)' } : {}}>
          {delta && <span>{trendIcon} {delta}</span>}
          {delta && sub && <span style={{ color: 'var(--color-text-3)' }}> · </span>}
          {sub && <span style={{ color: 'var(--color-text-3)' }}>{sub}</span>}
        </p>
      )}
    </div>
  )

  if (link) return <Link to={link} className="block card-hover rounded-[14px]">{inner}</Link>
  return inner
}
