"""
tenant_keys.py -- Multi-Tenant Phase 4C: the Python-side mirror of the
canonical tenant key architecture defined in dashboard/api/_lib/tenants.js,
tenantKeys.js, and tenantDualRead.js.

WHY THIS EXISTS: Phases 1-4B built a complete tenant model, key-builder
registry, and fail-closed migration-mode system for the Node/Vercel side of
this application. The background GitHub-Actions-driven Python pipeline
(google_api.py, gbp_reply_bridge_reconcile.py, sync_reviews.py, and their
callers) predates all of that and has never had any concept of "tenant" at
all -- every Redis key it touches (gbp_credentials:v1, publish_bridge:v1:*)
is a bare, global literal. Phase 4C's audit found this is a real gap: a
background worker with no tenantId has no way to prove which tenant's
credential/bridge record it's allowed to touch, and once a second tenant
exists, a worker running for it must never be able to read or write
Los Tres Amigos's data (or vice versa) merely because the key happened to
be guessable.

Python cannot `import` a JS module, so this file is a maintained, TESTED
MIRROR, not a shim -- test_tenant_keys.py cross-checks every constant and
format string here against the literal values in tenants.js/tenantKeys.js
so the two can never silently drift apart (the same discipline
test_tenant_model.js already applies to the Node side's own v1<->v2 key
registry).

MIGRATION MODE mirrors tenantDualRead.js's hardened design exactly: a
tenant's authoritative key version is a FIXED, explicit, code-reviewed
setting (LEGACY or CUTOVER) -- NEVER decided by whether a key happens to
exist or be populated at runtime. This is what makes "no automatic runtime
fallback to gbp_credentials:v1" and "fix the Node/Python credential
mismatch" simultaneously true: Los Tres Amigos is pinned to LEGACY (v1
authoritative, for BOTH Node and Python, matching pre-Phase-4A production
behavior exactly) until a single, separately reviewed commit flips it to
CUTOVER -- see the Phase 4C report's migration procedure. No tenant is ever
silently or implicitly assigned a mode; the map below is the one place
that decides, and it is never consulted based on Redis content.
"""
from __future__ import annotations

import re

DEFAULT_TENANT_ID = "t_los-tres-amigos"

_TENANT_ID_RE = re.compile(r"^t_[a-z0-9-]+$")


class InvalidTenantIdError(ValueError):
    """Raised by every resolve_*/assert_* function below for a tenantId
    that fails is_valid_tenant_id() -- callers must treat this as a hard
    stop, never a signal to fall back to a default tenant or a legacy key."""


def is_valid_tenant_id(tenant_id) -> bool:
    return isinstance(tenant_id, str) and bool(_TENANT_ID_RE.match(tenant_id))


def assert_valid_tenant_id(tenant_id, fn_name: str) -> None:
    if not is_valid_tenant_id(tenant_id):
        raise InvalidTenantIdError(f"{fn_name}: invalid tenantId {tenant_id!r}")


# --- v2 key builders (mirror tenantKeys.js) --------------------------------

def credential_key_v2(tenant_id: str) -> str:
    assert_valid_tenant_id(tenant_id, "credential_key_v2")
    return f"gbp_credentials:v2:{tenant_id}"


def publish_bridge_key_v2(tenant_id: str, review_id: str) -> str:
    assert_valid_tenant_id(tenant_id, "publish_bridge_key_v2")
    if not isinstance(review_id, str) or not review_id:
        raise ValueError(f"publish_bridge_key_v2: invalid review_id {review_id!r}")
    return f"publish_bridge:v2:{tenant_id}:{review_id}"


def publish_bridge_prefix_v2(tenant_id: str) -> str:
    """The KEYS glob prefix for ALL of one tenant's v2 publish-bridge
    records -- deliberately a separate function from publish_bridge_key_v2
    (which needs a specific review_id) since a reconciliation job scans by
    prefix, it doesn't address one record."""
    assert_valid_tenant_id(tenant_id, "publish_bridge_prefix_v2")
    return f"publish_bridge:v2:{tenant_id}:"


# --- Legacy (v1) key literals -----------------------------------------------
# Never read/written except when resolve_*() below determines a tenant is
# still explicitly in LEGACY mode. Kept as named constants (not inlined
# strings at each call site) so there is exactly one place that spells them,
# matching credentialStore.js's own CREDENTIAL_KEY constant.

LEGACY_CREDENTIAL_KEY = "gbp_credentials:v1"
LEGACY_PUBLISH_BRIDGE_PREFIX = "publish_bridge:v1:"


