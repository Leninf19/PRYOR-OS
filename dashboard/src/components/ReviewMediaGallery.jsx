import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import useFocusTrap from '../hooks/useFocusTrap'
import {
  usableItems, computeThumbnailLayout, countByType, computeSwipeTarget, computeArrowKeyTarget,
  canDownloadItem,
} from '../utils/reviewMediaGallery.js'
import { downloadReviewMedia } from '../services/reviewMediaService.js'

// Review Media Feature -- Scale & No-Backfill Audit (Phase 9). Renders a
// compact thumbnail strip for the SELECTED review's detail panel only --
// never in a review-table row -- plus an accessible lightbox for browsing
// the full set. `items` is the already-sanitized/gated array PRYOR's own
// backend produced (db.upsert_review()'s no-backfill gate + media_sanitizer.py);
// this component performs its OWN, independent HTTPS validation again
// (see ../utils/reviewMediaGallery.js) before ever rendering a URL, per
// the "safe URL validation again on the frontend" requirement -- it never
// trusts the backend blindly.
//
// PRYOR never claims to have analyzed or understood the contents of any
// photo or video shown here -- this is a pass-through display of Google's
// own review media, nothing more.

function MediaThumb({ item, onBroken }) {
  const [broken, setBroken] = useState(false)

  if (broken) {
    return (
      <div
        className="w-full h-full flex items-center justify-center text-[10px] rounded-lg"
        style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-3)', border: '1px solid var(--color-border)' }}
      >
        Unavailable
      </div>
    )
  }

  return (
    <img
      src={item.thumbnailUrl}
      alt={item.thumbnailLabel || (item.type === 'video' ? 'Review video thumbnail' : 'Review photo')}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="w-full h-full object-cover rounded-lg"
      onError={() => {
        setBroken(true)
        onBroken?.()
      }}
    />
  )
}

// Review Media View/Download feature: PHOTOS ONLY, server-proxied through
// dashboard/api/actions/[action].js's download-media action -- never a raw Google
// URL is ever downloaded directly. A video item, or a photo the endpoint
// itself rejects (oversized/invalid upstream response), falls back to
// simply opening that item's own URL in a new tab -- "View/Open" rather
// than a failed download, per this feature's spec.
const DOWNLOAD_STATE = { IDLE: 'idle', DOWNLOADING: 'downloading', ERROR: 'error' }

