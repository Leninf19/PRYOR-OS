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
#
# Review Response Playbook v2, PART 6: this is the Python-side mirror of
# dashboard/api/_lib/reviewRiskClassifier.js's RISK_CATEGORIES -- same 10
# categories, same keywords, same word-boundary matching -- kept as a
# categorized dict (rather than one flat list) so this batch pipeline can
# reason about WHICH kind of serious concern a review raises, exactly like
# the JS on-demand path, instead of maintaining a second, differently-shaped
# classifier. This is the established cross-language duplication convention
# for this codebase (see reviewRiskClassifier.js's own header comment) --
# there is no single module Python and JS can both import, so the two are
# kept as clearly cross-referenced, kept-in-sync copies rather than a new,
# competing scheme invented for Python alone.
_RISK_CATEGORIES = {
    "food_poisoning": [
        "sick", "ill", "illness", "vomit", "vomiting", "threw up", "food poisoning",
        "diarrhea", "nausea", "nauseous", "stomach ache", "upset stomach", "cramping",
    ],
    "allergic_reaction": [
        "allergic", "allergy", "allergies", "anaphylaxis", "anaphylactic", "epipen",
        "epi-pen", "throat closing", "throat swelling", "swelling", "hives",
        "difficulty breathing", "trouble breathing", "can't breathe", "cant breathe",
        "passed out", "unconscious", "lost consciousness",
    ],
    "injury": [
        "injury", "injured", "cut myself", "burned", "burn", "choke", "choked",
        "choking", "broken tooth", "chipped tooth", "fell", "fall", "accident",
        "bleeding", "stitches", "hospital", "hospitalized", "doctor", "er visit",
        "emergency room",
    ],
    "foreign_object": [
        "glass", "metal", "plastic", "staple", "wire", "bug", "insect", "cockroach",
        "roach", "fly in my", "hair in my food", "foreign object", "band-aid", "bandaid",
    ],
    "unsafe_food": [
        "raw chicken", "undercooked", "undercooked chicken", "spoiled", "rotten",
        "expired", "mold", "moldy", "rancid", "smelled off", "tasted off",
    ],
    "sanitation": [
        "rat", "rats", "mouse", "mice", "rodent", "rodents", "pest", "pests",
        "health department", "health code", "health violation", "dirty kitchen",
        "unsanitary", "filthy", "shut down",
    ],
    "threat_violence": [
        "threatened", "threatening", "assault", "assaulted", "violent", "violence",
        "weapon", "gun", "knife pulled",
    ],
    "discrimination_harassment": [
        "discrimination", "discriminated", "racist", "racism", "harassment",
        "harassed", "hostile", "homophobic", "sexist",
    ],
    "legal_threat": [
        "lawsuit", "lawyer", "attorney", "sue", "sued", "legal action", "police",
        "subpoena", "file a complaint",
    ],
    "fraud_payment": [
        "stole", "stolen", "theft", "fraud", "fraudulent", "overcharged", "scam", "scammed",
    ],
}
_ACTIVE_EMERGENCY_KEYWORDS = [
    "anaphylaxis", "anaphylactic", "difficulty breathing", "trouble breathing",
    "can't breathe", "cant breathe", "passed out", "unconscious", "lost consciousness",
]


def _word_boundary_re(keywords: list[str]) -> re.Pattern:
    return re.compile(r"\b(" + "|".join(re.escape(kw) for kw in keywords) + r")\b", re.IGNORECASE)


_CATEGORY_PATTERNS = {category: _word_boundary_re(keywords) for category, keywords in _RISK_CATEGORIES.items()}
_ACTIVE_EMERGENCY_RE = _word_boundary_re(_ACTIVE_EMERGENCY_KEYWORDS)

# Kept for any external caller expecting a flat list (none currently exist in
# this module) -- derived from _RISK_CATEGORIES rather than maintained twice.
_SERIOUS_KEYWORDS = [kw for keywords in _RISK_CATEGORIES.values() for kw in keywords]
_SERIOUS_RE = _word_boundary_re(_SERIOUS_KEYWORDS)


