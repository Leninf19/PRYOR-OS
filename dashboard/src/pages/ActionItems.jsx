import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import Badge from '../components/ui/Badge.jsx'
import Button from '../components/ui/Button.jsx'
import Skeleton from '../components/ui/Skeleton.jsx'
import EmptyState from '../components/ui/EmptyState.jsx'
import { useResponseDrafts, useActionItems } from '../hooks/useIntelligence.js'

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_META = {
  needs_review:  { label: 'Needs Review',   variant: 'warning', done: false },
  draft_ready:   { label: 'AI Draft Ready', variant: 'accent',  done: false },
  edited:        { label: 'Edited',         variant: 'info',    done: false },
  approved:      { label: 'Approved',       variant: 'success', done: false },
  published:     { label: 'Published',      variant: 'success', done: true  },
  failed:        { label: 'Failed',         variant: 'danger',  done: false },
  taken_care_of: { label: 'Done',           variant: 'neutral', done: true  },
}

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

// ── localStorage workspace state ──────────────────────────────────────────────

const WS_KEY = 'review_workspace_v1'
function loadWS() { try { return JSON.parse(localStorage.getItem(WS_KEY) || '{}') } catch { return {} } }
function saveWS(s) { try { localStorage.setItem(WS_KEY, JSON.stringify(s)) } catch {} }

