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
