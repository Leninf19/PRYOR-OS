"""
gbp_reply_bridge_reconcile.py -- Recovery Milestone 6B, Part 7: bounded,
frequent reconciliation of the durable publish-bridge records
dashboard/api/_lib/publishBridgeStore.js writes after a successful
Confirm & Publish (see that module's docstring for the full architecture).

Problem this solves: Milestone 6A's production diagnostic proved the
6-hourly full sync (update-reviews.yml) is the only existing process that
would ever re-discover an OLD review's NEW owner reply -- the 15-minute
critical-alert-check only fetches page 1 by review POST date, which can
never see a reply added to an old review. That left up to ~6 hours (plus
GitHub's own scheduling delay) where a review Future Insights had already
successfully published to Google still showed Needs Reply everywhere except
the one browser that published it.

This script closes that gap WITHOUT turning the 15-minute check into a full
all-pages sync (explicitly ruled out -- unnecessary Google API quota
pressure across all 23 locations). It only ever looks at reviews that have
an ACTIVE bridge record -- i.e. reviews Future Insights itself just
published and is still waiting on Google/the full sync to confirm -- and
checks each one by its exact gbp_review_name (a single targeted GET, the
same google_api.get_review() reconcile_gbp_replies.py already uses), not by
paginating a location's reviews at all.

Read/write split:
  - Redis (Upstash REST, same credentials every other GBP-calling workflow
    already has): read-only KEYS + GET to list bridge records, plus a DEL
    once a record is confirmed reconciled. The bridge keyspace is small by
    construction (bounded by recent publish activity and its own 48h TTL --
    see publishBridgeStore.js), so a KEYS scan here is a deliberate,
    reasoned choice, not a blind full-keyspace scan of a large, unrelated
    Redis instance.
  - reviews.db: a targeted db.upsert_review() call per confirmed row (the
    SAME function the real sync pipeline uses), which only ever touches
    owner_response/gbp_reply_update_time-related fields on a row it already
    found by an exact gbp_review_name match -- never review_text/
    star_rating (upsert_review()'s own coalesce logic preserves those
    untouched when this script's partial row doesn't supply them), never
    any other row, never a full-table scan.

Never calls google_api.reply_to_review() -- read-only against Google.

Usage: py gbp_reply_bridge_reconcile.py [--dry-run]
"""
import argparse
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import db
import google_api as ga

BRIDGE_KEY_PREFIX = "publish_bridge:v1:"
REQUEST_TIMEOUT_SECONDS = 10


class BridgeStoreUnavailableError(Exception):
    pass


def _redis_base_url() -> str:
    url = os.environ.get("UPSTASH_REDIS_REST_URL")
    token = os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    if not url or not token:
        raise BridgeStoreUnavailableError("UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not set")
    return url.rstrip("/"), token


