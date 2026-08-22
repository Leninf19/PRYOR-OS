"""
ai_engine.py — Claude API integration for generative intelligence.

All AI content is generated server-side during pipeline runs and stored
in analytics_cache. The static Vercel frontend fetches pre-computed JSON —
no API key is ever exposed to the browser.

Cost estimate at 4 runs/day:
  • 1 company summary  (Sonnet) × 4 = ~$0.004/day
  • 21 location summaries (Haiku)  × 4 = ~$0.006/day
  • Response drafts: incremental only -- capped at `limit` (default 100)
    NEW drafts per run, cached by content hash so an unchanged review is
    never regenerated (Recovery Milestone 4 widened this from ≤3★-only to
    every unresponded review, since the actionable inbox needs a prepared
    draft for positive reviews too, not just negative ones -- still bounded,
    still newest-first, still one call per scheduled sync, never per page
    load). Haiku, ~200 tokens/draft: even a full 100-draft run is a few cents.
  Total: well under $1/month in steady state.
"""
import hashlib
import json
import os
import re

_client = None


def _get_client():
    global _client
    if _client is not None:
        return _client
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        return None
    try:
        import anthropic
        _client = anthropic.Anthropic(api_key=key)
    except ImportError:
        print("[ai] anthropic package not installed — AI features disabled")
    return _client


def _call(prompt: str, model: str = "claude-haiku-4-5-20251001", max_tokens: int = 400) -> str | None:
    client = _get_client()
    if not client:
        return None
    try:
        import anthropic
        msg = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}],
        )
        return msg.content[0].text.strip()
    except Exception as e:
        print(f"[ai] Claude call failed: {e}")
        return None


