"""
tenant_paths.py -- Multi-Tenant Phase 4D: canonical, server-controlled
mapping from a validated tenant_id to the ONE review database file and ONE
export directory that tenant is approved to read/write. No function here
ever builds a path via string interpolation of tenant_id into a filesystem
path -- every resolution is a dict lookup against an explicit, reviewed
registry, so a well-formed-but-unregistered tenant_id (or any attempted
path-traversal payload masquerading as one) fails closed with
UnknownTenantError rather than silently deriving a plausible-looking path.
This mirrors tenant_keys.py's own registry discipline (Multi-Tenant
Phase 4C), applied here to the filesystem instead of Redis keys.

DATABASE ARCHITECTURE DECISION (Phase 4D audit finding): one SQLite
database FILE PER TENANT (Option A), not one shared database with a
tenant_id column on every table (Option B).

Why: db.py's ~50+ functions -- and every one of their many callers across
this repo (gbp_sync.py, gbp_import.py, reconcile_gbp_replies.py,
gbp_reply_bridge_reconcile.py, export_chunks.py, refresh_analytics.py,
validate.py, notify.py, nightly_digest.py, critical_alert_check.py,
check_db_integrity.py, auto_update.py, ai_engine.py, digest_filters.py,
and every test file exercising any of them) -- operate on raw SQL against
a schema with ZERO tenant_id columns anywhere. Option B would require
rewriting every table, every query, and every one of those call sites, and
a single missed `WHERE tenant_id = ?` clause anywhere in that surface would
be a silent, hard-to-detect cross-tenant data leak -- the exact opposite of
what this phase is trying to guarantee. Option A requires touching only
the small set of process ENTRYPOINTS that already resolve a validated,
explicit tenant_id (Multi-Tenant Phase 4C): each one sets db.DB_PATH
exactly once, at start-of-process, before any database access -- with ZERO
changes to db.py's schema, queries, or the ~50 functions built on top of
it. Every one of these Python entrypoints is a short-lived, single-tenant-
per-invocation batch process (a GitHub Actions job step, never a
long-running multi-tenant server), so a single mutable process-global
DB_PATH set once at the top is architecturally sound here -- this is
exactly the mechanism the existing test suite already uses
(`db.DB_PATH = Path(tmpdir) / "reviews.db"` in every test's _fresh_db()
helper), not a new one.
"""
from pathlib import Path

import tenant_config_store
import tenant_keys

BASE_DIR = Path(__file__).resolve().parent

# Multi-Tenant Phase 4F: the controlled root every DYNAMICALLY (self-service)
# provisioned tenant's resources live under -- see provision_tenant.py.
# Deliberately a SEPARATE tree from dashboard/ (Los Tres Amigos's own,
# statically-registered path below), so a provisioned tenant's directory can
# never collide with, or be confused for, LTA's real production files.
PROVISIONED_TENANTS_ROOT = BASE_DIR / "tenant-data"


class UnknownTenantError(ValueError):
    """Raised when a well-formed (regex-valid) tenant_id has no registered
    review-data resource. Distinct from tenant_keys.InvalidTenantIdError
    (malformed tenant_id, e.g. wrong shape/case) -- this specifically means
    "not yet onboarded". Both fail closed before any database/filesystem
    access; the distinction exists only so a caller/log line can tell
    "you spelled it wrong" apart from "that tenant doesn't exist here"."""


# Single source of truth: which physical SQLite file is a given tenant's
# review database. Los Tres Amigos maps to the EXACT pre-Phase-4D path --
# zero migration, zero behavior change for the one tenant with real
# production data today. A new tenant's entry is added here explicitly,
# once, as a reviewed part of that tenant's onboarding -- never derived
# automatically from the tenant_id string. This is deliberately a plain
# dict literal, not a function of tenant_id, so there is no way for any
# input (however it's spelled, encoded, or crafted) to produce a path that
# was not explicitly reviewed and committed here.
_TENANT_REVIEW_DB_REGISTRY = {
    tenant_keys.DEFAULT_TENANT_ID: BASE_DIR / "dashboard" / "reviews.db",
}

