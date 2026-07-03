"""
ai_engine.py — Claude API integration for generative intelligence.

All AI content is generated server-side during pipeline runs and stored
in analytics_cache. The static Vercel frontend fetches pre-computed JSON —
no API key is ever exposed to the browser.

Cost estimate at 4 runs/day:
  • 1 company summary  (Sonnet) × 4 = ~$0.004/day
  • 21 location summaries (Haiku)  × 4 = ~$0.006/day
  • Response drafts: incremental, only new unresponded ≤3★ reviews
  Total: well under $1/month
"""
import hashlib
import json
import os

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
# Response drafts
# ---------------------------------------------------------------------------

_SERIOUS_KEYWORDS = [
    "sick", "ill", "vomit", "threw up", "food poison", "diarrhea", "stomach",
    "hospital", "doctor", "health department", "health code",
    "cockroach", "roach", "rat", "mouse", "rodent", "insect", "bug", "pest",
    "injury", "injured", "hurt", "unsafe", "accident",
    "discrimination", "racist", "racism", "harassment", "rude", "hostile", "threatening",
    "lawsuit", "lawyer", "attorney", "sue", "legal",
    "police", "fight", "assault", "stole", "stolen", "theft",
    "never coming back", "health violation", "shut down", "report",
]
_CONTACT_EMAIL = "advertising@l3amigos.com"


def _is_serious(text: str, stars: int) -> bool:
    if stars == 1:
        return True
    lower = (text or "").lower()
    return any(kw in lower for kw in _SERIOUS_KEYWORDS)


def generate_response_draft(review: dict, restaurant_name: str) -> str | None:
    """Generate a professional owner-response draft for a single review."""
    stars    = review.get("star_rating") or 3
    reviewer = (review.get("reviewer_name") or "Guest").split()[0]
    text     = (review.get("review_text") or "").strip()
    serious  = _is_serious(text, stars)

    if stars <= 2:
        tone = "sincere and apologetic. Acknowledge the specific issue without being defensive"
    elif stars == 3:
        tone = "warm and appreciative while acknowledging there is room to improve"
    else:
        tone = "genuinely grateful and brief"

    if stars >= 4:
        length = "1-2 sentences"
    elif stars == 3:
        length = "2-3 sentences"
    elif serious:
        length = "3-4 sentences"
    else:
        length = "2-3 sentences"

    contact = (
        f" At the end, before the sign-off, invite them to reach out: "
        f"'Please contact us at {_CONTACT_EMAIL} so we can make this right.'"
        if serious else ""
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
            f"Do not offer discounts or freebies. No emojis.{contact} "
            f"Sign off with '— The {restaurant_name} Team'.\n\n"
            f"Review: {text[:400]}\n\nWrite the response now:"
        )

    return _call(prompt, model="claude-haiku-4-5-20251001", max_tokens=200)


# ---------------------------------------------------------------------------
# Batch response draft generation
# ---------------------------------------------------------------------------

def batch_generate_drafts(
    reviews: list, location_map: dict, existing_hashes: set, limit: int = 100
) -> dict:
    """
    Generate response drafts for unresponded ≤3★ reviews that don't already
    have a cached draft. Returns {review_id: draft_text}.
    """
    client = _get_client()
    if not client:
        return {}

    candidates = [
        r for r in reviews
        if not (r.get("owner_response") or "").strip()
        and (r.get("star_rating") or 5) <= 3
        and r.get("review_text")
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
