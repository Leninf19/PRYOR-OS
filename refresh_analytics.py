"""
refresh_analytics.py — Analytics, Complaint Intelligence & AI Summaries.

Pipeline step 3: reads reviews.db, computes all intelligence (complaint
categories, employee mentions, sentiment trends, predictions, AI summaries)
and writes results to analytics_cache so export_chunks.py can ship
precomputed JSON to the static frontend.
"""
import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

import db
import ai_engine
import tenant_keys
import tenant_paths

# ---------------------------------------------------------------------------
# Complaint / praise classification — 15 operational categories each
# ---------------------------------------------------------------------------

# Each entry: (category_id, display_name, keywords/phrases, severity 1-3)
COMPLAINT_CATEGORIES = [
    ("wait_time",       "Long Wait Times",        3, [
        "long wait", "waited", "waiting too long", "took forever", "took too long",
        "45 minutes", "hour wait", "30 minute wait", "20 minute wait", "wait time",
        "waited over", "slow to seat", "seating wait", "took ages", "still waiting",
    ]),
    ("slow_service",    "Slow Service",           2, [
        "slow service", "slow waiter", "slow waitress", "slow server",
        "forgot our order", "forgot my order", "never came back",
        "had to ask", "waited for drinks", "waited for refill",
        "slow to bring", "slow to take", "long time for",
    ]),
    ("poor_service",    "Poor Customer Service",  3, [
        "rude", "unfriendly", "disrespectful", "dismissive", "condescending",
        "bad attitude", "poor attitude", "attitude problem", "unprofessional",
        "ignored us", "ignored me", "ignored our", "not attentive", "inattentive",
        "poor customer service", "terrible service", "horrible service",
        "worst service", "bad service",
    ]),
    ("cold_food",       "Cold Food",              2, [
        "cold food", "food was cold", "food is cold", "came out cold",
        "arrived cold", "lukewarm", "not hot", "not warm enough", "stone cold",
        "cold when", "cold plate", "cold dishes",
    ]),
    ("wrong_order",     "Order Errors",           2, [
        "wrong order", "wrong dish", "wrong item", "wrong food",
        "not what i ordered", "not what we ordered", "missing item",
        "missing order", "didn't get", "never received", "order was wrong",
        "messed up our order", "messed up my order", "incorrect order",
    ]),
    ("food_quality",    "Food Quality",           3, [
        "bland", "tasteless", "no flavor", "no taste", "flavorless",
        "overcooked", "undercooked", "not fresh", "stale", "mushy",
        "soggy", "greasy", "too salty", "too spicy for", "disgusting food",
        "terrible food", "horrible food", "worst food", "bad food",
        "dry", "rubbery", "tough meat", "chewy", "burnt",
    ]),
    ("cleanliness",     "Cleanliness",            3, [
        "dirty", "unclean", "filthy", "grimy", "gross", "disgusting",
        "sticky table", "dirty table", "sticky floor", "dirty floor",
        "dirty dishes", "trash", "dusty", "needed cleaning", "not clean",
        "dirty restaurant",
    ]),
    ("restrooms",       "Restroom Issues",        2, [
        "dirty bathroom", "filthy bathroom", "disgusting bathroom",
        "dirty restroom", "filthy restroom", "bathroom was gross",
        "restroom was", "bathroom needs", "out of paper",
        "bathroom smelled", "toilet was",
    ]),
    ("pricing",         "Pricing & Value",        2, [
        "overpriced", "too expensive", "not worth the price", "not worth the money",
        "small portions for the price", "charge too much", "way too much",
        "price has gone up", "prices went up", "used to be cheaper",
        "not worth it", "poor value", "not a good value",
    ]),
    ("noise",           "Noise & Environment",    1, [
        "too loud", "very loud", "extremely loud", "loud music",
        "could not hear", "couldn't hear", "hard to hear",
        "music too loud", "noisy", "so loud", "deafening",
    ]),
    ("management",      "Management Issues",      3, [
        "poorly managed", "poor management", "bad management",
        "manager was rude", "manager had attitude", "manager didn't help",
        "need better management", "disorganized", "chaotic",
        "no manager", "manager was unhelpful",
    ]),
    ("drink_quality",   "Drink Quality",          2, [
        "watery margarita", "watery drinks", "weak drinks", "weak margaritas",
        "bad margarita", "terrible margarita", "tasteless margarita",
        "margarita was bad", "drinks were bad", "flat soda", "warm beer",
    ]),
    ("parking",         "Parking & Location",     1, [
        "no parking", "hard to park", "parking lot", "parking was",
        "difficult to find parking", "parking issue",
    ]),
    ("reservation",     "Seating & Reservations", 1, [
        "reservation was lost", "lost our reservation", "didn't honor",
        "couldn't find our reservation", "wait despite reservation",
        "sat us at a bad table", "table wasn't ready",
    ]),
    ("consistency",     "Inconsistent Quality",   2, [
        "inconsistent", "hit or miss", "used to be better", "gone downhill",
        "not as good as", "not what it used to", "quality has dropped",
        "quality went down", "used to love", "was better before",
    ]),
    ("host_seating",    "Host & Greeting",        2, [
        "rude host", "host was rude", "hostess was rude", "unfriendly host",
        "unfriendly hostess", "host was unwelcoming", "host ignored us",
        "host didn't greet", "no one greeted us at the door", "nobody greeted us at the door",
        "front desk was rude", "hostess ignored", "host stand was disorganized",
        "unorganized host stand", "host was not helpful", "host was unhelpful",
    ]),
    ("carryout",        "Carryout / Takeout",     2, [
        "carryout order was wrong", "takeout order was wrong", "takeout order was missing",
        "pickup order was wrong", "order wasn't ready when", "waited for my takeout",
        "carryout was cold", "togo order incorrect", "to go order was wrong",
        "forgot items in my takeout", "pickup order missing", "my carryout order was",
        "takeout was incorrect", "curbside order was wrong", "curbside pickup was late",
    ]),
    ("delivery",        "Delivery",               2, [
        "delivery was late", "delivery never arrived", "uber eats order", "doordash order",
        "grubhub order", "delivery driver", "arrived cold from delivery",
        "delivery order was wrong", "delivery took forever", "never delivered",
        "third party delivery", "delivery was missing", "delivery app order",
    ]),
    ("maintenance",     "Facility & Maintenance", 2, [
        "broken chair", "broken table", "ac wasn't working", "air conditioning broken",
        "air conditioning wasn't working", "heater wasn't working", "broken booth",
        "torn seats", "leaking roof", "broken door", "flickering lights", "broken sign",
        "run down", "needs renovation", "outdated decor", "falling apart",
        "broken bathroom fixture", "sink was broken", "toilet was broken",
    ]),
]

PRAISE_CATEGORIES = [
    ("friendly_staff",   "Friendly Staff",          [
        "friendly staff", "friendly service", "friendly server",
        "kind staff", "nice staff", "warm staff", "welcoming staff",
        "friendly and", "so friendly", "very friendly", "extremely friendly",
        "attentive server", "attentive staff", "attentive waitress", "attentive waiter",
    ]),
    ("fast_service",     "Fast & Efficient Service",[
        "fast service", "quick service", "prompt service", "efficient service",
        "came out quickly", "came out fast", "arrived quickly", "out fast",
        "great service", "excellent service", "outstanding service",
        "wonderful service", "service was great", "service was excellent",
    ]),
    ("great_margaritas", "Great Margaritas",        [
        "best margarita", "amazing margarita", "great margarita",
        "delicious margarita", "love the margaritas", "margaritas are amazing",
        "margaritas were great", "margaritas were excellent", "the margaritas",
        "perfect margarita", "strong margarita",
    ]),
    ("great_food",       "Delicious Food",          [
        "delicious", "amazing food", "great food", "excellent food",
        "food was amazing", "food was great", "food was delicious",
        "food was fantastic", "food is amazing", "loved the food",
        "best food", "incredible food",
    ]),
    ("great_tacos",      "Great Tacos",             [
        "best tacos", "amazing tacos", "great tacos", "delicious tacos",
        "love the tacos", "tacos are amazing", "tacos were great",
        "tacos were delicious", "tacos are the best",
    ]),
    ("authentic",        "Authentic Cuisine",       [
        "authentic", "authentic mexican", "authentic food", "authentic flavors",
        "traditional", "real mexican", "genuine", "tastes like mexico",
        "homestyle", "home cooked", "abuela's", "fresh ingredients",
    ]),
    ("family_friendly",  "Family-Friendly",         [
        "great for families", "family friendly", "family atmosphere",
        "kids loved it", "great with kids", "family restaurant",
        "brought the whole family", "family dinner", "kids menu",
    ]),
    ("great_value",      "Great Value",             [
        "great value", "good value", "worth the price", "affordable",
        "reasonable price", "reasonable prices", "not expensive",
        "great price", "good price", "fair price", "priced well",
        "large portions", "generous portions", "huge portions",
    ]),
    ("great_atmosphere", "Great Atmosphere",        [
        "great atmosphere", "love the atmosphere", "beautiful decor",
        "great ambiance", "nice ambiance", "cozy", "beautiful restaurant",
        "nice decor", "love the decor", "vibrant atmosphere",
    ]),
    ("special_occasion", "Special Occasion Excellence",[
        "birthday", "anniversary", "celebration", "special occasion",
        "made it special", "went above and beyond", "made us feel special",
        "treated us like", "special experience",
    ]),
    ("cleanliness_praise", "Clean & Well-Kept",     [
        "very clean", "super clean", "extremely clean", "spotless", "immaculate",
        "restaurant was clean", "clean restaurant", "always clean", "kept very clean",
        "clean tables", "clean bathrooms", "clean environment", "well maintained restaurant",
    ]),
    ("great_management", "Excellent Management",    [
        "manager was great", "manager was wonderful", "manager was amazing",
        "manager was very helpful", "manager took care of us", "manager went above and beyond",
        "great management", "excellent management", "manager was fantastic",
        "owner was great", "owner was very kind", "management was excellent",
    ]),
    ("great_host",       "Warm Welcome",            [
        "host was great", "host was wonderful", "hostess was great", "hostess was wonderful",
        "great host", "friendly host", "friendly hostess", "warm welcome",
        "greeted us warmly", "host was very friendly", "hostess was very friendly",
        "seated us right away", "host sat us immediately",
    ]),
    ("great_carryout",   "Great Carryout Experience",[
        "great takeout", "takeout was great", "takeout is great", "love their takeout",
        "pickup was easy", "easy pickup", "order was ready on time", "carryout order was perfect",
        "online order was great", "online order was perfect", "to go order was perfect",
    ]),
    ("great_delivery",   "Great Delivery Experience",[
        "delivery was fast", "fast delivery", "quick delivery", "delivery was great",
        "delivery was on time", "delivery arrived quickly", "great delivery",
        "delivery order was perfect", "delivery driver was great",
    ]),
    ("well_maintained",  "Well-Maintained Facility",[
        "well maintained", "well kept", "well-maintained", "kept up nicely",
        "nicely renovated", "recently renovated", "modern and clean",
        "facility was great", "building was well kept", "nice and updated",
    ]),
]

# ---------------------------------------------------------------------------
# Negation detection
# ---------------------------------------------------------------------------

_NEGATION_RE = re.compile(
    r"\b(not|no|never|nothing|wasn'?t|isn'?t|aren'?t|weren'?t|didn'?t|don'?t|doesn'?t|hardly|barely|without)\b",
    re.IGNORECASE,
)


def _has_negation_near(text: str, phrase: str, window: int = 6) -> bool:
    """Return True if a negation word appears within `window` words of `phrase`."""
    idx = text.lower().find(phrase)
    if idx == -1:
        return False
    before = text[max(0, idx - 60) : idx].lower()
    words_before = before.split()[-window:]
    return bool(_NEGATION_RE.search(" ".join(words_before)))


def classify_review(text: str, star_rating: int | None) -> dict:
    """
    Returns {"complaints": [...category_ids], "praises": [...category_ids]}
    for a single review.
    """
    if not text:
        text = ""
    tl = text.lower()

    complaints = []
    if star_rating is None or star_rating <= 3:
        for cat_id, _name, _sev, phrases in COMPLAINT_CATEGORIES:
            for phrase in phrases:
                if phrase in tl and not _has_negation_near(tl, phrase):
                    complaints.append(cat_id)
                    break

    praises = []
    if star_rating is None or star_rating >= 3:
        for cat_id, _name, phrases in PRAISE_CATEGORIES:
            for phrase in phrases:
                if phrase in tl and not _has_negation_near(tl, phrase):
                    praises.append(cat_id)
                    break

    return {"complaints": complaints, "praises": praises}


