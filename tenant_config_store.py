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

# Review Media Feature -- Scale & No-Backfill Audit: the ONLY two states
# mediaCapture.status may ever be. 'active' with a valid startedAt is the
# ONLY condition under which any caller (db.upsert_review()'s gate) may
# ever store review media -- see that function's own docstring. Neither
# value here is ever written by any deploy/onboarding/initial-sync/normal-
# sync code path in this codebase; activate_media_capture() below (never
# called anywhere in this implementation) is the sole intended writer of
# 'active', reserved for a future, separately-reviewed operator action.
_VALID_MEDIA_CAPTURE_STATUSES = {"inactive", "active"}

TENANT_CONFIG_KEY = "tenant_config:v1"

# Multi-Tenant Phase 4F closure: 'provisioned' inserted between
# 'provisioning' and 'active' -- see provision_tenant.py's header for the
# full state machine.
# Multi-Tenant Phase 4G: 'initial_sync'/'initial_sync_failed' inserted
# between 'provisioned' and 'active' -- see initial_sync.py's header. Only
# initial_sync.py's upsert_tenant_config() calls are ever allowed to write
# 'active'.
# Multi-Tenant Phase 4O: 'provisioning_dispatch_failed' added -- the
# automatic post-approval trigger (Node) writes this when a GitHub Actions
# dispatch attempt could not be confirmed (definite rejection, or a
# reconciliation timeout after an ambiguous network failure); distinct
# from 'provisioning_failed', which means provision_tenant.py itself ran
# and failed. See dashboard/api/_lib/tenantConfigStore.js's mirror of this
# same enum and provision_tenant.py's _PROVISIONABLE_STATUSES.
_VALID_STATUSES = {
    "onboarding", "locations_approved", "provisioning", "provisioned",
    "initial_sync", "active", "initial_sync_failed", "provisioning_failed",
    "provisioning_dispatch_failed", "suspended",
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
        # Multi-Tenant Phase 4I.3 -- see tenantConfigStore.js's own default
        # record comment: tracks a platform-admin post-onboarding
        # approvedLocations change, kept separate from "provisioning"/
        # "initialSync" for the same reason those two are separate from
        # each other. Node's applyEntitlementChange()/
        # markEntitlementChangeCompleted()/markEntitlementChangeFailed()
        # are the primary writers; apply_entitlement_change.py (Python)
        # writes the completion/failure side directly via this module,
        # mirroring how initial_sync.py already writes "initialSync".
        "entitlementChange": {
            "status": "none", "requestedAt": None, "completedAt": None, "failedAt": None,
            "addedLocationIds": [], "removedLocationIds": [], "lastError": None,
        },
        # Multi-Tenant Phase 4Q -- see tenantConfigStore.js's own
        # "commercial" field comment: purely descriptive plan/billing
        # metadata, additive, optional, and deliberately inert (nothing in
        # either language's authorization logic ever reads it). A record
        # created by this function (Python never creates a self-service
        # tenant's FIRST record today -- see this module's header -- but
        # mirrors the field for shape parity regardless) simply carries
        # commercial: None forever unless Node's registration flow set it.
        "commercial": None,
        # "Prevent duplicate/shadow tenant creation" hardening -- mirrors
        # tenantConfigStore.js's own `creation` provenance field for shape
        # parity only (same reasoning as `commercial` above): Python has no
        # gated "allowCreate" concept and never mints a tenant's first
        # record today, so this is always None here unless `existing`
        # already carries a real value written by Node's createNewTenant().
        "creation": None,
        # Review Media Feature -- Scale & No-Backfill Audit: a sibling of
        # provisioning/initialSync/entitlementChange on this SAME record,
        # per that audit's Audit 3 recommendation (no second tenant-config
        # store invented). Defaults to 'inactive'/None for EVERY tenant,
        # including one getting its first record via this function --
        # missing mediaCapture, or a missing/malformed startedAt, both mean
        # "inactive" to every reader (see db.upsert_review()'s gate) and
        # this default is what makes that true from a tenant's very first
        # write onward, with no special-casing required anywhere else.
        "mediaCapture": {"status": "inactive", "startedAt": None},
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
    media_capture = next_record.get("mediaCapture")
    if not isinstance(media_capture, dict) or media_capture.get("status") not in _VALID_MEDIA_CAPTURE_STATUSES:
        raise ValueError(f"upsert_tenant_config: invalid mediaCapture {media_capture!r}")

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


# ---------------------------------------------------------------------------
# Review Media Feature -- Scale & No-Backfill Audit (Phase 2)
# ---------------------------------------------------------------------------
# The two functions below are the ONLY code in this codebase that ever
# reads or writes mediaCapture with real intent to affect the storage gate.
# Neither is called anywhere in this implementation:
#   - resolve_media_capture_started_at() is wired into sync orchestration
#     in a LATER phase (see provider_sync.py), but as a pure READ that can
#     only ever produce None or an already-active tenant's own startedAt --
#     it cannot activate anything.
#   - activate_media_capture() is the sole intended WRITER of
#     mediaCapture.status='active', and is deliberately never called by
#     any deploy, onboarding, initial-sync, or normal-sync code path in
#     this implementation. Tenant activation is a separate, explicit,
#     later operation performed by a human-triggered call to this
#     function specifically -- see tests/test_tenant_config_media_capture.py
#     for its isolated coverage.

def _is_valid_iso_utc_timestamp(value) -> bool:
    """Strict, defensive ISO/RFC3339 validity check -- a malformed or
    non-string startedAt must NEVER be treated as a valid activation
    instant by any reader. Mirrors gbp_review_media_diagnostic.py's own
    _parse_iso_utc() normalization ('Z' -> '+00:00') without importing that
    diagnostic module (this store must not depend on diagnostic tooling)."""
    if not isinstance(value, str) or not value:
        return False
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        datetime.fromisoformat(normalized)
    except ValueError:
        return False
    return True


def resolve_media_capture_started_at(tenant_id: str) -> str | None:
    """The ONE safe read for 'what activation timestamp (if any) should
    gate this tenant's review media storage.' Returns the tenant's own
    validated startedAt ONLY when mediaCapture.status == 'active' AND
    startedAt is a genuinely valid ISO/RFC3339 timestamp -- every other
    case (no tenant_config record at all, missing mediaCapture, status
    'inactive', a missing/malformed startedAt) returns None, never a
    guessed or inherited value from another tenant or a fallback default.

    Raises TenantConfigStoreUnavailableError on a genuine store outage,
    exactly like every other read in this module -- it is the CALLER's
    responsibility (sync orchestration) to catch that and continue the
    review sync with media capture disabled, per this feature's explicit
    'config lookup failure fails closed, never blocks the sync' contract.
    This function itself never swallows that distinction, so a genuine
    outage can never be silently confused with a tenant that is simply
    not activated."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "resolve_media_capture_started_at")
    config = get_tenant_config(tenant_id)
    if config is None:
        return None
    media_capture = config.get("mediaCapture")
    if not isinstance(media_capture, dict) or media_capture.get("status") != "active":
        return None
    started_at = media_capture.get("startedAt")
    if not _is_valid_iso_utc_timestamp(started_at):
        return None
    return started_at


def activate_media_capture(tenant_id: str, expected_version: int) -> dict:
    """Server-only, CAS-protected helper for a FUTURE, separately-reviewed
    explicit activation action. NEVER called anywhere in this
    implementation -- no deploy step, onboarding flow, initial_sync.py run,
    or normal gbp_sync.py/provider_sync.py sync ever calls this function.
    There is no browser-reachable endpoint that reaches it either.

    Idempotent and backdate-proof by construction:
      - startedAt is computed here, server-side, from the CURRENT UTC
        clock (_now_iso()) -- this function takes NO timestamp parameter
        at all, so a caller has no way to supply, backdate, or reset one.
      - If the tenant is ALREADY status='active' with an already-valid
        startedAt, that existing startedAt is preserved UNCHANGED -- this
        call becomes a safe no-op for the timestamp itself (still goes
        through the normal CAS write path so configVersion/updatedAt
        advance consistently, but startedAt's value never moves). Calling
        this function a second time (or a tenth time) can never move an
        already-set activation instant earlier OR later.
      - A tenant with no tenant_config record at all raises ValueError --
        this function never creates a tenant's first record; activation is
        only ever meaningful for a tenant that already exists.

    `expected_version` is REQUIRED (positional, no default) -- exactly like
    every other write in this module after an initial read, binding this
    activation attempt to the exact generation the caller last observed."""
    tenant_keys.assert_valid_tenant_id(tenant_id, "activate_media_capture")
    config = get_tenant_config(tenant_id)
    if config is None:
        raise ValueError(f"activate_media_capture: tenant {tenant_id!r} has no tenant_config record yet")

    patch = compute_media_capture_activation_patch(config.get("mediaCapture"))
    return upsert_tenant_config(tenant_id, {"mediaCapture": patch}, expected_version=expected_version)


def compute_media_capture_activation_patch(existing_media_capture: dict | None) -> dict:
    """All-Tenant Rollout: the ONE place that decides what mediaCapture
    value an activation write should use -- a pure function, no I/O, no
    Redis access. Both activate_media_capture() (above, for an EXISTING
    tenant via the standalone CAS-protected admin path) and
    initial_sync.py's own final success CAS write (for a BRAND-NEW tenant's
    automatic activation at the moment it first becomes genuinely
    operational) call this exact function, so the "preserve an
    already-valid timestamp, otherwise compute a fresh server-side one"
    logic is never duplicated or allowed to drift between the two callers.

    Given the tenant's CURRENT mediaCapture sub-object (or None, for a
    tenant with no record/field at all -- the common case for a brand-new
    tenant's very first activation), returns the {'status': 'active',
    'startedAt': ...} patch to write:
      - If already status='active' with a genuinely valid startedAt, that
        exact value is returned UNCHANGED -- calling this again (a retry,
        a rerun of the admin rollout, a second initial_sync attempt after
        a transient earlier failure) can never move an already-set
        activation instant earlier or later.
      - Otherwise, startedAt is computed HERE, from the server's own UTC
        clock (_now_iso()) -- there is no parameter through which any
        caller could supply or backdate a timestamp."""
    existing_media_capture = existing_media_capture or {}
    existing_started_at = existing_media_capture.get("startedAt")
    if existing_media_capture.get("status") == "active" and _is_valid_iso_utc_timestamp(existing_started_at):
        started_at = existing_started_at  # preserved, never reset or backdated
    else:
        started_at = _now_iso()  # server-computed, never caller-supplied
    return {"status": "active", "startedAt": started_at}


def list_tenant_ids() -> list[str]:
    """All-Tenant Rollout: the ONE authoritative enumeration of every
    tenant that has a record in tenant_config:v1 -- the SAME Redis hash
    every read/write in this module already operates on (HGET/HSET/EVAL
    against TENANT_CONFIG_KEY), just read via HKEYS instead of a per-tenant
    HGET. This is a pure, read-only Redis call -- it can never write, and
    it does not itself judge whether a discovered key is a "legitimate"
    tenant (a valid tenant_id shape, a genuinely active/operational
    status, etc.) -- callers (e.g. an admin rollout script) MUST apply
    tenant_keys.is_valid_tenant_id() and their own status checks to
    whatever this returns before treating an entry as eligible for any
    action. Returns field names in whatever order Redis provides them --
    never assumed to be creation order or otherwise meaningful -- so
    callers that need a stable order must sort the result themselves.

    Raises TenantConfigStoreUnavailableError on a genuine store outage,
    exactly like every other read in this module -- never silently
    returns an empty list for an outage, which a caller could otherwise
    mistake for "there are genuinely zero tenants."""
    config = _upstash_config()
    if config is None:
        raise TenantConfigStoreUnavailableError("tenant config store is not configured (missing UPSTASH_REDIS_REST_URL/TOKEN)")
    url, token = config
    try:
        body = _upstash_generic_command(url, token, ["HKEYS", TENANT_CONFIG_KEY])
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise TenantConfigStoreUnavailableError(f"tenant config store unreachable: {e}") from e
    result = body.get("result")
    if not isinstance(result, list):
        raise TenantConfigStoreUnavailableError(f"tenant config store returned a malformed HKEYS result: {result!r}")
    return result
