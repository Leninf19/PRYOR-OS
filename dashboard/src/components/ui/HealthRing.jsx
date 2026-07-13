/**
 * Animated SVG ring showing a 0-100 health score with letter grade.
 * Uses a CSS variable for the ring-in animation.
 */
const GRADE_COLOR = {
  A: 'var(--color-grade-a)', B: 'var(--color-grade-b)', C: 'var(--color-grade-c)',
  D: 'var(--color-grade-d)', F: 'var(--color-grade-f)',
}

export default function HealthRing({ score, grade, size = 88 }) {
  if (score == null) {
    return (
      <div style={{ width: size, height: size }} className="skeleton rounded-full" />
    )
  }

  const r       = 42
  const circ    = 2 * Math.PI * r   // ≈ 263.9
  const offset  = circ - (score / 100) * circ
  const color   = GRADE_COLOR[grade] ?? '#9A6B00'
  const stroke  = Math.min(size / 10, 8)

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 100 100" style={{ transform: 'rotate(-90deg)' }}>
        {/* Track */}
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-border)" strokeWidth={stroke} />
        {/* Progress */}
        <circle
          cx="50" cy="50" r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          className="health-ring-progress"
          style={{ '--ring-offset': offset }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-black text-xl leading-none" style={{ color }}>{grade}</span>
        <span className="text-xs font-semibold mt-0.5" style={{ color: 'var(--color-text-2)' }}>{score}</span>
      </div>
    </div>
  )
}