def classify_review_risk(text: str) -> dict:
    """Python mirror of reviewRiskClassifier.js's classifyReviewRisk().
    Returns {"is_high_risk", "categories", "is_active_emergency"}. Never
    raises; empty/missing text is always low risk."""
    text = text or ""
    if not text.strip():
        return {"is_high_risk": False, "categories": [], "is_active_emergency": False}
    categories = [category for category, pattern in _CATEGORY_PATTERNS.items() if pattern.search(text)]
    return {
        "is_high_risk": bool(categories),
        "categories": categories,
        "is_active_emergency": bool(_ACTIVE_EMERGENCY_RE.search(text)),
    }


# Python mirror of reviewRiskClassifier.js's CATEGORY_GUIDANCE -- see that
# file's own header comment for the full PART 11-19 rationale (neutral
# chronology for food-poisoning language, no unverified health-department/
# inspection claims, protect-both-parties framing for staff/discrimination
# allegations, etc.). Kept equivalent in intent so a manager regenerating a
# batch-drafted response on-demand never sees the tone shift.
_CATEGORY_GUIDANCE = {
    "food_poisoning": "This review alleges the guest became ill after eating here. Use neutral chronology only -- say things like 'you became ill after your visit,' never 'our food made you sick' or 'we caused your illness.' You may calmly state standards, e.g. 'our restaurant follows established food-safety procedures and applicable health requirements,' but do not claim a perfect health inspection record, a specific inspection score, or 'this has never happened before' unless explicitly verified for this location. Do not diagnose the illness or admit fault.",
    "allergic_reaction": "This review describes a possible allergic reaction. Express genuine concern without diagnosing, admitting causation, or asking for medical details publicly. Do not admit fault.",
    "injury": "This review describes a physical injury. Express genuine concern for the guest's wellbeing and do not admit fault or dispute their account.",
    "foreign_object": "This review alleges a foreign object was found in food. Acknowledge the seriousness without stating as fact that contamination occurred, and never say anything like 'that could not have come from our kitchen.'",
    "unsafe_food": "This review alleges undercooked, raw, or spoiled food -- treat it as high-risk food safety. Do not confirm the item was actually undercooked/raw unless established, and do not call the guest dishonest.",
    "sanitation": "This review raises a sanitation or pest concern. You may state that the restaurant maintains its own cleanliness standards while still acknowledging the complaint -- do not claim the review is false because 'we're always clean.' Avoid saying 'we follow all Health Department regulations' -- prefer 'established food-safety procedures and applicable health requirements.'",
    "threat_violence": "This review describes a threat or confrontation. Keep the response neutral, serious, and non-inflammatory. Do not escalate or make accusations back.",
    "discrimination_harassment": "This review alleges discrimination or harassment. Keep the response calm and neutral. Do not make legal conclusions, admit it occurred, automatically deny it, or attack the reviewer.",
    "legal_threat": "This review references legal action or police involvement. Keep the response neutral. Do not make any legal conclusions or admissions.",
    "fraud_payment": "This review alleges theft or a billing problem. Do not discuss payment details publicly, and do not admit an incorrect charge before it has been verified.",
}

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


