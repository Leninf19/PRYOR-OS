"""
tenant_blob_keys.py -- Multi-Tenant Phase 4F.1: the Python mirror of
dashboard/api/_lib/tenantBlobKeys.js. See that file's header for the full
rationale (a Blob key is a deterministic FORMULA over an already-validated
tenantId, not a registry lookup -- unlike a filesystem root, there is nothing
tenant-specific to look up; both languages independently compute the SAME
key from nothing but a validated tenantId).

CANONICAL LAYOUT -- must stay byte-identical to tenantBlobKeys.js.
tests/test_tenant_blob_keys_cross_language_consistency.{js,py} cross-check
both languages against the same fixture.
"""
from __future__ import annotations

import tenant_keys


class InvalidBlobKeyInputError(Exception):
    """Raised for a malformed tenantId or relPath -- defense-in-depth only;
    callers are responsible for their own primary input validation."""


def _assert_safe_rel_path(rel_path: str, fn_name: str) -> None:
    if not isinstance(rel_path, str) or not rel_path:
        raise InvalidBlobKeyInputError(f"{fn_name}: relPath must be a non-empty string")
    for seg in rel_path.split("/"):
        if not seg or seg in (".", "..") or "\0" in seg or "\\" in seg:
            raise InvalidBlobKeyInputError(f"{fn_name}: unsafe relPath segment {seg!r} in {rel_path!r}")


def tenant_blob_root(tenant_id: str) -> str:
    tenant_keys.assert_valid_tenant_id(tenant_id, "tenant_blob_root")
    return f"tenant-data/{tenant_id}"


def review_db_blob_key(tenant_id: str) -> str:
    return f"{tenant_blob_root(tenant_id)}/reviews.db"


def private_data_prefix(tenant_id: str) -> str:
    return f"{tenant_blob_root(tenant_id)}/private-data/"


def private_data_blob_key(tenant_id: str, rel_path: str, prefix: str | None = None) -> str:
    _assert_safe_rel_path(rel_path, "private_data_blob_key")
    base = prefix if prefix is not None else private_data_prefix(tenant_id)
    return f"{base}{rel_path}"


def _assert_safe_generation(generation: str, fn_name: str) -> None:
    if not isinstance(generation, str) or not generation or "/" in generation or generation in (".", ".."):
        raise InvalidBlobKeyInputError(f"{fn_name}: invalid generation {generation!r}")


def generation_root(tenant_id: str, generation: str) -> str:
    _assert_safe_generation(generation, "generation_root")
    return f"{tenant_blob_root(tenant_id)}/generations/{generation}"


# Multi-Tenant Phase 4G -- the generation-versioned artifact namespace,
# a SIBLING of reviews.db/the flat private-data prefix under the tenant's
# root (tenant-data/{tenantId}/generations/{generation}/private-data/...),
# not nested under private_data_prefix() -- a generation groups EVERY
# artifact of one sync attempt under one id, so it must live at the same
# level reviews.db does, not inside the (now legacy/provisioning-only)
# flat prefix. A pure formula over (tenantId, generation, relPath) only --
# deliberately takes no `prefix` override, unlike private_data_blob_key()
# above, since a generation id is never a registry-stored value the way a
# tenant's overall private-data root historically was; it is always
# recomputed fresh from tenant_config's own recorded, trusted generation
# id (see initial_sync.py's header and reviewDataPaths.js's
# readPrivateDataFile()) plus this same deterministic formula.
#
# initial_sync.py uploads every private-data artifact for one sync attempt
# under a SINGLE generation id, then (only after every upload succeeds)
# CAS-writes tenant_config's provisioning.artifactGeneration to point at
# it. reviewDataPaths.js's readPrivateDataFile() resolves every BLOB-mode
# read through this SAME formula plus the tenant's currently PUBLISHED
# generation id, so a reader can never observe a mix of an old and a new
# sync's artifacts -- see initial_sync.py's header for the full
# atomic-publication design.
def generation_private_data_blob_key(tenant_id: str, generation: str, rel_path: str) -> str:
    _assert_safe_rel_path(rel_path, "generation_private_data_blob_key")
    return f"{generation_root(tenant_id, generation)}/private-data/{rel_path}"