# ---------------------------------------------------------------------------
# Aggregate complaint/praise intelligence
# ---------------------------------------------------------------------------

COMPLAINT_META = {c[0]: {"name": c[1], "severity": c[2]} for c in COMPLAINT_CATEGORIES}
PRAISE_META    = {p[0]: {"name": p[1]}                    for p in PRAISE_CATEGORIES}

# Operational recommendation shown alongside each complaint category so the
# page tells management what to *do*, not just what customers said.
SUGGESTED_ACTIONS = {
    "wait_time":     "Add a host or extra seating staff during the identified peak hours to reduce guest wait times.",
    "slow_service":  "Review server-to-table ratios during peak shifts and reinforce table-check cadence training.",
    "poor_service":  "Schedule a service-recovery training refresh with front-of-house staff on greeting and attentiveness.",
    "cold_food":     "Audit expo/plating times between kitchen and table — check heat-lamp usage and ticket times during rush.",
    "wrong_order":   "Reinforce order read-back at POS entry and at expo before dishes leave the kitchen.",
    "food_quality":  "Schedule a kitchen quality check-in with the head chef and spot-check consistency across shifts.",
    "cleanliness":   "Increase bussing frequency and add a mid-shift floor and table cleanliness check.",
    "restrooms":     "Add a scheduled hourly restroom check during peak hours.",
    "pricing":       "Review menu pricing and portion sizing against guest value perception for the affected items.",
    "noise":         "Evaluate music volume levels and consider acoustic dampening during peak dinner hours.",
    "management":    "Schedule manager coaching focused on guest recovery and complaint ownership.",
    "drink_quality": "Audit bar recipes and pour standards, and review ice-to-liquor ratios with bartenders.",
    "parking":       "Review parking signage and consider valet or overflow parking arrangements during peak hours.",
    "reservation":   "Audit the reservation system and host-stand process to ensure reservations are honored on arrival.",
    "consistency":   "Standardize recipes and prep procedures across shifts to reduce quality variance.",
    "host_seating":  "Coach host-stand staff on greeting standards and consider adding host coverage during peak hours.",
    "carryout":      "Audit the carryout packing checklist and reinforce order verification before handoff.",
    "delivery":      "Review third-party delivery packaging and handoff timing with delivery partners.",
    "maintenance":   "Schedule a facilities walkthrough to identify and prioritize repair needs.",
}


def build_complaint_intelligence(reviews: list, period_reviews: list, prev_reviews: list) -> dict:
    """
    Returns categorized complaint and praise intelligence with trends.
    """
    def _score_period(rev_list: list) -> dict:
        complaint_counts = Counter()
        praise_counts = Counter()
        complaint_reviews = defaultdict(list)
        praise_reviews = defaultdict(list)

        for r in rev_list:
            tags = classify_review(r.get("review_text") or "", r.get("star_rating"))
            for c in tags["complaints"]:
                complaint_counts[c] += 1
                if len(complaint_reviews[c]) < 3:
                    complaint_reviews[c].append({
                        "reviewer_name": r.get("reviewer_name"),
                        "review_text": (r.get("review_text") or "")[:200],
                        "review_date": r.get("review_date"),
                        "star_rating": r.get("star_rating"),
                        "location_name": r.get("location_name"),
                    })
            for p in tags["praises"]:
                praise_counts[p] += 1
                if len(praise_reviews[p]) < 3:
                    praise_reviews[p].append({
                        "reviewer_name": r.get("reviewer_name"),
                        "review_text": (r.get("review_text") or "")[:200],
                        "review_date": r.get("review_date"),
                        "star_rating": r.get("star_rating"),
                        "location_name": r.get("location_name"),
                    })

        return complaint_counts, complaint_reviews, praise_counts, praise_reviews

    cc_cur, cr_cur, pc_cur, pr_cur = _score_period(period_reviews)
    cc_prev, _, pc_prev, _          = _score_period(prev_reviews)

    total_period = max(1, len(period_reviews))

    complaints_out = []
    for cat_id, meta in COMPLAINT_META.items():
        cur_n = cc_cur.get(cat_id, 0)
        prev_n = cc_prev.get(cat_id, 0)
        if cur_n == 0 and prev_n == 0:
            continue
        pct = cur_n / total_period * 100
        delta = cur_n - prev_n
        trend = "up" if delta > 1 else "down" if delta < -1 else "stable"

        # Which locations are most affected
        loc_counts = Counter(
            ex.get("location_name") for ex in cr_cur.get(cat_id, [])
        )

        complaints_out.append({
            "id": cat_id,
            "name": meta["name"],
            "severity": meta["severity"],
            "count": cur_n,
            "prevCount": prev_n,
            "pct": round(pct, 1),
            "delta": delta,
            "trend": trend,
            "topLocations": [{"name": n, "count": c} for n, c in loc_counts.most_common(3)],
            "examples": cr_cur.get(cat_id, []),
            "suggestedAction": SUGGESTED_ACTIONS.get(cat_id),
        })

    complaints_out.sort(key=lambda x: (-x["severity"], -x["count"]))

    praises_out = []
    for cat_id, meta in PRAISE_META.items():
        cur_n = pc_cur.get(cat_id, 0)
        prev_n = pc_prev.get(cat_id, 0)
        if cur_n == 0 and prev_n == 0:
            continue
        pct = cur_n / total_period * 100
        delta = cur_n - prev_n
        trend = "up" if delta > 1 else "down" if delta < -1 else "stable"

        praises_out.append({
            "id": cat_id,
            "name": meta["name"],
            "count": cur_n,
            "prevCount": prev_n,
            "pct": round(pct, 1),
            "delta": delta,
            "trend": trend,
            "examples": pr_cur.get(cat_id, []),
        })

    praises_out.sort(key=lambda x: -x["count"])

    return {"complaints": complaints_out, "praises": praises_out}


# ---------------------------------------------------------------------------
# Marketing Intelligence extras — best customer quotes + seasonal detection.
# Campaign/caption generation already existed on the frontend; this adds the
# detection layer they were missing.
# ---------------------------------------------------------------------------

def build_best_quotes(intel: dict, top_n: int = 5) -> list:
    """Picks the most quotable example review per top praise category --
    reuses the examples build_complaint_intelligence already collected rather
    than mining text again. 'Most quotable' = longest available example, as a
    proxy for a fuller, more usable marketing quote."""
    quotes = []
    for p in intel.get("praises", [])[:top_n]:
        examples = [e for e in p.get("examples", []) if e.get("review_text")]
        if not examples:
            continue
        best = max(examples, key=lambda e: len(e["review_text"]))
        quotes.append({
            "category": p["name"],
            "quote": best["review_text"],
            "reviewerName": best.get("reviewer_name"),
            "locationName": best.get("location_name"),
            "starRating": best.get("star_rating"),
            "reviewDate": best.get("review_date"),
        })
    return quotes


MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
               "July", "August", "September", "October", "November", "December"]


def build_seasonal_trends(reviews: list, min_mentions: int = 8) -> list:
    """
    Detects categories whose mentions skew toward particular calendar months
    across the full review history -- a real seasonal signal, distinct from
    the current-vs-prior-period trend already shown elsewhere, since
    seasonality needs more than two data points to mean anything.

    Mention *rate* (mentions / total reviews that month) is used rather than
    raw mention count, normalizing away months that simply have more total
    review volume overall (this dataset's June has ~2x every other month's
    volume, which would otherwise make nearly every category falsely "peak"
    in June regardless of actual seasonality).
    """
    total_by_month = defaultdict(int)
    by_cat_month = defaultdict(lambda: defaultdict(int))
    cat_total = defaultdict(int)

    for r in reviews:
        if not r.get("review_date"):
            continue
        try:
            month_idx = int(r["review_date"][5:7]) - 1
        except (ValueError, IndexError):
            continue
        total_by_month[month_idx] += 1

        text = r.get("review_text") or ""
        if not text:
            continue
        tags = classify_review(text, r.get("star_rating"))
        for cat_id in tags["complaints"] + tags["praises"]:
            by_cat_month[cat_id][month_idx] += 1
            cat_total[cat_id] += 1

    all_meta = {**COMPLAINT_META, **PRAISE_META}
    out = []
    for cat_id, total in cat_total.items():
        if total < min_mentions:
            continue
        month_counts = by_cat_month[cat_id]
        overall_total_reviews = sum(total_by_month.values())
        avg_rate = total / overall_total_reviews if overall_total_reviews else 0
        if avg_rate == 0:
            continue

        rates = {
            m: count / total_by_month[m]
            for m, count in month_counts.items() if total_by_month.get(m)
        }
        if not rates:
            continue
        peak_month_idx, peak_rate = max(rates.items(), key=lambda kv: kv[1])

        skew = peak_rate / avg_rate
        if skew >= 1.5:  # at least 50% above this category's own overall mention rate
            out.append({
                "id": cat_id,
                "name": all_meta.get(cat_id, {}).get("name", cat_id),
                "type": "complaint" if cat_id in COMPLAINT_META else "praise",
                "peakMonth": MONTH_NAMES[peak_month_idx],
                "peakCount": month_counts[peak_month_idx],
                "totalMentions": total,
                "skew": round(skew, 2),
            })

    out.sort(key=lambda x: -x["skew"])
    return out[:8]


# ---------------------------------------------------------------------------
# Department performance — groups the 20 flat complaint/praise categories into
# the 13 operational departments management actually organizes around.
# ---------------------------------------------------------------------------

DEPARTMENTS = [
    "Kitchen", "Service", "Bar", "Management", "Host", "Carryout", "Delivery",
    "Cleanliness", "Bathrooms", "Atmosphere", "Parking", "Pricing", "Maintenance",
]

DEPARTMENT_MAP = {
    # complaints
    "wait_time": "Service", "slow_service": "Service", "poor_service": "Service",
    "cold_food": "Kitchen", "wrong_order": "Kitchen", "food_quality": "Kitchen", "consistency": "Kitchen",
    "cleanliness": "Cleanliness",
    "restrooms": "Bathrooms",
    "pricing": "Pricing",
    "noise": "Atmosphere",
    "management": "Management",
    "drink_quality": "Bar",
    "parking": "Parking",
    "reservation": "Host", "host_seating": "Host",
    "carryout": "Carryout",
    "delivery": "Delivery",
    "maintenance": "Maintenance",
    # praises
    "friendly_staff": "Service", "fast_service": "Service",
    "great_margaritas": "Bar",
    "great_food": "Kitchen", "great_tacos": "Kitchen", "authentic": "Kitchen",
    "family_friendly": "Atmosphere", "great_atmosphere": "Atmosphere", "special_occasion": "Atmosphere",
    "great_value": "Pricing",
    "cleanliness_praise": "Cleanliness",
    "great_management": "Management",
    "great_host": "Host",
    "great_carryout": "Carryout",
    "great_delivery": "Delivery",
    "well_maintained": "Maintenance",
}


def build_department_summary(intel: dict) -> list:
    """
    Aggregates the complaint/praise category intelligence build_complaint_intelligence()
    already computed into the 13 operational departments, rather than 20 flat
    category ids -- reuses that computation entirely instead of re-classifying reviews.
    """
    by_dept = {
        d: {"positive": 0, "negative": 0, "prevPositive": 0, "prevNegative": 0,
            "complaints": [], "praises": []}
        for d in DEPARTMENTS
    }

    for c in intel.get("complaints", []):
        dept = DEPARTMENT_MAP.get(c["id"])
        if not dept:
            continue
        by_dept[dept]["negative"] += c["count"]
        by_dept[dept]["prevNegative"] += c["prevCount"]
        by_dept[dept]["complaints"].append(c)

    for p in intel.get("praises", []):
        dept = DEPARTMENT_MAP.get(p["id"])
        if not dept:
            continue
        by_dept[dept]["positive"] += p["count"]
        by_dept[dept]["prevPositive"] += p["prevCount"]
        by_dept[dept]["praises"].append(p)

    out = []
    for dept, d in by_dept.items():
        total = d["positive"] + d["negative"]
        prev_total = d["prevPositive"] + d["prevNegative"]
        if total == 0 and prev_total == 0:
            continue  # no signal at all this period or last -- omit rather than fake a score

        score = round(d["positive"] / total * 100) if total else None
        prev_score = round(d["prevPositive"] / prev_total * 100) if prev_total else None
        delta = (score - prev_score) if score is not None and prev_score is not None else None
        trend = "up" if delta and delta > 3 else "down" if delta and delta < -3 else "stable"

        top_complaint = max(d["complaints"], key=lambda c: c["count"], default=None)
        top_praise = max(d["praises"], key=lambda p: p["count"], default=None)
        recommendations = [
            c["suggestedAction"] for c in sorted(d["complaints"], key=lambda c: -c["count"])[:2]
            if c.get("suggestedAction")
        ]

        out.append({
            "department": dept,
            "score": score,
            "prevScore": prev_score,
            "delta": delta,
            "trend": trend,
            "positiveMentions": d["positive"],
            "negativeMentions": d["negative"],
            "recurringIssue": top_complaint["name"] if top_complaint else None,
            "topStrength": top_praise["name"] if top_praise else None,
            "recommendations": recommendations,
        })

    out.sort(key=lambda d: d["score"] if d["score"] is not None else 100)
    return out


