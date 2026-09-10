// Multi-Tenant Phase 4Q -- shared visual shell for the new self-service
// registration pages (Register/VerifyEmail/GetStarted/Pricing/
// AccessCodeEntry), matching the split-screen system already deployed in
// Login.jsx. Deliberately a NEW, separate component rather than a refactor
// of Login.jsx itself -- Login.jsx is already live in production and this
// phase must not risk it; a small amount of duplication (Brand/
// ProductPreview) is the safer tradeoff.

export function Brand() {
  return (
    <div>
      <img src="/pryor-os-black-cropped.svg" alt="Pryor OS" className="w-[148px] h-auto dark:hidden" />
      <img src="/pryor-os-white-cropped.svg" alt="Pryor OS" className="hidden w-[148px] h-auto dark:block" />
      <p className="text-[9px] font-bold tracking-[0.2em] uppercase mt-2" style={{ color: 'var(--color-text-3)' }}>
        By Future Marketing Studio
      </p>
    </div>
  )
}

export function Field({ label, trailing, children }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <label className="text-xs font-semibold" style={{ color: 'var(--color-text-2)' }}>{label}</label>
        {trailing}
      </div>
      {children}
    </div>
  )
}

export function ErrorBanner({ children }) {
  if (!children) return null
  return (
    <div
      role="alert"
      className="rounded-lg border px-3.5 py-2.5 text-xs font-medium"
      style={{ background: 'var(--color-danger-bg)', borderColor: 'var(--color-danger-border)', color: 'var(--color-danger)' }}
    >
      {children}
    </div>
  )
}

export function SuccessBanner({ children }) {
  if (!children) return null
  return (
    <div
      className="rounded-lg border px-3.5 py-2.5 text-xs font-medium"
      style={{ background: 'var(--color-success-bg)', borderColor: 'var(--color-success-border)', color: 'var(--color-success)' }}
    >
      {children}
    </div>
  )
}

export function PrimaryButton({ children, disabled, ...rest }) {
  return (
    <button
      disabled={disabled}
      className="w-full rounded-lg py-2.5 text-sm font-semibold transition-opacity flex items-center justify-center gap-2"
      style={{ background: 'var(--color-text-1)', color: 'var(--color-bg)', opacity: disabled ? 0.7 : 1 }}
      {...rest}
    >
      {children}
    </button>
  )
}

export function LoadingDots({ label }) {
  return (
    <>
      <span className="flex items-center gap-1">
        {[0, 1, 2].map(i => (
          <span key={i} className="w-1.5 h-1.5 rounded-full pulse-dot" style={{ background: 'var(--color-bg)', animationDelay: `${i * 0.2}s` }} />
        ))}
      </span>
      {label}
    </>
  )
}

function ProductPreview() {
  const locations = [
    { name: 'Sunset Grill — Riverside', rating: 4.6, trend: '+0.2' },
    { name: 'The Copper Fork — Midtown', rating: 4.3, trend: '+0.1' },
    { name: 'Harbor House — Bayview', rating: 4.8, trend: '+0.4' },
  ]
  return (
    <div className="absolute inset-0 flex items-center justify-center p-14">
      <div className="absolute inset-0" style={{ background: 'radial-gradient(60% 50% at 72% 28%, rgba(224,165,38,0.16), transparent 70%)' }} />
      <div className="relative w-full max-w-[480px]">
        <div className="rounded-2xl border shadow-2xl overflow-hidden" style={{ background: '#FBFAF8', borderColor: 'rgba(255,255,255,0.08)' }}>
          <div className="flex items-center justify-between px-5 py-3.5 border-b" style={{ borderColor: '#EDE8E1' }}>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ background: '#E0A526' }} />
              <span className="text-[13px] font-semibold" style={{ color: '#1A1714' }}>Network Overview</span>
            </div>
            <span className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: '#9C9590' }}>Last 30 days</span>
          </div>
          <div className="px-5 py-4 space-y-3">
            {locations.map(loc => (
              <div key={loc.name} className="flex items-center justify-between">
                <span className="text-[12.5px]" style={{ color: '#413B34' }}>{loc.name}</span>
                <span className="flex items-center gap-2">
                  <span className="text-[12.5px] font-semibold" style={{ color: '#1A1714' }}>{loc.rating}★</span>
                  <span className="text-[10.5px] font-medium" style={{ color: '#9A6B00' }}>{loc.trend}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-8 text-center">
          <p className="font-serif text-[22px] leading-snug" style={{ color: '#F3EFE9' }}>
            See every location. Understand every review.<br />Act before problems repeat.
          </p>
          <p className="text-[13px] mt-3" style={{ color: '#B8AFA3' }}>
            Reputation and operations intelligence for restaurant groups.
          </p>
        </div>
      </div>
    </div>
  )
}

export default function AuthShell({ children, showPreview = true, maxWidth = 'max-w-sm' }) {
  return (
    <div className="min-h-screen min-h-[100dvh] flex" style={{ background: 'var(--color-bg)' }}>
      <div className={`w-full ${showPreview ? 'lg:w-[40%] lg:min-w-[420px]' : ''} flex flex-col justify-center px-6 sm:px-12 lg:px-16 py-12 relative overflow-y-auto`}>
        <div className={`w-full ${maxWidth} mx-auto`}>
          <Brand />
          {children}
        </div>
      </div>
      {showPreview && (
        <div className="hidden lg:block lg:w-[60%] relative overflow-hidden" style={{ background: 'linear-gradient(155deg, #17130F 0%, #1F1911 55%, #241C13 100%)' }}>
          <ProductPreview />
        </div>
      )}
    </div>
  )
}
