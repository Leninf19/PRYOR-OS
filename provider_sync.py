"""
provider_sync.py -- Phase 3 Milestone 4: the generic, provider-agnostic sync
orchestrator. Runs the same discover -> link -> fetch -> upsert -> record-run
cycle for any Provider (GBPProvider, ScraperProvider, MockProvider).

Moved and generalized from gbp_sync.py's original sync_all()/_link_locations/
_record_early_failure (Phase 3 Milestone 1) rather than rewritten --
gbp_sync.py's own sync_all() is now a thin wrapper delegating here (see
gbp_sync.py's docstring), and sync_reviews.py is the new, provider-selecting
CLI entrypoint that calls this directly for any of the three providers.

Not wired into any production workflow yet: update-reviews.yml and
critical-alert-check.yml are untouched, still calling auto_update.py/
gbp_sync.py directly. Wiring an actual production workflow to call
sync_reviews.py instead is Phase 3 Milestone 4b's job, deliberately deferred
(a real production behavior change gets its own explicit review).
"""
import asyncio
import inspect
import os
import re
import traceback
from datetime import datetime, timedelta, timezone

import db
import validate
from provider_base import Provider, ProviderError

# How long a row may sit at status='running' before the watchdog in
# health_check.py treats it as dead rather than merely slow -- see
# reconcile_stuck_runs() below. A real sync should never take anywhere near
# this long (update-reviews.yml's own scrape step has a 30-minute CI
# timeout); a run still 'running' after a full cron cycle was never going to
# self-report, not just running late.
STUCK_RUN_TIMEOUT = timedelta(hours=6)