# ---------------------------------------------------------------------------
# Customer Experience Index — 10 dimension scores derived from the same
# complaint/praise category counts as complaint intelligence (per your
# decision: not a separate 10-dimension LLM scoring pass over every review --
# near-zero extra AI cost and updates instantly with existing data).
# ---------------------------------------------------------------------------

CX_DIMENSIONS = {
    "Food Quality": {"complaints": ["food_quality", "cold_food", "wrong_order", "consistency"],
                      "praises": ["great_food", "great_tacos", "authentic"]},
    "Service":      {"complaints": ["poor_service", "slow_service"],
                      "praises": ["friendly_staff", "fast_service"]},
    "Atmosphere":   {"complaints": ["noise"],
                      "praises": ["great_atmosphere", "family_friendly", "special_occasion"]},
    "Cleanliness":  {"complaints": ["cleanliness", "restrooms"],
                      "praises": ["cleanliness_praise"]},
    "Value":        {"complaints": ["pricing"],
                      "praises": ["great_value"]},
    "Drinks":       {"complaints": ["drink_quality"],
                      "praises": ["great_margaritas"]},
    "Speed":        {"complaints": ["wait_time", "slow_service"],
                      "praises": ["fast_service"]},
    "Accuracy":     {"complaints": ["wrong_order", "carryout", "delivery"],
                      "praises": ["great_carryout", "great_delivery"]},
    "Friendliness": {"complaints": ["poor_service", "host_seating"],
                      "praises": ["friendly_staff", "great_host"]},
}


def _cx_score(complaint_n: int, praise_n: int) -> int | None:
    total = complaint_n + praise_n
    if total == 0:
        return None
    return round(50 + 50 * (praise_n - complaint_n) / total)


def build_cx_index(intel: dict) -> list:
    """Ten Customer Experience dimension scores (0-100) plus an Overall
    Experience composite, each derived from complaint/praise category counts
    already computed by build_complaint_intelligence -- no re-classification."""
    complaint_by_id = {c["id"]: c for c in intel.get("complaints", [])}
    praise_by_id    = {p["id"]: p for p in intel.get("praises", [])}

    out = []
    for dim, cats in CX_DIMENSIONS.items():
        cur_c  = sum(complaint_by_id.get(cid, {}).get("count", 0)     for cid in cats["complaints"])
        cur_p  = sum(praise_by_id.get(pid, {}).get("count", 0)        for pid in cats["praises"])
        prev_c = sum(complaint_by_id.get(cid, {}).get("prevCount", 0) for cid in cats["complaints"])
        prev_p = sum(praise_by_id.get(pid, {}).get("prevCount", 0)    for pid in cats["praises"])

        score      = _cx_score(cur_c, cur_p)
        prev_score = _cx_score(prev_c, prev_p)
        delta = (score - prev_score) if score is not None and prev_score is not None else None
        trend = "up" if delta and delta > 3 else "down" if delta and delta < -3 else "stable"

        drivers = (
            [(complaint_by_id[cid], "complaint") for cid in cats["complaints"] if cid in complaint_by_id]
            + [(praise_by_id[pid], "praise") for pid in cats["praises"] if pid in praise_by_id]
        )
        top_driver = max(drivers, key=lambda x: x[0]["count"])[0]["name"] if drivers else None

        out.append({
            "dimension": dim,
            "score": score,
            "prevScore": prev_score,
            "delta": delta,
            "trend": trend,
            "mentionCount": cur_c + cur_p,
            "explanation": f'Driven mainly by "{top_driver}" this period.' if top_driver else "No mentions in this dimension this period.",
        })

    scored      = [d["score"]     for d in out if d["score"]     is not None]
    prev_scored = [d["prevScore"] for d in out if d["prevScore"] is not None]
    overall       = round(sum(scored) / len(scored)) if scored else None
    overall_prev  = round(sum(prev_scored) / len(prev_scored)) if prev_scored else None
    overall_delta = (overall - overall_prev) if overall is not None and overall_prev is not None else None
    out.append({
        "dimension": "Overall Experience",
        "score": overall,
        "prevScore": overall_prev,
        "delta": overall_delta,
        "trend": "up" if overall_delta and overall_delta > 3 else "down" if overall_delta and overall_delta < -3 else "stable",
        "mentionCount": sum(d["mentionCount"] for d in out),
        "explanation": "Composite average across all measured dimensions.",
    })
    return out


# ---------------------------------------------------------------------------
# AI Action Center — turns complaint/praise category intelligence into a
# ranked list of concrete recommendations, instead of just displaying data.
# ---------------------------------------------------------------------------

# Difficulty is a static per-category judgment call (some issues are a
# training/coaching fix, others require capital investment or menu changes) --
# not derived from the data, since the data has no signal on organizational cost.
_ACTION_DIFFICULTY = {
    "wait_time": "medium", "slow_service": "medium", "poor_service": "medium",
    "cold_food": "medium", "wrong_order": "easy", "food_quality": "hard",
    "cleanliness": "easy", "restrooms": "easy", "pricing": "hard",
    "noise": "hard", "management": "medium", "drink_quality": "medium",
    "parking": "hard", "reservation": "easy", "consistency": "hard",
    "host_seating": "easy", "carryout": "medium", "delivery": "medium",
    "maintenance": "hard",
}
_ACTION_COMPLETION_TIME = {"easy": "This week", "medium": "Within 30 days", "hard": "Next quarter"}


def _action_priority(severity: int, trend: str) -> str:
    if severity == 3 and trend == "up":
        return "Critical"
    if severity == 3:
        return "High"
    if severity == 2 and trend == "up":
        return "High"
    if severity == 2:
        return "Medium"
    return "Low"


def _action_impact(pct: float) -> str:
    if pct >= 15:
        return "High"
    if pct >= 7:
        return "Medium"
    return "Low"


def _action_confidence(n: int) -> dict:
    c = confidence(n)
    label = "High" if c["level"] >= 3 else "Moderate" if c["level"] == 2 else "Low"
    return {"label": label, "sampleSize": n}


def build_executive_scores(
    company_health: dict, avg_30: float | None, rating_delta: float,
    period_sentiment: dict, unanswered: int, intel: dict, cx_index: list,
    loc_stats: list, alerts: list, consistency: list, staff_sentiment_totals: dict,
    period_n: int, prev_period_n: int, location_count: int,
) -> list:
    """
    Eight named composite scores for the Executive Dashboard. Reuses every
    input from analytics already computed elsewhere this run (health score,
    CX Index, complaint/praise intelligence, location stats, alerts) rather
    than re-deriving anything from raw reviews -- each entry documents its
    exact formula so nothing is a black box.
    """
    scores = []

    # 1. AI Health Score -- identical to compute_health_score(), reused as-is.
    scores.append({
        "id": "health", "label": "AI Health Score", "higherIsBetter": True,
        "score": company_health.get("score"),
        "explanation": "40% average rating, 25% AI sentiment, 20% response rate, 15% rating trend (same formula as the Health Score shown elsewhere).",
    })

    # 2. Customer Satisfaction Score -- the CX Index's Overall Experience composite.
    overall_cx = next((d for d in cx_index if d["dimension"] == "Overall Experience"), None)
    scores.append({
        "id": "satisfaction", "label": "Customer Satisfaction Score", "higherIsBetter": True,
        "score": overall_cx["score"] if overall_cx else None,
        "explanation": "Average of all 10 Customer Experience Index dimensions (Food Quality, Service, Atmosphere, Cleanliness, Value, Drinks, Speed, Accuracy, Friendliness).",
    })

    # 3. Company Reputation Score -- rating + sentiment + cross-location consistency.
    rating_component = max(0, min(100, (avg_30 - 1) / 4 * 100)) if avg_30 else None
    variances = [c["variance"] for c in consistency if c.get("variance") is not None]
    avg_variance = sum(variances) / len(variances) if variances else 0
    consistency_component = max(0, min(100, 100 - avg_variance * 200))
    reputation_score = (
        round(rating_component * 0.5 + period_sentiment["positive"] * 0.3 + consistency_component * 0.2)
        if rating_component is not None else None
    )
    scores.append({
        "id": "reputation", "label": "Company Reputation Score", "higherIsBetter": True,
        "score": reputation_score,
        "explanation": "50% average rating, 30% positive sentiment, 20% rating consistency across locations (a volatile network looks riskier to prospective guests than a steady one, even at the same average rating).",
    })

    # 4. Marketing Opportunity Score -- how much usable positive content exists.
    total_praise_mentions = sum(p["count"] for p in intel.get("praises", []))
    marketing_score = round(min(100, (total_praise_mentions / max(1, period_n)) * 100))
    scores.append({
        "id": "marketing", "label": "Marketing Opportunity Score", "higherIsBetter": True,
        "score": marketing_score,
        "explanation": f"Share of this period's reviews containing a specific, usable praise theme ({total_praise_mentions} praise mentions across {period_n} reviews).",
    })

    # 5. Operational Risk Score -- higher = more risk (inverted polarity, flagged for the UI).
    risk_from_alerts = min(100, (len(alerts) / max(1, location_count)) * 40)
    risk_from_unanswered = min(100, (unanswered / max(1, period_n)) * 200)
    risk_from_sentiment = period_sentiment["bad"]
    operational_risk_score = round(min(100, risk_from_alerts * 0.3 + risk_from_unanswered * 0.3 + risk_from_sentiment * 0.4))
    scores.append({
        "id": "risk", "label": "Operational Risk Score", "higherIsBetter": False,
        "score": operational_risk_score,
        "explanation": "Higher = more risk. 30% active alerts per location, 30% unanswered negative reviews as a share of period volume, 40% negative sentiment rate.",
    })

    # 6. Manager Performance Score -- explicitly a staff-mention sentiment PROXY,
    # not per-manager accountability tracking. The review schema has no manager
    # field, so this can only reflect aggregate name-mention sentiment from guests.
    total_staff_mentions = sum(staff_sentiment_totals.values())
    manager_score = round(staff_sentiment_totals["positive"] / total_staff_mentions * 100) if total_staff_mentions else None
    scores.append({
        "id": "manager", "label": "Manager Performance Score", "higherIsBetter": True,
        "score": manager_score,
        "explanation": "Proxy only: share of staff name-mentions across all reviews (last 90 days) that were positive. Not a true per-manager metric -- the data has no manager field, only guest-mentioned names.",
    })

    # 7. Growth Score -- review volume growth + rating growth.
    volume_growth_pct = ((period_n - prev_period_n) / prev_period_n * 100) if prev_period_n else 0
    rating_growth_component = (rating_delta / 0.5) * 50 if rating_delta else 0
    growth_score = round(max(0, min(100, 50 + volume_growth_pct / 4 + rating_growth_component)))
    scores.append({
        "id": "growth", "label": "Growth Score", "higherIsBetter": True,
        "score": growth_score,
        "explanation": f"Centered at 50: adjusted for review-volume growth ({volume_growth_pct:+.0f}% vs. prior period) and rating change ({rating_delta:+.2f}★).",
    })

    # 8. Trend Score -- forward-looking, based on how many locations are
    # forecast to improve vs. decline (reuses predict_rating(), already computed
    # per location in location_stats()).
    improving = declining = 0
    for s in loc_stats:
        pred = s.get("predictedRating")
        cur = (s.get("periodSentiment") or {}).get("avgRating")
        if pred is None or cur is None:
            continue
        if pred > cur + 0.05:
            improving += 1
        elif pred < cur - 0.05:
            declining += 1
    total_forecasted = improving + declining
    trend_score = round(50 + (improving - declining) / total_forecasted * 50) if total_forecasted else 50
    scores.append({
        "id": "trend", "label": "Trend Score", "higherIsBetter": True,
        "score": trend_score,
        "explanation": f"Centered at 50: {improving} location(s) forecast to improve vs. {declining} forecast to decline over the next 30 days (AI-generated forecasts, not guarantees).",
    })

    return scores


