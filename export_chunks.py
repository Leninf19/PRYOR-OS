"""
export_chunks.py - Export Agent (Milestone 3).

Reads dashboard/reviews.db and writes a set of small, purpose-built JSON
files into dashboard/private-data/ -- a directory OUTSIDE dashboard/public/,
so Vercel never serves these files as static assets. The frontend reaches
them only through the authenticated dashboard/api/data/[...path].js
endpoint (session-gated, path-allowlisted), not by direct fetch().

This directory was dashboard/public/data/ until raw review content, AI
sentiment/priority fields, and other operational data were found to be
reachable by anyone who guessed the URL -- see README "Standing rule:
sensitive data must never be written into a publicly served directory".
Do not add a new export target under dashboard/public/ for anything beyond
truly public, anonymous-safe assets (icons, manifest, etc).

Most of the heavy aggregation (KPIs, trends, location stats, rankings,
insights) is already computed by refresh_analytics.py into analytics_cache
-- this script just dumps those plus raw per-location review rows (for
ReviewExplorer/LocationDetail) and a few derived views (action items,
scraper status, validation summary) the frontend still needs in row form
rather than pre-aggregated form.
"""
import csv
import json
import re
from collections import Counter
from datetime import datetime, timedelta, timezone

import db

STOP_WORDS = {
    'a','an','the','is','are','was','were','be','been','have','has','had',
    'do','does','did','will','would','could','should','to','of','in','for',
    'on','with','at','by','from','and','or','but','not','this','that','it',
    'its','we','you','he','she','they','i','me','us','him','her','our',
    'just','got','go','get','came','come','also','very','really','good',
    'great','nice','bad','ok','okay','food','place','restaurant','time',
    'service','staff','always','never','still','now','even','back','out',
}

PRIVATE_DATA_DIR = db.BASE_DIR / "dashboard" / "private-data"


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def write_json(rel_path: str, payload) -> None:
    path = PRIVATE_DATA_DIR / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def review_to_dict(r, loc) -> dict:
    return {
        # Canonical, stable numeric location identifier -- the same
        # locations.id (dashboard/reviews.db) that account locationIds will
        # reference once location-scoped accounts exist (Phase 2 Milestone
        # 6+). Never derived from name/slug/array position, so it survives
        # a location rename untouched.
        "locationId": loc["id"],
        "location_name": loc["name"], "city": loc["city"],
        "reviewer_name": r["reviewer_name"], "review_date": r["review_date"],
        "star_rating": r["star_rating"], "review_text": r["review_text"],
        "owner_response": r["owner_response"], "review_url": r["review_url"],
        "response_status": "responded" if (r["owner_response"] or "").strip() else "unanswered",
        "review_id": db.canonical_review_id(r["review_url"] or "") or "",
        "last_checked_at": r["last_seen_at"] or "",
        "ai_sentiment": r["ai_sentiment"] if "ai_sentiment" in r.keys() else None,
        "ai_sentiment_reason": r["ai_sentiment_reason"] if "ai_sentiment_reason" in r.keys() else None,
        "ai_priority": r["ai_priority"] if "ai_priority" in r.keys() else None,
        "gbp_review_name": r["gbp_review_name"] if "gbp_review_name" in r.keys() else None,
    }


def export_reviews_csv(conn, out_path=None) -> None:
    """Regenerates dashboard/reviews.csv from the database. weekly_report.py
    reads this file directly (no DB access) -- it used to be written by
    auto_update.py's scraper as a side effect of scraping; now that
    gbp_sync.py is the active sync path and writes only to the SQLite DB,
    this keeps that CSV (and weekly_report.py) working unchanged."""
    path = out_path or (db.BASE_DIR / "dashboard" / "reviews.csv")
    rows = conn.execute(
        """SELECT r.reviewer_name, r.review_date, r.star_rating, r.review_text,
                  r.owner_response, r.review_url, l.name AS location_name, l.city AS city
           FROM reviews r JOIN locations l ON l.id = r.location_id
           WHERE r.is_deleted = 0 ORDER BY r.review_date"""
    ).fetchall()
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, quoting=csv.QUOTE_ALL)
        writer.writerow(["location_name", "city", "reviewer_name", "review_date",
                          "star_rating", "review_text", "owner_response", "review_url"])
        for r in rows:
            writer.writerow([r["location_name"], r["city"], r["reviewer_name"], r["review_date"],
                              r["star_rating"], r["review_text"], r["owner_response"], r["review_url"]])


