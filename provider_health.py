"""
provider_health.py -- Phase 3 Milestone 2: a shared, provider-neutral health
model (Healthy/Warning/Degraded/Failed/Offline), computed purely from
scraper_runs rows -- no I/O of its own, no provider-specific knowledge.

No explicit health-state model existed anywhere in the codebase before this
(ScraperStatus.jsx only has ad-hoc "Fresh/Stale/Critical" freshness
thresholds on the single most recent run; critical_alert_check.py/
health_check.py check unrelated, narrower things). This is the first
version, applicable identically to every provider that writes a `provider`
value on scraper_runs (Milestone 1's `provider` column).

Reuses the same freshness multipliers ScraperStatus.jsx already established
(1.5x/4x expected cadence) rather than inventing new thresholds.
"""
from datetime import datetime, timezone
from typing import Optional

STATE_OFFLINE = "offline"
STATE_FAILED = "failed"
STATE_DEGRADED = "degraded"
STATE_WARNING = "warning"
STATE_HEALTHY = "healthy"

_RUNNING = "running"
_OK = "ok"
_PARTIAL = "partial"
_FAILED = "failed"
# 'cancelled' (the process itself observed a cancellation) and 'timed_out'
# (the health_check.py watchdog reconciled a run that never self-reported at
# all -- see provider_sync.reconcile_stuck_runs()) are both genuine bad
# outcomes for whichever run they're on, treated identically to _FAILED
# below. Recency (a run's position in the caller-supplied `runs` list, which
# is ordered by when each run *started*, not by when it was reconciled) is
# what keeps an old, long-since-superseded abandoned run from counting as
# evidence the *current* scraper is failing -- reconciling it today doesn't
# move it to "most recent," it only replaces a silent gap with an honest
# terminal record in its original chronological slot.
_CANCELLED = "cancelled"
_TIMED_OUT = "timed_out"
_BAD_STATUSES = {_FAILED, _CANCELLED, _TIMED_OUT}

# Same multipliers ScraperStatus.jsx's freshness() already uses (Fresh <=
# 1.5x cadence, Stale <= 4x cadence) -- reused, not reinvented.
_WARNING_MULTIPLIER = 1.5
_DEGRADED_LOOKBACK = 5          # how many recent completed runs form the "trailing window"
_DEGRADED_TROUBLE_COUNT = 2     # >= this many failed/partial runs in the window -> degraded
_DEGRADED_LOCATION_FAILURE_RATIO = 0.25  # > this fraction of locations failed this run -> degraded


def _age_minutes(started_at: str, now: datetime) -> Optional[float]:
    try:
        started = datetime.fromisoformat(started_at)
    except (TypeError, ValueError):
        return None
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    return (now - started).total_seconds() / 60.0


def compute_health(
    provider_name: str,
    is_configured: bool,
    runs: list[dict],
    expected_cadence_minutes: Optional[int],
    *,
    now: Optional[datetime] = None,
) -> dict:
    """`runs`: this provider's scraper_runs rows, most recent first (already
    filtered by provider by the caller -- see export_chunks.py). Returns
    {"state": one of the STATE_* constants above, "reason": human-readable
    string}. `now` is injectable for deterministic tests; defaults to the
    real current time."""
    now = now or datetime.now(timezone.utc)

    if not is_configured:
        return {"state": STATE_OFFLINE, "reason": f"{provider_name} is not configured"}
    if not runs:
        return {"state": STATE_OFFLINE, "reason": f"no run has ever been recorded for {provider_name}"}

    # A run still in progress has no verdict yet -- judge health off the
    # last *completed* run until it finishes, rather than inventing a
    # distinct "running" health state.
    completed = [r for r in runs if r.get("status") != _RUNNING]
    if not completed:
        return {"state": STATE_OFFLINE, "reason": f"{provider_name}'s only recorded run is still in progress"}

    latest = completed[0]
    latest_status = latest.get("status")

    if latest_status in _BAD_STATUSES:
        verb = {_FAILED: "failed", _CANCELLED: "was cancelled", _TIMED_OUT: "timed out"}[latest_status]
        return {"state": STATE_FAILED, "reason": f"most recent run {verb}: {latest.get('error_summary') or 'no error summary recorded'}"}

    window = completed[:_DEGRADED_LOOKBACK]
    trouble_count = sum(1 for r in window if r.get("status") in _BAD_STATUSES or r.get("status") == _PARTIAL)

    attempted = latest.get("locations_attempted") or 0
    failed_locations = latest.get("locations_failed") or 0
    failed_ratio = (failed_locations / attempted) if attempted else 0.0

    if trouble_count >= _DEGRADED_TROUBLE_COUNT:
        return {
            "state": STATE_DEGRADED,
            "reason": f"{trouble_count} of the last {len(window)} runs were failed or partial",
        }
    if latest_status == _PARTIAL and failed_ratio > _DEGRADED_LOCATION_FAILURE_RATIO:
        return {
            "state": STATE_DEGRADED,
            "reason": f"most recent run: {failed_locations}/{attempted} locations failed ({failed_ratio:.0%})",
        }

    age = _age_minutes(latest.get("started_at"), now) if latest.get("started_at") else None
    stale = (
        expected_cadence_minutes is not None
        and age is not None
        and age > expected_cadence_minutes * _WARNING_MULTIPLIER
    )

    if latest_status == _PARTIAL:
        return {
            "state": STATE_WARNING,
            "reason": f"most recent run was partial: {failed_locations}/{attempted} locations failed",
        }
    if stale:
        return {
            "state": STATE_WARNING,
            "reason": f"most recent successful run was {age:.0f} minutes ago (expected every {expected_cadence_minutes})",
        }

    return {"state": STATE_HEALTHY, "reason": "most recent run succeeded and is within the expected cadence"}