function openInNewTab(url) {
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

function LightboxDialog({ items, index, reviewId, onClose, onNavigate }) {
  const panelRef = useRef(null)
  useFocusTrap(panelRef, true, onClose)
  const [downloadState, setDownloadState] = useState(DOWNLOAD_STATE.IDLE)

  const current = items[index]
  const hasPrev = index > 0
  const hasNext = index < items.length - 1

  // Never let a stale "download failed" message linger against a
  // different item after the user navigates away from the one that
  // produced it.
  useEffect(() => {
    setDownloadState(DOWNLOAD_STATE.IDLE)
  }, [index])

  const handleKeyDown = useCallback((e) => {
    const target = computeArrowKeyTarget(e.key, index, items.length)
    if (target !== null) onNavigate(target)
  }, [index, items.length, onNavigate])

  const handleDragEnd = (_e, info) => {
    const target = computeSwipeTarget(index, items.length, info.offset.x, info.velocity.x)
    if (target !== null) onNavigate(target)
  }

  const handleDownload = useCallback(async () => {
    if (!current || !canDownloadItem(current) || !reviewId) return
    setDownloadState(DOWNLOAD_STATE.DOWNLOADING)
    try {
      await downloadReviewMedia(reviewId, current.sortOrder)
      setDownloadState(DOWNLOAD_STATE.IDLE)
    } catch {
      // A video item, an oversized/invalid upstream response, a timeout,
      // etc. -- the endpoint already rejected it with a clear error, so
      // fall back to View/Open (the item's own URL in a new tab) rather
      // than leaving the user with nothing.
      setDownloadState(DOWNLOAD_STATE.ERROR)
      openInNewTab(current.thumbnailUrl)
    }
  }, [current, reviewId])

  if (typeof document === 'undefined' || !current) return null

  return createPortal(
    <AnimatePresence>
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onKeyDown={handleKeyDown}>
        <motion.div
          className="absolute inset-0"
          style={{ background: 'rgba(0,0,0,0.85)' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
          onClick={onClose}
          aria-hidden="true"
        />
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Review media, item ${index + 1} of ${items.length}`}
          tabIndex={-1}
          className="relative w-full max-w-3xl max-h-[85vh] flex flex-col items-center justify-center gap-3"
          initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.18 }}
        >
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute -top-2 -right-2 w-9 h-9 rounded-full flex items-center justify-center text-sm z-10"
            style={{ background: 'var(--color-surface)', color: 'var(--color-text-1)' }}
          >
            ✕
          </button>

          <motion.div
            key={current.thumbnailUrl}
            className="relative w-full flex items-center justify-center"
            style={{ maxHeight: '70vh' }}
            drag={items.length > 1 ? 'x' : false}
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.2}
            onDragEnd={handleDragEnd}
          >
            {current.type === 'video' && current.videoUrl ? (
              <video
                key={current.videoUrl}
                src={current.videoUrl}
                controls
                playsInline
                autoPlay={false}
                referrerPolicy="no-referrer"
                className="max-w-full max-h-[70vh] rounded-lg"
              />
            ) : (
              <img
                key={current.thumbnailUrl}
                src={current.thumbnailUrl}
                alt={current.thumbnailLabel || 'Review photo'}
                referrerPolicy="no-referrer"
                className="max-w-full max-h-[70vh] rounded-lg object-contain"
              />
            )}
          </motion.div>

          <div className="flex items-center gap-4">
            <button
              onClick={() => hasPrev && onNavigate(index - 1)}
              disabled={!hasPrev}
              aria-label="Previous item"
              className="w-9 h-9 rounded-full flex items-center justify-center text-sm disabled:opacity-30"
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-1)' }}
            >
              ‹
            </button>
            <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-inverse, #fff)' }}>
              {index + 1} of {items.length}
            </span>
            <button
              onClick={() => hasNext && onNavigate(index + 1)}
              disabled={!hasNext}
              aria-label="Next item"
              className="w-9 h-9 rounded-full flex items-center justify-center text-sm disabled:opacity-30"
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-1)' }}
            >
              ›
            </button>
          </div>

          {/* PHOTOS ONLY -- a video item (or a photo the download endpoint
              itself rejects) offers "Open in a new tab" instead, never a
              failed/silent download attempt. */}
          <div className="flex items-center gap-2">
            {canDownloadItem(current) ? (
              <button
                type="button"
                onClick={handleDownload}
                disabled={downloadState === DOWNLOAD_STATE.DOWNLOADING || !reviewId}
                className="px-3 py-1.5 rounded-full text-xs font-semibold disabled:opacity-50"
                style={{ background: 'var(--color-surface)', color: 'var(--color-text-1)' }}
              >
                {downloadState === DOWNLOAD_STATE.DOWNLOADING ? 'Downloading…' : 'Download'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => openInNewTab(current.videoUrl || current.thumbnailUrl)}
                className="px-3 py-1.5 rounded-full text-xs font-semibold"
                style={{ background: 'var(--color-surface)', color: 'var(--color-text-1)' }}
              >
                Open in new tab
              </button>
            )}
            {downloadState === DOWNLOAD_STATE.ERROR && (
              <span role="status" aria-live="polite" className="text-[11px]" style={{ color: 'var(--color-text-inverse, #fff)' }}>
                Download unavailable — opened in a new tab instead.
              </span>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body
  )
}

export default function ReviewMediaGallery({ items, reviewId }) {
  const safeItems = usableItems(items)
  const [lightboxIndex, setLightboxIndex] = useState(null)

  // Close (unmount) any open lightbox if the underlying item set changes
  // out from under it (e.g. a different review is selected) -- never leave
  // a stale video/photo playing against a gallery that no longer matches it.
  useEffect(() => {
    setLightboxIndex(null)
  }, [items])

  if (safeItems.length === 0) return null

  const { visible, overflowCount } = computeThumbnailLayout(safeItems)
  const { photoCount, videoCount } = countByType(safeItems)

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--color-text-3)' }}>
          {safeItems.length} media item{safeItems.length === 1 ? '' : 's'}
          {photoCount > 0 && videoCount > 0 ? ` (${photoCount} photo${photoCount === 1 ? '' : 's'}, ${videoCount} video${videoCount === 1 ? '' : 's'})` : ''}
        </p>
        {/* Explicit "View" affordance, in addition to clicking a thumbnail
            directly (both open the same accessible lightbox) -- opens at
            the first item. */}
        <button
          type="button"
          onClick={() => setLightboxIndex(0)}
          className="text-[10px] font-bold uppercase tracking-wider underline underline-offset-2"
          style={{ color: 'var(--color-text-3)' }}
        >
          View
        </button>
      </div>
      <div className="flex gap-2">
        {visible.map((item, i) => {
          const isLastVisibleWithOverflow = i === visible.length - 1 && overflowCount > 0
          return (
            <button
              key={item.thumbnailUrl}
              type="button"
              onClick={() => setLightboxIndex(i)}
              aria-label={item.type === 'video' ? `Open video ${i + 1}` : `Open photo ${i + 1}`}
              className="relative rounded-lg overflow-hidden"
              style={{ width: 64, height: 64, flexShrink: 0 }}
            >
              <MediaThumb item={item} />
              {item.type === 'video' && !isLastVisibleWithOverflow && (
                <span
                  className="absolute bottom-1 right-1 w-4 h-4 rounded-full flex items-center justify-center text-[8px]"
                  style={{ background: 'rgba(0,0,0,0.6)', color: '#fff' }}
                  aria-hidden="true"
                >
                  ▶
                </span>
              )}
              {isLastVisibleWithOverflow && (
                <span
                  className="absolute inset-0 flex items-center justify-center text-xs font-bold rounded-lg"
                  style={{ background: 'rgba(0,0,0,0.55)', color: '#fff' }}
                  aria-hidden="true"
                >
                  +{overflowCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {lightboxIndex !== null && (
        <LightboxDialog
          items={safeItems}
          index={lightboxIndex}
          reviewId={reviewId}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
        />
      )}
    </div>
  )
}