def export_meta(conn, locations: dict) -> None:
    loc_list = [
        {
            "locationId": l["id"],
            "name": l["name"], "city": l["city"], "brand": l["brand"],
            "slug": slugify(l["name"]), "maps_url": l.get("maps_url") or "",
            # Restaurant bad-review email workflow: a safe boolean signal
            # only -- lets the UI disable "Send to Restaurant" for an
            # unconfigured location without ever exposing the actual
            # contact email address here. The real address is served only
            # by dashboard/api/actions/[action].js's preview-review-email
            # action, read server-side from location-contacts.json (never
            # added to this file's own allowlist -- see that export).
            "hasContact": bool(l.get("contact_email") and l.get("contact_active")),
        }
        for l in locations.values()
    ]
    total = conn.execute("SELECT COUNT(*) AS c FROM reviews WHERE is_deleted = 0").fetchone()["c"]
    write_json("meta.json", {
        "locations": sorted(loc_list, key=lambda l: l["name"]),
        "brands": sorted({l["brand"] for l in loc_list if l["brand"]}),
        "totalReviews": total,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    })


def export_location_contacts(locations: dict) -> None:
    """Restaurant bad-review email workflow: the authoritative
    location-id -> contact-email mapping, keyed by the same numeric
    locations.id every review already carries as locationId.

    Deliberately NEVER added to dashboard/api/data.js's EXACT_ALLOWLIST/
    DYNAMIC_ALLOWLIST -- the browser must never be able to fetch this file
    directly, authenticated or not (see README "Do not expose the full
    contact directory"). Only dashboard/api/actions/[action].js reads it,
    directly off disk server-side, exactly the way data.js itself reads
    private-data files -- and it only ever returns the ONE resolved
    recipient for the location being acted on, never the whole file.

    Only includes locations with a configured, active contact -- an
    unconfigured location is simply absent from this file, so a lookup
    miss is the correct, unambiguous "not configured" signal downstream."""
    out = {
        str(loc_id): {
            "email": l["contact_email"],
            "name": l.get("contact_name") or None,
        }
        for loc_id, l in locations.items()
        if l.get("contact_email") and l.get("contact_active")
    }
    write_json("location-contacts.json", out)


def export_analytics_cache(conn) -> None:
    rows = conn.execute("SELECT cache_key, payload FROM analytics_cache").fetchall()
    by_key = {r["cache_key"]: json.loads(r["payload"]) for r in rows}

    for key in ("kpis", "monthly_trend", "location_stats", "rankings_30d"):
        if key in by_key:
            write_json(f"analytics/{key.replace('_', '-')}.json", by_key[key])

    if "insights_90d_all" in by_key:
        write_json("insights/all.json", by_key["insights_90d_all"])
    for key, payload in by_key.items():
        if key.startswith("insights_90d_") and key != "insights_90d_all":
            write_json(f"insights/{key[len('insights_90d_'):]}.json", payload)


def export_location_analytics(conn, locations: dict) -> None:
    """
    Phase 2 Milestone 5 (Option C): one canonical analytics artifact per
    location, under analytics/locations/<locationId>.json -- keyed by the
    same numeric locations.id Milestone 4 established, never a slug. This
    is ADDITIVE alongside the existing company-wide analytics/*.json files
    (export_analytics_cache above), which are untouched.

    refresh_analytics.py computes the payload (analytics_location_<id> in
    analytics_cache) using the same shared aggregation functions the
    company-wide analytics use, just fed this location's own filtered
    review list -- this function only reads that already-computed payload
    and writes it through, exactly like export_analytics_cache does for the
    company-wide files.
    """
    rows = conn.execute(
        "SELECT cache_key, payload FROM analytics_cache WHERE cache_key LIKE 'analytics_location_%'"
    ).fetchall()
    by_key = {r["cache_key"]: json.loads(r["payload"]) for r in rows}

    for loc_id in locations:
        key = f"analytics_location_{loc_id}"
        if key in by_key:
            write_json(f"analytics/locations/{loc_id}.json", by_key[key])


