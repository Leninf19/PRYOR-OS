import { useState, useMemo, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useToast } from '../components/ui/Toast.jsx'
import Card from '../components/ui/Card.jsx'
import Badge from '../components/ui/Badge.jsx'
import Button from '../components/ui/Button.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import { sentimentBucket } from '../utils/dataUtils.js'
import { exportCSV } from '../utils/exportUtils.js'
import { useResponseDrafts, useMeta } from '../hooks/useIntelligence.js'
import { useReviewWorkspace } from '../hooks/useReviewWorkspace.js'
import { useActionWorkspace } from '../hooks/useActionWorkspace.js'
import { useReviewEmailPreview, useSendReviewEmail } from '../hooks/useReviewEmailWorkflow.js'
import { useAccount } from '../components/AuthGate.jsx'

const PAGE_SIZE = 40

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

// Restaurant bad-review email workflow status badges (recovery-audit
// milestone) -- a separate workspace/state machine from the response
// workspace above (STATUS_META tracks the customer-facing Google reply;
// this tracks the internal "did we email the restaurant" thread).
const EMAIL_STATUS_META = {
  not_sent:           { label: 'Not Sent',            variant: 'neutral' },
  sent:               { label: 'Sent',                variant: 'info' },
  replied:            { label: 'Replied',             variant: 'success' },
  follow_up_required: { label: 'Follow-Up Required',  variant: 'warning' },
  resolved:           { label: 'Resolved',             variant: 'success' },
  failed:             { label: 'Send Failed',          variant: 'danger' },
}
const DUPLICATE_EMAIL_STATUSES = new Set(['sent', 'replied', 'follow_up_required', 'resolved'])

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
}