def build_action_center(intel: dict, top_staff: dict | None = None) -> list:
    """
    Synthesizes complaint/praise category intelligence (already computed by
    build_complaint_intelligence) into a ranked list of concrete recommendations
    -- what management should *do*, not just what customers said.
    """
    actions = []

    for c in intel.get("complaints", []):
        cat_id = c["id"]
        difficulty = _ACTION_DIFFICULTY.get(cat_id, "medium")
        actions.append({
            "id": f"complaint_{cat_id}",
            "type": "operational",
            "title": f"Address {c['name'].lower()}",
            "priority": _action_priority(c["severity"], c["trend"]),
            "reason": f"{c['name']} was mentioned in {c['count']} reviews this period ({c['pct']}% of all reviews)"
                      + (", and it's increasing" if c["trend"] == "up"
                         else ", though it's improving" if c["trend"] == "down" else "") + ".",
            "estimatedImpact": _action_impact(c["pct"]),
            "confidence": _action_confidence(c["count"]),
            "supportingReviews": c.get("examples", []),
            "difficulty": difficulty.capitalize(),
            "recommendedDepartment": DEPARTMENT_MAP.get(cat_id, "Management"),
            "suggestedCompletionTime": _ACTION_COMPLETION_TIME.get(difficulty),
            "suggestedAction": c.get("suggestedAction"),
        })

    praises = intel.get("praises", [])
    if praises:
        top = praises[0]
        actions.append({
            "id": f"marketing_{top['id']}",
            "type": "marketing",
            "title": f"Promote {top['name'].lower()} in marketing",
            "priority": "Medium",
            "reason": f"{top['name']} is your most-praised theme this period ({top['count']} mentions).",
            "estimatedImpact": _action_impact(top["pct"]),
            "confidence": _action_confidence(top["count"]),
            "supportingReviews": top.get("examples", []),
            "difficulty": "Easy",
            "recommendedDepartment": "Marketing",
            "suggestedCompletionTime": _ACTION_COMPLETION_TIME["easy"],
            "suggestedAction": f"Feature \"{top['name']}\" in social posts, Google Business updates, and in-store signage.",
        })

    if top_staff:
        actions.append({
            "id": "recognition_staff",
            "type": "recognition",
            "title": f"Recognize {top_staff['name']} at {top_staff['location']}",
            "priority": "Low",
            "reason": f"{top_staff['name']} was positively mentioned by name in {top_staff['count']} reviews "
                      f"at {top_staff['location']} in the last 90 days.",
            "estimatedImpact": "Medium",
            "confidence": _action_confidence(top_staff["count"]),
            "supportingReviews": [],
            "difficulty": "Easy",
            "recommendedDepartment": "Management",
            "suggestedCompletionTime": _ACTION_COMPLETION_TIME["easy"],
            "suggestedAction": f"Recognize {top_staff['name']} in the next team meeting or an employee-recognition program.",
        })

    order = {"Critical": 0, "High": 1, "Medium": 2, "Low": 3}
    actions.sort(key=lambda a: (order.get(a["priority"], 4), -a["confidence"]["sampleSize"]))
    return actions


# ---------------------------------------------------------------------------
# Operations Impact Center — company-wide operational superlatives with
# plain-English explanations, reusing complaint/praise intel + location_stats.
# ---------------------------------------------------------------------------

def _rating_variance(monthly: list) -> float | None:
    """Population variance of monthly average ratings -- a proxy for how
    consistent (vs. volatile) a location's rating has been over time."""
    vals = [m["avg"] for m in monthly if m.get("avg") is not None]
    if len(vals) < 3:
        return None
    mean = sum(vals) / len(vals)
    return round(sum((v - mean) ** 2 for v in vals) / len(vals), 4)


def build_operations_impact(intel: dict, loc_stats: list, consistency: list) -> dict:
    """
    Company-wide operational summary: biggest/fastest-growing complaint and
    compliment, highest/lowest-performing location, most/least consistent
    location, best-managed location, and the location needing the most
    immediate attention -- each with a one-sentence explanation.
    """
    complaints_by_count = sorted(intel.get("complaints", []), key=lambda c: -c["count"])
    praises_by_count    = sorted(intel.get("praises", []),    key=lambda p: -p["count"])
    growing_complaints  = sorted(intel.get("complaints", []), key=lambda c: -c["delta"])
    growing_praises     = sorted(intel.get("praises", []),    key=lambda p: -p["delta"])

    valid_locs = [s for s in loc_stats if s.get("periodSentiment", {}).get("avgRating") is not None]
    by_rating  = sorted(valid_locs, key=lambda s: s["periodSentiment"]["avgRating"], reverse=True)
    healthy_locs = [s for s in valid_locs if (s.get("healthScore") or {}).get("score") is not None]
    by_health  = sorted(healthy_locs, key=lambda s: s["healthScore"]["score"], reverse=True)
    by_consistency = sorted([c for c in consistency if c["variance"] is not None], key=lambda c: c["variance"])

    def _loc_brief(s):
        if not s:
            return None
        return {"name": s["name"], "avgRating": s["periodSentiment"]["avgRating"],
                "healthScore": (s.get("healthScore") or {}).get("score")}

    biggest_complaint  = complaints_by_count[0] if complaints_by_count else None
    fastest_complaint  = growing_complaints[0] if growing_complaints and growing_complaints[0]["delta"] > 0 else None
    biggest_compliment = praises_by_count[0] if praises_by_count else None
    fastest_compliment = growing_praises[0] if growing_praises and growing_praises[0]["delta"] > 0 else None

    best_loc         = by_rating[0] if by_rating else None
    worst_loc        = by_rating[-1] if by_rating else None
    most_consistent  = by_consistency[0] if by_consistency else None
    least_consistent = by_consistency[-1] if len(by_consistency) > 1 else None
    best_managed     = by_health[0] if by_health else None
    needs_attention  = by_health[-1] if by_health else worst_loc

    return {
        "biggestComplaint": None if not biggest_complaint else {
            "category": biggest_complaint,
            "explanation": f"{biggest_complaint['name']} is your biggest complaint theme — {biggest_complaint['count']} mentions this period ({biggest_complaint['pct']}% of reviews).",
        },
        "fastestGrowingComplaint": None if not fastest_complaint else {
            "category": fastest_complaint,
            "explanation": f"{fastest_complaint['name']} is rising fastest — up from {fastest_complaint['prevCount']} to {fastest_complaint['count']} mentions vs. the prior period.",
        },
        "biggestCompliment": None if not biggest_compliment else {
            "category": biggest_compliment,
            "explanation": f"{biggest_compliment['name']} is your biggest compliment theme — {biggest_compliment['count']} mentions this period.",
        },
        "fastestGrowingCompliment": None if not fastest_compliment else {
            "category": fastest_compliment,
            "explanation": f"{fastest_compliment['name']} is growing fastest — up from {fastest_compliment['prevCount']} to {fastest_compliment['count']} mentions vs. the prior period.",
        },
        "highestPerforming": None if not best_loc else {
            "location": _loc_brief(best_loc),
            "explanation": f"{best_loc['name']} leads the network at {best_loc['periodSentiment']['avgRating']:.2f}★ this period.",
        },
        "lowestPerforming": None if not worst_loc else {
            "location": _loc_brief(worst_loc),
            "explanation": f"{worst_loc['name']} is the lowest-rated location at {worst_loc['periodSentiment']['avgRating']:.2f}★ this period.",
        },
        "mostConsistent": None if not most_consistent else {
            "location": most_consistent,
            "explanation": f"{most_consistent['name']} has the most stable rating over time — the lowest month-to-month variance in the network.",
        },
        "leastConsistent": None if not least_consistent else {
            "location": least_consistent,
            "explanation": f"{least_consistent['name']} swings the most month-to-month — worth investigating what's driving the volatility.",
        },
        "bestManaged": None if not best_managed else {
            "location": _loc_brief(best_managed),
            "explanation": f"{best_managed['name']} has the highest health score in the network ({best_managed['healthScore']['score']}), reflecting strong ratings, sentiment, and responsiveness together.",
        },
        "needsAttention": None if not needs_attention else {
            "location": _loc_brief(needs_attention),
            "explanation": f"{needs_attention['name']} needs the most immediate attention based on its health score and recent trend.",
        },
    }


# ---------------------------------------------------------------------------
# Predictive analytics — simple linear trend on last 90 days
# ---------------------------------------------------------------------------

def predict_rating(reviews: list, days_ahead: int = 30) -> float | None:
    """
    Linear regression on monthly average ratings → project `days_ahead` forward.
    Returns projected rating (clamped 1.0–5.0) or None if insufficient data.
    """
    buckets = {}
    for r in reviews:
        if not r.get("review_date") or r.get("star_rating") is None:
            continue
        ym = r["review_date"][:7]
        b = buckets.setdefault(ym, {"sum": 0, "count": 0})
        b["sum"] += r["star_rating"]
        b["count"] += 1

    months = sorted(buckets.keys())
    if len(months) < 3:
        return None

    recent = months[-6:]  # use last 6 months for trend
    xs = list(range(len(recent)))
    ys = [buckets[m]["sum"] / buckets[m]["count"] for m in recent]

    n = len(xs)
    sx, sy = sum(xs), sum(ys)
    sxy = sum(x * y for x, y in zip(xs, ys))
    sxx = sum(x * x for x in xs)

    denom = n * sxx - sx * sx
    if denom == 0:
        return None

    slope = (n * sxy - sx * sy) / denom
    intercept = (sy - slope * sx) / n

    # Project ~1 month ahead
    x_future = len(recent) - 1 + (days_ahead / 30)
    predicted = intercept + slope * x_future
    return round(max(1.0, min(5.0, predicted)), 2)


def predict_volume(reviews: list, days_ahead: int = 30) -> int | None:
    """Project review volume for the next `days_ahead` days."""
    if not reviews:
        return None
    today = datetime.now(timezone.utc).date()
    d30 = (today - timedelta(days=30)).isoformat()
    d60 = (today - timedelta(days=60)).isoformat()

    cur30  = sum(1 for r in reviews if r.get("review_date") and r["review_date"] >= d30)
    prev30 = sum(1 for r in reviews if r.get("review_date") and d60 <= r["review_date"] < d30)

    if prev30 == 0:
        return cur30

    growth = cur30 / prev30
    projected = round(cur30 * growth * (days_ahead / 30))
    return max(0, projected)


def forecast_confidence(reviews: list) -> dict:
    """
    Confidence tier for predict_rating()/predict_volume() -- both are simple
    linear-trend point estimates with no statistical error bars, so this is
    an honest proxy (how much history exists, how volatile it's been) rather
    than a true confidence interval, and is always labeled as such in the UI.
    """
    buckets = {}
    for r in reviews:
        if not r.get("review_date") or r.get("star_rating") is None:
            continue
        ym = r["review_date"][:7]
        b = buckets.setdefault(ym, {"sum": 0, "count": 0})
        b["sum"] += r["star_rating"]
        b["count"] += 1

    months = sorted(buckets.keys())
    if len(months) < 3:
        return {"level": "low", "label": "Low confidence", "monthsOfData": len(months)}

    recent = months[-6:]
    vals = [buckets[m]["sum"] / buckets[m]["count"] for m in recent]
    mean = sum(vals) / len(vals)
    variance = round(sum((v - mean) ** 2 for v in vals) / len(vals), 4)
    n_months = len(months)

    if n_months >= 6 and variance < 0.05:
        level = "high"
    elif n_months >= 4 and variance < 0.15:
        level = "moderate"
    else:
        level = "low"

    label = {"high": "High confidence", "moderate": "Moderate confidence", "low": "Low confidence"}[level]
    return {"level": level, "label": label, "monthsOfData": n_months, "recentVariance": variance}


def rating_trend_alert(reviews: list, location_name: str) -> dict | None:
    """
    Returns an alert dict if the location's rating is declining significantly.
    """
    pred = predict_rating(reviews, days_ahead=30)
    if pred is None:
        return None

    recent = [r for r in reviews if r.get("review_date") and r.get("star_rating") is not None]
    if not recent:
        return None

    current = sum(r["star_rating"] for r in recent[-20:]) / min(len(recent), 20)

    if pred < 4.0 and current >= 4.0:
        return {
            "type": "rating_drop_warning",
            "location": location_name,
            "current": round(current, 2),
            "predicted": pred,
            "message": f"{location_name} is projected to drop below 4.0★ within 30 days (currently {current:.2f}★).",
        }
    if pred < current - 0.3:
        return {
            "type": "rating_declining",
            "location": location_name,
            "current": round(current, 2),
            "predicted": pred,
            "message": f"{location_name} shows a declining trend ({current:.2f}★ → projected {pred:.2f}★).",
        }
    return None