def validate_location_analytics(conn, locations: dict) -> tuple:
    """
    Post-export integrity check for the per-location analytics artifacts
    written by export_location_analytics() above. Reads what was actually
    written to PRIVATE_DATA_DIR (not analytics_cache), so it catches an
    export bug as well as a computation bug, and independently re-queries
    the database for each location's true review count rather than trusting
    the artifact's own claim -- the strongest available check against
    cross-location contamination or a miscounted export.

    Returns (ok, issues, details): ok is False if ANY check fails; issues is
    a list of human-readable problem descriptions; details carries the raw
    reconciliation numbers for reporting.
    """
    issues = []
    details = {}

    loc_dir = PRIVATE_DATA_DIR / "analytics" / "locations"
    files = sorted(loc_dir.glob("*.json")) if loc_dir.exists() else []

    by_loc_id = {}
    for f in files:
        stem = f.stem
        try:
            loc_id = int(stem)
        except ValueError:
            issues.append(f"analytics/locations/{f.name}: filename is not a canonical integer locationId")
            continue
        if loc_id in by_loc_id:
            issues.append(f"duplicate analytics artifact for location id {loc_id} (filename {f.name})")
            continue
        try:
            by_loc_id[loc_id] = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            issues.append(f"analytics/locations/{f.name}: not valid JSON")

    missing = sorted(set(locations.keys()) - set(by_loc_id.keys()))
    if missing:
        issues.append(f"location(s) missing an analytics artifact: {missing}")

    orphans = sorted(set(by_loc_id.keys()) - set(locations.keys()))
    if orphans:
        issues.append(f"orphan location analytics for unknown location id(s): {orphans}")

    for loc_id, payload in by_loc_id.items():
        declared = payload.get("locationId")
        if declared is None:
            issues.append(f"location {loc_id}: analytics artifact is missing its locationId field")
        elif declared != loc_id:
            issues.append(f"location {loc_id}: filename/content locationId mismatch (filename={loc_id}, content={declared})")

        if loc_id in locations:
            independent_count = conn.execute(
                "SELECT COUNT(*) AS c FROM reviews WHERE location_id = ? AND is_deleted = 0", (loc_id,)
            ).fetchone()["c"]
            claimed_count = payload.get("reviewCounts", {}).get("lifetime")
            if claimed_count != independent_count:
                issues.append(
                    f"location {loc_id}: artifact claims {claimed_count} lifetime reviews, but an "
                    f"independent database count finds {independent_count} -- possible cross-location "
                    f"contamination or a stale/miscounted export"
                )

    kpis_path = PRIVATE_DATA_DIR / "analytics" / "kpis.json"
    if kpis_path.exists():
        kpis = json.loads(kpis_path.read_text(encoding="utf-8"))
        company_total = kpis.get("totalReviews")
        company_avg = kpis.get("lifetimeAvgRating")
        company_star = {e["star"]: e["count"] for e in (kpis.get("starBreakdown") or [])}

        sum_reviews = sum((p.get("reviewCounts", {}).get("lifetime") or 0) for p in by_loc_id.values())
        details["companyReviewTotal"] = company_total
        details["sumLocationReviewTotals"] = sum_reviews
        if company_total is not None and sum_reviews != company_total:
            issues.append(f"sum of location review counts ({sum_reviews}) != company review total ({company_total})")

        weighted_sum, weighted_n = 0.0, 0
        for p in by_loc_id.values():
            n = p.get("reviewCounts", {}).get("lifetime") or 0
            avg = p.get("averageRating", {}).get("lifetime")
            if avg is not None and n:
                weighted_sum += avg * n
                weighted_n += n
        reconstructed_avg = round(weighted_sum / weighted_n, 2) if weighted_n else None
        details["companyAverageRating"] = company_avg
        details["reconstructedAverageRating"] = reconstructed_avg
        if company_avg is not None and reconstructed_avg is not None and abs(company_avg - reconstructed_avg) > 0.02:
            issues.append(
                f"reconstructed average rating ({reconstructed_avg}) does not reconcile with company average ({company_avg})"
            )

        summed_star = {}
        for p in by_loc_id.values():
            for entry in p.get("starDistribution", {}).get("lifetime", []):
                summed_star[entry["star"]] = summed_star.get(entry["star"], 0) + entry["count"]
        details["companyStarDistribution"] = company_star
        details["reconstructedStarDistribution"] = summed_star
        if company_star and summed_star != company_star:
            issues.append("reconstructed star distribution does not match company star distribution")

    details["locationAnalyticsGenerated"] = len(by_loc_id)
    details["locationsMissingAnalytics"] = missing
    details["orphanAnalytics"] = orphans

    return len(issues) == 0, issues, details


