"""
gbp_reply_reconciliation_diagnostic.py -- ONE-TIME, read-only diagnostic
(Recovery Milestone 6A) for the "successfully-published replies reappear as
Needs Reply" bug. Compares reviews.db's actionable (owner_response empty)
reviews for a single location against Google's LIVE, current review state,
to find out exactly how many are actually already answered on Google.

Read-only guarantees:
  - Google side: calls ONLY google_api.get_review(gbp_review_name) -- a
    single GET per review, the exact same read-only call
    reconcile_gbp_replies.py already uses to re-check one review. This
    script never calls google_api.reply_to_review() (PUT), never calls
    provider_sync.sync_all(), and never runs any provider's fetch_reviews().
  - Local DB side: opens dashboard/reviews.db via a SQLite read-only URI
    connection (mode=ro) -- not db.py's connect(), which runs schema
    migrations as a side effect. Any accidental write attempt against a
    mode=ro connection raises immediately rather than silently succeeding.
  - No AI draft is generated, no status is reconciled/written anywhere, no
    file on disk is modified.

Identity note: gbp_review_name is Google's canonical resource identity
(accounts/*/locations/*/reviews/*) -- printed here as the last ~24 characters
only (the review-id segment), matching gbp_location_diagnostic.py's existing
convention, so full account/location numeric segments don't fill the log.

Usage:
    py gbp_reply_reconciliation_diagnostic.py --location "Casa Tequila Prime"
    py gbp_reply_reconciliation_diagnostic.py --location "Casa Tequila Prime" --window-days 7
"""
import argparse
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

import google_api as ga
import tenant_keys
import tenant_paths

# Multi-Tenant Phase 4D: resolved in main() from --tenant-id via
# tenant_paths.resolve_review_db_path() -- never a hardcoded default.
DB_PATH: Path | None = None