def _data_hash(data: dict) -> str:
    return hashlib.md5(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Company executive summary
# ---------------------------------------------------------------------------

def generate_company_summary(data: dict) -> dict | None:
    """
    data keys: period_reviews, avg_rating, rating_delta, positive_pct, negative_pct,
               unanswered_count, best_location, best_rating, worst_location, worst_rating,
               top_complaint, top_praise, locations_above_4, locations_below_4
    Returns {"text": str, "hash": str} or None if AI unavailable.
    """
    h = _data_hash(data)
    prompt = f"""You are an analytics assistant for Los Tres Amigos, a Mexican restaurant group with {data.get('total_locations', 21)} locations.

Write a 4-5 sentence executive intelligence summary based on these metrics. Write in present tense. Be specific and use the actual numbers. Do not use bullet points, headers, or markdown. Plain paragraphs only. Focus on what management should know and act on today.

Metrics (last 30 days):
- Reviews received: {data['period_reviews']}
- Average rating: {data['avg_rating']:.2f}★ ({data['rating_delta']:+.2f} vs prior 30 days)
- Guest sentiment: {data['positive_pct']:.0f}% positive, {data['negative_pct']:.0f}% negative
- Reviews awaiting owner response: {data['unanswered_count']}
- Top-performing location: {data['best_location']} ({data['best_rating']:.1f}★)
- Location needing attention: {data['worst_location']} ({data['worst_rating']:.1f}★)
- Most common complaint theme: {data['top_complaint']}
- Most common praise theme: {data['top_praise']}
- Locations rated 4★+: {data.get('locations_above_4', 'N/A')}

Write the executive summary now:"""

    text = _call(prompt, model="claude-sonnet-4-6", max_tokens=350)
    if text is None:
        return None
    return {"text": text, "hash": h, "generatedAt": _now_iso()}


# ---------------------------------------------------------------------------
# Location intelligence summary
# ---------------------------------------------------------------------------

def generate_location_summary(data: dict) -> dict | None:
    """
    data keys: location_name, period_reviews, avg_rating, rating_delta,
               positive_pct, top_complaint, top_praise, praised_staff,
               unanswered_negative, prediction_30d
    """
    h = _data_hash(data)
    praised = ", ".join(data.get("praised_staff", [])[:3]) or "none identified"
    pred = data.get("prediction_30d")
    pred_str = f"Projected 30-day rating: {pred:.2f}★" if pred else "Insufficient data for projection"

    prompt = f"""You are an analytics assistant for Los Tres Amigos restaurant group.

Write a 3-sentence operational summary for the {data['location_name']} location. Be specific. Plain text only — no bullets, no headers.

Location metrics (last 30 days):
- Reviews: {data['period_reviews']}
- Average rating: {data['avg_rating']:.2f}★ ({data.get('rating_delta', 0):+.2f} vs prior period)
- Guest sentiment: {data['positive_pct']:.0f}% positive
- Top complaint: {data['top_complaint'] or 'none identified'}
- Top praise: {data['top_praise'] or 'none identified'}
- Staff praised by name: {praised}
- Unanswered negative reviews: {data['unanswered_negative']}
- {pred_str}

Write the location summary now:"""

    text = _call(prompt, model="claude-haiku-4-5-20251001", max_tokens=200)
    if text is None:
        return None
    return {"text": text, "hash": h, "generatedAt": _now_iso()}


# ---------------------------------------------------------------------------
# Per-review sentiment + priority classification
# ---------------------------------------------------------------------------
# Star ratings alone are a poor sentiment signal (a 5-star review can describe
# real problems; a 3-star review can be substantively positive). This reads
# the actual review text and returns an independent sentiment judgment plus
# an operational priority, batched to keep cost/latency low.

_CLASSIFY_BATCH_SIZE = 20

_CLASSIFY_PROMPT_HEADER = """You are a sentiment and priority classification engine for a restaurant review platform. Judge each review by its actual written content, not by its star rating -- a 5-star review can be neutral or negative if the text describes real problems (e.g. slow service, a rude employee), and a 3-star review can be positive if the text is largely complimentary.

For each review, return:
- "sentiment": "positive", "neutral", or "negative" -- based on what the customer actually described.
- "reason": one short sentence (under 15 words) grounded in specifics from the review text.
- "priority": "critical", "high", "medium", or "low":
  - critical: food poisoning/illness, injury, discrimination, harassment, health-code or safety violations, legal threats
  - high: repeated or serious complaints, a very angry customer, an explicit request for a manager to follow up
  - medium: an ordinary complaint or mixed feedback that deserves a reply
  - low: a simple compliment or a review needing no operational action

Reviews (numbered, do not skip any, respond in the same order):
"""

_CLASSIFY_FOOTER = """
Return ONLY a JSON array of {n} objects, no markdown, no explanation, one object per review in order:
[{{"sentiment":"...","reason":"...","priority":"..."}}, ...]"""


def classify_reviews_batch(reviews: list) -> dict:
    """
    reviews: list of {"id": <review row id>, "review_text": str, "star_rating": int|None}
    Returns {review_id: {"sentiment", "reason", "priority"}} for every review
    the model successfully classified (missing/malformed entries are simply
    omitted so the caller can retry or fall back to star-based sentiment).
    """
    client = _get_client()
    if not client or not reviews:
        return {}

    results = {}
    for i in range(0, len(reviews), _CLASSIFY_BATCH_SIZE):
        batch = reviews[i:i + _CLASSIFY_BATCH_SIZE]
        lines = [
            f"{j+1}. [{'★' * (r.get('star_rating') or 0)}] {(r.get('review_text') or '')[:500]}"
            for j, r in enumerate(batch)
        ]
        prompt = _CLASSIFY_PROMPT_HEADER + "\n".join(lines) + _CLASSIFY_FOOTER.format(n=len(batch))

        text = _call(prompt, model="claude-haiku-4-5-20251001", max_tokens=200 + 60 * len(batch))
        if text is None:
            continue

        text = text.strip()
        if text.startswith("```"):
            lines_ = text.split("\n")
            text = "\n".join(lines_[1:-1] if lines_[-1].strip() == "```" else lines_[1:])

        try:
            parsed = json.loads(text.strip())
        except json.JSONDecodeError:
            print(f"[ai] classify_reviews_batch: bad JSON for batch at offset {i}, skipping")
            continue

        if not isinstance(parsed, list) or len(parsed) != len(batch):
            print(f"[ai] classify_reviews_batch: expected {len(batch)} results, got "
                  f"{len(parsed) if isinstance(parsed, list) else type(parsed)} -- skipping batch")
            continue

        for r, item in zip(batch, parsed):
            sentiment = item.get("sentiment")
            priority = item.get("priority")
            if sentiment not in ("positive", "neutral", "negative"):
                continue
            if priority not in ("critical", "high", "medium", "low"):
                priority = "low"
            results[r["id"]] = {
                "sentiment": sentiment,
                "reason": (item.get("reason") or "").strip()[:200],
                "priority": priority,
            }

    return results


# ---------------------------------------------------------------------------
# Response drafts
# ---------------------------------------------------------------------------

_CONTACT_EMAIL = "advertising@l3amigos.com"

# Recovery Milestone 4 (Review Reply Inbox + AI Response Quality): the
# previous list matched as a naive substring (`kw in lower`), which fires on
# innocent words containing a keyword -- 'sue' matches inside "no ISSUEs at
# all", 'ill' matches inside "the tacos were griILLed perfectly". Every entry
# is now matched with \b...\b word boundaries via _SERIOUS_RE below, so a
# keyword only fires when it appears as its own word.
_SERIOUS_KEYWORDS = [
    "sick", "ill", "vomit", "vomiting", "food poisoning", "diarrhea",
    "hospital", "hospitalized", "doctor", "health department", "health code",
    "cockroach", "roach", "rat", "rats", "mouse", "mice", "rodent", "rodents",
    "insect", "insects", "pest", "pests",
    "injury", "injured", "unsafe", "accident",
    "discrimination", "discriminated", "racist", "racism", "harassment", "harassed",
    "hostile", "threatening", "threatened",
    "lawsuit", "lawyer", "attorney", "sue", "sued", "legal action",
    "police", "assault", "assaulted", "stole", "stolen", "theft",
    "never coming back", "health violation", "shut down",
]
_SERIOUS_RE = re.compile(
    r"\b(" + "|".join(re.escape(kw) for kw in _SERIOUS_KEYWORDS) + r")\b", re.IGNORECASE
)

# Phase 3 hard safety guard: language a NON-serious (positive/positive-with-
# feedback/mixed/ordinary-negative) response must never contain. Matched
# against the FINAL draft text regardless of which code path produced it
# (generate_response_draft's own prompt, or a rewrite) -- a deterministic
# backstop, not dependent on the classifier or the LLM having gotten it
# right. Sentence-level: enforce_response_policy() below removes only the
# offending sentence(s), not the whole response.
_FORBIDDEN_RECOVERY_PATTERNS = [
    re.compile(r"contact us[^.!?]*so we can make this right", re.IGNORECASE),
    re.compile(r"make this right", re.IGNORECASE),
    re.compile(r"please contact us", re.IGNORECASE),
    re.compile(r"reach out to us", re.IGNORECASE),
    re.compile(r"reach out directly", re.IGNORECASE),
    re.compile(r"contact us at", re.IGNORECASE),
    re.compile(re.escape(_CONTACT_EMAIL), re.IGNORECASE),
    re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"),  # any email address
    re.compile(r"\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b"),  # any US-style phone number
    re.compile(r"sincerely apologi[sz]e", re.IGNORECASE),
    re.compile(r"deeply apologi[sz]e", re.IGNORECASE),
    re.compile(r"give us another chance", re.IGNORECASE),
]

RESPONSE_TYPES = ("positive", "positive_with_feedback", "mixed", "negative", "serious_escalation")

# Words/phrases that reframe an otherwise-alarming word as explicitly minor,
# resolved, or not a real complaint -- used only to keep the FEEDBACK
# detector (constructive-feedback-within-a-positive-review) from over-firing;
# never used to suppress a serious-escalation match, which is deliberately
# unconditional (a 5-star review can still describe a serious incident).
_CONSTRUCTIVE_FEEDBACK_RE = re.compile(
    r"\b(but|however|only (complaint|issue|thing|downside)|one thing|"
    r"could (be|improve|use)|would be nice|wish (it|they|there)|"
    r"(?:not|n't|wasn't|weren't|isn't|doesn't|didn't)\s+(listed|obvious|clear|mentioned)|"
    r"minor|small (adjustments?|things?|notes?)|"
    r"a bit|slightly|room to improve|small (nitpick|critique))\b",
    re.IGNORECASE,
)


def _is_serious_escalation(text: str, stars: int) -> bool:
    """Deliberately NOT gated on star rating -- a 5-star review can still
    describe a serious unresolved incident (sarcasm, a mixed household, a
    delayed realization). star_rating == 1 alone is not sufficient either
    (plenty of 1-star reviews are just "slow service", not a serious
    incident) -- only an explicit keyword hit, precisely word-bounded,
    triggers this."""
    return bool(_SERIOUS_RE.search(text or ""))


def classify_response_type(review: dict) -> str:
    """positive | positive_with_feedback | mixed | negative | serious_escalation

    Built on the review's EXISTING signals (star_rating, and ai_sentiment/
    ai_priority when already computed by classify_reviews_batch -- no new
    scoring framework invented) plus one precise, word-bounded keyword check
    for the one case those signals can't reliably carry: a genuinely serious
    incident (food safety, injury, discrimination, threats, legal/police
    involvement)."""
    stars = review.get("star_rating") or 3
    text = review.get("review_text") or ""
    sentiment = review.get("ai_sentiment")
    priority = review.get("ai_priority")

    if _is_serious_escalation(text, stars):
        return "serious_escalation"

    if stars <= 2:
        return "negative"
    if stars == 3:
        return "mixed"

    # stars >= 4: a negative AI sentiment or high/critical priority on a
    # high-star review is a real signal something is off despite the rating
    # (e.g. a begrudging 4-star) -- treat as mixed, not a plain thank-you.
    if sentiment == "negative" or priority in ("critical", "high"):
        return "mixed"
    if _CONSTRUCTIVE_FEEDBACK_RE.search(text):
        return "positive_with_feedback"
    return "positive"


def enforce_response_policy(draft_text: str, response_type: str) -> str:
    """The Phase 3 hard safety guard: deterministic, independent of the LLM.
    For any response_type other than 'serious_escalation', strips any
    sentence containing forbidden recovery/escalation language (a contact
    CTA, an email address, a phone number, excessive apology) rather than
    trusting the model not to have generated it. serious_escalation
    responses are returned unmodified -- that's the one class allowed to
    contain a contact CTA, and Reviews.jsx additionally gates those behind
    a "Needs Management Review" human-review step rather than auto-allowing
    one-click publish."""
    if response_type == "serious_escalation" or not draft_text:
        return draft_text

    # Split on sentence boundaries, keeping the punctuation with each sentence.
    sentences = re.split(r"(?<=[.!?])\s+", draft_text.strip())
    kept = [
        s for s in sentences
        if not any(p.search(s) for p in _FORBIDDEN_RECOVERY_PATTERNS)
    ]
    cleaned = " ".join(kept).strip()
    return cleaned if cleaned else draft_text.split("—")[0].strip()  # never return empty; fall back to the pre-sign-off text


def generate_response_draft(review: dict, restaurant_name: str) -> str | None:
    """Generate a professional owner-response draft for a single review."""
    stars    = review.get("star_rating") or 3
    reviewer = (review.get("reviewer_name") or "Guest").split()[0]
    text     = (review.get("review_text") or "").strip()
    response_type = classify_response_type(review)
    serious  = response_type == "serious_escalation"

    tone_by_type = {
        "positive":              "genuinely grateful and brief",
        "positive_with_feedback": "warm and appreciative, briefly acknowledging the feedback without dwelling on it",
        "mixed":                 "balanced -- genuinely acknowledge both what went well and what didn't",
        "negative":              "sincere and apologetic. Acknowledge the specific issue without being defensive",
        "serious_escalation":    "sincere, calm, and taking the concern seriously without being defensive",
    }
    tone = tone_by_type[response_type]

    length_by_type = {
        "positive":               "1-2 sentences",
        "positive_with_feedback": "2-3 sentences",
        "mixed":                  "2-3 sentences",
        "negative":               "2-3 sentences",
        "serious_escalation":     "3-4 sentences",
    }
    length = length_by_type[response_type]

    contact = (
        f" At the end, before the sign-off, invite them to reach out: "
        f"'Please contact us at {_CONTACT_EMAIL} so we can make this right.'"
        if serious else ""
    )
    no_recovery_note = (
        "" if serious else
        " Do not include any contact email, phone number, or 'contact us' invitation -- "
        "that language is reserved for serious unresolved incidents only, which this is not."
    )

    if not text:
        prompt = (
            f"Write a {length} response from the owner of {restaurant_name} to a {stars}-star "
            f"Google review with no text from {reviewer}. Tone: {tone}. "
            f"Do not mention any other restaurant or chain. No emojis. "
            f"Sign off with '— The {restaurant_name} Team'."
        )
    else:
        prompt = (
            f"You are the manager of {restaurant_name}, a Mexican restaurant.\n\n"
            f"Write a professional, genuine {length} response to this {stars}-star Google review. "
            f"Tone: {tone}. Address {reviewer} by first name. "
            f"Respond only on behalf of {restaurant_name} — do not reference or name any other restaurant, brand, or chain. "
            f"Do not offer discounts or freebies. No emojis.{contact}{no_recovery_note} "
            f"Sign off with '— The {restaurant_name} Team'.\n\n"
            f"Review: {text[:400]}\n\nWrite the response now:"
        )

    draft = _call(prompt, model="claude-haiku-4-5-20251001", max_tokens=200)
    if draft is None:
        return None
    return enforce_response_policy(draft, response_type)


# ---------------------------------------------------------------------------
# Batch response draft generation
# ---------------------------------------------------------------------------

def batch_generate_drafts(
    reviews: list, location_map: dict, existing_hashes: set, limit: int = 100
) -> dict:
    """
    Generate response drafts for every unresponded review that doesn't
    already have a cached draft -- ALL star ratings (Recovery Milestone 4:
    the Reviews inbox's "response already prepared" experience covers the
    whole actionable/Needs-Reply queue, not just low-star reviews, so a
    4-5★ review needs a pre-generated draft too, not just an on-demand
    /api/rewrite call). Returns {cache_key: draft_record}.

    Bounded and cached exactly as before this change -- only the star-
    rating filter widened, nothing about the cost-control shape did:
    newest-first, capped to `limit` NEW generations per call (existing_hashes
    already accounts for review_text+star_rating, so an edited/re-scraped
    review gets a fresh draft while an unchanged one is never regenerated),
    called once per refresh_analytics.py run (one call per scheduled sync),
    never per page load.
    """
    client = _get_client()
    if not client:
        return {}

    candidates = [
        r for r in reviews
        if not (r.get("owner_response") or "").strip()
    ]
    # Newest first, cap to limit
    candidates.sort(key=lambda r: r.get("review_date") or "", reverse=True)
    candidates = candidates[:limit]

    results = {}
    for r in candidates:
        rid = r.get("review_id") or r.get("review_url") or ""
        if not rid:
            continue
        h = _data_hash({"text": r.get("review_text", ""), "stars": r.get("star_rating")})
        cache_key = f"draft_{rid[:40]}_{h}"
        if cache_key in existing_hashes:
            continue
        loc = location_map.get(r.get("location_id"), {})
        restaurant_name = loc.get("name") or r.get("location_name") or "this location"
        draft = generate_response_draft(r, restaurant_name)
        if draft:
            results[cache_key] = {
                "review_id": rid,
                "location_id": r.get("location_id"),
                "star_rating": r.get("star_rating"),
                "reviewer_name": r.get("reviewer_name"),
                "review_text": r.get("review_text", "")[:300],
                "draft": draft,
                "generatedAt": _now_iso(),
            }

    return results


# ---------------------------------------------------------------------------
# Competitive intelligence weekly briefing
# ---------------------------------------------------------------------------

def generate_competitive_briefing(data: dict) -> dict | None:
    """
    data keys: period, location_count, metrics (dict of metric objects),
               best_performer, worst_performer, most_improved,
               top_complaint, top_praise
    Returns parsed JSON dict or None if AI unavailable.
    """
    h = _data_hash(data)
    metrics = data.get("metrics", {})

    def mc(key):
        v = metrics.get(key, {})
        val = v.get("value", "N/A")
        chg = v.get("change", "")
        return f"{val} ({chg})" if chg else str(val)

    prompt = f"""You are Future Insights, an AI business intelligence consultant for Los Tres Amigos, a {data.get('location_count', 21)}-location Mexican restaurant group.

Period analyzed: {data.get('period', 'last 30 days')}

Performance summary:
- Average rating: {mc('avgRating')}★ vs prior period
- Reviews received: {mc('reviewCount')}
- 5-star reviews: {mc('fiveStarCount')}
- Positive guest sentiment: {mc('positiveRate')}%
- Review response rate: {mc('responseRate')}%
- Highest rated location: {data.get('best_performer', 'N/A')}
- Location needing attention: {data.get('worst_performer', 'N/A')}
- Most improved location: {data.get('most_improved', 'N/A')}
- Top complaint theme: {data.get('top_complaint', 'service speed')}
- Top praise theme: {data.get('top_praise', 'food quality')}

Return ONLY a JSON object — no markdown, no explanation, no code fences:
{{"executiveSummary":"3-4 sentence consultant-style briefing using actual numbers, present tense, no bullets","biggestWin":"One sentence — biggest positive development this period","biggestThreat":"One sentence — most significant concern requiring attention","mostImproved":"One sentence — strongest positive momentum area","largestDecline":"One sentence — biggest decline or what to monitor if nothing declined","marketingOpportunity":"One actionable sentence — specific marketing opportunity based on the data","operationalPriority":"One sentence — single highest-priority operational improvement","projectedTrend":"One sentence — where the business is headed in the next 30 days","recommendation":"2-3 sentence executive action recommendation, specific, professional, and actionable"}}"""

    text = _call(prompt, model="claude-sonnet-4-6", max_tokens=900)
    if text is None:
        return None

    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    try:
        parsed = json.loads(text.strip())
    except json.JSONDecodeError:
        parsed = {"executiveSummary": text}

    parsed.update({"hash": h, "generatedAt": _now_iso()})
    return parsed


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def is_available() -> bool:
    return _get_client() is not None
