"""
tenant_approved_locations_provider.py -- Multi-Tenant Phase 4G: wraps
GBPProvider so Initial Sync (and any future re-sync) can NEVER process a
Google-discovered location that isn't in the tenant's own approvedLocations.
"A Google account is connected" must never be silently interpreted as "sync
whatever Google returns" -- see initial_sync.py's header.

WHY A WRAPPER, NOT A CHANGE TO provider_gbp.py: GBPProvider.discover_locations()
returns every location the connected Google account exposes, unfiltered --
correct for Los Tres Amigos's own existing single-tenant nightly sync (LTA
has no separate "approval" concept; every discovered location is already
its established roster) and this phase must not change that production
path at all. This wrapper narrows discover_locations()'s result AFTER the
real API call, before provider_sync.py's location-linking logic
(_link_locations()) ever sees it.

WHY FILTERING discover_locations() IS SUFFICIENT (no change needed to
provider_sync.py's own linking/DB-write logic): _link_locations() creates a
NEW `locations` row (SQLite autoincrement) for any provider-discovered
location it cannot match to an existing row. Every approved location was
ALREADY given its stable numeric id and a matching row by
provision_tenant.py (gbp_location_name == googleLocationId, an exact-match
that _link_locations() checks FIRST, before any fuzzy-name fallback) -- so
as long as discover_locations() here never returns anything outside the
approved set, the "create new" branch is architecturally unreachable for a
properly provisioned BLOB tenant. initial_sync.py additionally re-verifies
the locations table against locationIdMap BEFORE and AFTER the sync runs
(see that module), as defense-in-depth against this invariant ever being
violated by a future change here.
"""
from __future__ import annotations

from provider_base import ProviderLocation
from provider_gbp import GBPProvider


class UnreconciledApprovedLocationError(Exception):
    """An approved googleLocationId was not present at all among what
    Google's API actually returned this run. Initial Sync treats this as a
    hard, fail-closed refusal -- never a silent partial sync that pretends
    the missing location doesn't exist."""


class ApprovedLocationsOnlyGBPProvider(GBPProvider):
    """A GBPProvider that only ever exposes a tenant's OWN approved Google
    locations to callers. discover_locations() filters the real API result
    down to EXACTLY approved_google_location_ids -- anything else Google
    returns (an unapproved location the tenant never selected during
    discovery/approval, or one belonging to a different Google Business
    Profile the same OAuth grant happens to also see) is silently excluded
    from the returned list (logged, never synced), while a MISSING approved
    location raises UnreconciledApprovedLocationError instead of being
    skipped -- "an approved location genuinely absent from Google's own
    response" is a real inconsistency (the location was unlinked/removed
    on Google's side, or credential access was narrowed) that must fail the
    whole sync, not silently produce a partial one."""

    def __init__(self, tenant_id: str, approved_google_location_ids: set[str]):
        super().__init__(tenant_id)
        if not approved_google_location_ids:
            raise ValueError("ApprovedLocationsOnlyGBPProvider: approved_google_location_ids must be non-empty")
        self._approved_google_location_ids = frozenset(approved_google_location_ids)

    def discover_locations(self) -> list[ProviderLocation]:
        all_locations = super().discover_locations()
        seen_external_ids = {loc.external_id for loc in all_locations if loc.external_id}
        missing = self._approved_google_location_ids - seen_external_ids
        if missing:
            raise UnreconciledApprovedLocationError(
                f"tenant {self.tenant_id!r}: approved Google location id(s) {sorted(missing)} were not present in "
                f"Google's API response this run -- refusing to sync a partial/inconsistent location set"
            )
        approved = [loc for loc in all_locations if loc.external_id in self._approved_google_location_ids]
        skipped = [loc.external_id for loc in all_locations if loc.external_id not in self._approved_google_location_ids]
        if skipped:
            print(f"tenant_approved_locations_provider.py: tenant {self.tenant_id!r} -- skipping "
                  f"{len(skipped)} Google-discovered location(s) not in approvedLocations: {sorted(skipped)}")
        return approved