def export_reviews_by_location(conn, locations: dict) -> None:
    for loc_id, loc in locations.items():
        rows = conn.execute(
            "SELECT * FROM reviews WHERE location_id = ? AND is_deleted = 0 ORDER BY review_date",
            (loc_id,),
        ).fetchall()
        write_json(f"reviews/by-location/{slugify(loc['name'])}.json",
                   [review_to_dict(r, loc) for r in rows])


def export_action_items(conn, locations: dict) -> None:
    """Ports ActionItems.jsx's exact filters -- unanswered <=2-star reviews,
    plus 30d-vs-60d avg trend per location -- so the page renders identically
    off the precomputed chunk instead of recomputing from 16k rows client-side."""
    rows = conn.execute(
        """SELECT r.*, l.id AS loc_id, l.name AS location_name, l.city AS city
           FROM reviews r JOIN locations l ON l.id = r.location_id
           WHERE r.is_deleted = 0"""
    ).fetchall()
    unanswered = [
        review_to_dict(r, locations[r["loc_id"]])
        for r in rows
        if r["star_rating"] is not None and r["star_rating"] <= 2 and not (r["owner_response"] or "").strip()
    ]
    unanswered.sort(key=lambda r: r["review_date"] or "", reverse=True)

    d30 = (datetime.now(timezone.utc) - timedelta(days=30)).date().isoformat()
    d60 = (datetime.now(timezone.utc) - timedelta(days=60)).date().isoformat()

    trend = []
    for loc_id, loc in locations.items():
        cur = [r["star_rating"] for r in rows
               if r["loc_id"] == loc_id and r["star_rating"] is not None
               and r["review_date"] and r["review_date"] >= d30]
        prev = [r["star_rating"] for r in rows
                if r["loc_id"] == loc_id and r["star_rating"] is not None
                and r["review_date"] and d60 <= r["review_date"] < d30]
        if len(cur) >= 5 and len(prev) >= 5:
            avg_cur, avg_prev = sum(cur) / len(cur), sum(prev) / len(prev)
            if abs(avg_cur - avg_prev) >= 0.2:
                trend.append({
                    "locationId": loc_id,
                    "name": loc["name"], "avgCur": round(avg_cur, 2), "avgPrev": round(avg_prev, 2),
                    "delta": round(avg_cur - avg_prev, 2), "curN": len(cur), "prevN": len(prev),
                })

    write_json("action-items.json", {"unanswered": unanswered, "trendAlerts": trend})


def export_validation(conn) -> None:
    rows = conn.execute(
        """SELECT flag_type, location_id, detail, detected_at FROM validation_flags
           WHERE resolved_at IS NULL ORDER BY detected_at DESC"""
    ).fetchall()
    # location_id (snake_case) already comes straight off the table; locationId
    # is added alongside as the canonical field name used everywhere else in
    # this file -- location_id is left in place, not renamed, since it's an
    # additive change. A flag with no specific location (a company-wide
    # validation issue) keeps location_id/locationId as None, same as today.
    write_json("validation.json", [{**dict(r), "locationId": r["location_id"]} for r in rows])


def top_complaint_words(rows, n=8):
    words = Counter()
    for r in rows:
        text = (r["review_text"] or "").lower()
        text = re.sub(r"[^a-z\s]", " ", text)
        for w in text.split():
            if len(w) > 3 and w not in STOP_WORDS:
                words[w] += 1
    return words.most_common(n)


