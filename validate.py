"""
validate.py - Data Validation Agent (Milestone 2).

Ports dashboard/src/pages/DataValidation.jsx's buildReport() checks to run
server-side against reviews.db, writing results into validation_flags so
issues persist across runs instead of being recomputed from scratch by
every browser tab.

Flag lifecycle (fixed 2026-07-28 -- see the incident note below): a flag's
identity is (review_id, location_id, flag_type). A run diffs the problems it
detects THIS pass against whatever is already open from a PRIOR pass:
  - still detected, already open  -> leave the existing row untouched (no
    new row, no churn -- this is the fix)
  - newly detected, nothing open  -> insert exactly one new row
  - previously open, no longer detected -> mark that row resolved
Nothing about the flag TYPE is ever suppressed going forward -- a resolved
issue that genuinely returns later gets a brand new row, preserving that
it's a new incident, not a permanently muted one.

Incident note: the previous version of this function resolved every
currently-open flag of its own check types unconditionally, then
re-inserted a fresh row for every review still failing a check, every
single run. A condition that's simply always true for a given review (a
star-rating-only review with no text is completely normal and legitimate,
for example) generated one new permanent row per pipeline run, forever,
with no deduplication -- 575,864 rows accumulated this way, 56.6 MiB (57%)
of the committed database, almost all of them already-resolved duplicates
of the same small set of persisting conditions. See
repair_review_identity.py's sibling, the validation-flag retention
maintenance utility, for the one-time cleanup of that backlog; this file
is the fix that stops it from recurring.

Confirmed via every reader of this table (notify.py's duplicate_review_url
alert, export_chunks.py's export_validation()) that nothing anywhere reads
RESOLVED flag history -- only currently-open flags are ever consumed. No
product feature depends on this function's resolved-row output.
"""
from datetime import datetime, timezone

import db

CHECK_TYPES = [
    "duplicate_review_url", "missing_text", "missing_url", "missing_reviewer",
    "bad_star_rating", "stale_location", "unverified_location",
]


def days_between(a: str, b: str) -> int:
    return (datetime.fromisoformat(b) - datetime.fromisoformat(a)).days


def insert_flag(conn, review_id, location_id, flag_type, detail, now):
    conn.execute(
        """INSERT INTO validation_flags (review_id, location_id, flag_type, detail, detected_at)
           VALUES (?, ?, ?, ?, ?)""",
        (review_id, location_id, flag_type, detail, now),
    )


def get_open_flags(conn) -> dict:
    """Every currently-open flag of one of THIS module's own CHECK_TYPES,
    keyed by identity (review_id, location_id, flag_type) -> list of rows.
    Normally at most one row per identity; kept as a list rather than a
    single row so a pre-existing anomaly (more than one simultaneously-open
    row for the same identity, e.g. leftover from before this fix) can be
    detected and self-healed by run() rather than silently hidden by a dict
    that only remembers the last one seen.

    Scoped to CHECK_TYPES (Recovery Milestone 3): other modules write other
    flag_types into this same table -- e.g. provider_sync.py's
    'duplicate_gbp_listing', which has its own independent open/resolve
    reconciliation in _reconcile_collision_flags(). Without this filter,
    run()'s resolve loop below would see those rows as "open but not
    detected this run" (since this module never checks for that condition
    at all) and incorrectly resolve them on every single validate.py run --
    silently undoing that flag's whole purpose."""
    placeholders = ",".join("?" * len(CHECK_TYPES))
    rows = conn.execute(
        f"SELECT id, review_id, location_id, flag_type FROM validation_flags "
        f"WHERE resolved_at IS NULL AND flag_type IN ({placeholders})",
        CHECK_TYPES,
    ).fetchall()
    by_identity: dict = {}
    for r in rows:
        key = (r["review_id"], r["location_id"], r["flag_type"])
        by_identity.setdefault(key, []).append(dict(r))
    return by_identity


