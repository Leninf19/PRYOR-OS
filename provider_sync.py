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
import inspect
import re
from datetime import datetime, timezone

import db
from provider_base import Provider, ProviderError


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


def _link_locations(conn, provider_locations: list, our_locations: list, now: str) -> dict:
    """Matches every provider-discovered location to -- or creates -- the
    corresponding internal row. Returns {key: {"id", "name", "location"}},
    keeping the original ProviderLocation alongside so the per-location
    review-fetch loop below doesn't need to reconstruct one.

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
         behavior is identical to before."""
    by_name = {_norm_name(l["name"]): l for l in our_locations}
    linked = {}

    for i, ploc in enumerate(provider_locations):
        existing_row = db.get_location_by_gbp_name(conn, ploc.external_id)
        if existing_row:
            loc_id, loc_name = existing_row["id"], existing_row["name"]
        else:
            gname = _norm_name(ploc.name)
            match = by_name.get(gname) or next(
                (l for l in our_locations
                 if gname and (gname in _norm_name(l["name"]) or _norm_name(l["name"]) in gname)),
                None,
            )
            if match:
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

        key = ploc.external_id or f"__unlinked_{i}__"
        linked[key] = {"id": loc_id, "name": loc_name, "location": ploc}

    return linked


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
        """INSERT INTO scraper_runs (started_at, finished_at, mode, status, error_summary, failure_stage, provider)
           VALUES (?, ?, ?, 'failed', ?, 'account_discovery', ?)""",
        (now, datetime.now(timezone.utc).isoformat(), mode, reason[:2000], provider_name),
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
        return {"status": "failed", "reason": str(e)}

    our_locations = [dict(r) for r in conn.execute("SELECT * FROM locations WHERE is_active = 1").fetchall()]
    linked = _link_locations(conn, provider_locations, our_locations, now)
    conn.commit()

    run_id = conn.execute(
        """INSERT INTO scraper_runs (started_at, mode, status, locations_attempted, provider)
           VALUES (?, ?, 'running', ?, ?)""",
        (now, mode, len(linked), provider.name),
    ).lastrowid
    conn.commit()

    total_new = total_edited = total_deleted = 0
    locations_succeeded = locations_failed = 0
    errors = []
    new_reviews_detail = []

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

    return {
        "status": status, "run_id": run_id,
        "locations_succeeded": locations_succeeded, "locations_failed": locations_failed,
        "new": total_new, "edited": total_edited, "deleted": total_deleted, "errors": errors,
        "new_reviews": new_reviews_detail,
    }