def export_weekly_report(conn, locations: dict) -> None:
    """Ports weekly_report.py's metrics (not its HTML) into a JSON chunk so
    the Reports page can render the same numbers the Monday email already
    sends, without re-reading reviews.csv client-side."""
    rows = conn.execute(
        """SELECT r.*, l.id AS loc_id, l.name AS location_name
           FROM reviews r JOIN locations l ON l.id = r.location_id
           WHERE r.is_deleted = 0"""
    ).fetchall()

    now = datetime.now(timezone.utc)
    d7  = (now - timedelta(days=7)).date().isoformat()
    d30 = (now - timedelta(days=30)).date().isoformat()
    d60 = (now - timedelta(days=60)).date().isoformat()

    new_reviews = [r for r in rows if r["review_date"] and r["review_date"] >= d7]
    by_location = dict(Counter(r["location_name"] for r in new_reviews))

    avg_now, avg_prev = {}, {}
    for loc in locations.values():
        cur  = [r["star_rating"] for r in rows if r["loc_id"] == loc["id"]
                and r["review_date"] and r["review_date"] >= d30]
        prev = [r["star_rating"] for r in rows if r["loc_id"] == loc["id"]
                and r["review_date"] and d60 <= r["review_date"] < d30]
        if cur:  avg_now[loc["name"]]  = sum(cur) / len(cur)
        if prev: avg_prev[loc["name"]] = sum(prev) / len(prev)

    unanswered = sum(
        1 for r in rows
        if r["star_rating"] is not None and r["star_rating"] <= 2 and not (r["owner_response"] or "").strip()
    )

    neg_this_week = [r for r in new_reviews if r["star_rating"] is not None and r["star_rating"] <= 2]
    complaints = top_complaint_words(neg_this_week) if neg_this_week else []

    week_str = f"Week of {(now - timedelta(days=7)).strftime('%B %d')} – {now.strftime('%B %d, %Y')}"

    write_json("reports/weekly-summary.json", {
        "weekStr": week_str,
        "generatedAt": now.isoformat(),
        "totalNew": len(new_reviews),
        "byLocation": by_location,
        "avgNow": avg_now,
        "avgPrev": avg_prev,
        "unanswered": unanswered,
        "complaints": complaints,
    })


def export_gbp_sync_status(conn, locations: dict) -> None:
    """Per-location Google Business Profile linkage + sync state, plus the
    most recent api_sync run, for the Settings -> Connection Center's
    Location Sync view. Read-only summary of columns gbp_sync.py maintains."""
    loc_list = [
        {
            "locationId": l["id"],
            "name": l["name"], "city": l["city"], "brand": l["brand"],
            "slug": slugify(l["name"]),
            "linked": bool(l.get("gbp_location_name")),
            "gbp_verification_status": l.get("gbp_verification_status"),
            "gbp_last_synced_at": l.get("gbp_last_synced_at"),
            "review_count": conn.execute(
                "SELECT COUNT(*) AS c FROM reviews WHERE location_id = ? AND is_deleted = 0",
                (l["id"],),
            ).fetchone()["c"],
        }
        for l in locations.values()
    ]
    last_run = conn.execute(
        "SELECT * FROM scraper_runs WHERE mode = 'api_sync' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    write_json("gbp-sync.json", {
        "locations": sorted(loc_list, key=lambda l: l["name"]),
        "lastRun": dict(last_run) if last_run else None,
    })


def export_scraper_status(conn) -> None:
    runs = conn.execute("SELECT * FROM scraper_runs ORDER BY id DESC LIMIT 30").fetchall()
    run_list = []
    for run in runs:
        loc_rows = conn.execute(
            """SELECT srl.*, l.name AS location_name FROM scraper_run_locations srl
               JOIN locations l ON l.id = srl.location_id WHERE srl.run_id = ?""",
            (run["id"],),
        ).fetchall()
        # srl.* already includes the raw location_id column; locationId is
        # added alongside it for the same reason as validation.json above.
        run_list.append({**dict(run), "locations": [{**dict(r), "locationId": r["location_id"]} for r in loc_rows]})
    write_json("scraper-status.json", run_list)