# Same registry discipline for the exported JSON/static data directory
# export_chunks.py writes to, and (see the Phase 4D report's proposed
# tenant-specific export structure) dashboard/api/data.js and its sibling
# Node endpoints will eventually read from per-tenant. Los Tres Amigos maps
# to the existing dashboard/private-data/ directory, unchanged.
_TENANT_EXPORT_DIR_REGISTRY = {
    tenant_keys.DEFAULT_TENANT_ID: BASE_DIR / "dashboard" / "private-data",
}


# --- Test-only override seam -------------------------------------------
# Same pattern as credentialStore.js's _setRedisClientForTests()/
# _resetRedisClientForTests(): every tenant-aware entrypoint now resolves
# its OWN db path/export dir via the functions below rather than trusting
# whatever db.DB_PATH/export_chunks.PRIVATE_DATA_DIR happen to already be
# set to -- which means a test's usual "point db.DB_PATH at a scratch
# tmpdir" setup would otherwise be silently overwritten back to the real
# registered path the moment a tenant-aware entrypoint runs. These
# overrides let a test register a scratch path for a given tenant_id for
# the duration of the test, without ever touching the real registry.
# Never used by production code paths.
_TEST_REVIEW_DB_OVERRIDES: dict = {}
_TEST_EXPORT_DIR_OVERRIDES: dict = {}


def _set_review_db_path_for_tests(tenant_id: str, path: Path) -> None:
    _TEST_REVIEW_DB_OVERRIDES[tenant_id] = path


def _set_export_dir_for_tests(tenant_id: str, path: Path) -> None:
    _TEST_EXPORT_DIR_OVERRIDES[tenant_id] = path


def _reset_review_db_paths_for_tests() -> None:
    _TEST_REVIEW_DB_OVERRIDES.clear()


def _reset_export_dirs_for_tests() -> None:
    _TEST_EXPORT_DIR_OVERRIDES.clear()


def _resolve_provisioned_path(tenant_id: str, field: str) -> Path | None:
    """Multi-Tenant Phase 4F -- the dynamic counterpart to the two static
    dict registries above, for a tenant that was onboarded via self-service
    (Connect Google -> Discover -> Approve -> provision_tenant.py) rather
    than a source-code edit.

    Multi-Tenant Phase 4F.1 -- NARROWED TO LEGACY_REPO ONLY. The production-
    persistence audit that motivated Phase 4F.1 found this whole "resolve a
    local filesystem path from a Redis-recorded value" design cannot work
    for a self-service tenant at all (no environment this codebase runs in
    -- GitHub Actions, local, Vercel -- shares a filesystem with the
    others), which is why provision_tenant.py now stores a Vercel Blob KEY
    (provisioning.reviewDbBlobKey/privateDataPrefix), not a path, for every
    tenant it provisions (storageMode 'BLOB'). There is no local path to
    return for a BLOB-mode tenant, by design -- this function explicitly
    checks storageMode and returns None for anything other than
    'LEGACY_REPO' rather than relying on the old field names simply no
    longer existing in the record. A future Phase 4G (Initial Sync) will
    need its OWN Blob-aware equivalent (download the current reviews.db
    Blob to a local temp file, point db.DB_PATH at it, reupload with
    if_match when done) -- not built here, since Initial Sync is
    deliberately blocked until this durable storage layer is complete.

    Reads tenant_config_store.py's SAME tenant_config:v1 Redis record
    dashboard/api/_lib/tenantConfigStore.js owns and returns the path
    recorded there ONLY IF provisioning genuinely succeeded (status ==
    'active' AND provisioning.status == 'provisioned' AND storageMode ==
    'LEGACY_REPO'). As defense-in-depth against a corrupted/tampered Redis
    record, the returned path is still required to resolve inside
    PROVISIONED_TENANTS_ROOT before being trusted.

    Returns None (never raises) for anything short of a fully verified,
    in-bounds LEGACY_REPO path -- callers fall through to
    UnknownTenantError, exactly as if the tenant were never in the static
    registry either. A tenant_config_store outage is deliberately treated
    as "unknown," not a separate error class.
    """
    try:
        config = tenant_config_store.get_tenant_config(tenant_id)
    except tenant_config_store.TenantConfigStoreUnavailableError:
        return None
    if not config or config.get("status") != "active":
        return None
    if config.get("storageMode") != "LEGACY_REPO":
        return None
    provisioning = config.get("provisioning") or {}
    if provisioning.get("status") != "provisioned":
        return None
    raw = provisioning.get(field)
    if not raw or not isinstance(raw, str):
        return None
    try:
        resolved = Path(raw).resolve()
        controlled_root = PROVISIONED_TENANTS_ROOT.resolve()
    except (OSError, RuntimeError):
        return None
    if resolved != controlled_root and controlled_root not in resolved.parents:
        return None
    return resolved


