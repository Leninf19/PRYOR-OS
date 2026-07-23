import { useState, useEffect } from 'react'
import Badge from '../../components/ui/Badge.jsx'
import Button from '../../components/ui/Button.jsx'
import Skeleton from '../../components/ui/Skeleton.jsx'
import EmptyState from '../../components/ui/EmptyState.jsx'
import ErrorState from '../../components/ui/ErrorState.jsx'
import ConfirmDialog from '../../components/ui/ConfirmDialog.jsx'
import { useToast } from '../../components/ui/Toast.jsx'
import { useGoogleOAuthStatus, useDisconnectGoogle } from '../../hooks/useGoogleOAuthStatus.js'

// Rebuilt for Phase 8, Milestone 8.7: the refresh token now lives in
// credentialStore.js (Redis, encrypted), not a Vercel env var -- reconnect
// takes effect immediately, no redeploy. Connection Status is one of five
// states (Connected/Token Expired/Token Revoked/Authentication Failed/
// Never Connected), matching credentialStore.js's GoogleHealth enum
// exactly, with a clear recovery action for every non-connected state
// instead of a raw Google API error.

const GBP_STEPS = [
  {
    n: 1,
    title: 'Submit API access request to Google',
    body: 'The Google Business Profile API is not publicly open — access must be approved by Google manually. Visit the GBP API prerequisites page and submit an "Application for Basic API Access." Use the business email that manages your GBP account. Approval typically takes 1–5 business days.',
    tag: 'Do this first',
    link: { label: 'Open prerequisites & request form ↗', href: 'https://developers.google.com/my-business/content/prereqs' },
  },
  {
    n: 2,
    title: 'Create a Google Cloud project',
    body: 'Go to console.cloud.google.com and create a new project (or use an existing one). Note the Project ID — you\'ll need it in the next steps.',
    tag: 'After approval',
  },
  {
    n: 3,
    title: 'Enable the required APIs',
    body: 'In your Cloud project → APIs & Services → Library, enable: "Google My Business API" (for reading and replying to reviews) and "My Business Account Management API" (to list all your locations).',
    tag: 'After approval',
  },
  {
    n: 4,
    title: 'Create OAuth 2.0 credentials',
    body: 'Go to Credentials → Create credentials → OAuth 2.0 Client ID. Set application type to "Web Application." Under "Authorized redirect URIs" add: https://[your-domain]/api/google/callback (replace [your-domain] with your Vercel production URL). This gives you a Client ID and Client Secret.',
    tag: 'After approval',
  },
  {
    n: 5,
    title: 'Add credentials to Vercel, then connect',
    body: 'In your Vercel project → Settings → Environment Variables, add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Click "Connect Google Account" below — from this point on, connecting and reconnecting never touch Vercel again; the connection is stored securely server-side and takes effect immediately.',
    tag: 'Final step',
  },
]

const PLANNED_GBP = [
  'One-click "Publish to Google" from every review card',
  'Automatic sync every 6 hours, plus critical-review alerts within ~15–30 minutes',
  'Auto-detect reviews already responded to on Google',
  'Full status tracking: Approved → Published → Confirmed on Google',
  'Failure alerts with exact reason (permission missing, review removed, etc.)',
]

// Connection Status -- the states the spec requires, mapped from
// credentialStore.js's GoogleHealth values (plus not_configured, a
// config-level gap distinct from a connection-health problem).
// 'quota_blocked' is deliberately NOT styled as 'danger' -- unlike the
// other non-connected states, the OAuth connection itself is fine; this
// is a Google Cloud project-level quota/access block discovered in
// production (project 786038057684), and looks (and is) less severe than
// a genuinely broken connection.
const STATUS_META = {
  connected:        { label: '✅ Connected', variant: 'success' },
  token_expired:    { label: '⚠ Token Expired', variant: 'warning' },
  token_revoked:    { label: '⚠ Token Revoked', variant: 'warning' },
  auth_failed:      { label: '⚠ Authentication Failed', variant: 'danger' },
  quota_blocked:    { label: '⚠ API Quota Blocked', variant: 'warning' },
  never_connected:  { label: 'Never Connected', variant: 'neutral' },
  not_configured:   { label: 'Setup Incomplete', variant: 'neutral' },
}