def negative_spike_alert(reviews: list, location_name: str) -> dict | None:
    """5+ negative (<=2-star) reviews landing on the same calendar day -- the
    finest granularity the data supports, since review timestamps (not just
    dates) aren't captured by the source."""
    by_day = defaultdict(int)
    for r in reviews:
        if r.get("review_date") and (r.get("star_rating") or 5) <= 2:
            by_day[r["review_date"]] += 1
    worst_day, worst_n = max(by_day.items(), key=lambda kv: kv[1], default=(None, 0))
    if worst_n < 5:
        return None
    return {
        "type": "negative_spike",
        "severity": "critical",
        "title": f"{location_name}: negative review spike",
        "location": location_name,
        "date": worst_day,
        "count": worst_n,
        "message": f"{location_name} received {worst_n} negative reviews on {worst_day}.",
    }


def volume_drop_alert(period_reviews: list, prev_reviews: list, location_name: str) -> dict | None:
    """Review volume dropped 40%+ vs. the prior period (distinct from the
    rating-delta trend alert -- a location can hold its rating while going
    quiet, which is its own early-warning signal)."""
    prev_n = len(prev_reviews)
    cur_n = len(period_reviews)
    if prev_n < 5:
        return None
    drop_pct = (prev_n - cur_n) / prev_n * 100
    if drop_pct < 40:
        return None
    return {
        "type": "volume_drop",
        "severity": "warning",
        "title": f"{location_name}: review volume dropped",
        "location": location_name,
        "current": cur_n,
        "prev": prev_n,
        "dropPct": round(drop_pct),
        "message": f"{location_name}'s review volume dropped {round(drop_pct)}% ({prev_n} → {cur_n} reviews) vs. the prior period.",
    }


def stale_reply_alert(reviews: list, location_name: str, days_threshold: int = 5, max_age_days: int = 90) -> dict | None:
    """A negative review has *recently* gone stale (5-90 days unanswered).
    Bounded at the top end so this stays a "this needs attention now" signal
    rather than restating years-old permanent backlog that's already visible
    in the Response Center / Action Items -- that's a distinct, calmer view."""
    today = datetime.now(timezone.utc).date()
    oldest_stale = None
    for r in reviews:
        if (r.get("star_rating") or 5) > 2 or (r.get("owner_response") or "").strip():
            continue
        if not r.get("review_date"):
            continue
        try:
            age_days = (today - datetime.fromisoformat(r["review_date"]).date()).days
        except ValueError:
            continue
        if days_threshold <= age_days <= max_age_days and (oldest_stale is None or age_days > oldest_stale):
            oldest_stale = age_days
    if oldest_stale is None:
        return None
    return {
        "type": "stale_reply",
        "severity": "warning",
        "title": f"{location_name}: unanswered review aging",
        "location": location_name,
        "daysUnanswered": oldest_stale,
        "message": f"{location_name} has a negative review that has gone {oldest_stale} days without an owner reply.",
    }


def critical_review_alert(reviews: list, location_name: str) -> dict | None:
    """
    Flags any unanswered review the AI classifier marked 'critical' priority
    (food safety, injury, discrimination, legal concerns -- see ai_engine.py's
    classify_reviews_batch) -- reuses that classification directly rather than
    re-detecting keywords. Returns nothing if AI classification hasn't run yet
    (ai_priority unset on every review, e.g. no ANTHROPIC_API_KEY configured).
    """
    critical_unanswered = [
        r for r in reviews
        if r.get("ai_priority") == "critical" and not (r.get("owner_response") or "").strip()
    ]
    if not critical_unanswered:
        return None
    most_recent = max(critical_unanswered, key=lambda r: r.get("review_date") or "")
    return {
        "type": "critical_review",
        "severity": "critical",
        "title": f"{location_name}: critical review needs immediate attention",
        "location": location_name,
        "count": len(critical_unanswered),
        "reviewDate": most_recent.get("review_date"),
        "message": f"{location_name} has {len(critical_unanswered)} unanswered review(s) flagged critical priority "
                   f"(safety, legal, or discrimination concerns) — most recent on {most_recent.get('review_date')}.",
    }


def sentiment_shift_alert(period_reviews: list, prev_reviews: list, location_name: str) -> dict | None:
    """Sentiment (AI-derived, not just stars) swung 20+ points period-over-period."""
    cur = sentiment(period_reviews)
    prev = sentiment(prev_reviews)
    if cur["n"] < 5 or prev["n"] < 5:
        return None
    delta = cur["positive"] - prev["positive"]
    if abs(delta) < 20:
        return None
    direction = "improved" if delta > 0 else "declined"
    return {
        "type": "sentiment_shift",
        "severity": "positive" if delta > 0 else "warning",
        "title": f"{location_name}: sentiment shift",
        "location": location_name,
        "delta": round(delta, 1),
        "direction": direction,
        "message": f"{location_name}'s guest sentiment {direction} sharply -- {round(prev['positive'])}% → {round(cur['positive'])}% positive vs. the prior period.",
    }


# ---------------------------------------------------------------------------
# Existing helpers (sentiment, confidence, trends, staff, etc.)
# ---------------------------------------------------------------------------

STOP_WORDS = {
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
    'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'up', 'about', 'into', 'through',
    'during', 'before', 'after', 'above', 'below', 'between', 'among', 'all', 'each', 'every',
    'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
    'same', 'so', 'than', 'too', 'very', 'just', 'but', 'and', 'or', 'if', 'as', 'it', 'its',
    'this', 'that', 'these', 'those', 'them', 'they', 'we', 'you', 'he', 'she', 'his', 'her',
    'our', 'your', 'their', 'my', 'i', 'me', 'us', 'him', 'also', 'there', 'here', 'when',
    'where', 'which', 'who', 'how', 'why', 'what', 'any', 'never', 'always', 'still', 'even',
    'get', 'got', 'go', 'went', 'came', 'come', 'can', 'like', 'really', 'actually',
    'back', 'out', 'over', 'well', 've', 'll', 're', 's', 't', 'm', 'd',
    'food', 'place', 'restaurant', 'time', 'service', 'staff', 'visit',
    'good', 'great', 'nice', 'bad', 'ok', 'okay', 'though',
    'now', 'then', 'again', 'much', 'many', 'lot', 'little', 'bit', 'quite', 'pretty',
    'definitely', 'absolutely',
}

MENU_ITEMS = [
    'tacos', 'taco', 'enchiladas', 'enchilada', 'fajitas', 'fajita', 'burrito', 'burritos',
    'margarita', 'margaritas', 'chips', 'salsa', 'guacamole', 'nachos', 'quesadilla',
    'quesadillas', 'tamales', 'tamale', 'carnitas', 'carne asada', 'al pastor', 'pollo',
    'rice', 'beans', 'chimichanga', 'chimichangas', 'tostada', 'tostadas', 'torta', 'tortas',
    'menudo', 'pozole', 'birria', 'mole', 'churros', 'churro', 'flautas', 'flauta',
    'taquitos', 'taquito', 'elote', 'horchata', 'tres leches', 'flan',
    'street tacos', 'fish tacos', 'steak', 'shrimp', 'chicken', 'pork', 'beef',
    'queso', 'pico', 'cilantro', 'lime',
]

STAFF_PATTERNS = [
    re.compile(r'(?:our|my)\s+(?:server|waiter|waitress|bartender|host|manager|girl|guy)\s+([A-Z][a-z]+)'),
    re.compile(r'(?:server|waiter|waitress|bartender|host|manager)\s+(?:named?\s+)?([A-Z][a-z]+)'),
    re.compile(r'(?:ask for|shoutout to|thanks? to|kudos to)\s+([A-Z][a-z]+)'),
    re.compile(r'([A-Z][a-z]+)\s+(?:was our|is our|helped us|was amazing|was great|was wonderful|was fantastic|was awesome|was so helpful|was incredibly)'),
]

NAME_DENYLIST = {
    'english', 'spanish', 'mexican', 'american', 'great', 'good', 'amazing', 'awesome',
    'wonderful', 'fantastic', 'excellent', 'perfect', 'friendly', 'attentive', 'quick',
    'fast', 'slow', 'rude', 'nice', 'super', 'very', 'extremely', 'always', 'definitely',
    'absolutely', 'overall', 'honestly', 'seriously', 'today', 'yesterday', 'monday',
    'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january',
    'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
    'october', 'november', 'december', 'manager', 'server', 'waiter', 'waitress',
    'bartender', 'host', 'hostess', 'highly', 'totally', 'usually', 'normally',
    'recently', 'forever', 'family', 'table', 'party', 'group', 'order', 'everything',
}

_WORD_RE = re.compile(r"[^a-z0-9\s']")


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def tokenize(text: str) -> list:
    text = _WORD_RE.sub(" ", text.lower())
    return [w for w in text.split() if len(w) > 2 and w not in STOP_WORDS]


def word_freq(texts: list, limit: int = 20) -> list:
    freq = Counter()
    for t in texts:
        freq.update(tokenize(t))
    return [{"word": w, "count": c} for w, c in freq.most_common(limit)]


def find_menu_items(reviews: list, top_n: int = 8) -> list:
    found = {}
    for r in reviews:
        text = (r.get("review_text") or "").lower()
        if not text:
            continue
        for item in MENU_ITEMS:
            if item in text:
                slot = found.setdefault(item, {"item": item, "count": 0, "reviews": []})
                slot["count"] += 1
                if len(slot["reviews"]) < 3:
                    slot["reviews"].append({
                        "reviewer_name": r.get("reviewer_name"),
                        "review_text": r.get("review_text"),
                    })
    return sorted(found.values(), key=lambda x: -x["count"])[:top_n]


def find_staff_names(reviews: list, top_n: int = 10) -> list:
    counts = Counter()
    by_name = {}
    positive_names = set()
    negative_names = set()

    for r in reviews:
        text = r.get("review_text") or ""
        if not text:
            continue
        stars = r.get("star_rating") or 3
        for pattern in STAFF_PATTERNS:
            for m in pattern.finditer(text):
                name = m.group(1)
                if not name or len(name) < 2 or name.lower() in NAME_DENYLIST:
                    continue
                counts[name] += 1
                by_name.setdefault(name, [])
                if len(by_name[name]) < 3:
                    by_name[name].append({
                        "reviewer_name": r.get("reviewer_name"),
                        "review_text": text,
                        "star_rating": stars,
                    })
                if stars >= 4:
                    positive_names.add(name)
                elif stars <= 2:
                    negative_names.add(name)

    return [
        {
            "name": name,
            "count": c,
            "sentiment": "negative" if name in negative_names and name not in positive_names
                          else "positive" if name in positive_names else "mixed",
            "reviews": by_name[name],
        }
        for name, c in counts.most_common() if c >= 2
    ][:top_n]


def _sentiment_bucket(r: dict) -> str | None:
    """AI-derived sentiment when available (judges actual review text, not
    just stars); falls back to star-based bucketing for reviews the pipeline
    hasn't classified yet (e.g. brand new since the last run)."""
    ai = r.get("ai_sentiment")
    if ai in ("positive", "neutral", "negative"):
        return ai
    stars = r.get("star_rating")
    if stars is None:
        return None
    if stars >= 4:
        return "positive"
    if stars == 3:
        return "neutral"
    return "negative"


def sentiment(reviews: list) -> dict:
    n = len(reviews)
    if n == 0:
        return {"n": 0, "positiveN": 0, "neutralN": 0, "badN": 0,
                "positive": 0, "neutral": 0, "bad": 0, "avgRating": None}
    rated = [r for r in reviews if r.get("star_rating") is not None]
    buckets = [_sentiment_bucket(r) for r in reviews]
    positive_n = buckets.count("positive")
    neutral_n  = buckets.count("neutral")
    bad_n      = buckets.count("negative")
    avg = round(sum(r["star_rating"] for r in rated) / len(rated), 2) if rated else None
    return {
        "n": n, "positiveN": positive_n, "neutralN": neutral_n, "badN": bad_n,
        "positive": positive_n / n * 100, "neutral": neutral_n / n * 100,
        "bad": bad_n / n * 100, "avgRating": avg,
    }


def confidence(n: int) -> dict:
    if n == 0:     return {"level": 0, "label": "No data"}
    if n < 5:      return {"level": 1, "label": "Low confidence"}
    if n < 15:     return {"level": 2, "label": "Moderate"}
    return             {"level": 3, "label": "High confidence"}


