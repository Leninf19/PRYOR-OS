"""
provision_tenant.py -- Multi-Tenant Phase 4F (revised in Phase 4F.1 for
durable Blob-backed storage): creates the review-storage resources (a
per-tenant reviews.db + private-data JSON artifacts, both stored in Vercel
Blob) a tenant needs before Phase 4G's Initial Sync can write real reviews
into them.

WHY BLOB, NOT A LOCAL FILESYSTEM DIRECTORY (Phase 4F.1): Phase 4F originally
built this under a local directory (tenant_paths.PROVISIONED_TENANTS_ROOT).
A dedicated production-persistence audit then proved that design cannot
survive in production: this script runs on an ephemeral GitHub Actions
runner, the dashboard API runs on Vercel serverless Node, and Python's GBP
sync workers run on yet another ephemeral runner -- none of these share a
filesystem, and nothing in the existing CI/CD pipeline ever commits or
deploys a tenant-data directory anywhere. Vercel Blob (already a real,
wired-in dependency of this project -- see dashboard/api/_lib/blobStore.js)
is a genuinely durable, network-accessible store reachable from all three
environments, so it replaces the local directory entirely for every tenant
this script provisions. Los Tres Amigos is NOT migrated by this change --
it keeps its existing git-committed reviews.db/private-data, storageMode
'LEGACY_REPO', and is never provisioned via this script at all.

WHAT THIS DOES NOT DO: sync any reviews from Google. That is Initial Sync
(Phase 4G, not built here) -- explicitly blocked until this durable storage
layer is complete. This script's only job is to bring a tenant from
"locations approved" (tenant_config's approvedLocations/locationIdMap,
written by google/[action].js's approveLocations()) to "has a real,
verified, empty reviews.db and private-data artifacts durably stored in
Vercel Blob, with its locations table pre-populated at the exact stable
numeric ids already reserved for it" -- i.e. a safe place for Initial Sync
to write into later, never fabricated review data.

TRUSTED INPUT ONLY: tenant_id is validated (tenant_keys.assert_valid_tenant_id)
before anything else runs, and every Blob key this script touches is
computed exclusively by tenant_blob_keys.py's deterministic formula over
that validated tenant_id -- never a key built by interpolating request input
into some other pattern. Only a tenant whose tenant_config record has
storageMode == 'BLOB' is ever provisioned here; any other value (LEGACY_REPO,
or a future mode this script doesn't understand) is a hard, fail-closed
refusal (UnsupportedStorageModeError) -- this script must never guess at or
silently "adapt to" a storage mode it wasn't explicitly built for.

STABLE LOCATION IDS: unchanged from Phase 4F -- every location's numeric
`locations.id` comes EXCLUSIVELY from tenant_config's locationIdMap
(googleLocationId -> locationId, permanent, allocated once, never
reassigned) via an explicit `INSERT INTO locations (id, ...)`, never
SQLite's own AUTOINCREMENT, never array position, never discovery/
alphabetical order. Every approvedLocations entry is cross-checked against
locationIdMap for consistency BEFORE any Blob I/O -- a missing/duplicate/
conflicting mapping fails closed with nothing uploaded at all.

CONCURRENCY, REVISED FOR BLOB (Phase 4F.1): the tenant_config record itself
is still protected exactly as in Phase 4F's closure -- every write after the
initial read is a CAS via `expected_version` (see tenant_config_store.py).
NEW in this phase: the reviews.db Blob object has its OWN, independent
concurrency guarantee, because two different pieces of state can each be
raced against (the tenant_config record, AND the Blob object's actual bytes)
and both must be protected, not just the former. This uses Vercel Blob's
NATIVE conditional-write support (confirmed directly against the installed
@vercel/blob@2.8.0 SDK's own type definitions and request-building code --
see tenant_blob_store.py's header): every reviews.db upload either supplies
`allow_overwrite=False` (no Blob may exist yet at that key -- the correct
guard for this tenant's very FIRST upload, catching a racing first writer)
or `if_match=<the ETag most recently read from Blob>` (the correct guard for
a later, reconciling upload -- catching any writer that started from a
generation someone else has since superseded). Vercel Blob itself, not
Redis and not application code, is the single atomic authority for "did the
database change since I looked" -- there is no read-then-write window in
this script for a second writer to race into, because the check and the
write are the SAME request to Blob's storage layer.

IDEMPOTENCY / PARTIAL-FAILURE RECOVERY: see provision_tenant()'s own
docstring below for the full state machine. Summary: fresh work happens
entirely against a local temp directory (never uploaded until fully built
and verified), uploaded to Blob only once verified, and tenant_config is
only ever confirmed 'provisioned' AFTER every upload succeeds. An
interruption at any point before the final tenant_config CAS write leaves
the tenant NOT provisioned (any partial Blob uploads are simply orphaned,
inert objects a fresh attempt will overwrite or ignore -- never mistaken for
a real tenant's authoritative state, since tenant_config's own recorded
reviewDbBlobKey/status is what every reader actually trusts, not "does a
Blob object happen to exist"). A retry against a tenant whose reviews.db
Blob already exists and is fully consistent with the current
approvedLocations is a safe, cheap no-op. A retry that finds an EMPTY (zero
real reviews) database missing only newly-approved locations safely adds
just those rows via a download-modify-reupload-with-if_match cycle. A
database that already contains real review data is NEVER touched by this
script under any circumstances, consistent or not -- provisioning existing,
live tenants is explicitly out of scope for this phase.

Run directly: py provision_tenant.py --tenant-id t_example-restaurant
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

import db
import tenant_blob_keys
import tenant_blob_store
import tenant_config_store
import tenant_keys
import tenant_location_mapping


class ProvisioningError(Exception):
    """Base class for every fail-closed provisioning refusal below."""


class UnknownTenantConfigError(ProvisioningError):
    """The tenant has no tenant_config record at all -- unknown tenant."""


class TenantNotApprovedError(ProvisioningError):
    """The tenant's current status does not permit provisioning (still
    onboarding, or suspended)."""


class NoApprovedLocationsError(ProvisioningError):
    """The tenant has approved zero locations -- nothing to provision."""


class UnsupportedStorageModeError(ProvisioningError):
    """The tenant's tenant_config.storageMode is not 'BLOB' -- this script
    only provisions Blob-backed tenants (Phase 4F.1). A LEGACY_REPO tenant
    (Los Tres Amigos) must never reach this script at all; any other/future
    value is refused rather than guessed at."""


class LocationMappingConsistencyError(ProvisioningError):
    """approvedLocations/locationIdMap disagree, are missing a valid stable
    id, or two locations claim the same numeric id -- refuses to guess."""


class ProvisioningRefusedError(ProvisioningError):
    """An existing Blob-stored resource for this tenant cannot be safely
    reconciled (it already contains real review data, or a numeric id
    already refers to a DIFFERENT Google location than currently expected)
    -- requires manual investigation, never auto-corrected destructively."""


class StaleProvisioningAttemptError(ProvisioningError):
    """Raised whenever this attempt's tenant_config write is rejected
    because the record's configVersion changed since this attempt started
    (a newer provisioning attempt, a suspension, an approved-locations
    change, or any other write), OR whenever a reviews.db Blob upload is
    rejected because the Blob's ETag changed since this attempt last read it
    (a newer provisioning/sync attempt won the race for the database
    itself). This attempt's work (if any was done) is NOT reported as the
    tenant's authoritative provisioned state. Never raised as a result of a
    fixable input error -- always retry-worthy."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slugify(name: str) -> str:
    """Byte-for-byte the same rule export_chunks.py's slugify() uses, so a
    location's by-location export filename is identical whether it was
    first written here (provisioning) or later regenerated by the real
    export pipeline."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


# ---------------------------------------------------------------------------
# Step 1: load + validate tenant_config state (no Blob access yet)
# ---------------------------------------------------------------------------

_PROVISIONABLE_STATUSES = {"locations_approved", "provisioning", "provisioning_failed", "provisioned", "active"}


def _load_and_validate_config(tenant_id: str) -> dict:
    config = tenant_config_store.get_tenant_config(tenant_id)
    if config is None:
        raise UnknownTenantConfigError(f"tenant {tenant_id!r} has no tenant_config record -- unknown tenant")

    status = config.get("status")
    if status == "suspended":
        raise TenantNotApprovedError(f"tenant {tenant_id!r} is suspended -- refusing to provision")
    if status not in _PROVISIONABLE_STATUSES:
        raise TenantNotApprovedError(
            f"tenant {tenant_id!r} has status {status!r} -- locations must be approved "
            f"(status 'locations_approved') before provisioning can run"
        )

    storage_mode = config.get("storageMode")
    if storage_mode != "BLOB":
        raise UnsupportedStorageModeError(
            f"tenant {tenant_id!r} has storageMode {storage_mode!r} -- this script only provisions "
            f"BLOB-mode tenants; a LEGACY_REPO tenant (Los Tres Amigos) must never be provisioned here"
        )

    approved_locations = config.get("approvedLocations") or []
    if not approved_locations:
        raise NoApprovedLocationsError(f"tenant {tenant_id!r} has no approved locations to provision")

    return config


def _validate_stable_id_consistency(approved_locations: list[dict], location_id_map: dict) -> dict[int, str]:
    """Multi-Tenant Phase 4G: delegates to tenant_location_mapping.py (the
    single, shared implementation initial_sync.py also uses) rather than
    keeping a second, independently-maintained copy of this rule -- see
    that module's header. Re-raises as THIS module's own
    LocationMappingConsistencyError (a ProvisioningError subclass) so
    existing callers/tests (main()'s `except ProvisioningError`,
    test_provision_tenant.py's `pt.LocationMappingConsistencyError`)
    continue to work unchanged."""
    try:
        return tenant_location_mapping.validate_stable_id_consistency(approved_locations, location_id_map)
    except tenant_location_mapping.LocationMappingConsistencyError as e:
        raise LocationMappingConsistencyError(str(e)) from e


# ---------------------------------------------------------------------------
# Step 2: SQLite helpers -- operate on a local temp file either way; Blob is
# only ever touched via explicit download/upload calls around these.
# ---------------------------------------------------------------------------

def _inspect_database_file(db_path: Path, expected: dict[int, str]) -> dict:
    """Reads a local reviews.db file (never writes) and classifies its state
    relative to `expected` ({locationId: googleLocationId})."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        review_count = conn.execute("SELECT COUNT(*) AS c FROM reviews").fetchone()["c"]
        rows = conn.execute("SELECT id, gbp_location_name FROM locations").fetchall()
    finally:
        conn.close()
    existing = {row["id"]: row["gbp_location_name"] for row in rows}

    mismatched = [lid for lid, gid in expected.items() if lid in existing and existing[lid] != gid]
    missing = [lid for lid in expected if lid not in existing]
    return {
        "review_count": review_count,
        "existing": existing,
        "mismatched": mismatched,
        "missing": missing,
        "fully_consistent": not mismatched and not missing,
    }


def _insert_location_with_explicit_id(conn: sqlite3.Connection, location_id: int, google_location_id: str, title: str, address: str) -> None:
    account_part = google_location_id.split("/locations/")[0] if "/locations/" in google_location_id else ""
    name = title or google_location_id
    city = address.split(",")[-1].strip() if address else ""
    conn.execute(
        """INSERT INTO locations
               (id, name, city, brand, search_query, is_active, gbp_account_name, gbp_location_name, gbp_verification_status)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)""",
        (location_id, name, city, db.get_brand(name), name, account_part, google_location_id, "UNSPECIFIED"),
    )


def _reconcile_missing_locations(db_path: Path, approved_locations: list[dict], missing_ids: list[int]) -> None:
    """Adds ONLY the rows in `missing_ids` -- never touches an existing row,
    never called unless the existing database's reviews table is verified
    empty by the caller."""
    by_id = {loc["locationId"]: loc for loc in approved_locations}
    conn = sqlite3.connect(db_path)
    try:
        for location_id in missing_ids:
            loc = by_id[location_id]
            _insert_location_with_explicit_id(conn, location_id, loc["googleLocationId"], loc.get("title") or "", loc.get("address") or "")
        conn.commit()
    finally:
        conn.close()


def _build_database_file(db_path: Path, approved_locations: list[dict]) -> None:
    conn = sqlite3.connect(db_path)
    try:
        db.init_schema(conn)
        for loc in approved_locations:
            _insert_location_with_explicit_id(conn, loc["locationId"], loc["googleLocationId"], loc.get("title") or "", loc.get("address") or "")
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Step 3: private-data artifacts -- built purely in memory as
# {relPath: bytes}, uploaded individually to Blob by the orchestrator.
# ---------------------------------------------------------------------------

def _build_initial_artifacts(approved_locations: list[dict]) -> dict[str, bytes]:
    """The minimum artifact set for the dashboard to behave safely before
    Initial Sync -- explicit zero-reviews/never-synced empty state, NEVER
    copied from Los Tres Amigos's own real artifacts. Every value here is
    derived solely from THIS tenant's own approvedLocations."""
    loc_list = []
    artifacts: dict[str, bytes] = {}
    for loc in sorted(approved_locations, key=lambda l: l.get("title") or ""):
        title = loc.get("title") or f"Location {loc['locationId']}"
        slug = _slugify(title) or f"location-{loc['locationId']}"
        brand = db.get_brand(title)
        loc_list.append({
            "locationId": loc["locationId"], "name": title, "city": "",
            "brand": brand, "slug": slug, "maps_url": "", "hasContact": False,
        })
        artifacts[f"reviews/by-location/{slug}.json"] = json.dumps([], separators=(",", ":")).encode("utf-8")

    artifacts["meta.json"] = json.dumps({
        "locations": loc_list,
        "brands": sorted({l["brand"] for l in loc_list if l["brand"] and l["brand"] != "Other"}),
        "totalReviews": 0,
        "generatedAt": _now_iso(),
        # Explicit, honest empty-state signal -- never fabricated statistics.
        "initialSyncCompleted": False,
    }, separators=(",", ":")).encode("utf-8")
    artifacts["action-items.json"] = json.dumps({"items": []}, separators=(",", ":")).encode("utf-8")
    artifacts["gbp-sync.json"] = json.dumps({"locations": [], "generatedAt": _now_iso(), "neverSynced": True}, separators=(",", ":")).encode("utf-8")
    artifacts["_internal/review-location-index.json"] = json.dumps({}, separators=(",", ":")).encode("utf-8")
    return artifacts


def _verify_staging(db_path: Path, artifacts: dict[str, bytes], expected: dict[int, str]) -> None:
    inspection = _inspect_database_file(db_path, expected)
    if not inspection["fully_consistent"]:
        raise ProvisioningError(f"staging verification failed: database does not match expected locations ({inspection})")
    if inspection["review_count"] != 0:
        raise ProvisioningError("staging verification failed: a freshly-built database must never contain review rows")
    if "meta.json" not in artifacts:
        raise ProvisioningError("staging verification failed: meta.json was not built")
    if "_internal/review-location-index.json" not in artifacts:
        raise ProvisioningError("staging verification failed: _internal/review-location-index.json was not built")


# ---------------------------------------------------------------------------
# Step 4: Blob upload helpers
# ---------------------------------------------------------------------------

def generate_new_artifact_generation_id() -> str:
    """A fresh, unique-per-attempt generation id -- never coordinated with
    any counter, since uniqueness (not ordering) is all correctness
    requires: two concurrent attempts building DIFFERENT generations never
    collide on a Blob key, and WHICH one becomes authoritative is decided
    entirely by the tenant_config CAS write that points artifactGeneration
    at it (see provision_tenant()/initial_sync.py)."""
    return uuid.uuid4().hex


def _upload_private_data_artifacts(tenant_id: str, generation: str, artifacts: dict[str, bytes]) -> None:
    """Uploads every private-data artifact of ONE generation. Multi-Tenant
    Phase 4G: artifacts are uploaded under a brand-new, never-before-used
    generation id (see generate_new_artifact_generation_id() below) --
    never overwritten in place at a flat key -- so a reader (Node's
    readPrivateDataFile()) can never observe a mix of an old and new
    generation's files; tenant_config's provisioning.artifactGeneration is
    only ever pointed at a generation AFTER every one of its uploads here
    has succeeded (see the CAS-confirm calls in provision_tenant()).
    allow_overwrite=True is still safe per-object because a generation id
    is unique per attempt -- two attempts never target the same key."""
    for rel_path, content in artifacts.items():
        tenant_blob_store.put_blob(
            tenant_blob_keys.generation_private_data_blob_key(tenant_id, generation, rel_path),
            content, content_type="application/json", allow_overwrite=True,
        )


def _upload_fresh_database(review_db_blob_key: str, db_path: Path) -> str:
    """Uploads a brand-new reviews.db -- requires that NO blob exists yet at
    this key (allow_overwrite=False, no if_match). If something else won the
    race to create it first, Blob itself rejects this with
    precondition_failed, converted to StaleProvisioningAttemptError by the
    caller. Returns the new blob's ETag."""
    data = db_path.read_bytes()
    try:
        result = tenant_blob_store.put_blob(review_db_blob_key, data, content_type="application/octet-stream", allow_overwrite=False)
    except tenant_blob_store.BlobPreconditionFailedError as e:
        raise StaleProvisioningAttemptError(
            f"reviews.db already exists at {review_db_blob_key!r} -- another writer created it first"
        ) from e
    return result["etag"]


def _upload_reconciled_database(review_db_blob_key: str, db_path: Path, expected_etag: str) -> str:
    """Uploads a modified (additive-only) reviews.db, requiring the Blob's
    CURRENT ETag to still equal `expected_etag` -- the exact guard that
    prevents a worker that read generation N from ever overwriting
    generation N+1. Raises StaleProvisioningAttemptError (never silently
    retries) if the ETag no longer matches."""
    data = db_path.read_bytes()
    try:
        result = tenant_blob_store.put_blob(review_db_blob_key, data, content_type="application/octet-stream", if_match=expected_etag)
    except tenant_blob_store.BlobPreconditionFailedError as e:
        raise StaleProvisioningAttemptError(
            f"reviews.db at {review_db_blob_key!r} changed since this attempt last read it (expected ETag {expected_etag!r})"
        ) from e
    return result["etag"]


def _private_data_looks_complete(tenant_id: str, generation: str | None) -> bool:
    """Cheap existence check (HEAD, no download) for the two artifacts
    _verify_staging() requires, under the CURRENTLY RECORDED generation --
    used by the idempotency path to detect a partial prior failure
    (reviews.db uploaded and confirmed by Blob, but the private-data
    uploads that were supposed to follow never completed, e.g. a network
    error between the two upload calls, OR no generation was ever recorded
    at all -- a pre-Phase-4G record). Blob's own per-object existence is
    independent of tenant_config's confirmation state, so this is the ONLY
    reliable way to detect that gap on a retry. A None generation is always
    "not complete" -- there is nothing to check existence of."""
    if generation is None:
        return False
    for rel_path in ("meta.json", "_internal/review-location-index.json"):
        key = tenant_blob_keys.generation_private_data_blob_key(tenant_id, generation, rel_path)
        if tenant_blob_store.head_blob(key) is None:
            return False
    return True


def _download_database_to_temp(review_db_blob_key: str, dest_path: Path) -> str | None:
    """Downloads the current reviews.db Blob (if any) to `dest_path`.
    Returns its ETag, or None if no Blob exists yet at this key."""
    head = tenant_blob_store.head_blob(review_db_blob_key)
    if head is None:
        return None
    content = tenant_blob_store.get_blob(review_db_blob_key)
    if content is None:
        # Vanished between head and get (e.g. a concurrent delete, which
        # this codebase never performs, but defend anyway) -- treat as "no
        # blob", consistent with head_blob's own None-means-absent contract.
        return None
    dest_path.write_bytes(content)
    return head["etag"]


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def provision_tenant(tenant_id: str) -> dict:
    """The full state machine, in order:

      1. Load + validate tenant_config (fails closed for an unknown/
         unapproved/suspended/non-BLOB tenant before any Blob access -- see
         _load_and_validate_config()). Captures `expected_version` = the
         record's configVersion AT THIS MOMENT -- see CONCURRENCY below.
      2. Validate approvedLocations/locationIdMap consistency (fails closed
         on any missing/duplicate/conflicting stable id) -- still no Blob
         access.
      3. Compute this tenant's Blob keys (tenant_blob_keys.py's
         deterministic formula -- never a registry, never request input).
      4. IDEMPOTENCY CHECK: download the current reviews.db Blob, if any --
           a. no Blob exists yet -> FRESH PROVISIONING (step 5).
           b. Blob exists, fully consistent with current approvedLocations,
              zero real reviews -> mark 'provisioned' (idempotent no-op,
              safe retry) and return.
           c. Blob exists, missing ids only, AND zero real review rows ->
              add ONLY the missing rows locally, reupload with if_match
              bound to the ETag just read, mark 'provisioned', return.
           d. ANY numeric id mismatch, or missing ids but real review rows
              already exist -> ProvisioningRefusedError. Never destructively
              rebuilt, ever, regardless of retry pressure.
      5. FRESH PROVISIONING (no reviews.db Blob exists yet): mark
         tenant_config status 'provisioning', build the ENTIRE database
         locally (a temp file, never uploaded until verified) + private-data
         artifacts (in memory), verify the local result from scratch, then
         upload the database (allow_overwrite=False -- see
         _upload_fresh_database) followed by every private-data artifact. If
         ANYTHING in this step raises, tenant_config is marked
         'provisioning_failed' with the error recorded -- no reviews.db
         Blob is ever left half-written (the local temp file is simply
         discarded), so the tenant can never appear provisioned from a
         failed attempt. A subsequent call is a normal retry, re-entering
         at step 1.
      6. Mark tenant_config status 'provisioned' (NEVER 'active' -- Phase
         4F's closure fix, unchanged in this revision: successful
         provisioning alone must not make a tenant operationally active;
         tenants.js's tenantOwnsLocationCatalog() only ever authorizes
         `status === 'active'`, and only Phase 4G's Initial Sync completion
         -- not built here -- is allowed to write that) with the
         verified logical Blob keys and provisioned location ids recorded.

    CONCURRENCY (Phase 4F.1 -- TWO independent atomic guarantees, not one):
      (a) tenant_config's own configVersion CAS, unchanged from Phase 4F's
          closure: every write this function makes after its initial read is
          checked against `expected_version`, bumped by 1 after each of this
          function's own successful writes. A stale write raises
          ConfigVersionConflictError, converted to
          StaleProvisioningAttemptError here.
      (b) the reviews.db Blob object's own ETag, enforced natively by Vercel
          Blob's conditional-write support (see tenant_blob_store.py's
          header) -- a worker that read ETag E can only successfully write a
          new version if the Blob's current ETag is STILL E at the moment of
          the write (single atomic request, no read-then-write window).
          A stale write raises BlobPreconditionFailedError, ALSO converted
          to StaleProvisioningAttemptError here.
    Either guarantee failing means this attempt's work (if any) is simply
    not published as the tenant's authoritative state -- an orphaned local
    temp file is discarded, an orphaned successful-but-unconfirmed Blob
    upload is left in place, unpublished (tenant_config's own recorded
    reviewDbBlobKey/status is what every reader trusts, never "does a Blob
    object happen to exist"). A later, fresh call to provision_tenant()
    re-reads current state and reconciles correctly (see step 4) rather than
    trusting anything this run computed.
    """
    tenant_keys.assert_valid_tenant_id(tenant_id, "provision_tenant")
    config = _load_and_validate_config(tenant_id)
    expected_version = config.get("configVersion", 0)
    approved_locations = config["approvedLocations"]
    location_id_map = config.get("locationIdMap") or {}
    expected = _validate_stable_id_consistency(approved_locations, location_id_map)

    review_db_blob_key = tenant_blob_keys.review_db_blob_key(tenant_id)
    private_data_prefix = tenant_blob_keys.private_data_prefix(tenant_id)  # recorded for backward-compat/diagnostics only; reads resolve via artifactGeneration
    recorded_generation = (config.get("provisioning") or {}).get("artifactGeneration")

    with tempfile.TemporaryDirectory(prefix=f"provision-{tenant_id}-") as tmp:
        tmp_db_path = Path(tmp) / "reviews.db"
        current_etag = _download_database_to_temp(review_db_blob_key, tmp_db_path)

        if current_etag is not None:
            inspection = _inspect_database_file(tmp_db_path, expected)
            if inspection["mismatched"]:
                raise ProvisioningRefusedError(
                    f"tenant {tenant_id!r}: existing database has locationId(s) {inspection['mismatched']} mapped to a "
                    f"DIFFERENT Google location than currently expected -- refusing to touch it; manual investigation required"
                )
            if inspection["fully_consistent"]:
                generation = recorded_generation
                if not _private_data_looks_complete(tenant_id, generation):
                    # The reviews.db upload from a prior attempt was
                    # confirmed by Blob, but the private-data artifacts that
                    # were supposed to follow it never fully landed (e.g. a
                    # network failure between the two upload calls), or no
                    # generation was ever recorded -- rebuild and republish
                    # under a BRAND-NEW generation from the CURRENT
                    # approvedLocations (never patch the old one in place --
                    # see generate_new_artifact_generation_id()'s header).
                    generation = generate_new_artifact_generation_id()
                    artifacts = _build_initial_artifacts(approved_locations)
                    _upload_private_data_artifacts(tenant_id, generation, artifacts)
                _mark_provisioned_or_raise_stale(tenant_id, review_db_blob_key, private_data_prefix, current_etag, generation, expected, expected_version)
                return {"outcome": "already_provisioned", "reviewDbBlobKey": review_db_blob_key, "artifactGeneration": generation, "locationIds": sorted(expected.keys())}
            if inspection["review_count"] != 0:
                raise ProvisioningRefusedError(
                    f"tenant {tenant_id!r}: existing database is missing locationId(s) {inspection['missing']} but already "
                    f"contains {inspection['review_count']} real review row(s) -- refusing to modify it; this requires a "
                    f"separate, carefully reviewed procedure, not automatic reconciliation"
                )
            # Empty database, missing only newly-approved locations -- safe,
            # additive reconciliation. Existing rows are never touched.
            _reconcile_missing_locations(tmp_db_path, approved_locations, inspection["missing"])
            new_etag = _upload_reconciled_database(review_db_blob_key, tmp_db_path, current_etag)
            generation = recorded_generation
            if not _private_data_looks_complete(tenant_id, generation):
                generation = generate_new_artifact_generation_id()
                artifacts = _build_initial_artifacts(approved_locations)
                _upload_private_data_artifacts(tenant_id, generation, artifacts)
            _mark_provisioned_or_raise_stale(tenant_id, review_db_blob_key, private_data_prefix, new_etag, generation, expected, expected_version)
            return {"outcome": "reconciled", "reviewDbBlobKey": review_db_blob_key, "artifactGeneration": generation, "locationIds": sorted(expected.keys())}

        # --- Fresh provisioning ---
        try:
            tenant_config_store.upsert_tenant_config(tenant_id, {
                "status": "provisioning",
                "provisioning": {**(config.get("provisioning") or {}), "status": "in_progress", "lastAttemptAt": _now_iso()},
            }, expected_version=expected_version)
        except tenant_config_store.ConfigVersionConflictError as e:
            raise StaleProvisioningAttemptError(
                f"tenant {tenant_id!r}: tenant_config changed before provisioning could start (expected version "
                f"{expected_version}) -- aborting without touching Blob; retry will re-read current state"
            ) from e
        expected_version += 1

        generation = generate_new_artifact_generation_id()
        try:
            _build_database_file(tmp_db_path, approved_locations)
            artifacts = _build_initial_artifacts(approved_locations)
            _verify_staging(tmp_db_path, artifacts, expected)

            new_etag = _upload_fresh_database(review_db_blob_key, tmp_db_path)
            _upload_private_data_artifacts(tenant_id, generation, artifacts)
        except StaleProvisioningAttemptError:
            # The Blob-level race already leaves nothing for this attempt to
            # publish -- report it as a plain stale attempt, not a failure
            # (a fresh retry will correctly find and reconcile against the
            # winner's database via the idempotency check above).
            raise
        except Exception as e:
            try:
                tenant_config_store.upsert_tenant_config(tenant_id, {
                    "status": "provisioning_failed",
                    "provisioning": {
                        "status": "failed", "reviewDbBlobKey": None, "privateDataPrefix": None, "reviewDbEtag": None,
                        "artifactGeneration": None, "provisionedLocationIds": [], "lastAttemptAt": _now_iso(), "lastError": str(e),
                    },
                }, expected_version=expected_version)
            except tenant_config_store.ConfigVersionConflictError:
                # Something NEWER already happened to this tenant -- a stale
                # failure report must never overwrite it.
                pass
            raise

    try:
        tenant_config_store.upsert_tenant_config(tenant_id, {
            "status": "provisioned",
            "provisioning": {
                "status": "provisioned", "reviewDbBlobKey": review_db_blob_key, "privateDataPrefix": private_data_prefix,
                "reviewDbEtag": new_etag, "artifactGeneration": generation, "provisionedLocationIds": sorted(expected.keys()),
                "lastAttemptAt": _now_iso(), "lastError": None,
            },
        }, expected_version=expected_version)
    except tenant_config_store.ConfigVersionConflictError as e:
        # The Blob uploads above are genuinely done and internally
        # consistent -- they are simply NOT published as this tenant's
        # authoritative state, because tenant_config changed underneath
        # this attempt while the build/upload was running.
        raise StaleProvisioningAttemptError(
            f"tenant {tenant_id!r}: tenant_config changed while provisioning was uploading (expected version "
            f"{expected_version}) -- the uploaded resources were not published as successful; retry will "
            f"re-evaluate them against current state"
        ) from e

    return {"outcome": "provisioned", "reviewDbBlobKey": review_db_blob_key, "artifactGeneration": generation, "locationIds": sorted(expected.keys())}


def _mark_provisioned_or_raise_stale(tenant_id: str, review_db_blob_key: str, private_data_prefix: str, review_db_etag: str, artifact_generation: str, expected: dict[int, str], expected_version: int) -> None:
    try:
        tenant_config_store.upsert_tenant_config(tenant_id, {
            "status": "provisioned",
            "provisioning": {
                "status": "provisioned", "reviewDbBlobKey": review_db_blob_key, "privateDataPrefix": private_data_prefix,
                "reviewDbEtag": review_db_etag, "artifactGeneration": artifact_generation, "provisionedLocationIds": sorted(expected.keys()),
                "lastAttemptAt": _now_iso(), "lastError": None,
            },
        }, expected_version=expected_version)
    except tenant_config_store.ConfigVersionConflictError as e:
        raise StaleProvisioningAttemptError(
            f"tenant {tenant_id!r}: tenant_config changed before this idempotent confirmation could commit "
            f"(expected version {expected_version}) -- no new Blob writes were left unconfirmed; retry will "
            f"re-evaluate against current state"
        ) from e


def main() -> int:
    parser = argparse.ArgumentParser(description="Provision a tenant's review-storage resources (Multi-Tenant Phase 4F.1, Blob-backed).")
    parser.add_argument("--tenant-id", required=True, help="The tenant to provision, e.g. t_example-restaurant")
    args = parser.parse_args()

    if not tenant_keys.is_valid_tenant_id(args.tenant_id):
        print(f"::error::provision_tenant.py: invalid --tenant-id {args.tenant_id!r}")
        return 1

    try:
        result = provision_tenant(args.tenant_id)
    except ProvisioningError as e:
        print(f"::error::provision_tenant.py: {e}")
        return 1

    print(f"provision_tenant.py: {result['outcome']} tenant={args.tenant_id!r} "
          f"locations={result['locationIds']} reviewDbBlobKey={result['reviewDbBlobKey']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
