import { useState, useMemo, useCallback, useRef, useEffect, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useToast } from '../components/ui/Toast.jsx'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Button from '../components/ui/Button.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import { sentimentBucket, reviewId, computeNextReviewId } from '../utils/dataUtils.js'
import { exportCSV } from '../utils/exportUtils.js'
import { useResponseDrafts } from '../hooks/useIntelligence.js'
import { useReviewWorkspace } from '../hooks/useReviewWorkspace.js'
import { useActionWorkspace } from '../hooks/useActionWorkspace.js'
import { useReviewEmailPreview, useSendReviewEmail } from '../hooks/useReviewEmailWorkflow.js'
import { useRestaurantContacts } from '../hooks/useRestaurantContacts.js'
import ContactEditorModal from './settings/ContactEditorModal.jsx'
import { useAccount } from '../components/AuthGate.jsx'
import { EMAIL_STATUS_META, DUPLICATE_EMAIL_STATUSES } from '../utils/actionWorkspaceUtils.js'
import { REPLY_STATE_META, computeReplyState, isActionableReplyState, isAnsweredReplyState, isSeriousReview, computeReplyStateCounts } from '../utils/replyState.js'

const PAGE_SIZE = 40

// M5 bug fix: the inbox shell must render the detail content in exactly ONE
// place at a time (either the desktop persistent panel or the mobile
// overlay). Toggling *visibility* with `lg:hidden`/`hidden lg:block` alone
// still MOUNTS both -- meaning ResponseWorkspace's own stateful draft text
// (a plain useState, not synced from wsEntry after mount) would exist as
// two independent instances simultaneously. Editing the draft in the
// visible one would never reach the hidden one, so resizing the window
// could suddenly reveal stale, pre-edit draft text. Tracks the same
// breakpoint Tailwind's `lg:` uses (1024px) via matchMedia so only one
// instance ever mounts.
const DESKTOP_QUERY = '(min-width: 1024px)'
function subscribeIsDesktop(callback) {
  const mql = window.matchMedia(DESKTOP_QUERY)
  mql.addEventListener('change', callback)
  return () => mql.removeEventListener('change', callback)
}
function getIsDesktopSnapshot() {
  return window.matchMedia(DESKTOP_QUERY).matches
}
function useIsDesktop() {
  return useSyncExternalStore(subscribeIsDesktop, getIsDesktopSnapshot, () => true)
}

// ─── Response workspace constants (ported from the former ActionItems.jsx) ────

const STATUS_META = {
  needs_review:  { label: 'Needs Review',   variant: 'warning', done: false },
  draft_ready:   { label: 'AI Draft Ready', variant: 'accent',  done: false },
  edited:        { label: 'Edited',         variant: 'info',    done: false },
  approved:      { label: 'Approved',       variant: 'success', done: false },
  published:     { label: 'Published',      variant: 'success', done: true  },
  failed:        { label: 'Failed',         variant: 'danger',  done: false },
  taken_care_of: { label: 'Done',           variant: 'neutral', done: true  },
}

// M5's reply-state model (REPLY_STATE_META/computeReplyState) now lives in
// ../utils/replyState.js -- extracted in M6 so Actions.jsx's "Waiting on
// Confirmation" section can reuse the exact same mapping instead of
// duplicating it. `taken_care_of` (an existing 6th, unrelated operational
// status -- "handled, no reply needed") is intentionally NOT one of the 5
// reply states; it keeps its own existing "Done" badge
// (STATUS_META.taken_care_of) unchanged, handled locally below.

const TONES = [
  { id: 'friendly',     label: 'Friendly'      },
  { id: 'professional', label: 'Professional'  },
  { id: 'short',        label: 'Short'         },
  { id: 'warm',         label: 'Warm'          },
  { id: 'apologetic',   label: 'Apologetic'    },
  { id: 'personal',     label: 'Personal'      },
  { id: 'seo',          label: 'SEO Boost'     },
  { id: 'spanish',      label: 'En Español'    },
]

const FAIL_REASONS = {
  not_connected:     'Google Business Profile is not connected. Complete the setup in Settings → Google Integration.',
  missing_permission:'The connected Google account does not have Manager or Owner access to this location.',
  api_error:         'Google API returned an error. Try again or contact support.',
  review_gone:       'This review no longer exists on Google — it may have been removed.',
  network_error:     'Network error. Check your connection and try again.',
  location_mismatch: 'Could not match this review to a verified Google location.',
  already_replied:   'This review already has an owner response on Google.',
  // Recovery Milestone 5: distinct from network_error -- this means OUR
  // OWN watchdog gave up waiting, not that the request definitely failed.
  // Google's reply endpoint is a PUT (an idempotent upsert), so retrying
  // the same text is always safe -- it can never create a duplicate reply,
  // even if the first attempt actually went through before we stopped
  // waiting for it.
  timeout: 'This took longer than expected — it may have already gone through on Google\'s side. Retrying is safe and will never create a duplicate reply; check Confirmed/Externally Replied first if you\'d like to be sure before retrying.',
}

function fmtWhen(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString()
}

function priority(r) {
  const stars   = Number(r.star_rating) || 3
  const daysOld = (Date.now() - new Date((r.review_date || '2020-01-01') + 'T12:00:00').getTime()) / 86400000
  return (6 - stars) * 10 + Math.min(daysOld, 60)
}

// Rating trend alerts, recomputed from whatever date range is currently
// selected (via the global filter bar) instead of a fixed 30-vs-60-day window.
function computeTrendAlerts(current, prior) {
  const curByLoc = {}, priorByLoc = {}
  current.forEach(r => {
    if (r.star_rating == null) return
    (curByLoc[r.location_name] ??= []).push(r.star_rating)
  })
  prior.forEach(r => {
    if (r.star_rating == null) return
    (priorByLoc[r.location_name] ??= []).push(r.star_rating)
  })
  const avg = arr => arr.reduce((s, n) => s + n, 0) / arr.length
  const alerts = []
  for (const name of Object.keys(curByLoc)) {
    const cur = curByLoc[name], prev = priorByLoc[name]
    if (!prev || cur.length < 5 || prev.length < 5) continue
    const avgCur = avg(cur), avgPrev = avg(prev)
    const delta = avgCur - avgPrev
    if (Math.abs(delta) >= 0.2) {
      alerts.push({
        name, avgCur: +avgCur.toFixed(2), avgPrev: +avgPrev.toFixed(2),
        delta: +delta.toFixed(2), curN: cur.length, prevN: prev.length,
      })
    }
  }
  return alerts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
}

// Recovery Milestone 6B, Part 5: bulk read of the durable publish-bridge
// records for a bounded set of reviews -- one request for up to
// PUBLISH_BRIDGE_MAX_IDS_CLIENT ids, never one request per review. Returns
// {} on any failure (network error, degraded backend, unauthenticated) --
// this is a best-effort enrichment layer, never something that should block
// the page from rendering the reviews it already has.
async function fetchPublishBridges(ids) {
  if (!ids.length) return {}
  try {
    const res = await fetch('/api/google/publish-bridge', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ ids }),
    })
    if (!res.ok) return {}
    const data = await res.json().catch(() => ({}))
    return data.bridges || {}
  } catch {
    return {}
  }
}

async function callRewrite(payload) {
  const res = await fetch('/api/rewrite', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(payload),
  })
  if (!res.ok) {
    const msg = await res.text().catch(() => 'Unknown error')
    throw new Error(msg)
  }
  const data = await res.json()
  if (!data.rewritten) throw new Error('Empty response from AI')
  return data.rewritten
}

// ─── GBP connection banner ─────────────────────────────────────────────────────

function GBPBanner() {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem('gbp_banner_v1') === '1'
  )
  if (dismissed) return null

  return (
    <div className="rounded-xl p-4 flex items-start gap-3 border"
         style={{ background: 'rgba(217,119,6,0.05)', borderColor: 'rgba(217,119,6,0.2)' }}>
      <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
           style={{ background: 'rgba(217,119,6,0.1)' }}>
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" style={{ color: 'var(--color-grade-c)' }}>
          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/>
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold" style={{ color: 'var(--color-text-1)' }}>
          Google Business Profile not connected
        </p>
        <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
          Use <strong>Copy Response</strong> + <strong>Open Google</strong> to paste manually.
          For one-click publishing, see{' '}
          <a href="/settings" className="underline" style={{ color: 'var(--color-accent)' }}>
            Settings → Google Integration
          </a>.
        </p>
      </div>
      <button
        onClick={() => { setDismissed(true); localStorage.setItem('gbp_banner_v1', '1') }}
        className="text-[10px] flex-shrink-0 mt-0.5"
        style={{ color: 'var(--color-text-3)' }}>
        Dismiss
      </button>
    </div>
  )
}