def monthly_trend(reviews: list) -> list:
    buckets = {}
    for r in reviews:
        if not r.get("review_date") or r.get("star_rating") is None:
            continue
        ym = r["review_date"][:7]
        b = buckets.setdefault(ym, {"sum": 0, "count": 0})
        b["sum"]   += r["star_rating"]
        b["count"] += 1
    return [
        {"ym": ym, "count": b["count"],
         "avg": round(b["sum"] / b["count"], 2) if b["count"] else None}
        for ym, b in sorted(buckets.items())
    ]


def compute_health_score(reviews_all: list, reviews_30d: list) -> dict:
    """
    Composite 0-100 health score weighted:
      40% average rating (30d)
      25% sentiment (% positive, 30d)
      20% response rate (unresponded / total)
      15% trend (rating delta 30d vs 60d)
    """
    rated_30 = [r for r in reviews_30d if r.get("star_rating") is not None]
    if not rated_30:
        return {"score": None, "grade": "N/A", "breakdown": {}}

    avg_30 = sum(r["star_rating"] for r in rated_30) / len(rated_30)

    today  = datetime.now(timezone.utc).date().isoformat()
    d30    = (datetime.now(timezone.utc) - timedelta(days=30)).date().isoformat()
    d60    = (datetime.now(timezone.utc) - timedelta(days=60)).date().isoformat()

    prev_30 = [r for r in reviews_all if r.get("review_date") and d60 <= r["review_date"] < d30
               and r.get("star_rating") is not None]
    prev_avg = sum(r["star_rating"] for r in prev_30) / len(prev_30) if prev_30 else avg_30

    # 1. Rating component (40 pts)
    rating_score = max(0, min(40, ((avg_30 - 1) / 4) * 40))

    # 2. Sentiment component (25 pts)
    sent = sentiment(reviews_30d)
    sentiment_score = max(0, min(25, sent["positive"] / 100 * 25))

    # 3. Response rate component (20 pts) — higher unanswered = lower score
    negative_30 = [r for r in reviews_30d if (r.get("star_rating") or 5) <= 2]
    unanswered  = sum(1 for r in negative_30 if not (r.get("owner_response") or "").strip())
    if negative_30:
        response_rate = 1 - (unanswered / len(negative_30))
    else:
        response_rate = 1.0
    response_score = max(0, min(20, response_rate * 20))

    # 4. Trend component (15 pts)
    delta = avg_30 - prev_avg
    trend_score = max(0, min(15, 7.5 + delta * 15))

    total = round(rating_score + sentiment_score + response_score + trend_score)

    if total >= 85:   grade = "A"
    elif total >= 70: grade = "B"
    elif total >= 55: grade = "C"
    elif total >= 40: grade = "D"
    else:             grade = "F"

    return {
        "score": total,
        "grade": grade,
        "breakdown": {
            "rating": round(rating_score),
            "sentiment": round(sentiment_score),
            "responseRate": round(response_score),
            "trend": round(trend_score),
        },
        "avgRating30d": round(avg_30, 2),
        "ratingDelta": round(avg_30 - prev_avg, 2),
    }


def location_stats(all_reviews: list, period_reviews: list, locations: dict) -> list:
    by_loc_all    = defaultdict(list)
    by_loc_period = defaultdict(list)
    for r in all_reviews:
        by_loc_all[r["location_id"]].append(r)
    for r in period_reviews:
        by_loc_period[r["location_id"]].append(r)

    out = []
    for loc_id, loc in locations.items():
        all_r    = by_loc_all[loc_id]
        period_r = by_loc_period[loc_id]
        rated    = [r for r in all_r if r.get("star_rating") is not None]
        lifetime_rating = round(sum(r["star_rating"] for r in rated) / len(rated), 2) if rated else None
        star_breakdown  = [{"star": s, "count": sum(1 for r in period_r if r.get("star_rating") == s)}
                           for s in range(1, 6)]
        health  = compute_health_score(all_r, period_r)
        predict = predict_rating(all_r)
        out.append({
            "name": loc["name"], "city": loc["city"], "brand": loc["brand"],
            "lifetimeRating": lifetime_rating, "lifetimeCount": len(all_r),
            "periodSentiment": sentiment(period_r), "starBreakdown": star_breakdown,
            "confidence": confidence(len(period_r)),
            "isUnverified": (not loc.get("brand") or loc["brand"] == "Other"
                             or not loc.get("city") or loc["city"] == "Unknown"),
            "spark": monthly_trend(all_r)[-6:],
            "healthScore": health,
            "predictedRating": predict,
            "predictedRatingConfidence": forecast_confidence(all_r),
        })
    return out


def rankings(period_reviews: list, prev_reviews: list, locations: dict) -> list:
    by_loc_period = defaultdict(list)
    by_loc_prev   = defaultdict(list)
    for r in period_reviews:
        by_loc_period[r["location_id"]].append(r)
    for r in prev_reviews:
        by_loc_prev[r["location_id"]].append(r)

    out = []
    for loc_id in set(by_loc_period) | set(by_loc_prev):
        loc = locations.get(loc_id)
        if not loc:
            continue
        cur, prev = by_loc_period[loc_id], by_loc_prev[loc_id]
        cur_sent, prev_sent = sentiment(cur), sentiment(prev)
        cur_conf, prev_conf = confidence(len(cur)), confidence(len(prev))
        can_compare = cur_conf["level"] >= 2 and prev_conf["level"] >= 2
        delta = round(cur_sent["positive"] - prev_sent["positive"], 1) if can_compare else None
        avg_delta = (
            round(cur_sent["avgRating"] - prev_sent["avgRating"], 2)
            if can_compare and cur_sent["avgRating"] and prev_sent["avgRating"] else None
        )
        out.append({
            "name": loc["name"], "brand": loc["brand"],
            "curN": len(cur), "prevN": len(prev),
            "curPositive": cur_sent["positive"], "prevPositive": prev_sent["positive"],
            "curAvgRating": cur_sent["avgRating"], "prevAvgRating": prev_sent["avgRating"],
            "canCompare": can_compare, "delta": delta, "avgDelta": avg_delta,
        })
    out.sort(key=lambda x: (x["curAvgRating"] or 0), reverse=True)
    return out


def _ratings_by_week(reviews: list, n_weeks: int = 8) -> list:
    """Aggregate average rating by calendar week for the timeline."""
    now = datetime.now(timezone.utc)
    result = []
    for i in range(n_weeks):
        end_dt   = (now - timedelta(days=i * 7)).date().isoformat()
        start_dt = (now - timedelta(days=(i + 1) * 7)).date().isoformat()
        week_revs = [
            r for r in reviews
            if r.get("review_date") and start_dt <= r["review_date"] < end_dt
            and r.get("star_rating") is not None
        ]
        if week_revs:
            avg = sum(r["star_rating"] for r in week_revs) / len(week_revs)
            result.append({"weekStart": start_dt, "count": len(week_revs), "avg": round(avg, 2)})
    return result


def _make_metric(value, prev, is_lower_better=False, fmt="int") -> dict:
    """Return a metric object with value, prev, change, changePct, and direction."""
    if value is None or prev is None:
        return {"value": value, "prev": prev, "change": None, "changePct": None, "direction": "stable"}
    diff = value - prev
    pct  = diff / prev * 100 if prev else 0
    if fmt == "float2":
        chg_str = f"{diff:+.2f}"
        val_out = round(value, 2)
        prev_out = round(prev, 2)
    elif fmt == "float1":
        chg_str = f"{diff:+.1f}"
        val_out = round(value, 1)
        prev_out = round(prev, 1)
    else:
        chg_str = f"{diff:+.0f}"
        val_out = int(round(value))
        prev_out = int(round(prev))
    direction = (
        ("down" if diff < 0 else "up" if diff > 0 else "stable") if is_lower_better
        else ("up" if diff > 0 else "down" if diff < 0 else "stable")
    )
    return {
        "value": val_out, "prev": prev_out,
        "change": chg_str, "changePct": f"{pct:+.0f}%",
        "direction": direction,
    }


