"""
provider_mock.py -- Phase 3 Milestone 3: MockProvider, a Provider implementation
for local development only. Replays real historical review data from a local
snapshot database (see bootstrap_mock_snapshot.py) so a developer can exercise
the entire pipeline -- dedup/upsert, analytics, exports, frontend -- without
hitting the real Google API or running the real Playwright scraper.

Never used by any production workflow: nothing in .github/workflows/ or
dashboard/api/ references this module. It is exercised only by a developer
directly (Python REPL / scratch script) or by its own tests, which build a
tiny scratch snapshot DB -- never the real, gitignored, full-size snapshot
this class reads by default.

Multi-Tenant Phase 4D classification: EXEMPT from --tenant-id enforcement,
by explicit audit finding, not by omission. This class never touches
db.DB_PATH or any tenant's real reviews.db at all -- it reads exclusively
from DEFAULT_SNAPSHOT_PATH (dashboard/reviews.snapshot.db), a separate,
gitignored, read-only replica file that only ever gets created locally by
bootstrap_mock_snapshot.py (itself tenant-aware as of this phase, since
IT reads the real database as its copy source). MockProvider itself is
read-only (reply_to_review() is unimplemented) and is selectable as
sync_reviews.py's --provider mock, but sync_reviews.py's own tenant-scoped
db.DB_PATH resolution (Phase 4D) still governs where any review data a
mock sync produces gets WRITTEN -- MockProvider supplies synthetic read
data, it never decides a write destination. It therefore provably cannot
read or write any tenant's real review data under any invocation.
"""
import os
import sqlite3
import time
from pathlib import Path
from typing import Optional

from provider_base import (
    Provider, ProviderLocation, ProviderReview,
    ProviderAuthError, ProviderRateLimitError, ProviderServerError,
    CAP_READ_REVIEWS,
)

BASE_DIR = Path(__file__).parent
DEFAULT_SNAPSHOT_PATH = BASE_DIR / "dashboard" / "reviews.snapshot.db"

_FAULT_ERRORS = {
    "rate_limit": lambda: ProviderRateLimitError("MockProvider: simulated rate limit", retryable=True),
    "outage": lambda: ProviderServerError("MockProvider: simulated outage", retryable=True),
    "auth_error": lambda: ProviderAuthError("MockProvider: simulated auth error", retryable=False),
}

# A distinct sentinel (not None) for "this kwarg was not passed at all" --
# None is itself a legitimate explicit value for fail_with (means "no fault"),
# so using None as the "check the environment variable instead" default would
# make it impossible to explicitly force fail_with=None over a set env var.
_UNSET = object()


