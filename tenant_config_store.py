"""
tenant_config_store.py -- Multi-Tenant Phase 4F: the Python-side client for
the SAME tenant_config:v1 Upstash Redis hash dashboard/api/_lib/
tenantConfigStore.js owns. This is the one persistent record Phase 4E's
self-service activation transaction (Connect Google -> Discover -> Approve)
writes, and this phase's provisioning script both reads (approvedLocations/
locationIdMap, to know what to provision) and writes (the `provisioning`
sub-object and the final status transition to 'active').

WHY A DIRECT REST CLIENT, NOT A SEPARATE PYTHON-SIDE RECORD: Phase 4F's
review explicitly calls out the risk of "two unrelated numeric location-ID
namespaces" / "separate independent path mappings that can drift" -- the
only way to guarantee Node and Python never disagree about a tenant's
status, approved locations, or stable location ids is for both to read and
write the literal same Redis hash, never a second, Python-only copy of the
data. This mirrors google_api.py's _fetch_refresh_token_from_redis()
exactly: a plain urllib.request call against Upstash's REST API, no Redis
client library dependency, gated the same way (missing config -> None/raise
without ever attempting a network call).

RECORD SHAPE (must stay byte-compatible with tenantConfigStore.js's own
defaults -- test_tenant_config_store_cross_language.py cross-checks the
canonical field list against a shared JSON fixture so the two can never
silently drift apart, the same discipline test_tenant_keys.py already
applies to Redis key formats):
  tenantId, displayName,
  status: 'onboarding' | 'locations_approved' | 'provisioning' | 'active' |
          'provisioning_failed' | 'suspended',
  locationCatalogEnabled: bool,
  approvedLocations: [{locationId, googleLocationId, title, address}],
  locationIdMap: {googleLocationId: locationId},   # permanent, ids never reused
  nextLocationId: int,
  brands: [str], logoUrl: str|None,
  storageMode: 'LEGACY_REPO' | 'BLOB',   # Phase 4F.1 -- see _VALID_STORAGE_MODES
  createdAt, updatedAt, activatedAt,
  provisioning: {
    status: 'none' | 'in_progress' | 'provisioned' | 'failed',
    reviewDbBlobKey: str|None, privateDataPrefix: str|None, reviewDbEtag: str|None,
    provisionedLocationIds: [int], lastAttemptAt: str|None, lastError: str|None,
  }

Failure model matches google_api.py: every read function raises
TenantConfigStoreUnavailableError on a genuine outage/misconfiguration
(never silently returns a value that could be mistaken for "not
provisioned") -- provision_tenant.py is responsible for deciding what a
raised error means for ITS OWN fail-closed behavior, exactly like
tenants.js's primeLocationCatalogState()/resolveLocationCatalogAuthz() do
on the Node side.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import tenant_keys

TENANT_CONFIG_KEY = "tenant_config:v1"

# Multi-Tenant Phase 4F closure: 'provisioned' inserted between
# 'provisioning' and 'active' -- see provision_tenant.py's header for the
# full state machine.
# Multi-Tenant Phase 4G: 'initial_sync'/'initial_sync_failed' inserted
# between 'provisioned' and 'active' -- see initial_sync.py's header. Only
# initial_sync.py's upsert_tenant_config() calls are ever allowed to write
# 'active'.
_VALID_STATUSES = {
    "onboarding", "locations_approved", "provisioning", "provisioned",
    "initial_sync", "active", "initial_sync_failed", "provisioning_failed", "suspended",
}

# Multi-Tenant Phase 4F.1 -- mirrors tenantConfigStore.js's
# isValidStorageMode()/storageMode comment exactly. LEGACY_REPO is reserved
# for Los Tres Amigos's existing git-committed/bundled data; every tenant
# provision_tenant.py provisions is BLOB.
_VALID_STORAGE_MODES = {"LEGACY_REPO", "BLOB"}

# Multi-Tenant Phase 4F closure -- optimistic concurrency control, mirroring
# tenantConfigStore.js's CAS_UPSERT_SCRIPT byte-for-byte (both languages
# send the LITERAL SAME Lua script text to Redis, so there is exactly one
# implementation of this comparison logic, never two that could drift).
# See that file's header comment for the full reasoning: `configVersion` is
# a monotonically increasing generation counter for the whole record,
# incremented on every write; a CAS write only commits if the record's
# CURRENT configVersion still equals what the caller captured, checked and
# applied atomically server-side (a single Redis EVAL, not a racy
# GET-then-SET pair from this process).
_CAS_UPSERT_SCRIPT = """
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local currentVersion = '0'
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and decoded and decoded.configVersion then
    currentVersion = tostring(decoded.configVersion)
  end
