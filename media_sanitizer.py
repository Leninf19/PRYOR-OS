"""
media_sanitizer.py -- Review Media Feature (Scale & No-Backfill Audit,
Phase 3). The ONE shared sanitizer used before any Google reviewMediaItems
payload is allowed to reach persistence (db.upsert_review()'s gate calls
this, or is handed its already-sanitized output -- see that function's
docstring for the exact contract).

This module NEVER makes a network request of any kind -- every URL is only
ever passed to urllib.parse.urlparse() (a pure string parse). It never
downloads, probes, or HEADs a thumbnailUrl/videoUrl, never generates
base64, and its own docstrings/comments never quote a real URL or label
value (see this file's own tests for the same discipline).

Google's authenticated API is the only source this sanitizer is ever fed
from in this codebase -- but HTTPS validation below is applied unconditionally
regardless of source, and no Google-hostname allowlist is hardcoded here
(the Scale & No-Backfill audit's live diagnostic has not yet confirmed the
real hostname set actually returned for real reviews -- hardcoding one now
would risk silently rejecting legitimate media the first time the actual
hostname turns out to differ from a guess).

Input shape (Google's reviewMediaItems, as returned inside a Review
resource -- an arbitrary/untrusted-shaped list as far as this module is
concerned): a list of dicts that MAY contain 'thumbnailUrl', 'videoUrl',
'thumbnailLabel', and/or other fields this module ignores entirely.

Output shape: a list of dicts, each containing ONLY:
    {"type": "photo" | "video", "thumbnailUrl": str, "thumbnailLabel": str,
     "videoUrl": str | None, "sortOrder": int}
Never a raw Google field name, never a mediaFormat value, never any key
beyond these five.
"""
import json
from urllib.parse import urlparse

MAX_ITEMS_CONSIDERED = 20
MAX_URL_LENGTH = 2048
MAX_LABEL_LENGTH = 200
MAX_SERIALIZED_BYTES = 8 * 1024

_REJECTED_SCHEMES = {"javascript", "data", "file", "http"}


def _is_safe_media_url(url) -> bool:
    """True only for a syntactically well-formed, HTTPS, non-credential-
    bearing URL within the length cap. Never makes a network request --
    this is a pure string parse via urlparse(). An oversized URL is
    rejected outright here, never truncated (truncating a URL produces a
    different, broken URL -- worse than dropping it)."""
    if not isinstance(url, str) or not url:
        return False
    if len(url) > MAX_URL_LENGTH:
        return False
    try:
        parsed = urlparse(url)
    except ValueError:
        return False  # malformed (e.g. an invalid IPv6 literal) -- fail safe
    if parsed.scheme != "https":
        return False  # covers javascript:/data:/file:/http: and anything else
    if not parsed.netloc:
        return False  # malformed -- no host at all
    if parsed.username or parsed.password:
        return False  # credential-bearing (user:pass@host) -- rejected unconditionally
    return True


def _sanitize_label(label) -> str:
    """Plain text only, truncated (never rejected) to MAX_LABEL_LENGTH.
    Never returns None -- matches this codebase's existing convention for
    optional text fields (review_text/owner_response are always '', never
    None, when absent -- see db.py's _normalize_text_field())."""
    if not isinstance(label, str) or not label:
        return ""
    return label.strip()[:MAX_LABEL_LENGTH]


def _sanitize_one_item(item) -> dict | None:
    """Returns a sanitized {type, thumbnailUrl, thumbnailLabel, videoUrl}
    dict (sortOrder added by the caller once final order is known), or
    None if this item must be dropped entirely. Unknown fields on `item`
    are silently ignored; an unknown/malformed shape (not a dict, or a
    dict with no usable thumbnail) fails safe by returning None -- never
    raises."""
    if not isinstance(item, dict):
        return None

    thumbnail_url = item.get("thumbnailUrl")
    if not _is_safe_media_url(thumbnail_url):
        return None  # no usable thumbnail -- the item is dropped, full stop

    video_url = item.get("videoUrl")
    has_valid_video = _is_safe_media_url(video_url)

    return {
        "type": "video" if has_valid_video else "photo",
        "thumbnailUrl": thumbnail_url,
        "thumbnailLabel": _sanitize_label(item.get("thumbnailLabel")),
        "videoUrl": video_url if has_valid_video else None,
    }


def _dedup_key(sanitized_item: dict) -> tuple:
    return (sanitized_item["thumbnailUrl"], sanitized_item["videoUrl"])


def sanitize_review_media_items(raw_items) -> list[dict]:
    """The one shared sanitizer. Input: Google's raw reviewMediaItems (or
    None/anything else -- a non-list input is treated as empty, never
    raises). Output: a normalized list of AT MOST MAX_ITEMS_CONSIDERED
    items (usually fewer, after dropping unusable/duplicate items and any
    trailing items needed to stay within MAX_SERIALIZED_BYTES), each
    containing ONLY type/thumbnailUrl/thumbnailLabel/videoUrl/sortOrder.

    Order is deterministic: input order is preserved throughout (only the
    first MAX_ITEMS_CONSIDERED raw items are ever considered at all), and
    duplicate removal keeps the FIRST occurrence of a given
    (thumbnailUrl, videoUrl) pair, dropping later repeats -- never
    reordered by any other criterion. sortOrder is assigned 0..N-1 in this
    same, final, deterministic order.

    Never downloads or probes a URL. Never generates base64. This
    function's own return value never contains a key beyond the five
    listed above -- there is no way for an unknown Google field to leak
    through."""
    if not isinstance(raw_items, list):
        return []

    considered = raw_items[:MAX_ITEMS_CONSIDERED]

    sanitized: list[dict] = []
    seen_keys: set = set()
    for raw in considered:
        item = _sanitize_one_item(raw)
        if item is None:
            continue
        key = _dedup_key(item)
        if key in seen_keys:
            continue  # deterministic duplicate removal -- first occurrence wins
        seen_keys.add(key)
        sanitized.append(item)

    for index, item in enumerate(sanitized):
        item["sortOrder"] = index

    # Enforce the total serialized-size cap by dropping trailing items --
    # never by truncating any individual field (a truncated URL is a
    # broken URL). This never re-numbers the items that remain; their
    # sortOrder values are already a dense 0..k-1 prefix.
    while sanitized and len(json.dumps(sanitized, separators=(",", ":")).encode("utf-8")) > MAX_SERIALIZED_BYTES:
        sanitized.pop()

    return sanitized