const RECOVERY_COPY = {
  token_expired: 'Your Google connection has expired. Click Reconnect below to restore it -- this takes about 30 seconds and does not affect any other settings.',
  token_revoked: 'Your Google connection was revoked (often because access was removed in the Google Account, or a password/security change invalidated it). Click Reconnect below to restore it.',
  auth_failed: 'Something went wrong communicating with Google. Try Reconnect below; if this keeps happening, check the technical details below for the specific reason.',
}

// Deliberately separate from RECOVERY_COPY above -- a quota block is not a
// "click Reconnect to fix it" situation (reconnecting re-runs the same
// OAuth flow and changes nothing about the Cloud project's quota/access),
// so this never tells the operator to reconnect, and is rendered in its
// own non-danger info box, not RECOVERY_COPY's box.
function quotaGuidance(projectNumber) {
  const projectClause = projectNumber
    ? `Google Cloud project ${projectNumber}`
    : 'the connected Google Cloud project'
  return `Google is blocking API calls for ${projectClause} due to a quota/access limit on the Business Profile Account Management API -- your Google account is still connected and the refresh token is valid, this is not an authentication problem. Ask whoever manages that Google Cloud project to check Google Cloud Console -> APIs & Services -> Business Profile Account Management API -> Quotas, and confirm API access has been fully granted (approval and quota increase are often separate steps). Reconnecting will not fix this.`
}

function fmtWhen(iso) {
  if (!iso) return 'Never'
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function useGbpSyncData() {
  const [state, setState] = useState({ loading: true, data: null, error: false })

  const load = () => {
    setState(s => ({ ...s, loading: true }))
    fetch('/api/data?file=gbp-sync.json')
      .then(r => {
        // 404 means no sync has ever run yet -- a legitimate empty state,
        // not a failure. Anything else (network/parse error) is a real error.
        if (r.status === 404) return null
        if (!r.ok) throw new Error(`gbp-sync.json returned ${r.status}`)
        return r.json()
      })
      .then(data => setState({ loading: false, data, error: false }))
      .catch(() => setState({ loading: false, data: null, error: true }))
  }

  useEffect(load, [])
  return { ...state, refetch: load }
}

// Renders one Test Connection check row.
function CheckRow({ c }) {
  const icon = c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '…'
  const color = c.status === 'pass' ? 'var(--color-success, #16a34a)'
    : c.status === 'fail' ? 'var(--color-danger, #dc2626)' : 'var(--color-text-3)'
  return (
    <div className="flex items-start gap-3 py-2">
      <span className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold"
            style={{ background: `${color}1a`, color }}>
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>{c.label}</p>
        <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: 'var(--color-text-3)' }}>{c.detail}</p>
      </div>
    </div>
  )
}

function TestConnectionPanel() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)

  const run = async () => {
    setRunning(true)
    setResult(null)
    try {
      const r = await fetch('/api/google/test-connection')
      setResult(await r.json())
    } catch (err) {
      setResult({ overallStatus: 'fail', checks: [{ id: 'network', label: 'Reach test endpoint', status: 'fail', detail: err.message }] })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="rounded-2xl border overflow-hidden"
         style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
      <div className="px-6 py-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Test Connection</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
            Walks OAuth → account → locations → reviews → reply permission, with the exact failure reason if any step breaks
          </p>
        </div>
        <button
          onClick={run}
          disabled={running}
          className="text-xs font-semibold px-3.5 py-2 rounded-lg border transition-colors flex-shrink-0"
          style={{ background: 'var(--color-accent)', borderColor: 'var(--color-accent)', color: 'white', opacity: running ? 0.6 : 1 }}>
          {running ? 'Testing…' : 'Run Test'}
        </button>
      </div>
      {result && (
        <div className="px-6 pb-5 pt-1 border-t divide-y" style={{ borderColor: 'var(--color-border)' }}>
          <div className="pt-3">
            <Badge variant={result.overallStatus === 'pass' ? 'success' : 'danger'}>
              {result.overallStatus === 'pass' ? 'All checks passed' : 'Connection issue found'}
            </Badge>
          </div>
          {result.checks.map(c => <CheckRow key={c.id} c={c} />)}
        </div>
      )}
    </div>
  )
}