end
if currentVersion ~= ARGV[2] then
  return raw or false
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return true
"""


class TenantConfigStoreUnavailableError(Exception):
    """Raised on a genuine Upstash outage/misconfiguration -- never for a
    tenant that simply has no config record yet (that's a normal `None`
    return from get_tenant_config(), not an error)."""


class ConfigVersionConflictError(Exception):
    """Raised when a CAS write's expected_version no longer matches the
    record's CURRENT configVersion -- something else (a newer provisioning
    attempt, a suspension, an approved-locations change, anything) wrote to
    this tenant's config after the caller captured its starting state.
    Carries the CURRENT record (parsed from what the Lua script itself
    returned -- the same atomic read used for the comparison, never a
    second, separate, racy GET) so a caller can decide whether to retry."""

    def __init__(self, message: str, current_record: dict | None):
        super().__init__(message)
        self.current_record = current_record


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _upstash_config():
    url = os.environ.get("UPSTASH_REDIS_REST_URL")
    token = os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    if not url or not token:
        return None
    return url.rstrip("/"), token


def _upstash_path_command(url: str, token: str, segments: list[str]) -> dict:
    """GET-style path command (e.g. GET {url}/hget/{key}/{field}) -- mirrors
    google_api.py's _fetch_refresh_token_from_redis()'s exact request shape.
    Used only for reads, where every segment (a fixed command name, the
    fixed hash key, and a short tenant_id field) is short and safe as a URL
    path segment."""
    full_url = url + "/" + "/".join(urllib.parse.quote(str(s), safe="") for s in segments)
    req = urllib.request.Request(full_url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def _upstash_generic_command(url: str, token: str, command: list[str]) -> dict:
    """POST {url} with a JSON command array body (e.g. ["HSET", key, field,
    value]) -- Upstash's generic REST command form, used for writes so an
    arbitrarily large JSON record value never has to travel as a URL path
    segment (which the path-command form above would require, and which
    real servers commonly cap in length)."""
    req = urllib.request.Request(
        url, data=json.dumps(command).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def get_tenant_config(tenant_id: str) -> dict | None:
    """Returns the tenant's config record, or None if it has no record yet
    (a perfectly normal state -- e.g. mid-onboarding, or a tenant that has
    never approved any locations). Raises TenantConfigStoreUnavailableError
    only for a genuine outage/misconfiguration; callers must not treat that
    the same as None."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "get_tenant_config")
    config = _upstash_config()
    if config is None:
        raise TenantConfigStoreUnavailableError("tenant config store is not configured (missing UPSTASH_REDIS_REST_URL/TOKEN)")
    url, token = config
    try:
        body = _upstash_path_command(url, token, ["hget", TENANT_CONFIG_KEY, tenant_id])
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise TenantConfigStoreUnavailableError(f"tenant config store unreachable: {e}") from e
    raw = body.get("result")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError) as e:
        raise TenantConfigStoreUnavailableError(f"tenant config store returned a malformed record: {e}") from e


