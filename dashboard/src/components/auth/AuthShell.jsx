import { useState, useEffect } from 'react'

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

// Google Sign-In (PRYOR login identity) -- every friendly error code the
// backend's redirectWithGoogleAuthError() (session/[action].js) can send
// back via ?googleAuthError=. Never the raw provider/internal code itself
// (Part 11) -- an unrecognized code (a future addition on the server this
// client hasn't been updated for yet) falls back to a generic message
// rather than rendering nothing or the raw code.
const GOOGLE_AUTH_ERROR_MESSAGES = {
  canceled: 'Google sign-in was canceled. You can try again.',
  state_invalid: 'Your Google sign-in session expired. Please try again.',
  exchange_failed: "We couldn't complete Google sign-in. Please try again.",
  email_unverified: "Your Google account's email isn't verified yet. Please verify it with Google, or sign in with your PRYOR password instead.",
  existing_account: 'An account already exists for this email. Sign in with your existing method to connect Google securely.',
  identity_conflict: "We couldn't use this Google account with your PRYOR account. Try signing in with your existing login method.",
  link_session_mismatch: 'Your session expired while connecting Google. Please sign in again.',
  account_unavailable: 'This is temporarily unavailable. Please try again shortly.',
  invite_unavailable: 'This is temporarily unavailable. Please try again shortly.',
  invite_invalid: 'This invitation link is invalid, expired, or has already been used.',
  invite_identity_mismatch: "Please continue with the Google account matching your invitation's email address.",
  commercial_denied: 'This invitation can no longer be accepted. Please contact your Owner or Admin.',
}

export function googleAuthErrorMessage(code) {
  if (!code) return null
  return GOOGLE_AUTH_ERROR_MESSAGES[code] || 'Something went wrong with Google sign-in. Please try again.'
}

// Reads ?googleAuthError= from the CURRENT URL once (on mount only -- this
// is a one-time redirect-result banner, not a live-updating field) and
// strips it from the visible URL so a page refresh doesn't re-show a stale
// error. Returns the already-translated friendly message, or null.
//
// Deliberately a useEffect, never a useState(() => ...) initializer: the
// read+history.replaceState() here is a SIDE EFFECT, and React 18's
// StrictMode double-invokes a render-phase state initializer in
// development -- the first invocation would strip the query param via its
// side effect, and the second (whose result React actually keeps) would
// then find nothing left to read, silently swallowing every
// googleAuthError banner. An effect's double-invoke (mount/cleanup/
// remount) does not have this problem: the second run finds the query
// param already stripped and simply no-ops, leaving the state already set
// by the first run untouched.
export function useGoogleAuthError() {
  const [message, setMessage] = useState(null)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const code = params.get('googleAuthError')
    if (!code) return
    params.delete('googleAuthError')
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`
    window.history.replaceState({}, '', next)
    setMessage(googleAuthErrorMessage(code))
  }, [])
  return message
}

// `href` is a real browser navigation (the OAuth flow needs a full-page
// redirect to Google, never an XHR/fetch) -- same convention as
// useConnectGoogle()'s own connect() for the unrelated GBP flow.
export function GoogleButton({ href, label = 'Continue with Google', disabled = false }) {
  return (
    <a
      href={disabled ? undefined : href}
      aria-disabled={disabled}
      className="w-full rounded-lg border px-3.5 py-2.5 flex items-center justify-center gap-2.5 text-sm font-semibold transition-colors"
      style={{
        background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)',
        opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? 'none' : 'auto',
      }}
    >
      <GoogleGlyph />
      {label}
    </a>
  )
}

export function OrDivider() {
  return (
    <div className="flex items-center gap-3 my-6">
      <div className="h-px flex-1" style={{ background: 'var(--color-border)' }} />
      <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--color-text-3)' }}>or</span>
      <div className="h-px flex-1" style={{ background: 'var(--color-border)' }} />
    </div>
  )
}

function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.85 2.09-1.81 2.73v2.26h2.92c1.7-1.57 2.69-3.88 2.69-6.63z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33C2.44 15.98 5.48 18 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.71a5.4 5.4 0 0 1 0-3.42V4.96H.96a8.99 8.99 0 0 0 0 8.08l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
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