def _redis_get(path: str, token: str):
    req = urllib.request.Request(f"{path}", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
        return json.loads(resp.read())


def list_bridge_keys() -> list[str]:
    """KEYS publish_bridge:v1:* -- see module docstring for why a KEYS scan
    is an accepted, reasoned choice for this specific, small, TTL-bounded
    keyspace rather than the general anti-pattern it usually is.

    NOT url-encoded, deliberately: BRIDGE_KEY_PREFIX + '*' is a fixed glob
    PATTERN, not an exact dynamic key -- unlike get_bridge_record()/
    delete_bridge_record() below, there is no per-record arbitrary content
    here to escape, and quoting the literal '*' would send Upstash '%2A'
    instead of the wildcard, breaking the scan entirely. The prefix itself
    (letters, digits, ':') never needs encoding either -- ':' is a valid
    unreserved path character per RFC 3986.
    """
    base_url, token = _redis_base_url()
    result = _redis_get(f"{base_url}/keys/{BRIDGE_KEY_PREFIX}*", token)
    return result.get("result") or []


# Every OTHER Redis call in this module addresses one exact, dynamic key
# returned by list_bridge_keys() -- built from Google's actual review data
# (reviewer name, review date, or a scraped review URL; see
# publishBridgeStore.js/dataUtils.js's reviewId() fallback chain), so it can
# contain spaces, punctuation, or non-ASCII characters. Unlike the KEYS
# pattern above, this is never a wildcard -- the full key must survive
# round-trip exactly, so it is safe (and required) to percent-encode
# every non-unreserved byte. safe='' additionally encodes '/' itself,
# since a key derived from a URL can legitimately contain one, and an
# un-encoded '/' would otherwise be read as an extra path segment by the
# HTTP layer, not as part of the key.
def _quote_key(key: str) -> str:
    return urllib.parse.quote(key, safe="")


def get_bridge_record(key: str) -> dict | None:
    base_url, token = _redis_base_url()
    result = _redis_get(f"{base_url}/get/{_quote_key(key)}", token)
    raw = result.get("result")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None


def delete_bridge_record(key: str) -> None:
    base_url, token = _redis_base_url()
    _redis_get(f"{base_url}/del/{_quote_key(key)}", token)


def find_local_review(conn, gbp_review_name: str):
    return conn.execute(
        """SELECT r.id, r.location_id, l.name AS location_name, r.owner_response
           FROM reviews r JOIN locations l ON l.id = r.location_id
           WHERE r.gbp_review_name = ?""",
        (gbp_review_name,),
    ).fetchone()


def reconcile_one(conn, key: str, record: dict, dry_run: bool,
                   fetch_review=None, delete_record=None) -> str:
    """Returns one of: 'confirmed', 'still_pending', 'skipped_no_gbp_id',
    'skipped_not_found_locally', 'fetch_failed'.

    fetch_review/delete_record default to the real google_api.get_review()/
    delete_bridge_record() -- overridable so tests can inject deterministic
    stand-ins, the same seam reconcile_gbp_replies.py's fetch_review
    parameter already uses."""
    fetch_review = fetch_review or ga.get_review
    delete_record = delete_record or delete_bridge_record

    gbp_review_name = record.get("gbpReviewName")
    if not gbp_review_name:
        # A publish through the fallback (location+reviewer fuzzy match)
        # path always resolves and stores the real gbp_review_name server-
        # side before writing the bridge (see [action].js's publish()) --
        # this branch is only reachable for a malformed/legacy record.
        print(f"[reconcile] {key}: no gbpReviewName on record -- skipping (nothing to check against Google)")
        return "skipped_no_gbp_id"

    local_row = find_local_review(conn, gbp_review_name)
    if not local_row:
        print(f"[reconcile] {key}: no local review row has gbp_review_name={gbp_review_name!r} -- skipping")
        return "skipped_not_found_locally"

    if (local_row["owner_response"] or "").strip():
        # Already reconciled by something else (e.g. the full sync ran
        # since this record was written) -- just clean up the now-redundant
        # bridge record and move on.
        print(f"[reconcile] {key}: reviews.db already has owner_response for this review -- clearing stale bridge record")
        if not dry_run:
            delete_record(key)
        return "confirmed"

    try:
        api_review = fetch_review(gbp_review_name)
    except Exception as e:  # noqa: BLE001 -- a fetch failure for one review must never abort the run
        print(f"[reconcile] {key}: fetch failed ({type(e).__name__}: {e}) -- leaving bridge record in place, TTL is the backstop")
        return "fetch_failed"

    reply = api_review.get("reviewReply") or {}
    comment = (reply.get("comment") or "").strip()
    if not comment:
        print(f"[reconcile] {key}: Google still shows no reply for this review -- still pending")
        return "still_pending"

    print(f"[reconcile] {key}: Google confirms the reply -- writing owner_response to reviews.db (review id={local_row['id']})")
    if not dry_run:
        db.upsert_review(
            conn, local_row["location_id"], local_row["location_name"],
            {
                "gbp_review_name": gbp_review_name,
                "owner_response": comment,
                "gbp_reply_update_time": reply.get("updateTime"),
            },
            datetime.now(timezone.utc).isoformat(),
        )
        conn.commit()
        delete_record(key)
    return "confirmed"


def run_reconcile(conn, dry_run: bool = False, *,
                   list_keys=None, get_record=None, fetch_review=None, delete_record=None) -> dict:
    """Orchestrates one reconciliation pass -- separated from main() so
    tests can drive it directly against a temporary DB with every external
    seam (Redis list/get/delete, Google fetch) injected, without touching
    argparse/sys.exit or any real network/Redis/DB."""
    list_keys = list_keys or list_bridge_keys
    get_record = get_record or get_bridge_record
    delete_record = delete_record or delete_bridge_record

    keys = list_keys()
    print(f"[reconcile] {len(keys)} active publish-bridge record(s) found")

    counts = {"confirmed": 0, "still_pending": 0, "skipped_no_gbp_id": 0, "skipped_not_found_locally": 0, "fetch_failed": 0}
    for key in keys:
        record = get_record(key)
        if not record:
            continue  # expired between list and get, or was concurrently cleared -- not an error
        outcome = reconcile_one(conn, key, record, dry_run, fetch_review=fetch_review, delete_record=delete_record)
        counts[outcome] = counts.get(outcome, 0) + 1
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                         help="Report what would happen without writing to reviews.db or deleting any Redis record")
    args = parser.parse_args()

    print("=== gbp_reply_bridge_reconcile.py -- bounded publish-bridge reconciliation ===")
    if not ga.is_configured():
        print("[reconcile] Google credentials not configured in this environment -- skipping (not a failure, matches every other GBP step's is_configured() guard).")
        return 0

    conn = db.get_connection()
    db.init_schema(conn)
    try:
        counts = run_reconcile(conn, dry_run=args.dry_run)
    except BridgeStoreUnavailableError as e:
        print(f"[reconcile] Redis not configured/unreachable ({e}) -- nothing to reconcile this run.")
        conn.close()
        return 0
    conn.close()
    print(f"[reconcile] done: {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