function reviewId(r) {
  return r.review_id || r.review_url || `${r.review_date}-${r.reviewer_name}`
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

function WorkspaceStats({ reviews, ws, draftByReviewId }) {
  const total     = reviews.length
  const withDraft = reviews.filter(r => draftByReviewId[r.review_id || r.review_url || '']).length
  const urgent    = reviews.filter(r => (r.star_rating ?? 5) <= 1).length
  const done      = reviews.filter(r => STATUS_META[ws[reviewId(r)]?.status]?.done).length

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[
        { label: 'Awaiting Response', value: total,     color: 'var(--color-danger)'  },
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

// ─── Filter bar ───────────────────────────────────────────────────────────────

function FilterBar({
  keyword, onKeyword, noReply, onNoReply, stars, onStars, locations, location, onLocation,
  sentiment, onSentiment, length, onLength, count,
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Keyword */}
      <div className="flex-1 min-w-48 relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
             style={{ color: 'var(--color-text-3)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
        <input
          type="search"
          placeholder="Search reviews, reviewer, location…"
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

      {/* Star filter */}
      <select
        value={stars}
        onChange={e => onStars(e.target.value)}
        className="text-sm px-3 py-2 rounded-lg border focus:outline-none"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
        aria-label="Filter by stars"
      >
        <option value="">All stars</option>
        {[1,2,3,4,5].map(s => <option key={s} value={s}>{s}★</option>)}
      </select>

      {/* AI Sentiment filter */}
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

      {/* Review length filter */}
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

      {/* Location */}
      {locations.length > 0 && (
        <select
          value={location}
          onChange={e => onLocation(e.target.value)}
          className="text-sm px-3 py-2 rounded-lg border focus:outline-none max-w-[200px]"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-1)' }}
          aria-label="Filter by location"
        >
          <option value="">All locations</option>
          {locations.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      )}

      {/* No reply toggle */}
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none"
             style={{ color: 'var(--color-text-2)' }}>
        <input type="checkbox" checked={noReply} onChange={e => onNoReply(e.target.checked)}
               className="w-3.5 h-3.5 rounded accent-amber-700" />
        No reply only
      </label>

      <span className="text-xs ml-auto" style={{ color: 'var(--color-text-3)' }}>
        {count.toLocaleString()} results
      </span>
    </div>
  )
}

// ─── Review row (click opens the side panel) ──────────────────────────────────

function ReviewRow({ r, selected, onSelect, wsStatus }) {
  const needsReply = !r.owner_response && (r.star_rating ?? 5) <= 2
  const tags = r.complaint_tags ?? []
  const doneMeta = wsStatus ? STATUS_META[wsStatus] : null

  const statusBadge = r.owner_response
    ? <Badge variant="success">✓ Replied</Badge>
    : doneMeta?.done
      ? <Badge variant={doneMeta.variant}>{doneMeta.label}</Badge>
      : needsReply
        ? <Badge variant="danger">Needs reply</Badge>
        : <Badge variant="neutral">No reply</Badge>

  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3 px-4 py-3 border-b cursor-pointer transition-colors ${needsReply ? 'border-l-4' : ''}`}
      style={{
        borderColor: 'var(--color-border)',
        borderLeftColor: needsReply && !doneMeta?.done ? 'var(--color-danger)' : undefined,
        background: selected ? 'var(--color-surface-2)' : 'var(--color-surface)',
        opacity: doneMeta?.done ? 0.6 : 1,
      }}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onSelect() }}
      aria-selected={selected}
    >
      {/* Star + date */}
      <div className="flex sm:flex-col items-center sm:items-start gap-2 sm:gap-0 sm:flex-shrink-0 sm:w-20 sm:pt-0.5">
        <StarBadge n={r.star_rating ?? 1} />
        <p className="text-[10px] sm:mt-1" style={{ color: 'var(--color-text-3)' }}>{r.review_date}</p>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold truncate" style={{ color: 'var(--color-text-1)' }}>
          {r.reviewer_name || 'Anonymous'}
          <span className="font-normal ml-1.5" style={{ color: 'var(--color-text-3)' }}>
            · {r.location_name}
          </span>
        </p>
        {r.review_text
          ? <p className="text-xs mt-0.5 line-clamp-2 leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
              {r.review_text}
            </p>
          : <em className="text-xs" style={{ color: 'var(--color-text-3)' }}>No text</em>
        }
        {/* Below sm: sentiment/priority/status/tags all collapse into one wrapping badge row here
            instead of the fixed-width columns to the right, which don't fit a phone viewport. */}
        <div className="flex flex-wrap gap-1.5 mt-1.5 sm:hidden">
          <SentimentBadge r={r} />
          <PriorityBadge r={r} />
          {statusBadge}
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {tags.slice(0, 3).map(t => <span key={t} className="badge badge-danger">{t.replace(/_/g, ' ')}</span>)}
          </div>
        )}
      </div>

      {/* AI Sentiment — sm and up only */}
      <div className="hidden sm:block flex-shrink-0 w-28 pt-0.5"><SentimentBadge r={r} /></div>
      {/* AI Priority — sm and up only */}
      <div className="hidden sm:block flex-shrink-0 w-20 pt-0.5"><PriorityBadge r={r} /></div>
      {/* Status — sm and up only */}
      <div className="hidden sm:block flex-shrink-0 w-24 pt-0.5">{statusBadge}</div>
    </div>
  )
}

// ─── Response workspace section (inside the side panel) ───────────────────────

function ResponseWorkspace({ r, draft, wsEntry, onUpdate }) {
  const rid            = reviewId(r)
  const initialStatus  = draft ? 'draft_ready' : 'needs_review'
  const status         = wsEntry?.status ?? initialStatus
  const statusMeta     = STATUS_META[status] ?? STATUS_META.needs_review
  const isDone         = statusMeta.done
  const failReason     = wsEntry?.failReason ?? null

  const [localDraft, setLocalDraft] = useState(wsEntry?.editedDraft ?? draft?.draft ?? '')
  const [activeTone, setActiveTone] = useState(null)
  const [rewriting,  setRewriting]  = useState(false)
  const [rewriteErr, setRewriteErr] = useState(null)
  const [publishing, setPublishing] = useState(false)
  const [copied,     setCopied]     = useState(false)

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

  async function handlePublish() {
    if (!localDraft || publishing) return
    setPublishing(true)
    try {
      const res = await fetch('/api/google/publish', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(
          r.gbp_review_name
            ? { reviewName: r.gbp_review_name, replyText: localDraft }
            : { locationName: r.location_name, reviewerName: r.reviewer_name, replyText: localDraft }
        ),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        onUpdate(rid, { status: 'published', publishedAt: new Date().toISOString(), failReason: null }, 'Published to Google')
      } else {
        onUpdate(rid, { status: 'failed', failReason: data.error || 'api_error' }, 'Publish failed')
      }
    } catch {
      onUpdate(rid, { status: 'failed', failReason: 'network_error' }, 'Publish failed')
    } finally {
      setPublishing(false)
    }
  }

  function handleMarkPublished() {
    onUpdate(rid, { status: 'published', publishedAt: new Date().toISOString(), failReason: null }, 'Marked published')
  }

  function handleTakenCareOf() {
    onUpdate(rid, { status: 'taken_care_of', publishedAt: new Date().toISOString(), failReason: null }, 'Marked done')
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
          Response Workspace
        </p>
        <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
      </div>

      {failReason && (
        <div className="mb-3 px-3 py-2.5 rounded-lg text-xs leading-relaxed"
             style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)', border: '1px solid var(--color-danger-border)' }}>
          <strong>Publish failed:</strong> {FAIL_REASONS[failReason] ?? failReason}
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
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] font-bold uppercase tracking-[0.15em]" style={{ color: 'var(--color-text-3)' }}>
                {draft ? '✦ AI Response Draft' : 'Your Response'}
              </label>
              <span className="text-[10px]" style={{ color: charOver ? 'var(--color-danger)' : 'var(--color-text-3)' }}>
                {charCount} / 4096
              </span>
            </div>
            <textarea
              value={localDraft}
              onChange={e => onTextChange(e.target.value)}
              placeholder="Write a response to this review…"
              rows={4}
              className="w-full rounded-xl px-3 py-2.5 text-xs resize-y focus:outline-none transition-colors"
              style={{
                background: 'var(--ai-draft-bg)', color: 'var(--ai-draft-text)',
                border: `1px solid ${charOver ? 'var(--color-danger)' : 'var(--ai-draft-border)'}`,
                lineHeight: 1.6, fontFamily: 'inherit', minHeight: 84,
              }}
            />
          </div>

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
                            : { background: 'var(--color-surface-2)', color: 'var(--color-text-2)', borderColor: 'var(--color-border)', opacity: rewriting ? 0.5 : 1 }}>
                    {isActive && rewriting ? '…' : t.label}
                  </button>
                )
              })}
            </div>
            {rewriteErr && <p className="text-xs mt-2" style={{ color: 'var(--color-danger)' }}>{rewriteErr}</p>}
          </div>

          <div className="flex items-center gap-2 flex-wrap pt-1">
            <Button variant="primary" onClick={handlePublish} disabled={!localDraft || publishing}>
              {publishing ? 'Publishing…' : 'Publish to Google'}
            </Button>
            <Button variant={copied ? 'accent' : 'secondary'} onClick={handleCopy} disabled={!localDraft}>
              {copied ? '✓ Copied!' : 'Copy Response'}
            </Button>
            <a href={link.href} target="_blank" rel="noopener noreferrer">
              <Button variant="secondary">Open Google ↗</Button>
            </a>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" onClick={handleMarkPublished}>Mark Published</Button>
            <Button variant="ghost" onClick={handleTakenCareOf}>Already Done</Button>
          </div>
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
  const { data: meta } = useMeta()
  const { data: ws } = useActionWorkspace()
  const sendMutation = useSendReviewEmail()

  const [open, setOpen] = useState(false)
  const [subject, setSubject] = useState('')
  const [internalNote, setInternalNote] = useState('')
  const [followUpDueAt, setFollowUpDueAt] = useState('')
  const [confirmArmed, setConfirmArmed] = useState(false)

  const isNegative = (r.star_rating ?? 5) <= 2
  const canSend = account?.role === 'owner' || account?.role === 'marketing'

  const rid = reviewId(r)
  const entry = ws[rid]
  const emailStatus = entry?.emailStatus ?? 'not_sent'
  const statusMeta = EMAIL_STATUS_META[emailStatus] ?? EMAIL_STATUS_META.not_sent

  const locationMeta = (meta?.locations ?? []).find(l => l.locationId === r.locationId)
  const hasContact = locationMeta?.hasContact ?? false

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
          <p className="text-xs italic" style={{ color: 'var(--color-text-3)' }}>Restaurant email not configured</p>
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

// ─── Side panel ────────────────────────────────────────────────────────────────

function ReviewDetailPanel({ r, draft, allReviews, onClose, wsEntry, onUpdate }) {
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
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-stone-100 dark:hover:bg-[var(--color-surface-2)]" aria-label="Close panel"
                  style={{ color: 'var(--color-text-2)' }}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="flex-1 p-5 space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <StarBadge n={r.star_rating ?? 1} />
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

          {/* Owner response (already replied on Google) */}
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
          ) : (
            /* Not yet replied -- full response workspace (draft/edit/rewrite/publish) */
            <div className="pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
              <ResponseWorkspace r={r} draft={draft} wsEntry={wsEntry} onUpdate={onUpdate} />
            </div>
          )}

          {/* Internal notes + assignment -- available regardless of reply status */}
          <div className="pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
            <NotesAndAssignment r={r} wsEntry={wsEntry} onUpdate={onUpdate} />
          </div>

          <ResponseHistory history={wsEntry?.history} />

          <SendToRestaurantSection r={r} />

          {/* Similar reviews */}
          {similar.length > 0 && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--color-text-3)' }}>
                Similar Reviews at This Location
              </p>
              <div className="space-y-2">
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
            </div>
          )}

          {!r.owner_response && (
            <a href={link.href} target="_blank" rel="noopener noreferrer"
               className="badge badge-accent hover:opacity-80 transition-opacity inline-block">
              {link.label}
            </a>
          )}
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

export default function ReviewExplorer({ allReviews = [], filtered = [], prevFiltered = [] }) {
  const showToast = useToast()
  const { data: drafts } = useResponseDrafts()
  const { data: ws, setRecord } = useReviewWorkspace()
  const [searchParams, setSearchParams] = useSearchParams()

  const [sortKey, setSortKey]     = useState('review_date')
  const [sortDir, setSortDir]     = useState('desc')
  const [keyword, setKeyword]     = useState('')
  const [noReply, setNoReply]     = useState(false)
  const [stars,   setStars]       = useState('')
  const [sentiment, setSentiment] = useState('')
  const [length,  setLength]      = useState('')
  const [locFilter, setLocFilter] = useState('')
  const [page,    setPage]        = useState(0)
  const [selectedKey, setSelectedKey] = useState(null)
  const [needsResponseOnly, setNeedsResponseOnly] = useState(() => searchParams.get('filter') === 'needs-response')

  const resetPage = useCallback(() => setPage(0), [])

  function toggleNeedsResponse() {
    const next = !needsResponseOnly
    setNeedsResponseOnly(next)
    setSearchParams(next ? { filter: 'needs-response' } : {}, { replace: true })
    resetPage()
  }

  const locations = useMemo(() => [...new Set(filtered.map(r => r.location_name).filter(Boolean))].sort(), [filtered])

  const trendAlerts = useMemo(() => computeTrendAlerts(filtered, prevFiltered), [filtered, prevFiltered])

  const processed = useMemo(() => {
    let rows = filtered
    if (needsResponseOnly) rows = rows.filter(r => (Number(r.star_rating) || 5) <= 2 && !(r.owner_response || '').trim())
    if (noReply)   rows = rows.filter(r => !r.owner_response)
    if (stars)     rows = rows.filter(r => r.star_rating === Number(stars))
    if (locFilter) rows = rows.filter(r => r.location_name === locFilter)
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
  }, [filtered, needsResponseOnly, noReply, stars, locFilter, sentiment, length, keyword, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(processed.length / PAGE_SIZE))
  const safePage   = Math.min(page, totalPages - 1)
  const visible    = processed.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

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

  const selected = useMemo(
    () => visible.find((r, i) => `${r.review_id || r.review_url || i}` === selectedKey) ?? null,
    [visible, selectedKey]
  )
  const selectedDraft = selected ? draftByReviewId[selected.review_id || selected.review_url || ''] : null
  const selectedWsEntry = selected ? ws[reviewId(selected)] : null

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
    <div className="space-y-4 max-w-[1300px]">
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>Customer Experience Center</h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Search, filter, and respond to reviews across all locations — AI drafts, notes, assignments, and history in one place
        </p>
      </div>

      {/* Needs Response quick filter */}
      <button
        onClick={toggleNeedsResponse}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors"
        style={needsResponseOnly
          ? { background: 'var(--color-danger)', color: 'white', borderColor: 'var(--color-danger)' }
          : { background: 'var(--color-surface)', color: 'var(--color-text-2)', borderColor: 'var(--color-border)' }}>
        {needsResponseOnly ? '✓ Needs Response only' : 'Show only reviews needing a response'}
      </button>

      {needsResponseOnly && (
        <>
          <GBPBanner />
          <WorkspaceStats reviews={processed} ws={ws} draftByReviewId={draftByReviewId} />
        </>
      )}

      <Card className="p-4">
        <FilterBar
          keyword={keyword}    onKeyword={v => { setKeyword(v); resetPage() }}
          noReply={noReply}    onNoReply={v => { setNoReply(v); resetPage() }}
          stars={stars}        onStars={v => { setStars(v); resetPage() }}
          sentiment={sentiment} onSentiment={v => { setSentiment(v); resetPage() }}
          length={length}      onLength={v => { setLength(v); resetPage() }}
          locations={locations} location={locFilter} onLocation={v => { setLocFilter(v); resetPage() }}
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

      {/* Table */}
      <div className="card overflow-hidden">
        {/* Column header row — hidden below sm: since the row layout collapses to
            stacked badges there instead of matching these fixed columns. */}
        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: 'collapse', minWidth: 880 }}>
            <thead>
              <tr>
                <Th label="Date"      sortKey="review_date" active={sortKey==='review_date'} dir={sortDir} onSort={toggleSort} className="w-20" />
                <Th label="Content"   sortKey={null}        active={false}                    dir={sortDir} onSort={toggleSort} />
                <Th label="AI Sentiment" sortKey={null}     active={false}                    dir={sortDir} onSort={toggleSort} className="w-28" />
                <Th label="AI Priority"  sortKey={null}      active={false}                    dir={sortDir} onSort={toggleSort} className="w-20" />
                <Th label="Reply Status" sortKey={null}     active={false}                    dir={sortDir} onSort={toggleSort} className="w-24" />
              </tr>
            </thead>
          </table>
        </div>

        {/* Review rows (not table rows — allows the flexible row layout below) */}
        <div>
          {visible.length === 0 ? (
            <EmptyState icon="🔍" title="No reviews match your filters"
                        body="Try adjusting your keyword, sentiment, star filter, or date range." />
          ) : visible.map((r, i) => {
            const rid = r.review_id || r.review_url || ''
            const key = `${rid || i}`
            return (
              <ReviewRow
                key={key}
                r={r}
                selected={selectedKey === key}
                onSelect={() => setSelectedKey(key)}
                wsStatus={ws[reviewId(r)]?.status}
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

      <AnimatePresence>
        {selected && (
          <ReviewDetailPanel
            r={selected}
            draft={selectedDraft}
            allReviews={filtered}
            onClose={() => setSelectedKey(null)}
            wsEntry={selectedWsEntry}
            onUpdate={setRecord}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