def upsert_tenant_config(tenant_id: str, patch: dict, expected_version: int | None = None) -> dict:
    """Partial merge + updatedAt stamp, matching tenantConfigStore.js's
    upsertTenantConfig() field-for-field (see this module's header comment)
    -- the two must never diverge on default values or field names, since
    either language may be the one that creates a tenant's very first
    record.

    `expected_version`, if provided, makes this a CAS write (see this
    module's header comment) -- raises ConfigVersionConflictError if the
    record's configVersion no longer matches. provision_tenant.py always
    supplies it for every write after its initial read, binding a
    provisioning attempt to the exact generation it validated."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "upsert_tenant_config")
    config = _upstash_config()
    if config is None:
        raise TenantConfigStoreUnavailableError("tenant config store is not configured (missing UPSTASH_REDIS_REST_URL/TOKEN)")
    url, token = config

    existing = get_tenant_config(tenant_id)
    now = _now_iso()
    current_version = (existing or {}).get("configVersion", 0)
    next_record = {
        "tenantId": tenant_id,
        "displayName": tenant_id,
        "status": "onboarding",
        "locationCatalogEnabled": False,
        "approvedLocations": [],
        "locationIdMap": {},
        "nextLocationId": 1,
        "brands": [],
        "logoUrl": None,
        # Multi-Tenant Phase 4F.1 -- see tenantConfigStore.js's
        # isValidStorageMode() comment. Defaults to BLOB for the same reason
        # as the Node side: any tenant getting its first record via this
        # function is new, and BLOB is the only architecture new tenants are
        # provisioned under.
        "storageMode": "BLOB",
        "provisioning": {
            "status": "none", "reviewDbBlobKey": None, "privateDataPrefix": None, "reviewDbEtag": None,
            "artifactGeneration": None, "provisionedLocationIds": [], "lastAttemptAt": None, "lastError": None,
        },
        # Multi-Tenant Phase 4G -- see tenantConfigStore.js's own default
        # record comment: kept separate from "provisioning" (storage
        # existence) since this describes "has real data been synced," a
        # distinct concern owned exclusively by initial_sync.py.
        "initialSync": {
            "status": "none", "startedAt": None, "completedAt": None, "failedAt": None,
            "reviewDbEtag": None, "artifactGeneration": None,
            "reviewCount": None, "locationCount": None, "lastError": None,
        },
        **(existing or {}),
        "createdAt": (existing or {}).get("createdAt", now),
        **patch,
        "tenantId": tenant_id,  # never overwritable via patch
        "updatedAt": now,
        # Multi-Tenant Phase 4F closure: ALWAYS incremented relative to
        # whatever was actually read as `existing` -- never overwritable
        # via patch.
        "configVersion": current_version + 1,
    }
    if next_record["status"] not in _VALID_STATUSES:
        raise ValueError(f"upsert_tenant_config: invalid status {next_record['status']!r}")
    if next_record["storageMode"] not in _VALID_STORAGE_MODES:
        raise ValueError(f"upsert_tenant_config: invalid storageMode {next_record['storageMode']!r}")
    if not isinstance(next_record["locationCatalogEnabled"], bool):
        raise ValueError("upsert_tenant_config: locationCatalogEnabled must be a boolean")

    if expected_version is not None:
        if current_version != expected_version:
            raise ConfigVersionConflictError(
                f"upsert_tenant_config: version conflict for tenant {tenant_id!r} -- "
                f"expected {expected_version}, found {current_version}",
                existing,
            )
        try:
            result = _upstash_generic_command(
                url, token,
                ["EVAL", _CAS_UPSERT_SCRIPT, "1", TENANT_CONFIG_KEY, tenant_id, str(expected_version), json.dumps(next_record)],
            )
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            raise TenantConfigStoreUnavailableError(f"tenant config store unreachable: {e}") from e
        value = result.get("result")
        if value not in (True, 1):
            # The script's own atomic check failed (a writer committed
            # between our read above and the EVAL itself) -- `value` is the
            # CURRENT raw record it read, if any.
            current_record = None
            if isinstance(value, str):
                try:
                    current_record = json.loads(value)
                except (TypeError, ValueError):
                    current_record = None
            raise ConfigVersionConflictError(
                f"upsert_tenant_config: version conflict for tenant {tenant_id!r} detected atomically at write time",
                current_record,
            )
        return next_record

    try:
        _upstash_generic_command(url, token, ["HSET", TENANT_CONFIG_KEY, tenant_id, json.dumps(next_record)])
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise TenantConfigStoreUnavailableError(f"tenant config store unreachable: {e}") from e
    return next_record