def load_actionable_reviews(location_name: str) -> list[dict]:
    """Read-only. Every actionable (owner_response empty, not soft-deleted)
    review for the given location, newest first."""
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """SELECT r.id, r.reviewer_name, r.review_date, r.star_rating, r.review_text,
                  r.owner_response, r.gbp_review_name, r.gbp_update_time,
                  r.gbp_reply_update_time, r.last_seen_at, l.name AS location_name
           FROM reviews r JOIN locations l ON l.id = r.location_id
           WHERE l.name = ? AND r.is_deleted = 0
             AND (r.owner_response IS NULL OR TRIM(r.owner_response) = '')
           ORDER BY r.review_date DESC""",
        (location_name,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def abbreviate(gbp_review_name: str | None) -> str:
    if not gbp_review_name:
        return "(none)"
    return "..." + gbp_review_name[-24:]


def check_google_state(tenant_id: str, gbp_review_name: str) -> dict:
    """Single read-only GET. Never writes, never replies. Returns a dict
    describing what Google currently reports for this exact review."""
    try:
        api_review = ga.get_review(tenant_id, gbp_review_name)
    except Exception as e:
        return {"verifiable": False, "error": f"{type(e).__name__}: {e}"}

    reply = api_review.get("reviewReply") or {}
    comment = (reply.get("comment") or "").strip()
    return {
        "verifiable": True,
        "has_reply": bool(comment),
        "reply_text": comment,
        "reply_timestamp": reply.get("updateTime"),
        "reviewer_display_name": (api_review.get("reviewer") or {}).get("displayName"),
        "create_time": api_review.get("createTime"),
        "review_comment": api_review.get("comment") or "",
    }


def identity_sanity_check(local_row: dict, google_state: dict) -> str:
    """Best-effort proxy for 'is gbp_review_name pointing at the right
    review' -- compares reviewer display name and review date, since this
    script has no other independent identity signal available. Not proof,
    just a flag for a human to look twice at."""
    if not google_state.get("verifiable"):
        return "unverifiable"
    name_match = (local_row["reviewer_name"] or "").strip().lower() == (google_state.get("reviewer_display_name") or "").strip().lower()
    date_match = True
    ct = google_state.get("create_time") or ""
    if ct and local_row["review_date"]:
        date_match = ct[:10] == local_row["review_date"]
    return "ok" if (name_match and date_match) else "MISMATCH -- check manually"


def main() -> int:
    global DB_PATH
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--location", required=True, help="Exact locations.name to diagnose")
    parser.add_argument("--window-days", type=int, default=7,
                         help="Reviews within this many days of today are reported as the "
                              "'default dashboard window' set, separately from older actionable reviews")
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose credential to use. REQUIRED -- no default. This "
                              "script never infers a tenant on its own.")
    args = parser.parse_args()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::gbp_reply_reconciliation_diagnostic.py: invalid --tenant-id {args.tenant_id!r}")
        return 1
    try:
        DB_PATH = tenant_paths.resolve_review_db_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::gbp_reply_reconciliation_diagnostic.py: {e}")
        return 1

    print(f"=== gbp_reply_reconciliation_diagnostic.py -- READ-ONLY, one-time run ===")
    print(f"Location: {args.location!r}")
    print(f"NOTE: this script only ever calls google_api.get_review() (GET). It never calls "
          f"reply_to_review(), never writes to reviews.db, never touches Redis/workspace state.\n")

    if not ga.is_configured():
        print("::error::GBP credentials are not configured in this environment (GOOGLE_CLIENT_ID/"
              "GOOGLE_CLIENT_SECRET + a refresh token via Redis or GOOGLE_REFRESH_TOKEN). Aborting -- "
              "no local-only fallback is used for this diagnostic.")
        return 1

    reviews = load_actionable_reviews(args.location)
    print(f"Actionable (owner_response empty) reviews at {args.location!r}: {len(reviews)}\n")

    cutoff = (date.today() - timedelta(days=args.window_days)).isoformat()
    default_window = [r for r in reviews if (r["review_date"] or "") >= cutoff]
    older = [r for r in reviews if (r["review_date"] or "") < cutoff]
    print(f"Default dashboard window (review_date >= {cutoff}, last {args.window_days} days): {len(default_window)}")
    print(f"Older actionable reviews (outside that window): {len(older)}\n")

    results = []
    for r in reviews:
        row = {
            "id": r["id"],
            "reviewer_name": r["reviewer_name"],
            "review_date": r["review_date"],
            "gbp_review_name": r["gbp_review_name"],
            "local_owner_response_present": bool((r["owner_response"] or "").strip()),
            "local_gbp_reply_update_time": r["gbp_reply_update_time"],
            "in_default_window": r in default_window,
        }
        if not r["gbp_review_name"]:
            row.update({"verifiable": False, "reason": "no gbp_review_name linked locally", "recommended_state": "unable to verify"})
            results.append(row)
            continue

        google_state = check_google_state(args.tenant_id, r["gbp_review_name"])
        row["google"] = google_state
        if not google_state.get("verifiable"):
            row["recommended_state"] = "unable to verify"
            row["identity_check"] = "unverifiable"
        else:
            row["identity_check"] = identity_sanity_check(r, google_state)
            row["recommended_state"] = (
                "already answered on Google -- should NOT be Needs Reply"
                if google_state["has_reply"] else
                "genuinely unanswered on Google -- Needs Reply is correct"
            )
        results.append(row)

    # --- Per-review table ---
    print("=" * 150)
    print(f"{'ID':7} | {'Reviewer':28} | {'Date':10} | {'GBP review id':27} | {'Local reply?':13} | {'Google reply?':14} | {'Identity':22} | Recommended state")
    print("=" * 150)
    for row in results:
        google = row.get("google") or {}
        google_reply_disp = (
            "N/A (no gbp id)" if "google" not in row else
            "ERROR" if not google.get("verifiable") else
            ("YES" if google["has_reply"] else "no")
        )
        print(
            f"{row['id']:<7} | {row['reviewer_name'][:28]:28} | {row['review_date'] or '':10} | "
            f"{abbreviate(row['gbp_review_name']):27} | {'yes' if row['local_owner_response_present'] else 'no':13} | "
            f"{google_reply_disp:14} | {row.get('identity_check', 'n/a'):22} | {row['recommended_state']}"
        )
    print("=" * 150)
    print()

    # --- Detail for anything Google says IS answered (the interesting case) ---
    answered_on_google = [r for r in results if r.get("google", {}).get("has_reply")]
    if answered_on_google:
        print("--- Reviews Google reports as ALREADY ANSWERED (local state is stale) ---")
        for row in answered_on_google:
            g = row["google"]
            print(f"  id={row['id']} reviewer={row['reviewer_name']!r} date={row['review_date']} "
                  f"gbp_review_name={abbreviate(row['gbp_review_name'])}")
            print(f"    Google reply timestamp: {g['reply_timestamp']}")
            print(f"    Google reply text: {g['reply_text'][:300]!r}")
            print(f"    Local gbp_reply_update_time (before this run): {row['local_gbp_reply_update_time']}")
            print(f"    Identity sanity check: {row['identity_check']}")
        print()

    unverifiable = [r for r in results if r["recommended_state"] == "unable to verify"]
    if unverifiable:
        print("--- Reviews that could NOT be verified against Google ---")
        for row in unverifiable:
            reason = row.get("reason") or (row.get("google") or {}).get("error", "unknown")
            print(f"  id={row['id']} reviewer={row['reviewer_name']!r} date={row['review_date']} reason={reason}")
        print()

    # --- Summary totals ---
    total = len(results)
    answered = len(answered_on_google)
    unanswered = len([r for r in results if r["recommended_state"] == "genuinely unanswered on Google -- Needs Reply is correct"])
    unable = len(unverifiable)

    default_results = [r for r in results if r["in_default_window"]]
    default_answered = len([r for r in default_results if r.get("google", {}).get("has_reply")])
    default_unanswered = len([r for r in default_results if r["recommended_state"] == "genuinely unanswered on Google -- Needs Reply is correct"])
    default_unable = len([r for r in default_results if r["recommended_state"] == "unable to verify"])

    print("=" * 60)
    print("SUMMARY -- all actionable reviews at this location")
    print(f"  Current Needs Reply (actionable, local):   {total}")
    print(f"  Already answered on Google:                {answered}")
    print(f"  Genuinely unanswered on Google:             {unanswered}")
    print(f"  Unable to verify:                           {unable}")
    print()
    print(f"SUMMARY -- default dashboard window only (last {args.window_days} days, {len(default_results)} reviews)")
    print(f"  Already answered on Google:                {default_answered}")
    print(f"  Genuinely unanswered on Google:             {default_unanswered}")
    print(f"  Unable to verify:                           {default_unable}")
    print("=" * 60)
    print("\n=== END gbp_reply_reconciliation_diagnostic.py -- nothing was written anywhere ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