def build_competitive_intelligence(
    reviews: list,
    period: list,
    prev_period: list,
    loc_stats: list,
    locations: dict,
    top_complaint: str | None,
    top_praise: str | None,
) -> dict:
    """Assemble the competitive intelligence payload for the CI page."""
    now = datetime.now(timezone.utc)
    d30 = (now - timedelta(days=30)).date().isoformat()

    def rated(revs):
        return [r for r in revs if r.get("star_rating") is not None]

    def avg_r(revs):
        r = rated(revs)
        return round(sum(x["star_rating"] for x in r) / len(r), 2) if r else None

    def pos_rate(revs):
        return len([r for r in revs if (r.get("star_rating") or 0) >= 4]) / max(1, len(revs)) * 100

    def resp_rate(revs):
        neg = [r for r in revs if (r.get("star_rating") or 5) <= 2]
        if not neg:
            return 100.0
        return len([r for r in neg if (r.get("owner_response") or "").strip()]) / len(neg) * 100

    # ── Metrics ──────────────────────────────────────────────────────────────
    avg_cur   = avg_r(period)
    avg_prev  = avg_r(prev_period)
    five_cur  = len([r for r in period if r.get("star_rating") == 5])
    five_prev = len([r for r in prev_period if r.get("star_rating") == 5])
    pos_cur,  pos_prev  = pos_rate(period),  pos_rate(prev_period)
    resp_cur, resp_prev = resp_rate(period), resp_rate(prev_period)
    unanswered = sum(
        1 for r in reviews
        if (r.get("star_rating") or 5) <= 2 and not (r.get("owner_response") or "").strip()
    )
    metrics = {
        "avgRating":    _make_metric(avg_cur,  avg_prev, fmt="float2"),
        "reviewCount":  _make_metric(len(period), len(prev_period)),
        "fiveStarCount": _make_metric(five_cur,  five_prev),
        "positiveRate": _make_metric(pos_cur,   pos_prev, fmt="float1"),
        "responseRate": _make_metric(resp_cur,  resp_prev, fmt="float1"),
        "unanswered":   {"value": unanswered, "prev": None, "change": None, "changePct": None,
                         "direction": "down" if unanswered > 10 else "stable"},
    }

    # ── Location Rankings ─────────────────────────────────────────────────────
    valid = [s for s in loc_stats if s.get("periodSentiment", {}).get("avgRating") is not None]
    valid.sort(key=lambda s: s["periodSentiment"]["avgRating"], reverse=True)

    by_name_prev: dict = defaultdict(list)
    for r in prev_period:
        by_name_prev[r.get("location_name", "")].append(r)
    prev_avgs = {name: avg_r(revs) for name, revs in by_name_prev.items() if avg_r(revs) is not None}
    prev_ranked = sorted(prev_avgs, key=lambda n: prev_avgs[n], reverse=True)
    prev_rank_map = {n: i + 1 for i, n in enumerate(prev_ranked)}

    location_rankings = []
    for i, loc in enumerate(valid):
        rank = i + 1
        name = loc["name"]
        pr   = prev_rank_map.get(name)
        location_rankings.append({
            "rank":         rank,
            "prevRank":     pr,
            "rankChange":   (pr - rank) if pr else 0,
            "name":         name,
            "avgRating":    loc["periodSentiment"]["avgRating"],
            "reviewCount":  loc["periodSentiment"]["n"],
            "positiveRate": round(loc["periodSentiment"]["positive"], 1),
            "healthScore":  (loc.get("healthScore") or {}).get("score"),
            "grade":        (loc.get("healthScore") or {}).get("grade"),
            "ratingDelta":  (loc.get("healthScore") or {}).get("ratingDelta"),
        })

    # ── Change Detection ──────────────────────────────────────────────────────
    changes = []
    for loc in location_rankings:
        delta = loc["ratingDelta"] or 0
        if abs(delta) >= 0.15:
            direction = "up" if delta > 0 else "down"
            changes.append({
                "id": f"rating_{slugify(loc['name'])}",
                "type": "rating_change", "direction": direction,
                "title": f"{loc['name']} rating {'improved' if direction == 'up' else 'declined'} {abs(delta):.2f}★",
                "body": f"Now averaging {loc['avgRating']:.2f}★ ({delta:+.2f} vs prior 30 days).",
                "location": loc["name"],
                "magnitude": "significant" if abs(delta) >= 0.3 else "notable",
            })
        rc = loc["rankChange"] or 0
        if abs(rc) >= 2 and loc["prevRank"]:
            direction = "up" if rc > 0 else "down"
            changes.append({
                "id": f"rank_{slugify(loc['name'])}",
                "type": "rank_change", "direction": direction,
                "title": f"{loc['name']} {'climbed' if rc > 0 else 'dropped'} to #{loc['rank']} in performance rankings",
                "body": f"Moved from #{loc['prevRank']} to #{loc['rank']} ({abs(rc)} position{'s' if abs(rc) > 1 else ''}).",
                "location": loc["name"], "magnitude": "notable",
            })
    if len(period) and len(prev_period):
        vol_d = len(period) - len(prev_period)
        vol_pct = vol_d / max(1, len(prev_period)) * 100
        if abs(vol_pct) >= 15:
            direction = "up" if vol_d > 0 else "down"
            changes.append({
                "id": "volume_change", "type": "review_volume", "direction": direction,
                "title": f"Review volume {'increased' if direction == 'up' else 'decreased'} {abs(vol_pct):.0f}%",
                "body": f"{len(period)} reviews this period vs {len(prev_period)} prior.",
                "location": None, "magnitude": "notable",
            })
    changes.sort(key=lambda c: 0 if c.get("magnitude") == "significant" else 1)

    # ── Alerts ────────────────────────────────────────────────────────────────
    alerts = []
    if location_rankings:
        top = location_rankings[0]
        alerts.append({
            "id": "top_performer", "type": "top_performer", "severity": "positive",
            "title": f"{top['name']} leads all locations at {top['avgRating']:.2f}★",
            "body": f"Health grade {top['grade']} · {top['reviewCount']} reviews this period.",
        })
    if avg_cur and avg_prev:
        diff = avg_cur - avg_prev
        if diff >= 0.05:
            alerts.append({
                "id": "rating_up", "type": "rating_trend", "severity": "positive",
                "title": f"Overall rating improved to {avg_cur:.2f}★ ({diff:+.2f})",
                "body": "Customer satisfaction is trending upward across all locations.",
            })
        elif diff <= -0.05:
            alerts.append({
                "id": "rating_down", "type": "rating_trend", "severity": "warning",
                "title": f"Overall rating softened to {avg_cur:.2f}★ ({diff:+.2f})",
                "body": f"Review top complaint themes — focus on {top_complaint or 'service and quality'}.",
            })
    if five_cur >= 10:
        alerts.append({
            "id": "five_star", "type": "five_star", "severity": "positive",
            "title": f"Earned {five_cur} five-star reviews this period",
            "body": f"{five_cur - five_prev:+d} vs prior period." if five_prev else None,
        })
    resp_diff = resp_cur - resp_prev
    if abs(resp_diff) >= 8:
        alerts.append({
            "id": "response_rate", "type": "response_rate",
            "severity": "positive" if resp_diff > 0 else "warning",
            "title": f"Response rate {'improved to' if resp_diff > 0 else 'dropped to'} {resp_cur:.0f}%",
            "body": "Keep responding — it accelerates rating recovery." if resp_diff < 0 else "Excellent customer feedback responsiveness.",
        })
    if unanswered >= 15:
        alerts.append({
            "id": "unanswered", "type": "unanswered", "severity": "danger",
            "title": f"{unanswered} negative reviews have not received a response",
            "body": "Visit Response Center to prioritize and deploy AI-drafted replies.",
        })

    # ── Trend Timeline ────────────────────────────────────────────────────────
    timeline = []
    weeks = _ratings_by_week(reviews, n_weeks=8)
    if weeks:
        best_w = max(weeks, key=lambda w: w["avg"])
        if best_w["avg"] >= 4.4:
            timeline.append({
                "date": best_w["weekStart"], "type": "positive",
                "title": f"Best rated week: {best_w['avg']:.2f}★",
                "body": f"{best_w['count']} reviews averaging {best_w['avg']:.2f}★.",
            })
    if location_rankings:
        improved = [l for l in location_rankings if (l["ratingDelta"] or 0) >= 0.2]
        declined = [l for l in location_rankings if (l["ratingDelta"] or 0) <= -0.2]
        if improved:
            top_i = max(improved, key=lambda l: l["ratingDelta"])
            timeline.append({
                "date": d30, "type": "positive",
                "title": f"{top_i['name']} improved {top_i['ratingDelta']:+.2f}★",
                "body": "Strongest single-location improvement this period.",
            })
        if declined:
            top_d = min(declined, key=lambda l: l["ratingDelta"])
            timeline.append({
                "date": d30, "type": "warning",
                "title": f"{top_d['name']} declined {top_d['ratingDelta']:+.2f}★",
                "body": "Needs operational review and proactive response engagement.",
            })
    if len(period) > 40:
        timeline.append({
            "date": d30, "type": "neutral",
            "title": f"Strong review volume: {len(period)} reviews this period",
            "body": "High engagement signals active customer base.",
        })
    timeline.sort(key=lambda t: t["date"], reverse=True)

    # ── Predictive Insights ───────────────────────────────────────────────────
    insights = []
    if avg_cur and avg_prev:
        delta = avg_cur - avg_prev
        if delta > 0.05:
            insights.append({
                "confidence": "moderate", "timeframe": "30 days", "type": "positive",
                "title": "Rating trajectory is positive",
                "body": f"Continuing current trends ({delta:+.2f}★/period), overall satisfaction is expected to improve further.",
                "location": None,
            })
        elif delta < -0.05:
            insights.append({
                "confidence": "moderate", "timeframe": "30 days", "type": "warning",
                "title": "Rating is showing a downward trend",
                "body": f"The {delta:+.2f}★ change, if unchecked, projects to continued softening. Prioritize complaint resolution.",
                "location": None,
            })
    if unanswered >= 12:
        insights.append({
            "confidence": "high", "timeframe": "ongoing", "type": "warning",
            "title": f"{unanswered} unanswered reviews pose a retention risk",
            "body": "Customers who receive no owner response are significantly less likely to update their rating upward.",
            "location": None,
        })
    positives = [l for l in location_rankings if (l["ratingDelta"] or 0) >= 0.2]
    if positives:
        p = positives[0]
        insights.append({
            "confidence": "moderate", "timeframe": "30 days", "type": "positive",
            "title": f"{p['name']} is on a strong upward trajectory",
            "body": f"With {p['ratingDelta']:+.2f}★ momentum and a grade {p['grade']}, this location is well positioned to hold its #{p['rank']} ranking.",
            "location": p["name"],
        })

    # ── Build briefing input for AI ───────────────────────────────────────────
    best_loc  = location_rankings[0]  if location_rankings else None
    worst_loc = location_rankings[-1] if location_rankings else None
    most_imp  = max(location_rankings, key=lambda l: l["ratingDelta"] or 0) if location_rankings else None
    period_str = f"{(now - timedelta(days=30)).strftime('%B %d')} – {now.strftime('%B %d, %Y')}"

    return {
        "generatedAt":        now.isoformat(),
        "period":             period_str,
        "metrics":            metrics,
        "locationRankings":   location_rankings,
        "changeDetection":    changes[:10],
        "alerts":             alerts[:8],
        "trendTimeline":      timeline[:6],
        "predictiveInsights": insights[:5],
        "weeklyBriefing":     None,
        "_briefingInput": {
            "period":           period_str,
            "location_count":   len(locations),
            "metrics":          metrics,
            "best_performer":   f"{best_loc['name']} ({best_loc['avgRating']:.2f}★)" if best_loc else "N/A",
            "worst_performer":  f"{worst_loc['name']} ({worst_loc['avgRating']:.2f}★)" if worst_loc else "N/A",
            "most_improved":    f"{most_imp['name']} ({(most_imp['ratingDelta'] or 0):+.2f}★)" if most_imp else "N/A",
            "top_complaint":    top_complaint or "service speed",
            "top_praise":       top_praise or "food quality",
        },
    }