def resolve_review_db_path(tenant_id: str) -> Path:
    """THE one function that decides which physical SQLite file is
    authoritative for a tenant's review data. Every entrypoint that touches
    reviews.db calls this (or resolve_export_dir() below) before opening
    any connection -- never a hardcoded/default path once a tenant_id is
    known. Fails closed (InvalidTenantIdError) before even considering the
    registry for a malformed tenant_id, and fails closed (UnknownTenantError)
    for a well-formed but unregistered/unprovisioned one -- there is no
    fallback path for either case.

    Resolution order: the static, source-controlled registry (Los Tres
    Amigos, and any future tenant explicitly onboarded that way) first,
    then the dynamic, provisioning-backed registry (_resolve_provisioned_path()
    above) for a self-service tenant -- checked in that order so nothing
    about LTA's own resolution changes even in the presence of the new
    dynamic path."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "resolve_review_db_path")
    if tenant_id in _TEST_REVIEW_DB_OVERRIDES:
        return _TEST_REVIEW_DB_OVERRIDES[tenant_id]
    if tenant_id in _TENANT_REVIEW_DB_REGISTRY:
        return _TENANT_REVIEW_DB_REGISTRY[tenant_id]
    provisioned = _resolve_provisioned_path(tenant_id, "reviewDbPath")
    if provisioned is not None:
        return provisioned
    raise UnknownTenantError(
        f"resolve_review_db_path: tenant {tenant_id!r} has no registered or provisioned review database -- "
        f"it must be explicitly onboarded (added to _TENANT_REVIEW_DB_REGISTRY) or successfully "
        f"provisioned (provision_tenant.py) before any review-data operation can run for it"
    )


def resolve_export_dir(tenant_id: str) -> Path:
    """The export-directory counterpart to resolve_review_db_path() above --
    same registry discipline, same fail-closed behavior, same static-then-
    dynamic resolution order."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "resolve_export_dir")
    if tenant_id in _TEST_EXPORT_DIR_OVERRIDES:
        return _TEST_EXPORT_DIR_OVERRIDES[tenant_id]
    if tenant_id in _TENANT_EXPORT_DIR_REGISTRY:
        return _TENANT_EXPORT_DIR_REGISTRY[tenant_id]
    provisioned = _resolve_provisioned_path(tenant_id, "privateDataRoot")
    if provisioned is not None:
        return provisioned
    raise UnknownTenantError(
        f"resolve_export_dir: tenant {tenant_id!r} has no registered or provisioned export directory -- "
        f"it must be explicitly onboarded (added to _TENANT_EXPORT_DIR_REGISTRY) or successfully "
        f"provisioned (provision_tenant.py) before any export can run for it"
    )


def resolve_review_csv_path(tenant_id: str) -> Path:
    """Multi-Tenant Phase 4D revision: the reviews.csv counterpart --
    export_chunks.py's export_reviews_csv() writes here, weekly_report.py
    reads it. Deliberately NOT its own registry: derived from
    resolve_export_dir()'s own result (one level above the tenant's export
    directory), the exact same derivation export_reviews_csv() itself
    uses, so the two can never disagree about where this file lives. For
    Los Tres Amigos this is byte-identical to the pre-Phase-4D hardcoded
    dashboard/reviews.csv path."""
    return resolve_export_dir(tenant_id).parent / "reviews.csv"


def is_tenant_onboarded(tenant_id: str) -> bool:
    """Non-throwing existence check for diagnostics/CLI help text that
    wants to report "not onboarded" without raising. Still validates
    tenant_id's shape first -- an invalid tenant_id raises here too, same
    as everywhere else in this module; only "valid but unregistered/
    unprovisioned" returns False instead of raising. Checks both the
    static registry and the dynamic, provisioning-backed one."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "is_tenant_onboarded")
    if tenant_id in _TENANT_REVIEW_DB_REGISTRY:
        return True
    return _resolve_provisioned_path(tenant_id, "reviewDbPath") is not None