class MockProvider(Provider):
    """Read-only (see provider_base.py's own "read-only Mock Provider variant"
    docstring) -- reply_to_review() is intentionally not overridden, so it
    inherits the ABC default (raises NotImplementedError).

    Every constructor kwarg falls back to an environment variable if not
    passed explicitly, then a safe default -- so `MockProvider()` still works
    standalone (matching GBPProvider()/ScraperProvider()'s zero-arg
    convention) while remaining configurable without code changes for a
    local dev session:
      snapshot_path       <- MOCK_PROVIDER_SNAPSHOT_PATH   (default: DEFAULT_SNAPSHOT_PATH)
      fail_with            <- MOCK_PROVIDER_FAIL_WITH       (default: None -- no fault)
      latency_seconds      <- MOCK_PROVIDER_LATENCY_SECONDS (default: 0.0)
      simulate_mutations   <- MOCK_PROVIDER_SIMULATE_MUTATIONS (default: False)

    `simulate_mutations`'s call-count tracking is in-memory, per instance,
    not persisted across process runs -- a developer must keep the same
    MockProvider() instance alive across two fetch_reviews() calls (e.g. in
    one REPL session) to see the simulated edit/delete; a fresh script
    invocation always starts back at "call 1" for every location.
    """

    name = "mock"
    display_name = "Mock Provider (local dev)"
    capabilities = frozenset({CAP_READ_REVIEWS})
    expected_cadence_minutes = None  # run on demand, no fixed schedule

    def __init__(self, *, snapshot_path=_UNSET, fail_with=_UNSET,
                 latency_seconds=_UNSET, simulate_mutations=_UNSET):
        if snapshot_path is _UNSET:
            snapshot_path = os.environ.get("MOCK_PROVIDER_SNAPSHOT_PATH") or str(DEFAULT_SNAPSHOT_PATH)
        self.snapshot_path = Path(snapshot_path)

        if fail_with is _UNSET:
            fail_with = os.environ.get("MOCK_PROVIDER_FAIL_WITH") or None
        if fail_with is not None and fail_with not in _FAULT_ERRORS:
            raise ValueError(f"MockProvider: unknown fail_with {fail_with!r}, expected one of {sorted(_FAULT_ERRORS)}")
        self.fail_with = fail_with

        if latency_seconds is _UNSET:
            latency_seconds = float(os.environ.get("MOCK_PROVIDER_LATENCY_SECONDS", "0") or "0")
        self.latency_seconds = latency_seconds

        if simulate_mutations is _UNSET:
            simulate_mutations = os.environ.get("MOCK_PROVIDER_SIMULATE_MUTATIONS", "").lower() in ("1", "true", "yes")
        self.simulate_mutations = simulate_mutations

        self._fetch_call_counts: dict[str, int] = {}

    def is_configured(self) -> bool:
        """Cheap, no-network check: has the developer run
        bootstrap_mock_snapshot.py yet? False (not an exception) if not --
        mirrors GBPProvider/ScraperProvider's is_configured() gate pattern."""
        return self.snapshot_path.exists()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(f"file:{self.snapshot_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        return conn

    def _maybe_fault_or_sleep(self) -> None:
        if self.latency_seconds:
            time.sleep(self.latency_seconds)
        if self.fail_with is not None:
            raise _FAULT_ERRORS[self.fail_with]()

    def discover_locations(self) -> list[ProviderLocation]:
        self._maybe_fault_or_sleep()
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM locations").fetchall()
        return [
            ProviderLocation(
                # Preserves whatever provenance the snapshot naturally has --
                # a location the real pipeline already linked to Google
                # keeps its external identity here too; one that never was
                # (or a snapshot predating any GBP linkage) has none, exactly
                # like ScraperProvider's locations.
                external_id=row["gbp_location_name"],
                name=row["name"],
                city=row["city"] or "",
                search_query=row["search_query"] or "",
                maps_url=row["maps_url"] or "",
                verification_status=row["gbp_verification_status"],
                provider_metadata={"gbp_account_name": row["gbp_account_name"]} if row["gbp_account_name"] else {},
            )
            for row in rows
        ]

    def fetch_reviews(self, location: ProviderLocation, *, fast: bool = False) -> list[ProviderReview]:
        self._maybe_fault_or_sleep()
        with self._connect() as conn:
            loc_row = conn.execute("SELECT id FROM locations WHERE name = ?", (location.name,)).fetchone()
            if loc_row is None:
                return []
            query = (
                "SELECT * FROM reviews WHERE location_id = ? AND is_deleted = 0 "
                "ORDER BY review_date DESC"
            )
            rows = conn.execute(query, (loc_row["id"],)).fetchall()

        if fast:
            rows = rows[:20]

        reviews = [self._to_provider_review(row) for row in rows]

        if self.simulate_mutations:
            call_count = self._fetch_call_counts.get(location.name, 0) + 1
            self._fetch_call_counts[location.name] = call_count
            if call_count > 1 and reviews:
                # Simulate one edit (for db.upsert_review()'s "edited" path)...
                first = reviews[0]
                reviews[0] = ProviderReview(
                    reviewer_name=first.reviewer_name,
                    review_date=first.review_date,
                    star_rating=first.star_rating,
                    review_text=first.review_text + " [mock-edited]",
                    owner_response=first.owner_response,
                    review_url=first.review_url,
                    gbp_review_name=first.gbp_review_name,
                    gbp_update_time=first.gbp_update_time,
                    gbp_reply_update_time=first.gbp_reply_update_time,
                    gbp_language_code=first.gbp_language_code,
                )
                # ...and one deletion (for db.detect_deletions() to catch).
                reviews = reviews[:-1]

        return reviews

    @staticmethod
    def _to_provider_review(row: sqlite3.Row) -> ProviderReview:
        return ProviderReview(
            reviewer_name=row["reviewer_name"] or "",
            review_date=row["review_date"] or "",
            star_rating=row["star_rating"],
            review_text=row["review_text"] or "",
            owner_response=row["owner_response"] or "",
            review_url=row["review_url"] or "",
            gbp_review_name=row["gbp_review_name"],
            gbp_update_time=row["gbp_update_time"],
            gbp_reply_update_time=row["gbp_reply_update_time"],
            gbp_language_code=row["gbp_language_code"],
        )