# Review Response Playbook v2, PART 6/7-10/17/18: Python-side mirror of
# dashboard/api/_lib/complaintCategoryGuide.js's normal-severity, non-
# high-risk complaint categories -- deliberately separate from
# _RISK_CATEGORIES above (which gates the serious_escalation type and must
# not be touched by this feature). Same word-boundary literal-phrase
# convention as _RISK_CATEGORIES.
_COMPLAINT_CATEGORIES = {
    "slow_service": [
        "slow service", "took forever", "waited forever", "waited an hour", "waited over an hour",
        "long wait", "nobody came", "no one came", "ignored us", "took so long", "took too long",
    ],
    "rude_staff": [
        "rude", "rude staff", "rude server", "rude waiter", "rude waitress", "attitude",
        "dismissive", "unfriendly", "condescending", "yelled at", "snapped at", "disrespectful",
    ],
    "wrong_order": [
        "wrong order", "wrong dish", "wrong item", "brought the wrong order", "not what I ordered",
        "mixed up our order",
    ],
    "missing_items": [
        "missing item", "forgot my", "forgot the", "didn't include", "left out of my order",
        "was missing from", "never got my",
    ],
    "cold_food": ["cold food", "food was cold", "came out cold", "lukewarm", "arrived cold"],
    "poor_food_quality": ["poor quality", "low quality", "not fresh", "tasted stale", "stale", "bad quality"],
    "bland_food": ["bland", "flavorless", "no flavor", "tasteless", "under-seasoned", "needed more seasoning"],
    "overcooked_food": ["overcooked", "over cooked", "dried out", "burnt", "burned", "too dry"],
    "small_portions": ["small portion", "tiny portion", "portion size", "not enough food", "skimpy"],
    "high_prices_or_value": [
        "overpriced", "too expensive", "not worth the price", "not worth it", "pricey for",
        "expensive for what", "wasn't worth",
    ],
    "long_takeout_wait": [
        "takeout took forever", "pickup took forever", "took forever for pickup",
        "order wasn't ready", "pickup wasn't ready",
    ],
    "reservation_or_seating_issue": [
        "reservation", "reserved a table", "seated us", "wouldn't seat us", "lost our reservation",
        "no table ready", "made us wait for a table",
    ],
    "cleanliness": [
        "dirty table", "sticky table", "dirty floor", "dirty bathroom", "dirty restroom",
        "not clean", "looked dirty", "grimy", "sticky floor",
    ],
    "billing_or_double_charge": [
        "double charged", "charged twice", "overcharged", "wrong total", "billing error",
        "charged the wrong", "bill was wrong", "incorrect charge",
    ],
    "delivery_problem": [
        "delivery was late", "late delivery", "delivery driver", "arrived cold via delivery",
        "never arrived", "delivery order", "doordash", "uber eats", "grubhub",
    ],
    "disputed_review": [
        "never went there", "never even went there", "never ate there", "wrong location",
        "not even the right restaurant", "this isn't us", "must be thinking of", "never been here",
    ],
}
_COMPLAINT_PATTERNS = {category: _word_boundary_re(keywords) for category, keywords in _COMPLAINT_CATEGORIES.items()}

_COMPLAINT_CATEGORY_GUIDANCE = {
    "slow_service": "The complaint is about slow service or a long wait. Acknowledge the wait specifically without over-apologizing, arguing, or promising a refund or compensation.",
    "rude_staff": "The complaint is about a staff member's behavior. Protect both the guest and the employee until the facts are known -- do not write that the employee \"would never do that,\" but also do not automatically agree the staff member's behavior was unacceptable or accuse them by name.",
    "wrong_order": "The complaint is about receiving the wrong order or dish. Acknowledge the mistake plainly without blaming a specific employee or the guest.",
    "missing_items": "The complaint is about missing item(s) from an order. Acknowledge it plainly without blaming a specific employee or promising a refund.",
    "cold_food": "The complaint is about food arriving cold. Acknowledge the specific issue without debating it or claiming it doesn't usually happen.",
    "poor_food_quality": "The complaint is about food quality. Acknowledge without debating personal taste or claiming \"most guests love this dish\" -- that reads as argumentative.",
    "bland_food": "The complaint is that the food was bland or under-seasoned. Acknowledge without debating personal taste.",
    "overcooked_food": "The complaint is that the food was overcooked or dried out. Acknowledge the specific issue without debating it.",
    "small_portions": "The complaint is about portion size. Acknowledge briefly without debating it or explaining ingredient costs.",
    "high_prices_or_value": "The complaint is about price or value. Do not argue about pricing, justify the price, or explain ingredient/food costs -- acknowledge briefly and keep it concise.",
    "long_takeout_wait": "The complaint is about a long takeout or pickup wait. Acknowledge the specific issue without over-apologizing or promising compensation.",
    "reservation_or_seating_issue": "The complaint is about a reservation or seating issue. Acknowledge it plainly without blaming a specific host or the guest.",
    "cleanliness": "The complaint is about cleanliness. You may note that the restaurant maintains cleanliness standards while still acknowledging the guest's experience and willingness to look into it -- do not claim the restaurant is \"always clean\" in a way that dismisses the complaint as false.",
    "billing_or_double_charge": "The complaint is about a billing or charge issue. Do not discuss specific card or payment details publicly, and do not admit an incorrect charge before it has been verified -- invite the guest to reach out so the charge can be looked into.",
    "delivery_problem": "The complaint is about a delivery issue. Acknowledge the specific problem without blaming the delivery driver, platform, or the guest, and without promising a refund.",
    "disputed_review": "This review may not match the restaurant's own records. Do not call the reviewer a liar, dishonest, or fraudulent -- acknowledge the discrepancy calmly and invite them to reach out with visit details.",
}