// ─── Workspace stats bar (shown when the "Needs Response" quick filter is active) ──

function WorkspaceStats({ reviews, ws, draftByReviewId, bridges }) {
  const total     = reviews.length
  // Recovery Milestone 5, Problem 3: this only counted the scheduled batch
  // export (draftByReviewId), so once on-demand/prewarmed generation started
  // persisting drafts straight into the workspace instead, this metric
  // under-reported (often showing 0 even with drafts genuinely ready) --
  // exactly the "broken pipeline" the metric needs to reflect accurately
  // rather than be removed. A review counts once it has a draft from either
  // source, unedited by a human (status 'draft_ready') or the original
  // scheduled export.
  const withDraft = reviews.filter(r =>
    Boolean(draftByReviewId[r.review_id || r.review_url || '']) || ws[reviewId(r)]?.status === 'draft_ready'
  ).length
  const urgent    = reviews.filter(r => (r.star_rating ?? 5) <= 1).length
  // Recovery Milestone 6B, Part 10: "done" now also recognizes the durable
  // publish bridge and Google's own owner_response (isAnsweredReplyState),
  // not just a same-browser workspace 'published'/'taken_care_of' status --
  // otherwise this count would under-report exactly the same way "AI Draft
  // Ready" did before Milestone 5 fixed its own equivalent gap.
  const done      = reviews.filter(r =>
    isAnsweredReplyState(r, ws[reviewId(r)], bridges[reviewId(r)]) || STATUS_META[ws[reviewId(r)]?.status]?.done
  ).length

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[
        { label: 'Needs Reply',       value: total,     color: 'var(--color-danger)'  },
        { label: 'AI Draft Ready',    value: withDraft, color: 'var(--color-accent)'  },
        { label: '1★ Urgent',         value: urgent,    color: 'var(--color-grade-c)' },
        { label: 'Completed',         value: done,      color: 'var(--color-success)' },
      ].map(s => (
        <div key={s.label} className="rounded-2xl p-4 border"
             style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}>
          <p className="text-2xl font-black" style={{ color: s.value > 0 ? s.color : 'var(--color-text-1)', fontWeight: 800 }}>
            {s.value}
          </p>
          <p className="text-[10px] font-bold uppercase tracking-wider mt-1"
             style={{ color: 'var(--color-text-3)' }}>
            {s.label}
          </p>
        </div>
      ))}
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function ReplyStateBadge({ r, wsEntry, bridgeEntry }) {
  // taken_care_of is a separate, unrelated operational status (handled, no
  // reply needed) -- keeps its own existing "Done" badge rather than being
  // forced into one of the 5 reply-state values it doesn't semantically fit.
  if (wsEntry?.status === 'taken_care_of') {
    return <Badge variant={STATUS_META.taken_care_of.variant}>{STATUS_META.taken_care_of.label}</Badge>
  }
  const state = computeReplyState(r, wsEntry, bridgeEntry)
  const meta = REPLY_STATE_META[state]
  return <Badge variant={meta.variant}>{meta.label}</Badge>
}

// ─── Filter bar ───────────────────────────────────────────────────────────────
// M5.3: reply-state quick filters (pills) per the frozen wireframe (Needs
// reply / Draft / Confirmed / Failed / Externally replied), replacing the
// old single "No reply only" checkbox with the same underlying predicate
// reachable through the new state vocabulary -- filtering behavior is
// identical for every non-pending review; only the control surface changed.

const REPLY_STATE_FILTERS = ['needs_reply', 'draft', 'confirmed', 'failed', 'externally_replied']

// Filtering UX Cleanup: `counts` (optional) shows, per state, how many
// reviews in the CURRENT GLOBAL scope (App.jsx's date/location/brand/star
// filters -- see Reviews()'s replyStateCounts memo) have that reply state --
// independent of whichever of these pills is currently active, so a manager
// can see "4 Drafts exist" even while "Needs Reply" is the selected view.
function ReplyStatePills({ selected, onChange, counts }) {
  function toggle(state) {
    onChange(selected.includes(state) ? selected.filter(s => s !== state) : [...selected, state])
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {REPLY_STATE_FILTERS.map(state => {
        const meta = REPLY_STATE_META[state]
        const active = selected.includes(state)
        return (
          <button
            key={state}
            type="button"
            onClick={() => toggle(state)}
            aria-pressed={active}
            className="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors"
            style={active
              ? { background: 'var(--color-accent)', color: 'white', borderColor: 'var(--color-accent)' }
              : { background: 'transparent', color: 'var(--color-text-2)', borderColor: 'var(--color-border)' }}>
            {meta.label}{counts != null && ` (${counts[state] ?? 0})`}
          </button>
        )
      })}
    </div>
  )
}

// Filtering UX Cleanup: date range, locations, brands, and stars are now
// EXCLUSIVELY the global filter bar's responsibility (App.jsx/
// GlobalFilters.jsx) -- this page receives the already-globally-filtered
// `filtered` dataset as a prop and only ever applies workflow/status
// filters on top of it (reply state, sentiment, review length, free-text
// search). The star and location selects that used to live here were a
// second, weaker, disagreeing copy of two of the four global dimensions
// (single-select vs. the global bar's multi-select, no visibility into the
// full authorized location set, no shared persistence) -- removed outright,
// not synchronized, so there is exactly one place to set them.
function FilterBar({
  keyword, onKeyword, replyStates, onReplyStates, replyStateCounts,
  sentiment, onSentiment, length, onLength, count,
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {/* Keyword */}
        <div className="flex-1 min-w-48 relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
               style={{ color: 'var(--color-text-3)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
          <input
            type="search"
            placeholder="Search reviews…"
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

        {/* AI Sentiment filter -- a review-workflow lens, not a global
            filtering dimension (App.jsx/GlobalFilters.jsx has no sentiment
            axis), so it stays local. */}
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

        {/* Review length filter -- also not a global dimension, stays local. */}
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

        <span className="text-xs ml-auto" style={{ color: 'var(--color-text-3)' }}>
          {count.toLocaleString()} results
        </span>
      </div>

      <ReplyStatePills selected={replyStates} onChange={onReplyStates} counts={replyStateCounts} />
    </div>
  )
}

// ─── Review row (compact, single-line -- inbox layout shell, M5.1) ────────────
// Per the frozen wireframe's own example rows ("★1 Jane D.  Pending"), the
// list row shows only stars + reviewer + location + reply-state badge --
// review text, tags, and AI reasoning move to the detail panel exclusively
// (nothing is dropped, it's relocated, matching the master-detail pattern
// the wireframe specifies). Compact row height per Design System
// Specification v1.0 Phase 2 ("36px 'compact' variant... for the Reviews
// inbox, which needs to show more rows per screen than an analytics table").

function ReviewRow({ r, selected, onSelect, wsEntry, bridgeEntry }) {
  return (
    <div
      className="flex items-center gap-3 px-4 border-b cursor-pointer transition-colors"
      style={{
        height: 36,
        borderColor: 'var(--color-border)',
        background: selected ? 'var(--color-surface-2)' : 'var(--color-surface)',
      }}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onSelect() }}
      aria-selected={selected}
    >
      <span className="flex-shrink-0 w-16"><StarBadge n={r.star_rating ?? 1} /></span>
      <span className="flex-1 min-w-0 text-xs font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>
        {r.reviewer_name || 'Anonymous'}
        <span className="font-normal ml-1.5" style={{ color: 'var(--color-text-3)' }}>
          · {r.location_name}
        </span>
      </span>
      <span className="hidden sm:inline flex-shrink-0 text-[10px]" style={{ color: 'var(--color-text-3)' }}>
        {r.review_date}
      </span>
      <span className="flex-shrink-0"><ReplyStateBadge r={r} wsEntry={wsEntry} bridgeEntry={bridgeEntry} /></span>
    </div>
  )
}

// ─── Response workspace section (inside the detail panel) ─────────────────────

