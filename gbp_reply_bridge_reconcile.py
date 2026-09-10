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
GitHub's own scheduling delay) where a review Pryor OS had already
successfully published to Google still showed Needs Reply everywhere except
the one browser that published it.

This script closes that gap WITHOUT turning the 15-minute check into a full
all-pages sync (explicitly ruled out -- unnecessary Google API quota
pressure across all 23 locations). It only ever looks at reviews that have
an ACTIVE bridge record -- i.e. reviews Pryor OS itself just
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

Multi-Tenant Phase 4C: this script requires an explicit, validated tenantId
(--tenant-id -- REQUIRED, no default) before it will list, read, or delete
ANY bridge record, or fetch ANY review from Google. The KEYS scan
prefix and the credential used are both derived from tenant_keys.py's
migration-mode-aware resolvers -- the SAME ones dashboard/api/_lib/
credentialStore.js and publishBridgeStore.js are built on -- so a worker
run with tenant_id='t_client_2' can only ever construct and scan
'publish_bridge:v2:t_client_2:*' and load 'gbp_credentials:v2:t_client_2',
structurally incapable of enumerating, reading, or deleting Los Tres
Amigos's own 'publish_bridge:v1:*'/'gbp_credentials:v1' records (or any
other tenant's), and vice versa.

Usage: py gbp_reply_bridge_reconcile.py --tenant-id t_los-tres-amigos [--dry-run]
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
import tenant_keys
import tenant_paths

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


def list_bridge_keys(tenant_id: str) -> list[str]:
    """KEYS {scan_prefix}* -- see module docstring for why a KEYS scan is an
    accepted, reasoned choice for this specific, small, TTL-bounded
    keyspace rather than the general anti-pattern it usually is.

    Multi-Tenant Phase 4C: the prefix is resolved via
    tenant_keys.resolve_publish_bridge_scan_prefix(tenant_id) -- a pure
    function of tenant_id and the fixed, code-reviewed migration-mode map,
    never of what Redis currently contains. This is the ONE line that
    determines which tenant's records this run can possibly see; every
    other function in this module only ever operates on keys THIS function
    returned, so a caller can never enumerate another tenant's keyspace no
    matter what it passes for tenant_id, short of passing another tenant's
    real tenantId on purpose (exactly the "explicit, validated tenantId"
    boundary this phase requires -- there is no way to trick this function
    into scanning a DIFFERENT prefix than the one tenant_id maps to).

    NOT url-encoded, deliberately: prefix + '*' is a fixed glob PATTERN,
    not an exact dynamic key -- unlike get_bridge_record()/
    delete_bridge_record() below, there is no per-record arbitrary content
    here to escape, and quoting the literal '*' would send Upstash '%2A'
    instead of the wildcard, breaking the scan entirely. The prefix itself
    (letters, digits, ':', '-') never needs encoding either -- ':' and '-'
    are valid unreserved path characters per RFC 3986.
    """
    tenant_keys.assert_valid_tenant_id(tenant_id, "list_bridge_keys")
    prefix = tenant_keys.resolve_publish_bridge_scan_prefix(tenant_id)
    base_url, token = _redis_base_url()
    result = _redis_get(f"{base_url}/keys/{prefix}*", token)
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


def reconcile_one(conn, key: str, record: dict, dry_run: bool, tenant_id: str,
                   fetch_review=None, delete_record=None) -> str:
    """Returns one of: 'confirmed', 'still_pending', 'skipped_no_gbp_id',
    'skipped_not_found_locally', 'fetch_failed'.

    fetch_review/delete_record default to the real google_api.get_review()
    (bound to tenant_id)/delete_bridge_record() -- overridable so tests can
    inject deterministic stand-ins, the same seam reconcile_gbp_replies.py's
    fetch_review parameter already uses. When overridden, tenant_id is
    unused (the injected callable is called directly)."""
    if fetch_review is None:
        tenant_keys.assert_valid_tenant_id(tenant_id, "reconcile_one")
        fetch_review = lambda review_name: ga.get_review(tenant_id, review_name)  # noqa: E731
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


def run_reconcile(conn, tenant_id: str, dry_run: bool = False, *,
                   list_keys=None, get_record=None, fetch_review=None, delete_record=None) -> dict:
    """Orchestrates one reconciliation pass -- separated from main() so
    tests can drive it directly against a temporary DB with every external
    seam (Redis list/get/delete, Google fetch) injected, without touching
    argparse/sys.exit or any real network/Redis/DB.

    Multi-Tenant Phase 4C revision: tenant_id is REQUIRED, with no default,
    and is validated up front regardless of whether list_keys/fetch_review
    are overridden (reconciliation is one of the explicitly listed
    operations that must never proceed without an explicit tenant). It is
    threaded into the real list_keys/reconcile_one defaults (
    list_bridge_keys/ga.get_review) -- a caller supplying its own
    list_keys/fetch_review (as every test in
    test_gbp_reply_bridge_reconcile.py does) bypasses tenant_id for those
    specific calls only, exactly like reconcile_one's own fetch_review
    override."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "run_reconcile")
    list_keys = list_keys or (lambda: list_bridge_keys(tenant_id))
    get_record = get_record or get_bridge_record
    delete_record = delete_record or delete_bridge_record

    keys = list_keys()
    print(f"[reconcile] tenant={tenant_id} {len(keys)} active publish-bridge record(s) found")

    counts = {"confirmed": 0, "still_pending": 0, "skipped_no_gbp_id": 0, "skipped_not_found_locally": 0, "fetch_failed": 0}
    for key in keys:
        record = get_record(key)
        if not record:
            continue  # expired between list and get, or was concurrently cleared -- not an error
        outcome = reconcile_one(conn, key, record, dry_run, tenant_id, fetch_review=fetch_review, delete_record=delete_record)
        counts[outcome] = counts.get(outcome, 0) + 1
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                         help="Report what would happen without writing to reviews.db or deleting any Redis record")
    parser.add_argument("--tenant-id", required=True,
                         help="Explicit tenant whose publish-bridge records to reconcile. REQUIRED -- no "
                              "default; this script never infers a tenant on its own. A worker run with a "
                              "given tenantId can only ever see and affect that tenant's own records, "
                              "never another tenant's. See the Multi-Tenant Phase 4C report.")
    args = parser.parse_args()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::gbp_reply_bridge_reconcile.py: invalid --tenant-id {args.tenant_id!r}")
        return 1

    # Multi-Tenant Phase 4D: resolve THIS tenant's own review database
    # before any DB access -- reconciliation writes owner_response back to
    # reviews.db (see reconcile_one() above), so this must never run
    # against another tenant's (or a default/unregistered) database.
    try:
        db.DB_PATH = tenant_paths.resolve_review_db_path(args.tenant_id)
    except tenant_paths.UnknownTenantError as e:
        print(f"::error::gbp_reply_bridge_reconcile.py: {e}")
        return 1

    print(f"=== gbp_reply_bridge_reconcile.py -- bounded publish-bridge reconciliation (tenant={args.tenant_id}) ===")
    if not ga.is_configured():
        print("[reconcile] Google credentials not configured in this environment -- skipping (not a failure, matches every other GBP step's is_configured() guard).")
        return 0

    conn = db.get_connection()
    db.init_schema(conn)
    try:
        counts = run_reconcile(conn, tenant_id=args.tenant_id, dry_run=args.dry_run)
    except BridgeStoreUnavailableError as e:
        print(f"[reconcile] Redis not configured/unreachable ({e}) -- nothing to reconcile this run.")
        conn.close()
        return 0
    conn.close()
    print(f"[reconcile] done: {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
