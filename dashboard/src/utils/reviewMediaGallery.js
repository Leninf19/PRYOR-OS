// Review Media Feature -- Scale & No-Backfill Audit (Phase 9). Pure,
// framework-free logic for ReviewMediaGallery.jsx, split into its own
// module specifically so it can be unit-tested directly (this codebase has
// no React-rendering test harness -- adding one, e.g. jsdom/@testing-library,
// would be a new external dependency this feature is not authorized to
// add) without needing to render any JSX at all.

export const MAX_VISIBLE_THUMBNAILS = 5

// Independent, frontend-side re-validation -- never trusts that the
// backend's own gate/sanitizer already ran correctly. Only a genuinely
// well-formed https:// URL with a hostname is ever considered safe.
export function isSafeHttpsUrl(url) {
  if (typeof url !== 'string' || !url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && Boolean(parsed.hostname)
  } catch {
    return false
  }
}

// Filters/normalizes a raw `media` array (as exported by export_chunks.py's
// review_to_dict()) down to only items this UI will ever render. An item
// without a safe thumbnailUrl is dropped entirely -- never rendered with a
// broken/missing image as the ONLY content. `type` is re-derived here
// (never trusted verbatim) from whether a safe videoUrl is present.
export function usableItems(items) {
  if (!Array.isArray(items)) return []
  return items
    .filter(item => item && typeof item === 'object' && isSafeHttpsUrl(item.thumbnailUrl))
    .map(item => ({
      type: item.type === 'video' && isSafeHttpsUrl(item.videoUrl) ? 'video' : 'photo',
      thumbnailUrl: item.thumbnailUrl,
      thumbnailLabel: typeof item.thumbnailLabel === 'string' ? item.thumbnailLabel : '',
      videoUrl: isSafeHttpsUrl(item.videoUrl) ? item.videoUrl : null,
    }))
}

// Splits an already-sanitized (usableItems()) list into what the
// thumbnail strip actually shows (at most `maxVisible`) and how many
// additional items exist beyond that (the "+N" overlay count).
export function computeThumbnailLayout(safeItems, maxVisible = MAX_VISIBLE_THUMBNAILS) {
  const visible = safeItems.slice(0, maxVisible)
  const overflowCount = Math.max(safeItems.length - visible.length, 0)
  return { visible, overflowCount }
}

export function countByType(safeItems) {
  return {
    photoCount: safeItems.filter(i => i.type === 'photo').length,
    videoCount: safeItems.filter(i => i.type === 'video').length,
  }
}

// Decides the lightbox's next index from a framer-motion onDragEnd
// (offsetX/velocityX) event, or null if the gesture doesn't cross either
// threshold, or would move past either end of the list. A swipe LEFT
// (negative offset/velocity) advances to the NEXT item; a swipe RIGHT
// goes to the PREVIOUS item -- matching this component's actual drag
// handler exactly, so this is the single source of truth for that
// decision, testable without simulating a real pointer gesture.
export function computeSwipeTarget(currentIndex, itemCount, offsetX, velocityX, {
  distanceThreshold = 60, velocityThreshold = 400,
} = {}) {
  const swipedLeft = offsetX < -distanceThreshold || velocityX < -velocityThreshold
  const swipedRight = offsetX > distanceThreshold || velocityX > velocityThreshold
  if (swipedLeft && currentIndex < itemCount - 1) return currentIndex + 1
  if (swipedRight && currentIndex > 0) return currentIndex - 1
  return null
}

// Decides the lightbox's next index from an ArrowLeft/ArrowRight keydown,
// or null if there is nowhere to go (already at an end) -- clamped, never
// wraps, matching the Previous/Next buttons' own disabled-at-the-ends
// behavior exactly.
export function computeArrowKeyTarget(key, currentIndex, itemCount) {
  if (key === 'ArrowLeft' && currentIndex > 0) return currentIndex - 1
  if (key === 'ArrowRight' && currentIndex < itemCount - 1) return currentIndex + 1
  return null
}