// Recovery Milestone 4, Phase 14: a serious_escalation-classified review
// must not be a routine one-click publish. Gated by a single explicit
// acknowledgment (not a second confirmation on every normal publish -- only
// this one class) before Confirm & Publish becomes clickable. Resets
// per-review (keyed by rid via the parent unmounting/remounting this
// component on selection change -- see Reviews.jsx's master-detail panel).
function SeriousReviewWarning({ acknowledged, onAcknowledge }) {
  return (
    <div className="mb-3 p-3 rounded-xl text-xs leading-relaxed"
         style={{ background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger-border)', color: 'var(--color-danger)' }}>
      <p className="font-bold mb-1">⚠ Needs Management Review</p>
      <p className="mb-2" style={{ color: 'var(--color-text-2)' }}>
        This review mentions something serious (a safety, legal, or conduct concern). Read it carefully before
        responding — a contact invitation may be appropriate here, unlike a routine review.
      </p>
      <label className="flex items-center gap-2 cursor-pointer" style={{ color: 'var(--color-text-1)' }}>
        <input type="checkbox" checked={acknowledged} onChange={e => onAcknowledge(e.target.checked)} />
        I've reviewed this and I'm ready to respond
      </label>
    </div>
  )
}

function ResponseWorkspace({ r, draft, wsEntry, onUpdate, onPublishSuccess, nextReviewId }) {
  const showToast       = useToast()
  const rid              = reviewId(r)
  const initialStatus    = draft ? 'draft_ready' : 'needs_review'
  const status           = wsEntry?.status ?? initialStatus
  const statusMeta       = STATUS_META[status] ?? STATUS_META.needs_review
  const isDone            = statusMeta.done
  const failReason       = wsEntry?.failReason ?? null
  const serious          = useMemo(() => isSeriousReview(r), [r])

  const [localDraft, setLocalDraft]   = useState(wsEntry?.editedDraft ?? draft?.draft ?? '')
  const [activeTone, setActiveTone]   = useState(null)
  const [lastTone,   setLastTone]     = useState(null)
  const [rewriting,  setRewriting]    = useState(false)
  const [rewriteErr, setRewriteErr]   = useState(null)
  // Recovery Milestone 5: explicit publish state machine
  // (idle -> publishing -> success | failed) instead of a single boolean --
  // 'success' is transient (this instance unmounts via onPublishSuccess()'s
  // review switch, or the queue empties, before it would ever need to
  // render), but making publishing/failed distinct from "never attempted"
  // is what lets a failure carry its own message without a stale boolean.
  const [publishState, setPublishState] = useState('idle') // 'idle' | 'publishing' | 'failed'
  const publishing = publishState === 'publishing'
  const [copied,     setCopied]       = useState(false)
  const [moreOpen,   setMoreOpen]     = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const textareaRef = useRef(null)
  // A ref, not state -- guards the actual double-submit race a fast double-
  // click/double-Enter can win against React's own render cycle (the
  // `disabled` attribute only reflects `publishing` state after the next
  // render; this is checked synchronously, before that render happens).
  const publishInFlight = useRef(false)

  const wasEdited = wsEntry?.status === 'edited'
  // AI-prepared covers both sources: the scheduled batch export (`draft`)
  // and an on-demand-generated one persisted into the workspace below --
  // both are "prepared, not yet touched by a manager."
  const isAiPrepared = (Boolean(draft) || wsEntry?.status === 'draft_ready') && !wasEdited

  // Recovery Milestone 5, Problem 2: if this actionable review has no
  // draft anywhere (no scheduled batch export, no persisted workspace
  // edit/generation), generate one automatically, once, the moment it's
  // opened -- reuses the same /api/rewrite endpoint and Phase-3 safety
  // guard the manual "AI Rewrite Tone" buttons already call, just
  // triggered automatically instead of by a click. Persisted into the
  // SAME localStorage-backed workspace editedDraft field a manual rewrite
  // already uses (status: 'draft_ready', not 'edited' -- this is prepared
  // text, not something the manager wrote), so reopening this review later
  // never re-generates: `hasAnyDraft` below becomes true and the effect's
  // own guard condition no longer matches. Explicit Regenerate is the only
  // other path back through this endpoint.
  const hasAnyDraft = Boolean(draft?.draft) || Boolean(wsEntry?.editedDraft)
  const [autoGenerating, setAutoGenerating] = useState(false)
  const [autoGenerateErr, setAutoGenerateErr] = useState(null)
  const autoGenerateAttempted = useRef(false)

  useEffect(() => {
    if (hasAnyDraft || isDone || autoGenerateAttempted.current) return
    autoGenerateAttempted.current = true
    setAutoGenerating(true)
    setAutoGenerateErr(null)
    callRewrite({
      tone: 'friendly',
      reviewText:   r.review_text  || '',
      currentDraft: '',
      reviewerName: r.reviewer_name || 'Guest',
      location:     r.location_name || 'our restaurant',
      stars:        r.star_rating   ?? 1,
      // Multi-Location Authentication & User Access System: required for a
      // location-scoped account (location_manager, or a scoped Marketing
      // account) to be authorized at all -- see dashboard/api/rewrite.js.
      // Owner/Admin/company-wide Marketing continue working unchanged
      // without it.
      localReviewId: rid,
    }).then(generated => {
      setLocalDraft(generated)
      onUpdate(rid, { editedDraft: generated, status: 'draft_ready' })
    }).catch(e => {
      setAutoGenerateErr(
        e.message?.includes('ANTHROPIC_API_KEY') || e.message?.includes('401') || /credit/i.test(e.message || '')
          ? 'AI is currently unavailable — you can still write your own response below.'
          : 'Could not prepare a response automatically. You can still write your own below.'
      )
    }).finally(() => setAutoGenerating(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per
    // mounted review (this component is now keyed by review id), guarded by
    // autoGenerateAttempted against StrictMode's dev-only double-invoke.
  }, [])

  function onTextChange(val) {
    setLocalDraft(val)
    onUpdate(rid, { editedDraft: val, status: 'edited' })
  }

  function handleCopy() {
    if (!localDraft) return
    navigator.clipboard?.writeText(localDraft)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  async function handleRewrite(tone) {
    if (rewriting) return
    setActiveTone(tone)
    setLastTone(tone)
    setRewriting(true)
    setRewriteErr(null)
    try {
      const rewritten = await callRewrite({
        tone,
        reviewText:   r.review_text  || '',
        currentDraft: localDraft,
        reviewerName: r.reviewer_name || 'Guest',
        location:     r.location_name || 'our restaurant',
        stars:        r.star_rating   ?? 1,
        localReviewId: rid,
      })
      setLocalDraft(rewritten)
      onUpdate(rid, { editedDraft: rewritten, status: 'edited' })
    } catch (e) {
      setRewriteErr(
        e.message?.includes('ANTHROPIC_API_KEY') || e.message?.includes('401')
          ? 'AI rewrite unavailable — add ANTHROPIC_API_KEY to Vercel environment variables.'
          : (e.message || 'Rewrite failed. Try again.')
      )
    } finally {
      setRewriting(false)
      setActiveTone(null)
    }
  }

  const publishBlocked = !localDraft || publishing || (serious && !acknowledged)

  // Recovery Milestone 5 root cause: the previous version had no bound on
  // how long a publish request could take before the UI gave up -- proven
  // by reproduction (a route that never resolves leaves the button
  // permanently disabled on "Publishing…" with zero recovery). The
  // concrete real-world trigger is /api/google/publish's own fallback
  // lookup path (used whenever a review has no gbp_review_name yet --
  // still true for a meaningful share of the actionable backlog): it makes
  // several sequential, paginated Google API calls with no per-call
  // timeout, only Vercel's platform-level function limit as an eventual
  // (and much longer) backstop. This watchdog is a bounded, generous
  // safety net for that -- NOT a substitute for the fallback path itself
  // eventually being unnecessary once more reviews are GBP-linked.
  const PUBLISH_TIMEOUT_MS = 45000

  async function handlePublish() {
    if (publishBlocked || publishInFlight.current) return
    publishInFlight.current = true
    setPublishState('publishing') // disabled immediately -- prevents double submission

    const controller = new AbortController()
    const watchdog = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS)

    try {
      const res = await fetch('/api/google/publish', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({
          ...(r.gbp_review_name
            ? { reviewName: r.gbp_review_name }
            : { locationName: r.location_name, reviewerName: r.reviewer_name }),
          replyText: localDraft,
          // Recovery Milestone 6B, Part 1/2: sent so the server can key a
          // durable Redis publish-bridge record by the SAME id this app's
          // own workspace already uses (see dataUtils.js's reviewId()) --
          // without it, a successful publish still reaches Google but has
          // no durable, cross-browser record of having done so.
          localReviewId: rid,
          reviewDate: r.review_date ?? null,
        }),
        signal: controller.signal,
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        onUpdate(rid, { status: 'published', publishedAt: new Date().toISOString(), failReason: null }, 'Published to Google')
        // Recovery Milestone 6B, Part 2: bridgeWarning means Google already
        // has the reply -- the durable record just couldn't be saved. This
        // is never a failure: still removed from the active queue and
        // auto-advanced, just with a message that doesn't encourage
        // republishing (the same-browser workspace 'published' status above
        // is itself a valid, if not cross-device, completion record).
        showToast(
          data.bridgeWarning
            ? "Published to Google, but local confirmation couldn't be saved. It will reconcile automatically."
            : 'Response published to Google'
        )
        // Auto-advance to the next actionable review -- `nextReviewId` was
        // captured by the parent BEFORE this review was marked complete
        // (see Reviews.jsx's own nextReviewId memo for why), so this is a
        // direct selection by stable identity, never a re-derived index.
        onPublishSuccess?.(nextReviewId)
        // No setPublishState('idle') here: this instance either unmounts
        // (queue empties) or a fresh instance mounts for the next review
        // (keyed by review id -- see ReviewDetailContent's callers), each
        // starting at 'idle' on its own. Resetting here too would just be
        // a redundant state update racing that transition.
      } else {
        onUpdate(rid, { status: 'failed', failReason: data.error || 'api_error' }, 'Publish failed')
        setPublishState('failed') // stays in the active queue, editable, retryable -- do NOT auto-advance
      }
    } catch (err) {
      // AbortError = our own watchdog fired, not a real network failure --
      // the request may well have reached Google and succeeded server-side
      // before the client gave up waiting (this is exactly the "stuck"
      // symptom's likely real-world mechanism). GBP's reply endpoint is a
      // PUT to a fixed .../reviews/{review}/reply resource (an idempotent
      // upsert by REST convention and by Google's own API design -- it SETS
      // the reply text, it does not append), so retrying with the same
      // text is safe either way: at worst it re-confirms the same value,
      // it can never create a duplicate reply. 'timeout' gets its own
      // FAIL_REASONS message saying exactly that, rather than the generic
      // network_error text.
      const timedOut = err?.name === 'AbortError'
      onUpdate(rid, { status: 'failed', failReason: timedOut ? 'timeout' : 'network_error' }, 'Publish failed')
      setPublishState('failed')
    } finally {
      clearTimeout(watchdog)
      publishInFlight.current = false
    }
  }

  function handleKeyDown(e) {
    const cmdEnter = (e.metaKey || e.ctrlKey) && e.key === 'Enter'
    if (cmdEnter && !publishBlocked) {
      e.preventDefault()
      handlePublish()
    }
  }

  function handleMarkPublished() {
    onUpdate(rid, { status: 'published', publishedAt: new Date().toISOString(), failReason: null }, 'Marked published')
    onPublishSuccess?.(nextReviewId)
  }

  function handleTakenCareOf() {
    onUpdate(rid, { status: 'taken_care_of', publishedAt: new Date().toISOString(), failReason: null }, 'Marked done')
    onPublishSuccess?.(nextReviewId)
  }

  function handleUndo() {
    onUpdate(rid, { status: initialStatus, failReason: null }, 'Reopened')
  }

  const charCount = localDraft.length
  const charOver  = charCount > 4096
  const link      = buildReviewLink(r)

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
          Response
        </p>
        <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
      </div>

      {failReason && (
        <div className="mb-3 px-3 py-2.5 rounded-lg text-xs leading-relaxed"
             style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)', border: '1px solid var(--color-danger-border)' }}>
          <strong>Publish failed:</strong> {FAIL_REASONS[failReason] ?? failReason} Your response text is unchanged — try again.
        </div>
      )}

      {isDone ? (
        <div className="p-3 rounded-xl text-xs flex items-center justify-between gap-3"
             style={{ background: 'var(--color-surface-2)' }}>
          <span style={{ color: 'var(--color-text-2)' }}>
            Marked {status === 'published' ? 'published' : 'done'}
            {wsEntry?.publishedAt && ` · ${fmtWhen(wsEntry.publishedAt)}`}
          </span>
          <button onClick={handleUndo} className="text-[10px] underline flex-shrink-0" style={{ color: 'var(--color-text-3)' }}>
            Undo
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {serious && <SeriousReviewWarning acknowledged={acknowledged} onAcknowledge={setAcknowledged} />}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] font-medium tracking-wide flex items-center gap-1.5" style={{ color: 'var(--color-text-3)' }}>
                {isAiPrepared && <span style={{ color: 'var(--color-accent)' }}>✦ AI Prepared</span>}
                {wasEdited && <span>Edited</span>}
                {!isAiPrepared && !wasEdited && !autoGenerating && <span>Your response</span>}
                {autoGenerating && <span style={{ color: 'var(--color-text-3)' }}>Preparing response…</span>}
              </label>
              <span className="text-[10px]" style={{ color: charOver ? 'var(--color-danger)' : 'var(--color-text-3)' }}>
                {charCount} / 4096
              </span>
            </div>
            <textarea
              ref={textareaRef}
              value={localDraft}
              onChange={e => onTextChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={autoGenerating ? 'Preparing a response…' : 'Write a response to this review…'}
              rows={4}
              disabled={autoGenerating}
              className="w-full rounded-xl px-3 py-2.5 text-xs resize-y focus:outline-none transition-colors"
              style={{
                // Recovery Milestone 5, Problem 3: this used to be the
                // near-black --ai-draft-* palette (an intentionally
                // theme-independent dark panel, still used elsewhere for the
                // "AI reasoning" card) -- for the actual reply text a manager
                // edits and publishes, that read as heavy/out of place next
                // to the rest of this light UI. Reuses the same light
                // accent-tint tokens the Owner Response box below already
                // uses, so "AI-prepared" and "already replied on Google"
                // read as one consistent light palette instead of two.
                background: isAiPrepared ? 'var(--color-accent-lt)' : 'var(--color-surface)',
                color: 'var(--color-text-1)',
                border: `1px solid ${charOver ? 'var(--color-danger)' : (isAiPrepared ? 'var(--color-accent-md)' : 'var(--color-border)')}`,
                lineHeight: 1.6, fontFamily: 'inherit', minHeight: 84,
                opacity: autoGenerating ? 0.6 : 1,
              }}
            />
            {autoGenerateErr && (
              <p className="text-[10px] mt-1" style={{ color: 'var(--color-text-3)' }}>{autoGenerateErr}</p>
            )}
          </div>

          {/* Primary + secondary actions -- Confirm & Publish is the one
              visually dominant control (Phase 10); Regenerate stays a
              step down; everything else moves into "More actions". */}
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <Button variant="primary" onClick={handlePublish} disabled={publishBlocked}>
              {publishing ? 'Publishing…' : 'Confirm & Publish'}
            </Button>
            <Button variant="secondary" disabled={rewriting} onClick={() => handleRewrite(lastTone || 'friendly')}>
              {rewriting && !activeTone ? 'Regenerating…' : 'Regenerate'}
            </Button>
            <button
              type="button"
              onClick={() => setMoreOpen(o => !o)}
              className="text-xs font-medium px-2 py-1.5"
              style={{ color: 'var(--color-text-3)' }}
              aria-expanded={moreOpen}
            >
              More actions {moreOpen ? '▲' : '▼'}
            </button>
          </div>
          {rewriteErr && <p className="text-xs" style={{ color: 'var(--color-danger)' }}>{rewriteErr}</p>}

          {moreOpen && (
            <div className="space-y-3 p-3 rounded-xl" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'var(--color-text-3)' }}>
                  AI Rewrite Tone
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {TONES.map(t => {
                    const isActive = activeTone === t.id
                    return (
                      <button key={t.id} disabled={rewriting} onClick={() => handleRewrite(t.id)}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-all"
                              style={isActive
                                ? { background: 'var(--color-accent)', color: 'white', borderColor: 'var(--color-accent)', opacity: 0.85 }
                                : { background: 'var(--color-surface)', color: 'var(--color-text-2)', borderColor: 'var(--color-border)', opacity: rewriting ? 0.5 : 1 }}>
                        {isActive && rewriting ? '…' : t.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Button variant={copied ? 'accent' : 'secondary'} onClick={handleCopy} disabled={!localDraft}>
                  {copied ? '✓ Copied!' : 'Copy Response'}
                </Button>
                <a href={link.href} target="_blank" rel="noopener noreferrer">
                  <Button variant="secondary">Open Google ↗</Button>
                </a>
                <Button variant="ghost" onClick={handleMarkPublished}>Mark Published</Button>
                <Button variant="ghost" onClick={handleTakenCareOf}>Already Done</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function NotesAndAssignment({ r, wsEntry, onUpdate }) {
  const rid = reviewId(r)
  const [notes, setNotes] = useState(wsEntry?.notes ?? '')
  const [assignedTo, setAssignedTo] = useState(wsEntry?.assignedTo ?? '')
  const savedNotesRef = useRef(wsEntry?.notes ?? '')
  const savedAssignedRef = useRef(wsEntry?.assignedTo ?? '')

  function handleNotesBlur() {
    onUpdate(rid, { notes }, notes !== savedNotesRef.current ? 'Internal note updated' : undefined)
    savedNotesRef.current = notes
  }

  function handleAssignedBlur() {
    onUpdate(rid, { assignedTo: assignedTo || null },
      assignedTo !== savedAssignedRef.current ? (assignedTo ? `Assigned to ${assignedTo}` : 'Unassigned') : undefined)
    savedAssignedRef.current = assignedTo
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className="text-[10px] font-bold uppercase tracking-wider mb-1.5 block" style={{ color: 'var(--color-text-3)' }}>
          Internal Notes
        </label>
        <textarea
          value={notes}
          onChange={e => { setNotes(e.target.value); onUpdate(rid, { notes: e.target.value }) }}
          onBlur={handleNotesBlur}
          placeholder="Not visible to the customer…"
          rows={2}
          className="w-full rounded-lg px-2.5 py-2 text-xs resize-y focus:outline-none"
          style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
        />
      </div>
      <div>
        <label className="text-[10px] font-bold uppercase tracking-wider mb-1.5 block" style={{ color: 'var(--color-text-3)' }}>
          Assigned To
        </label>
        <input
          type="text"
          value={assignedTo}
          onChange={e => setAssignedTo(e.target.value)}
          onBlur={handleAssignedBlur}
          placeholder="Manager or team member…"
          className="w-full rounded-lg px-2.5 py-2 text-xs focus:outline-none"
          style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
        />
      </div>
    </div>
  )
}

// Restaurant bad-review email workflow (recovery-audit milestone). Only
// shown for a negative review (star_rating <= 2, this codebase's existing
// "negative"/"unanswered" threshold -- see export_action_items.py) to an
// owner/marketing account. Reuses the SAME Action Center Redis record
// (keyed by reviewId(r)) rather than a separate store -- Action Center's
// own card for this item (Phase 8) shows the same emailStatus/history.
function SendToRestaurantSection({ r }) {
  const showToast = useToast()
  const account = useAccount()
  const { data: ws } = useActionWorkspace()
  const { data: contacts } = useRestaurantContacts()
  const sendMutation = useSendReviewEmail()

  const [open, setOpen] = useState(false)
  const [subject, setSubject] = useState('')
  const [internalNote, setInternalNote] = useState('')
  const [followUpDueAt, setFollowUpDueAt] = useState('')
  const [confirmArmed, setConfirmArmed] = useState(false)
  const [configureOpen, setConfigureOpen] = useState(false)

  const isNegative = (r.star_rating ?? 5) <= 2
  const canSend = account?.role === 'owner' || account?.role === 'marketing'

  const rid = reviewId(r)
  const entry = ws[rid]
  const emailStatus = entry?.emailStatus ?? 'not_sent'
  const statusMeta = EMAIL_STATUS_META[emailStatus] ?? EMAIL_STATUS_META.not_sent

  // Phase 8, Milestone 8.4: reads the live Redis-backed contact directly
  // (same source Settings -> Restaurant Contacts writes to), not the
  // baked meta.json hasContact flag -- a contact added through Settings is
  // reflected here immediately, no export/deploy needed.
  const contact = contacts?.[String(r.locationId)] ?? null
  const hasContact = Boolean(contact?.active && contact?.primaryEmail)

  const { data: preview, isLoading: previewLoading } = useReviewEmailPreview(rid, r.locationId, open)
  const isDuplicate = preview?.existingRecord && DUPLICATE_EMAIL_STATUSES.has(preview.existingRecord.emailStatus)
  const needsConfirmClick = isDuplicate && !confirmArmed

  if (!isNegative || !canSend) return null

  function handleOpen() {
    setSubject(`Response Requested — ${r.location_name} — ${r.star_rating}-Star Customer Review`)
    setInternalNote('')
    setFollowUpDueAt('')
    setConfirmArmed(false)
    setOpen(true)
  }

  async function handleSend() {
    if (needsConfirmClick) { setConfirmArmed(true); return }
    try {
      await sendMutation.mutateAsync({
        id: rid,
        locationId: r.locationId,
        review: {
          locationName: r.location_name, city: r.city ?? null, starRating: r.star_rating,
          reviewerName: r.reviewer_name ?? null, reviewDate: r.review_date ?? null,
          reviewText: r.review_text ?? null, reviewUrl: r.review_url ?? null,
        },
        subject,
        internalNote: internalNote || undefined,
        followUpDueAt: followUpDueAt || undefined,
        confirmResend: confirmArmed || isDuplicate,
      })
      showToast('Review email sent to the restaurant')
      setOpen(false)
    } catch (err) {
      if (err.code === 'already_sent') setConfirmArmed(true)
    }
  }

  return (
    <div className="pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
          Restaurant Email
        </p>
        <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
      </div>

      {entry?.emailSentAt && (
        <p className="text-[10px] mb-2" style={{ color: 'var(--color-text-3)' }}>
          Last sent {fmtWhen(entry.emailSentAt)} to {entry.emailRecipient}
        </p>
      )}
      {entry?.emailStatus === 'failed' && entry?.emailLastError && (
        <p className="text-[10px] mb-2" style={{ color: 'var(--color-danger)' }}>{entry.emailLastError}</p>
      )}

      {!open ? (
        !hasContact ? (
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="warning">⚠ No Restaurant Contact Configured</Badge>
            <Button variant="secondary" onClick={() => setConfigureOpen(true)}>Configure Contact</Button>
          </div>
        ) : (
          <Button variant="secondary" onClick={handleOpen}>
            {emailStatus === 'not_sent' ? 'Send to Restaurant' : 'Resend to Restaurant'}
          </Button>
        )
      ) : (
        <div className="space-y-2 p-3 rounded-lg" style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)' }}>
          {previewLoading ? (
            <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>Loading recipient…</p>
          ) : (
            <>
              <p className="text-xs">
                <span style={{ color: 'var(--color-text-3)' }}>To: </span>
                <span style={{ color: 'var(--color-text-1)' }}>{preview?.recipient?.email ?? '(unavailable)'}</span>
              </p>
              {preview?.cc?.length > 0 && (
                <p className="text-xs">
                  <span style={{ color: 'var(--color-text-3)' }}>Cc: </span>
                  <span style={{ color: 'var(--color-text-1)' }}>{preview.cc.join(', ')}</span>
                </p>
              )}
              <p className="text-xs">
                <span style={{ color: 'var(--color-text-3)' }}>Reply-To: </span>
                <span style={{ color: 'var(--color-text-1)' }}>{preview?.replyTo}</span>
              </p>
            </>
          )}

          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>Subject</label>
            <input type="text" value={subject} onChange={e => setSubject(e.target.value)}
                   className="w-full text-xs px-2 py-1.5 rounded-lg focus:outline-none"
                   style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }} />
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>Internal Note (optional)</label>
            <textarea value={internalNote} onChange={e => setInternalNote(e.target.value)} rows={2}
                      placeholder="Not included unless you add it here…"
                      className="w-full text-xs px-2 py-1.5 rounded-lg resize-y focus:outline-none"
                      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }} />
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase tracking-wider mb-1 block" style={{ color: 'var(--color-text-3)' }}>Follow-Up Due Date (optional)</label>
            <input type="date" value={followUpDueAt} onChange={e => setFollowUpDueAt(e.target.value)}
                   className="w-full text-xs px-2 py-1.5 rounded-lg focus:outline-none"
                   style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }} />
          </div>

          {(needsConfirmClick || confirmArmed) && (
            <p className="text-xs font-semibold" style={{ color: 'var(--color-danger)' }}>
              This review already has an email sent to the restaurant. Click Send again to confirm resending.
            </p>
          )}

          {sendMutation.isError && sendMutation.error?.code !== 'already_sent' && (
            <p className="text-xs" style={{ color: 'var(--color-danger)' }}>{sendMutation.error.message}</p>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button variant="primary" onClick={handleSend} disabled={sendMutation.isPending || (!preview?.recipient && !previewLoading)}>
              {sendMutation.isPending ? 'Sending…' : needsConfirmClick ? 'Send' : confirmArmed ? 'Confirm Resend' : 'Send'}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      )}

      {configureOpen && (
        <ContactEditorModal
          open={configureOpen}
          onClose={() => setConfigureOpen(false)}
          locationId={r.locationId}
          locationName={r.location_name}
          initialContact={null}
        />
      )}
    </div>
  )
}

function ResponseHistory({ history }) {
  if (!history?.length) return null
  const sorted = [...history].reverse()
  return (
    <details>
      <summary className="text-[10px] font-bold uppercase tracking-wider cursor-pointer" style={{ color: 'var(--color-text-3)' }}>
        Response History ({history.length})
      </summary>
      <ul className="mt-2 space-y-1.5">
        {sorted.map((h, i) => (
          <li key={i} className="text-xs flex items-baseline gap-2">
            <span style={{ color: 'var(--color-text-3)' }}>{fmtWhen(h.at)}</span>
            <span style={{ color: 'var(--color-text-1)' }}>{h.action}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

// ─── Detail content (shared by the desktop persistent panel and the mobile
// overlay panel -- inbox layout shell, M5.1) ───────────────────────────────

function ReviewDetailContent({ r, draft, allReviews, wsEntry, bridgeEntry, onUpdate, onPublishSuccess, nextReviewId }) {
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
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <StarBadge n={r.star_rating ?? 1} />
        <ReplyStateBadge r={r} wsEntry={wsEntry} bridgeEntry={bridgeEntry} />
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

      {/* Owner response (already replied on Google) -- or, Recovery
          Milestone 6B Part 4: a durable publish-bridge record, proof this
          app's own Confirm & Publish already reached Google even though
          the next GBP sync hasn't written owner_response back into
          reviews.db yet. Showing the actual bridge text here (not just an
          empty gap) is what makes the review read as done immediately,
          cross-browser/cross-device, without waiting on that sync. */}
      {r.owner_response ? (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--color-text-3)' }}>
            Owner Response
          </p>
          <div className="p-3 rounded-xl text-xs leading-relaxed italic"
               style={{ background: 'var(--color-accent-lt)', border: '1px solid var(--color-accent-md)', color: 'var(--color-text-2)' }}>
            {r.owner_response}
          </div>
        </div>
      ) : bridgeEntry ? (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--color-text-3)' }}>
            Published via Future Insights
          </p>
          <div className="p-3 rounded-xl text-xs leading-relaxed italic"
               style={{ background: 'var(--color-accent-lt)', border: '1px solid var(--color-accent-md)', color: 'var(--color-text-2)' }}>
            {bridgeEntry.responseText}
          </div>
          <p className="text-[10px] mt-1.5" style={{ color: 'var(--color-text-3)' }}>
            Published to Google · awaiting the next sync to confirm it here. No action needed.
          </p>
        </div>
      ) : (
        /* Not yet replied -- full response workspace (draft/edit/rewrite/publish) */
        <div className="pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <ResponseWorkspace r={r} draft={draft} wsEntry={wsEntry} onUpdate={onUpdate} onPublishSuccess={onPublishSuccess} nextReviewId={nextReviewId} />
        </div>
      )}

      {/* Internal notes + assignment -- available regardless of reply status,
          but de-emphasized (Phase 10): most reviews need neither. */}
      <details className="pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
        <summary className="text-[10px] font-bold uppercase tracking-wider cursor-pointer" style={{ color: 'var(--color-text-3)' }}>
          Notes &amp; Assignment
        </summary>
        <div className="mt-2">
          <NotesAndAssignment r={r} wsEntry={wsEntry} onUpdate={onUpdate} />
        </div>
      </details>

      <ResponseHistory history={wsEntry?.history} />

      <SendToRestaurantSection r={r} />

      {/* Similar reviews -- moved into a collapsed disclosure (Recovery
          Milestone 5, Problem 3): useful context, but competed with the
          review/response/publish flow for attention in the first viewport
          when shown open by default. */}
      {similar.length > 0 && (
        <details className="pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <summary className="text-[10px] font-bold uppercase tracking-wider cursor-pointer" style={{ color: 'var(--color-text-3)' }}>
            Related context · {similar.length} similar review{similar.length === 1 ? '' : 's'} at this location
          </summary>
          <div className="space-y-2 mt-2">
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
        </details>
      )}

      {!r.owner_response && (
        <a href={link.href} target="_blank" rel="noopener noreferrer"
           className="badge badge-accent hover:opacity-80 transition-opacity inline-block">
          {link.label}
        </a>
      )}
    </div>
  )
}

// ─── Desktop persistent detail panel (lg+, inbox layout shell) ────────────────

function ReviewDetailPersistent({ r, draft, allReviews, wsEntry, bridgeEntry, onUpdate, onPublishSuccess, nextReviewId }) {
  if (!r) {
    return (
      <Card className="p-8 h-full flex items-center justify-center text-center">
        <p className="text-sm" style={{ color: 'var(--color-text-3)' }}>
          Select a review to view its details
        </p>
      </Card>
    )
  }
  return (
    <Card className="p-5 max-h-[calc(100vh-140px)] overflow-y-auto">
      <div className="mb-3">
        <p className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>{r.reviewer_name || 'Anonymous'}</p>
        <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>{r.location_name} · {r.review_date}</p>
      </div>
      {/* Keyed by review identity (Recovery Milestone 5, defense-in-depth):
          guarantees ResponseWorkspace's local state (publishState, localDraft,
          etc.) always starts fresh for a newly-selected review rather than
          depending on React's own reconciliation heuristics happening to
          treat this as a remount every time. */}
      <ReviewDetailContent key={reviewId(r)} r={r} draft={draft} allReviews={allReviews} wsEntry={wsEntry} bridgeEntry={bridgeEntry} onUpdate={onUpdate} onPublishSuccess={onPublishSuccess} nextReviewId={nextReviewId} />
    </Card>
  )
}

// ─── Mobile/tablet overlay panel (below lg -- unchanged interaction from the
// prior ReviewExplorer.jsx, a fixed 460px panel doesn't fit a phone/tablet
// viewport the way it does on desktop) ─────────────────────────────────────

function ReviewDetailOverlay({ r, draft, allReviews, onClose, wsEntry, bridgeEntry, onUpdate, onPublishSuccess, nextReviewId }) {
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
        className="fixed inset-y-0 right-0 z-50 flex flex-col w-full sm:w-[460px] overflow-y-auto"
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
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)]" aria-label="Close panel"
                  style={{ color: 'var(--color-text-2)' }}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div className="flex-1 p-5">
          <ReviewDetailContent key={reviewId(r)} r={r} draft={draft} allReviews={allReviews} wsEntry={wsEntry} bridgeEntry={bridgeEntry} onUpdate={onUpdate} onPublishSuccess={onPublishSuccess} nextReviewId={nextReviewId} />
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

export default function Reviews({ allReviews = [], filtered = [], prevFiltered = [] }) {
  const showToast = useToast()
  const isDesktop = useIsDesktop()
  const { data: drafts } = useResponseDrafts()
  const { data: ws, setRecord } = useReviewWorkspace()
  const [searchParams, setSearchParams] = useSearchParams()

  // Recovery Milestone 6B, Part 5: bulk-fetch durable publish-bridge
  // records for the reviews a bridge could actually matter for -- anything
  // still owner_response-empty AND not already locally marked 'published'.
  // A review that already has either signal doesn't need bridge
  // disambiguation to show as done, so excluding them keeps this bounded to
  // roughly the size of the actionable queue itself, not the full
  // multi-thousand-review corpus. Capped at PUBLISH_BRIDGE_MAX_IDS_CLIENT
  // (matching the server's own per-request cap) and taken in `filtered`'s
  // existing order, so it naturally prioritizes whatever's about to be
  // shown; a bridge-confirmed review far down an unfiltered, all-locations
  // list may not be covered until it's actually paged/filtered into view --
  // an accepted, documented tradeoff for a single bounded bulk call instead
  // of paginating this lookup across the entire dataset.
  const PUBLISH_BRIDGE_MAX_IDS_CLIENT = 200
  const bridgeCandidateIds = useMemo(() => {
    return filtered
      .filter(r => !r.owner_response && ws[reviewId(r)]?.status !== 'published')
      .slice(0, PUBLISH_BRIDGE_MAX_IDS_CLIENT)
      .map(r => reviewId(r))
  }, [filtered, ws])
  const { data: bridges } = useQuery({
    queryKey: ['publish-bridges', bridgeCandidateIds.join(',')],
    queryFn:  () => fetchPublishBridges(bridgeCandidateIds),
    enabled:  bridgeCandidateIds.length > 0,
    staleTime: 30000,
    refetchInterval: 60000, // catches server-side reconciliation clearing a bridge without a manual reload
  })
  const bridgesData = bridges ?? {}

  const [sortKey, setSortKey]     = useState('review_date')
  const [sortDir, setSortDir]     = useState('desc')
  const [keyword, setKeyword]     = useState('')
  const [replyStates, setReplyStates] = useState([])
  const [sentiment, setSentiment] = useState('')
  const [length,  setLength]      = useState('')
  const [page,    setPage]        = useState(0)
  const [selectedKey, setSelectedKey] = useState(null)
  // Recovery Milestone 4, Phase 5: the Reviews inbox now defaults to the
  // actionable queue (needs_reply/draft/failed -- see
  // replyState.js's isActionableReplyState) rather than opening on the full
  // unfiltered list. The name is unchanged from M5 (still "needsResponseOnly")
  // to keep this diff scoped -- its MEANING widened from "star<=2 and
  // unanswered" to "not yet resolved", and its default flipped from off to
  // on. ?filter=all opts out to the full list on load; toggling flips both.
  const [needsResponseOnly, setNeedsResponseOnly] = useState(() => searchParams.get('filter') !== 'all')

  const resetPage = useCallback(() => setPage(0), [])

  // Best-effort deep link from the restaurant bad-review email's "internal
  // reference" URL / an Action Center email-thread card ("Open review"):
  // /reviews?reviewId=<review_id-or-review_url>. Only handles the common
  // case (a review with a real review_id/review_url, the overwhelming
  // majority) -- clears this page's own local (workflow) filters so the
  // target review isn't hidden by a stale one, but does NOT touch the
  // parent's global date/location/brand/star filters (Filtering UX
  // Cleanup: those are no longer this page's to clear -- a review outside
  // the current global scope still won't be found, same as before).
  useEffect(() => {
    const targetId = searchParams.get('reviewId')
    if (!targetId) return
    const match = allReviews.find(r => (r.review_id || r.review_url) === targetId)
    if (!match) return
    setReplyStates([]); setSentiment(''); setLength(''); setKeyword(''); setNeedsResponseOnly(false)
    resetPage()
    setSelectedKey(targetId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, allReviews])

  function toggleNeedsResponse() {
    const next = !needsResponseOnly
    setNeedsResponseOnly(next)
    setSearchParams(next ? {} : { filter: 'all' }, { replace: true })
    resetPage()
  }

  const trendAlerts = useMemo(() => computeTrendAlerts(filtered, prevFiltered), [filtered, prevFiltered])

  // Filtering UX Cleanup: reply-state (Needs Reply/Draft/Confirmed/Failed/
  // Externally Replied) counts for the pill row below, computed directly
  // from `filtered` -- the GLOBALLY-scoped dataset (App.jsx's date/
  // location/brand/star filters already applied, server-side authorization
  // already applied upstream of that) -- never renarrowed by this page's
  // own workflow filters (needsResponseOnly/replyStates/sentiment/length/
  // keyword). This is what makes the counts answer "how many of each
  // status exist in my current global scope," independent of whatever
  // local view the manager currently has selected, and why they
  // immediately recalculate when the global location/date/star selection
  // changes (filtered changes) but never when a local filter changes.
  const replyStateCounts = useMemo(
    () => computeReplyStateCounts(filtered, ws, bridgesData),
    [filtered, ws, bridgesData]
  )

  const processed = useMemo(() => {
    let rows = filtered
    if (needsResponseOnly) rows = rows.filter(r => isActionableReplyState(computeReplyState(r, ws[reviewId(r)], bridgesData[reviewId(r)])))
    if (replyStates.length) rows = rows.filter(r => replyStates.includes(computeReplyState(r, ws[reviewId(r)], bridgesData[reviewId(r)])))
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
    if (needsResponseOnly) return [...rows].sort((a, b) => priority(b) - priority(a))
    return [...rows].sort((a, b) => {
      let av = a[sortKey] ?? '', bv = b[sortKey] ?? ''
      if (typeof av === 'string') { av = av.toLowerCase(); bv = bv.toLowerCase() }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ?  1 : -1
      return 0
    })
  }, [filtered, needsResponseOnly, replyStates, ws, bridgesData, sentiment, length, keyword, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(processed.length / PAGE_SIZE))
  const safePage   = Math.min(page, totalPages - 1)
  // Memoized (not a plain .slice()) so its identity is stable across renders
  // that don't actually change the page/list.
  const visible    = useMemo(
    () => processed.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [processed, safePage]
  )

  // Recovery Milestone 4, Phase 9 / bugfix (auto-advance skip): after a
  // successful publish, the just-handled review will disappear from
  // `visible` on the next render (its reply state no longer matches the
  // actionable filter) -- this determines whichever review will take its
  // place in the queue, using the CURRENT (pre-removal) ordering, so the
  // manager lands on the next real item rather than momentarily on nothing.
  //
  // ROOT CAUSE of the "publish A -> opens C instead of B" bug this replaces:
  // the old version identified both the current AND the next review by
  // `${r.review_id || r.review_url || i}` -- for any review lacking BOTH a
  // real review_id and review_url (the location+reviewer fuzzy-match
  // fallback path -- a real, non-trivial share of the actionable backlog),
  // that identity fell back to `i`, the review's POSITION in `visible` at
  // the moment it was computed. `selectedKey` was then stored as that
  // positional string (e.g. "1" for B). Once A was removed from `visible`
  // on the next render (its status flipped to 'published', so it no longer
  // passes the actionable filter), every remaining review's position shifted
  // down by one -- B moved from index 1 to index 0, and whatever review
  // used to be at index 1 (C) was now the one matching the STALE stored key
  // "1". The bug was never about *when* the next review was computed (it
  // already correctly ran against the pre-removal array, since the
  // workspace mutation's onMutate -- see useReviewWorkspace.js -- awaits
  // cancelQueries() first, deferring the actual cache write to a later
  // microtask) -- it was that the selection was being remembered by a
  // POSITION that a mutating array does not keep stable, not by a genuine
  // identity.
  //
  // Fix: `nextReviewId` below is computed with the exact same canonical
  // reviewId(r) this file already uses everywhere else (ws/bridgesData
  // lookups, ReviewDetailContent's mount key) -- a content-derived identity
  // (review_id, review_url, or a review_date+reviewer_name fallback) that
  // never depends on array position, so it keeps pointing at the SAME
  // review no matter how many places ahead of it get removed first. It is
  // computed eagerly here (memoized on the current, still-unmutated
  // `visible`/`selectedKey`) -- i.e. genuinely BEFORE the current review is
  // marked complete/removed -- and handed to ResponseWorkspace as a plain
  // prop, which passes it straight back on success without recomputing
  // anything itself. No index, no re-derivation after the mutating array
  // has already changed shape.
  const nextReviewId = useMemo(
    () => computeNextReviewId(visible, selectedKey),
    [visible, selectedKey]
  )

  const advanceToNext = useCallback((targetReviewId) => {
    setSelectedKey(targetReviewId ?? null)
  }, [])

  function toggleSort(key) {
    if (needsResponseOnly) return // sorted by priority while this quick filter is active
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

  // UX fix (post-Milestone-5): the background prewarm worker that used to
  // live here generated AI drafts for up to the next 5 actionable reviews
  // the instant ANY review was selected -- including reviews the manager
  // never clicked or opened, which silently moved them from Needs Reply to
  // Draft just by virtue of being nearby in the list/queue. That violated
  // the required lifecycle (a review must stay Needs Reply until
  // intentionally opened) and burned Anthropic credits on reviews no one
  // asked about. Removed outright, not replaced with another background/
  // batch mechanism -- ResponseWorkspace's own on-open effect (see its
  // `autoGenerateAttempted` guard above) is the only remaining place that
  // triggers automatic generation, and it already runs exactly once per
  // review, only when that specific review is actually opened.

  const selected = useMemo(
    () => visible.find(r => reviewId(r) === selectedKey) ?? null,
    [visible, selectedKey]
  )
  const selectedDraft = selected ? draftByReviewId[selected.review_id || selected.review_url || ''] : null
  const selectedWsEntry = selected ? ws[reviewId(selected)] : null
  const selectedBridgeEntry = selected ? bridgesData[reviewId(selected)] : null

  function handleExportCSV() {
    const headers = ['Date','Location','City','Stars','AI Sentiment','AI Priority','Reviewer','Review','Owner Response','Response Status','Review URL']
    const rows = processed.map(r => [
      r.review_date, r.location_name, r.city, r.star_rating,
      sentimentBucket(r) ?? '', r.ai_priority ?? '',
      r.reviewer_name, r.review_text, r.owner_response,
      r.response_status || (r.owner_response ? 'responded' : 'unanswered'),
      r.review_url,
    ])
    exportCSV(`lta-reviews-${new Date().toISOString().slice(0, 10)}`, headers, rows)
    showToast(`Exported ${processed.length.toLocaleString()} reviews`)
  }

  return (
    <div className="max-w-[1500px]">
      <div className="mb-4">
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Reviews</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Search, filter, and respond to reviews across all locations — AI drafts, notes, assignments, and history in one place
        </p>
      </div>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-5 lg:items-start">
        {/* ── List column ── */}
        <div className="space-y-4 min-w-0">
          {/* Actionable-inbox toggle (Phase 5) -- Needs Reply is the default
              view; toggling shows the full list, including Published/
              Externally Replied history. */}
          <button
            onClick={toggleNeedsResponse}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors"
            style={needsResponseOnly
              ? { background: 'var(--color-danger)', color: 'white', borderColor: 'var(--color-danger)' }
              : { background: 'var(--color-surface)', color: 'var(--color-text-2)', borderColor: 'var(--color-border)' }}>
            {needsResponseOnly ? '✓ Needs Reply' : 'Show all reviews'}
          </button>

          {needsResponseOnly && (
            <>
              <GBPBanner />
              <WorkspaceStats reviews={processed} ws={ws} draftByReviewId={draftByReviewId} bridges={bridgesData} />
            </>
          )}

          <Card className="p-4">
            <FilterBar
              keyword={keyword}    onKeyword={v => { setKeyword(v); resetPage() }}
              replyStates={replyStates} onReplyStates={v => { setReplyStates(v); resetPage() }}
              replyStateCounts={replyStateCounts}
              sentiment={sentiment} onSentiment={v => { setSentiment(v); resetPage() }}
              length={length}      onLength={v => { setLength(v); resetPage() }}
              count={processed.length}
            />
          </Card>

          {/* Action bar */}
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="secondary" onClick={handleExportCSV}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 20 20" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a1 1 0 001 1h10a1 1 0 001-1v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
              </svg>
              Export CSV
            </Button>
            <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
              {processed.length.toLocaleString()} reviews
              {needsResponseOnly ? ' · sorted by priority' : ` · sorted by ${sortKey.replace('_', ' ')} ${sortDir === 'asc' ? '↑' : '↓'}`}
            </span>
          </div>

          {/* List */}
          <div className="card overflow-hidden">
            <div className="hidden sm:flex items-center px-4 py-1.5 gap-3"
                 style={{ background: 'var(--color-surface-2)', borderBottom: '1px solid var(--color-border)' }}>
              <span className="w-16 text-[10px] font-bold uppercase tracking-wide" style={{ color: 'var(--color-text-2)' }}>Stars</span>
              <span className="flex-1 text-[10px] font-bold uppercase tracking-wide cursor-pointer" style={{ color: 'var(--color-text-2)' }}
                    onClick={() => toggleSort('reviewer_name')} aria-sort={sortKey === 'reviewer_name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                Reviewer{sortKey === 'reviewer_name' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-wide cursor-pointer" style={{ color: 'var(--color-text-2)' }}
                    onClick={() => toggleSort('review_date')} aria-sort={sortKey === 'review_date' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                Date{sortKey === 'review_date' ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
              </span>
              <span className="w-28 text-[10px] font-bold uppercase tracking-wide text-right" style={{ color: 'var(--color-text-2)' }}>Status</span>
            </div>

            <div>
              {visible.length === 0 ? (
                needsResponseOnly && !keyword && !sentiment && !length && !replyStates.length ? (
                  <EmptyState icon="🎉" title="You're all caught up"
                              body="Every review has been replied to, published, or is otherwise resolved."
                              action={
                                <button onClick={toggleNeedsResponse} className="text-xs font-medium underline"
                                        style={{ color: 'var(--color-accent)' }}>
                                  View all reviews / history →
                                </button>
                              } />
                ) : (
                  <EmptyState icon="🔍" title="No reviews match your filters"
                              body="Try adjusting your keyword, sentiment, star filter, or date range." />
                )
              ) : visible.map(r => {
                const key = reviewId(r)
                return (
                  <ReviewRow
                    key={key}
                    r={r}
                    selected={selectedKey === key}
                    onSelect={() => setSelectedKey(key)}
                    wsEntry={ws[reviewId(r)]}
                    bridgeEntry={bridgesData[reviewId(r)]}
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

          {/* Trend alerts -- scoped to the selected date range vs. an equal-length
              prior period, shown alongside the Needs Response worklist. */}
          {needsResponseOnly && trendAlerts.length > 0 && (
            <div className="space-y-3 pt-2">
              <h3 className="text-label" style={{ color: 'var(--color-text-2)' }}>
                Rating Trend Alerts <span style={{ color: 'var(--color-text-3)', fontWeight: 400 }}>· selected period vs. prior</span>
              </h3>
              {trendAlerts.map((t, i) => (
                <div key={i} className="flex items-start gap-3 p-4 rounded-xl border"
                     style={{
                       background:  t.delta > 0 ? 'var(--color-success-bg)' : 'var(--color-warning-bg)',
                       borderColor: t.delta > 0 ? 'var(--color-success-border)' : 'var(--color-accent-md)',
                     }}>
                  <span className="text-xl flex-shrink-0">{t.delta > 0 ? '↑' : '↓'}</span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold" style={{ color: 'var(--color-text-1)' }}>{t.name}</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-2)' }}>
                      {t.delta > 0
                        ? `Rating improved: ${t.avgPrev}★ → ${t.avgCur}★ (+${t.delta.toFixed(2)})`
                        : `Rating declined: ${t.avgPrev}★ → ${t.avgCur}★ (${t.delta.toFixed(2)})`}
                    </p>
                  </div>
                  <Badge variant={t.delta > 0 ? 'success' : 'warning'} className="flex-shrink-0">
                    {t.delta > 0 ? '+' : ''}{t.delta.toFixed(2)}★
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Desktop persistent detail column (lg+) -- only mounted when
            isDesktop, so ResponseWorkspace's stateful draft text never
            exists as two simultaneous instances (see useIsDesktop above). ── */}
        {isDesktop && (
          <div className="lg:sticky lg:top-6">
            <ReviewDetailPersistent
              r={selected}
              draft={selectedDraft}
              allReviews={filtered}
              wsEntry={selectedWsEntry}
              bridgeEntry={selectedBridgeEntry}
              onUpdate={setRecord}
              onPublishSuccess={advanceToNext}
              nextReviewId={nextReviewId}
            />
          </div>
        )}
      </div>

      {/* ── Mobile/tablet overlay (below lg only) -- only mounted when NOT
          isDesktop, for the same reason. ── */}
      {!isDesktop && (
        <AnimatePresence>
          {selected && (
            <ReviewDetailOverlay
              r={selected}
              draft={selectedDraft}
              allReviews={filtered}
              onClose={() => setSelectedKey(null)}
              wsEntry={selectedWsEntry}
              bridgeEntry={selectedBridgeEntry}
              onUpdate={setRecord}
              onPublishSuccess={advanceToNext}
              nextReviewId={nextReviewId}
            />
          )}
        </AnimatePresence>
      )}
    </div>
  )
}
