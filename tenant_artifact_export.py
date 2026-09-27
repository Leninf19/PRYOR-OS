"""
tenant_artifact_export.py -- Multi-Tenant Phase 4G: the ONE place Initial
Sync (and any future re-sync) generates a tenant's real private-data
artifacts, reusing export_chunks.py's own production functions rather than
a second, independently-maintained implementation. Per this phase's
explicit requirement: meta.json, action-items.json, gbp-sync.json, the
review-location index, and per-location review chunks must all come from
the SAME canonical code export_chunks.py's own nightly LTA pipeline uses --
never a duplicated computation that could silently drift from it.

HOW REUSE WORKS SAFELY: export_chunks.py's export_*() functions already
read the module-global PRIVATE_DATA_DIR at write time (see that module's
write_json()) -- export_chunks.main() itself sets this global once per
invocation for Los Tres Amigos's own tenant-scoped export
(tenant_paths.resolve_export_dir(tenant_id)). generate_tenant_artifacts()
below does the Blob-tenant equivalent: point PRIVATE_DATA_DIR at a local
temp directory (never LTA's real dashboard/private-data), run the SAME
analytics computation and export functions LTA's own pipeline uses, then
read the resulting files back into an in-memory {relPath: bytes} dict for
initial_sync.py/recurring_sync.py to upload to Blob under a fresh
generation id. PRIVATE_DATA_DIR is always restored in a `finally`, so this
can never leak into anything else running in the same process (defensive,
even though initial_sync.py/recurring_sync.py are short-lived,
one-tenant-per-invocation batch processes exactly like db.DB_PATH's own
established pattern).

SCOPE (dashboard-parity revision): originally (Phase 4F/4F.1) only the 5
artifacts below were generated here -- meta.json, action-items.json,
gbp-sync.json, _internal/review-location-index.json,
reviews/by-location/*.json -- and export_chunks.py's wider analytics/
intelligence pipeline was explicitly out of scope. That gap meant a
BLOB-mode tenant's Today/Locations/Insights/Studio/Reports pages had
nothing to read: every one of them depends on refresh_analytics.py's
`analytics_cache` output (KPIs, location stats, complaint intelligence,
executive scores, AI company/location summaries, response drafts, the
weekly-report numbers, etc.), which nothing in a BLOB tenant's lifecycle
ever populated. generate_tenant_artifacts() now also runs
refresh_analytics.run_analytics_refresh() (the exact function LTA's own
update-reviews.yml cadence calls) against this same `conn`, then exports
the same additional chunks LTA's pipeline exports for those pages. Nothing
here fabricates or copies LTA's own data -- every value comes from `conn`,
which the caller has already bound to THIS tenant's own downloaded, synced
database, and refresh_analytics.run_analytics_refresh()'s own AI calls
(classification, summaries, drafts) already dedup by content hash / existing
cache key exactly as they do for LTA, so a tenant's recurring cost is
bounded to new/changed content each run, not a full recompute.

Deliberately still NOT included: export_validation(), export_scraper_status(),
export_provider_health(), export_location_contacts(), export_reviews_csv()
-- none of Today/Reviews/Calendar/Locations/Insights/Studio/Content/Reports/
Settings (the audited routes) depend on them; they back separate,
un-audited routes (DataValidation/ScraperStatus/ProviderHealth pages) and a
Python-only weekly-email input, respectively. Adding them is a reasonable
future extension, not a defect fix, so it is left out here.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import export_chunks
import refresh_analytics

# The artifacts _verify_generation() (initial_sync.py) requires to exist --
# reviews/by-location/*.json is checked separately, once per location,
# since its filename depends on each location's own slug. Deliberately
# unchanged by the dashboard-parity revision: the analytics/intelligence
# files added below are real dashboard dependencies (see this module's
# header), but were never part of the original Phase 4F/4F.1 hard
# completeness gate, and making them REQUIRED here would turn a merely
# slow/still-computing sync into a hard verification failure. They remain
# best-effort additions.
REQUIRED_RELATIVE_PATHS = ("meta.json", "action-items.json", "gbp-sync.json", "_internal/review-location-index.json")


def generate_tenant_artifacts(conn, tenant_id: str) -> dict[str, bytes]:
    """Runs export_chunks.py's real export functions (plus, since the
    dashboard-parity revision, refresh_analytics.py's real analytics
    computation) against `conn` (already bound, by the caller, to the
    tenant's own downloaded and synced database) and returns every
    resulting file as {relPath: bytes}. Never touches Los Tres Amigos's
    real dashboard/private-data directory -- PRIVATE_DATA_DIR is redirected
    to a local temp dir for the duration of this call only, and restored
    (even on an exception) before returning control to the caller."""
    locations = {row["id"]: dict(row) for row in conn.execute("SELECT * FROM locations").fetchall()}

    # Populates analytics_cache (KPIs, location stats, complaint/executive/
    # AI intelligence, response drafts, etc.) -- the exact same function
    # LTA's own update-reviews.yml cadence calls. Must run BEFORE the
    # export_* calls below, since several of them (export_analytics_cache,
    # export_location_analytics, export_intelligence) only serialize
    # whatever is already in analytics_cache at call time.
    refresh_analytics.run_analytics_refresh(conn, tenant_id)

    with tempfile.TemporaryDirectory(prefix="tenant-artifact-export-") as tmp:
        original_dir = export_chunks.PRIVATE_DATA_DIR
        export_chunks.PRIVATE_DATA_DIR = Path(tmp)
        try:
            export_chunks.export_meta(conn, locations)
            export_chunks.export_action_items(conn, locations)
            export_chunks.export_gbp_sync_status(conn, locations)
            export_chunks.export_review_location_index(conn, locations)
            export_chunks.export_location_detail_reviews(conn, locations)  # writes reviews/by-location/*.json
            # Dashboard-parity revision -- see this module's header.
            export_chunks.export_analytics_cache(conn)               # analytics/{kpis,monthly-trend,location-stats,rankings-30d}.json
            export_chunks.export_location_analytics(conn, locations)  # analytics/locations/{locationId}.json
            export_chunks.export_intelligence(conn, locations)        # intelligence/*.json (company summary, complaint intel, executive scores, drafts, etc.)
            export_chunks.export_weekly_report(conn, locations)        # reports/weekly-summary.json
        finally:
            export_chunks.PRIVATE_DATA_DIR = original_dir

        artifacts: dict[str, bytes] = {}
        for path in Path(tmp).rglob("*.json"):
            rel_path = path.relative_to(tmp).as_posix()
            artifacts[rel_path] = path.read_bytes()
    return artifacts
