"""
digest_filters.py -- shared logic between the frequent critical-alert check
(critical_alert_check.py, run every ~15-20 min) and the nightly digest
(nightly_digest.py, run once at 10pm ET), so both apply identical "is this
review meaningful" / "is this critical and not yet escalated" rules instead
of two independently-drifting copies.

Reuses notify.py's existing notifications_log dedup helpers (already_notified/
log_notification) rather than reimplementing them.
"""
import re
from datetime import datetime, timedelta, timezone

from notify import already_notified, log_notification  # noqa: F401 (log_notification re-exported for callers)

# Bounds how far back "critical and unescalated" looks. Without this, the
# very first run after this feature ships would immediately fire on every
# critical review in the entire historical backlog at once -- this project
# already hit exactly this failure mode once before with stale_reply_alert/
# negative_spike_alert in refresh_analytics.py, so the same fix applies here.
CRITICAL_LOOKBACK_DAYS = 30

# Generic, content-free phrases that provide no actionable information on
# their own -- matched against the FULL stripped review text, so a longer
# review that happens to mention "bad" in passing isn't excluded.
_GENERIC_PHRASES = {
    "bad", "no", "terrible", "worst", "awful", "horrible", "never again",
    "not good", "poor", "meh", "ok", "okay", "fine", "nothing special",
    "do not recommend", "dont recommend", "wont be back", "will not be back",
    "waste of money", "waste of time", "not worth it", "disappointed",
}

_MIN_MEANINGFUL_LENGTH = 15  # characters, after stripping punctuation/emoji


def _strip_punctuation_and_emoji(text: str) -> str:
    """Keeps letters/numbers/spaces only -- reduces "..." / a string of
    thumbs-down emoji / "!!!" all to an empty string."""
    return re.sub(r"[^\w\s]", "", text, flags=re.UNICODE).strip()


def is_meaningful_review(review_text: str) -> bool:
    """True if a review has enough real, specific content to be worth
    including in the nightly digest. Matches every include/exclude example
    from the spec: excludes empty / stars-only / "Bad" / punctuation-or-
    emoji-only / very short reviews; includes anything with actual
    descriptive content."""
    if not review_text:
        return False
    stripped = _strip_punctuation_and_emoji(review_text)
    if len(stripped) < _MIN_MEANINGFUL_LENGTH:
        return False
    if stripped.lower() in _GENERIC_PHRASES:
        return False
    return True


def find_unescalated_critical_reviews(conn) -> list:
    """Unanswered reviews the AI classifier marked 'critical' that haven't
    already been sent via the immediate-alert path -- used by
    critical_alert_check.py to decide what to send right now. Bounded to the
    last CRITICAL_LOOKBACK_DAYS so old backlog can never flood this channel
    (see the module-level comment on CRITICAL_LOOKBACK_DAYS)."""
    since_date = (datetime.now(timezone.utc) - timedelta(days=CRITICAL_LOOKBACK_DAYS)).date().isoformat()
    rows = conn.execute(
        """SELECT r.*, l.name AS location_name, l.city AS city FROM reviews r
           JOIN locations l ON l.id = r.location_id
           WHERE r.is_deleted = 0 AND r.ai_priority = 'critical'
             AND (r.owner_response IS NULL OR TRIM(r.owner_response) = '')
             AND r.review_date >= ?""",
        (since_date,),
    ).fetchall()
    out = []
    for r in rows:
        if already_notified(conn, "critical_review_immediate", related_review_id=r["id"]):
            continue
        out.append(dict(r))
    return out


def is_already_escalated(conn, review_id: int) -> bool:
    """For the nightly digest: was this specific review already sent via the
    immediate critical-alert path? If so it should be labeled "Previously
    Escalated" rather than presented as a fresh alert."""
    return already_notified(conn, "critical_review_immediate", related_review_id=review_id)
