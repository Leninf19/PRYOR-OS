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
temp directory (never LTA's real dashboard/private-data), call the SAME
five export functions the Phase 4G artifact list requires, then read the
resulting files back into an in-memory {relPath: bytes} dict for
initial_sync.py to upload to Blob under a fresh generation id.
PRIVATE_DATA_DIR is always restored in a `finally`, so this can never leak
into anything else running in the same process (defensive, even though
initial_sync.py is a short-lived, one-tenant-per-invocation batch process
exactly like db.DB_PATH's own established pattern).

SCOPE: only the 5 artifacts Phase 4F/4F.1 already provisioned as empty
placeholders are generated here -- meta.json, action-items.json,
gbp-sync.json, _internal/review-location-index.json,
reviews/by-location/*.json. export_chunks.py's wider analytics/
intelligence pipeline (KPIs, trends, AI summaries, weekly reports) is out
of this phase's scope; a tenant's Reviews/Action Items pages work from
these five, and nothing here fabricates or copies LTA's own data -- every
value comes from `conn`, which the caller has already bound to THIS
tenant's own downloaded, synced database.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import export_chunks

# The artifacts _verify_generation() (initial_sync.py) requires to exist --
# reviews/by-location/*.json is checked separately, once per location,
# since its filename depends on each location's own slug.
REQUIRED_RELATIVE_PATHS = ("meta.json", "action-items.json", "gbp-sync.json", "_internal/review-location-index.json")


def generate_tenant_artifacts(conn) -> dict[str, bytes]:
    """Runs export_chunks.py's real export functions against `conn`
    (already bound, by the caller, to the tenant's own downloaded and
    synced database) and returns every resulting file as {relPath: bytes}.
    Never touches Los Tres Amigos's real dashboard/private-data directory
    -- PRIVATE_DATA_DIR is redirected to a local temp dir for the duration
    of this call only, and restored (even on an exception) before returning
    control to the caller."""
    locations = {row["id"]: dict(row) for row in conn.execute("SELECT * FROM locations").fetchall()}

    with tempfile.TemporaryDirectory(prefix="tenant-artifact-export-") as tmp:
        original_dir = export_chunks.PRIVATE_DATA_DIR
        export_chunks.PRIVATE_DATA_DIR = Path(tmp)
        try:
            export_chunks.export_meta(conn, locations)
            export_chunks.export_action_items(conn, locations)
            export_chunks.export_gbp_sync_status(conn, locations)
            export_chunks.export_review_location_index(conn, locations)
            export_chunks.export_location_detail_reviews(conn, locations)  # writes reviews/by-location/*.json
        finally:
            export_chunks.PRIVATE_DATA_DIR = original_dir

        artifacts: dict[str, bytes] = {}
        for path in Path(tmp).rglob("*.json"):
            rel_path = path.relative_to(tmp).as_posix()
            artifacts[rel_path] = path.read_bytes()
    return artifacts
