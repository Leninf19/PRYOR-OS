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
            "name": l["name"], "city": l["city"], "brand": l["brand"],
            "slug": slugify(l["name"]), "maps_url": l.get("maps_url") or "",
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
                    "name": loc["name"], "avgCur": round(avg_cur, 2), "avgPrev": round(avg_prev, 2),
                    "delta": round(avg_cur - avg_prev, 2), "curN": len(cur), "prevN": len(prev),
                })

    write_json("action-items.json", {"unanswered": unanswered, "trendAlerts": trend})


def export_validation(conn) -> None:
    rows = conn.execute(
        """SELECT flag_type, location_id, detail, detected_at FROM validation_flags
           WHERE resolved_at IS NULL ORDER BY detected_at DESC"""
    ).fetchall()
    write_json("validation.json", [dict(r) for r in rows])


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
        run_list.append({**dict(run), "locations": [dict(r) for r in loc_rows]})
    write_json("scraper-status.json", run_list)


def export_intelligence(conn) -> None:
    """Export AI-generated intelligence: summaries, complaint intel, predictions, drafts."""
    cache_rows = conn.execute("SELECT cache_key, payload FROM analytics_cache").fetchall()
    by_key = {r["cache_key"]: json.loads(r["payload"]) for r in cache_rows}

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
    export_analytics_cache(conn)
    export_location_detail_reviews(conn, locations)  # replaces export_reviews_by_location
    export_action_items(conn, locations)
    export_validation(conn)
    export_scraper_status(conn)
    export_gbp_sync_status(conn, locations)
    export_weekly_report(conn, locations)
    export_intelligence(conn)

    conn.close()
    files = list(PRIVATE_DATA_DIR.rglob("*.json"))
    total_bytes = sum(f.stat().st_size for f in files)
    print(f"Exported {len(files)} chunk files, {total_bytes / 1024:.0f} KB total, to {PRIVATE_DATA_DIR}")


if __name__ == "__main__":
    main()