def _norm_name(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


# Phase 3 Milestone 4.1: `mode` historically described *how* a run was
# invoked ('local'/'cloud' for auto_update.py's interactive/CI paths,
# 'api_sync' for gbp_sync.py's programmatic API sync) -- kept deliberately
# separate from `provider` (which data source). Now that every provider goes
# through this one orchestrator, `mode` is looked up per provider rather than
# hardcoded, so each one keeps writing exactly the value it always did:
#   - GBPProvider  -> 'api_sync' (unchanged from gbp_sync.py's original value;
#     export_chunks.py's export_gbp_sync_status() specifically filters
#     `WHERE mode = 'api_sync'` to find genuine GBP runs -- any other
#     provider writing 'api_sync' too would make that query pick up a
#     non-GBP run and mislabel it).
#   - ScraperProvider -> 'cloud' (matching auto_update.py's own CI value).
#   - MockProvider -> 'mock', a new, distinct value -- deliberately NOT
#     'local', which specifically implies auto_update.py --local's
#     interactive git-commit/push/deploy flow that MockProvider never goes
#     through.
# A provider with no explicit entry defaults to 'api_sync' (the safest
# choice for a hypothetical future provider synced programmatically, same
# as gbp_sync.py's original, only-ever-GBP behavior).
_MODE_BY_PROVIDER = {
    "gbp": "api_sync",
    "scraper": "cloud",
    "mock": "mock",
}


def _mode_for(provider: Provider) -> str:
    return _MODE_BY_PROVIDER.get(provider.name, "api_sync")


async def _maybe_await(value):
    """Providers are not uniformly sync or async -- GBPProvider/MockProvider
    are plain sync (matching the Provider ABC's own literal method
    signatures); ScraperProvider is async (Playwright requires it). This is
    the one seam that lets this orchestrator call any of them generically,
    without changing any existing provider's method signature: a plain
    return value passes through unchanged, a coroutine gets awaited."""
    if inspect.isawaitable(value):
        return await value
    return value


def _link_locations(conn, provider_locations: list, our_locations: list, now: str) -> tuple[dict, list]:
    """Matches every provider-discovered location to -- or creates -- the
    corresponding internal row. Returns (linked, collisions):
      - linked: {key: {"id", "name", "location"}}, keeping the original
        ProviderLocation alongside so the per-location review-fetch loop
        below doesn't need to reconstruct one.
      - collisions: a list of dicts describing every discovered location
        that could NOT be safely auto-linked this run (see below). Never
        empty by default -- [] when nothing collided.

    Moved from gbp_sync.py (Phase 3 Milestone 1's _link_locations) --
    already fully generic for the matching logic itself: a provider location
    with no external identity (external_id=None, e.g. ScraperProvider/
    MockProvider) is handled correctly by the existing name-based fallback
    path, since db.get_location_by_gbp_name(conn, None) can never match a
    row (SQL's `column = NULL` is never true).

    Two adaptations were required to generalize safely beyond GBP (not just
    a verbatim move):
      1. The returned dict's key was originally ploc.external_id itself --
         safe for GBP (always a unique non-None string), but every
         ScraperProvider/MockProvider location has external_id=None, which
         would collide on the same dict key and silently drop every
         location but the last. Keyed by enumeration index instead when
         there's no external_id.
      2. db.set_location_gbp_info() (which writes gbp_account_name/
         gbp_location_name/gbp_verification_status/gbp_last_synced_at) is
         now only called when ploc.external_id is truthy -- otherwise a
         Scraper/Mock sync pass would clobber gbp_last_synced_at (and NULL
         out gbp_location_name) on a location that may already be
         legitimately linked to Google by a real GBP sync. For GBPProvider,
         external_id is always truthy, so this guard is always taken and
         behavior is identical to before.

    Recovery Milestone 3 gap (found via gbp_location_diagnostic.py, 2026-08-22:
    two live GBP listings named "Casa Tequila Prime" at the same address,
    distinct resource IDs, one already linked): the fuzzy-name fallback
    below used to silently overwrite gbp_location_name whenever a SECOND,
    different external_id also matched an already-linked local row --
    "last write wins," with no record that a conflict ever happened, and
    (worse) every location's linked entry got its reviews fetched, so a
    genuine second Google listing could have its reviews attached to the
    wrong local identity. Two defensive rules now apply, both scoped to the
    fuzzy-match path ONLY -- an exact gbp_location_name match (a provider
    location whose external_id already equals what's stored) is always
    authoritative and completely unaffected by either rule:
      1. If the fuzzy match resolves to a local row whose gbp_location_name
         is already set to a DIFFERENT external_id, this is a blocked
         collision -- the existing link is left completely untouched, and
         this provider location is excluded from `linked` entirely (so
         fetch_reviews() is never called for it this run -- see sync_all()).
         A local row with no gbp_location_name yet (never linked) is NOT a
         collision -- that's an ordinary first-time link.
      2. If the fuzzy match itself is ambiguous -- the normalized name
         matches MORE THAN ONE local row -- this is also a blocked
         collision. The previous code picked next()'s first result
         arbitrarily; it now never guesses."""
    by_name = {_norm_name(l["name"]): l for l in our_locations}
    # Keyed by id, sharing the SAME dict objects as our_locations/by_name (not
    # copies) -- updated in place below whenever a gbp_location_name write
    # happens, so the collision check a few iterations later in THIS SAME
    # loop sees it too. Without this, two brand-new (never-before-linked)
    # colliding external_ids discovered in the same run would each see the
    # OTHER's write as "still unlinked" (the pre-loop snapshot never
    # refreshes), and the second would incorrectly be allowed to also link --
    # the exact silent-overwrite this whole change exists to prevent. Only
    # matters for this in-run ordering; a location already linked from a
    # PRIOR run is caught immediately by the exact-match branch above
    # regardless (that's how the real Casa Tequila Prime case is caught).
    by_id = {l["id"]: l for l in our_locations}
    linked = {}
    collisions = []

    for i, ploc in enumerate(provider_locations):
        existing_row = db.get_location_by_gbp_name(conn, ploc.external_id)
        if existing_row:
            # Exact resource-ID match is always authoritative -- unchanged.
            loc_id, loc_name = existing_row["id"], existing_row["name"]
        else:
            gname = _norm_name(ploc.name)
            exact_name_match = by_name.get(gname)
            substring_matches = [
                l for l in our_locations
                if gname and (gname in _norm_name(l["name"]) or _norm_name(l["name"]) in gname)
            ] if not exact_name_match else []

            if exact_name_match:
                match = exact_name_match
            elif len(substring_matches) > 1:
                collisions.append({
                    "kind": "ambiguous_fuzzy_match",
                    "location_id": None, "location_name": None,
                    "existing_gbp_id": None, "conflicting_gbp_id": ploc.external_id,
                    "gbp_name": ploc.name, "city": ploc.city, "address": ploc.address,
                    "candidate_local_names": [l["name"] for l in substring_matches],
                })
                print(f"GBP_LOCATION_COLLISION kind=ambiguous_fuzzy_match "
                      f"gbp_name={ploc.name!r} gbp_id={ploc.external_id} "
                      f"candidates={[l['name'] for l in substring_matches]}")
                continue
            else:
                match = substring_matches[0] if substring_matches else None

            if match:
                existing_gbp_id = match["gbp_location_name"]
                if existing_gbp_id and existing_gbp_id != ploc.external_id:
                    collisions.append({
                        "kind": "duplicate_gbp_listing",
                        "location_id": match["id"], "location_name": match["name"],
                        "existing_gbp_id": existing_gbp_id, "conflicting_gbp_id": ploc.external_id,
                        "gbp_name": ploc.name, "city": ploc.city, "address": ploc.address,
                        "candidate_local_names": None,
                    })
                    print(f"GBP_LOCATION_COLLISION kind=duplicate_gbp_listing "
                          f"location_id={match['id']} location_name={match['name']!r} "
                          f"retained={existing_gbp_id} conflicting={ploc.external_id}")
                    continue
                loc_id, loc_name = match["id"], match["name"]
            else:
                # Genuinely new to us -- create it. Brand/city are
                # best-effort from the provider; correctable later in Settings.
                loc_name = ploc.name or gname
                loc_id = db.get_or_create_location(conn, loc_name, city=ploc.city)
                print(f"provider_sync.py: discovered new location '{loc_name}' -- added automatically")

        if ploc.external_id:
            account_name = ploc.provider_metadata.get("account_name")
            db.set_location_gbp_info(conn, loc_id, account_name, ploc.external_id,
                                      ploc.verification_status, now)
            if loc_id in by_id:
                by_id[loc_id]["gbp_location_name"] = ploc.external_id

        key = ploc.external_id or f"__unlinked_{i}__"
        linked[key] = {"id": loc_id, "name": loc_name, "location": ploc}

    return linked, collisions


def _reconcile_collision_flags(conn, collisions: list, now: str) -> None:
    """Mirrors validate.py's own open/detect/resolve pattern (see that
    module's docstring) exactly, scoped to just the 'duplicate_gbp_listing'
    flag_type: a location colliding THIS run gets exactly one open flag --
    no new row if one is already open, so a collision that persists across
    every sync (the expected case until the duplicate Google listing is
    merged or excluded) never grows duplicate rows. A location that WAS
    colliding but isn't detected as colliding this run (the duplicate was
    merged/removed on Google's side) gets its open flag resolved
    automatically, the same way validate.py resolves a cleared condition.

    Only 'duplicate_gbp_listing' (a real local location_id, from a fuzzy
    match landing on an already-differently-linked row) becomes a
    validation_flags row -- 'ambiguous_fuzzy_match' collisions (see
    _link_locations) have no location_id to anchor a flag to (nothing
    resolved at all) and are surfaced via the GBP_LOCATION_COLLISION log
    line only."""
    by_location = {
        c["location_id"]: c for c in collisions if c["kind"] == "duplicate_gbp_listing"
    }

    open_rows = conn.execute(
        "SELECT id, location_id FROM validation_flags "
        "WHERE resolved_at IS NULL AND flag_type = 'duplicate_gbp_listing'"
    ).fetchall()
    open_by_location: dict = {}
    for r in open_rows:
        open_by_location.setdefault(r["location_id"], []).append(r["id"])

    for location_id, c in by_location.items():
        if location_id in open_by_location:
            continue  # already open -- leave it in place, matches validate.py's own invariant
        detail = (
            f"gbp_name={c['gbp_name']!r} existing_gbp_id={c['existing_gbp_id']!r} "
            f"conflicting_gbp_id={c['conflicting_gbp_id']!r} city={c['city']!r} "
            "reason='two Google Business Profile listings with the same normalized "
            "name resolve to this one local location'"
        )
        validate.insert_flag(conn, None, location_id, "duplicate_gbp_listing", detail, now)

    ids_to_resolve = []
    for location_id, ids in open_by_location.items():
        ids_sorted = sorted(ids)
        still_colliding = location_id in by_location
        for i, flag_id in enumerate(ids_sorted):
            if still_colliding and i == 0:
                continue  # the one row kept open for an ongoing collision
            ids_to_resolve.append(flag_id)  # resolved, or a self-healed duplicate-open row

    if ids_to_resolve:
        placeholders = ",".join("?" * len(ids_to_resolve))
        conn.execute(
            f"UPDATE validation_flags SET resolved_at = ? WHERE id IN ({placeholders})",
            (now, *ids_to_resolve),
        )


def _record_early_failure(conn, now: str, reason: str, provider_name: str, mode: str) -> None:
    """A failure at location discovery (before any location is even known)
    previously left no scraper_runs row at all, so Data Health / Location
    Sync showed nothing rather than a visible failure. This gives every
    sync attempt a row, matching the per-location failure path below.
    failure_stage='account_discovery' is the explicit marker notify.py uses
    to pick the global-failure template instead of the per-location one --
    it is NEVER inferred from zeroed location counters, only set here.

    mode is provider-dependent (see _mode_for()/_MODE_BY_PROVIDER above),
    not hardcoded -- Phase 3 Milestone 4.1."""
    conn.execute(
        """INSERT INTO scraper_runs (started_at, finished_at, mode, status, error_summary, failure_stage, provider, workflow_run_id)
           VALUES (?, ?, ?, 'failed', ?, 'account_discovery', ?, ?)""",
        (now, datetime.now(timezone.utc).isoformat(), mode, reason[:2000], provider_name,
         os.environ.get("GITHUB_RUN_ID")),
    )
    conn.commit()


async def sync_all(provider: Provider, *, fast: bool = False) -> dict:
    """Runs one full sync pass for any Provider. Returns run stats
    (new/edited/deleted counts) in the same shape auto_update.py's own run
    stats and gbp_sync.py's previous sync_all() already used, so any caller
    (a workflow, a notification script, a test) can treat any provider's
    result identically.

    Moved and generalized from gbp_sync.py's original sync_all() (Phase 3
    Milestone 1). The only behavioral differences from that original: the
    provider name written to scraper_runs.provider is provider.name (not
    hardcoded 'gbp'), the "not configured" reason string names the provider
    generically (provider.display_name) rather than hardcoding "Google
    credentials" -- for GBPProvider this reads "Google Business Profile not
    configured" instead of the original "Google credentials not configured";
    no test asserts the exact original string, and the generalized text
    remains accurate and unambiguous -- and scraper_runs.mode is looked up
    per provider (see _mode_for()) rather than hardcoded 'api_sync' (Phase 3
    Milestone 4.1: hardcoding it for every provider would have made
    export_chunks.py's export_gbp_sync_status() mistake a ScraperProvider/
    MockProvider run for a genuine GBP one). For GBPProvider this still
    resolves to 'api_sync', identical to before. Every other behavior --
    location linking, dedup/upsert, deletion detection, per-location and
    run-level status computation, the returned dict shape -- is identical
    for GBPProvider."""
    conn = db.get_connection()
    db.init_schema(conn)
    now = datetime.now(timezone.utc).isoformat()
    mode = _mode_for(provider)

    if not provider.is_configured():
        return {"status": "skipped", "reason": f"{provider.display_name} not configured"}

    try:
        provider_locations = await _maybe_await(provider.discover_locations())
    except ProviderError as e:
        _record_early_failure(conn, now, str(e), provider.name, mode)
        # Diagnostics-only additions (error_type/error_status/error_traceback):
        # `e` already carries its class and (for GBPError/ProviderError
        # subclasses) an HTTP status, but both were previously discarded the
        # moment this became a plain dict -- callers (critical_alert_check.py)
        # had no way to distinguish a quota block from an auth failure from a
        # genuinely unexpected error, and fell back to a generic 'reason'/
        # 'errors' key mismatch that silently printed None. Purely additive:
        # 'status'/'reason' are unchanged, no control flow or DB write here
        # is different from before.
        return {
            "status": "failed",
            "reason": str(e),
            "error_type": type(e).__name__,
            "error_status": e.status,
            "error_traceback": traceback.format_exc(),
        }

    our_locations = [dict(r) for r in conn.execute("SELECT * FROM locations WHERE is_active = 1").fetchall()]
    linked, collisions = _link_locations(conn, provider_locations, our_locations, now)
    _reconcile_collision_flags(conn, collisions, now)
    conn.commit()

    run_id = conn.execute(
        """INSERT INTO scraper_runs (started_at, mode, status, locations_attempted, provider, workflow_run_id)
           VALUES (?, ?, 'running', ?, ?, ?)""",
        (now, mode, len(linked), provider.name, os.environ.get("GITHUB_RUN_ID")),
    ).lastrowid
    conn.commit()

    total_new = total_edited = total_deleted = 0
    locations_succeeded = locations_failed = 0
    errors = []
    new_reviews_detail = []

    # Every path out of this block -- normal completion, an explicit
    # cancellation, or a completely unexpected exception -- must leave this
    # run row with a terminal status. Before this fix, only normal
    # completion did: a non-ProviderError exception anywhere in the loop
    # below (e.g. a Playwright crash surfacing as a raw exception rather
    # than a classified ProviderError -- see provider_scraper.py's
    # classify_scraper_error()/retry.py's is_retryable, which only tolerate
    # ProviderError) propagated straight out of sync_all() and left the row
    # at status='running' forever, with no finished_at -- exactly run #159's
    # symptom. The process being alive to reach an except/finally clause is
    # the load-bearing assumption here; a hard kill (OOM, host crash) that
    # never lets Python run this code at all is what reconcile_stuck_runs()
    # below exists to clean up after the fact.
    try:
        for _key, loc in linked.items():
            loc_start = datetime.now(timezone.utc)
            try:
                provider_reviews = await _maybe_await(provider.fetch_reviews(loc["location"], fast=fast))
            except ProviderError as e:
                locations_failed += 1
                errors.append(f"{loc['name']}: {e}")
                conn.execute(
                    """INSERT INTO scraper_run_locations (run_id, location_id, status, error_message)
                       VALUES (?, ?, 'failed', ?)""",
                    (run_id, loc["id"], str(e)),
                )
                conn.commit()
                continue

            scraped_keys = set()
            window_min_date = None
            loc_new = loc_edited = 0

            for preview in provider_reviews:
                row = preview.as_row()
                key = db.dedup_key(loc["name"], row)
                scraped_keys.add(key)
                if row["review_date"] and (window_min_date is None or row["review_date"] < window_min_date):
                    window_min_date = row["review_date"]
                result = db.upsert_review(conn, loc["id"], loc["name"], row, now)
                if result == "new":
                    loc_new += 1
                    new_reviews_detail.append({
                        "location": loc["name"], "reviewer_name": row["reviewer_name"],
                        "star_rating": row["star_rating"], "review_text": row["review_text"],
                    })
                elif result == "edited":
                    loc_edited += 1

            # Skipped on the fast/partial path -- a one-page fetch doesn't cover
            # enough of the review window for detect_deletions to judge absence
            # correctly (it would misread "not on this page" as "deleted").
            loc_deleted = (
                db.detect_deletions(conn, loc["id"], scraped_keys, window_min_date, now)
                if (window_min_date and not fast) else 0
            )

            conn.execute(
                """INSERT INTO scraper_run_locations
                   (run_id, location_id, status, reviews_found, reviews_new, duration_ms)
                   VALUES (?, ?, 'success', ?, ?, ?)""",
                (run_id, loc["id"], len(provider_reviews), loc_new,
                 int((datetime.now(timezone.utc) - loc_start).total_seconds() * 1000)),
            )
            conn.commit()

            locations_succeeded += 1
            total_new += loc_new
            total_edited += loc_edited
            total_deleted += loc_deleted

        status = "ok" if locations_failed == 0 else ("partial" if locations_succeeded > 0 else "failed")
        conn.execute(
            """UPDATE scraper_runs SET finished_at = ?, status = ?, locations_succeeded = ?,
               locations_failed = ?, new_reviews_count = ?, edited_reviews_count = ?,
               deleted_reviews_count = ?, error_summary = ? WHERE id = ?""",
            (datetime.now(timezone.utc).isoformat(), status, locations_succeeded, locations_failed,
             total_new, total_edited, total_deleted, "; ".join(errors)[:2000] or None, run_id),
        )
        conn.commit()
    except asyncio.CancelledError:
        # Deliberately distinct from 'failed': the process itself observed
        # and is honoring a cancellation (e.g. the workflow step was
        # cancelled) rather than hitting a bug. Must still re-raise --
        # asyncio requires CancelledError to propagate.
        conn.execute(
            """UPDATE scraper_runs SET finished_at = ?, status = 'cancelled', locations_succeeded = ?,
               locations_failed = ?, new_reviews_count = ?, edited_reviews_count = ?,
               deleted_reviews_count = ?, error_summary = ? WHERE id = ?""",
            (datetime.now(timezone.utc).isoformat(), locations_succeeded, locations_failed,
             total_new, total_edited, total_deleted, "run was cancelled before completing", run_id),
        )
        conn.commit()
        raise
    except Exception as e:
        # An unexpected, non-ProviderError exception (a bug, an unclassified
        # Playwright failure, a DB error) -- give the run a terminal status
        # with as much partial progress as was recorded, then re-raise
        # unchanged. Matches sync_reviews.py's existing "a genuinely
        # unexpected error must still surface loudly" contract (see
        # test_non_provider_error_during_discovery_propagates_uncaught) --
        # this only adds the missing DB bookkeeping, it does not swallow
        # the error into a graceful {"status": "failed"} return value.
        conn.execute(
            """UPDATE scraper_runs SET finished_at = ?, status = 'failed', locations_succeeded = ?,
               locations_failed = ?, new_reviews_count = ?, edited_reviews_count = ?,
               deleted_reviews_count = ?, error_summary = ? WHERE id = ?""",
            (datetime.now(timezone.utc).isoformat(), locations_succeeded, locations_failed,
             total_new, total_edited, total_deleted,
             f"Unhandled exception: {type(e).__name__}: {e}"[:2000], run_id),
        )
        conn.commit()
        raise

    return {
        "status": status, "run_id": run_id,
        "locations_succeeded": locations_succeeded, "locations_failed": locations_failed,
        "new": total_new, "edited": total_edited, "deleted": total_deleted, "errors": errors,
        "new_reviews": new_reviews_detail,
        # Recovery Milestone 3: locations discovered but excluded from `linked`
        # (and therefore never fetch_reviews()'d this run) because linking them
        # would have overwritten a different existing gbp_location_name, or
        # because their normalized name matched more than one local row. See
        # _link_locations()/_reconcile_collision_flags(). Purely additive --
        # every existing key above is unchanged.
        "location_collisions": collisions,
    }


def reconcile_stuck_runs(conn, *, now: datetime | None = None,
                          timeout: timedelta = STUCK_RUN_TIMEOUT) -> list[dict]:
    """Watchdog reconciliation (see health_check.py, which calls this before
    its own alerting checks run): finds every scraper_runs row still
    status='running' after `timeout` has elapsed since it started, and marks
    it 'timed_out' with a finished_at and explanatory error_summary.

    This is the fix for "the same stuck run alerts forever": once reconciled,
    a row no longer matches health_check.py's `WHERE status = 'running'`
    stuck-run query, so it can only ever be surfaced once by that check
    (health_check.py's own dedup, scoped per-run-id, handles the case where
    it hasn't been reconciled yet but has already been alerted on). It is
    also the fix for "an old abandoned run must not look like a current
    failure": provider_health.compute_health() judges health from the most
    recent rows *by position in scraper_runs* (i.e. by when they started),
    not by when they were reconciled -- marking a 3-day-old row 'timed_out'
    today does not move it to "most recent," it just replaces a silent,
    perpetual gap with an honest terminal record in its correct chronological
    slot.

    Never touches a row that might still be legitimately in progress
    (anything younger than `timeout`) and never deletes or rewrites any
    review data -- this only ever updates scraper_runs.status/finished_at/
    error_summary on rows that are already, unambiguously stuck.

    Returns the list of rows just reconciled (as dicts), for the caller to
    alert on -- each row can only ever appear here once, since reconciliation
    is a one-way transition out of 'running'."""
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timeout).isoformat()
    stuck = [dict(r) for r in conn.execute(
        "SELECT * FROM scraper_runs WHERE status = 'running' AND started_at < ? ORDER BY id",
        (cutoff,),
    ).fetchall()]

    for row in stuck:
        conn.execute(
            """UPDATE scraper_runs SET finished_at = ?, status = 'timed_out',
               error_summary = ? WHERE id = ?""",
            (now.isoformat(),
             f"Reconciled by watchdog: no terminal status was ever recorded within "
             f"{timeout.total_seconds() / 3600:.0f}h of starting -- the process most likely "
             f"crashed or was killed before it could update its own run record.",
             row["id"]),
        )
    if stuck:
        conn.commit()
    return stuck