def export_provider_health(conn) -> None:
    """Phase 3 Milestone 2: a provider-neutral health snapshot (healthy/
    warning/degraded/failed/offline per provider), computed by
    provider_health.compute_health() from the same scraper_runs rows
    export_scraper_status() already reads.

    Written to its own file rather than a new key on scraper-status.json:
    that file's top level is a bare JSON array today (ScraperStatus.jsx and
    Alerts.jsx both consume it as an array directly), so adding a sibling
    key there would change its top-level type to an object -- a real
    breaking change existing consumers could not simply ignore. A separate
    file keeps scraper-status.json byte-for-byte untouched while still
    giving the future Provider Health Center milestone real data to build
    against from day one."""
    from provider_gbp import GBPProvider
    from provider_scraper import ScraperProvider
    import provider_health

    runs = [dict(r) for r in conn.execute(
        "SELECT * FROM scraper_runs ORDER BY id DESC LIMIT 30"
    ).fetchall()]

    by_provider: dict = {}
    for run in runs:
        # `provider` is NULL for every row written before Milestone 1's
        # migration -- by BOTH writers, not just the scraper -- so `mode`
        # (always populated, for either writer, since long before this
        # column existed) is the correct disambiguator for historical rows,
        # not an assumption that every provider-less row is the scraper's.
        provider_name = run.get("provider") or ("gbp" if run.get("mode") == "api_sync" else "scraper")
        by_provider.setdefault(provider_name, []).append(run)

    providers = {"gbp": GBPProvider(), "scraper": ScraperProvider()}
    health = {
        name: provider_health.compute_health(
            name, provider.is_configured(), by_provider.get(name, []), provider.expected_cadence_minutes,
        )
        for name, provider in providers.items()
    }
    write_json("provider-health.json", health)


def export_intelligence(conn, locations: dict) -> None:
    """Export AI-generated intelligence: summaries, complaint intel, predictions, drafts."""
    cache_rows = conn.execute("SELECT cache_key, payload FROM analytics_cache").fetchall()
    by_key = {r["cache_key"]: json.loads(r["payload"]) for r in cache_rows}
    slug_to_id = {slugify(l["name"]): l["id"] for l in locations.values()}

    # Company AI summary
    if "ai_company_summary" in by_key:
        write_json("intelligence/company-summary.json", by_key["ai_company_summary"])

    # Complaint + praise intelligence
    if "complaint_intelligence" in by_key:
        write_json("intelligence/complaint-intelligence.json", by_key["complaint_intelligence"])

    # Department performance
    if "department_performance" in by_key:
        write_json("intelligence/department-performance.json", by_key["department_performance"])

    # Customer Experience Index (company-wide; per-location is embedded in location_detail_*)
    if "cx_index" in by_key:
        write_json("intelligence/cx-index.json", by_key["cx_index"])

    # Marketing Intelligence extras
    if "best_quotes" in by_key:
        write_json("intelligence/best-quotes.json", by_key["best_quotes"])
    if "seasonal_trends" in by_key:
        write_json("intelligence/seasonal-trends.json", by_key["seasonal_trends"])

    # Executive Dashboard scores
    if "executive_scores" in by_key:
        write_json("intelligence/executive-scores.json", by_key["executive_scores"])

    # AI Action Center
    if "action_center" in by_key:
        write_json("intelligence/action-center.json", by_key["action_center"])

    # Operations Impact Center
    if "operations_impact" in by_key:
        write_json("intelligence/operations-impact.json", by_key["operations_impact"])

    # Predictive alerts
    if "predictive_alerts" in by_key:
        write_json("intelligence/predictive-alerts.json", by_key["predictive_alerts"])

    # Per-location detail (health score, predictions, AI summary, staff, complaints)
    for key, payload in by_key.items():
        if key.startswith("location_detail_"):
            slug = key[len("location_detail_"):]
            # refresh_analytics.py computes this payload and doesn't know
            # about locationId -- inject it here rather than in that (much
            # larger, out-of-scope-for-this-milestone) module. A slug with
            # no matching current location (a stale cache entry left over
            # from a since-renamed/removed location) is written through
            # unchanged rather than guessing -- it will be regenerated
            # correctly next time refresh_analytics.py runs.
            if isinstance(payload, dict) and "locationId" not in payload:
                location_id = slug_to_id.get(slug)
                if location_id is not None:
                    payload = {"locationId": location_id, **payload}
            write_json(f"intelligence/locations/{slug}.json", payload)

    # Competitive intelligence
    if "competitive_intelligence" in by_key:
        write_json("intelligence/competitive-intelligence.json", by_key["competitive_intelligence"])

    # Response drafts — group into one file keyed by review_id for easy lookup
    drafts = {}
    for key, payload in by_key.items():
        if key.startswith("draft_") and isinstance(payload, dict) and payload.get("review_id"):
            rid = payload["review_id"]
            if rid not in drafts:
                drafts[rid] = payload
    write_json("intelligence/response-drafts.json", drafts)


