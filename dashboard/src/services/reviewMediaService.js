/**
 * Downloads one review's photo media item through the authenticated,
 * server-side proxy endpoint (dashboard/api/actions/[action].js's
 * download-media action) -- NEVER a raw Google URL; only the review's own stable id
 * (dataUtils.js's reviewId()) and the item's 0-based sortOrder are ever
 * sent (see reviewMediaGallery.js's buildMediaDownloadUrl()).
 *
 * fetch-then-blob-URL approach (rather than a bare <a href=... download>
 * anchor) specifically so a non-2xx response (a video item, an oversized/
 * invalid upstream media file, a timeout, etc.) can be detected and
 * handled gracefully by the caller instead of the browser silently
 * "downloading" an error JSON body as if it were the photo.
 *
 * Throws on both transport failure and a non-2xx response -- the thrown
 * Error carries `.code` (the API's error string, e.g. 'not_downloadable' /
 * 'too_large' / 'timeout' / 'invalid_content_type') so the caller can react
 * (e.g. falling back to opening the item's own thumbnailUrl in a new tab)
 * without re-parsing a message string. Same convention as
 * reviewEmailService.js's sendReviewEmail().
 */

import { SESSION_EXPIRED_EVENT } from '../lib/dataClient.js'
import { buildMediaDownloadUrl } from '../utils/reviewMediaGallery.js'

function filenameFromContentDisposition(header) {
  if (typeof header !== 'string') return null
  const match = /filename="([^"]+)"/.exec(header)
  return match ? match[1] : null
}

export async function downloadReviewMedia(reviewId, sortOrder) {
  const url = buildMediaDownloadUrl(reviewId, sortOrder)
  if (!url) throw new Error('Cannot download this item: missing review id or index.')

  const res = await fetch(url)

  if (res.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    throw new Error('Session expired downloading media')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const err = new Error(body.message || `Failed to download media: ${res.status}`)
    err.code = body.error
    throw err
  }

  const blob = await res.blob()
  const filename = filenameFromContentDisposition(res.headers.get('content-disposition')) || 'review-photo'

  const objectUrl = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Revoked on a delay rather than synchronously -- freeing the object
    // URL immediately can race the browser actually starting the download
    // from it in some browsers.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000)
  }
}
