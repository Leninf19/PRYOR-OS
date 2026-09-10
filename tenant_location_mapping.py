"""
tenant_location_mapping.py -- Multi-Tenant Phase 4G: extracted from
provision_tenant.py's original _validate_stable_id_consistency() so
initial_sync.py can enforce the EXACT same stable-location-id consistency
rule without a second, independently-maintained copy of it. Both scripts
must refuse to proceed under the same conditions, byte-for-byte -- a
drifted second implementation here is exactly the kind of silent identity
bug this whole multi-tenant architecture exists to prevent.

Pure, no I/O: validates approvedLocations against locationIdMap (both
already read from tenant_config by the caller) before any Blob/SQLite/
Google access.
"""
from __future__ import annotations


class LocationMappingConsistencyError(Exception):
    """approvedLocations/locationIdMap disagree, are missing a valid stable
    id, or two locations claim the same numeric id -- refuses to guess."""


def validate_stable_id_consistency(approved_locations: list[dict], location_id_map: dict) -> dict[int, str]:
    """Cross-checks approvedLocations against locationIdMap BEFORE any
    Blob/SQLite/Google access. Returns {locationId: googleLocationId} on
    success; raises LocationMappingConsistencyError on any inconsistency."""
    by_location_id: dict[int, str] = {}
    for loc in approved_locations:
        google_id = loc.get("googleLocationId")
        location_id = loc.get("locationId")
        if not google_id or not isinstance(google_id, str):
            raise LocationMappingConsistencyError(f"approved location has no valid googleLocationId: {loc!r}")
        if not isinstance(location_id, int) or location_id < 1:
            raise LocationMappingConsistencyError(f"approved location {google_id!r} has no valid stable locationId: {loc!r}")
        mapped_id = location_id_map.get(google_id)
        if mapped_id != location_id:
            raise LocationMappingConsistencyError(
                f"approvedLocations entry for {google_id!r} claims locationId {location_id}, but "
                f"locationIdMap says {mapped_id!r} -- refusing to proceed on inconsistent tenant_config state"
            )
        if location_id in by_location_id and by_location_id[location_id] != google_id:
            raise LocationMappingConsistencyError(
                f"locationId {location_id} is claimed by both {by_location_id[location_id]!r} and "
                f"{google_id!r} -- duplicate/conflicting mapping, refusing to proceed"
            )
        by_location_id[location_id] = google_id
    return by_location_id