function LocationSyncPanel({ onLinkedCount }) {
  const { loading, data, error, refetch } = useGbpSyncData()
  const [triggering, setTriggering] = useState(false)
  const [triggerMsg, setTriggerMsg] = useState(null)

  const locations = data?.locations || []
  const linkedCount = locations.filter(l => l.linked).length

  useEffect(() => {
    if (!loading && !error) onLinkedCount?.({ linked: linkedCount, total: locations.length })
  }, [loading, error, linkedCount, locations.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const syncNow = async () => {
    setTriggering(true)
    setTriggerMsg(null)
    try {
      const r = await fetch('/api/google/trigger-sync', { method: 'POST' })
      const d = await r.json()
      setTriggerMsg(d.success
        ? { ok: true, text: 'Sync started — this page reflects new data after the workflow finishes (a few minutes).' }
        : { ok: false, text: d.message || 'Could not trigger sync.' })
    } catch (err) {
      setTriggerMsg({ ok: false, text: err.message })
    } finally {
      setTriggering(false)
    }
  }

  return (
    <div className="rounded-2xl border overflow-hidden"
         style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
      <div className="px-6 py-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Location Sync</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
            {!loading && (data
              ? `${linkedCount} of ${locations.length} locations linked to Google`
              : !error && 'No sync data yet — run a sync to populate this view.')}
            {data?.lastRun && ` · last sync ${data.lastRun.status} at ${data.lastRun.finished_at || data.lastRun.started_at}`}
          </p>
        </div>
        <button
          onClick={syncNow}
          disabled={triggering}
          className="text-xs font-semibold px-3.5 py-2 rounded-lg border transition-colors"
          style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)', opacity: triggering ? 0.6 : 1 }}>
          {triggering ? 'Starting…' : 'Sync Now'}
        </button>
      </div>
      {triggerMsg && (
        <div className="px-6 pb-3 text-xs" style={{ color: triggerMsg.ok ? 'var(--color-text-2)' : 'var(--color-danger, #dc2626)' }}>
          {triggerMsg.text}
        </div>
      )}
      {loading && (
        <div className="px-6 pb-5 space-y-2">
          {[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}
        </div>
      )}
      {error && (
        <div className="border-t" style={{ borderColor: 'var(--color-border)' }}>
          <ErrorState body="Couldn't load location sync status." onRetry={refetch} />
        </div>
      )}
      {locations.length > 0 && (
        <div className="border-t max-h-72 overflow-y-auto overflow-x-auto" style={{ borderColor: 'var(--color-border)' }}>
          <table className="w-full text-xs" style={{ minWidth: 480 }}>
            <thead>
              <tr className="text-left" style={{ color: 'var(--color-text-3)' }}>
                <th className="px-6 py-2 font-medium">Location</th>
                <th className="px-3 py-2 font-medium">Reviews</th>
                <th className="px-3 py-2 font-medium">Linked</th>
                <th className="px-6 py-2 font-medium">Last Synced</th>
              </tr>
            </thead>
            <tbody>
              {locations.map(l => (
                <tr key={l.slug} className="border-t" style={{ borderColor: 'var(--color-border)' }}>
                  <td className="px-6 py-2" style={{ color: 'var(--color-text-1)' }}>{l.name}</td>
                  <td className="px-3 py-2" style={{ color: 'var(--color-text-2)' }}>{l.review_count}</td>
                  <td className="px-3 py-2">
                    <Badge variant={l.linked ? 'success' : 'neutral'}>{l.linked ? 'Yes' : 'Not yet'}</Badge>
                  </td>
                  <td className="px-6 py-2" style={{ color: 'var(--color-text-3)' }}>{l.gbp_last_synced_at || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && locations.length === 0 && (
        <div className="border-t" style={{ borderColor: 'var(--color-border)' }}>
          <EmptyState icon="📍" title="No locations found"
                      body="Sync data exists but no locations are recorded yet — try Sync Now." />
        </div>
      )}
    </div>
  )
}

// One-time reconciliation between existing scraped reviews and the Google
// API (gbp_import.py) -- preview first, then a confirmed apply, never a
// single blind click straight to writing 16,000+ reviews.
function HistoricalImportPanel() {
  const [triggering, setTriggering] = useState(null) // null | 'preview' | 'apply'
  const [msg, setMsg] = useState(null)
  const [confirmText, setConfirmText] = useState('')

  const trigger = async (apply) => {
    setTriggering(apply ? 'apply' : 'preview')
    setMsg(null)
    try {
      const r = await fetch('/api/google/trigger-import', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ apply }),
      })
      const d = await r.json()
      setMsg(d.success
        ? {
            ok: true,
            text: apply
              ? 'Import started — check the "Historical Import" workflow run in GitHub Actions for the full report and commit.'
              : 'Preview started — check the "Historical Import" workflow run in GitHub Actions (job summary) for the match-rate report. Nothing is written in preview mode.',
          }
        : { ok: false, text: d.message || 'Could not trigger the import.' })
      if (apply) setConfirmText('')
    } catch (err) {
      setMsg({ ok: false, text: err.message })
    } finally {
      setTriggering(null)
    }
  }

  return (
    <div className="rounded-2xl border overflow-hidden"
         style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
      <div className="px-6 py-5">
        <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>Historical Import</p>
        <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--color-text-3)' }}>
          One-time reconciliation of every existing scraped review against Google's own records. Always preview
          first — it changes nothing and shows the match rate — before running the real import.
        </p>
      </div>
      <div className="px-6 pb-5 pt-1 border-t space-y-3" style={{ borderColor: 'var(--color-border)' }}>
        <div className="flex items-center gap-3 flex-wrap pt-3">
          <button
            onClick={() => trigger(false)}
            disabled={triggering !== null}
            className="text-xs font-semibold px-3.5 py-2 rounded-lg border transition-colors"
            style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)', opacity: triggering ? 0.6 : 1 }}>
            {triggering === 'preview' ? 'Starting…' : 'Preview Import'}
          </button>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              placeholder='Type "IMPORT" to enable'
              aria-label='Type IMPORT to confirm running the historical import'
              className="text-xs px-2.5 py-2 rounded-lg border w-40 focus:outline-none"
              style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
            />
            <button
              onClick={() => trigger(true)}
              disabled={triggering !== null || confirmText !== 'IMPORT'}
              className="text-xs font-semibold px-3.5 py-2 rounded-lg border transition-colors"
              style={{
                background: confirmText === 'IMPORT' ? 'var(--color-accent)' : 'var(--color-surface-2)',
                borderColor: confirmText === 'IMPORT' ? 'var(--color-accent)' : 'var(--color-border)',
                color: confirmText === 'IMPORT' ? 'white' : 'var(--color-text-3)',
                opacity: triggering ? 0.6 : 1,
              }}>
              {triggering === 'apply' ? 'Starting…' : 'Run Import'}
            </button>
          </div>
        </div>
        {msg && (
          <p className="text-xs" style={{ color: msg.ok ? 'var(--color-text-2)' : 'var(--color-danger, #dc2626)' }}>
            {msg.text}
          </p>
        )}
      </div>
    </div>
  )
}

export default function GoogleBusinessProfile() {
  const showToast = useToast()
  const [stepsOpen, setStepsOpen] = useState(false)
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const [linkedLocations, setLinkedLocations] = useState(null)
  const { data: status, isLoading, refetch } = useGoogleOAuthStatus()
  const disconnectMutation = useDisconnectGoogle()

  const state = status?.state ?? (isLoading ? null : 'never_connected')
  const meta = STATUS_META[state] ?? STATUS_META.never_connected
  const isConnected = state === 'connected'
  const hasEverConnected = state && state !== 'never_connected' && state !== 'not_configured'
  const needsRecovery = ['token_expired', 'token_revoked', 'auth_failed'].includes(state)
  // quota_blocked is intentionally excluded from needsRecovery -- it gets
  // its own guidance box below (quotaGuidance()), never RECOVERY_COPY's
  // "click Reconnect" framing.
  const isQuotaBlocked = state === 'quota_blocked'

  async function handleDisconnect() {
    try {
      await disconnectMutation.mutateAsync('DISCONNECT')
      showToast('Google Business Profile disconnected', { variant: 'success' })
      setDisconnectOpen(false)
    } catch (err) {
      showToast(err.message || 'Could not disconnect', { variant: 'error' })
    }
  }

  return (
    <div className="space-y-4">

      {/* Status card */}
      <div className="rounded-2xl border overflow-hidden"
           style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
        <div className="px-6 py-5 flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                 style={{ background: 'rgba(217,119,6,0.07)' }}>
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>
                Google Business Profile
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
                Read and reply to reviews via the official GBP API
              </p>
            </div>
          </div>
          <Badge variant={isLoading ? 'neutral' : meta.variant}>{isLoading ? '…' : meta.label}</Badge>
        </div>

        <div className="px-6 py-4 border-t" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-2)' }}>
          {needsRecovery && (
            <div className="mb-3 rounded-lg p-3" style={{ background: 'var(--color-danger-bg, rgba(220,38,38,0.06))', border: '1px solid var(--color-danger-border, rgba(220,38,38,0.2))' }}>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-1)', lineHeight: 1.7 }}>
                {RECOVERY_COPY[state]}
              </p>
            </div>
          )}
          {isQuotaBlocked && (
            <div className="mb-3 rounded-lg p-3" style={{ background: 'rgba(217,119,6,0.07)', border: '1px solid rgba(217,119,6,0.2)' }}>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-1)', lineHeight: 1.7 }}>
                {quotaGuidance(status?.quotaProjectNumber)}
              </p>
            </div>
          )}

          {hasEverConnected ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                {[
                  { label: 'Connected Google Account', value: status?.accountName || status?.connectedAccountName || '—' },
                  { label: 'Last Authentication', value: fmtWhen(status?.lastOAuthRefreshAt) },
                  { label: 'Last Successful Sync', value: fmtWhen(status?.lastSuccessfulSyncAt) },
                  { label: 'Last Failed Sync', value: fmtWhen(status?.lastFailedSyncAt) },
                  { label: 'Token Health', value: isConnected ? (status?.tokenExpiresIn ? `Valid — expires in ${status.tokenExpiresIn}s` : 'Valid') : isQuotaBlocked ? 'Valid (Google API quota blocked)' : (status?.lastFailureReason || 'Unavailable') },
                  { label: 'Number of Linked Locations', value: linkedLocations ? `${linkedLocations.linked} of ${linkedLocations.total}` : '—' },
                ].map(row => (
                  <div key={row.label}>
                    <p className="text-[10px] font-medium" style={{ color: 'var(--color-text-3)' }}>{row.label}</p>
                    <p className="text-xs font-mono mt-0.5 break-all" style={{ color: 'var(--color-text-1)' }}>{row.value}</p>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-3 flex-wrap mt-3">
                {/* For a quota block, Reconnect is kept only as a secondary
                    action (plain surface styling, not the accent primary
                    button) -- reconnecting doesn't fix a Cloud-project
                    quota/access problem, so it must never look like the
                    primary fix the way it correctly does for every other
                    non-connected state. */}
                <a href="/api/google/auth"
                   className="text-xs font-semibold px-3.5 py-2 rounded-lg border transition-colors"
                   style={isQuotaBlocked
                     ? { background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }
                     : { background: 'var(--color-accent)', borderColor: 'var(--color-accent)', color: 'white' }}>
                  Reconnect →
                </a>
                <Button variant="danger" onClick={() => setDisconnectOpen(true)}>Disconnect</Button>
              </div>

              {status?.error && (
                <details className="mt-3">
                  <summary className="text-[10px] cursor-pointer" style={{ color: 'var(--color-text-3)' }}>Technical details</summary>
                  <p className="text-[11px] mt-1 font-mono" style={{ color: 'var(--color-text-3)' }}>{status.error}</p>
                </details>
              )}
            </>
          ) : (
            <>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)', lineHeight: 1.75 }}>
                Once connected, one Google account covers all 21 locations. Future Insights can publish
                responses directly to Google, sync new reviews automatically, and track publish status
                for every response your team sends.
              </p>
              <div className="mt-3 flex items-center gap-3 flex-wrap">
                {state === 'never_connected' && (
                  <a href="/api/google/auth"
                     className="text-xs font-semibold px-3.5 py-2 rounded-lg border transition-colors"
                     style={{ background: 'var(--color-accent)', borderColor: 'var(--color-accent)', color: 'white' }}>
                    Connect Google Account →
                  </a>
                )}
                <button
                  onClick={() => setStepsOpen(s => !s)}
                  className="text-xs font-semibold px-3.5 py-2 rounded-lg border transition-colors"
                  style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)', color: 'var(--color-text-1)' }}>
                  {stepsOpen ? 'Hide setup guide' : 'View setup guide (5 steps)'}
                </button>
                {state === 'not_configured' && (
                  <span className="text-[10px]" style={{ color: 'var(--color-text-3)' }}>
                    Requires Google API approval · 1–5 business days
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Diagnostics -- only meaningful once credentials exist */}
      {hasEverConnected && (
        <>
          <TestConnectionPanel />
          <LocationSyncPanel onLinkedCount={setLinkedLocations} />
          <HistoricalImportPanel />
        </>
      )}

      {/* Setup steps */}
      {stepsOpen && (
        <div className="rounded-2xl border overflow-hidden"
             style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
          <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em]"
               style={{ color: 'var(--color-text-3)' }}>
              Setup Guide · 5 Steps
            </p>
          </div>

          <div className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
            {GBP_STEPS.map(step => (
              <div key={step.n} className="px-6 py-4 flex gap-4">
                <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 text-[11px] font-bold"
                     style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)', border: '1px solid var(--color-border)' }}>
                  {step.n}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1.5">
                    <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>
                      {step.title}
                    </p>
                    <span className="text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide"
                          style={{ background: 'rgba(217,119,6,0.07)', color: 'var(--color-grade-c)', border: '1px solid rgba(217,119,6,0.15)' }}>
                      {step.tag}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-2)', lineHeight: 1.75 }}>
                    {step.body}
                  </p>
                  {step.link && (
                    <a href={step.link.href} target="_blank" rel="noopener noreferrer"
                       className="inline-block mt-2 text-xs font-medium underline"
                       style={{ color: 'var(--color-accent)' }}>
                      {step.link.label}
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Technical reference */}
          <div className="px-6 py-4 border-t" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-2)' }}>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] mb-3"
               style={{ color: 'var(--color-text-3)' }}>
              Technical Reference
            </p>
            <div className="space-y-2">
              {[
                { label: 'API base URL',     value: 'https://mybusiness.googleapis.com/v4' },
                { label: 'OAuth scope',      value: 'https://www.googleapis.com/auth/business.manage' },
                { label: 'Reply endpoint',   value: 'PUT .../reviews/{reviewId}/reply' },
                { label: 'Rate limit',       value: '300 requests/minute (after approval)' },
                { label: 'Location coverage', value: 'All 21 locations under one Google account token' },
              ].map(row => (
                <div key={row.label} className="flex items-start gap-3">
                  <span className="text-[10px] w-28 flex-shrink-0 font-medium mt-0.5"
                        style={{ color: 'var(--color-text-3)' }}>
                    {row.label}
                  </span>
                  <code className="text-[10px] px-1.5 py-0.5 rounded font-mono break-all leading-relaxed"
                        style={{ background: 'var(--color-surface)', color: 'var(--color-text-2)', border: '1px solid var(--color-border)' }}>
                    {row.value}
                  </code>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* What this unlocks */}
      <div className="rounded-2xl border p-5"
           style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
        <p className="text-[10px] font-bold uppercase tracking-[0.15em] mb-3"
           style={{ color: 'var(--color-text-3)' }}>
          What connecting unlocks
        </p>
        <ul className="space-y-2">
          {PLANNED_GBP.map((item, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
                    style={{ background: 'var(--color-accent)' }} />
              <p className="text-xs" style={{ color: 'var(--color-text-2)' }}>{item}</p>
            </li>
          ))}
        </ul>
      </div>

      <ConfirmDialog
        open={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        onConfirm={handleDisconnect}
        title="Disconnect Google Business Profile"
        body="This permanently removes the stored connection. Publishing replies and syncing new reviews from Google will stop until you reconnect."
        confirmLabel="Disconnect"
        confirmWord="DISCONNECT"
        danger
        busy={disconnectMutation.isPending}
      />
    </div>
  )
}