def export_location_detail_reviews(conn, locations: dict) -> None:
    """
    Export enriched per-location review lists including complaint tags so
    the Review Center can display category labels without re-computing them.
    Already handled by export_reviews_by_location; this augments with tags.
    """
    try:
        from refresh_analytics import classify_review, slugify
    except ImportError:
        return

    for loc_id, loc in locations.items():
        rows = conn.execute(
            "SELECT * FROM reviews WHERE location_id = ? AND is_deleted = 0 ORDER BY review_date DESC",
            (loc_id,),
        ).fetchall()
        reviews_out = []
        for r in rows:
            rd = dict(r)
            tags = classify_review(rd.get("review_text") or "", rd.get("star_rating"))
            reviews_out.append({
                "locationId": loc["id"],
                "location_name": loc["name"], "city": loc["city"],
                "reviewer_name": rd.get("reviewer_name"), "review_date": rd.get("review_date"),
                "star_rating": rd.get("star_rating"), "review_text": rd.get("review_text"),
                "owner_response": rd.get("owner_response"),
                "review_url": rd.get("review_url"),
                "response_status": "responded" if (rd.get("owner_response") or "").strip() else "unanswered",
                "review_id": db.canonical_review_id(rd.get("review_url") or "") or "",
                "last_checked_at": rd.get("last_seen_at") or "",
                "complaint_tags": tags["complaints"],
                "praise_tags": tags["praises"],
                "ai_sentiment": rd.get("ai_sentiment"),
                "ai_sentiment_reason": rd.get("ai_sentiment_reason"),
                "ai_priority": rd.get("ai_priority"),
                "gbp_review_name": rd.get("gbp_review_name"),
            })
        write_json(f"reviews/by-location/{slugify(loc['name'])}.json", reviews_out)


def main():
    conn = db.get_connection()
    db.init_schema(conn)
    locations = {row["id"]: dict(row) for row in conn.execute("SELECT * FROM locations").fetchall()}

    export_reviews_csv(conn)
    export_meta(conn, locations)
    export_location_contacts(locations)
    export_analytics_cache(conn)
    export_location_analytics(conn, locations)  # Phase 2 Milestone 5 (Option C)
    export_location_detail_reviews(conn, locations)  # replaces export_reviews_by_location
    export_action_items(conn, locations)
    export_validation(conn)
    export_scraper_status(conn)
    export_provider_health(conn)
    export_gbp_sync_status(conn, locations)
    export_weekly_report(conn, locations)
    export_intelligence(conn, locations)

    # Gate the pipeline on per-location analytics integrity before closing
    # the connection (the independent review-count cross-check needs it).
    ok, issues, details = validate_location_analytics(conn, locations)
    conn.close()

    if not ok:
        print("Location analytics validation FAILED:")
        for issue in issues:
            print(f"  - {issue}")
        raise SystemExit(1)
    print(f"Location analytics validation passed ({details['locationAnalyticsGenerated']} locations).")

    files = list(PRIVATE_DATA_DIR.rglob("*.json"))
    total_bytes = sum(f.stat().st_size for f in files)
    print(f"Exported {len(files)} chunk files, {total_bytes / 1024:.0f} KB total, to {PRIVATE_DATA_DIR}")


if __name__ == "__main__":
    main()
