"""
provider_base.py -- Phase 3 Milestone 1: the common contract every review
data source (Google Business Profile API, the Playwright scraper, and a
future Mock Provider) can implement, so the sync pipeline can eventually
depend on this interface instead of on any one source directly.

This module is additive infrastructure only. Nothing in the pipeline calls
through it yet except google_api.py's exception hierarchy (see
provider_gbp.py and google_api.py's GBPError, now reparented onto
ProviderError below) -- auto_update.py (the currently-active scraper) is
untouched and has no Provider wrapper yet.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


class ProviderError(Exception):
    """Base class for every error any Provider can raise. `retryable`
    tells a generic retry loop (see retry.py) whether this specific
    failure is worth retrying -- e.g. a rate limit or a transient server
    error is, a permission or not-found error never is."""
    def __init__(self, message: str, status: Optional[int] = None, retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class ProviderAuthError(ProviderError):
    """Credentials missing, invalid, expired, or revoked."""


class ProviderRateLimitError(ProviderError):
    """Rate limited (429) even after retries were exhausted."""


class ProviderPermissionError(ProviderError):
    """Authenticated, but lacking permission for this resource (403)."""


class ProviderNotFoundError(ProviderError):
    """The requested resource no longer exists (404)."""


class ProviderServerError(ProviderError):
    """The provider returned a 5xx after retries were exhausted."""


class ProviderConfigError(ProviderError):
    """Not configured at all -- callers should skip this provider entirely
    rather than attempt a call, matching the existing is_configured() gate
    pattern (google_api.py's is_configured(), gbp_sync.py's usage of it)."""


class ProviderParsingError(ProviderError):
    """The provider was reachable but its response could not be parsed or
    had an unexpected structure (Phase 3 Milestone 2). No HTTP-API provider
    has hit this category yet -- a JSON parse failure would already surface
    as a different, generic error -- but a browser-driven provider (the
    scraper, and any future Yelp/Facebook/TripAdvisor-style scraper) can
    genuinely load a page successfully and still fail to find what it
    expects on it (markup changed, or the page isn't what was searched
    for). Never retryable within the same attempt: retrying immediately
    against an unrecognized page structure won't help."""


# Capability identifiers (Phase 3 Milestone 2). Plain strings, not an enum,
# matching this module's existing style -- checked via `CAP_X in
# provider.capabilities`. Declared once here so every Provider references
# the same literal value instead of each spelling it out independently.
CAP_READ_REVIEWS = "read_reviews"
CAP_REPLY = "reply"
CAP_DELETE_REPLY = "delete_reply"  # declared for forward-compatibility; no provider implements it yet


@dataclass
class ProviderLocation:
    """A location as reported by a provider. `external_id` is the
    provider's own resource identifier (e.g. Google's
    accounts/*/locations/* path); it is None for a provider with no
    external identity concept.

    `provider_metadata` is an escape hatch for bookkeeping a specific
    provider's caller needs but that has no meaning for other providers --
    e.g. GBPProvider stores the parent Google account name there, since
    gbp_sync.py's existing location-linking logic needs it but no generic
    caller (or a future Mock/Scraper provider) ever would."""
    external_id: Optional[str]
    name: str
    city: str = ""
    address: dict = field(default_factory=dict)
    verification_status: Optional[str] = None
    search_query: str = ""
    maps_url: str = ""
    provider_metadata: dict = field(default_factory=dict)


@dataclass
class ProviderReview:
    """Deliberately the exact same shape db.upsert_review()/db.dedup_key()
    already accept -- introducing a Provider never requires a storage-layer
    change."""
    reviewer_name: str
    review_date: str
    star_rating: Optional[int]
    review_text: str = ""
    owner_response: str = ""
    review_url: str = ""
    gbp_review_name: Optional[str] = None
    gbp_update_time: Optional[str] = None
    gbp_reply_update_time: Optional[str] = None
    gbp_language_code: Optional[str] = None

    def as_row(self) -> dict:
        return {
            "reviewer_name": self.reviewer_name,
            "review_date": self.review_date,
            "star_rating": self.star_rating,
            "review_text": self.review_text,
            "owner_response": self.owner_response,
            "review_url": self.review_url,
            "gbp_review_name": self.gbp_review_name,
            "gbp_update_time": self.gbp_update_time,
            "gbp_reply_update_time": self.gbp_reply_update_time,
            "gbp_language_code": self.gbp_language_code,
        }


class Provider(ABC):
    """The common contract. `name` is the short slug written to
    scraper_runs.provider (e.g. 'gbp', 'scraper', 'mock'); `display_name` is
    the human-readable label a future UI (e.g. the Provider Health Center)
    would show instead of the raw slug.

    `capabilities` (Phase 3 Milestone 2) declares what this provider can
    actually do, as a set of the CAP_* constants above -- e.g. a future UI
    can check `CAP_REPLY in provider.capabilities` instead of inferring
    support by catching NotImplementedError from reply_to_review(). Default
    empty: a provider that can only read reviews (like the scraper) simply
    never adds anything beyond CAP_READ_REVIEWS.

    `expected_cadence_minutes` (Phase 3 Milestone 2) declares how often this
    provider is expected to complete a run, for the shared health model in
    provider_health.py. `None` means "no fixed expectation" (e.g. a Mock
    Provider run on demand) -- the health model treats that as never stale."""
    name: str = "unknown"
    display_name: str = "Unknown Provider"
    capabilities: frozenset[str] = frozenset()
    expected_cadence_minutes: Optional[int] = None

    @abstractmethod
    def is_configured(self) -> bool:
        """Cheap, no-network check for whether this provider has what it
        needs to run at all. Callers should skip the provider entirely
        (not attempt discover_locations()/fetch_reviews()) when False."""

    @abstractmethod
    def discover_locations(self) -> list[ProviderLocation]:
        """Every location this provider can currently see. Raises
        ProviderError (typically ProviderAuthError/ProviderServerError) on
        total failure -- never returns a partial list silently."""

    @abstractmethod
    def fetch_reviews(self, location: ProviderLocation, *, fast: bool = False) -> list[ProviderReview]:
        """Every review for one location. fast=True mirrors gbp_sync.py's
        existing --fast flag (newest page/window only, for a frequent
        cadence). Must return an empty list for a legitimate zero-review
        location -- never raise for that case."""

    def reply_to_review(self, gbp_review_name: str, comment: str) -> None:
        """Optional -- not every provider can reply (e.g. a read-only
        Mock Provider variant). Default raises so a caller that assumes
        reply support fails loudly rather than silently no-op'ing."""
        raise NotImplementedError(f"{self.name} provider does not support reply_to_review")