def legacy_publish_bridge_key(review_id: str) -> str:
    if not isinstance(review_id, str) or not review_id:
        raise ValueError(f"legacy_publish_bridge_key: invalid review_id {review_id!r}")
    return f"{LEGACY_PUBLISH_BRIDGE_PREFIX}{review_id}"


# --- Migration mode ----------------------------------------------------------

LEGACY = "legacy"
CUTOVER = "cutover"

# Single source of truth for every tenant's CREDENTIAL migration mode.
# Los Tres Amigos stays LEGACY (gbp_credentials:v1 authoritative for BOTH
# Node and Python) until a separately reviewed cutover -- see the Phase 4C
# report's migration procedure. Any tenant not listed defaults to CUTOVER
# (v2-only, no legacy key exists for it, so none is ever consulted).
#
# TODO(multi-tenant-cutover): LEGACY mode exists ONLY as a transitional
# bridge for Los Tres Amigos's controlled migration off the pre-Phase-4A
# single global credential -- it is not a general "grandfather this
# tenant" mechanism and must not be extended to any other tenant. Remove
# this entry (and the matching one in dashboard/api/_lib/credentialStore.js)
# in the same reviewed change that performs the real v1 -> v2 migration and
# confirms a controlled OAuth reconnect against v2 -- once that lands, every
# tenant is CUTOVER-only and this LEGACY branch can be deleted entirely.
_CREDENTIAL_MIGRATION_MODE = {
    DEFAULT_TENANT_ID: LEGACY,
}

# Publish-bridge migration mode, tracked separately from credentials in
# case a future phase cuts one over before the other -- today both maps
# agree (Los Tres Amigos LEGACY, every other tenant CUTOVER), matching
# Node's dashboard/api/_lib/publishBridgeStore.js (routed through
# tenantDualRead.js, unchanged since Phase 2 and untouched by Phase 4A/4B).
# Same TODO as _CREDENTIAL_MIGRATION_MODE above: transitional only, remove
# this entry once Los Tres Amigos's publish-bridge keyspace is migrated.
_PUBLISH_BRIDGE_MIGRATION_MODE = {
    DEFAULT_TENANT_ID: LEGACY,
}


def get_credential_migration_mode(tenant_id: str) -> str:
    assert_valid_tenant_id(tenant_id, "get_credential_migration_mode")
    return _CREDENTIAL_MIGRATION_MODE.get(tenant_id, CUTOVER)


def get_publish_bridge_migration_mode(tenant_id: str) -> str:
    assert_valid_tenant_id(tenant_id, "get_publish_bridge_migration_mode")
    return _PUBLISH_BRIDGE_MIGRATION_MODE.get(tenant_id, CUTOVER)


def resolve_credential_key(tenant_id: str) -> str:
    """The ONE authoritative Redis key for this tenant's Google credential.
    Purely a function of tenant_id and the fixed migration-mode map above --
    never consults Redis, never checks whether a key happens to exist, so
    read and write resolution can never disagree (the same guarantee
    tenantDualRead.js's authoritativeKeyFor() provides on the Node side)."""
    assert_valid_tenant_id(tenant_id, "resolve_credential_key")
    if get_credential_migration_mode(tenant_id) == LEGACY:
        return LEGACY_CREDENTIAL_KEY
    return credential_key_v2(tenant_id)


def resolve_publish_bridge_key(tenant_id: str, review_id: str) -> str:
    """The ONE authoritative Redis key to read/write ONE publish-bridge
    record for this tenant+review."""
    assert_valid_tenant_id(tenant_id, "resolve_publish_bridge_key")
    if get_publish_bridge_migration_mode(tenant_id) == LEGACY:
        return legacy_publish_bridge_key(review_id)
    return publish_bridge_key_v2(tenant_id, review_id)


def resolve_publish_bridge_scan_prefix(tenant_id: str) -> str:
    """The KEYS glob prefix a reconciliation job should scan for THIS
    tenant's bridge records ONLY -- a worker given tenant_id='t_client_2'
    can only ever construct 'publish_bridge:v2:t_client_2:*', structurally
    incapable of enumerating 'publish_bridge:v1:*' (Los Tres Amigos's own
    keyspace) or any other tenant's v2 prefix."""
    assert_valid_tenant_id(tenant_id, "resolve_publish_bridge_scan_prefix")
    if get_publish_bridge_migration_mode(tenant_id) == LEGACY:
        return LEGACY_PUBLISH_BRIDGE_PREFIX
    return publish_bridge_prefix_v2(tenant_id)