def run(conn) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    open_flags = get_open_flags(conn)
    detected_identities = set()

    reviews = conn.execute(
        "SELECT id, location_id, review_url, review_text, reviewer_name, star_rating, review_date "
        "FROM reviews WHERE is_deleted = 0"
    ).fetchall()
    locations = {row["id"]: row for row in conn.execute("SELECT id, name, city, brand FROM locations").fetchall()}

    counts = {k: 0 for k in CHECK_TYPES}

    def flag(review_id, location_id, flag_type, detail):
        """Records that `flag_type` is detected for this identity in THIS
        run, and inserts a new row only if nothing is already open for it --
        the entire fix lives in this one function."""
        key = (review_id, location_id, flag_type)
        detected_identities.add(key)
        if key in open_flags:
            return  # already open -- leave it in place, exactly per the required invariant
        insert_flag(conn, review_id, location_id, flag_type, detail, now)
        counts[flag_type] += 1

    # Structurally this should never fire -- dedup_key is UNIQUE, and
    # review_url-derived rows collapse to the same dedup_key. Kept as a
    # safety net in case dedup_key()'s fallback (location/reviewer/date/star)
    # ever lets two distinct URLs through that shouldn't have been distinct.
    by_url = {}
    for r in reviews:
        if r["review_url"]:
            by_url.setdefault(r["review_url"], []).append(r)
    for url, group in by_url.items():
        if len(group) > 1:
            for r in group:
                flag(r["id"], r["location_id"], "duplicate_review_url",
                     f"{len(group)} rows share review_url {url}")

    max_date = max((r["review_date"] or "" for r in reviews), default="")
    per_location_last = {}

    for r in reviews:
        if not r["review_text"]:
            flag(r["id"], r["location_id"], "missing_text", None)
        if not r["review_url"]:
            flag(r["id"], r["location_id"], "missing_url", None)
        if not r["reviewer_name"]:
            flag(r["id"], r["location_id"], "missing_reviewer", None)
        if not (r["star_rating"] and 1 <= r["star_rating"] <= 5):
            flag(r["id"], r["location_id"], "bad_star_rating", f"star_rating={r['star_rating']}")
        if r["review_date"] and r["review_date"] > per_location_last.get(r["location_id"], ""):
            per_location_last[r["location_id"]] = r["review_date"]

    for loc_id, loc in locations.items():
        last_date = per_location_last.get(loc_id, "")
        if last_date and max_date:
            stale_days = days_between(last_date, max_date)
            if stale_days > 60:
                flag(None, loc_id, "stale_location",
                     f"No new review in {stale_days} days (last: {last_date})")
        brand_known = bool(loc["brand"]) and loc["brand"] != "Other"
        city_known = bool(loc["city"]) and loc["city"] != "Unknown"
        if not brand_known or not city_known:
            flag(None, loc_id, "unverified_location", f"brand={loc['brand']!r} city={loc['city']!r}")

    # Resolve whatever was open but is no longer detected (the condition
    # cleared), and self-heal any pre-existing duplicate-open rows for an
    # identity that's still active down to exactly one kept-open row.
    ids_to_resolve = []
    for key, rows in open_flags.items():
        rows_sorted = sorted(rows, key=lambda r: r["id"])
        still_present = key in detected_identities
        for i, r in enumerate(rows_sorted):
            if still_present and i == 0:
                continue  # the one row we keep open for an ongoing condition
            ids_to_resolve.append(r["id"])

    if ids_to_resolve:
        placeholders = ",".join("?" * len(ids_to_resolve))
        conn.execute(
            f"UPDATE validation_flags SET resolved_at = ? WHERE id IN ({placeholders})",
            (now, *ids_to_resolve),
        )

    conn.commit()

    # Re-attempt the defense-in-depth partial unique index now that
    # self-healing (above) has had its chance to clear any pre-existing
    # duplicate-open-flag violation. Unlike db._migrate_schema()'s own
    # attempt (which runs before self-healing and only warns, since a
    # violation there is expected), a failure HERE means self-healing itself
    # did not actually clear the violation -- that's a real bug, not a
    # transient condition, and must stop the pipeline rather than silently
    # leaving the invariant unenforced.
    if not db.ensure_validation_flags_open_identity_index(conn):
        raise RuntimeError(
            "idx_validation_flags_open_identity still could not be created "
            "after this run's own self-healing completed -- a duplicate open "
            "flag must still exist despite run()'s de-duplication logic. "
            "This indicates a bug in the self-healing logic itself, not "
            "pre-existing unmigrated data, and must be investigated before "
            "validation is trusted again."
        )
    conn.commit()

    return counts


def main():
    conn = db.get_connection()
    db.init_schema(conn)
    counts = run(conn)
    conn.close()
    print(f"Validation complete: {counts}")
    return counts


if __name__ == "__main__":
    main()
