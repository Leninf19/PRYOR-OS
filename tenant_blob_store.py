"""
tenant_blob_store.py -- Multi-Tenant Phase 4F.1: a raw REST client for
Vercel Blob, used exclusively by provision_tenant.py (and, in a future
phase, Initial Sync / the review-sync worker) to durably store a BLOB-mode
tenant's reviews.db and private-data JSON artifacts from GitHub Actions,
which has no Vercel OIDC identity (OIDC tokens are auto-injected only inside
Vercel's own Function runtime -- see dashboard/api/_lib/blobStore.js's header
comment). Python here authenticates with a real BLOB_READ_WRITE_TOKEN
secret instead.

WHY A HAND-ROLLED REST CLIENT, NOT THE @vercel/blob NPM PACKAGE: there is no
Python port of that SDK. This module is NOT a guess at Vercel Blob's wire
protocol -- every request shape below (method, URL, header names, body
format, error JSON shape) was read directly out of the INSTALLED
@vercel/blob@2.8.0 package this repo already depends on
(dashboard/node_modules/@vercel/blob/dist/chunk-YYMLUMXS.js's requestApi(),
createPutHeaders(), parseStoreIdFromReadWriteToken(), and getBlobError()),
not reconstructed from memory or documentation. If @vercel/blob is ever
upgraded to a version with a different wire protocol, this module must be
re-audited against the new installed version in the same change.

CONCURRENCY -- THE KEY DESIGN DECISION OF THIS PHASE: Vercel Blob's `put`
endpoint natively supports optimistic concurrency via ETags (`x-if-match` +
`x-allow-overwrite`, confirmed in the SDK's own type definitions --
PutCommandOptions.ifMatch / .allowOverwrite, throwing a `precondition_failed`
error code on mismatch). provision_tenant.py uses THIS, not a hand-rolled
Redis-based reservation scheme, to guarantee a worker that read generation N
can never overwrite generation N+1: it reads the current ETag (via
head_blob), builds+verifies its new content locally, then uploads with
`if_match=<the ETag it read>` (or `allow_overwrite=False` with no if_match
when no blob exists yet, so a racing FIRST writer is also caught). The
storage layer itself, not application code, is the single source of truth
for "did anything change since I looked," with no read-then-write window for
a second writer to race into.

CREDENTIALS: reads BLOB_READ_WRITE_TOKEN from the environment. Store id is
parsed from the token itself (`vercel_blob_rw_<storeId>_<secret>`, per
parseStoreIdFromReadWriteToken() in the installed SDK) -- never guessed or
separately configured. See this repo's Phase 4F.1 report for the exact
GitHub Actions secret name this requires at deployment time; NO real secret
value is hardcoded or assumed present here -- every function below raises
BlobStoreUnavailableError if the token is simply absent, exactly like
tenant_config_store.py raises TenantConfigStoreUnavailableError for a
missing Upstash config, and NEVER falls back to any other storage.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

_CONTROL_API_BASE = "https://vercel.com/api/blob"
_API_VERSION = "12"  # BLOB_API_VERSION, @vercel/blob@2.8.0


class BlobStoreUnavailableError(Exception):
    """Raised for a missing/malformed BLOB_READ_WRITE_TOKEN or a genuine
    network/outage failure -- never for a normal 404 (see head_blob/get_blob,
    which return None for that)."""


class BlobPreconditionFailedError(Exception):
    """Raised when a conditional put's `if_match` ETag no longer matches the
    blob's current state (or, with `allow_overwrite=False` and no if_match,
    when the blob was created by someone else first) -- the Blob-layer
    concurrency signal provision_tenant.py converts into
    StaleProvisioningAttemptError."""


class BlobNotFoundError(Exception):
    """Raised by delete_blob for a pathname that does not exist. head_blob/
    get_blob use a plain None return for 'not found' instead, since that is
    an expected, common outcome for those two, not an error condition."""


def _resolve_token() -> str:
    token = os.environ.get("BLOB_READ_WRITE_TOKEN")
    if not token:
        raise BlobStoreUnavailableError(
            "tenant blob store is not configured (missing BLOB_READ_WRITE_TOKEN) -- "
            "see the Phase 4F.1 report for the exact secret this requires"
        )
    return token


def _store_id_from_token(token: str) -> str:
    # Mirrors parseStoreIdFromReadWriteToken() exactly: token format is
    # "vercel_blob_rw_<storeId>_<secret>" -- split on '_', 4th element.
    parts = token.split("_")
    return parts[3] if len(parts) > 3 else ""


def _common_headers(token: str, store_id: str) -> dict:
    return {
        "x-vercel-blob-store-id": store_id,
        "x-api-version": _API_VERSION,
        "authorization": f"Bearer {token}",
    }


def _parse_error_body(raw: bytes) -> tuple[str, str | None]:
    try:
        data = json.loads(raw)
        err = data.get("error") or {}
        return err.get("code") or "unknown_error", err.get("message")
    except (TypeError, ValueError):
        return "unknown_error", None


def put_blob(
    pathname: str,
    data: bytes,
    *,
    content_type: str = "application/octet-stream",
    if_match: str | None = None,
    allow_overwrite: bool | None = None,
) -> dict:
    """PUT {control_api}/?pathname=<pathname> -- creates/overwrites a
    PRIVATE blob. Mirrors createPutMethod()/createPutHeaders() in the
    installed SDK exactly (single, non-multipart upload path only -- this
    module never needs multipart, since reviews.db/private-data artifacts
    are well under Blob's simple-PUT size limits at this stage).

    `if_match`: the ETag this write must still be current against (from a
    prior head_blob/put_blob call) -- raises BlobPreconditionFailedError if
    the blob changed since. Implies allow_overwrite=True unless explicitly
    overridden, exactly like the JS SDK's own contradictory-options check.
    `allow_overwrite=False` (the default when if_match is not given) means
    this call requires the blob NOT to already exist -- the correct choice
    for a tenant's FIRST-ever upload of a given key, since it lets a racing
    first writer be caught the same way a later one is via if_match.

    Returns the parsed response JSON on success: {url, downloadUrl,
    pathname, contentType, contentDisposition, etag}.
    """
    if if_match is not None and allow_overwrite is False:
        raise ValueError("put_blob: if_match and allow_overwrite=False are contradictory")
    token = _resolve_token()
    store_id = _store_id_from_token(token)
    headers = {
        **_common_headers(token, store_id),
        "x-vercel-blob-access": "private",
        "x-content-type": content_type,
        "content-type": content_type,
    }
    if if_match is not None:
        headers["x-if-match"] = if_match
        headers["x-allow-overwrite"] = "1" if allow_overwrite is not False else "0"
    elif allow_overwrite is not None:
        headers["x-allow-overwrite"] = "1" if allow_overwrite else "0"

    url = f"{_CONTROL_API_BASE}/?pathname={urllib.parse.quote(pathname, safe='')}"
    req = urllib.request.Request(url, data=data, headers=headers, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read()
        code, message = _parse_error_body(body)
        if code == "precondition_failed":
            raise BlobPreconditionFailedError(f"put_blob({pathname!r}): ETag precondition failed") from e
        raise BlobStoreUnavailableError(f"put_blob({pathname!r}) failed: {code} {message or ''}".strip()) from e
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise BlobStoreUnavailableError(f"put_blob({pathname!r}) unreachable: {e}") from e


def head_blob(pathname: str) -> dict | None:
    """GET {control_api}/?url=<pathname> -- Blob's control-plane metadata
    lookup (the SDK's head() re-uses GET for this since HEAD can't carry a
    JSON response body). Returns None for a genuine 404 (no such blob yet --
    the normal state before a tenant's first upload), the parsed metadata
    dict (including `etag`) otherwise. Raises BlobStoreUnavailableError for
    any other failure."""
    token = _resolve_token()
    store_id = _store_id_from_token(token)
    url = f"{_CONTROL_API_BASE}/?url={urllib.parse.quote(pathname, safe='')}"
    req = urllib.request.Request(url, headers=_common_headers(token, store_id), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        code, message = _parse_error_body(e.read())
        raise BlobStoreUnavailableError(f"head_blob({pathname!r}) failed: {code} {message or ''}".strip()) from e
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise BlobStoreUnavailableError(f"head_blob({pathname!r}) unreachable: {e}") from e


def get_blob(pathname: str) -> bytes | None:
    """Downloads a PRIVATE blob's full content. Mirrors get.ts's direct
    object-host request exactly: a plain GET to
    https://{storeId}.private.blob.vercel-storage.com/{pathname} with a
    Bearer token (private-access blobs authenticate this way -- there is no
    separate 'download API' for them). Returns None for a genuine 404
    (no such blob), raises BlobStoreUnavailableError otherwise."""
    token = _resolve_token()
    store_id = _store_id_from_token(token)
    url = f"https://{store_id}.private.blob.vercel-storage.com/{pathname}"
    req = urllib.request.Request(url, headers={"authorization": f"Bearer {token}"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise BlobStoreUnavailableError(f"get_blob({pathname!r}) failed: HTTP {e.code}") from e
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise BlobStoreUnavailableError(f"get_blob({pathname!r}) unreachable: {e}") from e


def delete_blob(pathname: str, *, if_match: str | None = None) -> None:
    """POST {control_api}/delete -- not used by provision_tenant.py today
    (this script never deletes tenant data), provided for completeness and
    symmetry with blobStore.js's deleteBlob()/del()."""
    token = _resolve_token()
    store_id = _store_id_from_token(token)
    headers = {**_common_headers(token, store_id), "content-type": "application/json"}
    if if_match is not None:
        headers["x-if-match"] = if_match
    body = json.dumps({"urls": [pathname]}).encode("utf-8")
    req = urllib.request.Request(f"{_CONTROL_API_BASE}/delete", data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30):
            return None
    except urllib.error.HTTPError as e:
        code, message = _parse_error_body(e.read())
        if code == "precondition_failed":
            raise BlobPreconditionFailedError(f"delete_blob({pathname!r}): ETag precondition failed") from e
        raise BlobStoreUnavailableError(f"delete_blob({pathname!r}) failed: {code} {message or ''}".strip()) from e
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise BlobStoreUnavailableError(f"delete_blob({pathname!r}) unreachable: {e}") from e
