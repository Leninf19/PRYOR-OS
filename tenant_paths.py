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

import tenant_keys

BASE_DIR = Path(__file__).resolve().parent


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


def resolve_review_db_path(tenant_id: str) -> Path:
    """THE one function that decides which physical SQLite file is
    authoritative for a tenant's review data. Every entrypoint that touches
    reviews.db calls this (or resolve_export_dir() below) before opening
    any connection -- never a hardcoded/default path once a tenant_id is
    known. Fails closed (InvalidTenantIdError) before even considering the
    registry for a malformed tenant_id, and fails closed (UnknownTenantError)
    for a well-formed but unregistered one -- there is no fallback path for
    either case."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "resolve_review_db_path")
    if tenant_id in _TEST_REVIEW_DB_OVERRIDES:
        return _TEST_REVIEW_DB_OVERRIDES[tenant_id]
    try:
        return _TENANT_REVIEW_DB_REGISTRY[tenant_id]
    except KeyError:
        raise UnknownTenantError(
            f"resolve_review_db_path: tenant {tenant_id!r} has no registered review database -- "
            f"it must be explicitly onboarded (added to _TENANT_REVIEW_DB_REGISTRY) before any "
            f"review-data operation can run for it"
        )


def resolve_export_dir(tenant_id: str) -> Path:
    """The export-directory counterpart to resolve_review_db_path() above --
    same registry discipline, same fail-closed behavior."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "resolve_export_dir")
    if tenant_id in _TEST_EXPORT_DIR_OVERRIDES:
        return _TEST_EXPORT_DIR_OVERRIDES[tenant_id]
    try:
        return _TENANT_EXPORT_DIR_REGISTRY[tenant_id]
    except KeyError:
        raise UnknownTenantError(
            f"resolve_export_dir: tenant {tenant_id!r} has no registered export directory -- "
            f"it must be explicitly onboarded (added to _TENANT_EXPORT_DIR_REGISTRY) before any "
            f"export can run for it"
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
    as everywhere else in this module; only "valid but unregistered"
    returns False instead of raising."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "is_tenant_onboarded")
    return tenant_id in _TENANT_REVIEW_DB_REGISTRY
