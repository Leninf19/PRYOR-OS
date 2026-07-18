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

# Google's Business Profile API returns star ratings as an enum string
# ("ONE".."FIVE"); some code paths/fixtures may also see "ONE_STAR"-style
# variants, or a plain numeric string/float from other sources. This maps
# every known shape to a plain int so filtering is never fooled by the
# review's original representation.
_STAR_ENUM_MAP = {
    "ONE": 1, "ONE_STAR": 1,
    "TWO": 2, "TWO_STAR": 2, "TWO_STARS": 2,
    "THREE": 3, "THREE_STAR": 3, "THREE_STARS": 3,
    "FOUR": 4, "FOUR_STAR": 4, "FOUR_STARS": 4,
    "FIVE": 5, "FIVE_STAR": 5, "FIVE_STARS": 5,
}


def normalize_rating(review) -> int | None:
    """Coerces a review's star rating into a plain int 1-5, regardless of
    whether the source stored it as an int, a float, a numeric string
    ("1", "1.0"), or a Google API enum string ("ONE", "ONE_STAR"). Returns
    None if the rating can't be determined -- callers must treat None as
    "not negative," never silently coerce it to a guessed value."""
    raw = review.get("star_rating") if hasattr(review, "get") else review["star_rating"]
    if raw is None:
        return None
    if isinstance(raw, bool):  # bool is a subclass of int -- exclude explicitly
        return None
    if isinstance(raw, (int, float)):
        n = int(raw)
        return n if 1 <= n <= 5 else None
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return None
        try:
            n = int(float(s))
            return n if 1 <= n <= 5 else None
        except ValueError:
            pass
        return _STAR_ENUM_MAP.get(s.upper())
    return None


def is_negative_review_for_notification(review) -> bool:
    """True if a review's normalized rating is 1 or 2 -- the sole
    eligibility rule for the immediate new-review negative-alert email.
    Deliberately has NO content/meaningfulness filter: a bare 1-2 star
    rating with no written text still qualifies, since this alert's job is
    awareness of a dissatisfied customer, not content curation (that's what
    the nightly digest's is_meaningful_review() is for, on its own,
    separate email)."""
    rating = normalize_rating(review)
    return rating is not None and rating <= 2


def get_new_negative_reviews(new_reviews: list) -> list:
    """Filters an already-deduped 'new reviews this run' list down to only
    the ones eligible for the immediate negative-review notification email.
    Never touches storage -- callers must keep storing every rating
    regardless of what this returns."""
    return [r for r in new_reviews if is_negative_review_for_notification(r)]


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
