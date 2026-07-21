"""
provider_gbp.py -- Phase 3 Milestone 1: GBPProvider, the Provider
implementation wrapping the existing Google Business Profile API client
(google_api.py).

This moves the raw external-fetch logic gbp_sync.py already had (account
listing, per-account location listing, review listing + row conversion)
behind the shared Provider interface. gbp_sync.py's own location-matching/
linking logic (matching a discovered Google location to an internal
locations row, creating a new one, recording gbp_account_name/
gbp_location_name) stays in gbp_sync.py, unchanged -- that's
sync-orchestration/storage logic, not something specific to being a
Provider, and a future Scraper/Mock provider would never need it.

"No accounts for this token" is raised as ProviderAuthError (not returned
as an empty list) specifically so gbp_sync.sync_all() can catch it exactly
like any other hard discovery failure and keep writing the same
_record_early_failure() row with the same reason string it always has --
this is a deliberate design choice to preserve gbp_sync.py's existing
external behavior byte-for-byte, not an arbitrary exception vs. empty-list
preference.
"""
from provider_base import Provider, ProviderLocation, ProviderReview, ProviderAuthError, ProviderConfigError
import google_api as ga

# Moved here from gbp_sync.py (Phase 3 Milestone 1) along with the review
# conversion logic that uses it. Kept in sync with
# digest_filters._STAR_ENUM_MAP -- this is the DB-write path
# (upsert_review() needs a plain int star_rating stored), while
# digest_filters.normalize_rating() is the read-side/notification path
# that also tolerates "ONE_STAR"-style variants and numeric strings for
# defense-in-depth. Both must recognize every value Google actually sends.
STAR_MAP = {"ONE": 1, "TWO": 2, "THREE": 3, "FOUR": 4, "FIVE": 5}


class GBPProvider(Provider):
    name = "gbp"

    def is_configured(self) -> bool:
        return ga.is_configured()

    def discover_locations(self) -> list[ProviderLocation]:
        if not self.is_configured():
            raise ProviderConfigError("Google credentials not configured (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN)")

        accounts = ga.list_accounts()  # a hard failure here raises ga.GBPError, a ProviderError -- propagates unchanged
        if not accounts:
            raise ProviderAuthError("No Google Business Profile accounts found for this token")

        locations = []
        for account in accounts:
            try:
                api_locations = ga.list_locations(account["name"])
            except ga.GBPError as e:
                # Preserves gbp_sync.py's original per-account skip-and-continue
                # behavior exactly -- one account's failure never aborts
                # discovery for every other account.
                print(f"provider_gbp.py: could not list locations for {account.get('name')}: {e}")
                continue

            for gloc in api_locations:
                address = gloc.get("address", {}) or {}
                verified = (gloc.get("locationState") or {}).get("isVerified")
                locations.append(ProviderLocation(
                    external_id=gloc["name"],
                    name=gloc.get("locationName") or "",
                    city=address.get("locality", ""),
                    address=address,
                    verification_status="VERIFIED" if verified else "UNVERIFIED",
                    provider_metadata={"account_name": account["name"]},
                ))
        return locations

    def fetch_reviews(self, location: ProviderLocation, *, fast: bool = False) -> list[ProviderReview]:
        max_pages = 1 if fast else None
        api_reviews = ga.list_reviews(location.external_id, max_pages=max_pages)
        return [self._to_provider_review(r) for r in api_reviews]

    @staticmethod
    def _to_provider_review(api_review: dict) -> ProviderReview:
        """Identical field-for-field to gbp_sync.py's previous
        _review_to_row() -- moved, not rewritten."""
        reviewer = api_review.get("reviewer", {}) or {}
        reply = api_review.get("reviewReply") or {}
        create_time = api_review.get("createTime", "") or ""
        return ProviderReview(
            reviewer_name=reviewer.get("displayName") or "A Google User",
            review_date=create_time[:10],
            star_rating=STAR_MAP.get(api_review.get("starRating")),
            review_text=api_review.get("comment") or "",
            owner_response=reply.get("comment") or "",
            review_url="",
            gbp_review_name=api_review.get("name"),
            gbp_update_time=api_review.get("updateTime"),
            gbp_reply_update_time=reply.get("updateTime"),
            gbp_language_code=api_review.get("languageCode"),
        )

    def reply_to_review(self, gbp_review_name: str, comment: str) -> None:
        ga.reply_to_review(gbp_review_name, comment)