def set_cache(conn, key: str, payload) -> None:
    new_json = json.dumps(payload, default=str)
    existing = conn.execute(
        "SELECT payload FROM analytics_cache WHERE cache_key = ?", (key,)
    ).fetchone()
    if existing and existing["payload"] == new_json:
        return
    conn.execute(
        """INSERT INTO analytics_cache (cache_key, computed_at, payload) VALUES (?, datetime('now'), ?)
           ON CONFLICT(cache_key) DO UPDATE SET computed_at = datetime('now'), payload = excluded.payload""",
        (key, new_json),
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

# Cap AI sentiment/priority classification per pipeline run so a large backlog
# (e.g. right after enabling this feature) can't blow past rate limits or
# stall the 6-hour cadence -- backfill_sentiment.py handles the full history.
CLASSIFY_LIMIT_PER_RUN = 300


def main():
    """Multi-Tenant Phase 4D revision: --tenant-id is REQUIRED, no default.
    Resolved before any DB connection, so a missing/invalid/unregistered
    tenant fails closed before touching anything."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose review database to analyze. REQUIRED -- no "
                              "default. This script never infers a tenant on its own.")
    args = parser.parse_args()
    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::refresh_analytics.py: invalid --tenant-id {args.tenant_id!r}")
        sys.exit(1)
    try:
        db.DB_PATH = tenant_paths.resolve_review_db_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::refresh_analytics.py: {e}")
        sys.exit(1)

    conn = db.get_connection()
    db.init_schema(conn)

    rows = conn.execute(
        """SELECT r.*, l.name AS location_name, l.city AS city, l.brand AS brand
           FROM reviews r JOIN locations l ON l.id = r.location_id
           WHERE r.is_deleted = 0"""
    ).fetchall()
    reviews  = [dict(r) for r in rows]
    locations = {row["id"]: dict(row) for row in conn.execute("SELECT * FROM locations").fetchall()}

    # --- AI sentiment + priority classification (server-side, cached by content hash) ---
    if ai_engine.is_available():
        to_classify = db.get_reviews_needing_classification(conn, limit=CLASSIFY_LIMIT_PER_RUN)
        if to_classify:
            classified = ai_engine.classify_reviews_batch(to_classify)
            for r in to_classify:
                result = classified.get(r["id"])
                if not result:
                    continue
                content_hash = db.review_content_hash(r["review_text"], r["star_rating"])
                db.save_ai_classification(
                    conn, r["id"], result["sentiment"], result["reason"], result["priority"], content_hash,
                )
            conn.commit()
            print(f"[ai] Classified {len(classified)}/{len(to_classify)} reviews this run")
            # Re-fetch so downstream analytics see the freshly classified rows
            rows = conn.execute(
                """SELECT r.*, l.name AS location_name, l.city AS city, l.brand AS brand
                   FROM reviews r JOIN locations l ON l.id = r.location_id
                   WHERE r.is_deleted = 0"""
            ).fetchall()
            reviews = [dict(r) for r in rows]

    now   = datetime.now(timezone.utc)
    today = now.date().isoformat()
    d30   = (now - timedelta(days=30)).date().isoformat()
    d60   = (now - timedelta(days=60)).date().isoformat()
    d90   = (now - timedelta(days=90)).date().isoformat()

    period      = [r for r in reviews if r.get("review_date") and d30 <= r["review_date"] <= today]
    prev_period = [r for r in reviews if r.get("review_date") and d60 <= r["review_date"] < d30]
    recent_90   = [r for r in reviews if r.get("review_date") and r["review_date"] >= d90]

    # --- KPIs ---
    rated = [r for r in reviews if r.get("star_rating") is not None]
    rated_30 = [r for r in period if r.get("star_rating") is not None]
    avg_30   = round(sum(r["star_rating"] for r in rated_30) / len(rated_30), 2) if rated_30 else None

    prev_rated = [r for r in prev_period if r.get("star_rating") is not None]
    prev_avg_30 = round(sum(r["star_rating"] for r in prev_rated) / len(prev_rated), 2) if prev_rated else None
    rating_delta = round(avg_30 - prev_avg_30, 2) if avg_30 and prev_avg_30 else 0.0

    unanswered = sum(
        1 for r in reviews
        if (r.get("star_rating") or 5) <= 2 and not (r.get("owner_response") or "").strip()
    )
    company_health = compute_health_score(reviews, period)

    # Company-wide lifetime star distribution -- added for Phase 2 Milestone 5
    # so the per-location analytics artifacts (below) have a single company
    # total to reconcile against (sum of every location's own lifetime star
    # distribution must equal this). Purely additive to the existing kpis
    # cache entry -- every field already here is unchanged.
    company_star_breakdown = [
        {"star": s, "count": sum(1 for r in rated if r["star_rating"] == s)}
        for s in range(1, 6)
    ]

    kpis = {
        "totalReviews":      len(reviews),
        "totalLocations":    len(locations),
        "lifetimeAvgRating": round(sum(r["star_rating"] for r in rated) / len(rated), 2) if rated else None,
        "period30dSentiment": sentiment(period),
        "avgRating30d":      avg_30,
        "ratingDelta30d":    rating_delta,
        "unansweredCount":   unanswered,
        "healthScore":       company_health,
        "starBreakdown":     company_star_breakdown,
        "computedAt":        now.isoformat(),
    }
    set_cache(conn, "kpis", kpis)

    # --- Standard caches ---
    set_cache(conn, "monthly_trend", monthly_trend(reviews))

    loc_stats = location_stats(reviews, period, locations)
    set_cache(conn, "location_stats", loc_stats)
    set_cache(conn, "rankings_30d", rankings(period, prev_period, locations))

    # --- Complaint intelligence ---
    intel = build_complaint_intelligence(reviews, period, prev_period)
    set_cache(conn, "complaint_intelligence", intel)
    _top_complaint = intel["complaints"][0]["name"] if intel["complaints"] else None
    _top_praise    = intel["praises"][0]["name"]    if intel["praises"]    else None

    # --- Department performance (company-wide) ---
    set_cache(conn, "department_performance", build_department_summary(intel))

    # --- Customer Experience Index (company-wide) ---
    cx_idx = build_cx_index(intel)
    set_cache(conn, "cx_index", cx_idx)

    # --- Marketing Intelligence extras (company-wide) ---
    set_cache(conn, "best_quotes", build_best_quotes(intel))
    set_cache(conn, "seasonal_trends", build_seasonal_trends(reviews))

    # --- Location-level intelligence ---
    by_loc_all    = defaultdict(list)
    by_loc_30     = defaultdict(list)
    for r in reviews:
        by_loc_all[r["location_id"]].append(r)
    for r in period:
        by_loc_30[r["location_id"]].append(r)

    best_staff = None    # accumulated across locations, for the Action Center's recognition action
    consistency = []     # accumulated across locations, for the Operations Impact Center
    staff_sentiment_totals = {"positive": 0, "negative": 0, "mixed": 0}  # for the Executive Dashboard's manager-performance proxy

    for loc_id, loc in locations.items():
        all_r    = by_loc_all[loc_id]
        period_r = by_loc_30[loc_id]
        recent_90_r = [r for r in all_r if r.get("review_date") and r["review_date"] >= d90]

        loc_intel = build_complaint_intelligence(all_r, period_r,
            [r for r in reviews if r["location_id"] == loc_id
             and r.get("review_date") and d60 <= r["review_date"] < d30])

        loc_staff  = find_staff_names(recent_90_r)
        for s in loc_staff:
            staff_sentiment_totals[s["sentiment"]] = staff_sentiment_totals.get(s["sentiment"], 0) + s["count"]
            if s["sentiment"] == "positive" and (best_staff is None or s["count"] > best_staff["count"]):
                best_staff = {"name": s["name"], "location": loc["name"], "count": s["count"]}
        loc_menu   = find_menu_items(recent_90_r)
        loc_trend  = monthly_trend(all_r)
        consistency.append({"name": loc["name"], "variance": _rating_variance(loc_trend)})
        loc_health = compute_health_score(all_r, period_r)
        loc_pred   = predict_rating(all_r)
        loc_pred_confidence = forecast_confidence(all_r)
        loc_vol    = predict_volume(all_r)
        loc_alert  = rating_trend_alert(all_r, loc["name"])

        rated_loc_30 = [r for r in period_r if r.get("star_rating") is not None]
        loc_avg_30 = round(sum(r["star_rating"] for r in rated_loc_30) / len(rated_loc_30), 2) if rated_loc_30 else None
        prev_loc_rated = [r for r in reviews if r["location_id"] == loc_id
                          and r.get("review_date") and d60 <= r["review_date"] < d30
                          and r.get("star_rating") is not None]
        prev_loc_avg = round(sum(r["star_rating"] for r in prev_loc_rated) / len(prev_loc_rated), 2) if prev_loc_rated else None
        loc_delta = round(loc_avg_30 - prev_loc_avg, 2) if loc_avg_30 and prev_loc_avg else 0.0

        unanswered_neg = sum(
            1 for r in all_r
            if (r.get("star_rating") or 5) <= 2 and not (r.get("owner_response") or "").strip()
        )

        praised_staff = [s["name"] for s in loc_staff if s["sentiment"] == "positive"]

        top_complaint = loc_intel["complaints"][0]["name"] if loc_intel["complaints"] else None
        top_praise    = loc_intel["praises"][0]["name"] if loc_intel["praises"] else None

        loc_summary_data = {
            "location_name": loc["name"],
            "period_reviews": len(period_r),
            "avg_rating": loc_avg_30 or 0,
            "rating_delta": loc_delta,
            "positive_pct": sentiment(period_r)["positive"],
            "top_complaint": top_complaint,
            "top_praise": top_praise,
            "praised_staff": praised_staff,
            "unanswered_negative": unanswered_neg,
            "prediction_30d": loc_pred,
        }

        ai_summary = ai_engine.generate_location_summary(loc_summary_data) if ai_engine.is_available() else None

        slug = slugify(loc["name"])
        set_cache(conn, f"location_detail_{slug}", {
            "name": loc["name"], "city": loc["city"], "brand": loc["brand"],
            "healthScore": loc_health,
            "avgRating30d": loc_avg_30,
            "ratingDelta": loc_delta,
            "predictedRating": loc_pred,
            "predictedRatingConfidence": loc_pred_confidence,
            "predictedVolume": loc_vol,
            "trendAlert": loc_alert,
            "sentiment30d": sentiment(period_r),
            "monthlyTrend": loc_trend,
            "complaints": loc_intel["complaints"],
            "praises": loc_intel["praises"],
            "staffMentions": loc_staff,
            "menuHighlights": loc_menu,
            "aiSummary": ai_summary,
            "cxIndex": build_cx_index(loc_intel),
        })

        # --- Phase 2 Milestone 5 (Option C): canonical per-location analytics ---
        # Everything below reuses values already computed above in this same
        # loop iteration (loc_health, loc_trend, loc_intel, loc_staff,
        # loc_menu, ai_summary, loc_pred*, loc_alert) plus one new call to
        # the existing build_department_summary() -- the same shared
        # function company-wide "department_performance" already uses,
        # given this location's own loc_intel instead of the company-wide
        # intel. No calculation is duplicated; this is strictly a new,
        # canonical-locationId-keyed packaging of data this loop already
        # produces, plus two new lightweight aggregates (lifetime review
        # count and lifetime star distribution) computed directly from the
        # already-filtered all_r list.
        #
        # Deliberately EXCLUDED (per the architecture's location/company
        # separation): rankings(), build_action_center(), and
        # build_operations_impact() all compare or rank across locations --
        # those remain company-wide only and must never appear here.
        rated_all_r = [r for r in all_r if r.get("star_rating") is not None]
        lifetime_rating = round(sum(r["star_rating"] for r in rated_all_r) / len(rated_all_r), 2) if rated_all_r else None
        star_breakdown_lifetime = [
            {"star": s, "count": sum(1 for r in rated_all_r if r["star_rating"] == s)}
            for s in range(1, 6)
        ]

        set_cache(conn, f"analytics_location_{loc_id}", {
            "locationId": loc_id,
            "name": loc["name"], "city": loc["city"], "brand": loc["brand"],
            "reviewCounts": {
                "lifetime": len(all_r),
                "last30d": len(period_r),
            },
            "averageRating": {
                "lifetime": lifetime_rating,
                "last30d": loc_avg_30,
                "delta30d": loc_delta,
            },
            "starDistribution": {
                "lifetime": star_breakdown_lifetime,
            },
            "responseMetrics": {
                "unansweredNegative": unanswered_neg,
                "healthScore": loc_health,
            },
            "trends": {
                "monthly": loc_trend,
                "trendAlert": loc_alert,
            },
            "prediction": {
                "predictedRating": loc_pred,
                "predictedRatingConfidence": loc_pred_confidence,
                "predictedVolume": loc_vol,
            },
            "departmentMetrics": build_department_summary(loc_intel),
            "keywords": {
                "menuHighlights": loc_menu,
            },
            "aiSummary": ai_summary,
            "complaints": loc_intel["complaints"],
            "praises": loc_intel["praises"],
            "staffMentions": loc_staff,
            "cxIndex": build_cx_index(loc_intel),
            "sentiment30d": sentiment(period_r),
            "computedAt": now.isoformat(),
        })

    # --- AI Action Center (company-wide) ---
    set_cache(conn, "action_center", build_action_center(intel, best_staff))

    # --- Operations Impact Center (company-wide) ---
    set_cache(conn, "operations_impact", build_operations_impact(intel, loc_stats, consistency))

    # --- Predictive alerts (company-wide) ---
    by_loc_prev = defaultdict(list)
    for r in prev_period:
        by_loc_prev[r["location_id"]].append(r)
    by_loc_recent_90 = defaultdict(list)
    for r in reviews:
        if r.get("review_date") and r["review_date"] >= d90:
            by_loc_recent_90[r["location_id"]].append(r)

    alerts = []
    for loc_id, loc in locations.items():
        loc_all    = by_loc_all[loc_id]
        loc_cur    = by_loc_30[loc_id]
        loc_prev   = by_loc_prev[loc_id]
        loc_recent = by_loc_recent_90[loc_id]
        for alert_fn, args in (
            (rating_trend_alert,     (loc_all, loc["name"])),
            (negative_spike_alert,   (loc_recent, loc["name"])),  # recent window -- an old spike isn't "actionable today"
            (volume_drop_alert,      (loc_cur, loc_prev, loc["name"])),
            (stale_reply_alert,      (loc_all, loc["name"])),
            (sentiment_shift_alert,  (loc_cur, loc_prev, loc["name"])),
            (critical_review_alert,  (loc_recent, loc["name"])),  # recent window, same reasoning as negative_spike_alert
        ):
            alert = alert_fn(*args)
            if alert:
                alerts.append(alert)
    set_cache(conn, "predictive_alerts", alerts)

    # --- Executive Dashboard scores (company-wide) ---
    set_cache(conn, "executive_scores", build_executive_scores(
        company_health, avg_30, rating_delta, sentiment(period), unanswered,
        intel, cx_idx, loc_stats, alerts, consistency, staff_sentiment_totals,
        len(period), len(prev_period), len(locations),
    ))

    # --- Company AI executive summary ---
    rated_all_locs = [
        s for s in loc_stats if s.get("periodSentiment", {}).get("avgRating") is not None
    ]
    if rated_all_locs:
        sorted_locs = sorted(rated_all_locs,
                             key=lambda s: s["periodSentiment"]["avgRating"] or 0)
        worst = sorted_locs[0]
        best  = sorted_locs[-1]
        top_complaint_name = _top_complaint or "none identified"
        top_praise_name    = _top_praise    or "none identified"
        sent30 = sentiment(period)

        ai_data = {
            "total_locations": len(locations),
            "period_reviews":  len(period),
            "avg_rating":      avg_30 or 0,
            "rating_delta":    rating_delta,
            "positive_pct":    sent30["positive"],
            "negative_pct":    sent30["bad"],
            "unanswered_count": unanswered,
            "best_location":   best["name"],
            "best_rating":     best["periodSentiment"]["avgRating"] or 0,
            "worst_location":  worst["name"],
            "worst_rating":    worst["periodSentiment"]["avgRating"] or 0,
            "top_complaint":   top_complaint_name,
            "top_praise":      top_praise_name,
            "locations_above_4": sum(
                1 for s in rated_all_locs
                if (s["periodSentiment"]["avgRating"] or 0) >= 4.0
            ),
        }

        ai_summary = ai_engine.generate_company_summary(ai_data) if ai_engine.is_available() else None
        set_cache(conn, "ai_company_summary", ai_summary or {"text": None})

    # --- Response drafts ---
    existing_draft_keys = {
        row["cache_key"]
        for row in conn.execute(
            "SELECT cache_key FROM analytics_cache WHERE cache_key LIKE 'draft_%'"
        ).fetchall()
    }
    loc_map = {loc_id: dict(loc) for loc_id, loc in locations.items()}
    new_drafts = ai_engine.batch_generate_drafts(reviews, loc_map, existing_draft_keys)
    for key, draft in new_drafts.items():
        set_cache(conn, key, draft)
    if new_drafts:
        print(f"[ai] Generated {len(new_drafts)} new response drafts")

    # --- Competitive intelligence ---
    comp_intel = build_competitive_intelligence(
        reviews, period, prev_period, loc_stats, locations,
        _top_complaint, _top_praise,
    )
    briefing = ai_engine.generate_competitive_briefing(comp_intel["_briefingInput"]) if ai_engine.is_available() else None
    if briefing:
        comp_intel["weeklyBriefing"] = briefing
    del comp_intel["_briefingInput"]
    set_cache(conn, "competitive_intelligence", comp_intel)

    conn.commit()
    conn.close()
    print(f"Analytics refreshed: {len(reviews)} reviews, {len(locations)} locations | AI={'on' if ai_engine.is_available() else 'off'}")


if __name__ == "__main__":
    main()