function useWorkspace() {
  const [ws, setWs] = useState(loadWS)
  const set = useCallback((id, patch) => {
    setWs(prev => {
      const next = { ...prev, [id]: { ...prev[id], ...patch } }
      saveWS(next)
      return next
    })
  }, [])
  return [ws, set]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function priority(r) {
  const stars   = Number(r.star_rating) || 3
  const daysOld = (Date.now() - new Date((r.review_date || '2020-01-01') + 'T12:00:00').getTime()) / 86400000
  return (6 - stars) * 10 + Math.min(daysOld, 60)
}

function daysAgo(dateStr) {
  if (!dateStr) return ''
  const d = Math.floor((Date.now() - new Date(dateStr + 'T12:00:00').getTime()) / 86400000)
  if (d === 0) return 'Today'
  if (d === 1) return 'Yesterday'
  return `${d}d ago`
}

function reviewId(r) {
  return r.review_id || r.review_url || `${r.review_date}-${r.reviewer_name}`
}

function Stars({ n }) {
  const color = n <= 1 ? 'var(--color-danger)' : n === 2 ? '#d97706' : n === 3 ? '#92400e' : 'var(--color-success)'
  return (
    <span className="text-sm font-bold" style={{ color, letterSpacing: '0.02em' }}>
      {'★'.repeat(n)}{'☆'.repeat(5 - n)}
    </span>
  )
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

// ── GBP connection banner ─────────────────────────────────────────────────────

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
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" style={{ color: '#d97706' }}>
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

// ── Individual review card ────────────────────────────────────────────────────

function ReviewCard({ r, draft, wsEntry, onUpdate }) {
  const rid         = reviewId(r)
  const initialStatus = draft ? 'draft_ready' : 'needs_review'
  const status      = wsEntry?.status ?? initialStatus
  const statusMeta  = STATUS_META[status] ?? STATUS_META.needs_review
  const isDone      = statusMeta.done
  const failReason  = wsEntry?.failReason ?? null
  const isUrgent    = (r.star_rating ?? 5) <= 1

  const [open,       setOpen]       = useState(false)
  const [localDraft, setLocalDraft] = useState(wsEntry?.editedDraft ?? draft?.draft ?? '')
  const [activeTone, setActiveTone] = useState(null)
  const [rewriting,  setRewriting]  = useState(false)
  const [rewriteErr, setRewriteErr] = useState(null)
  const [copied,     setCopied]     = useState(false)
  const textRef = useRef(null)

  // Sync if pipeline regenerates the draft and user hasn't edited yet
  useEffect(() => {
    if (!wsEntry?.editedDraft && draft?.draft) {
      setLocalDraft(draft.draft)
    }
  }, [draft?.draft]) // eslint-disable-line

  function onTextChange(val) {
    setLocalDraft(val)
    onUpdate({ editedDraft: val, status: 'edited' })
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
      onUpdate({ editedDraft: rewritten, status: 'edited' })
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

  function handlePublish() {
    // GBP API not connected — surface explicit error
    onUpdate({ status: 'failed', failReason: 'not_connected' })
    setOpen(true)
  }

  function handleMarkPublished() {
    onUpdate({ status: 'published', publishedAt: new Date().toISOString(), failReason: null })
    setOpen(false)
  }

  function handleTakenCareOf() {
    onUpdate({ status: 'taken_care_of', publishedAt: new Date().toISOString(), failReason: null })
    setOpen(false)
  }

  function handleUndo() {
    onUpdate({ status: initialStatus, failReason: null })
  }

  const charCount  = localDraft.length
  const charOver   = charCount > 4096

  return (
    <div
      className="rounded-2xl border overflow-hidden transition-opacity"
      style={{
        background:      'var(--color-surface)',
        borderColor:     isUrgent && !isDone ? 'var(--color-danger)' : 'var(--color-border)',
        borderLeftWidth: isUrgent && !isDone ? 3 : 1,
        opacity:         isDone ? 0.6 : 1,
      }}>

      {/* ── Header (always visible) ── */}
      <div className="px-5 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold" style={{ color: 'var(--color-text-1)' }}>
                {r.reviewer_name || 'Anonymous'}
              </span>
              <Stars n={r.star_rating ?? 1} />
              {isUrgent && !isDone && <Badge variant="danger">Urgent</Badge>}
              {draft && !isDone && status === 'draft_ready' && (
                <span className="ai-label">✦ AI Draft</span>
              )}
            </div>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-3)' }}>
              {r.location_name} · Google · {daysAgo(r.review_date)}
            </p>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
            {isDone && (
              <button
                onClick={handleUndo}
                className="text-[10px] underline"
                style={{ color: 'var(--color-text-3)' }}>
                Undo
              </button>
            )}
          </div>
        </div>

        {/* Review text */}
        {r.review_text ? (
          <p className="text-sm mt-3 leading-relaxed" style={{ color: 'var(--color-text-2)', lineHeight: 1.75 }}>
            "{r.review_text}"
          </p>
        ) : (
          <p className="text-xs mt-2 italic" style={{ color: 'var(--color-text-3)' }}>
            Rating only — no written review
          </p>
        )}

        {/* Fail reason */}
        {failReason && (
          <div className="mt-3 px-3 py-2.5 rounded-lg text-xs leading-relaxed"
               style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)', border: '1px solid #FECACA' }}>
            <strong>Publish failed:</strong> {FAIL_REASONS[failReason] ?? failReason}
          </div>
        )}

        {/* Done timestamp */}
        {isDone && wsEntry?.publishedAt && (
          <p className="text-[10px] mt-2" style={{ color: 'var(--color-text-3)' }}>
            Marked {status === 'published' ? 'published' : 'done'} · {new Date(wsEntry.publishedAt).toLocaleDateString()}
          </p>
        )}
      </div>

      {/* ── Expand toggle ── */}
      {!isDone && (
        <button
          onClick={() => setOpen(o => !o)}
          className="w-full px-5 py-2.5 flex items-center justify-between text-xs font-medium border-t transition-colors"
          style={{
            borderColor: 'var(--color-border)',
            background:  open ? 'var(--color-surface-2)' : 'transparent',
            color:       draft ? 'var(--color-accent)' : 'var(--color-text-2)',
          }}>
          <span>
            {draft
              ? open ? 'Hide response panel' : '✦ AI Draft ready — click to review & respond'
              : open ? 'Hide response panel' : 'Click to write a response'}
          </span>
          <svg
            className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
          </svg>
        </button>
      )}

      {/* ── Response panel (expanded) ── */}
      {open && !isDone && (
        <div className="px-5 pb-5 pt-4 space-y-4 border-t" style={{ borderColor: 'var(--color-border)' }}>

          {/* Draft textarea */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] font-bold uppercase tracking-[0.15em]"
                     style={{ color: 'var(--color-text-3)' }}>
                {draft ? '✦ AI Response Draft' : 'Your Response'}
              </label>
              <span className="text-[10px]" style={{ color: charOver ? 'var(--color-danger)' : 'var(--color-text-3)' }}>
                {charCount} / 4096
              </span>
            </div>
            <textarea
              ref={textRef}
              value={localDraft}
              onChange={e => onTextChange(e.target.value)}
              placeholder="Write a response to this review…"
              rows={5}
              className="w-full rounded-xl px-4 py-3 text-sm resize-y focus:outline-none transition-colors"
              style={{
                background:  '#1A1714',
                color:       '#D4C9BC',
                border:      `1px solid ${charOver ? 'var(--color-danger)' : '#3A2E25'}`,
                lineHeight:  1.75,
                fontFamily:  'inherit',
                minHeight:   96,
              }}
            />
          </div>

          {/* Tone rewrite */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] mb-2"
               style={{ color: 'var(--color-text-3)' }}>
              AI Rewrite Tone
            </p>
            <div className="flex flex-wrap gap-1.5">
              {TONES.map(t => {
                const isActive = activeTone === t.id
                return (
                  <button
                    key={t.id}
                    disabled={rewriting}
                    onClick={() => handleRewrite(t.id)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-all"
                    style={isActive
                      ? { background: 'var(--color-accent)', color: 'white',
                          borderColor: 'var(--color-accent)', opacity: 0.85 }
                      : { background: 'var(--color-surface-2)', color: 'var(--color-text-2)',
                          borderColor: 'var(--color-border)', opacity: rewriting ? 0.5 : 1 }}>
                    {isActive && rewriting ? '…' : t.label}
                  </button>
                )
              })}
            </div>
            {rewriteErr && (
              <p className="text-xs mt-2" style={{ color: 'var(--color-danger)' }}>
                {rewriteErr}
              </p>
            )}
          </div>

          {/* Action buttons */}
          <div className="pt-2 border-t flex items-center gap-2 flex-wrap" style={{ borderColor: 'var(--color-border)' }}>
            <Button variant="primary" onClick={handlePublish}>
              Publish to Google
            </Button>
            <Button
              variant={copied ? 'accent' : 'secondary'}
              onClick={handleCopy}
              disabled={!localDraft}>
              {copied ? '✓ Copied!' : 'Copy Response'}
            </Button>
            {r.review_url && (
              <a href={r.review_url} target="_blank" rel="noopener noreferrer">
                <Button variant="secondary">Open Google ↗</Button>
              </a>
            )}
            <div className="ml-auto flex items-center gap-2 flex-wrap">
              <Button variant="ghost" onClick={handleMarkPublished}>
                Mark Published
              </Button>
              <Button variant="ghost" onClick={handleTakenCareOf}>
                Already Done
              </Button>
            </div>
          </div>

        </div>
      )}
    </div>
  )
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function WorkspaceStats({ reviews, ws, draftByReviewId, loading }) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[1,2,3,4].map(i => <Skeleton key={i} className="h-20 rounded-2xl" />)}
      </div>
    )
  }

  const total     = reviews.length
  const withDraft = reviews.filter(r => draftByReviewId[r.review_id || r.review_url || '']).length
  const urgent    = reviews.filter(r => (r.star_rating ?? 5) <= 1).length
  const done      = reviews.filter(r => STATUS_META[ws[reviewId(r)]?.status]?.done).length

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {[
        { label: 'Awaiting Response', value: total,     color: 'var(--color-danger)'  },
        { label: 'AI Draft Ready',    value: withDraft, color: 'var(--color-accent)'  },
        { label: '1★ Urgent',         value: urgent,    color: '#d97706'              },
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

// ── Filter tabs ───────────────────────────────────────────────────────────────

const TABS = [
  { id: 'all',      label: 'All'         },
  { id: 'urgent',   label: '1★ Urgent'   },
  { id: 'draft',    label: 'Draft Ready' },
  { id: 'approved', label: 'Approved'    },
  { id: 'done',     label: 'Completed'   },
]

// ── Main ──────────────────────────────────────────────────────────────────────

export default function ActionItems() {
  const { data: items,  isLoading: lItems  } = useActionItems()
  const { data: drafts, isLoading: lDrafts  } = useResponseDrafts()
  const [ws, setWsEntry] = useWorkspace()
  const [tab, setTab]    = useState('all')

  const draftByReviewId = useMemo(() => {
    if (!drafts) return {}
    const out = {}
    Object.values(drafts).forEach(d => { if (d.review_id) out[d.review_id] = d })
    return out
  }, [drafts])

  const allReviews = useMemo(
    () => [...(items?.unanswered ?? [])].sort((a, b) => priority(b) - priority(a)),
    [items]
  )

  const counts = useMemo(() => ({
    all:      allReviews.length,
    urgent:   allReviews.filter(r => (r.star_rating ?? 5) <= 1).length,
    draft:    allReviews.filter(r => draftByReviewId[r.review_id || r.review_url || '']).length,
    approved: allReviews.filter(r => ['approved','edited'].includes(ws[reviewId(r)]?.status)).length,
    done:     allReviews.filter(r => STATUS_META[ws[reviewId(r)]?.status]?.done).length,
  }), [allReviews, draftByReviewId, ws])

  const visible = useMemo(() => {
    if (tab === 'urgent')   return allReviews.filter(r => (r.star_rating ?? 5) <= 1)
    if (tab === 'draft')    return allReviews.filter(r => draftByReviewId[r.review_id || r.review_url || ''])
    if (tab === 'approved') return allReviews.filter(r => ['approved','edited'].includes(ws[reviewId(r)]?.status))
    if (tab === 'done')     return allReviews.filter(r => STATUS_META[ws[reviewId(r)]?.status]?.done)
    return allReviews
  }, [allReviews, tab, draftByReviewId, ws])

  const isLoading = lItems || lDrafts

  return (
    <div className="space-y-6 max-w-[900px]">

      {/* Header */}
      <div>
        <h1 className="text-heading" style={{ color: 'var(--color-text-1)' }}>
          AI Review Workspace
        </h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-2)' }}>
          Review, edit, and respond to customer reviews — {allReviews.length} awaiting a response
        </p>
      </div>

      <GBPBanner />

      <WorkspaceStats
        reviews={allReviews}
        ws={ws}
        draftByReviewId={draftByReviewId}
        loading={isLoading}
      />

      {/* Filter tabs */}
      <div className="flex gap-1 p-1 rounded-xl w-fit overflow-x-auto"
           style={{ background: 'var(--color-surface-2)' }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="px-3.5 py-2 text-xs font-medium rounded-lg whitespace-nowrap transition-all"
            style={tab === t.id
              ? { background: 'var(--color-surface)', color: 'var(--color-text-1)', boxShadow: 'var(--shadow-sm)' }
              : { color: 'var(--color-text-2)' }}>
            {t.label}
            {counts[t.id] > 0 && (
              <span className="ml-1" style={{ opacity: 0.55 }}>({counts[t.id]})</span>
            )}
          </button>
        ))}
      </div>

      {/* Cards */}
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => <Skeleton key={i} className="h-32 w-full rounded-2xl" />)}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={tab === 'done' ? '✓' : counts.all === 0 ? '✓' : '🔍'}
          title={counts.all === 0 ? 'All caught up!' : tab === 'done' ? 'Nothing completed yet' : 'No reviews in this filter'}
          body={counts.all === 0
            ? 'No unanswered reviews. Great work keeping up with responses!'
            : 'Switch to a different tab to see reviews.'}
        />
      ) : (
        <div className="space-y-3">
          {visible.map(r => {
            const rid = reviewId(r)
            return (
              <ReviewCard
                key={rid}
                r={r}
                draft={draftByReviewId[r.review_id || r.review_url || '']}
                wsEntry={ws[rid]}
                onUpdate={patch => setWsEntry(rid, patch)}
              />
            )
          })}
        </div>
      )}

      {/* Trend alerts */}
      {!isLoading && (items?.trendAlerts?.length ?? 0) > 0 && (
        <div className="space-y-3 pt-2">
          <h3 className="text-label" style={{ color: 'var(--color-text-2)' }}>Rating Trend Alerts</h3>
          {items.trendAlerts.map((t, i) => (
            <div key={i} className="flex items-start gap-3 p-4 rounded-xl border"
                 style={{
                   background:  t.delta > 0 ? 'var(--color-success-bg)' : 'var(--color-warning-bg)',
                   borderColor: t.delta > 0 ? '#BBF7D0' : '#FDE68A',
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
  )
}

// ── Exported hook (sidebar badge + App.jsx compat) ────────────────────────────

export function useUnansweredCount() {
  const { data: items } = useActionItems()
  return items?.unanswered?.length ?? 0
}