def classify_complaint_categories(text: str) -> list[str]:
    """Python mirror of complaintCategoryGuide.js's classifyComplaintCategories()."""
    text = text or ""
    if not text.strip():
        return []
    return [category for category, pattern in _COMPLAINT_PATTERNS.items() if pattern.search(text)]


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
    return cleaned if cleaned else draft_text.strip()  # never return empty; fall back to the whole draft


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
        "positive_with_feedback": "1-3 sentences",
        "mixed":                  "1-3 sentences",
        "negative":               "1-3 sentences",
        "serious_escalation":     "2-4 sentences",
    }
    length = length_by_type[response_type]

    contact = (
        f" At the end, invite them to reach out: "
        f"'Please contact us at {_CONTACT_EMAIL} so we can make this right.'"
        if serious else ""
    )
    no_recovery_note = (
        "" if serious else
        " Do not include any contact email, phone number, or 'contact us' invitation -- "
        "that language is reserved for serious unresolved incidents only, which this is not."
    )

    # Review Response Playbook v2, PART 1/PART 2: no automatic signature of
    # any kind -- see responseStyleProfile.js's signatureEnabled field for
    # the JS-side equivalent switch (default off). ai_engine.py has no
    # per-tenant style-profile system of its own, so this is hardcoded off
    # for now, matching PART 1's explicit instruction ("For now: NO
    # AUTOMATIC SIGNATURE").
    no_signoff_note = (
        " Do not add a signature, name, or sign-off of any kind. Do not end with a dash and a "
        "name, '— Restaurant Team', 'Sincerely,', 'Best,', 'Regards,', or 'Warmly,' -- these are "
        "Google review replies, not letters. Simply end the response after its final sentence."
    )

    # PART 26: for a serious escalation, layer in the same category-specific
    # guidance the JS on-demand path uses (reviewRiskClassifier.js's
    # CATEGORY_GUIDANCE) -- acknowledge, express concern, state standards
    # when useful, never admit unverified causation, never attack the
    # reviewer, invite follow-up. For an ordinary negative/mixed review,
    # layer in the matching complaint-category guidance instead (PARTS 7-10,
    # 17-18) when a specific operational category was detected.
    category_guidance = ""
    if serious:
        risk = classify_review_risk(text)
        notes = [_CATEGORY_GUIDANCE[c] for c in risk["categories"] if c in _CATEGORY_GUIDANCE]
        if risk["is_active_emergency"]:
            notes.append(
                "The review describes what sounds like an ACTIVE or severe medical reaction -- include "
                "this exact guidance once: \"If you're currently experiencing difficulty breathing or "
                "another severe reaction, please seek emergency medical care immediately.\""
            )
        if notes:
            category_guidance = " " + " ".join(notes)
    elif response_type in ("negative", "mixed"):
        notes = [_COMPLAINT_CATEGORY_GUIDANCE[c] for c in classify_complaint_categories(text) if c in _COMPLAINT_CATEGORY_GUIDANCE]
        if notes:
            category_guidance = " " + " ".join(notes)

    if not text:
        prompt = (
            f"Write a {length} response from the owner of {restaurant_name} to a {stars}-star "
            f"Google review with no text from {reviewer}. Tone: {tone}. "
            f"Do not mention any other restaurant or chain. No emojis."
            f"{no_signoff_note}"
        )
    else:
        prompt = (
            f"You are the manager of {restaurant_name}, a Mexican restaurant.\n\n"
            f"Write a professional, genuine {length} response to this {stars}-star Google review, "
            f"warm and conversational, never robotic, corporate, or obviously AI-generated. "
            f"Vary how you open the response based on what this guest actually said -- never default to "
            f"'Thank you for your review' or begin every response with 'Thank you for...'. "
            f"Tone: {tone}. You may use {reviewer}'s first name occasionally if it feels natural, but do "
            f"not force it into every response and never use a letter-style salutation like 'Dear {reviewer},'. "
            f"Respond only on behalf of {restaurant_name} — do not reference or name any other restaurant, brand, or chain. "
            f"Do not unnecessarily repeat '{restaurant_name}' in the reply itself. "
            f"Do not offer discounts or freebies. No emojis.{contact}{no_recovery_note}{category_guidance}"
            f"{no_signoff_note}\n\n"
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

    prompt = f"""You are Pryor OS, an AI business intelligence consultant for Los Tres Amigos, a {data.get('location_count', 21)}-location Mexican restaurant group.

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
