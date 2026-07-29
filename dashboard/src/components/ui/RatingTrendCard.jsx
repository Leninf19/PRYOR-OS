import { useMemo } from 'react'
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts'
import Card from './Card.jsx'
import Skeleton from './Skeleton.jsx'
import Badge from './Badge.jsx'

// Extracted unchanged from Overview.jsx (M4) so Today.jsx can reuse the same
// "Company Rating Trend (12mo)" chart without a second implementation.
export default function RatingTrendCard({ trend, loading }) {
  const last12 = useMemo(() => (trend ?? []).slice(-12), [trend])

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-label" style={{ color: 'var(--color-text-2)' }}>Rating Trend</h3>
        <Badge variant="neutral">12 months</Badge>
      </div>
      {loading ? <Skeleton className="h-32 w-full" /> : (
        <>
          <ResponsiveContainer width="100%" height={80}>
            <LineChart data={last12}>
              <Line type="monotone" dataKey="avg" stroke="var(--color-accent)"
                    strokeWidth={2.5} dot={false} />
              <Tooltip
                contentStyle={{ fontSize: 11, border: '1px solid var(--color-border)', borderRadius: 8, boxShadow: 'var(--shadow-md)' }}
                formatter={(v) => [v ? `${v}★` : '—', 'Avg']}
                labelFormatter={(l) => l}
              />
            </LineChart>
          </ResponsiveContainer>
          <div className="mt-3 grid grid-cols-4 gap-1.5">
            {last12.slice(-4).map(m => (
              <div key={m.ym} className="text-center py-1.5 rounded-lg"
                   style={{ background: 'var(--color-surface-2)' }}>
                <p className="text-[9px] font-medium" style={{ color: 'var(--color-text-3)' }}>
                  {m.ym.slice(5)}
                </p>
                <p className="text-sm font-bold mt-0.5" style={{ color: 'var(--color-text-1)' }}>
                  {m.avg ?? '—'}
                </p>
                <p className="text-[9px]" style={{ color: 'var(--color-text-3)' }}>
                  {m.count}
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  )
}
